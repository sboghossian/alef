// Pure logic of the "cleanup" feature (P2): which paths may ever be moved, the live-guard,
// the suggestion buckets, and request validation. No fs, no exec: every input is a plain
// value, so every rule is unit-testable. `classifyCandidates` is also used by P3 (Health).

import { isAbsolute, relative, sep } from "node:path";
import {
  ALEF_TMUX_RE,
  RECENT_ACTIVITY_MS,
  RETIRE_MAX_IDS,
  type CandidateBuckets,
  type CleanupSessionItem,
  type CleanupTmuxItem,
  type CleanupWorktreeItem,
  type ManifestItem,
  type SessionBucketId,
  type TrashManifest,
} from "../../shared/features/cleanup.js";
import { isRecord } from "../http.js";
import { isValidUuid } from "../reactivate.js";

const DAY_MS = 86_400_000;
export const HEADLESS_MAX_MESSAGES = 3;
export const WORKTREE_IDLE_DAYS = 14;
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "login", "-zsh", "-bash"]);

// ── path guards ────────────────────────────────────────────────────────────

/** A project folder name we accept under ~/.claude/projects: one path segment, not a dot
 *  entry, never "memory*" (Claude's memory dirs and their backups are off limits). */
export function isAllowedProjDir(name: string): boolean {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (/^memory/i.test(name)) return false;
  return true;
}

/**
 * Why `candidate` (an already realpath-resolved absolute path) must NOT be moved for session
 * `id`, or null when it is exactly `<realRoot>/<projDir>/<id>.jsonl` or `<realRoot>/<projDir>/<id>`.
 * Anything else (deeper, shallower, another name, outside the root, memory*) is refused.
 */
export function retirablePathError(realRoot: string, candidate: string, id: string): string | null {
  if (!isValidUuid(id)) return "not a session id";
  if (!isAbsolute(realRoot) || !isAbsolute(candidate)) return "path is not absolute";
  const rel = relative(realRoot, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "path is outside ~/.claude/projects";
  const parts = rel.split(sep);
  if (parts.length !== 2) return "path is not a direct child of a project folder";
  const [projDir, leaf] = parts as [string, string];
  if (!isAllowedProjDir(projDir)) return `refusing project folder "${projDir}"`;
  if (leaf !== `${id}.jsonl` && leaf !== id) return "file name does not match the session id";
  return null;
}

/** True when `child` is `root` itself or inside it (both absolute, already resolved). */
export function isInsideDir(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── live guard ─────────────────────────────────────────────────────────────

export interface LiveGuardInput {
  id: string;
  nowMs: number;
  /** mtime of the jsonl on disk right now; null when unknown (then it is not retirable). */
  jsonlMtimeMs: number | null;
  /** worldViews() status, or null when the session is not in the world (e.g. no cwd). */
  status: "live" | "dormant" | null;
  awaitingInput: boolean;
  /** A talk binding exists for this id and its tmux session is alive. */
  tmuxBoundAlive: boolean;
  /** In processVouchedSessions for the current liveClaudeCwds(). */
  processVouched: boolean;
  /** A claude process is running in this session's folder. processVouched only protects the N
   *  most recently written sessions per folder, so an idle interactive session next to a newer
   *  one could slip through; any live claude in the folder protects every session in it. */
  cwdHasLiveClaude: boolean;
  /** The id appears in a running process's argv (e.g. `claude --resume <id>`). */
  inProcessArgv: boolean;
  pendingApproval: boolean;
  /** The Claude session this server runs under, if any (CLAUDE_CODE_SESSION_ID). */
  currentSessionIds: ReadonlySet<string>;
}

/** The first live-guard reason that protects this session, or null when it may be retired. */
export function liveGuardReason(g: LiveGuardInput): string | null {
  if (g.currentSessionIds.has(g.id)) return "this is the current Claude session";
  if (g.status === "live") return "it is live right now";
  if (g.jsonlMtimeMs === null) return "its transcript could not be read";
  if (g.nowMs - g.jsonlMtimeMs < RECENT_ACTIVITY_MS) return "it was active in the last 30 minutes";
  if (g.tmuxBoundAlive) return "its Alef tmux session is still running";
  if (g.processVouched) return "a running claude process vouches for it";
  if (g.cwdHasLiveClaude) return "a claude process is running in its folder";
  if (g.inProcessArgv) return "a running process names it (claude --resume)";
  if (g.awaitingInput) return "it is waiting for your answer";
  if (g.pendingApproval) return "it has a pending approval";
  return null;
}

/** Session ids that appear in any process argv, from a `ps` command list. */
export function idsInArgv(commands: readonly string[], ids: Iterable<string>): Set<string> {
  const joined = commands.join("\n").toLowerCase();
  const hit = new Set<string>();
  for (const id of ids) if (joined.includes(id.toLowerCase())) hit.add(id);
  return hit;
}

// ── transcript head facts ──────────────────────────────────────────────────

export interface HeadFacts {
  userTextTurns: number;
  assistantTurns: number;
  toolUse: boolean;
  /** `entrypoint: "sdk-cli"` on any line = a `claude -p` (headless) run. ✅ 119 of 383 real
   *  sessions carry it; `queue-operation` first lines are NOT a marker (VS Code writes them too). */
  headless: boolean;
  firstType: string | null;
  /** The byte cap cut the file: turn counts are a lower bound, never proof of "empty". */
  truncated: boolean;
}

/** Facts from the first bytes of a transcript. Lines are untrusted data: parsed, never run.
 *  A trailing partial line (cut by the byte cap) is ignored. */
export function scanHead(text: string, truncated: boolean): HeadFacts {
  const facts: HeadFacts = { userTextTurns: 0, assistantTurns: 0, toolUse: false, headless: false, firstType: null, truncated };
  const lines = text.split("\n");
  if (truncated) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(d)) continue;
    if (facts.firstType === null && typeof d.type === "string") facts.firstType = d.type;
    if (d.entrypoint === "sdk-cli") facts.headless = true;
    const msg = isRecord(d.message) ? d.message : null;
    if (d.type === "user" && msg) {
      const c = msg.content;
      if (typeof c === "string" ? c.trim().length > 0 : Array.isArray(c) && c.some((b) => isRecord(b) && b.type === "text")) facts.userTextTurns += 1;
    } else if (d.type === "assistant" && msg) {
      facts.assistantTurns += 1;
      if (Array.isArray(msg.content) && msg.content.some((b) => isRecord(b) && b.type === "tool_use")) facts.toolUse = true;
    }
  }
  return facts;
}

