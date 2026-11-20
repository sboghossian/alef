// 🎛️ Multi-room grid: Room's #/room/all (round 11 — merged in from the old, now-removed Control
// room view; see docs/round9-decisions.md and README's "Mission control" section). Several live
// agents' rooms side by side: state, todos, the tail of the live screen, cost, and Open room /
// Talk / Stop / Focus — the same real-data tiles Control room used, reusing Room's own
// bucket/urgency model and grid-sizing/pin helpers (room-lib.ts) so ordering and layout match
// Room exactly ("needs-you first, then live, then most recent"). Flat 2D (an inline SVG
// creature, not the 3D room): no extra WebGL context.
//
// Room (room.ts) owns the mount/unmount lifecycle, the shared filters and the shared selection;
// this file only builds tiles into the host element Room hands it and exposes small entry/exit
// hooks for the "Max view" sidebar fold, so it stays a plain function library, not a view.

import { agentTitle } from "../../../shared/display";
import { CONTROL_NOT_TMUX_ERROR, type ControlResult } from "../../../shared/features/control";
import { TALK_MAX_CHARS } from "../../../shared/features/talk";
import { todoProgress } from "../../../shared/features/todos";
import type { WorldAgent } from "../../../shared/types";
import { STATE_LABELS } from "../features/agent-state";
import { h, isRecord } from "../features/fleet-overlay";
import { formatCount, shortModel } from "../features/subagent-data";
import { sendTalk } from "../features/talk";
import { todoListFor } from "../features/todos";
import { formatUsd } from "../features/usage-format";
import { relativeTime } from "../ui/fuzzy";
import { safeLocalStorage } from "../ui/kit";
import type { FilterOption, FilterSpec, FilterState, ViewContext } from "../shell/views";
import {
  autoGridSize,
  gridDims,
  gridSizeFrom,
  lampMood,
  MANUAL_GRID_SIZES,
  modelKey,
  orderAgents,
  PinStore,
  progressLabel,
  progressPct,
  roomBucket,
  shortCwd,
  tileAgents,
  type AgentFacts,
  type RoomBucket,
} from "./room-lib";
import { creatureSvg, FAMILY_HEX } from "./room-art";

const SCREEN_LINES = 8;
const COST_REFRESH_MS = 45_000;
const PIN_CANDIDATES_MAX = 30;

let pins: PinStore | null = null;
/** Exported: views/village-3d.ts's DOM action dock (the selected room's Talk button) shares
 *  this open/closed set with the flat grid's tiles, so switching Diorama ⇄ List view keeps it. */
export const talkOpen = new Set<string>();
const costByAgent = new Map<string, number>();
const costFetchedAt = new Map<string, number>();
/** The sidebar's "Pin to a tile" section host: the shell calls the FilterSpec's `render(host)`
 *  once and keeps that element across refreshFilters() ("the view updates it in place" — see
 *  shell/views.ts's FilterSpec doc), so `renderGrid` below re-renders into this saved reference
 *  on every real render pass, exactly like the old Control room view did. */
let pinHostEl: HTMLElement | null = null;

// "Max view": folds both sidebars while the grid is up. Owned here (not Room) since it is
// entirely about this mode's lifecycle.
let prevSidebars: { left: boolean; right: boolean } | null = null;
let maxOn = true;

function pinStore(): PinStore {
  if (!pins) pins = new PinStore(safeLocalStorage());
  return pins;
}

/** Exported: views/village-3d.ts's diorama picks the same rooms as this flat grid, so it needs
 *  the same pin order (see village-lib.ts's villageAgents). */
export function pinnedIds(): readonly string[] {
  return pinStore().list();
}

function isInteractive(ev: Event): boolean {
  return ev.target instanceof HTMLElement && ev.target.closest("button, input, form, a") !== null;
}

// ---------------------------------------------------------------- usage (cost/tokens)

