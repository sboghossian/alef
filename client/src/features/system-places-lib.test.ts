import { describe, expect, it } from "vitest";
import { parseCareersResponse, type CareerWorker } from "../../../shared/features/careers";
import { openEntries, SICKNESS_OPEN_CAP, type SicknessCase, type SicknessOpenEntry } from "../../../shared/features/sickness";
import {
  CAMPUS_FOOTPRINT,
  CLINIC_FOOTPRINT,
  MAX_MARKS,
  QUARTER_PLACE_FOOTPRINT,
  clinicLamp,
  clinicSlot,
  markSelection,
  CAMPUS_IDS,
  CAMPUS_MIN_CLEARANCE,
  INSTITUTE_OF_TRUTH,
  LAMP_FRESH_DAYS,
  MAX_BANNERS,
  QUARTER_ARC,
  QUARTER_CENTER_ANGLE,
  bannerSlots,
  campusSlots,
  harnessObstacles,
  lampState,
  lotCalloutName,
  parseInstituteBlock,
  parseOutcomeDates,
  shippedSince,
  isMemoryPlace,
  MEMORY_PLACE_IDS,
  memoryPlaceCaption,
  PLACE_IDS,
  SlotPool,
  compactRoute,
  courierCap,
  courierRoute,
  hookGates,
  legSeconds,
  modelFamilyOf,
  permissionRoute,
  plantScale,
  plantStats,
  quarterSlots,
  routerHookState,
  stopRoute,
  type GateEvent,
} from "./system-places-lib";

const ALL: ReadonlySet<GateEvent> = new Set(["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"]);
const NONE: ReadonlySet<GateEvent> = new Set();

