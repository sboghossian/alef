// 🗺️ Capabilities (was Atlas): every capability Alex has (skills, agents, routines, CLIs) on one radial map,
// grouped by what it serves. The 🧠 memory hub sits at the centre (click: the Brain view), one
// hub per department on a ring (8 + Unfiled), a branch per kind, then the leaves fanning outward
// (atlas-lib.ts lays them out). Leaf size = uses; colour = autonomy (gold autonomous, the
// department's colour assisted, a grey hollow ring manual). Hover lights the path to the centre;
// a click opens the details panel (same geometry as the shell's #panel, like Brain's note).
// Search, kind and autonomy chips, the department list, the legend and the stats line are
// left-sidebar sections. Data: GET /api/atlas (shared/features/atlas.ts). Names, descriptions and
// reasons are untrusted text: textContent only.

import { ATLAS_AUTONOMY, ATLAS_KINDS, type AtlasLeaf, type AtlasOpenResult, type AtlasResponse } from "../../../shared/features/atlas";
import { MAX_K, clampPan, fitView, screenToWorld, wheelFactor, zoomAt, type View } from "../features/canvas/view";
import type { AlefView, FilterSpec, FilterState, ViewContext } from "../shell/views";
import { AUTONOMY_META, DEPT_COLORS, GOLD, HUB_R, KIND_META, LABEL_LINE, LABEL_Y, autonomyLabel, deptLabelLines, layoutAtlas, matchesFilter, pickLeaf, pollChain, reasonLine, statsLine, usesLine, viaLine, type AtlasLayout } from "./atlas-lib";
import { fetchResult } from "./code-api";
import "./atlas.css";

const SVG = "http://www.w3.org/2000/svg";

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let svg: SVGSVGElement | null = null;
let world: SVGGElement | null = null;
let tip: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let data: AtlasResponse | null = null;
let layout: AtlasLayout | null = null;
let error: string | null = null;
let filters: FilterState = {};
let view: View = { x: 0, y: 0, k: 1 };
let userMoved = false;
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element | null; leaf: string | null } | null = null;
/** Leaves the sidebar filters hide: never hovered or picked. */
let off = new Set<string>();
/** Re-asks /api/atlas while a source is still reading; one chain, whatever the remounts. */
const poll = pollChain();
/** Pointer target radius in screen px: a 24 px circle round every dot, whatever its size or the zoom. */
const PICK_PX = 12;
let ro: ResizeObserver | null = null;
/** Sidebar section bodies: made once on first use (not at import: tests load this module without a DOM). */
let side: { legend: HTMLElement; stats: HTMLElement } | null = null;
const sections = (): { legend: HTMLElement; stats: HTMLElement } => (side ??= { legend: el("div", "av-legend"), stats: el("div", "av-stats") });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

const leafById = (id: string): AtlasLeaf | undefined => data?.leaves.find((l) => l.id === id);
const deptName = (id: string): string => data?.departments.find((d) => d.id === id)?.name ?? id;

// ---------------------------------------------------------------- drawing

function draw(): void {
  if (!svg || !data) return;
  layout = layoutAtlas(data.departments.map((d) => d.id), data.leaves);
  const w = s("g", { class: "av-world" });
  const edges = s("g", { class: "av-edges" }, w);
  s("g", { class: "av-hot" }, w);
  const leaves = s("g", { class: "av-leaves" }, w);
  const nodes = s("g", { class: "av-nodes" }, w);
  for (const d of data.departments) {
    const p = layout.depts.get(d.id);
    if (!p) continue;
    s("line", { x1: 0, y1: 0, x2: p.x, y2: p.y, "data-edge": d.id }, edges);
    const g = s("g", { class: "av-dept", "data-dept": d.id, transform: `translate(${p.x} ${p.y})` }, nodes);
    s("circle", { r: p.r, fill: DEPT_COLORS[d.id] }, g);
    s("text", { class: "av-emoji", y: -4 }, g).textContent = d.emoji;
    s("text", { class: "av-count", y: 18 }, g).textContent = String(d.leaves);
    deptLabelLines(d.name).forEach((line, i) => {
      s("text", { class: "av-label", y: LABEL_Y + i * LABEL_LINE }, g).textContent = line;
    });
  }
  for (const [key, b] of layout.branches) {
    const dp = layout.depts.get(b.dept);
    if (dp) s("line", { x1: dp.x, y1: dp.y, x2: b.x, y2: b.y, "data-edge": key }, edges);
    const g = s("g", { class: "av-branch", transform: `translate(${b.x} ${b.y})` }, nodes);
    s("circle", { r: b.r, stroke: DEPT_COLORS[b.dept] }, g);
    s("text", { class: "av-emoji-sm", y: 1 }, g).textContent = KIND_META[b.kind].emoji;
  }
  for (const leaf of data.leaves) {
    const p = layout.leaves.get(leaf.id);
    const b = p ? layout.branches.get(p.branch) : undefined;
    if (!p || !b) continue;
    s("line", { x1: b.x, y1: b.y, x2: p.x, y2: p.y, class: "av-leaf-edge", "data-edge": leaf.id }, edges);
    const fill = leaf.autonomy === "autonomous" ? GOLD : leaf.autonomy === "assisted" ? DEPT_COLORS[leaf.dept] : "none";
    s("circle", { class: `av-leaf is-${leaf.autonomy ?? "unknown"}`, cx: p.x, cy: p.y, r: p.r, fill, "data-id": leaf.id }, leaves);
  }
  const hub = s("g", { class: "av-hub", "data-hub": "1" }, nodes);
  s("circle", { r: HUB_R }, hub);
  s("text", { class: "av-emoji", y: -8 }, hub).textContent = "🧠";
  s("text", { class: "av-hub-line", y: 17 }, hub).textContent = `${data.hub.memoryFiles ?? "?"} memory files`;
  s("text", { class: "av-hub-line", y: 33 }, hub).textContent = `${data.hub.bundles} bundles`;
  world?.remove();
  world = w;
  svg.append(w);
  applyFilter();
  if (!userMoved) fit();
  else paint();
}

