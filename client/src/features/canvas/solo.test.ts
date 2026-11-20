import { describe, expect, it } from "vitest";
import type { ArtifactItem } from "../../../../shared/features/artifacts";
import type { AtlasDept, AtlasLeaf } from "../../../../shared/features/atlas";
import type { SubagentRecord } from "../../../../shared/features/subagents";
import type { Island, WorldAgent, WorldEdge, WorldObject } from "../../../../shared/types";
import { parseRoute } from "../../shell/views";
import { buildGraph, LANE_CAPS, SOLO_CAP, type GraphFilter, type GraphInput } from "./graph";
import { layoutGraph } from "./layout";
import { rankSessions, soloFromHash } from "./solo";

const NOW = Date.parse("2026-10-14T12:00:00");
const iso = (h: number): string => new Date(Date.parse("2026-10-14T00:00:00") + h * 3600_000).toISOString();

function agent(id: string, over: Partial<WorldAgent> = {}): WorldAgent {
  return { id, islandId: "city-a", cwd: "/x", title: `title ${id}`, status: "dormant", startedAt: iso(1), lastActive: iso(2), messageCount: 3, model: "claude-opus-5-5", role: "builder", color: "#fff", targetIslandId: "city-a", tokens: 10, awaitingInput: false, ...over };
}
function sub(id: string, parent: string): SubagentRecord {
  return { id, parentSessionId: parent, parentAgentId: null, workflowId: null, description: `sub ${id}`, agentType: "general-purpose", model: "claude-sonnet-5", status: "done", reason: null, startedAt: iso(3), lastActive: iso(4), tokens: 5, toolCounts: {}, files: [{ path: `/repo/${id}.ts`, count: 1 }], depth: 1 };
}
function art(id: string, sessions: string[], lastAt = iso(5)): ArtifactItem {
  return { id, url: `https://claude.ai/artifact/${id}`, title: `page ${id}`, origin: "published", islandId: "city-a", sessions, firstAt: iso(1), lastAt, publishCount: 1, hasPreview: false };
}

const DEPTS: AtlasDept[] = [{ id: "build-ship", name: "Build + ship", emoji: "🚢", bundles: 0, leaves: 1 }];
const LEAVES: AtlasLeaf[] = [{ id: "skill:humanizer", kind: "skill", name: "humanizer", description: "", dept: "build-ship", reason: "", via: "override", autonomy: "assisted", evidence: "", uses: 1, uses30d: 1, lastUsedAt: null, path: null, canOpen: false }];

function input(): GraphInput {
  const objects = new Map<string, WorldObject>(
    (
      [
        { id: "skill:humanizer", kind: "skill", name: "humanizer", islandId: "harness", usage: 3, growth: 0 },
        { id: "skill:other", kind: "skill", name: "other", islandId: "harness", usage: 3, growth: 0 },
        { id: "file:/repo/a.ts", kind: "file", name: "a.ts", islandId: "city-a", usage: 2, growth: 0 },
        { id: "file:/repo/b.ts", kind: "file", name: "b.ts", islandId: "city-a", usage: 2, growth: 0 },
        { id: "hook:UserPromptSubmit:recall", kind: "hook", name: "UserPromptSubmit:recall", islandId: "harness", usage: 9, growth: 0 },
      ] satisfies WorldObject[]
    ).map((o) => [o.id, o]),
  );
  const edges: WorldEdge[] = [
    { from: "s1", to: "skill:humanizer", kind: "uses", weight: 2, at: iso(2) },
    { from: "s1", to: "file:/repo/a.ts", kind: "touched", weight: 1, at: iso(2) },
    { from: "s2", to: "skill:other", kind: "uses", weight: 1, at: iso(2) },
    { from: "s2", to: "file:/repo/b.ts", kind: "touched", weight: 1, at: iso(2) },
  ];
  const islands = new Map<string, Island>([["city-a", { id: "city-a", name: "a", path: "/a", agentCount: 2, lastActive: iso(2) }]]);
  return {
    agents: [agent("s1", { status: "live" }), agent("s2")],
    objects,
    edges,
    islands,
    subagents: [sub("a1", "s1"), sub("a2", "s2")],
    decisions: [],
    jevStatus: "online",
    approvals: [{ id: "ap1", agentId: "s2", toolName: "Bash", title: "x" }, { id: "ap2", agentId: "s1", toolName: "Edit", title: "y" }],
    routines: [{ label: "com.stephane.x", shortName: "x", running: false, lastExitStatus: 0 }],
    artifacts: [art("art-one", ["s1"]), art("art-two", ["s2"])],
    atlas: { departments: DEPTS, leaves: LEAVES },
  };
}

