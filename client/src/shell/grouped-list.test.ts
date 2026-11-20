import { describe, expect, it } from "vitest";
import type { Island, WorldAgent } from "../../../shared/types";
import { cityListOptions } from "./city-list";
import { groupListRows, type FilterOption } from "./views";

const opt = (value: string, group: string | undefined, activity: number): FilterOption => ({ value, label: value, group, activity });
const GROUPS = [
  { key: "WEB", label: "Website" },
  { key: "GTM", label: "Growth" },
  { key: "EMPTY", label: "Nothing" },
];

describe("groupListRows (Districts by continent)", () => {
  const options = [opt("b", "WEB", 1), opt("a", "WEB", 5), opt("c", "GTM", 2), opt("x", undefined, 9), opt("y", "MARS", 3)];

  it("keeps group order, sorts rows inside each group, drops empty groups", () => {
    const blocks = groupListRows(options, GROUPS, "activity", []);
    expect(blocks.map((b) => b.group?.key ?? null)).toEqual(["WEB", "GTM", null]);
    expect(blocks[0]!.rows.map((r) => r.value)).toEqual(["a", "b"]);
  });
  it("puts rows with a missing or unknown group in a last headerless block", () => {
    const last = groupListRows(options, GROUPS, "activity", []).at(-1)!;
    expect(last.group).toBeNull();
    expect(last.rows.map((r) => r.value)).toEqual(["x", "y"]);
  });
  it("floats pinned rows to a first headerless block, in pin order", () => {
    const blocks = groupListRows(options, GROUPS, "name", ["c", "a"]);
    expect(blocks[0]).toEqual({ group: null, rows: [options[2], options[1]] });
    expect(blocks[1]!.rows.map((r) => r.value)).toEqual(["b"]);
  });
  it("keeps an empty group only when it carries an empty note", () => {
    const blocks = groupListRows(options, [...GROUPS, { key: "TEAM", label: "Team", empty: "none yet" }], "activity", []);
    expect(blocks.find((b) => b.group?.key === "TEAM")?.rows).toEqual([]);
    expect(blocks.find((b) => b.group?.key === "EMPTY")).toBeUndefined();
  });
  it("handles no options", () => {
    expect(groupListRows([], GROUPS, "activity", [])).toEqual([]);
  });
});

describe("cityListOptions groupOf", () => {
  it("tags each city row with its continent", () => {
    const islands: Island[] = [{ id: "acme", name: "acme", path: "/x", agentCount: 1, lastActive: "2026-09-26T00:00:00Z" }];
    const agents: WorldAgent[] = [];
    const rows = cityListOptions(islands, agents, { groupOf: (id) => (id === "acme" ? "WEB" : undefined) });
    expect(rows[0]?.group).toBe("WEB");
    expect(cityListOptions(islands, agents)[0]?.group).toBeUndefined();
  });
});
