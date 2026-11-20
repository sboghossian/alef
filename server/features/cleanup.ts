// P2 "cleanup" (🪦 Retire & tidy up). Suggests sessions, dead Alef tmux sessions and stale
// worktrees that could go, and retires sessions by MOVING their files into ~/.alef-trash with a
// manifest (cleanup-trash.ts). Nothing is deleted, restore is one click, nothing runs on a timer.
//
// Routes (all user-click only; the server re-checks every live-guard itself, whatever the
// client sends):
//   GET  /api/cleanup/candidates?tiny=5&dormantDays=90   read-only suggestion buckets (60 s cache)
//   POST /api/cleanup/retire   {ids ≤200}                 move to the trash, forget, agentsRemoved
//   GET  /api/cleanup/trash                               batches, newest first
//   POST /api/cleanup/restore  {batchId, ids?}            move back, never overwriting
//   POST /api/cleanup/tmux/:name/close                    save scrollback, then kill a dead aw-*
//   POST /api/cleanup/reveal   {batchId?}                 `open -R` the trash (argv only)
// Worktrees have no route here: the client calls POST /api/fork/remove (clean trees only).

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_DORMANT_DAYS,
  DEFAULT_TINY,
  type CandidatesResponse,
  type CleanupMessage,
  type RestoreResult,
  type RetireResult,
  type TmuxCloseResult,
  type TrashListResponse,
} from "../../shared/features/cleanup.js";
import type { WorldAgent } from "../../shared/types.js";
import { processVouchedSessions } from "../heuristics.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { listClaudeAncestorPids, listProcesses } from "../live.js";
import { isValidUuid } from "../reactivate.js";
import { restoreLegacy, voidLegacy, writeLegacy } from "./alumni.js";
import { pendingApprovalAgents } from "./approvals.js";
import {
  BATCH_ID_RE,
  classifyCandidates,
  idsInArgv,
  isAllowedProjDir,
  isInsideDir,
  liveGuardReason,
  parseRestoreBody,
  parseRetireBody,
  scanHead,
  HEADLESS_MAX_MESSAGES,
  type HeadFacts,
  type SessionCandidateInput,
  type TmuxRow,
  type WorktreeInput,
} from "./cleanup-lib.js";
import { closeDeadTmux, listTmuxRows, realCleanupTmuxExec, type CleanupTmuxExec } from "./cleanup-tmux.js";
import { folderBytes, listTrash, realTrashFs, restoreBatch, retireSessions, saveTmuxScrollback, trashRootOf, type TrashDeps, type TrashFs } from "./cleanup-trash.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { loadTalkBindings, realTalkExec } from "./talk.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const HEAD_BYTES = 256 * 1024;
const UUID_JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CleanupDeps {
  home?: string;
  fs?: TrashFs;
  now?: () => Date;
  tmux?: CleanupTmuxExec;
  /** argv of every running process (ps). */
  processCommands?: () => string[] | Promise<string[]>;
  /** Pids with a running claude below them (live.ts's listClaudeAncestorPids); null when ps fails. */
  claudeAncestors?: () => ReadonlySet<number> | null | Promise<ReadonlySet<number> | null>;
  pendingApprovals?: () => ReadonlySet<string>;
  /** The Claude session(s) this server runs under. */
  currentSessionIds?: () => ReadonlySet<string>;
  /** First `bytes` of a file as utf8 (+ whether it was cut). */
  readHead?: (path: string, bytes: number) => Promise<{ text: string; truncated: boolean }>;
  /** `open -R <path>`. */
  reveal?: (path: string) => Promise<void>;
}

async function realReadHead(path: string, bytes: number): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const size = (await fh.stat()).size;
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: size > bytesRead };
  } finally {
    await fh.close();
  }
}

function envSessionIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"]) {
    const v = process.env[k];
    if (v && isValidUuid(v)) ids.add(v);
  }
  return ids;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Everything the live-guard needs, gathered once per request (ps, lsof, tmux, approvals). */
