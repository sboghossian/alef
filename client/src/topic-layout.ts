// Round 11 B: topic continents. Instead of one Fibonacci point per folder city, every city is a
// neighbourhood packed inside its topic continent (server/features/topics.ts decides which), and
// continents are big non-overlapping regions sized by what they hold. Catch-all folders (home
// dir, "/") hold sessions of every topic, so their houses are split: the folder's own city sits
// in its majority continent and every other topic gets a small neighbourhood `<island>~<GROUP>`
// in that topic's continent. Everything is deterministic (sorted inputs, no randomness), so a
// reload with the same data lands every city in the same place.
//
// Output is the same `Map<string, CityLayout>` computeCityLayout returns (plus the extra
// neighbourhood ids), so every per-island lookup — houses, towers, crowns, dispatch cars,
// flyToCity, applyDistrictMergesToLayout — keeps working unchanged.

import * as THREE from "three";
import type { Island, WorldAgent } from "../../shared/types";
import type { TopicGroup, TopicsMap } from "../../shared/features/topics";
import { CITY_SURFACE, FRONT_DIR, cityRadiusForLots, fibonacciSphere, type CityLayout } from "./layout";

/** Clear ground between two neighbourhoods' ring roads (tangent units). */
export const CITY_GAP = 1.8;
/** Coast between a continent's outermost neighbourhood and its border. */
export const CONTINENT_MARGIN = 2;
/** Minimum empty arc between two continents' borders (radians). */
export const CONTINENT_GAP = 0.12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Projection safety: equidistant mapping shrinks sideways distances by ≤ sin(θ)/θ. */
const PACK_SAFETY = 1.06;

export interface ContinentLayout {
  key: string;
  name: string;
  color: string;
  sessions: number;
  /** Folder cities (real islands) inside, including catch-all ones whose majority is here. */
  cities: string[];
  /** Every layout id inside (cities + catch-all neighbourhoods). */
  units: string[];
  dir: THREE.Vector3;
  /** Angular radius of the region (radians). */
  angle: number;
  t1: THREE.Vector3;
  t2: THREE.Vector3;
}

export interface TopicLayout {
  layout: Map<string, CityLayout>;
  continents: ContinentLayout[];
  /** Layout id → continent key (islands and neighbourhoods). */
  continentOf: Map<string, string>;
  /** Where an agent's house stands: its island, or its topic's neighbourhood for catch-all islands. */
  homeKey(agent: Pick<WorldAgent, "id" | "islandId">): string;
}

export function tangentBasis(dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const ref = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(t1, dir).normalize();
  return [t1, t2];
}

/** Azimuthal-equidistant: local (x, z) around `centre` → unit direction on the sphere. */
export function projectLocal(centre: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3, x: number, z: number): THREE.Vector3 {
  const d = Math.hypot(x, z);
  if (d < 1e-9) return centre.clone();
  const theta = d / CITY_SURFACE;
  const tangent = t1.clone().multiplyScalar(x / d).addScaledVector(t2, z / d);
  return centre.clone().multiplyScalar(Math.cos(theta)).addScaledVector(tangent, Math.sin(theta)).normalize();
}

/** Inverse of projectLocal: a direction on the sphere → local (x, z) around `centre`. */
export function toLocal(centre: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3, dir: THREE.Vector3): [number, number] {
  const d = centre.angleTo(dir) * CITY_SURFACE;
  const x = dir.dot(t1);
  const z = dir.dot(t2);
  const s = Math.hypot(x, z);
  return s < 1e-12 ? [0, 0] : [(x / s) * d, (z / s) * d];
}

interface Unit {
  id: string;
  lots: number;
  radius: number;
}

/** Packs circles around (0,0): biggest first, each on the first free spot of a spiral. */
export function packCircles(units: readonly Unit[]): { pos: Map<string, [number, number]>; extent: number } {
  const pos = new Map<string, [number, number]>();
  const placed: { x: number; z: number; r: number }[] = [];
  const sorted = [...units].sort((a, b) => b.radius - a.radius || a.id.localeCompare(b.id));
  for (const u of sorted) {
    const r = (u.radius + CITY_GAP / 2) * PACK_SAFETY;
    let spot: [number, number] = [0, 0];
    for (let k = 0; k < 20000; k++) {
      const d = 0.5 * Math.sqrt(k);
      const a = k * GOLDEN_ANGLE;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (placed.every((p) => Math.hypot(p.x - x, p.z - z) >= p.r + r)) {
        spot = [x, z];
        break;
      }
    }
    placed.push({ x: spot[0], z: spot[1], r });
    pos.set(u.id, spot);
  }
  const extent = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.z) + p.r), 0);
  return { pos, extent };
}

/** Pushes caps apart until no two overlap (plus CONTINENT_GAP). Index 0 stays pinned. Deterministic. */
export function relaxCaps(dirs: THREE.Vector3[], angles: readonly number[], iterations = 2000): void {
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        const a = dirs[i]!;
        const b = dirs[j]!;
        const need = angles[i]! + angles[j]! + CONTINENT_GAP;
        const have = a.angleTo(b);
        if (have >= need) continue;
        moved = true;
        axis.crossVectors(a, b);
        if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0).cross(a).normalize();
        else axis.normalize();
        const push = (need - have) / 2 + 1e-4;
        // Bigger caps move less; the pinned first cap never moves.
        const wi = i === 0 ? 0 : angles[j]! / (angles[i]! + angles[j]!);
        const wj = i === 0 ? 1 : angles[i]! / (angles[i]! + angles[j]!);
        const total = push * 2;
        // Rotating about a×b: a negative angle moves `a` away from `b`, a positive one moves `b` away from `a`.
        if (wi > 0) a.applyQuaternion(q.setFromAxisAngle(axis, -total * wi)).normalize();
        b.applyQuaternion(q.setFromAxisAngle(axis, total * wj)).normalize();
      }
    }
    if (!moved) return;
  }
}

