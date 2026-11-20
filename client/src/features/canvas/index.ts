// "canvas" client feature (round 5 G1c): V toggles Planet | Canvas. The canvas is the real
// orchestration graph in lanes (Prompt → Hook → Brain → Plan/Skill → Reason → Tools & MCPs →
// Subagents → Files/Repos, Jev + approvals on top, routines below), with beads traveling
// along edges for each real activity event. Selection is shared with the planet: clicking a
// session selects it there too (same side panel), and opening the canvas picks up whatever
// the planet had selected.

import { subagentNodeId, SUBAGENT_NODE_PREFIX } from "../../../../shared/features/subagents";
import type { AgentActivity } from "../../../../shared/types";
import { agentTitle } from "../../../../shared/display";
import { cityDisplayName } from "../../ui/world";
import { isRecord } from "../fleet-overlay";
import type { ClientContext, ClientFeature } from "../registry";
import { subagentData } from "../subagent-data";
import { openSubagent } from "../subagents";
import { CanvasView, type FilterChange, type QuickAction } from "./canvas";
import { activityTarget, buildGraph, type ApprovalLite, type Lane, type RoutineLite } from "./graph";
import type { View } from "./view";
import { redactOn } from "../../redact";
import { artifactLabel } from "../artifacts-lib";
import type { LaidNode } from "./layout";
import type { ArtifactItem, ArtifactsResponse } from "../../../../shared/features/artifacts";
import type { AtlasResponse } from "../../../../shared/features/atlas";
import { parseRouteCardSummary, ROUTER_CARDS_KEY, type RouteCardSummary } from "../../../../shared/features/router";
import { readStoredSolo, SoloBar, writeStoredSolo } from "./solo";
import { launchNeedsYou, launchSuccessText } from "../../ui/launch-result";
import "./canvas.css";

const REBUILD_MS = 700;
const APPROVALS_POLL_MS = 5_000;
const MAX_BEADS_PER_BATCH = 24;

let cv: CanvasView | null = null;
const filter: { scope: "today" | "all"; city: boolean; tree: boolean } = { scope: "today", city: false, tree: false };
/** The shared selection: the session the planet (or the canvas) last selected. */
let anchor: string | null = null;
let approvals: ApprovalLite[] = [];
let routeCards: RouteCardSummary | null = null;
let routines: RoutineLite[] = [];
const talkBound = new Set<string>();
/** Solo: the one session the canvas shows (null = Everything). Deep link #/canvas?session=<id>. */
let solo: string | null = null;
let pendingSolo: string | null = null;
let soloBar: SoloBar | null = null;
/** Lanes opened past SOLO_CAP by clicking their "+N more" card (reset when the session changes). */
const soloExpand = new Set<Lane>();
/** Where the user was before soloing, so leaving solo puts them back there. */
let preSoloView: View | null = null;
let artifacts: ArtifactItem[] = [];
let atlas: { departments: AtlasResponse["departments"]; leaves: AtlasResponse["leaves"] } | undefined;
let extrasTimer: ReturnType<typeof setInterval> | null = null;
const EXTRAS_POLL_MS = 30_000;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let loadingAll = false;

function parseApprovals(v: unknown): ApprovalLite[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovalLite[] = [];
  for (const a of v) {
    if (!isRecord(a) || typeof a.id !== "string" || typeof a.agentId !== "string" || typeof a.toolName !== "string") continue;
    const title = isRecord(a.preview) && typeof a.preview.title === "string" ? a.preview.title : "";
    out.push({ id: a.id, agentId: a.agentId, toolName: a.toolName, title });
  }
  return out;
}

function parseRoutines(v: unknown): RoutineLite[] {
  if (!isRecord(v) || !Array.isArray(v.routines)) return [];
  const out: RoutineLite[] = [];
  for (const r of v.routines) {
    if (!isRecord(r) || typeof r.label !== "string" || typeof r.shortName !== "string") continue;
    out.push({ label: r.label, shortName: r.shortName, running: r.running === true, lastExitStatus: typeof r.lastExitStatus === "number" ? r.lastExitStatus : null });
  }
  return out;
}