const ALL: GraphFilter = { scope: "today", city: null, tree: null, keep: null, nowMs: NOW };

describe("solo: one session's footprint", () => {
  it("keeps only that session's nodes and edges", () => {
    const g = buildGraph(input(), { ...ALL, solo: "s1" });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(false);
    expect(ids.has("subagent:a1")).toBe(true);
    expect(ids.has("subagent:a2")).toBe(false);
    expect(ids.has("skill:humanizer")).toBe(true);
    expect(ids.has("skill:other")).toBe(false);
    expect(ids.has("file:/repo/a.ts")).toBe(true);
    expect(ids.has("file:/repo/b.ts")).toBe(false);
    expect(ids.has("artifact:art-one")).toBe(true);
    expect(ids.has("artifact:art-two")).toBe(false);
    expect(ids.has("approval:ap2")).toBe(true);
    expect(ids.has("approval:ap1")).toBe(false);
    for (const e of g.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(e.from + e.to).not.toContain("s2");
    }
  });

  it("drops what has no link to the session: hooks and routines", () => {
    const g = buildGraph(input(), { ...ALL, solo: "s1" });
    expect(g.nodes.some((n) => n.kind === "hook" || n.kind === "routine")).toBe(false);
    expect(buildGraph(input(), ALL).nodes.some((n) => n.kind === "hook")).toBe(true);
  });

  it("ignores the shared selection and the time scope", () => {
    const g = buildGraph(input(), { ...ALL, solo: "s1", keep: "s2" });
    expect(g.nodes.filter((n) => n.kind === "session").map((n) => n.id)).toEqual(["s1"]);
    const old = input();
    old.agents = [agent("s1", { lastActive: "2026-01-01T00:00:00Z" }), agent("s2")];
    expect(buildGraph(old, { ...ALL, solo: "s1" }).nodes.some((n) => n.id === "s1")).toBe(true);
  });

  it("an unknown session id gives no session cards", () => {
    expect(buildGraph(input(), { ...ALL, solo: "nope" }).nodes.some((n) => n.kind === "session")).toBe(false);
  });
});

describe("new lanes: artifacts + atlas departments", () => {
  it("links a session to the artifacts it published", () => {
    const g = buildGraph(input(), ALL);
    const n = g.nodes.find((x) => x.id === "artifact:art-one");
    expect(n?.place).toBe("artifacts");
    expect(g.edges.some((e) => e.from === "s1" && e.to === "artifact:art-one")).toBe(true);
    expect(g.edges.some((e) => e.from === "s2" && e.to === "artifact:art-one")).toBe(false);
  });

  it("shows a department only when one of its skills is on the canvas", () => {
    const g = buildGraph(input(), ALL);
    expect(g.nodes.find((n) => n.id === "dept:build-ship")?.place).toBe("atlas");
    expect(g.edges.some((e) => e.from === "dept:build-ship" && e.to === "skill:humanizer")).toBe(true);
    expect(buildGraph(input(), { ...ALL, solo: "s2" }).nodes.some((n) => n.kind === "dept")).toBe(false);
  });

  it("is absent when the data is absent (feature-detect)", () => {
    const i = input();
    delete i.artifacts;
    delete i.atlas;
    const g = buildGraph(i, ALL);
    expect(g.nodes.some((n) => n.kind === "artifact" || n.kind === "dept")).toBe(false);
  });

  it("caps a lane and adds a '+N more' node", () => {
    const i = input();
    i.artifacts = Array.from({ length: LANE_CAPS.artifacts + 7 }, (_, k) => art(`bulk-${String(k).padStart(3, "0")}`, ["s1"], iso(5)));
    const g = buildGraph(i, ALL);
    expect(g.nodes.filter((n) => n.kind === "artifact")).toHaveLength(LANE_CAPS.artifacts);
    expect(g.hidden.artifacts).toBe(7);
    expect(g.nodes.find((n) => n.id === "more:artifacts")?.label).toBe("+7 more");
  });
});

