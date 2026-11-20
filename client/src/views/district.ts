// 🏘️ District: one city up close, at street level on the live planet (usesPlanet). The camera
// frames the district and T's orbit filter washes every other district out; over it: labelled
// houses (click one for Room / Focus / Code), a "today" stats card with the district's houses and
// busiest files, and a picker to walk between districts (◀ ▶, ← → keys, or the sidebar list).
// #/district/<cityId>. Real data only: counts come from the store and the subagent index.

import { agentTitle } from "../../../shared/display";
import type { Island, WorldAgent } from "../../../shared/types";
import { STATE_LABELS, agentStateOf, onAgentStates } from "../features/agent-state";
import { archiveSummary } from "../features/archive-state";
import { islandIdsWithAgents, visibleIslands } from "../features/archive-lib";
import { h, toScreen } from "../features/fleet-overlay";
import { orbitFilters } from "../features/orbit-filters";
import { formatCount, shortModel, subagentData } from "../features/subagent-data";
import { onUsageToday, usageToday } from "../features/usage";
import { formatUsd } from "../features/usage-format";
import { reconcileDistrictCost, SUBAGENT_COST_FOOTNOTE, type DistrictCostToday } from "../features/usage-lib";
import type { AlefView, FilterSpec, FilterState, Selection, ViewContext } from "../shell/views";
import {
  activityScore,
  displayName,
  DISTRICT_COST_ATTRIBUTION_NOTE,
  DISTRICT_COST_CAPTION,
  districtCostLine,
  districtFilterFrom,
  districtStats,
  houseOrder,
  orderDistricts,
  stepDistrict,
  type DistrictFilter,
  type DistrictStats,
} from "./district-lib";
import "./district.css";

const MAX_LABELS = 12;
const LABEL_W = 150;
const LABEL_H = 30;
const MAX_LIST = 8;
const MAX_FILES = 5;

let ctx: ViewContext | null = null;
let rootEl: HTMLElement | null = null;
let filter: DistrictFilter = districtFilterFrom({});
let current: string | null = null;
let openHouse: string | null = null;
let prevDistrict: string | null = null;
let raf = 0;
/** True during mount's synchronous tail (the shell replays onFilter / onSelect): keep the route's district. */
let settling = false;
let dom: {
  wrap: HTMLElement;
  name: HTMLElement;
  pos: HTMLElement;
  card: HTMLElement;
  stats: HTMLElement;
  costNote: HTMLElement;
  houses: HTMLElement;
  files: HTMLElement;
  labels: HTMLElement;
} | null = null;
const labelEls = new Map<string, HTMLElement>();
const unsubs: (() => void)[] = [];

let storeHooked = false;
let renderQueued = false;
function scheduleRender(): void {
  if (!ctx || renderQueued) return;
  renderQueued = true;
  window.setTimeout(() => {
    renderQueued = false;
    if (!ctx) return;
    renderCard();
    ctx.refreshFilters();
  }, 250);
}

function statsFor(c: ViewContext, id: string): DistrictStats {
  const island = c.store.islands.get(id);
  return districtStats(
    { id, lastActive: island?.lastActive ?? "" },
    // "waiting" = asked you something OR blocked on a permission (agent-state), not just awaitingInput
    [...c.store.agents.values()].map((a) => {
      const st = agentStateOf(a.id);
      return st === "permission" || st === "waiting" ? { ...a, awaitingInput: true } : a;
    }),
    [...c.store.objects.values()],
    [...subagentData.records.values()],
    Date.now(),
  );
}

/** The live visibility decision (same one main.ts uses for the planet), plus `current`: a district
 *  you are already standing in must never vanish out from under the ◀▶ picker just because its
 *  last agent left — it stays walkable (and listed) until you navigate off it yourself. */
function visibleWithCurrent(c: ViewContext): Island[] {
  const all = [...c.store.islands.values()];
  const visible = visibleIslands(all, islandIdsWithAgents([...c.store.agents.values()]), archiveSummary());
  if (current && !visible.some((i) => i.id === current)) {
    const cur = c.store.islands.get(current);
    if (cur) return [...visible, cur];
  }
  return visible;
}

