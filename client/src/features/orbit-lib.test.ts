import { describe, expect, it } from "vitest";
import {
  agentMatchesState,
  builtinToolKey,
  defaultFilterState,
  filterStateFromSearch,
  isGitPush,
  isTurnEnd,
  labelShouldDim,
  localDate,
  staleToolyardKeys,
  stagesForActivity,
  stagesForCommand,
  toolYardBuildings,
  yardCounts,
} from "./orbit-lib";

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
const agent = (over: Partial<{ status: "live" | "dormant"; awaitingInput: boolean; lastActive: string }> = {}) => ({
  status: "dormant" as "live" | "dormant",
  awaitingInput: false,
  lastActive: new Date(2026, 8, 20).toISOString(),
  ...over,
});

describe("filter state → agent visibility", () => {
  it("all shows everyone", () => {
    expect(agentMatchesState("all", agent(), NOW)).toBe(true);
  });
  it("live / dormant follow status", () => {
    expect(agentMatchesState("live", agent({ status: "live" }), NOW)).toBe(true);
    expect(agentMatchesState("live", agent(), NOW)).toBe(false);
    expect(agentMatchesState("dormant", agent(), NOW)).toBe(true);
    expect(agentMatchesState("dormant", agent({ status: "live" }), NOW)).toBe(false);
  });
  it("waiting = awaitingInput, or a live waiting/permission state", () => {
    expect(agentMatchesState("waiting", agent({ status: "live", awaitingInput: true }), NOW)).toBe(true);
    expect(agentMatchesState("waiting", agent({ status: "live" }), NOW, "permission")).toBe(true);
    expect(agentMatchesState("waiting", agent({ status: "live" }), NOW, "working")).toBe(false);
  });
  it("today = active since local midnight; bad dates never match", () => {
    expect(agentMatchesState("today", agent({ lastActive: new Date(2026, 8, 25, 0, 5).toISOString() }), NOW)).toBe(true);
    expect(agentMatchesState("today", agent({ lastActive: new Date(2026, 8, 24, 23, 55).toISOString() }), NOW)).toBe(false);
    expect(agentMatchesState("today", agent({ lastActive: "not a date" }), NOW)).toBe(false);
  });
  it("reads debug params and ignores junk", () => {
    const s = filterStateFromSearch("?filter=dormant&district=acme&hide=drones,planes,bogus");
    expect(s.state).toBe("dormant");
    expect(s.district).toBe("acme");
    expect(s.kinds.drones).toBe(false);
    expect(s.kinds.planes).toBe(false);
    expect(s.kinds.files).toBe(true);
    expect(filterStateFromSearch("?filter=nope")).toEqual(defaultFilterState());
  });
});

describe("lifecycle stage detection", () => {
  it("verify from test / typecheck / lint commands", () => {
    for (const cmd of ["npx vitest run", "npm test", "pytest -q", "npx tsc --noEmit", "npm run lint", "jest --ci", "npm run typecheck"]) {
      expect(stagesForCommand(cmd)).toContain("verify");
    }
    expect(stagesForCommand("ls -la && cat latest.txt")).toEqual([]);
  });
  it("reads the server's \"Bash: <command>\" summaries", () => {
    expect(stagesForActivity({ stage: "tool", toolName: "Bash", summary: "Bash: git commit -m fix" })).toContain("persist");
    expect(stagesForActivity({ stage: "tool", toolName: "Bash", summary: "Bash: npx vitest run" })).toContain("verify");
  });
  it("persist from git commit; push detected separately", () => {
    expect(stagesForCommand('git commit -m "feat: x"')).toEqual(["persist"]);
    expect(stagesForCommand("git -C /repo commit -am wip")).toEqual(["persist"]);
    expect(isGitPush("git push origin feat/x")).toBe(true);
    expect(isGitPush("git status")).toBe(false);
  });
  it("maps activity lines", () => {
    expect(stagesForActivity({ stage: "hook", toolName: null, summary: "fix the bug" })).toEqual(["prompt", "hook"]);
    expect(stagesForActivity({ stage: "plan", toolName: "Skill", summary: "Skill yalla" })).toEqual(["plan"]);
    expect(stagesForActivity({ stage: "reason", toolName: null, summary: "thinking…" })).toEqual(["reason"]);
    expect(stagesForActivity({ stage: "tool", toolName: "Agent", summary: "Agent" })).toEqual(["subagents"]);
    expect(stagesForActivity({ stage: "tool", toolName: "Edit", summary: "Edit a.ts" })).toEqual(["tools", "persist"]);
    expect(stagesForActivity({ stage: "tool", toolName: "Bash", summary: "Bash" })).toEqual(["tools"]);
    expect(stagesForActivity({ stage: "tool", toolName: "Bash", summary: "Bash npx vitest run" })).toEqual(["tools", "verify"]);
    expect(stagesForActivity({ stage: "brain", toolName: "Read", summary: "Read MEMORY.md" })).toEqual(["tools"]);
  });
  it("a response is a working → waiting/idle transition", () => {
    expect(isTurnEnd("working", "waiting")).toBe(true);
    expect(isTurnEnd("permission", "idle")).toBe(true);
    expect(isTurnEnd("idle", "waiting")).toBe(false);
    expect(isTurnEnd(undefined, "idle")).toBe(false);
  });
});

