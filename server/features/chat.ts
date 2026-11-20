// Round 10 §1 — chat with an agent from its Room screen, driven by the owner's own `claude` CLI in
// headless stream-json mode (Max plan login; the Agent SDK would need an API key). One process
// per turn: `claude -p … --resume <sessionId> --model <m>` (a new chat's first turn uses
// `--session-id <uuid>` instead), so the model can change per message. Events stream to the
// client over the WS feature channel (ctx.emit); see shared/features/chat.ts for the wire.
//
// Safety: spawn with an argv array (never a shell); cwd must be a directory the world already
// knows (the agent's session or a city); Stop signals ONLY that turn's child (SIGINT, then
// SIGTERM). Approvals: the PermissionRequest hook (hooks/permission-request.mjs) still runs under
// -p, so tool prompts land in Alef's approval queue; anything nobody approves is denied
// (`--permission-prompts none`) and the panel says so instead of showing a silent success.
// Uploads: images (magic bytes) + UTF-8 text only, ≤10 MB each, stored under data/chat-uploads/.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  CHAT_MAX_ATTACHMENTS,
  CHAT_MAX_TEXT,
  CHAT_MODELS,
  CHAT_MODES,
  type ChatActionResult,
  type ChatEvent,
  type ChatMessage,
  type ChatMode,
  type ChatModel,
  type ChatOpenResult,
  type ChatView,
} from "../../shared/features/chat.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import {
  addUsage,
  buildClaudeArgs,
  buildUserMessage,
  emptyTrace,
  forkDecision,
  LineSplitter,
  parseStreamLine,
  traceEvent,
  turnVerdict,
  validateAttachment,
  type StoredAttachment,
  type TurnTrace,
} from "./chat-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const META_CHATS = "chat.chats";
const MAX_CHATS = 40;
const MAX_EVENTS = 600;
const STOP_GRACE_MS = 4_000;
const STDERR_TAIL = 2_000;
/** 4 attachments × 10 MB, base64 (+33%), plus the text. */
const MAX_TURN_BODY_BYTES = 60 * 1024 * 1024;
const CHAT_ID_RE = /^c-[a-f0-9]{12}$/;

interface ChatRecord {
  view: ChatView;
  events: ChatEvent[];
  /** The session file exists (resume it) vs a brand-new chat (start it with --session-id). */
  sessionOnDisk: boolean;
  child: ChildProcess | null;
  trace: TurnTrace | null;
}

export interface ChatExec {
  findClaude(): Promise<string | null>;
  spawn(bin: string, args: readonly string[], cwd: string): ChildProcess;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const realChatExec: ChatExec = {
  async findClaude() {
    const dirs = [
      ...(process.env.PATH ?? "").split(delimiter),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(homedir(), ".local/bin"),
      join(homedir(), ".claude/local"),
    ].filter(Boolean);
    for (const d of new Set(dirs)) {
      const p = join(d, "claude");
      if (await isExecutable(p)) return p;
    }
    return null;
  },
  spawn(bin, args, cwd) {
    const env = { ...process.env };
    delete env.CLAUDECODE; // the dev server may itself run under a Claude session
    return spawn(bin, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  },
};

/** Reads a JSON body up to `max` bytes (the hub's readJsonBody caps at 16 KB; uploads need more). */
function readBigJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        rejectPromise(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolvePromise(raw ? JSON.parse(raw) : null);
      } catch (err) {
        rejectPromise(err);
      }
    });
    req.on("error", rejectPromise);
  });
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function uploadsRoot(ctx: FeatureContext): string {
  const db = ctx.config.dbPath;
  return db === ":memory:" ? join(tmpdir(), "agent-world-chat-uploads") : join(dirname(db), "chat-uploads");
}

function parseView(v: unknown): ChatView | null {
  if (!isRecord(v) || typeof v.id !== "string" || !CHAT_ID_RE.test(v.id)) return null;
  if (typeof v.cwd !== "string" || typeof v.islandId !== "string" || typeof v.createdAt !== "string") return null;
  const u = isRecord(v.usage) ? v.usage : {};
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    id: v.id,
    sessionId: typeof v.sessionId === "string" && isValidUuid(v.sessionId) ? v.sessionId : null,
    originAgentId: typeof v.originAgentId === "string" && isValidUuid(v.originAgentId) ? v.originAgentId : null,
    islandId: v.islandId,
    cwd: v.cwd,
    title: typeof v.title === "string" ? v.title : "",
    createdAt: v.createdAt,
    running: false,
    turns: n(v.turns),
    usage: { inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), cacheReadTokens: n(u.cacheReadTokens), cacheCreationTokens: n(u.cacheCreationTokens) },
    sessionCostUsd: typeof v.sessionCostUsd === "number" ? v.sessionCostUsd : null,
    forked: v.forked === true,
  };
}

