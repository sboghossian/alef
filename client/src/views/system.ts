// 🧭 System: the whole setup at a glance, live. A prompt enters at the top (sessions, voice,
// routines), runs through ONE engine (Claude Code + its harness), fans out to five planes
// (machines & sync, guardrails & hooks, skills & agents, memory & vault, services & routines) and
// ends as outputs. Every node is a pill with a status dot (green / amber / red / grey for unknown)
// and one live line; a click opens the details panel with the facts and where they were read.
// Wide screens draw it as an SVG hub and spoke (system-lib.ts lays it out, features/canvas/view
// pans and zooms it); under NARROW_PX the same planes stack as cards. Data: GET /api/system
// (shared/features/system.ts), re-asked every 15 s while the view is up. ?redact=1 asks the server
// to hide hostnames and paths. All text is untrusted: textContent only.

import type { SystemNode, SystemPlane, SystemResponse } from "../../../shared/features/system";
import { MAX_K, clampPan, fitView, wheelFactor, zoomAt, type View } from "../features/canvas/view";
import { redactOn } from "../redact";
import type { AlefView, FilterSpec, ViewContext } from "../shell/views";
import { pollChain } from "./atlas-lib";
import { fetchResult } from "./code-api";
import { NODE_H, NODE_W, STATUS_COLORS, STATUS_LABELS, clip, exportSvgText, waitText, isNarrow, layoutSystem, narrowOrder, statsLines, type SystemLayout } from "./system-lib";
import { renderLayers } from "./system-render-layers";
import { layerItems, layersMarkdown } from "./system-md";
import "./system.css";
import "./system-layers.css";

const SVG = "http://www.w3.org/2000/svg";
const REFRESH_MS = 15_000;

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let data: SystemResponse | null = null;
let error: string | null = null;
let layout: SystemLayout | null = null;
let svg: SVGSVGElement | null = null;
let world: SVGGElement | null = null;
let view: View = { x: 0, y: 0, k: 1 };
let userMoved = false;
let narrow = false;
let selected: string | null = null;
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; node: string | null } | null = null;
let ro: ResizeObserver | null = null;
const poll = pollChain();
let side: { legend: HTMLElement; stats: HTMLElement; actions: HTMLElement; note: HTMLElement } | null = null;
const sections = (): NonNullable<typeof side> => (side ??= buildSide());
let refreshing = false;
/** Map = the layered live map (default); Graph = the old hub-and-spoke drawing. */
let lens: "map" | "graph" = "map";
type Detail = Pick<SystemNode, "label" | "value" | "status" | "facts" | "source">;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildSide(): NonNullable<typeof side> {
  const actions = el("div", "sv-actions");
  const note = el("p", "sv-stat");
  note.setAttribute("role", "status");
  const mk = (text: string, on: () => void): HTMLButtonElement => {
    const b = el("button", "sv-btn", text);
    b.type = "button";
    b.addEventListener("click", on);
    return b;
  };
  actions.append(mk("↻ Refresh", () => void forceRefresh()), mk("Copy as Markdown", () => void copyMarkdown()), mk("Export SVG", exportSvg), mk("Map", () => setLens("map")), mk("Graph", () => setLens("graph")));
  return { legend: el("div", "sv-legend"), stats: el("div", "sv-stats"), actions, note };
}

