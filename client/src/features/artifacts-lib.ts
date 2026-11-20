// Where the artifact boards go, and how the Museum groups them. Pure: numbers only, no THREE, no DOM.
//
// Placement: every artifact is a framed board hung on the landmark tower of the district whose
// session published it (newest at the bottom row), and every artifact is hung again on the Museum
// island's tower. A tower is an 8-sided cylinder (scene/cities.ts: radius 1.05 at the foot, 0.85 at
// the top, height towerHeight), so each row holds one board per face. Boards stay within
// BOARD_REACH of the tower axis, well inside the first lot ring (lotLocal(0) sits LOT_SPACING·2 =
// 1.9 out), so they can never touch a file building or a house, however full the city is.
// What doesn't fit on a tower is still in the Museum gallery (the modal lists everything).

import type { ArtifactItem } from "../../../shared/features/artifacts";
import { artifactAt, artifactMonth, byArtifactAt, MUSEUM_ISLAND_ID } from "../../../shared/features/artifacts";

export const TOWER_FOOT_R = 1.05;
export const TOWER_TOP_R = 0.85;
export const FACES = 8;
export const BOARD_W = 0.46;
export const BOARD_H = 0.34;
export const BOARD_D = 0.05;
/** Gap between a face and the board's back. */
const STANDOFF = 0.02;
const ROW_START = 0.5;
const ROW_STEP = 0.5;
/** Keep the top row this far under the tower's top (the crown sits there). */
const TOP_MARGIN = 0.15;
/** Farthest any part of a board reaches from the tower axis (tangent units). */
export const BOARD_REACH = Math.hypot(TOWER_FOOT_R * Math.cos(Math.PI / FACES) + STANDOFF + BOARD_D, BOARD_W / 2);

export interface BoardSlot {
  /** Local (x, z) of the board centre in its city, y above the plateau, yaw facing outward. */
  x: number;
  z: number;
  y: number;
  yaw: number;
}

/** Board slots on a tower of height `h`: rows from the bottom up, one per face per row. */
export function towerSlots(h: number): BoardSlot[] {
  const out: BoardSlot[] = [];
  for (let y = ROW_START; y + BOARD_H / 2 <= h - TOP_MARGIN; y += ROW_STEP) {
    const r = TOWER_FOOT_R - (TOWER_FOOT_R - TOWER_TOP_R) * Math.min(1, y / Math.max(h, 1e-6));
    const d = r * Math.cos(Math.PI / FACES) + STANDOFF + BOARD_D / 2;
    for (let f = 0; f < FACES; f++) {
      const yaw = ((f + 0.5) * 2 * Math.PI) / FACES;
      out.push({ x: d * Math.sin(yaw), z: d * Math.cos(yaw), y, yaw });
    }
  }
  return out;
}

export interface PlacedBoard {
  item: ArtifactItem;
  cityId: string;
  slot: BoardSlot;
  /** Hung in the Museum (the mirror), not in its own district. */
  museum: boolean;
}

export interface BoardPlanInput {
  items: readonly ArtifactItem[];
  /** Cities with a tower drawn right now (laid out and holding at least one house), museum included. */
  hasTower(cityId: string): boolean;
  towerHeight(cityId: string): number;
}

const newestFirst = byArtifactAt;

/** One board per artifact on its district's tower, plus one per artifact on the Museum's, newest
 *  first, each tower up to its slot count. */
export function planBoards(input: BoardPlanInput): PlacedBoard[] {
  const sorted = [...input.items].sort(newestFirst);
  const byCity = new Map<string, ArtifactItem[]>();
  for (const item of sorted) {
    const city = item.islandId;
    if (!city || city === MUSEUM_ISLAND_ID || !input.hasTower(city)) continue;
    byCity.set(city, [...(byCity.get(city) ?? []), item]);
  }
  if (input.hasTower(MUSEUM_ISLAND_ID)) byCity.set(MUSEUM_ISLAND_ID, sorted);
  const out: PlacedBoard[] = [];
  for (const [cityId, list] of byCity) {
    const slots = towerSlots(input.towerHeight(cityId));
    list.slice(0, slots.length).forEach((item, i) => out.push({ item, cityId, slot: slots[i]!, museum: cityId === MUSEUM_ISLAND_ID }));
  }
  return out;
}

export interface MonthGroup {
  month: string; // "2026-10" or "undated"
  label: string; // "October 2026"
  items: ArtifactItem[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : "Undated";
}

/** The Museum's rooms: one per month, newest month first, newest artifact first inside. */
export function groupByMonth(items: readonly ArtifactItem[]): MonthGroup[] {
  const groups = new Map<string, ArtifactItem[]>();
  for (const item of [...items].sort(newestFirst)) {
    const month = artifactMonth(artifactAt(item));
    groups.set(month, [...(groups.get(month) ?? []), item]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "undated" ? 1 : b[0] === "undated" ? -1 : b[0].localeCompare(a[0])))
    .map(([month, list]) => ({ month, label: monthLabel(month), items: list }));
}

/** What a board, a row or the modal calls an artifact. In ?redact=1 mode never its title. */
export function artifactLabel(item: Pick<ArtifactItem, "title" | "origin" | "lastAt" | "firstAt">, redact: boolean): string {
  if (redact || !item.title) return `Artifact · ${monthLabel(artifactMonth(artifactAt(item)))}`;
  return item.title;
}

/** A stable frame colour per month, so a tower's rows read as bands of one month. */
export const FRAME_COLORS = [0xff4d8d, 0x2ec4b6, 0xffc300, 0x7b61ff, 0xff7a3d, 0x3aa0ff];
export function frameColor(month: string): number {
  let h = 0;
  for (const c of month) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FRAME_COLORS[h % FRAME_COLORS.length] ?? 0xff4d8d;
}