function panelAgentId(): string | null {
  const panel = document.getElementById("panel");
  const content = document.getElementById("panel-content");
  return panel && !panel.hidden ? (content?.dataset.agentId ?? null) : null;
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}

function overlayOpen(): boolean {
  if (document.body.classList.contains("in-room")) return true;
  const palette = document.getElementById("palette");
  if (palette && !palette.hidden) return true;
  return [...document.querySelectorAll<HTMLElement>(".ui-backdrop")].some((el) => !el.hidden);
}

function rebuild(ctx: ClientContext): void {
  if (!cv) return;
  let refit = false;
  if (pendingSolo && ctx.store.agents.has(pendingSolo)) {
    const id = pendingSolo;
    pendingSolo = null;
    solo = id;
    anchor = id;
    soloExpand.clear();
    writeStoredSolo(id);
    void subagentData.loadParent(ctx.api, id);
    refit = true;
  }
  const agent = anchor ? ctx.store.agents.get(anchor) : undefined;
  if (filter.scope === "all" && !subagentData.loadedAll && !loadingAll) {
    loadingAll = true;
    void subagentData.loadAll(ctx.api).finally(() => {
      loadingAll = false;
    });
  }
  const g = buildGraph(
    {
      agents: [...ctx.store.agents.values()],
      objects: ctx.store.objects,
      edges: ctx.store.edges,
      islands: ctx.store.islands,
      subagents: [...subagentData.records.values()],
      decisions: ctx.store.jev.decisions,
      jevStatus: ctx.store.jev.status,
      routeCards,
      approvals,
      routines,
      artifacts,
      atlas,
    },
    {
      solo,
      expand: soloExpand,
      scope: filter.scope,
      city: filter.city && agent ? agent.islandId : null,
      tree: filter.tree && agent ? agent.id : null,
      keep: anchor,
      nowMs: Date.now(),
    },
  );
  cv.setGraph(g);
  if (refit && solo) cv.soloView(solo);
  soloBar?.set(solo, solo ? (agent0(ctx) ?? solo) : null);
}

function agent0(ctx: ClientContext): string | null {
  const a = solo ? ctx.store.agents.get(solo) : undefined;
  return a ? agentTitle(a) : null;
}

/** Everything ↔ One session. Called by the bar, the card's Solo button, Esc and the route
 *  (#/canvas/<id> or #/canvas?session=<id>). Idempotent, so the route echo is harmless. */
export function canvasSolo(ctx: ClientContext, id: string | null, opts: { route?: boolean } = {}): void {
  const next = id && ctx.store.agents.has(id) ? id : null;
  if (id && !next) {
    pendingSolo = id; // a cold deep link: the world snapshot may not have arrived yet
    return;
  }
  pendingSolo = null;
  if (next === solo) return;
  if (!solo && next && cv) preSoloView = cv.getView();
  solo = next;
  soloExpand.clear();
  writeStoredSolo(solo);
  if (solo) {
    anchor = solo;
    void subagentData.loadParent(ctx.api, solo);
    filter.city = false;
    filter.tree = false;
  }
  rebuild(ctx);
  if (solo) cv?.soloView(solo);
  else if (preSoloView) cv?.restoreView(preSoloView);
  else cv?.fit();
  if (!solo) preSoloView = null;
  if (cv) {
    cv.root.classList.add("cv-soloing");
    setTimeout(() => cv?.root.classList.remove("cv-soloing"), 400);
  }
  if (opts.route !== false) ctx.showView("canvas", solo);
}

export function canvasSoloId(): string | null {
  return solo;
}

/** The sidebar's "One session" chip: solo the selected session (false = nothing selected). */
export function canvasSoloSelected(ctx: ClientContext): boolean {
  if (!anchor || !ctx.store.agents.has(anchor)) {
    ctx.toast("Select a session first (click a card), or pick one with “One session” above the canvas.");
    return false;
  }
  canvasSolo(ctx, anchor);
  return true;
}

/** First open: the route's session wins, else the one remembered in this browser. */
export function restoreSolo(ctx: ClientContext, routeId: string | null): void {
  const id = routeId ?? readStoredSolo();
  if (id && ctx.store.agents.has(id)) canvasSolo(ctx, id, { route: false });
  else if (routeId) pendingSolo = routeId;
}

