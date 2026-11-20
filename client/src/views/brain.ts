// 🧠 Brain: the alex_claude vault the way Obsidian shows it, embedded and read-only.
// The view itself (root) is just the graph (folder colours, degree-sized nodes, pan / zoom /
// minimap, hover lights up neighbours, click opens), drawn flat (2D canvas) or as a 3D globe
// (brain-globe.ts, its own WebGL renderer, chosen in the sidebar's "Graph" switch). Search
// (BM25) and its results, graph stats + zoom, and the folder legend live as left-sidebar
// sections/filters; a note (markdown
// with clickable [[wikilinks]], tags, callouts, backlinks, local graph, "Open in Obsidian") is
// the contextual details panel, docked at the right edge, shown only while one is open.
// #/brain/<vault-relative path> opens that note (the Project page and Home's cards link here).
// Data: /api/brain/* (shared/features/brain.ts). Private: note text is never logged; local-only.

import type {
  BrainBacklinksResponse,
  BrainGraphResponse,
  BrainLegendResponse,
  BrainLink,
  BrainNode,
  BrainNoteResponse,
  BrainSearchHit,
  BrainSearchResponse,
} from "../../../shared/features/brain";
import type { VaultClimb, VaultClimbResponse, VaultFiringResponse, VaultSynapse, VaultSynapsesResponse } from "../../../shared/features/vault";
import { MAX_K, clampPan, fitView, screenToWorld, wheelFactor, zoomAt, type View } from "../features/canvas/view";
import * as THREE from "three";
import { log } from "../log";
import type { AlefView, FilterSpec, FilterState, ViewContext } from "../shell/views";
import { escapeHtml, relativeTime } from "../ui/fuzzy";
import { createGlobe, type GlobeController } from "./brain-globe";
import { dropLegacyGraphMode, litIds, readGraphMode, settleGraphMode, writeGraphMode, type GraphMode } from "./brain-globe-lib";
import {
  FOLDER_COLORS,
  bounds,
  climbRuleLabel,
  climbStepTitle,
  combineFolderFilters,
  combineGroupFilters,
  filterGraph,
  folderColor,
  folderLabel,
  groupLabel,
  isMemoryPath,
  localGraph,
  neighbourMap,
  nodeRadius,
  graphRetryDelayMs,
  graphRetryText,
  notePath,
  obsidianUrl,
  resolveLink,
  seedLayout,
  stepLayout,
  type Graph,
  type GraphFilter,
  type Pos,
} from "./brain-lib";
import { renderMarkdown } from "./brain-md";
import { explainError, fetchResult } from "./code-api";
import "./brain.css";
import { mindFrame, mindTabs } from "./mind-tabs";
import { viewState } from "../shell/view-state";

const esc = escapeHtml;
const GRAPH_LIMIT = 1500;

interface Dom {
  /** The Brain destination's frame: the tab strip above `root` (mind-tabs.ts mindFrame). */
  frame: HTMLElement;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  tip: HTMLElement;
  minimapBox: HTMLElement;
  minimap: HTMLCanvasElement;
  notePanel: HTMLElement;
  noteHead: HTMLElement;
  noteBody: HTMLElement;
  /** The centred loading / error state over the graph (UX-11), or null when the graph is up. */
  state: HTMLElement | null;
}

/** Persistent sidebar-section bodies: built once, moved into a fresh host on every mount. */
interface Sections {
  mode: HTMLElement;
  results: HTMLElement;
  graph: HTMLElement;
  legend: HTMLElement;
  stats: HTMLElement;
}

let ctx: ViewContext | null = null;
let dom: Dom | null = null;
let sections: Sections | null = null;
let filters: FilterState = {};
let full: BrainGraphResponse | null = null;
let graphError: string | null = null;
let graphLoading = false;
/** A pending retry of a failed graph load (graphRetryDelayMs), cleared on unmount. */
let graphRetry: ReturnType<typeof setTimeout> | null = null;
let graphRetryNote: string | null = null;
/** Round 11, package D: vault-wide totals for the Legend (every folder/type in the WHOLE
 *  vault, tag/link/attachment counts) — independent of `full`, which is only the graph
 *  endpoint's top-N slice. */
let legend: BrainLegendResponse | null = null;
let legendError: string | null = null;
let legendLoading = false;
/** Folders/types the Legend has turned off, ANDed with the sidebar chips in applyFilters(). */
let legendFoldersOff = new Set<string>();
let legendGroupsOff = new Set<string>();
let shown: Graph = { nodes: [], edges: [] };
let byId = new Map<number, BrainNode>();
let byPath = new Map<string, BrainNode>();
let nbrs = new Map<number, Set<number>>();
let pos = new Map<number, Pos>();
let view: View = { x: 0, y: 0, k: 1 };
let alpha = 0;
let hover: number | null = null;
let raf = 0;
let dirty = true;
let fitted = false;
let userMoved = false;
let note: BrainNoteResponse | null = null;
let noteError: string | null = null;
let noteLoading: string | null = null;
let history: string[] = [];
/** The open note's chain up to Home, from the vault feed. Null until it arrives or when it fails. */
let climb: { path: string; data: VaultClimb } | null = null;
/** The open note's strongest synapses ("Wired to"), from the vault's synapse cache. */
let wired: { path: string; list: readonly VaultSynapse[] } | null = null;
/** What is firing now (notes from the last 2 days + one hop of spreading activation), keyed by
 *  lowercase vault path without ".md" (BrainNode.path's shape), valued by activation 0..1. */
let firing = new Map<string, number>();
let firingLoaded = false;
/** "⚡ What's firing" is on: everything that is not firing dims (2D) or goes dark (globe). */
let showFiring = false;
let hits: BrainSearchHit[] = [];
let searchState: "idle" | "loading" | "building" | "done" | "error" = "idle";
let searchQuery = "";
/** Enter was pressed before the results arrived: open the top hit when they do. */
let openFirstWhenReady = false;
/** The first onFilter after mount replays the remembered state; it is not an Enter. */
let freshMount = false;
let ro: ResizeObserver | null = null;
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
let noteAbort: AbortController | null = null;
const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);
dropLegacyGraphMode(storage);
/** 3D globe (the default) or 2D: localStorage when it works, else this variable remembers it for the page load. */
let graphMode: GraphMode = readGraphMode(storage);
let globe: GlobeController | null = null;
/** Neighbours over the WHOLE graph slice: the globe keeps every node and dims non-matches. */
let allNbrs = new Map<number, Set<number>>();
/** The last folder / legend / memory / project filter, before the 2D graph's unlinked-note prune. */
let lastFilter: GraphFilter = { folders: [], memoryOnly: false, project: null };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ---------------------------------------------------------------- DOM

