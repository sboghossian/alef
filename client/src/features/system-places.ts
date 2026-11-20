// The System Quarter (round 11 C): physical places for the parts of the system you can't see
// in a session — four hook gates, the Jev tower (router + director), the CLI station, four model
// power plants and the three memory buildings (episodic archive, semantic library, procedural
// workshop) — on an arc just outside Harness City, plus live traffic: every real activity
// line sends a small courier along its route (prompt → hook gate → Jev tower → model plant → the
// agent's city → its station; see system-places-lib.ts for every route). Extends Round 7 T's
// orbit-system (Tool Yard, lifecycle ring, landmarks) instead of duplicating it; the routines
// factory already exists (features/routines.ts) and is only labelled/explained, not rebuilt.
//
// Budget (round 11): 3 draw calls in total — the merged quarter, the instanced lamp/core orbs and
// the instanced couriers (the pick proxies are invisible and never drawn). Couriers are pooled
// (SlotPool + typed arrays, no per-frame allocation), capped by the quality tier, and with
// prefers-reduced-motion nothing travels: the places on the route just pulse.
//
// The campus (agent-city piece 7): the School and the Graduates' Hall are merged into the same
// quarter mesh, the School's lamp is one more orb, and the Hall's banners are one instanced mesh
// (count = trusted workers, so 0 trusted = no draw call): at most 4 calls with the campus. Their
// slots are picked once at boot (campusSlots), clear of the neighbouring cities; after that only
// the lamp colour, the banner count and the chip text change. Data: campus-data.ts. With reduced
// motion the banners hang still.
//
// The Clinic (vision wave 4): 🏥 one more building merged into the quarter mesh, its lamp one
// more orb (lit while any case is sick), and a small light over every sick house: extra instances
// of the same orb mesh (count = sick houses, at most MAX_MARKS), so sickness adds no draw call.
// The marks are written on a data change (sickness.ts onClinicChange, a house moving or leaving),
// never per frame: no animation at all. Nothing is built at runtime and no object moves.
//
// Everything lives under the "orbit-system" group, so Orbit's "Hide on the planet → System"
// hides it with the rest of the system layer (the Clinic's marks included). With WebGL off or
// lost nothing here touches the renderer: the quarter is plain geometry built on the CPU, and
// onFrame doesn't run.

import * as THREE from "three";
import type { AgentActivity, WorldSnapshot } from "../../../shared/types";
import type { Department } from "../../../shared/features/careers";
import { CITY_SURFACE, cityMatrix, cityPoint, type CityLayout } from "../layout";
import { log } from "../log";
import { sceneParts } from "../scene/scene-bus";
import { merge, painted, toon } from "../scene/toon";
import { prefersReducedMotion } from "../ui/kit";
import { agentStateOf, onAgentStates } from "./agent-state";
import { campusData, campusSnapshot, campusView, onCampusChange, startCampusData } from "./campus-data";
import { clinicView, onClinicChange } from "./sickness";
import type { ClinicView } from "./sickness-lib";
import { onApprovalsChange, pendingApprovals } from "./approvals";
import { explainOn, onExplainChange } from "./explain-state";
import { overlayLayer, place, toScreen } from "./fleet-overlay";
import { qualityController } from "./game-feel/quality";
import { isTurnEnd } from "./orbit-lib";
import type { ClientContext, ClientFeature } from "./registry";
import {
  CAMPUS_IDS,
  FAMILY_COLORS,
  GATE_EVENTS,
  LAMP_FRESH_DAYS,
  MAX_BANNERS,
  MAX_MARKS,
  SHIPPED_WINDOW_DAYS,
  GATE_TEXT,
  PLACE_IDS,
  ROUTE_COLORS,
  SlotPool,
  campusSlots,
  clinicLamp,
  clinicSlot,
  compactRoute,
  courierCap,
  courierRoute,
  harnessObstacles,
  hookGates,
  isCampusId,
  legSeconds,
  markSelection,
  permissionRoute,
  plantScale,
  plantStats,
  quarterSlots,
  routerHookState,
  stopRoute,
  type CampusId,
  type CampusSlot,
  type ClinicLamp,
  type ClinicSlot,
  type CourierRoute,
  type GateEvent,
  type GateInfo,
  type HouseMark,
  type Lamp,
  type PlaceId,
  type PlantFamily,
  type PlantStat,
  type RouterHookState,
  type Waypoint,
} from "./system-places-lib";
import { localMidnight } from "./explain-lib";

const SCALE = 1.15;
const MAX_COURIERS = 48;
const MAX_WAYPOINTS = 6;
const PER_AGENT_GAP_S = 0.35;
const GATE_COLORS: Record<GateEvent, number> = { UserPromptSubmit: 0xff5aa5, PreToolUse: 0x3a86ff, PermissionRequest: 0xff4d6d, Stop: 0x2ecc71 };
const GATE_EMOJI = "🚧";

// ---------------------------------------------------------------- live data (module scope, read by explain/tour)

let gates: GateInfo[] = GATE_EVENTS.map((event) => ({ event, configured: false, scripts: [] }));
let configured = new Set<GateEvent>();
let plants: PlantStat[] = [];
let routerDocs: number | null = null;
const hits = new Map<PlaceId, number>();
/** Real counts since this page opened (the store keeps only the last 50 lines). */
export const seen = {
  prompts: 0,
  brainReads: 0,
  perAgent: new Map<string, number>(),
  perIsland: new Map<string, number>(),
  /** agentId → station → calls */
  stations: new Map<string, Map<string, number>>(),
};

export function currentGates(): readonly GateInfo[] {
  return gates;
}
export function currentPlants(): readonly PlantStat[] {
  return plants;
}
export function currentRouterHook(): RouterHookState {
  return routerHookState(gates);
}
export function currentRouterDocs(): number | null {
  return routerDocs;
}
export function placeHits(id: PlaceId): number {
  return hits.get(id) ?? 0;
}

// ---------------------------------------------------------------- geometry

function gateGeometry(event: GateEvent): THREE.BufferGeometry {
  const c = GATE_COLORS[event];
  return merge([
    painted(new THREE.BoxGeometry(2.6, 0.18, 1.0).translate(0, 0.09, 0), 0xfff1e0),
    painted(new THREE.BoxGeometry(0.38, 2.3, 0.38).translate(-0.95, 1.15, 0), 0xfffaf0),
    painted(new THREE.BoxGeometry(0.38, 2.3, 0.38).translate(0.95, 1.15, 0), 0xfffaf0),
    painted(new THREE.BoxGeometry(2.5, 0.46, 0.5).translate(0, 2.45, 0), c),
    painted(new THREE.BoxGeometry(0.9, 0.3, 0.06).translate(0, 2.45, 0.28), 0xffffff),
    painted(new THREE.BoxGeometry(0.16, 0.9, 0.16).translate(0, 0.45, 0.5).rotateZ(0), 0x2a1850),
    painted(new THREE.BoxGeometry(1.5, 0.12, 0.12).translate(0.62, 0.95, 0.5), c),
  ]);
}

function towerGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.CylinderGeometry(1.5, 1.7, 0.5, 16).translate(0, 0.25, 0), 0xe4d4ff),
    painted(new THREE.CylinderGeometry(0.62, 0.9, 5.2, 12).translate(0, 3.1, 0), 0xfffaf0),
    painted(new THREE.CylinderGeometry(0.66, 0.66, 0.22, 12).translate(0, 2.0, 0), 0x8338ec),
    painted(new THREE.CylinderGeometry(0.66, 0.66, 0.22, 12).translate(0, 3.6, 0), 0x8338ec),
    painted(new THREE.CylinderGeometry(1.25, 1.0, 0.95, 16).translate(0, 6.05, 0), 0x8338ec),
    painted(new THREE.CylinderGeometry(1.3, 1.3, 0.14, 16).translate(0, 6.6, 0), 0xffd23f),
    painted(new THREE.ConeGeometry(0.22, 1.3, 8).translate(0, 7.9, 0), 0xff5aa5),
  ]);
}

function plantGeometry(family: PlantFamily): THREE.BufferGeometry {
  const c = FAMILY_COLORS[family];
  const cooling = (x: number): THREE.BufferGeometry[] => [
    painted(new THREE.CylinderGeometry(0.5, 0.72, 1.3, 14).translate(x, 1.85, -0.35), 0xf2f4fa),
    painted(new THREE.CylinderGeometry(0.62, 0.5, 0.9, 14).translate(x, 2.95, -0.35), 0xf2f4fa),
    painted(new THREE.CylinderGeometry(0.64, 0.64, 0.12, 14).translate(x, 3.44, -0.35), c),
  ];
  return merge([
    painted(new THREE.BoxGeometry(2.6, 1.2, 1.9).translate(0, 0.6, 0), 0xfffaf0),
    painted(new THREE.BoxGeometry(2.72, 0.2, 2.02).translate(0, 1.3, 0), c),
    ...cooling(-0.62),
    ...cooling(0.62),
    painted(new THREE.BoxGeometry(0.8, 0.7, 0.08).translate(0, 0.55, 0.96), 0x2a1850),
    painted(new THREE.CylinderGeometry(0.34, 0.4, 0.3, 14).translate(0, 1.55, 0.62), 0xdfe6f5),
  ]);
}

/** "What's true": the original memory library's bookshelf — a vault of curated, corrected facts. */
function semanticGeometry(): THREE.BufferGeometry {
  const cols: THREE.BufferGeometry[] = [];
  for (const x of [-1.1, -0.37, 0.37, 1.1]) cols.push(painted(new THREE.CylinderGeometry(0.16, 0.16, 1.4, 10).translate(x, 0.9, 1.05), 0xfffaf0));
  const books: THREE.BufferGeometry[] = [];
  const bookColors = [0xff5aa5, 0x3a86ff, 0xffd23f, 0x06d6a0, 0xa77bff];
  bookColors.forEach((c, i) => books.push(painted(new THREE.BoxGeometry(0.18, 0.55 + (i % 2) * 0.12, 0.42).translate(-0.5 + i * 0.25, 2.55, 0), c)));
  return merge([
    painted(new THREE.BoxGeometry(3.2, 0.2, 2.6).translate(0, 0.1, 0.1), 0xe4d4ff),
    painted(new THREE.BoxGeometry(3.0, 1.4, 1.8).translate(0, 0.9, -0.1), 0xc8f0ff),
    painted(new THREE.BoxGeometry(3.2, 0.2, 2.4).translate(0, 1.7, 0.1), 0xfffaf0),
    painted(new THREE.CylinderGeometry(1.35, 1.35, 3.2, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.42, 0.85).translate(0, 2.05, 0.1), 0xa77bff),
    ...cols,
    ...books,
  ]);
}

/** "What happened": a sealed archive vault with rolled transcripts on its roof — raw, write-once. */
function episodicGeometry(): THREE.BufferGeometry {
  const scrolls: THREE.BufferGeometry[] = [];
  const scrollColors = [0xffb703, 0xff9f1c, 0xffd166, 0xf4a261, 0xffc857];
  scrollColors.forEach((c, i) => scrolls.push(painted(new THREE.CylinderGeometry(0.16, 0.16, 0.9, 10).rotateZ(Math.PI / 2).translate(-1.0 + i * 0.5, 2.65, 0), c)));
  return merge([
    painted(new THREE.BoxGeometry(3.2, 0.2, 2.6).translate(0, 0.1, 0.1), 0xffe0a3),
    painted(new THREE.BoxGeometry(2.9, 1.5, 1.9).translate(0, 0.95, -0.1), 0xfff3d6),
    painted(new THREE.BoxGeometry(3.1, 0.2, 2.3).translate(0, 1.8, 0.1), 0xfffaf0),
    painted(new THREE.CylinderGeometry(1.3, 1.3, 0.9, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.4, 0.85).translate(0, 2.25, 0.1), 0xffb703),
    painted(new THREE.BoxGeometry(1.0, 1.1, 0.06).translate(0, 0.75, 1.0), 0x2a1850),
    ...scrolls,
  ]);
}

/** "What works": a workshop with a gear on its face — skills, run and occasionally repaired. */
function proceduralGeometry(): THREE.BufferGeometry {
  const teeth: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    teeth.push(painted(new THREE.BoxGeometry(0.22, 0.22, 0.1).translate(Math.cos(a) * 0.55, 1.7 + Math.sin(a) * 0.55, 1.0), 0x2a1850));
  }
  return merge([
    painted(new THREE.BoxGeometry(3.0, 0.2, 2.4).translate(0, 0.1, 0), 0xbdf2c4),
    painted(new THREE.BoxGeometry(2.7, 1.5, 1.7).translate(0, 0.95, 0), 0xfffaf0),
    painted(new THREE.BoxGeometry(2.9, 0.2, 2.0).translate(0, 1.75, 0), 0x2ecc71),
    painted(new THREE.CylinderGeometry(0.62, 0.62, 0.16, 20).translate(0, 1.7, 0.92), 0x2ecc71),
    painted(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 12).translate(0, 1.7, 1.0), 0xffd23f),
    painted(new THREE.BoxGeometry(1.4, 0.14, 0.6).translate(0, 0.55, 1.05), 0x8a5a2b),
    ...teeth,
  ]);
}

/** A small terminal kiosk: agent-authored CLIs (~/.claude/clis/<name>/cli.json). */
function cliGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.BoxGeometry(2.2, 0.16, 1.8).translate(0, 0.08, 0), 0xd7e8ff),
    painted(new THREE.BoxGeometry(1.9, 1.3, 1.4).translate(0, 0.83, 0), 0x2a3b55),
    painted(new THREE.BoxGeometry(1.5, 0.85, 0.1).translate(0, 0.95, 0.73), 0x4cc9f0),
    painted(new THREE.BoxGeometry(1.9, 0.18, 1.4).translate(0, 1.58, 0), 0x3a86ff),
    painted(new THREE.CylinderGeometry(0.07, 0.07, 0.55, 8).translate(-0.7, 1.9, 0), 0x2a3b55),
    painted(new THREE.SphereGeometry(0.12, 10, 8).translate(-0.7, 2.2, 0), 0xffd23f),
  ]);
}