describe("model families / power plants", () => {
  it("classifies model ids by family", () => {
    expect(modelFamilyOf("claude-opus-5-5")).toBe("opus");
    expect(modelFamilyOf("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamilyOf("claude-fable-5-1")).toBe("fable");
    expect(modelFamilyOf("<synthetic>")).toBe("other");
    expect(modelFamilyOf(null)).toBe("other");
  });

  it("counts live / today / all per family, from the agents passed in", () => {
    const since = Date.parse("2026-09-26T00:00:00Z");
    const stats = plantStats(
      [
        { model: "claude-opus-5", status: "live", lastActive: "2026-09-26T08:00:00Z" },
        { model: "claude-opus-5-5", status: "dormant", lastActive: "2026-09-20T08:00:00Z" },
        { model: "claude-sonnet-5", status: "dormant", lastActive: "2026-09-26T01:00:00Z" },
        { model: null, status: "dormant", lastActive: "not a date" },
      ],
      since,
    );
    expect(stats.map((s) => s.family)).toEqual(["opus", "sonnet", "haiku", "fable", "other"]);
    expect(stats[0]).toMatchObject({ live: 1, today: 1, total: 2 });
    expect(stats[1]).toMatchObject({ live: 0, today: 1, total: 1 });
    expect(stats[2]).toMatchObject({ live: 0, today: 0, total: 0 });
    expect(stats[4]).toMatchObject({ total: 1, today: 0 });
  });

  it("empty fleet: every plant at zero", () => {
    expect(plantStats([], 0).every((s) => s.total === 0 && s.live === 0)).toBe(true);
  });

  it("plant core grows with live sessions and is capped", () => {
    expect(plantScale(0)).toBe(1);
    expect(plantScale(-3)).toBe(1);
    expect(plantScale(Number.NaN)).toBe(1);
    expect(plantScale(1)).toBeGreaterThan(1);
    expect(plantScale(3)).toBeGreaterThan(plantScale(1));
    expect(plantScale(10_000)).toBe(2.2);
  });
});

describe("hook gates", () => {
  const objs = [
    { kind: "hook" as const, name: "UserPromptSubmit:plan-gate.py" },
    { kind: "hook" as const, name: "UserPromptSubmit:node" },
    { kind: "hook" as const, name: "UserPromptSubmit:node" },
    { kind: "hook" as const, name: "PreToolUse:rtk" },
    { kind: "hook" as const, name: "SessionStart:nudge.sh" },
    { kind: "skill" as const, name: "Stop:not-a-hook" },
    { kind: "hook" as const, name: "malformed" },
    { kind: "hook" as const, name: "Stop:" },
  ];

  it("groups real hook objects into the four gates, deduped and sorted", () => {
    const g = hookGates(objs);
    expect(g.map((x) => x.event)).toEqual(["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"]);
    expect(g[0]).toEqual({ event: "UserPromptSubmit", configured: true, scripts: ["node", "plan-gate.py"] });
    expect(g[1]?.scripts).toEqual(["rtk"]);
    expect(g[2]).toEqual({ event: "PermissionRequest", configured: false, scripts: [] });
    expect(g[3]?.configured).toBe(false); // "Stop:" has no script, the skill is not a hook
  });

  it("router hook state: named / likely (node) / absent", () => {
    expect(routerHookState(hookGates([{ kind: "hook", name: "UserPromptSubmit:jev-router.mjs" }]))).toBe("installed");
    expect(routerHookState(hookGates(objs))).toBe("likely");
    expect(routerHookState(hookGates([{ kind: "hook", name: "UserPromptSubmit:route.mjs" }]))).toBe("absent");
    expect(routerHookState(hookGates([{ kind: "hook", name: "PermissionRequest:node" }]))).toBe("absent");
    expect(routerHookState(hookGates([]))).toBe("absent");
  });
});

describe("quarter layout", () => {
  it("one slot per place, in route order, outside Harness City and the routines rings", () => {
    const slots = quarterSlots(11.6);
    expect(slots.map((s) => s.id)).toEqual([...PLACE_IDS]);
    expect(slots.map((s) => s.id).slice(0, 5)).toEqual(["gate:UserPromptSubmit", "gate:PreToolUse", "gate:PermissionRequest", "gate:Stop", "jev"]);
    for (const s of slots) expect(s.radius).toBeGreaterThanOrEqual(23);
    // neighbours at least 3.5 units apart along the arc (the widest place is ~3.5 across)
    for (let i = 1; i < slots.length; i++) expect(Math.abs(slots[i]!.angle - slots[i - 1]!.angle) * slots[i]!.radius).toBeGreaterThan(3.5);
  });

  it("a big Harness City pushes the quarter out", () => {
    expect(quarterSlots(30)[0]!.radius).toBe(42);
  });

  it("includes the CLI station and all three memory buildings", () => {
    expect(PLACE_IDS).toContain("cli");
    expect(PLACE_IDS).toEqual(expect.arrayContaining(["episodic", "semantic", "procedural"]));
  });
});

describe("courier routes", () => {
  it("a new prompt takes the full path: house → prompt gate → Jev → plant → city → station", () => {
    const r = courierRoute({ stage: "hook", toolName: null }, { model: "claude-opus-5", configured: ALL });
    expect(r.kind).toBe("prompt");
    expect(r.waypoints).toEqual(["house", "gate:UserPromptSubmit", "jev", "plant:opus", "city", "station"]);
    expect(r.station).toBe("hook");
  });

  it("a tool call starts at the plant and passes the tool gate; the station matches the tool", () => {
    const r = courierRoute({ stage: "tool", toolName: "Bash" }, { model: "claude-sonnet-5", configured: ALL });
    expect(r.waypoints).toEqual(["plant:sonnet", "gate:PreToolUse", "city", "station"]);
    expect(r.station).toBe("bash");
  });

  it("a memory read stops at the semantic library by default", () => {
    expect(courierRoute({ stage: "brain", toolName: "Read" }, { model: "claude-haiku-4-5", configured: ALL }).waypoints).toEqual(["plant:haiku", "semantic", "city", "station"]);
  });

  it("unconfigured gates and unknown models are skipped, never invented", () => {
    const r = courierRoute({ stage: "hook", toolName: null }, { model: "<synthetic>", configured: NONE });
    expect(r.waypoints).toEqual(["house", "jev", "city", "station"]);
    expect(courierRoute({ stage: "reason", toolName: null }, { model: null, configured: NONE }).waypoints).toEqual(["city", "station"]);
  });

  it("permission and stop routes end at their gates", () => {
    expect(permissionRoute({ model: null, configured: ALL }).waypoints).toEqual(["station", "city", "gate:PermissionRequest"]);
    expect(stopRoute({ model: null, configured: ALL }).waypoints).toEqual(["house", "city", "gate:Stop"]);
    expect(stopRoute({ model: null, configured: NONE }).waypoints).toEqual(["house", "city"]);
  });

  it("compactRoute drops repeated points and refuses a route with nowhere to go", () => {
    const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
    expect(compactRoute([1, 1.2, 5, 5, 9], same)).toEqual([1, 5, 9]);
    expect(compactRoute([3, 3.1], same)).toBeNull();
    expect(compactRoute([], same)).toBeNull();
  });

  it("leg timing: quick hops, capped long arcs, safe on bad input", () => {
    expect(legSeconds(0)).toBe(0.3);
    expect(legSeconds(Number.NaN)).toBe(0.3);
    expect(legSeconds(0.2)).toBeCloseTo(0.62, 5);
    expect(legSeconds(Math.PI)).toBe(1.4);
  });
});

describe("courier pool + budget", () => {
  it("cap follows the quality tier; reduced motion sends nothing", () => {
    expect(courierCap(0, false)).toBe(48);
    expect(courierCap(1, false)).toBe(24);
    expect(courierCap(2, false)).toBe(10);
    expect(courierCap(0, true)).toBe(0);
  });

  it("hands out free slots under the limit and reuses released ones", () => {
    const p = new SlotPool(3);
    expect(p.acquire()).toBe(0);
    expect(p.acquire()).toBe(1);
    expect(p.acquire(2)).toBe(-1); // tier cap reached
    expect(p.acquire()).toBe(2);
    expect(p.acquire()).toBe(-1);
    p.release(1);
    p.release(1); // double release is a no-op
    p.release(99); // out of range is a no-op
    expect(p.active).toBe(2);
    expect(p.acquire()).toBe(1);
    expect(p.isBusy(1)).toBe(true);
  });
});

describe("the Institute of Truth (the three memory buildings as a group)", () => {
  it("each memory building's Explain caption names the group and what it keeps", () => {
    expect(INSTITUTE_OF_TRUTH).toBe("Institute of Truth");
    expect(MEMORY_PLACE_IDS.map(memoryPlaceCaption)).toEqual([
      "Institute of Truth · what happened",
      "Institute of Truth · what's true",
      "Institute of Truth · what works",
    ]);
    expect(PLACE_IDS.filter(isMemoryPlace)).toEqual([...MEMORY_PLACE_IDS]);
    expect(isMemoryPlace("jev")).toBe(false);
  });
});

// ---------------------------------------------------------------- the campus (agent-city piece 7)
// Fixtures copy the REAL shapes (GET /api/careers, /api/skills/snapshot, /api/outcomes on
// 2026-09-28) and go through the same parsers the client uses, so a shape drift fails here.

/** One worker exactly as GET /api/careers served it (runs trimmed to one), state overridable. */
function realWorker(key: string, state: CareerWorker["state"], trustedSince: string | null = null, department = "Reports & Briefs"): unknown {
  return {
    key,
    name: null,
    department,
    state,
    standing: state === "retired" || state === "returned" ? "trusted" : state,
    reason: "0 of 5 clean runs in a row toward trusted (its last 5 only wrote files: no shipped, delivered or finished evidence)",
    runs: [{ id: "b475e929-0dc5-4e9c-b1aa-8afdceb3dce7", at: "2026-09-28T05:10:19.561Z", dayOnly: false, archived: false, mark: "wrote", why: "wrote 1 file edit: no shipped, delivered or finished evidence" }],
    lifetime: { total: 141, live: 30, archived: 111, clean: 0, wrote: 16, bad: 4 },
    lastRunAt: "2026-09-28T05:10:19.561Z",
    medianGapMs: 85303400,
    lapseAfterMs: 259200000,
    trustedSince,
    retiredAt: null,
    routine: { label: "com.stephane.daily-recap", schedule: "daily 08:10", lastExitStatus: 0, running: false },
  };
}

function careersResponse(workers: unknown[]): CareerWorker[] {
  const parsed = parseCareersResponse({
    ok: true,
    at: "2026-09-28T07:57:31.208Z",
    inputs: { liveRuns: 275, archivedRuns: 1743, archiveLoaded: true, outcomeRecords: 212, routines: 16 },
    departments: ["Reports & Briefs", "Inbox desk", "Research library", "Institute", "Control room", "Operations"],
    summary: { trusted: 0, probation: 3, enrolled: 4, lapsed: 21, returned: 0, retired: 0, total: 28 },
    workers,
  });
  if (!parsed) throw new Error("fixture no longer parses as a CareersResponse");
  return parsed.workers;
}

function trustedWorkers(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => realWorker(`/worker-${String(i).padStart(2, "0")}`, "trusted", new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString()));
}

describe("bannerSlots: one banner per trusted worker, at most 12", () => {
  it("0 workers: no banners, never a placeholder", () => {
    expect(bannerSlots([])).toEqual({ slots: [], unshown: 0 });
  });

  it("1 trusted worker: one banner that maps to it", () => {
    const b = bannerSlots(careersResponse(trustedWorkers(1)));
    expect(b.unshown).toBe(0);
    expect(b.slots).toHaveLength(1);
    expect(b.slots[0]).toMatchObject({ key: "/worker-00", label: "/worker-00", department: "Reports & Briefs", index: 0 });
  });

  it("12 trusted workers: 12 banners at 12 distinct spots in front of the Hall", () => {
    const b = bannerSlots(careersResponse(trustedWorkers(12)));
    expect(b.slots).toHaveLength(MAX_BANNERS);
    expect(b.unshown).toBe(0);
    expect(new Set(b.slots.map((s) => `${s.x},${s.z}`)).size).toBe(12);
    for (const s of b.slots) expect(s.z).toBeGreaterThan(1.5); // in front of the steps
  });

  it("30 trusted workers: 12 banners, the oldest graduates first, and 18 counted as unshown", () => {
    const workers = careersResponse(trustedWorkers(30).reverse());
    const b = bannerSlots(workers);
    expect(b.slots).toHaveLength(12);
    expect(b.unshown).toBe(18);
    expect(b.slots.map((s) => s.key)).toEqual(Array.from({ length: 12 }, (_, i) => `/worker-${String(i).padStart(2, "0")}`));
  });

  it("INVARIANT: every banner maps to a trusted worker; probation, lapsed, retired and returned never get one", () => {
    const workers = careersResponse([
      realWorker("/daily-recap", "enrolled"),
      realWorker("/yalla-brief", "probation"),
      realWorker("eval-harness", "lapsed"),
      realWorker("/old", "retired", "2026-08-01T00:00:00.000Z"),
      realWorker("/back", "returned", "2026-08-02T00:00:00.000Z"),
      realWorker("⏰ rss-feed-obsidian", "trusted", "2026-09-20T06:00:00.000Z", "Research library"),
    ]);
    const b = bannerSlots(workers);
    const trusted = new Set(workers.filter((w) => w.state === "trusted").map((w) => w.key));
    expect(b.slots.map((s) => s.key)).toEqual(["⏰ rss-feed-obsidian"]);
    for (const s of b.slots) expect(trusted.has(s.key)).toBe(true);
    expect(b.slots[0]?.department).toBe("Research library");
  });

  it("a named worker's banner carries its name", () => {
    const w = { ...(realWorker("/daily-recap", "trusted", "2026-09-01T00:00:00.000Z") as Record<string, unknown>), name: "Recap" };
    expect(bannerSlots(careersResponse([w])).slots[0]?.label).toBe("Recap");
  });
});

describe("lampState: the School's lamp", () => {
  // GET /api/skills/snapshot's institute.study block, as served on 2026-09-28.
  const realStudy = {
    line: "No new draft since 2026-05-24 (last clean exit 2026-06-08): 149 of 160 study runs failed (autopilot.log)",
    enabled: true,
    stats: {
      forksLaunched: 160,
      forksFailed: 149,
      forksOk: 10,
      noDraft: 149,
      permissionSkips: 3,
      thresholdSkips: 1808,
      lastRunAt: "2026-09-28T05:32:02.000Z",
      lastSuccessAt: "2026-06-08T05:59:05.000Z",
      lastDraftAt: "2026-05-24T14:53:50.000Z",
      lastExitRc: 1,
      lastFailureLine: "2026-09-28 08:32:37 fork: no draft / unparseable output",
    },
    logPartial: false,
  };
  const snapshot = (study: unknown): unknown => ({ ok: true, topUsed: [], graveyard: [], candidates: [], installedCount: 189, scannedAt: "2026-09-28T07:50:00.000Z", institute: { study, darwin: [], failureModes: { skills: [], patchedSkillCount: 0, patchEntryCount: 0 } }, historyStartAt: null });
  const NOW = Date.parse("2026-09-28T09:00:00.000Z");

  it("stale (the real block: last draft 2026-05-24): dim, with the real date and age", () => {
    const block = parseInstituteBlock(snapshot(realStudy));
    expect(block?.candidates).toBe(0);
    expect(lampState(block?.block, NOW)).toEqual({ state: "dim", lastDraftAt: "2026-05-24T14:53:50.000Z", days: 126, why: "no new draft since 2026-05-24 (126 days)" });
  });

  it("fresh (a draft 3 days ago): lit", () => {
    const block = parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, lastDraftAt: "2026-09-25T08:00:00.000Z" } }));
    expect(lampState(block?.block, NOW)).toMatchObject({ state: "lit", days: 3 });
  });

  it("exactly 30 days is still lit; a minute more is dim", () => {
    const at = (ms: number): string => new Date(NOW - ms).toISOString();
    const lamp = (ms: number): string => lampState(parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, lastDraftAt: at(ms) } }))?.block, NOW).state;
    expect(lamp(LAMP_FRESH_DAYS * 86_400_000)).toBe("lit");
    expect(lamp(LAMP_FRESH_DAYS * 86_400_000 + 60_000)).toBe("dim");
  });

  it("a missing block: unknown (grey), never lit and never a made-up date", () => {
    expect(lampState(null, NOW)).toMatchObject({ state: "unknown", lastDraftAt: null, days: null });
    expect(lampState(parseInstituteBlock({ ok: true })?.block, NOW).state).toBe("unknown");
    expect(lampState(parseInstituteBlock({ ok: false, error: "boom" })?.block, NOW).state).toBe("unknown");
  });

  it("the pipeline never ran (no autopilot.log) or never drafted: dim, saying which", () => {
    expect(lampState(parseInstituteBlock(snapshot({ ...realStudy, stats: null }))?.block, NOW)).toMatchObject({ state: "dim", why: "the study pipeline has never run (no autopilot.log)" });
    expect(lampState(parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, lastDraftAt: null } }))?.block, NOW)).toMatchObject({ state: "dim", why: "the study pipeline has never written a draft" });
  });

  it("a clean exit with no draft never lights it (lastSuccessAt fresh, lastDraftAt stale)", () => {
    const block = parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, lastSuccessAt: "2026-09-28T05:00:00.000Z" } }));
    expect(lampState(block?.block, NOW).state).toBe("dim");
  });

  it("an unreadable date is unknown, and a malformed stats block is rejected", () => {
    expect(lampState(parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, lastDraftAt: "not a date" } }))?.block, NOW).state).toBe("unknown");
    expect(parseInstituteBlock(snapshot({ ...realStudy, stats: { ...realStudy.stats, forksFailed: "149" } }))).toBeNull();
  });
});

