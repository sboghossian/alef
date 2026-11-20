// "vision": the vision ledger. shared/features/vision.ts holds the post's 42 claims as data (an
// audited status, an evidence line, a probe id or null); this feature re-checks what code can check
// and serves the ledger with its computed percentage and formula.
//
// Probes (every 5 min, and once on the first GET), each reading a running feature's own state,
// never a second count of the same thing:
//   census-sessions     agents.length + the archive's fossils (what the Census chip adds up)
//   census-generations  the subagent records, folded by census-lib's generations() (the Census's fold)
//   census-merged       the Census's last gh pr list (a failed or stale fetch fails it)
//   sickness            the served case counts, once the cold scan has read every transcript
//   wake-recall         the fed share at wake (fed / main transcripts)
//   jobs                sessions with one of the five jobs / sessions
//   trips               the honest-trips cleanup ran, and every stored visit is proven by touched
//                       files (an unproven one fails only if it is still unproven on the next run)
//   town-square         every launch stranded on Alex is in a fresh top 5 (a launch counts
//                       once a top 5 was computed after this feature first saw it stranded)
//   resident-journal    the resident's lastReflectAt is inside Health's warn limit
//   webtrips            Jev has at least one kept web trip (data/jev-web.jsonl, as webtrips.ts read
//                       it); the detail also counts the sessions' own trips, which make "only" false
//   improvement         at least one Tower worker measures better (careers-lib trendOf: clean rate,
//                       last 10 runs with a verdict against the 10 before), in the Tower's own words
//   crews               at least one crew: 2+ sessions whose outcome records name the same merged PR
//                       (shared/features/crews.ts, the agent panel's count); pending until the
//                       outcomes feature's first scan is done, unless a crew was already found
//   family-tree         3+ generations on record (a subagent that spawned its own), census fold
// pass keeps the audited status; fail lowers it one step (real -> partial -> missing); pending (the
// source isn't ready) keeps the audit and the row says why. A probe can never raise a status.
//
//   GET /api/vision -> VisionResponse
//
// Read-only: no writes, no model call, no subprocess.

import { homedir } from "node:os";
import { trendSummaryLine, type CareerTrend } from "../../shared/features/careers.js";
import type { CensusGenerations, CensusMergedSummary } from "../../shared/features/census.js";
import { crewCounts, shipCrews, type SessionPrs } from "../../shared/features/crews.js";
import type { JobsCounts } from "../../shared/features/jobs.js";
import type { ResidentState } from "../../shared/features/resident.js";
import type { SicknessCounts, SicknessKind, SicknessScanProgress } from "../../shared/features/sickness.js";
import type { StrandedDispatch } from "../../shared/features/talk.js";
import {
  effectiveStatus,
  VISION_CLAIMS,
  visionScore,
  type VisionClaim,
  type VisionClaimSeed,
  type VisionProbeId,
  type VisionProbeResult,
  type VisionProbeState,
  type VisionResponse,
} from "../../shared/features/vision.js";
import type { WakeRecallSummary } from "../../shared/features/wake-recall.js";
import type { WebTripsSummary } from "../../shared/features/webtrips.js";
import { respondJson } from "../http.js";
import { HONEST_TRIPS_FLAG, visitsFromDb } from "../trips-migration.js";
import { latestArchivedSessions } from "./archive.js";
import { latestCareerTrends } from "./careers.js";
import { generations } from "./census-lib.js";
import { latestCensusMerged } from "./census.js";
import { residentSilentWarnMs } from "./completeness-checks.js";
import { latestJobsCounts } from "./jobs.js";
import { summaryOf } from "./outcomes-lib.js";
import { latestOutcomeRecords, latestOutcomesColdDone } from "./outcomes.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { currentResidentState } from "./resident.js";
import { QUIET_REFLECT_FACTOR, REFLECT_MS } from "./resident-lib.js";
import { sicknessSummary } from "./sickness.js";
import { latestSubagentRecords } from "./subagents/index.js";
import { currentStranded } from "./talk.js";
import { latestWakeRecallSummary } from "./wake-recall.js";
import { webTripsFeature } from "./webtrips.js";
import { BROADCAST_STALE_MS, latestWorkspaceBroadcast, type WorkspaceBroadcast } from "./workspace-state.js";

