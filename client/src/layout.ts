import * as THREE from "three";
import type { Island } from "../../shared/types";

/** Sea-level radius of the planet. Everything else is scaled from this. */
export const PLANET_R = 50;
/** City plateaus sit this high above sea level. */
export const CITY_H = 0.9;
export const CITY_SURFACE = PLANET_R + CITY_H;
/** Spacing between building lots inside a city (tangent units). */
export const LOT_SPACING = 0.95;
/** First lot index used (keeps the centre free for the landmark tower). */
export const LOT_OFFSET = 4;
/** Where the initial camera looks from; the most recent city faces it. */
export const FRONT_DIR = new THREE.Vector3(0.18, 0.32, 1).normalize();

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface CityLayout {
  id: string;
  /** Unit vector from planet centre to city centre. */
  dir: THREE.Vector3;
  /** Tangent basis at the city centre (t1 x dir = t2 convention: X, up, Z). */
  t1: THREE.Vector3;
  t2: THREE.Vector3;
  /** Radius of the built-up area in tangent units (ring road runs just outside). */
  radius: number;
  lots: number;
  rank: number; // 0 = most recently active
}

/** N points spread evenly over a unit sphere (Fibonacci lattice). */
export function fibonacciSphere(n: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = i * GOLDEN_ANGLE;
    pts.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return pts;
}

export function cityRadiusForLots(lots: number): number {
  return Math.max(2.6, LOT_SPACING * Math.sqrt(lots + LOT_OFFSET) + 0.9);
}

/** Local (x, z) of lot `i` inside a city: a phyllotaxis spiral around the tower. */
export function lotLocal(i: number): [number, number] {
  const k = i + LOT_OFFSET;
  const r = LOT_SPACING * Math.sqrt(k);
  const a = k * GOLDEN_ANGLE;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function tangentBasis(dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const ref = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(t1, dir).normalize();
  return [t1, t2];
}

/**
 * Places one city per island on a Fibonacci sphere. The most recently active
 * island takes the lattice point that faces the initial camera, the Harness
 * capital takes the next one, then everything else by recency outward.
 * `lotsPerIsland` = how many buildings/houses the city must hold.
 */
export function computeCityLayout(islands: Island[], lotsPerIsland: Map<string, number>): Map<string, CityLayout> {
  const layout = new Map<string, CityLayout>();
  if (islands.length === 0) return layout;

  const byRecency = islands
    .filter((i) => i.id !== "harness")
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  const harness = islands.find((i) => i.id === "harness");
  const ordered = harness ? [...byRecency.slice(0, 1), harness, ...byRecency.slice(1)] : byRecency;

  const points = fibonacciSphere(Math.max(ordered.length, 12));
  // Rotate the lattice so its first point lands exactly on FRONT_DIR.
  points.sort((a, b) => b.dot(FRONT_DIR) - a.dot(FRONT_DIR));
  const first = points[0];
  if (first) {
    const q = new THREE.Quaternion().setFromUnitVectors(first, FRONT_DIR);
    for (const p of points) p.applyQuaternion(q);
    points.sort((a, b) => b.dot(FRONT_DIR) - a.dot(FRONT_DIR));
  }

  ordered.forEach((island, rank) => {
    const dir = points[rank];
    if (!dir) return;
    const lots = lotsPerIsland.get(island.id) ?? 0;
    const [t1, t2] = tangentBasis(dir);
    layout.set(island.id, { id: island.id, dir: dir.clone(), t1, t2, radius: cityRadiusForLots(lots), lots, rank });
  });
  return layout;
}

const tmpDir = new THREE.Vector3();
const tmpX = new THREE.Vector3();
const tmpZ = new THREE.Vector3();

/** World position of local (x, z) in a city, `y` above the city plateau. */
export function cityPoint(city: CityLayout, x: number, z: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  tmpDir
    .copy(city.dir)
    .multiplyScalar(CITY_SURFACE)
    .addScaledVector(city.t1, x)
    .addScaledVector(city.t2, z)
    .normalize();
  return out.copy(tmpDir).multiplyScalar(CITY_SURFACE + y);
}

/** Model matrix for something standing on a city lot: base at plateau+y, up = radial. */
export function cityMatrix(
  city: CityLayout,
  x: number,
  z: number,
  y: number,
  yaw: number,
  scale: THREE.Vector3,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  const pos = cityPoint(city, x, z, y);
  const up = tmpDir.copy(pos).normalize();
  tmpX.copy(city.t1).addScaledVector(up, -up.dot(city.t1)).normalize();
  tmpZ.crossVectors(tmpX, up);
  // Yaw around the local up axis.
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ax = tmpX.clone().multiplyScalar(c).addScaledVector(tmpZ, -s);
  const az = tmpX.clone().multiplyScalar(s).addScaledVector(tmpZ, c);
  out.makeBasis(ax, up, az);
  out.scale(scale);
  out.setPosition(pos);
  return out;
}

/** Orientation matrix for something at `pos` travelling along `forward` with up = radial. */
export function surfaceFrame(pos: THREE.Vector3, forward: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const up = tmpDir.copy(pos).normalize();
  tmpZ.copy(forward).addScaledVector(up, -up.dot(forward)).normalize();
  tmpX.crossVectors(up, tmpZ).normalize();
  out.makeBasis(tmpX, up, tmpZ);
  out.setPosition(pos);
  return out;
}

/** Minimal shape district merges need for layout aliasing (the full persisted record —
 *  `sessions`/`why`/`approvedAt` — lives in shared/features/president.ts; layout only cares
 *  about which island ids now share one footprint). */
export interface LayoutDistrictMerge {
  districts: readonly string[];
  into: string;
}

/**
 * Round 10: Jev-proposed, Alex-approved district merges are display-only — no session's
 * home island ever changes, no file moves. This is the smallest change that makes "merged
 * districts render as one city": it aliases every merged-away island id onto its target's
 * exact `CityLayout` (same `dir`/`t1`/`t2`/`radius`), in place, so every existing per-island
 * lookup that already runs off `layout` (agent house placement, `buildCities`' tower/crown
 * color, dispatch car flight) keeps resolving for every original id unchanged, while the
 * merged city visually sits exactly where its target does. A merge whose `into` isn't laid
 * out (an unknown/stale id), or a `districts` entry that already equals `into`, is skipped —
 * never throws. Mutates and returns the same map.
 */
export function applyDistrictMergesToLayout(layout: Map<string, CityLayout>, merges: readonly LayoutDistrictMerge[]): Map<string, CityLayout> {
  for (const merge of merges) {
    const target = layout.get(merge.into);
    if (!target) continue;
    for (const id of merge.districts) {
      if (id === merge.into) continue;
      layout.set(id, target);
    }
  }
  return layout;
}
