// Health's per-check "Snooze 7 days" / "Won't fix": one small store keyed by check id, persisted
// next to the db as data/health-dismissals.json (temp file + rename). A dismissed check is still
// measured and still listed in Health (muted); only the places that PIN a check (Town square via
// the workspace scorer, the Health keeper's Inbox item) leave it out. Undo removes the entry.
// Expired snoozes are dropped on read, so a snooze simply ends without anyone touching it.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  activeDismissal,
  CHECK_META,
  isCheckDismissal,
  type CheckDismissal,
  type CheckDismissals,
  type CompletenessCheck,
  type CompletenessCheckId,
  type DismissalKind,
} from "../../shared/features/completeness.js";
import { isRecord } from "../http.js";

const DAY_MS = 86_400_000;
const MAX_REASON = 300;

export function dismissalsPathFor(dbPath: string): string {
  return join(dirname(dbPath), "health-dismissals.json");
}

export function isCheckId(id: string): id is CompletenessCheckId {
  return Object.prototype.hasOwnProperty.call(CHECK_META, id);
}

/** Parses the file; unknown ids and malformed entries are dropped, never fatal. */
export function parseDismissals(text: string): CheckDismissals {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const out: CheckDismissals = {};
  if (!isRecord(raw)) return out;
  for (const [id, d] of Object.entries(raw)) if (isCheckId(id) && isCheckDismissal(d)) out[id] = d;
  return out;
}

/** The dismissal a POST asks for. Null for a kind that isn't one of the two. */
export function makeDismissal(kind: unknown, nowMs: number, days: unknown, reason: unknown): CheckDismissal | null {
  if (kind !== "snooze" && kind !== "wont-fix") return null;
  const k: DismissalKind = kind;
  const n = typeof days === "number" && Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, MAX_REASON) : null;
  return { kind: k, at: new Date(nowMs).toISOString(), until: k === "snooze" ? new Date(nowMs + n * DAY_MS).toISOString() : null, reason: why };
}

/** Each check with its dismissal in force at `nowMs` attached (and a stale one stripped). */
export function withDismissals(checks: readonly CompletenessCheck[], dismissals: CheckDismissals, nowMs: number): CompletenessCheck[] {
  return checks.map((c) => {
    const d = activeDismissal(dismissals[c.id], nowMs);
    if (d) return { ...c, dismissed: d };
    if (!c.dismissed) return c;
    const { dismissed: _gone, ...rest } = c;
    return rest;
  });
}

type Listener = () => void;

export interface DismissalStore {
  /** Every dismissal still in force. */
  list(nowMs: number): CheckDismissals;
  set(id: CompletenessCheckId, d: CheckDismissal): Promise<void>;
  clear(id: CompletenessCheckId): Promise<boolean>;
  onChange(fn: Listener): () => void;
}

/** One store per file, shared by every feature in this process (completeness writes it, the
 *  Health keeper reads it), loaded lazily and kept in memory. */
const stores = new Map<string, DismissalStore>();

export function dismissalStoreFor(path: string): DismissalStore {
  const hit = stores.get(path);
  if (hit) return hit;
  let data: CheckDismissals | null = null;
  const listeners = new Set<Listener>();
  const load = (): CheckDismissals => {
    if (data) return data;
    try {
      data = parseDismissals(readFileSync(path, "utf8"));
    } catch {
      data = {}; // no file yet
    }
    return data;
  };
  const save = async (): Promise<void> => {
    const tmp = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(load(), null, 2), "utf8");
    await rename(tmp, path);
    for (const fn of listeners) fn();
  };
  const store: DismissalStore = {
    list(nowMs) {
      const out: CheckDismissals = {};
      for (const [id, d] of Object.entries(load())) {
        const live = activeDismissal(d, nowMs);
        if (live && isCheckId(id)) out[id] = live;
      }
      return out;
    },
    async set(id, d) {
      load()[id] = d;
      await save();
    },
    async clear(id) {
      const cur = load();
      if (!cur[id]) return false;
      delete cur[id];
      await save();
      return true;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  stores.set(path, store);
  return store;
}

/** Test-only: forget the in-memory stores. */
export function resetDismissalStoresForTests(): void {
  stores.clear();
}
