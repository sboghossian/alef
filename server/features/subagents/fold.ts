// Pure line folding for subagent transcripts and their parents' status lines. No IO.
//
// Subagent transcripts are big (tool results are most of the bytes), so a line is only
// JSON-parsed when it can matter: the first line (timestamp, cwd, prompt), assistant turns
// (model, usage, tool calls, stop_reason), user text lines (small: a prompt or an interrupt),
// and the rare tool result that ends the turn (how a workflow agent finishes: its
// StructuredOutput call). A plain tool result is recognized without parsing. The checks are raw
// byte searches for `"type":"assistant"` / `"type":"user"` / `"type":"tool_result"` /
// `"toolEndsTurn":true`, which can only occur unescaped as structural keys (inside a JSON string
// the quotes would be escaped). Transcript text is untrusted data: read, never executed.
//
// How a transcript ends (lastKind) decides a subagent's status when its parent didn't report one,
// and a top-level session's RunEnding (endings.ts). The rules, measured on real transcripts
// (2026-09-28: 894 subagent transcripts, 204 session transcripts):
//   - an assistant line ends the turn only with stop_reason end_turn / stop_sequence. Claude Code
//     writes each content block as its own line, and a text block streamed before a tool call has
//     stop_reason null (6,253 such lines; 733 end_turn), so null means "the turn may go on".
//   - a tool result means a tool returned and the model has not answered yet. Of 979 real
//     silences >120s that an agent later went on from, the old rules called 893 "failed", 333 of
//     them right after a tool result; these rules call 915 of the 979 "running".
//   - silence mid-turn is not death. Of 206,497 gaps between timestamped lines while a subagent
//     was mid-turn, 7 passed 30 min: 2 text_open (read as done), 2 after a tool result (38 and 39
//     min, then it went on), 3 on an unanswered prompt (43 min then an API error; 61 and 61 min,
//     then the workflow's stall watchdog aborted them). In 52 headless (sdk-cli) session
//     transcripts, 8 of 4,873 did: 6 on an unanswered prompt (31, 53 and 63 min before the run went
//     on; 77, 95 and 108 min before an API error landed), 1 in a tool call (69 min), 1 thinking
//     (107 min). So mid-turn stays "running" for STALL_MS, and an unanswered prompt (a first reply
//     during an API outage, or a machine asleep) for PROMPT_STALL_MS; then it counts as cut off.
//     Claude Code's own watchdog fails a subagent after 600s without stream progress ("Agent
//     stalled: no progress for 600s").
//   - "[Request interrupted by user]" is written for every abort, not only a user's: the parent's
//     TaskStop, and a workflow's stall watchdog retrying the agent, write the same line. So an
//     interrupt is "stopped" only when something outside the transcript explains it (a parent
//     stop within STOP_MATCH_MS, see interruptCause; for a session, a human at the terminal), and
//     otherwise "failed: interrupted (cause unknown)".
//   - a text with stop_reason null that stays last past STALL_MS is the agent's final word (all 24
//     real ones are: "Report delivered to the caller.", a full report), so it is done.

import { isAbsolute, resolve } from "node:path";
import type { SubagentStatus } from "../../../shared/features/subagents.js";
import { deriveActivity, type ActivityDraft } from "../../activity.js";
import { sanitizeTitle } from "../../heuristics.js";
import { filePathFromToolUse, parseLine } from "../../jsonl-events.js";

export interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  model: string | null;
}

/** Persisted, folded state of one subagent transcript. */
export interface SubagentState {
  id: string;
  parentSessionId: string;
  workflowId: string | null;
  cwd: string | null;
  startedAt: string | null;
  mtimeMs: number;
  model: string | null;
  tokens: number;
  lastUsageMessageId: string | null;
  toolCounts: Record<string, number>;
  files: Record<string, number>;
  firstPrompt: string | null;
  /** How the transcript ends so far (see LineKind); null = nothing conversational yet. */
  lastKind: LineKind | null;
  /** The API error's text when lastKind is "api_error" (sanitized, one line). */
  lastError?: string | null;
  /** The timestamp of the last "[Request interrupted by user…]" line (matched against the parent's stops). */
  interruptedAt?: string | null;
  meta: SubagentMeta | null;
  /** FOLD_VERSION of the rules that folded this state; an older one is re-read from byte 0. */
  foldVersion: number;
}

