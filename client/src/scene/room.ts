import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AgentActivity, WorldAgent } from "../../../shared/types";
import { VIEW_LIGHT_DIR } from "./post";
import { creatureGeometry, FAMILY_SCALE, modelFamily, modelLabel } from "./creatures";
import { merge, painted, toon } from "./toon";

export interface RoomFile {
  name: string;
  weight: number;
}

export interface RoomInput {
  agent: WorldAgent;
  cityName: string;
  cityColor: number;
  files: RoomFile[];
  skills: string[];
  activities: AgentActivity[];
}

export type RoomHit = { kind: "file"; name: string } | { kind: "skill"; name: string } | { kind: "reactivate" } | { kind: "monitor" };

export interface Room {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** World position of the big Reactivate button (for its DOM label). */
  buttonAnchor: THREE.Vector3;
  hit(ndc: THREE.Vector2): RoomHit | null;
  setActivities(list: AgentActivity[]): void;
  update(dt: number, elapsed: number): void;
  resize(aspect: number): void;
  dispose(): void;
}

const INK = "#1a1030";
const STAGE_CSS: Record<string, string> = { hook: "#ff8a3d", brain: "#ff6fb5", plan: "#3fb6ff", reason: "#9b6dff", tool: "#e8a800" };

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/(?<=[\s/_.-])/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (ctx.measureText(cur + w).width > maxW && cur) {
      lines.push(cur.trimEnd());
      cur = w;
      if (lines.length === maxLines) break;
    } else cur += w;
  }
  if (lines.length < maxLines && cur) lines.push(cur.trimEnd());
  if (lines.length === maxLines && ctx.measureText(lines[maxLines - 1] ?? "").width > maxW) {
    lines[maxLines - 1] = `${(lines[maxLines - 1] ?? "").slice(0, -2)}…`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const NOTE_COLORS = ["#fff4a8", "#ffd6e0", "#c8f0ff", "#d9f99d", "#ffe0b8", "#e4d4ff"];
/** Pinboard note rects in UV space (0..1, origin bottom-left) for hit-testing. */
function noteRects(n: number): { x: number; y: number; w: number; h: number }[] {
  const cols = 3;
  const rows = 2;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < Math.min(n, cols * rows); i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: 0.05 + c * 0.315, y: 0.53 - r * 0.47, w: 0.28, h: 0.4 });
  }
  return out;
}

/** A cozy cut-away room for one agent: desk + monitor with its live activity, pinboard of its files,
 *  a shelf of skills it used, a window onto its city, the agent's creature, and a big Reactivate button. */
