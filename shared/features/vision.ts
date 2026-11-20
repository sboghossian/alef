// Wire types + data for the "vision" feature: the vision ledger. Alex's vision post (2026-09-28)
// makes 42 claims; this file holds each one as DATA, seeded from the vision plan's truth table
// (~/.alef-loop/vision-plan.json), re-audited against main after waves 1-3 merged, and again after
// every vision job merged (docs-truth, 2026-09-29). The server
// (server/features/vision.ts) re-checks what code can check with probes; a failed probe downgrades
// its claim one step. The percentage is computed here, never typed in, and always goes out with
// its formula.
//
//   GET /api/vision -> VisionResponse
//
// Statuses (the audit rule, applied to every row):
//   real      true today, as the post says it, or with the corrected number or wording its
//             evidence line states (Alef computes the true number: "2,049", not "2,051")
//   partial   true for only part of what the line says
//   missing   not built, or no signal (what the plan called "theatre" lands here too)
//   metaphor  a figure of speech with no possible signal: listed, never scored, never a number
//
// pct       = (real + 0.5 x partial) / non-metaphor claims
// strictPct = real / non-metaphor claims

export type VisionStatus = "real" | "partial" | "missing" | "metaphor";
export const VISION_STATUSES: readonly VisionStatus[] = ["real", "partial", "missing", "metaphor"];

/** What code can re-check (server/features/vision.ts runs each one). */
export type VisionProbeId =
  | "census-sessions"
  | "census-generations"
  | "census-merged"
  | "sickness"
  | "wake-recall"
  | "jobs"
  | "trips"
  | "town-square"
  | "resident-journal"
  | "webtrips"
  | "improvement"
  | "crews"
  | "family-tree";
export const VISION_PROBE_IDS: readonly VisionProbeId[] = [
  "census-sessions",
  "census-generations",
  "census-merged",
  "sickness",
  "wake-recall",
  "jobs",
  "trips",
  "town-square",
  "resident-journal",
  "webtrips",
  "improvement",
  "crews",
  "family-tree",
];

export interface VisionClaimSeed {
  /** The truth table's row number (1-42). */
  n: number;
  /** The post's line (the plan's short form). Quoted, never scored when a metaphor. */
  text: string;
  /** The audited status. A probe can only lower it, never raise it. */
  status: VisionStatus;
  /** One line: why the status is what it is, with its source. */
  evidence: string;
  probe: VisionProbeId | null;
  /** YYYY-MM-DD */
  auditedAt: string;
  auditedBy: string;
  /** Set when the piece that would make it real is not merged yet: what it waits on. */
  notYet?: string;
}

export type VisionProbeState = "pass" | "fail" | "pending";

export interface VisionProbeResult {
  id: VisionProbeId;
  /** pass = the claim keeps its audited status; fail = one step down; pending = the source isn't
   *  ready (not indexed / not fetched yet): the audit stands, and the row says so. */
  state: VisionProbeState;
  /** One line, the measured numbers with their formula. */
  detail: string;
  /** ISO time the probe ran. */
  at: string;
}

export interface VisionClaim extends VisionClaimSeed {
  /** The status that counts: the audited one, one step lower when its probe failed. */
  effective: VisionStatus;
  probeResult: VisionProbeResult | null;
}

export interface VisionCounts {
  real: number;
  partial: number;
  missing: number;
  metaphor: number;
  /** Non-metaphor claims: the denominator. */
  scored: number;
}

export interface VisionScore {
  counts: VisionCounts;
  /** Percent, one decimal; null when nothing is scored (never a fabricated 0). */
  pct: number | null;
  strictPct: number | null;
  formula: string;
  strictFormula: string;
}

export interface VisionResponse extends VisionScore {
  ok: true;
  claims: VisionClaim[];
  /** ISO of the last probe run; null before the first. */
  probedAt: string | null;
}

// ---------------------------------------------------------------- the rules

/** A failed probe lowers its claim one step; a metaphor is never touched. */
export function downgrade(s: VisionStatus): VisionStatus {
  if (s === "real") return "partial";
  if (s === "partial") return "missing";
  return s;
}

export function effectiveStatus(seed: VisionClaimSeed, result: VisionProbeResult | null): VisionStatus {
  if (seed.status === "metaphor" || seed.probe === null || !result || result.id !== seed.probe) return seed.status;
  return result.state === "fail" ? downgrade(seed.status) : seed.status;
}

function pct1(num: number, den: number): number {
  return Math.round((num / den) * 1000) / 10;
}

