// The "usage" feature's own small sqlite file (data/usage.db beside world.db), so the hub
// schema in server/db.ts stays untouched. Holds per-(date, session, model) token sums,
// per-(date, session) active-time sums, one dedupe/gap cursor per session, per-file
// backfill offsets, and a few meta flags. Deleting the file forces a full rebuild from the
// source transcripts, which are only ever read.

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { addTokens, ZERO_TOKENS, type SessionCursor, type TokenBucket } from "../../shared/features/usage.js";

export interface TokenRow {
  islandId: string;
  sessionId: string;
  model: string;
  tokens: TokenBucket;
}

export interface TimeRow {
  islandId: string;
  sessionId: string;
  activeMs: number;
}

interface TokenSqlRow {
  island_id: string;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read_tokens: number;
}

function tokensFromRow(r: TokenSqlRow): TokenRow {
  return {
    islandId: r.island_id,
    sessionId: r.session_id,
    model: r.model,
    tokens: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheWrite5mTokens: r.cache_write_5m,
      cacheWrite1hTokens: r.cache_write_1h,
      cacheReadTokens: r.cache_read_tokens,
    },
  };
}

const SCHEMA_VERSION = 3;
/** usage_meta key: set by the v2 -> v3 migration; lines older than it get usage_hour from the "hour" backfill. */
export const HOUR_BACKFILL_CUTOFF_KEY = "hour_backfill_cutoff_ms";