function buildDom(): Dom {
  const r = h("section", "bv-root");
  r.setAttribute("aria-label", "Vault graph");
  const canvas = h("canvas", "bv-canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Graph of the vault's notes and links. Click a dot to open the note.");
  const tip = h("div", "bv-tip");
  tip.hidden = true;
  const minimapBox = h("div", "bv-minimap");
  minimapBox.id = "brain-minimap";
  const minimap = h("canvas");
  minimap.setAttribute("aria-label", "Minimap: click to jump");
  minimap.setAttribute("role", "img");
  minimapBox.append(minimap);

  // The contextual details panel (same geometry as the shell's #panel): shown only when a note
  // is open, closed by its own ✕ or Esc.
  const noteEl = h("aside", "bv-note");
  noteEl.id = "brain-note";
  noteEl.setAttribute("aria-label", "Note");
  noteEl.hidden = true;
  const noteHead = h("div", "bv-box-head bv-note-head");
  const noteBody = h("div", "bv-note-body");
  noteBody.tabIndex = 0;
  noteEl.append(noteHead, noteBody);

  r.append(canvas, tip, minimapBox, noteEl);
  // The artifact's tab bar, in the strip above the graph: Graph is this view, every other tab a
  // Vault section. Vault mounts the same frame, so the bar sits in the same place in both (VIS-8).
  const tabs = mindTabs("graph", (view, param) => ctx?.showView(view, param));
  const frame = mindFrame(tabs, r);
  const d: Dom = { frame, root: r, canvas, tip, minimapBox, minimap, notePanel: noteEl, noteHead, noteBody, state: null };
  wire(d);
  return d;
}

/** Persistent sidebar-section bodies (built once; the shell hands out a fresh host per mount,
 *  and mounting again just re-parents the same content, listeners intact). */
function ensureSections(): Sections {
  if (sections) return sections;
  const results = h("div", "bv-results");
  results.setAttribute("aria-live", "polite");
  results.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-path]");
    if (b) openNote(b.dataset.path ?? "");
  });

  const stats = h("div", "bv-stats");
  const controls = h("div", "bv-graph-controls");
  controls.innerHTML = `<button type="button" data-act="in" aria-label="Zoom in">+</button><button type="button" data-act="out" aria-label="Zoom out">−</button><button type="button" data-act="fit" aria-label="Fit the graph">⤢</button>`;
  controls.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b || !dom) return;
    if (globe) {
      if (b.dataset.act === "fit") globe.reset();
      else globe.zoom(b.dataset.act === "in" ? 1.3 : 1 / 1.3);
      return;
    }
    const r = dom.canvas.getBoundingClientRect();
    userMoved = true;
    if (b.dataset.act === "in") view = zoomAt(view, 1.3, r.width / 2, r.height / 2, 0.05, MAX_K * 2);
    else if (b.dataset.act === "out") view = zoomAt(view, 1 / 1.3, r.width / 2, r.height / 2, 0.05, MAX_K * 2);
    else fit();
    markDirty();
  });
  const graph = h("div", "bv-sec-graph");
  graph.append(stats, controls);

  const legendEl = h("div", "bv-legend");
  // Round 11, package D: every row is a real checkbox (folders, then types); toggling one
  // ANDs/updates the graph filter (combineFolderFilters/combineGroupFilters) without touching
  // the separate "Folders" chips filter above it.
  legendEl.addEventListener("change", (ev) => {
    const input = ev.target instanceof HTMLInputElement ? ev.target : null;
    const row = input?.closest<HTMLElement>("[data-legend-id]");
    const id = row?.dataset.legendId;
    // "" is the real id for root-level files (no folder) — only a genuinely absent row bails out.
    if (!input || id === undefined) return;
    const off = row?.dataset.legendKind === "group" ? legendGroupsOff : legendFoldersOff;
    if (input.checked) off.delete(id);
    else off.add(id);
    applyFilters();
  });

  // The 2D / 3D switch is a render mode, not a filter: its own section (styled like the shell's
  // segmented control), so it never shows in the active-filters strip and Reset leaves it alone.
  const mode = h("div", "alef-f-segmented bv-mode");
  mode.innerHTML = `<div class="alef-fchips" role="group" aria-label="Graph"><button type="button" class="alef-fchip" data-mode="2d"><span class="alef-flabel">2D</span></button><button type="button" class="alef-fchip" data-mode="3d"><span class="alef-flabel">3D globe</span></button></div><button type="button" class="alef-fchip bv-firing-btn" data-firing hidden aria-pressed="false" title="Light up the notes from the last 2 days and the ones they set off (spreading activation over the vault's synapses)"><span class="alef-flabel">⚡ What's firing</span></button>`;
  mode.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("button[data-firing]")) {
      showFiring = !showFiring;
      renderModeSwitch();
      syncGlobe();
      renderStats();
      markDirty();
      return;
    }
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (b) setGraphMode(b.dataset.mode === "3d" ? "3d" : "2d");
  });

  sections = { mode, results, graph, legend: legendEl, stats };
  return sections;
}

function wire(d: Dom): void {
  d.canvas.addEventListener("wheel", onWheel, { passive: false });
  d.canvas.addEventListener("pointerdown", onDown);
  d.canvas.addEventListener("pointermove", onMove);
  d.canvas.addEventListener("pointerup", onUp);
  d.canvas.addEventListener("pointerleave", () => {
    if (hover !== null) {
      hover = null;
      d.tip.hidden = true;
      markDirty();
    }
  });
  d.minimap.addEventListener("click", (ev) => {
    const r = d.minimap.getBoundingClientRect();
    const b = bounds(pos, shown.nodes.map((n) => n.id));
    const s = Math.min(r.width / b.w, r.height / b.h);
    const wx = b.x + (ev.clientX - r.left - (r.width - b.w * s) / 2) / s;
    const wy = b.y + (ev.clientY - r.top - (r.height - b.h * s) / 2) / s;
    const cr = d.canvas.getBoundingClientRect();
    view = { k: view.k, x: cr.width / 2 - wx * view.k, y: cr.height / 2 - wy * view.k };
    markDirty();
  });
  d.noteHead.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "back") {
      history.pop();
      const prev = history.pop();
      if (prev) openNote(prev);
    } else if (b.dataset.act === "close") closeNote();
    else if (b.dataset.act === "locate") locate();
  });
  d.noteBody.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLElement>("a.md-wikilink, [data-note]");
    if (!a) return;
    ev.preventDefault();
    if (a.dataset.note) {
      openNote(a.dataset.note);
      return;
    }
    void followLink(a.dataset.target ?? "", a.dataset.heading ?? null);
  });
}

// ---------------------------------------------------------------- data

/** Round 11, package D: vault-wide legend totals, independent of the (top-N) graph load above
 *  so a folder/type with only low-degree notes still shows a real count and a working toggle. */
async function loadLegend(): Promise<void> {
  if (legendLoading || legend) return;
  legendLoading = true;
  legendError = null;
  renderLegend();
  const r = await fetchResult<BrainLegendResponse>(`/api/brain/legend`, undefined, 60_000);
  legendLoading = false;
  if (!r.ok) {
    legendError = r.error;
    renderLegend();
    return;
  }
  legend = r.data;
  renderLegend();
}

