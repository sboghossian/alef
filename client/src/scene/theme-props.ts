// Theme-specific props and skies. Everything here is built on first use and then kept
// (pooled): switching themes only flips `.visible` and swaps a cached sky texture.
// Rounds 1-10: every sky was bright on purpose. Round 11 adds three new skies for the
// Dark/Horror/Nintendo themes — night and blood are deliberately moodier, toy stays bright —
// see theme.ts's header for the readability rule that still applies to all of them.

import * as THREE from "three";
import { PLANET_R } from "../layout";
import { NO_INK_LAYER } from "./planet";
import { rng } from "./noise";
import { sceneParts } from "./scene-bus";
import { merge, painted, toon } from "./toon";
import type { SkyKind, ThemeSpec } from "./theme";

type Paint = (ctx: CanvasRenderingContext2D, size: number) => void;

function canvasTexture(paint: Paint): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function stars(ctx: CanvasRenderingContext2D, size: number, seed: number, count: number, colors: string[]): void {
  const rand = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const big = rand() < 0.1;
    const r = big ? 3 : 1.1 + rand() * 1.2;
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)] ?? "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (big) {
      ctx.fillRect(x - 8, y - 0.9, 16, 1.8);
      ctx.fillRect(x - 0.9, y - 8, 1.8, 16);
    }
  }
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

