// Pure logic for the #/room/all 3D village diorama (no DOM, no THREE): which agents get a room
// and where it sits on the iso ring, which rope bridges are real, the orbit-limited camera's
// spherical maths, and the Town square feed. Unit-tested in village-lib.test.ts.
//
// Bridge honesty (Alex's brief): a bridge is only ever drawn from something we actually
// observed —
//   (a) "repo"    — two shown agents share a repo (WorldAgent.islandId): repoBridges.
//   (b) "spawn"   — a running subagent, tethered to its parent's own room (see droneOffsets;
//                   this is a short local tether, not a cross-village bridge, because the
//                   subagent is drawn right beside its parent, never as its own room).
//   (c) "message" — server/features/village.ts resolved BOTH ends of a SendMessage/
//                   cross-session-message to a session id that is one of the rooms currently
//                   on stage: messageBridges. Unresolved names never draw a bridge.

import type { SubagentStatus } from "../../../shared/features/subagents";
import type { VillageMessage } from "../../../shared/features/village";
import type { WorldAgent } from "../../../shared/types";
import { redactOn } from "../redact";
import { gridSizeFrom, orderAgents, tileAgents, type AgentFacts } from "./room-lib";

// ---------------------------------------------------------------- room selection (reuses room-lib)

/** Which agents get a room, in order, capped for perf. Exactly the flat grid's own
 *  ordering/pins/grid-size logic (room-lib.ts), so the two views never disagree on "who's shown". */
export function villageAgents<T extends WorldAgent>(agents: readonly T[], facts: (id: string) => AgentFacts, pinnedIds: readonly string[], layoutFilter: string | undefined): T[] {
  const size = gridSizeFrom(layoutFilter, agents.length);
  return tileAgents(orderAgents(agents, facts), facts, pinnedIds, size);
}

// ---------------------------------------------------------------- iso ring layout

export interface VillageSlot {
  agentId: string;
  /** Position on the ground plane (world units; village-3d.ts scales/places the plaza at the origin). */
  gx: number;
  gz: number;
  /** Yaw (radians) so the room faces the plaza at the centre. */
  facing: number;
}

const ROOM_SPACING = 5.4; // approx. room footprint + gap, in village-3d.ts's world units
const MIN_RING_RADIUS = 6.2;

/** Ring radius that keeps neighbouring rooms roughly `ROOM_SPACING` apart as the count grows. */
export function ringRadius(n: number): number {
  if (n <= 1) return MIN_RING_RADIUS;
  return Math.max(MIN_RING_RADIUS, (ROOM_SPACING * n) / (2 * Math.PI));
}

/** Evenly spaced around a ring, starting at the top (12 o'clock), clockwise, each facing the
 *  plaza at the origin. Deterministic (same ids in the same order → same layout). */
export function villageSlots(agentIds: readonly string[]): VillageSlot[] {
  const n = agentIds.length;
  if (n === 0) return [];
  const radius = ringRadius(n);
  return agentIds.map((agentId, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const gx = Math.cos(a) * radius;
    const gz = Math.sin(a) * radius;
    return { agentId, gx, gz, facing: Math.atan2(-gx, -gz) };
  });
}

/** The resident's room sits just past the ring, at the top, out of the way of the agents' rooms. */
export function residentSlot(agentCount: number): VillageSlot {
  const radius = ringRadius(Math.max(agentCount, 1)) + 4.6;
  return { agentId: "resident", gx: 0, gz: -radius, facing: 0 };
}

/** Half of a room's own footprint (world units) — the platform's largest dimension, roughly. */
const ROOM_HALF_EXTENT = 2.0;

/** Ground-plane bounding radius of everything the camera must frame: the ring of rooms (each
 *  counted from its centre, plus its own footprint) and, when present, the resident's room
 *  further out. Feeds fitDistance below. */
export function sceneRadius(roomCount: number, hasResident: boolean): number {
  let r = roomCount > 0 ? ringRadius(roomCount) + ROOM_HALF_EXTENT : 3.6;
  if (hasResident) {
    const rs = residentSlot(roomCount);
    r = Math.max(r, Math.hypot(rs.gx, rs.gz) + ROOM_HALF_EXTENT);
  }
  return r;
}

/** The village camera's fixed "design" FOV/aspect (see room-lib.ts's stageProjection): on a
 *  wide/landscape stage the camera sees exactly this vertical FOV at this aspect; a narrow/
 *  portrait stage gets MORE vertical room automatically (stageProjection widens it to keep the
 *  same width), so fitDistance only needs the wide-case numbers to stay correct on both — a
 *  narrow stage ends up with extra headroom, never a crop. */
export const VILLAGE_FOV_DEG = 34;
export const VILLAGE_ASPECT = 1.7;

