// The vision ledger: the post's claims as data, re-checked by probes.
//   - the formula: pct = (real + 0.5 x partial) / non-metaphor claims, strict = real / same, with
//     the formula string carrying the very numbers it was computed from;
//   - metaphors are listed, never scored, never probed, never given a number;
//   - a failed probe lowers its claim one step (never more, never a raise); pending keeps the audit;
//   - the stateful probes (town square, trips) start from EXISTING state: a launch already stranded
//     and a top 5 already published, a legacy world.db that still holds invented visits.
// Never the real data/, ~/.claude or the live server: stub readers and temp dbs only.

import type { IncomingMessage, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trendSummaryLine, type CareerTrend } from "../../shared/features/careers.js";
import type { CensusMergedSummary } from "../../shared/features/census.js";
import type { SessionPrs } from "../../shared/features/crews.js";
import type { WebTripsSummary } from "../../shared/features/webtrips.js";
import type { JobsCounts } from "../../shared/features/jobs.js";
import type { ResidentState } from "../../shared/features/resident.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import { generations } from "../features/census-lib.js";
import type { StrandedDispatch } from "../../shared/features/talk.js";
import {
  downgrade,
  effectiveStatus,
  parseVisionResponse,
  VISION_CLAIMS,
  visionScore,
  type VisionClaimSeed,
  type VisionProbeId,
  type VisionProbeResult,
  type VisionResponse,
  type VisionStatus,
} from "../../shared/features/vision.js";
import type { WakeRecallSummary } from "../../shared/features/wake-recall.js";
import type { JevDecision } from "../../shared/types.js";
import type { WorkspaceEntry } from "../../shared/workspace/scorer.js";
import { openDb, WorldDb } from "../db.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import {
  buildVisionResponse,
  createVisionFeature,
  probeCensusGenerations,
  probeCensusMerged,
  probeCensusSessions,
  probeCrews,
  probeFamilyTree,
  probeImprovement,
  probeJobs,
  probeResidentJournal,
  probeSickness,
  probeTownSquare,
  probeTrips,
  probeWakeRecall,
  probeWebTrips,
  realTripsFacts,
  RESIDENT_WARN_MS,
  type SicknessFacts,
  type TripsFacts,
  type VisionReaders,
} from "../features/vision.js";
import type { WorkspaceBroadcast } from "../features/workspace-state.js";
import { runHonestTripsMigration } from "../trips-migration.js";
import { makeTempProjectsDir } from "./helpers.js";