export const VISION_TICK_MS = 5 * 60_000;
/** Health's own warn limit for a silent resident (4.5 h today). */
export const RESIDENT_WARN_MS = residentSilentWarnMs(REFLECT_MS * QUIET_REFLECT_FACTOR);

export interface ProbeOutcome {
  state: VisionProbeState;
  detail: string;
}

const n = (x: number): string => x.toLocaleString("en-US");
const pctText = (num: number, den: number): string => `${(Math.round((num / den) * 1000) / 10).toFixed(1)}%`;
const hhmm = (iso: string): string => (Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")}Z` : iso);

function spanText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ---------------------------------------------------------------- the probes (pure)

export function probeCensusSessions(indexed: number, fossils: number | null): ProbeOutcome {
  if (fossils === null) return { state: "pending", detail: "The archive has not been scanned yet, so the fossils are unknown." };
  const total = indexed + fossils;
  if (total === 0) return { state: "fail", detail: "0 sessions: nothing indexed and no fossils." };
  return { state: "pass", detail: `${n(total)} sessions = ${n(indexed)} indexed + ${n(fossils)} fossils.` };
}

/** `g`: census-lib's generations() over the subagent records (what GET /api/census serves), null
 *  before the subagents feature has indexed them. */
export function probeCensusGenerations(g: CensusGenerations | null): ProbeOutcome {
  if (g === null) return { state: "pending", detail: "The subagent records are not indexed yet." };
  if (g.total === 0) return { state: "fail", detail: "0 subagent records in subagents.db." };
  const depths = Object.keys(g.byDepth)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => `depth ${d}: ${n(g.byDepth[d] ?? 0)}`)
    .join(" · ");
  const since = g.since ? ` since ${g.since.slice(0, 10)}` : "";
  return { state: "pass", detail: `${n(g.total)} sub-minions${since} from ${n(g.parents)} sessions · ${g.generations} generations = 1 + deepest depth (${depths}).` };
}

export function probeCensusMerged(m: CensusMergedSummary | null): ProbeOutcome {
  if (!m || m.fetchedAt === null) {
    if (m?.error) return { state: "fail", detail: `gh pr list has never succeeded: ${m.error}` };
    return { state: "pending", detail: "gh pr list has not run yet." };
  }
  if (m.error) return { state: "fail", detail: `Stale since ${hhmm(m.fetchedAt)}: the last gh pr list failed (${m.error}).` };
  return { state: "pass", detail: `${n(m.total)} merged PRs (gh pr list --state merged at ${hhmm(m.fetchedAt)}) · review recorded on the merged SHA: ${n(m.reviewRecorded)}.` };
}

export interface SicknessFacts {
  counts: SicknessCounts;
  scan: SicknessScanProgress;
  disabledKinds: readonly SicknessKind[];
}

export function probeSickness(s: SicknessFacts | null): ProbeOutcome {
  if (!s) return { state: "pending", detail: "The case log has not loaded yet." };
  if (s.scan.finishedAt === null) return { state: "pending", detail: `The detectors are still reading transcripts (${n(s.scan.filesDone)} of ${n(s.scan.filesTotal)}).` };
  const { byKind, byState, total } = s.counts;
  const withheld = s.disabledKinds.length > 0 ? ` · withheld (precision below the bar): ${s.disabledKinds.join(", ")}` : "";
  if (total === 0) return { state: "fail", detail: `0 cases after reading every transcript${withheld}.` };
  const kinds = (Object.keys(byKind) as SicknessKind[])
    .filter((k) => !s.disabledKinds.includes(k))
    .map((k) => `${k} ${n(byKind[k])}`)
    .join(", ");
  const sick = byState.open + byState.chronic + byState.exposed;
  return { state: "pass", detail: `${n(total)} cases (${kinds}) · sick now ${n(sick)} = open ${n(byState.open)} + chronic ${n(byState.chronic)} + exposed ${n(byState.exposed)}${withheld}.` };
}

export function probeWakeRecall(w: WakeRecallSummary | null): ProbeOutcome {
  if (!w || !w.ready) return { state: "pending", detail: "The cold pass over transcript heads is not done yet." };
  const t = w.totals;
  if (t.sessions === 0) return { state: "pending", detail: "No main transcript is on disk." };
  if (t.fed === 0) return { state: "fail", detail: `0 of ${n(t.sessions)} main sessions got vault notes at wake.` };
  return {
    state: "pass",
    detail: `${n(t.fed)} of ${n(t.sessions)} main sessions got vault notes at wake = ${pctText(t.fed, t.sessions)} · nothing ${n(t.nothing)} (${n(t.headlessMisses)} headless) · unread ${n(t.unread)}.`,
  };
}

