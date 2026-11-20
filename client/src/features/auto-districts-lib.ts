// Sub-districts of the AUTO ("Automated Runs") continent: its home-dir sessions, live and fossil,
// clustered by the automation that started them (shared/display.ts's automationKey), each cluster
// a labelled lot of its own inside the continent. Pure: THREE maths only, no DOM, no scene.
//
// Boot timing: the planet (cities, plateaus, houses) is built once at load from the first
// snapshot, and fossils arrive later. So nothing here feeds that build. The archive feature calls
// computeAutoDistricts once the archive list is in (and again on every new archive summary), then
// moves the already-built live houses into their lot (instance matrices only) and lays the AUTO
// fossils out per lot. Until then the planet looks exactly as before: fail open.
//
// Covered by auto-districts-lib.test.ts.

import * as THREE from "three";
import { automationKey } from "../../../shared/display";
import type { ArchivePlace } from "../../../shared/features/archive";
import type { RunEnding, SubagentRecord } from "../../../shared/features/subagents";
import { LOT_OFFSET, LOT_SPACING, lotLocal, type CityLayout } from "../layout";
import { projectLocal, tangentBasis, toLocal, type ContinentLayout } from "../topic-layout";
import type { FilterOption } from "../shell/views";
import { FOSSIL_AREA, fossilOffset, hash32 } from "./archive-lib";

export const AUTO_GROUP = "AUTO";
/** The archive place every AUTO home-dir fossil sits in (server/features/archive-lib.ts). */
export const AUTO_TOPIC_PLACE = "topic:AUTO";
export const OTHER_AUTOMATIONS = "Other automations";
/** A cluster smaller than this folds into Other automations. */
export const MIN_CLUSTER = 3;
/** At most this many sub-districts, Other automations included; the smallest fold into Other. */
export const MAX_SUBDISTRICTS = 12;
/** Clear ground between a lot and anything else (tangent units). */
export const LOT_GAP = 0.8;
/** Distance kept from the continent border. */
export const BORDER_MARGIN = 0.6;
/** Clear ground kept around a city: its ring road runs at radius + 0.1, its flat plateau reaches radius + 2.4. */
const CITY_CLEARANCE = 1.5;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface AutoItem {
  id: string;
  title: string;
}

export interface AutoCluster {
  key: string;
  /** Live session ids, sorted. */
  live: string[];
  /** Fossil (archived) session ids, sorted. */
  archived: string[];
}

export function clusterSize(c: Pick<AutoCluster, "live" | "archived">): number {
  return c.live.length + c.archived.length;
}

/**
 * Groups sessions by automationKey. Named clusters come first (most sessions first, ties by key),
 * Other automations last. A cluster under `min` sessions, a title with no key, and everything past
 * the `max`-th sub-district fold into Other automations.
 */
