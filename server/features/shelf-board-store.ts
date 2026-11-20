// The Shelf view's persisted state in world.db's meta table (no schema change), with its OWN read
// cursor per transcript (never the indexer's, never the artifacts scanner's). Data-migration rule:
// world.db is backed up (WAL-safe) to `world.db.pre-shelf-board-<ISO>.bak` before the first write;
// items and cursors are written together in ONE transaction with the done flag last, so a crash
// re-reads exactly the lines whose mentions were not stored and a rerun converges. Pins live in
// their own key, written alone (they never depend on the cursors).

import { basename, dirname, join } from "node:path";
import { shelfScore, strongerSource, type ShelfPin, type ShelfPinsState, type ShelfSource } from "../../shared/features/shelf-board.js";
import { DEFAULT_SHELF_SECTIONS } from "../../shared/features/shelf-seed.js";
import type { WorldDb } from "../db.js";
import { itemIdOf, type Mention } from "./shelf-board-lib.js";
import { normalisePins } from "./shelf-board-pins.js";

export const META_STATE = "shelf_board_v1_items";
export const META_CURSORS = "shelf_board_v1_cursors";
export const META_DONE = "shelf_board_v1_backfill_done";
export const META_BACKUP = "shelf_board_v1_backup";
export const META_PINS = "shelf_board_v1_pins";

export const MAX_ITEMS = 5000;
const MAX_SESSIONS = 8;

export interface StoredItem {
  id: string;
  key: string;
  type: Mention["type"];
  url: string | null;
  path: string | null;
  title: string;
  kind: string;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  sessions: string[];
  source: ShelfSource;
  typed: boolean;
  /** Paths only: null until lstat'ed. A path found missing is removed. */
  onDisk?: boolean | null;
}

export interface BoardState {
  items: Record<string, StoredItem>;
}

/** Folds one line's mentions in (a key is counted once per line). */
export function applyMentions(state: BoardState, mentions: readonly Mention[], sessionId: string, at: string | null): void {
  for (const m of mentions) {
    const id = itemIdOf(m.key);
    let it = state.items[id];
    if (!it) {
      it = { id, key: m.key, type: m.type, url: m.url, path: m.path, title: m.title, kind: m.kind, firstSeen: at, lastSeen: at, count: 0, sessions: [], source: m.source, typed: false };
      if (m.path) it.onDisk = null;
      state.items[id] = it;
    }
    it.count += 1;
    it.source = strongerSource(it.source, m.source);
    if (m.source === "user") it.typed = true;
    if (at && (!it.firstSeen || at < it.firstSeen)) it.firstSeen = at;
    if (at && (!it.lastSeen || at > it.lastSeen)) it.lastSeen = at;
    if (it.sessions[0] !== sessionId) it.sessions = [sessionId, ...it.sessions.filter((s) => s !== sessionId)].slice(0, MAX_SESSIONS);
  }
}

/** Over MAX_ITEMS: drops fetch-only items first, then plain links and files (the bulk), then the
 *  lowest scores; GitHub, Linear, dashable and folder items are the last to go. */
export function pruneItems(state: BoardState, nowMs: number, max = MAX_ITEMS): number {
  const all = Object.values(state.items);
  if (all.length <= max) return 0;
  const tier = (i: StoredItem): number => (i.source === "fetch" ? 0 : i.type === "link" || i.type === "file" ? 1 : 2);
  const key = new Map(all.map((i) => [i.id, tier(i) * 1000 + shelfScore(i, nowMs)])); // scores once, not per compare
  const order = all.sort((a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0));
  const drop = order.slice(0, all.length - max);
  for (const it of drop) delete state.items[it.id];
  return drop.length;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isPin = (v: unknown): v is ShelfPin => isObj(v) && typeof v.itemId === "string" && typeof v.section === "string" && typeof v.type === "string";

export const defaultPins = (): ShelfPinsState => ({ sections: [...DEFAULT_SHELF_SECTIONS], pins: [] });

export class ShelfBoardStore {
  state: BoardState = { items: {} };
  cursors = new Map<string, number>();
  pins: ShelfPinsState = defaultPins();
  done = false;
  rev = 0;
  private backupChecked = false;

  constructor(private readonly db: WorldDb) {}

  load(): void {
    const state = parseJson(this.db.getMeta(META_STATE));
    const cursors = parseJson(this.db.getMeta(META_CURSORS));
    if (isObj(state) && isObj(state.items) && isObj(cursors)) {
      this.state = state as unknown as BoardState;
      this.cursors = new Map(Object.entries(cursors).filter((e): e is [string, number] => typeof e[1] === "number"));
    } else {
      this.state = { items: {} };
      this.cursors = new Map();
    }
    const pins = parseJson(this.db.getMeta(META_PINS));
    // normalisePins: one pin per (item, section); pins stored one-per-item load as they were.
    this.pins = isObj(pins) && Array.isArray(pins.sections) && Array.isArray(pins.pins) ? normalisePins({ sections: pins.sections, pins: pins.pins.filter(isPin) }) : defaultPins();
    this.done = this.db.getMeta(META_DONE) === "1";
    this.rev += 1;
  }

  /** Backs world.db up once, before the first write. False = the backup failed: write nothing. */
  async ensureBackup(now: Date = new Date()): Promise<boolean> {
    if (this.backupChecked) return true;
    const file = this.db.filePath();
    if (file && file !== ":memory:" && this.db.getMeta(META_BACKUP) === null) {
      const dest = join(dirname(file), `${basename(file)}.pre-shelf-board-${now.toISOString().replace(/:/g, "-")}.bak`);
      try {
        await this.db.backupTo(dest);
      } catch {
        return false;
      }
      this.db.setMeta(META_BACKUP, dest);
    }
    this.backupChecked = true;
    return true;
  }

  /** Items + cursors in one transaction; the done flag (when `markDone`) is the last write in it. */
  commit(markDone: boolean): void {
    const cursors = Object.fromEntries(this.cursors);
    this.db.transaction(() => {
      this.db.setMeta(META_STATE, JSON.stringify(this.state));
      this.db.setMeta(META_CURSORS, JSON.stringify(cursors));
      if (markDone) this.db.setMeta(META_DONE, "1");
    });
    if (markDone) this.done = true;
    this.rev += 1;
  }

  savePins(next: ShelfPinsState): void {
    this.db.setMeta(META_PINS, JSON.stringify(next));
    this.pins = next;
    this.rev += 1;
  }
}
