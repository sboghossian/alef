// Pure core of the "careers" feature (the 🏛 Tower): automation lineages as workers with careers.
// No I/O and no model call. shared/features/careers.ts has the wire types.
//
// A WORKER is one automationKey lineage (shared/display.ts): every live or archived session whose
// title that function maps to the same key is one of its RUNS. A run's verdict comes from the
// outcomes feature's record for that session (server/features/outcomes.ts); nothing here
// re-reads a transcript or recomputes an outcome.
//
// Run verdicts:
//   clean  outcomes says shipped / delivered / finished: its own evidence the run delivered
//   wrote  outcomes says unknown, but the run wrote ≥ 1 file. It did something, and nothing says it
//          delivered it (✅ 2026-09-28: the 4 such /artifact-ritual runs wrote only its LAST_RUN.md
//          log, each saying the ritual couldn't run). It counts as a run with a verdict (the 3-run
//          minimum, probation's window) but never toward trusted.
//   bad    failed / stopped / abandoned, or empty (0 tool calls)
//   none   archived (no transcript left, whatever the vault says), live now, not scanned yet or
//          not read to its end (the outcomes scanner will get there), a verdict outcomes marks
//          provisional (provisionalUntil: the clock alone can still make it failed or abandoned),
//          or tool calls with no writes and no outcome evidence. A run with no verdict never
//          counts either way.
// A launchd exit status is never an input: a headless `claude -p` can exit 0 having done nothing.
//
// Standing (what the runs alone say), first match wins:
//   lapsed     no run for max(3 × the median gap of its last 10 runs, 72h)
//   enrolled   fewer than 3 runs with a verdict
//   probation  at least one of the last 5 runs with a verdict is bad (reason: the latest bad one)
//   trusted    the last 5 runs with a verdict are all clean
//   enrolled   otherwise: no bad run in its last 5, but not 5 clean in a row yet (3 or 4 runs, or
//              some of them only wrote files)
// State = the standing, unless Alex retired it (data/careers.json): "retired" until a run
// starts after retiredAt, then "returned" (the retirement no longer holds; Un-retire clears it).
//
// Trend (trendOf): the clean rate of its newest 10 dated runs with a verdict against the 10 before
// them, each window with its run count and date span. "wrote" and "bad" both count as not clean.
// No delta until both windows are full: a rate over 3 runs is not a trend.

import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { FeedItem } from "../../shared/features/feed.js";
import type { Routine } from "../../shared/features/routines.js";
import { automationKey } from "../../shared/display.js";
import {
  emptySummary,
  formatSpan,
  TREND_WINDOW,
  type CareerRun,
  type CareerStanding,
  type CareerState,
  type CareerTrend,
  type CareerWorker,
  type CareersSummary,
  type Department,
  type RunMark,
  type TrendWindow,
} from "../../shared/features/careers.js";
import { sanitizeTitle } from "../heuristics.js";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The lapse floor: a worker is never lapsed before this long without a run. */
export const LAPSE_FLOOR_MS = 72 * HOUR_MS;
export const LAPSE_GAP_FACTOR = 3;
/** Runs the median gap is taken over, and the strip's length. */
export const STRIP_RUNS = 10;
/** Runs in a row it takes to be trusted; also the probation window. */
export const TRUST_RUNS = 5;
/** Fewer runs with a verdict than this = enrolled. */
export const MIN_VERDICT_RUNS = 3;
export const MAX_NAME_LENGTH = 40;
const MAX_KEY_LENGTH = 120;

// ── departments: the ONE map (nothing else in the codebase assigns a department) ─────────────

/**
 * Which Tower section each automation lineage works in, by its exact automationKey. A key that
 * isn't listed works in Operations. Keys are the ones automationKey actually produces today
 * (✅ 2026-09-28 over /api/world + /api/archive): "/<skill>" for a slash-command or step run,
 * "⏰ <name>" for a scheduled task, and the five fixed classifier names.
 */