const MIN = 60_000;
const T0 = Date.parse("2026-09-28T13:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- fixtures

function merged(over: Partial<CensusMergedSummary> = {}): CensusMergedSummary {
  return { total: 64, reviewRecorded: 0, loopMarked: 0, recent: [], fetchedAt: iso(T0 - 5 * MIN), repo: "sboghossian/agent-world", error: null, ...over };
}

function sub(id: string, depth: number, parent = "p1"): SubagentRecord {
  return { id, parentSessionId: parent, depth, startedAt: "2026-09-07T02:16:25.243Z" } as unknown as SubagentRecord;
}

function sickness(over: Partial<SicknessFacts> = {}): SicknessFacts {
  return {
    counts: {
      total: 272,
      byKind: { "leaked-key": 23, "broken-build": 249, "steering-page": 0 },
      byState: { open: 23, healed: 208, chronic: 41, exposed: 0, treated: 0 },
      byLineage: {},
    },
    scan: { filesDone: 214, filesTotal: 214, bytesDone: 1, bytesTotal: 1, finishedAt: "2026-09-28T05:11:45.594Z", linesSkipped: 0 },
    disabledKinds: ["steering-page"],
    ...over,
  };
}

function wake(over: Partial<WakeRecallSummary["totals"]> = {}, ready = true): WakeRecallSummary {
  return {
    ready,
    vaultNotes: 31404,
    totals: {
      sessions: 214,
      fed: 168,
      nothing: 37,
      unread: 9,
      pending: 0,
      headlessMisses: 35,
      reasons: {} as WakeRecallSummary["totals"]["reasons"],
      notes: 0,
      promptRecalls: 0,
      promptRecallSessions: 0,
      today: { sessions: 0, fed: 0, nothing: 0 },
      ...over,
    },
  };
}

function jobs(sessions: Partial<JobsCounts["sessions"]> = {}): { at: string; counts: JobsCounts } {
  return {
    at: iso(T0),
    counts: {
      sessions: { lawyer: 15, hacker: 0, learner: 38, builder: 125, gatherer: 27, none: 72, ...sessions },
      subagents: { lawyer: 151, hacker: 258, learner: 15, builder: 537, gatherer: 223, none: 125 },
    },
  };
}

function stranded(tmuxName: string): StrandedDispatch {
  return { tmuxName, cwd: "/ws/a", startedAt: iso(T0 - 60 * MIN), blockedOn: "trust", closable: false, promptHead: "Open PR", lastLine: null };
}

function entry(key: string, urgency: WorkspaceEntry["urgency"] = "info"): WorkspaceEntry {
  return { key, urgency, origin: "x", text: key, at: T0, score: 50, held: false, since: T0, occurrences: 1, districts: [], agentIds: [], reason: "r" };
}

function broadcast(computedAt: number, top: WorkspaceEntry[]): WorkspaceBroadcast {
  return { computedAt, top };
}

function resident(over: Partial<ResidentState> = {}): ResidentState {
  return { enabled: true, bornAt: "2026-09-26T15:48:45.059Z", lastReflectAt: iso(T0 - 30 * MIN), lastError: null, ...over } as unknown as ResidentState;
}

const TRIPS_OK: TripsFacts = { cleaned: true, visited: 80, unproven: [], invented: 0 };

/** The webtrips cold pass as it ended live on 2026-09-29 at 06:16Z, with `jev` kept trips. */
function webSummary(jevTrips: number, ready = true): WebTripsSummary {
  return {
    ready,
    transcripts: { main: 236, mainWithTrips: 108, subagent: 1246, subagentWithTrips: 286 },
    sessionsWithTrips: 113,
    trips: 6819,
    byTool: { WebSearch: 2209, WebFetch: 1427, exa: 362, obscura: 112, curl: 2709 },
    hosts: 1149,
    topHosts: [],
    jev: jevTrips === 0 ? { trips: 0, since: null, last: null } : { trips: jevTrips, since: "2026-09-29T10:00:00.000Z", last: "2026-09-29T11:00:00.000Z" },
  };
}

function trend(key: string, recentClean: number | null, priorClean = 5): CareerTrend {
  const full = (clean: number) => ({ runs: 10, clean, from: "2026-09-15T05:10:00.000Z", to: "2026-09-21T05:10:00.000Z" });
  if (recentClean === null) return { key, verdictRuns: 3, recent: { runs: 3, clean: 3, from: "2026-09-27T05:00:00.000Z", to: "2026-09-29T05:00:00.000Z" }, prior: { runs: 0, clean: 0, from: null, to: null }, deltaPts: null };
  return { key, verdictRuns: 20, recent: full(recentClean), prior: full(priorClean), deltaPts: (recentClean - priorClean) * 10 };
}

const pr = (repo: string, number: number, mergedAt: string | null = "2026-09-28T16:00:00Z") => ({ repo, number, mergedAt });

/** Two crews as GET /api/outcomes had them live on 2026-09-29 at 06:10Z (session ids made up). */
const CREW_ROWS: SessionPrs[] = [
  { sessionId: "s-a", mergedPrs: [pr("acme-inc/acme-ai", 460, "2026-09-27T10:00:00Z")] },
  { sessionId: "s-b", mergedPrs: [pr("acme-inc/acme-ai", 460, "2026-09-27T10:00:00Z"), pr("acme-inc/acme-ai", 461)] },
  { sessionId: "s-c", mergedPrs: [pr("ACME-Inc/acme-ai", 460, "2026-09-27T10:00:00Z")] },
  { sessionId: "s-d", mergedPrs: [pr("sboghossian/commandline", 21, "2026-09-20T10:00:00Z")] },
  { sessionId: "s-e", mergedPrs: [pr("sboghossian/commandline", 21, "2026-09-20T10:00:00Z")] },
  { sessionId: "s-f", mergedPrs: [] },
];

/** Every reader answering so that every probe passes. */
function healthyReaders(): VisionReaders {
  return {
    sessions: () => ({ indexed: 277, fossils: 1743 }),
    generations: () => generations([sub("s1", 1), sub("s2", 1), sub("s3", 2)]),
    merged: () => merged(),
    sickness: () => sickness(),
    wake: () => wake(),
    jobs: () => jobs(),
    trips: () => TRIPS_OK,
    stranded: () => [],
    workspace: () => broadcast(T0 - MIN, [entry("a")]),
    resident: () => resident(),
    webtrips: () => ({ jevRead: true, summary: webSummary(2) }),
    trends: () => [trend("/daily-recap", 7), trend("/upskill", null)],
    crews: () => ({ coldDone: true, rows: CREW_ROWS }),
  };
}

function fakeCtx(): { ctx: FeatureContext; warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => {};
  const ctx = {
    featureId: "vision",
    log: { info: noop, warn: (_s: string, m: string) => warnings.push(m), error: noop, debug: noop },
  } as unknown as FeatureContext;
  return { ctx, warnings };
}

async function getVision(feature: ServerFeature, ctx: FeatureContext): Promise<VisionResponse> {
  const route = feature.routes?.find((r) => r.path === "/api/vision");
  if (!route) throw new Error("no /api/vision route");
  let body = "";
  let status = 0;
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
    end: (b?: string) => {
      body = b ?? "";
    },
  };
  await route.handler({} as IncomingMessage, res as unknown as ServerResponse, ctx, {});
  expect(status).toBe(200);
  const parsed = parseVisionResponse(JSON.parse(body));
  if (!parsed) throw new Error(`unparseable /api/vision body: ${body.slice(0, 200)}`);
  return parsed;
}

