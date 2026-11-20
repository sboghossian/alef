// History: the last COUNCIL_HISTORY_LIMIT councils, newest first. Piggybacks on
// WorldDb's existing `meta` key/value table (server/db.ts: "small persisted counters",
// already used by director.ts for its roam cursor) instead of a bespoke file on disk —
// same persistence guarantee, no new file to manage, and no edit to db.ts needed.

import type { CouncilResult } from "../../shared/features/council.js";
import { COUNCIL_HISTORY_LIMIT, parseCouncilRef } from "../../shared/features/council.js";
import type { WorldDb } from "../db.js";

const META_KEY = "council.history";

function isCouncilResult(v: unknown): v is CouncilResult {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" && typeof (v as { at?: unknown }).at === "string";
}

/** A stored `ref` that isn't a valid CouncilRef is dropped, so every reader (the panel, the
 *  census link) can trust the field when it is there. Entries without one pass through as is. */
function withValidRef(r: CouncilResult): CouncilResult {
  if (!("ref" in r)) return r;
  const { ref, ...rest } = r;
  const valid = parseCouncilRef(ref);
  return valid ? { ...rest, ref: valid } : rest;
}

/** Never throws: corrupt/missing stored JSON just reads back as no history. */
export function loadCouncilHistory(db: Pick<WorldDb, "getMeta">): CouncilResult[] {
  const raw = db.getMeta(META_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCouncilResult).map(withValidRef) : [];
  } catch {
    return [];
  }
}

/** Prepends `entry` and caps at COUNCIL_HISTORY_LIMIT. Returns the new list. */
export function pushCouncilHistory(db: Pick<WorldDb, "getMeta" | "setMeta">, entry: CouncilResult): CouncilResult[] {
  const next = [entry, ...loadCouncilHistory(db)].slice(0, COUNCIL_HISTORY_LIMIT);
  db.setMeta(META_KEY, JSON.stringify(next));
  return next;
}