async function loadExtras(ctx: ClientContext): Promise<void> {
  const [a, t] = await Promise.all([ctx.api.getJson<ArtifactsResponse>("/api/artifacts", 15_000), ctx.api.getJson<AtlasResponse>("/api/atlas", 15_000)]);
  // ?redact=1: an artifact card never shows its title (same rule as the Artifacts boards).
  const items = isRecord(a) && a.ok === true && Array.isArray(a.items) ? (a.items as ArtifactItem[]) : null;
  const nextArts = items ? (redactOn() ? items.map((it) => ({ ...it, title: artifactLabel(it, true) })) : items) : artifacts;
  const nextAtlas = isRecord(t) && t.ok === true && Array.isArray(t.departments) && Array.isArray(t.leaves) ? { departments: t.departments, leaves: t.leaves } : atlas;
  if (nextArts !== artifacts || nextAtlas !== atlas) {
    artifacts = nextArts;
    atlas = nextAtlas;
    markDirty(ctx);
  }
}

function markDirty(ctx: ClientContext): void {
  if (!cv?.isOpen() || rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild(ctx);
  }, REBUILD_MS);
}

async function pollApprovals(ctx: ClientContext): Promise<void> {
  const res = await ctx.api.getJson<unknown>("/api/approvals", 4_000);
  if (!isRecord(res)) return;
  const next = parseApprovals(res.pending);
  if (JSON.stringify(next) !== JSON.stringify(approvals)) {
    approvals = next;
    markDirty(ctx);
  }
}

export function canvasOpen(): boolean {
  return cv?.isOpen() ?? false;
}

/** The Canvas view (views/canvas.ts) opens / closes the canvas on mount / unmount. */
export function setCanvasOpen(ctx: ClientContext, on: boolean): void {
  setOpen(ctx, on);
}

function setOpen(ctx: ClientContext, on: boolean): void {
  if (!cv || cv.isOpen() === on) return;
  if (on) {
    const fromPanel = panelAgentId();
    if (fromPanel) anchor = fromPanel;
    if (anchor) void subagentData.loadParent(ctx.api, anchor);
    rebuild(ctx);
    if (anchor) cv.select(anchor, { notify: false, quiet: true });
    cv.setOpen(true);
    pollTimer = setInterval(() => void pollApprovals(ctx), APPROVALS_POLL_MS);
    void pollApprovals(ctx);
    extrasTimer = setInterval(() => void loadExtras(ctx), EXTRAS_POLL_MS);
    void loadExtras(ctx);
  } else {
    cv.setOpen(false);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (extrasTimer) clearInterval(extrasTimer);
    extrasTimer = null;
  }
}

function sessionIdOf(node: LaidNode): string | null {
  return node.kind === "session" ? node.id : null;
}

function runAction(ctx: ClientContext, action: QuickAction, node: LaidNode): void {
  const id = sessionIdOf(node);
  const subId = node.kind === "subagent" ? node.id.slice(SUBAGENT_NODE_PREFIX.length) : null;
  switch (action) {
    case "room":
      if (id) ctx.showView("room", id);
      return;
    case "focus":
      if (!id) return;
      ctx.showView("orbit");
      ctx.flyTo(id);
      // E's focus mode via the panel's Focus button, when present; otherwise the agent just stays selected.
      document.getElementById("focus-btn")?.click();
      return;
    case "reactivate":
      if (!id) return;
      void ctx.api.reactivate(id).then((r) => ctx.toast(r.ok ? launchSuccessText(r, "Resumed", false) : `Reactivate failed: ${r.error ?? "unknown error"}`, r.ok && !launchNeedsYou(r) ? "info" : "error"));
      return;
    case "editor":
      if (!id) return;
      void ctx.api.openEditor(id).then((r) => ctx.toast(r.ok ? "Opened in VS Code." : `VS Code failed: ${r.error ?? "unknown error"}`, r.ok ? "info" : "error"));
      return;
    case "talk":
      if (!id) return;
      ctx.flyTo(id);
      document.querySelector<HTMLElement>("#panel-content .fx-talk")?.scrollIntoView({ block: "nearest" });
      return;
    case "details":
      if (subId) openSubagent(ctx, subId);
      return;
    case "solo":
      if (id) canvasSolo(ctx, id);
      return;
    case "parent": {
      const rec = subId ? subagentData.records.get(subId) : undefined;
      if (!rec || !cv) return;
      const parentNode = rec.parentAgentId ? subagentNodeId(rec.parentAgentId) : rec.parentSessionId;
      if (cv.node(parentNode)) cv.select(parentNode, { center: true });
      else ctx.flyTo(rec.parentSessionId);
      return;
    }
  }
}