export class UsageStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // Derived data: on a schema change, drop everything and let the backfill rebuild it.
    // v2 (2026-09-25): city in the keys (a session that changes city mid-day splits, not overwrites)
    // and a separate backfill cursor.
    // v3 (2026-10-14): usage_hour (active ms per local clock hour) for the activity-by-hour chart.
    //     v2 -> v3 is ADDITIVE: the transcripts behind older rows may already be gone (Claude Code
    //     prunes them after ~30 days), so a drop-and-rebuild would lose that history for good. Only
    //     usage_hour is new; it is backfilled on its own (usage-backfill.ts "hour" mode) up to the
    //     migration moment, recorded in usage_meta in the same transaction as the version bump.
    // Before the first write of any migration, the old file is copied to `<path>.pre-v3.bak` (once).
    const version = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (version !== SCHEMA_VERSION) {
      if (path !== ":memory:" && version !== 0) {
        const bak = `${path}.pre-v${SCHEMA_VERSION}.bak`;
        if (!existsSync(bak)) this.db.exec(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
      }
      this.db.transaction(() => {
        if (version === 2) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT);`);
          this.db.prepare(`INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`).run(HOUR_BACKFILL_CUTOFF_KEY, String(Date.now()));
        } else {
          this.db.exec(`DROP TABLE IF EXISTS usage_tokens; DROP TABLE IF EXISTS usage_time; DROP TABLE IF EXISTS usage_cursor;
            DROP TABLE IF EXISTS usage_file_offset; DROP TABLE IF EXISTS usage_hour; DROP TABLE IF EXISTS usage_meta;`);
        }
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_tokens (
        date TEXT NOT NULL,
        island_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_5m INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, island_id, session_id, model)
      );
      CREATE INDEX IF NOT EXISTS usage_tokens_date ON usage_tokens(date);
      CREATE INDEX IF NOT EXISTS usage_tokens_session ON usage_tokens(session_id);

      CREATE TABLE IF NOT EXISTS usage_time (
        date TEXT NOT NULL,
        island_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, island_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS usage_time_date ON usage_time(date);

      CREATE TABLE IF NOT EXISTS usage_hour (
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, hour)
      );

      CREATE TABLE IF NOT EXISTS usage_cursor (
        session_id TEXT PRIMARY KEY,
        last_message_id TEXT,
        last_event_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS usage_file_offset (
        path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  // ── tokens / time (additive) ─────────────────────────────────────────

  addTokens(date: string, islandId: string, sessionId: string, model: string, delta: TokenBucket): void {
    this.db
      .prepare(
        `INSERT INTO usage_tokens (date, island_id, session_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, island_id, session_id, model) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_write_5m = cache_write_5m + excluded.cache_write_5m,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`,
      )
      .run(date, islandId, sessionId, model, delta.inputTokens, delta.outputTokens, delta.cacheWrite5mTokens, delta.cacheWrite1hTokens, delta.cacheReadTokens);
  }

  addActiveMs(date: string, islandId: string, sessionId: string, ms: number): void {
    if (ms <= 0) return;
    this.db
      .prepare(
        `INSERT INTO usage_time (date, island_id, session_id, active_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(date, island_id, session_id) DO UPDATE SET active_ms = active_ms + excluded.active_ms`,
      )
      .run(date, islandId, sessionId, ms);
  }

  /** Active ms in one local clock hour (0-23) of one local date, summed over every session. */
  addHourMs(date: string, hour: number, ms: number): void {
    if (ms <= 0 || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
    this.db
      .prepare(`INSERT INTO usage_hour (date, hour, active_ms) VALUES (?, ?, ?) ON CONFLICT(date, hour) DO UPDATE SET active_ms = active_ms + excluded.active_ms`)
      .run(date, hour, ms);
  }

  /** Active ms per clock hour over [from, to] (inclusive local date keys): always 24 entries. */
  hourTotals(from: string, to: string): number[] {
    const out = new Array<number>(24).fill(0);
    const rows = this.db.prepare(`SELECT hour, SUM(active_ms) AS ms FROM usage_hour WHERE date >= ? AND date <= ? GROUP BY hour`).all(from, to) as Array<{ hour: number; ms: number }>;
    for (const r of rows) if (r.hour >= 0 && r.hour < 24) out[r.hour] = r.ms;
    return out;
  }

  /** Token sums per (city, model) over [from, to], plus how many distinct sessions touched each city. */
  rangeTokenRows(from: string, to: string): { rows: Array<{ islandId: string; model: string; tokens: TokenBucket }>; sessionsByIsland: Map<string, number> } {
    const rows = (
      this.db
        .prepare(
          `SELECT island_id, '' AS session_id, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_write_5m) AS cache_write_5m,
                  SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read_tokens) AS cache_read_tokens
           FROM usage_tokens WHERE date >= ? AND date <= ? GROUP BY island_id, model`,
        )
        .all(from, to) as TokenSqlRow[]
    ).map(tokensFromRow);
    const sess = this.db.prepare(`SELECT island_id, COUNT(DISTINCT session_id) AS n FROM usage_tokens WHERE date >= ? AND date <= ? GROUP BY island_id`).all(from, to) as Array<{ island_id: string; n: number }>;
    return { rows: rows.map((r) => ({ islandId: r.islandId, model: r.model, tokens: r.tokens })), sessionsByIsland: new Map(sess.map((r) => [r.island_id, r.n])) };
  }

  /** Active ms per city over [from, to]. */
  rangeTimeByIsland(from: string, to: string): Map<string, number> {
    const rows = this.db.prepare(`SELECT island_id, SUM(active_ms) AS ms FROM usage_time WHERE date >= ? AND date <= ? GROUP BY island_id`).all(from, to) as Array<{ island_id: string; ms: number }>;
    return new Map(rows.map((r) => [r.island_id, r.ms]));
  }

  dayTokenRows(date: string): TokenRow[] {
    const rows = this.db.prepare(`SELECT island_id, session_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read_tokens FROM usage_tokens WHERE date = ?`).all(date) as TokenSqlRow[];
    return rows.map(tokensFromRow);
  }

  dayTimeRows(date: string): TimeRow[] {
    const rows = this.db.prepare(`SELECT island_id, session_id, active_ms FROM usage_time WHERE date = ?`).all(date) as Array<{ island_id: string; session_id: string; active_ms: number }>;
    return rows.map((r) => ({ islandId: r.island_id, sessionId: r.session_id, activeMs: r.active_ms }));
  }

  sessionTokenRows(sessionId: string): TokenRow[] {
    const rows = this.db.prepare(`SELECT island_id, session_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read_tokens FROM usage_tokens WHERE session_id = ?`).all(sessionId) as TokenSqlRow[];
    return rows.map(tokensFromRow);
  }

  /** One session's token mix collapsed across every date it touched (a session can span
   *  midnight): model → summed tokens. */
  sessionModelMix(sessionId: string): Map<string, TokenBucket> {
    const out = new Map<string, TokenBucket>();
    for (const row of this.sessionTokenRows(sessionId)) out.set(row.model, addTokens(out.get(row.model) ?? ZERO_TOKENS, row.tokens));
    return out;
  }

  sessionActiveMs(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(active_ms), 0) AS ms FROM usage_time WHERE session_id = ?`).get(sessionId) as { ms: number };
    return row.ms;
  }

  sessionIslandId(sessionId: string): string | null {
    const fromTokens = this.db.prepare(`SELECT island_id FROM usage_tokens WHERE session_id = ? LIMIT 1`).get(sessionId) as { island_id: string } | undefined;
    if (fromTokens) return fromTokens.island_id;
    const fromTime = this.db.prepare(`SELECT island_id FROM usage_time WHERE session_id = ? LIMIT 1`).get(sessionId) as { island_id: string } | undefined;
    return fromTime?.island_id ?? null;
  }

  // ── per-session dedupe + gap cursor ──────────────────────────────────

  getCursor(sessionId: string): SessionCursor {
    const row = this.db.prepare(`SELECT last_message_id, last_event_ms FROM usage_cursor WHERE session_id = ?`).get(sessionId) as
      | { last_message_id: string | null; last_event_ms: number | null }
      | undefined;
    return row ? { lastMessageId: row.last_message_id, lastEventMs: row.last_event_ms } : { lastMessageId: null, lastEventMs: null };
  }

  /** `last_event_ms` only ever moves forward — protects against the backfill pass (which
   *  only ever sees strictly older lines than the live path) regressing state the live
   *  onIndexPass path already advanced. */
  setCursor(sessionId: string, cursor: SessionCursor): void {
    this.db
      .prepare(
        `INSERT INTO usage_cursor (session_id, last_message_id, last_event_ms) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_message_id = excluded.last_message_id,
           last_event_ms = MAX(COALESCE(last_event_ms, 0), COALESCE(excluded.last_event_ms, 0))`,
      )
      .run(sessionId, cursor.lastMessageId, cursor.lastEventMs);
  }

  // ── backfill bookkeeping ──────────────────────────────────────────────

  getFileOffset(path: string): number {
    const row = this.db.prepare(`SELECT byte_offset FROM usage_file_offset WHERE path = ?`).get(path) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  setFileOffset(path: string, offset: number): void {
    this.db.prepare(`INSERT INTO usage_file_offset (path, byte_offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset`).run(path, offset);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM usage_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** Applies one file's worth of backfill deltas in a single transaction, only if the file's stored
   *  offset is still `fromOffset` (another process on the same file already applied this slice
   *  otherwise: applying it again would double-count). Returns whether it applied. */
  applyBackfillBatch(opts: {
    path: string;
    fromOffset: number;
    fileOffset: number;
    sessionId: string;
    /** Where the backfill's own cursor lives (never the live cursor's key). */
    cursorKey: string;
    cursor: SessionCursor;
    tokenDeltas: ReadonlyMap<string, { date: string; islandId: string; model: string; tokens: TokenBucket }>;
    timeDeltas: ReadonlyMap<string, { date: string; islandId: string; ms: number }>;
    hourDeltas?: ReadonlyMap<string, { date: string; hour: number; ms: number }>;
  }): boolean {
    const tx = this.db.transaction((): boolean => {
      if (this.getFileOffset(opts.path) !== opts.fromOffset) return false;
      for (const d of opts.tokenDeltas.values()) this.addTokens(d.date, d.islandId, opts.sessionId, d.model, d.tokens);
      for (const d of opts.timeDeltas.values()) this.addActiveMs(d.date, d.islandId, opts.sessionId, d.ms);
      for (const d of opts.hourDeltas?.values() ?? []) this.addHourMs(d.date, d.hour, d.ms);
      this.setCursor(opts.cursorKey, opts.cursor);
      this.setFileOffset(opts.path, opts.fileOffset);
      return true;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }
}

/** data/usage.db beside the world db (":memory:" stays in memory, for tests). */
export function usageStorePathFor(worldDbPath: string): string {
  return worldDbPath === ":memory:" ? ":memory:" : join(dirname(worldDbPath), "usage.db");
}