// ── buckets ────────────────────────────────────────────────────────────────

export interface SessionCandidateInput {
  id: string;
  projDir: string;
  title: string;
  cwd: string;
  islandId: string;
  lastActive: string;
  messageCount: number;
  bytes: number;
  /** Null when the head was not read (only small sessions are read). */
  facts: HeadFacts | null;
  protected: string | null;
}

export interface TmuxRow {
  name: string;
  dead: boolean;
  /** #{pane_pid}: the process tmux started in the pane. Null when the list didn't carry it. */
  panePid: number | null;
  command: string;
}

export interface WorktreeInput {
  path: string;
  name: string;
  repo: string | null;
  /** The repo's .git/worktrees/<name> registration exists (= it is in `git worktree list`). */
  registered: boolean;
  repoExists: boolean;
  forkId: string | null;
  /** Newest lastActive of any session whose cwd is inside it, ms; null when none. */
  lastSessionMs: number | null;
  liveInside: boolean;
}

export interface ClassifyInput {
  nowMs: number;
  tiny: number;
  dormantDays: number;
  sessions: readonly SessionCandidateInput[];
  tmux: readonly TmuxRow[];
  /** tmux names bound (talk) to an agent that is live right now. */
  tmuxBoundToLive: ReadonlySet<string>;
  /** live.ts's claudeAncestorPids: pids with a running claude below them. Null when ps can't be read. */
  claudeAncestors: ReadonlySet<number> | null;
  worktrees: readonly WorktreeInput[];
}

