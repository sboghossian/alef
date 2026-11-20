// The canvas view's DOM: a pannable / zoomable world of cream node cards (virtualized: only
// cards near the viewport exist) over a screen-sized <canvas> that draws only the edges in
// view (a 2k×5k SVG edge layer re-rasterized on every pan/zoom was the bottleneck), a second
// canvas for the beads that travel along edges for live activity, a minimap, an inspector
// and a phone-friendly list. Hand-rolled, no dependencies. Text from sessions is untrusted:
// it only ever goes through textContent.

import { AUTONOMY_LEVELS } from "../../../../shared/autonomy";
import { mcpTint, STATIONS } from "../../../../shared/stations";
import type { ActivityStage } from "../../../../shared/types";
import { h } from "../fleet-overlay";
import { EDGE_KINDS, type CEdge, type CEdgeKind, type Graph, type NodeKind } from "./graph";
import { CARD_H, LANE_HEAD_Y, LANE_W, bezierPoint, edgeCurve, layoutAutonomy, layoutGraph, listGroups, type AutonomyYMode, type LaidNode, type Layout } from "./layout";
import { centerOn, clampPan, fitView, intersects, visibleWorld, wheelFactor, zoomAt, type View } from "./view";

const LAYOUT_MODE_KEY = "agent-world.canvas.layoutMode";
const AUTONOMY_Y_KEY = "agent-world.canvas.autonomyY";
export type LayoutMode = "graph" | "autonomy";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Edge styles (screen px): colors match the legend swatches in canvas.css. */
export const EDGE_STYLE: Record<CEdgeKind, { color: string; width: number; dash: number[]; alpha: number }> = {
  spawned: { color: "#5b3fc4", width: 3, dash: [], alpha: 0.8 },
  uses: { color: "#1a1030", width: 1.5, dash: [7, 5], alpha: 0.38 },
  touched: { color: "#1f9d61", width: 1.6, dash: [2, 4], alpha: 0.6 },
  decided: { color: "#ff4d8d", width: 2.2, dash: [10, 4, 2, 4], alpha: 0.75 },
  awaits: { color: "#ff5a36", width: 3, dash: [8, 5], alpha: 0.9 },
};

const STAGE_FILL: Record<ActivityStage, string> = { hook: "#ff8a3d", brain: "#ff6fb5", plan: "#7ad7ff", reason: "#b28dff", tool: "#ffd23f" };

// hook/skill/mcp/subagent are tool stations (shared/stations.ts): their colour comes from the
// one catalog everywhere (Feed, Canvas, Harness City), not a value hardcoded here a second time.
const BLOCK_FILL: Record<NodeKind, string> = {
  session: "#ffd0e3",
  subagent: STATIONS.subagent.color,
  hook: STATIONS.hook.color,
  router: "#fff4c7",
  tier: "#eadfff",
  brain: "#ffd6ec",
  skill: STATIONS.skill.color,
  model: "#eadfff",
  mcp: STATIONS.mcp.color, // per-node override: an actual mcp CNode uses mcpTint(n.label) instead
  file: "#fffdf6",
  repo: "#fffdf6",
  jev: "#fff4c7",
  approval: "#ffcfbf",
  routine: "#efeaf7",
  dept: "#e3f5e8",
  artifact: "#e0f0ff",
  more: "#f1ecf8",
};

/** The card's left accent stripe / LOD block colour: a station colour for hook/skill/subagent, a
 *  per-server tint for an mcp node (so different MCP servers read as different colours), else the
 *  kind's own flat colour. */
function stripeFor(kind: NodeKind, label: string): string {
  if (kind === "mcp") return mcpTint(label);
  if (kind === "hook" || kind === "skill" || kind === "subagent") return STATIONS[kind].color;
  return BLOCK_FILL[kind];
}

interface Curve {
  edge: CEdge;
  c: [number, number, number, number, number, number, number, number];
  box: { x: number; y: number; w: number; h: number };
}
const OVERSCAN_PX = 140;
/** Below this zoom the cards are too small to read: draw them as blocks on the edge canvas
 *  instead of mounting hundreds of DOM cards (level of detail). */
export const LOD_K = 0.34;
/** Solo never opens below this zoom: above cv-tiny (0.6), so cards show labels and actions. */
export const SOLO_K = 0.66;
const BEAD_MS = 1100;
const MAX_BEADS = 90;

export const EDGE_LABEL: Record<CEdgeKind, string> = {
  spawned: "spawned",
  uses: "uses",
  touched: "touched",
  decided: "decided",
  awaits: "awaits",
};

const KIND_LABEL: Record<NodeKind, string> = {
  session: "session",
  hook: `${STATIONS.hook.emoji} hook`,
  router: "🗼 Jev router",
  tier: "⚡ model tier",
  brain: "memory",
  skill: `${STATIONS.skill.emoji} skill`,
  model: "model",
  mcp: `${STATIONS.mcp.emoji} MCP`,
  subagent: `${STATIONS.subagent.emoji} subagent`,
  file: "file",
  repo: "repo",
  jev: "Jev",
  approval: "approval",
  routine: "routine",
  dept: "🗺️ department",
  artifact: "🖼 artifact",
  more: "more",
};

export type QuickAction = "focus" | "reactivate" | "editor" | "talk" | "room" | "parent" | "details" | "solo";

export interface CanvasHooks {
  onSelect(node: LaidNode | null): void;
  onAction(action: QuickAction, node: LaidNode): void;
  /** Talk is only offered for sessions the world started in tmux. */
  canTalk(nodeId: string): boolean;
  groupLabel(groupId: string): string;
  onClose(): void;
}

export type FilterChange = { scope: "today" | "all" } | { city: boolean } | { tree: boolean };