async function loadGraph(attempt = 0): Promise<void> {
  if (graphLoading || full) return;
  if (graphRetry) clearTimeout(graphRetry);
  graphRetry = null;
  graphLoading = true;
  graphError = null;
  renderStats();
  const r = await fetchResult<BrainGraphResponse>(`/api/brain/graph?limit=${GRAPH_LIMIT}`, undefined, 60_000);
  graphLoading = false;
  void loadFiring();
  if (!r.ok) {
    graphError = r.error;
    const delay = graphRetryDelayMs(attempt, r.status);
    // A busy or restarting server: try again on our own instead of staying empty until a remount.
    graphRetryNote = delay !== null && ctx ? graphRetryText(r.error, delay, attempt) : null;
    if (delay !== null && ctx) graphRetry = setTimeout(() => void loadGraph(attempt + 1), delay);
    renderStats();
    return;
  }
  graphRetryNote = null;
  full = r.data;
  byId = new Map(full.nodes.map((n) => [n.id, n]));
  byPath = new Map(full.nodes.map((n) => [notePath(n.path).toLowerCase(), n]));
  pos = seedLayout(full.nodes);
  allNbrs = neighbourMap(full.edges);
  globe?.setGraph(full.nodes, full.edges, allNbrs);
  applyFilters();
  ctx?.refreshFilters();
}

function projectName(): string | null {
  const sel = ctx?.selection.get();
  if (sel?.kind !== "agent") return null;
  return ctx?.store.agents.get(sel.id)?.islandId ?? null;
}

function applyFilters(): void {
  if (!full) return;
  const project = filters.project?.[0] === "on" ? projectName() : null;
  const allFolders = legend?.folders.map((f) => f.id) ?? [];
  const allGroups = legend?.groups.map((gr) => gr.id) ?? [];
  const folders = combineFolderFilters(filters.folders ?? [], allFolders, legendFoldersOff);
  const groups = combineGroupFilters(allGroups, legendGroupsOff);
  lastFilter = { folders, groups, memoryOnly: filters.memory?.[0] === "on", project };
  let g = filterGraph({ nodes: full.nodes, edges: full.edges }, lastFilter);
  if (filters.orphans?.[0] !== "on") {
    const linked = new Set<number>();
    for (const [a, b] of g.edges) {
      linked.add(a);
      linked.add(b);
    }
    const openId = note ? byPath.get(notePath(note.path).toLowerCase())?.id : undefined;
    g = { nodes: g.nodes.filter((n) => linked.has(n.id) || n.id === openId), edges: g.edges };
  }
  shown = g;
  userMoved = false;
  nbrs = neighbourMap(g.edges);
  alpha = 1;
  fitted = false;
  hover = null;
  renderStats();
  renderLegend();
  syncGlobe();
  markDirty();
  kick();
}

async function runSearch(q: string): Promise<void> {
  const query = q.trim();
  if (query !== searchQuery) openFirstWhenReady = false;
  searchQuery = query;
  if (!query) {
    hits = [];
    searchState = "idle";
    renderResults();
    syncGlobe();
    ctx?.refreshFilters();
    return;
  }
  searchState = "loading";
  renderResults();
  const r = await fetchResult<BrainSearchResponse>(`/api/brain/search?q=${encodeURIComponent(query)}&limit=30`);
  if (query !== searchQuery) return;
  if (!r.ok) {
    searchState = "error";
    hits = [];
  } else {
    hits = r.data.hits;
    searchState = r.data.ready ? "done" : "building";
  }
  renderResults();
  syncGlobe();
  const top = hits[0];
  if (openFirstWhenReady && searchState === "done" && top) openNote(top.path);
  openFirstWhenReady = false;
  ctx?.refreshFilters();
}

function openNote(path: string): void {
  const p = path.trim();
  if (!p) return;
  noteAbort?.abort();
  const ac = new AbortController();
  noteAbort = ac;
  noteLoading = p;
  noteError = null;
  const n = byPath.get(notePath(p).toLowerCase());
  if (globe && n) globe.face(n.id); // a search hit or a click turns the globe at once
  renderLayout();
  renderNote();
  void fetchResult<BrainNoteResponse>(`/api/brain/note?path=${encodeURIComponent(p)}`, ac.signal).then((r) => {
    if (ac.signal.aborted) return;
    noteLoading = null;
    if (!r.ok) {
      noteError = explainError(r.status, r.error === "not-found" ? "not-found" : r.error);
      note = null;
      renderNote();
      return;
    }
    note = r.data;
    if (history[history.length - 1] !== r.data.path) history.push(r.data.path);
    if (history.length > 50) history = history.slice(-50);
    renderNote();
    if (filters.orphans?.[0] !== "on") applyFilters();
    locate(false);
    markDirty();
    if (r.data.backlinks === null) void retryBacklinks(r.data.path);
    void loadClimb(r.data.path, ac.signal);
    void loadWired(r.data.path, ac.signal);
  });
}

async function loadClimb(path: string, signal: AbortSignal): Promise<void> {
  const r = await fetchResult<VaultClimbResponse>(`/api/vault/climb?path=${encodeURIComponent(path)}`, signal);
  if (signal.aborted || !note || note.path !== path) return;
  // A missing climb is not an error worth showing: the section simply stays away.
  climb = r.ok ? { path, data: r.data.climb } : null;
  renderNote();
}

async function loadWired(path: string, signal: AbortSignal): Promise<void> {
  const r = await fetchResult<VaultSynapsesResponse>(`/api/vault/synapses?path=${encodeURIComponent(path)}`, signal);
  if (signal.aborted || !note || note.path !== path) return;
  wired = r.ok && r.data.synapses.length ? { path, list: r.data.synapses } : null;
  renderNote();
}

/** Once per mount: which notes fire now. No cache yet => nothing glows, nothing is said. */
async function loadFiring(): Promise<void> {
  if (firingLoaded) return;
  firingLoaded = true;
  const r = await fetchResult<VaultFiringResponse>("/api/vault/firing?days=2");
  if (!r.ok || !r.data.ready) return;
  firing = new Map(r.data.firing.notes.map((f) => [f.path.replace(/\.md$/i, "").toLowerCase(), f.act]));
  renderModeSwitch();
  syncGlobe();
  renderStats();
  markDirty();
}

async function retryBacklinks(path: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2500));
    if (!note || note.path !== path) return;
    const r = await fetchResult<BrainBacklinksResponse>(`/api/brain/backlinks?path=${encodeURIComponent(path)}`);
    if (!note || note.path !== path) return;
    if (r.ok && r.data.ready) {
      note = { ...note, backlinks: r.data.backlinks };
      renderNote();
      return;
    }
  }
}

function closeNote(): boolean {
  if (!note && !noteError && !noteLoading) return false;
  noteAbort?.abort();
  note = null;
  climb = null;
  wired = null;
  noteError = null;
  noteLoading = null;
  history = [];
  renderLayout();
  renderNote();
  markDirty();
  return true;
}

