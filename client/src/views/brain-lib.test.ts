import { describe, expect, it } from "vitest";
import type { BrainNode } from "../../../shared/features/brain";
import { bounds, climbRuleLabel, climbStepTitle, combineFolderFilters, combineGroupFilters, GRAPH_RETRY_MAX, graphRetryDelayMs, graphRetryText, nodeRadius, filterGraph, folderColor, folderLabel, groupLabel, isMemoryPath, localGraph, neighbourMap, obsidianUrl, resolveLink, seedLayout, stepLayout } from "./brain-lib";

const node = (id: number, path: string, degree = 1, group = "other"): BrainNode => ({
  id,
  label: path.split("/").pop() ?? path,
  path,
  folder: path.includes("/") ? (path.split("/")[0] ?? "") : "",
  group,
  degree,
  community: 0,
});

const nodes = [
  node(1, "20-Projects/agent-world/plan", 5),
  node(2, "30-Knowledge/concepts/force-layout", 2),
  node(3, "60-Meta/claude-config/memory/feedback_x", 1),
  node(4, "50-Wiki/testing", 3),
  node(5, "10-Sessions/2026-09-25", 1),
];
const edges: Array<[number, number]> = [
  [1, 2],
  [1, 4],
  [3, 4],
  [4, 5],
];

