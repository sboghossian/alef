// Library drawer: one project (or the Unfiled pseudo-project) in three tabs, and a 📌 Page button
// to its Project page (views/project.ts).
//   Overview: the old Projects panel (stage, notes with their age, git, stack, sessions, artifacts)
//   Shelf:    that project's items grouped by type, the same cards as the Shelf (pin, drag, menu)
//   Files:    the folder tree, one level at a time
// Names, paths and titles are untrusted text: textContent only; ?redact=1 hides them.

import type { ProjectItem } from "../../../shared/features/projects";
import { SHELF_TYPE_META, type ShelfBoardItem } from "../../../shared/features/shelf-board";
import { groupItemsByType } from "./library-lib";
import { filesBody, overviewBody, type PanelEnv } from "./projects-panel";
import { displayName } from "./projects-lib";
import { card, el, type CardEnv } from "./shelf-cards";

export type DrawerTab = "overview" | "shelf" | "files";

export interface DrawerEnv extends PanelEnv {
  /** Null = the Unfiled pseudo-project (Shelf tab only). */
  project: ProjectItem | null;
  items: readonly ShelfBoardItem[];
  cards: CardEnv;
  tab: DrawerTab;
  setTab(t: DrawerTab): void;
  onClose(): void;
}

export function shelfBody(items: readonly ShelfBoardItem[], cards: CardEnv): HTMLElement {
  const body = el("div", "pv-panel-body");
  if (items.length === 0) body.append(el("p", "pv-empty", "Nothing on this project's shelf yet. Links, artifacts, repos and files our sessions touch for it show up here."));
  let n = 0;
  for (const g of groupItemsByType(items)) {
    body.append(el("h3", "lib-type-h", `${SHELF_TYPE_META[g.type].emoji} ${SHELF_TYPE_META[g.type].label} · ${g.items.length}`));
    const grid = el("div", "sv-grid");
    for (const i of g.items) grid.append(card(i, n++, cards, null));
    body.append(grid);
  }
  return body;
}

export function renderDrawer(panel: HTMLElement, e: DrawerEnv): void {
  const p = e.project;
  const key = `${p?.id ?? "-"}|${e.tab}`;
  const keep = panel.dataset.key === key ? (panel.querySelector<HTMLElement>(".pv-panel-body")?.scrollTop ?? 0) : 0; // a re-render (a pin) keeps the place; another tab or project starts at the top
  panel.dataset.key = key;
  const head = el("div", "pv-panel-head");
  head.append(el("span", "pv-panel-title", p ? `📁 ${displayName(p, e.all, e.redact)}` : "🗂 Unfiled"));
  if (p) {
    // UX-3: the one page that joins this card with its district's sessions and its vault note.
    const page = el("button", "lib-page-btn", "📌 Page");
    page.type = "button";
    page.title = "Open the Project page: its city's sessions, open todos, verdicts, spend and vault note";
    page.addEventListener("click", () => e.ctx.showView("project", p.id));
    head.append(page);
  }
  const x = el("button", "pv-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", e.onClose);
  head.append(x);

  const tabs: Array<{ id: DrawerTab; label: string; count?: number }> = p
    ? [{ id: "overview", label: "Overview" }, { id: "shelf", label: "Shelf", count: e.items.length }, { id: "files", label: "Files" }]
    : [{ id: "shelf", label: "Shelf", count: e.items.length }];
  const tab = tabs.some((t) => t.id === e.tab) ? e.tab : tabs[0]!.id;
  const bar = el("div", "lib-tabs");
  bar.setAttribute("role", "tablist");
  for (const t of tabs) {
    const b = el("button", "lib-tab", t.label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === tab));
    if (t.count !== undefined) b.append(el("small", "", String(t.count)));
    b.addEventListener("click", () => e.setTab(t.id));
    bar.append(b);
  }
  let body: HTMLElement;
  if (tab === "overview" && p) body = overviewBody(p, e);
  else if (tab === "files" && p) {
    body = el("div", "pv-panel-body");
    body.append(filesBody(p, e));
  } else body = shelfBody(e.items, e.cards);
  panel.replaceChildren(head, bar, body);
  panel.hidden = false;
  body.scrollTop = keep;
}