/** Forces the server to recompute now (single-flight, 1 per 10 s there); the page shows its answer. */
async function forceRefresh(): Promise<void> {
  const { note, actions } = sections();
  if (refreshing) return;
  refreshing = true;
  const btn = actions.querySelector("button");
  if (btn) btn.disabled = true;
  note.textContent = "Recomputing…";
  try {
    const res = await fetch(`/api/system/refresh${redactOn() ? "?redact=1" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => null)) as (SystemResponse & { error?: string; retryAfterMs?: number }) | null;
    if (res.ok && body?.planes) {
      data = body;
      error = null;
      note.textContent = "Refreshed.";
      renderSide();
      if (root && ctx) draw();
    } else if (res.status === 429) note.textContent = `Just refreshed, ${waitText(body?.retryAfterMs ?? 10_000)}.`;
    else note.textContent = `Refresh failed: ${body?.error ?? res.status}`;
  } catch (err) {
    note.textContent = `Refresh failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refreshing = false;
    if (btn) btn.disabled = false;
  }
}

function setLens(next: typeof lens): void {
  lens = next;
  for (const b of sections().actions.querySelectorAll("button")) if (b.textContent === "Map" || b.textContent === "Graph") b.setAttribute("aria-pressed", String(b.textContent.toLowerCase() === lens));
  if (data && root) draw();
}

/** The live map as Markdown on the clipboard (the layered map is HTML, so it cannot export as SVG). */
async function copyMarkdown(): Promise<void> {
  const { note } = sections();
  if (!data?.layers) {
    note.textContent = "No layered map to copy yet.";
    return;
  }
  try {
    await navigator.clipboard.writeText(layersMarkdown(data.layers, data.at));
    note.textContent = "Copied the map as Markdown.";
  } catch {
    note.textContent = "Couldn't reach the clipboard.";
  }
}

/** Downloads the current hub and spoke as a standalone .svg (wide layout only; narrow has no graph). */
function exportSvg(): void {
  const { note } = sections();
  if (!world || !layout) {
    note.textContent = lens === "map" ? "Export SVG applies to the Graph lens; use Copy as Markdown for the Map." : "Export needs the wide view: widen the window.";
    return;
  }
  const text = exportSvgText(new XMLSerializer().serializeToString(world).replace(/ transform="[^"]*"/, ""), layout.bounds);
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  const a = el("a", "");
  a.href = url;
  a.download = `alef-system-${new Date().toISOString().slice(0, 10)}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  note.textContent = "Exported the hub and spoke.";
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

const allNodes = (): SystemNode[] => data?.planes.flatMap((p) => p.nodes) ?? [];
const nodeById = (id: string): Detail | undefined => allNodes().find((n) => n.id === id) ?? (data?.layers ? layerItems(data.layers).find((i) => i.id === id) : undefined);

// ---------------------------------------------------------------- wide: SVG hub and spoke

function drawWide(planes: readonly SystemPlane[]): void {
  if (!stage) return;
  layout = layoutSystem(planes);
  svg ??= makeSvg();
  const w = s("g", { class: "sv-world" });
  const edges = s("g", { class: "sv-edges" }, w);
  const hubsG = s("g", { class: "sv-hubs" }, w);
  const nodesG = s("g", { class: "sv-nodes" }, w);
  // The flow: prompts -> engine -> services -> outputs, and the spokes to the four side planes.
  const link = (a: string, b: string, cls = ""): void => {
    const p = layout?.hubs.get(a as SystemPlane["id"]);
    const q = layout?.hubs.get(b as SystemPlane["id"]);
    if (p && q) s("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: cls }, edges);
  };
  for (const [a, b] of [["prompts", "engine"], ["engine", "services"], ["services", "outputs"], ["engine", "machines"], ["engine", "guardrails"], ["engine", "skills"], ["engine", "memory"]] as const) link(a, b, a === "engine" && b !== "services" ? "" : "sv-flow");
  for (const p of planes) {
    const hub = layout.hubs.get(p.id);
    if (!hub) continue;
    for (const n of p.nodes) {
      const c = layout.nodes.get(n.id);
      if (c) s("line", { x1: hub.x, y1: hub.y, x2: c.x, y2: c.y, class: "sv-spoke" }, edges);
    }
    const g = s("g", { class: `sv-hub${p.id === "engine" ? " is-engine" : ""}`, transform: `translate(${hub.x} ${hub.y})` }, hubsG);
    s("circle", { r: hub.r, fill: p.id === "engine" ? "#ffd23f" : "#fffdf6" }, g);
    s("circle", { class: "sv-hub-dot", cx: hub.r * 0.72, cy: -hub.r * 0.72, r: 8, fill: STATUS_COLORS[p.status] }, g);
    s("text", { class: "sv-emoji", y: 1 }, g).textContent = p.emoji;
    s("text", { class: "sv-hub-label", y: hub.r + 18 }, g).textContent = p.name;
  }
  for (const n of planes.flatMap((p) => p.nodes)) {
    const c = layout.nodes.get(n.id);
    if (!c) continue;
    const g = s("g", { class: "sv-node", "data-node": n.id, transform: `translate(${c.x - NODE_W / 2} ${c.y - NODE_H / 2})` }, nodesG);
    s("rect", { width: NODE_W, height: NODE_H, rx: 12 }, g);
    s("circle", { class: "sv-dot", cx: 17, cy: NODE_H / 2, r: 7, fill: STATUS_COLORS[n.status] }, g);
    s("text", { class: "sv-node-label", x: 32, y: 19 }, g).textContent = clip(n.label, 20);
    s("text", { class: "sv-node-value", x: 32, y: 38 }, g).textContent = clip(n.value, 27);
  }
  world?.remove();
  world = w;
  if (svg.parentElement !== stage) stage.replaceChildren(svg);
  svg.append(w);
  markSelected();
  if (!userMoved) fit();
  else paint();
}

function makeSvg(): SVGSVGElement {
  const e = s("svg", { class: "sv-svg", role: "img", "aria-label": "Hub and spoke: prompts enter at the top, one engine in the middle, five planes around it, outputs at the bottom" });
  e.addEventListener("wheel", onWheel, { passive: false });
  e.addEventListener("pointerdown", onDown);
  e.addEventListener("pointermove", onMove);
  e.addEventListener("pointerup", onUp);
  return e;
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

function onWheel(ev: WheelEvent): void {
  if (!svg) return;
  ev.preventDefault();
  userMoved = true;
  const r = svg.getBoundingClientRect();
  view = zoomAt(view, wheelFactor(ev.deltaY, ev.deltaMode, ev.ctrlKey), ev.clientX - r.left, ev.clientY - r.top, 0.1, MAX_K * 2);
  paint();
}

function onDown(ev: PointerEvent): void {
  if (!svg || ev.button !== 0) return;
  const node = ev.target instanceof Element ? (ev.target.closest("[data-node]")?.getAttribute("data-node") ?? null) : null;
  svg.setPointerCapture(ev.pointerId);
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, node };
}

function onMove(ev: PointerEvent): void {
  if (!svg || !drag) return;
  const dx = ev.clientX - drag.x;
  const dy = ev.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved || !layout) return;
  userMoved = true;
  const r = svg.getBoundingClientRect();
  view = clampPan({ k: view.k, x: drag.vx + dx, y: drag.vy + dy }, layout.bounds, r.width, r.height, 60);
  paint();
}

function onUp(ev: PointerEvent): void {
  if (!svg) return;
  const d = drag;
  drag = null;
  if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  if (d && !d.moved && d.node) openNode(d.node);
}

// ---------------------------------------------------------------- narrow: a vertical flow of cards

function drawNarrow(planes: readonly SystemPlane[]): void {
  if (!stage) return;
  const list = el("div", "sv-flow-list");
  narrowOrder(planes).forEach((p, i) => {
    if (i > 0) list.append(el("div", "sv-arrow", "↓"));
    const card = el("section", `sv-card sv-card-${p.id}`);
    const head = el("h3", "sv-card-head");
    const dot = el("i", "sv-dot");
    dot.style.background = STATUS_COLORS[p.status];
    head.append(dot, el("span", "", `${p.emoji} ${p.name}`));
    card.append(head);
    for (const n of p.nodes) {
      const b = el("button", "sv-row");
      b.type = "button";
      b.dataset.node = n.id;
      const d = el("i", "sv-dot");
      d.style.background = STATUS_COLORS[n.status];
      const text = el("span", "sv-row-text");
      text.append(el("b", "", n.label), el("small", "", n.value));
      b.append(d, text);
      b.addEventListener("click", () => openNode(n.id));
      card.append(b);
    }
    list.append(card);
  });
  stage.replaceChildren(list);
  svg = null;
  world = null;
  markSelected();
}

// ---------------------------------------------------------------- details panel

function drawMap(layers: NonNullable<SystemResponse["layers"]>): void {
  if (!stage) return;
  const top = stage.scrollTop;
  stage.classList.add("is-map");
  stage.replaceChildren(renderLayers(layers, openNode));
  stage.scrollTop = top;
  svg = null;
  world = null;
  layout = null;
  markSelected();
}

function openNode(id: string): void {
  const n = nodeById(id);
  if (!n || !panel) return;
  selected = id;
  markSelected();
  const head = el("div", "sv-panel-head");
  head.append(el("span", "sv-panel-title", n.label));
  const close = el("button", "sv-x", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => void closePanel());
  head.append(close);
  const body = el("div", "sv-panel-body");
  const row = (label: string, value: string, status?: SystemNode["status"]): void => {
    const r = el("div", "sv-fact");
    const v = el("span", "", value);
    if (status) {
      const d = el("i", "sv-dot");
      d.style.background = STATUS_COLORS[status];
      v.prepend(d);
    }
    r.append(el("b", "", label), v);
    body.append(r);
  };
  row("Status", STATUS_LABELS[n.status], n.status);
  row("Now", n.value);
  for (const f of n.facts) row(f.label, f.value);
  row("Read from", n.source);
  panel.replaceChildren(head, body);
  panel.hidden = false;
  reframe();
}

/** The panel docks over the right of the stage; on wide screens the stage gives it that room
 *  (CSS .has-panel) and the graph refits into what is left, so no plane hides under the panel.
 *  After a manual pan or zoom the view stays, only nudged so the selected node is not cut off. */
function reframe(): void {
  root?.classList.toggle("has-panel", !!panel && !panel.hidden);
  if (narrow || lens === "map" || !svg || !layout) return;
  if (!userMoved) return fit();
  const c = selected ? layout.nodes.get(selected) : undefined;
  const w = svg.getBoundingClientRect().width;
  if (c && w) {
    const right = view.x + (c.x + NODE_W / 2) * view.k;
    if (right > w - 16) view = { ...view, x: view.x - (right - w + 16) };
  }
  paint();
}

function closePanel(): boolean {
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  selected = null;
  markSelected();
  reframe();
  return true;
}

function markSelected(): void {
  for (const e of stage?.querySelectorAll("[data-node], [data-item]") ?? []) e.classList.toggle("is-selected", (e.getAttribute("data-node") ?? e.getAttribute("data-item")) === selected);
}

// ---------------------------------------------------------------- sidebar sections

function renderSide(): void {
  const { legend, stats } = sections();
  const key = (st: keyof typeof STATUS_COLORS): HTMLElement => {
    const r = el("div", "sv-key");
    const d = el("i", "sv-dot");
    d.style.background = STATUS_COLORS[st];
    r.append(d, el("span", "", STATUS_LABELS[st]));
    return r;
  };
  legend.replaceChildren(key("ok"), key("warn"), key("bad"), key("unknown"), el("p", "sv-stat", "Click any card or chip for its facts and where they were read."));
  const lines = data ? statsLines(data.planes, data.unavailable, data.at) : [error ? `Couldn't load the system: ${error}` : "Reading the whole setup…"];
  stats.replaceChildren(...lines.map((t) => el("p", "sv-stat", t)));
}

// ---------------------------------------------------------------- data + view

function draw(): void {
  if (!data || !stage) return;
  const w = root?.getBoundingClientRect().width ?? 0;
  narrow = isNarrow(w);
  root?.classList.toggle("is-narrow", narrow);
  const mapOn = lens === "map" && !!data.layers;
  stage.classList.toggle("is-map", mapOn);
  if (mapOn && data.layers) drawMap(data.layers);
  else if (narrow) drawNarrow(data.planes);
  else drawWide(data.planes);
  if (selected && !nodeById(selected)) void closePanel();
  else if (selected && panel && !panel.hidden) openNode(selected);
}

async function load(): Promise<void> {
  const r = await fetchResult<SystemResponse>(`/api/system${redactOn() ? "?redact=1" : ""}`, undefined, 15_000);
  if (!r.ok) error = r.error;
  else {
    data = r.data;
    error = null;
  }
  renderSide();
  if (ctx) poll.arm(() => void load(), REFRESH_MS);
  if (root && ctx) draw();
}

function buildRoot(): HTMLElement {
  const r = el("section", "sv-root");
  r.setAttribute("aria-label", "The whole system at a glance");
  stage = el("div", "sv-stage");
  panel = el("aside", "sv-panel");
  panel.setAttribute("aria-label", "Node details");
  panel.hidden = true;
  r.append(stage, panel);
  return r;
}

export const systemView: AlefView = {
  id: "system",
  emoji: "🧭",
  // Setup › Machine (UX-9): the route stays #/system.
  name: "Machine",
  hint: "The whole setup at a glance, live: machines, guardrails, the engine, memory, skills, jobs, connectors and what ships",
  usesPlanet: false,
  mount(r, c) {
    ctx = c;
    root ??= buildRoot();
    r.append(root);
    ro ??= new ResizeObserver(() => {
      const nowNarrow = isNarrow(root?.getBoundingClientRect().width ?? 0);
      if (data && nowNarrow !== narrow) draw();
      else if (!narrow && lens === "graph") userMoved ? paint() : fit();
    });
    ro.observe(root);
    renderSide();
    if (data) draw();
    void load();
  },
  unmount() {
    poll.stop();
    ro?.disconnect();
    void closePanel();
    root?.remove();
    ctx = null;
  },
  filters(): FilterSpec[] {
    return [
      { id: "legend", label: "Legend", type: "section", render: (host) => void host.append(sections().legend) },
      { id: "stats", label: "Stats", type: "section", render: (host) => void host.append(sections().stats) },
      { id: "actions", label: "Actions", type: "section", render: (host) => void host.append(sections().actions, sections().note) },
    ];
  },
  onFocus() {
    if (!userMoved && !narrow && lens === "graph") fit();
  },
  onEscape() {
    return closePanel();
  },
};