function paint(): void {
  world?.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
}

function fit(): void {
  if (!svg || !layout) return;
  const r = svg.getBoundingClientRect();
  if (r.width && r.height) view = fitView(layout.bounds, r.width, r.height, 16, 0.1, 1.4);
  paint();
}

function currentFilter(): Parameters<typeof matchesFilter>[1] {
  return { query: filters.search?.[0] ?? "", kinds: filters.kind ?? [], autonomy: filters.autonomy ?? [], dept: filters.dept?.[0] ?? null };
}

function applyFilter(): void {
  if (!world || !data) return;
  const f = currentFilter();
  let shown = 0;
  off = new Set();
  for (const leaf of data.leaves) {
    const on = matchesFilter(leaf, f);
    if (on) shown += 1;
    else off.add(leaf.id);
    world.querySelector(`[data-id="${CSS.escape(leaf.id)}"]`)?.classList.toggle("is-off", !on);
    world.querySelector(`[data-edge="${CSS.escape(leaf.id)}"]`)?.classList.toggle("is-off", !on);
  }
  renderStats(shown);
}

/** Lights leaf → branch → department → hub. */
function highlight(leaf: AtlasLeaf | null): void {
  const hot = world?.querySelector(".av-hot");
  if (!hot || !layout) return;
  hot.replaceChildren();
  const p = leaf ? layout.leaves.get(leaf.id) : undefined;
  const b = p ? layout.branches.get(p.branch) : undefined;
  const d = leaf ? layout.depts.get(leaf.dept) : undefined;
  if (!leaf || !p || !b || !d) return;
  s("polyline", { points: `${p.x},${p.y} ${b.x},${b.y} ${d.x},${d.y} 0,0`, stroke: leaf.autonomy === "autonomous" ? GOLD : leaf.autonomy === null ? DEPT_COLORS.unfiled : DEPT_COLORS[leaf.dept] }, hot);
}

// ---------------------------------------------------------------- details panel

function row(body: HTMLElement, label: string, value: string, sub?: string): void {
  const r = el("div", "av-row");
  r.append(el("b", "", label), el("span", "", value));
  if (sub) r.append(el("small", "", sub));
  body.append(r);
}

function openLeaf(leaf: AtlasLeaf): void {
  if (!panel) return;
  const head = el("div", "av-panel-head");
  head.append(el("span", "av-panel-title", `${KIND_META[leaf.kind].emoji} ${leaf.name}`));
  const close = el("button", "av-x", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closePanel);
  head.append(close);
  const body = el("div", "av-panel-body");
  row(body, "Kind", KIND_META[leaf.kind].label.replace(/s$/, ""));
  row(body, "Description", leaf.description || "no description in its frontmatter");
  row(body, "Department", deptName(leaf.dept), reasonLine(leaf));
  row(body, "Autonomy", autonomyLabel(leaf.autonomy), leaf.evidence);
  row(body, "Used", usesLine(leaf));
  row(body, "File", leaf.path ?? "no file of its own");
  const open = el("button", "av-open", "Open in editor");
  open.type = "button";
  open.disabled = !leaf.canOpen;
  if (!leaf.canOpen) open.title = leaf.path ? "Not opened from here: outside its folder, not a plain file, or a secret-looking name" : "It has no file of its own";
  open.addEventListener("click", () => {
    void ctx?.api.postJson<AtlasOpenResult>(`/api/atlas/open/${encodeURIComponent(leaf.id)}`, undefined, (err) => ({ ok: false, error: err })).then((r) => {
      ctx?.toast(r.ok ? `Opened ${leaf.name} in the editor` : `Couldn't open it: ${r.error}`, r.ok ? "info" : "error");
    });
  });
  body.append(open);
  panel.replaceChildren(head, body);
  panel.hidden = false;
}