export function clusterAutomations(
  live: readonly AutoItem[],
  archived: readonly AutoItem[],
  min = MIN_CLUSTER,
  max = MAX_SUBDISTRICTS,
): AutoCluster[] {
  const byKey = new Map<string, AutoCluster>();
  const add = (it: AutoItem, into: "live" | "archived"): void => {
    const key = automationKey(it.title) ?? OTHER_AUTOMATIONS;
    const c = byKey.get(key) ?? { key, live: [], archived: [] };
    c[into].push(it.id);
    byKey.set(key, c);
  };
  for (const it of live) add(it, "live");
  for (const it of archived) add(it, "archived");
  const other: AutoCluster = byKey.get(OTHER_AUTOMATIONS) ?? { key: OTHER_AUTOMATIONS, live: [], archived: [] };
  byKey.delete(OTHER_AUTOMATIONS);
  const named = [...byKey.values()].sort((a, b) => clusterSize(b) - clusterSize(a) || a.key.localeCompare(b.key));
  let kept = named.filter((c) => clusterSize(c) >= min);
  const needsOther = other.live.length + other.archived.length > 0 || kept.length < named.length;
  if (kept.length + (needsOther ? 1 : 0) > max) kept = kept.slice(0, Math.max(0, max - 1));
  const keptKeys = new Set(kept.map((c) => c.key));
  for (const c of named) {
    if (keptKeys.has(c.key)) continue;
    other.live.push(...c.live);
    other.archived.push(...c.archived);
  }
  const out = kept.map((c) => ({ key: c.key, live: [...c.live].sort(), archived: [...c.archived].sort() }));
  if (other.live.length + other.archived.length > 0) out.push({ key: OTHER_AUTOMATIONS, live: [...other.live].sort(), archived: [...other.archived].sort() });
  return out;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** Where a lot's contents start: live houses on the city lot spiral, fossils in a sunflower outside them. */
export function lotShape(houses: number, fossils: number): { r: number; fossilR0: number } {
  const houseOuter = houses > 0 ? LOT_SPACING * Math.sqrt(houses - 1 + LOT_OFFSET) + 0.5 : 0;
  const fossilR0 = houses > 0 ? houseOuter + 0.35 : 0.4;
  const fossilOuter = fossils > 0 ? Math.sqrt(fossilR0 * fossilR0 + (FOSSIL_AREA / Math.PI) * fossils) + 0.3 : 0;
  return { r: Math.max(1.2, houseOuter, fossilOuter), fossilR0 };
}

/** Lots reserve ground in steps of ×1.25 from 1.5, so a count change inside a step moves nothing. */
export function reservedRadius(r: number): number {
  let q = 1.5;
  while (q < r - 1e-9) q *= 1.25;
  return q;
}

/** A key's home spot in the continent's local plane: a hash-derived point, uniform over the disc of
 *  radius `reach`. Depends on the key alone, never on any count. */
export function keyAnchor(key: string, reach: number): [number, number] {
  const h = hash32(key);
  const u = (h & 0xffff) / 0x10000;
  const a = ((h >>> 16) / 0x10000) * Math.PI * 2;
  const d = Math.sqrt(u) * reach;
  return [Math.cos(a) * d, Math.sin(a) * d];
}

/** First spot on a spiral around (ax, az), within `limit` of the centre, clear of `taken` by
 *  LOT_GAP; else the in-bounds spot with the most clearance. */
function spiralSpot(ax: number, az: number, r: number, limit: number, reach: number, taken: readonly Circle[]): { spot: Circle | null; clear: number } {
  let best: Circle | null = null;
  let bestClear = -Infinity;
  if (limit < 0) return { spot: null, clear: -Infinity };
  for (let k = 0; ; k++) {
    const d = 0.3 * Math.sqrt(k);
    if (d > reach) break;
    const a = k * GOLDEN_ANGLE;
    const x = ax + Math.cos(a) * d;
    const z = az + Math.sin(a) * d;
    if (Math.hypot(x, z) > limit) continue;
    const clear = taken.reduce((m, o) => Math.min(m, Math.hypot(o.x - x, o.z - z) - o.r - r), Infinity);
    if (clear >= LOT_GAP) return { spot: { x, z, r }, clear };
    if (clear > bestClear) {
      bestClear = clear;
      best = { x, z, r };
    }
  }
  return { spot: best, clear: bestClear };
}

/**
 * Places each lot near its key's own anchor (keyAnchor), never by count or rank:
 *   1. its ideal spot: the first spot on a spiral around the anchor clear of the continent's
 *      obstacles (cities, fossil fields) by LOT_GAP, ignoring the other lots;
 *   2. in key order, a lot whose ideal spot collides with an earlier lot slides along a spiral
 *      from there to the next spot clear of both.
 * Each lot claims reservedRadius(r), not r. So a count change moves nothing unless a lot outgrows
 * its step; then it may slide, and only lots it now collides with move too. Everything stays inside
 * `extent − BORDER_MARGIN`; a lot with no clear spot takes the roomiest one and, if even that
 * overlaps, is listed in `crowded`. Returned circles carry the real radius.
 */
export function placeLots(extent: number, obstacles: readonly Circle[], lots: readonly { key: string; r: number }[]): { pos: Map<string, Circle>; crowded: string[] } {
  const pos = new Map<string, Circle>();
  const crowded: string[] = [];
  const taken: Circle[] = [...obstacles];
  const inner = extent - BORDER_MARGIN;
  const order = [...lots].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, r: real } of order) {
    const r = Math.min(reservedRadius(real), Math.max(real, inner));
    const limit = inner - r;
    const [ax, az] = keyAnchor(key, inner);
    const ideal = spiralSpot(ax, az, r, limit, 2 * inner, obstacles).spot ?? { x: 0, z: 0, r };
    const { spot, clear } = spiralSpot(ideal.x, ideal.z, r, limit, 2 * inner, taken);
    const at = spot ?? ideal;
    if (clear < 0) crowded.push(key);
    taken.push(at);
    pos.set(key, { x: at.x, z: at.z, r: real });
  }
  return { pos, crowded };
}

