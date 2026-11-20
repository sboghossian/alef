import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { ProjectCardsResponse, ProjectIndexResponse, ProjectPageResponse } from "../../shared/features/project-page.js";
import type { ProjectItem, ProjectsResponse } from "../../shared/features/projects.js";
import type { TodoList } from "../../shared/features/todos.js";
import type { WorldAgent, WorldSnapshot } from "../../shared/types.js";
import type { RunningServer } from "../index.js";
import { createProjectPageFeature } from "../features/project-page.js";
import { buildProjectPage, plainText, projectIndex, recentProjects, resolveProjectKey, vaultSummary } from "../features/project-page-lib.js";
import { assistantLine, bootTestServer, userLine } from "./helpers.js";

function item(id: string, o: Partial<ProjectItem> = {}): ProjectItem {
  return { id, name: id, path: `/Users/me/Documents/Code/${id}`, kind: "repo", islandId: null, sessions: 0, lastActive: null, git: null, readme: `${id} readme`, stack: [], category: "side", categoryReason: "", vaultNote: null, stage: "building", stageReason: "", deploy: null, activityAt: null, artifacts: null, unread: false, folded: [], hasPreview: false, notes: null, vaultSessions: null, changes: [], costUsd30d: null, ...o };
}

function agent(id: string, islandId: string, lastActive: string, o: Partial<WorldAgent> = {}): WorldAgent {
  return { id, islandId, cwd: `/c/${islandId}`, title: `task ${id}`, status: "dormant", startedAt: lastActive, lastActive, messageCount: 3, model: null, role: "builder", color: "#000", targetIslandId: islandId, tokens: 0, awaitingInput: false, ...o };
}

function outcome(sessionId: string, o: Partial<OutcomeRecord>): OutcomeRecord {
  return { sessionId, outcome: "unknown", reason: null, evidenceAt: null, lastActive: "2026-10-20T00:00:00Z", toolCalls: 0, writes: 0, learnings: [], artifacts: [], prs: [], pushes: [], todos: null, ending: null, onDisk: true, pending: false, provisionalUntil: null, ...o };
}

const names = (m: Record<string, string>) => (id: string): string | null => m[id] ?? null;

describe("resolveProjectKey", () => {
  const items = [item("alpha", { islandId: "alpha-city", vaultNote: "Alpha-Notes", folded: [{ id: "alpha-wt", name: "alpha-wt", path: "/p", kind: "worktree", reason: "", islandId: "alpha-wt-city", sessions: 1, branch: null, activityAt: null }] })];
  const cities = names({ "alpha-city": "alpha", "alpha-wt-city": "alpha wt", lone: "Lone city" });

  it("finds a Library project by id, by its vault slug (any case) and by any of its cities", () => {
    for (const k of ["alpha", "alpha-notes", "alpha-wt-city"]) {
      const r = resolveProjectKey(k, items, [], cities);
      expect(r?.item?.id).toBe("alpha");
      expect(r?.slug).toBe("Alpha-Notes");
      expect(r?.cities).toEqual([{ id: "alpha-city", name: "alpha" }, { id: "alpha-wt-city", name: "alpha wt" }]);
    }
  });

  it("falls back to a vault slug alone, then a city alone; anything else is unknown", () => {
    expect(resolveProjectKey("ideas", items, ["Ideas"], cities)).toEqual({ item: null, slug: "Ideas", cities: [] });
    expect(resolveProjectKey("lone", items, [], cities)).toEqual({ item: null, slug: null, cities: [{ id: "lone", name: "Lone city" }] });
    expect(resolveProjectKey("nope", items, ["ideas"], cities)).toBeNull();
  });
});

