// Wire types for the "wake-recall" feature: the Institute of Truth (the town's second brain: the
// vault, the memory files and the recall index) and which sessions really read from it the moment
// they woke up. The signal is Claude Code's own transcript record of its hooks: a SessionStart
// `hook_success` attachment whose content lists the vault notes the recall hook injected
// (`- \`~/…/note.md\` — …`), or a `hook_cancelled` / `hook_non_blocking_error` for the same hook.
// Only the first 256 KB of each main transcript is read (the wake happens at its very top).
//
// PRIVACY: a note's CONTENT (the snippet the hook injected) is never stored, served or rendered;
// only its vault-relative path and the counts are.
//
//   GET /api/wake-recall                     → WakeRecallResponse (every session + totals)
//   GET /api/wake-recall/session/:sessionId  → WakeRecallSessionResponse
//   WS  { type:"feature", feature:"wake-recall", payload: WakeRecallMessage }  (changed entries)
//   snapshot extras "wake-recall.summary"    → WakeRecallSummary (totals only, small)

export const WAKE_RECALL_FEATURE_ID = "wake-recall";
export const WAKE_RECALL_SUMMARY_KEY = "wake-recall.summary";
/** Bytes read from the top of each main transcript: the wake is always in its first lines. */
export const WAKE_HEAD_BYTES = 256 * 1024;

/** fed: at least one vault note injected at SessionStart. nothing: the session got past its wake
 *  (its first prompt is in the head) with no note. unread: the head holds no prompt and no wake
 *  signal, e.g. a first line (a queued prompt) bigger than the whole head. pending: not woken yet
 *  (no prompt in its transcript so far). */
export type WakeState = "fed" | "nothing" | "unread" | "pending";
/** Why a session woke with nothing, from its own transcript: the recall hook was cancelled at its
 *  timeout, it exited with an error, or it left no trace at all (it printed nothing or didn't run). */
export type WakeMissReason = "timed-out" | "failed" | "no-trace";

export interface WakeRecallEntry {
  sessionId: string;
  state: WakeState;
  /** Only for state "nothing". */
  reason: WakeMissReason | null;
  /** The transcript says entrypoint "sdk-cli" (a headless `claude -p` / Agent SDK run). */
  headless: boolean;
  /** First timestamp in the transcript's head (ISO), when there is one. */
  startedAt: string | null;
  /** Timestamp of the first SessionStart line that injected notes (ISO). */
  wokeAt: string | null;
  /** Its hook name, e.g. "SessionStart:startup" or "SessionStart:resume". */
  wakeEvent: string | null;
  /** Basename of that hook's command, e.g. "memory-recall.py". */
  hook: string | null;
  /** Distinct vault-relative .md paths injected at SessionStart (capped). Never the contents. */
  notes: string[];
  /** Distinct notes injected at SessionStart. */
  count: number;
  /** UserPromptSubmit recall injections with content (prompt-memory-recall / transcript-recall), in the
   *  first 256 KB only: NOT the session's total. */
  promptRecalls: number;
  /** First seen after the server booted (its lines came from the live indexer). */
  newSinceBoot: boolean;
}

export interface WakeRecallTotals {
  /** Main transcripts with a record (every one on disk, once the cold pass is done). */
  sessions: number;
  fed: number;
  nothing: number;
  unread: number;
  pending: number;
  /** Of `nothing`: headless runs. */
  headlessMisses: number;
  reasons: Record<WakeMissReason, number>;
  /** Sum of each fed session's distinct note count. */
  notes: number;
  promptRecalls: number;
  promptRecallSessions: number;
  /** Sessions whose transcript starts today (server-local midnight). */
  today: { sessions: number; fed: number; nothing: number };
}

export interface WakeRecallSummary {
  /** False until every transcript on disk at boot has had its head read once. */
  ready: boolean;
  totals: WakeRecallTotals;
  /** .md files under the vault (dot-folders skipped); null until counted or when unreadable. */
  vaultNotes: number | null;
}

export interface WakeRecallResponse extends WakeRecallSummary {
  ok: true;
  headBytes: number;
  bootAt: string;
  /** Newest first (startedAt). */
  sessions: WakeRecallEntry[];
}

export interface WakeRecallSessionResponse {
  ok: true;
  ready: boolean;
  entry: WakeRecallEntry | null;
}

export interface WakeRecallMessage {
  kind: "entries";
  entries: WakeRecallEntry[];
  summary: WakeRecallSummary;
}

// ---------------------------------------------------------------- the agent-panel line

export const INSTITUTE_OF_TRUTH = "Institute of Truth";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One plain line for the agent panel, from the entry alone (no guessing). */
export function wakeLine(e: WakeRecallEntry): string {
  const resumed = e.wakeEvent === "SessionStart:resume" ? " (on resume)" : "";
  switch (e.state) {
    case "fed":
      return `Woke with ${plural(e.count, "note")} from the ${INSTITUTE_OF_TRUTH}${resumed}`;
    case "nothing": {
      const why =
        e.reason === "timed-out" ? "the recall hook timed out" : e.reason === "failed" ? "the recall hook failed" : "the recall hook left no trace";
      return `Woke with nothing${e.headless ? " (headless run)" : ""}: ${why}`;
    }
    case "unread":
      return "Wake read not checked: its first line alone is bigger than the 256 KB read";
    case "pending":
      return "Not woken yet: no first prompt in its transcript";
  }
}

/** "3 recalls at prompt time (first 256 KB of the transcript)", or null for none. Only the head is
 *  read, so a long session holds many more past it: the line must never read as a total. */
export function promptRecallLine(e: WakeRecallEntry): string | null {
  return e.promptRecalls > 0 ? `${plural(e.promptRecalls, "recall")} at prompt time (first 256 KB of the transcript)` : null;
}

// ---------------------------------------------------------------- validators (client side)

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATES: ReadonlySet<string> = new Set(["fed", "nothing", "unread", "pending"]);
const REASONS: ReadonlySet<string> = new Set(["timed-out", "failed", "no-trace"]);

const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function isWakeRecallEntry(v: unknown): v is WakeRecallEntry {
  if (!isRecordLike(v)) return false;
  return (
    typeof v.sessionId === "string" &&
    typeof v.state === "string" &&
    STATES.has(v.state) &&
    (v.reason === null || (typeof v.reason === "string" && REASONS.has(v.reason))) &&
    typeof v.headless === "boolean" &&
    strOrNull(v.startedAt) &&
    strOrNull(v.wokeAt) &&
    strOrNull(v.wakeEvent) &&
    strOrNull(v.hook) &&
    Array.isArray(v.notes) &&
    v.notes.every((n) => typeof n === "string") &&
    count(v.count) &&
    count(v.promptRecalls) &&
    typeof v.newSinceBoot === "boolean"
  );
}

export function isWakeRecallSummary(v: unknown): v is WakeRecallSummary {
  if (!isRecordLike(v) || typeof v.ready !== "boolean" || !(v.vaultNotes === null || count(v.vaultNotes))) return false;
  const t = v.totals;
  if (!isRecordLike(t)) return false;
  const nums = ["sessions", "fed", "nothing", "unread", "pending", "headlessMisses", "notes", "promptRecalls", "promptRecallSessions"] as const;
  if (!nums.every((k) => count(t[k]))) return false;
  const r = t.reasons;
  const d = t.today;
  return isRecordLike(r) && count(r["timed-out"]) && count(r.failed) && count(r["no-trace"]) && isRecordLike(d) && count(d.sessions) && count(d.fed) && count(d.nothing);
}