/** Where a conversation stands after one line:
 *    assistant_text  the turn ended (stop_reason end_turn / stop_sequence)
 *    tool_end        a tool result that ended the turn (a workflow agent's accepted StructuredOutput)
 *    api_error       Claude Code gave up on the turn: an assistant line flagged isApiErrorMessage
 *    interrupted     "[Request interrupted by user]" / "… for tool use]"
 *  and mid-turn:
 *    text_open       a text block with no end stop_reason (null: more blocks may follow)
 *    thinking        a thinking block (or empty turn) with no end stop_reason
 *    assistant_tool  a tool call, no result yet
 *    tool_result     a tool returned, no reply yet
 *    prompt          a user message, no reply yet
 *  Stored states folded before FOLD_VERSION 3 only know assistant_text (then: any final text),
 *  assistant_tool and tool_end; those keep resolving the way they did. */
export type LineKind = "assistant_text" | "tool_end" | "api_error" | "interrupted" | "text_open" | "thinking" | "assistant_tool" | "tool_result" | "prompt";

/** Bump when the fold learns something new about lines it used to skip, so every stored state
 *  is re-read once under the new rules (2: turn-ending tool results; 3: stop_reason, tool results,
 *  interrupts, API errors; 4: an interrupt's timestamp). */
export const FOLD_VERSION = 4;

/** A transcript written this recently is "running" whatever its last line says. */
export const LIVE_WINDOW_MS = 120_000;
/** How long a transcript may stay silent mid-turn before it counts as cut off (see the header). */
export const STALL_MS = 30 * 60_000;
/** The same for an unanswered prompt: real ones went on after up to 63 min, or ended in an API error after up to 108 (see the header). */
export const PROMPT_STALL_MS = 2 * 60 * 60_000;
/** How close a parent's stop must be to a subagent's interrupt to explain it (real TaskStops: 12–180 ms). */
export const STOP_MATCH_MS = 1_000;
/** The reason for an interrupt a user caused. */
export const USER_INTERRUPT = "interrupted by the user";

export function newSubagentState(id: string, parentSessionId: string, workflowId: string | null): SubagentState {
  return {
    id,
    parentSessionId,
    workflowId,
    cwd: null,
    startedAt: null,
    mtimeMs: 0,
    model: null,
    tokens: 0,
    lastUsageMessageId: null,
    toolCounts: {},
    files: {},
    firstPrompt: null,
    lastKind: null,
    meta: null,
    foldVersion: FOLD_VERSION,
  };
}

const ASSISTANT_NEEDLE = Buffer.from('"type":"assistant"');
const USER_NEEDLE = Buffer.from('"type":"user"');
const TOOL_RESULT_NEEDLE = Buffer.from('"type":"tool_result"');
const TURN_END_NEEDLE = Buffer.from('"toolEndsTurn":true');
const INTERRUPTED = "[Request interrupted by user";
const INTERRUPTED_NEEDLE = Buffer.from(INTERRUPTED);
const TASK_TYPE_NEEDLE = Buffer.from('"task_type":"');
const TASK_NOTIFICATION = "<task-notification>";
const END_STOPS: ReadonlySet<unknown> = new Set(["end_turn", "stop_sequence"]);
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
/** Files map is pruned to this many entries (lowest counts dropped) so state stays small. */
const MAX_TRACKED_FILES = 120;

export interface FoldResult {
  /** tool_use ids of Agent/Task calls this transcript made (nested spawns). */
  spawnIds: string[];
  activities: ActivityDraft[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** tool_use ids of Agent/Task calls on one raw assistant line. */
export function spawnIdsOnLine(raw: string): string[] {
  if (!raw.includes('"name":"Agent"') && !raw.includes('"name":"Task"')) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(obj) || !isRecord(obj.message) || !Array.isArray(obj.message.content)) return [];
  const ids: string[] = [];
  for (const b of obj.message.content) {
    if (isRecord(b) && b.type === "tool_use" && typeof b.name === "string" && SPAWN_TOOLS.has(b.name) && typeof b.id === "string") ids.push(b.id);
  }
  return ids;
}

/** A user line carrying a tool result that ended the turn without an error. Claude Code writes
 *  `toolEndsTurn: true` on the accepted result of a workflow agent's StructuredOutput call
 *  ("Structured output provided successfully"); a rejected one is an error and the agent retries. */
export function endsTurnOk(raw: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(obj) || obj.type !== "user" || obj.toolEndsTurn !== true || !isRecord(obj.message) || !Array.isArray(obj.message.content)) return false;
  const results = obj.message.content.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_result");
  return results.length > 0 && results.every((b) => b.is_error !== true);
}