describe("deep link + picker", () => {
  it("parses #/canvas?session=<id> and #/canvas/<id>", () => {
    expect(soloFromHash("#/canvas?session=abc-1")).toBe("abc-1");
    expect(soloFromHash("#/canvas/abc-1")).toBe("abc-1");
    expect(soloFromHash("#/canvas")).toBeNull();
    expect(soloFromHash("#/orbit?session=abc")).toBeNull();
    expect(soloFromHash("#/canvas/%E0%A4%A")).toBeNull();
  });

  it("the shell routes the query form to the canvas with the session as param", () => {
    expect(parseRoute("#/canvas?session=abc-1")).toEqual({ view: "canvas", param: "abc-1" });
    expect(parseRoute("#/canvas")).toEqual({ view: "canvas", param: null });
    expect(parseRoute("#/room/x?session=abc")).toBeNull();
  });

  it("ranks live first, then newest, and filters by text", () => {
    const rows = rankSessions([agent("old", { lastActive: iso(1) }), agent("new", { lastActive: iso(9) }), agent("live", { status: "live", lastActive: iso(0) })], "");
    expect(rows.map((a) => a.id)).toEqual(["live", "new", "old"]);
    expect(rankSessions([agent("alpha"), agent("beta")], "BET").map((a) => a.id)).toEqual(["beta"]);
  });
});

describe("solo stays readable: capped lanes, the session in the middle", () => {
  function busy(n: number): GraphInput {
    const i = input();
    i.subagents = [
      ...Array.from({ length: n }, (_, k) => ({ ...sub(`b${String(k).padStart(2, "0")}`, "s1"), lastActive: iso(4 + k / 100) })),
      // a subagent of a subagent: same parent session, parentAgentId set
      { ...sub("nested", "s1"), parentAgentId: "b00", depth: 2, files: [{ path: "/repo/deep.ts", count: 50 }] },
      sub("other", "s2"),
    ];
    return i;
  }

  it("caps the subagents lane at SOLO_CAP and hangs the rest's links off '+N more'", () => {
    const g = buildGraph(busy(42), { ...ALL, solo: "s1" });
    expect(g.nodes.filter((n) => n.kind === "subagent")).toHaveLength(SOLO_CAP);
    expect(g.nodes.find((n) => n.id === "more:subagents")?.label).toBe(`+${43 - SOLO_CAP} more`);
    expect(g.edges.some((e) => e.from === "s1" && e.to === "more:subagents" && e.kind === "spawned")).toBe(true);
    // the hidden subagents' files are still on the canvas, linked from the stand-in
    expect(g.edges.some((e) => e.from === "more:subagents" && e.to === "file:/repo/deep.ts")).toBe(true);
    expect(g.nodes.some((n) => n.id === "subagent:other" || n.id === "s2")).toBe(false);
    expect(g.solo).toBe("s1");
  });

  it("a lane the user opened shows everything, nested subagents included", () => {
    const g = buildGraph(busy(42), { ...ALL, solo: "s1", expand: new Set(["subagents"]) });
    expect(g.nodes.filter((n) => n.kind === "subagent")).toHaveLength(43);
    expect(g.edges.some((e) => e.from === "subagent:b00" && e.to === "subagent:nested" && e.kind === "spawned")).toBe(true);
    expect(g.nodes.some((n) => n.id === "more:subagents")).toBe(false);
  });

  it("Everything keeps the old caps (no SOLO_CAP)", () => {
    const g = buildGraph(busy(42), { ...ALL, scope: "all" });
    expect(g.nodes.filter((n) => n.kind === "subagent")).toHaveLength(44);
    expect(g.solo).toBeNull();
  });

  it("lays the session lane out between what it used (left) and what it did (right), no empty lanes", () => {
    const l = layoutGraph(buildGraph(busy(42), { ...ALL, solo: "s1" }), new Set());
    const x = (id: string): number => l.lanes.find((b) => b.id === id)?.x ?? Number.NaN;
    expect(x("plan")).toBeLessThan(x("prompt"));
    expect(x("reason")).toBeLessThan(x("prompt"));
    expect(x("subagents")).toBeGreaterThan(x("prompt"));
    expect(x("files")).toBeGreaterThan(x("subagents"));
    expect(l.lanes.every((b) => b.count > 0)).toBe(true);
    expect(l.lanes.map((b) => b.x)).toEqual([...l.lanes.map((b) => b.x)].sort((a, b) => a - b));
    // every lane is a single column of at most SOLO_CAP cards + its "+N more"
    for (const b of l.lanes) expect(b.count).toBeLessThanOrEqual(SOLO_CAP + 1);
  });
});