export function buildRoom(canvas: HTMLElement, input: RoomInput, aspect: number): Room {
  const { agent } = input;
  const family = modelFamily(agent.model);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6ead6);
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // Portrait screens need a wider vertical FOV so the whole diorama fits across.
  const fovFor = (a: number): number => (a < 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(18)) / a)) * 0.9 : 36);
  const camera = new THREE.PerspectiveCamera(fovFor(aspect), aspect, 0.5, 200);
  camera.position.set(8.4, 6.6, 9.6);
  if (aspect < 1) camera.position.multiplyScalar(1.08);
  scene.add(camera);
  const key = new THREE.DirectionalLight(0xfff4e0, 2.1);
  key.position.copy(VIEW_LIGHT_DIR).multiplyScalar(30);
  camera.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0xfff8ee, 0xe8c9a0, 1.5), new THREE.AmbientLight(0xffffff, 0.35));

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(aspect < 1 ? 0.3 : -0.4, aspect < 1 ? 2.1 : 1.6, -1);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 9;
  controls.maxDistance = 40;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = 1.25;
  controls.minAzimuthAngle = 0.15;
  controls.maxAzimuthAngle = 1.35;
  controls.update();

  const mat = (c: number): THREE.MeshToonMaterial => track(toon(c));
  const box = (w: number, h: number, d: number, c: number, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat(c));
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  // ---- shell: floor, two walls, skirting ----
  box(10.4, 0.3, 10.4, 0xe0b27a, 0, -0.15, 0);
  box(10.4, 5.4, 0.3, 0xfff1dc, 0, 2.7, -5.05);
  box(0.3, 5.4, 10.4, 0xffe6c4, -5.05, 2.7, 0);
  box(10.4, 0.35, 0.36, 0xc98f55, 0, 0.17, -4.85);
  box(0.36, 0.35, 10.4, 0xc98f55, -4.85, 0.17, 0);
  // Rug.
  const rug = new THREE.Mesh(track(new THREE.CylinderGeometry(2.6, 2.6, 0.06, 40)), mat(new THREE.Color(input.cityColor).lerp(new THREE.Color(0xffffff), 0.45).getHex()));
  rug.position.set(0.2, 0.03, 0.8);
  scene.add(rug);

  // ---- desk + chair ----
  const deskColor = 0xb97a45;
  box(4.4, 0.18, 1.8, deskColor, 0.6, 1.5, -3.6);
  for (const [x, z] of [
    [-1.5, -4.3],
    [2.7, -4.3],
    [-1.5, -2.9],
    [2.7, -2.9],
  ] as const) {
    box(0.16, 1.45, 0.16, 0x8f5a2e, x, 0.72, z);
  }
  box(1.3, 0.14, 1.2, 0x5b6bd6, 0.4, 0.95, -1.9);
  box(1.3, 1.2, 0.14, 0x5b6bd6, 0.4, 1.6, -1.35);
  box(0.12, 0.9, 0.12, 0x3a3f66, 0.4, 0.45, -1.9);

  // ---- monitor with this agent's real activity ----
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = 640;
  screenCanvas.height = 400;
  const screenTex = track(new THREE.CanvasTexture(screenCanvas));
  screenTex.colorSpace = THREE.SRGBColorSpace;
  let lines: AgentActivity[] = input.activities.slice(-6);
  function drawScreen(cursorOn: boolean): void {
    const ctx = screenCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#eaf6ff";
    ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = "#1a1030";
    ctx.fillRect(0, 0, 640, 44);
    ctx.fillStyle = "#ffd23f";
    ctx.font = "bold 22px Menlo, monospace";
    ctx.fillText(`claude · ${input.cityName}`.slice(0, 44), 16, 30);
    ctx.font = "bold 26px Menlo, monospace";
    let y = 88;
    if (!lines.length) {
      ctx.fillStyle = "#4b4270";
      const status = agent.status === "live" ? "Live, waiting for the next line…" : "Asleep. No live activity.";
      for (const l of wrap(ctx, status, 600, 2)) {
        ctx.fillText(l, 16, y);
        y += 36;
      }
      ctx.fillStyle = "#1a1030";
      for (const l of wrap(ctx, `> ${agent.title}`, 600, 5)) {
        y += 6;
        ctx.fillText(l, 16, y);
        y += 26;
      }
    } else {
      for (const a of lines) {
        ctx.fillStyle = STAGE_CSS[a.stage] ?? "#1a1030";
        ctx.fillRect(16, y - 16, 14, 14);
        ctx.fillStyle = "#1a1030";
        const l = wrap(ctx, a.summary, 580, 1)[0] ?? "";
        ctx.fillText(l, 40, y);
        y += 50;
      }
    }
    if (cursorOn) {
      ctx.fillStyle = "#1a1030";
      ctx.fillRect(16, Math.min(y, 372), 14, 22);
    }
    screenTex.needsUpdate = true;
  }
  drawScreen(true);
  const monitorBody = box(2.4, 1.6, 0.16, 0x2b2544, 0.3, 2.65, -4.05);
  box(0.2, 0.6, 0.2, 0x2b2544, 0.3, 1.85, -4.1);
  box(0.9, 0.06, 0.5, 0x2b2544, 0.3, 1.62, -4.05);
  const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(2.2, 1.375)), track(new THREE.MeshBasicMaterial({ map: screenTex })));
  screen.position.set(0.3, 2.65, -3.96);
  scene.add(screen);
  box(1.6, 0.06, 0.55, 0xf4f0ff, 0.3, 1.62, -3.25);
  void monitorBody;

  // Desk lamp + mug.
  box(0.1, 0.9, 0.1, 0x2b2544, -1.3, 2.05, -4.1);
  const shade = new THREE.Mesh(track(new THREE.ConeGeometry(0.4, 0.45, 12, 1, true)), mat(0xff4d8d));
  shade.position.set(-1.1, 2.5, -3.95);
  shade.rotation.z = -0.5;
  scene.add(shade);
  const mug = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.14, 0.32, 14)), mat(0x3fb6ff));
  mug.position.set(-0.9, 1.76, -3.2);
  scene.add(mug);

  // ---- big Reactivate button on the desk ----
  const btnBase = new THREE.Mesh(track(new THREE.CylinderGeometry(0.46, 0.52, 0.2, 24)), mat(0x2b2544));
  btnBase.position.set(2.1, 1.69, -3.25);
  const btnCap = new THREE.Mesh(track(new THREE.SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), mat(agent.status === "live" ? 0x9aa0b5 : 0xff2e4d));
  btnCap.position.set(2.1, 1.78, -3.25);
  btnCap.scale.y = 0.7;
  scene.add(btnBase, btnCap);
  const buttonAnchor = new THREE.Vector3(2.1, 2.2, -3.25);

  // ---- pinboard: top touched files ----
  const files = input.files.slice(0, 6);
  const rects = noteRects(files.length);
  const boardTex = track(
    canvasTex(768, 512, (ctx) => {
      ctx.fillStyle = "#d9a066";
      ctx.fillRect(0, 0, 768, 512);
      ctx.fillStyle = "rgba(120,70,30,0.25)";
      for (let i = 0; i < 400; i++) ctx.fillRect((i * 97) % 768, (i * 53) % 512, 3, 3);
      if (!files.length) {
        ctx.fillStyle = INK;
        ctx.font = "bold 34px 'Arial Black', sans-serif";
        ctx.fillText("no files pinned yet", 170, 270);
      }
      files.forEach((f, i) => {
        const r = rects[i];
        if (!r) return;
        const x = r.x * 768;
        const y = (1 - r.y - r.h) * 512;
        const w = r.w * 768;
        const h = r.h * 512;
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(((i % 3) - 1) * 0.04);
        ctx.fillStyle = NOTE_COLORS[i % NOTE_COLORS.length] ?? "#fff";
        ctx.strokeStyle = INK;
        ctx.lineWidth = 5;
        roundRect(ctx, -w / 2, -h / 2, w, h, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ff2e4d";
        ctx.beginPath();
        ctx.arc(0, -h / 2 + 18, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK;
        ctx.font = "bold 26px 'Arial Black', sans-serif";
        const base = f.name.split("/").pop() ?? f.name;
        wrap(ctx, base, w - 26, 3).forEach((l, k) => ctx.fillText(l, -w / 2 + 13, -h / 2 + 64 + k * 30));
        ctx.font = "bold 20px Menlo, monospace";
        ctx.fillStyle = "#6b5f86";
        ctx.fillText(`touched ×${f.weight}`, -w / 2 + 13, h / 2 - 16);
        ctx.restore();
      });
    }),
  );
  box(3.6, 2.5, 0.12, 0x8f5a2e, -2.6, 3.3, -4.9);
  const board = new THREE.Mesh(track(new THREE.PlaneGeometry(3.4, 2.3)), track(new THREE.MeshToonMaterial({ map: boardTex })));
  board.position.set(-2.6, 3.3, -4.83);
  scene.add(board);

  // ---- name plaque (AI Village style) ----
  const plaqueTex = track(
    canvasTex(640, 120, (ctx) => {
      ctx.fillStyle = "#fffdf6";
      ctx.fillRect(0, 0, 640, 120);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, 632, 112);
      ctx.fillStyle = INK;
      ctx.font = "bold 44px 'Arial Black', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${modelLabel(agent.model).toUpperCase()}'S ROOM`, 320, 58);
      ctx.font = "bold 24px Menlo, monospace";
      ctx.fillStyle = "#6b5f86";
      ctx.fillText(`${input.cityName} · ${agent.status}`.slice(0, 44), 320, 96);
    }),
  );
  const plaque = new THREE.Mesh(track(new THREE.PlaneGeometry(3.2, 0.6)), track(new THREE.MeshBasicMaterial({ map: plaqueTex })));
  plaque.position.set(1.4, 4.7, -4.88);
  scene.add(plaque);

  // ---- window onto the city ----
  const winTex = track(
    canvasTex(320, 256, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, "#7ad7ff");
      g.addColorStop(1, "#d6f4ff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 320, 256);
      ctx.fillStyle = "#ffffff";
      for (const [x, y, r] of [
        [70, 60, 22],
        [95, 55, 28],
        [120, 62, 20],
        [240, 90, 18],
        [262, 84, 24],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#5cc93b";
      ctx.beginPath();
      ctx.ellipse(160, 290, 260, 110, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff6e6";
      ctx.fillRect(150, 90, 30, 110);
      ctx.fillStyle = `#${input.cityColor.toString(16).padStart(6, "0")}`;
      ctx.beginPath();
      ctx.moveTo(140, 92);
      ctx.lineTo(165, 50);
      ctx.lineTo(190, 92);
      ctx.fill();
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = NOTE_COLORS[i % NOTE_COLORS.length] ?? "#fff";
        ctx.fillRect(20 + i * 42, 190 - (i % 3) * 14, 30, 60);
      }
    }),
  );
  box(2.3, 2.1, 0.2, 0xffffff, 3.3, 3.0, -4.95);
  const win = new THREE.Mesh(track(new THREE.PlaneGeometry(2.0, 1.8)), track(new THREE.MeshBasicMaterial({ map: winTex })));
  win.position.set(3.3, 3.0, -4.83);
  scene.add(win);
  box(0.08, 1.8, 0.1, 0xffffff, 3.3, 3.0, -4.8);
  box(2.0, 0.08, 0.1, 0xffffff, 3.3, 3.0, -4.8);

  // ---- shelf of skills it used (left wall) ----
  box(0.5, 0.12, 4.2, 0x8f5a2e, -4.65, 2.0, 0.2);
  box(0.5, 0.12, 4.2, 0x8f5a2e, -4.65, 3.2, 0.2);
  const skills = input.skills.slice(0, 14);
  const bookGeo = track(new THREE.BoxGeometry(0.42, 0.9, 0.24).translate(0, 0.45, 0));
  const books = new THREE.InstancedMesh(bookGeo, track(toon(0xffffff)), Math.max(1, skills.length));
  books.count = skills.length;
  const BOOK_COLORS = [0xff4d6d, 0xffbe0b, 0x3a86ff, 0x8338ec, 0x06d6a0, 0xfb5607, 0xff006e, 0x00bbf9];
  skills.forEach((_, i) => {
    const shelfY = i < 7 ? 2.06 : 3.26;
    const k = i % 7;
    const h = 0.75 + ((i * 37) % 5) * 0.06;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(-4.62, shelfY, -1.55 + k * 0.52),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), k === 6 ? 0.2 : 0),
      new THREE.Vector3(1, h, 1),
    );
    books.setMatrixAt(i, m);
    books.setColorAt(i, new THREE.Color(BOOK_COLORS[i % BOOK_COLORS.length] ?? 0xff4d6d));
  });
  scene.add(books);

  // Plant.
  const pot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.42, 0.32, 0.7, 14)), mat(0xff8a3d));
  pot.position.set(-4, 0.35, 3.6);
  const leaves = new THREE.Mesh(
    track(
      merge([
        painted(new THREE.IcosahedronGeometry(0.62, 1).translate(0, 1.2, 0), 0x3dba5c),
        painted(new THREE.IcosahedronGeometry(0.42, 1).translate(0.35, 1.7, 0.1), 0x5cc93b),
      ]),
    ),
    track(toon(0xffffff, { vertexColors: true })),
  );
  leaves.position.copy(pot.position);
  scene.add(pot, leaves);

  // ---- the agent's creature ----
  const creature = new THREE.Mesh(track(creatureGeometry(family)), track(toon(0xffffff, { vertexColors: true })));
  const cScale = 2.4 * FAMILY_SCALE[family];
  creature.scale.setScalar(cScale);
  creature.position.set(-1.6, 1.2, -1.2);
  creature.rotation.y = 0.5;
  scene.add(creature);

  // ---- hit-testing ----
  const raycaster = new THREE.Raycaster();
  function hit(ndc: THREE.Vector2): RoomHit | null {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([board, books, btnBase, btnCap, screen], false);
    const h = hits[0];
    if (!h) return null;
    if (h.object === board && h.uv) {
      const uv = h.uv;
      const i = rects.findIndex((r) => uv.x >= r.x && uv.x <= r.x + r.w && uv.y >= r.y && uv.y <= r.y + r.h);
      const f = files[i];
      return f ? { kind: "file", name: f.name } : null;
    }
    if (h.object === books && h.instanceId !== undefined) {
      const name = skills[h.instanceId];
      return name ? { kind: "skill", name } : null;
    }
    if (h.object === btnBase || h.object === btnCap) return { kind: "reactivate" };
    if (h.object === screen) return { kind: "monitor" };
    return null;
  }

  let lastCursor = 0;
  let cursorOn = true;

  return {
    scene,
    camera,
    controls,
    buttonAnchor,
    hit,
    setActivities(list) {
      lines = list.slice(-6);
      drawScreen(cursorOn);
    },
    update(_dt, elapsed) {
      controls.update();
      const bobSpeed = family === "haiku" ? 5 : 2.6;
      creature.position.y = 1.2 + Math.abs(Math.sin(elapsed * bobSpeed)) * (agent.status === "live" ? 0.35 : 0.12);
      creature.rotation.y = 0.5 + Math.sin(elapsed * 0.7) * 0.35;
      btnCap.position.y = 1.78 + (agent.status === "live" ? 0 : Math.abs(Math.sin(elapsed * 3)) * 0.04);
      if (elapsed - lastCursor > 0.5) {
        lastCursor = elapsed;
        cursorOn = !cursorOn;
        drawScreen(cursorOn);
      }
    },
    resize(a) {
      camera.aspect = a;
      camera.fov = fovFor(a);
      camera.updateProjectionMatrix();
    },
    dispose() {
      controls.dispose();
      for (const d of disposables) d.dispose();
      books.dispose();
    },
  };
}
