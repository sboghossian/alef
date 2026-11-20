// One-time catch-up for Claude Code's own session titles (cc-titles-lib.ts). Sessions indexed
// before the indexer read custom-title / ai-title records have their offsets past those records,
// and the incremental indexer never re-reads old bytes. This reads each already-indexed transcript
// once, from byte 0 to its stored offset, keeps ONLY title records, and fills the two columns.
// Nothing else is re-folded (tokens, counts, edges stay exactly as they are).

import { createReadStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { foldCcTitles, mayBeTitleLine, type CcTitles } from "./cc-titles-lib.js";
import type { WorldDb } from "./db.js";
import { parseLine } from "./jsonl-events.js";
import { log } from "./log.js";

const BACKFILL_META_KEY = "cc_titles_backfilled";
const BACKUP_META_KEY = "cc_titles_backup";
const NEWLINE = 0x0a;

export interface CcTitlesBackfillOptions {
  /** Test seam: runs between the async scan and the final transaction. */
  beforeCommit?: () => void;
}

/** The last custom-title / ai-title records among the complete lines of `path`'s first `end` bytes. */
export async function scanCcTitles(path: string, end: number): Promise<CcTitles> {
  const acc: CcTitles = { customTitle: null, aiTitle: null };
  if (end <= 0) return acc;
  let buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { start: 0, end: end - 1 })) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    let start = 0;
    for (let nl = buffer.indexOf(NEWLINE, start); nl !== -1; nl = buffer.indexOf(NEWLINE, start)) {
      const line = buffer.toString("utf8", start, nl);
      if (mayBeTitleLine(line)) {
        const parsed = parseLine(line);
        if (parsed) foldCcTitles(acc, parsed);
      }
      start = nl + 1;
    }
    buffer = buffer.subarray(start);
  }
  return acc;
}

/**
 * Fills custom_title / ai_title for every session indexed before they existed. Only NULL columns
 * are filled (WorldDb.fillCcTitles), so a title the indexer already read from newer bytes wins.
 *
 * Crash-safe (LOOP.md data-migration rule): the db is backed up once (WAL-safe) to
 * `world.db.pre-cc-titles-<ISO>.bak` before the first attempt, and no backup means no migration
 * this boot; the scan only reads; every write plus the done flag commit in ONE transaction, the
 * flag last. An interrupted run leaves the flag unset and the next boot converges to the same state.
 * A transcript that can't be read (deleted, unreadable) is skipped: its session keeps its
 * first-prompt title.
 */
export async function runCcTitlesBackfill(db: WorldDb, opts: CcTitlesBackfillOptions = {}): Promise<void> {
  if (db.getMeta(BACKFILL_META_KEY) === "1") return;

  const file = db.filePath();
  if (file && db.getMeta(BACKUP_META_KEY) === null) {
    const dest = join(dirname(file), `${basename(file)}.pre-cc-titles-${new Date().toISOString().replace(/:/g, "-")}.bak`);
    try {
      await db.backupTo(dest);
    } catch (err) {
      log.warn("cc-titles", `could not back up the db before the title backfill; skipping it this boot: ${String(err)}`);
      return;
    }
    db.setMeta(BACKUP_META_KEY, dest);
    log.info("cc-titles", `backed up the db before the title backfill: ${dest}`);
  }

  const ids = new Set(db.listSessions().map((s) => s.id));
  const found = new Map<string, CcTitles>();
  let unreadable = 0;
  for (const off of db.listFileOffsets()) {
    const id = basename(off.path, ".jsonl");
    if (!off.path.endsWith(".jsonl") || !ids.has(id)) continue;
    try {
      const t = await scanCcTitles(off.path, off.byteOffset);
      if (t.customTitle !== null || t.aiTitle !== null) found.set(id, t);
    } catch {
      unreadable += 1;
    }
  }
  opts.beforeCommit?.();

  db.transaction(() => {
    for (const [id, t] of found) db.fillCcTitles(id, t.customTitle, t.aiTitle);
    db.setMeta(BACKFILL_META_KEY, "1");
  });
  log.info("cc-titles", `title backfill done: ${found.size} sessions carry a Claude Code title${unreadable ? `, ${unreadable} transcripts unreadable` : ""}`);
}