const byN = (r: VisionResponse, n: number) => {
  const c = r.claims.find((x) => x.n === n);
  if (!c) throw new Error(`no claim ${n}`);
  return c;
};

// ---------------------------------------------------------------- the formula

describe("visionScore: the formula", () => {
  it("pct = (real + 0.5 x partial) / non-metaphor claims, strict = real / non-metaphor, formula carries the numbers", () => {
    const s = visionScore(["real", "real", "partial", "missing", "metaphor"]);
    expect(s.counts).toEqual({ real: 2, partial: 1, missing: 1, metaphor: 1, scored: 4 });
    expect(s.pct).toBe(62.5);
    expect(s.strictPct).toBe(50);
    expect(s.formula).toBe("pct = (real + 0.5 × partial) / non-metaphor claims = (2 + 0.5 × 1) / 4 = 62.5%");
    expect(s.strictFormula).toBe("strict = real / non-metaphor claims = 2 / 4 = 50.0%");
  });

  it("rounds to one decimal the same way in the number and the formula", () => {
    const s = visionScore(["real", "partial", "missing"]);
    expect(s.pct).toBe(50);
    expect(s.strictPct).toBe(33.3);
    expect(s.strictFormula.endsWith("= 1 / 3 = 33.3%")).toBe(true);
  });

  it("nothing scored is null with a formula that says so, never a fabricated 0%", () => {
    const s = visionScore(["metaphor", "metaphor"]);
    expect(s.pct).toBeNull();
    expect(s.strictPct).toBeNull();
    expect(s.formula).toContain("no claim is scored");
  });
});

describe("metaphors are excluded from the denominator", () => {
  it("adding metaphors never moves pct or strict", () => {
    const base = visionScore(["real", "partial", "missing"]);
    const withMetaphors = visionScore(["real", "partial", "missing", "metaphor", "metaphor", "metaphor", "metaphor"]);
    expect(withMetaphors.pct).toBe(base.pct);
    expect(withMetaphors.strictPct).toBe(base.strictPct);
    expect(withMetaphors.counts.scored).toBe(3);
  });

  it("the post's 13%, 26 iterations and 0.2% / 99.8% lines (and insurance) are metaphors: no probe, no number", () => {
    const metaphors = VISION_CLAIMS.filter((c) => c.status === "metaphor");
    expect(metaphors.map((c) => c.n).sort((a, b) => a - b)).toEqual([28, 40, 41, 42]);
    expect(metaphors.map((c) => c.text).join(" | ")).toMatch(/26 iterations.*13%.*0\.2%/s);
    for (const m of metaphors) {
      expect(m.probe).toBeNull();
      expect(m.evidence).not.toMatch(/\d/); // the ledger never gives them a number of its own
    }
  });

  it("a failed probe never touches a metaphor", () => {
    const seed: VisionClaimSeed = { n: 99, text: "x", status: "metaphor", evidence: "", probe: "jobs", auditedAt: "2026-09-28", auditedBy: "t" };
    expect(effectiveStatus(seed, { id: "jobs", state: "fail", detail: "", at: iso(T0) })).toBe("metaphor");
  });
});

// ---------------------------------------------------------------- the ledger as audited