/** The ledger's percentage, from the statuses that count, with its formula spelled out. */
export function visionScore(statuses: readonly VisionStatus[]): VisionScore {
  const counts: VisionCounts = { real: 0, partial: 0, missing: 0, metaphor: 0, scored: 0 };
  for (const s of statuses) counts[s] += 1;
  counts.scored = counts.real + counts.partial + counts.missing;
  const { real, partial, scored } = counts;
  if (scored === 0) {
    return {
      counts,
      pct: null,
      strictPct: null,
      formula: "pct = (real + 0.5 × partial) / non-metaphor claims: no claim is scored",
      strictFormula: "strict = real / non-metaphor claims: no claim is scored",
    };
  }
  const pct = pct1(real + 0.5 * partial, scored);
  const strictPct = pct1(real, scored);
  return {
    counts,
    pct,
    strictPct,
    formula: `pct = (real + 0.5 × partial) / non-metaphor claims = (${real} + 0.5 × ${partial}) / ${scored} = ${pct.toFixed(1)}%`,
    strictFormula: `strict = real / non-metaphor claims = ${real} / ${scored} = ${strictPct.toFixed(1)}%`,
  };
}

// ---------------------------------------------------------------- the ledger

const AUDITED_AT = "2026-09-29";
const AUDITED_BY = "docs-truth re-audit (Claude Opus 5.5): every row re-checked against main at 0d16c7f and live GETs on :5179 at 06:06-06:18Z";

function c(n: number, status: VisionStatus, text: string, evidence: string, probe: VisionProbeId | null = null, notYet?: string): VisionClaimSeed {
  return { n, text, status, evidence, probe, auditedAt: AUDITED_AT, auditedBy: AUDITED_BY, ...(notYet ? { notYet } : {}) };
}

/** The post's claims, in the truth table's order. Change a status only with evidence, and say so
 *  in the PR; a probe keeps a probe-backed row honest between audits. */