/** The one bucket a session belongs to (first match wins), with its reason, or null. */
export function bucketOf(s: SessionCandidateInput, nowMs: number, tiny: number, dormantDays: number): { bucket: SessionBucketId; reason: string } | null {
  // messageCount comes from the index (or, for an unindexed file, a whole-file head read), so
  // 0 is real; a cut head read never proves emptiness on its own.
  if (s.messageCount === 0 && (s.facts === null || (!s.facts.truncated && s.facts.userTextTurns + s.facts.assistantTurns === 0))) {
    return { bucket: "empty", reason: "no messages at all" };
  }
  if (s.facts?.headless && s.messageCount <= HEADLESS_MAX_MESSAGES && !s.facts.toolUse) {
    return { bucket: "headless", reason: `one-shot claude -p run, ${s.messageCount} message${s.messageCount === 1 ? "" : "s"}, no tools` };
  }
  if (s.messageCount < tiny) return { bucket: "tiny", reason: `only ${s.messageCount} message${s.messageCount === 1 ? "" : "s"}` };
  const last = Date.parse(s.lastActive);
  if (Number.isFinite(last) && nowMs - last > dormantDays * DAY_MS) {
    return { bucket: "dormant", reason: `last active ${Math.floor((nowMs - last) / DAY_MS)} days ago` };
  }
  return null;
}

export function classifyCandidates(input: ClassifyInput): CandidateBuckets {
  const out: CandidateBuckets = { empty: [], headless: [], tiny: [], dormant: [], worktree: [], tmux: [], totals: { bytes: 0, count: 0, protectedCount: 0 } };
  for (const s of input.sessions) {
    const b = bucketOf(s, input.nowMs, input.tiny, input.dormantDays);
    if (!b) continue;
    const item: CleanupSessionItem = {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      islandId: s.islandId,
      projDir: s.projDir,
      lastActive: s.lastActive,
      messageCount: s.messageCount,
      bytes: s.bytes,
      reason: b.reason,
    };
    if (s.protected) {
      item.protected = s.protected;
      out.totals.protectedCount += 1;
    } else {
      out.totals.bytes += s.bytes;
      out.totals.count += 1;
    }
    out[b.bucket].push(item);
  }
  for (const k of ["empty", "headless", "tiny", "dormant"] as const) {
    out[k].sort((a, b) => Number(Boolean(a.protected)) - Number(Boolean(b.protected)) || b.bytes - a.bytes);
  }
  for (const t of input.tmux) {
    const item = classifyTmux(t, input.tmuxBoundToLive, input.claudeAncestors);
    if (item) out.tmux.push(item);
  }
  for (const w of input.worktrees) {
    const item = classifyWorktree(w, input.nowMs);
    if (item) out.worktree.push(item);
  }
  return out;
}

/** An Alef tmux session whose claude has exited (pane dead, or back at a shell prompt). A shell
 *  as #{pane_current_command} alone proves nothing: Alef launches run `zsh -c 'claude …; rm -f …'`,
 *  and tmux names zsh (the foreground process-group leader) for claude's whole life. So a live
 *  pane counts as exited only when no claude runs below its pid; when that can't be checked
 *  (`claudeAncestors` null, or no pane pid), it doesn't count (fail closed). */
export function classifyTmux(t: TmuxRow, boundToLive: ReadonlySet<string>, claudeAncestors: ReadonlySet<number> | null): CleanupTmuxItem | null {
  if (!ALEF_TMUX_RE.test(t.name)) return null;
  const shell = SHELLS.has(t.command);
  if (!t.dead && !shell) return null;
  if (!t.dead && (claudeAncestors === null || t.panePid === null || claudeAncestors.has(t.panePid))) return null;
  const item: CleanupTmuxItem = { name: t.name, command: t.command, dead: t.dead, reason: t.dead ? "its pane is dead" : `claude exited, only ${t.command} is left` };
  if (boundToLive.has(t.name)) item.protected = "bound to a live agent";
  return item;
}

export function classifyWorktree(w: WorktreeInput, nowMs: number): CleanupWorktreeItem | null {
  let reason: string | null = null;
  if (!w.repoExists) reason = "its repo is gone";
  else if (!w.registered) reason = "missing from its repo's git worktree list";
  else if (w.lastSessionMs === null || nowMs - w.lastSessionMs > WORKTREE_IDLE_DAYS * DAY_MS) reason = `no session touched it for ${WORKTREE_IDLE_DAYS} days`;
  if (!reason) return null;
  const item: CleanupWorktreeItem = { path: w.path, repo: w.repo, name: w.name, forkId: w.forkId, reason };
  if (w.liveInside) item.protected = "a live claude session runs in it";
  return item;
}

