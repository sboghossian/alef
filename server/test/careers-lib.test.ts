// The careers state machine (careers-lib.ts) on real shapes: agents exactly as /api/world serves
// them (copied from a live snapshot, 2026-09-28), fossils as /api/archive serves them, and full
// OutcomeRecords as the outcomes feature builds them. automationKey is the real one, never stubbed.

import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../shared/types.js";
import type { ArchivedSession } from "../../shared/features/archive.js";
import type { OutcomeRecord, SessionOutcome } from "../../shared/features/outcomes.js";
import type { Routine } from "../../shared/features/routines.js";
import {
  careerFeedItem,
  cleanName,
  computeCareers,
  computeWorker,
  DAY_MS,
  departmentOf,
  emptyCareersFile,
  groupRuns,
  HOUR_MS,
  judgeRun,
  LAPSE_FLOOR_MS,
  lapseAfterMs,
  medianGapMs,
  parseCareersFile,
  recordOf,
  routineFor,
  runSources,
  summarize,
  type CareersFile,
  type RecordedCareer,
  type RunSource,
} from "../features/careers-lib.js";
import { parseCareersResponse, trendLine, trendSummaryLine } from "../../shared/features/careers.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const RECAP_TITLE = "You are the narrative step of Alex's /daily-recap. A deterministic script a…";
const BRIEF_TITLE = "yalla-brief /yalla-brief";

function sid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/** A dormant agent in the real /api/world shape, started `hoursAgo` before NOW. */
function agent(n: number, title: string, hoursAgo: number, status: WorldAgent["status"] = "dormant"): WorldAgent {
  const started = NOW - hoursAgo * HOUR_MS;
  return {
    id: sid(n),
    islandId: "alexboghossian",
    cwd: "/Users/alexboghossian",
    title,
    displayName: null,
    status,
    startedAt: new Date(started).toISOString(),
    lastActive: new Date(started + 2 * 60_000).toISOString(),
    messageCount: 20,
    model: "claude-sonnet-4-6",
    role: "writer",
    color: "#0891b2",
    targetIslandId: "alexboghossian",
    tokens: 71201,
    awaitingInput: false,
  };
}

function fossil(n: number, title: string, date: string): ArchivedSession {
  return { id: sid(n), title, date, project: "home", place: "topic:AUTO", note: `10-Sessions/claude-code/${date}-x.md` };
}

/** A full outcomes record, as outcomes-lib buildRecord makes one. */
function rec(n: number, outcome: SessionOutcome, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    sessionId: sid(n),
    outcome,
    reason: outcome === "failed" ? "API Error: The socket connection was closed unexpectedly." : outcome === "unknown" ? null : `${outcome} evidence`,
    evidenceAt: null,
    lastActive: new Date(NOW).toISOString(),
    toolCalls: 6,
    writes: 1,
    learnings: [],
    artifacts: [],
    prs: [],
    pushes: [],
    todos: null,
    ending: null,
    onDisk: true,
    pending: false,
    provisionalUntil: null,
    ...over,
  };
}

/** careers.json with /daily-recap retired at `retiredAt`. */
function retiredFile(retiredAt: string, name: string | null = null): CareersFile {
  return { version: 1, workers: { "/daily-recap": { retiredAt, name, updatedAt: retiredAt } } };
}

/** A clean run: outcomes' own "finished" (its todo list all completed), as buildRecord makes one. */
const clean = (n: number): OutcomeRecord => rec(n, "finished", { reason: "all 3 todo items completed", toolCalls: 6, writes: 1, todos: { total: 3, completed: 3 } });
/** Tool calls and a file edit, but no shipped / delivered / finished evidence: outcomes says "unknown". */
const wroteOnly = (n: number): OutcomeRecord => rec(n, "unknown", { toolCalls: 6, writes: 1 });
const empty = (n: number): OutcomeRecord => rec(n, "unknown", { toolCalls: 0, writes: 0 });
const readOnly = (n: number): OutcomeRecord => rec(n, "unknown", { toolCalls: 5, writes: 0 });

interface Case {
  agents?: WorldAgent[];
  fossils?: ArchivedSession[];
  records?: OutcomeRecord[];
  file?: CareersFile;
  routines?: Routine[];
  now?: number;
}

function careers(c: Case) {
  return computeCareers({
    runs: runSources(c.agents ?? [], c.fossils ?? []),
    records: new Map((c.records ?? []).map((r) => [r.sessionId, r])),
    file: c.file ?? emptyCareersFile(),
    routines: c.routines ?? [],
    nowMs: c.now ?? NOW,
  });
}