function firstText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const b of content) if (isRecord(b) && b.type === "text" && typeof b.text === "string") return b.text;
  return null;
}

/** The kind of a user line (see LineKind), or null when it says nothing about the turn (not a user
 *  line; a queued <task-notification>, which Claude Code also appends after a session ended). A
 *  tool result is recognized from its two structural keys alone, never parsed (✅ on 53,651 real
 *  subagent user lines, the pair matched the parsed tool_result lines exactly). */
export function userLineKind(line: Buffer): LineKind | null {
  if (line.indexOf(USER_NEEDLE) === -1) return null;
  if (line.indexOf(TOOL_RESULT_NEEDLE) !== -1) return line.indexOf(TURN_END_NEEDLE) !== -1 && endsTurnOk(line.toString("utf8")) ? "tool_end" : "tool_result";
  let obj: unknown;
  try {
    obj = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "user" || !isRecord(obj.message)) return null;
  const text = firstText(obj.message.content);
  if (text === null) return "prompt"; // e.g. an image-only message: still input awaiting a reply
  if (text.startsWith(INTERRUPTED)) return "interrupted";
  if (text.trimStart().startsWith(TASK_NOTIFICATION)) return null;
  return "prompt";
}

/** The kind of a parsed assistant line (see LineKind), plus the API error's text. */
export function assistantKind(obj: unknown): { kind: LineKind; error: string | null } | null {
  if (!isRecord(obj) || obj.type !== "assistant" || !isRecord(obj.message)) return null;
  const content = obj.message.content;
  if (obj.isApiErrorMessage === true) {
    const t = firstText(content)?.replace(/\s+/g, " ").trim();
    return { kind: "api_error", error: t ? sanitizeTitle(t) : null };
  }
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  if (blocks.some((b) => b.type === "tool_use")) return { kind: "assistant_tool", error: null };
  if (END_STOPS.has(obj.message.stop_reason)) return { kind: "assistant_text", error: null };
  return { kind: typeof content === "string" || blocks.some((b) => b.type === "text") ? "text_open" : "thinking", error: null };
}

/** A line's own `timestamp`, or null. */
function timestampOf(line: Buffer): string | null {
  try {
    const obj: unknown = JSON.parse(line.toString("utf8"));
    return isRecord(obj) && typeof obj.timestamp === "string" ? obj.timestamp : null;
  } catch {
    return null;
  }
}

/** The kind of any one complete line (for reading a transcript's tail), or null. */
export function lineKind(line: Buffer): { kind: LineKind; error: string | null } | null {
  if (line.indexOf(ASSISTANT_NEEDLE) === -1) {
    const kind = userLineKind(line);
    return kind ? { kind, error: null } : null;
  }
  try {
    return assistantKind(JSON.parse(line.toString("utf8")));
  } catch {
    return null;
  }
}