/** 🏫 The School: a schoolhouse with a bell tower; its lamp (an orb) hangs above the bell. */
function schoolGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.BoxGeometry(3.0, 0.2, 2.4).translate(0, 0.1, 0), 0xffe0a3),
    painted(new THREE.BoxGeometry(2.7, 1.4, 1.8).translate(0, 0.9, 0), 0xfff3d6),
    painted(new THREE.CylinderGeometry(1.35, 1.35, 2.8, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.46, 0.8).translate(0, 1.95, 0), 0xff5a5f),
    painted(new THREE.BoxGeometry(0.62, 0.8, 0.62).translate(0, 2.55, 0), 0xfffaf0),
    painted(new THREE.ConeGeometry(0.52, 0.5, 4).rotateY(Math.PI / 4).translate(0, 3.2, 0), 0xff5a5f),
    painted(new THREE.BoxGeometry(0.62, 0.9, 0.06).translate(0, 0.65, 0.92), 0x2a1850),
    painted(new THREE.BoxGeometry(0.5, 0.42, 0.06).translate(-0.85, 1.0, 0.92), 0x8fd3ff),
    painted(new THREE.BoxGeometry(0.5, 0.42, 0.06).translate(0.85, 1.0, 0.92), 0x8fd3ff),
  ]);
}

/** 🎓 The Graduates' Hall: a columned hall under a mortarboard, a gold plaque on its front. */
function hallGeometry(): THREE.BufferGeometry {
  const cols: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) cols.push(painted(new THREE.CylinderGeometry(0.13, 0.15, 1.55, 10).translate(-1.35 + i * 0.54, 1.02, 0.78), 0xfffaf0));
  return merge([
    painted(new THREE.BoxGeometry(3.8, 0.24, 2.4).translate(0, 0.12, 0.1), 0xe4d4ff),
    painted(new THREE.BoxGeometry(3.3, 0.14, 0.5).translate(0, 0.31, 1.18), 0xe4d4ff),
    painted(new THREE.BoxGeometry(3.1, 1.55, 1.3).translate(0, 1.02, -0.25), 0xfffaf0),
    ...cols,
    painted(new THREE.BoxGeometry(3.6, 0.26, 2.1).translate(0, 1.92, 0.05), 0xffd23f),
    painted(new THREE.CylinderGeometry(1.25, 1.25, 3.6, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.4, 0.84).translate(0, 2.3, 0.05), 0x8338ec),
    painted(new THREE.BoxGeometry(1.3, 0.34, 0.06).translate(0, 1.45, 0.53), 0xffb703),
    painted(new THREE.CylinderGeometry(0.3, 0.34, 0.3, 12).translate(0, 2.85, 0), 0x2a1850),
    painted(new THREE.BoxGeometry(1.25, 0.08, 1.25).rotateY(Math.PI / 4).translate(0, 3.04, 0), 0x2a1850),
    painted(new THREE.BoxGeometry(0.06, 0.4, 0.06).translate(0.5, 2.86, 0.5), 0xffd23f),
  ]);
}

/** One banner (instanced, tinted by its worker's department): a pole, a cloth and a gold knob. */
function bannerGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.CylinderGeometry(0.04, 0.05, 1.7, 6).translate(0, 0.85, 0), 0xe6e6f0),
    painted(new THREE.BoxGeometry(0.46, 0.62, 0.04).translate(0.25, 1.28, 0), 0xffffff),
    painted(new THREE.ConeGeometry(0.23, 0.2, 3).rotateZ(Math.PI).translate(0.25, 0.87, 0).scale(1, 1, 0.2), 0xffffff),
    painted(new THREE.SphereGeometry(0.07, 8, 6).translate(0, 1.76, 0), 0xfff1a8),
  ]);
}

/** 🏥 The Clinic: a white ward with a red cross on its face and roof; its lamp (an orb) above. */
function clinicGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.BoxGeometry(2.6, 0.2, 2.0).translate(0, 0.1, 0), 0xd7f5ee),
    painted(new THREE.BoxGeometry(2.3, 1.5, 1.6).translate(0, 0.95, 0), 0xfffaf0),
    painted(new THREE.BoxGeometry(2.5, 0.18, 1.8).translate(0, 1.79, 0), 0xff4d6d),
    painted(new THREE.BoxGeometry(0.62, 0.2, 0.06).translate(0, 1.2, 0.82), 0xff2d55),
    painted(new THREE.BoxGeometry(0.2, 0.62, 0.06).translate(0, 1.2, 0.82), 0xff2d55),
    painted(new THREE.BoxGeometry(0.5, 0.62, 0.06).translate(0, 0.51, 0.82), 0x2a1850),
    painted(new THREE.BoxGeometry(0.42, 0.36, 0.06).translate(-0.8, 1.0, 0.82), 0x8fd3ff),
    painted(new THREE.BoxGeometry(0.42, 0.36, 0.06).translate(0.8, 1.0, 0.82), 0x8fd3ff),
    painted(new THREE.BoxGeometry(0.72, 0.14, 0.24).translate(0, 1.95, 0), 0xffffff),
    painted(new THREE.BoxGeometry(0.24, 0.14, 0.72).translate(0, 1.95, 0), 0xffffff),
  ]);
}

const CLINIC_NAME = "🏥 Clinic";
const CLINIC_LABEL = "System Quarter · Clinic";
/** Pick-proxy half-extents (x, height, z), local units before SCALE. */
const CLINIC_PROXY: [number, number, number] = [2.8, 3.2, 2.2];
/** The lamp's height above the ward, local units before SCALE. */
const CLINIC_LAMP_Y = 2.6;
const CLINIC_LAMP_COLORS: Record<ClinicLamp["state"], number> = { lit: 0xff4d6d, dark: 0x8d93a8, unknown: 0xcfc8dd };
/** A sick house's light: radius and lift above the roof's peak (world units). */
const MARK_R = 0.24;
const MARK_LIFT = 0.5;
const MARK_COLORS: Readonly<Record<string, number>> = { chronic: 0xc1121f, open: 0xff3b3b, exposed: 0xffa62b };

const CAMPUS_NAMES: Record<CampusId, string> = { school: "🏫 School", hall: "🎓 Graduates' Hall" };
/** Pick-proxy half-extents (x, height, z) per campus place; the Hall's covers its banners. */
const CAMPUS_PROXY: Record<CampusId, [number, number, number]> = { school: [3.0, 3.6, 2.6], hall: [4.8, 3.3, 5.4] };
const DEPARTMENT_COLORS: Record<Department, number> = {
  "Reports & Briefs": 0xff5aa5,
  "Inbox desk": 0x3a86ff,
  "Research library": 0xa77bff,
  Institute: 0x06d6a0,
  "Control room": 0xff7a1a,
  Operations: 0xffd23f,
};
const LAMP_COLORS: Record<Lamp["state"], number> = { lit: 0xffe066, dim: 0xff3b3b, unknown: 0xcfc8dd };

function placeGeometry(id: PlaceId): THREE.BufferGeometry {
  if (id === "jev") return towerGeometry();
  if (id === "cli") return cliGeometry();
  if (id === "episodic") return episodicGeometry();
  if (id === "semantic") return semanticGeometry();
  if (id === "procedural") return proceduralGeometry();
  if (id.startsWith("gate:")) return gateGeometry(id.slice(5) as GateEvent);
  return plantGeometry(id.slice(6) as PlantFamily);
}