export const VISION_CLAIMS: readonly VisionClaimSeed[] = [
  c(1, "real", "One screen for everything, on my own Mac", "Alef serves the world on localhost (client :5178, API :5179), and 🏠 Home is the default first view (#71): the prompt box, what happened today / this week / this month, automations, what needs you, the live feed and Jev's decisions on one page."),
  c(2, "real", "Every project is a city on a cartoon planet", "34 islands (canonical repos plus topic continents, GET /api/world 06:12Z). Literal wording: every repo is a city; vault-only projects are fossil fields, not cities."),
  c(3, "real", "Every agent session is a house", "One house per indexed session (GET /api/world agents); pruned sessions are fossils.", "census-sessions"),
  c(4, "real", "2,051 sessions have lived there", "The Census computes it: indexed sessions + vault fossils, 0 overlap (#46). The post's 2,051 was 2,049 on 09-28 at 03:21Z; it drifts as sessions are pruned and exported, and the probe line has today's.", "census-sessions"),
  c(5, "real", "The finished ones stay behind as fossils", "Ended sessions keep a verdict (#45) and retired ones a legacy card (#59); a pruned transcript leaves a fossil. Reworded: a fossil is a pruned session, not a finished one."),
  c(6, "real", "Jev is the president", "president.ts: Jev ranks the board (source \"jev\" in GET /api/president/proposals, 06:05Z)."),
  c(7, "partial", "Reads health, open loops, quiet districts and decides what to improve next", "Jev ranks treatments for sick lineages, tripwire drafts and graduation actions every 30 min (#54, #61), and the loop can ask scripts/president-pick.ts (#63). 0 of the last 10 merges came from a Jev pick (Census, 06:08Z): the vision jobs were pre-planned. Jev's board held 0 proposals at 06:05Z."),
  c(8, "partial", "Only Jev leaves the planet and learns from the internet", "False as worded: Jev is not the only one who leaves. What is built: Alef itself sends only Jev out (Ask Jev → Search the web, one click per search, #72), and each search is kept in data/jev-web.jsonl and recalled by Ask Jev, the voice brain and Jev's ranking. But the sessions browse on their own: the webtrips cold pass at 06:16Z counted 108 of 236 main and 286 of 1,246 subagent transcripts with web trips (6,819 trips to 1,149 hosts), against 0 kept trips for Jev. The probe re-counts both.", "webtrips"),
  c(9, "partial", "Every decision goes out on a live feed the whole town can see", "President, resident, council and merge decisions reach the Feed as persisted governance items (#62), and Home shows the live feed and \"Jev decided lately\" (#71). Sessions never read the feed: the audience is Alex's UI, the Logs tab, and Jev and the resident through the Town square's top 5 (#64)."),
  c(10, "real", "One resident in a sandbox on $0.50 a day", "Daily cap $0.50 with spend tracked per day (GET /api/resident: $0.09 of $0.50 at 06:10Z); its models get no tools; every write goes through the path-whitelisted sandbox."),
  c(11, "real", "...keeps a journal of what happened", "The withdraw-id bug is fixed (#43) and Health warns when the resident goes silent (#65).", "resident-journal"),
  c(12, "partial", "A council of models reviews big calls, then builders work", "20 council runs, all on 09-25 (GET /api/council/history, 06:10Z). The loop's scripts/council-round.ts (#63) has not run since: the vision jobs were pre-planned and skip it, so 0 of the last 10 merges are council-linked (Census, 06:08Z)."),
  c(13, "partial", "Nothing merges without passing review", "Every change comes in through a PR, and the Census reads the review recorded on each merged SHA (#46, #63): 7 of 72 merged PRs have one (06:08Z). Nothing enforces it: branch protection answers 403 on this plan (GET, 06:18Z), and the enforcing hook is Alex's to install."),
  c(14, "real", "Already merged 32 upgrades into itself", "The Census counts merged PRs from gh pr list (#46): 72 at 06:08Z. The post's 32 was 37 on 09-28 at 03:30Z.", "census-merged"),
  c(15, "partial", "Every minion has a job: learner, gatherer, builder, hacker, lawyer", "Five jobs from a deterministic classifier, each with its reason (#52), but not every minion has one: the probe line counts them.", "jobs"),
  c(16, "partial", "They go to school, graduate, get hired", "School truth (#37), the Tower (#53), graduation badges (#57) and commencement proposals (#61) are built. The study pipeline behind the School still fails (151 of 162 study runs failed, no new draft since 2026-05-24: GET /api/skills/snapshot, 06:10Z; the pipeline is outside agent-world), and 0 of 28 workers are trusted (GET /api/careers, 06:10Z), so nobody has been hired."),
  c(17, "partial", "...and keep getting better", "The Tower measures each worker's clean rate, its last 10 runs with a verdict against the 10 before (#69); the School counts SKILL.md revisions (42 commits over 27 skills in 30 days at 06:10Z), but a revision is not proof of a fix. Only the Tower's trend can say \"better\", so the probe fails while no worker measures better.", "improvement"),
  c(18, "partial", "Between shifts they roam the towns and common areas", "The theatre is gone (#47): a plane flies only when a live session edits another district's files, and every road is proven by touched files. Nobody roams \"between shifts\": dormant sessions stay home.", "trips"),
  c(19, "real", "Build together and socialize", "Neighbours (#49): sessions that share files, work the same repo in the same hours, or message each other."),
  c(20, "real", "The Institute of Truth is the second brain", "The Institute of Truth (#51): vault, memory and recall as one named place with live numbers; the School stays the skills study. Alef's own voice reads it too (#38): memory, vault notes, sessions and folders, behind the credential scanner."),
  c(21, "partial", "Every minion reads from it the moment it wakes up", "Most main sessions got vault notes at SessionStart, but headless runs are most of the misses (38 of the 41 that woke with nothing at 06:10Z) and subagents get only the MEMORY.md index. Full coverage needs ~/.claude hooks (Alex's call). The voice brain's reads (#38) are Alef's, not the minions'.", "wake-recall"),
  c(22, "partial", "Consciousness research shapes how the town thinks", "The Town square's top 5 is broadcast into Jev's and the resident's prompts (#64). Influence, last 24 h (GET /api/workspace/influence, 06:10Z): 2 of 10 resident reflections were about an entry they were shown (keyword matches only, and a match is not a cause); Jev's model-ranked proposals have no record yet, and the rules baseline is 0 of 5."),
  c(23, "real", "Town square shows the 5 things that matter most (GWT)", "The top 5 is real news (#44), scored on the server (#64); launches waiting on Alex rank first.", "town-square"),
  c(24, "real", "Repeat a learned mistake and a tripwire goes off", "12 tripwire rules; hits persist in data/tripwires.jsonl (#65); coverage 120 lessons written, 12 guarded (GET /api/tripwires, 06:10Z)."),
  c(25, "real", "Minions get sick", "Sickness detectors (#48), the Clinic (#50) and its building on the planet (#68).", "sickness"),
  c(26, "partial", "Leak a key, break a build, or wander onto a fake website, and you're sick", "Leaked keys and broken builds are detected (#48). The steering-page detector (reworded: exposed to a page that tries to steer agents) is withheld: its precision is below the bar.", "sickness"),
  c(27, "partial", "Doctors examine, research new diseases, review and ship the fix", "The Clinic examines, a Doctor prefills a fix dispatch (#50), and the Clinic building and a light on each sick house show it on the planet (#68); Jev ranks treat proposals and researches new tripwires (#54). Nothing closes a case by the PR that fixed it: only a manual \"Mark treated\" (0 treated at 06:10Z)."),
  c(28, "metaphor", "Unlimited insurance", "No signal. The honest version: every retire can be undone and every migration keeps a db backup."),
  c(29, "real", "A house to chill in", "Dormant sessions sleep in their houses (291 of 299 at 06:12Z)."),
  c(30, "real", "Friends to visit, trips to take", "Real co-workers (neighbours, #49) and real cross-district trips (#47).", "trips"),
  c(31, "real", "They sleep", "Sleeping = no running process (live detection by ps + lsof)."),
  c(32, "partial", "Keep routines", "The Tower tracks 28 automation lineages as workers (#53), 22 of them lapsed (GET /api/careers, 06:10Z). Sessions keep no routines."),
  c(33, "partial", "Improve themselves in a safe sandbox the president doesn't watch", "Only the resident has a sandbox (path whitelist, audited writes), and it has written 0 skills (GET /api/resident, 06:10Z). An unwatched sandbox with tools for every session is not something Alef should add."),
  c(34, "partial", "They merge with other minions", "Reworded to its only signal: crews, 2+ sessions whose outcome records name the same merged PR (#67). No transcript was found to continue another session (0 of 204 on 09-28), and a subagent handing back its result is family, not a merge, so beyond crews \"merge\" stays a metaphor. The probe counts the crews.", "crews"),
  c(35, "real", "...and have sub-minions", "Subagent records with their parent session (subagents.db).", "census-generations"),
  c(36, "real", "950 have been born", "The Census counts sub-minions with their window (#46). The post's 950 was 1,106 on 09-28 at 03:21Z, counted since 2026-09-07.", "census-generations"),
  c(37, "real", "A multi-generational world", "The Census shows the generations (sessions → children → grandchildren), and each drone's panel draws its family tree (#67). The probe checks that a third generation is on record.", "family-tree"),
  c(38, "real", "The world was built to evolve, and it does", "One Feed item per merge, sent by the server (#62) from the Census's merged list (#46).", "census-merged"),
  c(39, "real", "About 40% of this runs today", "This ledger computes it: GET /api/vision, with its formula. Read the computed pct, not the post's 40%."),
  c(40, "metaphor", "26 iterations later", "No registered count behind it. Never shown as a number."),
  c(41, "metaphor", "Type II civilization, 13%", "No signal behind it. Never shown as a number."),
  c(42, "metaphor", "Feed built for the 0.2%, post for the 99.8%", "No signal behind it. Never shown as a number."),
];

