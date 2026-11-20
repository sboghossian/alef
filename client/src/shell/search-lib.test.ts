import { describe, expect, it } from "vitest";
import type { Island, WorldAgent, WorldObject } from "../../../shared/types";
import type { PaletteData } from "../ui/palette";
import type { VaultSearchHit } from "../../../shared/features/vault";
import { MIND_TABS, mindTabRoute } from "../views/mind-tabs";
import { actionKey, flatRows, groupedResults, liveRecent, loadRecent, navEntries, navRows, projectSlugOf, pushRecent, saveRecent, stillMatching, RECENT_MAX, type SearchRow } from "./search-lib";

const agent = (id: string, title: string, extra: Partial<WorldAgent> = {}): WorldAgent =>
  ({ id, title, islandId: "alpha", status: "dormant", lastActive: new Date().toISOString(), ...extra }) as WorldAgent;
const data: PaletteData = {
  islands: () => [{ id: "alpha", name: "alpha", path: "/p/alpha", agentCount: 2 } as Island, { id: "beta", name: "beta", path: "/p/beta", agentCount: 1 } as Island],
  agents: () => [agent("a1", "fix the alpha login", { status: "live" }), agent("a2", "alpha docs")],
  objects: () => [{ id: "o1", name: "alpha.ts", kind: "file", islandId: "alpha", usage: 3 } as WorldObject],
  dispatchCity: () => "alpha",
  commands: () => [{ id: "fm:toggle", title: "Play alpha radio", run: () => undefined }],
};

describe("groupedResults", () => {
  it("groups agents · cities · files · commands in that order", () => {
    const g = groupedResults("alpha", data);
    expect(g.map((x) => x.id)).toEqual(["agents", "cities", "objects", "commands"]);
    expect(g.find((x) => x.id === "objects")!.rows[0]!.title).toBe("alpha.ts");
    // Ask Jev + Dispatch are always offered for a query.
    expect(g.find((x) => x.id === "commands")!.rows.map((r) => r.action.type)).toEqual(expect.arrayContaining(["ask", "dispatch"]));
  });
  it("empty query shows recents first and does not repeat them", () => {
    const recent: SearchRow[] = [{ action: { type: "city", id: "alpha" }, kind: "city", title: "alpha", meta: "" }];
    const g = groupedResults("", data, recent);
    expect(g[0]!.id).toBe("recent");
    expect(flatRows(g).filter((r) => r.action.type === "city" && r.action.id === "alpha")).toHaveLength(1);
  });
  it("a query with no hits still offers ask / dispatch", () => {
    expect(flatRows(groupedResults("zzzqqq", data)).map((r) => r.action.type)).toEqual(["ask", "dispatch"]);
  });
});

describe("recents", () => {
  it("dedupes, caps, maps reactivate/editor to the agent, survives bad storage", () => {
    let list: SearchRow[] = [];
    for (let i = 0; i < RECENT_MAX + 3; i++) list = pushRecent(list, { action: { type: "city", id: `c${i}` }, kind: "city", title: `c${i}`, meta: "" });
    expect(list).toHaveLength(RECENT_MAX);
    list = pushRecent(list, { action: { type: "reactivate", id: "a1" }, kind: "agent", title: "x", meta: "" });
    list = pushRecent(list, { action: { type: "agent", id: "a1" }, kind: "agent", title: "x", meta: "" });
    expect(list.filter((r) => r.action.type === "agent")).toHaveLength(1);
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveRecent(store, list);
    expect(loadRecent(store)).toEqual(list);
    mem.set("alef.search.recent", "{not json");
    expect(loadRecent(store)).toEqual([]);
    mem.set("alef.search.recent", JSON.stringify([{ nope: 1 }]));
    expect(loadRecent(store)).toEqual([]);
    expect(loadRecent(null)).toEqual([]);
    expect(liveRecent(list, (a) => a.type !== "agent").some((r) => r.action.type === "agent")).toBe(false);
  });
});

