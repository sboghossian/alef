// 🚪 Room (v2): step inside one agent. A polished 3D toon room (views/room-3d.ts) drawn with the
// shared renderer and the planet's ink + halftone pass:
//   - the agent's model creature on its stool, animated by its state (typing, hopping, shaking,
//     breathing, curled up asleep), with a speech bubble when it needs you;
//   - a wall-wide BAY WINDOW showing the live orbit: the shared planet scene rendered at low
//     res from above the agent's house, looking out at the horizon and the sky;
//   - the BOARD = its live todos as sticky notes; the SHELF = what the session wrote / linked
//     (B's shelf API), click a jar / frame / book to preview it in-app (sandboxed iframe);
//   - the SCREEN = its live session: click it for a real terminal on world-launched (tmux)
//     agents (W2's ui/terminal.ts over B's /ws/term), else read-only activity + Resume here
//     (never for an agent live in another terminal: that would start a second copy);
//   - a plant that grows with the session's tokens, a clock with its uptime, a lamp lit by its
//     state, drones = running subagents (click one to show it on the screen).
// DOM on top: the agent picker, the action dock (Focus, VS Code, Code, Activate / Stop, a note),
// accessible Todos / Shelf lists, overlays, and #/room/all = a multi-room grid, several live
// agents' rooms side by side (round 11: merged in from the old Control room view — see
// room-grid.ts; the "Max view" sidebar fold and #/control-room both live on there now).
// Only active agents by default; the sidebar's state filter shows dormant ones.

import { agentTitle, displayIslandName } from "../../../shared/display";
import type { AgentState } from "../../../shared/features/agent-state";
import { CONTROL_NOT_TMUX_ERROR, type ControlResult } from "../../../shared/features/control";
import type { ShelfFile } from "../../../shared/features/shelf";
import type { SubagentActivity, SubagentRecord } from "../../../shared/features/subagents";
import { TALK_MAX_CHARS } from "../../../shared/features/talk";
import { todoProgress } from "../../../shared/features/todos";
import type { WorldAgent } from "../../../shared/types";
import { STATE_LABELS, agentStateOf, onAgentStates } from "../features/agent-state";
import { h } from "../features/fleet-overlay";
import { formatCount, shortModel, subagentData } from "../features/subagent-data";
import { RUNNING_ELSEWHERE_TEXT, resumeStartedText } from "../features/resume-guard";
import { onTalkChange, resumeInTmux, resumeOfferFor, talkInfo } from "../features/talk";
import { onTodosChange, todoListElement, todoListFor } from "../features/todos";
import { log } from "../log";
import { redactOn } from "../redact";
import { sceneParts } from "../scene/scene-bus";
import type { AlefView, FilterSpec, FilterState, Selection, ViewContext } from "../shell/views";
import { relativeTime } from "../ui/fuzzy";
import { prefersReducedMotion } from "../ui/kit";
import { createTerminal, type TerminalHandle } from "../ui/terminal";
import { openRoomChat } from "../features/chat/chat";
import { villageData } from "../features/village-data";
import { workspaceData } from "../features/workspace-data";
import { URGENCY_EMOJI, URGENCY_LABEL, WORKSPACE, type WorkspaceEntry } from "../features/workspace-lib";
import { createRoom3D, type Room3D, type Room3DHit, type Room3DShelfItem } from "./room-3d";
import { roomActivate, roomInterrupt, roomOpenEditor, type RoomActionDeps } from "./room-actions";
import { createVillage3D, type Village3D, type Village3DHit, type Village3DResidentData, type Village3DRoomData } from "./village-3d";
import { feedItems, messageBridges, repoBridges, villageAgents, type SubagentSpawnFact } from "./village-lib";
import {
  NOTE_MAX,
  PLANT_NAMES,
  clockHands,
  lampMood,
  matchesFilter,
  modelKey,
  noteError,
  orderAgents,
  pickAgent,
  plantStage,
  roomBucket,
  roomFilterFrom,
  shortCwd,
  stepAgent,
  stickyNotes,
  uptime,
  eventPassedThrough,
  type AgentFacts,
  type RoomFilter,
} from "./room-lib";
import { buildActionsBar, closeAllGridTalk, enterGridMode, exitGridMode, gridFilterSpecs, gridHasOpenTalk, pinnedIds, renderGrid as renderGridTiles, talkForm, talkOpen } from "./room-grid";
import { baseName, loadShelf, previewUrl, renderShelf, safeHttpUrl, type ShelfResult } from "./room-shelf";
import "./room.css";

const GRID = "all";
const SHELF_REFRESH_MS = 20_000;
const TICK_MS = 30_000;
const MAX_SUB_TABS = 2;
const SCREEN_LINES = 6;

// ---------------------------------------------------------------- module state (one Room at a time)

let ctx: ViewContext | null = null;
let rootEl: HTMLElement | null = null;
let filter: RoomFilter = roomFilterFrom({});
let param: string | null = null;
let agentId: string | null = null;
let screenTab: string | null = null; // null = the session itself, else a subagent id
let term: TerminalHandle | null = null;
let overlayKind: "screen" | "preview" | "board" | "shelf" | null = null;
let tick = 0;
let shelfAt = 0;
let shelfFor: string | null = null;
let shelfRes: ShelfResult | null = null;
let shelfActions: { label: string; run(): void }[] = [];
let stopHold: number | null = null;
/** Whether #/room/all (the multi-room grid) was showing last render, so entering/leaving it can
 *  fold/restore the sidebars ("Max view") exactly once, at the transition. */
let wasGridMode = false;
let room3d: Room3D | null = null;
let village3d: Village3D | null = null;
/** #/room/all has two sub-views: the 3D diorama (default) and the flat 2D list it grew out of
 *  (round 11's room-grid.ts), kept as a one-click fallback with 100% of the old tile actions. */
// All agents: Village (3D diorama) or Grid (flat tiles). The choice is remembered per browser.
const SUBMODE_KEY = "alef.room.allMode";
function loadSubmode(): "diorama" | "list" {
  try {
    return localStorage.getItem(SUBMODE_KEY) === "list" ? "list" : "diorama";
  } catch {
    return "diorama";
  }
}
function setSubmode(m: "diorama" | "list"): void {
  gridSubmode = m;
  try {
    localStorage.setItem(SUBMODE_KEY, m);
  } catch {
    // private window / blocked storage: the switch still works for this page
  }
}
let gridSubmode: "diorama" | "list" = loadSubmode();
/** The diorama's own selection (an agent id, "resident", or none) — independent of `c.selection`
 *  so hovering/selecting a room never navigates away; only its dock's "Open room" does that. */
let villageSelected: string | null = null;
/** The Town square panel shows the global workspace's top 5, or (one click) its chronological log. */
let townSquareTab: "top" | "log" = "top";
/** Rooms on stage at the last village render (the log is scoped to them; the top 5 is global). */
let townSquareShown: ReadonlySet<string> = new Set();
/** What the Town square panel last drew: the village re-renders on every store change, and
 *  rebuilding an unchanged panel would reset its scroll and steal focus from its buttons. */
let townSquareSig = "";
let villageDragging = false;
let villageDragFrom: { x: number; y: number } | null = null;
let stageObs: ResizeObserver | null = null;
/** True during mount's synchronous tail: the shell replays onFilter / onSelect right after mount,
 *  and that replayed selection must not override the route's agent. */
let settling = false;
const unsubs: (() => void)[] = [];
const subLines = new Map<string, SubagentActivity[]>();

