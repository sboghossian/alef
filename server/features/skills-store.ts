// The skills feature's own small sqlite file (data/skills.db next to world.db), so the hub
// schema in server/db.ts stays untouched — same pattern as server/features/subagents/store.ts.
// Holds every detected skill-system event (invoke / slash / suggested), plus the historical
// backfill's own bookkeeping (skills-backfill.ts): one byte offset per file it has tailed and
// a handful of meta flags (cutoff timestamp, done flag, file-count progress) — same shape as
// usage-store.ts's usage_file_offset/usage_meta tables. Deleting the file loses history
// gathered so far and any in-progress backfill; the next boot just starts over (source
// transcripts are only ever read, never mutated).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillEvent, SkillEventKind } from "../../shared/features/skills.js";

export class SkillsStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        UNIQUE(session_id, skill_name, kind, at)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_events_skill ON skill_events(skill_name);
      CREATE INDEX IF NOT EXISTS idx_skill_events_session ON skill_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_skill_events_at ON skill_events(at);

      CREATE TABLE IF NOT EXISTS skills_file_offset (path TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS skills_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Inserts new events, ignoring exact duplicates (same session+skill+kind+timestamp — a
   *  reprocessed line, not a second real event). Returns the subset that was actually new,
   *  in the same order, so callers can broadcast exactly what landed. */
  insertEvents(events: readonly SkillEvent[]): SkillEvent[] {
    if (events.length === 0) return [];
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO skill_events (session_id, skill_name, kind, at) VALUES (@sessionId, @skillName, @kind, @at)`,
    );
    const tx = this.db.transaction((rows: readonly SkillEvent[]) => {
      const added: SkillEvent[] = [];
      for (const r of rows) if (stmt.run(r).changes > 0) added.push(r);
      return added;
    });
    return tx(events);
  }

  /** One session's events, oldest first. */
  eventsForSession(sessionId: string): SkillEvent[] {
    return (
      this.db
        .prepare(`SELECT session_id AS sessionId, skill_name AS skillName, kind, at FROM skill_events WHERE session_id = ? ORDER BY at ASC, id ASC`)
        .all(sessionId) as SkillEvent[]
    );
  }

  /** Most recent events across every session, newest first, capped at `limit`. */
  recentEvents(limit: number): SkillEvent[] {
    return (
      this.db
        .prepare(`SELECT session_id AS sessionId, skill_name AS skillName, kind, at FROM skill_events ORDER BY at DESC, id DESC LIMIT ?`)
        .all(limit) as SkillEvent[]
    );
  }

  /** Every event of the given kinds at/after `sinceIso`, for usage aggregation. */
  eventsSince(sinceIso: string, kinds: readonly SkillEventKind[]): SkillEvent[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT session_id AS sessionId, skill_name AS skillName, kind, at FROM skill_events WHERE at >= ? AND kind IN (${placeholders})`)
        .all(sinceIso, ...kinds) as SkillEvent[]
    );
  }

  /** ISO `at` of the OLDEST recorded skill_event — the real start of this store's history.
   *  Null when the store has no events at all ("no data", not "0 days of history"). Used by
   *  the Institute/Graveyard tabs: a store only a few weeks old can't tell you a skill has
   *  really been silent for the full 90-day window skills-aggregate.ts buckets fired90d over. */
  firstEventAt(): string | null {
    const row = this.db.prepare(`SELECT MIN(at) AS at FROM skill_events`).get() as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /** Each skill's first event of the given kinds, for skills whose first one is at/after `sinceIso`
   *  (oldest first). "First" is relative to this store's history (firstEventAt), nothing older. */
  firstFiresSince(sinceIso: string, kinds: readonly SkillEventKind[]): { skillName: string; firstAt: string }[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT skill_name AS skillName, MIN(at) AS firstAt FROM skill_events WHERE kind IN (${placeholders}) GROUP BY skill_name HAVING MIN(at) >= ? ORDER BY firstAt ASC`)
      .all(...kinds, sinceIso) as { skillName: string; firstAt: string }[];
  }

  // ── historical backfill bookkeeping (skills-backfill.ts) ─────────────

  getFileOffset(path: string): number {
    const row = this.db.prepare(`SELECT byte_offset FROM skills_file_offset WHERE path = ?`).get(path) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  setFileOffset(path: string, offset: number): void {
    this.db.prepare(`INSERT INTO skills_file_offset (path, byte_offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset`).run(path, offset);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM skills_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO skills_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** Persists one file's backfilled events and its new byte offset in a single transaction —
   *  so a crash between the two can never leave the offset ahead of what was actually saved. */
  applyBackfillBatch(opts: { path: string; fileOffset: number; events: readonly SkillEvent[] }): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO skill_events (session_id, skill_name, kind, at) VALUES (@sessionId, @skillName, @kind, @at)`);
    const tx = this.db.transaction(() => {
      for (const e of opts.events) insert.run(e);
      this.setFileOffset(opts.path, opts.fileOffset);
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}

/** data/skills.db beside the world db (":memory:" stays in memory, e.g. in tests). */
export function skillsStorePathFor(worldDbPath: string): string {
  return worldDbPath === ":memory:" ? ":memory:" : join(dirname(worldDbPath), "skills.db");
}
