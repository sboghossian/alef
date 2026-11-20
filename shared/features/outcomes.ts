// Wire types for the "outcomes" feature: one verdict per session, computed by code from evidence
// in its own transcript (server/features/outcomes-lib.ts). No model call, no keyword reading of
// what the model said.
//
//   GET /api/outcomes              → OutcomesResponse (every session with a record, compact, plus
//                                    counts per outcome and the scan's progress)
//   GET /api/outcomes/:agentId     → OutcomeRecord (404 when the session has no record)
//   WS  { feature: "outcomes", payload: OutcomesMessage }   the whole map, when it changed
//   WorldSnapshot.extras["outcomes.map"] → OutcomesMap (only sessions whose outcome isn't "unknown")
//
// Precedence, highest first (a live session is always "active": a verdict is for a session that
// ended, and one that resumes is recomputed once it goes quiet again):
//   shipped    at least one PR that `gh pr view` reports MERGED
//   delivered  a PR not verified as merged (open, closed, unchecked, or gh couldn't say), a
//              `git push` to GitHub, or a published claude.ai artifact (Claude Code's frame-link)
//   failed     its transcript's ending (RunEnding): an API error, a cut-off turn, a headless interrupt
//   stopped    the user interrupted an interactive session
//   abandoned  dormant 24h+ while its last turn waited on the user (AskUserQuestion, a question)
//   finished   its latest TodoWrite / Task list has at least one item, all completed
//   active     live now
//   unknown    none of the above ("no outcome evidence": most chats and research, not a failure)

export const SESSION_OUTCOMES = ["shipped", "delivered", "failed", "stopped", "abandoned", "finished", "active", "unknown"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];
export type KnownOutcome = Exclude<SessionOutcome, "unknown">;

/** gh's word for a PR, "unknown" when gh failed (missing, unauthed, offline, no such PR), or
 *  "unchecked" before gh was asked. Only "MERGED" ever makes a session shipped. */
export type PrState = "MERGED" | "OPEN" | "CLOSED" | "unknown" | "unchecked";

export interface OutcomePr {
  repo: string; // "owner/repo", lowercased
  number: number;
  url: string;
  state: PrState;
  mergedAt: string | null;
  checkedAt: string | null;
  /** When the transcript first showed this PR (its pr-link record, or the ship command's output). */
  firstSeenAt: string;
}

export interface OutcomeEnding {
  status: "failed" | "stopped";
  reason: string;
  headless: boolean;
}

export interface OutcomeRecord {
  sessionId: string;
  outcome: SessionOutcome;
  /** One line: "owner/repo#12 merged", "API Error: …", "waited on you: AskUserQuestion", …; null for unknown. */
  reason: string | null;
  /** When the evidence behind shipped / delivered happened (merge time, push, first PR sighting). */
  evidenceAt: string | null;
  lastActive: string; // ISO, transcript mtime when last seen
  toolCalls: number;
  /** Write / Edit / MultiEdit / NotebookEdit calls. */
  writes: number;
  /** Memory and lessons files it wrote (shelf-lib's isLearningPath), ≤ 50. */
  learnings: string[];
  /** claude.ai artifact links it published, ≤ 50. */
  artifacts: string[];
  prs: OutcomePr[];
  /** GitHub repos it pushed to ("owner/repo"). */
  pushes: string[];
  todos: { total: number; completed: number } | null;
  /** How the transcript ended, when that ending was a failure or a stop. */
  ending: OutcomeEnding | null;
  /** False once the transcript was pruned: the record stays. */
  onDisk: boolean;
  /** The transcript was not read to its current end yet (it grew, or the per-tick budget ran out). */
  pending: boolean;
  /** Until when the clock alone can still change this verdict (ISO), or null once it can't. A turn
   *  left mid-way reads as cut off (failed) past its stall bound (30 min, 2h for an unanswered
   *  prompt: subagents/fold.ts), a question to the user as abandoned after 24h; until then the
   *  verdict is unknown or finished for now. Shipped, delivered, failed, stopped and abandoned are
   *  never provisional. */
  provisionalUntil: string | null;
}

/** One PR `gh pr view` reported MERGED, as GET /api/outcomes lists it per session. */
export interface OutcomeMergedPr {
  repo: string; // "owner/repo", lowercased
  number: number;
  mergedAt: string | null;
}

export interface OutcomeSummary {
  sessionId: string;
  outcome: SessionOutcome;
  reason: string | null;
  /** OutcomeRecord.evidenceAt: when a shipped / delivered verdict's evidence happened (merge time,
   *  push, first PR sighting); null for every other outcome. */
  evidenceAt: string | null;
  lastActive: string;
  prs: number;
  merged: number;
  /** The `merged` PRs themselves, one per owner/repo#n: the client groups sessions that name the
   *  same one into a crew ("shipped together", client/src/features/family-lib.ts). */
  mergedPrs: OutcomeMergedPr[];
  pushes: number;
  artifacts: number;
  pending: boolean;
}

export type OutcomeCounts = Record<SessionOutcome, number>;

export interface OutcomesScan {
  /** Ticks run since the store was created. Saved with the store, which is only written when it
   *  changed, so after a restart it can lag by the ticks that changed nothing. */
  ticks: number;
  /** True once every dormant transcript was read and every PR asked about once. */
  coldDone: boolean;
  /** The tick on which the cold scan finished; null while it runs. */
  coldTicks: number | null;
  /** Dormant transcripts not read to their end yet. */
  pendingSessions: number;
  /** PRs due for a `gh pr view`. */
  pendingPrChecks: number;
  lastTick: { at: string; bytesRead: number; sessionsRead: number; ghCalls: number } | null;
  /** "unavailable" after a gh call failed on the last tick (missing binary, unauthed, offline). */
  gh: "ok" | "unavailable" | "untried";
}

export interface OutcomesResponse {
  ok: true;
  outcomes: OutcomeSummary[];
  counts: OutcomeCounts;
  scan: OutcomesScan;
}

export type OutcomesMap = Record<string, KnownOutcome>;
export type OutcomesMessage = { kind: "map"; map: OutcomesMap };

export const OUTCOMES_EXTRAS_KEY = "outcomes.map";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isSessionOutcome(v: unknown): v is SessionOutcome {
  return typeof v === "string" && (SESSION_OUTCOMES as readonly string[]).includes(v);
}

export function emptyCounts(): OutcomeCounts {
  return Object.fromEntries(SESSION_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts;
}

/** The map from a snapshot extra or a WS message (the client trusts nothing it parses): entries
 *  that aren't a session id → known outcome are dropped. Null when it isn't an object at all. */
export function parseOutcomesMap(v: unknown): OutcomesMap | null {
  if (!isRecord(v)) return null;
  // fromEntries defines own properties, so no key (not even "__proto__") reaches a prototype.
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, KnownOutcome] => e[0].length > 0 && e[0].length <= 64 && isSessionOutcome(e[1]) && e[1] !== "unknown"));
}

export function parseOutcomesMessage(v: unknown): OutcomesMessage | null {
  if (!isRecord(v) || v.kind !== "map") return null;
  const map = parseOutcomesMap(v.map);
  return map ? { kind: "map", map } : null;
}