export function probeJobs(j: { at: string; counts: JobsCounts } | null): ProbeOutcome {
  if (!j) return { state: "pending", detail: "Jobs have not been computed yet." };
  const s = j.counts.sessions;
  const total = s.lawyer + s.hacker + s.learner + s.builder + s.gatherer + s.none;
  if (total === 0) return { state: "pending", detail: "No session is indexed." };
  const labelled = total - s.none;
  if (labelled === 0) return { state: "fail", detail: `0 of ${n(total)} sessions have a job.` };
  const sub = j.counts.subagents;
  const subTotal = sub ? sub.lawyer + sub.hacker + sub.learner + sub.builder + sub.gatherer + sub.none : 0;
  const subText = sub && subTotal > 0 ? ` · subagents ${n(subTotal - sub.none)} of ${n(subTotal)}` : "";
  return {
    state: "pass",
    detail: `${n(labelled)} of ${n(total)} sessions have a job = ${pctText(labelled, total)} (builder ${n(s.builder)}, learner ${n(s.learner)}, gatherer ${n(s.gatherer)}, lawyer ${n(s.lawyer)}, hacker ${n(s.hacker)}; none ${n(s.none)})${subText}.`,
  };
}

export interface TripsFacts {
  /** The one-time honest-trips cleanup has run (trips-migration.ts HONEST_TRIPS_FLAG). */
  cleaned: boolean;
  /** Stored `visited` edges. */
  visited: number;
  /** "<session>|<island>" of stored visits no touched file proves right now. */
  unproven: readonly string[];
  /** Invented roam/pair decisions among the newest 200. */
  invented: number;
}

/** `previouslyUnproven`: the unproven keys the last run saw. A visit only fails the probe when it was
 *  unproven on two runs in a row: the director re-syncs visits every minute, so a home change can
 *  leave one stored visit unproven for up to a minute, and that is not theatre. */
export function probeTrips(t: TripsFacts, previouslyUnproven: ReadonlySet<string> | null): ProbeOutcome {
  if (!t.cleaned) return { state: "fail", detail: "The honest-trips cleanup has not run: invented visits may still be stored." };
  if (t.invented > 0) return { state: "fail", detail: `${n(t.invented)} invented roam/pair decisions are stored.` };
  if (t.unproven.length > 0) {
    const stuck = previouslyUnproven ? t.unproven.filter((k) => previouslyUnproven.has(k)).length : 0;
    if (stuck > 0) return { state: "fail", detail: `${n(stuck)} of ${n(t.visited)} stored visits are proven by no touched file (two runs in a row).` };
    return { state: "pending", detail: `${n(t.unproven.length)} of ${n(t.visited)} stored visits are unproven right now; re-checked on the next run.` };
  }
  return { state: "pass", detail: `${n(t.visited)} visits, each proven by touched files · 0 invented roam/pair decisions.` };
}

/** `firstSeen`: tmux name -> when this feature first saw the launch stranded (ms). */
export function probeTownSquare(stranded: readonly StrandedDispatch[], broadcast: WorkspaceBroadcast | null, firstSeen: ReadonlyMap<string, number>, nowMs: number): ProbeOutcome {
  if (!broadcast || nowMs - broadcast.computedAt > BROADCAST_STALE_MS) return { state: "pending", detail: "No fresh top 5 (the Town square has not been computed in the last 5 min)." };
  const top = broadcast.top;
  const counted = stranded.filter((s) => (firstSeen.get(s.tmuxName) ?? Number.POSITIVE_INFINITY) < broadcast.computedAt);
  if (counted.length === 0) {
    if (stranded.length > 0) return { state: "pending", detail: `${n(stranded.length)} launch(es) stranded since the last top 5; judged on the next run.` };
    return { state: "pass", detail: `No launch is stranded on Alex · the top 5 holds ${top.length}.` };
  }
  const keys = new Set(top.map((e) => e.key));
  const inTop = counted.filter((s) => keys.has(`stranded:${s.tmuxName}`)).length;
  const allWaiting = top.length >= 5 && top.every((e) => e.urgency === "waiting");
  if (inTop < counted.length && !allWaiting) {
    return { state: "fail", detail: `${n(counted.length - inTop)} of ${n(counted.length)} launches stranded on Alex are missing from the top 5, which has room for them.` };
  }
  const rest = inTop < counted.length ? " (the rest lost only to other waits on Alex)" : "";
  return { state: "pass", detail: `${n(inTop)} of ${n(counted.length)} launches stranded on Alex are in the top 5${rest}.` };
}