/** Today's cost per REAL district, from the usage feature's own cached poll (never a
 *  second fetch) reconciled against the world's actual island ids — see usage-lib.ts.
 *  Empty until that poll's first response lands. */
function costsToday(c: ViewContext): ReadonlyMap<string, DistrictCostToday> {
  const day = usageToday();
  if (!day) return new Map();
  return reconcileDistrictCost(day.perCity, new Set(c.store.islands.keys())).byDistrict;
}

function order(c: ViewContext): string[] {
  const cache = new Map<string, DistrictStats>();
  const s = (id: string): DistrictStats => {
    let v = cache.get(id);
    if (!v) cache.set(id, (v = statsFor(c, id)));
    return v;
  };
  return orderDistricts(visibleWithCurrent(c), s, filter);
}

function nameOf(c: ViewContext, id: string): string {
  const i = c.store.islands.get(id);
  return i ? displayName(i) : id;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!iso || !Number.isFinite(s)) return "never";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function btn(label: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

// ---------------------------------------------------------------- navigation

function go(id: string | null): void {
  const c = ctx;
  if (!c || !dom || !id || !c.store.islands.has(id)) return;
  const changed = id !== current;
  current = id;
  if (changed) {
    openHouse = null;
    for (const el of labelEls.values()) el.remove();
    labelEls.clear();
    // T's filter isolates the district (others wash out) and flies the camera there.
    orbitFilters.setDistrict(id);
    if (orbitFilters.get().district !== id) c.planet.flyToCity(id);
  }
  renderCard();
}

function walk(dir: 1 | -1): void {
  const c = ctx;
  if (!c) return;
  const next = stepDistrict(order(c), current, dir);
  if (next) c.showView("district", next);
}

function houseActions(c: ViewContext, a: WorldAgent): HTMLElement {
  const row = h("div", "ds-acts");
  row.append(
    btn("🚪 Room", "ds-act", "Step inside its room", () => c.showView("room", a.id)),
    btn("🎯 Focus", "ds-act", "Focus on it on the planet", () => {
      c.selection.set({ kind: "agent", id: a.id });
      c.showView("orbit");
      c.planet.flyToAgent(a.id);
      c.focus.set(true);
    }),
    btn("💻 Code", "ds-act", "Its repo and diffs", () => c.showView("code", a.id)),
  );
  return row;
}

// ---------------------------------------------------------------- the card

function renderCard(): void {
  const c = ctx;
  if (!c || !dom) return;
  const ids = order(c);
  if (!current || !c.store.islands.has(current)) {
    const first = ids[0] ?? null;
    if (first) {
      go(first);
      return;
    }
  }
  if (!current) {
    dom.name.textContent = "No district matches";
    dom.pos.textContent = "";
    dom.stats.replaceChildren(h("p", "ds-empty", "No district matches the filters."));
    dom.costNote.hidden = true;
    dom.houses.replaceChildren();
    dom.files.replaceChildren();
    return;
  }
  const s = statsFor(c, current);
  dom.name.textContent = nameOf(c, current);
  const i = ids.indexOf(current);
  dom.pos.textContent = i >= 0 ? `${i + 1} / ${ids.length}` : "outside the filter";

  const stat = (n: string, label: string, hint: string, cls = ""): HTMLElement => {
    const d = h("div", `ds-stat ${cls}`.trim());
    d.title = hint;
    d.append(h("b", undefined, n), h("span", undefined, label));
    return d;
  };
  const cost = costsToday(c).get(current);
  dom.stats.replaceChildren(
    stat(String(s.live), "live", "Agents with a live session now", s.live ? "ds-hot" : ""),
    stat(String(s.waiting), "waiting", "Live agents waiting on you", s.waiting ? "ds-ask" : ""),
    stat(String(s.activeToday), "active today", "Agents active since midnight"),
    stat(formatCount(s.tokensToday), "tokens", "Session tokens of the agents active today (whole-session totals)"),
    ...(cost ? [stat(formatUsd(cost.costUsd), DISTRICT_COST_CAPTION, districtCostLine(cost, formatUsd) ?? "")] : []),
    stat(`${s.subagentsToday}${s.subagentsLive ? ` · ${s.subagentsLive}🛸` : ""}`, "subagents today", "Subagents active today · running now"),
    stat(String(s.files), "buildings", "Files on the map for this district"),
    stat(ago(s.lastActive), "last active", "Most recent agent activity here"),
  );
  // Only shown once the cost tile itself is (no usage-store row yet = nothing to caveat).
  dom.costNote.textContent = cost ? `${DISTRICT_COST_ATTRIBUTION_NOTE} ${SUBAGENT_COST_FOOTNOTE}` : "";
  dom.costNote.hidden = !cost;

  // houses
  const agents = [...c.store.agents.values()].filter((a) => a.islandId === current);
  const houses = houseOrder(agents, MAX_LIST);
  dom.houses.replaceChildren(
    h("h3", "ds-sub", `Houses (${agents.length})`),
    ...(houses.length
      ? houses.map((a) => {
          const row = h("div", "ds-house");
          const st = agentStateOf(a.id) ?? (a.status === "live" ? "idle" : "sleeping");
          const head = h("button", "ds-house-head");
          head.type = "button";
          head.title = `${agentTitle(a)}\nfly there`;
          head.append(h("span", `ds-dot ds-${st}`), h("span", "ds-house-name", agentTitle(a) || a.id.slice(0, 8)), h("span", "ds-house-meta", `${STATE_LABELS[st]} · ${shortModel(a.model)}`));
          head.addEventListener("click", () => {
            openHouse = a.id;
            c.planet.flyToAgent(a.id);
          });
          row.append(head, houseActions(c, a));
          return row;
        })
      : [h("p", "ds-empty", "No houses here yet.")]),
    ...(agents.length > MAX_LIST ? [h("p", "ds-more", `+${agents.length - MAX_LIST} older houses (see them on the planet)`)] : []),
  );

  // busiest files (the buildings)
  const files = [...c.store.objects.values()]
    .filter((o) => o.islandId === current && o.kind === "file")
    .sort((a, b) => b.usage - a.usage)
    .slice(0, MAX_FILES);
  dom.files.replaceChildren(
    h("h3", "ds-sub", "Busiest buildings"),
    ...(files.length
      ? files.map((f) => {
          const li = h("div", "ds-file");
          li.title = f.id.replace(/^file:/, "");
          li.append(h("span", "ds-file-name", f.name), h("span", "ds-file-n", `${f.usage} session${f.usage === 1 ? "" : "s"}`));
          return li;
        })
      : [h("p", "ds-empty", current === "harness" ? "The harness holds skills, hooks and MCPs, not files." : "No files on the map for this district.")]),
  );
}

// ---------------------------------------------------------------- labels pinned to houses

function frame(): void {
  raf = requestAnimationFrame(frame);
  const c = ctx;
  if (!c || !dom || !current) return;
  const box = dom.labels.getBoundingClientRect();
  const agents = houseOrder(
    [...c.store.agents.values()].filter((a) => a.islandId === current),
    MAX_LABELS,
  );
  const keep = new Set<string>();
  // Greedy de-overlap in priority order (waiting, live, recent): a label that would cover one
  // already placed is hidden; the open one always shows.
  const placed: { x: number; y: number }[] = [];
  const ordered = openHouse ? [...agents].sort((x, y) => (x.id === openHouse ? -1 : y.id === openHouse ? 1 : 0)) : agents;
  for (const a of ordered) {
    const pos = c.agentPosition(a.id);
    if (!pos) continue;
    const p = toScreen(c, pos);
    let el = labelEls.get(a.id);
    if (!el) {
      el = makeLabel(c, a);
      labelEls.set(a.id, el);
      dom.labels.append(el);
    }
    keep.add(a.id);
    const x = p.x - box.left;
    const y = p.y - box.top;
    const onScreen = p.visible && x > -40 && y > -40 && x < box.width + 40 && y < box.height + 40;
    const clash = a.id !== openHouse && placed.some((q) => Math.abs(q.x - x) < LABEL_W && Math.abs(q.y - y) < LABEL_H);
    el.hidden = !onScreen || clash;
    if (el.hidden) continue;
    placed.push({ x, y });
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    el.classList.toggle("ds-open", openHouse === a.id);
    el.style.zIndex = openHouse === a.id ? "5" : String(Math.max(1, 4 - Math.round(p.dist / 60)));
  }
  for (const [id, el] of labelEls) {
    if (!keep.has(id)) {
      el.remove();
      labelEls.delete(id);
    }
  }
}

function makeLabel(c: ViewContext, a: WorldAgent): HTMLElement {
  const el = h("div", "ds-label");
  const st = agentStateOf(a.id) ?? (a.status === "live" ? "idle" : "sleeping");
  el.dataset.state = st;
  const tag = h("button", "ds-tag");
  tag.type = "button";
  tag.title = `${agentTitle(a)}\n${STATE_LABELS[st]} · click for Room / Focus / Code`;
  const kids = subagentData.byParent(a.id).filter((k) => k.status === "running").length;
  tag.append(h("span", `ds-dot ds-${st}`), h("span", "ds-tag-name", agentTitle(a) || a.id.slice(0, 8)));
  if (kids) tag.append(h("span", "ds-tag-kids", `🛸${kids}`));
  tag.addEventListener("click", () => {
    openHouse = openHouse === a.id ? null : a.id;
  });
  el.append(tag, houseActions(c, a));
  return el;
}

// ---------------------------------------------------------------- keys

function onKey(ev: KeyboardEvent): void {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable]"))) return;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    walk(ev.key === "ArrowRight" ? 1 : -1);
  }
}