describe("vaultSummary", () => {
  it("reads title, status and umbrella, and the first prose paragraph with links flattened", () => {
    const text = [
      "---",
      'title: "project-agent-world (Alef)"',
      "parent: side-projects",
      "status: active",
      "---",
      "",
      "# project-agent-world (Alef)",
      "",
      "_Refreshed 2026-10-27 from working memory [[60-Meta/m/project_agent_world|project_agent_world]]._",
      "",
      "```dataview",
      "TABLE x",
      "```",
      "",
      "**Alef** is the app name. Not [[20-Projects/alef-app/_index|alef-app]] or [[aleph]], see [docs](http://x).",
      "",
      "- a list item",
    ].join("\n");
    expect(vaultSummary("agent-world", text, "name")).toEqual({
      slug: "agent-world",
      path: "20-Projects/agent-world/_index.md",
      title: "project-agent-world (Alef)",
      status: "active",
      umbrella: "side-projects",
      summary: "Alef is the app name. Not alef-app or aleph, see docs.",
      matchedBy: "name",
    });
  });

  it("caps a long paragraph, and a slug with no index note is just its path", () => {
    expect(vaultSummary("x", `---\n---\n${"word ".repeat(200)}`, null).summary?.length).toBeLessThanOrEqual(420);
    expect(vaultSummary("x", null, null)).toMatchObject({ path: "20-Projects/x/_index.md", title: null, summary: null });
    expect(plainText("[[a/b/c]] and *em* and `code`")).toBe("c and em and code");
  });
});

describe("buildProjectPage", () => {
  const p = item("alpha", { islandId: "alpha-city", vaultNote: "alpha", vaultMatch: "code_path", stage: "shipped", git: { remote: "o/alpha", branch: "main", lastCommit: "2026-10-26T00:00:00Z", commits: 40 } });
  const agents = [
    agent("s1", "alpha-city", "2026-10-25T10:00:00Z"),
    agent("s2", "alpha-city", "2026-10-26T10:00:00Z", { displayName: "Ship the page" }),
    agent("s3", "alpha-city", "2026-10-24T10:00:00Z", { status: "live", awaitingInput: true }),
    agent("other", "beta-city", "2026-10-27T10:00:00Z"),
  ];
  const outcomes = new Map([
    ["s1", outcome("s1", { outcome: "shipped", reason: "o/alpha#3 merged", evidenceAt: "2026-10-25T11:00:00Z" })],
    ["s2", outcome("s2", { outcome: "failed", reason: "API Error" })],
    ["s3", outcome("s3", { outcome: "active" })],
  ]);
  const todos: Record<string, TodoList> = {
    s2: { agentId: "s2", updatedAt: "x", items: [{ content: "write tests", status: "in_progress", activeForm: null }, { content: "done", status: "completed", activeForm: null }] },
    s3: { agentId: "s3", updatedAt: "x", items: [{ content: "ship", status: "pending", activeForm: null }] },
  };
  const build = (o: { costs?: Map<string, number> | null; sessionCap?: number } = {}) =>
    buildProjectPage({ key: "alpha", resolved: { item: p, slug: "alpha", cities: [{ id: "alpha-city", name: "alpha" }] }, agents, outcomes, todoList: (id) => todos[id] ?? null, costs: o.costs === undefined ? new Map([["alpha-city", 12.5], ["beta-city", 99]]) : o.costs, noteText: "---\ntitle: Alpha\n---\nThe alpha app.", sessionCap: o.sessionCap });

  it("joins the city's sessions (live first), open todos, verdicts, spend, vault note and resume", () => {
    const page = build();
    expect(page).toMatchObject({ key: "alpha", name: "alpha", libraryId: "alpha", stage: "shipped", desc: "alpha readme", sessionsTotal: 3, live: 1, spendUsd30d: 12.5 });
    expect(page.sessions.map((s) => [s.id, s.status, s.outcome, s.openTodos])).toEqual([
      ["s3", "live", "active", 1],
      ["s2", "dormant", "failed", 1],
      ["s1", "dormant", "shipped", 0],
    ]);
    expect(page.todos).toEqual({ open: 2, items: [{ sessionId: "s2", content: "write tests", status: "in_progress" }, { sessionId: "s3", content: "ship", status: "pending" }] });
    // Newest first, and a live session's "active" is not a verdict.
    expect(page.verdicts).toEqual([
      { sessionId: "s2", title: "Ship the page", outcome: "failed", reason: "API Error", at: "2026-10-20T00:00:00Z" },
      { sessionId: "s1", title: "task s1", outcome: "shipped", reason: "o/alpha#3 merged", at: "2026-10-25T11:00:00Z" },
    ]);
    expect(page.vault).toMatchObject({ slug: "alpha", title: "Alpha", summary: "The alpha app.", matchedBy: "code_path" });
    expect(page.resume).toEqual({ sessionId: "s2", title: "Ship the page", status: "dormant" });
  });

  it("a card lists fewer sessions; unknown spend and no sessions stay null, never 0", () => {
    expect(build({ sessionCap: 1 }).sessions.map((s) => s.id)).toEqual(["s3"]);
    expect(build({ costs: null }).spendUsd30d).toBeNull();
    const empty = buildProjectPage({ key: "ideas", resolved: { item: null, slug: "ideas", cities: [] }, agents, outcomes, todoList: () => null, costs: new Map(), noteText: null });
    expect(empty).toMatchObject({ name: "ideas", libraryId: null, sessions: [], resume: null, spendUsd30d: null, activityAt: null, vault: { slug: "ideas", title: null } });
  });
});

