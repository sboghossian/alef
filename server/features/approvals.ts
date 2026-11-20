// A2 — approve Claude Code permission prompts from the world.
// hooks/permission-request.mjs POSTs the PermissionRequest hook payload here, then
// long-polls for a decision. The world answers allow / deny / passthrough; anything
// unanswered expires after 65s and the hook falls back to the normal terminal prompt.
//
// Persistence: the queue (pending + recently decided) and the ON/OFF toggle are kept
// in the core `meta` table (ctx.db.setMeta) as small JSON values, so a `tsx watch`
// restart does not drop a request a hook is still polling for. The queue is tiny
// (items live ≤55s + 2min), so a JSON value is cheaper than a second sqlite handle.
//
// Security: loopback-only + JSON-only writes (server/guard.ts). Tool input is untrusted:
// it is reduced to a sanitized, truncated text preview; the client renders it as text.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative } from "node:path";
import type {
  ApprovalBehavior,
  ApprovalOutcome,
  ApprovalPollResult,
  ApprovalPreview,
  ApprovalsMessage,
  ApprovalView,
} from "../../shared/features/approvals.js";
import { redactSecrets } from "../heuristics.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

// hooks/permission-request.mjs's own DEADLINE_MS is 60_000: this must stay comfortably below
// it (see the guard test in approvals.test.ts), or a decision can land here after the hook has
// already given up and let the terminal's normal prompt take over — with nobody listening.
export const APPROVAL_EXPIRY_MS = 55_000;
const DECIDED_RETENTION_MS = 120_000;
const POLL_MAX_MS = 25_000;
const META_QUEUE = "approvals.queue";
const META_ENABLED = "approvals.enabled";
const META_AUTO = "approvals.auto_approve";
const META_HOOK_SEEN = "approvals.hook_seen_at";
const HOOK_TRUST_MS = 7 * 24 * 3600_000;
const BODY_MAX_CHARS = 2400;
const BODY_MAX_LINES = 60;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

// ── preview (pure) ────────────────────────────────────────────────────────