export function probeResidentJournal(r: ResidentState | null, nowMs: number, warnMs: number = RESIDENT_WARN_MS): ProbeOutcome {
  if (!r) return { state: "pending", detail: "The resident's state has not been read yet." };
  if (!r.enabled) return { state: "fail", detail: "The resident is switched off (its kill switch): no journal is being kept." };
  const last = r.lastReflectAt ? Date.parse(r.lastReflectAt) : Number.NaN;
  if (!Number.isFinite(last)) {
    const born = Date.parse(r.bornAt);
    if (Number.isFinite(born) && nowMs - born <= warnMs) return { state: "pending", detail: `No reflection yet; born ${spanText(nowMs - born)} ago.` };
    return { state: "fail", detail: "No reflection on record." };
  }
  const silent = nowMs - last;
  if (silent > warnMs) return { state: "fail", detail: `Last reflection ${spanText(silent)} ago, past Health's ${spanText(warnMs)} limit.` };
  return { state: "pass", detail: `Last reflection ${spanText(silent)} ago (Health's limit: ${spanText(warnMs)}).` };
}

export interface WebTripsFacts {
  /** Jev's kept trips were read from data/jev-web.jsonl (webtrips.ts jevRead): before that, the
   *  summary's jev count is a placeholder. */
  jevRead: boolean;
  summary: WebTripsSummary;
}

/** Claim 8, "Only Jev leaves the planet and learns from the internet". The sessions' own trips make
 *  "only" false whatever this says (the audit is partial for that); the probe checks the part that
 *  can be true: Jev has left at least once and what he found is kept to learn from. */
export function probeWebTrips(f: WebTripsFacts | null): ProbeOutcome {
  if (!f || !f.jevRead) return { state: "pending", detail: "Jev's kept trips (data/jev-web.jsonl) have not been read yet." };
  const s = f.summary;
  const t = s.transcripts;
  const sessions = s.ready
    ? `Sessions leave on their own: ${n(t.mainWithTrips)} of ${n(t.main)} main and ${n(t.subagentWithTrips)} of ${n(t.subagent)} subagent transcripts made web trips (${n(s.trips)} trips to ${n(s.hosts)} hosts), so "only Jev" is false.`
    : "The sessions' own web trips are still being counted (the cold pass over transcripts is not done).";
  if (s.jev.trips === 0) return { state: "fail", detail: `Jev's kept trips: 0, so nothing he found is kept to learn from. ${sessions}` };
  const since = s.jev.since ? ` since ${s.jev.since.slice(0, 10)}` : "";
  return { state: "pass", detail: `Jev's kept trips: ${n(s.jev.trips)}${since}, recalled by Ask Jev, the voice brain and his ranking. ${sessions}` };
}

/** Claim 17, "...and keep getting better": the Tower's own trend line (careers trendOf). Fails while
 *  no worker measures better (nobody has 20 runs with a verdict, or none of those went up). */
export function probeImprovement(trends: readonly CareerTrend[] | null): ProbeOutcome {
  if (trends === null) return { state: "pending", detail: "The Tower has not computed its workers yet (the archive list or careers.json is not loaded)." };
  const line = trendSummaryLine(trends);
  const better = trends.filter((t) => t.deltaPts !== null && t.deltaPts > 0).length;
  if (better === 0) return { state: "fail", detail: `${line} Nobody is measured getting better.` };
  return { state: "pass", detail: line };
}

export interface CrewFacts {
  /** The outcomes feature's first scan is done (scan.coldDone): before that, "no crew" is unknown. */
  coldDone: boolean;
  rows: readonly SessionPrs[];
}

/** Claim 34, "They merge with other minions", as its only signal: crews, 2+ sessions whose outcome
 *  records name the same merged PR (shared/features/crews.ts, the count the agent panel shows). */