// Store / subagent listeners have no "off": register them once and route to the live view.
let storeHooked = false;
function hookStoreOnce(c: ViewContext): void {
  if (storeHooked) return;
  storeHooked = true;
  c.store.onAgents(() => scheduleRender());
  c.store.onSnapshot(() => scheduleRender());
  c.store.onActivity((fresh) => {
    if (!ctx) return;
    if (agentId && fresh.some((a) => a.agentId === agentId)) {
      pushRoomData();
      if (Date.now() - shelfAt > SHELF_REFRESH_MS) void refreshShelf(true);
    }
  });
  subagentData.onChange(() => scheduleRender());
  villageData.onChange(() => scheduleRender());
  subagentData.onActivity((items) => {
    for (const it of items) {
      const ring = subLines.get(it.subagentId) ?? [];
      ring.push(it);
      subLines.set(it.subagentId, ring.slice(-SCREEN_LINES * 2));
    }
    if (ctx && screenTab && items.some((i) => i.subagentId === screenTab)) pushRoomData();
  });
}

let renderQueued = false;
function scheduleRender(): void {
  if (!ctx || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!ctx) return;
    renderAll();
    ctx.refreshFilters();
  });
}

// ---------------------------------------------------------------- facts

function facts(id: string): AgentFacts {
  return { state: agentStateOf(id), hasTerminal: talkInfo(id).binding !== undefined };
}

function stateOf(a: WorldAgent): AgentState {
  return agentStateOf(a.id) ?? (a.status === "live" ? (a.awaitingInput ? "waiting" : "idle") : "sleeping");
}

function visibleAgents(c: ViewContext): WorldAgent[] {
  const all = [...c.store.agents.values()].filter((a) => matchesFilter(a, facts(a.id), filter));
  return orderAgents(all, facts);
}

function cityName(c: ViewContext, id: string): string {
  if (id === "harness") return "Harness City";
  const isl = c.store.islands.get(id);
  return isl ? displayIslandName(isl) : id;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- DOM skeleton

interface Dom {
  wrap: HTMLElement;
  /** "This agent" (who, actions, screen & lists, note): hosted in a left-sidebar section. */
  dock: HTMLElement;
  stage: HTMLElement;
  tip: HTMLElement;
  fallback: HTMLElement;
  dockTitle: HTMLElement;
  dockMeta: HTMLElement;
  screenBtn: HTMLButtonElement;
  todosBtn: HTMLButtonElement;
  shelfBtn: HTMLButtonElement;
  screenTabs: HTMLElement;
  activateBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  hardBtn: HTMLButtonElement;
  noteInput: HTMLInputElement;
  noteSend: HTMLButtonElement;
  status: HTMLElement;
  grid: HTMLElement;
  overlay: HTMLElement;
  vlgTopbar: HTMLElement;
  vlgDock: HTMLElement;
  vlgFeed: HTMLElement;
}
let dom: Dom | null = null;

function btn(label: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function build(root: HTMLElement, c: ViewContext): Dom {
  const wrap = h("div", "rm rm-mode-room");
  // The layout rule: nothing floats over the room. Picking an agent = the sidebar's "Agents"
  // list; this dock (who, actions, screen & lists, note) is the sidebar's "This agent" section.
  const dock = h("section", "rm-dock");
  dock.id = "rm-dock";
  dock.setAttribute("aria-label", "Agent actions");
  const who = h("div", "rm-who");
  const dockTitle = h("div", "rm-who-title");
  const dockMeta = h("div", "rm-who-meta");
  const whoText = h("div", "rm-who-text");
  whoText.append(dockTitle, dockMeta);
  who.append(btn("◀", "rm-step", "Previous agent", () => step(-1)), whoText, btn("▶", "rm-step", "Next agent", () => step(1)));
  const actions = h("div", "rm-actions");
  const activateBtn = btn("Activate", "comic-btn small", "Resume this session in a world tmux session (live terminal here)", () => void activate(activateBtn));
  const stopBtn = btn("Stop (Esc)", "comic-btn small secondary", "Interrupt: sends Esc to its tmux session. Never kills it.", () => void interrupt(false));
  const hardBtn = btn("Ctrl-C (click twice)", "comic-btn small secondary rm-hard", "Hard interrupt: sends Ctrl-C (click twice to confirm)", () => armHard());
  const editorBtn = btn("Open in VS Code", "comic-btn small secondary", "Open its project folder in VS Code", () => void openEditor(editorBtn));
  actions.append(
    btn("Focus", "comic-btn small secondary", "Focus on this agent on the planet", () => focusAgent()),
    editorBtn,
    btn("Code", "comic-btn small secondary", "Browse its repo and diffs in the Code view", () => agentId && c.showView("code", agentId)),
    activateBtn,
    stopBtn,
    hardBtn,
  );
  const lists = h("div", "rm-lists");
  const screenBtn = btn(">_ Screen", "rm-pill rm-screen-btn", "Open the screen: its live terminal, or its activity", () => openScreen());
  const todosBtn = btn("📋 Todos", "rm-pill", "The board as a list", () => openBoard());
  const shelfBtn = btn("📚 Shelf", "rm-pill", "The shelf as a list", () => openShelfList());
  const screenTabs = h("div", "rm-screen-tabs");
  screenTabs.setAttribute("role", "tablist");
  screenTabs.setAttribute("aria-label", "What the screen shows");
  lists.append(screenBtn, todosBtn, shelfBtn, screenTabs);
  const noteForm = h("form", "rm-note");
  const noteInput = h("input", "rm-note-input");
  noteInput.type = "text";
  noteInput.maxLength = Math.min(NOTE_MAX, TALK_MAX_CHARS);
  noteInput.placeholder = "Send it a note…";
  noteInput.setAttribute("aria-label", "Note to send to the agent");
  const noteSend = h("button", "comic-btn small", "Send note");
  noteSend.type = "submit";
  noteForm.append(noteInput, noteSend);
  noteForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void sendNote();
  });
  const status = h("div", "rm-status");
  status.setAttribute("role", "status");
  lists.classList.add("rm-lists-dock");
  dock.append(who, actions, lists, noteForm, status);

  // the 3D stage: transparent, the shared canvas shows the room through it
  const stage = h("section", "rm-stage");
  stage.setAttribute("aria-label", "The agent's room (3D). Click the screen, the shelf, the board, the window.");
  const tip = h("div", "rm-tip");
  tip.hidden = true;
  const fallback = h("p", "rm-fallback", "The 3D scene needs the planet renderer. In a single room, use the Todos / Shelf lists and the screen tabs; in #/room/all, switch to List view.");
  fallback.hidden = true;
  // A small strip naming the room's clickable furniture zones (each hoverable/clickable in the
  // 3D room itself; this is just the legend, so it never intercepts the stage's own pointer events).
  const legend = h("div", "rm-legend");
  for (const [emoji, label] of [
    ["🖥️", "Screen"],
    ["📋", "Board"],
    ["📚", "Shelf"],
    ["🪟", "Window"],
  ] as const) {
    legend.append(h("span", "rm-legend-item", `${emoji} ${label}`));
  }
  // #/room/all's 3D village diorama: a top bar (room count + back-to-List), a compact action
  // dock for whichever room is selected, and the Town square feed. Only shown in grid+diorama
  // sub-mode (renderAll toggles their `hidden`); they live in the stage so they share its
  // pointer-events:auto region (see docs/VIEWS.md's usesPlanet rule) without a new element.
  const vlgTopbar = h("div", "vlg-topbar");
  vlgTopbar.hidden = true;
  const vlgDock = h("div", "vlg-dock");
  vlgDock.hidden = true;
  const vlgFeed = h("aside", "vlg-feed");
  vlgFeed.setAttribute("aria-label", "Town square: what the whole system should know right now, and the log");
  vlgFeed.hidden = true;

  stage.append(tip, fallback, legend, vlgTopbar, vlgDock, vlgFeed);
  stage.addEventListener("pointermove", (ev) => onStageMove(ev));
  stage.addEventListener("pointerdown", (ev) => onStageDown(ev));
  stage.addEventListener("pointerup", () => onStageUp());
  stage.addEventListener("pointerleave", () => {
    tip.hidden = true;
    room3d?.setHover(null);
    village3d?.setHover(null);
    villageDragFrom = null;
    stage.style.cursor = "";
  });
  stage.addEventListener("click", (ev) => onStageClick(ev));
  stage.addEventListener("wheel", (ev) => onStageWheel(ev), { passive: false });

  const grid = h("section", "rm-grid");
  grid.setAttribute("aria-label", "All agents");
  const overlay = h("div", "rm-overlay");
  overlay.hidden = true;
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeOverlay();
  });

  wrap.append(stage, grid, overlay);
  root.append(wrap);
  return {
    wrap, dock, stage, tip, fallback, dockTitle, dockMeta, screenBtn, todosBtn, shelfBtn, screenTabs, activateBtn, stopBtn, hardBtn,
    noteInput, noteSend, status, grid, overlay, vlgTopbar, vlgDock, vlgFeed,
  };
}