async function followLink(target: string, heading: string | null): Promise<void> {
  if (!target && heading) {
    document.getElementById(`md-${heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-")}`)?.scrollIntoView({ block: "start" });
    return;
  }
  const hit = resolveLink(target, note?.outlinks ?? [], full?.nodes ?? [], note?.path ?? "");
  if (hit) {
    openNote(hit);
    return;
  }
  // Not in the graph slice or the note's resolved links: ask search for the closest title.
  const r = await fetchResult<BrainSearchResponse>(`/api/brain/search?q=${encodeURIComponent(target)}&limit=5`);
  const want = target.toLowerCase().split("/").pop() ?? "";
  const best = r.ok ? (r.data.hits.find((x) => x.title.toLowerCase() === want || notePath(x.path).toLowerCase().endsWith(want)) ?? null) : null;
  if (best) openNote(best.path);
  else ctx?.toast(`"${target}" has no note in the vault yet (an unresolved link).`);
}

/** Centre the graph on the open note. */
function locate(animate = true): void {
  if (!note || !dom) return;
  const n = byPath.get(notePath(note.path).toLowerCase());
  const p = n ? pos.get(n.id) : undefined;
  if (globe && n) {
    globe.face(n.id);
    return;
  }
  if (!p) {
    if (animate) ctx?.toast("This note is not in the graph slice (only the most linked notes are drawn).");
    return;
  }
  const r = dom.canvas.getBoundingClientRect();
  userMoved = true;
  const k = Math.max(view.k, 0.9);
  view = { k, x: r.width / 2 - p.x * k, y: r.height / 2 - p.y * k };
  markDirty();
}

// ---------------------------------------------------------------- rendering (DOM)

function renderLayout(): void {
  if (!dom) return;
  dom.notePanel.hidden = !(note || noteError || noteLoading);
  globe?.setOpen(note ? (byPath.get(notePath(note.path).toLowerCase())?.id ?? null) : null);
}

/** Loading and failure are said in the middle of the graph, with one action, not only in the
 *  sidebar's Stats line where nobody looks (UX-11). Gone once there is a graph to show. */
function renderGraphState(): void {
  if (!dom) return;
  const tone = full ? null : graphError ? "error" : graphLoading ? "loading" : null;
  const key = tone === "error" ? `error:${graphError}:${graphRetryNote ?? ""}` : tone;
  if (dom.state?.dataset.key === key) return;
  dom.state?.remove();
  dom.state = null;
  if (!tone) return;
  const state =
    tone === "error"
      ? viewState({
          tone,
          overlay: true,
          title: "Couldn't load the vault graph",
          detail: graphRetryNote ?? graphError ?? undefined,
          action: {
            label: "Try again",
            run: () => {
              if (graphRetry) clearTimeout(graphRetry);
              graphRetry = null;
              void loadGraph();
            },
          },
        })
      : viewState({ tone, overlay: true, title: "Loading the vault graph…" });
  state.dataset.key = key ?? "";
  dom.root.append(state);
  dom.state = state;
}

function renderStats(): void {
  renderGraphState();
  if (!sections) return;
  if (graphLoading) sections.stats.textContent = "Loading the vault graph…";
  else if (graphError) sections.stats.textContent = graphRetryNote ?? `Could not load the graph: ${graphError}`;
  else if (full) {
    const age = full.generatedAt ? ` · graph built ${relativeTime(full.generatedAt)}` : "";
    const vault = `(vault: ${full.total.nodes.toLocaleString()} notes, ${full.total.edges.toLocaleString()} links)${age}`;
    const folders = (list: readonly BrainNode[]): number => new Set(list.map((n) => n.folder)).size;
    if (globe) {
      const drawn = globe.linksDrawn();
      const lit = globeLit();
      const links = drawn < full.edges.length ? `${drawn.toLocaleString()} of ${full.edges.length.toLocaleString()} links drawn (the strongest; hover a note for all of its links)` : `${drawn.toLocaleString()} links`;
      sections.stats.textContent = `${full.nodes.length.toLocaleString()} notes · ${links} · ${folders(full.nodes)} folders on the globe${lit ? ` · ${lit.size.toLocaleString()} ${showFiring ? "firing" : "match"}` : ""} ${vault}`;
    } else {
      const lit = firing.size ? shown.nodes.filter((n) => firing.has(n.path.toLowerCase())).length : 0;
      sections.stats.textContent = `${shown.nodes.length} notes · ${shown.edges.length} links · ${folders(shown.nodes)} folders shown${lit ? ` · ⚡ ${lit} firing (amber glow)` : ""} ${vault}`;
    }
  } else sections.stats.textContent = "";
}

/** Round 11, package D: every element of the vault (real, vault-wide counts — never just the
 *  graph's top-N slice), with a real checkbox per folder/type that toggles it in the graph
 *  (combineFolderFilters/combineGroupFilters in applyFilters). Tags/links/attachments are
 *  informational counts only: brain-graph.json has no tag or attachment nodes to toggle. */
function legendRow(kind: "folder" | "group", id: string, count: number, label: string, dotColor: string | null): string {
  const off = (kind === "group" ? legendGroupsOff : legendFoldersOff).has(id);
  const dot = dotColor ? `<i style="background:${dotColor}"></i>` : "";
  return `<label class="bv-leg bv-leg-toggle" data-legend-kind="${kind}" data-legend-id="${esc(id)}">
    <input type="checkbox" ${off ? "" : "checked"} aria-label="Show ${esc(label)} in the graph" />${dot}${esc(label)} <b>${count.toLocaleString("en-US")}</b>
  </label>`;
}

function renderLegend(): void {
  if (!sections) return;
  if (legendLoading && !legend) {
    sections.legend.innerHTML = `<p class="bv-empty">Loading the vault legend…</p>`;
    return;
  }
  if (legendError && !legend) {
    sections.legend.innerHTML = `<p class="bv-empty">Could not load the vault legend: ${esc(legendError)}</p>`;
    return;
  }
  if (!legend) return;
  const folderRows = legend.folders.map((f) => legendRow("folder", f.id, f.count, folderLabel(f.id), folderColor(f.id))).join("");
  const groupRows = legend.groups.map((g) => legendRow("group", g.id, g.count, groupLabel(g.id), null)).join("");
  const tags = !legend.tagsReady
    ? `<p class="bv-leg-tags">Tags: still building the vault index…</p>`
    : legend.tags.length
      ? `<p class="bv-leg-tags">Top tags: ${legend.tags
          .slice(0, 15)
          .map((t) => `#${esc(t.id)} (${t.count})`)
          .join(", ")}</p>`
      : `<p class="bv-leg-tags">No #tags found in the vault.</p>`;
  const splits = globe?.splits() ?? [];
  const globeRows = splits
    .map(
      (sp) =>
        `<div class="bv-leg-section"><h4>On the globe: ${esc(sp.folder)} by ${sp.by}</h4>${sp.groups
          .map((gr) => `<span class="bv-leg"><i style="background:${gr.color}"></i>${esc(gr.key || "(top level)")} <b>${gr.count.toLocaleString("en-US")}</b></span>`)
          .join("")}</div>`,
    )
    .join("");
  sections.legend.innerHTML = `${globeRows}
    <p class="bv-leg-stats">${legend.totalNodes.toLocaleString("en-US")} notes vault-wide · ${legend.totalLinks.toLocaleString("en-US")} links · ${legend.attachments.toLocaleString("en-US")} attachments</p>
    <div class="bv-leg-section"><h4>Folders</h4>${folderRows}</div>
    <div class="bv-leg-section"><h4>Types</h4>${groupRows}</div>
    ${tags}
  `;
}

