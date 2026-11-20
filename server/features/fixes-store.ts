// The Fix queue's own small state, data/fixes.json (temp file + rename): per fix row, a snooze /
// won't fix (the same CheckDismissal shape and rules as Health's, health-dismissals.ts), and the
// session a "Draft a fix" or a Loops ▶ Launch started (its tmux name, then its session id once
// talk's binding adopts it). A health row's dismissal is NOT kept here: it is the check's own
// (health-dismissals.ts), so Health, the Town square and the queue never disagree.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activeDismissal, isCheckDismissal, type CheckDismissal } from "../../shared/features/completeness.js";
import { isFixId } from "../../shared/features/fixes.js";
import { isRecord } from "../http.js";

/** At most this many launches are remembered (oldest dropped): the queue only shows live rows. */
const MAX_LAUNCHES = 500;
const TMUX_NAME_RE = /^aw-[0-9a-f]{4,64}$/;
const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/i;

export interface StoredLaunch {
  at: string;
  tmuxName: string | null;
  sessionId: string | null;
}

export interface FixesFile {
  dismissals: Record<string, CheckDismissal>;
  launches: Record<string, StoredLaunch>;
}

export function fixesPathFor(dbPath: string): string {
  return join(dirname(dbPath), "fixes.json");
}

export function isTmuxName(v: unknown): v is string {
  return typeof v === "string" && TMUX_NAME_RE.test(v);
}

function isStoredLaunch(v: unknown): v is StoredLaunch {
  if (!isRecord(v) || typeof v.at !== "string") return false;
  return (v.tmuxName === null || isTmuxName(v.tmuxName)) && (v.sessionId === null || (typeof v.sessionId === "string" && SESSION_ID_RE.test(v.sessionId)));
}

/** Parses the file; unknown ids and malformed entries are dropped, never fatal. */
export function parseFixesFile(text: string): FixesFile {
  const out: FixesFile = { dismissals: {}, launches: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isRecord(raw)) return out;
  if (isRecord(raw.dismissals)) for (const [id, d] of Object.entries(raw.dismissals)) if (isFixId(id) && isCheckDismissal(d)) out.dismissals[id] = d;
  if (isRecord(raw.launches)) for (const [id, l] of Object.entries(raw.launches)) if (isFixId(id) && isStoredLaunch(l)) out.launches[id] = l;
  return out;
}

export interface FixesStore {
  /** The dismissal in force for `id` at `nowMs`, or null (an expired snooze reads as none). */
  dismissal(id: string, nowMs: number): CheckDismissal | null;
  setDismissal(id: string, d: CheckDismissal): Promise<void>;
  clearDismissal(id: string): Promise<boolean>;
  launch(id: string): StoredLaunch | null;
  recordLaunch(id: string, launch: StoredLaunch): Promise<void>;
  /** Fills in the session id talk's binding adopted for a launch's tmux session. */
  bindSession(id: string, sessionId: string): Promise<void>;
}

const stores = new Map<string, FixesStore>();

/** One store per file, shared by the fixes feature and loops' ▶ Launch, loaded lazily. */
export function fixesStoreFor(path: string): FixesStore {
  const hit = stores.get(path);
  if (hit) return hit;
  let data: FixesFile | null = null;
  const load = (): FixesFile => {
    if (data) return data;
    try {
      data = parseFixesFile(readFileSync(path, "utf8"));
    } catch {
      data = { dismissals: {}, launches: {} }; // no file yet
    }
    return data;
  };
  const save = async (): Promise<void> => {
    const tmp = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(load(), null, 2), "utf8");
    await rename(tmp, path);
  };
  const store: FixesStore = {
    dismissal(id, nowMs) {
      return activeDismissal(load().dismissals[id], nowMs);
    },
    async setDismissal(id, d) {
      load().dismissals[id] = d;
      await save();
    },
    async clearDismissal(id) {
      const cur = load();
      if (!cur.dismissals[id]) return false;
      delete cur.dismissals[id];
      await save();
      return true;
    },
    launch(id) {
      return load().launches[id] ?? null;
    },
    async recordLaunch(id, launch) {
      const cur = load();
      delete cur.launches[id]; // re-insert, so the newest is last and survives the trim
      cur.launches[id] = launch;
      const ids = Object.keys(cur.launches);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_LAUNCHES))) delete cur.launches[old];
      await save();
    },
    async bindSession(id, sessionId) {
      const l = load().launches[id];
      if (!l || l.sessionId === sessionId || !SESSION_ID_RE.test(sessionId)) return;
      l.sessionId = sessionId;
      await save();
    },
  };
  stores.set(path, store);
  return store;
}

/** Test-only: forget the in-memory stores. */
export function resetFixesStoresForTests(): void {
  stores.clear();
}
