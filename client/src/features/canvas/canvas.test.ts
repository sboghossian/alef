import { describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS } from "../../../../shared/autonomy";
import type { SubagentRecord } from "../../../../shared/features/subagents";
import type { Island, JevDecision, WorldAgent, WorldEdge, WorldObject } from "../../../../shared/types";
import { shortModel } from "../subagent-data";
import { droneSlots, MAX_PARKED } from "../subagents-drones";
import { activityTarget, buildGraph, isMemoryPath, type GraphFilter, type GraphInput } from "./graph";
import { CARD_W, LANE_W, WRAP_AT, bezierPoint, edgeCurve, layoutAutonomy, layoutGraph, listGroups } from "./layout";
import { clampK, clampPan, fitView, intersects, MAX_K, MIN_K, screenToWorld, visibleWorld, wheelFactor, worldToScreen, zoomAt } from "./view";

const NOW = Date.parse("2026-09-25T12:00:00");
const today = (h: number): string => new Date(Date.parse("2026-09-25T00:00:00") + h * 3600_000).toISOString();

function agent(id: string, over: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id,
    islandId: "city-a",
    cwd: "/x",
    title: `title ${id}`,
    status: "dormant",
    startedAt: today(1),
    lastActive: today(2),
    messageCount: 3,
    model: "claude-opus-5-5",
    role: "builder",
    color: "#fff",
    targetIslandId: "city-a",
    tokens: 10,
    awaitingInput: false,
    ...over,
  };
}

function sub(id: string, parent: string, over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id,
    parentSessionId: parent,
    parentAgentId: null,
    workflowId: null,
    description: `sub ${id}`,
    agentType: "general-purpose",
    model: "claude-sonnet-5",
    status: "done",
    reason: null,
    startedAt: today(3),
    lastActive: today(4),
    tokens: 5,
    toolCounts: { Read: 2, mcp__linear__save_issue: 1 },
    files: [{ path: "/repo/sub-file.ts", count: 2 }],
    depth: 1,
    ...over,
  };
}

function input(): GraphInput {
  const objects = new Map<string, WorldObject>(
    (
      [
        { id: "skill:humanizer", kind: "skill", name: "humanizer", islandId: "harness", usage: 3, growth: 0 },
        { id: "file:/repo/a.ts", kind: "file", name: "a.ts", islandId: "city-a", usage: 2, growth: 0 },
        { id: "file:/Users/me/.claude/projects/p/memory/MEMORY.md", kind: "file", name: "MEMORY.md", islandId: "city-a", usage: 1, growth: 0 },
        { id: "hook:UserPromptSubmit:recall", kind: "hook", name: "UserPromptSubmit:recall", islandId: "harness", usage: 9, growth: 0 },
        { id: "mcp:linear", kind: "mcp", name: "linear", islandId: "harness", usage: 1, growth: 0 },
      ] satisfies WorldObject[]
    ).map((o) => [o.id, o]),
  );
  const edges: WorldEdge[] = [
    { from: "s1", to: "skill:humanizer", kind: "uses", weight: 2, at: today(2) },
    { from: "s1", to: "file:/repo/a.ts", kind: "touched", weight: 4, at: today(2) },
    { from: "s1", to: "file:/Users/me/.claude/projects/p/memory/MEMORY.md", kind: "touched", weight: 1, at: today(2) },
    { from: "old", to: "file:/repo/a.ts", kind: "touched", weight: 1, at: "2026-01-01T00:00:00Z" },
    { from: "s1", to: "s2", kind: "visited", weight: 1, at: today(2) },
  ];
  const decisions: JevDecision[] = [
    { id: "d1", at: today(2), kind: "pair", subjects: ["s1", "s2"], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "pair" },
  ];
  const islands = new Map<string, Island>([["city-a", { id: "city-a", name: "a", path: "/a", agentCount: 3, lastActive: today(2) }]]);
  return {
    agents: [agent("s1", { status: "live" }), agent("s2"), agent("old", { lastActive: "2026-01-01T00:00:00Z", islandId: "city-b" })],
    objects,
    edges,
    islands,
    subagents: [sub("a1", "s1", { status: "running" }), sub("a2", "s1", { parentAgentId: "a1", depth: 2 }), sub("a9", "old")],
    decisions,
    jevStatus: "online",
    approvals: [{ id: "ap1", agentId: "s2", toolName: "Bash", title: "rm -rf build" }],
    routines: [{ label: "com.stephane.x", shortName: "x", running: false, lastExitStatus: 0 }],
  };
}

