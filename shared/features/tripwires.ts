// Wire types for the "tripwires" feature: a live session repeating a lesson the fleet already
// learned (the definitions live in server/features/tripwires-defs.ts, mined from the Alef loop
// journal, LOOP.md and the MEMORY.md standing warnings). Observe and flag only: a hit never
// blocks or interrupts the session.
//
//   GET /api/tripwires                    → TripwiresResponse (recent hits, newest first, the rules,
//                                           the lesson coverage counts, what the hit log restored)
//   WS  { type:"feature", feature:"tripwires", payload: TripwiresMessage }   new hits as they happen
//   snapshot extras "tripwires.hits"      → TripwireHit[] (same list as the GET)
//   snapshot extras "tripwires.coverage"  → TripwireCoverage | null (same as the GET's)
//
// Every new hit is appended to data/tripwires.jsonl (append-only; a new generation file starts at
// 5 MB) and the log is folded back in at boot, so hits survive a restart. A hit is deduped per
// session + tripwire across restarts too (for the hits the fold reads back). A subagent's call
// counts for its parent session (`subagentId` says which subagent made it). `snippet` is the
// matched part of the command, secrets redacted, one line, capped; it is still untrusted text
// (it came out of a transcript), so render it with textContent only.

export const TRIPWIRES_FEATURE_ID = "tripwires";
export const TRIPWIRES_HITS_KEY = "tripwires.hits";
export const TRIPWIRES_COVERAGE_KEY = "tripwires.coverage";
/** Hits kept in memory (and sent in the snapshot), newest first. */
export const TRIPWIRES_HIT_CAP = 200;

export type TripwireSeverity = "info" | "warn" | "danger";

export interface TripwireHit {
  /** Stable per session + tripwire: `${sessionId}:${tripwireId}`. */
  id: string;
  sessionId: string;
  /** Set when one of the session's subagents made the call (its agent id); null for the session itself. */
  subagentId: string | null;
  /** Display name of the session's district (island), when the index knows it. */
  district: string | null;
  tripwireId: string;
  /** The one-line lesson the session repeated. */
  lesson: string;
  severity: TripwireSeverity;
  /** Where the lesson was learned (journal date / file). */
  source: string;
  /** The tool name that tripped it (usually "Bash"). */
  tool: string;
  /** Matched text, redacted and truncated. Untrusted. */
  snippet: string;
  /** ISO time of the tool call (transcript time, not detection time). */
  at: string;
}

/** A rule as the client may show it (no regexes on the wire). */
export interface TripwireRuleView {
  id: string;
  lesson: string;
  severity: TripwireSeverity;
  source: string;
}

/** Where lessons get written down. Each is counted from the file itself (see `how`). */
export type LessonSourceId = "journal" | "standing-warnings" | "feedback-memories" | "conduct-cases";

export interface LessonSourceCount {
  id: LessonSourceId;
  label: string;
  /** Home-relative path of the file or folder the count comes from. */
  path: string;
  /** Lessons counted there; null when the source couldn't be read (`error` says why). */
  lessons: number | null;
  /** How `lessons` is counted, in one line. */
  how: string;
  /** Tripwire rules whose own `source` field cites this source. */
  citedByRules: number;
  error?: string;
}

/** "N lessons written, M guarded": counts only. `lessonsWritten` sums the sources that could be
 *  read, and they overlap (a standing warning usually points at a feedback memory). `guarded` is the
 *  number of tripwire rules, one per lesson. Nothing here turns a lesson into a rule. */
export interface TripwireCoverage {
  lessonsWritten: number;
  guarded: number;
  sources: LessonSourceCount[];
  /** ISO time the sources were last counted. */
  countedAt: string;
}

/** What data/tripwires.jsonl did for this server process. */
export interface TripwirePersistence {
  /** The generation file new hits go to, relative to the data dir. */
  file: string;
  /** Hits read back from the log at boot. */
  restored: number;
  /** Hits appended since boot (confirmed written). */
  appended: number;
  /** Hits that were not confirmed written (refused, failed or timed out). */
  unconfirmed: number;
  lastError: string | null;
}

export interface TripwiresResponse {
  ok: true;
  version: number;
  rules: TripwireRuleView[];
  hits: TripwireHit[];
  /** Null until the lesson sources were counted once. */
  coverage: TripwireCoverage | null;
  persistence: TripwirePersistence;
}

export interface TripwiresMessage {
  kind: "hits";
  hits: TripwireHit[];
}

const SEVERITIES: readonly TripwireSeverity[] = ["info", "warn", "danger"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates one untrusted hit off the wire (snapshot extras or a WS payload). */
export function isTripwireHit(v: unknown): v is TripwireHit {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.sessionId === "string" &&
    (v.subagentId === null || typeof v.subagentId === "string") &&
    (v.district === null || typeof v.district === "string") &&
    typeof v.tripwireId === "string" &&
    typeof v.lesson === "string" &&
    typeof v.severity === "string" &&
    SEVERITIES.includes(v.severity as TripwireSeverity) &&
    typeof v.source === "string" &&
    typeof v.tool === "string" &&
    typeof v.snippet === "string" &&
    typeof v.at === "string" &&
    Number.isFinite(Date.parse(v.at))
  );
}

export function parseTripwireHits(v: unknown): TripwireHit[] {
  return Array.isArray(v) ? v.filter(isTripwireHit) : [];
}

const LESSON_SOURCE_IDS: readonly string[] = ["journal", "standing-warnings", "feedback-memories", "conduct-cases"];
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function isLessonSourceCount(v: unknown): v is LessonSourceCount {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    LESSON_SOURCE_IDS.includes(v.id) &&
    typeof v.label === "string" &&
    typeof v.path === "string" &&
    (v.lessons === null || isCount(v.lessons)) &&
    typeof v.how === "string" &&
    isCount(v.citedByRules) &&
    (v.error === undefined || typeof v.error === "string")
  );
}

/** Validates snapshot extras "tripwires.coverage" (null when absent or malformed). */
export function parseTripwireCoverage(v: unknown): TripwireCoverage | null {
  if (!isRecord(v) || !isCount(v.lessonsWritten) || !isCount(v.guarded) || typeof v.countedAt !== "string" || !Array.isArray(v.sources)) return null;
  if (!v.sources.every(isLessonSourceCount)) return null;
  return { lessonsWritten: v.lessonsWritten, guarded: v.guarded, sources: v.sources, countedAt: v.countedAt };
}

/** The coverage line: "76 lessons written, 12 guarded". */
export function coverageLine(c: Pick<TripwireCoverage, "lessonsWritten" | "guarded">): string {
  return `${c.lessonsWritten} lesson${c.lessonsWritten === 1 ? "" : "s"} written, ${c.guarded} guarded`;
}

/** Where the count comes from, one clause per source: "journal 30 (4 rules cite it) · …". */
export function coverageSourcesLine(c: Pick<TripwireCoverage, "sources">): string {
  return c.sources.map((s) => `${s.label} ${s.lessons === null ? "unreadable" : s.lessons} (${s.citedByRules} rule${s.citedByRules === 1 ? "" : "s"} cite${s.citedByRules === 1 ? "s" : ""} it)`).join(" · ");
}