function parseCostUsd(v: unknown): number | null {
  if (!isRecord(v) || v.ok !== true || typeof v.totalCostUsd !== "number") return null;
  return v.totalCostUsd;
}

function ensureCost(c: ViewContext, id: string, onChange: () => void): void {
  const last = costFetchedAt.get(id) ?? 0;
  if (Date.now() - last < COST_REFRESH_MS) return;
  costFetchedAt.set(id, Date.now());
  void c.api.getJson<unknown>(`/api/usage/session/${encodeURIComponent(id)}`).then((raw) => {
    const cost = parseCostUsd(raw);
    if (cost !== null) costByAgent.set(id, cost);
    onChange();
  });
}

// ---------------------------------------------------------------- actions

export async function stopAgent(c: ViewContext, id: string): Promise<void> {
  const r = await c.api.postJson<ControlResult>(`/api/agents/${encodeURIComponent(id)}/interrupt`, {}, (error) => ({ ok: false, error }));
  c.toast(r.ok ? `Sent Esc to ${r.tmuxName ?? "its tmux session"}.` : `Not stopped: ${r.error ?? "unknown error"}`, r.ok ? "info" : "error");
}

export function focusAgent(c: ViewContext, id: string): void {
  c.selection.set({ kind: "agent", id });
  c.showView("orbit");
  c.planet.flyToAgent(id);
  c.focus.set(true);
}

export function toggleTalk(id: string, onChange: () => void): void {
  if (talkOpen.has(id)) talkOpen.delete(id);
  else talkOpen.add(id);
  onChange();
}

export function talkForm(c: ViewContext, a: WorldAgent): HTMLElement {
  const form = h("form", "cr-talk");
  const input = h("input", "cr-talk-input");
  input.type = "text";
  input.maxLength = TALK_MAX_CHARS;
  input.placeholder = "Say something…";
  input.setAttribute("aria-label", `Message to ${agentTitle(a) || a.id}`);
  const send = h("button", "comic-btn small", "Send");
  send.type = "submit";
  const status = h("span", "cr-talk-status");
  status.setAttribute("role", "status");
  form.append(input, send, status);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    void sendTalk(c, a.id, text).then((r) => {
      send.disabled = false;
      status.textContent = r.ok ? "Sent." : `Failed: ${r.error ?? "unknown error"}`;
      if (r.ok) input.value = "";
    });
  });
  return form;
}

// ---------------------------------------------------------------- tiles

function screenLines(c: ViewContext, a: WorldAgent): HTMLElement {
  const box = h("div", "cr-screen");
  const acts = c.store.activities.filter((x) => x.agentId === a.id).slice(-SCREEN_LINES);
  if (!acts.length) {
    box.append(h("p", "cr-screen-empty", a.status === "live" ? "Quiet since this page loaded." : `Asleep · last active ${relativeTime(a.lastActive)}`));
    return box;
  }
  for (const x of acts) {
    const line = h("div", "cr-line");
    const dot = h("i", `stage-dot ${x.stage}`);
    dot.title = x.stage;
    line.append(dot, h("span", "cr-line-text", x.summary));
    box.append(line);
  }
  return box;
}

/** Open room / Talk / Stop / Focus for one agent — shared by the flat grid's tiles
 *  (buildTile, below) and views/village-3d.ts's compact "selected room" action dock, via room.ts,
 *  so both #/room/all sub-views offer exactly the same reachable actions. */
