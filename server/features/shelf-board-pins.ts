// Pure pin and section operations for the Shelf view. Every function returns a new state; the
// feature persists it (shelf-board-store.ts savePins). "Unsorted" always exists and is last.

import type { ShelfBoardItem, ShelfPin, ShelfPinsState } from "../../shared/features/shelf-board.js";
import { cleanSection, isSeedRow, SEED_MAX_ROWS, TITLE_MAX_CHARS, UNSORTED_SECTION } from "../../shared/features/shelf-seed.js";
import { redactSecrets } from "../heuristics.js";
import { classifyUrl, itemIdOf } from "./shelf-board-lib.js";

export const MAX_SECTIONS = 30;
export const MAX_PINS = 1000;

export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = redactSecrets(raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX_CHARS);
  return t || null;
}

/** Unique, cleaned, ≤MAX_SECTIONS, with Unsorted last. */
export function normaliseSections(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const s = cleanSection(raw);
    if (s && s !== UNSORTED_SECTION && !out.includes(s) && out.length < MAX_SECTIONS - 1) out.push(s);
  }
  return [...out, UNSORTED_SECTION];
}

function withSection(state: ShelfPinsState, section: string): string[] {
  return state.sections.includes(section) ? state.sections : normaliseSections([...state.sections.filter((s) => s !== UNSORTED_SECTION), section]);
}

/** The pin an item (or a bare URL) would become; null for a URL the shelf refuses (credentials). */
export function pinFor(target: { item?: ShelfBoardItem; url?: string }, section: string, title: string | null, at: string): ShelfPin | null {
  if (target.item) {
    const i = target.item;
    return { itemId: i.id, section, type: i.type, url: i.url, path: i.path, title: title ?? i.title, pinnedAt: at };
  }
  const c = target.url ? classifyUrl(target.url, { lenient: true }) : null;
  if (!c) return null;
  return { itemId: itemIdOf(c.key), section, type: c.type, url: c.type === "dashable" ? (target.url ?? c.url) : c.url, path: null, title: title ?? c.title, pinnedAt: at };
}

const samePin = (p: ShelfPin, itemId: string, section: string): boolean => p.itemId === itemId && p.section === section;

/** One pin per (item, section), each section known (else Unsorted). Applied to whatever was stored, so
 *  pins saved before an item could sit on several shelves (one per item) load unchanged. */
export function normalisePins(state: ShelfPinsState): ShelfPinsState {
  const sections = normaliseSections(state.sections);
  const pins: ShelfPin[] = [];
  for (const p of state.pins) {
    const section = sections.includes(p.section) ? p.section : UNSORTED_SECTION;
    if (!pins.some((q) => samePin(q, p.itemId, section)) && pins.length < MAX_PINS) pins.push({ ...p, section });
  }
  return { sections, pins };
}

/** Pins an item to `pin.section` (an item can sit on several shelves); already there: refreshes the title. */
export function upsertPin(state: ShelfPinsState, pin: ShelfPin): ShelfPinsState {
  const sections = withSection(state, pin.section);
  const section = sections.includes(pin.section) ? pin.section : UNSORTED_SECTION;
  if (state.pins.some((p) => samePin(p, pin.itemId, section))) {
    return { sections, pins: state.pins.map((p) => (samePin(p, pin.itemId, section) ? { ...p, title: pin.title } : p)) };
  }
  if (state.pins.length >= MAX_PINS) return state;
  return { sections, pins: [...state.pins, { ...pin, section }] };
}

/** Moves the item's pin on `from` to `to` (keeping when it was first pinned); already on `to`: the
 *  `from` copy just goes. Not on `from`: unchanged. */
export function movePin(state: ShelfPinsState, itemId: string, from: string, to: string): ShelfPinsState {
  const prev = state.pins.find((p) => samePin(p, itemId, from));
  if (!prev || from === to) return state;
  const sections = withSection(state, to);
  const section = sections.includes(to) ? to : UNSORTED_SECTION;
  if (state.pins.some((p) => samePin(p, itemId, section))) return { sections, pins: state.pins.filter((p) => p !== prev) };
  return { sections, pins: state.pins.map((p) => (p === prev ? { ...p, section } : p)) };
}

/** Unpins from one shelf (`section`), or from every shelf when `section` is omitted. */
export function removePin(state: ShelfPinsState, itemId: string, section?: string): ShelfPinsState {
  return { sections: state.sections, pins: state.pins.filter((p) => p.itemId !== itemId || (section !== undefined && p.section !== section)) };
}

/** New section list; `renames` (old → new) carries pins along, pins of a dropped section go to Unsorted
 *  (an item that lands twice on one shelf keeps one pin). */
export function setSections(state: ShelfPinsState, list: readonly unknown[], renames: Readonly<Record<string, unknown>> = {}): ShelfPinsState {
  const sections = normaliseSections(list);
  const pins = state.pins.map((p) => {
    const to = cleanSection(renames[p.section]);
    const section = to && sections.includes(to) ? to : p.section;
    return { ...p, section: sections.includes(section) ? section : UNSORTED_SECTION };
  });
  return normalisePins({ sections, pins });
}

export interface SeedResult {
  state: ShelfPinsState;
  added: number;
  skipped: number;
  invalid: number;
}

/** Imports [{section,url,title}] once per (url, section): a URL already on that shelf (same item key)
 *  is skipped, never moved, so a rerun changes nothing; the same URL under two headings lands on both
 *  shelves. Unknown sections are added. */
export function seedPins(state: ShelfPinsState, rows: unknown, at: string): SeedResult | null {
  if (!Array.isArray(rows) || rows.length > SEED_MAX_ROWS) return null;
  let next = state;
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  for (const row of rows) {
    const section = isSeedRow(row) ? cleanSection(row.section) : null;
    const pin = isSeedRow(row) && section ? pinFor({ url: row.url }, section, cleanTitle(row.title), at) : null;
    if (!pin) {
      invalid += 1;
      continue;
    }
    if (next.pins.some((p) => samePin(p, pin.itemId, pin.section))) {
      skipped += 1;
      continue;
    }
    const before = next.pins.length;
    next = upsertPin(next, pin);
    if (next.pins.length > before) added += 1;
    else invalid += 1;
  }
  return { state: next, added, skipped, invalid };
}