const TODAY: GraphFilter = { scope: "today", city: null, tree: null, keep: null, nowMs: NOW };

describe("pan / zoom math", () => {
  it("zoomAt keeps the world point under the cursor fixed", () => {
    const v = { x: 120, y: -40, k: 0.7 };
    const before = screenToWorld(v, 500, 300);
    const z = zoomAt(v, 1.8, 500, 300);
    const after = screenToWorld(z, 500, 300);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(z.k).toBeCloseTo(1.26, 6);
  });

  it("clamps zoom and still anchors at the clamp", () => {
    const v = { x: 0, y: 0, k: 2 };
    const z = zoomAt(v, 10, 200, 100);
    expect(z.k).toBe(MAX_K);
    const w = screenToWorld(z, 200, 100);
    expect(w.x).toBeCloseTo(100, 6);
    expect(clampK(0.0001)).toBe(MIN_K);
  });

  it("fitView centers the bounds inside the viewport (with padding) and caps k", () => {
    const b = { x: -20, y: -20, w: 2000, h: 1000 };
    const v = fitView(b, 1000, 800, 40);
    expect(v.k).toBeCloseTo(0.46, 6);
    const tl = worldToScreen(v, b.x, b.y);
    const br = worldToScreen(v, b.x + b.w, b.y + b.h);
    expect(tl.x).toBeCloseTo(40, 6);
    expect(br.x).toBeCloseTo(960, 6);
    expect((tl.y + br.y) / 2).toBeCloseTo(400, 6);
    expect(fitView({ x: 0, y: 0, w: 10, h: 10 }, 1000, 800).k).toBe(1.2); // tiny graphs are not blown up
  });

  it("clampPan never lets the content leave the screen", () => {
    const content = { x: 0, y: 0, w: 1000, h: 1000 };
    const away = clampPan({ x: -5000, y: 9000, k: 1 }, content, 800, 600, 80);
    const tl = worldToScreen(away, content.x, content.y);
    const br = worldToScreen(away, content.x + content.w, content.y + content.h);
    expect(br.x).toBeGreaterThanOrEqual(80);
    expect(tl.y).toBeLessThanOrEqual(600 - 80);
    const fine = { x: -100, y: -100, k: 1 };
    expect(clampPan(fine, content, 800, 600)).toEqual(fine);
  });

  it("visibleWorld is the inverse of the view, plus overscan", () => {
    const v = { x: 50, y: 20, k: 0.5 };
    const r = visibleWorld(v, 800, 600, 100);
    expect(r.x).toBeCloseTo(-100 - 200, 6);
    expect(r.w).toBeCloseTo(1600 + 400, 6);
    expect(intersects(r, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(intersects(r, { x: 5000, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it("wheel: scroll down zooms out, pinch is more sensitive, line mode is scaled", () => {
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(10, 0, true)).toBeLessThan(wheelFactor(10, 0, false));
    expect(wheelFactor(3, 1, false)).toBeCloseTo(wheelFactor(48, 0, false), 9);
  });
});

describe("graph: nodes, lanes, typed edges", () => {
  it("types every edge and puts each node in its lane", () => {
    const g = buildGraph(input(), TODAY);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("s1")?.place).toBe("prompt");
    expect(byId.get("skill:humanizer")?.place).toBe("plan");
    expect(byId.get("file:/repo/a.ts")?.place).toBe("files");
    expect(byId.get("file:/Users/me/.claude/projects/p/memory/MEMORY.md")?.place).toBe("brain");
    expect(byId.get("hook:UserPromptSubmit:recall")?.place).toBe("hook");
    expect(byId.get("model:Opus 5.5")?.place).toBe("reason");
    expect(byId.get("mcp:linear")?.place).toBe("tools");
    expect(byId.get("subagent:a1")?.place).toBe("subagents");
    expect(byId.get("jev")?.place).toBe("top");
    expect(byId.get("approval:ap1")?.place).toBe("top");
    expect(byId.get("routine:com.stephane.x")?.place).toBe("bottom");

    const kinds = new Map(g.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(kinds.get("s1>subagent:a1")).toBe("spawned");
    expect(kinds.get("subagent:a1>subagent:a2")).toBe("spawned"); // nested spawn hangs off its parent subagent
    expect(kinds.get("s1>skill:humanizer")).toBe("uses");
    expect(kinds.get("s1>file:/repo/a.ts")).toBe("touched");
    expect(kinds.get("subagent:a1>file:/repo/sub-file.ts")).toBe("touched");
    expect(kinds.get("subagent:a1>mcp:linear")).toBe("uses");
    expect(kinds.get("s1>model:Opus 5.5")).toBe("uses");
    expect(kinds.get("jev>s1")).toBe("decided");
    expect(kinds.get("approval:ap1>s2")).toBe("awaits");
    expect(g.edges.some((e) => e.from === "s1" && e.to === "s2")).toBe(false); // "visited" is a planet thing
    expect(g.edges.every((e) => byId.has(e.from) && byId.has(e.to))).toBe(true);
  });

  it("live + today leaves old sessions out unless they are the shared selection", () => {
    const g = buildGraph(input(), TODAY);
    expect(g.nodes.some((n) => n.id === "old")).toBe(false);
    expect(g.nodes.some((n) => n.id === "subagent:a9")).toBe(false);
    const kept = buildGraph(input(), { ...TODAY, keep: "old" });
    expect(kept.nodes.some((n) => n.id === "old")).toBe(true);
    expect(kept.nodes.some((n) => n.id === "subagent:a9")).toBe(true);
    const all = buildGraph(input(), { ...TODAY, scope: "all" });
    expect(all.nodes.filter((n) => n.kind === "session")).toHaveLength(3);
  });

  it("tree and city filters narrow to one session / one city", () => {
    const tree = buildGraph(input(), { ...TODAY, scope: "all", tree: "s1", keep: "s1" });
    expect(tree.nodes.filter((n) => n.kind === "session").map((n) => n.id)).toEqual(["s1"]);
    expect(tree.nodes.filter((n) => n.kind === "subagent")).toHaveLength(2);
    const city = buildGraph(input(), { ...TODAY, scope: "all", city: "city-b" });
    expect(city.nodes.filter((n) => n.kind === "session").map((n) => n.id)).toEqual(["old"]);
  });

  it("activityTarget: the object when on the canvas, else the stage's lane", () => {
    const has = { has: (id: string) => id === "skill:humanizer" || id === "model:Opus 5.5" || id === "hook:UserPromptSubmit:b" };
    expect(activityTarget(has, "plan", "skill:humanizer", null, [])).toBe("skill:humanizer");
    expect(activityTarget(has, "reason", null, "claude-opus-5-5[1m]", [])).toBe("model:Opus 5.5");
    expect(activityTarget(has, "hook", null, null, ["hook:SessionStart:a", "hook:UserPromptSubmit:b"])).toBe("hook:UserPromptSubmit:b");
    expect(activityTarget(has, "tool", "file:/nope", null, [])).toBeNull();
  });

  it("activityTarget: a hook stage returns null when no hook is laid out (Autonomy mode never lays out hooks — GRO review finding)", () => {
    const noHooksLaidOut = { has: () => false };
    expect(activityTarget(noHooksLaidOut, "hook", null, null, ["hook:SessionStart:a", "hook:UserPromptSubmit:b"])).toBeNull();
  });

  it("memory paths go to the Brain lane", () => {
    expect(isMemoryPath("/Users/x/.claude/projects/-Users-x/memory/feedback.md")).toBe(true);
    expect(isMemoryPath("/Users/x/Documents/Code/alex_claude/20-Projects/a.md")).toBe(true);
    expect(isMemoryPath("/Users/x/Documents/Code/app/src/memory.ts")).toBe(false);
  });
});

describe("lane layout", () => {
  it("is deterministic regardless of input order", () => {
    const g = buildGraph(input(), { ...TODAY, scope: "all" });
    const a = layoutGraph(g, new Set());
    const shuffled = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    const b = layoutGraph(shuffled, new Set());
    const boxes = (l: typeof a): string[] => [...l.nodes.values()].map((n) => `${n.id}@${n.x},${n.y},${n.w},${n.h}`).sort();
    expect(boxes(b)).toEqual(boxes(a));
  });

  it("lanes run left to right in the documented order and cards never overlap", () => {
    const g = buildGraph(input(), { ...TODAY, scope: "all" });
    const l = layoutGraph(g, new Set());
    expect(l.lanes.map((x) => x.id)).toEqual(["prompt", "hook", "router", "tiers", "brain", "plan", "reason", "tools", "subagents", "files"]);
    for (let i = 1; i < l.lanes.length; i++) expect((l.lanes[i]?.x ?? 0) > (l.lanes[i - 1]?.x ?? 0)).toBe(true);
    const cards = [...l.nodes.values()];
    for (const a of cards) for (const b of cards) if (a !== b) expect(intersects(a, b)).toBe(false);
    const x = (id: string): number => l.nodes.get(id)?.x ?? -1;
    expect(x("s1")).toBeLessThan(x("hook:UserPromptSubmit:recall"));
    expect(x("model:Opus 5.5")).toBeLessThan(x("subagent:a1"));
    expect(x("subagent:a1")).toBeLessThan(x("file:/repo/a.ts"));
    // the nested subagent sits below its parent
    expect(l.nodes.get("subagent:a2")?.y ?? 0).toBeGreaterThan(l.nodes.get("subagent:a1")?.y ?? 0);
  });

  it("groups sessions by city (live cities first) and hides a collapsed city's cards", () => {
    const g = buildGraph(input(), { ...TODAY, scope: "all" });
    const l = layoutGraph(g, new Set());
    expect(l.groups.map((gr) => gr.id)).toEqual(["city-a", "city-b"]);
    const collapsed = layoutGraph(g, new Set(["city-a"]));
    expect(collapsed.nodes.has("s1")).toBe(false);
    expect(collapsed.groups.find((gr) => gr.id === "city-a")?.collapsed).toBe(true);
    expect(collapsed.nodes.has("old")).toBe(true);
  });

  it("wraps a crowded lane into columns", () => {
    const base = input();
    const many = Array.from({ length: WRAP_AT * 2 + 1 }, (_, i) => ({ from: "s1", to: `file:/repo/f${String(i).padStart(3, "0")}.ts`, kind: "touched" as const, weight: 1, at: today(2) }));
    const g = buildGraph({ ...base, edges: [...base.edges, ...many] }, TODAY);
    const l = layoutGraph(g, new Set());
    const files = l.lanes.find((x) => x.id === "files");
    expect(files?.w).toBeGreaterThan(CARD_W * 2);
    const xs = new Set([...l.nodes.values()].filter((n) => n.place === "files").map((n) => n.x));
    expect(xs.size).toBe(3);
  });

  it("edge curves leave the source's right side and enter the target's left side", () => {
    const a = { x: 0, y: 0, w: 100, h: 40 };
    const b = { x: 400, y: 200, w: 100, h: 40 };
    const c = edgeCurve(a, b);
    expect([c[0], c[1]]).toEqual([100, 20]);
    expect([c[6], c[7]]).toEqual([400, 220]);
    expect(bezierPoint(c, 0)).toEqual({ x: 100, y: 20 });
    expect(bezierPoint(c, 1)).toEqual({ x: 400, y: 220 });
    const vertical = edgeCurve({ x: 0, y: 0, w: 100, h: 40 }, { x: 10, y: 300, w: 100, h: 40 });
    expect(vertical[1]).toBe(40); // bottom of the rail card
  });
});

describe("autonomy layout (shared/autonomy.ts + layoutAutonomy)", () => {
  // One real-shaped session per level, plus a subagent (always level 4 — see graph.ts).
  function autonomyInput(): GraphInput {
    const base = input();
    return {
      ...base,
      agents: [
        agent("lvl1", { title: "fix the login bug on the pricing page", messageCount: 320, islandId: "city-a", lastActive: today(10) }),
        agent("lvl2", { title: "clean up the stale feature branches", messageCount: 3, islandId: "city-a", lastActive: today(9) }),
        agent("lvl3", { title: '<scheduled-task name="rss-feed-obsidian" file="…">go', messageCount: 12, islandId: "city-b", lastActive: today(8) }),
        agent("lvl4", { title: "headless run: reconcile the invoice queue overnight", messageCount: 40, islandId: "city-b", lastActive: today(7) }),
        agent("lvl5", { title: "fix the login bug", messageCount: 500, cwd: "/Users/x/.alef-resident", islandId: "city-a", lastActive: today(6) }),
      ],
      subagents: [sub("subA", "lvl1", { status: "running" })],
    };
  }

  it("tags every session and subagent CNode with its autonomy level, and nothing else", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("lvl1")?.autonomy).toBe(1);
    expect(byId.get("lvl2")?.autonomy).toBe(2);
    expect(byId.get("lvl3")?.autonomy).toBe(3);
    expect(byId.get("lvl4")?.autonomy).toBe(4);
    expect(byId.get("lvl5")?.autonomy).toBe(5);
    expect(byId.get("subagent:subA")?.autonomy).toBe(4);
    // Everything else buildGraph produces (skills, hooks, mcps, files, jev, the router/tier
    // cards, routines…) is untouched: no autonomy level.
    const untouchedKinds = g.nodes.filter((n) => n.kind !== "session" && n.kind !== "subagent");
    expect(untouchedKinds.length).toBeGreaterThan(0);
    expect(untouchedKinds.every((n) => n.autonomy === undefined)).toBe(true);
  });

  it("places every node inside its own level's band, with no overlaps, in both y-modes", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    for (const yMode of ["recency", "district"] as const) {
      const l = layoutAutonomy(g, new Set(), yMode);
      expect(l.autonomyBands).toHaveLength(5);
      expect(l.lanes).toEqual([]); // the graph's Lane bands are unused in this mode
      const bandByLevel = new Map(l.autonomyBands!.map((b) => [b.level, b]));
      const placed = [...l.nodes.values()].filter((n) => n.kind === "session" || n.kind === "subagent");
      expect(placed.length).toBeGreaterThan(0);
      for (const n of placed) {
        const band = bandByLevel.get(n.autonomy!);
        expect(band).toBeDefined();
        expect(n.x).toBeGreaterThanOrEqual(band!.x);
        expect(n.x + n.w).toBeLessThanOrEqual(band!.x + band!.w);
      }
      // No two placed cards overlap.
      for (const a of placed) for (const b of placed) if (a !== b) expect(intersects(a, b)).toBe(false);
      // Non-session/subagent kinds never make it into the Autonomy layout's node map at all.
      for (const n of l.nodes.values()) expect(n.kind === "session" || n.kind === "subagent").toBe(true);
    }
  });

  it("bands run left to right in level order (1 driven-by-you → 5 the resident)", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const l = layoutAutonomy(g, new Set(), "recency");
    const bands = l.autonomyBands!;
    expect(bands.map((b) => b.level)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < bands.length; i++) expect(bands[i]!.x).toBeGreaterThan(bands[i - 1]!.x);
  });

  it("recency mode puts the most recently active node on top within a band", () => {
    const g = buildGraph(
      {
        ...autonomyInput(),
        agents: [
          agent("older", { title: "fix a thing", messageCount: 50, lastActive: today(1) }),
          agent("newer", { title: "fix another thing", messageCount: 50, lastActive: today(20) }),
        ],
      },
      { ...TODAY, scope: "all" },
    );
    const l = layoutAutonomy(g, new Set(), "recency");
    expect(l.nodes.get("newer")!.y).toBeLessThan(l.nodes.get("older")!.y);
  });

  it("district mode groups sessions by city and respects the shared collapsed set; subagents trail ungrouped", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const l = layoutAutonomy(g, new Set(), "district");
    // lvl4's session (city-b) and lvl1's subagent both land in level 4: one real city group,
    // plus the subagent placed without any group header.
    expect(l.groups.some((gr) => gr.id === "city-b")).toBe(true);
    expect(l.nodes.has("subagent:subA")).toBe(true);
    const collapsed = layoutAutonomy(g, new Set(["city-a"]), "district");
    expect(collapsed.nodes.has("lvl1")).toBe(false); // city-a, collapsed
    expect(collapsed.groups.find((gr) => gr.id === "city-a")?.collapsed).toBe(true);
    expect(collapsed.nodes.has("lvl3")).toBe(true); // city-b, not collapsed
  });

  it("is deterministic regardless of input order, in both y-modes", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const boxesOf = (l: ReturnType<typeof layoutAutonomy>): string[] => [...l.nodes.values()].map((n) => `${n.id}@${n.x},${n.y}`).sort();
    for (const yMode of ["recency", "district"] as const) {
      const a = layoutAutonomy(g, new Set(), yMode);
      const shuffled = { ...g, nodes: [...g.nodes].reverse() };
      const b = layoutAutonomy(shuffled, new Set(), yMode);
      expect(boxesOf(b)).toEqual(boxesOf(a));
    }
  });

  it("appends the classifier's reason to the card's sub-line", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const l = layoutAutonomy(g, new Set(), "recency");
    expect(l.nodes.get("lvl3")!.sub).toContain("named automation: ⏰ rss-feed-obsidian");
  });

  it("a level-4 band's header discloses the subagents lane's hidden count; every other band never shows one (GRO review finding)", () => {
    const base = autonomyInput();
    const manySubs = Array.from({ length: 450 }, (_, i) => sub(`many-${i}`, "lvl1", { lastActive: today(i % 20) }));
    const g = buildGraph({ ...base, subagents: [...base.subagents, ...manySubs] }, { ...TODAY, scope: "all" });
    expect(g.hidden.subagents).toBeGreaterThan(0); // buildGraph's own LANE_CAPS.subagents cap
    const l = layoutAutonomy(g, new Set(), "recency");
    const level4 = l.autonomyBands!.find((band) => band.level === 4)!;
    expect(level4.hidden).toBe(g.hidden.subagents);
    for (const band of l.autonomyBands!) if (band.level !== 4) expect(band.hidden).toBe(0);
  });

  it("district mode's column count comes from the ungrouped trailing cards, not the whole level (GRO review finding: cosmetic width bug)", () => {
    const base = autonomyInput();
    // WRAP_AT+6 level-1 sessions, 0 trailing (non-session) cards at that level: before the fix
    // `cols` was computed from the whole level (sessions included), giving 2 columns of which one
    // was always empty, since district mode always stacks a city's sessions in a single column.
    const manySessions = Array.from({ length: WRAP_AT + 5 }, (_, i) => agent(`extra-${i}`, { title: `fix bug number ${i}`, messageCount: 320, islandId: "city-a", lastActive: today(10) }));
    const g = buildGraph({ ...base, agents: [...base.agents, ...manySessions] }, { ...TODAY, scope: "all" });
    const l = layoutAutonomy(g, new Set(), "district");
    const level1 = l.autonomyBands!.find((band) => band.level === 1)!;
    expect(level1.count).toBe(WRAP_AT + 6); // lvl1 + the extras
    expect(level1.w).toBe(LANE_W); // a single column, not wrapped into an empty second one
  });

  it("listGroups groups by autonomy band (not by lane) for a layoutAutonomy() layout (GRO review finding: the phone list was always by-lane)", () => {
    const g = buildGraph(autonomyInput(), { ...TODAY, scope: "all" });
    const l = layoutAutonomy(g, new Set(), "recency");
    const groups = listGroups(l);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((grp) => AUTONOMY_LEVELS.some((m) => m.title === grp.title))).toBe(true);
    expect(groups.some((grp) => grp.title.includes("Prompt"))).toBe(false);
    expect(groups.find((grp) => grp.title === "1 · Driven by you")?.nodes.some((n) => n.id === "lvl1")).toBe(true);
  });

  it("listGroups falls back to lane grouping for a layoutGraph() layout (regression)", () => {
    const g = buildGraph(input(), { ...TODAY, scope: "all" });
    const l = layoutGraph(g, new Set());
    const groups = listGroups(l);
    expect(groups.some((grp) => grp.title === "Prompt · Sessions")).toBe(true);
  });
});

