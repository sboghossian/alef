// The #/room/all "village" diorama: a bright isometric-ish 3D scene of every shown agent's room
// around a central Town square, drawn with the SHARED renderer and the planet's ink + halftone
// post pass — same technique as views/room-3d.ts (InkPost.afterNextRender + a camera view offset
// onto the stage rect): no second WebGL context. All layout/bridge/orbit maths is in
// village-lib.ts (pure, unit-tested); this file only builds and animates the THREE objects.
//
// A room here is a simplified version of room-3d.ts's single room (a plaque, a desk + monitor,
// the agent's creature, a lamp) so up to ~9 of them plus the resident's room plus rope bridges
// stay cheap to draw. Every plaque/monitor is real data the caller hands in via setData(); the
// caller (views/room.ts) is responsible for redacting it (see village-lib.ts's maybeRedact and
// room.ts's screen-line blanking) before it ever reaches this file.

import * as THREE from "three";
import { creatureGeometry, FAMILY_SCALE } from "../scene/creatures";
import { toon } from "../scene/toon";
import type { InkPost } from "../scene/post";
import { VIEW_LIGHT_DIR } from "../scene/post";
import {
  bridgeControlPoints,
  clampOrbit,
  droneOffsets,
  fitDistance,
  orbitPosition,
  residentSlot,
  sceneRadius,
  villageSlots,
  ORBIT_BASE,
  VILLAGE_ASPECT,
  VILLAGE_FOV_DEG,
  type OrbitState,
  type VillageBridge,
  type VillageSlot,
} from "./village-lib";
import { creatureMotion, lampLight, shelfSlots, stageProjection, type LampMood, type ModelKey, type Rect } from "./room-lib";

const INK = "#1a1030";
const PLAQUE_W = 900;
const PLAQUE_H = 220;
const SCREEN_W = 512;
const SCREEN_H = 320;

export interface Village3DRoomData {
  agentId: string;
  /** Short, redact-safe label (the repo/cwd basename — never the session title/prompt). */
  roomLabel: string;
  modelLabel: string;
  family: ModelKey;
  mood: LampMood;
  needsYou: boolean;
  /** Blank ([]) when the caller is redacting the screen. */
  screenLines: readonly string[];
  screenTitle: string;
  drones: number;
}

export interface Village3DResidentData {
  name: string;
  day: number;
  shelfCount: number;
  /** Blank ("") when the caller is redacting the screen. */
  journalLine: string;
}

export interface Village3DData {
  rooms: Village3DRoomData[];
  bridges: readonly VillageBridge[];
  resident: Village3DResidentData | null;
  selectedId: string | null;
}

export type Village3DHit = { kind: "room"; agentId: string } | { kind: "resident" };

export interface Village3D {
  setData(d: Village3DData): void;
  setActive(on: boolean): void;
  setStage(rect: Rect): void;
  setHover(hit: Village3DHit | null): void;
  hit(clientX: number, clientY: number): Village3DHit | null;
  /** Orbit-drag by a pixel delta (clamped — see village-lib.ts's ORBIT_LIMITS). */
  drag(dxPx: number, dyPx: number): void;
  /** Zoom by a wheel delta (clamped). */
  zoom(deltaY: number): void;
  dispose(): void;
}

export interface Village3DDeps {
  renderer: THREE.WebGLRenderer;
  post: InkPost;
  reducedMotion: boolean;
}

function canvas2d(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  return { c, g };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/(?<=[\s/_.-])/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (g.measureText(cur + w).width > maxW && cur) {
      lines.push(cur.trimEnd());
      cur = w;
      if (lines.length === maxLines) break;
    } else cur += w;
  }
  if (lines.length < maxLines && cur) lines.push(cur.trimEnd());
  return lines;
}

interface RoomRig {
  agentId: string;
  group: THREE.Group;
  plaqueCanvas: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
  plaqueTex: THREE.CanvasTexture;
  screenCanvas: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
  screenTex: THREE.CanvasTexture;
  creature: THREE.Mesh;
  family: ModelKey | null;
  lamp: THREE.PointLight;
  shade: THREE.MeshToonMaterial;
  beacon: THREE.Sprite;
  beaconTex: THREE.CanvasTexture;
  drones: THREE.Mesh[];
  platformHit: THREE.Mesh;
  data: Village3DRoomData | null;
}