describe("VISION_CLAIMS", () => {
  it("holds the truth table's 42 rows once each, every one audited with a date and an author", () => {
    expect(VISION_CLAIMS.map((c) => c.n)).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
    for (const c of VISION_CLAIMS) {
      expect(c.auditedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.auditedBy.length).toBeGreaterThan(0);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });

  it("the audit (docs-truth, 2026-09-29): 22 real, 16 partial, 0 missing, 4 metaphors -> 78.9% (strict 57.9%) while every probe passes", () => {
    const s = visionScore(VISION_CLAIMS.map((c) => c.status));
    expect(s.counts).toEqual({ real: 22, partial: 16, missing: 0, metaphor: 4, scored: 38 });
    expect(s.pct).toBe(78.9);
    expect(s.strictPct).toBe(57.9);
  });

  it("off-planet is partial, false as worded (sessions leave too); 17, 34 and 37 carry live probes, and nothing waits on an unmerged piece", () => {
    const byClaim = (n: number) => VISION_CLAIMS.find((c) => c.n === n);
    expect(byClaim(8)?.status).toBe("partial");
    expect(byClaim(8)?.probe).toBe("webtrips");
    expect(byClaim(8)?.evidence).toMatch(/^False as worded: Jev is not the only one who leaves\./);
    expect(byClaim(17)?.probe).toBe("improvement");
    expect(byClaim(34)?.probe).toBe("crews");
    expect(byClaim(34)?.status).toBe("partial"); // crews are a reword: merging itself stays a metaphor
    expect(byClaim(37)?.probe).toBe("family-tree");
    for (const c of VISION_CLAIMS) expect(c.notYet).toBeUndefined();
  });

  it("with the live signals of 2026-09-29 06:16Z (Jev kept 0 trips, no worker measured better) the ledger reads 76.3% (strict 57.9%)", () => {
    const at = iso(T0);
    const pass = (id: VisionProbeId): VisionProbeResult => ({ id, state: "pass", detail: "d", at });
    const results = new Map<VisionProbeId, VisionProbeResult>(
      (["census-sessions", "census-generations", "census-merged", "sickness", "wake-recall", "jobs", "trips", "town-square", "resident-journal", "crews", "family-tree"] as const).map((id) => [id, pass(id)]),
    );
    results.set("webtrips", { id: "webtrips", at, ...probeWebTrips({ jevRead: true, summary: webSummary(0) }) });
    results.set("improvement", { id: "improvement", at, ...probeImprovement([trend("/daily-recap", 0, 0)]) });
    const r = buildVisionResponse(VISION_CLAIMS, results, at);
    expect(byN(r, 8).effective).toBe("missing");
    expect(byN(r, 17).effective).toBe("missing");
    expect(r.counts).toEqual({ real: 22, partial: 14, missing: 2, metaphor: 4, scored: 38 });
    expect(r.formula).toBe("pct = (real + 0.5 × partial) / non-metaphor claims = (22 + 0.5 × 14) / 38 = 76.3%");
    expect(r.strictPct).toBe(57.9);
  });
});

// ---------------------------------------------------------------- the downgrade

describe("probe downgrade", () => {
  const seed = (status: VisionStatus, probe: VisionProbeId | null = "jobs"): VisionClaimSeed => ({ n: 1, text: "t", status, evidence: "e", probe, auditedAt: "2026-09-28", auditedBy: "t" });
  const result = (state: VisionProbeResult["state"], id: VisionProbeId = "jobs"): VisionProbeResult => ({ id, state, detail: "d", at: iso(T0) });

  it("one step down on fail: real -> partial -> missing, and missing stays missing", () => {
    expect(downgrade("real")).toBe("partial");
    expect(downgrade("partial")).toBe("missing");
    expect(downgrade("missing")).toBe("missing");
    expect(effectiveStatus(seed("real"), result("fail"))).toBe("partial");
    expect(effectiveStatus(seed("partial"), result("fail"))).toBe("missing");
  });

  it("pass and pending keep the audited status: a probe never raises one", () => {
    expect(effectiveStatus(seed("partial"), result("pass"))).toBe("partial");
    expect(effectiveStatus(seed("real"), result("pending"))).toBe("real");
    expect(effectiveStatus(seed("missing"), result("pass"))).toBe("missing");
  });

  it("another probe's result, or none at all, never applies", () => {
    expect(effectiveStatus(seed("real"), result("fail", "trips"))).toBe("real");
    expect(effectiveStatus(seed("real", null), result("fail"))).toBe("real");
    expect(effectiveStatus(seed("real"), null)).toBe("real");
  });

  it("buildVisionResponse: a failing census-merged probe drops claims 14 and 38 to partial and the pct by 2 x 0.5 / 38", () => {
    const pass = new Map<VisionProbeId, VisionProbeResult>([["census-merged", result("pass", "census-merged")]]);
    const fail = new Map<VisionProbeId, VisionProbeResult>([["census-merged", result("fail", "census-merged")]]);
    const before = buildVisionResponse(VISION_CLAIMS, pass, iso(T0));
    const after = buildVisionResponse(VISION_CLAIMS, fail, iso(T0));
    expect(byN(before, 14).effective).toBe("real");
    expect(byN(after, 14).effective).toBe("partial");
    expect(byN(after, 38).effective).toBe("partial");
    expect(byN(after, 14).status).toBe("real"); // the audit itself is kept, shown next to the downgrade
    expect(after.counts.real).toBe(before.counts.real - 2);
    expect(after.pct).toBe(Math.round(((20 + 0.5 * 18) / 38) * 1000) / 10);
    expect(after.formula).toContain("(20 + 0.5 × 18) / 38");
  });
});

// ---------------------------------------------------------------- each probe

describe("the probes", () => {
  it("census-sessions: pending until the archive is scanned, then indexed + fossils", () => {
    expect(probeCensusSessions(277, null).state).toBe("pending");
    expect(probeCensusSessions(0, 0).state).toBe("fail");
    expect(probeCensusSessions(277, 1743)).toEqual({ state: "pass", detail: "2,020 sessions = 277 indexed + 1,743 fossils." });
  });

  it("census-generations: pending before the first index, fail on 0 records, else the census fold", () => {
    expect(probeCensusGenerations(null).state).toBe("pending");
    expect(probeCensusGenerations(generations([])).state).toBe("fail");
    const r = probeCensusGenerations(generations([sub("a", 1), sub("b", 1, "p2"), sub("c", 2)]));
    expect(r.state).toBe("pass");
    expect(r.detail).toBe("3 sub-minions since 2026-09-07 from 2 sessions · 3 generations = 1 + deepest depth (depth 1: 2 · depth 2: 1).");
  });

  it("census-merged: a failed or stale gh fetch fails (never a silent 0); not fetched yet is pending", () => {
    expect(probeCensusMerged(null).state).toBe("pending");
    expect(probeCensusMerged(merged({ fetchedAt: null })).state).toBe("pending");
    expect(probeCensusMerged(merged({ fetchedAt: null, error: "gh: not logged in" })).state).toBe("fail");
    const stale = probeCensusMerged(merged({ error: "HTTP 502" }));
    expect(stale.state).toBe("fail");
    expect(stale.detail).toContain("HTTP 502");
    expect(probeCensusMerged(merged()).detail).toBe("64 merged PRs (gh pr list --state merged at 2026-09-28 12:55Z) · review recorded on the merged SHA: 0.");
  });

  it("sickness: pending while the cold scan runs, fail on 0 served cases after it, withheld kinds named", () => {
    expect(probeSickness(null).state).toBe("pending");
    expect(probeSickness(sickness({ scan: { ...sickness().scan, finishedAt: null, filesDone: 3 } })).state).toBe("pending");
    const none = sickness();
    none.counts = { ...none.counts, total: 0 };
    expect(probeSickness(none).state).toBe("fail");
    const r = probeSickness(sickness());
    expect(r.state).toBe("pass");
    expect(r.detail).toBe("272 cases (leaked-key 23, broken-build 249) · sick now 64 = open 23 + chronic 41 + exposed 0 · withheld (precision below the bar): steering-page.");
  });

  it("wake-recall: the fed share with its formula; fail only when nobody was fed", () => {
    expect(probeWakeRecall(null).state).toBe("pending");
    expect(probeWakeRecall(wake({}, false)).state).toBe("pending");
    expect(probeWakeRecall(wake({ fed: 0 })).state).toBe("fail");
    expect(probeWakeRecall(wake()).detail).toBe("168 of 214 main sessions got vault notes at wake = 78.5% · nothing 37 (35 headless) · unread 9.");
  });

  it("jobs: coverage = sessions with a job / sessions; fail when the classifier labels nobody", () => {
    expect(probeJobs(null).state).toBe("pending");
    expect(probeJobs(jobs({ lawyer: 0, learner: 0, builder: 0, gatherer: 0, none: 10 })).state).toBe("fail");
    const r = probeJobs(jobs());
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("205 of 277 sessions have a job = 74.0%");
    expect(r.detail).toContain("hacker 0; none 72");
    expect(r.detail).toContain("subagents 1,184 of 1,309");
  });

  it("resident-journal: inside Health's warn limit passes, past it fails, switched off fails", () => {
    expect(probeResidentJournal(null, T0).state).toBe("pending");
    expect(probeResidentJournal(resident(), T0)).toEqual({ state: "pass", detail: "Last reflection 30 min ago (Health's limit: 4 h 30 min)." });
    expect(probeResidentJournal(resident({ lastReflectAt: iso(T0 - RESIDENT_WARN_MS - MIN) }), T0).state).toBe("fail");
    expect(probeResidentJournal(resident({ enabled: false }), T0).state).toBe("fail");
    expect(probeResidentJournal(resident({ lastReflectAt: null, bornAt: iso(T0 - 10 * MIN) }), T0).state).toBe("pending");
    expect(probeResidentJournal(resident({ lastReflectAt: null }), T0).state).toBe("fail");
  });

  it("webtrips: pending until Jev's log is read; fails on 0 kept trips whatever the sessions did, and always counts the sessions' own trips", () => {
    expect(probeWebTrips(null).state).toBe("pending");
    expect(probeWebTrips({ jevRead: false, summary: webSummary(0) }).state).toBe("pending"); // a placeholder 0 is not a measurement
    const sessions = 'Sessions leave on their own: 108 of 236 main and 286 of 1,246 subagent transcripts made web trips (6,819 trips to 1,149 hosts), so "only Jev" is false.';
    expect(probeWebTrips({ jevRead: true, summary: webSummary(0) })).toEqual({ state: "fail", detail: `Jev's kept trips: 0, so nothing he found is kept to learn from. ${sessions}` });
    const counting = probeWebTrips({ jevRead: true, summary: webSummary(0, false) });
    expect(counting.state).toBe("fail");
    expect(counting.detail).toContain("still being counted"); // no half-counted number
    expect(counting.detail).not.toContain("108");
    expect(probeWebTrips({ jevRead: true, summary: webSummary(2) })).toEqual({ state: "pass", detail: `Jev's kept trips: 2 since 2026-09-29, recalled by Ask Jev, the voice brain and his ranking. ${sessions}` });
  });

  it("improvement: the Tower's own trend line; fails while no worker measures better (none measured, or none up)", () => {
    expect(probeImprovement(null).state).toBe("pending");
    const none = probeImprovement([]);
    expect(none).toEqual({ state: "fail", detail: `${trendSummaryLine([])} Nobody is measured getting better.` });
    const flat = probeImprovement([trend("/daily-recap", 0, 0), trend("/upskill", null)]);
    expect(flat.state).toBe("fail");
    expect(flat.detail).toBe("Getting better? 1 of 2 workers has 20+ runs with a verdict to compare: 0 better, 0 worse, 1 no change (clean rate, last 10 vs the 10 before). Nobody is measured getting better.");
    expect(probeImprovement([trend("/daily-recap", 3, 6)]).state).toBe("fail"); // worse is not better
    expect(probeImprovement([trend("/daily-recap", 7), trend("/upskill", null)])).toEqual({
      state: "pass",
      detail: "Getting better? 1 of 2 workers has 20+ runs with a verdict to compare: 1 better, 0 worse, 0 no change (clean rate, last 10 vs the 10 before).",
    });
  });

  it("crews: 2+ sessions naming one merged PR (case-folded repo); pending while the first outcomes scan could still find one", () => {
    expect(probeCrews(null).state).toBe("pending");
    const solo: SessionPrs[] = [{ sessionId: "s-a", mergedPrs: [pr("o/r", 1)] }, { sessionId: "s-b", mergedPrs: [pr("o/r", 2)] }];
    expect(probeCrews({ coldDone: false, rows: solo }).state).toBe("pending");
    expect(probeCrews({ coldDone: true, rows: solo })).toEqual({ state: "fail", detail: "0 crews: no merged PR is named by two sessions' outcome records." });
    expect(probeCrews({ coldDone: true, rows: [] }).state).toBe("fail");
    expect(probeCrews({ coldDone: true, rows: CREW_ROWS })).toEqual({
      state: "pass",
      detail: "2 crews: 5 sessions shipped a merged PR with another (acme-inc/acme-ai#460: 3 sessions, sboghossian/commandline#21: 2 sessions).",
    });
    const early = probeCrews({ coldDone: false, rows: CREW_ROWS });
    expect(early.state).toBe("pass"); // a crew already found is a crew
    expect(early.detail).toContain("2 crews so far (the outcomes feature's first scan is still running)");
  });

  it("family-tree: a third generation on record (a subagent that spawned its own), from the census fold", () => {
    expect(probeFamilyTree(null).state).toBe("pending");
    expect(probeFamilyTree(generations([])).state).toBe("fail");
    expect(probeFamilyTree(generations([sub("a", 1), sub("b", 1, "p2")]))).toEqual({ state: "fail", detail: "2 generations on record: no subagent has spawned one of its own (depth 1: 2)." });
    expect(probeFamilyTree(generations([sub("a", 1), sub("b", 1, "p2"), sub("c", 2)]))).toEqual({
      state: "pass",
      detail: "3 generations = 1 + deepest depth (depth 1: 2 · depth 2: 1), under 2 parent sessions.",
    });
  });
});

// ---------------------------------------------------------------- stateful probes, from EXISTING state

describe("town-square probe (a launch already stranded, a top 5 already published)", () => {
  const top = (...keys: string[]) => keys.map((k) => entry(k, k.startsWith("stranded:") ? "waiting" : "info"));

  it("a launch first seen after the last top 5 is not judged yet; one seen before it is", () => {
    const seen = new Map([["aw-1", T0 - 2 * MIN]]);
    expect(probeTownSquare([stranded("aw-1")], broadcast(T0 - 3 * MIN, top("a")), seen, T0).state).toBe("pending");
    expect(probeTownSquare([stranded("aw-1")], broadcast(T0 - MIN, top("a")), seen, T0).state).toBe("fail");
    expect(probeTownSquare([stranded("aw-1")], broadcast(T0 - MIN, top("stranded:aw-1", "a")), seen, T0).detail).toBe("1 of 1 launches stranded on Alex are in the top 5.");
  });

  it("a stranded launch that lost only to 5 other waits on Alex passes; a stale top 5 is pending", () => {
    const seen = new Map([["aw-1", T0 - 10 * MIN]]);
    const waits = ["w1", "w2", "w3", "w4", "w5"].map((k) => entry(k, "waiting"));
    expect(probeTownSquare([stranded("aw-1")], broadcast(T0 - MIN, waits), seen, T0).state).toBe("pass");
    expect(probeTownSquare([stranded("aw-1")], broadcast(T0 - 6 * MIN, top("stranded:aw-1")), seen, T0).state).toBe("pending");
    expect(probeTownSquare([stranded("aw-1")], null, seen, T0).state).toBe("pending");
  });

  it("across ticks of the feature: first run pending, the next run (after a newer top 5) judges it", async () => {
    let now = T0;
    let bc = broadcast(T0 - MIN, top("a")); // already published before the feature ever ran
    const readers: Partial<VisionReaders> = { ...healthyReaders(), stranded: () => [stranded("aw-1")], workspace: () => bc };
    const feature = createVisionFeature({ now: () => now, readers });
    const { ctx } = fakeCtx();
    const first = await getVision(feature, ctx);
    expect(byN(first, 23).probeResult?.state).toBe("pending");
    expect(byN(first, 23).effective).toBe("real");
    now = T0 + 5 * MIN;
    bc = broadcast(T0 + 4 * MIN, top("a", "b")); // computed after the launch was first seen, and it's missing
    await feature.onTick?.(ctx);
    const second = await getVision(feature, ctx);
    expect(byN(second, 23).probeResult?.state).toBe("fail");
    expect(byN(second, 23).effective).toBe("partial");
  });
});

describe("trips probe", () => {
  it("an unproven stored visit fails only when it is unproven on two runs in a row", () => {
    const t: TripsFacts = { cleaned: true, visited: 80, unproven: ["s|x"], invented: 0 };
    expect(probeTrips(t, null).state).toBe("pending");
    expect(probeTrips(t, new Set(["s|y"])).state).toBe("pending");
    expect(probeTrips(t, new Set(["s|x"])).state).toBe("fail");
    expect(probeTrips({ ...t, unproven: [] }, new Set(["s|x"])).state).toBe("pass");
    expect(probeTrips({ ...TRIPS_OK, cleaned: false }, null).state).toBe("fail");
    expect(probeTrips({ ...TRIPS_OK, invented: 1 }, null).state).toBe("fail");
  });

  const HOME = "/ws-home";
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const dirs: string[] = [];
  const dbs: WorldDb[] = [];
  afterEach(async () => {
    for (const db of dbs.splice(0)) db.close();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  function decision(id: string, kind: JevDecision["kind"]): JevDecision {
    return { id, at: "2026-09-28T03:00:00.000Z", kind, subjects: [A], choice: "x", probabilities: { x: 1 }, confidence: 1, source: "rules", summary: kind };
  }

  it("realTripsFacts on a world.db still holding Jev's invented visits fails, and passes after the honest-trips cleanup", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = new WorldDb(openDb(join(dir, "world.db")));
    dbs.push(db);
    db.setIslandForCwd("/ws/a", "island-a");
    db.setIslandForCwd("/ws/b", "island-b");
    for (const [id, cwd, island] of [[A, "/ws/a", "island-a"], [B, "/ws/b", "island-b"]] as const) {
      db.upsertSession({ id, cwd, islandId: island, startedAt: "2026-09-27T00:00:00.000Z", lastActive: "2026-09-27T00:00:00.000Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 1, cntAssistantTotalDelta: 1 });
    }
    db.upsertEdge({ from: A, to: B, kind: "visited", at: "2026-09-28T03:00:00.000Z" }); // invented: agent -> agent
    db.upsertEdge({ from: A, to: "file:/ws/b/x.ts", kind: "touched", at: "2026-09-27T10:00:00.000Z" }); // real work in island-b
    db.insertDecision(decision("d-pair", "pair"));
    db.insertDecision(decision("d-grow", "grow"));
    const ctx = { db } as unknown as FeatureContext;

    const before = realTripsFacts(ctx, HOME);
    expect(before).toEqual({ cleaned: false, visited: 1, unproven: [`${A}|${B}`], invented: 1 });
    expect(probeTrips(before, null).state).toBe("fail");

    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: () => new Date(T0) })).toBe("migrated");
    const after = realTripsFacts(ctx, HOME);
    expect(after).toEqual({ cleaned: true, visited: 1, unproven: [], invented: 0 }); // A -> island-b, proven by x.ts
    expect(probeTrips(after, new Set(before.unproven)).state).toBe("pass");
  });
});

// ---------------------------------------------------------------- the route

describe("GET /api/vision", () => {
  it("serves every claim with its probe result, the pct, strict and their formulas", async () => {
    const feature = createVisionFeature({ now: () => T0, readers: healthyReaders() });
    const { ctx } = fakeCtx();
    const r = await getVision(feature, ctx);
    expect(r.claims).toHaveLength(42);
    expect(r.pct).toBe(78.9);
    expect(r.strictPct).toBe(57.9);
    expect(r.formula).toBe("pct = (real + 0.5 × partial) / non-metaphor claims = (22 + 0.5 × 16) / 38 = 78.9%");
    expect(r.probedAt).toBe(iso(T0));
    expect(byN(r, 4).probeResult).toEqual({ id: "census-sessions", state: "pass", detail: "2,020 sessions = 277 indexed + 1,743 fossils.", at: iso(T0) });
    expect(byN(r, 1).probeResult).toBeNull();
    for (const c of r.claims.filter((x) => x.probe)) expect(c.probeResult?.id).toBe(c.probe);
  });

  it("a probe that fails live lowers its claims and the pct; a throwing reader leaves the audit standing", async () => {
    const readers: VisionReaders = {
      ...healthyReaders(),
      resident: () => resident({ lastReflectAt: iso(T0 - 6 * 60 * MIN) }), // silent 6 h
      wake: () => {
        throw new Error("boom");
      },
    };
    const feature = createVisionFeature({ now: () => T0, readers });
    const { ctx, warnings } = fakeCtx();
    const r = await getVision(feature, ctx);
    expect(byN(r, 11).effective).toBe("partial");
    expect(byN(r, 11).probeResult?.detail).toContain("past Health's 4 h 30 min limit");
    expect(byN(r, 21).probeResult?.state).toBe("pending");
    expect(byN(r, 21).effective).toBe("partial");
    expect(warnings.some((w) => w.includes("wake-recall"))).toBe(true);
    expect(r.counts).toEqual({ real: 21, partial: 17, missing: 0, metaphor: 4, scored: 38 });
    expect(r.pct).toBe(77.6);
  });

  it("the real readers of the four new probes, in a process where nothing was read yet, answer pending (never a fabricated fail)", async () => {
    // Only the ctx-bound readers are stubbed; webtrips, trends, crews and the generations behind
    // family-tree are the REAL module readers (webTripsFeature, latestCareerTrends, the outcomes
    // records + coldDone, latestSubagentRecords), none of which has run in this test process.
    const h = healthyReaders();
    const readers: Partial<VisionReaders> = { sessions: h.sessions, merged: h.merged, sickness: h.sickness, wake: h.wake, jobs: h.jobs, trips: h.trips, stranded: h.stranded, workspace: h.workspace, resident: h.resident };
    const feature = createVisionFeature({ now: () => T0, readers });
    const { ctx } = fakeCtx();
    const r = await getVision(feature, ctx);
    for (const n of [8, 17, 34, 37]) {
      expect(byN(r, n).probeResult?.state).toBe("pending");
      expect(byN(r, n).effective).toBe(byN(r, n).status);
    }
  });

  it("probes once on the first GET, then only on ticks (a GET never re-runs them)", async () => {
    let calls = 0;
    let now = T0;
    const readers: VisionReaders = {
      ...healthyReaders(),
      merged: () => {
        calls += 1;
        return merged();
      },
    };
    const feature = createVisionFeature({ now: () => now, readers });
    const { ctx } = fakeCtx();
    await getVision(feature, ctx);
    await getVision(feature, ctx);
    expect(calls).toBe(1);
    now = T0 + 5 * MIN;
    await feature.onTick?.(ctx);
    const r = await getVision(feature, ctx);
    expect(calls).toBe(2);
    expect(r.probedAt).toBe(iso(T0 + 5 * MIN));
  });
});
