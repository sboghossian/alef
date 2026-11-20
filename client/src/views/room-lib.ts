// Pure logic for the 🚪 Room view (no DOM, no THREE): which agents show, in what order, and
// how real data maps to the room's props (plant ← tokens, clock ← uptime, sticky notes ←
// todos, lamp ← state). Unit-tested in room-lib.test.ts.

import type { AgentState } from "../../../shared/features/agent-state";
import type { TodoItem, TodoList } from "../../../shared/features/todos";
import type { WorldAgent } from "../../../shared/types";
import type { FilterState } from "../shell/views";

/** The three buckets of the sidebar's state filter. */
export type RoomBucket = "live" | "waiting" | "dormant";
export const ROOM_BUCKETS: readonly RoomBucket[] = ["live", "waiting", "dormant"];
/** Only active agents' insides by default; dormant ones via the filter. */
export const DEFAULT_BUCKETS: readonly RoomBucket[] = ["live", "waiting"];

export type ModelKey = "opus" | "sonnet" | "haiku" | "fable" | "other";

export function modelKey(model: string | null | undefined): ModelKey {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "other";
}

export function roomBucket(agent: Pick<WorldAgent, "status" | "awaitingInput">, state: AgentState | undefined): RoomBucket {
  if (agent.status !== "live") return "dormant";
  if (agent.awaitingInput || state === "waiting" || state === "permission") return "waiting";
  return "live";
}

/** What the view needs to know about one agent beyond WorldAgent (read live from the features). */
export interface AgentFacts {
  state: AgentState | undefined;
  /** A world-launched tmux session is bound to it: a live terminal is possible. */
  hasTerminal: boolean;
}

export interface RoomFilter {
  buckets: readonly RoomBucket[];
  city: string | null;
  models: readonly ModelKey[];
  terminalOnly: boolean;
}

const MODEL_KEYS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable", "other"]);

/** Sidebar FilterState → RoomFilter. An empty state chip set means "the default" (active only). */
export function roomFilterFrom(state: FilterState): RoomFilter {
  const b = (state.state ?? []).filter((v): v is RoomBucket => (ROOM_BUCKETS as readonly string[]).includes(v));
  return {
    buckets: b.length ? b : DEFAULT_BUCKETS,
    city: state.city?.[0] ?? null,
    models: (state.model ?? []).filter((v): v is ModelKey => MODEL_KEYS.has(v)),
    terminalOnly: (state.terminal ?? []).includes("on"),
  };
}

export function matchesFilter(agent: WorldAgent, facts: AgentFacts, f: RoomFilter): boolean {
  if (!f.buckets.includes(roomBucket(agent, facts.state))) return false;
  if (f.city && agent.islandId !== f.city) return false;
  if (f.models.length && !f.models.includes(modelKey(agent.model))) return false;
  if (f.terminalOnly && !facts.hasTerminal) return false;
  return true;
}

/** Lower sorts first: agents that need you, then busy, then quiet, then asleep. */
export function urgency(agent: Pick<WorldAgent, "status" | "awaitingInput">, state: AgentState | undefined): number {
  if (agent.status !== "live") return 5;
  if (state === "permission") return 0;
  if (agent.awaitingInput || state === "waiting") return 1;
  if (state === "working") return 2;
  return 3;
}