// ---------------------------------------------------------------- validation (untrusted wire)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStatus(v: unknown): v is VisionStatus {
  return typeof v === "string" && (VISION_STATUSES as readonly string[]).includes(v);
}

function isProbeId(v: unknown): v is VisionProbeId {
  return typeof v === "string" && (VISION_PROBE_IDS as readonly string[]).includes(v);
}

function isProbeResult(v: unknown): v is VisionProbeResult {
  if (!isRecord(v)) return false;
  return isProbeId(v.id) && (v.state === "pass" || v.state === "fail" || v.state === "pending") && typeof v.detail === "string" && typeof v.at === "string";
}

export function isVisionClaim(v: unknown): v is VisionClaim {
  if (!isRecord(v)) return false;
  return (
    typeof v.n === "number" &&
    typeof v.text === "string" &&
    isStatus(v.status) &&
    isStatus(v.effective) &&
    typeof v.evidence === "string" &&
    (v.probe === null || isProbeId(v.probe)) &&
    typeof v.auditedAt === "string" &&
    typeof v.auditedBy === "string" &&
    (v.notYet === undefined || typeof v.notYet === "string") &&
    (v.probeResult === null || isProbeResult(v.probeResult))
  );
}

function isCounts(v: unknown): v is VisionCounts {
  if (!isRecord(v)) return false;
  return ["real", "partial", "missing", "metaphor", "scored"].every((k) => typeof v[k] === "number");
}

export function parseVisionResponse(v: unknown): VisionResponse | null {
  if (!isRecord(v) || v.ok !== true) return null;
  if (!Array.isArray(v.claims) || !v.claims.every(isVisionClaim)) return null;
  if (!isCounts(v.counts)) return null;
  if (v.pct !== null && typeof v.pct !== "number") return null;
  if (v.strictPct !== null && typeof v.strictPct !== "number") return null;
  if (typeof v.formula !== "string" || typeof v.strictFormula !== "string") return null;
  if (v.probedAt !== null && typeof v.probedAt !== "string") return null;
  return {
    ok: true,
    claims: v.claims,
    counts: v.counts,
    pct: v.pct as number | null,
    strictPct: v.strictPct as number | null,
    formula: v.formula,
    strictFormula: v.strictFormula,
    probedAt: v.probedAt as string | null,
  };
}