/** Local (x, z) of an archived-only district's fossil field inside its continent (features/archive.ts). */
export function archivedFieldLocal(placeKey: string, continentAngle: number, surface: number): [number, number] {
  const az = (hash32(placeKey) / 0x1_0000_0000) * Math.PI * 2;
  const d = continentAngle * 0.78 * surface;
  return [Math.cos(az) * d, Math.sin(az) * d];
}

export interface AutoLot {
  key: string;
  live: string[];
  archived: string[];
  /** Centre and radius in the continent's local plane. */
  x: number;
  z: number;
  r: number;
  /** The lot as a city frame: houses and fossils sit at local (x, z) around it. */
  frame: CityLayout;
  /** Where the live-house spiral gives way to the fossil ring (lotShape), fixed at whatever this
   *  lot's live/archived counts were the moment it was built — the fossils it was sized for never
   *  move again, so this never grows just because more live houses arrive (see lotHasRoom). */
  fossilR0: number;
}

export interface AutoDistricts {
  lots: AutoLot[];
  /** Session id (live or fossil) → its lot key and lot-local (x, z). */
  slots: Map<string, { key: string; x: number; z: number }>;
  /** Lots that overlap a neighbour because the continent had no free spot for them (see placeLots). */
  crowded: string[];
}

export interface AutoDistrictsInput {
  continent: Pick<ContinentLayout, "key" | "dir" | "t1" | "t2" | "angle" | "units">;
  /** Every continent key in layout order (archive.ts drops a place of an unknown group into the first). */
  continentKeys: readonly string[];
  layout: ReadonlyMap<string, CityLayout>;
  places: readonly ArchivePlace[];
  /** Live AUTO sessions housed in a catch-all (home dir, "/") island. */
  live: readonly AutoItem[];
  /** Fossils in the topic:AUTO place. */
  fossils: readonly AutoItem[];
  surface: number;
}

/** Everything already standing in the continent, as circles in its local plane. */
export function continentObstacles(input: Omit<AutoDistrictsInput, "live" | "fossils">): Circle[] {
  const { continent: c, layout, places, surface } = input;
  const islandFossils = new Map(places.filter((p) => p.kind === "island").map((p) => [p.ref, p.count]));
  const out: Circle[] = [];
  for (const id of c.units) {
    const city = layout.get(id);
    if (!city) continue;
    const [x, z] = toLocal(c.dir, c.t1, c.t2, city.dir);
    const n = islandFossils.get(id) ?? 0;
    const r0 = city.radius + 2.6; // archive.ts's ring() around a city
    const ring = n > 0 ? Math.sqrt(r0 * r0 + (FOSSIL_AREA / Math.PI) * n) + 0.3 : 0;
    out.push({ x, z, r: Math.max(city.radius + CITY_CLEARANCE, ring) });
  }
  const first = input.continentKeys[0];
  for (const p of places) {
    if (p.kind !== "archived") continue;
    const inHere = p.group === c.key || (!input.continentKeys.includes(p.group) && first === c.key);
    if (!inHere) continue;
    const [x, z] = archivedFieldLocal(p.key, c.angle, surface);
    out.push({ x, z, r: Math.sqrt(0.16 + (FOSSIL_AREA / Math.PI) * p.count) + 0.3 });
  }
  return out;
}

export function computeAutoDistricts(input: AutoDistrictsInput): AutoDistricts {
  const { continent: c, surface } = input;
  const clusters = clusterAutomations(input.live, input.fossils);
  const shapes = new Map(clusters.map((cl) => [cl.key, lotShape(cl.live.length, cl.archived.length)]));
  const { pos, crowded } = placeLots(
    c.angle * surface,
    continentObstacles(input),
    clusters.map((cl) => ({ key: cl.key, r: shapes.get(cl.key)!.r })),
  );
  const lots: AutoLot[] = [];
  const slots = new Map<string, { key: string; x: number; z: number }>();
  clusters.forEach((cl, rank) => {
    const p = pos.get(cl.key)!;
    const dir = projectLocal(c.dir, c.t1, c.t2, p.x, p.z);
    const [t1, t2] = tangentBasis(dir);
    const frame: CityLayout = { id: `auto:${cl.key}`, dir, t1, t2, radius: p.r, lots: clusterSize(cl), rank };
    const r0 = shapes.get(cl.key)!.fossilR0;
    lots.push({ key: cl.key, live: cl.live, archived: cl.archived, x: p.x, z: p.z, r: p.r, frame, fossilR0: r0 });
    cl.live.forEach((id, i) => {
      const [x, z] = lotLocal(i);
      slots.set(id, { key: cl.key, x, z });
    });
    const seed = ((hash32(cl.key) % 1000) / 1000) * Math.PI * 2;
    cl.archived.forEach((id, i) => {
      const [x, z] = fossilOffset(i, r0, seed);
      slots.set(id, { key: cl.key, x, z });
    });
  });
  return { lots, slots, crowded };
}