function renderResults(): void {
  if (!sections) return;
  if (searchState === "idle") {
    sections.results.innerHTML = `<p class="bv-empty">Search every note in the vault (titles and text).</p>`;
    return;
  }
  if (searchState === "loading") {
    sections.results.innerHTML = `<p class="bv-empty">Searching…</p>`;
    return;
  }
  if (searchState === "error") {
    sections.results.innerHTML = `<p class="bv-empty">Search failed. Is the world server running?</p>`;
    return;
  }
  if (searchState === "building") {
    sections.results.innerHTML = `<p class="bv-empty">The search index is still being built. Try again in a few seconds.</p>`;
    return;
  }
  sections.results.innerHTML = hits.length
    ? `<ul>${hits
        .map((x) => {
          const folder = x.path.split("/")[0] ?? "";
          return `<li><button type="button" data-path="${esc(x.path)}" class="${note?.path === x.path ? "bv-on" : ""}"><span class="bv-hit-title"><i style="background:${folderColor(folder)}"></i>${esc(x.title)}</span><span class="bv-hit-path">${esc(notePath(x.path))}</span><span class="bv-hit-snip">${esc(x.snippet.replace(/\s+/g, " ").slice(0, 160))}</span></button></li>`;
        })
        .join("")}</ul>`
    : `<p class="bv-empty">No note matches “${esc(searchQuery)}”.</p>`;
}

/** "this note › a kind of Pricing › a kind of Startup › … › Home", each step a link. */
function climbHtml(path: string): string {
  if (!climb || climb.path !== path || climb.data.end === "unknown" || climb.data.steps.length < 2) return "";
  const { steps, end } = climb.data;
  const items = steps
    .slice(1)
    .map((s) => {
      const folder = s.path.split("/")[0] ?? "";
      const why = climbRuleLabel(s.rule);
      return `<li>${why ? `<small>${esc(why)}</small>` : ""}<button type="button" class="bv-climb-step" data-note="${esc(s.path)}" title="${esc(notePath(s.path))}"><i style="background:${folderColor(folder)}"></i>${esc(climbStepTitle(s.path))}</button></li>`;
    })
    .join("");
  const unanchored = steps[1]?.rule === "home";
  const warn =
    end === "loop" ? `<p class="bv-climb-warn">This chain loops back on itself. Fix the <code>broader:</code> that points back.</p>`
    : end === "dead-end" ? `<p class="bv-climb-warn">The chain stops at a note the feed does not hold.</p>`
    : unanchored ? `<p class="bv-climb-warn">No genus, project or folder index: add <code>broader:</code> to give it one.</p>`
    : "";
  return `<nav class="bv-climb" aria-label="Climb to Home"><span class="bv-climb-head">↑ Climb <b>${steps.length - 1}</b></span><ol>${items}</ol>${warn}</nav>`;
}

/** "⚡ Wired to": the note's strongest synapses, each a link with a bar for its weight. */
function wiredHtml(path: string): string {
  if (!wired || wired.path !== path) return "";
  const max = Math.max(...wired.list.map((s) => s.w), 1e-9);
  const items = wired.list
    .slice(0, 8)
    .map((s) => {
      const folder = s.path.split("/")[0] ?? "";
      const pct = Math.round((s.w / max) * 100);
      return `<li><button type="button" class="bv-link" data-note="${esc(s.path)}" title="${esc(notePath(s.path))} · weight ${s.w}"><i style="background:${folderColor(folder)}"></i><span>${esc(climbStepTitle(s.path))}</span><em class="bv-wire" style="--w:${pct}%"></em></button></li>`;
    })
    .join("");
  return `<section class="bv-section bv-wired"><h3>⚡ Wired to <b>${wired.list.length}</b></h3><p class="bv-meta">Strongest synapses: links plus how often you used these notes together, fading over months.</p><ul class="bv-links">${items}</ul></section>`;
}

function linkList(list: readonly BrainLink[], empty: string): string {
  if (!list.length) return `<p class="bv-empty">${empty}</p>`;
  return `<ul class="bv-links">${list
    .slice(0, 80)
    .map((l) => {
      const folder = l.path.split("/")[0] ?? "";
      return `<li><button type="button" class="bv-link" data-note="${esc(l.path)}"><i style="background:${folderColor(folder)}"></i><span>${esc(l.title)}</span><small>${esc(notePath(l.path).split("/").slice(0, -1).join("/"))}</small></button></li>`;
    })
    .join("")}${list.length > 80 ? `<li class="bv-empty">+${list.length - 80} more</li>` : ""}</ul>`;
}

function localGraphSvg(n: BrainNoteResponse): string {
  const nodes = localGraph({ path: n.path, title: n.title }, n.outlinks, n.backlinks ?? [], 16);
  if (nodes.length <= 1) return `<p class="bv-empty">No links in or out.</p>`;
  const W = 420;
  const H = 240;
  const cx = W / 2;
  const cy = H / 2;
  const R = 92;
  const px = (x: number): number => cx + x * R * 1.25;
  const py = (y: number): number => cy + y * R;
  let lines = "";
  let dots = "";
  for (const ln of nodes.slice(1)) lines += `<line x1="${cx}" y1="${cy}" x2="${px(ln.x).toFixed(1)}" y2="${py(ln.y).toFixed(1)}" class="bv-lg-${ln.kind}"/>`;
  for (const ln of nodes) {
    const x = ln.kind === "center" ? cx : px(ln.x);
    const y = ln.kind === "center" ? cy : py(ln.y);
    const folder = ln.path.split("/")[0] ?? "";
    const r = ln.kind === "center" ? 11 : 6;
    const label = ln.title.length > 18 ? `${ln.title.slice(0, 17)}…` : ln.title;
    const anchor = ln.kind === "center" ? "middle" : x >= cx ? "start" : "end";
    const lx = ln.kind === "center" ? x : x + (x >= cx ? 9 : -9);
    const ly = ln.kind === "center" ? y + 25 : y + 4;
    dots += `<g class="bv-lg-node${ln.kind === "center" ? " bv-lg-center" : ""}" data-note="${esc(ln.path)}" tabindex="0" role="link" aria-label="${esc(ln.title)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${folderColor(folder)}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(label)}</text></g>`;
  }
  return `<svg class="bv-local" viewBox="0 0 ${W} ${H}" role="group" aria-label="Local graph of this note">${lines}${dots}</svg>
    <p class="bv-lg-key"><span class="bv-k-out">→ links to</span> <span class="bv-k-back">← linked from</span> <span class="bv-k-both">↔ both</span></p>`;
}