describe("shippedSince: the Hall's plaque", () => {
  const NOW = Date.parse("2026-09-28T09:00:00.000Z");
  const WEEK = NOW - 7 * 86_400_000;
  // GET /api/outcomes rows (real shape) with the evidenceAt this PR adds.
  const row = (outcome: string, evidenceAt: string | null): unknown => ({ sessionId: "9e6070ff-8488-4c3b-bec6-28df361de682", outcome, reason: "sboghossian/commandline#21 merged", evidenceAt, lastActive: "2026-09-28T05:31:24.769Z", prs: 1, merged: 1, pushes: 0, artifacts: 0, pending: false });

  it("counts shipped sessions merged inside the window, by merge time", () => {
    const rows = parseOutcomeDates({ ok: true, outcomes: [row("shipped", "2026-09-28T05:03:06Z"), row("shipped", "2026-09-21T09:00:00Z"), row("shipped", "2026-09-20T00:00:00Z"), row("delivered", "2026-09-27T00:00:00Z"), row("unknown", null)], counts: {}, scan: {} });
    expect(shippedSince(rows ?? [], WEEK)).toEqual({ count: 2, undated: 0 });
  });

  it("a shipped row without a merge time is undated, never counted in the window", () => {
    // Today's live server (before this PR) serves no evidenceAt at all.
    const rows = parseOutcomeDates({ ok: true, outcomes: [{ sessionId: "x", outcome: "shipped", reason: null, lastActive: "2026-09-28T05:31:24.769Z", prs: 1, merged: 1, pushes: 0, artifacts: 0, pending: false }] });
    expect(shippedSince(rows ?? [], WEEK)).toEqual({ count: 0, undated: 1 });
  });

  it("rejects a response that isn't /api/outcomes, and drops rows with no known outcome", () => {
    expect(parseOutcomeDates({ ok: false })).toBeNull();
    expect(parseOutcomeDates({ ok: true, outcomes: [row("graduated", "2026-09-28T00:00:00Z"), 7, null] })).toEqual([]);
  });
});