function closePanel(): boolean {
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  return true;
}

// ---------------------------------------------------------------- sidebar sections

function renderStats(shown: number): void {
  const statsEl = sections().stats;
  if (!data) {
    statsEl.textContent = error ? `Couldn't load the atlas: ${error}` : "Reading every skill, agent, routine and CLI…";
    return;
  }
  const unfiled = data.leaves.filter((l) => l.dept === "unfiled").length;
  const lines = [
    statsLine(data.leaves),
    `${Math.round((unfiled / Math.max(1, data.leaves.length)) * 100)}% unfiled · ${data.hub.bundles} bundles read`,
    shown < data.leaves.length ? `showing ${shown} of ${data.leaves.length}` : `${data.leaves.length} in all`,
  ];
  lines.push(viaLine(data.leaves));
  if (data.pending.length) lines.push(`still reading: ${data.pending.join(", ")} (refreshes by itself)`);
  statsEl.replaceChildren(...lines.map((t) => el("p", "av-stat", t)));
}

function renderLegend(): void {
  const item = (swatch: string, label: string, hint: string): HTMLElement => {
    const r = el("div", "av-key");
    const dot = el("i", `av-swatch ${swatch}`);
    r.append(dot, el("span", "", label), el("small", "", hint));
    return r;
  };
  sections().legend.replaceChildren(
    item("is-autonomous", AUTONOMY_META.autonomous.label, AUTONOMY_META.autonomous.hint),
    item("is-assisted", AUTONOMY_META.assisted.label, `${AUTONOMY_META.assisted.hint} (department colour)`),
    item("is-manual", AUTONOMY_META.manual.label, AUTONOMY_META.manual.hint),
    item("is-unknown", autonomyLabel(null), "launchd's load state couldn't be read"),
    el("p", "av-stat", "Bigger dot = used more. Click 🧠 for the Brain."),
    ...(data ? [el("p", "av-stat", "Department colours (hub, and its assisted dots):")] : []),
    ...(data?.departments ?? []).map((d) => {
      const r = el("div", "av-key av-key-dept");
      const dot = el("i", "av-swatch is-dept");
      dot.style.background = DEPT_COLORS[d.id];
      r.append(dot, el("span", "", `${d.emoji} ${d.name}`), el("small", "", String(d.leaves)));
      return r;
    }),
  );
}

// ---------------------------------------------------------------- input

function onWheel(ev: WheelEvent): void {
  if (!svg) return;
  ev.preventDefault();
  userMoved = true;
  const r = svg.getBoundingClientRect();
  view = zoomAt(view, wheelFactor(ev.deltaY, ev.deltaMode, ev.ctrlKey), ev.clientX - r.left, ev.clientY - r.top, 0.1, MAX_K * 2);
  paint();
}

/** The leaf within PICK_PX of the pointer (nearest first), or null. */
function leafAt(ev: PointerEvent): AtlasLeaf | null {
  if (!svg || !layout) return null;
  const r = svg.getBoundingClientRect();
  const w = screenToWorld(view, ev.clientX - r.left, ev.clientY - r.top);
  const id = pickLeaf(layout, w.x, w.y, PICK_PX / view.k, (x) => !off.has(x));
  return id ? (leafById(id) ?? null) : null;
}

function onDown(ev: PointerEvent): void {
  if (!svg || ev.button !== 0) return;
  const target = ev.target instanceof Element ? ev.target.closest("[data-hub],[data-dept]") : null;
  svg.setPointerCapture(ev.pointerId);
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, target, leaf: target ? null : (leafAt(ev)?.id ?? null) };
}

function onMove(ev: PointerEvent): void {
  if (!svg || !tip || !root) return;
  if (drag) {
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved && layout) {
      userMoved = true;
      const r = svg.getBoundingClientRect();
      view = clampPan({ k: view.k, x: drag.vx + dx, y: drag.vy + dy }, layout.bounds, r.width, r.height, 60);
      paint();
    }
    return;
  }
  const overNode = ev.target instanceof Element && ev.target.closest("[data-hub],[data-dept]") !== null;
  const leaf = overNode ? null : leafAt(ev);
  highlight(leaf);
  tip.hidden = !leaf;
  svg.classList.toggle("is-pointing", leaf !== null);
  if (!leaf) return;
  const rr = root.getBoundingClientRect();
  tip.textContent = `${KIND_META[leaf.kind].emoji} ${leaf.name} · ${autonomyLabel(leaf.autonomy)}`;
  tip.style.left = `${ev.clientX - rr.left + 12}px`;
  tip.style.top = `${ev.clientY - rr.top + 12}px`;
}