// ---------------------------------------------------------------- the view

export const districtView: AlefView = {
  id: "district",
  emoji: "🏘️",
  name: "District",
  hint: "One city up close: its houses, who is working there, today's numbers",
  usesPlanet: true,

  mount(root, c) {
    ctx = c;
    rootEl = root;
    settling = true;
    queueMicrotask(() => {
      settling = false;
    });
    prevDistrict = orbitFilters.get().district;
    document.body.classList.add("alef-district-open");
    const wrap = h("div", "ds");
    const labels = h("div", "ds-labels");

    // The layout rule: no floating picker or card. Picking = the sidebar's Districts list (and
    // ←/→); "Today here" is a left-sidebar section (filters() re-parents this card into it).
    const name = h("div", "ds-name");
    const pos = h("div", "ds-pos");
    const titles = h("div", "ds-titles");
    titles.append(name, pos);
    const head = h("div", "ds-card-head");
    head.append(btn("◀", "ds-step", "Previous district (←)", () => walk(-1)), titles, btn("▶", "ds-step", "Next district (→)", () => walk(1)));

    const card = h("div", "ds-card");
    card.id = "ds-card";
    card.setAttribute("aria-label", "Today in this district");
    const stats = h("div", "ds-stats");
    const costNote = h("p", "ds-more");
    costNote.hidden = true;
    const houses = h("div", "ds-houses");
    const files = h("div", "ds-files");
    // UX-3: the district's project, joined with its Library entry and vault note.
    const project = btn("📌 Project page", "ds-act ds-project", "This district's project: sessions, open todos, verdicts, spend and its vault note", () => {
      if (current) c.showView("project", current);
    });
    card.append(head, project, stats, costNote, houses, files);

    wrap.append(labels);
    root.append(wrap);
    dom = { wrap, name, pos, card, stats, costNote, houses, files, labels };

    if (!storeHooked) {
      storeHooked = true;
      c.store.onAgents(() => scheduleRender());
      c.store.onSnapshot(() => scheduleRender());
      subagentData.onChange(() => scheduleRender());
    }
    unsubs.push(onAgentStates(scheduleRender));
    unsubs.push(onUsageToday(scheduleRender));
    window.addEventListener("keydown", onKey);
    raf = requestAnimationFrame(frame);

    const sel = c.selection.get();
    const start = c.route().param ?? (sel?.kind === "city" ? sel.id : null) ?? (sel?.kind === "agent" ? c.store.agents.get(sel.id)?.islandId ?? null : null);
    current = null;
    if (start && c.store.islands.has(start)) go(start);
    else renderCard();
  },

  unmount() {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey);
    for (const u of unsubs.splice(0)) u();
    labelEls.clear();
    document.body.classList.remove("alef-district-open", "alef-district-focus");
    // Give the Orbit back the district filter it had before (usually "all districts").
    if (orbitFilters.get().district === current) orbitFilters.setDistrict(prevDistrict);
    ctx = null;
    rootEl = null;
    dom = null;
    current = null;
    openHouse = null;
  },

  filters(c) {
    const all = visibleWithCurrent(c);
    const stats = new Map(all.map((i) => [i.id, statsFor(c, i.id)]));
    const costs = costsToday(c);
    const liveN = [...stats.values()].filter((s) => s.live > 0).length;
    const ids = orderDistricts(all, (id) => stats.get(id)!, { show: "all", sort: "activity" });
    const card = dom?.card;
    const specs: FilterSpec[] = [
      ...(card ? [{ id: "today", label: "Today here", type: "section" as const, render: (host: HTMLElement) => void host.append(card) }] : []),
      {
        id: "show",
        label: "Show",
        type: "segmented",
        options: [
          { value: "all", label: "All", count: all.length },
          { value: "live", label: "Live", count: liveN, dot: "live", hint: "Districts with a live agent" },
          { value: "dormant", label: "Dormant", count: all.length - liveN, dot: "asleep", hint: "Districts where everyone sleeps" },
        ],
      },
      {
        id: "sort",
        label: "Order",
        type: "segmented",
        options: [
          { value: "activity", label: "Activity", hint: "Live agents, then today's work" },
          { value: "agents", label: "Agents", hint: "Most houses first" },
          { value: "name", label: "A–Z" },
        ],
      },
      {
        id: "district",
        label: "Districts",
        type: "list",
        pinnable: true,
        limit: 12,
        options: ids.map((id) => {
          const s = stats.get(id)!;
          const cost = costs.get(id);
          const costLine = cost ? districtCostLine(cost, formatUsd) : null;
          return {
            value: id,
            label: nameOf(c, id),
            count: s.agents,
            dot: s.live ? "live" : s.activeToday ? "today" : "asleep",
            // The cost figure (meta, below) is billed by folder, not by this district's own
            // houses (district-lib.ts's DISTRICT_COST_CAPTION comment) — say so in the hint,
            // since the bare row otherwise reads as "these houses cost $X".
            hint: `${s.live} live · score ${activityScore(s)}${costLine ? ` · ${costLine}` : ""}`,
            meta: cost && cost.costUsd > 0 ? formatUsd(cost.costUsd) : undefined,
          };
        }),
      },
    ];
    return specs;
  },

  onFilter(state: FilterState) {
    filter = districtFilterFrom(state);
    if (!settling && filter.picked && filter.picked !== current && ctx) ctx.showView("district", filter.picked);
    else renderCard();
  },

  onSelect(sel: Selection | null) {
    const c = ctx;
    if (!c || !sel || settling) return;
    if (sel.kind === "city" && sel.id !== current) c.showView("district", sel.id);
    if (sel.kind === "agent") {
      const home = c.store.agents.get(sel.id)?.islandId;
      if (home && home !== current) c.showView("district", home);
      openHouse = sel.id;
    }
  },

  onParam(p) {
    if (p) go(p);
  },

  onFocus(on) {
    document.body.classList.toggle("alef-district-focus", on);
    rootEl?.classList.toggle("ds-focus", on);
  },

  onEscape() {
    if (openHouse) {
      openHouse = null;
      return true;
    }
    return false;
  },
};
