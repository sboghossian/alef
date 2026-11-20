import { describe, expect, it } from "vitest";
import type { ProjectItem } from "../../../shared/features/projects";
import type { ShelfBoardItem } from "../../../shared/features/shelf-board";
import { buildProjectIndex, githubRepoOf, groupItemsByProject, groupItemsByType, libraryParam, notesFreshness, parseLibraryParam, projectIdForItem, projectMatchesQuery, stripCounts } from "./library-lib";

function p(id: string, o: Partial<ProjectItem> = {}): ProjectItem {
  return { id, name: id, path: `/c/${id}`, kind: "repo", islandId: null, sessions: 0, lastActive: null, git: null, readme: null, stack: [], category: "side", categoryReason: "", vaultNote: null, stage: "building", stageReason: "", deploy: null, activityAt: null, artifacts: null, unread: false, folded: [], hasPreview: false, notes: null, vaultSessions: null, changes: [], costUsd30d: null, ...o };
}
function it_(id: string, o: Partial<ShelfBoardItem> = {}): ShelfBoardItem {
  return { id, type: "link", url: null, path: null, title: id, kind: "link", firstSeen: null, lastSeen: null, count: 1, sessions: [], district: null, source: "user", typed: false, score: 1, ...o };
}
const PROJECTS = [
  p("web", { git: { remote: "Acme/Web", branch: null, lastCommit: null, commits: null }, artifacts: { count: 1, items: [{ id: "art-1", title: null }] }, islandId: "isl-web" }),
  p("web-sub", { path: "/c/web/packages/sub" }),
  p("tools", { islandId: "isl-tools", folded: [{ id: "x", name: "tools-wt", path: "/wt/tools-wt", kind: "worktree", reason: "", islandId: null, sessions: 0, branch: null, activityAt: null }] }),
];
const idx = buildProjectIndex(PROJECTS);

describe("route param", () => {
  it("maps params to lens and project", () => {
    expect(parseLibraryParam(null)).toEqual({ lens: "project", projectId: null });
    expect(parseLibraryParam("lens:type")).toEqual({ lens: "type", projectId: null });
    expect(parseLibraryParam("lens:pinned")).toEqual({ lens: "pinned", projectId: null });
    expect(parseLibraryParam("lens:nope")).toEqual({ lens: "project", projectId: null });
    expect(parseLibraryParam("abc")).toEqual({ lens: "project", projectId: "abc" });
    expect(libraryParam("type")).toBe("lens:type");
    expect(libraryParam("project")).toBeNull();
    expect(libraryParam("project", "abc")).toBe("abc");
  });
});

describe("item -> project", () => {
  it("path prefix: the longest folder wins, a sibling prefix does not count", () => {
    expect(projectIdForItem(it_("a", { type: "file", path: "/c/web/src/x.ts" }), idx)).toBe("web");
    expect(projectIdForItem(it_("b", { type: "folder", path: "/c/web/packages/sub/lib" }), idx)).toBe("web-sub");
    expect(projectIdForItem(it_("c", { type: "folder", path: "/c/website/x" }), idx)).toBeNull();
  });
  it("a folded worktree's path maps to its canonical project", () => {
    expect(projectIdForItem(it_("d", { type: "file", path: "/wt/tools-wt/a.md" }), idx)).toBe("tools");
  });
  it("github items match the remote, case-insensitively, from the URL or the kind", () => {
    expect(githubRepoOf("https://github.com/acme/web/pull/3", "PR #3")).toBe("acme/web");
    expect(githubRepoOf(null, "acme/web")).toBe("acme/web");
    expect(projectIdForItem(it_("e", { type: "github", url: "https://github.com/acme/web/issues/9", kind: "issue #9" }), idx)).toBe("web");
    expect(projectIdForItem(it_("f", { type: "github", url: "https://github.com/other/repo", kind: "repo" }), idx)).toBeNull();
  });
  it("artifact items match by artifact id", () => {
    expect(projectIdForItem(it_("g", { type: "artifact", url: "https://claude.ai/artifact/art-1" }), idx)).toBe("web");
    expect(projectIdForItem(it_("h", { type: "artifact", url: "https://claude.ai/artifact/zzz" }), idx)).toBeNull();
  });
  it("the district is the fallback, and the rest is unfiled", () => {
    expect(projectIdForItem(it_("i", { district: "isl-tools" }), idx)).toBe("tools");
    expect(projectIdForItem(it_("j", { district: "unknown" }), idx)).toBeNull();
    const g = groupItemsByProject([it_("i", { district: "isl-tools" }), it_("j"), it_("a", { type: "file", path: "/c/web/x" })], PROJECTS);
    expect(g.byProject.get("tools")?.map((x) => x.id)).toEqual(["i"]);
    expect(g.byProject.get("web")?.map((x) => x.id)).toEqual(["a"]);
    expect(g.unfiled.map((x) => x.id)).toEqual(["j"]);
  });
});

describe("strip + grouping", () => {
  it("counts the five strip buckets", () => {
    const c = stripCounts([{ type: "artifact" }, { type: "link" }, { type: "dashable" }, { type: "github" }, { type: "linear" }, { type: "folder" }, { type: "file" }]);
    expect(c).toEqual({ artifacts: 1, links: 2, github: 1, linear: 1, files: 2 });
  });
  it("groups by type in type order, best score first", () => {
    const g = groupItemsByType([it_("a", { type: "link", score: 1 }), it_("b", { type: "artifact", score: 1 }), it_("c", { type: "link", score: 5 })]);
    expect(g.map((x) => x.type)).toEqual(["artifact", "link"]);
    expect(g[1]?.items.map((x) => x.id)).toEqual(["c", "a"]);
  });
});

describe("search + notes", () => {
  it("matches name, README, stack and notes; every word must hit", () => {
    const x = p("alpha", { readme: "Court filings", stack: ["react"], notes: { desc: "drafts briefs", longDesc: null, milestones: [], nextSteps: ["ship v2"], started: null, liveUrl: null } as unknown as ProjectItem["notes"] });
    for (const q of ["alpha", "court", "REACT", "briefs", "ship", "court react", ""]) expect(projectMatchesQuery(x, q, false), q).toBe(true);
    expect(projectMatchesQuery(x, "court nope", false)).toBe(false);
  });
  it("under redact a search never hits", () => {
    expect(projectMatchesQuery(p("alpha"), "alpha", true)).toBe(false);
    expect(projectMatchesQuery(p("alpha"), "", true)).toBe(true);
  });
  it("says how old the notes are", () => {
    expect(notesFreshness({})).toBe("notes from the old roadmap, not refreshed");
    expect(notesFreshness({ asOf: null, stale: false })).toBe("notes from the old roadmap, not refreshed");
    expect(notesFreshness({ asOf: "2026-10-01" })).toBe("notes as of 2026-10-01");
    expect(notesFreshness({ asOf: "2026-06-01", stale: true })).toContain("may be out of date");
  });
});
