// Library, "By project" lens: project cards grouped by category (the old Projects page), each with
// the note's desc and a strip of its shelf counts by type, plus an "Unfiled" card for the items no
// project claims. Names, paths, README and notes are untrusted text: textContent only. ?redact=1
// hides them (projects-lib.ts / library-lib.ts decide what).

import type { ProjectItem, ProjectsResponse } from "../../../shared/features/projects";
import type { ShelfItemType } from "../../../shared/features/shelf-board";
import { hasQuery, projectMatchesQuery, STRIP_META, stripCounts, UNFILED_ID, type ItemsByProject } from "./library-lib";
import { CATEGORY_META, STAGE_META, ago, commitStats, costLabel, displayName, foldedLabel, GROUP_CAP, groupByCategory, lastChangeLine, logoUrl, matchesFilter, previewUrl, refreshLine, sessionChips, stackName, summaryLine, textShown, visibleCards, type ProjectFilter } from "./projects-lib";
import { el } from "./shelf-cards";
import { matchesShelfFilter, NO_SHELF_FILTER } from "./shelf-lib";
import { viewState } from "../shell/view-state";

export interface ProjectsLens {
  redact: boolean;
  data: ProjectsResponse | null;
  error: string | null;
  /** Shelf items per project; null until the board has loaded (no strip yet). */
  grouped: ItemsByProject | null;
  filter: ProjectFilter;
  query: string;
  openId: string | null;
  expanded: Set<string>;
  collapsed: Set<string>;
  select(id: string): void;
  rerender(): void;
  /** Ask /api/projects again (the failure state's one action). */
  retry(): void;
}

function logo(label: string): HTMLElement {
  const wrap = el("span", "pv-logo");
  wrap.title = stackName(label);
  const url = logoUrl(label);
  if (!url) {
    wrap.classList.add("is-text");
    wrap.textContent = stackName(label);
    return wrap;
  }
  const img = document.createElement("img");
  img.src = url;
  img.alt = stackName(label);
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    wrap.classList.add("is-text");
    wrap.replaceChildren(document.createTextNode(stackName(label)));
  });
  wrap.append(img);
  return wrap;
}

/** The compact strip of a card's shelf counts; nonzero buckets only. */
export function stripEl(items: ReadonlyArray<{ type: ShelfItemType }>): HTMLElement | null {
  const c = stripCounts(items);
  const spans = STRIP_META.filter((m) => c[m.key] > 0).map((m) => {
    const s = el("span", "", `${m.emoji} ${c[m.key]}`);
    s.title = `${c[m.key]} ${m.label} on this project's shelf`;
    return s;
  });
  if (spans.length === 0) return null;
  const strip = el("div", "lib-strip");
  strip.append(...spans);
  return strip;
}

function clickable(c: HTMLElement, open: () => void): void {
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.addEventListener("click", open);
  c.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      open();
    }
  });
}

function projectCard(p: ProjectItem, all: readonly ProjectItem[], L: ProjectsLens): HTMLElement {
  const { redact } = L;
  const c = el("div", "pv-card");
  if (p.hasPreview && !redact) {
    const img = document.createElement("img");
    img.className = "pv-thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = previewUrl(p.id);
    img.addEventListener("error", () => img.remove());
    c.append(img);
  }
  c.dataset.id = p.id;
  if (p.id === L.openId) c.classList.add("is-open");
  const top = el("div", "pv-card-top");
  top.append(el("span", "pv-name", displayName(p, all, redact)));
  const pill = el("span", "pv-pill", STAGE_META[p.stage].label);
  pill.style.background = STAGE_META[p.stage].color;
  pill.title = p.stageReason;
  top.append(pill);
  const readme = textShown(p.readme, redact);
  const desc = textShown(p.notes?.desc ?? null, redact);
  const stack = el("div", "pv-stack");
  stack.append(...p.stack.slice(0, 5).map(logo));
  c.append(top, el("p", readme ? "pv-readme" : "pv-readme is-dim", readme ?? desc ?? (p.kind === "repo" ? "No README" : "A folder")));
  if (readme && desc && desc !== readme) c.append(el("p", "lib-desc", desc));
  const strip = L.grouped ? stripEl(L.grouped.byProject.get(p.id) ?? []) : null;
  c.append(stack);
  if (strip) c.append(strip);
  const chips = sessionChips(p.vaultSessions);
  if (chips.length) {
    const row = el("div", "pv-src");
    row.title = "Session notes in the Obsidian vault labelled with this project";
    row.append(...chips.map((k) => el("span", "pv-src-chip", `${k.emoji} ${k.n}`)));
    c.append(row);
  }
  const now = Date.now();
  const ch = lastChangeLine(p, now);
  if (ch) c.append(el("p", "pv-changed", ch));
  const fl = foldedLabel(p);
  if (fl) {
    const chip = el("span", "pv-folded", fl);
    chip.title = "Worktrees and clones of this repo, folded into this card (listed in the details)";
    c.append(chip);
  }
  const foot = el("div", "pv-foot");
  foot.append(el("span", "", `⏱ ${ago(p.activityAt, now)}`), el("span", p.sessions ? "" : "is-dim", `💬 ${p.sessions}`), el("span", p.artifacts?.count ? "" : "is-dim", `🖼 ${p.artifacts?.count ?? "…"}`));
  const spend = costLabel(p.costUsd30d);
  if (spend) {
    foot.append(el("span", "", `≈${spend}`));
    foot.lastElementChild?.setAttribute("title", "Est. API-equivalent cost of this project's sessions, last 30 days");
  }
  c.append(foot);
  clickable(c, () => L.select(p.id));
  return c;
}

