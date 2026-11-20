import { describe, expect, it } from "vitest";
import type { ArchiveSummary } from "../../../shared/features/archive";
import { archivedByGroup, archivedByIsland, fossilOffset, islandIdsWithAgents, isArchivedDistrict, visibleIslands, withArchiveRows } from "./archive-lib";

const summary: ArchiveSummary = {
  generatedAt: "2026-09-27T00:00:00.000Z",
  files: 10,
  parsed: 10,
  skipped: 0,
  duplicates: 0,
  skippedLive: 1,
  total: 9,
  homeIslandId: "home",
  vault: "alex_claude",
  places: [
    { key: "island:acme-ai-next", kind: "island", ref: "acme-ai-next", group: "", count: 4 },
    { key: "topic:AUTO", kind: "topic", ref: "AUTO", group: "AUTO", count: 2 },
    { key: "topic:OTHER", kind: "topic", ref: "OTHER", group: "OTHER", count: 1 },
    { key: "archived:crucible", kind: "archived", ref: "crucible", group: "RESEARCH", count: 2 },
  ],
};
const continentOf = (id: string): string | undefined => ({ "acme-ai-next": "WEB", home: "AUTO" })[id];

describe("archive counts", () => {
  it("per island: repo fossils on their city, home-dir topic fossils on the home row", () => {
    expect([...archivedByIsland(summary)]).toEqual([
      ["acme-ai-next", 4],
      ["home", 3],
    ]);
  });

  it("per continent: a city's fossils follow its continent; topic/archived use their own group", () => {
    expect(Object.fromEntries(archivedByGroup(summary, continentOf))).toEqual({ WEB: 4, AUTO: 2, OTHER: 1, RESEARCH: 2 });
  });

  it("district rows: adds archived counts and appends archived-only districts", () => {
    const rows = withArchiveRows(
      [
        { value: "acme-ai-next", label: "acme-ai-next", count: 10, meta: "2 live" },
        { value: "home", label: "~", count: 5 },
        { value: "quiet", label: "quiet", count: 1 },
      ],
      summary,
      continentOf,
    );
    expect(rows.map((r) => [r.value, r.count, r.meta])).toEqual([
      ["acme-ai-next", 14, "2 live · 4 archived"],
      ["home", 8, "3 archived"],
      ["quiet", 1, undefined],
      ["archived:crucible", 2, "archived · 2 fossils"],
    ]);
    expect(rows[3]?.group).toBe("RESEARCH");
    expect(isArchivedDistrict("archived:crucible")).toBe(true);
    expect(isArchivedDistrict("acme-ai-next")).toBe(false);
  });

  it("no summary yet: rows pass through untouched", () => {
    const rows = [{ value: "a", label: "a", count: 1 }];
    expect(withArchiveRows(rows, null, continentOf)).toEqual(rows);
  });
});

describe("islandIdsWithAgents", () => {
  it("collects every island id with at least one agent right now, deduped", () => {
    expect([...islandIdsWithAgents([{ islandId: "a" }, { islandId: "b" }, { islandId: "a" }])].sort()).toEqual(["a", "b"]);
  });

  it("empty agents map -> empty set", () => {
    expect(islandIdsWithAgents([]).size).toBe(0);
  });
});

describe("visibleIslands", () => {
  const island = (id: string) => ({ id });
  const noAgents = new Set<string>();

  it("summary not loaded yet: fails open, every island stays visible", () => {
    const islands = [island("acme-ai-next"), island("aleph"), island("downloads")];
    expect(visibleIslands(islands, noAgents, null).map((i) => i.id)).toEqual(["acme-ai-next", "aleph", "downloads"]);
  });

  it("once the summary loads: keeps islands with an agent or a fossil, drops the rest", () => {
    const islands = [island("acme-ai-next"), island("home"), island("downloads")];
    // acme-ai-next: 4 island fossils; home: 3 topic fossils (counted via homeIslandId); downloads: neither.
    expect(visibleIslands(islands, noAgents, summary).map((i) => i.id)).toEqual(["acme-ai-next", "home"]);
  });

  it("a fossil-only island (e.g. aleph) is visible once the summary loads, with 0 agents", () => {
    const fossilSummary: ArchiveSummary = { ...summary, places: [{ key: "island:aleph", kind: "island", ref: "aleph", group: "", count: 66 }] };
    expect(visibleIslands([island("aleph"), island("downloads")], noAgents, fossilSummary).map((i) => i.id)).toEqual(["aleph"]);
  });

  it("a 0 -> 1 agent flips an island visible immediately, even with the summary loaded and 0 fossils", () => {
    expect(visibleIslands([island("downloads")], noAgents, summary).map((i) => i.id)).toEqual([]);
    expect(visibleIslands([island("downloads")], new Set(["downloads"]), summary).map((i) => i.id)).toEqual(["downloads"]);
  });

  it("always keeps harness, summary loaded or not, agents or none", () => {
    expect(visibleIslands([island("harness")], noAgents, summary).map((i) => i.id)).toEqual(["harness"]);
    expect(visibleIslands([island("harness")], noAgents, null).map((i) => i.id)).toEqual(["harness"]);
  });

  it("preserves extra fields and input order", () => {
    const rich = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    expect(visibleIslands(rich, new Set(["a"]), summary)).toEqual([{ id: "a", name: "A" }]);
  });
});

describe("fossilOffset", () => {
  it("starts at the inner radius and spreads outward without stacking", () => {
    const pts = Array.from({ length: 200 }, (_, i) => fossilOffset(i, 5));
    const r = pts.map(([x, z]) => Math.hypot(x, z));
    expect(Math.min(...r)).toBeGreaterThanOrEqual(5);
    expect(r[199]!).toBeGreaterThan(r[0]!);
    let minGap = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minGap = Math.min(minGap, Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1]));
    expect(minGap).toBeGreaterThan(0.15);
  });
});