/**
 * Camera distance (from the plaza at the origin) that frames a ground-plane circle of `radius`
 * at `elevation`, in the design FOV/aspect above. Two constraints, the larger wins:
 *  - horizontal: the ring's full width must fit within the horizontal FOV;
 *  - vertical: the ring's elevation-foreshortened height, plus headroom for the rooms' own
 *    height (walls/plaques stick up), must fit within the vertical FOV.
 */
export function fitDistance(radius: number, elevation: number, roomHeight = 2.6): number {
  const halfV = (VILLAGE_FOV_DEG * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * VILLAGE_ASPECT);
  const dH = radius / Math.tan(halfH);
  const dV = (radius * Math.sin(elevation) + roomHeight / 2) / Math.tan(halfV);
  return Math.max(dH, dV);
}

// ---------------------------------------------------------------- bridges

export type BridgeKind = "repo" | "message";

export interface VillageBridge {
  a: string; // agent id
  b: string; // agent id
  kind: BridgeKind;
}

/** (a) same repo/cwd: chains agents sharing an island into a simple path, not a dense clique, so
 *  a big shared repo doesn't turn into a spaghetti of overlapping ropes. Chains in the CALLER's
 *  order (villageAgents' ring order), not a re-sort by id — same-repo agents are then more often
 *  adjacent on the ring, so the rope tends to hug the ring's edge instead of cutting a long chord
 *  across the plaza. Not a guarantee (ring order is urgency, not repo), just the better default. */
export function repoBridges(agents: readonly { id: string; islandId: string }[]): VillageBridge[] {
  const byIsland = new Map<string, string[]>();
  for (const a of agents) {
    const list = byIsland.get(a.islandId) ?? [];
    list.push(a.id);
    byIsland.set(a.islandId, list);
  }
  const out: VillageBridge[] = [];
  for (const ids of byIsland.values()) for (let i = 1; i < ids.length; i++) out.push({ a: ids[i - 1]!, b: ids[i]!, kind: "repo" });
  return out;
}

/** (c) inter-session messages: a bridge only when BOTH ends resolved to a session id that is
 *  one of the rooms currently on stage (`shownIds`) — an unresolved or off-stage end never
 *  draws anything, per the brief. De-duplicated (one rope per pair, regardless of direction
 *  or how many messages passed between them). */
export function messageBridges(messages: readonly Pick<VillageMessage, "fromSessionId" | "toSessionId">[], shownIds: ReadonlySet<string>): VillageBridge[] {
  const seen = new Set<string>();
  const out: VillageBridge[] = [];
  for (const m of messages) {
    const { fromSessionId: a, toSessionId: b } = m;
    if (!a || !b || a === b || !shownIds.has(a) || !shownIds.has(b)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, kind: "message" });
  }
  return out;
}

/** Nudges a bridge endpoint from a room's centre toward the other room, so the rope touches the
 *  platform's rim instead of running through it. Clamped to 40% of the pair's own distance so two
 *  closely-spaced rooms never invert past each other. */
function edgePoint(fromX: number, fromZ: number, towardX: number, towardZ: number, inset: number): { x: number; z: number } {
  const dx = towardX - fromX;
  const dz = towardZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  const safeInset = Math.min(inset, len * 0.4);
  return { x: fromX + (dx / len) * safeInset, z: fromZ + (dz / len) * safeInset };
}

/** A rope's three control points (edge, slightly sagging middle, edge), y-up, for a
 *  TubeGeometry/CatmullRom curve in village-3d.ts. Endpoints are inset from the room centres
 *  toward each other by `edgeInset` (≈ a room's own half-extent) so the rope runs between the
 *  platforms' rims, not through their centres. Pure so the maths is testable without THREE. */
export function bridgeControlPoints(ax: number, az: number, bx: number, bz: number, deckY = 0.9, sag = 0.22, edgeInset = ROOM_HALF_EXTENT - 0.3): { x: number; y: number; z: number }[] {
  const a = edgePoint(ax, az, bx, bz, edgeInset);
  const b = edgePoint(bx, bz, ax, az, edgeInset);
  return [
    { x: a.x, y: deckY, z: a.z },
    { x: (a.x + b.x) / 2, y: deckY - sag, z: (a.z + b.z) / 2 },
    { x: b.x, y: deckY, z: b.z },
  ];
}

// ---------------------------------------------------------------- subagent tethers (type b)

export const MAX_VILLAGE_DRONES = 4;

export interface DroneOffset {
  index: number;
  dx: number;
  dz: number;
}

/** Where up to `max` of a room's running subagents pop out beside it (a short local tether, not
 *  a cross-village bridge — see the header). The rest become a "+N" the caller can render. */