function shortAge(atMs: number, now: number): string {
  if (!atMs) return "";
  const s = Math.max(0, (now - atMs) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

interface Bead {
  curve: number[];
  t0: number;
  stage: ActivityStage;
  /** Drawn at least once (on a slow machine a frame can take longer than the whole trip). */
  drawn: boolean;
}

export class CanvasView {
  readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly world: HTMLElement;
  private readonly edgeCanvas: HTMLCanvasElement;
  private readonly beadCanvas: HTMLCanvasElement;
  private curves: Curve[] = [];
  /** Lane / group headers with their world boxes: virtualized like the cards (a tall, mostly
   *  off-screen header layer made every pan frame re-raster the whole world layer). */
  private bandItems: Array<{ el: HTMLElement; box: { x: number; y: number; w: number; h: number } }> = [];
  private readonly bandLayer: HTMLElement;
  private readonly cardLayer: HTMLElement;
  /** Sidebar "View" section: stats + zoom/fit/list/planet actions (mounted by views/canvas.ts). */
  private readonly viewSection: HTMLElement;
  /** Sidebar "Legend" section, folded by default. */
  private readonly legendSection: HTMLElement;
  private readonly inspector: HTMLElement;
  private inspectorWanted = false;
  private readonly minimapBox: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly list: HTMLElement;
  private readonly countsEl: HTMLElement;

  private graph: Graph = { nodes: [], edges: [], hidden: {} };
  private layout: Layout = layoutGraph(this.graph, new Set());
  private readonly collapsedGroups: Set<string>;
  /** "graph" (default) or "autonomy" (client/src/features/canvas/layout.ts's layoutAutonomy);
   *  remembered per browser (localStorage, try/catch — see the constructor and setLayoutMode). */
  private layoutMode: LayoutMode = "graph";
  private autonomyY: AutonomyYMode = "recency";
  private readonly modeGraphBtn: HTMLButtonElement;
  private readonly modeAutonomyBtn: HTMLButtonElement;
  private readonly yRow: HTMLElement;
  private readonly yRecencyBtn: HTMLButtonElement;
  private readonly yDistrictBtn: HTMLButtonElement;
  private readonly autonomyLegend: HTMLElement;
  private readonly mounted = new Map<string, HTMLElement>();
  private readonly incident = new Map<string, CEdge[]>();
  private view: View = { x: 40, y: 40, k: 0.6 };
  private selected: string | null = null;
  private hovered: string | null = null;
  private frameQueued = false;
  private beads: Bead[] = [];
  private beadLoop = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  private pinch: { d: number; k: number } | null = null;
  private fitted = false;
  private open = false;

  constructor(private readonly hooks: CanvasHooks) {
    let stored: string[] = [];
    try {
      const raw = localStorage.getItem("agent-world.canvas.collapsed");
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) stored = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* private mode */
    }
    this.collapsedGroups = new Set(stored);

    try {
      const raw = localStorage.getItem(LAYOUT_MODE_KEY);
      if (raw === "graph" || raw === "autonomy") this.layoutMode = raw;
    } catch {
      /* private mode */
    }
    try {
      const raw = localStorage.getItem(AUTONOMY_Y_KEY);
      if (raw === "recency" || raw === "district") this.autonomyY = raw;
    } catch {
      /* private mode */
    }

    this.root = h("div", "cv-root");
    this.root.id = "aw-canvas";
    this.root.hidden = true;
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Orchestration canvas");

    this.viewport = h("div", "cv-viewport");
    this.viewport.tabIndex = -1;
    this.world = h("div", "cv-world");
    this.bandLayer = h("div", "cv-bands");
    this.edgeCanvas = document.createElement("canvas");
    this.edgeCanvas.className = "cv-edges";
    this.edgeCanvas.setAttribute("aria-hidden", "true");
    this.beadCanvas = document.createElement("canvas");
    this.beadCanvas.className = "cv-edges cv-beads";
    this.beadCanvas.setAttribute("aria-hidden", "true");
    this.cardLayer = h("div", "cv-cards");
    this.world.append(this.bandLayer, this.cardLayer);
    this.viewport.append(this.edgeCanvas, this.beadCanvas, this.world);

    // "View" sidebar section: stats + zoom/fit/list/planet actions. Time / narrow-to-selection
    // live as the sidebar's own "Time" / "Narrow" filters (views/canvas.ts): no buttons here.
    this.viewSection = h("div", "cv-view-sec");
    const hint = h("div", "cv-ctl-hint", "V planet · 0 fit · drag to pan");
    this.countsEl = h("div", "cv-counts");
    const mk = (label: string, cls: string, title2: string): HTMLButtonElement => {
      const b = h("button", cls, label);
      b.type = "button";
      b.title = title2;
      return b;
    };
    const zoomRow = h("div", "cv-ctl-row");
    const zin = mk("+", "cv-btn cv-icon", "Zoom in (+)");
    const zout = mk("−", "cv-btn cv-icon", "Zoom out (−)");
    const fit = mk("Fit 0", "cv-btn", "Fit everything (0)");
    const listBtn = mk("List", "cv-btn", "A plain list of every card (handy on a phone)");
    const planet = mk("← Planet", "cv-btn cv-primary", "Back to the planet (V)");
    zin.addEventListener("click", () => this.zoomCenter(1.25));
    zout.addEventListener("click", () => this.zoomCenter(0.8));
    fit.addEventListener("click", () => this.fit());
    listBtn.addEventListener("click", () => this.toggleList());
    planet.addEventListener("click", () => this.hooks.onClose());
    zoomRow.append(zout, zin, fit, listBtn, planet);

    // Layout mode: the normal orchestration graph, or the Autonomy axis (client/src/features/
    // canvas/layout.ts's layoutAutonomy — sessions + subagents only, laid out by autonomyLevel).
    const modeRow = h("div", "cv-ctl-row");
    this.modeGraphBtn = mk("Graph", "cv-btn", "The full orchestration graph (default)");
    this.modeAutonomyBtn = mk("Autonomy", "cv-btn", "Lay sessions out by autonomy: driven by you → the resident");
    this.modeGraphBtn.addEventListener("click", () => this.setLayoutMode("graph"));
    this.modeAutonomyBtn.addEventListener("click", () => this.setLayoutMode("autonomy"));
    modeRow.append(this.modeGraphBtn, this.modeAutonomyBtn);

    this.yRow = h("div", "cv-ctl-row");
    this.yRecencyBtn = mk("Recency", "cv-btn", "Newest activity on top");
    this.yDistrictBtn = mk("District", "cv-btn", "Grouped by city inside each autonomy level");
    this.yRecencyBtn.addEventListener("click", () => this.setAutonomyY("recency"));
    this.yDistrictBtn.addEventListener("click", () => this.setAutonomyY("district"));
    this.yRow.append(this.yRecencyBtn, this.yDistrictBtn);

    this.viewSection.append(hint, this.countsEl, modeRow, this.yRow, zoomRow);

    // "Legend" sidebar section (folded by default): edge kinds + bead stages.
    this.legendSection = h("div", "cv-legend-sec");
    const legend = h("div", "cv-legend");
    for (const k of EDGE_KINDS) {
      const item = h("span", `cv-leg cv-leg-${k}`);
      const sw = document.createElementNS(SVG_NS, "svg");
      sw.setAttribute("viewBox", "0 0 28 8");
      sw.setAttribute("aria-hidden", "true");
      const ln = document.createElementNS(SVG_NS, "path");
      ln.setAttribute("d", "M1 4H27");
      ln.setAttribute("class", `cv-e cv-e-${k}`);
      sw.append(ln);
      item.append(sw, document.createTextNode(EDGE_LABEL[k]));
      legend.append(item);
    }
    const stages = h("div", "cv-legend cv-stages");
    stages.append(h("span", "cv-leg-title", "beads:"));
    for (const s of ["hook", "brain", "plan", "reason", "tool"] as ActivityStage[]) {
      const item = h("span", "cv-leg");
      item.append(h("i", `cv-stage cv-stage-${s}`), document.createTextNode(s));
      stages.append(item);
    }
    // The 4 tool-station node kinds (shared/stations.ts): same colour as the Feed's chips and
    // Harness City's buildings.
    const stationNodes = h("div", "cv-legend cv-stages");
    stationNodes.append(h("span", "cv-leg-title", "stations:"));
    for (const id of ["hook", "skill", "mcp", "subagent"] as const) {
      const st = STATIONS[id];
      const dot = h("i", "cv-stage");
      dot.style.background = st.color;
      dot.title = st.description;
      const item = h("span", "cv-leg");
      item.title = st.description;
      item.append(dot, document.createTextNode(`${st.emoji} ${st.label}`));
      stationNodes.append(item);
    }
    // Autonomy axis legend (shared/autonomy.ts's AUTONOMY_LEVELS): only relevant in Autonomy
    // layout mode — syncAutonomyControls() shows/hides it with the mode.
    this.autonomyLegend = h("div", "cv-legend cv-stages");
    this.autonomyLegend.append(h("span", "cv-leg-title", "autonomy axis:"));
    for (const m of AUTONOMY_LEVELS) {
      const item = h("span", "cv-leg");
      item.title = m.hint;
      item.append(document.createTextNode(m.title));
      this.autonomyLegend.append(item);
    }
    this.legendSection.append(legend, stages, stationNodes, this.autonomyLegend);

    this.inspector = h("aside", "cv-inspector");
    this.inspector.id = "canvas-inspector";
    this.inspector.setAttribute("aria-label", "Inspector");
    this.inspector.hidden = true;

    this.minimapBox = h("div", "cv-minimap");
    this.minimapBox.id = "canvas-minimap";
    this.minimap = document.createElement("canvas");
    this.minimap.setAttribute("aria-label", "Minimap: click to jump");
    this.minimap.setAttribute("role", "img");
    this.minimapBox.append(this.minimap);

    this.list = h("div", "cv-list");
    this.list.hidden = true;

    this.root.append(this.viewport);
    // The list is a body-level sheet so its z-index can sit above the HUD and the chrome pills.
    document.body.append(this.root, this.inspector, this.minimapBox, this.list);
    this.minimapBox.hidden = true;
    this.syncAutonomyControls();
    this.wire();
  }

  /** Reflects layoutMode/autonomyY onto the toggle buttons, the Y-axis row's visibility and the
   *  autonomy legend. Called once at construction (after localStorage's remembered choice loads)
   *  and again from setLayoutMode/setAutonomyY. */
  private syncAutonomyControls(): void {
    this.modeGraphBtn.classList.toggle("on", this.layoutMode === "graph");
    this.modeAutonomyBtn.classList.toggle("on", this.layoutMode === "autonomy");
    this.yRow.hidden = this.layoutMode !== "autonomy";
    this.autonomyLegend.hidden = this.layoutMode !== "autonomy";
    this.yRecencyBtn.classList.toggle("on", this.autonomyY === "recency");
    this.yDistrictBtn.classList.toggle("on", this.autonomyY === "district");
  }

  /** Switches between the full orchestration graph and the Autonomy axis; remembers the choice. */
  private setLayoutMode(mode: LayoutMode): void {
    if (this.layoutMode === mode) return;
    this.layoutMode = mode;
    try {
      localStorage.setItem(LAYOUT_MODE_KEY, mode);
    } catch {
      /* private mode */
    }
    this.syncAutonomyControls();
    this.relayout();
    // relayout() swaps this.layout.bounds for the other mode's (Autonomy's is narrower/shorter
    // than Graph's), but never re-clamps the current pan/zoom against it — a view deep in Graph's
    // 190-card Prompt lane or the Files lane showed only empty space after switching to Autonomy,
    // until the next pan/zoom/"0" (GRO review finding). setView re-clamps via clampPan, keeping the
    // current view when it still fits and pulling it back on screen when it doesn't.
    this.setView(this.view);
  }

  /** Switches the Autonomy layout's y-axis (recency vs. district); remembers the choice. A no-op
   *  on the current render when the Graph layout is active — it takes effect next time Autonomy
   *  mode is turned on. */
  private setAutonomyY(mode: AutonomyYMode): void {
    if (this.autonomyY === mode) return;
    this.autonomyY = mode;
    try {
      localStorage.setItem(AUTONOMY_Y_KEY, mode);
    } catch {
      /* private mode */
    }
    this.syncAutonomyControls();
    if (this.layoutMode === "autonomy") this.relayout();
  }

  /** Sidebar "View" section (stats + zoom/fit/list/planet). Safe to call again on a remount:
   *  it moves the same persistent element into the fresh host the shell hands it. */
  mountViewSection(host: HTMLElement): void {
    host.append(this.viewSection);
  }

  /** Sidebar "Legend" section (folded by default): edge kinds + bead stages. */
  mountLegendSection(host: HTMLElement): void {
    host.append(this.legendSection);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.root.hidden = !on;
    this.minimapBox.hidden = !on;
    this.inspector.hidden = !on || this.selected === null || !this.inspectorWanted;
    document.body.classList.toggle("aw-canvas-open", on);
    if (on) {
      if (!this.fitted) {
        this.fitted = true;
        if (this.selected && this.layout.nodes.has(this.selected)) this.centerOnNode(this.selected, 0.85);
        else this.home();
      }
      this.queue();
      this.viewport.focus({ preventScroll: true });
    } else {
      this.list.hidden = true;
    }
  }

  // ------------------------------------------------------------------ data

  setGraph(g: Graph): void {
    this.graph = g;
    this.relayout();
  }

  private relayout(): void {
    this.layout = this.layoutMode === "autonomy" ? layoutAutonomy(this.graph, this.collapsedGroups, this.autonomyY) : layoutGraph(this.graph, this.collapsedGroups);
    this.incident.clear();
    for (const e of this.graph.edges) {
      if (!this.layout.nodes.has(e.from) || !this.layout.nodes.has(e.to)) continue;
      (this.incident.get(e.from) ?? this.incident.set(e.from, []).get(e.from))?.push(e);
      (this.incident.get(e.to) ?? this.incident.set(e.to, []).get(e.to))?.push(e);
    }
    this.curves = [];
    for (const e of this.graph.edges) {
      const a = this.layout.nodes.get(e.from);
      const c = this.layout.nodes.get(e.to);
      if (!a || !c) continue;
      const q = edgeCurve(a, c);
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      this.curves.push({ edge: e, c: q, box: { x: x0, y: y0, w: Math.max(...xs) - x0 + 1, h: Math.max(...ys) - y0 + 1 } });
    }
    this.renderBands();
    // Keep cards whose content and box did not change (hover / focus survive live updates).
    for (const [id, el] of this.mounted) {
      const n = this.layout.nodes.get(id);
      if (!n || el.dataset.sig !== this.signature(n)) {
        el.remove();
        this.mounted.delete(id);
      }
    }
    if (this.selected && !this.layout.nodes.has(this.selected)) this.inspector.hidden = true;
    const sessions = this.graph.nodes.filter((n) => n.kind === "session").length;
    const subs = this.graph.nodes.filter((n) => n.kind === "subagent").length;
    const live = this.graph.nodes.filter((n) => n.kind === "session" && n.live).length;
    const subsHidden = this.graph.hidden.subagents ?? 0;
    this.countsEl.textContent = `${sessions} sessions (${live} live) · ${subsHidden ? `${subs} of ${subs + subsHidden}` : subs} subagents · ${this.graph.edges.length} links`;
    this.updateHighlight();
    this.renderInspector();
    if (!this.list.hidden) this.renderList();
    this.queue();
  }

  // ------------------------------------------------------------------ rendering

  private renderBands(): void {
    this.bandLayer.replaceChildren();
    this.bandItems = [];
    const add = (el: HTMLElement, x: number, y: number, w: number, hh: number): void => {
      el.hidden = true; // shown by renderFrame when on screen
      this.bandItems.push({ el, box: { x, y, w, h: hh } });
      this.bandLayer.append(el);
    };
    const b = this.layout.bounds;
    if (this.layout.autonomyBands) {
      // Autonomy mode: 5 level bands instead of the graph's lanes, and no Jev/approvals rail
      // (that mode places no "top"-placed node at all — see layoutAutonomy's doc comment).
      for (const band of this.layout.autonomyBands) {
        const head = h("div", "cv-lane-head");
        head.style.transform = `translate(${band.x + 10}px, ${LANE_HEAD_Y}px)`;
        head.style.width = `${band.w - 20}px`;
        const t = h("div", "cv-lane-title", band.title);
        t.append(h("span", "cv-lane-count", band.hidden ? `${band.count} +${band.hidden} hidden` : String(band.count)));
        head.append(t, h("div", "cv-lane-hint", band.hint));
        add(head, band.x + 10, LANE_HEAD_Y, band.w - 20, 56);
      }
    } else {
      this.layout.lanes.forEach((lane) => {
        const head = h("div", "cv-lane-head");
        head.style.transform = `translate(${lane.x + 10}px, ${LANE_HEAD_Y}px)`;
        head.style.width = `${lane.w - 20}px`;
        const t = h("div", "cv-lane-title", `${lane.title}`);
        const c = h("span", "cv-lane-count", lane.hidden ? `${lane.count} +${lane.hidden} hidden` : String(lane.count));
        t.append(c);
        head.append(t, h("div", "cv-lane-hint", lane.hint));
        add(head, lane.x + 10, LANE_HEAD_Y, lane.w - 20, 56);
      });
      const rail = h("div", "cv-rail-label", "Jev + approvals");
      rail.style.transform = `translate(${LANE_W + 24}px, -18px)`;
      add(rail, LANE_W + 24, -18, 220, 18);
    }
    if (this.layout.rails.bottom !== null) {
      const bottom = h("div", "cv-rail-label", "Routines (launchd)");
      bottom.style.transform = `translate(${b.x + 24}px, ${this.layout.rails.bottom - 24}px)`;
      add(bottom, b.x + 24, this.layout.rails.bottom - 24, 220, 18);
    }
    for (const g of this.layout.groups) {
      const head = h("button", `cv-group${g.collapsed ? " cv-collapsed" : ""}${g.live ? " cv-group-live" : ""}`);
      head.type = "button";
      head.style.transform = `translate(${g.x}px, ${g.y}px)`;
      head.style.width = `${g.w}px`;
      head.dataset.group = g.id;
      head.setAttribute("aria-expanded", String(!g.collapsed));
      head.append(h("span", "cv-caret", g.collapsed ? "▸" : "▾"), h("span", "cv-group-name", this.hooks.groupLabel(g.id)), h("span", "cv-group-count", g.live ? `${g.live} live · ${g.count}` : String(g.count)));
      // In Autonomy/district mode the same city id can head a group in several bands at once (a
      // city's sessions can spread across levels), and every band shares this one collapsedGroups
      // set — collapsing here collapses that city everywhere it appears, Graph mode included. The
      // tooltip used to say nothing about that (GRO review finding); only disclose it where it can
      // actually happen.
      const crossBand = this.layout.autonomyBands ? " — collapses this city everywhere it appears" : "";
      head.title = g.collapsed ? `Show this city's sessions${crossBand}` : `Collapse this city${crossBand}`;
      add(head, g.x, g.y, g.w, g.h);
    }
  }

  private signature(n: LaidNode): string {
    return `${n.x}|${n.y}|${n.h}|${n.label}|${n.sub}|${n.status ?? ""}|${n.live}|${Math.floor(n.at / 60_000)}|${this.hooks.canTalk(n.id)}`;
  }

  private cardFor(n: LaidNode, now: number): HTMLElement {
    const el = h("div", `cv-card cv-k-${n.kind}${n.h < CARD_H ? " cv-small" : ""}${n.live ? " cv-live" : ""}${n.status ? ` cv-s-${n.status.replace(/[^a-z_]/gi, "")}` : ""}`);
    el.dataset.id = n.id;
    el.dataset.sig = this.signature(n);
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${KIND_LABEL[n.kind]}: ${n.label}`);
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    el.style.width = `${n.w}px`;
    el.style.height = `${n.h}px`;
    if (n.kind === "hook" || n.kind === "skill" || n.kind === "mcp" || n.kind === "subagent") el.style.setProperty("--cv-stripe", stripeFor(n.kind, n.label));
    const top = h("div", "cv-card-top");
    top.append(h("i", "cv-dot"), h("span", "cv-kind", n.kind === "subagent" && n.status ? `subagent · ${n.status === "async_launched" ? "silent" : n.status}` : n.kind === "session" && n.status === "awaiting" ? "session · waiting for you" : KIND_LABEL[n.kind]), h("span", "cv-age", shortAge(n.at, now)));
    el.append(top, h("div", "cv-label", n.label), h("div", "cv-sub", n.sub));
    if (n.kind === "session" || n.kind === "subagent") {
      const acts = h("div", "cv-actions");
      const add = (act: QuickAction, label: string, title: string, disabled = false): void => {
        const b = h("button", "cv-act", label);
        b.type = "button";
        b.dataset.act = act;
        b.title = title;
        b.disabled = disabled;
        acts.append(b);
      };
      if (n.kind === "session") {
        add("focus", "Focus", "Focus mode on this agent (planet)");
        add("reactivate", "Wake", n.live ? "Already live" : "Reactivate: claude --resume in Terminal", n.live);
        add("editor", "Code", "Open its folder in VS Code");
        if (this.hooks.canTalk(n.id)) add("talk", "Talk", "Type into its tmux session");
        add("room", "Room", "Visit its room on the planet");
        add("solo", "Solo", "Show only this session (Esc returns to everything)");
      } else {
        add("details", "Details", "Open the subagent panel");
        add("parent", "Parent", "Jump to the session that spawned it");
      }
      el.append(acts);
    }
    if (n.id === this.selected) el.classList.add("cv-sel");
    if (this.hovered && n.id !== this.hovered && this.incident.get(this.hovered)?.some((e) => e.from === n.id || e.to === n.id)) el.classList.add("cv-nb");
    return el;
  }

  private queue(): void {
    if (this.frameQueued || !this.open) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    const vw = this.viewport.clientWidth || window.innerWidth;
    const vh = this.viewport.clientHeight || window.innerHeight;
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`;
    this.root.classList.toggle("cv-far", this.view.k < 0.45);
    this.root.classList.toggle("cv-tiny", this.view.k < 0.6); // quick actions would be too small to hit
    // Virtualize: only cards near the viewport exist in the DOM.
    const vis = visibleWorld(this.view, vw, vh, OVERSCAN_PX);
    const now = Date.now();
    const want = new Set<string>();
    const lod = this.view.k < LOD_K;
    this.root.classList.toggle("cv-lod", lod);
    if (!lod) for (const n of this.layout.nodes.values()) if (intersects(n, vis)) want.add(n.id);
    for (const it of this.bandItems) {
      const on = intersects(it.box, vis);
      if (it.el.hidden === on) it.el.hidden = !on;
    }
    for (const [id, el] of this.mounted) {
      if (!want.has(id)) {
        el.remove();
        this.mounted.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    for (const id of want) {
      if (this.mounted.has(id)) continue;
      const n = this.layout.nodes.get(id);
      if (!n) continue;
      const el = this.cardFor(n, now);
      this.mounted.set(id, el);
      frag.append(el);
    }
    this.cardLayer.append(frag);
    this.drawEdges(vw, vh, lod);
    if (this.beads.length) this.drawBeads(performance.now());
    this.drawMinimap(vw, vh);
  }

  /** Sizes a screen canvas to the viewport and applies the view transform. */
  private prep(c: HTMLCanvasElement, vw: number, vh: number): CanvasRenderingContext2D | null {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(vw * dpr);
    const hh = Math.round(vh * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== hh) c.height = hh;
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, hh);
    const k = this.view.k * dpr;
    g.setTransform(k, 0, 0, k, this.view.x * dpr, this.view.y * dpr);
    return g;
  }

  /** Lane stripes + only the edges whose bounding box is on screen. */
  private drawEdges(vw: number, vh: number, lod: boolean): void {
    const g = this.prep(this.edgeCanvas, vw, vh);
    if (!g) return;
    const k = this.view.k;
    const b = this.layout.bounds;
    this.layout.lanes.forEach((lane, i) => {
      g.fillStyle = i % 2 ? "rgba(255, 210, 63, 0.10)" : "rgba(255, 253, 246, 0.6)";
      g.fillRect(lane.x, LANE_HEAD_Y - 8, lane.w, Math.max(200, b.y + b.h - LANE_HEAD_Y + 8));
    });
    const vis = visibleWorld(this.view, vw, vh, 20);
    const focus = this.hovered ?? this.selected;
    const hl = new Set(focus ? (this.incident.get(focus) ?? []) : []);
    const dim = hl.size > 0;
    g.lineCap = "round";
    for (const kind of EDGE_KINDS) {
      const st = EDGE_STYLE[kind];
      g.strokeStyle = st.color;
      g.lineWidth = st.width / k;
      g.setLineDash(st.dash.map((d) => d / k));
      g.globalAlpha = dim ? 0.12 : st.alpha;
      g.beginPath();
      for (const cv of this.curves) {
        if (cv.edge.kind !== kind || hl.has(cv.edge) || !intersects(cv.box, vis)) continue;
        g.moveTo(cv.c[0], cv.c[1]);
        g.bezierCurveTo(cv.c[2], cv.c[3], cv.c[4], cv.c[5], cv.c[6], cv.c[7]);
      }
      g.stroke();
    }
    if (dim) {
      g.globalAlpha = 1;
      for (const cv of this.curves) {
        if (!hl.has(cv.edge)) continue;
        const st = EDGE_STYLE[cv.edge.kind];
        g.strokeStyle = st.color;
        g.lineWidth = (st.width + 1.6) / k;
        g.setLineDash(st.dash.map((d) => d / k));
        g.beginPath();
        g.moveTo(cv.c[0], cv.c[1]);
        g.bezierCurveTo(cv.c[2], cv.c[3], cv.c[4], cv.c[5], cv.c[6], cv.c[7]);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.setLineDash([]);
    if (lod) this.drawBlocks(g, vis, focus, hl);
  }

  /** Zoomed-out cards: a colored block per node (live ones ringed), no text. */
  private drawBlocks(g: CanvasRenderingContext2D, vis: { x: number; y: number; w: number; h: number }, focus: string | null, hl: ReadonlySet<CEdge>): void {
    const k = this.view.k;
    const nb = new Set<string>();
    for (const e of hl) nb.add(e.from === focus ? e.to : e.from);
    g.lineWidth = 2 / k;
    g.strokeStyle = "#1a1030";
    for (const n of this.layout.nodes.values()) {
      if (!intersects(n, vis)) continue;
      g.globalAlpha = focus && n.id !== focus && !nb.has(n.id) ? 0.35 : 1;
      g.fillStyle = stripeFor(n.kind, n.label);
      g.fillRect(n.x, n.y, n.w, n.h);
      g.strokeRect(n.x, n.y, n.w, n.h);
      if (n.live || n.id === this.selected) {
        g.strokeStyle = n.id === this.selected ? "#ff4d8d" : "#ffd23f";
        g.lineWidth = 5 / k;
        g.strokeRect(n.x - 4 / k, n.y - 4 / k, n.w + 8 / k, n.h + 8 / k);
        g.strokeStyle = "#1a1030";
        g.lineWidth = 2 / k;
      }
    }
    g.globalAlpha = 1;
  }

  /** The node under a screen point (block mode has no DOM cards to hit). */
  private nodeAtScreen(sx: number, sy: number): LaidNode | null {
    const r = this.viewport.getBoundingClientRect();
    const wx = (sx - r.left - this.view.x) / this.view.k;
    const wy = (sy - r.top - this.view.y) / this.view.k;
    for (const n of this.layout.nodes.values()) if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n;
    return null;
  }

  private drawBeads(now: number): void {
    const vw = this.viewport.clientWidth || window.innerWidth;
    const vh = this.viewport.clientHeight || window.innerHeight;
    const g = this.prep(this.beadCanvas, vw, vh);
    if (!g) return;
    const r = 6.5 / this.view.k;
    g.lineWidth = 2.5 / this.view.k;
    g.strokeStyle = "#1a1030";
    for (const b of this.beads) {
      const t = Math.min(1, (now - b.t0) / BEAD_MS);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = bezierPoint(b.curve, e);
      b.drawn = true;
      g.fillStyle = STAGE_FILL[b.stage];
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private updateHighlight(): void {
    const focus = this.hovered ?? this.selected;
    this.queue(); // edges are redrawn with the highlight on the next frame
    this.root.classList.toggle("cv-dim", focus !== null && (this.incident.get(focus)?.length ?? 0) > 0);
    const nb = new Set<string>();
    if (focus) for (const e of this.incident.get(focus) ?? []) nb.add(e.from === focus ? e.to : e.from);
    for (const [id, el] of this.mounted) {
      el.classList.toggle("cv-sel", id === this.selected);
      el.classList.toggle("cv-nb", nb.has(id));
    }
  }

  // ------------------------------------------------------------------ selection + inspector

  /** `quiet`: highlight only (the selection carried over from another view); the inspector, the
   *  contextual details panel, opens only for a selection made here. */
  select(id: string | null, opts: { center?: boolean; notify?: boolean; quiet?: boolean } = {}): void {
    this.selected = id;
    this.inspectorWanted = id !== null && opts.quiet !== true;
    this.updateHighlight();
    this.renderInspector();
    const n = id ? this.layout.nodes.get(id) : undefined;
    if (opts.center && n) this.centerOnNode(n.id);
    if (opts.notify !== false) this.hooks.onSelect(n ?? null);
  }

  selectedId(): string | null {
    return this.selected;
  }

  node(id: string): LaidNode | undefined {
    return this.layout.nodes.get(id);
  }

  private renderInspector(): void {
    const n = this.selected ? this.layout.nodes.get(this.selected) : undefined;
    this.inspector.hidden = !this.open || !n || !this.inspectorWanted;
    if (!n) return;
    this.inspector.replaceChildren();
    const head = h("div", "cv-ins-head");
    head.append(h("span", `cv-ins-kind cv-k-${n.kind}`, KIND_LABEL[n.kind]), h("span", "cv-ins-status", n.status ?? ""));
    const close = h("button", "cv-ins-close", "×");
    close.type = "button";
    close.title = "Clear selection (Esc)";
    close.setAttribute("aria-label", "Clear selection");
    close.addEventListener("click", () => this.select(null));
    head.append(close);
    this.inspector.append(head, h("h3", "cv-ins-title", n.label), h("p", "cv-ins-sub", n.sub));
    const edges = this.incident.get(n.id) ?? [];
    const section = (title: string, list: CEdge[], other: (e: CEdge) => string): void => {
      this.inspector.append(h("h4", undefined, `${title} (${list.length})`));
      const ul = h("ul", "cv-ins-list");
      for (const e of list.slice(0, 40)) {
        const nb = this.layout.nodes.get(other(e));
        if (!nb) continue;
        const li = h("li");
        const b = h("button", "cv-ins-row");
        b.type = "button";
        b.append(h("span", `cv-chip cv-chip-${e.kind}`, EDGE_LABEL[e.kind]), h("span", "cv-ins-name", nb.label), h("span", "cv-ins-meta", KIND_LABEL[nb.kind]));
        b.title = `Jump to ${nb.label}`;
        b.addEventListener("click", () => this.select(nb.id, { center: true }));
        li.append(b);
        ul.append(li);
      }
      if (list.length > 40) ul.append(h("li", "cv-ins-more", `+${list.length - 40} more`));
      if (list.length === 0) ul.append(h("li", "cv-ins-more", "none"));
      this.inspector.append(ul);
    };
    section("In", edges.filter((e) => e.to === n.id), (e) => e.from);
    section("Out", edges.filter((e) => e.from === n.id), (e) => e.to);
  }

  // ------------------------------------------------------------------ view ops

  private vsize(): { vw: number; vh: number } {
    return { vw: this.viewport.clientWidth || window.innerWidth, vh: this.viewport.clientHeight || window.innerHeight };
  }

  private setView(v: View): void {
    const { vw, vh } = this.vsize();
    this.view = clampPan(v, this.layout.bounds, vw, vh);
    this.queue();
  }

  fit(): void {
    const { vw, vh } = this.vsize();
    const wide = vw > 900;
    const left = wide ? 380 : 0;
    // Leave room for the docked inspector on wide screens: it overlaps the graph's right edge.
    const right = wide && !this.inspector.hidden ? this.inspector.offsetWidth + 24 : 0;
    const v = fitView(this.layout.bounds, vw - left - right, vh - 40, 30);
    this.setView({ ...v, x: v.x + left });
  }

  /** Solo's first paint: the session card centred, at a zoom where every card keeps its label
   *  (never below SOLO_K, so a busy session does not fit down to coloured blocks). Lanes
   *  further out are a pan away. */
  soloView(id: string): void {
    const n = this.layout.nodes.get(id);
    if (!n) return this.fit();
    const { vw, vh } = this.vsize();
    const right = vw > 900 && !this.inspector.hidden ? this.inspector.offsetWidth + 24 : 0;
    const b = this.layout.bounds;
    const k = Math.min(0.9, Math.max(SOLO_K, fitView(b, vw - right, vh - 40, 30).k));
    const fitsTall = b.h * k <= vh - 80;
    this.setView({ k, x: (vw - right) / 2 - (n.x + n.w / 2) * k, y: fitsTall ? (vh - b.h * k) / 2 - b.y * k : 64 - b.y * k });
  }

  /** Back to a view saved with getView() (leaving solo returns to where you were). */
  restoreView(v: View): void {
    this.setView(v);
  }

  /** A readable start: the top-left of the lanes at ~80%, clear of the HUD column. */
  home(): void {
    const { vw } = this.vsize();
    const b = this.layout.bounds;
    const k = vw > 900 ? 0.8 : 0.62;
    const left = vw > 900 ? 390 : 8;
    this.setView({ k, x: left - b.x * k, y: 16 - b.y * k });
  }

  zoomCenter(factor: number): void {
    const { vw, vh } = this.vsize();
    this.setView(zoomAt(this.view, factor, vw / 2, vh / 2));
  }

  panBy(dx: number, dy: number): void {
    this.setView({ ...this.view, x: this.view.x + dx, y: this.view.y + dy });
  }

  centerOnNode(id: string, k?: number): void {
    const n = this.layout.nodes.get(id);
    if (!n) return;
    const { vw, vh } = this.vsize();
    this.setView(centerOn({ ...this.view, k: k ?? Math.max(this.view.k, 0.7) }, n.x + n.w / 2, n.y + n.h / 2, vw, vh));
  }

  getView(): View {
    return { ...this.view };
  }

  // ------------------------------------------------------------------ beads (live activity)

  /** A bead travels from `from` to `to` (stage-colored); the target card pulses on arrival. */
  bead(from: string, to: string, stage: ActivityStage): boolean {
    const a = this.layout.nodes.get(from);
    const b = this.layout.nodes.get(to);
    if (!a || !b || !this.open) return false;
    this.beads.push({ curve: [...edgeCurve(a, b)], t0: performance.now(), stage, drawn: false });
    while (this.beads.length > MAX_BEADS) this.beads.shift();
    this.pulse(from);
    if (!this.beadLoop) {
      this.beadLoop = true;
      requestAnimationFrame((t) => this.stepBeads(t));
    }
    window.setTimeout(() => this.pulse(to), BEAD_MS);
    return true;
  }

  pulse(id: string): void {
    const el = this.mounted.get(id);
    if (!el) return;
    el.classList.remove("cv-hit");
    void el.offsetWidth; // restart the animation
    el.classList.add("cv-hit");
  }

  private stepBeads(now: number): void {
    this.beads = this.open ? this.beads.filter((b) => !b.drawn || now - b.t0 < BEAD_MS) : [];
    this.drawBeads(now);
    if (this.beads.length) requestAnimationFrame((t) => this.stepBeads(t));
    else this.beadLoop = false;
  }

  // ------------------------------------------------------------------ minimap

  private drawMinimap(vw: number, vh: number): void {
    if (this.minimapBox.hidden || this.minimapBox.classList.contains("aw-collapsed")) return;
    const c = this.minimap;
    const cw = c.clientWidth || 180;
    const ch = c.clientHeight || 120;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(cw * dpr)) c.width = Math.round(cw * dpr);
    if (c.height !== Math.round(ch * dpr)) c.height = Math.round(ch * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    const b = this.layout.bounds;
    const s = Math.min(cw / b.w, ch / b.h);
    const ox = (cw - b.w * s) / 2;
    const oy = (ch - b.h * s) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#fffdf6";
    g.fillRect(0, 0, cw, ch);
    this.layout.lanes.forEach((lane, i) => {
      if (i % 2) {
        g.fillStyle = "#f6edd6";
        g.fillRect(ox + (lane.x - b.x) * s, 0, lane.w * s, ch);
      }
    });
    for (const n of this.layout.nodes.values()) {
      g.fillStyle = n.live ? "#ffb400" : n.kind === "subagent" ? "#8a6cf0" : n.kind === "session" ? "#ff4d8d" : "#6b5f86";
      g.fillRect(ox + (n.x - b.x) * s, oy + (n.y - b.y) * s, Math.max(2, n.w * s), Math.max(1.5, n.h * s));
    }
    const vis = visibleWorld(this.view, vw, vh);
    g.strokeStyle = "#1a1030";
    g.lineWidth = 2;
    g.strokeRect(ox + (vis.x - b.x) * s, oy + (vis.y - b.y) * s, vis.w * s, vis.h * s);
  }

  private minimapJump(clientX: number, clientY: number): void {
    const r = this.minimap.getBoundingClientRect();
    const b = this.layout.bounds;
    const s = Math.min(r.width / b.w, r.height / b.h);
    const ox = (r.width - b.w * s) / 2;
    const oy = (r.height - b.h * s) / 2;
    const wx = (clientX - r.left - ox) / s + b.x;
    const wy = (clientY - r.top - oy) / s + b.y;
    const { vw, vh } = this.vsize();
    this.setView(centerOn(this.view, wx, wy, vw, vh));
  }

  // ------------------------------------------------------------------ list fallback (phones)

  private toggleList(): void {
    this.list.hidden = !this.list.hidden;
    this.minimapBox.hidden = !this.list.hidden || !this.open; // would float over the full-screen sheet
    if (!this.list.hidden) this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const head = h("div", "cv-list-head");
    const back = h("button", "cv-btn cv-primary", "← Back to the graph");
    back.type = "button";
    back.addEventListener("click", () => this.toggleList());
    head.append(h("b", undefined, this.layout.autonomyBands ? "Every card, by autonomy level" : "Every card, by lane"), back);
    this.list.append(head);
    // listGroups mirrors whichever grouping is actually on screen (autonomy bands vs. graph
    // lanes) instead of always falling back to lanes — see its doc comment.
    for (const grp of listGroups(this.layout)) {
      const nodes = grp.nodes;
      const sec = h("section", "cv-list-sec");
      sec.append(h("h4", undefined, `${grp.title} (${nodes.length})`));
      const ul = h("ul");
      for (const n of nodes) {
        const b = h("button", `cv-list-row${n.live ? " cv-live" : ""}`);
        b.type = "button";
        b.append(h("i", `cv-dot cv-k-${n.kind}`), h("span", "cv-ins-name", n.label), h("span", "cv-ins-meta", n.sub));
        b.addEventListener("click", () => {
          this.toggleList();
          this.select(n.id, { center: true });
        });
        const li = h("li");
        li.append(b);
        ul.append(li);
      }
      sec.append(ul);
      this.list.append(sec);
    }
  }

  // ------------------------------------------------------------------ input

  private cardAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(".cv-card") : null;
  }

  private wire(): void {
    const vp = this.viewport;
    vp.addEventListener("pointerdown", (ev) => {
      if (ev.target instanceof Element && ev.target.closest("button")) return;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      vp.setPointerCapture(ev.pointerId);
      if (this.pointers.size === 1) this.drag = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      if (this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        if (p1 && p2) this.pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), k: this.view.k };
        this.drag = null;
      }
    });
    vp.addEventListener("pointermove", (ev) => {
      if (!this.pointers.has(ev.pointerId)) {
        const card = this.cardAt(ev.target);
        const id = card?.dataset.id ?? null;
        if (id !== this.hovered) {
          this.hovered = id;
          this.updateHighlight();
        }
        return;
      }
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        if (!p1 || !p2) return;
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        const r = vp.getBoundingClientRect();
        const mx = (p1.x + p2.x) / 2 - r.left;
        const my = (p1.y + p2.y) / 2 - r.top;
        this.setView(zoomAt(this.view, (this.pinch.k * (d / Math.max(1, this.pinch.d))) / this.view.k, mx, my));
        return;
      }
      if (this.drag) {
        const dx = ev.clientX - this.drag.x;
        const dy = ev.clientY - this.drag.y;
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          vp.classList.add("cv-panning");
          this.setView({ ...this.view, x: this.drag.vx + dx, y: this.drag.vy + dy });
        }
      }
    });
    const end = (ev: PointerEvent): void => {
      const wasDrag = this.drag?.moved ?? false;
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        vp.classList.remove("cv-panning");
        // Pointer capture retargets pointerup to the viewport: hit-test the real element.
        if (!wasDrag && ev.type === "pointerup") {
          const block = this.view.k < LOD_K ? this.nodeAtScreen(ev.clientX, ev.clientY) : null;
          if (block) this.select(block.id);
          else this.clickAt(document.elementFromPoint(ev.clientX, ev.clientY));
        }
        this.drag = null;
      }
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("pointerleave", () => {
      if (this.hovered && this.pointers.size === 0) {
        this.hovered = null;
        this.updateHighlight();
      }
    });
    vp.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const r = vp.getBoundingClientRect();
        this.setView(zoomAt(this.view, wheelFactor(ev.deltaY, ev.deltaMode, ev.ctrlKey), ev.clientX - r.left, ev.clientY - r.top));
      },
      { passive: false },
    );
    // Quick-action buttons and group headers are real buttons: handle them on click.
    vp.addEventListener("click", (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      const act = t?.closest<HTMLButtonElement>("button.cv-act");
      if (act) {
        const id = this.cardAt(act)?.dataset.id;
        const n = id ? this.layout.nodes.get(id) : undefined;
        if (n && act.dataset.act) {
          this.select(n.id, { notify: false }); // the inspector follows the card you acted on
          this.hooks.onAction(act.dataset.act as QuickAction, n);
        }
        return;
      }
      const grp = t?.closest<HTMLButtonElement>("button.cv-group");
      if (grp?.dataset.group) this.toggleGroup(grp.dataset.group);
    });
    vp.addEventListener("keydown", (ev) => {
      const card = this.cardAt(ev.target);
      if (card && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        if (card.dataset.id) this.select(card.dataset.id);
      }
    });
    let mmDown = false;
    this.minimap.addEventListener("pointerdown", (ev) => {
      mmDown = true;
      this.minimap.setPointerCapture(ev.pointerId);
      this.minimapJump(ev.clientX, ev.clientY);
    });
    this.minimap.addEventListener("pointermove", (ev) => {
      if (mmDown) this.minimapJump(ev.clientX, ev.clientY);
    });
    this.minimap.addEventListener("pointerup", () => {
      mmDown = false;
    });
    window.addEventListener("resize", () => this.queue());
    // overflow:hidden boxes still scroll when a focused / scrolled-to card is off-screen:
    // undo that and pan the view to the card instead.
    for (const el of [this.root, vp]) {
      el.addEventListener("scroll", () => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      });
    }
    vp.addEventListener("focusin", (ev) => {
      const id = this.cardAt(ev.target)?.dataset.id;
      const n = id ? this.layout.nodes.get(id) : undefined;
      if (!n) return;
      const { vw, vh } = this.vsize();
      const sx = n.x * this.view.k + this.view.x;
      const sy = n.y * this.view.k + this.view.y;
      if (sx < 0 || sy < 0 || sx + n.w * this.view.k > vw || sy + n.h * this.view.k > vh) this.centerOnNode(n.id, this.view.k);
    });
  }

  private clickAt(target: EventTarget | null): void {
    if (target instanceof Element && target.closest("button")) return;
    const card = this.cardAt(target);
    if (card?.dataset.id) this.select(card.dataset.id);
    else if (this.selected) this.select(null);
  }

  private toggleGroup(id: string): void {
    if (this.collapsedGroups.has(id)) this.collapsedGroups.delete(id);
    else this.collapsedGroups.add(id);
    try {
      localStorage.setItem("agent-world.canvas.collapsed", JSON.stringify([...this.collapsedGroups]));
    } catch {
      /* private mode */
    }
    this.relayout();
  }
}