// ---------------------------------------------------------------- 3D room

function ensureRoom3D(c: ViewContext): Room3D | null {
  if (room3d) return room3d;
  const rig = sceneParts().rig;
  if (!rig) return null;
  try {
    room3d = createRoom3D({
      renderer: rig.renderer,
      post: rig.post,
      planet: c.scene,
      agentPosition: (id) => c.agentPosition(id),
      reducedMotion: prefersReducedMotion(),
    });
  } catch (err) {
    log.error("room", "3D room failed to build", err);
    room3d = null;
  }
  return room3d;
}

function ensureVillage3D(): Village3D | null {
  if (village3d) return village3d;
  const rig = sceneParts().rig;
  if (!rig) return null;
  try {
    village3d = createVillage3D({ renderer: rig.renderer, post: rig.post, reducedMotion: prefersReducedMotion() });
  } catch (err) {
    log.error("room", "village diorama failed to build", err);
    village3d = null;
  }
  return village3d;
}

function syncStage(): void {
  if (!dom) return;
  const r = dom.stage.getBoundingClientRect();
  const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  room3d?.setStage(rect);
  village3d?.setStage(rect);
}

function runningKids(id: string): SubagentRecord[] {
  return subagentData
    .byParent(id)
    .filter((k) => k.status === "running")
    .slice(0, 6);
}

function hitLabel(hit: Room3DHit): string {
  const c = ctx;
  const a = c && agentId ? c.store.agents.get(agentId) : undefined;
  if (!c || !a) return "";
  switch (hit.kind) {
    case "screen":
      return facts(a.id).hasTerminal ? "The live session: click for its terminal" : "The session: click for its activity (and Resume here, to chat)";
    case "window":
      return "The live orbit outside: click to fly there";
    case "board": {
      const l = todoListFor(c, a.id);
      const p = l && l.items.length ? todoProgress(l) : null;
      return p ? `Todos ${p.done}/${p.total}: click for the list` : "No todo list yet";
    }
    case "shelf":
      return shelfActions[hit.index]?.label ?? "";
    case "drone": {
      const r = runningKids(a.id)[hit.index];
      return r ? `Subagent: ${r.description} (click to show it on the screen)` : "";
    }
    case "creature":
      return `${shortModel(a.model)} · ${STATE_LABELS[stateOf(a)]}`;
    case "plant":
      return `${formatCount(a.tokens)} tokens: a ${PLANT_NAMES[plantStage(a.tokens)]} plant`;
    case "clock": {
      const live = a.status === "live";
      const up = uptime(a.startedAt, live ? Date.now() : Date.parse(a.lastActive));
      return up ? (live ? `Up ${up}` : `Ran ${up}`) : "";
    }
  }
}

function villageHitLabel(hit: Village3DHit): string {
  const c = ctx;
  if (!c) return "";
  if (hit.kind === "resident") {
    const r = villageData.resident;
    return r ? `${r.name}'s room · day ${r.day}` : "";
  }
  const a = c.store.agents.get(hit.agentId);
  if (!a) return "";
  return `${agentTitle(a) || shortCwd(a.cwd)} · ${STATE_LABELS[stateOf(a)]} · click to select`;
}

/** True for events on the village's own DOM (top bar, action dock, Town square): those are
 *  buttons and lists over the stage, so no orbit drag or room pick through them, and the wheel
 *  scrolls them instead of zooming the village. */
function onVillageUi(ev: Event): boolean {
  return !!dom && eventPassedThrough(ev, [dom.vlgFeed, dom.vlgDock, dom.vlgTopbar]);
}

function onStageMove(ev: PointerEvent): void {
  if (!dom) return;
  if (param === GRID) {
    if (gridSubmode !== "diorama" || !village3d) return;
    if (villageDragFrom) {
      const dx = ev.clientX - villageDragFrom.x;
      const dy = ev.clientY - villageDragFrom.y;
      villageDragFrom = { x: ev.clientX, y: ev.clientY };
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) villageDragging = true;
      village3d.drag(-dx, dy);
      dom.tip.hidden = true;
      dom.stage.style.cursor = "grabbing";
      return;
    }
    if (onVillageUi(ev)) {
      dom.tip.hidden = true;
      dom.stage.style.cursor = "";
      return;
    }
    const hit = village3d.hit(ev.clientX, ev.clientY);
    const label = hit ? villageHitLabel(hit) : "";
    dom.stage.style.cursor = hit ? "pointer" : "grab";
    dom.tip.hidden = !label;
    if (label) {
      dom.tip.textContent = label;
      const r = dom.stage.getBoundingClientRect();
      dom.tip.style.transform = `translate(${Math.round(ev.clientX - r.left + 14)}px, ${Math.round(ev.clientY - r.top + 16)}px)`;
    }
    return;
  }
  if (!room3d) return;
  const hit = room3d.hit(ev.clientX, ev.clientY);
  const label = hit ? hitLabel(hit) : "";
  dom.stage.style.cursor = hit && hit.kind !== "creature" && hit.kind !== "plant" && hit.kind !== "clock" ? "pointer" : "";
  dom.tip.hidden = !label;
  if (label) {
    dom.tip.textContent = label;
    const r = dom.stage.getBoundingClientRect();
    dom.tip.style.transform = `translate(${Math.round(ev.clientX - r.left + 14)}px, ${Math.round(ev.clientY - r.top + 16)}px)`;
  }
}

function onStageDown(ev: PointerEvent): void {
  if (param !== GRID || gridSubmode !== "diorama" || onVillageUi(ev)) return;
  villageDragging = false;
  villageDragFrom = { x: ev.clientX, y: ev.clientY };
}

function onStageUp(): void {
  villageDragFrom = null;
}

function onStageWheel(ev: WheelEvent): void {
  if (param !== GRID || gridSubmode !== "diorama" || !village3d || onVillageUi(ev)) return;
  ev.preventDefault();
  village3d.zoom(ev.deltaY);
}