export function createChatFeature(exec: ChatExec = realChatExec, now: () => number = Date.now): ServerFeature {
  let chats: Map<string, ChatRecord> | null = null;

  function load(ctx: FeatureContext): Map<string, ChatRecord> {
    if (chats) return chats;
    chats = new Map();
    try {
      const parsed: unknown = JSON.parse(ctx.db.getMeta(META_CHATS) ?? "[]");
      if (Array.isArray(parsed)) {
        for (const x of parsed) {
          const view = parseView(x);
          // A persisted chat has run at least one turn when its session id is set and turns > 0.
          if (view) chats.set(view.id, { view, events: [], sessionOnDisk: view.turns > 0 || view.originAgentId !== null, child: null, trace: null });
        }
      }
    } catch {
      // corrupt value: start empty
    }
    return chats;
  }

  function save(ctx: FeatureContext): void {
    const list = [...load(ctx).values()].map((r) => r.view).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const keep = list.slice(0, MAX_CHATS);
    for (const v of list.slice(MAX_CHATS)) {
      const r = load(ctx).get(v.id);
      if (r && !r.child) load(ctx).delete(v.id);
    }
    ctx.db.setMeta(META_CHATS, JSON.stringify(keep.map((v) => ({ ...v, running: false }))));
  }

  function push(ctx: FeatureContext, rec: ChatRecord, event: ChatEvent): void {
    // Token deltas are live-only; the final assistant-text is what history keeps.
    if (event.kind !== "text-delta") {
      rec.events.push(event);
      if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
    }
    ctx.emit({ kind: "event", chatId: rec.view.id, event } satisfies ChatMessage);
  }

  function announce(ctx: FeatureContext, rec: ChatRecord): void {
    ctx.emit({ kind: "chat", chat: rec.view } satisfies ChatMessage);
  }

  /** Is this session open in a terminal / VS Code right now? Only asked before a chat's first send:
   *  afterwards "live" (a jsonl touched < 120s ago) would just be our own last turn. */
  function liveElsewhere(ctx: FeatureContext, rec: ChatRecord): boolean {
    if (rec.child || !rec.view.sessionId || rec.view.turns > 0) return false;
    const id = rec.view.sessionId;
    return ctx.worldViews().agents.some((a) => a.id === id && a.status === "live");
  }

  function openResult(ctx: FeatureContext, rec: ChatRecord): ChatOpenResult {
    return { ok: true, chat: rec.view, events: rec.events, liveElsewhere: liveElsewhere(ctx, rec) };
  }

  function newRecord(islandId: string, cwd: string, title: string, sessionId: string, originAgentId: string | null, onDisk: boolean): ChatRecord {
    return {
      view: {
        id: `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        sessionId,
        originAgentId,
        islandId,
        cwd,
        title,
        createdAt: new Date(now()).toISOString(),
        running: false,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        sessionCostUsd: null,
        forked: false,
      },
      events: [],
      sessionOnDisk: onDisk,
      child: null,
      trace: null,
    };
  }

  async function saveUploads(ctx: FeatureContext, chatId: string, raw: unknown[]): Promise<{ ok: true; stored: StoredAttachment[] } | { ok: false; error: string }> {
    const stored: StoredAttachment[] = [];
    if (raw.length === 0) return { ok: true, stored };
    const dir = join(uploadsRoot(ctx), chatId);
    await mkdir(dir, { recursive: true });
    for (const [i, u] of raw.entries()) {
      const att = validateAttachment(u);
      if (!att.ok) return { ok: false, error: att.error };
      const path = join(dir, `${now()}-${i}-${att.name}`);
      await writeFile(path, att.bytes, { mode: 0o600 });
      stored.push({ att, path });
    }
    return { ok: true, stored };
  }

  function runTurn(ctx: FeatureContext, rec: ChatRecord, bin: string, args: string[], line: string): void {
    const trace = emptyTrace();
    rec.trace = trace;
    const child = exec.spawn(bin, args, rec.view.cwd);
    rec.child = child;
    rec.view.running = true;
    announce(ctx, rec);
    const out = new LineSplitter();
    let stderr = "";
    let finished = false;

    const onEvent = (ev: ChatEvent): void => {
      traceEvent(trace, ev);
      if (ev.kind === "init") {
        if (ev.sessionId !== rec.view.sessionId && isValidUuid(ev.sessionId)) rec.view.sessionId = ev.sessionId; // --fork-session gives a new id
        rec.sessionOnDisk = true;
      } else if (ev.kind === "result") {
        rec.view.usage = addUsage(rec.view.usage, ev.usage);
        if (ev.costUsd !== null) rec.view.sessionCostUsd = ev.costUsd;
        // The turn is over: close stdin so claude exits (it waits for more input otherwise).
        child.stdin?.end();
      }
      push(ctx, rec, ev);
    };
    const onLines = (lines: string[]): void => {
      for (const l of lines) for (const ev of parseStreamLine(l)) onEvent(ev);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onLines(out.push(chunk)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin?.on("error", () => {
      // EPIPE when claude dies early: the close handler reports it
    });

    const finish = (code: number | null, signal: string | null, spawnError?: string): void => {
      if (finished) return;
      finished = true;
      onLines(out.flush());
      trace.exitCode = code;
      trace.signal = signal;
      trace.stderrTail = spawnError ?? stderr;
      const verdict = turnVerdict(trace);
      if (verdict) push(ctx, rec, { kind: "notice", level: verdict.level, text: verdict.text });
      rec.child = null;
      rec.trace = null;
      rec.view.running = false;
      rec.view.turns += 1;
      save(ctx);
      announce(ctx, rec);
      ctx.log.info("chat", `turn ended ${rec.view.id} code=${code ?? "-"} signal=${signal ?? "-"} result=${trace.sawResult}`);
    };
    child.on("error", (err) => finish(null, null, String(err)));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin?.write(`${line}\n`);
  }

  function reply(res: Parameters<typeof respondJson>[0], status: number, body: ChatActionResult | ChatOpenResult): void {
    respondJson(res, status, body);
  }

  function chatOf(ctx: FeatureContext, id: string | undefined): ChatRecord | null {
    if (!id || !CHAT_ID_RE.test(id)) return null;
    return load(ctx).get(id) ?? null;
  }

  return {
    id: "chat",
    routes: [
      {
        method: "GET",
        path: "/api/chat/list",
        handler(_req, res, ctx) {
          const views = [...load(ctx).values()].map((r) => r.view).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          respondJson(res, 200, { ok: true, chats: views });
        },
      },
      {
        method: "POST",
        path: "/api/chat/open",
        async handler(req, res, ctx) {
          let b: unknown;
          try {
            b = await readJsonBody(req);
          } catch {
            return reply(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const agentId = isRecord(b) && typeof b.agentId === "string" ? b.agentId : "";
          const islandId = isRecord(b) && typeof b.islandId === "string" ? b.islandId : "";
          if (agentId) {
            if (!isValidUuid(agentId)) return reply(res, 400, { ok: false, error: "invalid agent id" });
            const session = ctx.db.getSession(agentId);
            if (!session) return reply(res, 404, { ok: false, error: "unknown agent id" });
            if (!(await isDir(session.cwd))) return reply(res, 409, { ok: false, error: `its folder is gone: ${session.cwd}` });
            const existing = [...load(ctx).values()].find((r) => r.view.originAgentId === agentId);
            if (existing) return reply(res, 200, openResult(ctx, existing));
            const agent = ctx.worldViews().agents.find((a) => a.id === agentId);
            const rec = newRecord(agent?.islandId ?? "", session.cwd, agent?.title ?? "", agentId, agentId, true);
            load(ctx).set(rec.view.id, rec);
            save(ctx);
            return reply(res, 200, openResult(ctx, rec));
          }
          if (!islandId || islandId === "harness") return reply(res, 400, { ok: false, error: "an agent id or a project city is required" });
          const cwd = ctx.db.getIslandCwd(islandId);
          if (!cwd) return reply(res, 404, { ok: false, error: "unknown city" });
          if (!(await isDir(cwd))) return reply(res, 409, { ok: false, error: `the city's folder is gone: ${cwd}` });
          const rec = newRecord(islandId, cwd, "New chat", randomUUID(), null, false);
          load(ctx).set(rec.view.id, rec);
          save(ctx);
          reply(res, 200, openResult(ctx, rec));
        },
      },
      {
        method: "GET",
        path: "/api/chat/:chatId",
        handler(_req, res, ctx, params) {
          const rec = chatOf(ctx, params.chatId);
          if (!rec) return reply(res, 404, { ok: false, error: "unknown chat" });
          reply(res, 200, openResult(ctx, rec));
        },
      },
      {
        method: "POST",
        path: "/api/chat/:chatId/turn",
        async handler(req, res, ctx, params) {
          const rec = chatOf(ctx, params.chatId);
          if (!rec) return reply(res, 404, { ok: false, error: "unknown chat" });
          if (rec.child) return reply(res, 409, { ok: false, error: "a turn is already running; Stop it first" });
          let b: unknown;
          try {
            b = await readBigJsonBody(req, MAX_TURN_BODY_BYTES);
          } catch (err) {
            return reply(res, String(err).includes("too large") ? 413 : 400, { ok: false, error: String(err).includes("too large") ? "attachments too large" : "invalid JSON body" });
          }
          if (!isRecord(b)) return reply(res, 400, { ok: false, error: "invalid body" });
          const text = typeof b.text === "string" ? b.text.replace(/\r\n?/g, "\n") : "";
          const model = CHAT_MODELS.find((m) => m === b.model);
          const mode = CHAT_MODES.find((m) => m === b.mode);
          const rawAtts = Array.isArray(b.attachments) ? b.attachments : [];
          if (!text.trim() && rawAtts.length === 0) return reply(res, 400, { ok: false, error: "write a message first" });
          if (text.length > CHAT_MAX_TEXT) return reply(res, 400, { ok: false, error: `message is over ${CHAT_MAX_TEXT} characters` });
          if (!model) return reply(res, 400, { ok: false, error: "model must be opus, sonnet or haiku" });
          if (!mode) return reply(res, 400, { ok: false, error: "mode must be normal, plan or acceptEdits" });
          if (rawAtts.length > CHAT_MAX_ATTACHMENTS) return reply(res, 400, { ok: false, error: `at most ${CHAT_MAX_ATTACHMENTS} attachments` });
          if (!(await isDir(rec.view.cwd))) return reply(res, 409, { ok: false, error: `the folder is gone: ${rec.view.cwd}` });
          const sessionId = rec.view.sessionId;
          if (!sessionId) return reply(res, 409, { ok: false, error: "this chat has no session id" });

          const fork = forkDecision({ liveElsewhere: liveElsewhere(ctx, rec), alreadyForked: rec.view.forked, resume: rec.sessionOnDisk, acknowledged: b.forkAcknowledged === true });
          if (fork === "needs-ack") return reply(res, 409, { ok: false, error: "this session is open elsewhere: continuing here creates a fork (confirm first)" });

          const bin = await exec.findClaude();
          if (!bin) return reply(res, 409, { ok: false, error: "the claude CLI was not found on PATH" });
          let uploads: Awaited<ReturnType<typeof saveUploads>>;
          try {
            uploads = await saveUploads(ctx, rec.view.id, rawAtts);
          } catch (err) {
            return reply(res, 500, { ok: false, error: `could not save attachments: ${String(err)}` });
          }
          if (!uploads.ok) return reply(res, 400, { ok: false, error: uploads.error });

          const args = buildClaudeArgs({ sessionId, resume: rec.sessionOnDisk, fork: fork === "fork", model: model as ChatModel, mode: mode as ChatMode });
          if (fork === "fork") rec.view.forked = true;
          if (rec.view.title === "New chat" && text.trim()) rec.view.title = text.trim().replace(/\s+/g, " ").slice(0, 80);
          push(ctx, rec, { kind: "user", text, attachments: uploads.stored.map((s) => s.att.name), model: model as ChatModel, mode: mode as ChatMode });
          try {
            runTurn(ctx, rec, bin, args, buildUserMessage(text, uploads.stored));
          } catch (err) {
            rec.child = null;
            rec.view.running = false;
            push(ctx, rec, { kind: "notice", level: "error", text: `could not start claude: ${String(err)}` });
            return reply(res, 500, { ok: false, error: String(err) });
          }
          ctx.log.info("chat", `turn started ${rec.view.id} model=${model} mode=${mode}${fork === "fork" ? " (fork)" : ""} atts=${uploads.stored.length}`);
          reply(res, 200, { ok: true });
        },
      },
      {
        method: "POST",
        path: "/api/chat/:chatId/stop",
        handler(_req, res, ctx, params) {
          const rec = chatOf(ctx, params.chatId);
          if (!rec) return reply(res, 404, { ok: false, error: "unknown chat" });
          const child = rec.child;
          if (!child) return reply(res, 409, { ok: false, error: "nothing is running" });
          if (rec.trace) rec.trace.stoppedByUser = true;
          // SIGINT ends the turn cleanly (docs: headless "Stop a run"); SIGTERM only if it lingers.
          child.kill("SIGINT");
          const timer = setTimeout(() => {
            if (rec.child === child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          }, STOP_GRACE_MS);
          child.once("close", () => clearTimeout(timer));
          reply(res, 200, { ok: true });
        },
      },
    ],
    snapshotExtras(ctx) {
      return { "chat.running": [...load(ctx).values()].filter((r) => r.child).map((r) => r.view.id) };
    },
  };
}

export const chatFeature = createChatFeature();
