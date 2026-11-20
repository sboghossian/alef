// 🧠 Brain, 3D globe mode: the vault graph as a luminous, see-through globe of ideas. Saturated
// beads (hubs big, leaves small) cluster by folder, a dominant folder splits into sub-patches in
// its own colour family, the strongest links hug the surface as faint arcs, and the far
// hemisphere shows through a milky pale-sky veil so it reads as a sphere, not a disc. A pastel
// halo rings it. Brain's OWN THREE.WebGLRenderer (the caller creates it on a canvas inside Brain's
// root and hands it in; Brain is usesPlanet:false, so the shared planet loop is paused and this
// never touches the planet renderer). dispose() frees everything, including the globe's own
// toon-gradient clone (the shared one is never used here, so no dead renderer stays hooked to
// it), then renderer.dispose() + forceContextLoss(). The loop runs only while the canvas is
// attached and the tab is visible, and sleeps when nothing moves. Layout, colours, link cap,
// spin physics, tones and label placement are pure in brain-globe-lib.ts; this file only builds
// and animates the THREE objects.

import * as THREE from "three";
import type { BrainNode } from "../../../shared/features/brain";
import { wheelFactor } from "../features/canvas/view";
import { toon, toonGradient } from "../scene/toon";
import {
  ARC_SEGMENTS,
  GLOBE_R,
  arcPoints,
  capLinks,
  dragSpin,
  faceSpin,
  fitDistance,
  frontMost,
  globeLayout,
  globeNodeSize,
  keySpin,
  layoutLabels,
  spinAt,
  spinMoving,
  stepSpin,
  toneOf,
  type GlobeSplit,
  type Region,
  type Vec3,
} from "./brain-globe-lib";
import { folderColor } from "./brain-lib";

const INK = "#1a1030";
const RIM = "#3a3170";
const SKY = "#cdeaff";
const HALO = "#9fd6ff";
const FOG = "#dcf0fd"; // the backdrop's own pale sky: the far side fades INTO the page, never to dark
const PINK = "#ff4d8d";
const FOV = 38;
const PER_LINK = ARC_SEGMENTS * 2; // vertices per link (LineSegments pairs)
const LINK_ALPHA = 38; // of 255: faint, tinted threads
const LINK_ALPHA_DIM = 8;

/** The part of THREE.WebGLRenderer the globe uses (tests hand in a mock). */
export interface GlobeRenderer {
  setPixelRatio(r: number): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  dispose(): void;
  forceContextLoss(): void;
}

export interface GlobeCanvas extends EventTarget {
  readonly isConnected: boolean;
  readonly style: { cursor: string };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  remove(): void;
}

export interface GlobeEnv {
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  hidden(): boolean;
  reducedMotion(): boolean;
  dpr(): number;
  onVisibility(fn: () => void): () => void;
}

export interface GlobeDeps {
  canvas: GlobeCanvas;
  renderer: GlobeRenderer;
  /** Folder names drawn as small labels over the globe (optional). `make` is handed the raw
   *  folder id -- the vault root is "" -- and decides what to call it; the globe only places it. */
  labels?: { host: HTMLElement; make(folder: string, color: string): HTMLElement } | null;
  env?: GlobeEnv;
  onHover(id: number | null, clientX: number, clientY: number): void;
  onPick(id: number): void;
  /** The GPU dropped the context (not our own dispose). */
  onLost?(): void;
}

export interface GlobeController {
  setGraph(nodes: readonly BrainNode[], edges: ReadonlyArray<readonly [number, number]>, nbrs: ReadonlyMap<number, ReadonlySet<number>>): void;
  /** Ids that pass the search / folder filters; null = no filter (everything lit). */
  setLit(lit: ReadonlySet<number> | null): void;
  setOpen(id: number | null): void;
  face(id: number): boolean;
  zoom(factor: number): void;
  reset(): void;
  resize(): void;
  linksDrawn(): number;
  /** The folders split into coloured sub-groups (for the legend). */
  splits(): readonly GlobeSplit[];
  /** Where the globe is turned and how far the camera is (read-only; for tests and a11y text). */
  view(): { yaw: number; pitch: number; dist: number; targetDist: number; vyaw: number; vpitch: number };
  dispose(): void;
}