function cleanBlock(raw: string): string {
  // Keep newlines and tabs, drop other control chars (terminal escapes etc.).
  let t = redactSecrets(raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
  const lines = t.split("\n");
  if (lines.length > BODY_MAX_LINES) t = [...lines.slice(0, BODY_MAX_LINES), `… ${lines.length - BODY_MAX_LINES} more lines`].join("\n");
  if (t.length > BODY_MAX_CHARS) t = t.slice(0, BODY_MAX_CHARS - 1) + "…";
  return t;
}

function cleanLine(raw: string, max = 200): string {
  let t = redactSecrets(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  if (t.length > max) t = t.slice(0, max - 1) + "…";
  return t;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function displayPath(cwd: string, p: string): string {
  if (!cwd || !p.startsWith("/")) return p;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

function diffBody(oldS: string, newS: string): string {
  const minus = oldS ? oldS.split("\n").map((l) => `- ${l}`) : [];
  const plus = newS ? newS.split("\n").map((l) => `+ ${l}`) : [];
  return [...minus.slice(0, 25), ...(minus.length > 25 ? ["- …"] : []), ...plus.slice(0, 30), ...(plus.length > 30 ? ["+ …"] : [])].join("\n");
}

export function buildPreview(toolName: string, input: Record<string, unknown>, cwd: string): ApprovalPreview {
  const path = displayPath(cwd, str(input.file_path) || str(input.notebook_path));
  switch (toolName) {
    case "Bash":
      return { kind: "command", title: cleanLine(str(input.description) || "Run a shell command"), body: cleanBlock(str(input.command)) };
    case "Edit":
      return { kind: "diff", title: cleanLine(path || "Edit a file"), body: cleanBlock(diffBody(str(input.old_string), str(input.new_string))) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
      const body = edits
        .slice(0, 3)
        .map((e) => diffBody(str(e.old_string), str(e.new_string)))
        .join("\n@@\n");
      return { kind: "diff", title: cleanLine(`${path || "Edit a file"} (${edits.length} edits)`), body: cleanBlock(body) };
    }
    case "Write":
      return { kind: "file", title: cleanLine(path || "Write a file"), body: cleanBlock(str(input.content)) };
    case "NotebookEdit":
      return { kind: "file", title: cleanLine(path || "Edit a notebook"), body: cleanBlock(str(input.new_source)) };
    case "WebFetch":
      return { kind: "generic", title: cleanLine(str(input.url) || "Fetch a URL"), body: cleanBlock(str(input.prompt)) };
    default: {
      let json = "";
      try {
        json = JSON.stringify(input, null, 2);
      } catch {
        json = "";
      }
      return { kind: "generic", title: cleanLine(toolName), body: cleanBlock(json === "{}" ? "" : json) };
    }
  }
}

// ── queue ─────────────────────────────────────────────────────────────────

interface Stored {
  view: ApprovalView;
  expiresAtMs: number;
  status: "pending" | "decided" | "expired";
  behavior?: ApprovalBehavior;
  message?: string;
  settledAtMs?: number;
}

export interface QueueOptions {
  now?: () => number;
  expiryMs?: number;
}

export class ApprovalQueue {
  private readonly items = new Map<string, Stored>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private readonly expiryMs: number;

  constructor(opts: QueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.expiryMs = opts.expiryMs ?? APPROVAL_EXPIRY_MS;
  }

  /** "55s" (or whatever this instance's expiry is) — for the one-line expiry log. */
  expirySecondsLabel(): string {
    return `${Math.round(this.expiryMs / 1000)}s`;
  }

  add(input: { agentId: string; cwd: string; toolName: string; preview: ApprovalPreview }): ApprovalView {
    const at = this.now();
    const view: ApprovalView = {
      id: randomUUID(),
      agentId: input.agentId,
      cwd: input.cwd,
      toolName: input.toolName,
      preview: input.preview,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.expiryMs).toISOString(),
    };
    this.items.set(view.id, { view, expiresAtMs: at + this.expiryMs, status: "pending" });
    return view;
  }

  decide(id: string, behavior: ApprovalBehavior, message?: string): "ok" | "not-found" | "not-pending" | "expired" {
    this.sweep();
    const s = this.items.get(id);
    if (!s) return "not-found";
    if (s.status === "expired") return "expired";
    if (s.status !== "pending") return "not-pending";
    s.status = "decided";
    s.behavior = behavior;
    if (message !== undefined) s.message = message;
    s.settledAtMs = this.now();
    this.wake(id);
    return "ok";
  }

  poll(id: string): ApprovalPollResult | null {
    this.sweep();
    const s = this.items.get(id);
    if (!s) return null;
    if (s.status === "pending") return { status: "pending" };
    if (s.status === "expired" || !s.behavior) return { status: "expired" };
    return s.message !== undefined ? { status: "decided", behavior: s.behavior, message: s.message } : { status: "decided", behavior: s.behavior };
  }

  /** Resolves when `id` is settled, or after `timeoutMs`, or when `abort` fires. */
  wait(id: string, timeoutMs: number, onAbort?: (cancel: () => void) => void): Promise<void> {
    return new Promise((resolvePromise) => {
      const set = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, set);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(id);
        resolvePromise();
      };
      set.add(done);
      timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, this.remainingMs(id))));
      onAbort?.(done);
    });
  }

  private remainingMs(id: string): number {
    const s = this.items.get(id);
    return s && s.status === "pending" ? s.expiresAtMs - this.now() + 5 : 0;
  }

  private wake(id: string): void {
    for (const fn of [...(this.waiters.get(id) ?? [])]) fn();
  }

  /** Marks overdue requests expired and forgets old settled ones. Returns newly expired views. */
  sweep(): ApprovalView[] {
    const now = this.now();
    const expired: ApprovalView[] = [];
    for (const [id, s] of this.items) {
      if (s.status === "pending" && now >= s.expiresAtMs) {
        s.status = "expired";
        s.settledAtMs = now;
        expired.push(s.view);
        this.wake(id);
      } else if (s.status !== "pending" && now - (s.settledAtMs ?? now) > DECIDED_RETENTION_MS) {
        this.items.delete(id);
      }
    }
    return expired;
  }

  get(id: string): ApprovalView | null {
    return this.items.get(id)?.view ?? null;
  }

  pending(): ApprovalView[] {
    this.sweep();
    return [...this.items.values()].filter((s) => s.status === "pending").map((s) => s.view);
  }

  pendingAgents(): Set<string> {
    return new Set(this.pending().map((v) => v.agentId));
  }

  toJSON(): string {
    return JSON.stringify([...this.items.values()]);
  }

  load(json: string | null): void {
    if (!json) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const raw of parsed) {
      if (!isRecord(raw) || !isRecord(raw.view) || typeof raw.view.id !== "string" || typeof raw.expiresAtMs !== "number") continue;
      const status = raw.status === "pending" || raw.status === "decided" || raw.status === "expired" ? raw.status : null;
      if (!status) continue;
      const stored: Stored = { view: raw.view as unknown as ApprovalView, expiresAtMs: raw.expiresAtMs, status };
      if (isBehavior(raw.behavior)) stored.behavior = raw.behavior;
      if (typeof raw.message === "string") stored.message = raw.message;
      if (typeof raw.settledAtMs === "number") stored.settledAtMs = raw.settledAtMs;
      this.items.set(raw.view.id, stored);
    }
    this.sweep();
  }
}