export function buildActionsBar(c: ViewContext, a: WorldAgent, bound: boolean, onChange: () => void): HTMLElement {
  const id = a.id;
  const actions = h("div", "cr-actions");
  const openBtn = h("button", "comic-btn small", "Open room");
  openBtn.type = "button";
  openBtn.title = "Open this agent's full Room";
  openBtn.addEventListener("click", () => c.showView("room", id));

  const talkBtn = h("button", "comic-btn small secondary", "Talk");
  talkBtn.type = "button";
  talkBtn.disabled = !bound;
  talkBtn.title = bound ? "Send it a message (types into its tmux session)" : "Only world-launched agents (tmux) can be talked to from here";
  talkBtn.setAttribute("aria-pressed", String(talkOpen.has(id)));
  talkBtn.addEventListener("click", () => toggleTalk(id, onChange));

  const stopBtn = h("button", "comic-btn small secondary", "Stop (Esc)");
  stopBtn.type = "button";
  const canStop = bound && a.status === "live";
  stopBtn.disabled = !canStop;
  stopBtn.title = bound ? "Interrupt: sends Esc to its tmux session. Never kills it." : `Only world-launched agents can be stopped from here (${CONTROL_NOT_TMUX_ERROR}).`;
  stopBtn.addEventListener("click", () => void stopAgent(c, id));

  const focusBtn = h("button", "comic-btn small secondary", "Focus");
  focusBtn.type = "button";
  focusBtn.title = "Fly to this agent on the planet and lock focus on it";
  focusBtn.addEventListener("click", () => focusAgent(c, id));

  actions.append(openBtn, talkBtn, stopBtn, focusBtn);
  return actions;
}

function buildTile(
  c: ViewContext,
  a: WorldAgent,
  facts: (id: string) => AgentFacts,
  cityName: (id: string) => string,
  selected: string | null,
  onChange: () => void,
): HTMLElement {
  const id = a.id;
  const st = facts(id).state ?? (a.status === "live" ? (a.awaitingInput ? "waiting" : "idle") : "sleeping");
  const bucket: RoomBucket = roomBucket(a, facts(id).state);
  const bound = facts(id).hasTerminal;

  const tile = h("article", "cr-tile");
  tile.dataset.agent = id;
  tile.classList.toggle("cr-waiting", bucket === "waiting");
  tile.classList.toggle("cr-selected", id === selected);
  tile.classList.toggle("cr-pinned", pinStore().has(id));
  tile.title = `${agentTitle(a)}\nClick to select · double-click to open its room`;

  const head = h("header", "cr-tile-head");
  const art = h("div", "cr-art");
  art.style.setProperty("--cr-accent", FAMILY_HEX[modelKey(a.model)]);
  art.innerHTML = creatureSvg(modelKey(a.model), lampMood(a, facts(id).state));
  const titles = h("div", "cr-titles");
  titles.append(h("div", "cr-title", agentTitle(a) || shortCwd(a.cwd)), h("div", "cr-sub", `${cityName(a.islandId)} · ${shortModel(a.model)} · ${relativeTime(a.lastActive)}`));
  head.append(art, titles, h("span", `as-chip as-${st}`, STATE_LABELS[st]));

  const list = todoListFor(c, id);
  const prog = list && list.items.length ? todoProgress(list) : { done: 0, total: 0, current: null };
  const bar = h("div", "cr-bar");
  const fill = h("div", "cr-bar-fill");
  fill.style.width = `${progressPct(prog.done, prog.total)}%`;
  bar.append(fill);
  const todoRow = h("div", "cr-todo");
  todoRow.append(bar, h("span", "cr-todo-label", progressLabel(prog.done, prog.total)));

  const usage = h("div", "cr-usage");
  usage.append(h("span", "cr-usage-cost", costByAgent.has(id) ? formatUsd(costByAgent.get(id)!) : "…"), h("span", "cr-usage-tok", `${formatCount(a.tokens)} tok`));

  const actions = buildActionsBar(c, a, bound, onChange);

  tile.append(head, todoRow, screenLines(c, a), usage, actions);
  if (talkOpen.has(id)) tile.append(talkForm(c, a));

  tile.addEventListener("click", (ev) => {
    if (isInteractive(ev)) return;
    c.selection.set({ kind: "agent", id });
  });
  tile.addEventListener("dblclick", (ev) => {
    if (isInteractive(ev)) return;
    c.showView("room", id);
  });
  return tile;
}