function browserEnv(): GlobeEnv {
  return {
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    hidden: () => document.hidden,
    reducedMotion: () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    dpr: () => window.devicePixelRatio || 1,
    onVisibility(fn) {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

/** Faint latitude rings + meridians: the globe reads as a turning ball even between beads. */
function graticule(): THREE.LineSegments {
  const pts: number[] = [];
  const r = GLOBE_R * 0.972;
  const ring = (f: (a: number) => [number, number, number]): void => {
    for (let i = 0; i < 64; i++) pts.push(...f((i / 64) * Math.PI * 2), ...f(((i + 1) / 64) * Math.PI * 2));
  };
  for (const lat of [-60, -30, 0, 30, 60]) {
    const y = Math.sin((lat * Math.PI) / 180) * r;
    const c = Math.cos((lat * Math.PI) / 180) * r;
    ring((a) => [Math.cos(a) * c, y, Math.sin(a) * c]);
  }
  for (let k = 0; k < 6; k++) {
    const lon = (k / 6) * Math.PI;
    ring((a) => [Math.cos(a) * Math.cos(lon) * r, Math.sin(a) * r, Math.cos(a) * Math.sin(lon) * r]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.7, depthWrite: false }));
}

/** A soft pastel halo just outside the globe: a back-faced shell whose alpha peaks at the
 *  globe's edge and fades to nothing outward (and inward, behind the veil). */
function halo(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(HALO) } },
    vertexShader: "varying vec3 vN; void main() { vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader:
      "uniform vec3 color; varying vec3 vN; void main() { float a = -vN.z; float k = smoothstep(0.0, 0.5, a) * (1.0 - smoothstep(0.5, 0.75, a)); gl_FragColor = vec4(color, 0.75 * k); \n#include <colorspace_fragment>\n}",
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.16, 64, 32), mat);
}

