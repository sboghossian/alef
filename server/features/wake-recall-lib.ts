// Pure half of the "wake-recall" feature (no fs, no clock): turns the hook attachment lines Claude
// Code writes at the top of every main transcript into one record per session: did it read from
// the Institute of Truth when it woke, which vault notes (paths only), and if not, why not.
//
// The real line shape (✅ 163 of 204 main transcripts carried one on 2026-09-28):
//   {"type":"attachment","timestamp":"…","attachment":{"type":"hook_success","hookEvent":"SessionStart",
//    "hookName":"SessionStart:startup"|"SessionStart:resume","command":"…/memory-recall.py",
//    "content":"## Memory recall …\n- `~/Documents/Code/alex_claude/20-Projects/x/_index.md` — <snippet>\n…",
//    "stdout":…,"exitCode":0,"durationMs":433}}
// and, when the hook didn't deliver: attachment.type "hook_cancelled" ({timedOut:true,timeoutMs}) or
// "hook_non_blocking_error" ({exitCode}). A hook that printed nothing leaves no line at all.
//
// PRIVACY INVARIANT: only the backticked path of each "- `path` — …" line is kept, resolved to a
// vault-relative .md path; the snippet after it (the note's content) is never copied anywhere.
// Unit-tested in server/test/wake-recall-lib.test.ts.

import { posix } from "node:path";
import {
  WAKE_HEAD_BYTES,
  type WakeMissReason,
  type WakeRecallEntry,
  type WakeRecallTotals,
  type WakeState,
} from "../../shared/features/wake-recall.js";

/** SessionStart hooks whose cancellation / error explains an empty wake. */
export const WAKE_HOOKS: ReadonlySet<string> = new Set(["memory-recall.py"]);
/** UserPromptSubmit hooks that recall from the Institute of Truth at prompt time (vault+memory, transcripts). */
export const PROMPT_RECALL_HOOKS: ReadonlySet<string> = new Set(["prompt-memory-recall.py", "transcript-recall.py"]);
/** Distinct note paths kept per session (a wake injects at most 6 per hook). */
export const WAKE_NOTES_CAP = 200;
const PATH_MAX = 400;

export interface VaultRoots {
  /** Home directory, for "~/" paths. */
  home: string;
  /** Absolute vault root, e.g. ~/Documents/Code/alex_claude. */
  vaultRoot: string;
  /** Absolute folders that are really a folder of the vault (a symlink): the memory dir is
   *  ~/.claude/projects/<home>/memory → 60-Meta/claude-config/memory. */
  aliases: ReadonlyArray<{ from: string; to: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const INTERPRETERS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "python", "python3", "node", "env", "exec", "uv", "uvx", "npx", "bun", "deno", "ruby", "perl"]);

/** Basename of the script a hook command runs: `bash "$HOME/…/pull-and-link.sh"` → "pull-and-link.sh",
 *  `$HOME/.claude/hooks/with-lock.sh skillsrepo bash …` → "with-lock.sh", `rtk hook claude` → "rtk". */