function renderNote(): void {
  if (!dom) return;
  renderLayout();
  if (noteLoading && !note) {
    dom.noteHead.innerHTML = `<span class="bv-box-title">📄 ${esc(notePath(noteLoading).split("/").pop() ?? "")}</span>`;
    dom.noteBody.innerHTML = `<p class="bv-empty">Opening…</p>`;
    return;
  }
  if (noteError) {
    dom.noteHead.innerHTML = `<span class="bv-box-title">📄 Note</span><span class="bv-head-btns"><button type="button" class="bv-mini" data-act="close" aria-label="Close the note">×</button></span>`;
    dom.noteBody.innerHTML = `<div class="bv-refused">${esc(noteError)}</div>`;
    return;
  }
  if (!note) return; // renderLayout() already hid the panel in this state
  const n = note;
  const rendered = renderMarkdown(n.markdown);
  const folder = n.path.split("/")[0] ?? "";
  const crumbs = notePath(n.path).split("/").slice(0, -1).join(" › ");
  dom.noteHead.innerHTML = `<span class="bv-box-title" title="${esc(n.path)}"><i class="bv-fdot" style="background:${folderColor(folder)}"></i>${esc(n.title)}</span>
    <span class="bv-head-btns">
      ${history.length > 1 ? `<button type="button" class="bv-mini" data-act="back" aria-label="Back to the previous note">←</button>` : ""}
      <button type="button" class="bv-mini" data-act="locate" title="Find it in the graph" aria-label="Find it in the graph">⌖</button>
      <a class="bv-mini bv-obsidian" href="${esc(obsidianUrl(n.path))}" title="Open this note in Obsidian">Open in Obsidian</a>
      <button type="button" class="bv-mini" data-act="close" aria-label="Close the note">×</button>
    </span>`;
  const tags = [...new Set(rendered.tags)];
  const back = n.backlinks;
  dom.noteBody.innerHTML = `<div class="bv-crumbs">${esc(crumbs)}${isMemoryPath(n.path) ? ' <span class="bv-chip">memory</span>' : ""} · <span class="bv-meta">edited ${relativeTime(n.modifiedAt)}</span></div>
    ${tags.length ? `<div class="bv-tags">${tags.map((t) => `<span class="md-tag">#${esc(t.replace(/^#/, ""))}</span>`).join(" ")}</div>` : ""}
    ${rendered.aliases.length ? `<div class="bv-meta">Also called: ${rendered.aliases.map(esc).join(", ")}</div>` : ""}
    ${climbHtml(n.path)}
    ${wiredHtml(n.path)}
    <article class="bv-md">${rendered.html || '<p class="bv-empty">This note is empty.</p>'}</article>
    <section class="bv-section"><h3>Backlinks ${back ? `<b>${back.length}</b>` : ""}</h3>${back === null ? `<p class="bv-empty">Building the backlink index…</p>` : linkList(back, "No note links here yet.")}</section>
    <section class="bv-section"><h3>Links out <b>${n.outlinks.length}</b></h3>${linkList(n.outlinks, "This note links to nothing.")}</section>
    <section class="bv-section"><h3>Local graph</h3>${localGraphSvg(n)}</section>`;
  dom.noteBody.scrollTop = 0;
  renderResults();
}

// ---------------------------------------------------------------- graph canvas

function markDirty(): void {
  dirty = true;
  kick();
}

function kick(): void {
  if (raf || !dom?.root.isConnected || globe) return; // the globe runs its own loop
  raf = requestAnimationFrame(frame);
}

function frame(): void {
  raf = 0;
  if (!dom?.root.isConnected) return;
  if (alpha > 0.02 && shown.nodes.length) {
    const sub = new Map<number, Pos>();
    for (const n of shown.nodes) {
      const p = pos.get(n.id);
      if (p) sub.set(n.id, p);
    }
    const steps = shown.nodes.length > 1500 ? 1 : 3;
    for (let i = 0; i < steps; i++) {
      stepLayout(sub, shown.edges, alpha);
      alpha *= 0.985;
    }
    // Keep the settling graph in frame until the user pans or zooms.
    if (!userMoved && (!fitted || alpha > 0.05)) {
      fit();
      fitted = true;
    }
    markDirty();
  }
  if (dirty) {
    draw();
    drawMinimap();
    dirty = false;
  }
  if (alpha > 0.02) kick();
}

function fit(): void {
  if (!dom) return;
  const r = dom.canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  view = fitView(bounds(pos, shown.nodes.map((n) => n.id)), r.width, r.height, 30, 0.05, 1.4);
  markDirty();
}

function resize(): void {
  if (!dom) return;
  globe?.resize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of [dom.canvas, dom.minimap]) {
    const r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const hh = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
  }
  markDirty();
  kick();
}