export function createGlobe(deps: GlobeDeps): GlobeController {
  const { canvas, renderer } = deps;
  const env = deps.env ?? browserEnv();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000);
  const sun = new THREE.DirectionalLight("#ffffff", 1.5);
  sun.position.set(-0.6, 0.9, 1);
  camera.add(sun);
  scene.add(new THREE.HemisphereLight("#ffffff", "#fff1c9", 2.1), camera);
  const globe = new THREE.Group();
  // Draw order (all transparent, sorted by renderOrder): halo, graticule, links, beads, then the
  // veil, which only lands on what is BEHIND its front surface: the far hemisphere fades, the near
  // one stays crisp. The rim is a camera-facing ring on the silhouette.
  const haloMesh = halo();
  const lines = graticule();
  const veil = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 0.99, 64, 40), new THREE.MeshBasicMaterial({ color: SKY, transparent: true, opacity: 0.5, depthWrite: false }));
  // Depth: fog in the backdrop's colour, from the near surface to past the far one, so the limb
  // and far hemisphere (beads and links alike) fade toward the page and it reads as a sphere.
  const fog = new THREE.Fog(FOG, 1, 2);
  scene.fog = fog;
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.992, 1, 128), new THREE.MeshBasicMaterial({ color: RIM, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
  // The globe's own gradient ramp: the shared toonGradient() singleton would keep a dispose
  // listener (and with it this renderer and canvas) alive after every close.
  const gradient = toonGradient().clone();
  gradient.needsUpdate = true;
  const nodeGeo = new THREE.IcosahedronGeometry(1, 1); // 80 faces: low-poly, toy-like
  const nodeMat = toon("#ffffff", { gradientMap: gradient, transparent: true });
  const outlineMat = new THREE.MeshBasicMaterial({ color: "#ffffff", side: THREE.BackSide, transparent: true });
  let dots = new THREE.InstancedMesh(nodeGeo, nodeMat, 0);
  let outlines = new THREE.InstancedMesh(nodeGeo, outlineMat, 0);
  const links = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  const hiLinks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PINK, transparent: true, opacity: 0.95, depthWrite: false }));
  haloMesh.renderOrder = 0;
  lines.renderOrder = 1;
  links.renderOrder = 2;
  hiLinks.renderOrder = 3;
  veil.renderOrder = 6;
  rim.renderOrder = 7;
  globe.add(lines, links, hiLinks, dots, outlines, veil);
  scene.add(haloMesh, globe, rim);
  renderer.setClearColor(0x000000, 0);

  let list: BrainNode[] = [];
  let pos = new Map<number, Vec3>();
  let regions = new Map<string, Region>();
  let colors = new Map<number, string>();
  let splitList: GlobeSplit[] = [];
  let nbrs: ReadonlyMap<number, ReadonlySet<number>> = new Map();
  let drawn: Array<readonly [number, number]> = [];
  let lit: ReadonlySet<number> | null = null;
  let open: number | null = null;
  let hover: number | null = null;
  let fitDist = fitDistance(FOV, 1.4);
  let spin = spinAt(fitDist);
  let userZoomed = false;
  let framed = false; // the first graph opens facing its biggest folder, turned toward the second
  let view = { w: 0, h: 0 };
  let rafId = 0;
  let last = 0;
  let disposed = false;
  let drag: { sx: number; sy: number; x: number; y: number; t: number; moved: boolean } | null = null;
  let pendingHover: { x: number; y: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  let labelEls: Array<{ el: HTMLElement; c: Vec3; w: number; h: number }> = [];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const col = new THREE.Color();
  const skyC = new THREE.Color(SKY);
  const inkC = new THREE.Color(INK);

  function kick(): void {
    if (rafId || disposed || !canvas.isConnected || env.hidden()) return;
    rafId = env.raf(frame);
  }

  function frame(t: number): void {
    rafId = 0;
    if (disposed || !canvas.isConnected || env.hidden()) return; // visibilitychange restarts it
    const dt = last ? Math.min(0.05, Math.max(0, (t - last) / 1000)) : 1 / 60;
    last = t;
    const auto = !env.reducedMotion();
    spin = stepSpin(spin, dt, { drag: drag !== null, hover: hover !== null, auto });
    if (pendingHover) hoverAt(pendingHover);
    pendingHover = null;
    globe.rotation.set(spin.pitch, spin.yaw, 0);
    camera.position.set(0, 0, spin.dist);
    fog.near = spin.dist - GLOBE_R * 0.95;
    fog.far = spin.dist + GLOBE_R * 1.6;
    // the rim ring sits on the sphere's silhouette circle as seen from the camera
    const k = GLOBE_R / spin.dist;
    rim.position.set(0, 0, GLOBE_R * k);
    rim.scale.setScalar(GLOBE_R * Math.sqrt(Math.max(0, 1 - k * k)));
    renderer.render(scene, camera);
    placeLabels();
    if (spinMoving(spin, auto && hover === null) || drag) kick(); // a hovered, still globe sleeps until the next event
    else last = 0;
  }

  function setGraph(nodes: readonly BrainNode[], edges: ReadonlyArray<readonly [number, number]>, nb: ReadonlyMap<number, ReadonlySet<number>>): void {
    if (disposed) return;
    const lay = globeLayout(nodes);
    pos = lay.pos;
    regions = lay.regions;
    colors = lay.color;
    splitList = lay.splits;
    nbrs = nb;
    list = nodes.filter((n) => pos.has(n.id));
    for (const m of [dots, outlines]) {
      globe.remove(m);
      m.dispose();
    }
    dots = new THREE.InstancedMesh(nodeGeo, nodeMat, list.length);
    outlines = new THREE.InstancedMesh(nodeGeo, outlineMat, list.length);
    outlines.renderOrder = 4;
    dots.renderOrder = 5;
    globe.add(dots, outlines);
    drawn = capLinks(
      edges.filter(([a, b]) => pos.has(a) && pos.has(b)),
      new Map(list.map((n) => [n.id, n.degree])),
    );
    const P = new Float32Array(drawn.length * PER_LINK * 3);
    const C = new Uint8Array(drawn.length * PER_LINK * 4);
    const to = new THREE.Color();
    drawn.forEach(([a, b], e) => {
      const pts = arcPoints(pos.get(a) as Vec3, pos.get(b) as Vec3);
      // tinted by the source folder, blending into the target's colour along the arc
      const from = new THREE.Color(colors.get(a) ?? INK);
      to.set(colors.get(b) ?? INK);
      for (let s = 0; s < ARC_SEGMENTS; s++)
        for (let k = 0; k < 2; k++) {
          const p = pts[s + k] as Vec3;
          const v = e * PER_LINK + s * 2 + k;
          P.set([p.x, p.y, p.z], v * 3);
          col.copy(from).lerp(to, (s + k) / ARC_SEGMENTS);
          C.set([col.r * 255, col.g * 255, col.b * 255, 0], v * 4);
        }
    });
    links.geometry.dispose();
    links.geometry = new THREE.BufferGeometry();
    links.geometry.setAttribute("position", new THREE.BufferAttribute(P, 3));
    links.geometry.setAttribute("color", new THREE.BufferAttribute(C, 4, true));
    if (!framed && regions.size) {
      const [a, b] = [...regions.values()]; // biggest first
      const c = a && b ? { x: a.centre.x + 0.5 * b.centre.x, y: a.centre.y + 0.5 * b.centre.y, z: a.centre.z + 0.5 * b.centre.z } : a?.centre;
      if (c && Math.hypot(c.x, c.y, c.z) > 1e-6) spin = faceSpin(spin, c, true);
      framed = true;
    }
    buildLabels();
    paint();
  }

  /** Colours, sizes and link alphas for the current focus (hover, else the open note) and filters. */
  function paint(): void {
    if (disposed) return;
    const f = hover ?? open;
    const near = f !== null ? nbrs.get(f) : undefined;
    list.forEach((n, i) => {
      const tone = toneOf(n.id, f, near, lit);
      const p = pos.get(n.id) as Vec3;
      const r = globeNodeSize(n.degree) * (tone === "focus" ? 1.9 : tone === "near" ? 1.35 : tone === "dim" ? 0.8 : 1);
      col.set(colors.get(n.id) ?? INK);
      if (tone === "dim") col.lerp(skyC, 0.72);
      dots.setColorAt(i, col);
      dots.setMatrixAt(i, m4.compose(v3.set(p.x, p.y, p.z), q, s3.setScalar(r)));
      // a thin outline in a deeper shade of the bead's own colour (pink for the focus)
      outlines.setMatrixAt(i, m4.compose(v3, q, s3.setScalar(r * 1.14 + 0.05)));
      outlines.setColorAt(i, tone === "focus" ? col.set(PINK) : col.lerp(inkC, tone === "dim" ? 0.15 : 0.45));
    });
    for (const m of [dots, outlines]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    dots.computeBoundingSphere();
    const alpha = links.geometry.getAttribute("color");
    if (alpha instanceof THREE.BufferAttribute && alpha.array instanceof Uint8Array) {
      const arr = alpha.array;
      drawn.forEach(([a, b], e) => {
        const on = f === null && (lit === null || (lit.has(a) && lit.has(b)));
        for (let v = 0; v < PER_LINK; v++) arr[(e * PER_LINK + v) * 4 + 3] = on ? LINK_ALPHA : LINK_ALPHA_DIM;
      });
      alpha.needsUpdate = true;
    }
    // ALL of the focus note's links, bright (not just the capped ones drawn by default)
    const hi: number[] = [];
    const fp = f !== null ? pos.get(f) : undefined;
    if (fp)
      for (const o of near ?? []) {
        const op = pos.get(o);
        if (!op) continue;
        const pts = arcPoints(fp, op);
        for (let s = 0; s < ARC_SEGMENTS; s++) for (const p of [pts[s] as Vec3, pts[s + 1] as Vec3]) hi.push(p.x, p.y, p.z);
      }
    hiLinks.geometry.dispose();
    hiLinks.geometry = new THREE.BufferGeometry();
    hiLinks.geometry.setAttribute("position", new THREE.Float32BufferAttribute(hi, 3));
    kick();
  }

  function buildLabels(): void {
    for (const l of labelEls) l.el.remove();
    labelEls = [];
    if (!deps.labels) return;
    for (const [folder, reg] of regions) {
      const el = deps.labels.make(folder, folderColor(folder));
      deps.labels.host.append(el);
      const r = el.getBoundingClientRect();
      labelEls.push({ el, c: reg.centre, w: r.width || 8 * (folder.length + 3), h: r.height || 22 });
    }
  }

  /** Folder names follow their region's centre, fade out as it turns away, and never overlap
   *  (biggest folders keep their spot; the others nudge a line or hide). */
  function placeLabels(): void {
    if (!labelEls.length) return;
    const boxes = labelEls.map((l) => {
      v3.set(l.c.x, l.c.y, l.c.z).multiplyScalar(GLOBE_R).applyMatrix4(globe.matrixWorld);
      const facing = v3.z / GLOBE_R;
      v3.project(camera);
      return { x: ((v3.x + 1) / 2) * view.w, y: ((1 - v3.y) / 2) * view.h, w: l.w, h: l.h, facing };
    });
    const front = boxes.map((b, i) => ({ b, i })).filter(({ b }) => b.facing > 0.1);
    const placed = layoutLabels(front.map(({ b }) => b));
    const at = new Map(front.map(({ i }, k) => [i, placed[k]]));
    labelEls.forEach((l, i) => {
      const p = at.get(i);
      const b = boxes[i];
      l.el.style.opacity = p?.visible && b ? String(Math.min(1, (b.facing - 0.1) / 0.3)) : "0";
      if (p?.visible) l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  }

  function pickAt(clientX: number, clientY: number): number | null {
    if (!list.length || !view.w || !view.h) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    globe.rotation.set(spin.pitch, spin.yaw, 0);
    camera.position.set(0, 0, spin.dist);
    scene.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects([dots, veil], false)[0];
    if (!hit || hit.object !== dots || hit.instanceId === undefined) return null; // the veil blocks the far side
    return list[hit.instanceId]?.id ?? null;
  }

  function hoverAt(p: { x: number; y: number }): void {
    const id = pickAt(p.x, p.y);
    if (id !== hover) {
      hover = id;
      paint();
    }
    canvas.style.cursor = id !== null ? "pointer" : "grab";
    deps.onHover(id, p.x, p.y);
  }

  function clearHover(): void {
    pendingHover = null;
    if (hover !== null) {
      hover = null;
      paint();
    }
    deps.onHover(null, 0, 0);
  }

  function zoom(factor: number): void {
    if (!(factor > 0)) return;
    userZoomed = true;
    spin = { ...spin, targetDist: Math.max(GLOBE_R * 1.35, Math.min(fitDist * 2.2, spin.targetDist / factor)) };
    kick();
  }

  const spread = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  /** A drag of one globe-radius in px turns the globe by about one radian (the surface follows). */
  const radPerPx = (): number => 1 / Math.max(40, (GLOBE_R / (spin.dist * Math.tan((FOV * Math.PI) / 360))) * (view.h / 2));

  const onDown = (ev: PointerEvent): void => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      pinch = spread();
      drag = null;
      return;
    }
    drag = { sx: ev.clientX, sy: ev.clientY, x: ev.clientX, y: ev.clientY, t: ev.timeStamp, moved: false };
  };
  const onMove = (ev: PointerEvent): void => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2 && pinch > 0) {
      const d = spread();
      zoom(d / pinch); // fingers apart → factor > 1 → closer
      pinch = d;
      return;
    }
    if (drag && !drag.moved && Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 4) {
      drag.moved = true;
      clearHover();
    }
    if (drag?.moved) {
      spin = dragSpin(spin, ev.clientX - drag.x, ev.clientY - drag.y, Math.max(1, ev.timeStamp - drag.t) / 1000, radPerPx());
      Object.assign(drag, { x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
      canvas.style.cursor = "grabbing";
      kick();
      return;
    }
    pendingHover = { x: ev.clientX, y: ev.clientY };
    kick();
  };
  const onUp = (ev: PointerEvent): void => {
    pointers.delete(ev.pointerId);
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (pointers.size < 2) pinch = 0;
    const d = drag;
    drag = null;
    if (!d || ev.type === "pointercancel") return;
    if (d.moved) {
      // no fling under reduced motion, nor when the pointer stopped before letting go
      if (env.reducedMotion() || ev.timeStamp - d.t > 80) spin = { ...spin, vyaw: 0, vpitch: 0 };
      kick();
      return;
    }
    const id = pickAt(ev.clientX, ev.clientY);
    if (id !== null) deps.onPick(id);
  };
  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    zoom(wheelFactor(ev.deltaY, ev.deltaMode, ev.ctrlKey));
  };
  /** Only while the globe has focus: arrows turn, + / − zoom, Enter opens the hovered note (else
   *  the one in the middle). Handled keys stop here, so the shell's global keys never see them. */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const turned = keySpin(spin, ev.key, env.reducedMotion());
    if (turned) spin = turned;
    else if (ev.key === "+" || ev.key === "=") zoom(1.25);
    else if (ev.key === "-" || ev.key === "_") zoom(1 / 1.25);
    else if (ev.key === "Enter") {
      const id = hover ?? frontMost(pos, spin.yaw, spin.pitch);
      if (id !== null) deps.onPick(id);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
    kick();
  };
  const onLost = (): void => deps.onLost?.();
  const listeners: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["pointerdown", onDown as EventListener],
    ["pointermove", onMove as EventListener],
    ["pointerup", onUp as EventListener],
    ["pointercancel", onUp as EventListener],
    ["pointerleave", clearHover],
    ["wheel", onWheel as EventListener, { passive: false }],
    ["keydown", onKey as EventListener],
    ["webglcontextlost", onLost],
  ];
  for (const [type, fn, opts] of listeners) canvas.addEventListener(type, fn, opts);
  const offVisibility = env.onVisibility(() => kick());

  return {
    setGraph,
    setLit(next) {
      lit = next;
      paint();
    },
    setOpen(id) {
      if (id === open) return;
      open = id;
      paint();
    },
    face(id) {
      const p = pos.get(id);
      if (!p || disposed) return false;
      spin = faceSpin(spin, p, env.reducedMotion());
      kick();
      return true;
    },
    zoom,
    reset() {
      userZoomed = false;
      spin = { ...spin, targetDist: fitDist, face: { yaw: spin.yaw, pitch: 0.3 } };
      kick();
    },
    resize() {
      if (disposed) return;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      view = { w: r.width, h: r.height };
      renderer.setPixelRatio(Math.min(2, env.dpr()));
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      fitDist = fitDistance(FOV, camera.aspect);
      if (!userZoomed) spin = { ...spin, targetDist: fitDist, dist: last ? spin.dist : fitDist };
      kick();
    },
    linksDrawn: () => drawn.length,
    splits: () => splitList,
    view: () => ({ yaw: spin.yaw, pitch: spin.pitch, dist: spin.dist, targetDist: spin.targetDist, vyaw: spin.vyaw, vpitch: spin.vpitch }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId) env.caf(rafId);
      rafId = 0;
      offVisibility();
      for (const [type, fn] of listeners) canvas.removeEventListener(type, fn);
      for (const l of labelEls) l.el.remove();
      labelEls = [];
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh || o instanceof THREE.Line)) return;
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
      gradient.dispose(); // our clone only; the shared ramp belongs to the planet
      renderer.dispose();
      renderer.forceContextLoss(); // WebGL contexts are a scarce, per-page resource
      canvas.remove();
    },
  };
}
