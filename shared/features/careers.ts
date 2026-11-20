// Wire types for the "careers" feature (agent-city piece 3, the 🏛 Tower): one WORKER per
// automation lineage (shared/display.ts automationKey over every live and archived session title),
// each with a career state computed by code from its real runs. server/features/careers-lib.ts has
// the state machine and the one department map. No model call anywhere.
//
//   GET  /api/careers                     → CareersResponse
//   POST /api/careers/:key/retire         {confirm:true}              → CareersActionResult
//   POST /api/careers/:key/unretire       {confirm:true}              → CareersActionResult
//   POST /api/careers/:key/name           {confirm:true, name|null}   → CareersActionResult
//   WS   { feature: "careers", payload: CareersMessage }   the summary, when it changed
//   WorldSnapshot.extras["careers.summary"] → CareersSummary
// `:key` is the automationKey, URI-encoded ("/daily-recap" → "%2Fdaily-recap").
//
// Retire / Un-retire / Name only change what Alef displays: they write data/careers.json and
// nothing else (never launchd, skills or transcripts).

export const CAREER_STATES = ["trusted", "probation", "enrolled", "lapsed", "returned", "retired"] as const;
export type CareerState = (typeof CAREER_STATES)[number];

/** What a worker's runs alone say (a retirement sits on top of it: see CareerWorker.state). */
export type CareerStanding = "enrolled" | "trusted" | "probation" | "lapsed";

/** Sections of the Tower, in display order. Which worker sits where: careers-lib.ts departmentOf. */
export const DEPARTMENTS = ["Reports & Briefs", "Inbox desk", "Research library", "Institute", "Control room", "Operations"] as const;
export type Department = (typeof DEPARTMENTS)[number];

/**
 * One run's mark on the strip:
 *   clean      outcomes says shipped / delivered / finished (its todo list all completed)
 *   wrote      outcomes says unknown, but it wrote ≥ 1 file: it did something, with no evidence it
 *              delivered it (a log file counts too), so it never counts toward trusted
 *   failed     its transcript ended in a failure (outcomes: API error, cut-off turn, headless interrupt)
 *   stopped    interrupted by the user
 *   abandoned  waited on the user, then nothing for 24h
 *   empty      0 tool calls: it did nothing it could show
 *   unknown    no verdict: archived (no transcript left), live now, not scanned yet, a verdict
 *              outcomes can still change (a cut-off turn, a closing question), or tool calls with
 *              no writes and no evidence
 * failed / stopped / abandoned / empty are "bad"; unknown never counts either way.
 */
export type RunMark = "clean" | "wrote" | "failed" | "stopped" | "abandoned" | "empty" | "unknown";

export interface CareerRun {
  /** Session id. */
  id: string;
  /** ISO start time; for an archived run only its day is known (dayOnly). */
  at: string;
  dayOnly: boolean;
  archived: boolean;
  mark: RunMark;
  /** One line: why this mark ("did nothing: 0 tool calls", "API Error: …", "archived: …"). */
  why: string;
}

export interface CareerRoutine {
  /** "com.stephane.<slug>", matched by the exact shortName. Shown, never used as proof. */
  label: string;
  schedule: string;
  lastExitStatus: number | null;
  running: boolean;
}

export interface CareerWorker {
  /** The automationKey: "/daily-recap", "⏰ rss-feed-obsidian", "eval-harness". */
  key: string;
  /** Alex's display name for it (careers.json), or null. */
  name: string | null;
  department: Department;
  state: CareerState;
  standing: CareerStanding;
  /** One line explaining the state. */
  reason: string;
  /** Its last 10 runs, newest first. */
  runs: CareerRun[];
  lifetime: { total: number; live: number; archived: number; clean: number; wrote: number; bad: number };
  lastRunAt: string | null;
  /** Median gap between its last 10 runs; null with fewer than 2 runs. */
  medianGapMs: number | null;
  /** No run for this long = lapsed: max(3 × medianGapMs, 72h). */
  lapseAfterMs: number;
  /** Start of the run that completed its current streak of 5 clean runs; null unless trusted. */
  trustedSince: string | null;
  retiredAt: string | null;
  routine: CareerRoutine | null;
}

export type CareersSummary = Record<CareerState, number> & { total: number };