describe("lotCalloutName: 🎓 on trusted AUTO lots", () => {
  const trusted = new Set(["⏰ rss-feed-obsidian"]);

  it("prefixes only a trusted worker's lot (keys match automationKey exactly)", () => {
    expect(lotCalloutName("⏰ rss-feed-obsidian", trusted, false)).toBe("🎓 ⏰ rss-feed-obsidian");
    expect(lotCalloutName("/daily-recap", trusted, false)).toBe("/daily-recap");
    expect(lotCalloutName("/daily-recap", new Set(), false)).toBe("/daily-recap");
  });

  it("keeps the badge, hides the name, when redacted", () => {
    expect(lotCalloutName("⏰ rss-feed-obsidian", trusted, true)).toBe("🎓 …");
    expect(lotCalloutName("/daily-recap", trusted, true)).toBe("…");
  });
});

describe("campusSlots: on the quarter's arc, clear of the neighbours, nothing moved", () => {
  const H = 11.77; // Harness City's radius on the real 2026-09-28 layout
  const quarter = quarterSlots(H);
  const xz = (s: { angle: number; radius: number }): [number, number] => [Math.cos(s.angle) * s.radius, Math.sin(s.angle) * s.radius];

  it("the campus is not in PLACE_IDS, so the quarter's 13 places keep their exact slots", () => {
    for (const id of CAMPUS_IDS) expect(PLACE_IDS as readonly string[]).not.toContain(id);
    expect(quarter).toHaveLength(13);
    expect(quarter[0]?.angle).toBeCloseTo(QUARTER_CENTER_ANGLE - QUARTER_ARC / 2, 12);
    expect(quarter[12]?.angle).toBeCloseTo(QUARTER_CENTER_ANGLE + QUARTER_ARC / 2, 12);
  });

  it("no neighbours: just past the procedural workshop, on the quarter's own radius, School then Hall", () => {
    const c = campusSlots(H, []);
    expect(c.map((s) => s.id)).toEqual(["school", "hall"]);
    const end = QUARTER_CENTER_ANGLE + QUARTER_ARC / 2;
    expect(c[0]!.angle).toBeGreaterThan(end);
    expect(c[1]!.angle).toBeGreaterThan(c[0]!.angle);
    for (const s of c) expect(s.radius).toBe(quarter[0]!.radius);
  });

  it("never lands on a quarter place: each campus footprint clears every quarter slot", () => {
    for (const c of campusSlots(H, [])) {
      const [cx, cz] = xz(c);
      for (const q of quarter) {
        const [qx, qz] = xz(q);
        expect(Math.hypot(cx - qx, cz - qz)).toBeGreaterThan(CAMPUS_FOOTPRINT[c.id] + 1.8);
      }
    }
  });

  it("steps around a city sitting on its first choice", () => {
    const first = campusSlots(H, []);
    const [x, z] = xz(first[0]!);
    const c = campusSlots(H, [{ x, z, r: 4 }]);
    for (const s of c) expect(s.clearance).toBeGreaterThanOrEqual(CAMPUS_MIN_CLEARANCE);
    expect(c[0]!.angle === first[0]!.angle && c[0]!.radius === first[0]!.radius).toBe(false);
  });

  it("with no room anywhere, still two slots (the roomiest), and the same answer every time", () => {
    const wall = Array.from({ length: 72 }, (_, i) => ({ x: Math.cos((i / 72) * Math.PI * 2) * 30, z: Math.sin((i / 72) * Math.PI * 2) * 30, r: 9 }));
    const a = campusSlots(H, wall);
    expect(a).toHaveLength(2);
    expect(campusSlots(H, wall)).toEqual(a);
  });

  it("harnessObstacles: projects a neighbour onto Harness's tangent plane (cityPoint's inverse), grows its disc, skips the far side", () => {
    const harness = { dir: { x: 0, y: 1, z: 0 }, t1: { x: 1, y: 0, z: 0 }, t2: { x: 0, y: 0, z: 1 } };
    const th = 0.4;
    const obs = harnessObstacles(
      harness,
      [
        { id: "harness", dir: harness.dir, radius: 11 },
        { id: "near", dir: { x: Math.sin(th), y: Math.cos(th), z: 0 }, radius: 5 },
        { id: "far", dir: { x: 0, y: -1, z: 0 }, radius: 5 },
      ],
      50.9,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.x).toBeCloseTo(50.9 * Math.tan(th), 6);
    expect(obs[0]!.z).toBeCloseTo(0, 6);
    expect(obs[0]!.r).toBeCloseTo(5 / Math.cos(th) ** 2, 6);
  });
});