/** Orb (lamp / core) height and base size per place, in local units before SCALE. */
function orbSpec(id: PlaceId): { y: number; z: number; r: number; color: number } {
  if (id === "jev") return { y: 7.2, z: 0, r: 0.75, color: 0xffe066 };
  if (id === "cli") return { y: 2.0, z: 0, r: 0.32, color: 0x4cc9f0 };
  if (id === "episodic") return { y: 3.0, z: 0, r: 0.42, color: 0xffb703 };
  if (id === "semantic") return { y: 3.25, z: 0, r: 0.45, color: 0xa77bff };
  if (id === "procedural") return { y: 2.05, z: 0, r: 0.4, color: 0x2ecc71 };
  if (id.startsWith("gate:")) return { y: 3.0, z: 0, r: 0.36, color: GATE_COLORS[id.slice(5) as GateEvent] };
  return { y: 1.9, z: 0.62, r: 0.42, color: FAMILY_COLORS[id.slice(6) as PlantFamily] };
}

/** Pick-proxy half-extents (x, height, z) per place, local units before SCALE. */
function proxySize(id: PlaceId): [number, number, number] {
  if (id === "jev") return [3.2, 8.6, 3.2];
  if (id === "cli") return [2.6, 2.2, 2.2];
  if (id === "episodic") return [3.3, 3.0, 2.8];
  if (id === "semantic") return [3.4, 3.4, 2.8];
  if (id === "procedural") return [3.1, 2.2, 2.6];
  if (id.startsWith("gate:")) return [2.7, 3.4, 1.2];
  return [2.9, 3.6, 2.2];
}

// ---------------------------------------------------------------- the visual

interface Courier {
  legs: number; // waypoints - 1
  leg: number;
  t: number;
  dur: number;
  ids: (Waypoint | null)[]; // place ids to pulse on arrival (null for house/city/station)
}

export interface Quarter {
  group: THREE.Group;
  orbs: THREE.InstancedMesh;
  couriers: THREE.InstancedMesh;
  proxies: THREE.InstancedMesh;
  top: Map<PlaceId, THREE.Vector3>;
  orbBase: Map<PlaceId, { pos: THREE.Vector3; r: number; color: THREE.Color; index: number }>;
  campus: {
    slots: readonly CampusSlot[];
    top: Map<CampusId, THREE.Vector3>;
    /** The School's lamp: the orb instance after the quarter's own. */
    lamp: { pos: THREE.Vector3; index: number } | null;
    /** The Hall's model matrix; banners stand in its local frame. Null when it has no slot. */
    hall: THREE.Matrix4 | null;
    banners: THREE.InstancedMesh;
  };
  clinic: {
    slot: ClinicSlot;
    top: THREE.Vector3;
    /** The lamp: one orb instance after the School's. */
    lamp: { pos: THREE.Vector3; index: number };
    /** First orb instance of the house marks; `orbs.count` = markBase + marks shown. */
    markBase: number;
  };
}

let quarter: Quarter | null = null;
const labelOf = new Map<string, PlaceId>();
const campusLabelOf = new Map<string, CampusId>();
/** Banners' hall-local x, z (pooled: rewritten in place, MAX_BANNERS long). */
const bannerXZ = new Float32Array(MAX_BANNERS * 2);
const placeLabelById = new Map<PlaceId, string>();
const pool = new SlotPool(MAX_COURIERS);
const couriers: Courier[] = Array.from({ length: MAX_COURIERS }, () => ({ legs: 0, leg: 0, t: 0, dur: 1, ids: new Array<Waypoint | null>(MAX_WAYPOINTS).fill(null) }));
const wp = new Float32Array(MAX_COURIERS * MAX_WAYPOINTS * 3);
const pulseAt = new Float32Array(PLACE_IDS.length).fill(-100);
let orbsDirty = true;
let reduced = false;
const lastSpawn = new Map<string, number>();
const seenActivity = new Set<string>();
const seenApprovals = new Set<string>();
const prevStates = new Map<string, string | undefined>();

/** The hover label (pick id) of a place; also used by explain.ts to resolve a click. */
export function placeLabel(id: PlaceId): string {
  return placeLabelById.get(id) ?? id;
}
/** Place id behind a pick label, or undefined when the label is not one of ours. */
export function placeForLabel(label: string): PlaceId | undefined {
  return labelOf.get(label);
}
/** World point just above a place (for the tour camera and explain labels). */
export function placeTop(id: PlaceId): THREE.Vector3 | undefined {
  return quarter?.top.get(id);
}
/** Campus place behind a pick label, or undefined. */
export function campusForLabel(label: string): CampusId | undefined {
  return campusLabelOf.get(label);
}
/** World point just above a campus place, when it was built. */
export function campusTop(id: CampusId): THREE.Vector3 | undefined {
  return quarter?.campus.top.get(id);
}
export function campusName(id: CampusId): string {
  return CAMPUS_NAMES[id];
}
/** The School's lamp as shown now. */
export function currentLamp(): Lamp {
  return campusView().lamp;
}
/** The Hall's banners as shown now; null until /api/careers answered. */
export function currentBanners(): { shown: number; unshown: number } | null {
  const b = campusView().banners;
  return b ? { shown: b.slots.length, unshown: b.unshown } : null;
}
/** One short line per campus place, for chips and Explain tags (real numbers or "no data"). */
export function campusCaption(id: CampusId): string {
  const { lamp, banners } = campusView();
  if (id === "school") return lamp.state === "lit" ? `lamp lit: a draft in the last ${LAMP_FRESH_DAYS} days` : lamp.state === "dim" ? `lamp dim: ${lamp.why}` : "lamp: no data";
  const shipped = campusData().shipped;
  const b = banners ? `${banners.slots.length} banner${banners.slots.length === 1 ? "" : "s"}` : "banners: no data";
  const ship = !shipped ? "shipped: no data" : shipped.undated > 0 && shipped.count === 0 ? "shipped: no merge times" : `${shipped.undated > 0 ? "≥" : ""}${shipped.count} shipped in ${SHIPPED_WINDOW_DAYS}d`;
  return `${b} · ${ship}`;
}

/** True for the Clinic's pick label. */
export function isClinicLabel(label: string): boolean {
  return label === CLINIC_LABEL;
}
/** World point just above the Clinic, when it was built. */
export function clinicTop(): THREE.Vector3 | undefined {
  return quarter?.clinic.top;
}
export function clinicName(): string {
  return CLINIC_NAME;
}
/** The Clinic's lamp as shown now (from the live data, never a cached copy). */
export function currentClinicLamp(view: ClinicView = clinicView()): ClinicLamp {
  return clinicLamp(view.sick);
}

let ctxRef: ClientContext | null = null;

/** The roof of a session's house while it stands on the planet (in the store: a retired or pruned
 *  session's house is hidden and keeps no mark). */
function liveHouseAt(agentId: string): THREE.Vector3 | undefined {
  return ctxRef?.store.agents.has(agentId) ? ctxRef.agentPosition(agentId) : undefined;
}

/** Which houses carry a mark now, computed from the live data on every call (so the Explain card
 *  and the planet can't disagree, whichever change listener runs first). `drawn` is false when no
 *  System Quarter was built (no Harness City): then nothing is marked on the planet. */