/** Runs with a verdict in each of a trend's two windows. */
export const TREND_WINDOW = 10;

/** One window of a worker's runs with a verdict (clean, only wrote, or bad). */
export interface TrendWindow {
  /** Runs with a verdict in it (at most TREND_WINDOW). */
  runs: number;
  clean: number;
  /** Start of its oldest and newest run (a YYYY-MM-DD when only the day is known); null when empty. */
  from: string | null;
  to: string | null;
}

/**
 * Is a worker getting better? The clean rate of its last TREND_WINDOW runs with a verdict against
 * the TREND_WINDOW before them (careers-lib.ts trendOf). Runs with no verdict (archived, live,
 * awaiting outcomes) are in neither window. deltaPts is null until both windows are full.
 */
export interface CareerTrend {
  key: string;
  /** Dated runs with a verdict, lifetime. */
  verdictRuns: number;
  recent: TrendWindow;
  prior: TrendWindow;
  /** Clean-rate change in percentage points, recent minus prior; null unless both windows are full. */
  deltaPts: number | null;
}

export interface CareersResponse {
  ok: true;
  at: string;
  /** Inputs the states were computed from, so the panel can say what it knows. */
  inputs: { liveRuns: number; archivedRuns: number; archiveLoaded: boolean; outcomeRecords: number; routines: number };
  departments: readonly Department[];
  summary: CareersSummary;
  workers: CareerWorker[];
  /** One per worker, by key. */
  trends: CareerTrend[];
}

export interface CareersActionResult {
  ok: boolean;
  error?: string;
  key?: string;
  state?: CareerState;
  name?: string | null;
}

export type CareersMessage = { kind: "summary"; summary: CareersSummary };

/** "45m", "72h", "4d": a span, rounded, for reasons and cadence lines (server and client alike). */
export function formatSpan(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms <= 72 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export const CAREERS_SUMMARY_KEY = "careers.summary";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isCareerState(v: unknown): v is CareerState {
  return typeof v === "string" && (CAREER_STATES as readonly string[]).includes(v);
}

export function emptySummary(): CareersSummary {
  return { trusted: 0, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 0 };
}

/** The summary from a snapshot extra or a WS message; null for anything else (the client trusts
 *  nothing it parses). */
export function parseCareersSummary(v: unknown): CareersSummary | null {
  if (!isRecord(v)) return null;
  const out = emptySummary();
  for (const k of [...CAREER_STATES, "total"] as const) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[k] = n;
  }
  return out;
}

const MARKS: readonly string[] = ["clean", "wrote", "failed", "stopped", "abandoned", "empty", "unknown"] satisfies readonly RunMark[];

function isRun(v: unknown): v is CareerRun {
  return isRecord(v) && typeof v.id === "string" && typeof v.at === "string" && typeof v.dayOnly === "boolean" && typeof v.archived === "boolean" && typeof v.mark === "string" && MARKS.includes(v.mark) && typeof v.why === "string";
}

function isNumOrNull(v: unknown): boolean {
  return v === null || typeof v === "number";
}

