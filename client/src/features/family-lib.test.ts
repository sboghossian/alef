import { describe, expect, it } from "vitest";
import { crewCounts as sharedCrewCounts, shipCrews as sharedShipCrews } from "../../../shared/features/crews";
import { parseSubagentList, type SubagentRecord } from "../../../shared/features/subagents";
import { CrewCache, crewCounts, crewsFor, familyOf, generationLine, noCrewText, parseOutcomePrs, parseRecordsScan, shipCrews, townCrewLine, treeRows, type RecordsScan, type SessionPrs } from "./family-lib";

const S = "5a1157ca-9872-479d-b350-993efc43de69";
const OTHER = "0b6e3750-8026-4c25-91e8-a5df3dc16a2b";
const t = (min: number): string => new Date(Date.parse("2026-09-28T08:00:00.000Z") + min * 60_000).toISOString();

/** One record exactly as GET /api/subagents serves it (then through the client's own validator). */
function wire(id: string, o: { parent?: string | null; session?: string; depth?: number; at?: number; status?: string; description?: string } = {}): unknown {
  return {
    id,
    parentSessionId: o.session ?? S,
    parentAgentId: o.parent ?? null,
    workflowId: null,
    description: o.description ?? `task ${id}`,
    agentType: "general-purpose",
    model: "claude-sonnet-5",
    status: o.status ?? "done",
    reason: null,
    startedAt: t(o.at ?? 0),
    lastActive: t((o.at ?? 0) + 5),
    tokens: 1200,
    toolCounts: { Read: 3 },
    files: [{ path: "/repo/a.ts", count: 2 }],
    depth: o.depth ?? (o.parent ? 2 : 1),
  };
}

function records(...raw: unknown[]): SubagentRecord[] {
  const list = parseSubagentList(raw);
  expect(list).toHaveLength(raw.length); // every fixture is a valid wire record
  return list;
}

describe("familyOf: parent session → children → grandchildren", () => {
  // c2's child g1 started before c2's younger sibling c3: a flat start-time sort would draw g1 under
  // the wrong parent.
  const recs = records(
    wire("c1", { at: 0 }),
    wire("c2", { at: 10 }),
    wire("g1", { parent: "c2", at: 12 }),
    wire("c3", { at: 11 }),
    wire("x1", { session: OTHER, at: 1 }),
  );

  it("links by parentAgentId, keeps only this session's records, counts generations by depth", () => {
    const f = familyOf(recs, S);
    expect(f.size).toBe(4);
    expect(f.roots.map((n) => n.record.id)).toEqual(["c1", "c2", "c3"]);
    expect(f.roots[1]?.children.map((n) => n.record.id)).toEqual(["g1"]);
    expect(f.byDepth).toEqual({ 1: 3, 2: 1 });
    expect(f.generations).toBe(3);
    expect(generationLine(f)).toBe("3 generations: 1 session → 3 children → 1 grandchild");
  });

  it("draws a grandchild right under its real parent", () => {
    const { rows, hidden } = treeRows(familyOf(recs, S), { limit: 30 });
    expect(rows.map((r) => [r.record.id, r.level])).toEqual([
      ["c1", 1],
      ["c2", 1],
      ["g1", 2],
      ["c3", 1],
    ]);
    expect(rows.find((r) => r.record.id === "c2")?.kids).toBe(1);
    expect(hidden).toBe(0);
  });

  it("a record seen twice (snapshot, then ?parent=) counts once", () => {
    const f = familyOf([...recs, ...records(wire("c1", { at: 0, status: "running" }))], S);
    expect(f.size).toBe(4);
    expect(f.roots[0]?.record.status).toBe("running"); // the later copy wins, like the client store
  });

  it("a session with no subagents is one generation, and says so", () => {
    const f = familyOf(recs, "no-such-session");
    expect(f).toMatchObject({ size: 0, generations: 1, roots: [] });
    expect(generationLine(f)).toBe("1 generation: no subagent of this session is on record.");
  });
});