describe("tool yard sizing", () => {
  it("groups built-ins, drops MCP and unknown tools", () => {
    expect(builtinToolKey("Task")).toBe("Agent");
    expect(builtinToolKey("TaskCreate")).toBe("Todo/Task");
    expect(builtinToolKey("mcp__linear__save_issue")).toBeNull();
    expect(builtinToolKey("SomethingNew")).toBeNull();
    const c = yardCounts([
      { name: "Bash", count: 501 },
      { name: "BashOutput", count: 4 },
      { name: "Read", count: 64 },
      { name: "mcp__linear__save_issue", count: 37 },
      { name: "Edit", count: 0 },
    ]);
    expect(c.get("Bash")).toBe(505);
    expect(c.has("Edit")).toBe(false);
    expect(c.size).toBe(2);
  });
  it("busiest first, log-scaled heights within bounds, capped", () => {
    const b = toolYardBuildings(new Map([["Read", 64], ["Bash", 505], ["Write", 1]]));
    expect(b.map((x) => x.key)).toEqual(["Bash", "Read", "Write"]);
    expect(b[0]?.height).toBeCloseTo(3.2);
    expect(b[2]!.height).toBeGreaterThan(0.6);
    expect(b[1]!.height).toBeLessThan(b[0]!.height);
    expect(toolYardBuildings(new Map())).toEqual([]);
    const many = new Map(Array.from({ length: 30 }, (_, i) => [`T${i}`, i + 1] as [string, number]));
    expect(toolYardBuildings(many, 18)).toHaveLength(18);
  });
  it("formats local dates for the replay API", () => {
    expect(localDate(NOW)).toBe("2026-09-25");
    expect(localDate(NOW, 25)).toBe("2026-08-31");
  });
});

describe("labelShouldDim", () => {
  it("dims nothing when no district is focused", () => {
    expect(labelShouldDim("agent-world", null)).toBe(false);
    expect(labelShouldDim(undefined, null)).toBe(false);
  });
  it("leaves the focused district's own callout un-dimmed", () => {
    expect(labelShouldDim("agent-world", "agent-world")).toBe(false);
  });
  it("dims every other callout by id, even one with the same rendered name as the focused one", () => {
    // Two islands can display the same label (e.g. both showing as "Vault", or two projects a
    // user happens to name the same) — the id, not the text, decides who stays lit.
    expect(labelShouldDim("island-b", "island-a")).toBe(true);
  });
  it("dims a callout with no island id wired up, same as any other non-match", () => {
    expect(labelShouldDim(undefined, "agent-world")).toBe(true);
  });
});

describe("staleToolyardKeys", () => {
  it("lists cached days before the window and malformed keys, never other keys", () => {
    const keys = ["alef.toolyard.2026-10-19", "alef.toolyard.2026-10-20", "alef.toolyard.2026-10-26", "alef.toolyard.junk", "alef.orbit.filters", "other"];
    expect(staleToolyardKeys(keys, "2026-10-20")).toEqual(["alef.toolyard.2026-10-19", "alef.toolyard.junk"]);
    expect(staleToolyardKeys([], "2026-10-20")).toEqual([]);
  });
});