interface GuardSnapshot {
  nowMs: number;
  agents: Map<string, WorldAgent>;
  vouched: Set<string>;
  argvCommands: string[];
  tmuxRows: TmuxRow[];
  claudeAncestors: ReadonlySet<number> | null;
  tmuxBoundAliveIds: Set<string>;
  tmuxBoundToLive: Set<string>;
  pending: ReadonlySet<string>;
  current: ReadonlySet<string>;
  liveCwds: string[];
  sessionCwds: Map<string, string>;
}

export function createCleanupFeature(deps: CleanupDeps = {}): { feature: ServerFeature; loadCandidates: (ctx: FeatureContext, tiny?: number, dormantDays?: number) => Promise<CandidatesResponse> } {
  const home = deps.home ?? homedir();
  const fs = deps.fs ?? realTrashFs;
  const now = deps.now ?? (() => new Date());
  const tmux = deps.tmux ?? realCleanupTmuxExec(() => realTalkExec.findTmux());
  const processCommands = deps.processCommands ?? (async () => ((await listProcesses()) ?? []).map((p) => p.command));
  const claudeAncestors = deps.claudeAncestors ?? listClaudeAncestorPids;
  const pendingApprovals = deps.pendingApprovals ?? pendingApprovalAgents;
  const currentSessionIds = deps.currentSessionIds ?? envSessionIds;
  const readHead = deps.readHead ?? realReadHead;
  const reveal = deps.reveal ?? (async (p: string) => void (await execFileAsync("open", ["-R", p], { timeout: 5000 })));

  let cache: { key: string; at: number; value: CandidatesResponse } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  /** Retire/restore/close run one at a time. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  const trashDeps = (ctx: FeatureContext): TrashDeps => ({ home, projectsDir: ctx.config.projectsDir, fs, now });

  async function snapshot(ctx: FeatureContext): Promise<GuardSnapshot> {
    const liveCwdMap = ctx.detectLive();
    const views = ctx.worldViews();
    const agents = new Map(views.agents.map((a) => [a.id, a]));
    const sessions = ctx.db.listSessions();
    const vouched = processVouchedSessions(sessions, liveCwdMap);
    const tmuxRows = await listTmuxRows(tmux);
    const aliveNames = new Set(tmuxRows.filter((r) => !r.dead).map((r) => r.name));
    const tmuxBoundAliveIds = new Set<string>();
    const tmuxBoundToLive = new Set<string>();
    for (const b of loadTalkBindings(ctx.db)) {
      if (!b.agentId) continue;
      if (aliveNames.has(b.tmuxName)) tmuxBoundAliveIds.add(b.agentId);
      if (agents.get(b.agentId)?.status === "live") tmuxBoundToLive.add(b.tmuxName);
    }
    return {
      nowMs: now().getTime(),
      agents,
      vouched,
      argvCommands: await processCommands(),
      tmuxRows,
      // Read after the tmux list, so a pane's claude is never missed for having started in between.
      claudeAncestors: tmuxRows.length > 0 ? await claudeAncestors() : new Set<number>(),
      tmuxBoundAliveIds,
      tmuxBoundToLive,
      pending: pendingApprovals(),
      current: currentSessionIds(),
      liveCwds: [...liveCwdMap.keys()],
      sessionCwds: new Map(sessions.map((s) => [s.id, s.cwd])),
    };
  }

  function guardFor(snap: GuardSnapshot, id: string, jsonlMtimeMs: number | null, inArgv: boolean): string | null {
    const a = snap.agents.get(id);
    return liveGuardReason({
      id,
      nowMs: now().getTime(),
      jsonlMtimeMs,
      status: a ? a.status : null,
      awaitingInput: a?.awaitingInput ?? false,
      tmuxBoundAlive: snap.tmuxBoundAliveIds.has(id),
      processVouched: snap.vouched.has(id),
      cwdHasLiveClaude: snap.liveCwds.includes(snap.sessionCwds.get(id) ?? "\0"),
      inProcessArgv: inArgv,
      pendingApproval: snap.pending.has(id),
      currentSessionIds: snap.current,
    });
  }

  async function scanSessions(ctx: FeatureContext, snap: GuardSnapshot): Promise<SessionCandidateInput[]> {
    const rows = new Map(ctx.db.listSessions().map((s) => [s.id, s]));
    const out: SessionCandidateInput[] = [];
    let realRoot: string;
    let projDirs: Dirent[];
    try {
      realRoot = await fs.realpath(ctx.config.projectsDir);
      projDirs = await fs.readdir(realRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: { id: string; projDir: string; path: string; size: number; mtimeMs: number; dir: string | null }[] = [];
    for (const d of projDirs) {
      if (!d.isDirectory() || !isAllowedProjDir(d.name)) continue;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(join(realRoot, d.name), { withFileTypes: true });
      } catch {
        continue;
      }
      const dirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
      for (const e of entries) {
        const m = UUID_JSONL_RE.exec(e.name);
        if (!m || !e.isFile()) continue;
        const id = m[1] ?? "";
        const path = join(realRoot, d.name, e.name);
        try {
          const st = await fs.lstat(path);
          found.push({ id, projDir: d.name, path, size: st.size, mtimeMs: st.mtimeMs, dir: dirNames.has(id) ? join(realRoot, d.name, id) : null });
        } catch {
          /* vanished */
        }
      }
    }
    const argvHits = idsInArgv(snap.argvCommands, found.map((f) => f.id));
    for (const f of found) {
      const row = rows.get(f.id);
      const agent = snap.agents.get(f.id);
      let facts: HeadFacts | null = null;
      if (!row || row.messageCount <= HEADLESS_MAX_MESSAGES) {
        try {
          const head = await readHead(f.path, HEAD_BYTES);
          facts = scanHead(head.text, head.truncated);
        } catch {
          facts = null;
        }
      }
      // Not in the index (e.g. no cwd) and too big to read whole: its content is unknown, skip it.
      if (!row && (facts === null || facts.truncated)) continue;
      const messageCount = row ? row.messageCount : (facts?.userTextTurns ?? 0) + (facts?.assistantTurns ?? 0);
      const bytes = f.size + (f.dir ? await folderBytes(fs, f.dir) : 0);
      out.push({
        id: f.id,
        projDir: f.projDir,
        title: agent?.title ?? row?.title ?? (facts?.firstType ? `(${facts.firstType} only)` : "(untitled)"),
        cwd: row?.cwd ?? "",
        islandId: row?.islandId ?? "",
        lastActive: row?.lastActive ?? new Date(f.mtimeMs).toISOString(),
        messageCount,
        bytes,
        facts,
        protected: guardFor(snap, f.id, f.mtimeMs, argvHits.has(f.id)),
      });
    }
    return out;
  }

  async function forkRecords(ctx: FeatureContext): Promise<{ id: string; path: string }[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dirname(resolve(ctx.config.dbPath)), "fork-worktrees.json"), "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r): r is { id: string; path: string } => isRecord(r) && typeof r.id === "string" && typeof r.path === "string");
    } catch {
      return [];
    }
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function scanWorktrees(ctx: FeatureContext, snap: GuardSnapshot): Promise<WorktreeInput[]> {
    const root = join(home, ".alef-worktrees");
    let repos: Dirent[];
    try {
      repos = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return []; // no root yet: nothing Alef made
    }
    const records = await forkRecords(ctx);
    const sessions = ctx.db.listSessions();
    const out: WorktreeInput[] = [];
    // Forks live at ~/.alef-worktrees/<repo>/<name>. A <slug> with a `.git` of its own is instead
    // a loop worktree of agent-world, checked out straight there and managed by the loop: not a
    // fork, and neither its subfolders (client/, server/…) nor those of a removed one are
    // worktrees of a "gone" repo (175 of them were listed that way on 2026-10-14).
    const candidates: { path: string; name: string }[] = [];
    for (const r of repos) {
      if (!r.isDirectory()) continue;
      const top = join(root, r.name);
      if (await exists(join(top, ".git"))) continue;
      let names: Dirent[];
      try {
        names = await fs.readdir(top, { withFileTypes: true });
      } catch {
        continue;
      }
      // Only a checkout (a `.git` of its own) is a fork; a leftover cache folder (.vite) is not.
      for (const n of names) if (n.isDirectory() && (await exists(join(top, n.name, ".git")))) candidates.push({ path: join(top, n.name), name: n.name });
    }
    for (const { path, name } of candidates) {
      let repo: string | null = null;
      let registered = false;
      let repoExists = false;
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(join(path, ".git"), "utf8"));
        const gitdir = m?.[1]?.trim() ?? "";
        const idx = gitdir.indexOf("/.git/worktrees/");
        if (idx > 0) {
          repo = gitdir.slice(0, idx);
          repoExists = await exists(join(repo, ".git"));
          registered = await exists(gitdir);
        }
      } catch {
        /* no .git file: not a worktree git knows about */
      }
      let lastSessionMs: number | null = null;
      for (const s of sessions) {
        if (!s.cwd || !isInsideDir(path, s.cwd)) continue;
        const t = Date.parse(s.lastActive);
        if (Number.isFinite(t) && (lastSessionMs === null || t > lastSessionMs)) lastSessionMs = t;
      }
      out.push({
        path,
        name,
        repo,
        registered,
        repoExists,
        forkId: records.find((x) => x.path === path)?.id ?? null,
        lastSessionMs,
        liveInside: snap.liveCwds.some((c) => isInsideDir(path, c)),
      });
    }
    return out;
  }

  async function loadCandidates(ctx: FeatureContext, tiny = DEFAULT_TINY, dormantDays = DEFAULT_DORMANT_DAYS): Promise<CandidatesResponse> {
    const key = `${tiny}:${dormantDays}`;
    const t = now().getTime();
    if (cache && cache.key === key && t - cache.at < CACHE_MS) return cache.value;
    const snap = await snapshot(ctx);
    const buckets = classifyCandidates({
      nowMs: snap.nowMs,
      tiny,
      dormantDays,
      sessions: await scanSessions(ctx, snap),
      tmux: snap.tmuxRows,
      tmuxBoundToLive: snap.tmuxBoundToLive,
      claudeAncestors: snap.claudeAncestors,
      worktrees: await scanWorktrees(ctx, snap),
    });
    const value: CandidatesResponse = { ok: true, generatedAt: new Date(t).toISOString(), params: { tiny, dormantDays }, buckets };
    cache = { key, at: t, value };
    return value;
  }

  async function doRetire(ctx: FeatureContext, body: unknown): Promise<{ status: number; body: RetireResult }> {
    const parsed = parseRetireBody(body);
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    const snap = await snapshot(ctx);
    const argvHits = idsInArgv(snap.argvCommands, parsed.ids);
    const items = parsed.ids.map((id) => {
      const row = ctx.db.getSession(id);
      return { id, title: row?.title ?? "", cwd: row?.cwd ?? "", messageCount: row?.messageCount ?? 0, lastActive: row?.lastActive ?? "" };
    });
    const outcome = await retireSessions(
      trashDeps(ctx),
      items,
      (id, mtime) => guardFor(snap, id, mtime, argvHits.has(id)),
      (ids, batchId) => writeLegacy(ctx, ids, batchId),
      (ids, batchId) => voidLegacy(ctx, ids, batchId),
    );
    const retired = outcome.results.filter((r) => r.ok).map((r) => r.id);
    // Files are in the trash with their manifest; only now forget them in the index.
    for (const id of retired) {
      try {
        ctx.db.forgetSession(id);
      } catch (err) {
        ctx.log.error("cleanup", `forgetSession ${id} failed`, String(err));
      }
    }
    cache = null;
    if (retired.length > 0) {
      ctx.broadcast({ type: "agentsRemoved", ids: retired });
      ctx.emit({ kind: "retired", ids: retired } satisfies CleanupMessage);
      ctx.log.info("cleanup", `retired ${retired.length} session(s) into batch ${outcome.batchId}`);
    }
    return { status: 200, body: { ok: true, batchId: outcome.batchId, results: outcome.results } };
  }

  async function doRestore(ctx: FeatureContext, body: unknown): Promise<{ status: number; body: RestoreResult }> {
    const parsed = parseRestoreBody(body);
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    let out: Awaited<ReturnType<typeof restoreBatch>>;
    try {
      out = await restoreBatch(trashDeps(ctx), parsed.batchId, parsed.ids);
    } catch (err) {
      return { status: 404, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
    cache = null;
    if (out.restoredIds.length > 0) {
      ctx.emit({ kind: "restored", ids: out.restoredIds } satisfies CleanupMessage);
      ctx.log.info("cleanup", `restored ${out.restoredIds.length} session(s) from batch ${parsed.batchId}`);
      await restoreLegacy(ctx, out.restoredIds);
    }
    const conflict = out.results.length > 0 && out.results.every((r) => !r.ok && /not overwriting/.test(r.error ?? ""));
    return { status: conflict ? 409 : 200, body: { ok: true, batchId: parsed.batchId, results: out.results } };
  }

  const feature: ServerFeature = {
    id: "cleanup",
    routes: [
      {
        method: "GET",
        path: "/api/cleanup/candidates",
        async handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const tiny = clampInt(url.searchParams.get("tiny"), DEFAULT_TINY, 1, 50);
          const dormantDays = clampInt(url.searchParams.get("dormantDays"), DEFAULT_DORMANT_DAYS, 1, 3650);
          try {
            respondJson(res, 200, await loadCandidates(ctx, tiny, dormantDays));
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) });
          }
        },
      },
      {
        method: "POST",
        path: "/api/cleanup/retire",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies RetireResult);
          }
          try {
            const out = await serial(() => doRetire(ctx, body));
            respondJson(res, out.status, out.body);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) } satisfies RetireResult);
          }
        },
      },
      {
        method: "GET",
        path: "/api/cleanup/trash",
        async handler(_req, res, ctx) {
          const batches = await listTrash(trashDeps(ctx));
          respondJson(res, 200, { ok: true, root: trashRootOf(home), batches } satisfies TrashListResponse);
        },
      },
      {
        method: "POST",
        path: "/api/cleanup/restore",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies RestoreResult);
          }
          const out = await serial(() => doRestore(ctx, body));
          respondJson(res, out.status, out.body);
        },
      },
      {
        method: "POST",
        path: "/api/cleanup/tmux/:name/close",
        async handler(_req, res, ctx, params) {
          const name = params.name ?? "";
          try {
            const out = await serial(async () => {
              const snap = await snapshot(ctx);
              return closeDeadTmux(tmux, name, snap.tmuxBoundToLive, snap.claudeAncestors, (text) => saveTmuxScrollback(trashDeps(ctx), name, text));
            });
            cache = null;
            if (out.status === 200 && out.savedTo) {
              ctx.emit({ kind: "tmux-closed", ids: [name] } satisfies CleanupMessage);
              return respondJson(res, 200, { ok: true, name, savedTo: out.savedTo } satisfies TmuxCloseResult);
            }
            respondJson(res, out.status, { ok: false, error: out.error ?? "failed" } satisfies TmuxCloseResult);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) } satisfies TmuxCloseResult);
          }
        },
      },
      {
        method: "POST",
        path: "/api/cleanup/reveal",
        async handler(req, res) {
          let body: unknown = null;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const root = trashRootOf(home);
          let target = root;
          if (isRecord(body) && typeof body.batchId === "string") {
            if (!BATCH_ID_RE.test(body.batchId)) return respondJson(res, 400, { ok: false, error: "bad batch id" });
            const m = (await listTrash({ home, projectsDir: root, fs, now })).find((b) => b.batchId === body.batchId);
            if (!m) return respondJson(res, 404, { ok: false, error: "no such batch" });
            target = join(root, m.date, m.batchId);
          }
          try {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            await reveal(target);
            respondJson(res, 200, { ok: true });
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) });
          }
        },
      },
    ],
  };
  return { feature, loadCandidates };
}

const defaultCleanup = createCleanupFeature();
export const cleanupFeature = defaultCleanup.feature;
/** Candidate buckets for other features (P3 Health). Cached 60 s, read-only. */
export const loadCleanupCandidates = defaultCleanup.loadCandidates;
// Re-exported so P3 can classify its own inputs without importing the lib path.
export { classifyCandidates } from "./cleanup-lib.js";