// ---------------------------------------------------------------- pin list (sidebar section)

function pinCandidates(c: ViewContext, facts: (id: string) => AgentFacts): WorldAgent[] {
  const all = [...c.store.agents.values()].filter((a) => roomBucket(a, facts(a.id).state) !== "dormant" || pinStore().has(a.id));
  return orderAgents(all, facts).slice(0, PIN_CANDIDATES_MAX);
}

function pinRow(c: ViewContext, a: WorldAgent, facts: (id: string) => AgentFacts, cityName: (id: string) => string, selected: string | null, onChange: () => void): HTMLElement {
  const id = a.id;
  const li = h("li", "alef-frow-li");
  const b = h("button", "alef-frow");
  b.type = "button";
  b.classList.toggle("on", id === selected);
  b.setAttribute("aria-pressed", String(id === selected));
  b.title = agentTitle(a);
  const text = h("span", "alef-frow-text");
  const st = facts(id).state ?? (a.status === "live" ? (a.awaitingInput ? "waiting" : "idle") : "sleeping");
  text.append(h("span", "alef-flabel", agentTitle(a) || shortCwd(a.cwd)), h("span", "alef-fmeta", `${cityName(a.islandId)} · ${STATE_LABELS[st]}`));
  b.append(text);
  b.addEventListener("click", () => c.selection.set({ kind: "agent", id }));
  li.append(b);
  const pinned = pinStore().has(id);
  const pin = h("button", "alef-pin", pinned ? "★" : "☆");
  pin.type = "button";
  pin.classList.toggle("on", pinned);
  pin.setAttribute("aria-pressed", String(pinned));
  pin.setAttribute("aria-label", pinned ? `Unpin ${agentTitle(a)} from a tile` : `Pin ${agentTitle(a)} to a tile`);
  pin.title = pinned ? "Unpin from a tile" : "Pin to a tile (always shown, top priority)";
  pin.addEventListener("click", () => {
    pinStore().toggle(id, (x) => c.store.agents.has(x));
    onChange();
  });
  li.append(pin);
  return li;
}

function renderPinList(c: ViewContext, host: HTMLElement, facts: (id: string) => AgentFacts, cityName: (id: string) => string, selected: string | null, onChange: () => void): void {
  const rows = pinCandidates(c, facts);
  const ul = h("ul", "alef-flist cr-pin-list");
  for (const a of rows) ul.append(pinRow(c, a, facts, cityName, selected, onChange));
  if (!rows.length) ul.append(h("li", "alef-sec-empty", "No agents to pin yet."));
  host.replaceChildren(ul);
}

// ---------------------------------------------------------------- filters (Layout + pins)

/** The "Layout" grid-size picker + the "pins" pin-to-a-tile section, spliced into Room's own
 *  filters() only while #/room/all is showing (Room already has its own Agent/State/Model/City
 *  filters, which apply to the grid the same way they apply to a single room). */
export function gridFilterSpecs(c: ViewContext, facts: (id: string) => AgentFacts, cityName: (id: string) => string, selected: string | null, onChange: () => void): FilterSpec[] {
  const options: FilterOption[] = [{ value: "auto", label: `Auto (${autoGridSize(c.store.agents.size)})` }, ...MANUAL_GRID_SIZES.map((n) => ({ value: String(n), label: String(n) }))];
  return [
    { id: "layout", label: "Layout", type: "segmented", default: ["auto"], options },
    {
      id: "grid-pins",
      label: "Pin to a tile",
      type: "section",
      render: (host) => {
        pinHostEl = host;
        renderPinList(c, host, facts, cityName, selected, onChange);
      },
    },
  ];
}

// ---------------------------------------------------------------- render

export interface GridRenderResult {
  count: number;
  shown: number;
}

