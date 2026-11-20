// The Room's 3D scene: a cozy toon room drawn with the shared renderer and the planet's ink +
// halftone post pass, with the agent's model creature (same geometry as on the planet) animated
// by its state, and a wall-wide bay window that shows the LIVE orbit: each frame (every other
// one) the shared planet scene is rendered at low res from a camera parked above the agent's
// house, looking at the horizon and sky, into a render target that the window glass shows.
//
// Timing: InkPost.afterNextRender runs right after the planet frame, so the room always draws
// on top of it (no main.ts hook needed). The room is centred on the stage element with a
// camera view offset (stageProjection), since the canvas spans the whole window.
// Every prop is real data handed in by views/room.ts (todos, shelf, activity, tokens, uptime).

import * as THREE from "three";
import { creatureGeometry, FAMILY_SCALE } from "../scene/creatures";
import { NO_INK_LAYER } from "../scene/planet";
import type { InkPost } from "../scene/post";
import { VIEW_LIGHT_DIR } from "../scene/post";
import { merge, painted, toon } from "../scene/toon";
import {
  creatureMotion,
  lampLight,
  shelfSlots,
  stageProjection,
  type LampMood,
  type ModelKey,
  type PlantStage,
  type Rect,
  type StickyNote,
} from "./room-lib";

const INK = "#1a1030";
const WIN_RT_W = 768;
const WIN_RT_H = 384;
const PLANKS = 3;
const PER_PLANK = 5;

export type ShelfKind = "jar" | "frame" | "book" | "card";

export interface Room3DShelfItem {
  kind: ShelfKind;
  /** Hex colour of the object. */
  color: number;
  gone: boolean;
}

export interface Room3DData {
  agentId: string;
  mood: LampMood;
  family: ModelKey;
  /** Agent role colour ("#rrggbb"), tints the rug. */
  tint: string;
  notes: StickyNote[];
  hiddenNotes: number;
  progress: { done: number; total: number } | null;
  screen: { title: string; lines: { stage: string; text: string }[]; empty: string; cta: string; live: boolean };
  clock: { hour: number; minute: number } | null;
  clockLabel: string;
  plant: PlantStage;
  plantLabel: string;
  shelf: Room3DShelfItem[];
  drones: string[];
}

export type Room3DHit =
  | { kind: "screen" }
  | { kind: "window" }
  | { kind: "board" }
  | { kind: "shelf"; index: number }
  | { kind: "drone"; index: number }
  | { kind: "creature" }
  | { kind: "plant" }
  | { kind: "clock" };

export interface Room3D {
  setData(d: Room3DData): void;
  /** false: stop drawing (the grid is up); the hook stays armed. */
  setActive(on: boolean): void;
  /** Where the stage is on screen (px): the room is centred there. */
  setStage(rect: Rect): void;
  setHover(hit: Room3DHit | null): void;
  hit(clientX: number, clientY: number): Room3DHit | null;
  dispose(): void;
}

export interface Room3DDeps {
  renderer: THREE.WebGLRenderer;
  post: InkPost;
  /** The shared planet scene (rendered into the window). */
  planet: THREE.Scene;
  /** Roof of the agent's house (world space), undefined when not placed. */
  agentPosition(agentId: string): THREE.Vector3 | undefined;
  reducedMotion: boolean;
}

// ---------------------------------------------------------------- canvas helpers

