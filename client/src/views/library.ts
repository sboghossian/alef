// 📚 Library: the old Projects and Shelf views in one. Three lenses (segmented control, in the route:
// #/library, #/library/lens:type, #/library/lens:pinned; #/library/<projectId> opens that project):
//   By project  every project, each card with its shelf counts; click opens the drawer (Overview, Shelf, Files)
//   By type     pinned shelves, then "Found in sessions" (the old Shelf)
//   Pinned      only the pinned shelves
// One search box filters projects (name, README, stack, notes) and items (title, URL, path). Data:
// GET /api/projects + GET /api/shelf/board, joined client-side (library-lib.ts); pins use the Shelf's
// own POST/DELETE/PUT routes. ?redact=1 hides what both old views hid. See docs/VIEWS.md.

import { MUSEUM_ISLAND_ID } from "../../../shared/features/artifacts";
import type { ProjectsResponse } from "../../../shared/features/projects";
import { PROJECT_CATEGORIES, PROJECT_STAGES } from "../../../shared/features/projects";
import { isShelfBoardResponse, isShelfPinsState, SHELF_ITEM_TYPES, SHELF_TYPE_META, type ShelfBoardItem, type ShelfBoardResponse, type ShelfPinsState } from "../../../shared/features/shelf-board";
import { openArtifactsGallery } from "../features/artifacts";
import { log } from "../log";
import { redactOn } from "../redact";
import type { AlefView, FilterSpec, FilterState, ViewContext } from "../shell/views";
import { viewHeaderEl } from "../ui/view-header";
import { fetchResult } from "./code-api";
import { renderDrawer, type DrawerTab } from "./library-drawer";
import { groupItemsByProject, hasQuery, LENSES, libraryParam, parseLibraryParam, projectIdForItem, projectMatchesQuery, buildProjectIndex, UNFILED_ID, type ItemsByProject, type Lens } from "./library-lib";
import { createMenu } from "./library-menu";
import { facetCountsFor, renderProjectsLens, statsNode, type ProjectsLens } from "./library-projects";
import { foundEl, shelvesEl } from "./library-shelves";
import { CATEGORY_META, NO_FILTER, STAGE_META, type ProjectFilter } from "./projects-lib";
import { el, pinAsItem, renderPanel, type CardEnv } from "./shelf-cards";
import { renderAddLink, renderSections } from "./shelf-side";
import { actionFor, artifactIdOf, districtCounts, matchesShelfFilter, NO_SHELF_FILTER, pinnedMap, typeCounts, type ShelfFilter } from "./shelf-lib";
import "./projects.css";
import "./shelf.css";
import "./library.css";
import { viewState } from "../shell/view-state";

const PAGE = 120;
const REFRESH_MS = 60_000;
const PROJECTS_REFRESH_MS = 5 * 60_000;

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let main: HTMLElement | null = null;
let drawer: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let board: ShelfBoardResponse | null = null;
let boardError: string | null = null;
let projects: ProjectsResponse | null = null;
let projectsError: string | null = null;
let grouped: ItemsByProject | null = null;
let filters: FilterState = {};
let lens: Lens = "project";
let shown = PAGE;
let openItem: string | null = null;
let openProject: string | null = null;
let tab: DrawerTab = "overview";
let wanted: string | null = null;
let timers: Array<ReturnType<typeof setInterval>> = [];
let seq = 0;
const expanded = new Set<string>();
const collapsed = new Set<string>();
const sideHosts: Array<() => void> = [];
let stats: HTMLElement | null = null;
const statsHost = (): HTMLElement => (stats ??= el("div", "pv-stats-host"));
const menu = createMenu(() => root);

const items = (): readonly ShelfBoardItem[] => board?.items ?? [];
const pinsState = (): ShelfPinsState => ({ sections: board?.sections ?? [], pins: board?.pins ?? [] });
const query = (): string => filters.search?.[0] ?? "";
const itemFilter = (): ShelfFilter => ({ ...NO_SHELF_FILTER, query: query(), types: lens === "type" ? (filters.type ?? []) : [], districts: lens === "type" ? (filters.district ?? []) : [], typedOnly: lens === "type" && (filters.typed ?? []).includes("on") });
const projectFilter = (): ProjectFilter => ({ ...NO_FILTER, query: query(), categories: filters.category ?? [], stages: filters.stage ?? [], sessionsOnly: (filters.sessions ?? []).includes("on") });

