// Wire types for the "president" feature (round 10, item 3+4): Jev as a president that only
// PROPOSES — a session to start, or small dormant districts to merge on the planet — and
// Alex approves or dismisses each one with a click. Jev never writes the proposal text:
// it only ranks/scores real candidates that `server/features/president-lib.ts` builds from
// real sources (open loops, failing/warn Health checks, stale todo.md items, dormant
// districts, and since vision wave 2 the sickness cases: a "treat" proposal per sick
// automation lineage, disease and folder, and a "research" proposal to draft a tripwire rule
// for a disease that keeps recurring). Same "Jev classifies, code writes the words" split used elsewhere in Alef.
//
// SAFETY: a session candidate whose cwd backs an always-live *.dashable.dev host (the ingress
// in ~/.cloudflared/dashable/config.yml plus the dir->port->host map in ~/.dashable/services.yml,
// read-only), whose text quotes a file path inside such a folder, or whose text mentions
// HARD STOP / cutover / tunnel ingress / launchd / dashable / cloudflared never reaches Jev or
// the board. It is listed in `PresidentBoard.dropped` instead.
//
//   GET  /api/president/proposals            -> PresidentBoard (cached; computes once if never ticked)
//   GET  /api/president/refresh              -> PresidentBoard (forces a recompute now, on-demand)
//   POST /api/president/proposals/:id/dismiss -> PresidentActionResult (7-day cooldown, shared/features/president.ts DISMISS_COOLDOWN_MS; 404 for an id never proposed, 200 again for one already dismissed)
//   POST /api/president/proposals/:id/launch  -> PresidentActionResult (kind "session", and "commencement" schedule / hire / hook, or a
//                                                retire's routine-unload session; reuses loops' plan-mode launcher — never server-initiated.
//                                                The server re-derives cwd and task from the stored candidate: a body carrying cwd/task/prompt is a 400)
//   POST /api/president/proposals/:id/retire  {confirm:true} -> PresidentActionResult (commencement "retire" only; the careers
//                                                feature's own retire path, which writes data/careers.json and nothing else)
//   POST /api/president/proposals/:id/merge   -> PresidentActionResult (kind "merge" only; writes data/district-merges.json)
//   GET  /api/district-merges                 -> DistrictMergesResponse (the approved, display-only mapping)
//   POST /api/district-merges/:id/undo        -> PresidentActionResult (removes one mapping)
//   WS "president" feature message            -> PresidentMessage
//   WorldSnapshot.extras["president.board"]   -> PresidentBoard (initial / mid-session snapshot)
//   WorldSnapshot.extras["president.merges"]  -> readonly DistrictMergeRecord[] (read by client/src/layout.ts at boot)
//
// `task`/`why`/city names originate in todo.md files, Health check details and real island
// metadata: untrusted-ish real data. Render it escaped, never execute it.
//
// Until the first refresh after a restart has finished, launch/dismiss/merge answer 503 with
// PRESIDENT_NOT_READY_ERROR instead of a 404 that reads as if the proposal were gone.
//
// COMMENCEMENT (agent-city piece 5): graduation actions, built by code from real signals, ranked
// by Jev in the same single batched call, at most MAX_COMMENCEMENT_PROPOSALS ("none" can empty it):
//   schedule  a trusted worker whose recent runs were started by hand (autonomy 1–2) and that no
//             com.stephane routine runs: a plan-mode session in ~/.alef-commencement DRAFTS the LaunchAgent plist
//   retire    a worker lapsed 14+ days: Retire is the Tower's own display-only retire; a routine still
//             installed gets a second button, a plan-mode session that unloads it only once Alex confirms there
//             (never offered when the plist names an always-live folder). A worker already retired whose
//             routine is still installed gets an unload-only card.
//   hire      a worker trusted in the last 7 days, or an installed skill that fired for the first time,
//             matched to an open-loops item by 2+ shared keywords (one from its own slug, never a
//             struck-through item): "/x <task>" in the loop's folder
//   hook      a tripwire lesson repeated in 5+ sessions in the tripwires' kept hits: a plan-mode session
//             drafts a PreToolUse hook for it, never installs it
// Every proposal Jev shows goes into a ledger (data/president.json, capped): shown, acted on (a click),
// and, for a launch, the adopted session's own outcome verdict. PresidentBoard.record is computed
// from that ledger alone: never a model's score of itself.

import type { LaunchDetails } from "../types.js";
import type { FolderTrust } from "./trust.js";

export const PRESIDENT_NOT_READY_ERROR = "Alef is still reading your proposals after a restart. Try again in a few seconds.";