/** The Canvas view's left-sidebar filters land here too. */
export function canvasFilter(ctx: ClientContext, change: FilterChange): void {
  onFilter(ctx, change);
}

/** Current canvas filter (the Canvas view mirrors it in the left sidebar). */
export function canvasFilterState(): { scope: "today" | "all"; city: boolean; tree: boolean } {
  return { ...filter };
}

/** Sidebar "View" section: stats + zoom/fit/list/planet actions (views/canvas.ts's filters()). */
export function mountCanvasViewSection(host: HTMLElement): void {
  cv?.mountViewSection(host);
}

/** Sidebar "Legend" section, folded by default (views/canvas.ts's filters()). */
export function mountCanvasLegendSection(host: HTMLElement): void {
  cv?.mountLegendSection(host);
}

function onFilter(ctx: ClientContext, change: FilterChange): void {
  if ("scope" in change) filter.scope = change.scope;
  if ("city" in change) filter.city = change.city;
  if ("tree" in change) filter.tree = change.tree;
  if ((filter.city || filter.tree) && !anchor) {
    ctx.toast("Select a session first (click a card), then narrow to its city or tree.");
    filter.city = false;
    filter.tree = false;
  }
  if (filter.tree && anchor) void subagentData.loadParent(ctx.api, anchor);
  rebuild(ctx);
  if (filter.tree || filter.city) cv?.fit();
}

function hookIds(ctx: ClientContext): string[] {
  return [...ctx.store.objects.values()].filter((o) => o.kind === "hook").map((o) => o.id).sort();
}

function beadsForActivity(ctx: ClientContext, list: AgentActivity[]): void {
  if (!cv?.isOpen()) return;
  const hooks = hookIds(ctx);
  const has = { has: (id: string) => cv?.node(id) !== undefined };
  for (const a of list.slice(-MAX_BEADS_PER_BATCH)) {
    const model = ctx.store.agents.get(a.agentId)?.model ?? null;
    const target = activityTarget(has, a.stage, a.targetObjectId, model, hooks);
    if (target) cv.bead(a.agentId, target, a.stage);
    else cv.pulse(a.agentId);
  }
}