const PAINTERS: Record<Exclude<SkyKind, "weather">, Paint> = {
  // Pastel nebula: lavender -> pink -> peach with soft mint/periwinkle clouds and bright stars.
  nebula(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, "#b9a6ff");
    g.addColorStop(0.5, "#f6b3e0");
    g.addColorStop(1, "#ffd3b0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    blob(ctx, size * 0.22, size * 0.3, size * 0.38, "rgba(160,240,220,0.75)");
    blob(ctx, size * 0.8, size * 0.25, size * 0.32, "rgba(170,190,255,0.8)");
    blob(ctx, size * 0.7, size * 0.8, size * 0.36, "rgba(255,240,170,0.7)");
    blob(ctx, size * 0.15, size * 0.85, size * 0.3, "rgba(255,170,220,0.75)");
    stars(ctx, size, 11, 220, ["#ffffff", "#ffffff", "#fff4b0", "#e0f7ff"]);
  },
  // Sea-side sky: bright turquoise to pale horizon, a few soft clouds.
  ocean(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#5cc8ff");
    g.addColorStop(0.65, "#aee9ff");
    g.addColorStop(1, "#e8fbff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const rand = rng(7);
    for (let i = 0; i < 14; i++) blob(ctx, rand() * size, rand() * size * 0.8, 60 + rand() * 90, "rgba(255,255,255,0.7)");
  },
  // Wintry pastel: pale periwinkle with a soft glow and snowflake dots.
  snow(ctx, size) {
    const g = ctx.createRadialGradient(size * 0.5, size * 0.45, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
    g.addColorStop(0, "#eef6ff");
    g.addColorStop(1, "#b8c8f5");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    stars(ctx, size, 13, 260, ["#ffffff", "#ffffff", "#f3f8ff"]);
  },
  // Blueprint paper: bright cyan, fine grid, heavier every 5th line.
  blueprint(ctx, size) {
    ctx.fillStyle = "#3b9be8";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i <= size; i += 16) {
      ctx.fillStyle = i % 80 === 0 ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.13)";
      const w = i % 80 === 0 ? 2 : 1;
      ctx.fillRect(i, 0, w, size);
      ctx.fillRect(0, i, size, w);
    }
  },
  // Dark: a deep-blue night gradient, a pale moon, bright stars. Readable, not murky — the
  // gradient never drops all the way to black.
  night(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#0d1f3d");
    g.addColorStop(0.6, "#1c3f6b");
    g.addColorStop(1, "#3f6f9e");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    blob(ctx, size * 0.78, size * 0.22, size * 0.2, "rgba(223,242,255,0.85)");
    ctx.fillStyle = "#eaf6ff";
    ctx.beginPath();
    ctx.arc(size * 0.78, size * 0.22, size * 0.07, 0, Math.PI * 2);
    ctx.fill();
    stars(ctx, size, 21, 240, ["#ffffff", "#dff2ff", "#bcd4ee"]);
  },
  // Horror: a sickly red-to-green fog, a blood moon with a soft red halo, a low fog bank, and
  // a handful of painted crow silhouettes (cheap: 2D canvas, not geometry — the real bird
  // flock in game-feel/life.ts is untouched). Spooky-fun, not gory: no red beyond the moon.
  blood(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#2a0f16");
    g.addColorStop(0.55, "#5a1f22");
    g.addColorStop(1, "#6f7a3a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const mx = size * 0.72;
    const my = size * 0.24;
    const mr = size * 0.1;
    blob(ctx, mx, my, mr * 1.9, "rgba(200,40,40,0.55)");
    ctx.fillStyle = "#a81c1c";
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();
    const fog = rng(17);
    for (let i = 0; i < 10; i++) blob(ctx, fog() * size, size * (0.75 + fog() * 0.2), 90 + fog() * 120, "rgba(120,140,110,0.3)");
    const crow = rng(29);
    ctx.fillStyle = "rgba(12,8,10,0.75)";
    for (let i = 0; i < 5; i++) {
      const cx = crow() * size;
      const cy = size * (0.15 + crow() * 0.3);
      const s = 9 + crow() * 7;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.quadraticCurveTo(cx, cy - s * 0.6, cx + s * 0.1, cy);
      ctx.quadraticCurveTo(cx + s * 0.2, cy - s * 0.6, cx + s * 1.1, cy);
      ctx.fill();
    }
  },
  // Nintendo-style: a bright candy-cyan-to-yellow sky, puffy toy clouds, and a red/white
  // checker band low on the horizon (a toy racetrack cue).
  toy(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#3ec6ff");
    g.addColorStop(0.7, "#8fe6ff");
    g.addColorStop(1, "#fff2b0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    blob(ctx, size * 0.5, size * 0.18, size * 0.42, "rgba(255,255,255,0.5)");
    const puff = rng(41);
    for (let i = 0; i < 9; i++) blob(ctx, puff() * size, size * (0.15 + puff() * 0.35), 60 + puff() * 70, "rgba(255,255,255,0.85)");
    const bandY = size * 0.86;
    const cell = size / 24;
    for (let x = 0; x < size; x += cell) {
      ctx.fillStyle = Math.floor(x / cell) % 2 === 0 ? "#ffffff" : "#ff4d6d";
      ctx.fillRect(x, bandY, cell, size * 0.05);
    }
  },
};

const skies = new Map<SkyKind, THREE.CanvasTexture>();

/** The theme's sky, or null for "weather" (leave the live weather sky alone). Cached. */
export function skyTexture(kind: SkyKind): THREE.CanvasTexture | null {
  if (kind === "weather") return null;
  let tex = skies.get(kind);
  if (!tex) {
    tex = canvasTexture(PAINTERS[kind]);
    skies.set(kind, tex);
  }
  return tex;
}

/** True for any texture this module made (so the theme feature can tell its sky from the weather's). */
export function isThemeSky(t: unknown): boolean {
  return t instanceof THREE.Texture && [...skies.values()].includes(t as THREE.CanvasTexture);
}

export const SUN_RADIUS = PLANET_R * 0.42;
const DOME_R = PLANET_R * 1.55;

function glowShell(radius: number, color: number, power: number, strength: number, side: THREE.Side): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(vN, vV));
  gl_FragColor = vec4(uColor * pow(f, ${power.toFixed(1)}) * ${strength.toFixed(2)}, 1.0);
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 40), mat);
  mesh.layers.set(NO_INK_LAYER);
  return mesh;
}