function districtName(id: string | null): string | null {
  if (!id) return null;
  if (redactOn()) return "district";
  return ctx?.store.islands.get(id)?.name ?? id;
}

/** Live item for an id, else the pin standing in for it. */
function find(id: string): ShelfBoardItem | null {
  const live = items().find((i) => i.id === id);
  if (live) return live;
  const p = board?.pins.find((x) => x.itemId === id);
  return p ? pinAsItem(p) : null;
}

function regroup(): void {
  grouped = board && projects ? groupItemsByProject(board.items, projects.items) : null;
}

async function send(method: "POST" | "DELETE" | "PUT", path: string, body: unknown): Promise<void> {
  try {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j: unknown = await r.json();
    if (!r.ok || !isShelfPinsState(j)) {
      const msg = typeof j === "object" && j !== null && typeof (j as { error?: unknown }).error === "string" ? (j as { error: string }).error : `HTTP ${r.status}`;
      ctx?.toast(`Library: ${msg}`, "error");
      return;
    }
    if (board) board = { ...board, sections: j.sections, pins: j.pins };
    render();
  } catch (err) {
    log.warn("library", "pin request failed", String(err));
    ctx?.toast("Library: the server did not answer", "error");
  }
}

const cardEnv = (): CardEnv => ({
  redact: redactOn(),
  pinned: pinnedMap(pinsState().pins),
  sections: pinsState().sections,
  districtName,
  open,
  pin: (itemId, section) => void send("POST", "/api/shelf/pins", { itemId, section }),
  move: (itemId, from, section) => void send("POST", "/api/shelf/pins", { itemId, from, section }),
  unpin: (itemId, section) => void send("DELETE", "/api/shelf/pins", { itemId, section }),
  menu: menu.open,
});

function projectOf(i: ShelfBoardItem): string | null {
  return projects ? projectIdForItem(i, buildProjectIndex(projects.items)) : null;
}

function open(id: string): void {
  const i = find(id);
  if (!i || !ctx || !panel) return;
  const pid = i.path ? projectOf(i) : null;
  const act = actionFor(i, () => pid);
  if (act === "preview") return void openArtifactsGallery(MUSEUM_ISLAND_ID, artifactIdOf(i.url) ?? undefined);
  if (act === "projects" && i.type === "folder" && pid) return void ctx.showView("library", pid);
  openItem = id;
  renderPanel(panel, i, { ...cardEnv(), ctx, close: () => void closeItem(), openProjects: pid });
  root?.classList.add("has-panel");
}

function closeItem(): boolean {
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  openItem = null;
  syncPanelClass();
  return true;
}

function closeDrawer(): boolean {
  if (!drawer || drawer.hidden) return false;
  drawer.hidden = true;
  openProject = null;
  syncPanelClass();
  main?.querySelectorAll(".pv-card.is-open").forEach((c) => c.classList.remove("is-open"));
  return true;
}

function syncPanelClass(): void {
  root?.classList.toggle("has-panel", !!panel && !panel.hidden ? true : !!drawer && !drawer.hidden);
}

function drawerItems(): ShelfBoardItem[] {
  if (!grouped || !openProject) return [];
  const all = openProject === UNFILED_ID ? grouped.unfiled : (grouped.byProject.get(openProject) ?? []);
  const self = projects?.items.find((p) => p.id === openProject);
  if (!hasQuery(query()) || (self && projectMatchesQuery(self, query(), redactOn()))) return all;
  return all.filter((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, query: query() }, redactOn()));
}

function renderDrawerNow(): void {
  if (!drawer || !ctx || !openProject) return;
  const all = projects?.items ?? [];
  const project = openProject === UNFILED_ID ? null : (all.find((p) => p.id === openProject) ?? null);
  if (openProject !== UNFILED_ID && !project) return;
  renderDrawer(drawer, { ctx, all, redact: redactOn(), project, items: drawerItems(), cards: cardEnv(), tab, setTab: (t) => { tab = t; renderDrawerNow(); }, onClose: () => void closeDrawer() });
  syncPanelClass();
}