describe("clinicSlot: on the quarter's arc, clear of the quarter, the campus and the neighbours", () => {
  const H = 11.77; // Harness City's radius on the real 2026-09-28 layout
  const quarter = quarterSlots(H);
  const xz = (s: { angle: number; radius: number }): [number, number] => [Math.cos(s.angle) * s.radius, Math.sin(s.angle) * s.radius];
  const dist = (a: { angle: number; radius: number }, b: { angle: number; radius: number }): number => {
    const [ax, az] = xz(a);
    const [bx, bz] = xz(b);
    return Math.hypot(ax - bx, az - bz);
  };

  it("adds nothing to PLACE_IDS: the 13 places keep their exact slots, and the campus its own", () => {
    expect(PLACE_IDS as readonly string[]).not.toContain("clinic");
    expect(quarter).toHaveLength(13);
    const campus = campusSlots(H, []);
    const before = JSON.stringify(campus);
    clinicSlot(H, [], campus);
    expect(JSON.stringify(campus)).toBe(before); // an input, never moved
    expect(campusSlots(H, [])).toEqual(campus);
  });

  it("no neighbours: past the hook gates (the end the campus didn't take), on the quarter's radius", () => {
    const campus = campusSlots(H, []);
    expect(campus.every((c) => c.angle > QUARTER_CENTER_ANGLE)).toBe(true);
    const k = clinicSlot(H, [], campus);
    expect(k.angle).toBeLessThan(QUARTER_CENTER_ANGLE - QUARTER_ARC / 2);
    expect(k.radius).toBe(quarter[0]!.radius);
    expect(k.clearance).toBeGreaterThanOrEqual(CAMPUS_MIN_CLEARANCE);
  });

  it("never lands on a quarter place or a campus place", () => {
    const campus = campusSlots(H, []);
    const k = clinicSlot(H, [], campus);
    for (const q of quarter) expect(dist(k, q)).toBeGreaterThanOrEqual(CLINIC_FOOTPRINT + QUARTER_PLACE_FOOTPRINT + CAMPUS_MIN_CLEARANCE);
    for (const c of campus) expect(dist(k, c)).toBeGreaterThanOrEqual(CLINIC_FOOTPRINT + CAMPUS_FOOTPRINT[c.id] + CAMPUS_MIN_CLEARANCE);
  });

  it("steps around a city on its first choice; with the campus on the other end it goes past the procedural workshop", () => {
    const campus = campusSlots(H, []);
    const first = clinicSlot(H, [], campus);
    const [x, z] = xz(first);
    const k = clinicSlot(H, [{ x, z, r: 4 }], campus);
    expect(k.clearance).toBeGreaterThanOrEqual(CAMPUS_MIN_CLEARANCE);
    expect(k.angle === first.angle && k.radius === first.radius).toBe(false);
    // A campus on the gates' end sends the Clinic past the procedural workshop instead.
    const mirrored = campus.map((c) => ({ ...c, angle: 2 * QUARTER_CENTER_ANGLE - c.angle }));
    expect(clinicSlot(H, [], mirrored).angle).toBeGreaterThan(QUARTER_CENTER_ANGLE + QUARTER_ARC / 2);
  });

  it("with no room anywhere, still one slot (the roomiest), and the same answer every time", () => {
    const wall = Array.from({ length: 72 }, (_, i) => ({ x: Math.cos((i / 72) * Math.PI * 2) * 30, z: Math.sin((i / 72) * Math.PI * 2) * 30, r: 9 }));
    const campus = campusSlots(H, wall);
    const a = clinicSlot(H, wall, campus);
    expect(Number.isFinite(a.angle)).toBe(true);
    expect(clinicSlot(H, wall, campus)).toEqual(a);
  });
});