/** One bare, leafless tree (Horror). A trunk plus three crooked branches, single draw call. */
function deadTreeGeometry(): THREE.BufferGeometry {
  const trunk = painted(new THREE.CylinderGeometry(0.06, 0.1, 0.55, 5).translate(0, 0.27, 0), 0x2a1f1c);
  const b1 = painted(new THREE.CylinderGeometry(0.02, 0.04, 0.5, 4).rotateZ(0.9).translate(0.18, 0.62, 0), 0x1e1614);
  const b2 = painted(new THREE.CylinderGeometry(0.02, 0.04, 0.42, 4).rotateZ(-1.0).translate(-0.16, 0.7, 0.05), 0x1e1614);
  const b3 = painted(new THREE.CylinderGeometry(0.015, 0.03, 0.34, 4).rotateX(0.6).translate(0.02, 0.86, -0.14), 0x1e1614);
  return merge([trunk, b1, b2, b3]);
}

/** Bounds a candidate ground height to "past the beach, short of the snow line" — the same
 *  band buildTrees() (planet.ts) scatters the normal forest in, read back through the
 *  public groundHeight() handle instead of the private elevation function. */
function isForestHeight(h: number): boolean {
  return h > 0.25 && h < 3.4;
}

export interface ThemeProps {
  /** The Space theme's sun (pickable: "The sun · Harness"). */
  sun(): THREE.Object3D;
  apply(theme: ThemeSpec): void;
  update(dt: number, elapsed: number): void;
}

const DEAD_TREE_MAX = 110;

/** Sun (Space), glass dome + base (Snow globe), snowfall (Snow globe), dead trees (Horror).
 *  Built lazily, then pooled. */
