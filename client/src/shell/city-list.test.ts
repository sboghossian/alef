import { describe, expect, it } from "vitest";
import type { Island, WorldAgent } from "../../../shared/types";
import { citySparks, cityListOptions } from "./city-list";

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
const at = (daysAgo: number, hour = 10): string => new Date(2026, 8, 25 - daysAgo, hour, 0, 0).toISOString();

function agent(id: string, islandId: string, lastActive: string, extra: Partial<WorldAgent> = {}): WorldAgent {
  return { id, islandId, lastActive, status: "dormant", title: id, cwd: "/x", role: "ops", startedAt: lastActive, messageCount: 1, color: "#fff", ...extra } as WorldAgent;
}
const island = (id: string, name: string, agentCount: number): Island => ({ id, name, path: `/p/${name}`, agentCount }) as Island;

describe("citySparks", () => {
  it("buckets sessions by local day, oldest first, ignoring older ones", () => {
    const s = citySparks([agent("a", "c1", at(0)), agent("b", "c1", at(0, 1)), agent("c", "c1", at(6)), agent("d", "c1", at(9)), agent("e", "c2", at(2))], NOW);
    expect(s.get("c1")).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(s.get("c2")).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });
  it("skips unparseable dates and is empty for no agents", () => {
    expect(citySparks([agent("a", "c1", "nope")], NOW).size).toBe(0);
    expect(citySparks([], NOW).size).toBe(0);
  });
});

describe("cityListOptions", () => {
  const islands = [island("harness", "harness", 0), island("c1", "alpha", 3), island("c2", "beta", 1)];
  const agents = [agent("a", "c1", at(3)), agent("b", "c2", at(0), { status: "live" }), agent("c", "c1", at(0), { awaitingInput: true })];

  it("ranks waiting, then live, and fills dot / meta / spark", () => {
    const rows = cityListOptions(islands, agents, { skipHarness: true }, NOW);
    expect(rows.map((r) => r.value)).toEqual(["c1", "c2"]);
    expect(rows[0]).toMatchObject({ label: "alpha", dot: "awaiting", count: 3, meta: "1 waiting · 1 today" });
    expect(rows[0]!.spark).toEqual([0, 0, 0, 1, 0, 0, 1]);
    expect(rows[1]).toMatchObject({ dot: "live", meta: "1 live · 1 today" });
  });
  it("keeps harness without a count unless skipped, and filters by `only`", () => {
    const all = cityListOptions(islands, agents, {}, NOW);
    expect(all.find((r) => r.value === "harness")).toMatchObject({ label: "Harness City", count: undefined, dot: "asleep", spark: undefined });
    expect(cityListOptions(islands, agents, { only: ["live"] }, NOW).map((r) => r.value)).toEqual(["c2"]);
  });
});
