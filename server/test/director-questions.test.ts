import { describe, expect, it } from "vitest";
import type { ObjectWithUsage } from "../db.js";
import { buildQuestions } from "../director.js";

const skill = (name: string, usage: number): ObjectWithUsage => ({ id: `skill:${name}`, kind: "skill", name, islandId: "harness", growth: 0, usage });

describe("buildQuestions", () => {
  it("asks Jev one thing only, which harness skill/MCP grows: never a pair or a roam", () => {
    const q = buildQuestions([skill("humanizer", 4), skill("browse", 2)]);
    expect(Object.keys(q!.payload)).toEqual(["grow"]);
    expect(Object.keys(q!.payload.grow!.criteria)).toEqual(["skill:humanizer", "skill:browse"]);
    expect(Object.keys(q!.state)).toEqual(["growCandidates"]);
  });
  it("asks nothing when no harness object has usage to rank", () => {
    expect(buildQuestions([])).toBeNull();
  });
});