describe("clinicLamp: lit while any case is sick", () => {
  it("unknown before any data, dark with no sick session, lit with the count", () => {
    expect(clinicLamp(null)).toEqual({ state: "unknown", sessions: null, why: "no data: the sickness list hasn't loaded" });
    expect(clinicLamp([])).toEqual({ state: "dark", sessions: 0, why: "no sick case" });
    expect(clinicLamp([{}])).toMatchObject({ state: "lit", sessions: 1, why: "1 sick session" });
    expect(clinicLamp(new Array(27).fill({}))).toMatchObject({ state: "lit", sessions: 27, why: "27 sick sessions" });
  });
});

// Cases in the served shape (GET /api/sickness), sessions like the live 2026-09-28 world: two
// leaked-key sessions, a chronic build, one session with a healed and a treated case only.
function sc(id: string, sessionId: string, state: SicknessCase["state"], kind: SicknessCase["kind"] = "broken-build", lastSeenAt = "2026-09-28T10:00:00.000Z"): SicknessCase {
  return {
    id,
    kind,
    state,
    sessionId,
    subagentId: null,
    lineage: null,
    district: "agent-world",
    label: kind === "leaked-key" ? "OpenRouter key read into context by Read" : "npm test failing",
    source: { tool: kind === "leaked-key" ? "Read" : "Bash", target: kind === "leaked-key" ? "~/.config/x.yaml" : "npm test" },
    detail: kind === "leaked-key" ? { provider: "OpenRouter", masked: "sk-or-v1-...", vector: "read into context" } : { cmdClass: "npm test" },
    firstSeenAt: "2026-09-28T09:00:00.000Z",
    lastSeenAt,
    occurrences: 1,
    healedAt: state === "healed" ? lastSeenAt : null,
    treatment: state === "treated" ? { by: "alex", at: lastSeenAt } : null,
  };
}