function canvas2d(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  return { c, g };
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
  const last = lines[maxLines - 1];
  if (lines.length === maxLines && last !== undefined && g.measureText(last).width > maxW) lines[maxLines - 1] = `${last.slice(0, -2)}…`;
  return lines;
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

const STAGE_COLOR: Record<string, string> = { hook: "#ff8a3d", brain: "#ff6fb5", plan: "#3fb6ff", reason: "#9b6dff", tool: "#e8a800" };
const NOTE_FILL: Record<StickyNote["tone"], string> = { now: "#fff07a", next: "#ffd6e7", done: "#cdf5c8" };

// ---------------------------------------------------------------- the room

export function createRoom3D(deps: Room3DDeps): Room3D {
  const { renderer, post } = deps;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const mat = (c: THREE.ColorRepresentation, o: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial => track(toon(c, o));
  const hits = new Map<THREE.Object3D, Room3DHit>();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfff3de);
  const camera = new THREE.PerspectiveCamera(40, 1.6, 0.3, 200);
  camera.layers.enable(NO_INK_LAYER);
  scene.add(camera);
  const key = new THREE.DirectionalLight(0xfff4e0, 1.7);
  key.position.copy(VIEW_LIGHT_DIR).multiplyScalar(30);
  camera.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0xfff8ee, 0xe8c9a0, 1.45), new THREE.AmbientLight(0xffffff, 0.3));
  // Daylight pouring in through the bay window: the room feels open.
  const sun = new THREE.DirectionalLight(0xfff1c9, 0.9);
  sun.position.set(-2, 9, -12);
  sun.target.position.set(0, 0, 1);
  scene.add(sun, sun.target);

  const box = (w: number, h: number, d: number, c: THREE.ColorRepresentation, x: number, y: number, z: number, parent: THREE.Object3D = scene): THREE.Mesh => {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat(c));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const cyl = (rt: number, rb: number, h: number, c: THREE.ColorRepresentation, x: number, y: number, z: number, seg = 24, parent: THREE.Object3D = scene): THREE.Mesh => {
    const m = new THREE.Mesh(track(new THREE.CylinderGeometry(rt, rb, h, seg)), mat(c));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // ---- shell: floor, side walls, back wall around a wall-wide bay window ----
  const floorTex = (() => {
    const { c, g } = canvas2d(512, 512);
    g.fillStyle = "#efb877";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? "#e9ae6a" : "#f3c286";
      g.fillRect(0, i * 64, 512, 62);
      g.fillStyle = "rgba(122,72,24,0.35)";
      g.fillRect(0, i * 64 + 62, 512, 2);
      g.fillRect(((i * 197) % 400) + 40, i * 64, 2, 62);
    }
    const t = track(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    return t;
  })();
  const floor = new THREE.Mesh(track(new THREE.BoxGeometry(13.4, 0.3, 10)), mat(0xffffff, { map: floorTex }));
  floor.position.set(0, -0.15, -0.5);
  scene.add(floor);
  const wallC = 0xffe9c9;
  box(0.3, 6.2, 10, 0xffe0b8, -6.55, 3.1, -0.5);
  box(0.3, 6.2, 10, 0xffe0b8, 6.55, 3.1, -0.5);
  // back wall pieces around the opening x∈[-4.4, 4.4], y∈[1.15, 5.1]
  box(13.4, 1.15, 0.3, wallC, 0, 0.575, -5.35);
  box(13.4, 1.1, 0.3, wallC, 0, 5.65, -5.35);
  box(2.3, 3.95, 0.3, wallC, -5.55, 3.125, -5.35);
  box(2.3, 3.95, 0.3, wallC, 5.55, 3.125, -5.35);
  // ceiling + crown moulding (closes the box: no background shows above the walls)
  box(13.4, 0.3, 12, 0xfff6e8, 0, 6.35, 0.5);
  box(13.4, 0.22, 0.2, 0xfffdf6, 0, 6.1, -5.15);
  // skirting
  box(13.4, 0.32, 0.12, 0xfffdf6, 0, 0.16, -5.15);
  box(0.12, 0.32, 10, 0xfffdf6, -6.35, 0.16, -0.5);
  box(0.12, 0.32, 10, 0xfffdf6, 6.35, 0.16, -0.5);

  // ---- the bay window onto the live orbit ----
  const winRT = track(new THREE.WebGLRenderTarget(WIN_RT_W, WIN_RT_H, { depthBuffer: true }));
  const view = new THREE.Mesh(track(new THREE.PlaneGeometry(26, 13)), track(new THREE.MeshBasicMaterial({ map: winRT.texture, toneMapped: false })));
  view.position.set(0, 3.2, -12);
  view.layers.set(NO_INK_LAYER);
  scene.add(view);
  hits.set(view, { kind: "window" });
  const frameC = 0xfffdf6;
  const windowHead = box(9.2, 0.26, 0.5, frameC, 0, 5.05, -5.2); // head
  const windowFrameL = box(0.26, 4.1, 0.5, frameC, -4.47, 3.1, -5.2);
  const windowFrameR = box(0.26, 4.1, 0.5, frameC, 4.47, 3.1, -5.2);
  for (const x of [-1.48, 1.48]) box(0.14, 3.9, 0.3, frameC, x, 3.1, -5.25); // mullions
  const windowTransom = box(8.9, 0.12, 0.3, frameC, 0, 4.25, -5.25); // transom
  const sill = box(9.6, 0.2, 1.0, 0xfffdf6, 0, 1.1, -4.85); // deep sill to sit on
  hits.set(sill, { kind: "window" });
  const windowFrame = [windowHead, windowFrameL, windowFrameR, windowTransom, sill];
  // curtains: soft pink folds pulled to the sides + rod
  box(10.2, 0.1, 0.1, 0xb77838, 0, 5.4, -4.9);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const fold = box(0.28, 4.3, 0.22, i % 2 ? 0xffb3cd : 0xff9fbf, side * (4.75 + i * 0.26), 3.2, -4.8 + (i % 2) * 0.12);
      fold.rotation.z = side * 0.03;
    }
  }

  // ---- rug ----
  const rugMat = mat(0xffd6e7);
  const rug = new THREE.Mesh(track(new THREE.CylinderGeometry(2.7, 2.7, 0.05, 48)), rugMat);
  rug.position.set(0.4, 0.03, -0.6);
  scene.add(rug);
  const rugRing = cyl(2.9, 2.9, 0.03, 0xfffdf6, 0.4, 0.015, -0.6, 48);
  rugRing.renderOrder = -1;

  // ---- board on an easel (front left, turned to you): the agent's live todos as sticky notes ----
  const easel = new THREE.Group();
  easel.position.set(-3.2, 0, -0.7);
  easel.rotation.y = 0.62;
  scene.add(easel);
  const boardCanvas = canvas2d(1024, 720);
  const boardTex = track(new THREE.CanvasTexture(boardCanvas.c));
  boardTex.colorSpace = THREE.SRGBColorSpace;
  boardTex.anisotropy = 4;
  const board = new THREE.Mesh(track(new THREE.PlaneGeometry(2.9, 2.04)), track(new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false })));
  board.position.set(0, 2.6, 0.07);
  easel.add(board);
  const boardFrame = box(3.12, 2.26, 0.12, 0xb77838, 0, 2.6, 0, easel);
  for (const x of [-1.1, 1.1]) box(0.12, 1.6, 0.12, 0x8f5a2e, x, 0.8, 0.05, easel);
  const backLeg = box(0.12, 2.9, 0.12, 0x8f5a2e, 0, 1.4, -0.55, easel);
  backLeg.rotation.x = -0.35;
  box(3.0, 0.1, 0.3, 0x8f5a2e, 0, 1.52, 0.12, easel); // chalk ledge
  hits.set(board, { kind: "board" });

  // ---- bookcase (back right, turned to you): what the session wrote / linked ----
  const shelfGroup = new THREE.Group();
  shelfGroup.position.set(4.35, 0, -3.35);
  shelfGroup.rotation.y = -0.5;
  scene.add(shelfGroup);
  const plankYs = [3.75, 2.7, 1.65];
  box(2.4, 4.6, 0.08, 0xffd6a8, 0, 2.3, -0.33, shelfGroup); // back panel
  for (const x of [-1.16, 1.16]) box(0.12, 4.7, 0.72, 0xc98a4b, x, 2.35, 0, shelfGroup);
  for (const y of [...plankYs, 0.6, 4.7]) box(2.3, 0.12, 0.72, 0xc98a4b, 0, y, 0, shelfGroup);
  const shelfItems: THREE.Mesh[] = [];

  // ---- desk + monitor (the live session) ----
  const desk = new THREE.Group();
  desk.position.set(2.3, 0, -1.25);
  desk.rotation.y = -0.28;
  scene.add(desk);
  box(3.4, 0.18, 1.5, 0xb97a45, 0, 1.55, 0, desk);
  for (const [x, z] of [[-1.55, -0.6], [1.55, -0.6], [-1.55, 0.6], [1.55, 0.6]] as const) box(0.14, 1.5, 0.14, 0x8f5a2e, x, 0.75, z, desk);
  box(0.5, 0.5, 0.1, 0x3a3f66, 0, 1.85, -0.35, desk); // stand
  const bezel = box(2.46, 1.62, 0.14, 0xfffdf6, 0, 2.75, -0.3, desk); // bezel
  const screenCanvas = canvas2d(768, 480);
  const screenTex = track(new THREE.CanvasTexture(screenCanvas.c));
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.anisotropy = 4;
  const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(2.24, 1.4)), track(new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false })));
  screen.position.set(0, 2.75, -0.22);
  desk.add(screen);
  hits.set(screen, { kind: "screen" });
  box(0.9, 0.06, 0.35, 0xd8cfe8, -0.1, 1.67, 0.3, desk); // keyboard
  const mug = cyl(0.14, 0.12, 0.28, 0xff4d8d, 1.2, 1.78, 0.2, 16, desk);
  mug.name = "mug";

  // ---- stool + the agent's creature ----
  const seat = new THREE.Group();
  seat.position.set(-0.45, 0, -0.35);
  scene.add(seat);
  cyl(0.75, 0.75, 0.22, 0x5b6bd6, 0, 0.72, 0, 32, seat);
  cyl(0.1, 0.14, 0.62, 0x3a3f66, 0, 0.31, 0, 12, seat);
  const creatureMat = mat(0xffffff, { vertexColors: true });
  const creature = new THREE.Mesh(creatureGeometry("opus"), creatureMat);
  creature.position.set(0, 1.6, 0);
  seat.add(creature);
  hits.set(creature, { kind: "creature" });
  let creatureFamily: ModelKey | null = null;

  const bubbleCanvas = canvas2d(256, 256);
  const bubbleTex = track(new THREE.CanvasTexture(bubbleCanvas.c));
  bubbleTex.colorSpace = THREE.SRGBColorSpace;
  const bubble = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: bubbleTex, depthTest: false, toneMapped: false })));
  bubble.scale.set(1.1, 1.1, 1);
  bubble.position.set(0.8, 3.3, 0);
  bubble.layers.set(NO_INK_LAYER);
  seat.add(bubble);
  let bubbleText = "";

  // ---- plant (grows with tokens) ----
  const plantGroup = new THREE.Group();
  // on the window sill, in the daylight
  plantGroup.position.set(-3.0, 1.2, -4.72);
  plantGroup.scale.setScalar(0.72);
  scene.add(plantGroup);
  cyl(0.62, 0.46, 0.9, 0xff8a5c, 0, 0.45, 0, 20, plantGroup);
  cyl(0.66, 0.66, 0.14, 0xffa37f, 0, 0.92, 0, 20, plantGroup);
  cyl(0.56, 0.56, 0.04, 0x8a5a2b, 0, 0.98, 0, 20, plantGroup);
  let plantMesh: THREE.Mesh | null = null;
  let plantStageNow: PlantStage | -1 = -1;
  const plantHit = new THREE.Mesh(track(new THREE.CylinderGeometry(0.9, 0.9, 3.4, 8)), track(new THREE.MeshBasicMaterial({ visible: false })));
  plantHit.position.set(0, 1.7, 0);
  plantGroup.add(plantHit);
  hits.set(plantHit, { kind: "plant" });

  function buildPlant(stage: PlantStage): void {
    if (plantMesh) {
      plantGroup.remove(plantMesh);
      plantMesh.geometry.dispose();
    }
    plantStageNow = stage;
    const parts: THREE.BufferGeometry[] = [];
    if (stage === 0) {
      parts.push(painted(new THREE.SphereGeometry(0.12, 10, 8).scale(1, 0.7, 1).translate(0, 1.05, 0), 0x8a5a2b));
    } else {
      const h = [0, 0.6, 1.1, 1.6, 2.0, 2.5][stage]!;
      parts.push(painted(new THREE.CylinderGeometry(0.05, 0.08, h, 8).translate(0, 1 + h / 2, 0), 0x2e9e4f));
      const leaves = Math.min(10, stage * 2);
      for (let i = 0; i < leaves; i++) {
        const y = 1.15 + ((i + 1) * h) / (leaves + 1);
        const a = i * 2.4;
        const leaf = new THREE.SphereGeometry(0.26, 10, 6).scale(1.3, 0.45, 0.7);
        leaf.rotateZ(0.4);
        leaf.translate(0.28, 0, 0);
        leaf.rotateY(a);
        leaf.translate(0, y, 0);
        parts.push(painted(leaf, i % 3 === 0 ? 0x6fd46b : 0x4cc35a));
      }
      if (stage >= 4) {
        const tops = stage === 5 ? [[0, 1 + h + 0.1, 0], [0.45, 1 + h * 0.8, 0.2], [-0.4, 1 + h * 0.7, -0.2]] : [[0, 1 + h + 0.1, 0]];
        for (const [x, y, z] of tops) {
          for (let p = 0; p < 5; p++) {
            const petal = new THREE.SphereGeometry(0.13, 8, 6).scale(1, 0.4, 1.6).translate(0, 0, 0.16).rotateY((p * Math.PI * 2) / 5);
            parts.push(painted(petal.translate(x!, y!, z!), 0xff7eb6));
          }
          parts.push(painted(new THREE.SphereGeometry(0.1, 8, 6).translate(x!, y! + 0.03, z!), 0xffd23f));
        }
      } else parts.push(painted(new THREE.SphereGeometry(0.2, 10, 8).scale(0.8, 1.2, 0.8).translate(0, 1 + h + 0.1, 0), 0x6fd46b));
    }
    plantMesh = new THREE.Mesh(merge(parts), creatureMat);
    plantGroup.add(plantMesh);
  }

  // ---- lamp (its light follows the state) ----
  const lampGroup = new THREE.Group();
  lampGroup.position.set(-2.3, 0, -3.7);
  scene.add(lampGroup);
  cyl(0.5, 0.6, 0.12, 0x3a3f66, 0, 0.06, 0, 20, lampGroup);
  cyl(0.06, 0.06, 3.3, 0xfffdf6, 0, 1.7, 0, 10, lampGroup);
  const shadeMat = mat(0xffd23f, { emissive: new THREE.Color(0xffd23f), emissiveIntensity: 0.35 });
  const shade = new THREE.Mesh(track(new THREE.CylinderGeometry(0.45, 0.85, 0.8, 24, 1, true)), shadeMat);
  shade.position.set(0, 3.55, 0);
  shadeMat.side = THREE.DoubleSide;
  lampGroup.add(shade);
  const lampLightObj = new THREE.PointLight(0xffd36b, 2, 14, 1.4);
  lampLightObj.position.set(0, 3.3, 0);
  lampGroup.add(lampLightObj);

  // ---- clock (uptime) on the back wall ----
  const clock = new THREE.Group();
  clock.position.set(0, 5.62, -5.16);
  clock.scale.setScalar(0.72);
  scene.add(clock);
  const face = cyl(0.62, 0.62, 0.1, 0xfffdf6, 0, 0, 0, 32, clock);
  face.rotation.x = Math.PI / 2;
  const rim = new THREE.Mesh(track(new THREE.TorusGeometry(0.62, 0.07, 8, 32)), mat(0xff4d8d));
  clock.add(rim);
  hits.set(face, { kind: "clock" });
  const hourHand = new THREE.Group();
  const minHand = new THREE.Group();
  box(0.1, 0.36, 0.05, 0x1a1030, 0, 0.18, 0.08, hourHand);
  box(0.06, 0.52, 0.05, 0xff4d8d, 0, 0.26, 0.1, minHand);
  clock.add(hourHand, minHand);
  cyl(0.07, 0.07, 0.08, 0xffd23f, 0, 0, 0.12, 12, clock).rotation.x = Math.PI / 2;

  // ---- drones = running subagents ----
  const droneGeo = track(
    merge([
      painted(new THREE.BoxGeometry(0.5, 0.22, 0.34), 0x5bd1ff),
      painted(new THREE.BoxGeometry(0.34, 0.04, 0.12).translate(-0.3, 0.16, 0), 0xbfe3ff),
      painted(new THREE.BoxGeometry(0.34, 0.04, 0.12).translate(0.3, 0.16, 0), 0xbfe3ff),
      painted(new THREE.SphereGeometry(0.05, 6, 4).translate(-0.1, 0.02, 0.18), 0x1a1030),
      painted(new THREE.SphereGeometry(0.05, 6, 4).translate(0.1, 0.02, 0.18), 0x1a1030),
    ]),
  );
  const drones: THREE.Mesh[] = [];

  // ---------------------------------------------------------------- data → props

  let data: Room3DData | null = null;
  let mood: LampMood = "calm";

  function drawBoard(d: Room3DData): void {
    const { g } = boardCanvas;
    g.fillStyle = "#e9b77f";
    g.fillRect(0, 0, 1024, 720);
    g.fillStyle = "rgba(122,72,24,0.22)";
    for (let y = 8; y < 720; y += 16) for (let x = (y / 16) % 2 ? 8 : 16; x < 1024; x += 16) g.fillRect(x, y, 3, 3);
    g.fillStyle = "#ffd23f";
    roundRect(g, 24, 18, 330, 58, 12);
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = "900 34px 'Arial Black', Arial, sans-serif";
    g.fillText(d.progress ? `TODOS ${d.progress.done}/${d.progress.total}` : "TODOS", 42, 60);
    if (!d.notes.length) {
      g.fillStyle = "#fffdf6";
      roundRect(g, 60, 150, 900, 260, 18);
      g.fill();
      g.stroke();
      g.fillStyle = INK;
      g.font = "600 40px 'Avenir Next', Nunito, sans-serif";
      wrap(g, "No todo list yet. Sticky notes appear here when the agent writes one.", 840, 4).forEach((l, i) => g.fillText(l, 90, 220 + i * 52));
      boardTex.needsUpdate = true;
      return;
    }
    const cols = 3;
    const w = 300;
    const h = 190;
    d.notes.forEach((n, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = 30 + c * 328;
      const y = 100 + r * 205;
      g.save();
      g.translate(x + w / 2, y + h / 2);
      g.rotate((((i * 37) % 7) - 3) * 0.012);
      g.translate(-w / 2, -h / 2);
      g.fillStyle = "rgba(26,16,48,0.35)";
      g.fillRect(6, 8, w, h);
      g.fillStyle = NOTE_FILL[n.tone];
      g.fillRect(0, 0, w, h);
      g.lineWidth = 4;
      g.strokeStyle = INK;
      g.strokeRect(0, 0, w, h);
      g.fillStyle = "#ff4d8d";
      g.beginPath();
      g.arc(w / 2, 14, 10, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = n.tone === "done" ? "#3b5a3c" : INK;
      g.font = `${n.tone === "now" ? "800" : "600"} 30px 'Avenir Next', Nunito, sans-serif`;
      const lines = wrap(g, n.text, w - 30, 4);
      lines.forEach((l, j) => {
        g.fillText(l, 15, 60 + j * 34);
        if (n.tone === "done") g.fillRect(15, 50 + j * 34, g.measureText(l).width, 3);
      });
      g.restore();
    });
    if (d.hiddenNotes) {
      g.fillStyle = INK;
      g.font = "900 34px 'Arial Black', Arial, sans-serif";
      g.fillText(`+${d.hiddenNotes} more`, 820, 700);
    }
    boardTex.needsUpdate = true;
  }

  function drawScreen(d: Room3DData, cursorOn: boolean): void {
    const { g } = screenCanvas;
    g.fillStyle = d.screen.live ? "#e4fbff" : "#eafff3";
    g.fillRect(0, 0, 768, 480);
    g.fillStyle = INK;
    g.fillRect(0, 0, 768, 54);
    g.fillStyle = "#ffd23f";
    g.font = "bold 26px Menlo, monospace";
    g.fillText(d.screen.title.slice(0, 46), 18, 36);
    g.font = "bold 28px Menlo, monospace";
    let y = 102;
    if (!d.screen.lines.length) {
      g.fillStyle = "#4b4270";
      for (const l of wrap(g, d.screen.empty, 720, 3)) {
        g.fillText(l, 18, y);
        y += 40;
      }
    }
    for (const a of d.screen.lines.slice(-6)) {
      g.fillStyle = STAGE_COLOR[a.stage] ?? INK;
      g.fillRect(18, y - 20, 16, 16);
      g.fillStyle = INK;
      g.fillText((wrap(g, a.text, 680, 1)[0] ?? "").slice(0, 44), 46, y);
      y += 46;
    }
    g.fillStyle = "#ffd23f";
    roundRect(g, 18, 410, 732, 54, 27);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = "900 26px 'Arial Black', Arial, sans-serif";
    g.fillText(`${d.screen.cta}${cursorOn ? " ▌" : ""}`, 40, 447);
    screenTex.needsUpdate = true;
  }

  function drawBubble(text: string): void {
    bubbleText = text;
    bubble.visible = text !== "";
    if (!text) return;
    const { g } = bubbleCanvas;
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = mood === "alarm" ? "#ffd0dc" : mood === "ask" ? "#fff07a" : "#fffdf6";
    g.lineWidth = 12;
    g.strokeStyle = INK;
    g.beginPath();
    g.ellipse(128, 112, 100, 86, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(70, 180);
    g.lineTo(40, 240);
    g.lineTo(110, 192);
    g.fill();
    g.stroke();
    g.fillStyle = mood === "alarm" ? "#c4204f" : INK;
    g.font = `900 ${text.length > 2 ? 64 : 110}px 'Arial Black', Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 128, 118);
    g.textAlign = "start";
    g.textBaseline = "alphabetic";
    bubbleTex.needsUpdate = true;
  }

  function setShelf(items: Room3DShelfItem[]): void {
    for (const m of shelfItems) {
      shelfGroup.remove(m);
      m.geometry.dispose();
      hits.delete(m);
      (m.material as THREE.Material).dispose();
    }
    shelfItems.length = 0;
    shelfSlots(items.length, PLANKS, PER_PLANK).forEach(({ plank, slot }, i) => {
      const it = items[i]!;
      const y = plankYs[plank]! + 0.06;
      const x = -0.86 + slot * 0.43;
      let geo: THREE.BufferGeometry;
      let lift = 0;
      if (it.kind === "jar") {
        geo = new THREE.CylinderGeometry(0.19, 0.19, 0.62, 16);
        lift = 0.31;
      } else if (it.kind === "frame") {
        geo = new THREE.BoxGeometry(0.4, 0.6, 0.1);
        lift = 0.3;
      } else if (it.kind === "card") {
        geo = new THREE.BoxGeometry(0.4, 0.34, 0.06);
        lift = 0.17;
      } else {
        geo = new THREE.BoxGeometry(0.26 + ((i * 7) % 3) * 0.05, 0.86 - ((i * 5) % 3) * 0.08, 0.52);
        lift = 0.43 - ((i * 5) % 3) * 0.04;
      }
      const m = new THREE.Mesh(geo, toon(it.gone ? 0xcfc6de : it.color, { emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 }));
      m.position.set(x, y + lift, it.kind === "frame" || it.kind === "card" ? -0.12 : 0.02);
      if (it.kind === "frame" || it.kind === "card") m.rotation.x = -0.18;
      shelfGroup.add(m);
      shelfItems.push(m);
      hits.set(m, { kind: "shelf", index: i });
    });
  }

  function setDrones(labels: string[]): void {
    while (drones.length > Math.min(6, labels.length)) {
      const d = drones.pop()!;
      scene.remove(d);
      hits.delete(d);
    }
    while (drones.length < Math.min(6, labels.length)) {
      const d = new THREE.Mesh(droneGeo, creatureMat);
      scene.add(d);
      drones.push(d);
    }
    drones.forEach((d, i) => hits.set(d, { kind: "drone", index: i }));
  }

  // ---------------------------------------------------------------- the window camera

  const winCam = new THREE.PerspectiveCamera(52, WIN_RT_W / WIN_RT_H, 0.3, 1200);
  winCam.layers.enable(NO_INK_LAYER);
  const up = new THREE.Vector3();
  const north = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let frameNo = 0;

  function aimWindow(t: number): boolean {
    const id = data?.agentId;
    const house = id ? deps.agentPosition(id) : undefined;
    if (!house) return false;
    up.copy(house).normalize();
    north.set(0, 1, 0).addScaledVector(up, -up.y);
    if (north.lengthSq() < 1e-4) north.set(1, 0, 0).addScaledVector(up, -up.x);
    north.normalize().applyAxisAngle(up, deps.reducedMotion ? 0.6 : 0.6 + Math.sin(t * 0.05) * 0.35);
    winCam.up.copy(up);
    // ~22° down from 5 above the ground, just past the house (so the Orbit's selection marker,
    // which bobs above the roof, stays behind us): the district, the curved horizon, the sky.
    winCam.position.copy(house).addScaledVector(up, 4.2).addScaledVector(north, 3.5);
    tmp.copy(house).addScaledVector(north, 20).addScaledVector(up, -2.8);
    winCam.lookAt(tmp);
    return true;
  }

  // ---------------------------------------------------------------- frame loop (after each planet frame)

  let stage: Rect = { left: 0, top: 0, width: 1, height: 1 };
  let hover: THREE.Object3D | null = null;
  let disposed = false;
  let last = performance.now();
  let clockT = 0;
  let cursorAt = 0;

  let active = true;

  function frame(): void {
    if (disposed) return;
    post.afterNextRender(frame); // keep the hook alive for the next planet frame
    if (!active || !data) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clockT += dt;
    const t = deps.reducedMotion ? 0 : clockT;

    // 1. the live orbit into the window (every other frame, low res)
    if (frameNo++ % 2 === 0 && aimWindow(clockT)) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(winRT);
      renderer.clear();
      renderer.render(deps.planet, winCam);
      renderer.setRenderTarget(prev);
    }

    // 2. animate the props
    const m = creatureMotion(mood, t);
    creature.position.y = 1.6 + m.y;
    creature.rotation.set(0, m.yaw, m.roll);
    const s = FAMILY_SCALE[creatureFamily ?? "other"] * 1.55;
    creature.scale.set(s, s * m.squash, s);
    bubble.position.y = 3.2 + (mood === "sleep" ? Math.sin(t * 0.8) * 0.12 : 0);
    drones.forEach((d, i) => {
      const a = t * (mood === "busy" ? 1.2 : 0.6) + (i * Math.PI * 2) / Math.max(1, drones.length);
      d.position.set(-0.45 + Math.cos(a) * 2.2, 3.4 + Math.sin(t * 2 + i) * 0.2 + (i % 2) * 0.35, -0.35 + Math.sin(a) * 1.6);
      d.rotation.y = -a;
    });
    if (mood === "alarm") shadeMat.emissiveIntensity = 0.25 + (Math.sin(t * 8) > 0 ? 0.5 : 0);
    if (data && now - cursorAt > 530) {
      cursorAt = now;
      drawScreen(data, Math.floor(now / 530) % 2 === 0);
    }

    // 3. the room, centred on the stage, through the ink + halftone post pass
    const size = renderer.getSize(new THREE.Vector2());
    const narrow = stage.width / Math.max(1, stage.height) < 1;
    // Portrait: crop the side walls a little so the desk, the creature and the window stay big.
    const proj = stageProjection(size.x, size.y, stage, 40, narrow ? 1.12 : 1.55);
    camera.aspect = size.x / Math.max(1, size.y);
    camera.fov = proj.fov;
    camera.setViewOffset(size.x, size.y, proj.offsetX, proj.offsetY, size.x, size.y);
    const px = deps.reducedMotion ? 0 : Math.sin(t * 0.13) * 0.35;
    camera.position.set(px, narrow ? 3.5 : 3.3, narrow ? 9.2 : 8.0);
    camera.lookAt(0.2, 2.35, -2);
    camera.updateProjectionMatrix();
    post.render({ scene, camera });
  }
  post.afterNextRender(frame);

  // ---------------------------------------------------------------- API

  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();
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

  /** The frame/trim around a furniture zone: these use a plain toon material (no texture), so the
   *  same emissive-glow trick used for a shelf item works on them too, giving screen/board/window
   *  a visible hover outline even though those zones' own mesh is a textured MeshBasicMaterial
   *  plane that can't glow itself. */
  function framesFor(o: THREE.Object3D | null): readonly THREE.Object3D[] {
    switch (o ? hits.get(o)?.kind : undefined) {
      case "screen":
        return [bezel];
      case "board":
        return [boardFrame];
      case "window":
        return windowFrame;
      default:
        return [];
    }
  }

  function setHoverObj(o: THREE.Object3D | null): void {
    if (hover === o) return;
    const glow = (x: THREE.Object3D | null, on: boolean): void => {
      if (!(x instanceof THREE.Mesh)) return;
      // The creature and every drone share one material instance (creatureMat): glowing it would
      // light up all of them at once, not just the hovered one, so both are excluded here.
      if (x === creature || drones.includes(x)) return;
      const m = x.material;
      if (m instanceof THREE.MeshToonMaterial) m.emissiveIntensity = on ? 0.35 : 0;
    };
    for (const f of framesFor(hover)) glow(f, false);
    glow(hover, false);
    glow(o, true);
    for (const f of framesFor(o)) glow(f, true);
    hover = o;
  }

  return {
    setData(d) {
      const prev = data;
      data = d;
      mood = d.mood;
      if (d.family !== creatureFamily) {
        creatureFamily = d.family;
        const old = creature.geometry;
        creature.geometry = creatureGeometry(d.family);
        old.dispose();
      }
      rugMat.color.set(d.tint).lerp(new THREE.Color(0xffffff), 0.55);
      const light = lampLight(d.mood);
      lampLightObj.color.setHex(light.color);
      lampLightObj.intensity = light.intensity;
      shadeMat.color.setHex(light.color);
      shadeMat.emissive.setHex(light.color);
      shadeMat.emissiveIntensity = 0.35;
      if (!prev || JSON.stringify(prev.notes) !== JSON.stringify(d.notes) || prev.hiddenNotes !== d.hiddenNotes || prev.progress?.done !== d.progress?.done) drawBoard(d);
      drawScreen(d, true);
      if (d.plant !== plantStageNow) buildPlant(d.plant);
      if (!prev || JSON.stringify(prev.shelf) !== JSON.stringify(d.shelf)) setShelf(d.shelf);
      setDrones(d.drones);
      const bubbleWant = d.mood === "sleep" ? "z z" : d.mood === "ask" ? "?" : d.mood === "alarm" ? "!" : "";
      if (bubbleWant !== bubbleText || prev?.mood !== d.mood) drawBubble(bubbleWant);
      const hands = d.clock ?? { hour: 0, minute: 0 };
      hourHand.rotation.z = -(hands.hour * Math.PI) / 180;
      minHand.rotation.z = -(hands.minute * Math.PI) / 180;
    },
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
    dispose() {
      disposed = true;
      if (plantMesh) plantMesh.geometry.dispose();
      creature.geometry.dispose();
      for (const m of shelfItems) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      for (const x of disposables) x.dispose();
      scene.clear();
    },
  };
}
