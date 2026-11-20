// One-time historical catch-up for the "usage" feature. The shared indexer's own startup
// pass (server/index.ts's `runIndexPass` before the tick timers start) never forwards
// lines to features, so onIndexPass only ever sees lines appended AFTER this feature's
// store was first opened — "today" and a Replay day query for an earlier date would
// otherwise read zero. This walks every session jsonl once, applying the same pure
// reducer as the live path, but only to lines strictly OLDER than `cutoffMs` (the moment
// this feature's store was first opened, which is always at or after that startup pass —
// see usage.ts). Everything from `cutoffMs` on is onIndexPass's job, so the two paths
// never double-count the same line. Runs in the background, one file's turn to yield at a
// time, and stops for good once every file has reached its cutoff line. Transcript
// content is untrusted data: read and parsed only, never executed.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { addTokens, reduceLine, type SessionCursor, type TokenBucket } from "../../shared/features/usage.js";
import { yieldToLoop } from "./cache-lib.js";
import { parseUsageLine } from "./usage-parse.js";
import type { UsageStore } from "./usage-store.js";

async function jsonlFiles(projectsDir: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const perDir = await Promise.all(
    projectDirs.map(async (dir) => {
      const full = join(projectsDir, dir);
      try {
        return (await readdir(full)).filter((f) => f.endsWith(".jsonl")).map((f) => join(full, f));
      } catch {
        return [];
      }
    }),
  );
  return perDir.flat();
}

function localDateKeyFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Cursor-table key for a session's backfill cursor, kept apart from the live cursor. */
export function backfillCursorKey(sessionId: string): string {
  return `backfill:${sessionId}`;
}

export interface BackfillDeps {
  store: UsageStore;
  projectsDir: string;
  cutoffMs: number;
  /** Resolves a cwd to an island (city) id. Same lookup the live path uses. */
  getIslandForCwd: (cwd: string) => string | null;
  /** "full" (default): tokens, time and usage_hour. "hour": usage_hour only, with its own offsets,
   *  cursors and done flag: the v2 -> v3 catch-up for a store that kept its older rows. */
  mode?: "full" | "hour";
  /** Full mode: false leaves usage_hour to the "hour" pass (set when that pass owns the history). */
  hours?: boolean;
}

/** Offset-table key, cursor-table key and done flag of one backfill mode. */
function keysFor(mode: "full" | "hour"): { offset: (path: string) => string; cursor: (sessionId: string) => string; done: string } {
  return mode === "hour"
    ? { offset: (p) => `hour:${p}`, cursor: (s) => `backfill-hour:${s}`, done: "hour_backfill_done" }
    : { offset: (p) => p, cursor: backfillCursorKey, done: "backfill_done" };
}

function islandFor(deps: BackfillDeps, cwd: string | null): string {
  if (!cwd) return "unknown";
  return deps.getIslandForCwd(cwd) ?? `cwd:${cwd}`;
}

interface TokenDelta {
  date: string;
  islandId: string;
  model: string;
  tokens: TokenBucket;
}

/** Reads one file from its stored offset up to (but never past) its first line whose
 *  timestamp is `>= cutoffMs`. Returns true when the file needs no more backfilling
 *  (either it hit the cutoff, or it reached EOF entirely before the cutoff). */
async function backfillFile(deps: BackfillDeps, path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return true; // gone mid-scan: nothing left to do here
  }
  const mode = deps.mode ?? "full";
  const keys = keysFor(mode);
  const withTotals = mode === "full";
  const withHours = mode === "hour" || deps.hours !== false;
  const startOffset = deps.store.getFileOffset(keys.offset(path));
  if (startOffset >= size) return true; // nothing new since the last pass

  const sessionId = basename(path, ".jsonl");
  // The backfill keeps its OWN cursor: the live path's cursor sits at "now", and gapping old
  // lines against it made every historical gap non-advancing (0 active time).
  const cursorKey = keys.cursor(sessionId);
  let cursor: SessionCursor = deps.store.getCursor(cursorKey);
  const tokenDeltas = new Map<string, TokenDelta>(); // key: `${date}|${model}`
  const timeDeltas = new Map<string, { date: string; islandId: string; ms: number }>(); // key: `${date}|${islandId}`
  const hourDeltas = new Map<string, { date: string; hour: number; ms: number }>(); // key: `${date}|${hour}`
  let cwd: string | null = null;
  let bytesRead = 0;
  let hitCutoff = false;

  const rl = createInterface({ input: createReadStream(path, { start: startOffset, encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    bytesRead += Buffer.byteLength(rawLine, "utf8") + 1; // +1: the newline readline stripped
    const facts = parseUsageLine(rawLine);
    if (!facts) continue; // malformed: skip, bytes still counted so we move past it
    if (facts.cwd) cwd = facts.cwd;
    if (facts.atMs === null) continue; // no timestamp: nothing to attribute or gap against
    if (facts.atMs >= deps.cutoffMs) {
      hitCutoff = true;
      break;
    }

    const islandId = islandFor(deps, cwd);
    const date = localDateKeyFromMs(facts.atMs);
    const result = reduceLine(cursor, { atMs: facts.atMs, model: facts.model, messageId: facts.messageId, tokens: facts.tokens });
    cursor = result.next;
    if (result.activeMsDelta > 0 && withTotals) {
      const key = `${date}|${islandId}`;
      const prev = timeDeltas.get(key) ?? { date, islandId, ms: 0 };
      timeDeltas.set(key, { ...prev, ms: prev.ms + result.activeMsDelta });
    }
    if (result.activeMsDelta > 0 && withHours) {
      const hour = new Date(facts.atMs).getHours();
      const hkey = `${date}|${hour}`;
      const hprev = hourDeltas.get(hkey) ?? { date, hour, ms: 0 };
      hourDeltas.set(hkey, { ...hprev, ms: hprev.ms + result.activeMsDelta });
    }
    if (result.tokenDelta && withTotals) {
      const key = `${date}|${result.tokenDelta.model}`;
      const prev = tokenDeltas.get(key);
      tokenDeltas.set(key, prev ? { ...prev, tokens: addTokens(prev.tokens, result.tokenDelta.tokens) } : { date, islandId, model: result.tokenDelta.model, tokens: result.tokenDelta.tokens });
    }
  }
  rl.close();

  const reachedEnd = startOffset + bytesRead >= size;
  deps.store.applyBackfillBatch({
    path: keys.offset(path),
    fromOffset: startOffset,
    fileOffset: startOffset + bytesRead,
    sessionId,
    cursorKey,
    cursor,
    tokenDeltas,
    timeDeltas,
    hourDeltas,
  });
  return hitCutoff || reachedEnd;
}

/** One pass over every file not yet fully backfilled. Cheap and safe to call repeatedly
 *  (e.g. every tick): a file already at its cutoff line is a one-line, no-op re-check, and
 *  the whole pass is skipped once every file has reported done. */
export async function runBackfillPass(deps: BackfillDeps): Promise<void> {
  const done = keysFor(deps.mode ?? "full").done;
  if (deps.store.getMeta(done) === "1") return;
  const files = await jsonlFiles(deps.projectsDir);
  let allDone = true;
  for (const path of files) {
    try {
      if (!(await backfillFile(deps, path))) allDone = false;
    } catch {
      allDone = false; // a transient read error: retry this file next pass
    }
    await yieldToLoop();
  }
  if (allDone) deps.store.setMeta(done, "1");
}