describe("markSelection: one mark per sick house on the planet, and only there", () => {
  const cases = [
    sc("leaked-key:a1", "s-leak-1", "open", "leaked-key"),
    sc("leaked-key:a2", "s-leak-1", "open", "leaked-key", "2026-09-28T11:00:00.000Z"),
    sc("leaked-key:b1", "s-leak-2", "open", "leaked-key"),
    sc("broken-build:c1", "s-chronic", "chronic"),
    sc("broken-build:c2", "s-chronic", "healed"),
    sc("broken-build:d1", "s-well", "healed"),
    sc("broken-build:d2", "s-well", "treated"),
    sc("broken-build:e1", "s-retired", "open"),
  ];
  const sick = openEntries(cases, SICKNESS_OPEN_CAP);
  const onPlanet = new Set(["s-leak-1", "s-leak-2", "s-chronic", "s-well"]);

  it("marks equal the sick sessions that have a house: never a healed or treated-only one", () => {
    const r = markSelection(sick, (id) => onPlanet.has(id));
    expect(r.marks.map((m) => m.agentId)).toEqual(["s-chronic", "s-leak-1", "s-leak-2"]); // worst first (chronic), then most recent
    expect(r.marks[0]).toEqual({ agentId: "s-chronic", worst: "chronic", kinds: ["broken-build"] });
    expect(r.unplaced).toBe(1); // s-retired: sick, but no house on the planet
    expect(r.unshown).toBe(0);
    const sickSessions = new Set(cases.filter((c) => ["open", "chronic", "exposed"].includes(c.state)).map((c) => c.sessionId));
    expect(r.marks.length + r.unplaced).toBe(sickSessions.size);
  });

  it("no data is no marks (never a guess); nobody sick is no marks", () => {
    expect(markSelection(null, () => true)).toEqual({ marks: [], unplaced: 0, unshown: 0 });
    expect(markSelection([], () => true)).toEqual({ marks: [], unplaced: 0, unshown: 0 });
  });

  it("caps at MAX_MARKS (the server's own sickness.open cap) and counts the rest; one mark per session", () => {
    expect(MAX_MARKS).toBe(SICKNESS_OPEN_CAP);
    const many: SicknessOpenEntry[] = Array.from({ length: 5 }, (_, i) => ({ agentId: `s${i}`, kinds: ["broken-build"], worst: "open", caseIds: [`c${i}`] }));
    const r = markSelection([...many, many[0]!], () => true, 3);
    expect(r.marks.map((m) => m.agentId)).toEqual(["s0", "s1", "s2"]);
    expect(r.unshown).toBe(2);
    expect(r.unplaced).toBe(0);
  });
});