const DEPARTMENT_OF: Readonly<Record<string, Department>> = {
  "/daily-recap": "Reports & Briefs",
  "/yalla-brief": "Reports & Briefs",
  "/artifact-ritual": "Reports & Briefs",
  "⏰ daily-work-summary": "Reports & Briefs",
  "⏰ weekly-work-summary": "Reports & Briefs",
  "/inbox-sweep": "Inbox desk",
  "/inbox-operator": "Inbox desk",
  "⏰ acme-inbox-scan": "Inbox desk",
  "idea-inbox": "Inbox desk",
  "inbox-triage": "Inbox desk",
  "eval-harness": "Research library",
  "⏰ rss-feed-obsidian": "Research library",
  "/ig-innovation": "Research library",
  "⏰ daily-legal-llm-benchmark": "Research library",
  "⏰ legal-ai-daily-digest": "Research library",
  "/upskill": "Institute",
  "session-groups": "Institute",
  "fleet-probe": "Control room",
};

export function departmentOf(key: string): Department {
  return Object.hasOwn(DEPARTMENT_OF, key) ? DEPARTMENT_OF[key]! : "Operations";
}

/** The routine slug a key would have: "/daily-recap" and "⏰ daily-recap" → "daily-recap". */
export function routineSlug(key: string): string {
  return key.replace(/^⏰\s*/, "").replace(/^\/+/, "");
}

/** The com.stephane.<slug> routine whose shortName is exactly this worker's slug, or null. */
export function routineFor(key: string, routines: readonly Routine[]): Routine | null {
  const slug = routineSlug(key);
  return routines.find((r) => r.shortName === slug) ?? null;
}

// ── runs ─────────────────────────────────────────────────────────────────

export interface RunSource {
  id: string;
  /** The raw first prompt (WorldAgent.title / ArchivedSession.title): what automationKey reads. */
  title: string;
  /** Start time (ms); for a day-only archived run, local midnight of its day. Null = no date. */
  atMs: number | null;
  /** The run's own date string when only the day is known ("2026-09-26"). */
  day: string | null;
  archived: boolean;
  live: boolean;
}

/** An archived session's YYYY-MM-DD as local midnight (ms), or null when it isn't a real date. */
export function dayStartMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null;
}

export interface AgentLike {
  id: string;
  title: string;
  status: string;
  startedAt: string;
}

export interface ArchivedLike {
  id: string;
  title: string;
  date: string;
}

/** Every run from the world's agents and the archive's fossils, the agents first (an id in both
 *  is the agent's: the archive already skips ids the world indexes). */
export function runSources(agents: readonly AgentLike[], archived: readonly ArchivedLike[]): RunSource[] {
  const out: RunSource[] = [];
  for (const a of agents) {
    const t = Date.parse(a.startedAt);
    out.push({ id: a.id, title: a.title, atMs: Number.isFinite(t) ? t : null, day: null, archived: false, live: a.status === "live" });
  }
  for (const s of archived) out.push({ id: s.id, title: s.title, atMs: dayStartMs(s.date), day: s.date || null, archived: true, live: false });
  return out;
}