export function currentClinicMarks(view: ClinicView = clinicView(), houseAt: (agentId: string) => THREE.Vector3 | undefined = liveHouseAt): {
  marks: HouseMark[];
  unplaced: number;
  unshown: number;
  drawn: boolean;
} {
  return { ...markSelection(view.sick, (id) => houseAt(id) !== undefined), drawn: quarter !== null };
}

/** One short line for the Clinic's chip and Explain tag (real numbers or "no data"). */
export function clinicCaption(view: ClinicView = clinicView()): string {
  const lamp = currentClinicLamp(view);
  return lamp.state === "lit" ? `lamp lit: ${lamp.why}` : lamp.state === "dark" ? "lamp dark: no sick case" : "lamp: no data";
}

export function quarterVisible(): boolean {
  let o: THREE.Object3D | null = quarter?.group ?? null;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return quarter !== null;
}

function nameOf(id: PlaceId): string {
  if (id === "jev") return "🗼 Jev tower";
  if (id === "cli") return "💻 CLI station";
  if (id === "episodic") return "🗄️ Episodic archive";
  if (id === "semantic") return "📚 Semantic library";
  if (id === "procedural") return "🛠️ Procedural workshop";
  if (id.startsWith("gate:")) return `${GATE_EMOJI} ${GATE_TEXT[id.slice(5) as GateEvent].short}`;
  const f = id.slice(6) as PlantFamily;
  return `⚡ ${f[0]!.toUpperCase()}${f.slice(1)} plant`;
}
export function placeName(id: PlaceId): string {
  return nameOf(id);
}

/** The quarter and its campus as plain geometry (CPU only, no renderer): exported for the
 *  draw-call test, which renders it through three's own WebGLRenderer. */
export function buildQuarter(harness: CityLayout, ctx: ClientContext): Quarter {
  const group = new THREE.Group();
  group.name = "system-quarter";
  const slots = quarterSlots(harness.radius);
  // The campus, then the Clinic clear of it: chosen once from the layout as it was laid out at boot (frozen: #16).
  const neighbours = harnessObstacles(harness, sceneParts().layout ?? [], CITY_SURFACE);
  const campus = campusSlots(harness.radius, neighbours);
  const clinicAt = clinicSlot(harness.radius, neighbours, campus);
  const parts: THREE.BufferGeometry[] = [];
  const top = new Map<PlaceId, THREE.Vector3>();
  const orbBase = new Map<PlaceId, { pos: THREE.Vector3; r: number; color: THREE.Color; index: number }>();
  const proxies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ visible: false }), slots.length + campus.length + 1);
  proxies.name = "system-quarter-pick";
  const hasSchool = campus.some((c) => c.id === "school");
  // Orb instances: the quarter's places, the School's lamp, the Clinic's lamp, then up to MAX_MARKS
  // sick-house marks (count grows and shrinks with them; the capacity never changes).
  const clinicLampIndex = slots.length + (hasSchool ? 1 : 0);
  const markBase = clinicLampIndex + 1;
  const orbs = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }), markBase + MAX_MARKS);
  orbs.name = "system-quarter-orbs";
  orbs.count = markBase;
  const orbWhite = new THREE.Color(0xffffff);
  for (let i = 0; i < markBase + MAX_MARKS; i++) orbs.setColorAt(i, orbWhite); // instanceColor exists before the first draw
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3(SCALE, SCALE, SCALE);
  slots.forEach((slot, i) => {
    const x = Math.cos(slot.angle) * slot.radius;
    const z = Math.sin(slot.angle) * slot.radius;
    // Face Harness City's centre (the courier road runs along the arc).
    const yaw = Math.atan2(-x, -z);
    cityMatrix(harness, x, z, 0, yaw, s, m);
    parts.push(placeGeometry(slot.id).applyMatrix4(m));
    const [px, py, pz] = proxySize(slot.id);
    proxies.setMatrixAt(i, cityMatrix(harness, x, z, 0, yaw, new THREE.Vector3(px * SCALE, py * SCALE, pz * SCALE), new THREE.Matrix4()));
    const o = orbSpec(slot.id);
    // The orb sits on the place's local up axis (+ a small forward offset for plant cores).
    const pos = new THREE.Vector3(0, o.y, o.z).applyMatrix4(m);
    orbBase.set(slot.id, { pos, r: o.r * SCALE, color: new THREE.Color(o.color), index: i });
    top.set(slot.id, cityPoint(harness, x, z, (proxySize(slot.id)[1] + 0.6) * SCALE));
  });
  const campusTopMap = new Map<CampusId, THREE.Vector3>();
  let lampSpot: { pos: THREE.Vector3; index: number } | null = null;
  let hall: THREE.Matrix4 | null = null;
  campus.forEach((c, i) => {
    const x = Math.cos(c.angle) * c.radius;
    const z = Math.sin(c.angle) * c.radius;
    const yaw = Math.atan2(-x, -z);
    cityMatrix(harness, x, z, 0, yaw, s, m);
    parts.push((c.id === "school" ? schoolGeometry() : hallGeometry()).applyMatrix4(m));
    const [px, py, pz] = CAMPUS_PROXY[c.id];
    proxies.setMatrixAt(slots.length + i, cityMatrix(harness, x, z, 0, yaw, new THREE.Vector3(px * SCALE, py * SCALE, pz * SCALE), new THREE.Matrix4()));
    campusTopMap.set(c.id, cityPoint(harness, x, z, (py + 0.6) * SCALE));
    if (c.id === "school") lampSpot = { pos: new THREE.Vector3(0, 3.95, 0).applyMatrix4(m), index: slots.length };
    else hall = m.clone();
  });
  // 🏥 The Clinic, merged into the same mesh; its pick proxy is the last one.
  const cx = Math.cos(clinicAt.angle) * clinicAt.radius;
  const cz = Math.sin(clinicAt.angle) * clinicAt.radius;
  const cyaw = Math.atan2(-cx, -cz);
  cityMatrix(harness, cx, cz, 0, cyaw, s, m);
  parts.push(clinicGeometry().applyMatrix4(m));
  proxies.setMatrixAt(slots.length + campus.length, cityMatrix(harness, cx, cz, 0, cyaw, new THREE.Vector3(CLINIC_PROXY[0] * SCALE, CLINIC_PROXY[1] * SCALE, CLINIC_PROXY[2] * SCALE), new THREE.Matrix4()));
  const clinic = {
    slot: clinicAt,
    top: cityPoint(harness, cx, cz, (CLINIC_PROXY[1] + 0.6) * SCALE),
    lamp: { pos: new THREE.Vector3(0, CLINIC_LAMP_Y, 0).applyMatrix4(m), index: clinicLampIndex },
    markBase,
  };
  const bannerMesh = new THREE.InstancedMesh(bannerGeometry(), toon(0xffffff, { vertexColors: true }), MAX_BANNERS);
  bannerMesh.name = "campus-banners";
  bannerMesh.count = 0;
  const blank = new THREE.Color(0xffffff);
  for (let i = 0; i < MAX_BANNERS; i++) bannerMesh.setColorAt(i, blank); // instanceColor exists before the first draw
  const mesh = new THREE.Mesh(merge(parts), toon(0xffffff, { vertexColors: true }));
  mesh.name = "system-quarter-places";
  mesh.matrixAutoUpdate = false;
  proxies.instanceMatrix.needsUpdate = true;
  const couriersMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 10, 8), toon(0xffffff), MAX_COURIERS);
  couriersMesh.name = "system-couriers";
  couriersMesh.count = 0;
  couriersMesh.frustumCulled = false;
  const white = new THREE.Color(0xffffff);
  for (let i = 0; i < MAX_COURIERS; i++) couriersMesh.setColorAt(i, white);
  group.add(mesh, orbs, couriersMesh, bannerMesh, proxies);

  const pick = sceneParts().pick;
  for (const slot of slots) {
    const label = `System Quarter · ${nameOf(slot.id).replace(/^\S+\s/, "")}`;
    labelOf.set(label, slot.id);
    placeLabelById.set(slot.id, label);
  }
  const campusLabel = (id: CampusId): string => `Campus · ${CAMPUS_NAMES[id].replace(/^\S+\s/, "")}`;
  for (const c of campus) campusLabelOf.set(campusLabel(c.id), c.id);
  pick?.register(proxies, (instanceId) => {
    if (instanceId === undefined) return null;
    const slot = slots[instanceId];
    if (slot) return { kind: "system", id: placeLabel(slot.id) };
    const c = campus[instanceId - slots.length];
    if (c) return { kind: "system", id: campusLabel(c.id) };
    return instanceId === slots.length + campus.length ? { kind: "system", id: CLINIC_LABEL } : null;
  });
  void ctx;
  return { group, orbs, couriers: couriersMesh, proxies, top, orbBase, campus: { slots: campus, top: campusTopMap, lamp: lampSpot, hall, banners: bannerMesh }, clinic };
}