/** Builds the header + `.cr-grid` of tiles into `host` (Room's own `.rm-grid` section). */
export function renderGrid(
  c: ViewContext,
  host: HTMLElement,
  list: readonly WorldAgent[],
  facts: (id: string) => AgentFacts,
  cityName: (id: string) => string,
  state: FilterState,
  selected: string | null,
  onChange: () => void,
  /** Set by room.ts when the 3D village diorama is available: renders a "🏘 Diorama" button so
   *  this flat list (the diorama's List-view fallback) can switch back in one click. */
  onShowDiorama?: () => void,
): GridRenderResult {
  pinStore().prune((id) => c.store.agents.has(id));
  const size = gridSizeFrom(state.layout?.[0], list.length);
  const tiles = tileAgents(list, facts, pinStore().list(), size);
  const dims = gridDims(size);

  const head = h("header", "rm-grid-head");
  head.append(h("h2", undefined, `Every room (${list.length})`));
  if (onShowDiorama) {
    const dioramaBtn = h("button", "comic-btn small secondary", "🏘 Village view");
    dioramaBtn.type = "button";
    dioramaBtn.title = "Switch to the 3D village of rooms (remembered)";
    dioramaBtn.addEventListener("click", onShowDiorama);
    head.append(dioramaBtn);
  }
  const maxBtn = h("button", "comic-btn small secondary cr-max-btn", "Max view");
  maxBtn.type = "button";
  updateMaxBtn(maxBtn);
  maxBtn.addEventListener("click", () => {
    toggleMax(c);
    updateMaxBtn(maxBtn);
  });
  head.append(maxBtn);
  const sub = h("span", "rm-grid-sub", tiles.length ? `${tiles.length} of ${list.length} shown · click a tile to select, double-click to open its room` : "0 agents shown");
  head.append(sub);

  const grid = h("div", "cr-grid");
  grid.style.setProperty("--cr-cols", String(dims.cols));
  grid.setAttribute("aria-label", "Agent tiles");
  if (tiles.length) {
    grid.append(...tiles.map((a) => buildTile(c, a, facts, cityName, selected, onChange)));
    for (const a of tiles) ensureCost(c, a.id, onChange);
  } else {
    grid.classList.add("cr-grid-empty");
    grid.append(h("p", "cr-empty", "No agents match the filters. Turn on 💤 Dormant in the sidebar, or clear the state filter."));
  }
  host.replaceChildren(head, grid);
  if (pinHostEl) renderPinList(c, pinHostEl, facts, cityName, selected, onChange);
  return { count: tiles.length, shown: list.length };
}

// ---------------------------------------------------------------- lifecycle (Max view + reset)

function updateMaxBtn(btn: HTMLButtonElement): void {
  btn.classList.toggle("on", maxOn);
  btn.setAttribute("aria-pressed", String(maxOn));
  btn.title = maxOn ? "Sidebars are folded to maximise the grid: click to show them" : "Fold both sidebars to maximise the grid";
}

function toggleMax(c: ViewContext): void {
  maxOn = !maxOn;
  if (maxOn) c.sidebars.setOpen({ left: false, right: false });
  else c.sidebars.setOpen(prevSidebars ?? { left: true, right: true });
}

/** Entering #/room/all: remember the sidebars' state and fold them if "Max view" is on. */
export function enterGridMode(c: ViewContext): void {
  prevSidebars = c.sidebars.open();
  if (maxOn) c.sidebars.setOpen({ left: false, right: false });
}

/** Leaving #/room/all (a single agent's room, or the view entirely): restore the sidebars. */
export function exitGridMode(c: ViewContext): void {
  if (prevSidebars) c.sidebars.setOpen(prevSidebars);
  prevSidebars = null;
  pinHostEl = null;
}

export function gridHasOpenTalk(): boolean {
  return talkOpen.size > 0;
}

export function closeAllGridTalk(): void {
  talkOpen.clear();
}