/** Folds one complete line (bytes, no trailing newline) into `st`. */
export function foldSubagentLine(st: SubagentState, line: Buffer, collectActivity: boolean, out: FoldResult): void {
  const first = st.startedAt === null;
  if (line.indexOf(ASSISTANT_NEEDLE) === -1) {
    const kind = userLineKind(line);
    if (kind) st.lastKind = kind;
    if (kind === "interrupted") st.interruptedAt = timestampOf(line);
    if (!first) return;
  }
  const raw = line.toString("utf8");
  const parsed = parseLine(raw);
  if (!parsed) return;
  if (parsed.cwd && !st.cwd) st.cwd = parsed.cwd;
  if (first && parsed.timestamp) st.startedAt = parsed.timestamp;
  if (parsed.isUserText && parsed.userText && st.firstPrompt === null) st.firstPrompt = parsed.userText.slice(0, 400);
  if (!parsed.isAssistant) return;

  if (parsed.model && !parsed.model.startsWith("<")) st.model = parsed.model; // "<synthetic>" turns carry no real model
  const dup = parsed.messageId !== null && parsed.messageId === st.lastUsageMessageId;
  if (parsed.usage && !dup) st.tokens += parsed.usage.inputTokens + parsed.usage.outputTokens + parsed.usage.cacheCreationInputTokens;
  if (parsed.messageId !== null) st.lastUsageMessageId = parsed.messageId;

  for (const use of parsed.toolUses) {
    st.toolCounts[use.name] = (st.toolCounts[use.name] ?? 0) + 1;
    const p = filePathFromToolUse(use);
    if (p) {
      const abs = isAbsolute(p) ? p : st.cwd ? resolve(st.cwd, p) : p;
      st.files[abs] = (st.files[abs] ?? 0) + 1;
    }
  }
  if (Object.keys(st.files).length > MAX_TRACKED_FILES) {
    const keep = Object.entries(st.files)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TRACKED_FILES);
    st.files = Object.fromEntries(keep);
  }
  if (parsed.toolUses.length > 0) {
    st.lastKind = "assistant_tool";
    if (parsed.toolUses.some((u) => SPAWN_TOOLS.has(u.name))) out.spawnIds.push(...spawnIdsOnLine(raw));
  } else {
    // Tool-less turns need stop_reason and isApiErrorMessage, which parseLine doesn't keep: a
    // second parse of these lines only (✅ ~0.4s over all 322 MB of real assistant lines).
    let k: ReturnType<typeof assistantKind> = null;
    try {
      k = assistantKind(JSON.parse(raw));
    } catch {
      /* parseLine already parsed this line */
    }
    if (k) {
      st.lastKind = k.kind;
      st.lastError = k.error;
    }
  }
  if (collectActivity && st.cwd) out.activities.push(...deriveActivity(parsed, st.cwd, parsed.timestamp ?? new Date(st.mtimeMs).toISOString()));
}

/** What a parent transcript said about one of its subagents. */
export interface ParentReport {
  agentId: string;
  status: string; // raw: "completed" | "async_launched" | "failed" | "stopped" | "killed" | …
  model: string | null;
  description: string | null;
  /** A task-notification's <summary> (untrusted), e.g. `Agent "x" failed: Agent stalled: no
   *  progress for 600s (stream watchdog did not recover)`. Absent on reports stored before it. */
  summary?: string | null;
}

const RESULT_NEEDLE = '"toolUseResult"';
const NOTIFY_NEEDLE = "<task-notification>";
const NOTIFY_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const AGENT_ID_RE = /^a[0-9a-f]{16}$/;

/** Cheap byte test: can this parent line carry a subagent report or a stop (ParentStop)? */
export function parentLineMayReport(line: Buffer): boolean {
  return line.indexOf(RESULT_NEEDLE) !== -1 || line.indexOf(NOTIFY_NEEDLE) !== -1 || line.indexOf(INTERRUPTED_NEEDLE) !== -1;
}

/** Something a parent session did that aborts its subagents: its user interrupted its own turn
 *  ("user"), or it stopped a background agent or workflow with TaskStop ("task"). */
export interface ParentStop {
  at: string;
  by: "user" | "task";
}

const STOPPABLE_TASKS: ReadonlySet<unknown> = new Set(["local_agent", "local_workflow"]);

/** The stop on one parent line: a "[Request interrupted by user…]" line, or a TaskStop's result
 *  (`toolUseResult` {message: "Successfully stopped task: …", task_id, task_type}) for an agent or a
 *  workflow (a stopped background shell aborts no agent). */