/** A slot's direction on the sphere. */
export function slotDir(lot: Pick<AutoLot, "frame">, x: number, z: number): THREE.Vector3 {
  return projectLocal(lot.frame.dir, lot.frame.t1, lot.frame.t2, x, z);
}

// ── live agents arriving after boot (features/archive.ts's onAgents handler) ───────────────────

export interface AutoSessionAgent {
  id: string;
  islandId: string;
  title: string;
}

/** Clear ground kept between a lot's outermost live house and its (fixed) fossil ring. */
/** Clearance from a live house's CENTRE to the fossil ring: the roof cone's radius (0.5, scene/agents.ts)
 *  plus a small gap, so a house at capacity never overlaps the first fossils. */
export const LOT_LIVE_MARGIN = 0.7;

/** A home-folder session classified into the AUTO continent. When the topics map already has an
 *  answer for this id (computeAuto's boot-time `live` filter uses the same field), that answer
 *  wins. A session the map hasn't reached yet — main.ts reads the map once at boot, and nothing
 *  ever adds a freshly-started session to it (topics.ts's countNew counts them, never inserts them)
 *  — falls back to the same signal a lot's own key comes from: does its title carry a recognizable
 *  automationKey? Only automations write those titles, so a match is as good as the map. */
export function isAutoHomeSession(agent: Pick<AutoSessionAgent, "id" | "islandId" | "title">, catchAll: ReadonlySet<string>, groupOf: (id: string) => string | undefined): boolean {
  if (!catchAll.has(agent.islandId)) return false;
  const group = groupOf(agent.id);
  return group !== undefined ? group === AUTO_GROUP : automationKey(agent.title) !== null;
}

/** Whether a lot can take one more live house without its spiral reaching into its fossil ring.
 *  fossilR0 is frozen at whatever it was when the lot was built (see AutoLot); the fossils
 *  themselves never move, so this must not grow just because more live houses keep arriving. */
export function lotHasRoom(lot: Pick<AutoLot, "live" | "fossilR0">): boolean {
  const [x, z] = lotLocal(lot.live.length);
  return Math.hypot(x, z) <= lot.fossilR0 - LOT_LIVE_MARGIN;
}

/**
 * Which lot a live agent's house should move into when its upsert arrives after boot, the same
 * grouping boot's computeAutoDistricts used — without moving or resizing any lot already placed.
 * Null means "leave the house where it is":
 *   - not a home-folder AUTO session (isAutoHomeSession is false), or
 *   - its house is already in a lot (moved at boot, or by an earlier upsert — no double move), or
 *   - its own lot (or "Other automations", its automationKey has no lot of its own) has no room
 *     left before its fossil ring (lotHasRoom) — the house stays in the home city; a full reload
 *     will resize the lot properly.
 * An automationKey with no lot of its own otherwise falls into "Other automations".
 */
export function planNewAutoLot(
  agent: AutoSessionAgent,
  catchAll: ReadonlySet<string>,
  groupOf: (id: string) => string | undefined,
  districts: Pick<AutoDistricts, "lots" | "slots">,
): string | null {
  if (districts.slots.has(agent.id)) return null;
  if (!isAutoHomeSession(agent, catchAll, groupOf)) return null;
  const key = automationKey(agent.title) ?? OTHER_AUTOMATIONS;
  const named = districts.lots.find((l) => l.key === key);
  if (named && lotHasRoom(named)) return named.key;
  const other = districts.lots.find((l) => l.key === OTHER_AUTOMATIONS);
  if (other && lotHasRoom(other)) return other.key;
  return null;
}

/**
 * Adds a newly-seen live session to an existing lot, at the lot's next open spiral spot (the same
 * per-lot indexing boot used for its live houses) — no lot moves, no spiral recomputed. Returns
 * `districts` unchanged for an unknown lot key, an already-placed agent, or a lot with no room left
 * before its fossil ring (lotHasRoom) — this never places a house where it would overlap a fossil.
 */
