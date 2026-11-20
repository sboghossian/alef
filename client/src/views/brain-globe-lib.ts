// Pure logic for the 🧠 Brain view's 3D globe mode: every note sits on a sphere of radius R, each
// top-level folder owns a cap-shaped region (centroids spread on a Fibonacci sphere, cap area
// weighted by folder size, then relaxed apart), notes are jittered inside their cap by a hash of
// their path (the same vault always lands the same way). A dominant folder is split into
// sub-groups (its sub-folders, or half-years from dated note names, whichever is more even), each
// a sub-patch with its own hue from the folder's colour family. Also: the link cap, great-circle
// arcs, the spin/inertia physics, "turn the globe to face this point", node tones and the lit set
// for hover/filter dimming, label placement, and the remembered 2D/3D choice.
// DOM-free and THREE-free; tested in brain-globe-lib.test.ts.

import type { BrainNode } from "../../../shared/features/brain";
import { filterGraph, folderColor, nodeRadius, rng, type Graph, type GraphFilter } from "./brain-lib";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Globe radius in world units. Nodes sit exactly on it; links arc just above it. */
export const GLOBE_R = 100;
/** Link cap. The real slice (limit 1500) has ~11.7k links: drawing them all makes a hairy ball, so
 *  the globe draws the strongest 2,500 (each node's strongest link first, then the strongest
 *  others). Hovering or opening a note still draws ALL of its links. */
export const MAX_GLOBE_LINKS = 2_500;
/** Straight pieces per arc: 2.5k links × 8 × 2 vertices = 40k line vertices, one draw call. */
export const ARC_SEGMENTS = 8;
/** Share of the sphere the folder caps cover together: the rest is breathing room between
 *  clusters, so the globe reads as clusters of ideas rather than an evenly dotted ball. */
const FILL = 0.6;
const MIN_CAP = 0.1; // rad (~6°): a 1-note folder is still a visible patch
const MAX_CAP = 2.5; // rad

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0, z: 1 };
}
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(dot(unit(a), unit(b)), -1, 1));
}

/** FNV-1a, 32-bit: a stable seed per note path. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** n unit vectors spread evenly over the sphere (golden-angle spiral). */
export function fibonacciSphere(n: number): Vec3[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    return { x: Math.cos(i * GOLDEN) * r, y, z: Math.sin(i * GOLDEN) * r };
  });
}

export interface Region {
  centre: Vec3; // unit vector
  radius: number; // cap angular radius (rad)
}

/**
 * One cap per folder. Folders sorted biggest first take Fibonacci-sphere slots; each cap covers a
 * share of the sphere proportional to its note count; a few relaxation passes push overlapping
 * caps apart (the lighter folder moves more), so big folders get room and small ones still show.
 */
export function folderRegions(counts: ReadonlyMap<string, number>): Map<string, Region> {
  const list = [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = list.reduce((s, [, n]) => s + n, 0);
  const pts = fibonacciSphere(list.length);
  const radii = list.map(([, n]) => clamp(Math.acos(Math.max(-1, 1 - 2 * FILL * (n / total))), MIN_CAP, MAX_CAP));
  for (let pass = 0; pass < 80; pass++) {
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const [p, q] = [pts[i] as Vec3, pts[j] as Vec3];
        const gap = (radii[i] ?? 0) + (radii[j] ?? 0) - angleBetween(p, q);
        if (gap <= 0) continue;
        const wi = (list[j]?.[1] ?? 1) / ((list[i]?.[1] ?? 1) + (list[j]?.[1] ?? 1));
        pts[i] = pushAway(p, q, gap * 0.2 * wi);
        pts[j] = pushAway(q, p, gap * 0.2 * (1 - wi));
      }
  }
  return new Map(list.map(([f], i) => [f, { centre: pts[i] as Vec3, radius: radii[i] as number }]));
}

/** Move unit vector p by `step` rad along the great circle away from q. */
function pushAway(p: Vec3, q: Vec3, step: number): Vec3 {
  const away = add(p, scale(q, -1));
  const tangent = add(away, scale(p, -dot(p, away)));
  if (Math.hypot(tangent.x, tangent.y, tangent.z) < 1e-9) return p;
  return unit(add(p, scale(unit(tangent), step)));
}