describe("drones + labels", () => {
  it("live subagents fly, up to 12 finished ones park, the rest are counted", () => {
    const kids = [sub("r1", "p", { status: "running" }), ...Array.from({ length: 15 }, (_, i) => sub(`d${i}`, "p", { lastActive: today(i % 10) }))];
    const s = droneSlots(kids);
    expect(s.live.map((k) => k.id)).toEqual(["r1"]);
    expect(s.parked).toHaveLength(MAX_PARKED);
    expect(s.overflow).toBe(3);
    expect(droneSlots([...kids].reverse())).toEqual(s);
  });

  it("shortModel", () => {
    expect(shortModel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(shortModel(null)).toBe("unknown model");
  });
});

describe("router + model-tier lanes (round 11)", () => {
  it("adds one Jev router node and one tier per family with sessions, with real counts", () => {
    const g = buildGraph(input(), TODAY);
    const router = g.nodes.find((n) => n.id === "router:jev");
    expect(router?.place).toBe("router");
    expect(router?.status).toBe("absent"); // the fixture's only UserPromptSubmit hook is "recall"
    expect(router?.sub).toContain("hook not seen");
    const opus = g.nodes.find((n) => n.id === "tier:opus");
    // 3 opus agents in the fixture: s1 live, s2 today, old outside the today scope.
    expect(opus?.sub).toBe("1 live · 2 in view · 3 all");
    expect(g.nodes.some((n) => n.id === "tier:haiku")).toBe(false);
    expect(g.edges.find((e) => e.from === "router:jev" && e.to === "tier:opus")?.weight).toBe(2);
    // tier → the Reason lane's model node of that family
    expect(g.edges.some((e) => e.from === "tier:opus" && e.to.startsWith("model:"))).toBe(true);
  });

  it("names the UserPromptSubmit node hook when it is likely the Jev router", () => {
    const inp = input();
    const objects = new Map(inp.objects);
    objects.set("hook:UserPromptSubmit:node", { id: "hook:UserPromptSubmit:node", kind: "hook", name: "UserPromptSubmit:node", islandId: "harness", usage: 1, growth: 0 });
    const g = buildGraph({ ...inp, objects }, TODAY);
    const router = g.nodes.find((n) => n.id === "router:jev");
    expect(router?.status).toBe("likely");
    expect(router?.sub).toContain("UserPromptSubmit · node");
    expect(router?.live).toBe(true); // hook likely + Jev online
  });

  it("in a one-session tree only that session's tier shows", () => {
    const g = buildGraph(input(), { ...TODAY, tree: "s1" });
    expect(g.nodes.filter((n) => n.kind === "tier").map((n) => n.id)).toEqual(["tier:opus"]);
  });

  // The lane's whole problem was that it showed install state while the real decisions sat
  // unread in the hook's log, so these pin that the decisions now drive it.
  const cards = (byTier: { opus: number; fable: number; sonnet: number; haiku: number }, over: Record<string, unknown> = {}) => ({
    total: Object.values(byTier).reduce((a, b) => a + b, 0),
    today: 4,
    byTier,
    down: 0,
    rules: 0,
    lastAt: "2026-10-26T04:00:00.000Z",
    ...over,
  });

  it("leads the router card with real decisions when the log has them", () => {
    const g = buildGraph({ ...input(), routeCards: cards({ opus: 219, fable: 0, sonnet: 155, haiku: 350 }) }, TODAY);
    const router = g.nodes.find((n) => n.id === "router:jev");
    expect(router?.sub).toMatch(/^724 decisions · 4 today · /);
    expect(router?.sub).toContain("hook not seen"); // install state still there, just no longer first
    expect(router?.weight).toBe(724);
  });

  it("says so plainly when nothing has been logged", () => {
    expect(buildGraph(input(), TODAY).nodes.find((n) => n.id === "router:jev")?.sub).toContain("no decisions logged");
  });

  it("edges carry what the router ADVISED, not how many sessions are on that tier", () => {
    // The fixture has 2 opus sessions in view; the router advised opus 219 times. The old
    // lane drew 2 and called it "uses", which is the fact that was never the router's.
    const g = buildGraph({ ...input(), routeCards: cards({ opus: 219, fable: 0, sonnet: 155, haiku: 350 }) }, TODAY);
    const e = g.edges.find((x) => x.from === "router:jev" && x.to === "tier:opus");
    expect(e?.weight).toBe(219);
    expect(e?.kind).toBe("decided");
    expect(g.nodes.find((n) => n.id === "tier:opus")?.sub).toBe("219 advised · 1 live · 2 in view · 3 all");
  });

  it("keeps a tier the router advises even when no session ever runs on it", () => {
    // Haiku has no sessions in this fixture at all, so the old lane dropped it entirely —
    // hiding exactly the case worth seeing: advised often, run never.
    const g = buildGraph({ ...input(), routeCards: cards({ opus: 219, fable: 0, sonnet: 155, haiku: 350 }) }, TODAY);
    const haiku = g.nodes.find((n) => n.id === "tier:haiku");
    expect(haiku?.sub).toBe("350 advised · 0 live · 0 in view · 0 all");
    expect(g.edges.find((x) => x.from === "router:jev" && x.to === "tier:haiku")?.weight).toBe(350);
  });

  it("draws no edge to a tier the router has never picked", () => {
    const g = buildGraph({ ...input(), routeCards: cards({ opus: 219, fable: 0, sonnet: 155, haiku: 350 }) }, TODAY);
    expect(g.edges.some((x) => x.from === "router:jev" && x.to === "tier:fable")).toBe(false);
  });
});