describe("recentProjects and projectIndex", () => {
  it("orders projects by their cities' newest session and leaves out the ones with none", () => {
    const items = [item("a", { islandId: "ca" }), item("b", { islandId: "cb" }), item("c", { islandId: null, folded: [{ id: "c2", name: "c2", path: "/c2", kind: "clone", reason: "", islandId: "cc", sessions: 1, branch: null, activityAt: null }] }), item("d")];
    const agents = [agent("1", "ca", "2026-10-20T00:00:00Z"), agent("2", "cb", "2026-10-26T00:00:00Z"), agent("3", "cc", "2026-10-22T00:00:00Z"), agent("4", "ca", "2026-10-21T00:00:00Z")];
    expect(recentProjects(items, agents, 4).map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(recentProjects(items, agents, 1).map((p) => p.id)).toEqual(["b"]);
  });

  it("never gives a card to a folder that holds other projects (~/Documents)", () => {
    const items = [item("documents", { path: "/u/Documents", islandId: "cd" }), item("app", { path: "/u/Documents/Code/app", islandId: "ca" })];
    const agents = [agent("1", "cd", "2026-10-26T00:00:00Z"), agent("2", "ca", "2026-10-20T00:00:00Z")];
    expect(recentProjects(items, agents, 4).map((p) => p.id)).toEqual(["app"]);
  });

  it("lists every Library project newest first with its slug and city", () => {
    const idx = projectIndex([item("old", { activityAt: "2026-01-01" }), item("new", { activityAt: "2026-10-01", vaultNote: "new-note", islandId: "nc" })]);
    expect(idx).toEqual([
      { key: "new", name: "new", vaultSlug: "new-note", cityId: "nc", stage: "building", activityAt: "2026-10-01" },
      { key: "old", name: "old", vaultSlug: null, cityId: null, stage: "building", activityAt: "2026-01-01" },
    ]);
  });
});

describe("project-page feature: wired into a real server", () => {
  let server: RunningServer | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    await server?.close();
    server = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function boot(): Promise<{ base: string; city: string }> {
    const home = await mkdtemp(join(tmpdir(), "project-page-"));
    dirs.push(home);
    const projects = join(home, "projects");
    const sid = "bbbbbbbb-1111-4000-8000-000000000000";
    await mkdir(join(projects, "-w-alpha"), { recursive: true });
    const at = new Date(Date.now() - 60_000).toISOString();
    await writeFile(join(projects, "-w-alpha", `${sid}.jsonl`), `${userLine({ cwd: "/w/alpha", timestamp: at, text: "build the alpha page" })}\n${assistantLine({ cwd: "/w/alpha", timestamp: at })}\n`);
    const vault = join(home, "vault", "20-Projects");
    await mkdir(join(vault, "alpha-notes"), { recursive: true });
    await mkdir(join(vault, "ideas"), { recursive: true });
    await writeFile(join(vault, "alpha-notes", "_index.md"), "---\ntitle: Alpha notes\nparent: side-projects\n---\n# Alpha\n\nWhat alpha is for.\n");
    let city = "";
    const list = (): Promise<ProjectsResponse> =>
      Promise.resolve({ ok: true, items: [item("alpha", { islandId: city, vaultNote: "alpha-notes", vaultMatch: "github" }), item("quiet")], scannedAt: "x", skipped: 0, folded: 0, timedOut: 0, history: { since: "x", refreshes: [] } });
    const feature = createProjectPageFeature({
      projects: list,
      vaultProjectsDir: vault,
      outcomes: () => [outcome(sid, { outcome: "delivered", reason: "pushed o/alpha" })],
      todoList: (id) => (id === sid ? { agentId: sid, updatedAt: at, items: [{ content: "finish", status: "pending", activeForm: null }] } : null),
      costs: () => Promise.resolve(new Map([[city, 3]])),
    });
    const b = await bootTestServer({ configOverrides: { projectsDir: projects, features: [feature] } });
    server = b.server;
    const world = (await (await fetch(`${b.base}/api/world`)).json()) as WorldSnapshot;
    city = world.agents.find((a) => a.id === sid)?.islandId ?? "";
    expect(city).not.toBe("");
    return { base: b.base, city };
  }

  it("serves a page by Library id, by vault slug and by city, joined with the world's real session", async () => {
    const { base, city } = await boot();
    for (const key of ["alpha", "alpha-notes", city]) {
      const r = (await (await fetch(`${base}/api/project-page/${encodeURIComponent(key)}`)).json()) as ProjectPageResponse;
      expect(r.ok).toBe(true);
      expect(r.project).toMatchObject({ key, name: "alpha", libraryId: "alpha", sessionsTotal: 1, spendUsd30d: 3, todos: { open: 1 } });
      expect(r.project.verdicts[0]).toMatchObject({ outcome: "delivered", title: "build the alpha page" });
      expect(r.project.vault).toMatchObject({ slug: "alpha-notes", title: "Alpha notes", umbrella: "side-projects", summary: "What alpha is for.", matchedBy: "github" });
      expect(r.project.resume?.title).toBe("build the alpha page");
    }
  });

  it("a vault-only slug is a page too; a bad or unknown key is refused", async () => {
    const { base } = await boot();
    const ideas = (await (await fetch(`${base}/api/project-page/ideas`)).json()) as ProjectPageResponse;
    expect(ideas.project).toMatchObject({ libraryId: null, sessions: [], vault: { slug: "ideas", title: null } });
    expect((await fetch(`${base}/api/project-page/${encodeURIComponent("../etc")}`)).status).toBe(400);
    expect((await fetch(`${base}/api/project-page/nothing-here`)).status).toBe(404);
  });

  it("recent cards are the projects with a session, newest first; the index lists every project", async () => {
    const { base } = await boot();
    const cards = (await (await fetch(`${base}/api/project-page/recent?n=99`)).json()) as ProjectCardsResponse;
    expect(cards.cards.map((c) => [c.name, c.todos.open, c.spendUsd30d, c.vault?.slug])).toEqual([["alpha", 1, 3, "alpha-notes"]]);
    const idx = (await (await fetch(`${base}/api/project-page`)).json()) as ProjectIndexResponse;
    expect(idx.items.map((i) => i.key).sort()).toEqual(["alpha", "quiet"]);
  });
});