function draw(): void {
  if (!dom) return;
  const c = dom.canvas;
  const g = c.getContext("2d");
  if (!g) return;
  const dpr = c.width / Math.max(1, c.getBoundingClientRect().width);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#fffdf6";
  g.fillRect(0, 0, c.width, c.height);
  if (!shown.nodes.length) return;
  g.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
  const hi = hover !== null ? (nbrs.get(hover) ?? new Set<number>()) : null;
  const openId = note ? byPath.get(notePath(note.path).toLowerCase())?.id ?? null : null;
  const focusId = hover ?? openId;
  const focusN = focusId !== null ? (nbrs.get(focusId) ?? new Set<number>()) : null;
  // edges
  g.lineWidth = Math.max(0.6, 1.1 / view.k);
  g.strokeStyle = focusN ? "rgba(26,16,48,0.06)" : "rgba(26,16,48,0.16)";
  g.beginPath();
  for (const [a, b] of shown.edges) {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) continue;
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
  }
  g.stroke();
  if (focusId !== null) {
    g.strokeStyle = "#ff4d8d";
    g.lineWidth = Math.max(1.2, 2.2 / view.k);
    g.beginPath();
    const p = pos.get(focusId);
    for (const o of focusN ?? []) {
      const q = pos.get(o);
      if (!p || !q) continue;
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
    }
    g.stroke();
  }
  // firing halos: notes active in the last 2 days and the ones they set off (spreading activation)
  if (firing.size) {
    g.fillStyle = "#ffb21e"; // --amber
    for (const n of shown.nodes) {
      const act = firing.get(n.path.toLowerCase());
      if (act === undefined) continue;
      const p = pos.get(n.id);
      if (!p) continue;
      const dim = focusN && n.id !== focusId && !focusN.has(n.id);
      g.globalAlpha = (dim ? 0.12 : 0.35) * (0.4 + 0.6 * act);
      g.beginPath();
      g.arc(p.x, p.y, nodeRadius(n.degree) + (4 + 8 * act) / view.k + 2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  // nodes
  const ink = Math.max(0.8, 1.6 / view.k);
  for (const n of shown.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const r = nodeRadius(n.degree);
    const dim = (focusN && n.id !== focusId && !focusN.has(n.id)) || (showFiring && firing.size > 0 && !firing.has(n.path.toLowerCase()));
    g.globalAlpha = dim ? 0.28 : 1;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = folderColor(n.folder);
    g.fill();
    g.lineWidth = ink;
    g.strokeStyle = "#1a1030";
    g.stroke();
    if (n.id === openId) {
      g.beginPath();
      g.arc(p.x, p.y, r + 5 / view.k + 2, 0, Math.PI * 2);
      g.lineWidth = Math.max(2, 3 / view.k);
      g.strokeStyle = "#ff4d8d";
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  // labels: big nodes when zoomed in, plus the hovered / open note and its neighbours
  const fontPx = 12 / view.k;
  g.font = `700 ${fontPx}px "Avenir Next", "Nunito", system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "top";
  g.lineJoin = "round";
  let labelled = 0;
  for (const n of shown.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const r = nodeRadius(n.degree);
    const near = focusId !== null && (n.id === focusId || (hi ?? focusN)?.has(n.id) === true);
    // Nodes arrive most-linked first: label the big ones once zoomed in, at most 40 at a time.
    if (!near && (r * view.k < 14 || labelled >= 40)) continue;
    if (focusN && !near) continue;
    if (!near) labelled++;
    const label = n.label.length > 32 ? `${n.label.slice(0, 31)}…` : n.label;
    g.lineWidth = 3.5 / view.k;
    g.strokeStyle = "rgba(255,253,246,0.95)";
    g.strokeText(label, p.x, p.y + r + 2 / view.k);
    g.fillStyle = "#1a1030";
    g.fillText(label, p.x, p.y + r + 2 / view.k);
  }
}

function drawMinimap(): void {
  if (!dom || dom.minimapBox.hidden) return;
  const c = dom.minimap;
  const g = c.getContext("2d");
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#fff8e7";
  g.fillRect(0, 0, c.width, c.height);
  const b = bounds(pos, shown.nodes.map((n) => n.id));
  const s = Math.min(c.width / b.w, c.height / b.h);
  const ox = (c.width - b.w * s) / 2;
  const oy = (c.height - b.h * s) / 2;
  for (const n of shown.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    g.fillStyle = folderColor(n.folder);
    g.fillRect(ox + (p.x - b.x) * s - 1, oy + (p.y - b.y) * s - 1, 2.5, 2.5);
  }
  const r = dom.canvas.getBoundingClientRect();
  const tl = screenToWorld(view, 0, 0);
  const br = screenToWorld(view, r.width, r.height);
  g.strokeStyle = "#ff4d8d";
  g.lineWidth = 2;
  g.strokeRect(ox + (tl.x - b.x) * s, oy + (tl.y - b.y) * s, (br.x - tl.x) * s, (br.y - tl.y) * s);
}

function pick(clientX: number, clientY: number): number | null {
  if (!dom) return null;
  const r = dom.canvas.getBoundingClientRect();
  const w = screenToWorld(view, clientX - r.left, clientY - r.top);
  let best: number | null = null;
  let bestD = Infinity;
  for (const n of shown.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    const reach = nodeRadius(n.degree) + 4 / view.k;
    if (d < reach && d < bestD) {
      best = n.id;
      bestD = d;
    }
  }
  return best;
}

function onWheel(ev: WheelEvent): void {
  if (!dom) return;
  ev.preventDefault();
  userMoved = true;
  const r = dom.canvas.getBoundingClientRect();
  if (ev.ctrlKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) view = zoomAt(view, wheelFactor(ev.deltaY, ev.deltaMode, ev.ctrlKey), ev.clientX - r.left, ev.clientY - r.top, 0.05, MAX_K * 2);
  else view = { ...view, x: view.x - ev.deltaX };
  markDirty();
  kick();
}

function onDown(ev: PointerEvent): void {
  if (!dom || ev.button !== 0) return;
  dom.canvas.setPointerCapture(ev.pointerId);
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
}

function onMove(ev: PointerEvent): void {
  if (!dom) return;
  if (drag) {
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) {
      userMoved = true;
      const r = dom.canvas.getBoundingClientRect();
      view = clampPan({ k: view.k, x: drag.vx + dx, y: drag.vy + dy }, bounds(pos, shown.nodes.map((n) => n.id)), r.width, r.height, 60);
      markDirty();
      kick();
      return;
    }
  }
  const id = pick(ev.clientX, ev.clientY);
  if (id !== hover) {
    hover = id;
    markDirty();
    kick();
  }
  dom.canvas.style.cursor = showTip(id, ev.clientX, ev.clientY) ? "pointer" : drag ? "grabbing" : "grab";
}

/** The hover label, shared by the 2D graph and the globe. True when a note is under the pointer. */
function showTip(id: number | null, clientX: number, clientY: number): boolean {
  const n = id !== null ? byId.get(id) : undefined;
  if (!dom) return false;
  dom.tip.hidden = !n;
  if (!n) return false;
  const r = dom.root.getBoundingClientRect();
  dom.tip.innerHTML = `<b>${esc(n.label)}</b><span>${esc(notePath(n.path))}</span><span>${n.degree} link${n.degree === 1 ? "" : "s"} in the vault · click to open</span>`;
  dom.tip.style.left = `${Math.min(r.width - 260, clientX - r.left + 14)}px`;
  dom.tip.style.top = `${clientY - r.top + 14}px`;
  return true;
}

function onUp(ev: PointerEvent): void {
  if (!dom) return;
  const wasDrag = drag?.moved === true;
  drag = null;
  if (dom.canvas.hasPointerCapture(ev.pointerId)) dom.canvas.releasePointerCapture(ev.pointerId);
  if (wasDrag) return;
  const id = pick(ev.clientX, ev.clientY);
  const n = id !== null ? byId.get(id) : undefined;
  if (n) openNote(n.path);
}

// ---------------------------------------------------------------- 3D globe mode

/** What the globe keeps lit: litIds (brain-globe-lib) over the whole slice, unlinked notes included. */
function globeLit(): Set<number> | null {
  if (!full) return null;
  const searching = searchQuery !== "" && searchState === "done";
  const hitIds = searching ? new Set(hits.map((x) => byPath.get(notePath(x.path).toLowerCase())?.id).filter((id): id is number => id !== undefined)) : null;
  const lit = litIds({ nodes: full.nodes, edges: full.edges }, lastFilter, hitIds);
  if (!showFiring || !firing.size) return lit;
  const on = new Set<number>();
  for (const n of full.nodes) if (firing.has(n.path.toLowerCase()) && (!lit || lit.has(n.id))) on.add(n.id);
  return on;
}

function syncGlobe(): void {
  if (!globe) return;
  globe.setLit(globeLit());
  renderStats();
}

/** True when the globe is up. False: WebGL can't start here (a toast says so). */
function openGlobe(): boolean {
  if (!dom) return false;
  if (globe) return true;
  const canvas = h("canvas", "bv-globe");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-roledescription", "3D globe");
  canvas.setAttribute("aria-label", "Globe of the vault's notes, one region per folder. Drag or arrow keys to turn, scroll or + and − to zoom, click a dot or press Enter to open the note in the middle.");
  const labels = h("div", "bv-globe-labels");
  dom.root.insertBefore(labels, dom.tip);
  dom.root.insertBefore(canvas, labels);
  let renderer: THREE.WebGLRenderer;
  try {
    if (document.body.classList.contains("alef-no-3d")) throw new Error("WebGL is off in this browser");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (err) {
    canvas.remove();
    labels.remove();
    log.warn("brain", "3D globe unavailable, staying on the 2D graph", err instanceof Error ? err.message : String(err));
    ctx?.toast("The 3D globe needs WebGL, which this browser can't start. Showing the 2D graph.");
    return false;
  }
  globe = createGlobe({
    canvas,
    renderer,
    labels: {
      host: labels,
      make(folder, color) {
        const el = h("span", "bv-globe-label", folderLabel(folder));
        el.style.setProperty("--dot", color);
        // Born hidden: the globe appends every label, then places them on the next frame, so a
        // label that starts visible flashes once at the host's top-left before it is positioned.
        // Opacity (not display) keeps it measurable -- buildLabels reads its width on append.
        el.style.opacity = "0";
        return el;
      },
    },
    onHover: (id, x, y) => void showTip(id, x, y),
    onPick(id) {
      const n = byId.get(id);
      if (n) openNote(n.path);
    },
    onLost() {
      ctx?.toast("The 3D globe lost its GPU context. Back to the 2D graph.");
      graphMode = "2d"; // not saved: it did open here once, so the next load tries again
      syncMode();
    },
  });
  globe.resize();
  if (full) globe.setGraph(full.nodes, full.edges, allNbrs);
  renderLayout();
  syncGlobe();
  return true;
}

/** Disposes every GPU resource (renderer.dispose + forceContextLoss) and removes the canvas. */
function closeGlobe(): void {
  if (!globe) return;
  globe.dispose();
  globe = null;
  dom?.root.querySelector(".bv-globe-labels")?.remove();
  if (dom) dom.tip.hidden = true;
}

function renderModeSwitch(): void {
  for (const b of sections?.mode.querySelectorAll<HTMLButtonElement>("button[data-mode]") ?? []) {
    const on = b.dataset.mode === graphMode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const fb = sections?.mode.querySelector<HTMLButtonElement>("button[data-firing]");
  if (fb) {
    fb.hidden = firing.size === 0;
    fb.classList.toggle("on", showFiring);
    fb.setAttribute("aria-pressed", String(showFiring));
  }
}

/** The user picked a mode in the sidebar switch. */
function setGraphMode(mode: GraphMode): void {
  graphMode = mode;
  syncMode(true);
}

/** Open or close the globe to match graphMode (only while Brain is mounted). `save`: remember the
 *  outcome (settleGraphMode: "3d" only once the globe really opened; a failed open saves "2d"). */
function syncMode(save = false): void {
  if (!dom) return;
  if (graphMode === "3d" && dom.root.isConnected) {
    const settled = settleGraphMode("3d", openGlobe());
    graphMode = settled.mode;
    if (save || settled.mode !== "3d") writeGraphMode(storage, settled.save);
  } else {
    closeGlobe();
    if (save) writeGraphMode(storage, "2d");
  }
  dom.root.classList.toggle("bv-3d", globe !== null);
  renderModeSwitch();
  renderStats();
  renderLegend();
  resize();
}

// ---------------------------------------------------------------- the view

export const brainView: AlefView = {
  id: "brain",
  emoji: "🧠",
  name: "Brain",
  keys: ["9"],
  hint: "Your alex_claude vault, Obsidian style: graph, notes, backlinks, search (read-only)",
  mount(r, c) {
    freshMount = true;
    ctx = c;
    const first = !dom;
    dom ??= buildDom();
    r.append(dom.frame);
    if (first) {
      ro = new ResizeObserver(() => resize());
      ro.observe(dom.canvas);
      ro.observe(dom.minimap);
    }
    renderLayout();
    renderResults();
    renderNote();
    renderStats();
    renderLegend();
    syncMode();
    void loadGraph();
    void loadFiring();
    void loadLegend();
    kick();
    // #/brain/<vault path> opens that note (the Project page's "Vault note" links here).
    const param = c.route().param;
    if (param) openNote(param);
  },
  onParam(param) {
    if (param) openNote(param);
  },
  unmount() {
    firingLoaded = false; // re-read what fires on the next visit
    if (graphRetry) clearTimeout(graphRetry);
    graphRetry = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    closeGlobe(); // frees the WebGL context; the next mount in 3D builds a fresh one
    dom?.frame.remove();
    ctx = null;
  },
  filters(): FilterSpec[] {
    const groups = full?.groups ?? [];
    const known = Object.keys(FOLDER_COLORS);
    const folderOpts = [...groups]
      .filter((g) => g.id)
      .sort((a, b) => (known.indexOf(a.id) + 1 || 99) - (known.indexOf(b.id) + 1 || 99))
      .map((g) => ({ value: g.id, label: folderLabel(g.id), count: g.count }));
    const sec = ensureSections();
    renderModeSwitch();
    return [
      { id: "search", label: "Search the vault", type: "search", placeholder: "Words in any note…" },
      {
        id: "results",
        label: "Results",
        type: "section",
        count: hits.length || undefined,
        render(host) {
          host.append(sec.results);
        },
      },
      {
        id: "graphMode",
        label: "Graph",
        type: "section",
        render(host) {
          host.append(sec.mode);
        },
      },
      {
        id: "graph",
        label: "Stats · zoom",
        type: "section",
        render(host) {
          host.append(sec.graph);
        },
      },
      {
        id: "legend",
        label: "Legend",
        type: "section",
        collapsed: true,
        render(host) {
          host.append(sec.legend);
        },
      },
      { id: "folders", label: "Folders", type: "chips", multi: true, options: folderOpts.length ? folderOpts : Object.keys(FOLDER_COLORS).map((f) => ({ value: f, label: folderLabel(f) })) },
      { id: "memory", label: "Memory only", type: "toggle" },
      { id: "project", label: "Linked to the selected agent's project", type: "toggle" },
      { id: "orphans", label: "Show unlinked notes", type: "toggle" },
    ];
  },
  onFilter(state) {
    const prev = filters;
    filters = state;
    const wasFresh = freshMount;
    freshMount = false;
    const q = (state.search?.[0] ?? "").trim();
    if (q !== (prev.search?.[0] ?? "").trim()) void runSearch(q);
    else if (q && !wasFresh && JSON.stringify(prev) === JSON.stringify(state)) {
      // The same search fired again with nothing changed: that's Enter in the box. Open the top hit.
      const top = hits[0];
      if (searchState === "done" && top) openNote(top.path);
      else openFirstWhenReady = true;
    }
    const same = (k: string): boolean => (prev[k] ?? []).join("|") === (state[k] ?? []).join("|");
    if (!same("folders") || !same("memory") || !same("project") || !same("orphans")) {
      applyFilters();
      if (state.project?.[0] === "on" && !projectName()) ctx?.toast("Select an agent first (on Orbit or the Board): this filter keeps notes about its project.");
    }
  },
  onSelect() {
    if (filters.project?.[0] === "on") applyFilters();
  },
  onFocus() {
    resize(); // the main area resizes as the shell hides/shows its chrome
  },
  onEscape() {
    return closeNote();
  },
};
