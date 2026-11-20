import * as THREE from "three";
import type { AgentState } from "../../../shared/features/agent-state";
import type { WorldAgent } from "../../../shared/types";
import { CITY_SURFACE, cityMatrix, cityPoint, lotLocal, surfaceFrame, type CityLayout } from "../layout";
import { arrivalPopScale, blendAnim, creatureAnimFor, crossfadeK, facingCameraWindow, type CreatureAnim } from "../features/game-feel/game-feel-lib";
import { carCity, planeHome } from "./house-home";
import { hashString } from "./noise";
import { merge, painted, toon, windowMaterial } from "./toon";
import type { PickRegistry } from "./pick";
import { registerSceneParts } from "./scene-bus";
import { buildCreatures, FAMILY_SCALE, modelFamily, type CreaturePlacement } from "./creatures";

/** Arrival "pop" (game-feel item 6) plays over this many seconds. */
const ARRIVAL_POP_S = 0.4;

const DAY_MS = 86_400_000;
const FADED = new THREE.Color(0xd8cfee);
/** Filtered-out houses wash toward this (the orbit filter's "15%"). */
const WASHED = new THREE.Color(0xf1ecff);
const CAR_SCALE = 1.6;
const PUFF_CAPACITY = 700;
const PUFF_LIFE = 3.2;
/** Above every landmark tower (tallest crown tops out around 12.3). */
const CRUISE_ALT = 14;

/** Role colours pumped up for the toon look (saturated, mid lightness). */
export function vivid(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.max(hsl.s, 0.78), THREE.MathUtils.clamp(hsl.l, 0.5, 0.6));
}

interface Trip {
  fromDir: THREE.Vector3;
  toDir: THREE.Vector3;
  objectId: string | null;
  phase: "go" | "dwell" | "back";
  t: number;
  dur: number;
  /** false for a dispatch car rolling out of its tower: no dwell, no return. */
  returns: boolean;
}

interface CarState {
  agentId: string;
  city: CityLayout;
  angle: number;
  speed: number; // radians / s around the ring
  lane: number; // tangent offset from ring centre line
  trip?: Trip;
  /** Dispatch cars are temporary: removed after this elapsed time. */
  expiresAt?: number;
}

const DISPATCH_PREFIX = "dispatch:";
const ZERO = new THREE.Vector3(0, 0, 0);
const DISPATCH_COLOR = new THREE.Color(0xffc300);

interface PlaneState {
  agentId: string;
  group: THREE.Group;
  prop: THREE.Object3D;
  fromDir: THREE.Vector3;
  toDir: THREE.Vector3;
  toCity: CityLayout;
  t: number;
  duration: number;
  holding: boolean;
  returning: boolean;
  holdAngle: number;
  lastPuff: number;
  /** Per-plane altitude/holding offsets so planes from one city don't overlap. */
  lane: number;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
}

export interface AgentsVisual {
  group: THREE.Group;
  upsert(agent: WorldAgent): void;
  update(dt: number, elapsed: number): void;
  positionOf(agentId: string): THREE.Vector3 | undefined;
  /** Planes currently in the air, for the ride camera. */
  flyingPlanes(): { agentId: string; pos: THREE.Vector3; forward: THREE.Vector3 }[];
  /** Top of the agent's house (for pips and "!" bubbles). */
  houseTopOf(agentId: string): THREE.Vector3 | undefined;
  /** Moves an agent's house to local (x, z) of `city`, `y` above its plateau (a sub-district lot
   *  on open ground). Instance matrices only: nothing is rebuilt. A moved live agent parks its car
   *  (its creature wanders the house, positionOf is the house) and its plane leaves from the lot.
   *  Callers holding houseTopOf vectors refresh them. False for an unknown agent. */
  moveHouse(agentId: string, city: CityLayout, x: number, z: number, y: number): boolean;
  /** Called once (a microtask later) after a batch of moveHouse calls. */
  onHousesMoved(fn: () => void): void;
  /** Sends a live agent's car to a building and back. False if it has no car or is already on a trip. */
  startTrip(agentId: string, objectId: string, target: THREE.Vector3): boolean;
  /** A new car rolls out of the city's tower onto its ring road (after a dispatch). */
  spawnDispatchCar(islandId: string, elapsed: number): void;
  /** Called when a trip reaches its building. */
  onArrive(fn: (agentId: string, objectId: string) => void): void;
  /** Orbit filter: agents that don't match fade and shrink (houses) or hide (creatures, cars, planes). null = all. */
  setFilter(match: ((agent: WorldAgent) => boolean) | null): void;
  /** Retired agents vanish: house, creature, car and plane hidden and unpickable. Composes with setFilter. */
  hide(ids: ReadonlySet<string>): void;
  /** Archipelago theme: cars become boats. */
  setVehicle(kind: "car" | "boat"): void;
  setPlanesVisible(on: boolean): void;
  // ---- game feel (P4a, round 10) ----
  /** Per-agent life data driving the creature's pose (game-feel/life.ts). `null` clears it,
   *  falling back to the old live/dormant wander so the planet never looks broken mid-boot. */
  setAnim(id: string, state: AgentState | null, activityRate: number): void;
  /** Houses "calling for you" (waiting/permission): a slow scale pulse. */
  setCalling(ids: ReadonlySet<string>): void;
  /** Arrival pop: house scale 0 -> 1.1 -> 1 over ~0.4s (a brand-new live session). */
  popHouse(agentId: string): void;
  /** Reuses the plane-contrail puff pool for a one-off dust puff (retire pack-up). */
  puffAt(pos: THREE.Vector3): void;
  /** 0 (day) .. 1 (night): blends every house's windows a little toward "lit", live ones stay full. */
  setNightGlow(amount: number): void;
  /** prefers-reduced-motion: poses keep their shape but drop the oscillation. */
  setReducedMotion(on: boolean): void;
}