function selectProject(id: string): void {
  if (openProject !== id) tab = id === UNFILED_ID ? "shelf" : "overview";
  openProject = id;
  renderDrawerNow();
  main?.querySelectorAll(".pv-card").forEach((c) => c.classList.toggle("is-open", (c as HTMLElement).dataset.id === id));
}

function projectsLens(): ProjectsLens {
  return { redact: redactOn(), data: projects, error: projectsError, grouped, filter: projectFilter(), query: query(), openId: openProject, expanded, collapsed, select: selectProject, rerender: render, retry: () => void loadProjects() };
}

function lensBar(): HTMLElement {
  const bar = el("div", "lib-lens ch-seg");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Library lens");
  for (const l of LENSES) {
    const b = el("button", "", l.label);
    b.type = "button";
    b.title = l.hint;
    b.setAttribute("aria-pressed", String(l.id === lens));
    b.addEventListener("click", () => ctx?.showView("library", libraryParam(l.id)));
    bar.append(b);
  }
  return bar;
}

function subLine(shownProjects: number): string {
  const n = board ? `${board.pins.length} pinned · ${items().length} found in sessions${board.ready ? "" : " · still reading transcripts…"}` : (boardError ?? "reading the shelf…");
  return lens === "project" ? `${projects ? `${shownProjects} of ${projects.items.length} projects` : "reading projects…"} · ${n}` : n;
}

function boardNote(): HTMLElement {
  return boardError
    ? viewState({ tone: "error", title: "Couldn't load the shelf", detail: boardError, action: { label: "Try again", run: () => void loadBoard() } })
    : viewState({ tone: "loading", title: "Reading every transcript for links, repos, issues, hosts and folders…" });
}

function render(): void {
  if (!main) return;
  const e = cardEnv();
  const head = viewHeaderEl("Library", "", [lensBar()], { icon: "library", className: "lib-head" });
  const body = el("div", "lib-body");
  menu.close();
  let n = 0;
  if (lens === "project") {
    const L = projectsLens();
    n = renderProjectsLens(body, L);
    statsHost().replaceChildren(statsNode(L, n));
  } else if (!board) body.append(boardNote());
  else {
    const f = itemFilter();
    const visible = (i: ShelfBoardItem): boolean => matchesShelfFilter(i, { ...NO_SHELF_FILTER, query: f.query }, e.redact);
    body.append(shelvesEl({ env: e, state: pinsState(), find, visible }));
    if (lens === "type") {
      const list = items().filter((i) => matchesShelfFilter(i, f, e.redact));
      body.append(foundEl(list, shown, PAGE, e, () => { shown += PAGE; render(); }));
    }
  }
  const sub = head.querySelector(".view-head-sub");
  if (sub) sub.textContent = subLine(n);
  main.replaceChildren(head, body);
  for (const fn of sideHosts) fn();
  if (openItem) open(openItem);
  if (openProject) renderDrawerNow();
}

async function loadBoard(): Promise<void> {
  const mine = ++seq;
  const r = await fetchResult<unknown>(`/api/shelf/board${redactOn() ? "?redact=1" : ""}`, undefined, 30_000);
  if (mine !== seq || !ctx) return;
  if (r.ok && isShelfBoardResponse(r.data)) {
    board = r.data;
    boardError = null;
  } else boardError = r.ok ? "unexpected answer" : r.error;
  regroup();
  if (!menu.isOpen()) render(); // a poll never closes an open "⋯" menu; the next action re-renders
  ctx.refreshFilters();
}

async function loadProjects(): Promise<void> {
  const r = await fetchResult<ProjectsResponse>("/api/projects", undefined, 60_000);
  if (!ctx) return;
  if (r.ok) {
    projects = r.data;
    projectsError = null;
  } else projectsError = r.error;
  regroup();
  if (!menu.isOpen()) render();
  ctx.refreshFilters();
  openWanted();
}

/** #/library/<id>: open that project's drawer once the list is in. */
function openWanted(): void {
  if (wanted && projects?.items.some((p) => p.id === wanted)) {
    selectProject(wanted);
    wanted = null;
  }
}

