import { describe, expect, it } from "vitest";
import type { SubagentRecord } from "../../../shared/features/subagents";
import type { WorldAgent, WorldObject } from "../../../shared/types";
import {
  DISTRICT_COST_ATTRIBUTION_NOTE,
  DISTRICT_COST_CAPTION,
  districtCostLine,
  districtFilterFrom,
  districtStats,
  houseOrder,
  orderDistricts,
  stepDistrict,
  type DistrictStats,
} from "./district-lib";

const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime();
const today = new Date(2026, 8, 25, 9, 0, 0).toISOString();
const yesterday = new Date(2026, 8, 24, 9, 0, 0).toISOString();

function agent(id: string, islandId: string, over: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id, islandId, cwd: "/x", title: id, status: "dormant", startedAt: yesterday, lastActive: yesterday,
    messageCount: 1, model: null, role: "builder", color: "#fff", targetIslandId: islandId, tokens: 0, awaitingInput: false,
    ...over,
  };
}
function sub(id: string, parent: string, over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id, parentSessionId: parent, parentAgentId: null, workflowId: null, description: id, agentType: null, model: null,
    status: "done", reason: null, startedAt: today, lastActive: today, tokens: 0, toolCounts: {}, files: [], depth: 1, ...over,
  };
}
const file = (id: string, islandId: string): WorldObject => ({ id, kind: "file", name: id, islandId, usage: 1, growth: 0 });

describe("districtStats", () => {
  it("counts live, waiting, today, tokens, subagents and files for one district only", () => {
    const agents = [
      agent("a", "c1", { status: "live", lastActive: today, tokens: 1000 }),
      agent("b", "c1", { status: "live", awaitingInput: true, lastActive: today, tokens: 500 }),
      agent("c", "c1", { tokens: 99_999 }),
      agent("z", "c2", { status: "live", lastActive: today }),
    ];
    const subs = [sub("s1", "a", { status: "running" }), sub("s2", "c", { lastActive: yesterday }), sub("s3", "z")];
    const s = districtStats({ id: "c1", lastActive: yesterday }, agents, [file("f1", "c1"), file("f2", "c2")], subs, NOW);
    expect(s).toMatchObject({ agents: 3, live: 2, waiting: 1, activeToday: 2, tokensToday: 1500, subagentsToday: 1, subagentsLive: 1, files: 1 });
    expect(s.lastActive).toBe(today);
  });
});

describe("orderDistricts", () => {
  const islands = [
    { id: "quiet", name: "quiet" },
    { id: "busy", name: "busy" },
    { id: "harness", name: "harness" },
    { id: "mid", name: "Mid" },
  ];
  const base = (id: string): DistrictStats => ({
    id, agents: 0, live: 0, waiting: 0, activeToday: 0, tokensToday: 0, subagentsToday: 0, subagentsLive: 0, files: 0, lastActive: "",
  });
  const stats: Record<string, DistrictStats> = {
    quiet: { ...base("quiet"), agents: 9 },
    busy: { ...base("busy"), agents: 2, live: 2 },
    harness: base("harness"),
    mid: { ...base("mid"), agents: 1, activeToday: 1 },
  };
  const f = (id: string): DistrictStats => stats[id]!;

  it("sorts by activity by default and filters live / dormant", () => {
    expect(orderDistricts(islands, f, districtFilterFrom({}))).toEqual(["busy", "mid", "harness", "quiet"]);
    expect(orderDistricts(islands, f, { show: "live", sort: "activity" })).toEqual(["busy"]);
    expect(orderDistricts(islands, f, { show: "dormant", sort: "agents" })).toEqual(["quiet", "mid", "harness"]);
    expect(orderDistricts(islands, f, { show: "all", sort: "name" })).toEqual(["busy", "harness", "mid", "quiet"]);
  });

  it("walks with wrap-around", () => {
    expect(stepDistrict(["a", "b"], "b", 1)).toBe("a");
    expect(stepDistrict(["a", "b"], "a", -1)).toBe("b");
    expect(stepDistrict(["a", "b"], null, 1)).toBe("a");
    expect(stepDistrict([], "a", 1)).toBeNull();
  });

  it("reads the filter state with safe defaults", () => {
    expect(districtFilterFrom({ show: ["bogus"], sort: ["name"], district: ["x"] })).toEqual({ show: "all", sort: "name", picked: "x" });
  });
});

describe("districtCostLine", () => {
  const fmt = (n: number): string => `≈$${n.toFixed(2)}`;

  it("formats the panel's cost + session-count line", () => {
    expect(districtCostLine({ costUsd: 1.2, sessions: 7 }, fmt)).toBe("≈$1.20 — est. cost of work done in this district's folders today, by any agent, wherever its house is (7 sessions).");
  });

  it("singularizes one session", () => {
    expect(districtCostLine({ costUsd: 0.02, sessions: 1 }, fmt)).toBe("≈$0.02 — est. cost of work done in this district's folders today, by any agent, wherever its house is (1 session).");
  });

  it("is null when the usage store has no row for this district today (not the same as $0)", () => {
    expect(districtCostLine(undefined, fmt)).toBeNull();
  });

  // Regression for the cwd-vs-house mismeasurement (server/features/usage.ts's
  // `islandForCwd` keys per-district cost by each transcript line's cwd, while every other
  // stat on this card — and the houses list right below it — is keyed by `agent.islandId`,
  // where the session's house actually sits). A bare "$X · N sessions" reads as "these N
  // houses cost $X"; the tooltip must spell out that the work can have come from a session
  // housed anywhere else, not just this district's own houses.
  it("says the cost can come from a session housed elsewhere, not just this district's houses", () => {
    const line = districtCostLine({ costUsd: 7.11, sessions: 1 }, fmt);
    expect(line).toMatch(/wherever its house is/);
    expect(line).toMatch(/by any agent/);
  });
});

describe("DISTRICT_COST_CAPTION", () => {
  // The visible tile caption must never carry a session count on its own — pairing "$X" with
  // "N sessions" right next to the houses list below is exactly what made the tile misread as
  // "these houses cost $X" (see districtCostLine's regression test above for the full story).
  it("never mentions a session count, so it can't be misread as a house count", () => {
    expect(DISTRICT_COST_CAPTION).not.toMatch(/session/i);
  });
});

describe("DISTRICT_COST_ATTRIBUTION_NOTE", () => {
  it("explains the cost is billed by folder, not by house, in the card itself", () => {
    expect(DISTRICT_COST_ATTRIBUTION_NOTE).toMatch(/folder/i);
    expect(DISTRICT_COST_ATTRIBUTION_NOTE).toMatch(/house/i);
  });
});

describe("houseOrder", () => {
  it("puts waiting, then live, then recent dormant first, capped", () => {
    const out = houseOrder(
      [
        agent("old", "c"),
        agent("live", "c", { status: "live", lastActive: today }),
        agent("ask", "c", { status: "live", awaitingInput: true }),
        agent("new", "c", { lastActive: today }),
      ],
      3,
    ).map((a) => a.id);
    expect(out).toEqual(["ask", "live", "new"]);
  });
});