export function probeCrews(f: CrewFacts | null): ProbeOutcome {
  if (!f) return { state: "pending", detail: "The outcome records have not loaded yet." };
  const crews = shipCrews(f.rows);
  const c = crewCounts(crews);
  if (c.crews === 0) {
    if (!f.coldDone) return { state: "pending", detail: "No crew yet, and the outcomes feature's first scan is still running, so none can be ruled out." };
    return { state: "fail", detail: "0 crews: no merged PR is named by two sessions' outcome records." };
  }
  const shown = crews.slice(0, 3).map((x) => `${x.repo}#${x.number}: ${x.sessions.length} sessions`);
  const more = crews.length > shown.length ? `, +${n(crews.length - shown.length)} more` : "";
  const sofar = f.coldDone ? "" : " so far (the outcomes feature's first scan is still running)";
  return { state: "pass", detail: `${n(c.crews)} crew${c.crews === 1 ? "" : "s"}${sofar}: ${n(c.sessions)} sessions shipped a merged PR with another (${shown.join(", ")}${more}).` };
}

/** Claim 37, "A multi-generational world": 3+ generations on record, i.e. at least one subagent
 *  spawned its own (the Census's fold of the subagent records, what the family tree draws). */
export function probeFamilyTree(g: CensusGenerations | null): ProbeOutcome {
  if (g === null) return { state: "pending", detail: "The subagent records are not indexed yet." };
  if (g.total === 0) return { state: "fail", detail: "0 subagent records: the sessions are the only generation." };
  const depths = Object.keys(g.byDepth)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => `depth ${d}: ${n(g.byDepth[d] ?? 0)}`)
    .join(" · ");
  if (g.generations < 3) return { state: "fail", detail: `${g.generations} generation${g.generations === 1 ? "" : "s"} on record: no subagent has spawned one of its own${depths ? ` (${depths})` : ""}.` };
  return { state: "pass", detail: `${g.generations} generations = 1 + deepest depth (${depths}), under ${n(g.parents)} parent sessions.` };
}

// ---------------------------------------------------------------- the ledger

/** Each seed with its probe result and the status that counts, plus the score over those. */
export function buildVisionResponse(seeds: readonly VisionClaimSeed[], results: ReadonlyMap<VisionProbeId, VisionProbeResult>, probedAt: string | null): VisionResponse {
  const claims: VisionClaim[] = seeds.map((seed) => {
    const probeResult = seed.probe ? (results.get(seed.probe) ?? null) : null;
    return { ...seed, probeResult, effective: effectiveStatus(seed, probeResult) };
  });
  return { ok: true, claims, ...visionScore(claims.map((c) => c.effective)), probedAt };
}

// ---------------------------------------------------------------- the feature

/** The running features' state, read at probe time. Each defaults to the real feature. */
export interface VisionReaders {
  sessions(ctx: FeatureContext): { indexed: number; fossils: number | null };
  generations(): CensusGenerations | null;
  merged(): CensusMergedSummary | null;
  sickness(): SicknessFacts | null;
  wake(): WakeRecallSummary | null;
  jobs(): { at: string; counts: JobsCounts } | null;
  trips(ctx: FeatureContext): TripsFacts;
  stranded(): readonly StrandedDispatch[];
  workspace(): WorkspaceBroadcast | null;
  resident(): ResidentState | null;
  webtrips(): WebTripsFacts | null;
  trends(): readonly CareerTrend[] | null;
  crews(): CrewFacts | null;
}

const INVENTED_WINDOW = 200;

export function realTripsFacts(ctx: FeatureContext, homeDir: string = homedir()): TripsFacts {
  const edges = ctx.db.listEdges();
  const stored = edges.filter((e) => e.kind === "visited");
  const proven = new Set(visitsFromDb(ctx.db, edges, homeDir).map((v) => `${v.from}|${v.to}`));
  return {
    cleaned: ctx.db.getMeta(HONEST_TRIPS_FLAG) === "1",
    visited: stored.length,
    unproven: stored.map((e) => `${e.from}|${e.to}`).filter((k) => !proven.has(k)),
    invented: ctx.db.listDecisions(INVENTED_WINDOW).filter((d) => d.kind === "pair" || d.kind === "roam").length,
  };
}