export function hookBasename(command: string): string {
  for (const raw of command.trim().split(/\s+/)) {
    const t = raw.replace(/^["']+|["']+$/g, "");
    if (!t || t.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    const base = t.slice(t.lastIndexOf("/") + 1);
    if (INTERPRETERS.has(base)) continue;
    return base;
  }
  return "";
}

function inside(rel: string): string | null {
  const n = posix.normalize(rel);
  return n === "." || n.startsWith("../") || n === ".." || n.startsWith("/") ? null : n;
}

/** A path as the recall hook prints it ("~/…" or absolute) → vault-relative .md path, or null when
 *  it is not an .md file inside the vault (or one of its aliased folders). */
export function vaultRelative(raw: string, roots: VaultRoots): string | null {
  let p = raw.trim();
  if (p.length === 0 || p.length > PATH_MAX || /[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith("~/")) p = `${roots.home}${p.slice(1)}`;
  if (!p.startsWith("/")) return null;
  p = posix.normalize(p);
  if (!p.toLowerCase().endsWith(".md")) return null;
  for (const a of roots.aliases) {
    if (p.startsWith(`${a.from}/`)) {
      const rest = inside(p.slice(a.from.length + 1));
      return rest ? posix.join(a.to, rest) : null;
    }
  }
  return p.startsWith(`${roots.vaultRoot}/`) ? inside(p.slice(roots.vaultRoot.length + 1)) : null;
}

// "- `path` — snippet" (memory-recall.py) or "- **[vault]** `path` — snippet" (prompt-memory-recall.py).
// Only the backticked path is captured; the snippet is never read into anything.
const RECALL_LINE_RE = /^- (?:\*\*\[[\w-]{1,20}\]\*\* )?`([^`\n]{1,400})` — /gm;

/** Distinct vault-relative note paths a recall hook's content lists, in order. */
export function parseRecallNotes(content: string, roots: VaultRoots): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(RECALL_LINE_RE)) {
    const rel = m[1] ? vaultRelative(m[1], roots) : null;
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}

export interface HookLine {
  kind: "success" | "cancelled" | "error";
  /** hookEvent, e.g. "SessionStart", "UserPromptSubmit". */
  event: string;
  /** hookName, e.g. "SessionStart:startup", "SessionStart:resume". */
  hookName: string | null;
  /** Basename of the hook's command. */
  hook: string;
  /** Vault-relative .md paths listed in the content (success only). Never the content itself. */
  notes: string[];
  count: number;
  /** The line's own timestamp. */
  at: string | null;
  /** The hook printed something (success with non-blank content). */
  hasContent: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

const HOOK_KINDS: Readonly<Record<string, HookLine["kind"]>> = {
  hook_success: "success",
  hook_cancelled: "cancelled",
  hook_non_blocking_error: "error",
};

/** One raw transcript line → the hook attachment it records, or null for any other line. */
export function parseHookLine(line: string, roots: VaultRoots): HookLine | null {
  if (!line.includes('"attachment"') || !line.includes('"hook_')) return null;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(o) || o.type !== "attachment" || !isRecord(o.attachment)) return null;
  const a = o.attachment;
  const kind = typeof a.type === "string" ? HOOK_KINDS[a.type] : undefined;
  if (!kind) return null;
  const content = kind === "success" && typeof a.content === "string" ? a.content : "";
  const notes = content ? parseRecallNotes(content, roots) : [];
  return {
    kind,
    event: str(a.hookEvent) ?? "",
    hookName: str(a.hookName),
    hook: hookBasename(str(a.command) ?? ""),
    notes,
    count: notes.length,
    at: str(o.timestamp),
    hasContent: content.trim().length > 0,
    exitCode: typeof a.exitCode === "number" && Number.isFinite(a.exitCode) ? a.exitCode : null,
    timedOut: a.timedOut === true,
  };
}

// ---------------------------------------------------------------- per-session record

export interface WakeRecord {
  sessionId: string;
  /** Offset just past the last line folded (index path); bytes read (cold path). */
  bytes: number;
  /** The head is used up: nothing after it will be read. */
  headFull: boolean;
  startedAt: string | null;
  /** The first prompt (a top-level "user" or "assistant" line) is in the head: the wake is over. */
  sawTurn: boolean;
  headless: boolean;
  wokeAt: string | null;
  wakeEvent: string | null;
  hook: string | null;
  notes: string[];
  promptRecalls: number;
  timedOut: boolean;
  failed: boolean;
  newSinceBoot: boolean;
}

export function newWakeRecord(sessionId: string, newSinceBoot: boolean): WakeRecord {
  return {
    sessionId,
    bytes: 0,
    headFull: false,
    startedAt: null,
    sawTurn: false,
    headless: false,
    wokeAt: null,
    wakeEvent: null,
    hook: null,
    notes: [],
    promptRecalls: 0,
    timedOut: false,
    failed: false,
    newSinceBoot,
  };
}

const TIMESTAMP_RE = /"timestamp":"([^"]{10,40})"/;

function timestampOf(line: string): string | null {
  const m = TIMESTAMP_RE.exec(line);
  return m?.[1] && Number.isFinite(Date.parse(m[1])) ? m[1] : null;
}

function isTurnLine(line: string): boolean {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return false;
  try {
    const o: unknown = JSON.parse(line);
    return isRecord(o) && (o.type === "user" || o.type === "assistant");
  } catch {
    return false;
  }
}

/** Folds one complete line of a transcript's head (newline stripped) into its record. */
export function foldWakeLine(rec: WakeRecord, line: string, roots: VaultRoots): void {
  if (line.length === 0) return;
  if (rec.startedAt === null) rec.startedAt = timestampOf(line);
  if (!rec.headless && line.includes('"entrypoint":"sdk-cli"')) rec.headless = true;
  const hook = parseHookLine(line, roots);
  if (hook) {
    if (hook.event === "SessionStart") {
      if (hook.kind === "success" && hook.notes.length > 0) {
        for (const n of hook.notes) if (rec.notes.length < WAKE_NOTES_CAP && !rec.notes.includes(n)) rec.notes.push(n);
        if (rec.wokeAt === null) {
          rec.wokeAt = hook.at;
          rec.wakeEvent = hook.hookName;
          rec.hook = hook.hook || null;
        }
      } else if (WAKE_HOOKS.has(hook.hook)) {
        if (hook.kind === "cancelled") rec.timedOut = true;
        else if (hook.kind === "error") rec.failed = true;
      }
    } else if (hook.event === "UserPromptSubmit" && hook.kind === "success" && hook.hasContent && PROMPT_RECALL_HOOKS.has(hook.hook)) {
      rec.promptRecalls += 1;
    }
    return;
  }
  if (!rec.sawTurn && isTurnLine(line)) rec.sawTurn = true;
}

/** The indexer's new raw lines for a session first seen after boot (complete lines, newline
 *  stripped, oldest first): folded while each line still ends inside the head, like the cold read. */
export function foldIndexLines(rec: WakeRecord, lines: readonly string[], roots: VaultRoots, headBytes = WAKE_HEAD_BYTES): void {
  for (const line of lines) {
    if (rec.headFull) return;
    const end = rec.bytes + Buffer.byteLength(line, "utf8") + 1;
    if (end > headBytes) {
      rec.headFull = true;
      return;
    }
    rec.bytes = end;
    foldWakeLine(rec, line, roots);
  }
}

/** A fresh record from the first `head.length` bytes of a transcript `fileSize` bytes long: every
 *  complete line in it; a trailing partial line (still being written, or cut by the head) is not. */
export function recordFromHead(sessionId: string, head: Buffer, fileSize: number, roots: VaultRoots, headBytes = WAKE_HEAD_BYTES): WakeRecord {
  const rec = newWakeRecord(sessionId, false);
  let start = 0;
  for (;;) {
    const nl = head.indexOf(0x0a, start);
    if (nl === -1) break;
    if (nl > start) foldWakeLine(rec, head.toString("utf8", start, nl), roots);
    start = nl + 1;
  }
  rec.bytes = start;
  rec.headFull = fileSize >= headBytes;
  return rec;
}

export function wakeState(rec: WakeRecord): { state: WakeState; reason: WakeMissReason | null } {
  if (rec.notes.length > 0) return { state: "fed", reason: null };
  if (rec.sawTurn || rec.timedOut || rec.failed) return { state: "nothing", reason: rec.timedOut ? "timed-out" : rec.failed ? "failed" : "no-trace" };
  return { state: rec.headFull ? "unread" : "pending", reason: null };
}

/** The served entry: paths and counts only. */
export function toEntry(rec: WakeRecord): WakeRecallEntry {
  const { state, reason } = wakeState(rec);
  return {
    sessionId: rec.sessionId,
    state,
    reason,
    headless: rec.headless,
    startedAt: rec.startedAt,
    wokeAt: rec.wokeAt,
    wakeEvent: rec.wakeEvent,
    hook: rec.hook,
    notes: [...rec.notes],
    count: rec.notes.length,
    promptRecalls: rec.promptRecalls,
    newSinceBoot: rec.newSinceBoot,
  };
}

/** Totals over the served entries; "today" = transcripts starting at or after `sinceMs`. */
export function wakeTotals(entries: readonly WakeRecallEntry[], sinceMs: number): WakeRecallTotals {
  const t: WakeRecallTotals = {
    sessions: entries.length,
    fed: 0,
    nothing: 0,
    unread: 0,
    pending: 0,
    headlessMisses: 0,
    reasons: { "timed-out": 0, failed: 0, "no-trace": 0 },
    notes: 0,
    promptRecalls: 0,
    promptRecallSessions: 0,
    today: { sessions: 0, fed: 0, nothing: 0 },
  };
  for (const e of entries) {
    t[e.state] += 1;
    if (e.state === "fed") t.notes += e.count;
    if (e.state === "nothing") {
      if (e.headless) t.headlessMisses += 1;
      if (e.reason) t.reasons[e.reason] += 1;
    }
    t.promptRecalls += e.promptRecalls;
    if (e.promptRecalls > 0) t.promptRecallSessions += 1;
    const started = Date.parse(e.startedAt ?? "");
    if (Number.isFinite(started) && started >= sinceMs) {
      t.today.sessions += 1;
      if (e.state === "fed") t.today.fed += 1;
      if (e.state === "nothing") t.today.nothing += 1;
    }
  }
  return t;
}

/** Same served fields → same entry (a re-read that changed nothing isn't pushed). */
export function sameEntry(a: WakeRecallEntry | undefined, b: WakeRecallEntry): boolean {
  if (!a) return false;
  return (
    a.state === b.state &&
    a.reason === b.reason &&
    a.headless === b.headless &&
    a.startedAt === b.startedAt &&
    a.wokeAt === b.wokeAt &&
    a.count === b.count &&
    a.promptRecalls === b.promptRecalls &&
    a.notes.join("\n") === b.notes.join("\n")
  );
}

/** "woke with 8 vault notes" — the activity summary a new session's wake read broadcasts. */
export function wakeSummary(count: number): string {
  return `woke with ${count} vault note${count === 1 ? "" : "s"}`;
}
