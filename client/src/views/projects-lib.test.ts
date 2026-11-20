import { describe, expect, it } from "vitest";
import type { ProjectItem } from "../../../shared/features/projects";
import { GROUP_CAP, NO_FILTER, ago, foldedLabel, islandsOf, visibleCards, displayName, displayPath, facetCounts, groupByCategory, logoUrl, matchesFilter, summaryLine, textShown, changeSummary, commitStats, costLabel, githubUrl, lastChangeLine, previewUrl, refreshLine, safeHttpUrl, sessionChips } from "./projects-lib";

function p(id: string, o: Partial<ProjectItem> = {}): ProjectItem {
  return { id, name: id, path: `/Users/me/Documents/Code/${id}`, kind: "repo", islandId: null, sessions: 0, lastActive: null, git: null, readme: `${id} readme`, stack: [], category: "side", categoryReason: "", vaultNote: null, stage: "building", stageReason: "", deploy: null, activityAt: null, artifacts: null, unread: false, folded: [], hasPreview: false, notes: null, vaultSessions: null, changes: [], costUsd30d: null, ...o };
}

const ITEMS = [p("alpha", { category: "acme", stage: "shipped", sessions: 4, stack: ["react"], activityAt: "2026-10-01T00:00:00Z" }), p("beta", { stage: "dormant" }), p("gamma", { category: "acme", stage: "idea", readme: "Court filings" })];

describe("filters", () => {
  it("search matches name, README and stack; category, stage and sessions-only narrow", () => {
    const m = (f: Partial<typeof NO_FILTER>) => ITEMS.filter((x) => matchesFilter(x, { ...NO_FILTER, ...f })).map((x) => x.id);
    expect(m({ query: "court" })).toEqual(["gamma"]);
    expect(m({ query: "REACT" })).toEqual(["alpha"]);
    expect(m({ categories: ["acme"] })).toEqual(["alpha", "gamma"]);
    expect(m({ categories: ["acme"], stages: ["idea"] })).toEqual(["gamma"]);
    expect(m({ sessionsOnly: true })).toEqual(["alpha"]);
  });

  it("under redact a search never hits (it could reveal a hidden name)", () => {
    expect(ITEMS.filter((x) => matchesFilter(x, { ...NO_FILTER, query: "alpha" }, true))).toEqual([]);
    expect(ITEMS.filter((x) => matchesFilter(x, NO_FILTER, true))).toHaveLength(3);
  });

  it("facet counts ignore their own facet so a chip shows what clicking it gives", () => {
    const c = facetCounts(ITEMS, { ...NO_FILTER, categories: ["side"], stages: ["idea"] });
    expect(c.category).toMatchObject({ acme: 1, side: 0 }); // stage idea only: gamma (acme)
    expect(c.stage).toMatchObject({ dormant: 1, idea: 0 }); // category side only: beta
  });
});

describe("grouping", () => {
  it("groups in the fixed category order, drops empty ones, newest first", () => {
    const g = groupByCategory([p("old", { category: "side", activityAt: "2026-01-01" }), p("new", { category: "side", activityAt: "2026-09-01" }), p("h", { category: "acme" })]);
    expect(g.map((x) => x.category)).toEqual(["acme", "side"]);
    expect(g[1]?.items.map((x) => x.id)).toEqual(["new", "old"]);
  });
});

describe("redact", () => {
  it("hides names, paths and free text", () => {
    expect(displayName(ITEMS[1]!, ITEMS, true)).toBe("project 2");
    expect(displayName(ITEMS[1]!, ITEMS, false)).toBe("beta");
    expect(displayPath("/Users/me/Documents/Code/x", true)).toBe("");
    expect(displayPath("/Users/me/Documents/Code/x", false)).toBe("~/Documents/Code/x");
    expect(textShown("secret plan", true)).toBeNull();
    expect(textShown("fine", false)).toBe("fine");
  });
});