export function createVillage3D(deps: Village3DDeps): Village3D {
  const { renderer, post } = deps;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const mat = (c: THREE.ColorRepresentation, o: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial => track(toon(c, o));
  const creatureMat = mat(0xffffff, { vertexColors: true });
  const droneGeo = track(new THREE.SphereGeometry(0.16, 10, 8).scale(1, 0.7, 1));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe9ff);
  const camera = new THREE.PerspectiveCamera(22, 1.6, 1, 400);
  scene.add(camera);
  const key = new THREE.DirectionalLight(0xfff4e0, 1.6);
  key.position.copy(VIEW_LIGHT_DIR).multiplyScalar(40);
  scene.add(key, new THREE.HemisphereLight(0xfff8ee, 0xbfe9c9, 1.35), new THREE.AmbientLight(0xffffff, 0.35));

  // ---- ground + plaza ----
  const ground = new THREE.Mesh(track(new THREE.CircleGeometry(60, 48)), mat(0x9fe0a0));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const plazaGroup = new THREE.Group();
  scene.add(plazaGroup);
  const plaza = new THREE.Mesh(track(new THREE.CylinderGeometry(3.4, 3.6, 0.24, 32)), mat(0xffe3ae));
  plaza.position.y = 0.12;
  plazaGroup.add(plaza);
  const plazaRing = new THREE.Mesh(track(new THREE.TorusGeometry(3.4, 0.08, 8, 32)), mat(0xffffff));
  plazaRing.rotation.x = Math.PI / 2;
  plazaRing.position.y = 0.24;
  plazaGroup.add(plazaRing);
  const postMesh = new THREE.Mesh(track(new THREE.CylinderGeometry(0.08, 0.1, 2.2, 10)), mat(0x8f5a2e));
  postMesh.position.y = 1.3;
  plazaGroup.add(postMesh);
  const lanternMat = mat(0xffd23f, { emissive: new THREE.Color(0xffd23f), emissiveIntensity: 0.4 });
  const lantern = new THREE.Mesh(track(new THREE.OctahedronGeometry(0.32, 0)), lanternMat);
  lantern.position.y = 2.5;
  plazaGroup.add(lantern);
  const plazaLight = new THREE.PointLight(0xffe08a, 1.6, 10, 1.6);
  plazaLight.position.set(0, 2.6, 0);
  plazaGroup.add(plazaLight);
  const selectionRing = new THREE.Mesh(track(new THREE.TorusGeometry(2.1, 0.06, 8, 32)), mat(0xffd23f, { emissive: new THREE.Color(0xffd23f), emissiveIntensity: 0.5 }));
  selectionRing.rotation.x = Math.PI / 2;
  selectionRing.position.y = 0.02;
  selectionRing.visible = false;
  scene.add(selectionRing);

  // ---- pools ----
  const rooms = new Map<string, RoomRig>();
  const bridgeGroup = new THREE.Group();
  scene.add(bridgeGroup);
  const bridgeMeshes: THREE.Mesh[] = [];
  const hits = new Map<THREE.Object3D, Village3DHit>();
  let slotOf = new Map<string, VillageSlot>();

  // ---- resident room (built once, shown/hidden) ----
  let residentGroup: THREE.Group | null = null;
  let residentCanvas: { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null = null;
  let residentTex: THREE.CanvasTexture | null = null;
  let residentPlaque: { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null = null;
  let residentPlaqueTex: THREE.CanvasTexture | null = null;
  let residentShelfItems: THREE.Mesh[] = [];
  const residentShelfGroup = new THREE.Group();

  function buildPlaque(g: CanvasRenderingContext2D, line1: string, line2: string): void {
    g.clearRect(0, 0, PLAQUE_W, PLAQUE_H);
    g.fillStyle = "#fffdf6";
    roundRect(g, 0, 0, PLAQUE_W, PLAQUE_H, 24);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = "900 64px 'Arial Black', Arial, sans-serif";
    g.textAlign = "center";
    wrap(g, line1, PLAQUE_W - 60, 1).forEach((l) => g.fillText(l, PLAQUE_W / 2, 92));
    g.font = "600 42px 'Avenir Next', Nunito, sans-serif";
    g.fillStyle = "#6a5a8f";
    g.fillText(line2, PLAQUE_W / 2, 158);
    g.textAlign = "start";
  }

  function drawScreen(g: CanvasRenderingContext2D, title: string, lines: readonly string[]): void {
    g.fillStyle = "#e4fbff";
    g.fillRect(0, 0, SCREEN_W, SCREEN_H);
    g.fillStyle = INK;
    g.fillRect(0, 0, SCREEN_W, 40);
    g.fillStyle = "#ffd23f";
    g.font = "bold 20px Menlo, monospace";
    g.fillText(title.slice(0, 34), 12, 27);
    g.fillStyle = INK;
    g.font = "20px Menlo, monospace";
    let y = 74;
    if (!lines.length) {
      g.fillStyle = "#8a7fb0";
      g.fillText("· · ·", 12, y);
    }
    for (const l of lines.slice(0, 5)) {
      g.fillText((wrap(g, l, SCREEN_W - 24, 1)[0] ?? "").slice(0, 40), 12, y);
      y += 34;
    }
  }

  function buildRoom(agentId: string): RoomRig {
    const group = new THREE.Group();
    scene.add(group);

    // platform
    const platform = new THREE.Mesh(track(new THREE.BoxGeometry(3.4, 0.3, 2.6)), mat(0xffd6e7));
    platform.position.y = 0.15;
    group.add(platform);
    const platformHit = new THREE.Mesh(track(new THREE.BoxGeometry(3.6, 2.2, 2.8)), track(new THREE.MeshBasicMaterial({ visible: false })));
    platformHit.position.y = 1.1;
    group.add(platformHit);

    // back wall + plaque
    const wall = new THREE.Mesh(track(new THREE.BoxGeometry(3.4, 1.9, 0.16)), mat(0xffe9c9));
    wall.position.set(0, 1.25, -1.2);
    group.add(wall);
    const plaqueCanvas = canvas2d(PLAQUE_W, PLAQUE_H);
    const plaqueTex = track(new THREE.CanvasTexture(plaqueCanvas.c));
    plaqueTex.colorSpace = THREE.SRGBColorSpace;
    const plaque = new THREE.Mesh(track(new THREE.PlaneGeometry(2.7, 0.66)), track(new THREE.MeshBasicMaterial({ map: plaqueTex, toneMapped: false })));
    plaque.position.set(0, 1.95, -1.11);
    group.add(plaque);

    // desk + monitor
    const desk = new THREE.Mesh(track(new THREE.BoxGeometry(1.5, 0.14, 0.7)), mat(0xb97a45));
    desk.position.set(0.7, 0.75, -0.7);
    group.add(desk);
    const screenCanvas = canvas2d(SCREEN_W, SCREEN_H);
    const screenTex = track(new THREE.CanvasTexture(screenCanvas.c));
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(1.0, 0.62)), track(new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false })));
    screen.position.set(0.7, 1.28, -1.02);
    group.add(screen);

    // creature (on a small stool, facing the desk)
    const creature = new THREE.Mesh(creatureGeometry("opus"), creatureMat);
    creature.position.set(-0.4, 0.78, -0.3);
    group.add(creature);

    // lamp
    const shade = mat(0xffd23f, { emissive: new THREE.Color(0xffd23f), emissiveIntensity: 0.35 });
    const shadeMesh = new THREE.Mesh(track(new THREE.ConeGeometry(0.22, 0.3, 12)), shade);
    shadeMesh.position.set(-1.3, 1.55, -0.9);
    group.add(shadeMesh);
    const lamp = new THREE.PointLight(0xffd36b, 1.8, 6, 1.6);
    lamp.position.set(-1.3, 1.5, -0.9);
    group.add(lamp);

    // needs-you beacon (hidden by default)
    const beaconCanvas = canvas2d(128, 128);
    beaconCanvas.g.fillStyle = "#fff07a";
    beaconCanvas.g.beginPath();
    beaconCanvas.g.arc(64, 64, 52, 0, Math.PI * 2);
    beaconCanvas.g.fill();
    beaconCanvas.g.lineWidth = 10;
    beaconCanvas.g.strokeStyle = INK;
    beaconCanvas.g.stroke();
    beaconCanvas.g.fillStyle = INK;
    beaconCanvas.g.font = "900 84px 'Arial Black', Arial, sans-serif";
    beaconCanvas.g.textAlign = "center";
    beaconCanvas.g.textBaseline = "middle";
    beaconCanvas.g.fillText("!", 64, 70);
    const beaconTex = track(new THREE.CanvasTexture(beaconCanvas.c));
    const beacon = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: beaconTex, depthTest: false, toneMapped: false })));
    beacon.scale.set(0.6, 0.6, 1);
    beacon.position.set(0, 2.6, 0.6);
    beacon.visible = false;
    group.add(beacon);

    const rig: RoomRig = {
      agentId,
      group,
      plaqueCanvas,
      plaqueTex,
      screenCanvas,
      screenTex,
      creature,
      family: null,
      lamp,
      shade,
      beacon,
      beaconTex,
      drones: [],
      platformHit,
      data: null,
    };
    hits.set(platformHit, { kind: "room", agentId });
    return rig;
  }

  function ensureDrones(rig: RoomRig, count: number): void {
    const offsets = droneOffsets(count);
    while (rig.drones.length > offsets.length) {
      const d = rig.drones.pop();
      if (d) rig.group.remove(d);
    }
    while (rig.drones.length < offsets.length) {
      const d = new THREE.Mesh(droneGeo, creatureMat);
      rig.group.add(d);
      rig.drones.push(d);
    }
    offsets.forEach((o, i) => {
      const d = rig.drones[i];
      if (d) d.position.set(1.6 + o.dx, 0.5, 0.4 + o.dz);
    });
  }

  function applyRoomData(rig: RoomRig, d: Village3DRoomData): void {
    const prev = rig.data;
    rig.data = d;
    if (d.family !== rig.family) {
      rig.family = d.family;
      const old = rig.creature.geometry;
      rig.creature.geometry = creatureGeometry(d.family);
      old.dispose();
    }
    if (!prev || prev.roomLabel !== d.roomLabel || prev.modelLabel !== d.modelLabel) buildPlaque(rig.plaqueCanvas.g, d.roomLabel, d.modelLabel);
    rig.plaqueTex.needsUpdate = true;
    drawScreen(rig.screenCanvas.g, d.screenTitle, d.screenLines);
    rig.screenTex.needsUpdate = true;
    const light = lampLight(d.mood);
    rig.lamp.color.setHex(light.color);
    rig.lamp.intensity = light.intensity * 0.7;
    rig.shade.color.setHex(light.color);
    rig.shade.emissive.setHex(light.color);
    rig.beacon.visible = d.needsYou;
    ensureDrones(rig, d.drones);
  }

  function ensureResident(): void {
    if (residentGroup) return;
    const group = new THREE.Group();
    residentGroup = group;
    scene.add(group);
    const platform = new THREE.Mesh(track(new THREE.BoxGeometry(3.6, 0.3, 2.8)), mat(0xd8cfe8));
    platform.position.y = 0.15;
    group.add(platform);
    const wall = new THREE.Mesh(track(new THREE.BoxGeometry(3.6, 2.1, 0.16)), mat(0xe6dcff));
    wall.position.set(0, 1.3, -1.3);
    group.add(wall);
    residentPlaque = canvas2d(PLAQUE_W, PLAQUE_H);
    residentPlaqueTex = track(new THREE.CanvasTexture(residentPlaque.c));
    residentPlaqueTex.colorSpace = THREE.SRGBColorSpace;
    const plaque = new THREE.Mesh(track(new THREE.PlaneGeometry(2.9, 0.7)), track(new THREE.MeshBasicMaterial({ map: residentPlaqueTex, toneMapped: false })));
    plaque.position.set(0, 2.05, -1.21);
    group.add(plaque);
    residentShelfGroup.position.set(-1.3, 0, -1.15);
    group.add(residentShelfGroup);
    residentCanvas = canvas2d(SCREEN_W, SCREEN_H);
    residentTex = track(new THREE.CanvasTexture(residentCanvas.c));
    residentTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(1.1, 0.68)), track(new THREE.MeshBasicMaterial({ map: residentTex, toneMapped: false })));
    screen.position.set(0.9, 1.3, -1.02);
    group.add(screen);
    const hitBox = new THREE.Mesh(track(new THREE.BoxGeometry(3.8, 2.2, 3.0)), track(new THREE.MeshBasicMaterial({ visible: false })));
    hitBox.position.y = 1.1;
    group.add(hitBox);
    hits.set(hitBox, { kind: "resident" });
  }

  function setResidentShelf(count: number): void {
    for (const m of residentShelfItems) {
      residentShelfGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    residentShelfItems = [];
    const books = [0xffd23f, 0x6fd46b, 0x9b7bff, 0xff8a5c, 0x3fb6ff];
    shelfSlots(Math.min(count, 15), 3, 5).forEach(({ plank, slot }, i) => {
      // Not `mat()` — see the bridges' comment above: this list is rebuilt often and disposed
      // individually, right above.
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.34), toon(books[i % books.length]!));
      m.position.set(slot * 0.2 - 0.4, 0.5 + plank * 0.4, 0);
      residentShelfGroup.add(m);
      residentShelfItems.push(m);
    });
  }

  // ---- bridges ----
  function rebuildBridges(list: readonly VillageBridge[]): void {
    for (const m of bridgeMeshes) {
      bridgeGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    bridgeMeshes.length = 0;
    for (const b of list) {
      const from = slotOf.get(b.a);
      const to = slotOf.get(b.b);
      if (!from || !to) continue;
      const pts = bridgeControlPoints(from.gx, from.gz, to.gx, to.gz).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const curve = new THREE.CatmullRomCurve3(pts);
      const radius = b.kind === "message" ? 0.02 : 0.03;
      const color = b.kind === "message" ? 0x5bd1ff : 0xb77838;
      // Not `mat()`: bridges are rebuilt on every setData, and `mat()` tracks into the
      // dispose-at-teardown list forever — these are disposed individually, right above.
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, radius, 6, false), toon(color));
      bridgeGroup.add(tube);
      bridgeMeshes.push(tube);
    }
  }

  // ---- data → scene ----

  function setData(d: Village3DData): void {
    const ids = d.rooms.map((r) => r.agentId);
    slotOf = new Map(villageSlots(ids).map((s) => [s.agentId, s] as const));

    // Drop rigs for rooms no longer shown. Known tradeoff: a dropped rig's own geometries/
    // materials were created via the tracked `mat()`/`track()` helpers, so they are freed at
    // dispose() (view unmount), not here — bounded by how many distinct agents cycle through
    // this village during one #/room/all session, not unbounded.
    for (const [id, rig] of rooms) {
      if (!slotOf.has(id)) {
        scene.remove(rig.group);
        rooms.delete(id);
        hits.delete(rig.platformHit);
      }
    }
    for (const roomData of d.rooms) {
      const slot = slotOf.get(roomData.agentId);
      if (!slot) continue;
      let rig = rooms.get(roomData.agentId);
      if (!rig) {
        rig = buildRoom(roomData.agentId);
        rooms.set(roomData.agentId, rig);
      }
      rig.group.position.set(slot.gx, 0, slot.gz);
      rig.group.rotation.y = slot.facing;
      applyRoomData(rig, roomData);
    }

    if (d.resident) {
      ensureResident();
      const slot = residentSlot(d.rooms.length);
      if (residentGroup) {
        residentGroup.position.set(slot.gx, 0, slot.gz);
        residentGroup.rotation.y = slot.facing;
      }
      if (residentPlaque) buildPlaque(residentPlaque.g, `${d.resident.name.toUpperCase()}'S ROOM`, `day ${d.resident.day}`);
      if (residentPlaqueTex) residentPlaqueTex.needsUpdate = true;
      if (residentCanvas) drawScreen(residentCanvas.g, "journal", d.resident.journalLine ? [d.resident.journalLine] : []);
      if (residentTex) residentTex.needsUpdate = true;
      setResidentShelf(d.resident.shelfCount);
    }
    if (residentGroup) residentGroup.visible = d.resident !== null;

    rebuildBridges(d.bridges);

    if (d.selectedId && slotOf.has(d.selectedId)) {
      const slot = slotOf.get(d.selectedId)!;
      selectionRing.position.set(slot.gx, 0.02, slot.gz);
      selectionRing.visible = true;
    } else if (d.selectedId === "resident" && d.resident) {
      const slot = residentSlot(d.rooms.length);
      selectionRing.position.set(slot.gx, 0.02, slot.gz);
      selectionRing.visible = true;
    } else {
      selectionRing.visible = false;
    }

    // Frame the whole village by default: recompute the fit distance for the CURRENT room count
    // every time data changes, until the user actually touches the camera (drag/zoom below) —
    // after that we stop overriding their composition.
    if (!userAdjustedOrbit) {
      const radius = sceneRadius(d.rooms.length, d.resident !== null);
      orbit = clampOrbit({ ...orbit, distance: fitDistance(radius, orbit.elevation) });
    }
  }

  // ---- orbit camera ----
  let orbit: OrbitState = { ...ORBIT_BASE };
  /** Once the user drags or zooms, setData stops re-fitting the distance for them. */
  let userAdjustedOrbit = false;
  const AZ_PER_PX = 0.006;
  const EL_PER_PX = 0.005;
  const ZOOM_PER_DELTA = 0.01;

  // ---- frame loop ----
  let stage: Rect = { left: 0, top: 0, width: 1, height: 1 };
  let disposed = false;
  let active = true;
  let last = performance.now();
  let clockT = 0;
  let hover: THREE.Object3D | null = null;

  function frame(): void {
    if (disposed) return;
    post.afterNextRender(frame);
    if (!active) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clockT += dt;
    const t = deps.reducedMotion ? 0 : clockT;

    for (const rig of rooms.values()) {
      const mood = rig.data?.mood ?? "calm";
      const m = creatureMotion(mood, t);
      const s = FAMILY_SCALE[rig.family ?? "other"] * 1.1;
      rig.creature.position.y = 0.78 + m.y;
      rig.creature.rotation.set(0, m.yaw, m.roll);
      rig.creature.scale.set(s, s * m.squash, s);
      if (mood === "alarm") rig.shade.emissiveIntensity = 0.25 + (Math.sin(t * 8) > 0 ? 0.5 : 0);
      if (rig.beacon.visible) rig.beacon.scale.setScalar(0.6 + Math.sin(t * 5) * 0.08);
      rig.drones.forEach((dr, i) => {
        dr.position.y = 0.5 + Math.sin(t * 2.4 + i) * 0.12;
      });
    }
    lantern.rotation.y = t * 0.4;

    const size = renderer.getSize(new THREE.Vector2());
    // A single design FOV/aspect (VILLAGE_FOV_DEG/VILLAGE_ASPECT, matched exactly by
    // village-lib.ts's fitDistance) for every stage shape: stageProjection already widens the
    // vertical FOV on a narrower-than-design stage to keep the same width in view, so a portrait
    // phone gets extra headroom, never a crop, with no separate narrow-case constant needed.
    const proj = stageProjection(size.x, size.y, stage, VILLAGE_FOV_DEG, VILLAGE_ASPECT);
    camera.aspect = size.x / Math.max(1, size.y);
    camera.fov = proj.fov;
    camera.setViewOffset(size.x, size.y, proj.offsetX, proj.offsetY, size.x, size.y);
    const pos = orbitPosition(orbit);
    camera.position.set(pos.x, pos.y, pos.z);
    camera.lookAt(0, 1.2, 0);
    camera.updateProjectionMatrix();
    post.render({ scene, camera });
  }
  post.afterNextRender(frame);

  // ---- picking ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pick(clientX: number, clientY: number): THREE.Object3D | null {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const targets = [...hits.keys()];
    const hit = raycaster.intersectObjects(targets, false)[0];
    return hit?.object ?? null;
  }

  function setHoverObj(o: THREE.Object3D | null): void {
    if (hover === o) return;
    hover = o;
  }

  return {
    setData,
    setActive(on) {
      active = on;
      last = performance.now();
    },
    setStage(rect) {
      stage = rect;
    },
    setHover(h) {
      if (!h) setHoverObj(null);
    },
    hit(clientX, clientY) {
      const o = pick(clientX, clientY);
      setHoverObj(o);
      return o ? hits.get(o) ?? null : null;
    },
    drag(dxPx, dyPx) {
      userAdjustedOrbit = true;
      orbit = clampOrbit({ azimuth: orbit.azimuth + dxPx * AZ_PER_PX, elevation: orbit.elevation + dyPx * EL_PER_PX, distance: orbit.distance });
    },
    zoom(deltaY) {
      userAdjustedOrbit = true;
      orbit = clampOrbit({ ...orbit, distance: orbit.distance + deltaY * ZOOM_PER_DELTA });
    },
    dispose() {
      disposed = true;
      for (const rig of rooms.values()) rig.creature.geometry.dispose();
      for (const m of residentShelfItems) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      for (const m of bridgeMeshes) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      for (const x of disposables) x.dispose();
      scene.clear();
    },
  };
}