// ---------------------------------------------------------------- the Clinic (lamp + house marks)

const markPos = new THREE.Vector3();

/**
 * Re-reads what the Clinic shows (on a data change, a house moving or leaving; never per frame):
 * the lamp's colour and size, and one mark over each sick house that stands on the planet, worst
 * first. Only orb instances are rewritten: the Clinic and the houses are never rebuilt or moved,
 * and nothing touches the renderer, so it is the same CPU work with WebGL on, off or lost.
 */
export function paintClinic(q: Quarter | null = quarter, view: ClinicView = clinicView(), houseAt: (agentId: string) => THREE.Vector3 | undefined = liveHouseAt): void {
  refreshChipText();
  if (!q) return;
  const lamp = currentClinicLamp(view);
  const { lamp: spot, markBase } = q.clinic;
  tmpS.setScalar((lamp.state === "lit" ? 0.5 : 0.36) * SCALE);
  q.orbs.setMatrixAt(spot.index, tmpM.compose(spot.pos, tmpQ.identity(), tmpS));
  q.orbs.setColorAt(spot.index, tmpC.setHex(CLINIC_LAMP_COLORS[lamp.state]));
  const { marks } = currentClinicMarks(view, houseAt);
  let n = 0;
  for (const mark of marks) {
    const roof = houseAt(mark.agentId);
    if (!roof) continue;
    markPos.copy(roof).setLength(roof.length() + MARK_LIFT);
    q.orbs.setMatrixAt(markBase + n, tmpM.compose(markPos, tmpQ.identity(), tmpS.setScalar(MARK_R)));
    q.orbs.setColorAt(markBase + n, tmpC.setHex(MARK_COLORS[mark.worst] ?? MARK_COLORS.open!));
    n += 1;
  }
  q.orbs.count = markBase + n;
  q.orbs.instanceMatrix.needsUpdate = true;
  if (q.orbs.instanceColor) q.orbs.instanceColor.needsUpdate = true;
  q.orbs.computeBoundingSphere(); // marks sit all over the planet: never cull them with the quarter's old sphere
}

// ---------------------------------------------------------------- campus (lamp + banners)

const bannerLocal = new THREE.Matrix4();
const bannerColor = new THREE.Color();

/** Banner `i`'s instance matrix: the Hall's frame, then its hall-local spot, swayed by `sway` rad. */
function setBanner(q: Quarter, i: number, sway: number): void {
  if (!q.campus.hall) return;
  bannerLocal.makeRotationY(sway).setPosition(bannerXZ[i * 2] ?? 0, 0, bannerXZ[i * 2 + 1] ?? 0);
  tmpM.multiplyMatrices(q.campus.hall, bannerLocal);
  q.campus.banners.setMatrixAt(i, tmpM);
}

/**
 * Re-reads what the campus shows from campus-data (on a data change, never per frame): the lamp's
 * state and colour, and one banner per trusted worker. Places are never rebuilt or moved; only the
 * banner count, instance matrices / colours and the lamp orb change. No renderer access.
 */