export function createThemeProps(scene: THREE.Scene): ThemeProps {
  let sun: THREE.Group | null = null;
  let dome: THREE.Group | null = null;
  let snow: THREE.Points | null = null;
  let snowTime: { value: number } | null = null;
  let deadTrees: THREE.InstancedMesh | null = null;
  let deadTreesPopulated = false;

  const buildSun = (): THREE.Group => {
    const g = new THREE.Group();
    g.name = "theme-sun";
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(SUN_RADIUS, 4), toon(0xffd84a));
    body.name = "sun-body";
    const rays = new THREE.Mesh(
      new THREE.TorusGeometry(SUN_RADIUS * 1.12, 0.9, 6, 48),
      toon(0xffb347),
    );
    rays.name = "sun-ring";
    rays.rotation.x = Math.PI / 2.6;
    g.add(body, rays, glowShell(SUN_RADIUS * 1.45, 0xfff0a0, 1.6, 0.9, THREE.BackSide));
    scene.add(g);
    return g;
  };

  const buildDome = (): THREE.Group => {
    const g = new THREE.Group();
    g.name = "theme-dome";
    const glass = glowShell(DOME_R, 0xdff6ff, 3.0, 0.8, THREE.FrontSide);
    // A soft specular streak so it reads as glass.
    const streak = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_R * 1.001, 32, 16, -0.9, 0.35, 0.5, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.FrontSide }),
    );
    streak.layers.set(NO_INK_LAYER);
    const baseY = -DOME_R * 0.9;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(DOME_R * 0.5, DOME_R * 0.62, DOME_R * 0.3, 40).translate(0, baseY - DOME_R * 0.12, 0), toon(0xc98b5a));
    const band = new THREE.Mesh(new THREE.TorusGeometry(DOME_R * 0.47, 1.4, 10, 48).rotateX(Math.PI / 2).translate(0, baseY + 0.8, 0), toon(0xffd166));
    base.name = "globe-base";
    band.name = "globe-band";
    g.add(glass, streak, base, band);
    scene.add(g);
    return g;
  };

  const buildSnow = (): THREE.Points => {
    const count = 2400;
    const rand = rng(31);
    const dir = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const y = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      dir.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
      seed[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(dir, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    snowTime = { value: 0 };
    // GPU-animated: each flake falls radially from the dome toward the ground and loops.
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: snowTime, uInner: { value: PLANET_R + 1 }, uOuter: { value: DOME_R * 0.97 } },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uInner; uniform float uOuter;
varying float vA;
void main() {
  float t = fract(uTime * (0.03 + aSeed * 0.025) + aSeed * 7.13);
  float r = mix(uOuter, uInner, t);
  vec3 side = normalize(cross(position, vec3(0.0, 1.0, 0.0)) + 1e-4);
  vec3 p = normalize(position) * r + side * sin(uTime * 0.8 + aSeed * 40.0) * 0.8;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (2.0 + aSeed * 3.0) * (260.0 / -mv.z);
  vA = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.9, 1.0, t));
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  vec3 c = mix(vec3(1.0), vec3(0.62, 0.74, 0.95), smoothstep(0.32, 0.5, d));
  gl_FragColor = vec4(c, vA);
}`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.layers.set(NO_INK_LAYER);
    pts.name = "theme-snowfall";
    scene.add(pts);
    return pts;
  };

  const buildDeadTrees = (): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(deadTreeGeometry(), toon(0xffffff, { vertexColors: true }), DEAD_TREE_MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = "theme-dead-trees";
    scene.add(mesh);
    return mesh;
  };

  /** Scatters instances over the real terrain (planet.groundHeight, an existing scene-bus
   *  handle) so trees sit on the ground instead of floating or burying — no new WebGL context,
   *  no touch to planet.ts. Retried from update() until the planet exists. */
  const populateDeadTrees = (mesh: THREE.InstancedMesh): void => {
    const planet = sceneParts().planet;
    if (!planet) return;
    const rand = rng(53);
    const up = new THREE.Vector3(0, 1, 0);
    const d = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const twist = new THREE.Quaternion();
    const tint = new THREE.Color();
    let n = 0;
    for (let tries = 0; tries < 6000 && n < DEAD_TREE_MAX; tries++) {
      const y = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      d.set(Math.cos(th) * r, y, Math.sin(th) * r);
      const h = planet.groundHeight(d);
      if (!isForestHeight(h)) continue;
      const s = 1.1 + rand() * 1.3;
      q.setFromUnitVectors(up, d);
      twist.setFromAxisAngle(up, rand() * Math.PI * 2);
      q.multiply(twist);
      const m = new THREE.Matrix4().compose(d.clone().multiplyScalar(PLANET_R + h - 0.05), q, new THREE.Vector3(s, s, s));
      mesh.setMatrixAt(n, m);
      tint.setHSL(0.08, 0.15, 0.14 + rand() * 0.08);
      mesh.setColorAt(n, tint);
      n++;
    }
    if (n === 0) return; // planet not laid out yet on this attempt; update() will retry
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    deadTreesPopulated = true;
  };

  return {
    sun() {
      sun ??= buildSun();
      return sun;
    },
    apply(theme) {
      if (theme.props.sun || sun) (sun ??= buildSun()).visible = theme.props.sun;
      if (theme.props.dome || dome) (dome ??= buildDome()).visible = theme.props.dome;
      if (theme.props.snowfall || snow) (snow ??= buildSnow()).visible = theme.props.snowfall;
      if (theme.props.deadTrees || deadTrees) {
        deadTrees ??= buildDeadTrees();
        deadTrees.visible = theme.props.deadTrees;
        if (theme.props.deadTrees && !deadTreesPopulated) populateDeadTrees(deadTrees);
      }
    },
    update(dt, elapsed) {
      if (deadTrees?.visible && !deadTreesPopulated) populateDeadTrees(deadTrees);
      if (sun?.visible) {
        sun.rotation.y += dt * 0.05;
        const s = 1 + Math.sin(elapsed * 1.3) * 0.015;
        sun.scale.setScalar(s);
      }
      if (snow?.visible && snowTime) snowTime.value = elapsed;
    },
  };
}