/** Point at angular distance `phi` from centre c, azimuth `psi`, on the unit sphere. */
function offset(c: Vec3, phi: number, psi: number): Vec3 {
  const e1 = unit(cross(c, Math.abs(c.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }));
  const e2 = cross(c, e1);
  const side = add(scale(e1, Math.cos(psi)), scale(e2, Math.sin(psi)));
  return unit(add(scale(c, Math.cos(phi)), scale(side, Math.sin(phi))));
}

// ---------------------------------------------------------------- sub-groups + colours

/** A folder big enough to be split into coloured sub-groups on the globe (and in its legend). */
export interface GlobeSplit {
  folder: string;
  by: "sub-folder" | "half-year";
  /** In drawing order (half-years oldest first); "other" merges the small rest. */
  groups: Array<{ key: string; color: string; count: number }>;
}

const SPLIT_SHARE = 0.2; // a folder holding ≥ 20% of the notes gets split
const MAX_GROUPS = 6;

/** "2025 H2" from the first YYYY-MM in the path (dated session notes), else null. */
export function halfYear(path: string): string | null {
  const m = /(?:^|\/)(\d{4})-(\d{2})/.exec(path);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]} H${month <= 6 ? 1 : 2}` : null;
}

function subFolder(path: string): string {
  const seg = path.split("/");
  return seg.length > 2 ? (seg[1] ?? "") : "";
}

/**
 * Which folders to split, and how: the candidate (sub-folder, or half-year when ≥ 80% of the
 * folder's notes are dated) whose biggest bucket is the smallest share wins, if that share is
 * ≤ 80% (a split where one bucket is 95% adds no colour). Up to 6 groups; the rest are "other".
 */
export function planSplits(nodes: readonly BrainNode[]): Map<string, GlobeSplit> {
  const byFolder = new Map<string, BrainNode[]>();
  for (const n of nodes) {
    const list = byFolder.get(n.folder);
    if (list) list.push(n);
    else byFolder.set(n.folder, [n]);
  }
  const out = new Map<string, GlobeSplit>();
  for (const [folder, list] of byFolder) {
    if (list.length < 20 || list.length / nodes.length < SPLIT_SHARE) continue;
    const dated = list.filter((n) => halfYear(n.path) !== null).length / list.length >= 0.8;
    const candidates: Array<{ by: GlobeSplit["by"]; key: (n: BrainNode) => string }> = [{ by: "sub-folder", key: (n) => subFolder(n.path) }];
    if (dated) candidates.push({ by: "half-year", key: (n) => halfYear(n.path) ?? "undated" });
    let best: { split: GlobeSplit; top: number } | null = null;
    for (const c of candidates) {
      const counts = new Map<string, number>();
      for (const n of list) counts.set(c.key(n), (counts.get(c.key(n)) ?? 0) + 1);
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const top = (ranked[0]?.[1] ?? 0) / list.length;
      if (ranked.length < 2 || top > 0.8 || (best && best.top <= top)) continue;
      const kept = ranked.slice(0, ranked.length > MAX_GROUPS ? MAX_GROUPS - 1 : MAX_GROUPS);
      if (c.by === "half-year") kept.sort((a, b) => a[0].localeCompare(b[0]));
      const rest = list.length - kept.reduce((s, [, n]) => s + n, 0);
      const keys = [...kept.map(([k, n]) => ({ key: k, count: n })), ...(rest > 0 ? [{ key: "other", count: rest }] : [])];
      const colors = familyColors(folderColor(folder), keys.length);
      best = { top, split: { folder, by: c.by, groups: keys.map((g, i) => ({ ...g, color: colors[i] ?? folderColor(folder) })) } };
    }
    if (best) out.set(folder, best.split);
  }
  return out;
}

/** The sub-group a note falls in ("other" when its bucket was merged), or null if not split. */
export function groupOf(n: BrainNode, split: GlobeSplit | undefined): string | null {
  if (!split) return null;
  const raw = split.by === "half-year" ? (halfYear(n.path) ?? "undated") : subFolder(n.path);
  return split.groups.some((g) => g.key === raw) ? raw : "other";
}

function hexToHsl(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255).toString(16).padStart(2, "0");
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** n bright, distinct hues from one family: a ±35° hue ramp around `base`, lightness alternating. */
export function familyColors(base: string, n: number): string[] {
  if (n <= 1) return [base].slice(0, Math.max(0, n));
  const [h, s, l] = hexToHsl(base);
  return Array.from({ length: n }, (_, i) => hslToHex((h + (i / (n - 1) - 0.5) * 70 + 360) % 360, clamp(s, 0.7, 1), clamp(l + (i % 2 ? 0.1 : -0.05), 0.4, 0.72)));
}

// ---------------------------------------------------------------- layout

export interface GlobeLayout {
  pos: Map<number, Vec3>; // node id → point at radius r
  regions: Map<string, Region>;
  /** Display colour per node: its sub-group's hue in a split folder, else its folder colour. */
  color: Map<number, string>;
  splits: GlobeSplit[];
}

/** Deterministic: same nodes → same globe, whatever their order. */
export function globeLayout(nodes: readonly BrainNode[], r = GLOBE_R): GlobeLayout {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
  const regions = folderRegions(counts);
  const splits = planSplits(nodes);
  // a split folder's sub-groups get sunflower-placed sub-caps inside its cap, sized by count
  const sub = new Map<string, { reg: Region; color: string }>();
  for (const [folder, sp] of splits) {
    const reg = regions.get(folder);
    if (!reg) continue;
    const total = sp.groups.reduce((s, g) => s + g.count, 0);
    sp.groups.forEach((g, i) => {
      const centre = offset(reg.centre, reg.radius * 0.72 * Math.sqrt((i + 0.5) / sp.groups.length), i * GOLDEN);
      sub.set(`${folder}\u0000${g.key}`, { reg: { centre, radius: Math.max(MIN_CAP, reg.radius * Math.sqrt(g.count / total) * 0.62) }, color: g.color });
    });
  }
  const pos = new Map<number, Vec3>();
  const color = new Map<number, string>();
  for (const n of nodes) {
    const g = groupOf(n, splits.get(n.folder));
    const s = g !== null ? sub.get(`${n.folder}\u0000${g}`) : undefined;
    const reg = s?.reg ?? regions.get(n.folder);
    if (!reg) continue;
    const rand = rng(hash32(n.path));
    // cos φ uniform over the cap = area-uniform; the 1.3 power packs notes a bit towards the middle.
    const phi = Math.acos(1 - Math.pow(rand(), 1.3) * (1 - Math.cos(reg.radius)));
    pos.set(n.id, scale(offset(reg.centre, phi, rand() * Math.PI * 2), r));
    color.set(n.id, s?.color ?? folderColor(n.folder));
  }
  return { pos, regions, color, splits: [...splits.values()] };
}

/** Bead radius on the globe: leaves small, hubs pop (nodeRadius's log scale, stretched). */
export function globeNodeSize(degree: number): number {
  const t = (nodeRadius(degree) - 3) / 19; // 0 (no links) … 1 (the biggest hubs)
  return 0.45 + 2.9 * Math.pow(clamp(t, 0, 1), 1.6);
}

/**
 * The documented link cap: under `max`, every link. Over it, pass 1 walks links strongest first
 * (by the endpoints' vault degree) and keeps any that reaches a node not yet covered, so with
 * max ≥ nodes - 1 no note loses all its lines; pass 2 fills the budget with the strongest of the
 * rest. Deterministic.
 */
export function capLinks<E extends readonly [number, number]>(edges: readonly E[], degree: ReadonlyMap<number, number>, max = MAX_GLOBE_LINKS): E[] {
  if (edges.length <= max) return edges.slice();
  const w = (e: E): number => (degree.get(e[0]) ?? 0) + (degree.get(e[1]) ?? 0);
  const order = edges.map((_, i) => i).sort((a, b) => w(edges[b] as E) - w(edges[a] as E) || a - b);
  const keep = new Uint8Array(edges.length);
  const covered = new Set<number>();
  let n = 0;
  for (const i of order) {
    const [a, b] = edges[i] as E;
    if (n >= max || (covered.has(a) && covered.has(b))) continue;
    keep[i] = 1;
    n++;
    covered.add(a).add(b);
  }
  for (const i of order) {
    if (n >= max) break;
    if (!keep[i]) {
      keep[i] = 1;
      n++;
    }
  }
  return edges.filter((_, i) => keep[i] === 1);
}

/** A great-circle arc from a to b (both at radius r), hugging the surface: lifted a little, more for long links. */
export function arcPoints(a: Vec3, b: Vec3, r = GLOBE_R, segments = ARC_SEGMENTS): Vec3[] {
  const ua = unit(a);
  let ub = unit(b);
  if (angleBetween(ua, ub) > Math.PI - 1e-3) ub = unit(add(ub, scale(offset(ub, Math.PI / 2, 0), 0.01))); // antipodes: pick a side
  const om = angleBetween(ua, ub);
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = om < 1e-6 ? ua : add(scale(ua, Math.sin((1 - t) * om) / Math.sin(om)), scale(ub, Math.sin(t * om) / Math.sin(om)));
    out.push(scale(unit(p), r * (1 + (0.015 + 0.03 * (om / Math.PI)) * Math.sin(Math.PI * t))));
  }
  return out;
}

// ---------------------------------------------------------------- rotation + spin

/** The globe's rotation is Rx(pitch)·Ry(yaw) (three's Euler "XYZ"). Where does p end up? */
export function rotateYawPitch(p: Vec3, yaw: number, pitch: number): Vec3 {
  const x = Math.cos(yaw) * p.x + Math.sin(yaw) * p.z;
  const z1 = -Math.sin(yaw) * p.x + Math.cos(yaw) * p.z;
  return { x, y: Math.cos(pitch) * p.y - Math.sin(pitch) * z1, z: Math.sin(pitch) * p.y + Math.cos(pitch) * z1 };
}

/** Yaw/pitch that bring point p to the front (+z, facing a camera on the +z axis). */
export function faceAngles(p: Vec3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(-p.x, p.z), pitch: Math.atan2(p.y, Math.hypot(p.x, p.z)) };
}

/** The node nearest the middle of the view (the one facing the camera most squarely). */
export function frontMost(pos: ReadonlyMap<number, Vec3>, yaw: number, pitch: number): number | null {
  let best: number | null = null;
  let bestZ = -Infinity;
  for (const [id, p] of pos) {
    const z = rotateYawPitch(unit(p), yaw, pitch).z;
    if (z > bestZ) [best, bestZ] = [id, z];
  }
  return best;
}

export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/** Camera distance that fits the whole globe (plus a margin for the halo) in a viewport of this aspect. */
export function fitDistance(fovDeg: number, aspect: number, r = GLOBE_R): number {
  const v = (fovDeg * Math.PI) / 360;
  const hz = Math.atan(Math.tan(v) * Math.max(0.1, aspect));
  return (r * 1.28) / Math.sin(Math.min(v, hz));
}

export interface Spin {
  yaw: number;
  pitch: number;
  vyaw: number; // rad/s
  vpitch: number;
  dist: number;
  targetDist: number;
  face: { yaw: number; pitch: number } | null;
  idle: number; // seconds since the last touch
}

export const PITCH_LIMIT = 1.45;
export const AUTO_SPIN = 0.07; // rad/s, slow
const AUTO_DELAY = 2.5; // s idle before the auto-rotate resumes
const KEY_STEP = 0.2; // rad per arrow press

export function spinAt(dist: number): Spin {
  return { yaw: 0.5, pitch: 0.3, vyaw: 0, vpitch: 0, dist, targetDist: dist, face: null, idle: 0 };
}

const clampPitch = (p: number): number => clamp(p, -PITCH_LIMIT, PITCH_LIMIT);

/** Turn so p faces the camera: eased, or at once (`snap`, for reduced motion). Pitch is clamped
 *  like a drag, so the turn always ends. */
export function faceSpin(s: Spin, p: Vec3, snap = false): Spin {
  const f = faceAngles(p);
  const target = { yaw: f.yaw, pitch: clampPitch(f.pitch) };
  return snap ? { ...s, ...target, face: null, vyaw: 0, vpitch: 0, idle: 0 } : { ...s, face: target, vyaw: 0, vpitch: 0, idle: 0 };
}

/** Arrow keys turn the globe a step (from where a running turn is heading, so presses add up). */
export function keySpin(s: Spin, key: string, snap = false): Spin | null {
  const d = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[key];
  if (!d) return null;
  const from = s.face ?? s;
  const target = { yaw: wrapAngle(from.yaw + (d[0] ?? 0)), pitch: clampPitch(from.pitch + (d[1] ?? 0)) };
  return snap ? { ...s, ...target, face: null, vyaw: 0, vpitch: 0, idle: 0 } : { ...s, face: target, vyaw: 0, vpitch: 0, idle: 0 };
}

/** Dragging by (dx, dy) px over dt s: rotate now, and remember the velocity for the inertia. */
export function dragSpin(s: Spin, dx: number, dy: number, dt: number, radPerPx: number): Spin {
  const k = 1 / Math.max(dt, 1 / 120);
  const blend = (v: number, nv: number): number => v * 0.3 + nv * 0.7;
  return {
    ...s,
    yaw: wrapAngle(s.yaw + dx * radPerPx),
    pitch: clampPitch(s.pitch + dy * radPerPx),
    vyaw: blend(s.vyaw, dx * radPerPx * k),
    vpitch: blend(s.vpitch, dy * radPerPx * k),
    face: null,
    idle: 0,
  };
}

/**
 * One frame: ease towards a face target, else coast with friction, else slow auto-rotate.
 * `drag` holds the globe and keeps the velocity (the fling on release); `hover` holds it and
 * drops the velocity, so a hovered globe comes to rest and an old fling never resumes.
 */
export function stepSpin(s: Spin, dt: number, o: { drag: boolean; hover: boolean; auto: boolean }): Spin {
  let { yaw, pitch, vyaw, vpitch, face } = s;
  const hold = o.drag || o.hover;
  if (face) {
    const k = 1 - Math.exp(-dt * 6);
    const dy = wrapAngle(face.yaw - yaw);
    const dp = face.pitch - pitch;
    yaw += dy * k;
    pitch += dp * k;
    vyaw = vpitch = 0;
    if (Math.abs(dy) < 1e-3 && Math.abs(dp) < 1e-3) face = null;
  } else if (o.hover && !o.drag) {
    vyaw = vpitch = 0;
  } else if (!hold) {
    yaw += vyaw * dt;
    pitch += vpitch * dt;
    const f = Math.exp(-dt * 3);
    vyaw = Math.abs(vyaw * f) < 1e-3 ? 0 : vyaw * f;
    vpitch = Math.abs(vpitch * f) < 1e-3 ? 0 : vpitch * f;
  }
  const idle = hold || face ? 0 : s.idle + dt;
  if (o.auto && !face && !hold && idle > AUTO_DELAY && Math.abs(vyaw) < AUTO_SPIN) yaw += AUTO_SPIN * dt;
  const dist = s.dist + (s.targetDist - s.dist) * (1 - Math.exp(-dt * 8));
  return { yaw: wrapAngle(yaw), pitch: clampPitch(pitch), vyaw, vpitch, dist, targetDist: s.targetDist, face, idle };
}

/** False = nothing will change without input (lets the frame loop sleep). */
export function spinMoving(s: Spin, auto: boolean): boolean {
  return auto || s.face !== null || s.vyaw !== 0 || s.vpitch !== 0 || Math.abs(s.targetDist - s.dist) > 0.05;
}

// ---------------------------------------------------------------- tones + the lit set

export type Tone = "focus" | "near" | "base" | "dim";

/** focus = hovered (else the open note); near = its neighbours; dim = outside the focus, or
 *  filtered out by the search / folder filters (`lit`; null = no filter active). */
export function toneOf(id: number, focus: number | null, near: ReadonlySet<number> | undefined, lit: ReadonlySet<number> | null): Tone {
  if (focus !== null) return id === focus ? "focus" : near?.has(id) ? "near" : "dim";
  return lit === null || lit.has(id) ? "base" : "dim";
}

/**
 * The notes the globe keeps lit: the folder / legend / memory / project filters (the same
 * `filterGraph` as the 2D graph, but BEFORE its unlinked-note prune: the globe shows every note),
 * narrowed by the search hits when a search is on. null = nothing filtered, all lit. A project
 * filter with no agent selected arrives as `project: null` and filters nothing.
 */
export function litIds(g: Graph, f: GraphFilter, hits: ReadonlySet<number> | null): Set<number> | null {
  const filtering = f.folders.length > 0 || (f.groups?.length ?? 0) > 0 || f.memoryOnly || f.project !== null;
  if (!filtering && hits === null) return null;
  const base = filtering ? filterGraph(g, f).nodes : g.nodes;
  return new Set(base.filter((n) => hits === null || hits.has(n.id)).map((n) => n.id));
}

// ---------------------------------------------------------------- labels

export interface LabelBox {
  x: number; // centre, px
  y: number;
  w: number;
  h: number;
}

/** Greedy, in priority order: keep each label where it is, else nudge it down/up a line or two,
 *  else hide it. Visible labels never overlap. */
export function layoutLabels(items: readonly LabelBox[], gap = 4): Array<{ x: number; y: number; visible: boolean }> {
  const placed: LabelBox[] = [];
  const hit = (b: LabelBox): boolean => placed.some((p) => Math.abs(p.x - b.x) * 2 < p.w + b.w + gap && Math.abs(p.y - b.y) * 2 < p.h + b.h + gap);
  return items.map((it) => {
    for (const k of [0, 1, -1, 2, -2]) {
      const b = { ...it, y: it.y + k * (it.h + gap) };
      if (!hit(b)) {
        placed.push(b);
        return { x: b.x, y: b.y, visible: true };
      }
    }
    return { x: it.x, y: it.y, visible: false };
  });
}

// ---------------------------------------------------------------- the 2D / 3D choice

export type GraphMode = "2d" | "3d";
/** v2: the default flipped to the globe, so a "2d" saved while 2D was the default is never read. */
export const GRAPH_MODE_KEY = "alef.brain.graph.v2";
export const LEGACY_GRAPH_MODE_KEY = "alef.brain.graph";

/** The globe is the default: only an explicit "2d" under the current key means 2D. Storage may be
 *  missing or throw (private mode, blocked site data): then the globe is tried, never a throw. */
export function readGraphMode(storage: () => Pick<Storage, "getItem"> | null): GraphMode {
  try {
    return storage()?.getItem(GRAPH_MODE_KEY) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

/** Drops the pre-v2 key once (it is never read). Best effort. */
export function dropLegacyGraphMode(storage: () => Pick<Storage, "removeItem"> | null): void {
  try {
    storage()?.removeItem(LEGACY_GRAPH_MODE_KEY);
  } catch {
    /* blocked storage: nothing to clean */
  }
}

export function writeGraphMode(storage: () => Pick<Storage, "setItem"> | null, mode: GraphMode): boolean {
  try {
    const s = storage();
    s?.setItem(GRAPH_MODE_KEY, mode);
    return s !== null;
  } catch {
    return false;
  }
}

/** After trying to show `want` (a click, or restoring the saved choice on mount): what the view
 *  shows and what gets saved. "3d" is saved only once the globe really opened; a failed open
 *  saves "2d", so a browser without WebGL doesn't retry (and toast) on every load. */
export function settleGraphMode(want: GraphMode, opened: boolean): { mode: GraphMode; save: GraphMode } {
  const mode = want === "3d" && opened ? "3d" : "2d";
  return { mode, save: mode };
}