function onUp(ev: PointerEvent): void {
  if (!svg) return;
  const d = drag;
  drag = null;
  if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  if (!d || d.moved) return;
  const leaf = d.leaf ? leafById(d.leaf) : undefined;
  if (leaf) return openLeaf(leaf);
  if (!d.target) return;
  if (d.target.hasAttribute("data-hub")) return ctx?.showView("brain");
  const dept = d.target.getAttribute("data-dept");
  if (dept && ctx) {
    filters = { ...filters, dept: filters.dept?.[0] === dept ? [] : [dept] };
    ctx.setFilterState(filters);
    ctx.refreshFilters();
    return applyFilter();
  }
}

// ---------------------------------------------------------------- data + view

async function load(): Promise<void> {
  const r = await fetchResult<AtlasResponse>("/api/atlas", undefined, 60_000);
  if (!r.ok) error = r.error;
  else {
    data = r.data;
    error = null;
  }
  renderStats(data?.leaves.length ?? 0);
  renderLegend();
  // A source still reading (or a failed first scan): ask again shortly, only while the view is up.
  if (ctx && (error || data?.pending.length)) poll.arm(() => void load(), 10_000);
  if (!root || !ctx) return;
  draw();
  ctx.refreshFilters();
}

function buildRoot(): HTMLElement {
  const r = el("section", "av-root");
  r.setAttribute("aria-label", "Atlas of capabilities");
  svg = s("svg", { class: "av-svg", role: "img", "aria-label": "Radial map: memory at the centre, departments, then skills, agents, routines and CLIs" });
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointerleave", () => {
    if (tip) tip.hidden = true;
    highlight(null);
  });
  tip = el("div", "av-tip");
  tip.hidden = true;
  panel = el("aside", "av-panel");
  panel.setAttribute("aria-label", "Capability details");
  panel.hidden = true;
  r.append(svg, tip, panel);
  return r;
}

// Was the 🗺️ Atlas view (#/atlas, redirected by resolveLegacyRoute): renamed Capabilities and
// moved under Setup (UX-2), so "atlas" now means one thing, the Vault's Folders section.
export const capabilitiesView: AlefView = {
  id: "capabilities",
  emoji: "🗺️",
  name: "Capabilities",
  hint: "Every skill, agent, routine and CLI (the old Atlas), grouped into 8 departments by what it serves, with its autonomy",
  usesPlanet: false,
  mount(r, c) {
    ctx = c;
    root ??= buildRoot();
    r.append(root);
    ro ??= new ResizeObserver(() => (userMoved ? paint() : fit()));
    if (svg) ro.observe(svg);
    renderLegend();
    renderStats(data?.leaves.length ?? 0);
    if (data) draw();
    void load();
  },
  unmount() {
    poll.stop();
    ro?.disconnect();
    closePanel();
    root?.remove();
    ctx = null;
  },
  filters(): FilterSpec[] {
    const leaves = data?.leaves ?? [];
    return [
      { id: "search", label: "Find a capability", type: "search", placeholder: "skill, agent, routine, CLI…" },
      { id: "kind", label: "Kind", type: "chips", multi: true, options: ATLAS_KINDS.map((k) => ({ value: k, label: KIND_META[k].label, emoji: KIND_META[k].emoji, count: leaves.filter((l) => l.kind === k).length })) },
      { id: "autonomy", label: "Autonomy", type: "chips", multi: true, options: [...ATLAS_AUTONOMY].reverse().map((a) => ({ value: a, label: AUTONOMY_META[a].label, hint: AUTONOMY_META[a].hint, count: leaves.filter((l) => l.autonomy === a).length })) },
      { id: "dept", label: "Departments", type: "list", options: (data?.departments ?? []).map((d) => ({ value: d.id, label: d.name, emoji: d.emoji, count: d.leaves, dot: DEPT_COLORS[d.id] })) },
      { id: "legend", label: "Legend", type: "section", render: (host) => void host.append(sections().legend) },
      { id: "stats", label: "Stats", type: "section", render: (host) => void host.append(sections().stats) },
    ];
  },
  onFilter(state) {
    filters = state;
    applyFilter();
  },
  onFocus() {
    if (!userMoved) fit();
  },
  onEscape() {
    return closePanel();
  },
};