export const canvasFeature: ClientFeature = {
  id: "canvas",
  mount(ctx) {
    cv = new CanvasView({
      onSelect(node) {
        if (!node) return;
        if (node.kind === "session") {
          anchor = node.id;
          ctx.flyTo(node.id); // same selection + side panel as the planet
          if (filter.city || filter.tree) rebuild(ctx);
        } else if (node.kind === "subagent") {
          openSubagent(ctx, node.id.slice(SUBAGENT_NODE_PREFIX.length));
        } else if (node.kind === "more" && solo && node.place !== "top" && node.place !== "bottom") {
          soloExpand.add(node.place); // solo: "+N more" opens the lane
          cv?.select(null, { notify: false });
          rebuild(ctx);
        }
      },
      onAction: (action, node) => runAction(ctx, action, node),
      canTalk: (id) => talkBound.has(id),
      groupLabel(id) {
        const island = ctx.store.islands.get(id);
        return island ? cityDisplayName(island) : id || "no city";
      },
      onClose: () => ctx.showView("orbit"),
    });

    soloBar = new SoloBar({
      onChange: (id) => canvasSolo(ctx, id),
      agents: () => ctx.store.agents.values(),
      suggest: () => (anchor && ctx.store.agents.has(anchor) ? anchor : null),
    });
    cv.root.append(soloBar.el);

    window.addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target) || overlayOpen()) return;
      const k = ev.key;
      // V / 5 and the view keys belong to the shell (docs/VIEWS.md); only the canvas's own keys here.
      if (!canvasOpen() || !cv) return;
      if (k === "0") cv.fit();
      else if (k === "+" || k === "=") cv.zoomCenter(1.25);
      else if (k === "-" || k === "_") cv.zoomCenter(0.8);
      else if (k === "ArrowLeft") cv.panBy(80, 0);
      else if (k === "ArrowRight") cv.panBy(-80, 0);
      else if (k === "ArrowUp") cv.panBy(0, 80);
      else if (k === "ArrowDown") cv.panBy(0, -80);
      else return;
      ev.preventDefault();
    });

    // Planet → canvas selection sync: whatever agent the side panel shows is the selection.
    const content = document.getElementById("panel-content");
    if (content) {
      new MutationObserver(() => {
        const id = content.dataset.agentId;
        if (!id || id === anchor) return;
        anchor = id;
        if (cv?.isOpen()) {
          if (filter.city || filter.tree || !cv.node(id)) rebuild(ctx);
          cv.select(id, { center: true, notify: false });
        }
      }).observe(content, { attributes: true, attributeFilter: ["data-agent-id"] });
    }

    const dirtyFn = (): void => markDirty(ctx);
    ctx.store.onAgents(dirtyFn);
    ctx.store.onEdges(dirtyFn);
    ctx.store.onObjects(dirtyFn);
    ctx.store.onDecision(dirtyFn);
    ctx.store.onSnapshot(dirtyFn);
    subagentData.onChange(dirtyFn);
    ctx.store.onActivity((fresh) => beadsForActivity(ctx, fresh));
    subagentData.onActivity((items) => {
      if (!cv?.isOpen()) return;
      const hooks = hookIds(ctx);
      const has = { has: (id: string) => cv?.node(id) !== undefined };
      for (const it of items.slice(-MAX_BEADS_PER_BATCH)) {
        const src = subagentNodeId(it.subagentId);
        const rec = subagentData.records.get(it.subagentId);
        const target = activityTarget(has, it.stage, it.targetObjectId, rec?.model ?? null, hooks);
        if (target) cv.bead(src, target, it.stage);
        else cv.bead(rec?.parentAgentId ? subagentNodeId(rec.parentAgentId) : it.parentSessionId, src, it.stage);
      }
    });

    const params = new URLSearchParams(location.search);
    if (params.get("canvas") === "1") {
      if (params.get("scope") === "all") filter.scope = "all";
      const sel = params.get("select");
      if (sel) anchor = sel;
      if (params.get("tree") === "1" && sel) pendingSolo = sel; // the old "tree" link is solo now
      const one = params.get("session");
      if (one) anchor = one;
    }
  },
  onSnapshot(world, ctx) {
    const extras = world.extras ?? {};
    approvals = parseApprovals(extras["approvals.pending"]);
    routines = parseRoutines(extras["routines.state"]);
    routeCards = parseRouteCardSummary(extras[ROUTER_CARDS_KEY]);
    talkBound.clear();
    const bindings = extras["talk.bindings"];
    if (Array.isArray(bindings)) for (const b of bindings) if (isRecord(b) && typeof b.agentId === "string") talkBound.add(b.agentId);
    markDirty(ctx);
  },
  onEscape(ctx) {
    if (!cv?.isOpen()) return false;
    if (soloBar?.isPicking()) {
      soloBar.closePicker();
      return true;
    }
    if (cv.selectedId()) {
      cv.select(null, { notify: false });
      return true;
    }
    if (solo) {
      canvasSolo(ctx, null);
      return true;
    }
    return false; // the shell goes back to the previous view
  },
  paletteCommands: (ctx) => [
    { id: "toggle", title: canvasOpen() ? "Back to the planet" : "Open the canvas (orchestration graph)", keywords: ["canvas", "graph", "lanes", "orchestration", "subagents", "V"], run: () => ctx.showView(canvasOpen() ? "orbit" : "canvas") },
    { id: "all", title: "Canvas: show all time", keywords: ["canvas", "history"], run: () => (ctx.showView("canvas"), onFilter(ctx, { scope: "all" })) },
  ],
};