function onStageClick(ev: MouseEvent): void {
  const c = ctx;
  if (!c || !dom) return;
  if (param === GRID) {
    if (villageDragging) {
      villageDragging = false;
      return;
    }
    if (gridSubmode !== "diorama" || !village3d || onVillageUi(ev)) return;
    const hit = village3d.hit(ev.clientX, ev.clientY);
    if (!hit) return;
    if (hit.kind === "room") {
      villageSelected = hit.agentId;
      c.selection.set({ kind: "agent", id: hit.agentId });
    } else {
      villageSelected = "resident";
    }
    scheduleRender();
    return;
  }
  if (!room3d || !agentId) return;
  const hit = room3d.hit(ev.clientX, ev.clientY);
  if (!hit) return;
  const id = agentId;
  switch (hit.kind) {
    case "screen":
      if (dom) openRoomChat(c, id, dom.stage);
      break;
    case "window":
      c.selection.set({ kind: "agent", id });
      c.showView("orbit");
      c.planet.flyToAgent(id);
      break;
    case "board":
      openBoard();
      break;
    case "shelf":
      shelfActions[hit.index]?.run();
      break;
    case "drone": {
      const r = runningKids(id)[hit.index];
      if (r) {
        screenTab = r.id;
        pushRoomData();
      }
      break;
    }
    default:
      break;
  }
}

/** Shelf → 3D items + what a click on each does (same order). */
function shelfModel(res: ShelfResult | null, id: string): { items: Room3DShelfItem[]; actions: { label: string; run(): void }[] } {
  const items: Room3DShelfItem[] = [];
  const actions: { label: string; run(): void }[] = [];
  if (!res || !res.ok) return { items, actions };
  const fileAction = (f: ShelfFile): { label: string; run(): void } => ({
    label: `${baseName(f.path)} · ${!f.exists ? "deleted" : f.previewable ? "click to preview here" : "click to open in Code"}`,
    run: () => {
      if (!f.exists) return;
      if (f.previewable) openPreview(f);
      else ctx?.showView("code", id);
    },
  });
  const linkAction = (url: string, label: string): { label: string; run(): void } => ({
    label: `${label} · opens in a new tab`,
    run: () => {
      const safe = safeHttpUrl(url);
      if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    },
  });
  const media = new Set(res.media.map((m) => m.path));
  const learn = new Set(res.learnings.map((m) => m.path));
  for (const f of res.learnings.slice(0, 3)) {
    items.push({ kind: "jar", color: 0x5bd1ff, gone: !f.exists });
    actions.push(fileAction(f));
  }
  for (const f of res.media.slice(0, 3)) {
    items.push({ kind: "frame", color: 0xff6fa5, gone: !f.exists });
    actions.push(fileAction(f));
  }
  for (const a of res.artifacts.slice(0, 2)) {
    items.push({ kind: "frame", color: 0xffd23f, gone: false });
    actions.push(linkAction(a.url, "claude.ai artifact"));
  }
  const books = [0xffd23f, 0x6fd46b, 0x9b7bff, 0xff8a5c, 0x3fb6ff];
  res.files
    .filter((f) => !media.has(f.path) && !learn.has(f.path))
    .slice(0, 5)
    .forEach((f, i) => {
      items.push({ kind: "book", color: books[i % books.length]!, gone: !f.exists });
      actions.push(fileAction(f));
    });
  for (const u of res.urls.slice(0, 3)) {
    items.push({ kind: "card", color: 0x7ee0a0, gone: false });
    actions.push(linkAction(u.url, u.host || u.url));
  }
  return { items, actions };
}

/** Hands the current agent's real data to the 3D room and the dock's screen tabs. */
function pushRoomData(): void {
  const c = ctx;
  if (!c || !dom || !agentId) return;
  const a = c.store.agents.get(agentId);
  if (!a) return;
  const mood = lampMood(a, agentStateOf(a.id));
  const kids = subagentData.byParent(a.id);
  if (!kids.length && a.status === "live") void subagentData.loadParent(c.api, a.id);
  if (screenTab && !kids.some((k) => k.id === screenTab)) screenTab = null;

  // screen tabs (dock)
  const tab = (id: string | null, label: string, title: string): HTMLButtonElement => {
    const b = btn(label, "rm-pill rm-tab", title, () => {
      screenTab = id;
      pushRoomData();
    });
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(screenTab === id));
    return b;
  };
  const tabs: HTMLElement[] = kids.length ? [tab(null, "Session", "The screen shows the agent's own session")] : [];
  const shownKids = [...kids]
    .sort((x, y) => (x.status === "running" ? 0 : 1) - (y.status === "running" ? 0 : 1) || (x.lastActive < y.lastActive ? 1 : -1))
    .slice(0, MAX_SUB_TABS);
  for (const k of shownKids) tabs.push(tab(k.id, `🛸 ${k.description.slice(0, 16)}`, `Subagent (${k.status}): ${k.description}`));
  if (kids.length > MAX_SUB_TABS) tabs.push(h("span", "rm-more", `+${kids.length - MAX_SUB_TABS}`));
  dom.screenTabs.replaceChildren(...tabs);

  // screen content
  let title = `claude · ${shortCwd(a.cwd)}`;
  let lines: { stage: string; text: string }[] = [];
  let empty = "";
  if (screenTab) {
    const r = subagentData.records.get(screenTab);
    if (r) {
      title = `subagent · ${r.description}`;
      const tools = Object.entries(r.toolCounts)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([k, n]) => `${k}×${n}`)
        .join("  ");
      lines.push({ stage: "plan", text: `${r.status} · ${shortModel(r.model)} · ${formatCount(r.tokens)} tokens` });
      if (tools) lines.push({ stage: "tool", text: tools });
      for (const f of r.files.slice(0, 2)) lines.push({ stage: "tool", text: `✎ ${baseName(f.path)}` });
    }
    for (const x of (subLines.get(screenTab) ?? []).slice(-3)) lines.push({ stage: x.stage, text: x.summary });
  } else {
    lines = c.store.activities
      .filter((x) => x.agentId === a.id)
      .slice(-SCREEN_LINES)
      .map((x) => ({ stage: x.stage, text: x.summary }));
    if (!lines.length) empty = a.status === "live" ? `Quiet since this page loaded. > ${a.title}` : `Asleep. Last active ${ago(a.lastActive)}. > ${a.title}`;
  }
  const bound = facts(a.id).hasTerminal;
  dom.screenBtn.textContent = bound ? ">_ Live terminal" : ">_ Open screen";
  dom.screenBtn.classList.toggle("rm-live", bound);

  const todo = todoListFor(c, a.id);
  const { notes, hidden } = stickyNotes(todo);
  const prog = todo && todo.items.length ? todoProgress(todo) : null;
  dom.todosBtn.textContent = prog ? `📋 Todos ${prog.done}/${prog.total}` : "📋 Todos";
  const model = shelfModel(shelfFor === a.id ? shelfRes : null, a.id);
  shelfActions = model.actions;
  const live = a.status === "live";
  const endMs = live ? Date.now() : Date.parse(a.lastActive);
  const up = uptime(a.startedAt, endMs);

  const r3 = ensureRoom3D(c);
  dom.fallback.hidden = r3 !== null;
  r3?.setData({
    agentId: a.id,
    mood,
    family: modelKey(a.model),
    tint: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#ffb3cd",
    notes,
    hiddenNotes: hidden,
    progress: prog ? { done: prog.done, total: prog.total } : null,
    screen: { title, lines, empty, cta: bound ? ">_ click: live terminal" : "click: open the session", live: bound },
    clock: clockHands(a.startedAt, endMs),
    clockLabel: up ? (live ? `up ${up}` : `ran ${up}`) : "",
    plant: plantStage(a.tokens),
    plantLabel: `${formatCount(a.tokens)} tokens`,
    shelf: model.items,
    drones: runningKids(a.id).map((k) => k.description),
  });
}

// ---------------------------------------------------------------- village diorama (#/room/all)