describe("finding places, projects, people and notes", () => {
  const views = [
    { id: "home", name: "Home", hint: "What wants you now" },
    { id: "brain", name: "Brain", hint: "Your vault as a graph" },
    { id: "vault", name: "Vault", hint: "Fourteen readings of the vault" },
    { id: "health", name: "Health", hint: "Is Alef itself well" },
    { id: "library", name: "Library", hint: "Everything you own" },
  ];
  const nav = navEntries(views, (id) => (id === "health" ? "System" : id === "brain" || id === "vault" || id === "library" ? "Mind" : "Now"), MIND_TABS, mindTabRoute);
  const acme: VaultSearchHit[] = [
    { kind: "project", name: "acme", path: "20-Projects/acme/_index.md", meta: "312 notes" },
    { kind: "person", name: "Acme Advisor", path: "40-Resources/People/Acme Advisor.md", meta: "40-Resources" },
    { kind: "note", name: "2026-10-01-acme-pitch", path: "10-Sessions/claude-code/2026-10-01-acme-pitch.md", meta: "10-Sessions" },
  ];

  it("indexes every view and every Vault section, but no second row for Graph", () => {
    expect(nav.filter((e) => e.param === null).map((e) => e.view)).toEqual(views.map((v) => v.id));
    const sections = nav.filter((e) => e.view === "vault" && e.param !== null).map((e) => e.param);
    expect(sections).toEqual(expect.arrayContaining(["pulse", "projects", "people", "gaps", "echoes", "atlas"]));
    expect(sections).not.toContain("graph");
    expect(nav.find((e) => e.view === "brain")!.keywords).toContain("Graph");
  });

  it("finds a view by name or by its group, and a section by name, routed to #/vault/<section>", () => {
    expect(navRows("vault", nav)[0]!.action).toEqual({ type: "view", view: "vault", param: null });
    expect(navRows("health", nav)[0]!.action).toEqual({ type: "view", view: "health", param: null });
    expect(navRows("system", nav).map((r) => r.title)).toContain("Health");
    expect(navRows("gaps", nav)[0]!.action).toEqual({ type: "view", view: "vault", param: "gaps" });
    expect(navRows("pulse", nav)[0]!.title).toBe("Pulse");
    // A long hint never matches a word it does not contain.
    expect(navRows("acme", nav)).toEqual([]);
  });

  it("ranks places and the vault project above agents, notes and the Ask Jev / Dispatch fallbacks", () => {
    const g = groupedResults("acme", data, [], { nav, vault: acme });
    expect(g.map((x) => x.id)).toEqual(["go", "notes", "commands"]);
    expect(g[0]!.rows[0]).toMatchObject({ kind: "project", title: "acme", action: { type: "view", view: "project", param: "acme" } });
    expect(g[1]!.rows.map((r) => r.title)).toEqual(["Acme Advisor", "2026-10-01-acme-pitch"]);
    const flat = flatRows(g).map((r) => r.action.type);
    expect(flat.indexOf("note")).toBeLessThan(flat.indexOf("ask"));
    // "vault" puts the Vault view first, above the ask / dispatch rows.
    expect(flatRows(groupedResults("vault", data, [], { nav }))[0]!.action).toEqual({ type: "view", view: "vault", param: null });
  });

  it("a project with no _index note goes to the Projects section; actions key and remember", () => {
    const g = groupedResults("loose", data, [], { vault: [{ kind: "project", name: "loose-end", path: "", meta: "1 note" }] });
    expect(g[0]!.rows[0]!.action).toEqual({ type: "view", view: "vault", param: "projects" });
    expect(actionKey({ type: "view", view: "vault", param: "gaps" })).toBe("view:vault:gaps");
    expect(actionKey({ type: "note", path: "a.md" })).toBe("note:a.md");
    const list = pushRecent([], g[0]!.rows[0]!);
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveRecent(store, list);
    expect(loadRecent(store)).toEqual(list);
  });

  it("keeps the last vault answer only while the box still extends that query", () => {
    expect(stillMatching("acme", acme, "acme-p").map((h) => h.name)).toEqual(["2026-10-01-acme-pitch"]);
    expect(stillMatching("acme", acme, "brain")).toEqual([]);
    expect(stillMatching("acme", acme, "h")).toEqual([]);
    expect(stillMatching("", acme, "acme")).toEqual([]);
  });
});

describe("projects in the search (UX-3)", () => {
  const idx = [
    { key: "agent-world", name: "agent-world", vaultSlug: "agent-world", cityId: "agent-world", stage: "building" as const, activityAt: "2026-10-27" },
    { key: "alex_claude", name: "alex_claude", vaultSlug: "alex-claude-brain", cityId: null, stage: "building" as const, activityAt: null },
  ];

  it("a Library project opens its Project page, found by name or by its vault slug", () => {
    const g = groupedResults("agent", data, [], { projects: idx });
    expect(g[0]!.rows[0]).toMatchObject({ kind: "project", title: "agent-world", action: { type: "view", view: "project", param: "agent-world" } });
    expect(flatRows(groupedResults("claude-brain", data, [], { projects: idx }))[0]).toMatchObject({ title: "alex_claude", action: { type: "view", view: "project", param: "alex_claude" } });
  });

  it("a vault project a Library project stands for is listed once; another one opens its page by slug", () => {
    const hits = [
      { kind: "project" as const, name: "agent-world", path: "20-Projects/agent-world/_index.md", meta: "12 notes" },
      { kind: "project" as const, name: "ideas", path: "20-Projects/ideas/_index.md", meta: "3 notes" },
    ];
    const rows = flatRows(groupedResults("agent", data, [], { projects: idx, vault: hits })).filter((r) => r.kind === "project");
    expect(rows.map((r) => r.action)).toEqual([
      { type: "view", view: "project", param: "agent-world" },
      { type: "view", view: "project", param: "ideas" },
    ]);
    expect(projectSlugOf("20-Projects/x/notes.md")).toBeNull();
  });
});
