// The artifacts feature's persisted state, kept in world.db's meta table (no schema change): the
// folded items, one read cursor per transcript (its own: never the indexer's), and the done flag of
// the first full read. Data-migration rule: before the first write, world.db is backed up
// (WAL-safe) to `world.db.pre-artifacts-<ISO>.bak`; every write is ONE transaction that stores the
// items and the cursors together, with the done flag last. Items and cursors only ever move
// together, so a crash between passes re-reads exactly the lines whose events were not stored, and
// a rerun converges instead of counting a publish twice.

import { basename, dirname, join } from "node:path";
import type { WorldDb } from "../db.js";
import { emptyState, type ArtifactsState, type PendingPublish } from "./artifacts-lib.js";

export const META_STATE = "artifacts_v1_state";
export const META_CURSORS = "artifacts_v1_cursors";
export const META_DONE = "artifacts_v1_backfill_done";
export const META_BACKUP = "artifacts_v1_backup";

/** Read position in one transcript: byte offset past the last complete line read, plus that file's
 *  Artifact calls still waiting for their result. */
export interface FileCursor {
  o: number;
  p?: Record<string, PendingPublish>;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ArtifactsStore {
  state: ArtifactsState = emptyState();
  cursors = new Map<string, FileCursor>();
  done = false;
  /** Bumped on every change; the client refetches the list when it moves. */
  rev = 0;
  private backupChecked = false;

  constructor(private readonly db: WorldDb) {}

  /** Restores the last committed state. A corrupt value starts that part over (cursors included,
   *  so nothing is lost: the transcripts are re-read). */
  load(): void {
    const state = parseJson(this.db.getMeta(META_STATE));
    const cursors = parseJson(this.db.getMeta(META_CURSORS));
    if (isObj(state) && isObj(state.items) && isObj(state.aliases) && isObj(cursors)) {
      this.state = state as unknown as ArtifactsState;
      this.cursors = new Map(Object.entries(cursors as Record<string, FileCursor>).filter(([, c]) => isObj(c) && typeof c.o === "number"));
    } else {
      this.state = emptyState();
      this.cursors = new Map();
    }
    this.done = this.db.getMeta(META_DONE) === "1";
    this.rev += 1;
  }

  /** Backs world.db up once, before the first write. False when the backup failed: then nothing
   *  is written this boot. A db with no file (tests' :memory:) has nothing to back up. */
  async ensureBackup(now: Date = new Date()): Promise<boolean> {
    if (this.backupChecked) return true;
    const file = this.db.filePath();
    if (file && file !== ":memory:" && this.db.getMeta(META_BACKUP) === null) {
      const dest = join(dirname(file), `${basename(file)}.pre-artifacts-${now.toISOString().replace(/:/g, "-")}.bak`);
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
}