describe("brain-lib", () => {
  it("colours folders and knows memory paths", () => {
    expect(folderColor("20-Projects")).toBe("#22c55e");
    expect(folderColor("nope")).toBe("#b8b0cc");
    expect(isMemoryPath("60-Meta/claude-config/memory/feedback_x")).toBe(true);
    expect(isMemoryPath("50-Wiki/testing")).toBe(false);
  });

  it("sizes nodes by degree, log-scaled and capped", () => {
    expect(nodeRadius(0)).toBe(3);
    expect(nodeRadius(10)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(8663)).toBe(22);
  });

  it("builds the obsidian link without .md and fully encoded", () => {
    expect(obsidianUrl("20-Projects/a b/plan.md")).toBe("obsidian://open?vault=alex_claude&file=20-Projects%2Fa%20b%2Fplan");
  });

  it("filters by folder, memory, and project (+ neighbours)", () => {
    expect(filterGraph({ nodes, edges }, { folders: ["50-Wiki", "10-Sessions"], memoryOnly: false, project: null }).edges).toEqual([[4, 5]]);
    expect(filterGraph({ nodes, edges }, { folders: [], memoryOnly: true, project: null }).nodes.map((n) => n.id)).toEqual([3]);
    const p = filterGraph({ nodes, edges }, { folders: [], memoryOnly: false, project: "agent-world" });
    expect(p.nodes.map((n) => n.id).sort()).toEqual([1, 2, 4]);
    expect(filterGraph({ nodes, edges }, { folders: [], memoryOnly: false, project: "nothing-here" }).nodes).toEqual([]);
  });

  it("filters by group (round 11, package D's Legend 'type' toggles), same keep-list convention as folders", () => {
    const typed = [node(1, "a", 1, "knowledge"), node(2, "b", 1, "session"), node(3, "c", 1, "wiki")];
    expect(filterGraph({ nodes: typed, edges: [] }, { folders: [], groups: ["knowledge", "wiki"], memoryOnly: false, project: null }).nodes.map((n) => n.id)).toEqual([1, 3]);
    // empty/omitted groups = no restriction, same as folders
    expect(filterGraph({ nodes: typed, edges: [] }, { folders: [], groups: [], memoryOnly: false, project: null }).nodes.length).toBe(3);
    expect(filterGraph({ nodes: typed, edges: [] }, { folders: [], memoryOnly: false, project: null }).nodes.length).toBe(3);
  });

  it("groupLabel: known kinds get a human label, an unknown one falls back to itself", () => {
    expect(groupLabel("knowledge")).toBe("Knowledge");
    expect(groupLabel("session")).toBe("Sessions");
    expect(groupLabel("some-future-kind")).toBe("some-future-kind");
  });

  // The globe draws one of these per region and there is room for about a word, so the vault's
  // sort prefix has to go. The id is what everything else keys on, so this is display only.
  it("folderLabel: drops the vault's filing prefixes and reads as a name", () => {
    expect(folderLabel("10-Sessions")).toBe("Sessions");
    expect(folderLabel("30-Knowledge")).toBe("Knowledge");
    expect(folderLabel("Clippings")).toBe("Clippings");
    expect(folderLabel("_quarantine-dead-placeholders")).toBe("Quarantine dead placeholders");
  });

  it("folderLabel: names the vault root, which arrives as an empty id", () => {
    expect(folderLabel("")).toBe("Vault root");
  });

  it("folderLabel: leaves a year-like name alone, and never returns an empty pill", () => {
    expect(folderLabel("2026-reviews")).toBe("2026 reviews"); // not a two-digit prefix
    expect(folderLabel("99-")).toBe("99-"); // nothing left to show: keep the id
    expect(folderLabel("__")).toBe("__");
  });

  it("folderLabel: two folders that prettify alike keep distinct ids, so filters cannot blur", () => {
    expect(folderLabel("10-Notes")).toBe(folderLabel("_notes"));
    expect("10-Notes").not.toBe("_notes");
  });

  describe("combineFolderFilters / combineGroupFilters (round 11, package D's Legend)", () => {
    const all = ["00-Inbox", "10-Sessions", "20-Projects"];
    it("no restriction from either control -> no restriction", () => {
      expect(combineFolderFilters([], all, new Set())).toEqual([]);
    });
    it("only the Legend restricts: the real folder set minus the off-list", () => {
      expect(combineFolderFilters([], all, new Set(["10-Sessions"]))).toEqual(["00-Inbox", "20-Projects"]);
    });
    it("only the chips restrict: passes them through untouched", () => {
      expect(combineFolderFilters(["20-Projects"], all, new Set())).toEqual(["20-Projects"]);
    });
    it("both restrict: AND — a folder must clear both to show", () => {
      expect(combineFolderFilters(["10-Sessions", "20-Projects"], all, new Set(["20-Projects"]))).toEqual(["10-Sessions"]);
    });
    it("combineGroupFilters: no off-list -> no restriction, else the real set minus off", () => {
      expect(combineGroupFilters(["knowledge", "session"], new Set())).toEqual([]);
      expect(combineGroupFilters(["knowledge", "session"], new Set(["session"]))).toEqual(["knowledge"]);
    });
  });

  it("neighbour map is symmetric", () => {
    const m = neighbourMap(edges);
    expect([...(m.get(4) ?? [])].sort()).toEqual([1, 3, 5]);
    expect(m.get(2)?.has(1)).toBe(true);
  });

  it("layout is deterministic, finite and settles", () => {
    const a = seedLayout(nodes);
    const b = seedLayout(nodes);
    expect([...a.values()]).toEqual([...b.values()]);
    let moved = Infinity;
    for (let i = 0; i < 300; i++) moved = stepLayout(a, edges, 1 - i / 300);
    expect(moved).toBeLessThan(0.5);
    for (const p of a.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    const bx = bounds(a);
    expect(bx.w).toBeGreaterThan(0);
    expect(bounds(new Map())).toEqual({ x: -100, y: -100, w: 200, h: 200 });
  });

  it("resolves wikilinks: server outlinks first, then graph paths / basenames, then relative", () => {
    const out = [{ path: "50-Wiki/testing.md", title: "testing" }];
    expect(resolveLink("testing", out, nodes)).toBe("50-Wiki/testing");
    expect(resolveLink("force-layout", [], nodes)).toBe("30-Knowledge/concepts/force-layout");
    expect(resolveLink("agent-world/plan", [], nodes)).toBe("20-Projects/agent-world/plan");
    expect(resolveLink("../testing", [], nodes, "50-Wiki/sub/note.md")).toBe("50-Wiki/testing");
    expect(resolveLink("does-not-exist", [], nodes)).toBeNull();
    expect(resolveLink("  ", [], nodes)).toBeNull();
  });

  it("local graph: outlinks right, backlinks left, both merged, no self", () => {
    const g = localGraph({ path: "a.md", title: "A" }, [{ path: "b.md", title: "B" }, { path: "c.md", title: "C" }, { path: "a.md", title: "A" }], [{ path: "c.md", title: "C" }, { path: "d.md", title: "D" }]);
    expect(g[0]).toMatchObject({ path: "a", kind: "center" });
    const by = Object.fromEntries(g.map((n) => [n.path, n]));
    expect(by.c?.kind).toBe("both");
    expect(by.d?.kind).toBe("back");
    expect((by.b?.x ?? 0) > 0).toBe(true);
    expect((by.d?.x ?? 0) < 0).toBe(true);
    expect(g.length).toBe(4);
  });
});

describe("graph load retries", () => {
  it("backs off on a timeout or a 5xx, up to the cap", () => {
    expect([0, 1, 2, 3, 4].map((a) => graphRetryDelayMs(a, 0))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(graphRetryDelayMs(0, 503)).toBe(2_000);
    expect(graphRetryDelayMs(GRAPH_RETRY_MAX, 0)).toBeNull();
  });
  it("never retries an answer that won't change (no file, too large)", () => {
    expect(graphRetryDelayMs(0, 404)).toBeNull();
    expect(graphRetryDelayMs(0, 413)).toBeNull();
  });
  it("says what failed, when and which attempt", () => {
    expect(graphRetryText("timed out", 4_000, 1)).toBe("Could not load the graph (timed out). Retrying in 4 s (2 of 5)…");
  });
});

describe("climb labels", () => {
  it("names each rule the way a reader would say it", () => {
    expect(climbRuleLabel("broader")).toBe("a kind of");
    expect(climbRuleLabel("mentions")).toBe("about");
    expect(climbRuleLabel("project")).toBe("in project");
    expect(climbRuleLabel("home")).toBe("no genus yet");
    expect(climbRuleLabel("")).toBe("");
  });

  it("titles a step by note name, or by folder for an _index note", () => {
    expect(climbStepTitle("20-Projects/acme/_index.md")).toBe("acme");
    expect(climbStepTitle("50-Wiki/_index.md")).toBe("Wiki");
    expect(climbStepTitle("50-Wiki/product-mgmt.md")).toBe("product mgmt");
    expect(climbStepTitle("10-Sessions/2026-10-01-pricing-call.md")).toBe("pricing call");
    expect(climbStepTitle("Home.md")).toBe("Home");
  });
});