function unfiledCard(n: number, items: ReadonlyArray<{ type: ShelfItemType }>, L: ProjectsLens): HTMLElement {
  const c = el("div", "pv-card is-unfiled");
  c.dataset.id = UNFILED_ID;
  if (L.openId === UNFILED_ID) c.classList.add("is-open");
  c.append(el("div", "pv-card-top"));
  c.firstElementChild?.append(el("span", "pv-name", "🗂 Unfiled"));
  c.append(el("p", "pv-readme", `${n} items from sessions that no project's folder, repo, artifacts or district claims.`));
  const strip = stripEl(items);
  if (strip) c.append(strip);
  clickable(c, () => L.select(UNFILED_ID));
  return c;
}

/** Projects that pass the sidebar facets and the shared search (their own text, or one of their items). */
export function visibleProjects(L: ProjectsLens): ProjectItem[] {
  const items = L.data?.items ?? [];
  const q = L.query;
  const itemHit = (id: string): boolean => (L.grouped?.byProject.get(id) ?? []).some((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, query: q }, L.redact));
  return items.filter((p) => matchesFilter(p, { ...L.filter, query: "" }, L.redact) && (!hasQuery(q) || projectMatchesQuery(p, q, L.redact) || itemHit(p.id)));
}

/** Chip counts under every facet except the chip's own, with the shared search counted (like the old facetCounts). */
export function facetCountsFor(L: ProjectsLens): { category: Record<string, number>; stage: Record<string, number> } {
  const category: Record<string, number> = {};
  const stage: Record<string, number> = {};
  for (const p of visibleProjects({ ...L, filter: { ...L.filter, categories: [] } })) category[p.category] = (category[p.category] ?? 0) + 1;
  for (const p of visibleProjects({ ...L, filter: { ...L.filter, stages: [] } })) stage[p.stage] = (stage[p.stage] ?? 0) + 1;
  return { category, stage };
}

export function statsNode(L: ProjectsLens, shownCount: number): HTMLElement {
  const host = el("div", "pv-stats");
  if (!L.data) {
    host.append(el("p", "", L.error ?? "Reading ~/Documents/Code and the districts…"));
    return host;
  }
  const items = L.data.items;
  host.append(el("p", "", summaryLine(items, shownCount)), el("p", "", commitStats(items, Date.now())));
  if (L.data.history.refreshes.length) host.append(el("p", "pv-hist-h", `Scan history (tracked since ${ago(L.data.history.since, Date.now())})`), ...L.data.history.refreshes.slice(0, 5).map((e) => el("p", "pv-hist", refreshLine(e))));
  return host;
}

export function renderProjectsLens(host: HTMLElement, L: ProjectsLens): number {
  if (!L.data) {
    // Centred, with one action (UX-11): a failed read used to be a dead line with nothing to press.
    host.append(
      L.error
        ? viewState({ tone: "error", title: "Couldn't load the projects", detail: L.error, action: { label: "Try again", run: () => L.retry() } })
        : viewState({ tone: "loading", title: "Reading every folder of ~/Documents/Code and Alef's districts…", detail: "The first read takes a few seconds." }),
    );
    return 0;
  }
  const all = L.data.items;
  const shown = visibleProjects(L);
  const f = L.filter;
  const facets = f.categories.length > 0 || f.stages.length > 0 || f.sessionsOnly;
  const loose = L.grouped && !facets ? L.grouped.unfiled.filter((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, query: L.query }, L.redact)) : [];
  if (shown.length === 0 && loose.length === 0) {
    host.append(el("p", "pv-note", "No project matches these filters."));
    return 0;
  }
  for (const g of groupByCategory(shown)) {
    const sec = el("section", "pv-group");
    const shut = L.collapsed.has(g.category);
    const toggle = el("button", "pv-group-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!shut));
    toggle.append(el("span", "pv-caret", shut ? "▸" : "▾"), el("span", "", `${CATEGORY_META[g.category].emoji} ${CATEGORY_META[g.category].label}`), el("small", "", String(g.items.length)));
    toggle.addEventListener("click", () => {
      if (!L.collapsed.delete(g.category)) L.collapsed.add(g.category);
      L.rerender();
    });
    const h = el("h2", "pv-group-h");
    h.append(toggle);
    sec.append(h);
    host.append(sec);
    if (shut) continue;
    const open = L.expanded.has(g.category);
    const cards = el("div", "pv-cards");
    cards.append(...visibleCards(g.items, open).shown.map((p) => projectCard(p, all, L)));
    sec.append(cards);
    if (g.items.length > GROUP_CAP) {
      const more = el("button", "pv-more", open ? "Show fewer" : `Show all ${g.items.length}`);
      more.type = "button";
      more.addEventListener("click", () => {
        if (!L.expanded.delete(g.category)) L.expanded.add(g.category);
        L.rerender();
      });
      sec.append(more);
    }
  }
  if (loose.length) {
    const sec = el("section", "pv-group");
    const h = el("h2", "pv-group-h");
    h.append(el("span", "", "🗂 Unfiled"), el("small", "", String(loose.length)));
    const cards = el("div", "pv-cards");
    cards.append(unfiledCard(loose.length, loose, L));
    sec.append(h, cards);
    host.append(sec);
  }
  return shown.length;
}