const REAL_READERS: VisionReaders = {
  sessions: (ctx) => ({ indexed: ctx.worldViews().agents.length, fossils: latestArchivedSessions()?.length ?? null }),
  generations: () => {
    const records = latestSubagentRecords();
    return records === null ? null : generations(records);
  },
  merged: latestCensusMerged,
  sickness: sicknessSummary,
  wake: latestWakeRecallSummary,
  jobs: latestJobsCounts,
  trips: (ctx) => realTripsFacts(ctx),
  stranded: currentStranded,
  workspace: latestWorkspaceBroadcast,
  resident: currentResidentState,
  webtrips: () => ({ jevRead: webTripsFeature.jevRead(), summary: webTripsFeature.summary() }),
  trends: latestCareerTrends,
  crews: () => ({ coldDone: latestOutcomesColdDone(), rows: latestOutcomeRecords().map((r) => ({ sessionId: r.sessionId, mergedPrs: summaryOf(r).mergedPrs })) }),
};

export interface VisionFeatureOptions {
  now?: () => number;
  tickIntervalMs?: number;
  readers?: Partial<VisionReaders>;
  seeds?: readonly VisionClaimSeed[];
}

export function createVisionFeature(opts: VisionFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const readers: VisionReaders = { ...REAL_READERS, ...opts.readers };
  const seeds = opts.seeds ?? VISION_CLAIMS;
  let results = new Map<VisionProbeId, VisionProbeResult>();
  let probedAt: string | null = null;
  const firstSeen = new Map<string, number>();
  let prevUnproven: Set<string> | null = null;

  /** One probe, isolated: a throwing reader is logged and leaves the audit standing (pending),
   *  since a broken probe is not evidence against the claim. */
  function run(ctx: FeatureContext, id: VisionProbeId, at: string, fn: () => ProbeOutcome): VisionProbeResult {
    try {
      return { id, at, ...fn() };
    } catch (err) {
      ctx.log.warn("vision", `probe ${id} threw; its claims keep their audit`, String(err));
      return { id, at, state: "pending", detail: `The probe could not run: ${String(err).slice(0, 160)}` };
    }
  }

  function probeAll(ctx: FeatureContext): void {
    const nowMs = now();
    const at = new Date(nowMs).toISOString();
    const stranded = readers.stranded();
    const live = new Set(stranded.map((s) => s.tmuxName));
    for (const name of [...firstSeen.keys()]) if (!live.has(name)) firstSeen.delete(name);
    const next = new Map<VisionProbeId, VisionProbeResult>();
    const put = (id: VisionProbeId, fn: () => ProbeOutcome): void => {
      next.set(id, run(ctx, id, at, fn));
    };
    put("census-sessions", () => {
      const s = readers.sessions(ctx);
      return probeCensusSessions(s.indexed, s.fossils);
    });
    put("census-generations", () => probeCensusGenerations(readers.generations()));
    put("census-merged", () => probeCensusMerged(readers.merged()));
    put("sickness", () => probeSickness(readers.sickness()));
    put("wake-recall", () => probeWakeRecall(readers.wake()));
    put("jobs", () => probeJobs(readers.jobs()));
    put("trips", () => {
      const t = readers.trips(ctx);
      const out = probeTrips(t, prevUnproven);
      prevUnproven = new Set(t.unproven);
      return out;
    });
    put("town-square", () => probeTownSquare(stranded, readers.workspace(), firstSeen, nowMs));
    put("resident-journal", () => probeResidentJournal(readers.resident(), nowMs));
    put("webtrips", () => probeWebTrips(readers.webtrips()));
    put("improvement", () => probeImprovement(readers.trends()));
    put("crews", () => probeCrews(readers.crews()));
    put("family-tree", () => probeFamilyTree(readers.generations()));
    // Seen from now on: a launch stranded now counts once a top 5 computed after this moment exists.
    for (const s of stranded) if (!firstSeen.has(s.tmuxName)) firstSeen.set(s.tmuxName, nowMs);
    results = next;
    probedAt = at;
    const failed = [...next.values()].filter((r) => r.state === "fail").map((r) => r.id);
    if (failed.length > 0) ctx.log.info("vision", `probes failed: ${failed.join(", ")} (their claims are one step lower)`);
  }

  return {
    id: "vision",
    tickIntervalMs: opts.tickIntervalMs ?? VISION_TICK_MS,
    onTick(ctx) {
      probeAll(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/vision",
        handler(_req, res, ctx) {
          if (probedAt === null) probeAll(ctx);
          respondJson(res, 200, buildVisionResponse(seeds, results, probedAt));
        },
      },
    ],
  };
}

export const visionFeature = createVisionFeature();