describe("familyOf: broken links are still drawn, once", () => {
  it("a grandchild whose parent isn't loaded sits under the session, marked, and still counts as generation 3", () => {
    const f = familyOf(records(wire("c1", { at: 0 }), wire("g9", { parent: "not-loaded", at: 3 })), S);
    expect(f.roots.map((n) => [n.record.id, n.orphan])).toEqual([
      ["c1", false],
      ["g9", true],
    ]);
    expect(f.generations).toBe(3);
    expect(generationLine(f)).toBe("3 generations: 1 session → 1 child → 1 grandchild");
  });

  it("a parentAgentId cycle (or a self-parent) terminates and draws every record exactly once", () => {
    const f = familyOf(records(wire("a", { parent: "b", at: 1 }), wire("b", { parent: "a", at: 2 }), wire("s", { parent: "s", at: 3 })), S);
    const { rows } = treeRows(f, { limit: 30 });
    expect(rows.map((r) => r.record.id).sort()).toEqual(["a", "b", "s"]);
    expect(rows.filter((r) => r.orphan).map((r) => r.record.id).sort()).toEqual(["a", "s"]);
  });
});

describe("treeRows: a big family under a row limit", () => {
  // 40 children; c05 has 2 children; the focused drone is c30's child f1; c38 is running.
  const raw: unknown[] = [];
  for (let i = 0; i < 40; i++) raw.push(wire(`c${String(i).padStart(2, "0")}`, { at: i, status: i === 38 ? "running" : "done" }));
  raw.push(wire("k1", { parent: "c05", at: 5.5 }), wire("k2", { parent: "c05", at: 5.6 }), wire("f1", { parent: "c30", at: 30.5 }));
  const fam = familyOf(records(...raw), S);

  it("keeps the focused drone with its whole line, running ones and the branches, within the limit", () => {
    const { rows, hidden } = treeRows(fam, { focusId: "f1", limit: 10 });
    const ids = rows.map((r) => r.record.id);
    expect(ids.length).toBe(10);
    expect(hidden).toBe(fam.size - 10);
    for (const must of ["c30", "f1", "c38", "c05", "k1", "k2"]) expect(ids).toContain(must);
    expect(rows.find((r) => r.record.id === "f1")).toMatchObject({ focus: true, level: 2 });
    expect(rows.filter((r) => r.focus)).toHaveLength(1);
    // Tree order holds: every level-2 row comes right after its parent or a sibling.
    expect(ids.indexOf("k1")).toBe(ids.indexOf("c05") + 1);
    expect(ids.indexOf("f1")).toBe(ids.indexOf("c30") + 1);
  });

  it("never draws a row without its parent, even at a tiny limit", () => {
    const { rows } = treeRows(fam, { limit: 3 });
    const ids = new Set(rows.map((r) => r.record.id));
    for (const r of rows) if (r.record.parentAgentId) expect(ids.has(r.record.parentAgentId)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("a focus id outside the family focuses nothing", () => {
    const { rows } = treeRows(fam, { focusId: "someone-else", limit: 5 });
    expect(rows.some((r) => r.focus)).toBe(false);
    expect(rows).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- crews

/** GET /api/outcomes' `scan` once the server's first scan is done (✅ the live v2 store's own:
 *  235 ticks, done on tick 13). */
const SCAN_DONE = { ticks: 235, coldDone: true, coldTicks: 13, pendingSessions: 0, pendingPrChecks: 0, lastTick: { at: t(0), bytesRead: 0, sessionsRead: 0, ghCalls: 0 }, gh: "ok" };

/** GET /api/outcomes as the server sends it (only the fields this reads, plus a few it ignores). */
function outcomesBody(rows: Array<{ id: string; merged: Array<[string, number, string | null]> }>, scan: unknown = SCAN_DONE): unknown {
  return {
    ok: true,
    counts: {},
    scan,
    outcomes: rows.map((r) => ({
      sessionId: r.id,
      outcome: r.merged.length ? "shipped" : "unknown",
      reason: null,
      evidenceAt: null,
      lastActive: t(0),
      prs: r.merged.length,
      merged: r.merged.length,
      mergedPrs: r.merged.map(([repo, number, mergedAt]) => ({ repo, number, mergedAt })),
      pushes: 0,
      artifacts: 0,
      pending: false,
    })),
  };
}

describe("parseOutcomePrs: the untrusted GET /api/outcomes body", () => {
  it("keeps valid merged PRs, drops malformed ones", () => {
    const body = outcomesBody([{ id: "A", merged: [["acme-inc/acme-ai", 460, "2026-09-16T09:51:59Z"], ["../evil", 1, null], ["a b/c", 2, null], ["o/r", 1.5, null], ["o/r", -3, null], ["O/R", 7, "not a date"]] }]);
    expect(parseOutcomePrs(body)).toEqual([
      {
        sessionId: "A",
        mergedPrs: [
          { repo: "acme-inc/acme-ai", number: 460, mergedAt: "2026-09-16T09:51:59Z" },
          { repo: "o/r", number: 7, mergedAt: null },
        ],
      },
    ]);
  });

  it("a server from before crews (no mergedPrs) means unknown, not 'no crews'", () => {
    const old = { ok: true, outcomes: [{ sessionId: "A", outcome: "shipped", merged: 2 }] };
    expect(parseOutcomePrs(old)).toBeNull();
    expect(parseOutcomePrs(null)).toBeNull();
    expect(parseOutcomePrs({ ok: false, error: "x" })).toBeNull();
    expect(parseOutcomePrs(outcomesBody([]))).toEqual([]);
  });
});

describe("shipCrews: 2+ distinct sessions naming the same merged PR", () => {
  // ✅ The shape of the one real crew on 2026-09-28: b6e37506 opened acme-inc/acme-ai#460 on 09-15,
  // a8bc4822 swept and merged it on 09-16 (two sessions, neither continues the other).
  const rows = (): SessionPrs[] =>
    parseOutcomePrs(
      outcomesBody([
        { id: "b6e37506", merged: [["acme-inc/acme-ai", 460, "2026-09-16T09:51:59Z"]] },
        { id: "a8bc4822", merged: [["acme-inc/acme-ai", 460, "2026-09-16T09:51:59Z"], ["acme-inc/acme-ai", 473, "2026-09-16T10:00:00Z"], ["ACME-Inc/acme-ai", 460, "2026-09-16T09:51:59Z"]] },
        { id: "943ddee1", merged: [["sboghossian/agent-world", 62, "2026-09-28T13:00:00Z"], ["sboghossian/agent-world", 63, null]] },
        { id: "0ld", merged: [["o/r", 1, null]] },
        { id: "0lder", merged: [["o/r", 1, null]] },
      ]),
    ) ?? [];

  it("groups by owner/repo#n, case-blind, each session once; a PR only one session names is no crew", () => {
    const crews = shipCrews(rows());
    expect(crews).toEqual([
      { repo: "acme-inc/acme-ai", number: 460, mergedAt: "2026-09-16T09:51:59Z", sessions: ["a8bc4822", "b6e37506"] },
      { repo: "o/r", number: 1, mergedAt: null, sessions: ["0ld", "0lder"] }, // undated sorts last
    ]);
    expect(crewCounts(crews)).toEqual({ crews: 2, sessions: 4 });
  });

  it("a subagent hand-back is not a merge: one session (however many rows or drones) is never a crew", () => {
    // The orchestrator's builders are subagents: they have no outcome row, so every PR they opened
    // and handed back is named by one session only. A duplicated row for the same session doesn't
    // make it two.
    const solo: SessionPrs[] = [
      { sessionId: "943ddee1", mergedPrs: [{ repo: "sboghossian/agent-world", number: 62, mergedAt: null }] },
      { sessionId: "943ddee1", mergedPrs: [{ repo: "sboghossian/agent-world", number: 62, mergedAt: null }] },
    ];
    expect(shipCrews(solo)).toEqual([]);
    expect(crewCounts([])).toEqual({ crews: 0, sessions: 0 });
  });

  it("is the one shared count: the vision ledger's crews probe calls these very functions", () => {
    expect(shipCrews).toBe(sharedShipCrews);
    expect(crewCounts).toBe(sharedCrewCounts);
  });

  it("crewsFor lists the other sessions and a link built from repo + number only", () => {
    const mine = crewsFor("a8bc4822", shipCrews(rows()));
    expect(mine).toEqual([{ repo: "acme-inc/acme-ai", number: 460, url: "https://github.com/acme-inc/acme-ai/pull/460", mergedAt: "2026-09-16T09:51:59Z", partners: ["b6e37506"] }]);
    expect(crewsFor("943ddee1", shipCrews(rows()))).toEqual([]);
  });
});

describe("the words when there is no crew", () => {
  const done = parseRecordsScan(outcomesBody([]));

  it("once the server's first scan is done, says which signal is missing", () => {
    expect(done).toEqual({ done: true, left: { sessions: 0, prChecks: 0 } });
    expect(noCrewText(null, done)).toBe("No outcome record for this session, so no crew.");
    expect(noCrewText(0, done)).toBe("No merged PR, so no crew: merging with another session stays a metaphor here.");
    // Scoped to what the records hold: a merge they can't see (`gh pr merge $n`, no number) makes no sighting.
    expect(noCrewText(1, done)).toBe("No other session's outcome record names its merged PR, so no crew on record.");
    expect(noCrewText(55, done)).toBe("No other session's outcome record names any of its 55 merged PRs, so no crew on record.");
    expect(townCrewLine({ crews: 0, sessions: 0 }, done)).toBe("No crews town-wide: no merged PR is named by two sessions.");
    expect(townCrewLine({ crews: 1, sessions: 2 }, done)).toBe("1 crew town-wide: 2 sessions shipped a merged PR with another.");
  });
});

describe("during the server's first scan of the records, 'no crew' is never claimed", () => {
  // ✅ Reproduced by the reviewer on a copy of the live store: after the v2 → v3 bump the first GET
  // /api/outcomes is ok:true with 0 rows and coldDone:false (the panel said "No outcome record for
  // this session, so no crew."), then rows arrive before their PRs are re-asked ("No merged PR, so
  // no crew"). Both scans below are the server's real shapes at those two moments.
  const booting = { ticks: 0, coldDone: false, coldTicks: null, pendingSessions: 0, pendingPrChecks: 0, lastTick: null, gh: "untried" };
  const midway = { ticks: 4, coldDone: false, coldTicks: null, pendingSessions: 37, pendingPrChecks: 1, lastTick: { at: t(4), bytesRead: 67_108_864, sessionsRead: 40, ghCalls: 10 }, gh: "ok" };
  const NOT_YET = "Not known yet: the server's first scan of the outcome records is still running";

  it("right after a restart (0 rows, no tick yet): not known, never 'no outcome record' or 'no crews town-wide'", () => {
    const c = new CrewCache(60_000);
    c.begin(0);
    c.settle(outcomesBody([], booting), 5);
    const held = c.held;
    expect(held?.rows).toEqual([]);
    expect(held?.scan).toEqual({ done: false, left: null }); // its counts are 0 before a tick, not "nothing left"
    const scan: RecordsScan = held?.scan ?? { done: true, left: null };
    expect(noCrewText(null, scan)).toBe(`${NOT_YET}, so a crew may still turn up.`);
    expect(townCrewLine(crewCounts(held?.crews ?? []), scan)).toBe("Crews town-wide: not known until the server's first scan of the outcome records ends.");
  });

  it("a row read before its PRs were asked about: still not known, with what is left of the scan", () => {
    const scan = parseRecordsScan(outcomesBody([{ id: "6a10cdc0", merged: [] }], midway));
    expect(scan).toEqual({ done: false, left: { sessions: 37, prChecks: 1 } });
    expect(noCrewText(0, scan)).toBe(`${NOT_YET} (37 transcripts left to read, 1 PR left to check), so a crew may still turn up.`);
    expect(noCrewText(3, scan)).toBe(`${NOT_YET} (37 transcripts left to read, 1 PR left to check), so a crew may still turn up.`);
    expect(noCrewText(0, { done: false, left: { sessions: 1, prChecks: 0 } })).toBe(`${NOT_YET} (1 transcript left to read), so a crew may still turn up.`);
  });

  it("a crew already found is real and shown; the town count says 'so far'", () => {
    const c = new CrewCache(60_000);
    c.begin(0);
    c.settle(outcomesBody([{ id: "a", merged: [["o/r", 1, null]] }, { id: "b", merged: [["o/r", 1, null]] }, { id: "c", merged: [] }], midway), 5);
    const held = c.held;
    expect(crewsFor("a", held?.crews ?? [])).toHaveLength(1);
    expect(townCrewLine(crewCounts(held?.crews ?? []), held?.scan ?? { done: true, left: null })).toBe(
      "1 crew town-wide so far: 2 sessions shipped a merged PR with another. The server's first scan of the outcome records is still running.",
    );
  });

  it("a scan the body doesn't carry, or carries malformed, is never read as done", () => {
    for (const scan of [null, [], "done", {}, { coldDone: "true" }, { coldDone: 1 }]) {
      expect(parseRecordsScan(outcomesBody([], scan)).done).toBe(false);
    }
    expect(parseRecordsScan({ ok: true, outcomes: [] })).toEqual({ done: false, left: null }); // no scan key at all
    expect(parseRecordsScan(null)).toEqual({ done: false, left: null });
    // Counts that aren't whole and >= 0 say nothing about what is left.
    expect(parseRecordsScan(outcomesBody([], { ...midway, pendingSessions: -1 })).left).toBeNull();
    expect(parseRecordsScan(outcomesBody([], { ...midway, pendingPrChecks: 1.5 })).left).toBeNull();
  });

  it("the cache keeps the scan with the copy it came with, and a later done read replaces it", () => {
    const c = new CrewCache(60_000);
    c.begin(0);
    c.settle(outcomesBody([], booting), 5);
    c.begin(60_000);
    c.settle(null, 60_005); // a failed read keeps the last good copy, scan included
    expect(c.held?.scan.done).toBe(false);
    c.begin(120_000);
    c.settle(outcomesBody([{ id: "6a10cdc0", merged: [] }]), 120_005);
    expect(c.held?.scan.done).toBe(true);
    expect(noCrewText(0, c.held?.scan ?? { done: false, left: null })).toBe("No merged PR, so no crew: merging with another session stays a metaphor here.");
  });
});

describe("CrewCache: when the house panel reads GET /api/outcomes again", () => {
  const TTL = 60_000;
  const good = outcomesBody([
    { id: "a", merged: [["o/r", 1, null]] },
    { id: "b", merged: [["o/r", 1, null]] },
  ]);
  /** A cache that already holds a good read at t=1000 (the state every later render starts from). */
  function held(): CrewCache {
    const c = new CrewCache(TTL);
    c.begin(1_000);
    c.settle(good, 1_000);
    return c;
  }

  it("reads once when empty, not again while that read is in flight", () => {
    const c = new CrewCache(TTL);
    expect(c.due(0)).toBe(true);
    c.begin(0);
    expect(c.due(10)).toBe(false);
    c.settle(good, 20);
    expect(c.held?.crews).toHaveLength(1);
    expect(c.due(20 + TTL - 1)).toBe(false);
    expect(c.due(20 + TTL)).toBe(true);
  });

  it("from a held copy: a verdict change makes a read due at once", () => {
    const c = held();
    expect(c.due(2_000)).toBe(false);
    c.invalidate();
    expect(c.due(2_000)).toBe(true);
    c.begin(2_000);
    c.settle(good, 2_100);
    expect(c.due(2_200)).toBe(false);
  });

  it("from a held copy: a verdict change DURING a read keeps a read due after it (that read may predate it)", () => {
    const c = held();
    c.invalidate();
    c.begin(2_000);
    c.invalidate(); // the map changed while GET /api/outcomes was in flight
    expect(c.due(2_050)).toBe(false); // still one read at a time
    c.settle(good, 2_100);
    expect(c.due(2_100)).toBe(true);
  });

  it("from a held copy: a failed read keeps the last good copy and waits a TTL before retrying", () => {
    const c = held();
    c.begin(1_000 + TTL);
    c.settle(null, 1_000 + TTL + 5);
    expect(c.unknown).toBe(false);
    expect(c.held?.at).toBe(1_000);
    expect(c.held?.crews).toHaveLength(1);
    expect(c.due(1_000 + TTL + 10)).toBe(false);
    expect(c.due(1_000 + 2 * TTL)).toBe(true);
  });

  it("with nothing held, a failed or old-server read is unknown (never 'no crews'), then retried after a TTL", () => {
    const c = new CrewCache(TTL);
    c.begin(0);
    c.settle({ ok: true, outcomes: [{ sessionId: "a", merged: 1 }] }, 5); // a server from before mergedPrs
    expect(c.held).toBeNull();
    expect(c.unknown).toBe(true);
    expect(c.due(10)).toBe(false);
    expect(c.due(TTL)).toBe(true);
    c.begin(TTL);
    c.settle(good, TTL + 5);
    expect(c.unknown).toBe(false);
    expect(c.held?.crews).toHaveLength(1);
  });
});