/** Recent subagents whose parent is one of the rooms currently shown, for the Town square feed. */
function shownSubagentFacts(shownIds: ReadonlySet<string>): SubagentSpawnFact[] {
  const out: SubagentSpawnFact[] = [];
  for (const r of subagentData.records.values()) {
    if (!shownIds.has(r.parentSessionId)) continue;
    out.push({ id: r.id, description: r.description, status: r.status, startedAt: r.startedAt, lastActive: r.lastActive });
  }
  return out;
}

function renderVillage(c: ViewContext, list: readonly WorldAgent[], sel: Selection | null): void {
  if (!dom) return;
  const shown = villageAgents(list, facts, pinnedIds(), lastState.layout?.[0]);
  const shownIds = new Set(shown.map((a) => a.id));
  const v3 = ensureVillage3D();
  dom.fallback.hidden = v3 !== null;
  dom.vlgTopbar.hidden = false;
  dom.vlgFeed.hidden = false;

  if (villageSelected && villageSelected !== "resident" && !shownIds.has(villageSelected)) villageSelected = null;
  const selectedAgentId = sel?.kind === "agent" && shownIds.has(sel.id) ? sel.id : null;
  const selectedId = villageSelected ?? selectedAgentId;

  const rooms: Village3DRoomData[] = shown.map((a) => {
    const st = facts(a.id).state;
    const acts = c.store.activities.filter((x) => x.agentId === a.id).slice(-4);
    return {
      agentId: a.id,
      roomLabel: shortCwd(a.cwd).toUpperCase(),
      modelLabel: shortModel(a.model),
      family: modelKey(a.model),
      mood: lampMood(a, st),
      needsYou: roomBucket(a, st) === "waiting",
      screenLines: redactOn() ? [] : acts.map((x) => x.summary),
      screenTitle: redactOn() ? "session" : agentTitle(a) || shortCwd(a.cwd),
      drones: subagentData.byParent(a.id).filter((k) => k.status === "running").length,
    };
  });

  const resident = villageData.resident;
  const residentData: Village3DResidentData | null =
    resident && resident.enabled
      ? { name: resident.name, day: resident.day, shelfCount: resident.skills.length, journalLine: redactOn() ? "" : (resident.journalTail.at(-1) ?? "") }
      : null;

  v3?.setData({
    rooms,
    bridges: [...repoBridges(shown), ...messageBridges(villageData.messages, shownIds)],
    resident: residentData,
    selectedId,
  });

  const topbar = h("span", "vlg-topbar-count", `${shown.length} of ${list.length} rooms shown · drag to orbit, scroll to zoom`);
  const listBtn = h("button", "comic-btn small secondary", "▦ Grid view");
  listBtn.type = "button";
  listBtn.title = "Switch to the grid of rooms: every tile's actions at once (remembered)";
  listBtn.addEventListener("click", () => {
    setSubmode("list");
    scheduleRender();
  });
  dom.vlgTopbar.replaceChildren(topbar, listBtn);

  if (selectedId && selectedId !== "resident") {
    const a = c.store.agents.get(selectedId);
    if (a) {
      dom.vlgDock.hidden = false;
      const title = h("div", "vlg-dock-title", agentTitle(a) || shortCwd(a.cwd));
      const actions = buildActionsBar(c, a, facts(a.id).hasTerminal, scheduleRender);
      dom.vlgDock.replaceChildren(title, actions);
      if (talkOpen.has(a.id)) dom.vlgDock.append(talkForm(c, a));
    } else {
      dom.vlgDock.hidden = true;
    }
  } else if (selectedId === "resident" && residentData) {
    dom.vlgDock.hidden = false;
    dom.vlgDock.replaceChildren(h("div", "vlg-dock-title", `${residentData.name}'s room · day ${residentData.day}`), h("p", "vlg-dock-note", "Read-only: the resident manages its own sandbox."));
  } else {
    dom.vlgDock.hidden = true;
  }

  townSquareShown = shownIds;
  renderTownSquare(c);
}

/** One row of the global workspace's top 5: what it is, and the one-line reason it got in.
 *  Text is untrusted (titles, previews): textContent only, blurred under ?redact=1 by room.css. */
function workspaceRow(c: ViewContext, e: WorkspaceEntry): HTMLLIElement {
  const li = h("li", `vlg-feed-item vlg-ws-item vlg-ws-${e.urgency}`);
  const btn = h("button", "vlg-ws-main");
  btn.type = "button";
  btn.dataset.focusKey = `ws:${e.key}`;
  const target = e.agentIds.find((id) => c.store.agents.has(id));
  btn.disabled = !target;
  btn.title = target ? "Select this agent" : "";
  btn.setAttribute("aria-label", `${URGENCY_LABEL[e.urgency]}: ${e.text}. ${e.reason}`);
  btn.append(h("span", "vlg-ws-emoji", URGENCY_EMOJI[e.urgency]), h("span", "vlg-ws-text", e.text), h("span", "vlg-ws-reason", e.reason));
  btn.addEventListener("click", () => {
    if (!target) return;
    if (townSquareShown.has(target)) villageSelected = target;
    c.selection.set({ kind: "agent", id: target });
    scheduleRender();
  });
  li.append(btn);
  return li;
}

/** The Town square: the global workspace's top 5 (features/workspace-lib.ts), and one click away
 *  the chronological log it has always kept (messages, subagent spawns and hand-backs). */
function renderTownSquare(c: ViewContext): void {
  if (!dom || dom.vlgFeed.hidden) return;
  const ws = workspaceData.result;
  const log = feedItems(villageData.messages, shownSubagentFacts(townSquareShown), 24);
  const sig = JSON.stringify([
    townSquareTab,
    ws.top.map((e) => [e.key, e.text, e.reason, e.agentIds.find((id) => c.store.agents.has(id)) ?? ""]),
    ws.counts,
    log.map((i) => [i.id, i.text, relativeTime(i.at)]),
  ]);
  if (sig === townSquareSig && dom.vlgFeed.childElementCount > 0) return;
  townSquareSig = sig;
  const focused = document.activeElement instanceof HTMLElement && dom.vlgFeed.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
  const tabs = h("div", "vlg-ws-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Town square view");
  const tab = (id: "top" | "log", label: string, title: string): HTMLButtonElement => {
    const b = h("button", "vlg-ws-tab", label);
    b.type = "button";
    b.title = title;
    b.dataset.focusKey = `tab:${id}`;
    b.setAttribute("aria-pressed", String(townSquareTab === id));
    b.addEventListener("click", () => {
      townSquareTab = id;
      renderTownSquare(c);
    });
    return b;
  };
  tabs.append(
    tab("top", `Top ${ws.top.length}`, `What cleared the salience bar (${WORKSPACE.enter}) right now, at most ${WORKSPACE.slots}`),
    tab("log", `Log ${log.length}`, "Every message and subagent spawn / hand-back, newest first"),
  );

  let body: HTMLElement;
  if (townSquareTab === "top") {
    const k = ws.counts;
    const count = h("p", "vlg-ws-count", `${k.candidates} signals in the last 2 h · ${k.groups} after merging repeats · ${k.contenders} urgent or broad enough to clear the bar${k.crowdedOut ? ` · ${k.crowdedOut} crowded out` : ""}`);
    if (ws.top.length) {
      const list = h("ol", "vlg-feed-list vlg-ws-list");
      for (const e of ws.top) list.append(workspaceRow(c, e));
      body = h("div", "vlg-ws-body");
      body.append(list, count);
    } else {
      body = h("div", "vlg-ws-body");
      body.append(h("p", "vlg-feed-empty", `Nothing clears the bar (${WORKSPACE.enter}) right now. Everything else is in the Log and the Feed tab.`), count);
    }
  } else if (log.length) {
    const feedList = h("ul", "vlg-feed-list");
    for (const item of log) {
      const li = h("li", `vlg-feed-item vlg-feed-${item.kind}`);
      li.append(h("span", "vlg-feed-text", item.text), h("time", "vlg-feed-at", relativeTime(item.at)));
      feedList.append(li);
    }
    body = feedList;
  } else {
    body = h("p", "vlg-feed-empty", "Quiet so far — no messages or subagent activity yet.");
  }
  dom.vlgFeed.replaceChildren(h("h3", "vlg-feed-title", "Town square"), tabs, body);
  if (focused) [...dom.vlgFeed.querySelectorAll<HTMLElement>("[data-focus-key]")].find((el) => el.dataset.focusKey === focused)?.focus();
}