/** The agent picker's order: urgency, then most recently active, then id (stable). */
export function orderAgents<T extends WorldAgent>(agents: readonly T[], facts: (id: string) => AgentFacts): T[] {
  return [...agents].sort((a, b) => {
    const u = urgency(a, facts(a.id).state) - urgency(b, facts(b.id).state);
    if (u) return u;
    if (a.lastActive !== b.lastActive) return a.lastActive < b.lastActive ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Which agent's room to show: the requested one if it exists, else the first in the picker. */
export function pickAgent(requested: string | null, ordered: readonly Pick<WorldAgent, "id">[], exists: (id: string) => boolean): string | null {
  if (requested && exists(requested)) return requested;
  return ordered[0]?.id ?? null;
}

/** Next / previous agent in the picker, wrapping. */
export function stepAgent(ordered: readonly Pick<WorldAgent, "id">[], current: string | null, dir: 1 | -1): string | null {
  if (!ordered.length) return null;
  const i = ordered.findIndex((a) => a.id === current);
  if (i < 0) return ordered[0]!.id;
  return ordered[(i + dir + ordered.length) % ordered.length]!.id;
}

// ---------------------------------------------------------------- props from data

/** Token thresholds for the plant: seed, sprout, leafy, bushy, blooming, tree. */
export const PLANT_STEPS = [0, 20_000, 200_000, 1_000_000, 5_000_000, 20_000_000] as const;
export const PLANT_NAMES = ["seed", "sprout", "leafy", "bushy", "blooming", "tree"] as const;
export type PlantStage = 0 | 1 | 2 | 3 | 4 | 5;

/** The plant grows with the session's tokens. Negative / NaN tokens are a seed. */
export function plantStage(tokens: number): PlantStage {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  let s = 0;
  for (let i = 0; i < PLANT_STEPS.length; i++) if (tokens >= PLANT_STEPS[i]!) s = i;
  return s as PlantStage;
}

/** Session uptime for the wall clock: "42m", "3h 05m", "2d 4h". Null for bad dates. */
export function uptime(startedAt: string, nowMs: number): string | null {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 48) return `${hrs}h ${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/** Clock hand angles (degrees, 12 o'clock = 0) for the session's uptime: the hour hand turns once per 12h. */
export function clockHands(startedAt: string, nowMs: number): { hour: number; minute: number } | null {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, (nowMs - t) / 60_000);
  return { hour: ((min / 720) * 360) % 360, minute: ((min % 60) / 60) * 360 };
}

export interface StickyNote {
  text: string;
  status: TodoItem["status"];
  /** Paper colour class: now (yellow), next (pink), done (green). */
  tone: "now" | "next" | "done";
}

export const MAX_NOTES = 9;

/** Sticky notes on the board = the agent's live todos, in its own order. Done items fold last when
 *  the board is full so the open work stays visible. */
export function stickyNotes(list: TodoList | undefined, max = MAX_NOTES): { notes: StickyNote[]; hidden: number } {
  const items = list?.items ?? [];
  const open = items.filter((i) => i.status !== "completed");
  const done = items.filter((i) => i.status === "completed");
  const ordered = items.length > max ? [...open, ...done] : items;
  const notes = ordered.slice(0, max).map((i) => ({
    text: i.status === "in_progress" && i.activeForm ? i.activeForm : i.content,
    status: i.status,
    tone: i.status === "in_progress" ? ("now" as const) : i.status === "completed" ? ("done" as const) : ("next" as const),
  }));
  return { notes, hidden: Math.max(0, items.length - notes.length) };
}

export type LampMood = "busy" | "ask" | "alarm" | "calm" | "sleep";

/** The room's lighting follows the agent's state (always bright; asleep is soft lilac, never dark). */
export function lampMood(agent: Pick<WorldAgent, "status" | "awaitingInput">, state: AgentState | undefined): LampMood {
  if (agent.status !== "live") return "sleep";
  if (state === "permission") return "alarm";
  if (agent.awaitingInput || state === "waiting") return "ask";
  if (state === "working") return "busy";
  return "calm";
}

/** Folder-ish short name of a cwd: "/Users/x/Documents/Code/agent-world" → "agent-world". */
export function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Validates a note before it is sent (the server re-checks it). */
export const NOTE_MAX = 2000;
export function noteError(text: string): string | null {
  const t = text.trim();
  if (!t) return "Write something first.";
  if (t.length > NOTE_MAX) return `Keep it under ${NOTE_MAX} characters.`;
  return null;
}

// ---------------------------------------------------------------- 3D room maths (pure)

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The 3D room is drawn on the full shared canvas, but only the stage (the main view area minus
 * our bars) is really visible. Returns the camera's full-canvas vertical FOV and the view offset
 * that centre the room in the stage and fit its designed aspect (`roomAspect`) inside it.
 */
export function stageProjection(
  canvasW: number,
  canvasH: number,
  stage: Rect,
  roomFovDeg = 40,
  roomAspect = 1.55,
): { fov: number; offsetX: number; offsetY: number } {
  const sw = Math.max(1, stage.width);
  const sh = Math.max(1, stage.height);
  const a = sw / sh;
  const half = (roomFovDeg * Math.PI) / 360;
  // Narrow stage: widen the vertical FOV so the room's width still fits.
  const roomHalf = a < roomAspect ? Math.atan((Math.tan(half) * roomAspect) / a) : half;
  const fullHalf = Math.atan((Math.tan(roomHalf) * Math.max(1, canvasH)) / sh);
  const fov = Math.min(150, (fullHalf * 360) / Math.PI);
  return {
    fov,
    offsetX: canvasW / 2 - (stage.left + sw / 2),
    offsetY: canvasH / 2 - (stage.top + sh / 2),
  };
}

export interface CreatureMotion {
  /** Lift above the seat (units). */
  y: number;
  /** Side-to-side tilt (radians). */
  roll: number;
  /** Turn (radians, 0 = facing the camera). */
  yaw: number;
  /** Vertical squash (1 = none). */
  squash: number;
}

/** How the agent's creature moves for its state at time `t` (seconds). Deterministic. */
export function creatureMotion(mood: LampMood, t: number): CreatureMotion {
  switch (mood) {
    case "busy": // typing at the desk: quick bob, turned towards the monitor
      return { y: Math.abs(Math.sin(t * 7)) * 0.08, roll: Math.sin(t * 7) * 0.05, yaw: 0.55 + Math.sin(t * 1.3) * 0.08, squash: 1 - Math.abs(Math.sin(t * 7)) * 0.04 };
    case "ask": // hopping, facing you
      return { y: Math.max(0, Math.sin(t * 4.2)) * 0.45, roll: 0, yaw: Math.sin(t * 0.8) * 0.12, squash: 1 + Math.max(0, Math.sin(t * 4.2)) * 0.06 };
    case "alarm": // shaking on the spot
      return { y: Math.abs(Math.sin(t * 11)) * 0.06, roll: Math.sin(t * 22) * 0.12, yaw: Math.sin(t * 3) * 0.2, squash: 1 };
    case "calm": // breathing, looking around now and then
      return { y: Math.sin(t * 1.6) * 0.03, roll: 0, yaw: Math.sin(t * 0.45) * 0.6, squash: 1 + Math.sin(t * 1.6) * 0.025 };
    case "sleep": // curled up, slow breaths
      return { y: -0.18, roll: 0.35, yaw: 0.2, squash: 0.82 + Math.sin(t * 0.9) * 0.03 };
  }
}

/** Shelf slots: `n` items spread over `planks` planks, `perPlank` each, filling the top plank first. */
export function shelfSlots(n: number, planks: number, perPlank: number): { plank: number; slot: number }[] {
  const out: { plank: number; slot: number }[] = [];
  for (let i = 0; i < Math.min(n, planks * perPlank); i++) out.push({ plank: Math.floor(i / perPlank), slot: i % perPlank });
  return out;
}

/** The lamp's light colour and strength per mood (never dark: asleep is a soft lilac). */
export function lampLight(mood: LampMood): { color: number; intensity: number } {
  switch (mood) {
    case "busy":
      return { color: 0xffd36b, intensity: 2.2 };
    case "ask":
      return { color: 0xffb21e, intensity: 2.4 };
    case "alarm":
      return { color: 0xff5d8f, intensity: 2.6 };
    case "calm":
      return { color: 0x9fe3ff, intensity: 1.6 };
    case "sleep":
      return { color: 0xcbb8ff, intensity: 1.2 };
  }
}

// ---------------------------------------------------------------- multi-room grid (round 11:
// merged in from the old Control room view — see room-grid.ts). Grid sizing, tile ordering /
// assignment, and a tiny injectable pin store. Reuses this file's own bucket/urgency model —
// "live first, waiting-on-you pinned top-left, then most recent" is exactly `orderAgents`'s
// order — instead of re-deriving it.

export type GridSize = 1 | 2 | 4 | 6 | 9;
export const GRID_SIZES: readonly GridSize[] = [1, 2, 4, 6, 9];
/** The manual picker's non-auto options (1 up is never a manual choice: Auto already covers it). */
export const MANUAL_GRID_SIZES: readonly GridSize[] = [2, 4, 6, 9];

/** How many tiles fit the agent count when nothing is picked manually. */
export function autoGridSize(count: number): GridSize {
  if (Number.isNaN(count)) return 1;
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 4;
  if (count <= 6) return 6;
  return 9;
}

/** Columns × rows for a grid size (always exact: 1×1, 2×1, 2×2, 3×2, 3×3). */
export function gridDims(size: GridSize): { cols: number; rows: number } {
  switch (size) {
    case 1:
      return { cols: 1, rows: 1 };
    case 2:
      return { cols: 2, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 6:
      return { cols: 3, rows: 2 };
    case 9:
      return { cols: 3, rows: 3 };
  }
}

/** The sidebar's "layout" filter value ("auto" | "2" | "4" | "6" | "9") → the grid size to use. */
export function gridSizeFrom(manual: string | undefined, count: number): GridSize {
  const n = Number(manual);
  if (manual && manual !== "auto" && (MANUAL_GRID_SIZES as readonly number[]).includes(n)) return n as GridSize;
  return autoGridSize(count);
}

/**
 * Which agents fill the grid, in order: pinned agents first (in pin order), then the rest in
 * Room's order (needs-you first, then live, then most recent), capped at `size` tiles.
 */
export function tileAgents<T extends WorldAgent>(agents: readonly T[], facts: (id: string) => AgentFacts, pinnedIds: readonly string[], size: GridSize): T[] {
  const ordered = orderAgents(agents, facts);
  const byId = new Map(ordered.map((a) => [a.id, a] as const));
  const pinned: T[] = [];
  for (const id of pinnedIds) {
    const a = byId.get(id);
    if (a) {
      pinned.push(a);
      byId.delete(id);
    }
  }
  const rest = ordered.filter((a) => byId.has(a.id));
  return [...pinned, ...rest].slice(0, size);
}

/** The minimal storage surface the pin store needs (matches client/src/ui/kit's FlagStore). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PIN_STORE_KEY = "alef.control-room.pins";

export function parsePinIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Which agents are pinned to a tile, in pin order. Blocked/absent storage = no pins, never throws. */
export class PinStore {
  private ids: string[];

  constructor(
    private readonly store: KeyValueStore | null,
    private readonly key: string = PIN_STORE_KEY,
  ) {
    this.ids = this.read();
  }

  private read(): string[] {
    try {
      return parsePinIds(this.store?.getItem(this.key) ?? null);
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.ids));
    } catch {
      /* private mode: pins just don't persist */
    }
  }

  list(): readonly string[] {
    return this.ids;
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Pin (appended to the end) or unpin `id`; drops ids that no longer exist. */
  toggle(id: string, exists: (id: string) => boolean): void {
    this.ids = this.ids.filter(exists);
    this.ids = this.has(id) ? this.ids.filter((x) => x !== id) : [...this.ids, id];
    this.write();
  }

  /** Drop pins whose agent is gone (called once per render pass; cheap, no-op when nothing changed). */
  prune(exists: (id: string) => boolean): void {
    const next = this.ids.filter(exists);
    if (next.length !== this.ids.length) {
      this.ids = next;
      this.write();
    }
  }
}

/** "3/7" progress label, or "–" when there is no todo list yet. */
export function progressLabel(done: number, total: number): string {
  return total > 0 ? `${done}/${total}` : "–";
}

/** 0..100 fill percentage for the progress bar (0 when there is no list). */
export function progressPct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * True when an event passed through any of `roots` (the village's own DOM over the 3D stage). It
 * reads the event's composed path, which is fixed when dispatch starts: a click on a button that
 * its own handler just detached (a Town square tab re-rendering the panel) still counts, where
 * `root.contains(ev.target)` says no and lets the click fall through to a room behind the panel.
 */
export function eventPassedThrough(ev: { composedPath(): EventTarget[] }, roots: readonly (EventTarget | null | undefined)[]): boolean {
  const path = ev.composedPath();
  return roots.some((r) => r != null && path.includes(r));
}