function only(c: Case) {
  const all = careers(c);
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** n daily /daily-recap runs, newest `startHoursAgo` ago, each judged by `judge(i)` (i = 0 newest). */
function daily(count: number, judge: (n: number, i: number) => OutcomeRecord | null, startHoursAgo = 2): Case {
  const agents: WorldAgent[] = [];
  const records: OutcomeRecord[] = [];
  for (let i = 0; i < count; i++) {
    agents.push(agent(i + 1, RECAP_TITLE, startHoursAgo + 24 * i));
    const r = judge(i + 1, i);
    if (r) records.push(r);
  }
  return { agents, records };
}

describe("run verdicts (judgeRun)", () => {
  const dormant = { archived: false, live: false };
  it("clean needs shipped / delivered / finished, and no bad ending", () => {
    expect(judgeRun(dormant, rec(1, "shipped", { writes: 0 })).verdict).toBe("clean");
    expect(judgeRun(dormant, rec(1, "delivered", { writes: 0 })).verdict).toBe("clean");
    expect(judgeRun(dormant, rec(1, "finished", { writes: 0 })).verdict).toBe("clean");
    expect(judgeRun(dormant, clean(1))).toMatchObject({ mark: "clean", verdict: "clean", why: "all 3 todo items completed" });
  });

  it("a run that only wrote files is 'wrote': a verdict, never clean (outcomes said unknown)", () => {
    expect(judgeRun(dormant, wroteOnly(1))).toEqual({ mark: "wrote", verdict: "wrote", why: "wrote 1 file edit: no shipped, delivered or finished evidence", awaiting: false });
    expect(judgeRun(dormant, rec(1, "unknown", { toolCalls: 31, writes: 2 })).why).toBe("wrote 2 file edits: no shipped, delivered or finished evidence");
  });

  it("empty-run detection: 0 tool calls is bad ('did nothing'), tool calls with no writes is no verdict", () => {
    expect(judgeRun(dormant, empty(1))).toEqual({ mark: "empty", verdict: "bad", why: "did nothing: 0 tool calls", awaiting: false });
    expect(judgeRun(dormant, readOnly(1))).toEqual({ mark: "unknown", verdict: null, why: "no outcome evidence: 5 tool calls, no writes", awaiting: false });
    // A failure is named for what it was, even with 0 tool calls.
    expect(judgeRun(dormant, rec(1, "failed", { toolCalls: 0, writes: 0 }))).toMatchObject({ mark: "failed", verdict: "bad", why: "API Error: The socket connection was closed unexpectedly." });
  });

  it("failed / stopped / abandoned are bad even when the run wrote files", () => {
    for (const o of ["failed", "stopped", "abandoned"] as const) expect(judgeRun(dormant, rec(1, o, { writes: 3 }))).toMatchObject({ mark: o, verdict: "bad" });
  });

  it("archived runs never count, even with a record saying shipped", () => {
    expect(judgeRun({ archived: true, live: false }, rec(1, "shipped"))).toMatchObject({ mark: "unknown", verdict: null, awaiting: false });
  });

  it("live, unscanned and half-read runs have no verdict; only the dormant ones await the scanner", () => {
    expect(judgeRun({ archived: false, live: true }, undefined)).toMatchObject({ verdict: null, awaiting: false });
    expect(judgeRun(dormant, undefined)).toMatchObject({ verdict: null, awaiting: true, why: "not scanned by outcomes yet" });
    expect(judgeRun(dormant, rec(1, "shipped", { pending: true }))).toMatchObject({ verdict: null, awaiting: true });
    expect(judgeRun(dormant, rec(1, "active"))).toMatchObject({ verdict: null, awaiting: true });
  });

  it("a verdict outcomes can still change by the clock alone is no verdict yet, and awaits it", () => {
    // A cut-off turn reads "finished" (or "unknown" with writes) until its stall bound, a question
    // until 24h; outcomes marks both provisional. Only a record it calls final counts.
    const until = "2026-09-28T12:30:00.000Z";
    for (const r of [clean(1), wroteOnly(1), empty(1), readOnly(1)]) {
      expect(judgeRun(dormant, { ...r, provisionalUntil: until })).toEqual({ mark: "unknown", verdict: null, why: "not final yet: outcomes may still call it cut off or abandoned (until 2026-09-28 12:30 UTC)", awaiting: true });
    }
    // A bad verdict is final: the clock never turns failed into anything else.
    expect(judgeRun(dormant, rec(1, "failed", { provisionalUntil: null }))).toMatchObject({ verdict: "bad", awaiting: false });
  });
});

describe("the state table", () => {
  it("enrolled: fewer than 3 runs with a verdict (runs without one don't count)", () => {
    const w = only({ ...daily(4, (n, i) => (i < 2 ? clean(n) : readOnly(n))) }).worker;
    expect(w).toMatchObject({ state: "enrolled", standing: "enrolled", reason: "2 runs with a verdict so far (needs 3)" });
  });

  it("enrolled: 3 or 4 runs with a verdict, all clean, is not 5 in a row yet", () => {
    expect(only(daily(4, (n) => clean(n))).worker).toMatchObject({ state: "enrolled", reason: "4 of 5 clean runs in a row toward trusted", trustedSince: null });
  });

  it("trusted: the last 5 runs with a verdict are all clean; trustedSince is the run that completed the 5", () => {
    const c = daily(7, (n) => clean(n));
    const w = only(c).worker;
    expect(w.state).toBe("trusted");
    expect(w.reason).toBe("last 5 runs with a verdict all clean (7 in a row)");
    expect(w.trustedSince).toBe(c.agents![2]!.startedAt); // runs 7,6,5,4,3 (oldest first) made the first 5: run 3 completed it
  });

  it("trusted: runs with no verdict in between are skipped, not held against it", () => {
    const w = only(daily(8, (n, i) => (i % 2 ? readOnly(n) : clean(n)))).worker; // 4 clean, 4 read-only
    expect(w.standing).toBe("enrolled");
    const w2 = only(daily(10, (n, i) => (i % 2 ? readOnly(n) : clean(n)))).worker; // 5 clean
    expect(w2.standing).toBe("trusted");
  });

  it("probation: one bad run in the last 5 with a verdict, with the latest bad run's reason", () => {
    const w = only(daily(6, (n, i) => (i === 1 ? rec(n, "failed") : i === 3 ? empty(n) : clean(n)))).worker;
    expect(w).toMatchObject({ state: "probation", reason: "failed: API Error: The socket connection was closed unexpectedly." });
    const w2 = only(daily(6, (n, i) => (i === 2 ? empty(n) : clean(n)))).worker;
    expect(w2.reason).toBe("did nothing: 0 tool calls");
  });

  it("writes alone never make it trusted: /artifact-ritual's real records, plus 2 more of the same shape", () => {
    // ✅ 2026-09-28 via GET /api/outcomes/:id: its 4 runs that wrote (only LAST_RUN.md; a324ebda also a
    // memory file) are outcome "unknown"; the other 2 were cut off. Each wrote run's transcript ends
    // "the ritual could not run" / "nothing was republished": nothing shipped, delivered or finished.
    const title = "artifact-ritual /artifact-ritual -- headless run, nobody is there to answer. Co…";
    const runs: Array<[string, string, Partial<OutcomeRecord> & { outcome: SessionOutcome }]> = [
      ["44ac7877", "2026-09-23T05:02:57.300Z", { outcome: "unknown", toolCalls: 16, writes: 1 }],
      ["a96c2446", "2026-09-24T09:55:14.401Z", { outcome: "failed", reason: "cut off: a tool call never returned", toolCalls: 1, writes: 0 }],
      ["8960e2fb", "2026-09-25T05:39:35.753Z", { outcome: "failed", reason: "cut off: no reply after a tool result", toolCalls: 6, writes: 0 }],
      ["8d633ba1", "2026-09-26T05:00:10.109Z", { outcome: "unknown", toolCalls: 14, writes: 1 }],
      ["357935a2", "2026-09-27T05:04:52.732Z", { outcome: "unknown", toolCalls: 16, writes: 1 }],
      ["a324ebda", "2026-09-28T05:01:21.786Z", { outcome: "unknown", toolCalls: 31, writes: 2, learnings: ["/Users/alexboghossian/.claude/projects/-Users-alexboghossian/memory/feedback_headless_claude_permission_gate.md"] }],
      ["aaaaaaa1", "2026-09-29T05:01:00.000Z", { outcome: "unknown", toolCalls: 16, writes: 1 }],
      ["aaaaaaa2", "2026-09-30T05:01:00.000Z", { outcome: "unknown", toolCalls: 16, writes: 1 }],
    ];
    const now = Date.parse("2026-09-30T06:00:00.000Z");
    const id = (short: string): string => `${short}-0000-4000-8000-000000000000`;
    const agents = runs.map(([s, at]): WorldAgent => ({ ...agent(0, title, 0), id: id(s), startedAt: at, lastActive: at }));
    const records = runs.map(([s, , r]): OutcomeRecord => ({ ...rec(0, r.outcome, r), sessionId: id(s), reason: r.reason ?? null }));
    const before = only({ agents: agents.slice(0, 6), records, now: Date.parse("2026-09-28T06:00:00.000Z") });
    expect(before.worker.state).toBe("probation");
    const c = only({ agents, records, now });
    expect(c.worker.key).toBe("/artifact-ritual");
    expect(c.worker.runs.slice(0, 5).map((r) => r.mark)).toEqual(["wrote", "wrote", "wrote", "wrote", "wrote"]);
    expect(c.worker).toMatchObject({ state: "enrolled", trustedSince: null, lifetime: { total: 8, clean: 0, wrote: 6, bad: 2 } });
    expect(c.worker.reason).toBe("0 of 5 clean runs in a row toward trusted (its last 5 only wrote files: no shipped, delivered or finished evidence)");
    expect(careerFeedItem(recordOf(before), c, new Date(now).toISOString())).toBeNull(); // never "🎓 graduated"
  });

  it("a wrote run still counts toward probation's window and the 3-run minimum", () => {
    const w = only(daily(6, (n, i) => (i === 4 ? rec(n, "failed") : wroteOnly(n)))).worker;
    expect(w).toMatchObject({ state: "probation", reason: "failed: API Error: The socket connection was closed unexpectedly." });
    expect(only(daily(3, (n) => wroteOnly(n))).worker.reason).toBe("0 of 5 clean runs in a row toward trusted (its last 3 only wrote files: no shipped, delivered or finished evidence)");
    const mixed = only(daily(6, (n, i) => (i < 2 ? clean(n) : wroteOnly(n)))).worker;
    expect(mixed).toMatchObject({ state: "enrolled", reason: "2 of 5 clean runs in a row toward trusted (3 of its last 5 only wrote files: no shipped, delivered or finished evidence)" });
  });

  it("a bad run older than the last 5 with a verdict no longer holds it back", () => {
    expect(only(daily(6, (n, i) => (i === 5 ? empty(n) : clean(n)))).worker.standing).toBe("trusted");
  });

  it("lapsed wins over every standing once no run came for the lapse window", () => {
    const trustedButQuiet = daily(6, (n) => clean(n), 80); // daily cadence: lapses after 72h; last run 80h ago
    expect(only(trustedButQuiet).worker).toMatchObject({ state: "lapsed", standing: "lapsed" });
    expect(only(trustedButQuiet).worker.reason).toMatch(/^stopped reporting: no run since 2026-09-2\d \(lapses after 72h without one\)$/);
    expect(only(daily(6, (n) => clean(n), 70)).worker.state).toBe("trusted");
  });

  it("retired until a run starts after retiredAt, then returned (with its standing in the reason)", () => {
    const c = daily(6, (n) => clean(n), 30);
    const retiredAt = new Date(NOW - 10 * HOUR_MS).toISOString();
    const file = retiredFile(retiredAt);
    const retired = only({ ...c, file }).worker;
    expect(retired).toMatchObject({ state: "retired", standing: "trusted", retiredAt });
    expect(retired.reason).toContain("only changes what Alef shows");

    const ranAgain = { ...c, file, agents: [agent(99, RECAP_TITLE, 1), ...c.agents!], records: [...c.records!, clean(99)] };
    const back = only(ranAgain).worker;
    expect(back.state).toBe("returned");
    expect(back.reason).toMatch(/^ran again \d{4}-\d{2}-\d{2} after you retired it on 2026-09-28 · trusted: /);
  });

  it("an archived run dated the retirement day never reads as returned (a day-only run counts from its day's start)", () => {
    const retiredAt = new Date(NOW).toISOString();
    const file = retiredFile(retiredAt);
    const w = only({ fossils: [fossil(1, RECAP_TITLE, "2026-09-28")], file, now: NOW + HOUR_MS }).worker;
    expect(w.state).toBe("retired");
  });

  it("archived runs count in lifetime but never toward a verdict", () => {
    const fossils = [1, 2, 3, 4, 5, 6].map((n) => fossil(n, "<command-message>inbox-operator</command-message> <command-name>/inbox-operator</command-name>", `2026-09-2${n}`));
    const w = only({ fossils, records: fossils.map((f, i) => rec(i + 1, "shipped")) }).worker;
    expect(w.key).toBe("/inbox-operator");
    expect(w).toMatchObject({ state: "enrolled", lifetime: { total: 6, live: 0, archived: 6, clean: 0, bad: 0 } });
    expect(w.runs.every((r) => r.mark === "unknown" && r.archived && r.dayOnly)).toBe(true);
  });

  it("the strip is the last 10 runs, newest first, and summarize counts every state", () => {
    const all = careers({ ...daily(12, (n) => clean(n)), fossils: [fossil(50, BRIEF_TITLE, "2026-09-01")] });
    const recap = all.find((w) => w.worker.key === "/daily-recap")!.worker;
    expect(recap.runs).toHaveLength(10);
    expect(recap.runs[0]!.id).toBe(sid(1));
    expect(recap.lastRunAt).toBe(new Date(NOW - 2 * HOUR_MS).toISOString());
    const s = summarize(all.map((w) => w.worker));
    expect(s).toEqual({ trusted: 1, probation: 0, enrolled: 0, lapsed: 1, returned: 0, retired: 0, total: 2 });
  });

  it("is unsettled while any run that could enter its standing window awaits its verdict", () => {
    const c = daily(6, (n, i) => (i === 0 ? null : clean(n)));
    expect(only(c).awaiting).toBe(1);
    const live = { ...c, agents: [agent(1, RECAP_TITLE, 2, "live"), ...c.agents!.slice(1)] };
    expect(only(live).awaiting).toBe(0);
    // 3 newest runs have no verdict (read-only), 2 clean, then unscanned ones: the window reaches them.
    const reach = daily(8, (n, i) => (i < 3 ? readOnly(n) : i < 5 ? clean(n) : null));
    expect(only(reach).awaiting).toBe(3);
    // Unscanned runs older than the 5th run with a verdict can't move it.
    const deep = daily(8, (n, i) => (i < 5 ? clean(n) : null));
    expect(only(deep).awaiting).toBe(0);
  });
});

describe("cadence and the 72h floor", () => {
  it("median gap with irregular gaps (odd and even counts) and a single run", () => {
    const h = (x: number): number => x * HOUR_MS;
    expect(medianGapMs([0, h(1), h(25), h(50), h(52), h(82)])).toBe(h(24)); // gaps 1,24,25,2,30 → 24
    expect(medianGapMs([0, h(2), h(12), h(40)])).toBe(h(10)); // gaps 2,10,28 → 10
    expect(medianGapMs([h(40), 0, h(12), h(2)])).toBe(h(10)); // order doesn't matter
    expect(medianGapMs([0, h(1), h(4), h(10)])).toBe(h(3)); // gaps 1,3,6 → 3
    expect(medianGapMs([0, h(1), h(4), h(10), h(20)])).toBe(h(4.5)); // gaps 1,3,6,10 → (3+6)/2
    expect(medianGapMs([h(5)])).toBeNull();
    expect(medianGapMs([])).toBeNull();
  });

  it("lapse window is max(3 × median, 72h)", () => {
    expect(lapseAfterMs(null)).toBe(LAPSE_FLOOR_MS);
    expect(lapseAfterMs(HOUR_MS)).toBe(LAPSE_FLOOR_MS); // hourly: 3h < floor
    expect(lapseAfterMs(24 * HOUR_MS)).toBe(72 * HOUR_MS);
    expect(lapseAfterMs(7 * DAY_MS)).toBe(21 * DAY_MS); // weekly: 3 weeks
  });

  it("an hourly worker is not lapsed after 71h, and is after 73h (the floor, not 3h)", () => {
    const hourly = (lastHoursAgo: number): Case => ({ agents: [0, 1, 2, 3].map((i) => agent(i + 1, BRIEF_TITLE, lastHoursAgo + i)), records: [1, 2, 3, 4].map(clean) });
    expect(only(hourly(71)).worker).toMatchObject({ medianGapMs: HOUR_MS, lapseAfterMs: LAPSE_FLOOR_MS });
    expect(only(hourly(71)).worker.state).not.toBe("lapsed");
    expect(only(hourly(73)).worker.state).toBe("lapsed");
  });

  it("a single run: no cadence, and it lapses 72h after it", () => {
    const one = (h: number): Case => ({ agents: [agent(1, BRIEF_TITLE, h)], records: [clean(1)] });
    expect(only(one(10)).worker).toMatchObject({ medianGapMs: null, lapseAfterMs: LAPSE_FLOOR_MS, state: "enrolled" });
    expect(only(one(73)).worker.state).toBe("lapsed");
  });

  it("a day-only archived run counts as late as its day's end for lapsing", () => {
    // 2026-09-25 local; its end is 2026-09-26 00:00 local. 72h after that is the 29th: not lapsed on the 28th.
    const w = only({ fossils: [fossil(1, BRIEF_TITLE, "2026-09-25")], now: new Date(2026, 8, 28, 20).getTime() }).worker;
    expect(w.state).toBe("enrolled");
    expect(only({ fossils: [fossil(1, BRIEF_TITLE, "2026-09-25")], now: new Date(2026, 8, 29, 1).getTime() }).worker.state).toBe("lapsed");
  });
});

describe("departments and routines", () => {
  it("maps the listed lineages and falls back to Operations", () => {
    expect(departmentOf("/daily-recap")).toBe("Reports & Briefs");
    expect(departmentOf("⏰ acme-inbox-scan")).toBe("Inbox desk");
    expect(departmentOf("eval-harness")).toBe("Research library");
    expect(departmentOf("/upskill")).toBe("Institute");
    expect(departmentOf("fleet-probe")).toBe("Control room");
    expect(departmentOf("/linear")).toBe("Operations");
    expect(departmentOf("⏰ pe-biotech-competitor-scan")).toBe("Operations");
    expect(departmentOf("__proto__")).toBe("Operations");
    expect(departmentOf("toString")).toBe("Operations");
  });

  it("links a routine only by the exact com.stephane.<slug> shortName", () => {
    const r = (shortName: string, lastExitStatus: number | null = 0): Routine => ({
      label: `com.stephane.${shortName}`,
      shortName,
      program: "/bin/zsh",
      schedule: { kind: "calendar", text: "daily 08:10", nextRunAt: null },
      running: false,
      lastExitStatus,
      ranRecently: false,
      skillDescription: null,
    });
    const routines = [r("daily-recap-v2"), r("daily-recap"), r("rss-feed-obsidian", 2)];
    expect(routineFor("/daily-recap", routines)?.label).toBe("com.stephane.daily-recap");
    expect(routineFor("⏰ rss-feed-obsidian", routines)?.lastExitStatus).toBe(2);
    expect(routineFor("/daily", routines)).toBeNull();
    const w = only({ ...daily(1, (n) => clean(n)), routines }).worker;
    expect(w.routine).toEqual({ label: "com.stephane.daily-recap", schedule: "daily 08:10", lastExitStatus: 0, running: false });
  });

  it("an exit 0 routine never makes a run clean", () => {
    const routines: Routine[] = [{ label: "com.stephane.daily-recap", shortName: "daily-recap", program: "x", schedule: { kind: "calendar", text: "daily", nextRunAt: null }, running: false, lastExitStatus: 0, ranRecently: true, skillDescription: null }];
    const w = only({ ...daily(5, (n) => empty(n)), routines }).worker;
    expect(w.state).toBe("probation");
    expect(w.lifetime.clean).toBe(0);
  });
});

describe("runs and grouping", () => {
  it("groups by the real automationKey over agent and fossil titles, each id once (the agent's)", () => {
    const runs: RunSource[] = runSources(
      [agent(1, RECAP_TITLE, 2), agent(2, "fix the build please", 3), agent(3, BRIEF_TITLE, 4)],
      [fossil(1, RECAP_TITLE, "2026-09-01"), fossil(4, "History: Task: Pull every indemnificat...", "2026-07-25")],
    );
    const g = groupRuns(runs);
    expect([...g.keys()].sort()).toEqual(["/daily-recap", "/yalla-brief", "eval-harness"]);
    expect(g.get("/daily-recap")).toHaveLength(1);
    expect(g.get("/daily-recap")![0]!.archived).toBe(false);
  });

  it("a fossil without a date counts in lifetime but not on the strip", () => {
    const w = only({ fossils: [fossil(1, BRIEF_TITLE, "")] }).worker;
    expect(w.lifetime.total).toBe(1);
    expect(w.runs).toEqual([]);
    expect(w.lastRunAt).toBeNull();
  });
});

describe("careers.json", () => {
  it("anything that isn't the file's shape is null (read as empty); a bad entry alone is dropped", () => {
    for (const raw of [null, "x", [], { version: 2, workers: {} }, { version: 1, workers: [] }, { version: 1 }]) expect(parseCareersFile(raw)).toBeNull();
    const f = parseCareersFile({
      version: 1,
      workers: {
        "/daily-recap": { retiredAt: "2026-09-28T10:00:00.000Z", name: "Quill\n\u0007", updatedAt: "2026-09-28T10:00:00.000Z" },
        "/yalla-brief": { retiredAt: "yesterday", name: null, updatedAt: "2026-09-28T10:00:00.000Z" },
        "/upskill": "retired",
      },
    });
    expect(Object.keys(f!.workers)).toEqual(["/daily-recap"]);
    expect(f!.workers["/daily-recap"]!.name).toBe("Quill");
  });

  it("names are one clean line of at most 40 characters", () => {
    expect(cleanName("  Carillon\tthe\n bell  ")).toBe("Carillon the bell");
    expect(cleanName(" \n ")).toBeNull();
    expect(cleanName("x".repeat(80))).toHaveLength(40);
  });
});

describe("Feed items (careerFeedItem)", () => {
  const iso = new Date(NOW).toISOString();
  /** A recorded state; `verdicts` = what its verdicts said (defaults to the standing, or trusted when lapsed). */
  const was = (standing: RecordedCareer["standing"], verdicts?: RecordedCareer["verdictStanding"], state: RecordedCareer["state"] = standing): RecordedCareer => ({
    state,
    standing,
    verdictStanding: verdicts ?? (standing === "lapsed" ? "trusted" : standing),
  });

  it("into trusted: the graduation line with the department", () => {
    const item = careerFeedItem(was("enrolled"), only(daily(5, (n) => clean(n))), iso);
    expect(item).toMatchObject({ kind: "graduation", title: "🎓 /daily-recap graduated: 5 clean runs in a row · Reports & Briefs", tag: "career-trusted", agentId: sid(1) });
  });

  it("into probation: 'back on probation' from trusted, 'on probation' from enrolled", () => {
    const c = only(daily(5, (n, i) => (i === 0 ? empty(n) : clean(n))));
    expect(careerFeedItem(was("trusted"), c, iso)?.title).toBe("↩ /daily-recap back on probation: did nothing: 0 tool calls");
    expect(careerFeedItem(was("enrolled"), c, iso)?.title).toBe("↩ /daily-recap on probation: did nothing: 0 tool calls");
  });

  it("an older run's late failure still puts it on probation (whichever run's verdict landed last)", () => {
    // Run 1 (newest) clean was already judged; run 3, older and long, only now lands failed.
    const c = only(daily(6, (n, i) => (i === 2 ? rec(n, "failed") : clean(n))));
    const item = careerFeedItem(was("trusted"), c, iso);
    expect(item?.title).toMatch(/^↩ \/daily-recap back on probation: failed: API Error: The socket connection was…$/); // capped at 80
    expect(item?.detail).toBe("failed: API Error: The socket connection was closed unexpectedly.");
  });

  it("into lapsed: 'stopped reporting' with the last run's day, only for a worker with 3+ runs with a verdict", () => {
    expect(careerFeedItem(was("trusted"), only(daily(3, (n) => clean(n), 100)), iso)?.title).toMatch(/^💤 \/daily-recap stopped reporting \(last run 2026-09-2\d\)$/);
    // A slash command typed by hand twice has no record to stop.
    expect(careerFeedItem(was("enrolled"), only(daily(2, (n) => clean(n), 100)), iso)).toBeNull();
    // Already lapsed: nothing new.
    expect(careerFeedItem(was("lapsed"), only(daily(3, (n) => clean(n), 100)), iso)).toBeNull();
  });

  it("nothing for enrolled, no change, or while retired", () => {
    expect(careerFeedItem(was("trusted"), only(daily(1, (n) => clean(n))), iso)).toBeNull();
    expect(careerFeedItem(was("trusted"), only(daily(5, (n) => clean(n))), iso)).toBeNull();
    const retired = only({ ...daily(5, (n) => clean(n), 30), file: retiredFile(new Date(NOW - 10 * HOUR_MS).toISOString(), "Quill") });
    expect(retired.worker.state).toBe("retired");
    expect(careerFeedItem(was("enrolled"), retired, iso)).toBeNull();
  });

  it("running again after a retirement is one line, even when the retire and the run fell between two ticks", () => {
    const back = only({ ...daily(5, (n) => clean(n), 1), file: retiredFile(new Date(NOW - 10 * HOUR_MS).toISOString(), "Quill") });
    expect(back.worker.state).toBe("returned");
    expect(careerFeedItem(was("trusted", "trusted", "retired"), back, iso)?.title).toBe("↺ Quill (/daily-recap) ran again after you retired it");
    expect(careerFeedItem(was("trusted"), back, iso)?.title).toBe("↺ Quill (/daily-recap) ran again after you retired it"); // never recorded as retired
    expect(careerFeedItem(was("trusted", "trusted", "returned"), back, iso)).toBeNull();
  });

  it("leaving a lapse on the same verdicts is neither a second graduation nor probation again", () => {
    const trustedQuiet = daily(6, (n) => clean(n), 80);
    const settled = recordOf(only(trustedQuiet));
    expect(settled).toEqual({ state: "lapsed", standing: "lapsed", verdictStanding: "trusted" });
    // Seen live by a tick, or finished between two ticks and landed clean: either way, no news.
    const liveAgain = { ...trustedQuiet, agents: [agent(99, RECAP_TITLE, 0.2, "live"), ...trustedQuiet.agents!] };
    expect(careerFeedItem(settled, only(liveAgain), iso)).toBeNull();
    const landedClean = { ...trustedQuiet, agents: [agent(99, RECAP_TITLE, 0.2), ...trustedQuiet.agents!], records: [...trustedQuiet.records!, clean(99)] };
    expect(only(landedClean).worker.standing).toBe("trusted");
    expect(careerFeedItem(settled, only(landedClean), iso)).toBeNull();

    // An old bad run still in its window: coming back clean is not "on probation" again.
    const badQuiet = daily(6, (n, i) => (i === 0 ? rec(n, "failed") : clean(n)), 80);
    const settledBad = recordOf(only(badQuiet));
    const badBack = { ...badQuiet, agents: [agent(99, RECAP_TITLE, 0.2), ...badQuiet.agents!], records: [...badQuiet.records!, clean(99)] };
    expect(only(badBack).worker.standing).toBe("probation");
    expect(careerFeedItem(settledBad, only(badBack), iso)).toBeNull();

    // A new bad run that changes what the verdicts say is news.
    const landedBad = { ...trustedQuiet, agents: [agent(99, RECAP_TITLE, 0.2), ...trustedQuiet.agents!], records: [...trustedQuiet.records!, empty(99)] };
    expect(careerFeedItem(settled, only(landedBad), iso)?.title).toBe("↩ /daily-recap back on probation: did nothing: 0 tool calls");
  });

  it("titles are sanitized: markup in a failure reason never reaches the Feed as tags", () => {
    const c = only(daily(5, (n, i) => (i === 0 ? rec(n, "failed", { reason: 'API Error: <img src=x onerror="alert(1)"> boom' }) : clean(n))));
    const item = careerFeedItem(was("trusted"), c, iso)!;
    expect(item.title).not.toContain("<img");
    expect(item.detail).not.toContain("<img");
    expect(item.title.length).toBeLessThanOrEqual(80);
  });

  it("computeWorker is the same worker computeCareers returns", () => {
    const c = daily(3, (n) => clean(n));
    const runs = runSources(c.agents!, []);
    const direct = computeWorker("/daily-recap", runs, { records: new Map(c.records!.map((r) => [r.sessionId, r])), file: emptyCareersFile(), routines: [], nowMs: NOW });
    expect(direct).toEqual(only(c));
  });
});

describe("the trend (trendOf): clean rate of the last 10 runs with a verdict vs the 10 before", () => {
  it("20 judged runs: 7 of the newest 10 clean vs 2 of the 10 before is +50 pts, each window with its span", () => {
    // i = 0 is the newest run (2h ago), one run a day before that.
    const c = daily(20, (n, i) => (i < 10 ? (i < 7 ? clean(n) : wroteOnly(n)) : i < 12 ? clean(n) : rec(n, "failed")));
    const t = only(c).trend;
    expect(t.verdictRuns).toBe(20);
    expect(t.recent).toEqual({ runs: 10, clean: 7, from: new Date(NOW - (2 + 24 * 9) * HOUR_MS).toISOString(), to: new Date(NOW - 2 * HOUR_MS).toISOString() });
    expect(t.prior).toEqual({ runs: 10, clean: 2, from: new Date(NOW - (2 + 24 * 19) * HOUR_MS).toISOString(), to: new Date(NOW - (2 + 24 * 10) * HOUR_MS).toISOString() });
    expect(t.deltaPts).toBe(50);
    expect(trendLine(t)).toBe(
      "Last 10 runs with a verdict: 7 of 10 clean (70%, 2026-09-19 – 2026-09-28) vs the 10 before: 2 of 10 clean (20%, 2026-09-09 – 2026-09-18). Better by 50 pts.",
    );
  });

  it("a worker that got worse, and one that didn't move, are both measured", () => {
    const worse = only(daily(20, (n, i) => (i < 10 ? rec(n, "failed") : clean(n)))).trend;
    expect(worse.deltaPts).toBe(-100);
    expect(trendLine(worse)).toMatch(/Worse by 100 pts\.$/);
    // /daily-recap on 2026-09-28: 20 judged runs, every one only wrote files → 0% vs 0%.
    const flat = only(daily(20, (n) => wroteOnly(n))).trend;
    expect(flat).toMatchObject({ deltaPts: 0, recent: { runs: 10, clean: 0 }, prior: { runs: 10, clean: 0 } });
    expect(trendLine(flat)).toMatch(/No change\.$/);
  });

  it("runs with no verdict are in neither window: live, archived, unscanned and read-only runs are skipped, not counted as not clean", () => {
    // 25 runs: every 5th has no verdict (a read-only run), so 20 have one.
    const c = daily(25, (n, i) => (i % 5 === 4 ? readOnly(n) : i < 12 ? clean(n) : wroteOnly(n)));
    const t = only(c).trend;
    expect(t.verdictRuns).toBe(20);
    // The newest 10 judged are i = 0..3, 5..8, 10, 11 (all clean); the 10 before are i = 12, 13, 15..18, 20..23 (only wrote).
    expect(t.recent).toMatchObject({ runs: 10, clean: 10 });
    expect(t.prior).toMatchObject({ runs: 10, clean: 0 });
    expect(t.deltaPts).toBe(100);
    // Archived runs never have a verdict, however many there are.
    const fossils = Array.from({ length: 30 }, (_, i) => fossil(100 + i, RECAP_TITLE, `2026-08-${String(1 + i).padStart(2, "0")}`));
    expect(only({ fossils }).trend).toEqual({ key: "/daily-recap", verdictRuns: 0, recent: { runs: 0, clean: 0, from: null, to: null }, prior: { runs: 0, clean: 0, from: null, to: null }, deltaPts: null });
    expect(trendLine(only({ fossils }).trend)).toBe("No trend: no run with a verdict yet.");
  });

  it("no delta until both windows are full: 17 judged runs show the newest 10 and say what's missing", () => {
    // /yalla-brief on 2026-09-28 had 17 runs with a verdict.
    const t = only(daily(17, (n, i) => (i === 3 ? clean(n) : wroteOnly(n)))).trend;
    expect(t).toMatchObject({ verdictRuns: 17, recent: { runs: 10, clean: 1 }, prior: { runs: 7, clean: 0 }, deltaPts: null });
    expect(trendLine(t)).toBe("Last 10 runs with a verdict: 1 of 10 clean (10%, 2026-09-19 – 2026-09-28). Nothing to compare yet: 7 of the 10 before them.");
    expect(trendLine(only(daily(4, (n) => clean(n))).trend)).toBe("No trend yet: 4 runs with a verdict (a trend compares the last 10 with the 10 before).");
  });

  it("only the newest 20 judged runs count: older history can't dilute the trend", () => {
    const t = only(daily(35, (n, i) => (i < 10 ? clean(n) : i < 20 ? wroteOnly(n) : clean(n)))).trend;
    expect(t).toMatchObject({ verdictRuns: 35, recent: { clean: 10 }, prior: { clean: 0 }, deltaPts: 100 });
  });

  it("the Tower's summary counts only workers with both windows full", () => {
    const measured = careers({
      agents: [...daily(20, (n, i) => (i < 10 ? clean(n) : wroteOnly(n))).agents!, agent(500, BRIEF_TITLE, 3)],
      records: [...daily(20, (n, i) => (i < 10 ? clean(n) : wroteOnly(n))).records!, clean(500)],
    }).map((w) => w.trend);
    expect(measured.map((t) => t.key).sort()).toEqual(["/daily-recap", "/yalla-brief"]);
    expect(trendSummaryLine(measured)).toBe("Getting better? 1 of 2 workers has 20+ runs with a verdict to compare: 1 better, 0 worse, 0 no change (clean rate, last 10 vs the 10 before).");
    expect(trendSummaryLine([])).toBe("Getting better? 0 of 0 workers have 20+ runs with a verdict to compare.");
  });

  it("parseCareersResponse keeps valid trends, drops malformed ones, and reads a missing list as none", () => {
    const good = only(daily(20, (n) => clean(n))).trend;
    const base = { ok: true, at: new Date(NOW).toISOString(), inputs: { liveRuns: 1, archivedRuns: 0, archiveLoaded: true, outcomeRecords: 1, routines: 0 }, summary: summarize([]), workers: [] };
    expect(parseCareersResponse({ ...base, trends: [good, { ...good, recent: { ...good.recent, clean: 11 } }, { key: 1 }] })?.trends).toEqual([good]);
    expect(parseCareersResponse(base)?.trends).toEqual([]);
  });
});