/** Continent order: the server's (most sessions first); unknown keys after, alphabetically. */
function orderedGroups(topics: TopicsMap, used: ReadonlySet<string>): TopicGroup[] {
  const known = topics.groups.filter((g) => used.has(g.key));
  const extra = [...used].filter((k) => !topics.groups.some((g) => g.key === k)).sort();
  return [...known, ...extra.map((key) => ({ key, name: key, hint: "", color: "#c4a676", sessions: 0, cities: 0 }))];
}

export function computeTopicLayout(
  islands: readonly Island[],
  lotsPerIsland: ReadonlyMap<string, number>,
  topics: TopicsMap,
  agents: readonly Pick<WorldAgent, "id" | "islandId" | "lastActive">[],
): TopicLayout {
  const catchAll = new Set(topics.catchAll);
  const fallback = topics.groups[topics.groups.length - 1]?.key ?? "OTHER";
  const groupOfIsland = (id: string): string => topics.islands[id] ?? fallback;

  // Per catch-all island: agents per topic (the majority topic stays in the island's own city).
  const splitCounts = new Map<string, Map<string, number>>();
  const agentHome = new Map<string, string>();
  for (const a of [...agents].sort((x, y) => x.id.localeCompare(y.id))) {
    if (!catchAll.has(a.islandId)) continue;
    const g = topics.sessions[a.id]?.group ?? groupOfIsland(a.islandId);
    if (g === groupOfIsland(a.islandId)) continue;
    const m = splitCounts.get(a.islandId) ?? new Map<string, number>();
    m.set(g, (m.get(g) ?? 0) + 1);
    splitCounts.set(a.islandId, m);
    agentHome.set(a.id, `${a.islandId}~${g}`);
  }

  const unitsByGroup = new Map<string, Unit[]>();
  const citiesByGroup = new Map<string, string[]>();
  const continentOf = new Map<string, string>();
  const add = (group: string, id: string, lots: number): void => {
    const list = unitsByGroup.get(group) ?? [];
    list.push({ id, lots, radius: cityRadiusForLots(lots) });
    unitsByGroup.set(group, list);
    continentOf.set(id, group);
  };
  for (const i of [...islands].sort((a, b) => a.id.localeCompare(b.id))) {
    const g = groupOfIsland(i.id);
    const moved = [...(splitCounts.get(i.id)?.values() ?? [])].reduce((s, n) => s + n, 0);
    add(g, i.id, Math.max(0, (lotsPerIsland.get(i.id) ?? 0) - moved));
    citiesByGroup.set(g, [...(citiesByGroup.get(g) ?? []), i.id]);
    for (const [sg, n] of [...(splitCounts.get(i.id)?.entries() ?? [])].sort((a, b) => a[0].localeCompare(b[0]))) add(sg, `${i.id}~${sg}`, n);
  }

  const groups = orderedGroups(topics, new Set(unitsByGroup.keys()));
  const packs = groups.map((g) => packCircles(unitsByGroup.get(g.key) ?? []));
  const angles = packs.map((p) => (p.extent + CONTINENT_MARGIN) / CITY_SURFACE);

  // Seed on a Fibonacci lattice rotated so the biggest continent faces the camera, then relax.
  const seeds = fibonacciSphere(Math.max(groups.length, 2));
  seeds.sort((a, b) => b.dot(FRONT_DIR) - a.dot(FRONT_DIR));
  const q = new THREE.Quaternion().setFromUnitVectors(seeds[0]!, FRONT_DIR);
  const dirs = seeds.slice(0, groups.length).map((p) => p.clone().applyQuaternion(q).normalize());
  relaxCaps(dirs, angles);

  // Ranks keep their old meaning: 0 = most recently active island.
  const recency = [...islands].sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive) || a.id.localeCompare(b.id));
  const rankOf = new Map(recency.map((i, r) => [i.id, r]));

  const layout = new Map<string, CityLayout>();
  const continents: ContinentLayout[] = [];
  groups.forEach((g, gi) => {
    const dir = dirs[gi]!;
    const [t1, t2] = tangentBasis(dir);
    const pack = packs[gi]!;
    const units = unitsByGroup.get(g.key) ?? [];
    for (const u of units) {
      const [x, z] = pack.pos.get(u.id) ?? [0, 0];
      const cdir = projectLocal(dir, t1, t2, x, z);
      const [c1, c2] = tangentBasis(cdir);
      layout.set(u.id, { id: u.id, dir: cdir, t1: c1, t2: c2, radius: u.radius, lots: u.lots, rank: rankOf.get(u.id) ?? islands.length + layout.size });
    }
    continents.push({
      key: g.key,
      name: g.name,
      color: g.color,
      sessions: g.sessions,
      cities: (citiesByGroup.get(g.key) ?? []).slice(),
      units: units.map((u) => u.id),
      dir: dir.clone(),
      angle: angles[gi]!,
      t1,
      t2,
    });
  });

  return {
    layout,
    continents,
    continentOf,
    homeKey: (agent) => agentHome.get(agent.id) ?? agent.islandId,
  };
}