// ---------------------------------------------------------------- render

function renderAll(): void {
  const c = ctx;
  if (!c || !dom) return;
  const list = visibleAgents(c);
  const explicit = param !== null && param !== GRID && c.store.agents.has(param);
  const gridMode = param === GRID || (!explicit && list.length === 0);
  dom.wrap.classList.toggle("rm-mode-grid", gridMode);
  dom.wrap.classList.toggle("rm-mode-room", !gridMode);
  document.body.classList.toggle("alef-room-inside", !gridMode);
  room3d?.setActive(!gridMode);
  if (gridMode !== wasGridMode) {
    wasGridMode = gridMode;
    if (gridMode) enterGridMode(c);
    else exitGridMode(c);
    c.refreshFilters(); // the Layout + Pins sidebar section only exists in grid mode
  }
  if (gridMode) {
    if (agentId) closeOverlay();
    agentId = null;
    const sel = c.selection.get();
    dom.wrap.classList.toggle("rm-grid-list", gridSubmode === "list");
    if (gridSubmode === "list") {
      village3d?.setActive(false);
      dom.vlgTopbar.hidden = true;
      dom.vlgDock.hidden = true;
      dom.vlgFeed.hidden = true;
      renderGridTiles(c, dom.grid, list, facts, (id) => cityName(c, id), lastState, sel?.kind === "agent" ? sel.id : null, scheduleRender, () => {
        setSubmode("diorama");
        scheduleRender();
      });
    } else {
      village3d?.setActive(true);
      renderVillage(c, list, sel);
    }
    syncPicker(c);
    syncStage();
    return;
  }
  const next = pickAgent(param === GRID ? null : param, list, (id) => c.store.agents.has(id));
  if (next !== agentId) {
    agentId = next;
    screenTab = null;
    closeOverlay();
    say("");
    if (next) {
      c.planet.flyToAgent(next);
      const sel = c.selection.get();
      if (sel?.kind !== "agent" || sel.id !== next) c.selection.set({ kind: "agent", id: next });
    }
    void refreshShelf(false);
  }
  syncPicker(c);
  renderDock(c);
  pushRoomData();
  room3d?.setActive(true);
  syncStage();
}

/** The sidebar's "Agents" list follows the room (the list is in filters(); counts / dots change often). */
let lastState: FilterState = {};
function syncPicker(c: ViewContext): void {
  const want = agentId ?? GRID;
  if (lastState.agent?.[0] !== want) {
    lastState = { ...lastState, agent: [want] };
    c.setFilterState(lastState);
  } else c.refreshFilters();
}

function renderDock(c: ViewContext): void {
  if (!dom || !agentId) return;
  const a = c.store.agents.get(agentId);
  if (!a) return;
  dom.dockTitle.textContent = agentTitle(a) || shortCwd(a.cwd);
  dom.dockTitle.title = `${a.title}\n${cityName(c, a.islandId)} · ${shortModel(a.model)} · ${a.messageCount} msgs · active ${ago(a.lastActive)}`;
  dom.dockMeta.replaceChildren(
    h("span", `as-chip as-${stateOf(a)}`, STATE_LABELS[stateOf(a)]),
    h("span", "rm-meta-txt", `${cityName(c, a.islandId)} · ${shortModel(a.model)}`),
  );
  const live = a.status === "live";
  const bound = facts(a.id).hasTerminal;
  dom.activateBtn.hidden = live;
  dom.stopBtn.hidden = !live;
  dom.hardBtn.hidden = !live;
  dom.stopBtn.disabled = !bound;
  dom.hardBtn.disabled = !bound;
  const noTmux = `Only world-launched agents can be stopped from here (${CONTROL_NOT_TMUX_ERROR}).`;
  dom.stopBtn.title = bound ? "Interrupt: sends Esc to its tmux session. Never kills it." : noTmux;
  dom.hardBtn.title = bound ? "Hard interrupt: sends Ctrl-C (click twice to confirm)" : noTmux;
  dom.noteInput.disabled = !live || !bound;
  dom.noteSend.disabled = !live || !bound;
  dom.noteInput.placeholder = !live ? "Activate it to send a note" : bound ? "Send it a note…" : "Notes need a world tmux session: Activate / Resume here";
}

// ---------------------------------------------------------------- shelf, board, preview, screen

async function refreshShelf(quiet: boolean): Promise<void> {
  const c = ctx;
  const id = agentId;
  if (!c || !dom || !id) return;
  shelfAt = Date.now();
  if (!quiet || shelfFor !== id) {
    shelfRes = null;
    dom.shelfBtn.textContent = "📚 Shelf…";
  }
  shelfFor = id;
  const res = await loadShelf(c.api, id);
  if (!dom || agentId !== id) return;
  shelfRes = res;
  const total = res.ok ? res.files.length + res.urls.length + res.artifacts.length : 0;
  dom.shelfBtn.textContent = res.ok ? `📚 Shelf ${total}` : "📚 Shelf";
  pushRoomData();
  if (overlayKind === "shelf") openShelfList();
}

function overlayCard(title: string, sub: string): { card: HTMLElement; body: HTMLElement; tools: HTMLElement } {
  const card = h("div", "rm-ov-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", title);
  const head = h("header", "rm-ov-head");
  const titles = h("div", "rm-ov-titles");
  titles.append(h("div", "rm-ov-title", title), h("div", "rm-ov-sub", sub));
  const tools = h("div", "rm-ov-tools");
  const close = btn("×", "ui-close", "Close (Esc)", () => closeOverlay());
  close.setAttribute("aria-label", "Close");
  head.append(titles, tools, close);
  const body = h("div", "rm-ov-body");
  card.append(head, body);
  return { card, body, tools };
}

function showOverlay(card: HTMLElement, kind: NonNullable<typeof overlayKind>): void {
  if (!dom) return;
  dom.overlay.replaceChildren(card);
  dom.overlay.hidden = false;
  overlayKind = kind;
}

function openBoard(): void {
  const c = ctx;
  if (!c || !agentId) return;
  closeOverlay();
  const list = todoListFor(c, agentId);
  const prog = list && list.items.length ? todoProgress(list) : null;
  const { card, body } = overlayCard("Todos", prog ? `${prog.done} of ${prog.total} done · updated ${ago(list?.updatedAt ?? "")}` : "no todo list yet");
  card.classList.add("rm-ov-small");
  body.append(list && list.items.length ? todoListElement(list) : h("p", "rm-ro-why", "Sticky notes appear when the agent writes a todo list (TodoWrite / tasks)."));
  body.classList.add("rm-ov-pad");
  showOverlay(card, "board");
}