function isWorker(v: unknown): v is CareerWorker {
  if (!isRecord(v)) return false;
  const life = v.lifetime;
  const routine = v.routine;
  return (
    typeof v.key === "string" &&
    (v.name === null || typeof v.name === "string") &&
    typeof v.department === "string" &&
    (DEPARTMENTS as readonly string[]).includes(v.department) &&
    isCareerState(v.state) &&
    typeof v.standing === "string" &&
    typeof v.reason === "string" &&
    Array.isArray(v.runs) &&
    v.runs.every(isRun) &&
    isRecord(life) &&
    ["total", "live", "archived", "clean", "wrote", "bad"].every((k) => typeof life[k] === "number") &&
    (v.lastRunAt === null || typeof v.lastRunAt === "string") &&
    isNumOrNull(v.medianGapMs) &&
    typeof v.lapseAfterMs === "number" &&
    (v.trustedSince === null || typeof v.trustedSince === "string") &&
    (v.retiredAt === null || typeof v.retiredAt === "string") &&
    (routine === null || (isRecord(routine) && typeof routine.label === "string" && typeof routine.schedule === "string" && isNumOrNull(routine.lastExitStatus) && typeof routine.running === "boolean"))
  );
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isTrendWindow(v: unknown): v is TrendWindow {
  return isRecord(v) && isCount(v.runs) && isCount(v.clean) && v.clean <= v.runs && v.runs <= TREND_WINDOW && (v.from === null || typeof v.from === "string") && (v.to === null || typeof v.to === "string");
}

function isTrend(v: unknown): v is CareerTrend {
  return isRecord(v) && typeof v.key === "string" && isCount(v.verdictRuns) && isTrendWindow(v.recent) && isTrendWindow(v.prior) && (v.deltaPts === null || (typeof v.deltaPts === "number" && Number.isFinite(v.deltaPts)));
}

/** A window's clean rate in whole percent, or null when it has no runs. */
export function cleanPct(w: TrendWindow): number | null {
  return w.runs === 0 ? null : Math.round((100 * w.clean) / w.runs);
}

type DayFormat = (at: string) => string;
const isoDay: DayFormat = (at) => at.slice(0, 10);

function spanText(w: TrendWindow, day: DayFormat): string {
  if (!w.from || !w.to) return "";
  const a = day(w.from);
  const b = day(w.to);
  return a === b ? a : `${a} – ${b}`;
}

function windowText(w: TrendWindow, day: DayFormat): string {
  return `${w.clean} of ${w.runs} clean (${cleanPct(w) ?? 0}%, ${spanText(w, day)})`;
}

/** One worker's trend in one line, every count with its window. */
export function trendLine(t: CareerTrend, day: DayFormat = isoDay): string {
  if (t.verdictRuns === 0) return "No trend: no run with a verdict yet.";
  if (t.recent.runs < TREND_WINDOW) return `No trend yet: ${t.verdictRuns} run${t.verdictRuns === 1 ? "" : "s"} with a verdict (a trend compares the last ${TREND_WINDOW} with the ${TREND_WINDOW} before).`;
  const recent = `Last ${TREND_WINDOW} runs with a verdict: ${windowText(t.recent, day)}`;
  if (t.deltaPts === null) return `${recent}. Nothing to compare yet: ${t.prior.runs} of the ${TREND_WINDOW} before them.`;
  const move = t.deltaPts > 0 ? `Better by ${t.deltaPts} pts` : t.deltaPts < 0 ? `Worse by ${-t.deltaPts} pts` : "No change";
  return `${recent} vs the ${TREND_WINDOW} before: ${windowText(t.prior, day)}. ${move}.`;
}

/** The Tower's one-line answer to "are they getting better?", over every worker's trend. */
export function trendSummaryLine(trends: readonly CareerTrend[]): string {
  const measured = trends.filter((t) => t.deltaPts !== null);
  const up = measured.filter((t) => (t.deltaPts ?? 0) > 0).length;
  const down = measured.filter((t) => (t.deltaPts ?? 0) < 0).length;
  const n = measured.length;
  const head = `Getting better? ${n} of ${trends.length} worker${trends.length === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} ${2 * TREND_WINDOW}+ runs with a verdict to compare`;
  return n === 0 ? `${head}.` : `${head}: ${up} better, ${down} worse, ${n - up - down} no change (clean rate, last ${TREND_WINDOW} vs the ${TREND_WINDOW} before).`;
}

/** GET /api/careers, validated; null when it isn't that shape. Malformed workers and trends are
 *  dropped (a response with no trends list reads as none). */
export function parseCareersResponse(v: unknown): CareersResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.at !== "string" || !Array.isArray(v.workers) || !isRecord(v.inputs)) return null;
  const summary = parseCareersSummary(v.summary);
  if (!summary) return null;
  const i = v.inputs;
  if (typeof i.liveRuns !== "number" || typeof i.archivedRuns !== "number" || typeof i.archiveLoaded !== "boolean" || typeof i.outcomeRecords !== "number" || typeof i.routines !== "number") return null;
  return {
    ok: true,
    at: v.at,
    inputs: { liveRuns: i.liveRuns, archivedRuns: i.archivedRuns, archiveLoaded: i.archiveLoaded, outcomeRecords: i.outcomeRecords, routines: i.routines },
    departments: DEPARTMENTS,
    summary,
    workers: v.workers.filter(isWorker),
    trends: Array.isArray(v.trends) ? v.trends.filter(isTrend) : [],
  };
}