/** At most this many session proposals are shown at once (the brief's "at most 3"). */
export const MAX_SESSION_PROPOSALS = 3;
/** Merge proposals are capped separately and kept small: the Inbox should never feel cluttered. */
export const MAX_MERGE_PROPOSALS = 3;
/** A dismissed proposal's underlying candidate doesn't come back for this long. */
export const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** "no activity for 14+ days" (the brief's own wording) defines a dormant district. */
export const DORMANT_DISTRICT_DAYS = 14;
/** "few sessions" — a district with more agents than this is never a merge candidate. */
export const SMALL_DISTRICT_MAX_AGENTS = 3;

/** A research candidate needs at least this many open cases of one (kind, source class). */
export const RESEARCH_MIN_CASES = 3;
/** A proposal carries at most this many sickness case ids. */
export const PROPOSAL_CASE_IDS_CAP = 50;

/** Commencement proposals shown at once (Jev may show fewer, down to none). */
export const MAX_COMMENCEMENT_PROPOSALS = 2;
/** retire: a worker lapsed (careers-lib) for at least this long. */
export const RETIRE_LAPSED_DAYS = 14;
/** retire: only a worker with a record (the careers Feed's own 3-run bar); one typed by hand once or twice isn't a worker to retire. */
export const RETIRE_MIN_RUNS = 3;
/** hire: a worker trusted, or a skill first fired, this recently. */
export const HIRE_WINDOW_DAYS = 7;
/** hire: an open loop must share at least this many distinct keywords with the worker or skill. */
export const HIRE_MIN_SHARED_KEYWORDS = 2;
/** hook: a tripwire lesson repeated in at least this many sessions in the tripwires' kept hits. */
export const HOOK_MIN_HITS = 5;
/** The ledger keeps this many entries (newest). */
export const LEDGER_CAP = 500;
/** The record line's window. */
export const RECORD_WINDOW_DAYS = 30;

export type PresidentProposalKind = "session" | "merge" | "commencement";

export const COMMENCEMENT_ACTIONS = ["schedule", "retire", "hire", "hook"] as const;
export type CommencementAction = (typeof COMMENCEMENT_ACTIONS)[number];

/** Where a session proposal came from: an open-loops item, a stale todo.md item, a failing
 *  Health check, a sick automation lineage ("treat"), or a recurring disease no tripwire rule
 *  catches yet ("research": draft the rule and its test, never install it). */
export type PresidentOrigin = "loop" | "stale" | "health" | "treat" | "research";
export const PRESIDENT_ORIGINS: readonly PresidentOrigin[] = ["loop", "stale", "health", "treat", "research"];

export interface PresidentSessionProposal {
  id: string;
  kind: "session";
  task: string;
  city: string;
  model: string;
  why: string;
  /** Absent on boards persisted before vision wave 2. */
  origin?: PresidentOrigin;
  /** treat / research: the sickness case ids (shared/features/sickness.ts) this proposal answers,
   *  so a later session-outcomes verdict can close them. At most PROPOSAL_CASE_IDS_CAP. */
  caseIds?: readonly string[];
}

export interface PresidentMergeProposal {
  id: string;
  kind: "merge";
  districts: readonly string[];
  into: string;
  sessions: number;
  why: string;
}

/** A graduation action (see the header). Every word is code-written from real counts; `subject`
 *  and a hire's loop task still came from titles, skill files and todo files: render escaped. */
export interface PresidentCommencementProposal {
  id: string;
  kind: "commencement";
  action: CommencementAction;
  /** The worker key ("/daily-recap"), skill command ("/grill-me") or tripwire lesson id. */
  subject: string;
  /** The card's one line: "Schedule /x as a routine", "Retire /x (61 runs, last 2026-07-28)", … */
  title: string;
  /** What its launch starts the plan-mode session with (for a retire: the routine-unload session's
   *  task, "" when no routine is installed). Shown for review; the server never takes it back. */
  task: string;
  why: string;
  /** retire only: the com.stephane routine still installed for this worker. */
  routine?: string;
  /** retire only: the tmux session its routine-unload launch started. */
  unloadStartedAs?: string;
  /** retire only: the worker is already retired and only its routine's unload is left (no Retire button). */
  retired?: boolean;
}

export type PresidentProposal = PresidentSessionProposal | PresidentMergeProposal | PresidentCommencementProposal;

export type LedgerOutcome = "launched" | "dismissed" | "retired" | "merged";

/** One proposal shown on the board, and what Alex did with it (data/president.json). A
 *  proposal that leaves the board unclicked keeps outcome null ("shown, not acted on"); shown again
 *  later, it reuses that entry. After a click, a later showing (a cooldown ran out) is a new entry. */
export interface PresidentLedgerEntry {
  id: string;
  kind: PresidentProposalKind;
  /** "launch" (session), "merge", or the commencement action. */
  action: "launch" | "merge" | CommencementAction;
  /** Jev put it on the board, or the rules fallback did (no Jev answer). Rules never becomes Jev's. */
  rankedBy: "jev" | "rules";
  proposedAt: string;
  actedAt: string | null;
  outcome: LedgerOutcome | null;
  /** A launch: the tmux session it started. */
  tmuxName?: string;
  /** The session talk adopted into that tmux session (talk.bindings), once it did. */
  sessionId?: string;
}

/** The record line, from the ledger alone: proposals Jev showed in the last `days`, how many
 *  Alex acted on (launch / retire / merge), and how many launches' sessions shipped (a merged
 *  PR per the outcomes feature). `since` is the oldest entry: there is no record before it. */
export interface PresidentRecord {
  days: number;
  shown: number;
  actedOn: number;
  dismissed: number;
  launched: number;
  /** Launches whose tmux session talk adopted: only these can have an outcome. */
  linked: number;
  shipped: number;
  /** Shown by the rules fallback while Jev gave no answer: not counted as Jev's above. */
  rulesShown: number;
  since: string | null;
}

/** A session candidate held back by the safety filter (never shown to Jev, never launchable). */
export interface PresidentDroppedCandidate {
  id: string;
  /** Code-written, e.g. 'cwd is inside always-live service lawgraph.dashable.dev (port 3894)'. */
  reason: string;
  /** The candidate's task, one line, capped. */
  task: string;
}

export interface PresidentBoard {
  generatedAt: string; // ISO
  proposals: readonly PresidentProposal[];
  source: "jev" | "rules";
  /** Candidates the safety filter dropped on this refresh. Absent on boards persisted before vision wave 2. */
  dropped?: readonly PresidentDroppedCandidate[];
  /** Jev's record (the ledger). Absent on boards persisted before commencement. */
  record?: PresidentRecord;
}

/** One approved, display-only merge: `districts` (including `into`) render as one city on the
 *  planet after the next reload. No session's home island ever changes, and no file moves. */
export interface DistrictMergeRecord {
  id: string;
  districts: readonly string[];
  into: string;
  sessions: number;
  why: string;
  approvedAt: string; // ISO
}

export interface DistrictMergesResponse {
  ok: true;
  merges: readonly DistrictMergeRecord[];
}

export interface PresidentActionResult extends LaunchDetails {
  ok: boolean;
  error?: string;
  /** launch only: the tmux session name a confirmed launch started. */
  tmuxName?: string;
  /** launch only: whether Claude will stop on its folder-trust dialog in `cwd` (read before starting). */
  trust?: FolderTrust;
  /** launch only: the directory the session was started in. */
  cwd?: string;
  /** merge only: the record that was written. */
  merge?: DistrictMergeRecord;
}

/** WS payload: the board or the merge mapping changed since the last emit. */
export type PresidentMessage = { kind: "board"; board: PresidentBoard } | { kind: "merges"; merges: readonly DistrictMergeRecord[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isDistrictMergeRecord(v: unknown): v is DistrictMergeRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    isStringArray(o.districts) &&
    typeof o.into === "string" &&
    typeof o.sessions === "number" &&
    typeof o.why === "string" &&
    typeof o.approvedAt === "string"
  );
}

/** Validates `WorldSnapshot.extras["president.merges"]` before `client/src/layout.ts` trusts
 *  it — an unrecognized or malformed shape (older cache, a race with a mid-write extras key)
 *  is treated as "no merges yet", never as a crash. */
export function isDistrictMergeRecordArray(v: unknown): v is DistrictMergeRecord[] {
  return Array.isArray(v) && v.every(isDistrictMergeRecord);
}

function isPresidentProposal(v: unknown): v is PresidentProposal {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "session") {
    return (
      typeof o.id === "string" &&
      typeof o.task === "string" &&
      typeof o.city === "string" &&
      typeof o.model === "string" &&
      typeof o.why === "string" &&
      (o.origin === undefined || (typeof o.origin === "string" && (PRESIDENT_ORIGINS as readonly string[]).includes(o.origin))) &&
      (o.caseIds === undefined || isStringArray(o.caseIds))
    );
  }
  if (o.kind === "merge") return typeof o.id === "string" && isStringArray(o.districts) && typeof o.into === "string" && typeof o.sessions === "number" && typeof o.why === "string";
  if (o.kind === "commencement") {
    return (
      typeof o.id === "string" &&
      typeof o.action === "string" &&
      (COMMENCEMENT_ACTIONS as readonly string[]).includes(o.action) &&
      typeof o.subject === "string" &&
      typeof o.title === "string" &&
      typeof o.task === "string" &&
      typeof o.why === "string" &&
      (o.routine === undefined || typeof o.routine === "string") &&
      (o.unloadStartedAs === undefined || typeof o.unloadStartedAs === "string") &&
      (o.retired === undefined || typeof o.retired === "boolean")
    );
  }
  return false;
}

const RECORD_COUNTS = ["days", "shown", "actedOn", "dismissed", "launched", "linked", "shipped", "rulesShown"] as const;

function isPresidentRecord(v: unknown): v is PresidentRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return RECORD_COUNTS.every((k) => typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) >= 0) && (o.since === null || typeof o.since === "string");
}

/** Validates `WorldSnapshot.extras["president.board"]` on the client. A malformed record alone is
 *  not a reason to drop the board: the caller shows no record line (see parsePresidentBoard). */
export function isPresidentBoard(v: unknown): v is PresidentBoard {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.generatedAt === "string" && Array.isArray(o.proposals) && o.proposals.every(isPresidentProposal) && (o.source === "jev" || o.source === "rules");
}

/** The board with its record kept only when it is well-formed; null when the board itself isn't. */
export function parsePresidentBoard(v: unknown): PresidentBoard | null {
  if (!isPresidentBoard(v)) return null;
  const { record, ...rest } = v;
  return isPresidentRecord(record) ? { ...rest, record } : rest;
}