/** `tmux list-sessions -F '#{session_name} #{pane_dead} #{pane_pid} #{pane_current_command}'` → rows
 *  (a row without the pid still parses, with panePid null). */
export function parseTmuxList(stdout: string): TmuxRow[] {
  const rows: TmuxRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+) ([01])(?: (\d+))?(?: (.*))?$/.exec(line.trim());
    if (!m) continue;
    rows.push({ name: m[1] ?? "", dead: m[2] === "1", panePid: m[3] === undefined ? null : Number(m[3]), command: (m[4] ?? "").trim() });
  }
  return rows;
}

// ── requests / ids ─────────────────────────────────────────────────────────

export function parseRetireBody(body: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!isRecord(body) || !Array.isArray(body.ids)) return { ok: false, error: "body must be {ids: string[]}" };
  if (body.ids.length === 0) return { ok: false, error: "no ids" };
  if (body.ids.length > RETIRE_MAX_IDS) return { ok: false, error: `at most ${RETIRE_MAX_IDS} ids per retire` };
  const ids: string[] = [];
  for (const id of body.ids) {
    if (typeof id !== "string" || !isValidUuid(id)) return { ok: false, error: "every id must be a session uuid" };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

export const BATCH_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
export const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRestoreBody(body: unknown): { ok: true; batchId: string; ids: string[] | null } | { ok: false; error: string } {
  if (!isRecord(body) || typeof body.batchId !== "string" || !BATCH_ID_RE.test(body.batchId)) return { ok: false, error: "body must be {batchId, ids?}" };
  if (body.ids === undefined || body.ids === null) return { ok: true, batchId: body.batchId, ids: null };
  if (!Array.isArray(body.ids) || body.ids.length > RETIRE_MAX_IDS || !body.ids.every((x): x is string => typeof x === "string" && isValidUuid(x))) {
    return { ok: false, error: "ids must be session uuids" };
  }
  return { ok: true, batchId: body.batchId, ids: body.ids };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Local calendar day "YYYY-MM-DD" (the trash sub-folder). */
export function trashDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYYMMDD-HHMMSS-<6 hex>", sortable by time. */
export function makeBatchId(d: Date, hex6: string): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex6}`;
}

/** A manifest read from disk (untrusted: the trash folder is user-writable). Null when malformed. */
export function parseManifest(v: unknown): TrashManifest | null {
  if (!isRecord(v) || typeof v.batchId !== "string" || !BATCH_ID_RE.test(v.batchId)) return null;
  if (typeof v.date !== "string" || !DATE_DIR_RE.test(v.date) || typeof v.at !== "string" || !Array.isArray(v.items)) return null;
  const items: ManifestItem[] = [];
  for (const it of v.items) {
    if (!isRecord(it) || typeof it.sessionId !== "string" || !isValidUuid(it.sessionId)) return null;
    if (!Array.isArray(it.from) || !Array.isArray(it.to) || it.from.length !== it.to.length) return null;
    if (!it.from.every((x): x is string => typeof x === "string") || !it.to.every((x): x is string => typeof x === "string")) return null;
    const state = it.state;
    if (state !== "planned" && state !== "retired" && state !== "failed" && state !== "restored") return null;
    items.push({
      sessionId: it.sessionId,
      title: typeof it.title === "string" ? it.title : "",
      cwd: typeof it.cwd === "string" ? it.cwd : "",
      messageCount: typeof it.messageCount === "number" ? it.messageCount : 0,
      lastActive: typeof it.lastActive === "string" ? it.lastActive : "",
      from: it.from,
      to: it.to,
      bytes: typeof it.bytes === "number" ? it.bytes : 0,
      state,
      ...(typeof it.error === "string" ? { error: it.error } : {}),
    });
  }
  return { batchId: v.batchId, date: v.date, at: v.at, items };
}
