import { describe, expect, it } from "vitest";
import type { WorldAgent, WorldEdge, WorldObject } from "../../shared/types";
import { WorldStore } from "./state";

const agent = (id: string): WorldAgent => ({ id }) as WorldAgent;

describe("WorldStore.removeAgents", () => {
  it("drops present agents and reports only those", () => {
    const store = new WorldStore();
    store.upsertAgents([agent("a"), agent("b")]);
    const seen: string[][] = [];
    store.onAgentsRemoved((ids) => seen.push(ids));
    store.removeAgents(["a", "zzz"]);
    expect([...store.agents.keys()]).toEqual(["b"]);
    expect(seen).toEqual([["a"]]);
  });

  it("does not fire when nothing was removed", () => {
    const store = new WorldStore();
    let fired = false;
    store.onAgentsRemoved(() => (fired = true));
    store.removeAgents(["nope"]);
    store.removeAgents([]);
    expect(fired).toBe(false);
  });
});

describe("WorldStore.removeObjects", () => {
  const obj = (id: string): WorldObject => ({ id, kind: "file", name: id, islandId: "i", usage: 1, growth: 0 });

  it("drops present objects and reports only those; nothing fires for unknown ids", () => {
    const store = new WorldStore();
    store.upsertObjects([obj("f1"), obj("f2")]);
    const seen: string[][] = [];
    store.onObjectsRemoved((ids) => seen.push(ids));
    store.removeObjects(["f1", "nope"]);
    store.removeObjects(["nope"]);
    expect([...store.objects.keys()]).toEqual(["f2"]);
    expect(seen).toEqual([["f1"]]);
  });
});

describe("WorldStore.setEdges", () => {
  const edge = (from: string, to: string): WorldEdge => ({ from, to, kind: "touched", weight: 1, at: "2026-10-27T00:00:00Z" });

  it("replaces the edge set: repeated full broadcasts never grow the store", () => {
    const store = new WorldStore();
    const full = [edge("a", "f1"), edge("b", "f2"), edge("c", "f3")];
    for (let pass = 0; pass < 10; pass++) store.setEdges(full);
    expect(store.edges).toHaveLength(3);
    store.setEdges([edge("a", "f1")]);
    expect(store.edges).toEqual([edge("a", "f1")]);
  });

  it("hands listeners the full set and keeps its own copy", () => {
    const store = new WorldStore();
    const seen: number[] = [];
    store.onEdges((all) => seen.push(all.length));
    const sent = [edge("a", "f1"), edge("b", "f2")];
    store.setEdges(sent);
    store.setEdges(sent);
    sent.push(edge("c", "f3"));
    expect(seen).toEqual([2, 2]);
    expect(store.edges).toHaveLength(2);
  });
});