function openShelfList(): void {
  const c = ctx;
  if (!c || !agentId) return;
  const id = agentId;
  closeOverlay();
  const { card, body } = overlayCard("Shelf", "what this session wrote and linked");
  card.classList.add("rm-ov-small");
  const planks = h("div", "rm-planks");
  if (shelfRes && shelfFor === id) renderShelf(planks, shelfRes, { preview: (f) => openPreview(f), openInCode: () => c.showView("code", id) });
  else planks.append(h("p", "rm-shelf-note", "Dusting the shelf…"));
  body.append(planks);
  body.classList.add("rm-ov-pad");
  showOverlay(card, "shelf");
}

function openPreview(f: ShelfFile): void {
  const c = ctx;
  if (!c || !dom || !agentId) return;
  closeOverlay();
  const id = agentId;
  const { card, body, tools } = overlayCard(baseName(f.path), f.path);
  card.classList.add("rm-ov-preview");
  tools.append(btn("Open in Code", "comic-btn small secondary", "Show the repo in the Code view", () => c.showView("code", id)));
  const frame = h("iframe", "rm-preview");
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.title = `Preview of ${baseName(f.path)}`;
  frame.src = previewUrl(id, f.path);
  body.append(frame);
  showOverlay(card, "preview");
}

function openScreen(): void {
  const c = ctx;
  if (!c || !dom || !agentId) return;
  const a = c.store.agents.get(agentId);
  if (!a) return;
  closeOverlay();
  const id = a.id;
  const binding = talkInfo(id).binding;
  const { card, body, tools } = overlayCard(agentTitle(a) || shortCwd(a.cwd), binding ? `live terminal · tmux ${binding.tmuxName}` : "read-only activity");
  card.classList.add("rm-ov-screen");
  showOverlay(card, "screen");
  if (binding) {
    term = createTerminal(body, id, {
      title: `${shortCwd(a.cwd)} · ${binding.tmuxName}`,
      onResume: async () => {
        await resumeInTmux(c, id);
      },
      resumeOffer: () => resumeOfferFor(id, c.store.agents.get(id)?.status),
    });
    term.focus();
    return;
  }
  const info = talkInfo(id);
  const lines = h("ul", "rm-ro-lines");
  const acts = c.store.activities.filter((x) => x.agentId === id);
  for (const x of acts.slice(-20)) {
    const li = h("li", `rm-line rm-stage-${x.stage}`);
    li.append(h("time", "rm-ro-at", new Date(x.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), h("span", undefined, x.summary));
    lines.append(li);
  }
  if (!acts.length) lines.append(h("li", "rm-line rm-line-dim", `No live lines since this page loaded. Last active ${ago(a.lastActive)}.`));
  const offer = resumeOfferFor(id, a.status);
  const why = h(
    "p",
    "rm-ro-why",
    offer === "running-elsewhere"
      ? RUNNING_ELSEWHERE_TEXT
      : info.available === false
        ? info.hint ?? "Talk needs tmux."
        : "This session was not started from the world, so there is no terminal to attach. Resume it here to chat: it restarts inside a world tmux session and this screen becomes its live terminal.",
  );
  if (offer !== "running-elsewhere") {
    const resume = btn("Resume here, to chat", "comic-btn small", "claude --resume in a world tmux session", () => {
      // Checked again at click time: the agent may have started elsewhere since this opened.
      if (resumeOfferFor(id, c.store.agents.get(id)?.status) !== "resume") return openScreen();
      void roomActivate(actionDeps(c), id, true, { status: dockStatus(id), button: resume }, (r) => `${resumeStartedText(r)} Opening its terminal here…`).then((r) => {
        if (r?.ok) window.setTimeout(() => overlayKind === "screen" && agentId === id && talkInfo(id).binding && openScreen(), 1500);
      });
    });
    resume.disabled = offer !== "resume";
    tools.append(resume);
  }
  body.append(why, lines);
}

function closeOverlay(): void {
  term?.dispose();
  term = null;
  overlayKind = null;
  if (dom) {
    dom.overlay.hidden = true;
    dom.overlay.replaceChildren();
  }
}

// ---------------------------------------------------------------- actions

function say(text: string): void {
  if (dom) dom.status.textContent = text;
}

function step(dir: 1 | -1): void {
  const c = ctx;
  if (!c) return;
  const next = stepAgent(visibleAgents(c), agentId, dir);
  if (next) c.showView("room", next);
}

function focusAgent(): void {
  const c = ctx;
  if (!c || !agentId) return;
  const id = agentId;
  c.selection.set({ kind: "agent", id });
  c.showView("orbit");
  c.planet.flyToAgent(id);
  c.focus.set(true);
}

// Open in VS Code, Activate / Resume here, Stop and Ctrl-C: views/room-actions.ts (a toast for every
// outcome, the clicked button busy while it runs).
function actionDeps(c: ViewContext): RoomActionDeps {
  return {
    agent: (id) => c.store.agents.get(id),
    reactivate: (id) => c.api.reactivate(id),
    openEditor: (id) => c.api.openEditor(id),
    toast: c.toast,
    resume: (id) => resumeInTmux(c, id),
    interrupt: (id, hard) =>
      c.api.postJson<ControlResult>(`/api/agents/${encodeURIComponent(id)}/interrupt${hard ? "?hard=1" : ""}`, {}, (error) => ({ ok: false, error })),
    resumeOffer: (id) => resumeOfferFor(id, c.store.agents.get(id)?.status),
  };
}

/** The dock's status line while the Room still shows agent `id` (stepping to another clears it). */
function dockStatus(id: string): () => HTMLElement | null {
  return () => (agentId === id ? dom?.status ?? null : null);
}

async function openEditor(button: HTMLButtonElement): Promise<void> {
  const c = ctx;
  if (!c || !agentId) return;
  await roomOpenEditor(actionDeps(c), agentId, { status: dockStatus(agentId), button });
}

/** The button is hidden for live agents; roomActivate re-checks the resume guard at click time, for
 *  a dock rendered before the agent went live, and adds the folder-trust hint to a success. */
async function activate(button: HTMLButtonElement): Promise<void> {
  const c = ctx;
  if (!c || !agentId) return;
  await roomActivate(actionDeps(c), agentId, talkInfo(agentId).available !== false, { status: dockStatus(agentId), button });
}

async function interrupt(hard: boolean): Promise<void> {
  const c = ctx;
  if (!c || !agentId || !dom) return;
  await roomInterrupt(actionDeps(c), agentId, hard, { status: dockStatus(agentId), button: hard ? dom.hardBtn : dom.stopBtn });
}

function disarmHard(): void {
  if (stopHold !== null) window.clearTimeout(stopHold);
  stopHold = null;
  if (dom) {
    dom.hardBtn.classList.remove("rm-armed");
    dom.hardBtn.textContent = "Ctrl-C (click twice)";
  }
}

function armHard(): void {
  if (!dom) return;
  if (stopHold !== null) {
    disarmHard();
    void interrupt(true);
    return;
  }
  dom.hardBtn.classList.add("rm-armed");
  dom.hardBtn.textContent = "Sure? Ctrl-C";
  say("Click again within 3s to send Ctrl-C.");
  stopHold = window.setTimeout(disarmHard, 3000);
}

async function sendNote(): Promise<void> {
  const c = ctx;
  if (!c || !dom || !agentId) return;
  const text = dom.noteInput.value;
  const err = noteError(text);
  if (err) {
    say(err);
    return;
  }
  const id = agentId;
  say("Sending the note…");
  const r = await c.api.postJson<ControlResult>(`/api/agents/${encodeURIComponent(id)}/note`, { text: text.trim() }, (error) => ({ ok: false, error }));
  if (r.ok && dom) dom.noteInput.value = "";
  say(r.ok ? `Note sent to ${r.tmuxName ?? "the agent"}.` : `Not sent: ${r.error ?? "unknown error"}`);
}

// ---------------------------------------------------------------- the view

function counts(c: ViewContext): { bucket: Record<string, number>; city: Map<string, number>; model: Record<string, number>; term: number } {
  const bucket: Record<string, number> = { live: 0, waiting: 0, dormant: 0 };
  const model: Record<string, number> = {};
  const city = new Map<string, number>();
  let termN = 0;
  for (const a of c.store.agents.values()) {
    const f = facts(a.id);
    const b = roomBucket(a, f.state);
    bucket[b] = (bucket[b] ?? 0) + 1;
    const m = modelKey(a.model);
    model[m] = (model[m] ?? 0) + 1;
    city.set(a.islandId, (city.get(a.islandId) ?? 0) + 1);
    if (f.hasTerminal) termN++;
  }
  return { bucket, city, model, term: termN };
}

const FAMILIES: readonly [string, string][] = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["other", "Other"],
];