/** Runs grouped by automationKey, each id once (first wins). Sessions no automation wrote are skipped. */
export function groupRuns(runs: readonly RunSource[]): Map<string, RunSource[]> {
  const seen = new Set<string>();
  const out = new Map<string, RunSource[]>();
  for (const r of runs) {
    const id = r.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const key = automationKey(r.title);
    if (!key || key.length > MAX_KEY_LENGTH) continue;
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}

export type Verdict = "clean" | "wrote" | "bad" | null;

export interface RunJudgement {
  mark: RunMark;
  verdict: Verdict;
  why: string;
  /** Its verdict is still coming: the outcomes scanner hasn't read this dormant transcript to its
   *  end, or says the clock alone can still change what it read (provisionalUntil). */
  awaiting: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One run's mark, from the outcomes record of its session (never from an exit code). */
export function judgeRun(run: Pick<RunSource, "archived" | "live">, rec: OutcomeRecord | undefined): RunJudgement {
  if (run.archived) return { mark: "unknown", verdict: null, why: "archived: no transcript left to judge", awaiting: false };
  if (run.live) return { mark: "unknown", verdict: null, why: "live now: no verdict yet", awaiting: false };
  if (!rec) return { mark: "unknown", verdict: null, why: "not scanned by outcomes yet", awaiting: true };
  if (rec.pending || rec.outcome === "active") return { mark: "unknown", verdict: null, why: "not read to its end yet", awaiting: true };
  if (rec.outcome === "failed" || rec.outcome === "stopped" || rec.outcome === "abandoned") {
    return { mark: rec.outcome, verdict: "bad", why: rec.reason ?? rec.outcome, awaiting: false };
  }
  // Outcomes' own word that this verdict isn't final: a cut-off turn reads finished (or unknown)
  // until its stall bound, a closing question until 24h. Counting it now could graduate a worker
  // on a run that turns bad minutes later.
  if (rec.provisionalUntil !== null) {
    const until = `${rec.provisionalUntil.slice(0, 16).replace("T", " ")} UTC`;
    return { mark: "unknown", verdict: null, why: `not final yet: outcomes may still call it cut off or abandoned (until ${until})`, awaiting: true };
  }
  if (rec.toolCalls === 0) return { mark: "empty", verdict: "bad", why: "did nothing: 0 tool calls", awaiting: false };
  if (rec.outcome === "shipped" || rec.outcome === "delivered" || rec.outcome === "finished") {
    return { mark: "clean", verdict: "clean", why: rec.reason ?? rec.outcome, awaiting: false };
  }
  if (rec.writes >= 1) return { mark: "wrote", verdict: "wrote", why: `wrote ${plural(rec.writes, "file edit")}: no shipped, delivered or finished evidence`, awaiting: false };
  return { mark: "unknown", verdict: null, why: `no outcome evidence: ${plural(rec.toolCalls, "tool call")}, no writes`, awaiting: false };
}

/** Median of the gaps between consecutive run times (any order in); null with fewer than 2. */
export function medianGapMs(times: readonly number[]): number | null {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

export function lapseAfterMs(median: number | null): number {
  return Math.max(LAPSE_GAP_FACTOR * (median ?? 0), LAPSE_FLOOR_MS);
}

// ── careers.json (Alex's intent: retirements and names; nothing computed) ──────────────

export const CAREERS_FILE_VERSION = 1;

export interface CareerEntry {
  retiredAt: string | null;
  name: string | null;
  updatedAt: string;
}

export interface CareersFile {
  version: typeof CAREERS_FILE_VERSION;
  workers: Record<string, CareerEntry>;
}

export function emptyCareersFile(): CareersFile {
  return { version: CAREERS_FILE_VERSION, workers: {} };
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
}

/** The persisted file, or null when it isn't this version's shape at all (the caller reads that as
 *  empty, and keeps the bytes aside before ever writing over them). A bad entry alone is dropped. */
export function parseCareersFile(raw: unknown): CareersFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== CAREERS_FILE_VERSION || typeof r.workers !== "object" || r.workers === null || Array.isArray(r.workers)) return null;
  const workers = Object.fromEntries(
    Object.entries(r.workers as Record<string, unknown>).flatMap(([key, v]): Array<[string, CareerEntry]> => {
      if (key.length === 0 || key.length > MAX_KEY_LENGTH || typeof v !== "object" || v === null || Array.isArray(v)) return [];
      const e = v as Record<string, unknown>;
      if (!(e.retiredAt === null || isIso(e.retiredAt)) || !(e.name === null || typeof e.name === "string") || !isIso(e.updatedAt)) return [];
      return [[key, { retiredAt: e.retiredAt, name: e.name === null ? null : cleanName(e.name), updatedAt: e.updatedAt }]];
    }),
  );
  return { version: CAREERS_FILE_VERSION, workers };
}

/** A display name as stored: one line, no control characters, at most 40 characters; null when empty. */
export function cleanName(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return [...s].slice(0, MAX_NAME_LENGTH).join("");
}

export function entryOf(file: CareersFile, key: string): CareerEntry | null {
  return Object.hasOwn(file.workers, key) ? file.workers[key]! : null;
}

// ── workers ──────────────────────────────────────────────────────────────

export interface ComputedWorker {
  worker: CareerWorker;
  /** Runs still awaiting the outcomes scanner that could change its standing: every awaiting run
   *  newer than its 5th-newest run with a verdict (all of them while it has fewer than 5). */
  awaiting: number;
  /** What its runs with a verdict say, lapse aside: a move into trusted or probation is news only
   *  when THIS changed (leaving a lapse, or catching up on verdicts it already had, is not). */
  verdictStanding: VerdictStanding;
  verdictReason: string;
  /** Runs with a verdict, lifetime. */
  verdictRuns: number;
  /** What its runs alone say, in one line (the state's reason may lead with a retirement). */
  standingReason: string;
  /** Its clean rate, newest 10 runs with a verdict against the 10 before (trendOf). */
  trend: CareerTrend;
}

export interface CareersInput {
  runs: readonly RunSource[];
  records: ReadonlyMap<string, OutcomeRecord>;
  file: CareersFile;
  routines: readonly Routine[];
  nowMs: number;
}

export interface JudgedRun extends RunSource {
  atMs: number;
  j: RunJudgement;
}

function runAt(r: RunSource & { atMs: number }): string {
  return r.day ?? new Date(r.atMs).toISOString();
}

function dayOf(r: RunSource & { atMs: number }): string {
  return r.day ?? new Date(r.atMs).toISOString().slice(0, 10);
}

/** Newest first; ties by id so the order never depends on input order. */
function newestFirst(a: JudgedRun, b: JudgedRun): number {
  return b.atMs - a.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What its runs with a verdict say, lapse aside. */
export type VerdictStanding = Exclude<CareerStanding, "lapsed">;

function verdictStandingOf(sorted: readonly JudgedRun[]): { standing: VerdictStanding; reason: string; trustedSince: string | null } {
  const judged = sorted.filter((r) => r.j.verdict !== null);
  if (judged.length < MIN_VERDICT_RUNS) return { standing: "enrolled", reason: `${plural(judged.length, "run")} with a verdict so far (needs ${MIN_VERDICT_RUNS})`, trustedSince: null };
  const window = judged.slice(0, TRUST_RUNS);
  const bad = window.find((r) => r.j.verdict === "bad");
  if (bad) return { standing: "probation", reason: bad.j.mark === "empty" ? bad.j.why : `${bad.j.mark}: ${bad.j.why}`, trustedSince: null };
  let streak = 0;
  while (streak < judged.length && judged[streak]!.j.verdict === "clean") streak++;
  if (streak < TRUST_RUNS) {
    const wrote = window.filter((r) => r.j.verdict === "wrote").length;
    const why = wrote === 0 ? "" : ` (${wrote === window.length ? "its" : `${wrote} of its`} last ${window.length} only wrote files: no shipped, delivered or finished evidence)`;
    return { standing: "enrolled", reason: `${streak} of ${TRUST_RUNS} clean runs in a row toward trusted${why}`, trustedSince: null };
  }
  const completing = judged[streak - TRUST_RUNS]!;
  return { standing: "trusted", reason: `last ${TRUST_RUNS} runs with a verdict all clean (${streak} in a row)`, trustedSince: runAt(completing) };
}

function windowOf(runs: readonly JudgedRun[]): TrendWindow {
  const oldest = runs[runs.length - 1];
  const newest = runs[0];
  return { runs: runs.length, clean: runs.filter((r) => r.j.verdict === "clean").length, from: oldest ? runAt(oldest) : null, to: newest ? runAt(newest) : null };
}

/** The trend from a worker's dated runs sorted newest first (computeWorker's order). */
export function trendOf(key: string, sorted: readonly JudgedRun[]): CareerTrend {
  const judged = sorted.filter((r) => r.j.verdict !== null);
  const recent = windowOf(judged.slice(0, TREND_WINDOW));
  const prior = windowOf(judged.slice(TREND_WINDOW, 2 * TREND_WINDOW));
  const full = recent.runs === TREND_WINDOW && prior.runs === TREND_WINDOW;
  const deltaPts = full ? Math.round((100 * (recent.clean - prior.clean)) / TREND_WINDOW) : null;
  return { key, verdictRuns: judged.length, recent, prior, deltaPts };
}

/** One worker from its runs (any order), its outcomes and its careers.json entry. */
export function computeWorker(key: string, runs: readonly RunSource[], input: Omit<CareersInput, "runs">): ComputedWorker {
  const dated: JudgedRun[] = [];
  let clean = 0;
  let wrote = 0;
  let bad = 0;
  for (const r of runs) {
    const j = judgeRun(r, input.records.get(r.id));
    if (j.verdict === "clean") clean++;
    else if (j.verdict === "wrote") wrote++;
    else if (j.verdict === "bad") bad++;
    if (r.atMs !== null) dated.push({ ...r, atMs: r.atMs, j });
  }
  dated.sort(newestFirst);
  const last10 = dated.slice(0, STRIP_RUNS);
  const median = medianGapMs(last10.map((r) => r.atMs));
  const lapseMs = lapseAfterMs(median);
  const lastRun = dated[0];
  // A day-only run happened some time that day: it counts as late as the day's end.
  const lastRunEnd = dated.reduce((m, r) => Math.max(m, r.day !== null ? r.atMs + DAY_MS : r.atMs), -Infinity);
  const lapsed = lastRun !== undefined && input.nowMs - lastRunEnd > lapseMs;
  const byVerdicts = verdictStandingOf(dated);
  const standing: CareerStanding = lapsed ? "lapsed" : byVerdicts.standing;
  const standingReason = lapsed && lastRun ? `stopped reporting: no run since ${dayOf(lastRun)} (lapses after ${formatSpan(lapseMs)} without one)` : byVerdicts.reason;
  const trustedSince = lapsed ? null : byVerdicts.trustedSince;

  const entry = entryOf(input.file, key);
  const retiredMs = entry?.retiredAt ? Date.parse(entry.retiredAt) : null;
  let state: CareerState = standing;
  let reason = standingReason;
  if (entry?.retiredAt && retiredMs !== null) {
    const ranAgain = dated.find((r) => r.atMs > retiredMs); // a day-only run counts from its day's start: never a false "returned"
    const since = entry.retiredAt.slice(0, 10);
    if (ranAgain) {
      const newest = lastRun!;
      state = "returned";
      reason = `ran again ${dayOf(newest)} after you retired it on ${since} · ${standing}: ${standingReason}`;
    } else {
      state = "retired";
      reason = `retired on ${since} (only changes what Alef shows)`;
    }
  }

  const routine = routineFor(key, input.routines);
  // Settled = no run that could still enter the standing window is waiting for its verdict.
  let awaiting = 0;
  let seen = 0;
  for (const r of dated) {
    if (seen >= TRUST_RUNS) break;
    if (r.j.awaiting) awaiting++;
    if (r.j.verdict !== null) seen++;
  }
  const strip: CareerRun[] = last10.map((r) => ({ id: r.id, at: runAt(r), dayOnly: r.day !== null, archived: r.archived, mark: r.j.mark, why: r.j.why }));
  const worker: CareerWorker = {
    key,
    name: entry?.name ?? null,
    department: departmentOf(key),
    state,
    standing,
    reason,
    runs: strip,
    lifetime: { total: runs.length, live: runs.filter((r) => !r.archived).length, archived: runs.filter((r) => r.archived).length, clean, wrote, bad },
    lastRunAt: lastRun ? runAt(lastRun) : null,
    medianGapMs: median,
    lapseAfterMs: lapseMs,
    trustedSince,
    retiredAt: entry?.retiredAt ?? null,
    routine: routine ? { label: routine.label, schedule: routine.schedule.text, lastExitStatus: routine.lastExitStatus, running: routine.running } : null,
  };
  return { worker, awaiting, verdictStanding: byVerdicts.standing, verdictReason: byVerdicts.reason, verdictRuns: clean + wrote + bad, standingReason, trend: trendOf(key, dated) };
}

/** Every worker, busiest first (lifetime runs, then key). */
export function computeCareers(input: CareersInput): ComputedWorker[] {
  const out: ComputedWorker[] = [];
  for (const [key, runs] of groupRuns(input.runs)) out.push(computeWorker(key, runs, input));
  return out.sort((a, b) => b.worker.lifetime.total - a.worker.lifetime.total || (a.worker.key < b.worker.key ? -1 : 1));
}

export function summarize(workers: readonly CareerWorker[]): CareersSummary {
  const s = emptySummary();
  for (const w of workers) s[w.state] += 1;
  s.total = workers.length;
  return s;
}

/** When a summary push is due: the counts AND which workers are trusted (key, display name,
 *  department). Counts alone miss a swap that keeps them (one worker loses trust in the tick
 *  another gains it) and a trusted worker's rename, and the campus's banners and 🎓 callouts
 *  re-read the workers on this push (client campus-data.ts). The message itself is unchanged. */
export function publishKey(s: CareersSummary, workers: readonly Pick<CareerWorker, "key" | "state" | "name" | "department">[]): string {
  const trusted = workers
    .filter((w) => w.state === "trusted")
    .map((w) => [w.key, w.name, w.department])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([s, trusted]);
}

// ── the Feed ─────────────────────────────────────────────────────────────

export interface RecordedCareer {
  state: CareerState;
  standing: CareerStanding;
  verdictStanding: VerdictStanding;
}

/** What to remember of a worker after a settled computation. */
export function recordOf(c: ComputedWorker): RecordedCareer {
  return { state: c.worker.state, standing: c.worker.standing, verdictStanding: c.verdictStanding };
}

export function workerLabel(w: Pick<CareerWorker, "key" | "name">): string {
  return w.name ? `${w.name} (${w.key})` : w.key;
}

/**
 * The Feed item for a worker's move from `prev` (its last recorded, settled state) to `c`, or
 * null when the move isn't news. Kind "graduation", like the outcomes feature's session
 * graduations. News is:
 *   - running again after a retirement (entering "returned", however many ticks it took);
 *   - into lapsed, for a worker with a record (3+ runs with a verdict): a slash command typed by
 *     hand twice has nothing to stop;
 *   - into trusted or probation while not lapsed, only when what its VERDICTS say changed:
 *     leaving a lapse on the same verdicts is not a second graduation or probation, and a move
 *     while lapsed is recorded silently.
 * Never: into enrolled, anything while retired, or no change.
 */
export function careerFeedItem(prev: RecordedCareer, c: ComputedWorker, nowIso: string): Omit<FeedItem, "seq"> | null {
  const w = c.worker;
  const label = workerLabel(w);
  const newest = w.runs[0] ?? null;
  const agentId = newest && !newest.archived ? newest.id : null;
  const item = (tag: string, title: string, detail: string | null): Omit<FeedItem, "seq"> => ({
    id: `career:${w.key}:${tag}:${newest?.id ?? "none"}`,
    at: nowIso,
    kind: "graduation",
    agentId,
    title: sanitizeTitle(title),
    detail: detail === null ? null : sanitizeTitle(detail),
    tag: `career-${tag}`,
  });
  if (w.state === "retired") return null;
  if (w.state === "returned" && prev.state !== "returned") return item("returned", `↺ ${label} ran again after you retired it`, w.reason);
  if (w.standing === "lapsed") {
    if (prev.standing === "lapsed" || c.verdictRuns < MIN_VERDICT_RUNS) return null;
    return item("lapsed", `💤 ${label} stopped reporting (last run ${w.lastRunAt ? w.lastRunAt.slice(0, 10) : "never"})`, c.standingReason);
  }
  if (c.verdictStanding === prev.verdictStanding) return null;
  if (c.verdictStanding === "trusted") return item("trusted", `🎓 ${label} graduated: ${TRUST_RUNS} clean runs in a row · ${w.department}`, c.verdictReason);
  if (c.verdictStanding === "probation") return item("probation", `↩ ${label} ${prev.verdictStanding === "trusted" ? "back on probation" : "on probation"}: ${c.verdictReason}`, c.verdictReason);
  return null;
}