export interface AgentsInput {
  agents: WorldAgent[];
  layout: Map<string, CityLayout>;
  /** Lots already taken by file buildings, per island (houses go after them). */
  fileLots: Map<string, number>;
  pick: PickRegistry;
  /** Round 11 topic continents: the layout id an agent's house stands in (a catch-all folder's
   *  sessions live in per-topic neighbourhoods). Defaults to the agent's own island. */
  homeKey?: (agent: WorldAgent) => string;
}

function carGeometry(): THREE.BufferGeometry {
  const parts = [
    painted(new THREE.BoxGeometry(0.5, 0.24, 0.9).translate(0, 0.2, 0), 0xffffff),
    painted(new THREE.BoxGeometry(0.42, 0.2, 0.46).translate(0, 0.42, -0.06), 0xe8f6ff),
  ];
  for (const [x, z] of [
    [-0.25, 0.28],
    [0.25, 0.28],
    [-0.25, -0.28],
    [0.25, -0.28],
  ] as const) {
    parts.push(painted(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10).rotateZ(Math.PI / 2).translate(x, 0.1, z), 0x2a2238));
  }
  return merge(parts);
}

function boatGeometry(): THREE.BufferGeometry {
  const hull = new THREE.CylinderGeometry(0.34, 0.2, 0.9, 4, 1).rotateY(Math.PI / 4).scale(0.8, 0.3, 1.25).translate(0, 0.14, 0);
  return merge([
    painted(hull, 0xffffff),
    painted(new THREE.BoxGeometry(0.34, 0.06, 0.62).translate(0, 0.29, 0), 0xfff1d6),
    painted(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 5).translate(0, 0.65, 0.02), 0x8a5a35),
    painted(new THREE.ConeGeometry(0.3, 0.62, 3).scale(0.25, 1, 1).translate(0, 0.66, -0.12), 0xfffdf6),
  ]);
}

function lightsGeometry(): THREE.BufferGeometry {
  return merge([
    painted(new THREE.BoxGeometry(0.1, 0.08, 0.04).translate(-0.15, 0.24, 0.46), 0xfff27a),
    painted(new THREE.BoxGeometry(0.1, 0.08, 0.04).translate(0.15, 0.24, 0.46), 0xfff27a),
    painted(new THREE.BoxGeometry(0.1, 0.07, 0.04).translate(-0.15, 0.24, -0.46), 0xff3048),
    painted(new THREE.BoxGeometry(0.1, 0.07, 0.04).translate(0.15, 0.24, -0.46), 0xff3048),
  ]);
}

export function buildPlaneModel(color: THREE.Color): { group: THREE.Group; prop: THREE.Object3D } {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.5, 4, 10).rotateX(Math.PI / 2), toon(color));
  const white = toon(0xffffff);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.55).translate(0, 0, 0.1), white);
  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.3).translate(0, 0.05, -0.95), white);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.36).translate(0, 0.3, -0.95), toon(color));
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8).translate(0, 0.2, 0.45), toon(0x9fe8ff));
  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.04), toon(0x3a2d4d));
  prop.position.z = 1.1;
  group.add(body, wings, tailWing, fin, cockpit, prop);
  group.scale.setScalar(1.25);
  return { group, prop };
}