/** Applies the route param (lens + project); the lens's own sidebar filters start clean. */
function applyParam(param: string | null): void {
  const p = parseLibraryParam(param);
  if (p.lens !== lens) {
    lens = p.lens;
    filters = { search: filters.search ?? [] };
    shown = PAGE;
    closeDrawer();
    closeItem();
    ctx?.refreshFilters();
  }
  wanted = p.projectId;
  render();
  openWanted();
}

export const libraryView: AlefView = {
  id: "library",
  emoji: "📚",
  name: "Library",
  hint: "Every project and everything our sessions made or linked for it, with your pinned shelves",
  usesPlanet: false,
  mount(r, c) {
    ctx = c;
    if (!root) {
      root = el("section", "lib-root");
      root.setAttribute("aria-label", "Library");
      main = el("div", "lib-main");
      drawer = el("aside", "pv-panel lib-panel");
      drawer.setAttribute("aria-label", "Project details");
      drawer.hidden = true;
      panel = el("aside", "sv-panel");
      panel.setAttribute("aria-label", "Item details");
      panel.hidden = true;
      root.append(main, drawer, panel);
    }
    r.append(root);
    shown = PAGE;
    lens = "project";
    applyParam(c.route().param);
    void loadBoard();
    void loadProjects();
    timers = [setInterval(() => document.visibilityState === "visible" && void loadBoard(), REFRESH_MS), setInterval(() => document.visibilityState === "visible" && void loadProjects(), PROJECTS_REFRESH_MS)];
  },
  onParam: applyParam,
  unmount() {
    seq += 1;
    for (const t of timers) clearInterval(t);
    timers = [];
    menu.close();
    closeItem();
    closeDrawer();
    root?.remove();
    ctx = null;
  },
  filters(): FilterSpec[] {
    const redact = redactOn();
    const search: FilterSpec = { id: "search", label: "Find in the library", type: "search", placeholder: lens === "project" ? "project, README, stack, notes, link, path…" : "title, host, repo, path…" };
    const pins: FilterSpec[] = [
      { id: "add", label: "Pin a link", type: "section", render: (host) => renderAddLink(host, sideHosts, () => pinsState().sections, (url, section, title) => void send("POST", "/api/shelf/pins", { url, section, title })) },
      { id: "shelves", label: "Shelves", type: "section", collapsed: true, render: (host) => renderSections(host, sideHosts, pinsState, (sections, renames) => void send("PUT", "/api/shelf/sections", { sections, renames })) },
    ];
    if (lens === "project") {
      const counts = facetCountsFor(projectsLens());
      return [
        search,
        { id: "category", label: "Category", type: "chips", multi: true, options: PROJECT_CATEGORIES.map((k) => ({ value: k, label: CATEGORY_META[k].label, emoji: CATEGORY_META[k].emoji, count: counts.category[k] ?? 0 })) },
        { id: "stage", label: "Stage", type: "chips", multi: true, options: PROJECT_STAGES.map((s) => ({ value: s, label: STAGE_META[s].label, hint: STAGE_META[s].hint, count: counts.stage[s] ?? 0 })) },
        { id: "sessions", label: "With sessions only", type: "toggle" },
        { id: "stats", label: "Stats", type: "section", render: (host) => void host.append(statsHost()) },
      ];
    }
    if (lens === "pinned") return [search, ...pins];
    const f = itemFilter();
    const tc = typeCounts(items(), f, redact);
    return [
      search,
      { id: "type", label: "Type", type: "chips", multi: true, options: SHELF_ITEM_TYPES.map((t) => ({ value: t, label: SHELF_TYPE_META[t].label, emoji: SHELF_TYPE_META[t].emoji, count: tc[t] })) },
      { id: "typed", label: "Typed by me only", type: "toggle" },
      { id: "district", label: "Districts", type: "list", limit: 10, options: districtCounts(items(), f, redact).map((d, n) => ({ value: d.id, label: redact ? `District ${n + 1}` : (districtName(d.id) ?? d.id), count: d.count })) },
      ...pins,
    ];
  },
  onFilter(state) {
    filters = state;
    shown = PAGE;
    render();
  },
  onEscape() {
    return menu.close() || closeItem() || closeDrawer();
  },
};