function isBehavior(v: unknown): v is ApprovalBehavior {
  return v === "allow" || v === "deny" || v === "passthrough";
}

// ── auto-approve (pure) ───────────────────────────────────────────────────

/** With auto-approve ON these still wait for a human: Steph's Layer-1 hard stops (merging, pushing
 *  to main, force pushes, production deploys). Everything else is allowed at once. The whole Bash
 *  command text is matched, so a chained command (`a && <hard stop>`) is caught too. */
export const AUTO_HOLD_BASH: readonly RegExp[] = [
  /\bgh\s+pr\s+merge\b/,
  /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/,
  /\bgit\s+push\b[^|;&]*[\s:](main|master)\b/,
  /\bvercel\b[^|;&]*--prod\b/,
  /\balef-live\s+deploy\b/,
];
const AUTO_HOLD_TOOL = /(^|__)merge_pull_request$/;

/** Why this request still goes to a human under auto-approve, or null when it may be allowed. */
export function autoHoldReason(toolName: string, input: Record<string, unknown>): string | null {
  if (AUTO_HOLD_TOOL.test(toolName)) return "merges a pull request";
  if (toolName !== "Bash") return null;
  const cmd = str(input.command);
  const hit = AUTO_HOLD_BASH.find((re) => re.test(cmd));
  return hit ? `matches hard stop ${hit.source}` : null;
}

// ── feature ───────────────────────────────────────────────────────────────

export interface ApprovalsFeatureOptions extends QueueOptions {
  pollMaxMs?: number;
}