export function paintCampus(q: Quarter | null = quarter, nowMs = Date.now()): void {
  const { lamp, banners } = campusView(nowMs);
  refreshChipText();
  if (!q) return;
  const spot = q.campus.lamp;
  if (spot) {
    tmpS.setScalar((lamp.state === "lit" ? 0.5 : 0.38) * SCALE);
    tmpM.compose(spot.pos, tmpQ.identity(), tmpS);
    q.orbs.setMatrixAt(spot.index, tmpM);
    q.orbs.setColorAt(spot.index, tmpC.setHex(LAMP_COLORS[lamp.state]));
    q.orbs.instanceMatrix.needsUpdate = true;
    if (q.orbs.instanceColor) q.orbs.instanceColor.needsUpdate = true;
  }
  const mesh = q.campus.banners;
  const list = q.campus.hall ? (banners?.slots ?? []) : [];
  list.forEach((b, i) => {
    bannerXZ[i * 2] = b.x;
    bannerXZ[i * 2 + 1] = b.z;
    setBanner(q, i, 0);
    mesh.setColorAt(i, bannerColor.setHex(DEPARTMENT_COLORS[b.department]));
  });
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

/** Banners flutter a little (never with reduced motion: then they hang still). */
export function swayBanners(q: Quarter, elapsed: number, reducedMotion: boolean): void {
  const mesh = q.campus.banners;
  if (reducedMotion || mesh.count === 0) return;
  for (let i = 0; i < mesh.count; i++) setBanner(q, i, Math.sin(elapsed * 1.4 + i * 0.9) * 0.14);
  mesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- orbs

const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpC = new THREE.Color();
const GREY = new THREE.Color(0xcfc8dd);
const FLASH = new THREE.Color(0xfff6a8);

function pop(elapsed: number, at: number): number {
  const k = (elapsed - at) / 0.9;
  return k >= 0 && k < 1 ? Math.sin(k * Math.PI) * (1 - k * 0.5) : 0;
}

function updateOrbs(elapsed: number): void {
  if (!quarter) return;
  let active = orbsDirty;
  for (let i = 0; i < PLACE_IDS.length; i++) if (elapsed - (pulseAt[i] ?? -100) < 1) active = true;
  if (!active) return;
  orbsDirty = false;
  for (const [id, b] of quarter.orbBase) {
    let scale = 1;
    let lit = 1;
    if (id.startsWith("plant:")) {
      const st = plants.find((p) => `plant:${p.family}` === id);
      scale = plantScale(st?.live ?? 0);
      lit = st && st.live > 0 ? 1 : 0.35;
    } else if (id.startsWith("gate:")) {
      lit = configured.has(id.slice(5) as GateEvent) ? 1 : 0.2;
    }
    const p = pop(elapsed, pulseAt[b.index] ?? -100);
    tmpS.setScalar(b.r * scale * (1 + 0.6 * p));
    tmpM.compose(b.pos, tmpQ.identity(), tmpS);
    quarter.orbs.setMatrixAt(b.index, tmpM);
    tmpC.copy(GREY).lerp(b.color, lit).lerp(FLASH, p * 0.7);
    quarter.orbs.setColorAt(b.index, tmpC);
  }
  quarter.orbs.instanceMatrix.needsUpdate = true;
  if (quarter.orbs.instanceColor) quarter.orbs.instanceColor.needsUpdate = true;
}

function pulse(id: PlaceId, elapsed: number): void {
  hits.set(id, (hits.get(id) ?? 0) + 1);
  const i = PLACE_IDS.indexOf(id);
  if (i >= 0) pulseAt[i] = elapsed;
}

// ---------------------------------------------------------------- couriers

const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vp = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

function isPlace(w: Waypoint): w is PlaceId {
  return w !== "house" && w !== "city" && w !== "station";
}

/** Resolve a route's waypoints for `agentId` into world points (into `out`, reused). */
function resolve(route: CourierRoute, agentId: string, ctx: ClientContext, out: { p: THREE.Vector3; id: Waypoint }[]): number {
  const agent = ctx.store.agents.get(agentId);
  let n = 0;
  for (const w of route.waypoints) {
    if (n >= MAX_WAYPOINTS) break;
    let p: THREE.Vector3 | undefined;
    if (w === "house") p = ctx.agentPosition(agentId);
    else if (w === "city") p = agent ? ctx.cityPosition(agent.islandId) : undefined;
    else if (w === "station") {
      const roof = ctx.agentPosition(agentId);
      // The station props stand in a small ring beside the house: land just above its lot.
      if (roof) p = vp.copy(roof).setLength(roof.length() + 0.6);
    } else p = quarter?.top.get(w);
    if (!p) continue;
    const slot = out[n];
    if (!slot) break;
    slot.p.copy(p);
    slot.id = w;
    n += 1;
  }
  return n;
}

const resolved = Array.from({ length: MAX_WAYPOINTS }, () => ({ p: new THREE.Vector3(), id: "house" as Waypoint }));

function spawn(route: CourierRoute, agentId: string, ctx: ClientContext): void {
  if (!quarter) return;
  const elapsed = ctx.elapsed();
  const n = resolve(route, agentId, ctx, resolved);
  const pts = compactRoute(resolved.slice(0, n), (a, b) => a.p.distanceToSquared(b.p) < 0.25);
  if (!pts) return;
  const cap = courierCap(qualityController.tier(), reduced);
  const last = lastSpawn.get(agentId) ?? -10;
  if (cap === 0 || elapsed - last < PER_AGENT_GAP_S) {
    // Nothing travels (reduced motion / busy agent): the places on the route still light up.
    for (const w of pts) if (isPlace(w.id)) pulse(w.id, elapsed);
    return;
  }
  const slot = pool.acquire(cap);
  if (slot < 0) {
    for (const w of pts) if (isPlace(w.id)) pulse(w.id, elapsed);
    return;
  }
  lastSpawn.set(agentId, elapsed);
  const c = couriers[slot]!;
  pts.forEach((w, i) => {
    const o = (slot * MAX_WAYPOINTS + i) * 3;
    wp[o] = w.p.x;
    wp[o + 1] = w.p.y;
    wp[o + 2] = w.p.z;
    c.ids[i] = isPlace(w.id) ? w.id : null;
  });
  c.legs = pts.length - 1;
  c.leg = 0;
  c.t = 0;
  c.dur = legDuration(slot, 0);
  quarter.couriers.setColorAt(slot, tmpC.setHex(ROUTE_COLORS[route.kind]));
  if (quarter.couriers.instanceColor) quarter.couriers.instanceColor.needsUpdate = true;
  const first = c.ids[0];
  if (first && isPlace(first)) pulse(first, elapsed);
}

function legDuration(slot: number, leg: number): number {
  const o = (slot * MAX_WAYPOINTS + leg) * 3;
  va.set(wp[o]!, wp[o + 1]!, wp[o + 2]!);
  vb.set(wp[o + 3]!, wp[o + 4]!, wp[o + 5]!);
  return legSeconds(va.angleTo(vb));
}

/** Great-circle hop from waypoint `leg` to `leg+1` of `slot` at t∈[0,1], lifted into an arc. */
function legPoint(slot: number, leg: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const o = (slot * MAX_WAYPOINTS + leg) * 3;
  va.set(wp[o]!, wp[o + 1]!, wp[o + 2]!);
  vb.set(wp[o + 3]!, wp[o + 4]!, wp[o + 5]!);
  const ra = va.length();
  const rb = vb.length();
  const angle = va.angleTo(vb);
  const e = t * t * (3 - 2 * t);
  if (angle < 1e-4) return out.copy(va).lerp(vb, e);
  const sinA = Math.sin(angle);
  const wa = Math.sin((1 - e) * angle) / sinA;
  const wb = Math.sin(e * angle) / sinA;
  out.copy(va).divideScalar(ra).multiplyScalar(wa).addScaledVector(vb.divideScalar(rb), wb).normalize();
  const lift = Math.sin(Math.PI * e) * (1.5 + angle * 22);
  return out.multiplyScalar(ra + (rb - ra) * e + lift);
}

function updateCouriers(dt: number, elapsed: number): void {
  if (!quarter) return;
  const mesh = quarter.couriers;
  let maxUsed = 0;
  for (let i = 0; i < MAX_COURIERS; i++) {
    if (!pool.isBusy(i)) continue;
    const c = couriers[i]!;
    c.t += dt / c.dur;
    while (c.t >= 1 && pool.isBusy(i)) {
      const arrived = c.ids[c.leg + 1];
      if (arrived && isPlace(arrived)) pulse(arrived, elapsed);
      c.leg += 1;
      c.t -= 1;
      if (c.leg >= c.legs) {
        pool.release(i);
        tmpM.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, tmpM);
      } else c.dur = legDuration(i, c.leg);
    }
    if (!pool.isBusy(i)) continue;
    maxUsed = i + 1;
    legPoint(i, c.leg, c.t, vp);
    const s = 1 + 0.25 * Math.sin(elapsed * 14 + i);
    tmpM.compose(vp, tmpQ.identity(), tmpS.copy(ONE).multiplyScalar(s));
    mesh.setMatrixAt(i, tmpM);
  }
  mesh.count = maxUsed;
  mesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- live signals

function onActivities(list: AgentActivity[], ctx: ClientContext): void {
  for (const a of list) {
    if (seenActivity.has(a.id)) continue;
    seenActivity.add(a.id);
    const agent = ctx.store.agents.get(a.agentId);
    seen.perAgent.set(a.agentId, (seen.perAgent.get(a.agentId) ?? 0) + 1);
    if (agent) seen.perIsland.set(agent.islandId, (seen.perIsland.get(agent.islandId) ?? 0) + 1);
    if (a.stage === "hook") seen.prompts += 1;
    if (a.stage === "brain") seen.brainReads += 1;
    const route = courierRoute(a, { model: agent?.model ?? null, configured });
    const st = seen.stations.get(a.agentId) ?? new Map<string, number>();
    st.set(route.station, (st.get(route.station) ?? 0) + 1);
    seen.stations.set(a.agentId, st);
    spawn(route, a.agentId, ctx);
  }
  if (seenActivity.size > 4000) seenActivity.clear();
}

function onApprovals(ctx: ClientContext): void {
  for (const ap of pendingApprovals()) {
    if (seenApprovals.has(ap.id)) continue;
    seenApprovals.add(ap.id);
    const agent = ctx.store.agents.get(ap.agentId);
    spawn(permissionRoute({ model: agent?.model ?? null, configured }), ap.agentId, ctx);
  }
}

function onStates(ctx: ClientContext): void {
  for (const a of ctx.store.agents.values()) {
    if (a.status !== "live") continue;
    const next = agentStateOf(a.id);
    const prev = prevStates.get(a.id);
    if (prev === next) continue;
    prevStates.set(a.id, next);
    if (isTurnEnd(prev, next)) spawn(stopRoute({ model: a.model, configured }), a.id, ctx);
  }
}

function refreshGates(ctx: ClientContext): void {
  gates = hookGates(ctx.store.objects.values());
  configured = new Set(gates.filter((g) => g.configured).map((g) => g.event));
  orbsDirty = true;
}

function refreshPlants(ctx: ClientContext): void {
  plants = plantStats([...ctx.store.agents.values()], localMidnight(Date.now()));
  orbsDirty = true;
  refreshChipText();
}

// ---------------------------------------------------------------- name chips (explain off, camera close)

interface Chip {
  id: PlaceId | CampusId | "clinic";
  el: HTMLElement;
}
const chips: Chip[] = [];
const NEAR = 50 + 46; // camera distance from the centre under which the names show

function mountChips(): void {
  const layer = overlayLayer();
  for (const id of [...PLACE_IDS, ...CAMPUS_IDS, "clinic" as const]) {
    const el = document.createElement("div");
    el.className = "orbit-chip orbit-landmark sq-chip";
    el.hidden = true;
    layer.appendChild(el);
    chips.push({ id, el });
  }
  refreshChipText();
}

function refreshChipText(): void {
  for (const c of chips) {
    if (c.id === "clinic" || isCampusId(c.id)) {
      const text = c.id === "clinic" ? `${CLINIC_NAME} · ${clinicCaption()}` : `${CAMPUS_NAMES[c.id]} · ${campusCaption(c.id)}`;
      if (c.el.textContent !== text) c.el.textContent = text;
      continue;
    }
    let text = nameOf(c.id);
    if (c.id.startsWith("plant:")) {
      const st = plants.find((p) => `plant:${p.family}` === c.id);
      if (st) text += ` · ${st.live} live`;
    }
    if (c.el.textContent !== text) c.el.textContent = text;
  }
}

function updateChips(ctx: ClientContext): void {
  const show = quarterVisible() && !explainOn() && ctx.camera.position.length() < NEAR;
  for (const c of chips) {
    const p = !show ? undefined : c.id === "clinic" ? quarter?.clinic.top : isCampusId(c.id) ? quarter?.campus.top.get(c.id) : quarter?.top.get(c.id);
    if (!p) {
      c.el.hidden = true;
      continue;
    }
    place(c.el, toScreen(ctx, p));
  }
}

// ---------------------------------------------------------------- feature

export const systemPlacesFeature: ClientFeature = {
  id: "system-places",
  mount(ctx) {
    // The campus data runs with or without the 3D view: the Explain cards read it from the palette.
    startCampusData(ctx);
    ctxRef = ctx; // the Clinic card counts sick houses even when no quarter gets built
    onCampusChange(() => paintCampus());
    const parts = sceneParts();
    const harness = parts.layout?.find((c) => c.id === "harness");
    if (!harness || !parts.pick) {
      log.warn("system-places", "no Harness City or pick registry; the System Quarter is off");
      return;
    }
    quarter = buildQuarter(harness, ctx);
    // Under the orbit-system group so "Hide on the planet → System" hides the quarter too.
    const host = ctx.scene.getObjectByName("orbit-system") ?? ctx.scene;
    host.add(quarter.group);
    reduced = prefersReducedMotion();
    try {
      matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => (reduced = e.matches));
    } catch {
      /* old browsers: keep the first reading */
    }
    refreshGates(ctx);
    refreshPlants(ctx);
    mountChips();
    paintCampus();
    paintClinic();
    // The marks follow the data and the houses: a case opening or healing, a house moving to its
    // AUTO lot (#22), a session retired (its house hides: no mark), a new house standing up.
    onClinicChange(() => paintClinic());
    parts.agents?.onHousesMoved(() => paintClinic());
    ctx.store.onAgentsRemoved(() => paintClinic());
    onExplainChange(() => updateChips(ctx));
    for (const a of ctx.store.agents.values()) prevStates.set(a.id, agentStateOf(a.id));
    for (const ap of pendingApprovals()) seenApprovals.add(ap.id);
    for (const a of ctx.store.activities) seenActivity.add(a.id); // history, not live traffic
    ctx.store.onActivity((fresh) => onActivities(fresh, ctx));
    ctx.store.onObjects(() => refreshGates(ctx));
    let plantTimer: ReturnType<typeof setTimeout> | null = null;
    ctx.store.onAgents(() => {
      if (plantTimer) return;
      plantTimer = setTimeout(() => {
        plantTimer = null;
        refreshPlants(ctx);
        paintClinic();
      }, 1000);
    });
    onAgentStates(() => onStates(ctx));
    onApprovalsChange(() => onApprovals(ctx));
    const clear = (c: number): string => (c === Infinity ? "no neighbour" : `${c.toFixed(1)} clear`);
    const cs = quarter.campus.slots.map((c) => `${c.id} ${clear(c.clearance)}`).join(", ");
    log.info("system-places", `System Quarter: ${PLACE_IDS.length} places, ${configured.size}/4 gates configured; campus: ${cs || "no slot"}; clinic ${clear(quarter.clinic.slot.clearance)}`);
  },
  onSnapshot(world: WorldSnapshot, ctx) {
    campusSnapshot(world);
    const docs = world.extras?.["router.docCount"];
    routerDocs = typeof docs === "number" && Number.isFinite(docs) ? docs : routerDocs;
    if (quarter) {
      refreshGates(ctx);
      refreshPlants(ctx);
      paintClinic(); // a reconnect reloads the store's sessions
    }
  },
  onFrame(dt, ctx) {
    if (!quarter) return;
    const elapsed = ctx.elapsed();
    updateOrbs(elapsed);
    if (pool.active > 0 || quarter.couriers.count > 0) updateCouriers(Math.min(dt, 0.1), elapsed);
    if (quarterVisible()) swayBanners(quarter, elapsed, reduced);
    updateChips(ctx);
  },
};
