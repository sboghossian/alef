import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../../shared/types";
import { codeAgents, isHomeCwd, isProjectCwd } from "./code";

const agent = (id: string, cwd: string, status: "live" | "dormant", lastActive: string, islandId = "x"): WorldAgent => ({
  id, islandId, cwd, title: id, status, startedAt: lastActive, lastActive, messageCount: 1, model: null, role: "builder", color: "#000",
  targetIslandId: islandId, tokens: 0, awaitingInput: false,
});

describe("code agents", () => {
  it("only project folders can be opened", () => {
    expect(isProjectCwd("/Users/me/Documents/Code/app")).toBe(true);
    expect(isProjectCwd("/Users/me")).toBe(false);
    expect(isProjectCwd("/Users/me/")).toBe(false);
    expect(isProjectCwd("/")).toBe(false);
    expect(isProjectCwd("/private/tmp/claude/scratchpad")).toBe(false);
    expect(isProjectCwd("/tmp")).toBe(false);
    expect(isHomeCwd("/Users/me")).toBe(true);
    expect(isHomeCwd("/Users/me/")).toBe(true);
    expect(isHomeCwd("/Users/me/code")).toBe(false);
    expect(isHomeCwd("/")).toBe(false);
  });
  it("lists live first, then most recent, optionally one repo", () => {
    const list = [
      agent("old", "/Users/me/a", "dormant", "2026-09-01T00:00:00Z", "a"),
      agent("new", "/Users/me/b", "dormant", "2026-09-20T00:00:00Z", "b"),
      agent("live", "/Users/me/a", "live", "2026-09-10T00:00:00Z", "a"),
      agent("home", "/Users/me", "live", "2026-09-25T00:00:00Z", "home"),
    ];
    // $HOME sessions are listed too: the server serves them the repos they touched.
    expect(codeAgents(list, null).map((a) => a.id)).toEqual(["home", "live", "new", "old"]);
    expect(codeAgents(list, "a").map((a) => a.id)).toEqual(["live", "old"]);
  });
});
