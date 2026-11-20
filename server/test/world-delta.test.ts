// The hub's wire diet (world-delta.ts): only changed rows go out, ids that left are named, the edge
// set only when it changed, and a tab that just loaded GET /api/world gets a catch-up, not a repeat.

import { describe, expect, it } from "vitest";
import type { WorldAgent, WorldEdge, WorldObject, WorldSnapshot } from "../../shared/types.js";
import { baselineOf, deltaMessages, diffWorld, emptyBaseline, SnapshotLedger, type WorldRows } from "../world-delta.js";

const agent = (id: string, over: Partial<WorldAgent> = {}): WorldAgent => ({
  id,
  islandId: "isl",
  cwd: "/w",
  title: "t",
  displayName: null,
  status: "dormant",
  startedAt: "2026-10-27T00:00:00.000Z",
  lastActive: "2026-10-27T00:00:00.000Z",
  messageCount: 1,
  model: null,
  role: "builder",
  color: "#fff",
  targetIslandId: "isl",
  tokens: 0,
  awaitingInput: false,
  ...over,
});
const obj = (id: string, usage = 1): WorldObject => ({ id, kind: "file", name: id, islandId: "isl", usage, growth: 0 });
const edge = (from: string, to: string, weight = 1): WorldEdge => ({ from, to, kind: "touched", weight, at: "2026-10-27T00:00:00.000Z" });

const rows = (over: Partial<WorldRows> = {}): WorldRows => ({
  agents: [agent("a"), agent("b")],
  objects: [obj("f1"), obj("f2")],
  edges: [edge("a", "f1")],
  ...over,
});

const snapshot = (r: WorldRows, over: Partial<WorldSnapshot> = {}): WorldSnapshot => ({
  generatedAt: "2026-10-27T00:00:00.000Z",
  stats: { liveCount: 0, awaitingCount: 0, tokensToday: 0 },
  islands: [{ id: "isl", name: "isl", path: "/w", agentCount: 2, lastActive: "2026-10-27T00:00:00.000Z" }],
  agents: [...r.agents],
  objects: [...r.objects],
  edges: [...r.edges],
  jev: { status: "disabled", lastTickAt: null, decisions: [] },
  extras: { "x.y": 1 },
  ...over,
});

describe("diffWorld", () => {
  it("sends everything against an empty baseline", () => {
    const { delta } = diffWorld(emptyBaseline(), rows());
    expect(deltaMessages(delta).map((m) => m.type)).toEqual(["agents", "objects", "edges"]);
  });

  it("sends nothing when nothing changed (fresh but equal row objects)", () => {
    const base = baselineOf(rows());
    const { delta, next } = diffWorld(base, rows());
    expect(deltaMessages(delta)).toEqual([]);
    expect(diffWorld(next, rows()).delta.edges).toBeNull();
  });

  it("sends only the rows that changed, and the edge set only when it changed", () => {
    const base = baselineOf(rows());
    const { delta } = diffWorld(base, rows({ agents: [agent("a"), agent("b", { status: "live" })], objects: [obj("f1"), obj("f2", 5)] }));
    expect(delta.agents.map((a) => a.id)).toEqual(["b"]);
    expect(delta.objects.map((o) => o.id)).toEqual(["f2"]);
    expect(delta.edges).toBeNull();

    const withEdge = diffWorld(base, rows({ edges: [edge("a", "f1", 2)] })).delta;
    expect(withEdge.agents).toEqual([]);
    expect(withEdge.edges).toEqual([edge("a", "f1", 2)]); // the FULL set: the client replaces its edges
  });

  it("names the ids that left, as agentsRemoved / objectsRemoved", () => {
    const { delta } = diffWorld(baselineOf(rows()), rows({ agents: [agent("a")], objects: [obj("f1")] }));
    expect(deltaMessages(delta)).toEqual([
      { type: "agentsRemoved", ids: ["b"] },
      { type: "objectsRemoved", ids: ["f2"] },
    ]);
  });

  it("carries the new baseline forward: a change is sent once", () => {
    let base = baselineOf(rows());
    const changed = rows({ agents: [agent("a", { tokens: 9 }), agent("b")] });
    const first = diffWorld(base, changed);
    base = first.next;
    expect(first.delta.agents).toHaveLength(1);
    expect(deltaMessages(diffWorld(base, changed).delta)).toEqual([]);
  });
});

describe("SnapshotLedger", () => {
  it("catches a tab up from the snapshot it loaded: only the rows that changed since", () => {
    const ledger = new SnapshotLedger(() => 1000);
    const served = snapshot(rows());
    ledger.remember(served);
    const now = snapshot(rows({ agents: [agent("a", { status: "live" }), agent("b")] }), { generatedAt: "2026-10-27T00:00:05.000Z" });
    const delta = ledger.catchUp(served.generatedAt, now);
    expect(delta && deltaMessages(delta)).toEqual([{ type: "agents", agents: [agent("a", { status: "live" })] }]);
  });

  it("an unchanged world catches up with no row messages at all", () => {
    const ledger = new SnapshotLedger(() => 1000);
    const served = snapshot(rows());
    ledger.remember(served);
    const delta = ledger.catchUp(served.generatedAt, snapshot(rows(), { generatedAt: "later" }));
    expect(delta && deltaMessages(delta)).toEqual([]);
  });

  it("answers null (send the full snapshot) when the snapshot is unknown, used, expired or its frame changed", () => {
    let t = 0;
    const ledger = new SnapshotLedger(() => t);
    const served = snapshot(rows());

    expect(ledger.catchUp(served.generatedAt, served)).toBeNull(); // never served

    ledger.remember(served);
    expect(ledger.catchUp(served.generatedAt, served)).not.toBeNull();
    expect(ledger.catchUp(served.generatedAt, served)).toBeNull(); // one use each

    ledger.remember(served);
    t = 31_000;
    expect(ledger.catchUp(served.generatedAt, served)).toBeNull(); // expired

    t = 0;
    ledger.remember(served);
    expect(ledger.catchUp(served.generatedAt, snapshot(rows(), { extras: { "x.y": 2 } }))).toBeNull(); // extras moved
    ledger.remember(served);
    expect(ledger.catchUp(served.generatedAt, snapshot(rows(), { islands: [] }))).toBeNull(); // islands moved
  });

  it("keeps only the last few snapshots", () => {
    const ledger = new SnapshotLedger(() => 0);
    for (let i = 0; i < 6; i++) ledger.remember(snapshot(rows(), { generatedAt: `g${i}` }));
    expect(ledger.catchUp("g0", snapshot(rows()))).toBeNull();
    expect(ledger.catchUp("g5", snapshot(rows()))).not.toBeNull();
  });
});