export function droneOffsets(count: number, max = MAX_VILLAGE_DRONES): DroneOffset[] {
  const shown = Math.max(0, Math.min(count, max));
  const out: DroneOffset[] = [];
  for (let i = 0; i < shown; i++) {
    const a = (i / shown) * Math.PI * 2;
    out.push({ index: i, dx: Math.cos(a) * 1.6, dz: Math.sin(a) * 1.6 });
  }
  return out;
}

// ---------------------------------------------------------------- orbit-limited camera

export interface OrbitState {
  azimuth: number; // radians, around Y
  elevation: number; // radians above the ground plane
  distance: number;
}

// Default elevation ~40° (the requested "iso-ish 35-45°" band) so a room's plaque/desk/monitor/
// creature reads face-on, like the AI Village reference, instead of a steep top-down look.
// `distance` is a placeholder overwritten by the first setData (village-3d.ts fits it to the
// actual room count via fitDistance, above) — it only matters before any data has arrived.
export const ORBIT_BASE: OrbitState = { azimuth: Math.PI / 4, elevation: (40 * Math.PI) / 180, distance: 22 };
export const ORBIT_LIMITS = {
  azimuthSpan: (35 * Math.PI) / 180,
  elevMin: (30 * Math.PI) / 180,
  elevMax: (50 * Math.PI) / 180,
  // distMin: close enough to inspect one room. distMax: comfortably covers fitDistance's worst
  // case (9 rooms + the resident, at elevMax) with a little breathing room — see village-lib.test.ts.
  distMin: 5,
  distMax: 45,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Keeps the camera an "isometric-ish" ride, not a free orbit: azimuth stays within `azimuthSpan`
 *  of the base 45°, elevation and distance stay in their own ranges. */
export function clampOrbit(s: OrbitState): OrbitState {
  return {
    azimuth: clamp(s.azimuth, ORBIT_BASE.azimuth - ORBIT_LIMITS.azimuthSpan, ORBIT_BASE.azimuth + ORBIT_LIMITS.azimuthSpan),
    elevation: clamp(s.elevation, ORBIT_LIMITS.elevMin, ORBIT_LIMITS.elevMax),
    distance: clamp(s.distance, ORBIT_LIMITS.distMin, ORBIT_LIMITS.distMax),
  };
}

/** Spherical → cartesian, centred on the plaza at the origin, y-up. */
export function orbitPosition(s: OrbitState): { x: number; y: number; z: number } {
  const r = s.distance * Math.cos(s.elevation);
  return { x: Math.sin(s.azimuth) * r, y: s.distance * Math.sin(s.elevation), z: Math.cos(s.azimuth) * r };
}

// ---------------------------------------------------------------- redaction (?redact=1)

/** Agent titles are already redacted globally (client/src/state.ts, redactAgent) by the time a
 *  view sees them — but VillageMessage is not a WorldAgent, so its free text needs its own pass. */
export function redactMessage(m: VillageMessage): VillageMessage {
  return {
    ...m,
    preview: "…",
    fromRaw: m.fromSessionId ? `agent ${m.fromSessionId.slice(0, 4)}` : "someone",
    toRaw: m.toSessionId ? `agent ${m.toSessionId.slice(0, 4)}` : "someone",
  };
}

export function maybeRedact(m: VillageMessage): VillageMessage {
  return redactOn() ? redactMessage(m) : m;
}

// ---------------------------------------------------------------- Town square feed

export type FeedKind = "message" | "spawn" | "handback";

export interface FeedItem {
  id: string;
  at: string; // ISO
  kind: FeedKind;
  text: string;
}

export function messageFeedItems(messages: readonly VillageMessage[]): FeedItem[] {
  return messages.map((m) => {
    const r = maybeRedact(m);
    return { id: r.id, at: r.at, kind: "message" as const, text: `${r.fromRaw} → ${r.toRaw}: ${r.preview}` };
  });
}

export interface SubagentSpawnFact {
  id: string;
  description: string;
  status: SubagentStatus;
  startedAt: string;
  lastActive: string;
}

export function subagentFeedItems(records: readonly SubagentSpawnFact[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const r of records) {
    const desc = redactOn() ? "a task" : r.description;
    out.push({ id: `${r.id}:spawn`, at: r.startedAt, kind: "spawn", text: `spawned: ${desc}` });
    if (r.status === "done" || r.status === "failed" || r.status === "stopped") {
      out.push({ id: `${r.id}:${r.status}`, at: r.lastActive, kind: "handback", text: `${r.status === "done" ? "handed back" : r.status}: ${desc}` });
    }
  }
  return out;
}

/** Messages + subagent spawns/hand-backs, newest first, capped. */
export function feedItems(messages: readonly VillageMessage[], subagents: readonly SubagentSpawnFact[], limit = 30): FeedItem[] {
  return [...messageFeedItems(messages), ...subagentFeedItems(subagents)].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