describe("dates, logos, summary", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  it("ago", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-10-14T01:00:00Z", now)).toBe("today");
    expect(ago("2026-10-13T01:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-10-04T12:00:00Z", now)).toBe("10 d ago");
    expect(ago("2026-06-14T12:00:00Z", now)).toBe("4 mo ago");
    expect(ago("2024-10-14T12:00:00Z", now)).toBe("2 y ago");
  });
  it("logoUrl is a pinned devicon URL for known stacks and null otherwise", () => {
    expect(logoUrl("react")).toContain("/react/react-original.svg");
    expect(logoUrl("anthropic")).toBeNull();
  });
  it("summaryLine", () => {
    expect(summaryLine(ITEMS, 3)).toBe("3 projects · 3 git repos · 1 with sessions");
    expect(summaryLine(ITEMS, 1)).toContain("showing 1 of 3");
  });
});

describe("large groups and folded folders", () => {
  it("a group over GROUP_CAP shows the first GROUP_CAP until expanded", () => {
    const many = Array.from({ length: GROUP_CAP + 5 }, (_, i) => i);
    expect(visibleCards(many, false)).toMatchObject({ hidden: 5 });
    expect(visibleCards(many, false).shown).toHaveLength(GROUP_CAP);
    expect(visibleCards(many, true)).toMatchObject({ hidden: 0 });
    expect(visibleCards([1, 2], false).hidden).toBe(0);
  });
  it("labels and searches folded worktrees/clones, and counts their districts", () => {
    const f = (name: string, kind: "worktree" | "clone", islandId: string | null = null) => ({ id: name, name, path: `/x/${name}`, kind, reason: "", islandId, sessions: 0, branch: null, activityAt: null });
    const card = p("main", { islandId: "main", folded: [f("wt-a", "worktree"), f("wt-b", "worktree", "wtb"), f("copy", "clone")] });
    expect(foldedLabel(card)).toBe("+2 worktrees · +1 clone");
    expect(foldedLabel(p("solo"))).toBe("");
    expect(islandsOf(card)).toEqual(["main", "wtb"]);
    expect(matchesFilter(card, { ...NO_FILTER, query: "wt-b" })).toBe(true);
  });
});

describe("ported from the roadmap", () => {
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  it("summarizes a recorded change and dates the newest one", () => {
    expect(changeSummary({ at: "x", commits: 12, sessions: -1, stage: { from: "building", to: "shipped" } })).toBe("+12 commits · -1 session · stage building -> shipped");
    expect(changeSummary({ at: "x", commits: 1 })).toBe("+1 commit");
    const withChange = p("a", { changes: [{ at: "2026-10-11T12:00:00Z", commits: 12 }, { at: "2026-10-01T00:00:00Z", commits: 1 }] });
    expect(lastChangeLine(withChange, NOW)).toBe("changed 3 d ago: +12 commits");
    expect(lastChangeLine(p("b"), NOW)).toBeNull();
  });
  it("lists session-source chips in the fixed order and drops zeroes", () => {
    expect(sessionChips({ chatgpt: 4, "claude-code": 12, "claude-chat": 0 }).map((c) => `${c.emoji}${c.n}`)).toEqual(["💻12", "🤖4"]);
    expect(sessionChips(null)).toEqual([]);
  });
  it("only builds GitHub and live links from safe shapes", () => {
    expect(githubUrl("ACME-Inc/alpha.web")).toBe("https://github.com/ACME-Inc/alpha.web");
    expect(githubUrl("javascript:alert(1)")).toBeNull();
    expect(githubUrl(null)).toBeNull();
    expect(safeHttpUrl("https://a.dev")).toBe("https://a.dev");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(previewUrl("a b")).toBe("/api/projects/a%20b/preview");
  });
  it("formats cost, commit stats and a refresh line", () => {
    expect([costLabel(null), costLabel(0), costLabel(0.4), costLabel(1234.5)]).toEqual([null, null, "<$1", "$1,235"]);
    const items = [p("a", { git: { remote: null, branch: null, lastCommit: "2026-10-13T00:00:00Z", commits: 1500 } }), p("b", { git: { remote: null, branch: null, lastCommit: "2026-01-01T00:00:00Z", commits: 500 } }), p("c")];
    expect(commitStats(items, NOW)).toBe("2,000 commits · 1 active this week");
    expect(refreshLine({ at: "2026-10-14T09:12:00", total: 84, stageCounts: { idea: 1, building: 6, shipped: 2, dormant: 3 }, activeThisWeek: 9 })).toBe("14 Oct 09:12 · 84 projects · 6 building · 9 active this week");
  });
});