export function addLiveToLot(districts: AutoDistricts, lotKey: string, agentId: string): AutoDistricts {
  if (districts.slots.has(agentId)) return districts;
  const at = districts.lots.findIndex((l) => l.key === lotKey);
  if (at < 0) return districts;
  const lot = districts.lots[at]!;
  if (!lotHasRoom(lot)) return districts;
  const live = [...lot.live, agentId];
  const lots = districts.lots.slice();
  lots[at] = { ...lot, live };
  const [x, z] = lotLocal(live.length - 1);
  const slots = new Map(districts.slots);
  slots.set(agentId, { key: lotKey, x, z });
  return { lots, slots, crowded: districts.crowded };
}

// ── what went wrong in a lot (the Automated Runs panel, features/archive.ts) ─────────────────────

export interface LotRunNote {
  status: "failed" | "stopped";
  /** One line, untrusted (a subagent description, the parent's words): escape it. */
  text: string;
}

/**
 * Why each of a lot's sessions didn't end well, from deterministic markers only: its own RunEnding
 * (server endings.ts: an API error, a turn cut off, an interrupt), else its failed subagents
 * (their reason). A run that failed outranks a stop; sessions with nothing to report are absent.
 */
export function lotRunNotes(ids: readonly string[], endings: ReadonlyMap<string, RunEnding>, subagents: Iterable<SubagentRecord>): Map<string, LotRunNote> {
  const wanted = new Set(ids);
  const failedSubs = new Map<string, SubagentRecord[]>();
  for (const r of subagents) {
    if (r.status !== "failed" || !wanted.has(r.parentSessionId)) continue;
    const list = failedSubs.get(r.parentSessionId) ?? [];
    list.push(r);
    failedSubs.set(r.parentSessionId, list);
  }
  const out = new Map<string, LotRunNote>();
  for (const id of ids) {
    const e = endings.get(id);
    const subs = (failedSubs.get(id) ?? []).sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id < b.id ? -1 : 1));
    const first = subs[0];
    if (e?.status === "failed") out.set(id, { status: "failed", text: e.reason });
    else if (first) out.set(id, { status: "failed", text: `${subs.length} subagent${subs.length === 1 ? "" : "s"} failed: ${first.reason ?? first.description}` });
    else if (e) out.set(id, { status: "stopped", text: e.reason });
  }
  return out;
}

/** A lot's live sessions for its panel: failed runs first, then stopped ones, else as given. */
export function orderLotRows(ids: readonly string[], notes: ReadonlyMap<string, LotRunNote>): string[] {
  const rank = (id: string): number => (notes.get(id)?.status === "failed" ? 2 : notes.has(id) ? 1 : 0);
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(b.id) - rank(a.id) || a.i - b.i).map((x) => x.id);
}

/** Districts-sidebar group the sub-district rows sit under, right after the AUTO continent's own. */
export const AUTO_LOTS_GROUP = "AUTO~lots";
export const AUTO_LOT_PREFIX = "autolot:";

export function isAutoLotRow(value: string): boolean {
  return value.startsWith(AUTO_LOT_PREFIX);
}

/** "/daily-recap · 41" — the planet label and the sidebar row say the same. */
export function lotLabel(lot: Pick<AutoLot, "key" | "live" | "archived">): string {
  return `${lot.key} · ${clusterSize(lot)}`;
}

/** One Districts row per sub-district (none before the archive list is in). */
export function autoLotRows(d: AutoDistricts | null): FilterOption[] {
  if (!d) return [];
  return d.lots.map((lot) => {
    const bits = [lot.live.length ? `${lot.live.length} live` : "", lot.archived.length ? `${lot.archived.length} archived` : ""].filter(Boolean).join(" · ");
    return {
      value: `${AUTO_LOT_PREFIX}${lot.key}`,
      label: lot.key === OTHER_AUTOMATIONS ? lot.key : `↳ ${lot.key}`,
      count: clusterSize(lot),
      dot: lot.live.length ? "today" : "asleep",
      meta: bits,
      hint: `${lot.key}: ${bits} home-folder runs of this automation, grouped in their own lot of Automated Runs. Click to list them.`,
      activity: clusterSize(lot),
      group: AUTO_LOTS_GROUP,
    };
  });
}