export const roomView: AlefView = {
  id: "room",
  emoji: "🚪",
  name: "Room",
  hint: "Step inside an agent: its 3D room, live screen, board, shelf and a window onto the planet",
  usesPlanet: true,
  coversPlanet: true,

  mount(root, c) {
    ctx = c;
    rootEl = root;
    const sel = c.selection.get();
    param = c.route().param ?? (sel?.kind === "agent" && c.store.agents.has(sel.id) ? sel.id : null);
    settling = true;
    queueMicrotask(() => {
      settling = false;
    });
    if (c.planet.roomAgent()) c.planet.exitRoom();
    document.body.classList.add("alef-room-open");
    dom = build(root, c);
    hookStoreOnce(c);
    unsubs.push(onTodosChange(scheduleRender), onAgentStates(scheduleRender), onTalkChange(scheduleRender));
    // The workspace re-scores on its own clock (decay); only the Town square panel redraws.
    unsubs.push(workspaceData.onChange(() => ctx && renderTownSquare(ctx)));
    stageObs = new ResizeObserver(() => syncStage());
    stageObs.observe(dom.stage);
    const onResize = (): void => syncStage();
    window.addEventListener("resize", onResize);
    unsubs.push(() => window.removeEventListener("resize", onResize));
    tick = window.setInterval(() => {
      if (!agentId || !ctx) return;
      renderDock(ctx);
      pushRoomData();
    }, TICK_MS);
    renderAll();
  },

  unmount() {
    closeOverlay();
    window.clearInterval(tick);
    disarmHard();
    for (const u of unsubs.splice(0)) u();
    stageObs?.disconnect();
    stageObs = null;
    room3d?.dispose();
    room3d = null;
    village3d?.dispose();
    village3d = null;
    villageSelected = null;
    villageDragging = false;
    villageDragFrom = null;
    document.body.classList.remove("alef-room-open", "alef-room-inside", "alef-room-focus");
    if (wasGridMode && ctx) exitGridMode(ctx);
    wasGridMode = false;
    closeAllGridTalk();
    lastState = {};
    ctx = null;
    rootEl = null;
    dom = null;
    agentId = null;
    shelfFor = null;
    shelfRes = null;
    shelfActions = [];
  },

  filters(c) {
    const n = counts(c);
    const shown = visibleAgents(c);
    const cur = agentId ? c.store.agents.get(agentId) : undefined;
    // The agent in the room stays in the picker even when the filter would hide it (dormant).
    if (cur && !shown.some((a) => a.id === cur.id)) shown.unshift(cur);
    const dock = dom?.dock;
    const cities = [...n.city.entries()]
      .sort((a, b) => b[1] - a[1] || cityName(c, a[0]).localeCompare(cityName(c, b[0])))
      .map(([id, count]) => ({ value: id, label: cityName(c, id), count }));
    const gridMode = param === GRID;
    const gridSelected = (): string | null => {
      const s = c.selection.get();
      return s?.kind === "agent" ? s.id : null;
    };
    const specs: FilterSpec[] = [
      {
        id: "agent",
        label: "Agents",
        type: "list",
        limit: 10,
        default: [agentId ?? GRID],
        count: shown.length,
        options: [
          { value: GRID, label: "All agents", emoji: "🎛️", hint: "Watch several agents at once, side by side" },
          ...shown.map((a) => {
            const st = stateOf(a);
            return {
              value: a.id,
              label: agentTitle(a) || shortCwd(a.cwd),
              meta: `${cityName(c, a.islandId)} · ${STATE_LABELS[st]}${facts(a.id).hasTerminal ? " · >_" : ""}`,
              dot: st === "working" || st === "idle" ? "live" : st === "waiting" || st === "permission" ? "awaiting" : "asleep",
              hint: `${a.title}\n${cityName(c, a.islandId)} · ${STATE_LABELS[st]} · ${shortModel(a.model)}`,
            };
          }),
        ],
      },
      ...(dock && agentId ? [{ id: "here", label: "This agent", type: "section" as const, render: (host: HTMLElement) => void host.append(dock) }] : []),
      ...(gridMode ? gridFilterSpecs(c, facts, (id) => cityName(c, id), gridSelected(), scheduleRender) : []),
      {
        id: "state",
        label: "State",
        type: "chips",
        multi: true,
        default: ["live", "waiting"],
        options: [
          { value: "live", label: "Live", count: n.bucket.live, dot: "live", hint: "Awake: working or idle" },
          { value: "waiting", label: "Waiting", count: n.bucket.waiting, dot: "awaiting", hint: "Waiting on you (a question or a permission)" },
          { value: "dormant", label: "Dormant", emoji: "💤", count: n.bucket.dormant, dot: "asleep", hint: "Asleep: show their rooms too" },
        ],
      },
      { id: "terminal", label: "Terminal", type: "toggle", options: [{ value: "on", label: `Has a live terminal (${n.term})`, hint: "Started or resumed from the world (tmux)" }] },
      { id: "model", label: "Model", type: "chips", multi: true, options: FAMILIES.filter(([k]) => (n.model[k] ?? 0) > 0).map(([k, l]) => ({ value: k, label: l, count: n.model[k] })) },
      { id: "city", label: "City", type: "list", collapsed: cities.length > 8, options: cities },
    ];
    return specs;
  },

  onFilter(state: FilterState) {
    const picked = state.agent?.[0];
    const prev = lastState.agent?.[0];
    lastState = state;
    filter = roomFilterFrom(state);
    if (!settling && picked && picked !== prev && picked !== (agentId ?? GRID) && ctx) {
      ctx.showView("room", picked);
      return;
    }
    renderAll();
  },

  onSelect(sel: Selection | null) {
    const c = ctx;
    if (!c || settling || sel?.kind !== "agent") return;
    if (param === GRID) {
      // The grid's own tile click already calls c.selection.set(); just reflect it (highlight).
      renderAll();
      return;
    }
    if (sel.id === agentId) return;
    if (c.store.agents.has(sel.id)) c.showView("room", sel.id);
  },

  onParam(p) {
    param = p;
    renderAll();
  },

  onFocus(on) {
    document.body.classList.toggle("alef-room-focus", on);
    rootEl?.classList.toggle("rm-focus", on);
    requestAnimationFrame(() => syncStage());
  },

  onEscape() {
    if (stopHold !== null) {
      disarmHard();
      say("");
      return true;
    }
    if (overlayKind === "screen" && term && dom?.overlay.contains(document.activeElement)) {
      // Esc typed into the live terminal belongs to the agent (xterm already sent it): keep it open.
      return true;
    }
    if (overlayKind) {
      closeOverlay();
      return true;
    }
    if (param === GRID && gridHasOpenTalk()) {
      closeAllGridTalk();
      scheduleRender();
      return true;
    }
    return false;
  },
};