export function parentStopOnLine(line: Buffer): ParentStop | null {
  const user = line.indexOf(INTERRUPTED_NEEDLE) !== -1 && userLineKind(line) === "interrupted";
  if (!user && line.indexOf(TASK_TYPE_NEEDLE) === -1) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(obj) || typeof obj.timestamp !== "string") return null;
  if (user) return { at: obj.timestamp, by: "user" };
  const r = obj.toolUseResult;
  const ok = isRecord(r) && typeof r.task_id === "string" && STOPPABLE_TASKS.has(r.task_type) && typeof r.message === "string" && r.message.startsWith("Successfully stopped task");
  return ok ? { at: obj.timestamp, by: "task" } : null;
}

/** Why a subagent was interrupted at `interruptedAt`, when its parent session explains it: the
 *  nearest parent stop within STOP_MATCH_MS. Null when nothing does (e.g. a workflow's stall
 *  watchdog retrying it, which leaves no line in the parent). */
export function interruptCause(interruptedAt: string | null | undefined, stops: readonly ParentStop[] | undefined): string | null {
  const t = interruptedAt ? Date.parse(interruptedAt) : Number.NaN;
  if (Number.isNaN(t) || !stops) return null;
  let best: ParentStop | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const s of stops) {
    const gap = Math.abs(Date.parse(s.at) - t);
    if (gap <= STOP_MATCH_MS && gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  return best === null ? null : best.by === "user" ? USER_INTERRUPT : "stopped by its parent session";
}

/** Reports on one parent line: an Agent tool_result (sync "completed" or "async_launched"),
 *  or task-notifications carried by a user / queue-operation line. */
export function parentReportsOnLine(raw: string): ParentReport[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(obj)) return [];
  const out: ParentReport[] = [];
  const r = obj.toolUseResult;
  if (isRecord(r) && typeof r.agentId === "string" && typeof r.status === "string") {
    out.push({
      agentId: r.agentId,
      status: r.status,
      model: typeof r.resolvedModel === "string" ? r.resolvedModel : null,
      description: typeof r.description === "string" ? r.description : null,
      summary: null,
    });
  }
  if ((obj.type === "user" || obj.type === "queue-operation") && raw.includes(NOTIFY_NEEDLE)) {
    const texts: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) for (const b of v) if (isRecord(b) && typeof b.text === "string") texts.push(b.text);
    };
    if (isRecord(obj.message)) collect(obj.message.content);
    collect(obj.content);
    for (const t of texts) {
      for (const m of t.matchAll(NOTIFY_RE)) {
        const body = m[1] ?? "";
        const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim();
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim() ?? null;
        // One notification can name several agents ("4 background agents didn't finish before the
        // previous session ended"): each <task-id> gets the report.
        for (const tid of body.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
          const id = tid[1]?.trim();
          if (id && status && AGENT_ID_RE.test(id)) out.push({ agentId: id, status, model: null, description: null, summary });
        }
      }
    }
  }
  return out;
}

export interface Outcome {
  status: SubagentStatus;
  /** Why it failed or stopped (one sanitized line); null otherwise. */
  reason: string | null;
}

const RUNNING: Outcome = { status: "running", reason: null };
const DONE: Outcome = { status: "done", reason: null };
const failed = (reason: string): Outcome => ({ status: "failed", reason });

/** What a transcript's ending means on its own, `quietMs` after its last write (file mtime: Claude
 *  Code keeps appending retry notices while it retries an API call, so mtime, not the last turn's
 *  timestamp, says whether the process is still going). Only "running" / "done" / "failed" /
 *  "stopped". A clean ending (assistant_text, tool_end) is never "failed". An interrupt is
 *  "stopped" only with `stoppedBy`, what explains it from outside the transcript; else "failed". */
export function endingOutcome(kind: LineKind | null, quietMs: number, error: string | null | undefined, stoppedBy: string | null = null): Outcome {
  if (quietMs <= LIVE_WINDOW_MS) return RUNNING;
  if (kind === "assistant_text" || kind === "tool_end") return DONE;
  if (kind === "api_error") return failed(error ? (/^api error\b/i.test(error) ? error : `API error: ${error}`) : "API error");
  if (kind === "interrupted") return stoppedBy ? { status: "stopped", reason: stoppedBy } : failed("interrupted (cause unknown)");
  if (quietMs <= (kind === "prompt" ? PROMPT_STALL_MS : STALL_MS)) return RUNNING; // mid-turn: a tool call or the model's reply may still come
  switch (kind) {
    case "text_open":
      return DONE; // its last word, silent since
    case "assistant_tool":
      return failed("cut off: a tool call never returned");
    case "tool_result":
      return failed("cut off: no reply after a tool result");
    case "thinking":
      return failed("cut off mid-reply");
    default:
      return failed("cut off: its prompt was never answered");
  }
}