export function createApprovalsFeature(opts: ApprovalsFeatureOptions = {}): { feature: ServerFeature; queue: ApprovalQueue; hookInstalled: () => boolean } {
  const queue = new ApprovalQueue(opts);
  const pollMaxMs = opts.pollMaxMs ?? POLL_MAX_MS;
  let loaded = false;
  let hookSeenAt = 0;

  function ensureLoaded(ctx: FeatureContext): void {
    if (loaded) return;
    loaded = true;
    queue.load(ctx.db.getMeta(META_QUEUE));
    hookSeenAt = Number(ctx.db.getMeta(META_HOOK_SEEN) ?? 0) || 0;
  }
  function persist(ctx: FeatureContext): void {
    ctx.db.setMeta(META_QUEUE, queue.toJSON());
  }
  function enabled(ctx: FeatureContext): boolean {
    return ctx.db.getMeta(META_ENABLED) !== "0"; // default ON
  }
  function autoApprove(ctx: FeatureContext): boolean {
    return ctx.db.getMeta(META_AUTO) === "1"; // default OFF
  }
  function settings(ctx: FeatureContext): { enabled: boolean; autoApprove: boolean } {
    return { enabled: enabled(ctx), autoApprove: autoApprove(ctx) };
  }
  function emit(ctx: FeatureContext, msg: ApprovalsMessage): void {
    ctx.emit(msg);
  }
  function resolved(ctx: FeatureContext, view: ApprovalView, outcome: ApprovalOutcome): void {
    emit(ctx, { kind: "resolved", id: view.id, agentId: view.agentId, outcome });
  }
  /** Every request that times out gets exactly one line: `sweep()` only ever returns a given
   *  id once (it flips pending → expired), so this can't double-log. */
  function logExpired(ctx: FeatureContext, expired: readonly ApprovalView[]): void {
    for (const v of expired) {
      resolved(ctx, v, "expired");
      ctx.log.info("approvals", `expired ${v.toolName} for ${v.agentId.slice(0, 8)}: nobody answered in ${queue.expirySecondsLabel()}, the terminal prompt took over`);
    }
  }

  async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    try {
      const b = await readJsonBody(req);
      if (isRecord(b)) return b;
    } catch {
      // fall through
    }
    respondJson(res, 400, { ok: false, error: "JSON object body required" });
    return null;
  }

  const feature: ServerFeature = {
    id: "approvals",
    tickIntervalMs: 2_000,
    routes: [
      {
        method: "GET",
        path: "/api/approvals/settings",
        handler(_req, res, ctx) {
          respondJson(res, 200, settings(ctx));
        },
      },
      {
        method: "POST",
        path: "/api/approvals/settings",
        async handler(req, res, ctx) {
          const b = await body(req, res);
          if (!b) return;
          const hasEnabled = typeof b.enabled === "boolean";
          const hasAuto = typeof b.autoApprove === "boolean";
          if ((b.enabled !== undefined && !hasEnabled) || (b.autoApprove !== undefined && !hasAuto) || (!hasEnabled && !hasAuto)) {
            return respondJson(res, 400, { ok: false, error: "enabled and/or autoApprove (boolean) is required" });
          }
          if (hasEnabled) ctx.db.setMeta(META_ENABLED, b.enabled ? "1" : "0");
          if (hasAuto) {
            ctx.db.setMeta(META_AUTO, b.autoApprove ? "1" : "0");
            ctx.log.info("approvals", `auto-approve ${b.autoApprove ? "ON" : "OFF"}`);
          }
          const now = settings(ctx);
          emit(ctx, { kind: "settings", ...now });
          respondJson(res, 200, now);
        },
      },
      {
        method: "GET",
        path: "/api/approvals",
        handler(_req, res, ctx) {
          ensureLoaded(ctx);
          respondJson(res, 200, { enabled: enabled(ctx), pending: queue.pending() });
        },
      },
      {
        method: "POST",
        path: "/api/approvals",
        async handler(req, res, ctx) {
          ensureLoaded(ctx);
          const b = await body(req, res);
          if (!b) return;
          const input = isRecord(b.tool_input) ? b.tool_input : {};
          const auto = autoApprove(ctx) && autoHoldReason(typeof b.tool_name === "string" ? b.tool_name : "", input) === null;
          // Auto-approve answers even with the world toggle OFF; a held request follows the toggle.
          if (!enabled(ctx) && !auto) {
            res.writeHead(204);
            res.end();
            return;
          }
          const sessionId = typeof b.session_id === "string" ? b.session_id : "";
          const toolName = typeof b.tool_name === "string" ? b.tool_name : "";
          const cwd = typeof b.cwd === "string" && b.cwd.length <= 4096 ? b.cwd : "";
          if (!SESSION_ID_RE.test(sessionId)) return respondJson(res, 400, { ok: false, error: "session_id invalid" });
          if (!TOOL_NAME_RE.test(toolName)) return respondJson(res, 400, { ok: false, error: "tool_name invalid" });
          if (b.agent_world_hook === 1) {
            hookSeenAt = Date.now();
            ctx.db.setMeta(META_HOOK_SEEN, String(hookSeenAt));
          }
          const view = queue.add({ agentId: sessionId, cwd, toolName, preview: buildPreview(toolName, input, cwd) });
          if (auto) {
            // Decided before anyone sees it: no card, and the hook's first poll returns allow.
            queue.decide(view.id, "allow");
            persist(ctx);
            ctx.log.info("approvals", `auto-allowed ${toolName} for ${sessionId.slice(0, 8)}`);
            return respondJson(res, 201, { id: view.id });
          }
          if (autoApprove(ctx)) ctx.log.info("approvals", `auto-approve held ${toolName} for ${sessionId.slice(0, 8)}: ${autoHoldReason(toolName, input)}`);
          persist(ctx);
          emit(ctx, { kind: "added", approval: view });
          ctx.log.info("approvals", `queued ${toolName} for ${sessionId.slice(0, 8)}`);
          respondJson(res, 201, { id: view.id });
        },
      },
      {
        method: "GET",
        path: "/api/approvals/:id",
        async handler(_req, res, ctx, params) {
          ensureLoaded(ctx);
          const id = params.id ?? "";
          let r = queue.poll(id);
          if (!r) return respondJson(res, 404, { status: "expired" } satisfies ApprovalPollResult);
          if (r.status === "pending") {
            await queue.wait(id, pollMaxMs, (cancel) => res.on("close", cancel));
            const expired = queue.sweep();
            logExpired(ctx, expired);
            if (expired.length) persist(ctx);
            r = queue.poll(id) ?? { status: "expired" };
          }
          if (!res.writableEnded && !res.destroyed) respondJson(res, 200, r);
        },
      },
      {
        method: "POST",
        path: "/api/approvals/:id/decision",
        async handler(req, res, ctx, params) {
          ensureLoaded(ctx);
          const b = await body(req, res);
          if (!b) return;
          if (!isBehavior(b.behavior)) return respondJson(res, 400, { ok: false, error: 'behavior must be "allow", "deny" or "passthrough"' });
          if (b.message !== undefined && (typeof b.message !== "string" || b.message.length > 500)) {
            return respondJson(res, 400, { ok: false, error: "message must be a string of ≤500 chars" });
          }
          if (b.message !== undefined && b.behavior !== "deny") return respondJson(res, 400, { ok: false, error: "message is only valid with deny" });
          const id = params.id ?? "";
          // Sweep first (and log/persist any newly-expired requests) so a request that just
          // crossed the deadline gets one clean 410, not a stale "ok" for a hook nobody's polling.
          const expired = queue.sweep();
          logExpired(ctx, expired);
          if (expired.length) persist(ctx);
          const view = queue.get(id);
          const outcome = queue.decide(id, b.behavior, typeof b.message === "string" ? cleanLine(b.message, 500) : undefined);
          if (outcome === "not-found" || !view) return respondJson(res, 404, { ok: false, error: "unknown or expired request" });
          if (outcome === "expired") return respondJson(res, 410, { ok: false, error: "Too late: that request expired and the terminal prompt took over." });
          if (outcome === "not-pending") return respondJson(res, 409, { ok: false, error: "already settled" });
          persist(ctx);
          resolved(ctx, view, b.behavior);
          ctx.log.info("approvals", `${b.behavior} ${view.toolName} for ${view.agentId.slice(0, 8)}`);
          respondJson(res, 200, { ok: true });
        },
      },
    ],
    onTick(ctx) {
      ensureLoaded(ctx);
      const expired = queue.sweep();
      logExpired(ctx, expired);
      if (expired.length) persist(ctx);
    },
    snapshotExtras(ctx) {
      ensureLoaded(ctx);
      return { "approvals.pending": queue.pending(), "approvals.enabled": enabled(ctx), "approvals.autoApprove": autoApprove(ctx) };
    },
  };
  /** True once the real hook has posted within the last week: its queue is then the ground truth. */
  const hookInstalled = (): boolean => hookSeenAt > 0 && Date.now() - hookSeenAt < HOOK_TRUST_MS;
  return { feature, queue, hookInstalled };
}

const defaultApprovals = createApprovalsFeature();
export const approvalsFeature = defaultApprovals.feature;

/** Agents with a queued PermissionRequest right now (read by agent-state). */
export function pendingApprovalAgents(): ReadonlySet<string> {
  return defaultApprovals.queue.pendingAgents();
}

/** Whether the real PermissionRequest hook has been seen recently (read by agent-state). */
export function approvalsHookInstalled(): boolean {
  return defaultApprovals.hookInstalled();
}

/** Pending approval requests right now (read by the feed). */
export function pendingApprovalViews(): ApprovalView[] {
  return defaultApprovals.queue.pending();
}