export function buildAgents(input: AgentsInput): AgentsVisual {
  const { layout, pick } = input;
  const homeOf = input.homeKey ?? ((a: WorldAgent): string => a.islandId);
  /** Agents whose house moveHouse put in a sub-district lot → that lot (see house-home.ts). */
  const movedTo = new Map<string, CityLayout>();
  const movedListeners: (() => void)[] = [];
  let movedPending = false;
  const group = new THREE.Group();
  group.name = "agents";
  const agents = new Map<string, WorldAgent>();
  const capacity = input.agents.length + 256;
  const tmpM = new THREE.Matrix4();

  // ---- houses: one per agent (footprint of a city grows with its agents) ----
  const wallMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.6, 0.5, 0.6).translate(0, 0.25, 0),
    windowMaterial({ wall: 0xfffaf0, grid: [2, 1.4] }),
    capacity,
  );
  const roofMesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.5, 0.42, 4).rotateY(Math.PI / 4).translate(0, 0.71, 0),
    toon(0xffffff),
    capacity,
  );
  const houseLit = new Float32Array(capacity);
  wallMesh.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(houseLit, 1));
  wallMesh.count = 0;
  roofMesh.count = 0;
  wallMesh.name = "houses";
  roofMesh.name = "roofs";
  group.add(wallMesh, roofMesh);
  const houseIndex = new Map<string, number>();
  const houseIds: string[] = [];
  const houseTop = new Map<string, THREE.Vector3>();
  /** `y`: base height relative to the city plateau (0 in a city; a sub-district lot on open ground sets it from the terrain). */
  const houseLot = new Map<string, { city: CityLayout; x: number; z: number; y: number; phase: number; yaw: number }>();
  let filter: ((a: WorldAgent) => boolean) | null = null;
  const hidden = new Set<string>();
  // ---- game feel (P4a, round 10) ----
  const anims = new Map<string, { anim: CreatureAnim; prev: CreatureAnim; changedAt: number }>();
  const calling = new Set<string>();
  const popping = new Map<string, number>(); // agentId -> elapsed at pop start
  const pulseScale = new THREE.Vector3();
  let nightGlow = 0;
  let reduced = false;
  const matches = (id: string): boolean => {
    if (hidden.has(id)) return false;
    if (!filter) return true;
    const a = agents.get(id);
    return a ? filter(a) : true;
  };
  let planesVisible = true;
  const nextLot = new Map<string, number>(input.fileLots);
  const housePick = (id: number | undefined): { kind: "agent"; id: string } | null => {
    const aid = id === undefined ? undefined : houseIds[id];
    return aid && !hidden.has(aid) ? { kind: "agent", id: aid } : null;
  };
  pick.register(wallMesh, housePick);
  pick.register(roofMesh, housePick);

  function paintHouse(agent: WorldAgent, idx: number): void {
    const ageDays = Math.max(0, (Date.now() - Date.parse(agent.lastActive)) / DAY_MS);
    const fade = agent.status === "live" ? 0 : 0.2 + 0.45 * Math.min(1, Math.log1p(ageDays) / Math.log1p(60));
    const gone = hidden.has(agent.id);
    const shown = !gone && (!filter || filter(agent));
    roofMesh.setColorAt(idx, shown ? vivid(agent.color).lerp(FADED, fade) : vivid(agent.color).lerp(WASHED, 0.85));
    // Live windows stay fully lit; everyone else's windows glow a little warmer as night falls
    // (game-feel item 5) instead of the flat "asleep" slate all day and all night.
    houseLit[idx] = !shown ? 0 : agent.status === "live" ? 1 : nightGlow * 0.55;
    const lot = houseLot.get(agent.id);
    if (lot) {
      const k = gone ? 0.0001 : shown ? 1.2 : 0.62;
      wallMesh.setMatrixAt(idx, cityMatrix(lot.city, lot.x, lot.z, lot.y, lot.yaw, new THREE.Vector3(k, k, k), tmpM));
      roofMesh.setMatrixAt(idx, tmpM);
      wallMesh.instanceMatrix.needsUpdate = true;
      roofMesh.instanceMatrix.needsUpdate = true;
    }
    const attr = wallMesh.geometry.getAttribute("aLit");
    attr.needsUpdate = true;
    if (roofMesh.instanceColor) roofMesh.instanceColor.needsUpdate = true;
  }

  function addHouse(agent: WorldAgent): void {
    const home = homeOf(agent);
    const city = layout.get(home);
    if (!city || wallMesh.count >= capacity) return;
    const lot = nextLot.get(home) ?? 0;
    nextLot.set(home, lot + 1);
    const [x, z] = lotLocal(lot);
    const idx = wallMesh.count;
    const yaw = Math.atan2(x, z) + ((hashString(agent.id) % 7) - 3) * 0.08;
    const s = new THREE.Vector3(1.2, 1.2, 1.2);
    wallMesh.setMatrixAt(idx, cityMatrix(city, x, z, 0, yaw, s, tmpM));
    roofMesh.setMatrixAt(idx, tmpM);
    wallMesh.count = idx + 1;
    roofMesh.count = idx + 1;
    wallMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
    wallMesh.boundingSphere = null;
    roofMesh.boundingSphere = null;
    houseIndex.set(agent.id, idx);
    houseIds[idx] = agent.id;
    houseTop.set(agent.id, cityPoint(city, x, z, 1.1));
    houseLot.set(agent.id, { city, x, z, y: 0, phase: (hashString(agent.id) % 628) / 100, yaw });
    paintHouse(agent, idx);
  }

  // Recent agents live closest to the tower.
  const sorted = input.agents.slice().sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  for (const a of sorted) {
    agents.set(a.id, a);
    addHouse(a);
  }

  // ---- cars: live agents drive their city's ring road ----
  const carGeo = carGeometry();
  let boatGeo: THREE.BufferGeometry | null = null;
  const carMesh = new THREE.InstancedMesh(carGeo, toon(0xffffff, { vertexColors: true }), capacity);
  const lightMesh = new THREE.InstancedMesh(lightsGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }), capacity);
  carMesh.count = 0;
  lightMesh.count = 0;
  carMesh.frustumCulled = false;
  lightMesh.frustumCulled = false;
  carMesh.name = "cars";
  group.add(carMesh, lightMesh);
  const cars: CarState[] = [];
  pick.register(
    carMesh,
    (id) => {
      const c = id === undefined ? undefined : cars[id];
      return c && !c.agentId.startsWith(DISPATCH_PREFIX) ? { kind: "agent", id: c.agentId } : null;
    },
    { dynamic: true },
  );

  // ---- model creatures: dormant ones wander around their house, live ones ride their car ----
  const creatures = buildCreatures(capacity);
  group.add(creatures.group);
  for (const mesh of creatures.group.children) {
    pick.register(mesh, (id) => {
      const aid = creatures.idAt(mesh, id);
      return aid ? { kind: "agent", id: aid } : null;
    });
  }
  const creatureM = new THREE.Matrix4();
  const creatureOffset = new THREE.Matrix4();
  const creatureScale = new THREE.Vector3();
  let creatureFrame = 0;
  /** The blended (crossfaded) pose for one agent right now; falls back to a plain
   *  working/sleeping pose when game-feel hasn't fed this id an anim yet. */
  function poseFor(id: string, elapsed: number, fallback: CreatureAnim): CreatureAnim {
    const rec = anims.get(id);
    if (!rec) return fallback;
    const k = crossfadeK(elapsed - rec.changedAt);
    return k >= 1 ? rec.anim : blendAnim(rec.prev, rec.anim, k);
  }

  function placeCreatures(elapsed: number): void {
    const list: CreaturePlacement[] = [];
    const carIndex = new Map(cars.map((c, i) => [c.agentId, i]));
    const fallbackWorking = creatureAnimFor("working", 0);
    const fallbackSleeping = creatureAnimFor("sleeping", 0);
    for (const [id, lot] of houseLot) {
      const a = agents.get(id);
      if (!a || planes.has(id) || !matches(id)) continue;
      const family = modelFamily(a.model);
      const k = FAMILY_SCALE[family];
      const ci = carIndex.get(id);
      if (ci !== undefined) {
        // Riding on the roof, bobbing — the rate comes from how busy the agent's last 60s
        // were (game-feel item 1).
        carMesh.getMatrixAt(ci, creatureM);
        const pose = poseFor(id, elapsed, fallbackWorking);
        const baseHz = family === "haiku" ? 9 : 6;
        const hop = reduced ? 0.05 : Math.abs(Math.sin(elapsed * baseHz * Math.max(0.6, pose.bobRate / 2) + lot.phase)) * (0.1 + pose.bobAmp);
        creatureOffset.makeScale(k * 0.62, k * 0.62, k * 0.62).setPosition(0, 0.78 + hop, -0.05);
        list.push({ agentId: id, family, matrix: creatureM.clone().multiply(creatureOffset) });
        continue;
      }
      // Wander around the house; the pattern, speed and bob come from the agent's game-feel
      // state (game-feel item 1) so it reads like an RTS unit at a glance: a full loop while
      // "working"/"idle", a pace in front of the door with a periodic pause "to look at you"
      // while "waiting"/"permission", and a tiny curl while "sleeping".
      const pose = poseFor(id, elapsed, a.status === "live" ? fallbackWorking : fallbackSleeping);
      const facingNow = !reduced && pose.facesCamera && facingCameraWindow(elapsed, lot.phase);
      const curling = pose.pattern === "curl";
      const pacing = pose.pattern === "pace";
      const speed = curling ? 0.03 : family === "haiku" ? 0.5 : 0.18;
      const paceAngle = pacing ? Math.sin(elapsed * 0.8 + lot.phase) * 0.5 : 0;
      const ang = facingNow ? lot.phase : pacing ? lot.phase + paceAngle : lot.phase + elapsed * speed;
      const r = curling ? 0.2 : 0.62 + Math.sin(elapsed * 0.4 + lot.phase) * 0.08;
      const bobT = reduced ? 0 : Math.abs(Math.sin(elapsed * pose.bobRate + lot.phase));
      const bob = bobT * pose.bobAmp + (a.status === "live" && !curling ? bobT * 0.15 : 0);
      const poseScale = reduced ? Math.max(pose.poseScale, 0.9) : pose.poseScale;
      creatureScale.setScalar(k * 0.5 * poseScale);
      list.push({
        agentId: id,
        family,
        matrix: cityMatrix(lot.city, lot.x + Math.cos(ang) * r, lot.z + Math.sin(ang) * r, lot.y + 0.23 * k * poseScale + bob, ang + Math.PI, creatureScale, new THREE.Matrix4()),
      });
    }
    creatures.set(list);
  }

  // ---- planes: roaming agents fly great-circle arcs to their target city ----
  const planes = new Map<string, PlaneState>();
  const puffMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), toon(0xffffff), PUFF_CAPACITY);
  puffMesh.frustumCulled = false;
  puffMesh.name = "contrails";
  const puffPos: THREE.Vector3[] = [];
  const puffBorn = new Float32Array(PUFF_CAPACITY).fill(-100);
  for (let i = 0; i < PUFF_CAPACITY; i++) {
    puffPos.push(new THREE.Vector3());
    puffMesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
  }
  let puffHead = 0;
  group.add(puffMesh);

  function isRoaming(a: WorldAgent): boolean {
    return a.targetIslandId !== a.islandId && layout.has(a.targetIslandId);
  }

  let now = 0;
  let arriveFn: ((agentId: string, objectId: string) => void) | null = null;
  let dispatchSeq = 0;

  function syncCars(): void {
    const keep = new Map(cars.map((c) => [c.agentId, c]));
    const fresh = new Set<string>();
    const temps = cars.filter((c) => c.expiresAt !== undefined && c.expiresAt > now);
    cars.length = 0;
    for (const a of agents.values()) {
      const city = carCity(a, planes.has(a.id), movedTo, layout.get(homeOf(a)));
      if (!city) continue;
      const existing = keep.get(a.id);
      if (existing) {
        cars.push(existing);
        continue;
      }
      const h = hashString(a.id);
      const dirSign = h % 2 === 0 ? 1 : -1;
      const rr = city.radius + 0.1;
      // Same speed per lane, so cars never drive through each other; angles are spread below.
      cars.push({ agentId: a.id, city, angle: 0, speed: (dirSign * 1.9) / rr, lane: dirSign * 0.22 });
      fresh.add(a.id);
    }
    // Spread newly placed cars evenly around each ring, per lane.
    const perLane = new Map<string, CarState[]>();
    for (const c of cars) {
      const key = `${c.city.id}|${Math.sign(c.lane)}`;
      const list = perLane.get(key) ?? [];
      list.push(c);
      perLane.set(key, list);
    }
    for (const list of perLane.values()) {
      const anchor = list.find((c) => !fresh.has(c.agentId))?.angle ?? (hashString(list[0]?.city.id ?? "") % 628) / 100;
      list.forEach((c, k) => {
        if (fresh.has(c.agentId)) c.angle = anchor + (k * Math.PI * 2) / list.length;
      });
    }
    cars.push(...temps);
    carMesh.count = cars.length;
    lightMesh.count = cars.length;
    cars.forEach((c, i) => {
      const a = agents.get(c.agentId);
      carMesh.setColorAt(i, a ? vivid(a.color) : DISPATCH_COLOR);
    });
    if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
  }

  function startLeg(p: PlaneState, fromDir: THREE.Vector3, toCity: CityLayout, returning: boolean): void {
    p.fromDir.copy(fromDir).normalize();
    p.toDir.copy(toCity.dir);
    p.toCity = toCity;
    p.t = 0;
    p.duration = Math.max(5, (p.fromDir.angleTo(p.toDir) * CITY_SURFACE) / 7);
    p.holding = false;
    p.returning = returning;
  }

  function syncPlane(a: WorldAgent): void {
    const existing = planes.get(a.id);
    if (isRoaming(a)) {
      const target = layout.get(a.targetIslandId);
      const home = planeHome(a.id, movedTo, layout.get(homeOf(a)));
      if (!target || !home) return;
      if (existing) {
        if (existing.toCity.id !== target.id) startLeg(existing, existing.pos, target, false);
        return;
      }
      const { group: model, prop } = buildPlaneModel(vivid(a.color));
      model.userData = { agentId: a.id };
      const p: PlaneState = {
        agentId: a.id,
        group: model,
        prop,
        fromDir: new THREE.Vector3(),
        toDir: new THREE.Vector3(),
        toCity: target,
        t: 0,
        duration: 1,
        holding: false,
        returning: false,
        holdAngle: 0,
        lastPuff: 0,
        lane: planes.size % 4,
        pos: home.dir.clone().multiplyScalar(CITY_SURFACE + 2),
        forward: new THREE.Vector3(),
      };
      startLeg(p, home.dir, target, false);
      planes.set(a.id, p);
      group.add(model);
      pick.register(model, () => (hidden.has(a.id) ? null : { kind: "agent", id: a.id }));
    } else if (existing && !existing.returning) {
      const home = planeHome(a.id, movedTo, layout.get(homeOf(a)));
      if (home) startLeg(existing, existing.pos, home, true);
    }
  }

  function removePlane(p: PlaneState): void {
    group.remove(p.group);
    pick.unregister(p.group);
    planes.delete(p.agentId);
    syncCars();
  }

  for (const a of agents.values()) syncPlane(a);
  syncCars();

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const scale = new THREE.Vector3(CAR_SCALE, CAR_SCALE, CAR_SCALE);
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();

  function planePoint(p: PlaneState, t: number, elapsed: number, out: THREE.Vector3): THREE.Vector3 {
    if (p.holding) {
      const a = p.holdAngle + t;
      const r = 9 + p.lane * 2.5;
      return cityPoint(p.toCity, Math.cos(a) * r, Math.sin(a) * r, CRUISE_ALT + p.lane * 1.8, out);
    }
    const ang = p.fromDir.angleTo(p.toDir);
    const axis = ahead.crossVectors(p.fromDir, p.toDir);
    if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
    axis.normalize();
    const alt = CRUISE_ALT + p.lane * 1.8 + 3 * Math.sin(Math.PI * t) + Math.sin(elapsed * 1.3) * 0.15;
    return out.copy(p.fromDir).applyAxisAngle(axis, ang * t).multiplyScalar(CITY_SURFACE + alt);
  }

  function ringDir(c: CarState, out: THREE.Vector3): THREE.Vector3 {
    const rr = c.city.radius + 0.1 + c.lane;
    return cityPoint(c.city, Math.cos(c.angle) * rr, Math.sin(c.angle) * rr, 0, out).normalize();
  }

  function tripDuration(from: THREE.Vector3, to: THREE.Vector3): number {
    return THREE.MathUtils.clamp((from.angleTo(to) * CITY_SURFACE) / 30, 1.1, 3.4);
  }

  const slerpQ = new THREE.Quaternion();
  function tripPoint(trip: Trip, t: number, out: THREE.Vector3): THREE.Vector3 {
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    slerpQ.setFromUnitVectors(trip.fromDir, trip.toDir);
    out.copy(trip.fromDir).applyQuaternion(new THREE.Quaternion().slerp(slerpQ, e));
    const arc = trip.fromDir.angleTo(trip.toDir) * CITY_SURFACE;
    const hop = Math.min(7, arc * 0.12) + 0.4;
    return out.multiplyScalar(CITY_SURFACE + 0.08 + hop * Math.sin(Math.PI * t));
  }

  function stepCar(c: CarState, dt: number): void {
    const trip = c.trip;
    if (!trip) {
      c.angle += c.speed * dt;
      const rr = c.city.radius + 0.1 + c.lane;
      cityPoint(c.city, Math.cos(c.angle) * rr, Math.sin(c.angle) * rr, 0.08, pos);
      const a2 = c.angle + Math.sign(c.speed) * 0.05;
      cityPoint(c.city, Math.cos(a2) * rr, Math.sin(a2) * rr, 0.08, ahead);
      fwd.subVectors(ahead, pos);
      return;
    }
    if (trip.phase === "dwell") {
      trip.t += dt;
      pos.copy(trip.toDir).multiplyScalar(CITY_SURFACE + 0.08);
      if (trip.t >= 0.55) {
        trip.phase = "back";
        trip.fromDir.copy(trip.toDir);
        ringDir(c, trip.toDir);
        trip.t = 0;
        trip.dur = tripDuration(trip.fromDir, trip.toDir);
      }
      return; // keep last forward
    }
    trip.t = Math.min(1, trip.t + dt / trip.dur);
    tripPoint(trip, trip.t, pos);
    tripPoint(trip, Math.min(1, trip.t + 0.02), ahead);
    if (ahead.distanceToSquared(pos) > 1e-8) fwd.subVectors(ahead, pos);
    if (trip.t < 1) return;
    if (trip.phase === "go" && trip.returns) {
      trip.phase = "dwell";
      trip.t = 0;
      if (trip.objectId) arriveFn?.(c.agentId, trip.objectId);
    } else {
      c.trip = undefined;
    }
  }

  function spawnPuff(at: THREE.Vector3, elapsed: number): void {
    const i = puffHead;
    puffHead = (puffHead + 1) % PUFF_CAPACITY;
    puffPos[i]?.copy(at);
    puffBorn[i] = elapsed;
  }

  const visual: AgentsVisual = {
    group,
    upsert(agent) {
      const prev = agents.get(agent.id);
      agents.set(agent.id, agent);
      const idx = houseIndex.get(agent.id);
      if (idx === undefined) addHouse(agent);
      else paintHouse(agent, idx);
      syncPlane(agent);
      if (!prev || prev.status !== agent.status) syncCars();
    },

    update(dt, elapsed) {
      now = elapsed;
      if (cars.some((c) => c.expiresAt !== undefined && c.expiresAt <= elapsed)) syncCars();
      // Cars.
      cars.forEach((c, i) => {
        stepCar(c, dt);
        surfaceFrame(pos, fwd, tmpM);
        tmpM.scale(matches(c.agentId) ? scale : ZERO);
        carMesh.setMatrixAt(i, tmpM);
        lightMesh.setMatrixAt(i, tmpM);
      });
      if (cars.length) {
        carMesh.instanceMatrix.needsUpdate = true;
        lightMesh.instanceMatrix.needsUpdate = true;
      }

      // Planes.
      for (const p of planes.values()) {
        if (p.holding) {
          p.holdAngle += dt * 0.35;
        } else {
          p.t = Math.min(1, p.t + dt / p.duration);
        }
        planePoint(p, p.holding ? 0 : p.t, elapsed, p.pos);
        const next = planePoint(p, p.holding ? 0.05 : Math.min(1, p.t + 0.01), elapsed, new THREE.Vector3());
        if (next.distanceToSquared(p.pos) > 1e-6) p.forward.subVectors(next, p.pos).normalize();
        surfaceFrame(p.pos, p.forward, tmpM);
        tmpM.decompose(p.group.position, tmpQ, tmpS);
        p.group.quaternion.copy(tmpQ);
        p.group.rotateZ(p.holding ? -0.35 : Math.sin(elapsed * 0.8) * 0.12);
        p.prop.rotation.z += dt * 30;
        p.group.visible = planesVisible && matches(p.agentId);
        if (elapsed - p.lastPuff > 0.07) {
          p.lastPuff = elapsed;
          spawnPuff(pos.copy(p.pos).addScaledVector(p.forward, -1.7), elapsed);
        }
        if (!p.holding && p.t >= 1) {
          if (p.returning) {
            removePlane(p);
          } else {
            p.holding = true;
            p.holdAngle = 0;
          }
        }
      }

      // Contrail puffs: pop in, swell, then shrink away.
      let anyPuff = false;
      for (let i = 0; i < PUFF_CAPACITY; i++) {
        const age = elapsed - (puffBorn[i] ?? -100);
        const p = puffPos[i];
        if (!p) continue;
        if (age < 0 || age > PUFF_LIFE) {
          if (age < PUFF_LIFE + 0.2 && age > PUFF_LIFE) {
            puffMesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
            anyPuff = true;
          }
          continue;
        }
        const grow = Math.min(1, age / 0.35);
        const s = (0.2 + 0.45 * grow) * (1 - age / PUFF_LIFE) + 0.02;
        tmpM.makeScale(s, s, s).setPosition(p);
        puffMesh.setMatrixAt(i, tmpM);
        anyPuff = true;
      }
      if (anyPuff) puffMesh.instanceMatrix.needsUpdate = true;
      // Creatures every other frame (311 matrices).
      if (creatureFrame++ % 2 === 0) placeCreatures(elapsed);

      // Houses "calling for you" (waiting/permission) pulse — bounded to the few agents that
      // need you, so this is cheap even on a full fleet (game-feel item 4).
      let houseTouched = false;
      for (const id of calling) {
        if (!matches(id)) continue;
        const idx = houseIndex.get(id);
        const lot = houseLot.get(id);
        if (idx === undefined || !lot) continue;
        const pulse = reduced ? 1 : 1 + 0.08 * Math.sin(elapsed * 3.2 + lot.phase);
        wallMesh.setMatrixAt(idx, cityMatrix(lot.city, lot.x, lot.z, lot.y, lot.yaw, pulseScale.setScalar(1.2 * pulse), tmpM));
        roofMesh.setMatrixAt(idx, tmpM);
        houseTouched = true;
      }
      // Arrival pop: a brand-new live house bounces in over ARRIVAL_POP_S (game-feel item 6).
      if (popping.size) {
        for (const [id, startAt] of popping) {
          const t = (elapsed - startAt) / ARRIVAL_POP_S;
          const idx = houseIndex.get(id);
          const lot = houseLot.get(id);
          if (t >= 1 || idx === undefined || !lot) {
            popping.delete(id);
            continue;
          }
          const k = (matches(id) ? 1.2 : 0.62) * arrivalPopScale(t);
          wallMesh.setMatrixAt(idx, cityMatrix(lot.city, lot.x, lot.z, lot.y, lot.yaw, pulseScale.setScalar(k), tmpM));
          roofMesh.setMatrixAt(idx, tmpM);
          houseTouched = true;
        }
      }
      if (houseTouched) {
        wallMesh.instanceMatrix.needsUpdate = true;
        roofMesh.instanceMatrix.needsUpdate = true;
      }
    },

    positionOf(agentId) {
      const plane = planes.get(agentId);
      if (plane) return plane.pos;
      const ci = cars.findIndex((c) => c.agentId === agentId);
      if (ci >= 0) {
        carMesh.getMatrixAt(ci, tmpM);
        return new THREE.Vector3().setFromMatrixPosition(tmpM);
      }
      return houseTop.get(agentId);
    },

    houseTopOf(agentId) {
      return houseTop.get(agentId);
    },

    moveHouse(agentId, city, x, z, y) {
      const lot = houseLot.get(agentId);
      const idx = houseIndex.get(agentId);
      const agent = agents.get(agentId);
      if (!lot || idx === undefined || !agent) return false;
      houseLot.set(agentId, { ...lot, city, x, z, y, yaw: Math.atan2(x, z) + ((hashString(agentId) % 7) - 3) * 0.08 });
      houseTop.set(agentId, cityPoint(city, x, z, y + 1.1));
      wallMesh.boundingSphere = null;
      roofMesh.boundingSphere = null;
      paintHouse(agent, idx);
      const hadCar = cars.some((c) => c.agentId === agentId);
      movedTo.set(agentId, city);
      if (hadCar) syncCars(); // its car parks: the creature and the marker follow the house
      // Already flying home when the move landed: retarget its landing instead of arriving at the
      // old city (a plane mid-outbound leg is unaffected — it's headed somewhere else entirely).
      const plane = planes.get(agentId);
      if (plane?.returning && plane.toCity.id !== city.id) startLeg(plane, plane.pos, city, true);
      if (!movedPending) {
        movedPending = true;
        queueMicrotask(() => {
          movedPending = false;
          for (const fn of movedListeners) fn();
        });
      }
      return true;
    },

    onHousesMoved(fn) {
      movedListeners.push(fn);
    },

    startTrip(agentId, objectId, target) {
      const c = cars.find((car) => car.agentId === agentId);
      if (!c || c.trip) return false;
      const from = ringDir(c, new THREE.Vector3());
      const to = target.clone().normalize();
      c.trip = { fromDir: from, toDir: to, objectId, phase: "go", t: 0, dur: tripDuration(from, to), returns: true };
      return true;
    },

    spawnDispatchCar(islandId, elapsed) {
      const city = layout.get(islandId);
      if (!city) return;
      const rr = city.radius + 0.1 - 0.22;
      const c: CarState = {
        agentId: `${DISPATCH_PREFIX}${dispatchSeq++}`,
        city,
        angle: Math.random() * Math.PI * 2,
        speed: -1.9 / (city.radius + 0.1),
        lane: -0.22,
        expiresAt: elapsed + 25,
      };
      const from = city.dir.clone();
      const to = ringDir(c, new THREE.Vector3());
      c.trip = { fromDir: from, toDir: to, objectId: null, phase: "go", t: 0, dur: Math.max(1.2, rr / 3), returns: false };
      cars.push(c);
      carMesh.count = cars.length;
      lightMesh.count = cars.length;
      carMesh.setColorAt(cars.length - 1, DISPATCH_COLOR);
      if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
    },

    onArrive(fn) {
      arriveFn = fn;
    },

    setFilter(match) {
      filter = match;
      for (const [id, idx] of houseIndex) {
        const a = agents.get(id);
        if (a) paintHouse(a, idx);
      }
      placeCreatures(now);
    },

    hide(ids) {
      for (const id of ids) hidden.add(id);
      for (const id of ids) {
        const idx = houseIndex.get(id);
        const a = agents.get(id);
        if (idx !== undefined && a) paintHouse(a, idx);
        const p = planes.get(id);
        if (p) p.group.visible = false;
      }
      placeCreatures(now);
    },

    setVehicle(kind) {
      const want = kind === "boat" ? (boatGeo ??= boatGeometry()) : carGeo;
      if (carMesh.geometry !== want) carMesh.geometry = want;
      lightMesh.visible = kind === "car";
    },

    setPlanesVisible(on) {
      planesVisible = on;
      puffMesh.visible = on;
    },

    flyingPlanes() {
      return [...planes.values()].map((p) => ({ agentId: p.agentId, pos: p.pos, forward: p.forward }));
    },

    // ---- game feel (P4a, round 10) ----
    setAnim(id, state, activityRate) {
      if (!state) {
        anims.delete(id);
        return;
      }
      const next = creatureAnimFor(state, activityRate);
      const cur = anims.get(id);
      if (!cur) {
        anims.set(id, { anim: next, prev: next, changedAt: now });
        return;
      }
      const posesDiffer = cur.anim.pattern !== next.pattern || cur.anim.facesCamera !== next.facesCamera || Math.abs(cur.anim.bobRate - next.bobRate) > 0.001;
      anims.set(id, posesDiffer ? { anim: next, prev: cur.anim, changedAt: now } : { anim: next, prev: cur.prev, changedAt: cur.changedAt });
    },

    setCalling(ids) {
      calling.clear();
      for (const id of ids) calling.add(id);
    },

    popHouse(agentId) {
      if (houseIndex.has(agentId)) popping.set(agentId, now);
    },

    puffAt(pos) {
      spawnPuff(pos, now);
    },

    setNightGlow(amount) {
      const clamped = Math.max(0, Math.min(1, amount));
      if (Math.abs(clamped - nightGlow) < 0.02) return; // skip a repaint for a barely-changed value
      nightGlow = clamped;
      for (const [id, idx] of houseIndex) {
        const a = agents.get(id);
        if (a) paintHouse(a, idx);
      }
    },

    setReducedMotion(on) {
      reduced = on;
    },
  };
  registerSceneParts({ agents: visual });
  return visual;
}