const TERMINAL_OK = new Set(["completed", "done", "success"]);
const TERMINAL_FAILED = new Set(["failed", "error"]);
const TERMINAL_STOPPED: ReadonlyMap<string, string> = new Map([
  ["killed", "stopped by its parent session"], // `Agent "x" was stopped by Claude`
  ["stopped", "its session ended before it finished"], // `Background agent "x" didn't finish before the previous session ended`
  ["cancelled", "cancelled by its parent session"],
  ["canceled", "cancelled by its parent session"],
]);

/** The parent's own words for a failure: `Agent "x" failed: <why>` → `<why>` (sanitized). */
function reportReason(r: ParentReport): string {
  const why = r.summary ? /\bfailed:\s*([\s\S]+)$/.exec(r.summary)?.[1]?.replace(/\s+/g, " ").trim() : undefined;
  return why ? sanitizeTitle(why) : "its parent reported it failed";
}

/** Order of precedence: writing now → the parent's "completed" → a clean ending (final text, or an
 *  accepted StructuredOutput) → the parent stopped it → the parent's "failed" → an API error /
 *  interrupt (stopped when `stoppedBy`, the parent's matching stop, explains it; else failed) →
 *  mid-turn but silent < STALL_MS, PROMPT_STALL_MS on an unanswered prompt (running) → "launched in the background and never heard from" →
 *  cut off mid-turn (failed). A clean ending outranks a bad report because the
 *  transcript is the direct evidence: on real data, both such reports were stale re-announcements
 *  (a "failed: Agent stalled" before the agent was resumed and finished; a "stopped: didn't finish
 *  before the previous session ended" sent after its final text and its "completed"). */
export function resolveOutcome(quietMs: number, report: ParentReport | undefined, lastKind: LineKind | null, lastError?: string | null, stoppedBy: string | null = null): Outcome {
  if (quietMs <= LIVE_WINDOW_MS) return RUNNING;
  if (report && TERMINAL_OK.has(report.status)) return DONE;
  if (lastKind === "assistant_text" || lastKind === "tool_end") return DONE;
  const stopped = report ? TERMINAL_STOPPED.get(report.status) : undefined;
  if (stopped) return { status: "stopped", reason: stopped };
  if (report && TERMINAL_FAILED.has(report.status)) return failed(reportReason(report));
  const own = endingOutcome(lastKind, quietMs, lastError, stoppedBy);
  if (own.status === "failed" && lastKind !== "api_error" && lastKind !== "interrupted" && report?.status === "async_launched") return { status: "async_launched", reason: null };
  return own;
}

/** Depth of each subagent: 1 for direct children of a session, +1 per nested spawn.
 *  `ownerOfToolUse` maps an Agent tool_use id to the subagent that made it. */
export function computeParents(
  states: Iterable<SubagentState>,
  ownerOfToolUse: ReadonlyMap<string, string>,
): Map<string, { parentAgentId: string | null; depth: number }> {
  const byId = new Map<string, SubagentState>();
  for (const s of states) byId.set(s.id, s);
  const parentOf = new Map<string, string | null>();
  for (const s of byId.values()) {
    const owner = s.meta?.toolUseId ? ownerOfToolUse.get(s.meta.toolUseId) : undefined;
    const ownerState = owner ? byId.get(owner) : undefined;
    parentOf.set(s.id, owner && ownerState && owner !== s.id && ownerState.parentSessionId === s.parentSessionId ? owner : null);
  }
  const out = new Map<string, { parentAgentId: string | null; depth: number }>();
  for (const id of byId.keys()) {
    let depth = 1;
    let cur = parentOf.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cur && !seen.has(cur) && depth < 32) {
      seen.add(cur);
      depth += 1;
      cur = parentOf.get(cur) ?? null;
    }
    out.set(id, { parentAgentId: parentOf.get(id) ?? null, depth });
  }
  return out;
}
