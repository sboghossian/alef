// SQLite persistence layer (better-sqlite3). Owns the schema and all raw
// reads/writes; indexer.ts, harness.ts, director.ts and index.ts only ever
// talk to the world through this module's typed functions.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionKind, JevDecision } from "../shared/types.js";
import type { LastLineKind } from "./heuristics.js";
import type { EvidenceRow } from "./placement-evidence-lib.js";
import { log } from "./log.js";

export interface SessionRow {
  id: string;
  cwd: string;
  /** Home island. Stable, except for a session run from a catch-all cwd (home dir or "/"),
   *  which home-placement.ts may re-home onto the git repo its touched files dominantly
   *  belong to as more of them arrive — see setSessionIslandId. */
  islandId: string;
  targetIslandId: string; // where the agent currently is / heading
  roamTicksLeft: number;
  title: string;
  startedAt: string;
  lastActive: string;
  jsonlMtime: number;
  messageCount: number;
  model: string | null;
  cntEdit: number;
  cntResearch: number;
  cntBash: number;
  cntTextOnly: number;
  cntAssistantTotal: number;
  tokens: number; // input+output+cache_creation tokens summed over the whole session
  lastLineKind: LastLineKind;
  lastToolName: string | null;
  lastTextIsQuestion: boolean;
  /** message.id of the last assistant turn whose usage was already counted into `tokens` —
   *  one turn is streamed across several jsonl lines that repeat the same id and the same
   *  (cumulative) usage block, so this is how the indexer avoids counting a turn twice. */
  lastUsageMessageId: string | null;
  /** Claude Code's own names for the session, verbatim from its transcript (last record wins):
   *  the user's /rename and Claude Code's AI title. Display only: `title` (the first prompt) stays
   *  what topics, automationKey and autonomy classify on. Null when no such record was seen. */
  customTitle: string | null;
  aiTitle: string | null;
}

export interface ObjectRow {
  id: string;
  kind: "repo" | "file" | "skill" | "hook" | "mcp";
  name: string;
  islandId: string;
  growth: number;
}

export interface ObjectWithUsage extends ObjectRow {
  usage: number;
}

export interface EdgeRow {
  from: string;
  to: string;
  kind: "touched" | "visited" | "uses";
  weight: number;
  at: string;
}

export interface FileOffsetRow {
  path: string;
  size: number;
  mtime: number;
  byteOffset: number;
  malformedCount: number;
}

/** Adds a column to an already-created table if it isn't there yet, and reports whether
 *  it actually added it (vs. it already existed). SQLite has no "ADD COLUMN IF NOT
 *  EXISTS"; this keeps openDb() idempotent against a pre-existing data/world.db from
 *  before these fields existed, without a migrations framework. */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): boolean {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true;
  } catch (err) {
    if (!/duplicate column name/i.test(String(err))) throw err;
    return false;
  }
}

/** Opens (creating if needed) the SQLite database and its schema. */
export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      island_id TEXT NOT NULL,
      target_island_id TEXT NOT NULL,
      roam_ticks_left INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      last_active TEXT NOT NULL,
      jsonl_mtime REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      cnt_edit INTEGER NOT NULL DEFAULT 0,
      cnt_research INTEGER NOT NULL DEFAULT 0,
      cnt_bash INTEGER NOT NULL DEFAULT 0,
      cnt_text_only INTEGER NOT NULL DEFAULT 0,
      cnt_assistant_total INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      island_id TEXT NOT NULL,
      growth REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      at TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, kind)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      subjects TEXT NOT NULL,
      choice TEXT NOT NULL,
      probabilities TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_offsets (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      byte_offset INTEGER NOT NULL,
      malformed_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cwd_islands (
      cwd TEXT PRIMARY KEY,
      island_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cwd_aliases (
      cwd TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      prev_island_id TEXT
    );

    CREATE TABLE IF NOT EXISTS git_roots (
      cwd TEXT PRIMARY KEY,
      repo_root TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS day_tokens (
      date TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL DEFAULT 0
    );

    -- Where a home-run session's work shipped (placement-evidence-lib.ts). Never drawn: only
    -- home-placement.ts reads it. kind 'pending-ship' = a ship command whose output is unread.
    CREATE TABLE IF NOT EXISTS placement_evidence (
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      subject TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (session_id, kind, key)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_objects_island ON objects(island_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_island ON sessions(island_id);
  `);

  const addedTokens = ensureColumn(db, "sessions", "tokens", "tokens INTEGER NOT NULL DEFAULT 0");
  const addedLastLineKind = ensureColumn(db, "sessions", "last_line_kind", "last_line_kind TEXT NOT NULL DEFAULT 'user'");
  const addedLastToolName = ensureColumn(db, "sessions", "last_tool_name", "last_tool_name TEXT");
  const addedLastTextIsQuestion = ensureColumn(
    db,
    "sessions",
    "last_text_is_question",
    "last_text_is_question INTEGER NOT NULL DEFAULT 0",
  );
  const addedLastUsageMessageId = ensureColumn(db, "sessions", "last_usage_message_id", "last_usage_message_id TEXT");
  // Display-only titles (cc-titles-lib.ts). Deliberately NOT part of the reindex trigger below:
  // cc-titles-backfill.ts fills them for already-indexed sessions without re-folding anything.
  ensureColumn(db, "sessions", "custom_title", "custom_title TEXT");
  ensureColumn(db, "sessions", "ai_title", "ai_title TEXT");
  // cwd_aliases shipped briefly without prev_island_id; dev dbs that have it need the column. Not part of the reindex trigger below.
  ensureColumn(db, "cwd_aliases", "prev_island_id", "prev_island_id TEXT");

  // These five columns exist only because token/last-line tracking was added after this
  // db may already have fully-consumed file_offsets from an older server build that never
  // extracted them. The incremental indexer only ever reads NEW bytes, so without this a
  // pre-existing install would report 0 tokens / wrong awaitingInput forever for every
  // session indexed before today. Force exactly one full reindex the first time any of
  // these columns is freshly added. The source .jsonl files are read-only and untouched —
  // this only clears this app's own derived SQLite cache, which is safe to rebuild.
  if (addedTokens || addedLastLineKind || addedLastToolName || addedLastTextIsQuestion || addedLastUsageMessageId) {
    log.warn(
      "db",
      "sessions schema gained token/last-line columns — wiping the derived index (sessions/objects/edges/file_offsets/day_tokens) for a one-time full reindex from source jsonl",
    );
    db.exec(`
      DELETE FROM sessions;
      DELETE FROM objects;
      DELETE FROM edges;
      DELETE FROM file_offsets;
      DELETE FROM day_tokens;
      DELETE FROM placement_evidence;
    `);
  }

  log.info("db", `opened ${path}`);
  return db;
}

/** Typed wrapper around the raw better-sqlite3 handle. */
export class WorldDb {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  // ── file_offsets ─────────────────────────────────────────────────────

  /** Every transcript offset row (the one-time title backfill scans each file up to its offset). */
  listFileOffsets(): FileOffsetRow[] {
    return this.db
      .prepare(`SELECT path, size, mtime, byte_offset AS byteOffset, malformed_count AS malformedCount FROM file_offsets`)
      .all() as FileOffsetRow[];
  }

  getFileOffset(path: string): FileOffsetRow | null {
    const row = this.db
      .prepare(
        `SELECT path, size, mtime, byte_offset AS byteOffset, malformed_count AS malformedCount
         FROM file_offsets WHERE path = ?`,
      )
      .get(path) as FileOffsetRow | undefined;
    return row ?? null;
  }

  setFileOffset(row: FileOffsetRow): void {
    this.db
      .prepare(
        `INSERT INTO file_offsets (path, size, mtime, byte_offset, malformed_count)
         VALUES (@path, @size, @mtime, @byteOffset, @malformedCount)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size,
           mtime = excluded.mtime,
           byte_offset = excluded.byte_offset,
           malformed_count = excluded.malformed_count`,
      )
      .run(row);
  }

  // ── retire ──────────────────────────────────────────────────────────

  /** Forget a session everywhere (row, edges, file offsets for its transcript and its
   *  subagents/ dir) in one transaction. With the offsets gone, a restored file is re-indexed
   *  from byte 0. Ids are session UUIDs; anything else is refused so LIKE can't over-match. */
  forgetSession(id: string): { sessionsDeleted: number; offsetsDeleted: number } {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error(`forgetSession: not a session id: ${id}`);
    const tx = this.db.transaction(() => {
      const sessionsDeleted = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes;
      this.db.prepare(`DELETE FROM edges WHERE from_id = ? OR to_id = ?`).run(id, id);
      this.db.prepare(`DELETE FROM placement_evidence WHERE session_id = ?`).run(id);
      const offsetsDeleted = this.db
        .prepare(`DELETE FROM file_offsets WHERE path LIKE '%/' || ? || '.jsonl' OR path LIKE '%/' || ? || '/%'`)
        .run(id, id).changes;
      return { sessionsDeleted, offsetsDeleted };
    });
    return tx();
  }

  // ── cwd → island id (assigned once, stable forever) ─────────────────

  getIslandForCwd(cwd: string): string | null {
    const row = this.db.prepare(`SELECT island_id AS islandId FROM cwd_islands WHERE cwd = ?`).get(cwd) as
      | { islandId: string }
      | undefined;
    return row?.islandId ?? null;
  }

  setIslandForCwd(cwd: string, islandId: string): void {
    this.db
      .prepare(`INSERT INTO cwd_islands (cwd, island_id) VALUES (?, ?) ON CONFLICT(cwd) DO NOTHING`)
      .run(cwd, islandId);
  }

  /** Points `cwd` (a worktree or subfolder) at its canonical repo `root`'s island, replacing any
   *  island it had (canonical-repo.ts). The alias row keeps getIslandCwd on the root and records
   *  the island the cwd had before (null for a cwd first seen as an alias), set once, never lost. */
  aliasCwdToRoot(cwd: string, root: string, islandId: string): void {
    this.db.transaction(() => {
      const prev = this.getIslandForCwd(cwd);
      this.db
        .prepare(`INSERT INTO cwd_islands (cwd, island_id) VALUES (?, ?) ON CONFLICT(cwd) DO UPDATE SET island_id = excluded.island_id`)
        .run(cwd, islandId);
      this.db
        .prepare(
          `INSERT INTO cwd_aliases (cwd, root, prev_island_id) VALUES (?, ?, ?)
           ON CONFLICT(cwd) DO UPDATE SET root = excluded.root, prev_island_id = COALESCE(cwd_aliases.prev_island_id, excluded.prev_island_id)`,
        )
        .run(cwd, root, prev !== null && prev !== islandId ? prev : null);
    })();
  }

  /** Every alias cwd with its root, the island it now shares and the island it had before. */
  listCwdAliases(): Array<{ cwd: string; root: string; islandId: string | null; prevIslandId: string | null }> {
    return this.db
      .prepare(
        `SELECT a.cwd, a.root, c.island_id AS islandId, a.prev_island_id AS prevIslandId
         FROM cwd_aliases a LEFT JOIN cwd_islands c ON c.cwd = a.cwd ORDER BY a.cwd`,
      )
      .all() as Array<{ cwd: string; root: string; islandId: string | null; prevIslandId: string | null }>;
  }

  /** Moves every object of island `from` onto island `to` (a vacated island, canonical-backfill.ts). */
  moveIslandObjects(from: string, to: string): void {
    this.db.prepare(`UPDATE objects SET island_id = ? WHERE island_id = ?`).run(to, from);
  }

  /** Every object on `islandId`, with the island of the session whose edge reached it last (null
   *  when no session's edge reaches it any more) — where the indexer would put it today. */
  objectsWithLatestToucher(islandId: string): Array<{ id: string; toucherIslandId: string | null }> {
    return this.db
      .prepare(
        `SELECT o.id AS id,
                (SELECT s.island_id FROM edges e JOIN sessions s ON s.id = e.from_id
                 WHERE e.to_id = o.id ORDER BY e.at DESC, s.id LIMIT 1) AS toucherIslandId
         FROM objects o WHERE o.island_id = ? ORDER BY o.id`,
      )
      .all(islandId) as Array<{ id: string; toucherIslandId: string | null }>;
  }

  setObjectIsland(id: string, islandId: string): void {
    this.db.prepare(`UPDATE objects SET island_id = ? WHERE id = ?`).run(islandId, id);
  }

  /** Island ids at least one indexed session sits on (live or dormant; fossils are vault-only). */
  listSessionIslandIds(): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT island_id AS islandId FROM sessions`).all() as Array<{ islandId: string }>;
    return new Set(rows.map((r) => r.islandId));
  }

  /** Runs `fn` in one SQLite transaction (all or nothing). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** The database file on disk ("" for an in-memory db). */
  filePath(): string {
    return this.db.memory ? "" : this.db.name;
  }

  /** WAL-safe online copy of the database to `dest` (better-sqlite3's backup API). */
  async backupTo(dest: string): Promise<void> {
    await this.db.backup(dest);
  }

  /** The cwd an island id was assigned from, if any ("harness" and unknown ids return null).
   *  An island shared by aliases (worktrees, subfolders) answers with its canonical root. */
  getIslandCwd(islandId: string): string | null {
    const row = this.db
      .prepare(`SELECT cwd FROM cwd_islands WHERE island_id = ? ORDER BY cwd IN (SELECT cwd FROM cwd_aliases), cwd LIMIT 1`)
      .get(islandId) as
      | { cwd: string }
      | undefined;
    return row?.cwd ?? null;
  }

  /** All (cwd -> islandId) assignments, used to detect slug collisions. */
  listIslandSlugs(): Map<string, string> {
    const rows = this.db.prepare(`SELECT cwd, island_id AS islandId FROM cwd_islands`).all() as Array<{
      cwd: string;
      islandId: string;
    }>;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.cwd, r.islandId);
    return map;
  }

  // ── git roots cache ──────────────────────────────────────────────────

  getGitRoot(cwd: string): string | null | undefined {
    const row = this.db.prepare(`SELECT repo_root AS repoRoot FROM git_roots WHERE cwd = ?`).get(cwd) as
      | { repoRoot: string | null }
      | undefined;
    if (!row) return undefined; // not cached yet
    return row.repoRoot; // may be null (no repo found)
  }

  setGitRoot(cwd: string, repoRoot: string | null): void {
    this.db
      .prepare(
        `INSERT INTO git_roots (cwd, repo_root) VALUES (?, ?)
         ON CONFLICT(cwd) DO UPDATE SET repo_root = excluded.repo_root`,
      )
      .run(cwd, repoRoot);
  }

  // ── sessions ─────────────────────────────────────────────────────────

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Insert a brand-new session or merge incremental deltas into an existing one. */
  upsertSession(delta: {
    id: string;
    cwd: string;
    islandId: string;
    title?: string;
    startedAt: string;
    lastActive: string;
    jsonlMtime: number;
    messageCountDelta: number;
    model: string | null;
    cntEditDelta: number;
    cntResearchDelta: number;
    cntBashDelta: number;
    cntTextOnlyDelta: number;
    cntAssistantTotalDelta: number;
    tokensDelta?: number;
    lastLineKind?: LastLineKind;
    lastToolName?: string | null;
    lastTextIsQuestion?: boolean;
    /** Always supplied by the indexer (already seeded from the existing value at the
     *  start of the pass), so — unlike lastLineKind — a plain `?? existing` fallback is
     *  fine here: omitting the key (as tests do) means "leave it alone". */
    lastUsageMessageId?: string | null;
    /** Omitted = this pass saw no such record: leave the stored value alone. */
    customTitle?: string;
    aiTitle?: string;
  }): void {
    const existing = this.getSession(delta.id);
    const tokensDelta = delta.tokensDelta ?? 0;
    // The three lastLine* fields are always supplied together (or not at all) by the
    // indexer, and lastToolName is meaningfully `null` (not "unset"). So the presence
    // of lastLineKind — not `??` per field — decides whether this call updates them;
    // `??` alone would coalesce an explicit `null` back to the old tool name.
    const hasLastLineUpdate = delta.lastLineKind !== undefined;
    const lastLineKind = hasLastLineUpdate ? delta.lastLineKind! : (existing?.lastLineKind ?? "user");
    const lastToolName = hasLastLineUpdate ? (delta.lastToolName ?? null) : (existing?.lastToolName ?? null);
    const lastTextIsQuestion = hasLastLineUpdate ? (delta.lastTextIsQuestion ?? false) : (existing?.lastTextIsQuestion ?? false);
    const lastUsageMessageId = delta.lastUsageMessageId !== undefined ? delta.lastUsageMessageId : (existing?.lastUsageMessageId ?? null);
    const customTitle = delta.customTitle ?? existing?.customTitle ?? null;
    const aiTitle = delta.aiTitle ?? existing?.aiTitle ?? null;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sessions (
             id, cwd, island_id, target_island_id, roam_ticks_left, title, started_at, last_active, jsonl_mtime,
             message_count, model, cnt_edit, cnt_research, cnt_bash, cnt_text_only, cnt_assistant_total,
             tokens, last_line_kind, last_tool_name, last_text_is_question, last_usage_message_id, custom_title, ai_title
           ) VALUES (@id, @cwd, @islandId, @islandId, 0, @title, @startedAt, @lastActive, @jsonlMtime,
             @messageCount, @model, @cntEdit, @cntResearch, @cntBash, @cntTextOnly, @cntAssistantTotal,
             @tokens, @lastLineKind, @lastToolName, @lastTextIsQuestion, @lastUsageMessageId, @customTitle, @aiTitle)`,
        )
        .run({
          id: delta.id,
          cwd: delta.cwd,
          islandId: delta.islandId,
          title: delta.title ?? "",
          startedAt: delta.startedAt,
          lastActive: delta.lastActive,
          jsonlMtime: delta.jsonlMtime,
          messageCount: delta.messageCountDelta,
          model: delta.model,
          cntEdit: delta.cntEditDelta,
          cntResearch: delta.cntResearchDelta,
          cntBash: delta.cntBashDelta,
          cntTextOnly: delta.cntTextOnlyDelta,
          cntAssistantTotal: delta.cntAssistantTotalDelta,
          tokens: tokensDelta,
          lastLineKind,
          lastToolName,
          lastTextIsQuestion: lastTextIsQuestion ? 1 : 0,
          lastUsageMessageId,
          customTitle,
          aiTitle,
        });
      return;
    }
    const title = existing.title || delta.title || "";
    const lastActive = delta.lastActive > existing.lastActive ? delta.lastActive : existing.lastActive;
    const model = delta.model ?? existing.model;
    this.db
      .prepare(
        `UPDATE sessions SET
           title = @title,
           last_active = @lastActive,
           jsonl_mtime = @jsonlMtime,
           message_count = message_count + @messageCountDelta,
           model = @model,
           cnt_edit = cnt_edit + @cntEditDelta,
           cnt_research = cnt_research + @cntResearchDelta,
           cnt_bash = cnt_bash + @cntBashDelta,
           cnt_text_only = cnt_text_only + @cntTextOnlyDelta,
           cnt_assistant_total = cnt_assistant_total + @cntAssistantTotalDelta,
           tokens = tokens + @tokensDelta,
           last_line_kind = @lastLineKind,
           last_tool_name = @lastToolName,
           last_text_is_question = @lastTextIsQuestion,
           last_usage_message_id = @lastUsageMessageId,
           custom_title = @customTitle,
           ai_title = @aiTitle
         WHERE id = @id`,
      )
      .run({
        id: delta.id,
        title,
        lastActive,
        jsonlMtime: delta.jsonlMtime,
        model,
        messageCountDelta: delta.messageCountDelta,
        cntEditDelta: delta.cntEditDelta,
        cntResearchDelta: delta.cntResearchDelta,
        cntBashDelta: delta.cntBashDelta,
        cntTextOnlyDelta: delta.cntTextOnlyDelta,
        cntAssistantTotalDelta: delta.cntAssistantTotalDelta,
        tokensDelta,
        lastLineKind,
        lastToolName,
        lastTextIsQuestion: lastTextIsQuestion ? 1 : 0,
        lastUsageMessageId,
        customTitle,
        aiTitle,
      });
  }

  /** Backfill write (cc-titles-backfill.ts): fills only titles still NULL, so a value the indexer
   *  already read from newer bytes is never overwritten by an older one. */
  fillCcTitles(id: string, customTitle: string | null, aiTitle: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET custom_title = COALESCE(custom_title, ?), ai_title = COALESCE(ai_title, ?) WHERE id = ?`)
      .run(customTitle, aiTitle, id);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  countSessions(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  setTarget(id: string, targetIslandId: string, roamTicksLeft: number): void {
    this.db
      .prepare(`UPDATE sessions SET target_island_id = ?, roam_ticks_left = ? WHERE id = ?`)
      .run(targetIslandId, roamTicksLeft, id);
  }

  /** Re-homes a session onto a different island (home-placement.ts, for a catch-all cwd only).
   *  Also snaps target_island_id to match, unless the session is mid-roam (roam_ticks_left > 0),
   *  in which case it settles there on its own once tickRoamers sends it home. */
  setSessionIslandId(id: string, islandId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET island_id = ?, target_island_id = CASE WHEN roam_ticks_left = 0 THEN ? ELSE target_island_id END WHERE id = ?`,
      )
      .run(islandId, islandId, id);
  }

  /** Snaps one session back to its home island, mid-roam or not (a dormant agent never travels). */
  sendHome(id: string): void {
    this.db.prepare(`UPDATE sessions SET roam_ticks_left = 0, target_island_id = island_id WHERE id = ?`).run(id);
  }

  /** Snaps every session back home (trips-migration.ts). Returns how many rows changed. */
  resetAllRoamers(): number {
    return this.db
      .prepare(`UPDATE sessions SET roam_ticks_left = 0, target_island_id = island_id WHERE roam_ticks_left != 0 OR target_island_id != island_id`)
      .run().changes;
  }

  /** Decrement roam counters; snap anyone reaching 0 back to their home island. Returns ids sent home. */
  tickRoamers(): string[] {
    const roaming = this.db
      .prepare(`SELECT id, island_id AS islandId, roam_ticks_left AS roamTicksLeft FROM sessions WHERE roam_ticks_left > 0`)
      .all() as Array<{ id: string; islandId: string; roamTicksLeft: number }>;
    const sentHome: string[] = [];
    const tx = this.db.transaction(() => {
      for (const r of roaming) {
        const next = r.roamTicksLeft - 1;
        if (next <= 0) {
          this.db
            .prepare(`UPDATE sessions SET roam_ticks_left = 0, target_island_id = island_id WHERE id = ?`)
            .run(r.id);
          sentHome.push(r.id);
        } else {
          this.db.prepare(`UPDATE sessions SET roam_ticks_left = ? WHERE id = ?`).run(next, r.id);
        }
      }
    });
    tx();
    return sentHome;
  }

  // ── objects ──────────────────────────────────────────────────────────

  /** Insert an object if new; on conflict, keep growth untouched but refresh name/island. */
  upsertObjectShell(obj: { id: string; kind: ObjectRow["kind"]; name: string; islandId: string }): void {
    this.db
      .prepare(
        `INSERT INTO objects (id, kind, name, island_id, growth) VALUES (@id, @kind, @name, @islandId, 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, island_id = excluded.island_id`,
      )
      .run(obj);
  }

  bumpGrowth(id: string, delta: number, cap = 1): number {
    const row = this.db.prepare(`SELECT growth FROM objects WHERE id = ?`).get(id) as
      | { growth: number }
      | undefined;
    const next = Math.min(cap, (row?.growth ?? 0) + delta);
    this.db.prepare(`UPDATE objects SET growth = ? WHERE id = ?`).run(next, id);
    return next;
  }

  /** Distinct island ids known to the world (from sessions' home islands and any object, e.g. "harness"). */
  listIslandIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT island_id AS islandId FROM sessions
         UNION
         SELECT island_id AS islandId FROM objects`,
      )
      .all() as Array<{ islandId: string }>;
    return rows.map((r) => r.islandId);
  }

  listObjectsWithUsage(): ObjectWithUsage[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.kind, o.name, o.island_id AS islandId, o.growth,
                COALESCE((SELECT COUNT(*) FROM edges e WHERE e.to_id = o.id), 0) AS usage
         FROM objects o`,
      )
      .all() as ObjectWithUsage[];
    return rows;
  }

  // ── edges ────────────────────────────────────────────────────────────

  upsertEdge(edge: { from: string; to: string; kind: EdgeRow["kind"]; at: string; weightDelta?: number }): void {
    const weightDelta = edge.weightDelta ?? 1;
    this.db
      .prepare(
        `INSERT INTO edges (from_id, to_id, kind, weight, at) VALUES (@from, @to, @kind, @weightDelta, @at)
         ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
           weight = weight + @weightDelta,
           at = CASE WHEN excluded.at > edges.at THEN excluded.at ELSE edges.at END`,
      )
      .run({ from: edge.from, to: edge.to, kind: edge.kind, weightDelta, at: edge.at });
  }

  /** Writes an edge with exactly this weight and time (a derived edge, recomputed rather than accumulated). */
  putEdge(edge: EdgeRow): void {
    this.db
      .prepare(
        `INSERT INTO edges (from_id, to_id, kind, weight, at) VALUES (@from, @to, @kind, @weight, @at)
         ON CONFLICT(from_id, to_id, kind) DO UPDATE SET weight = excluded.weight, at = excluded.at`,
      )
      .run(edge);
  }

  deleteEdge(from: string, to: string, kind: EdgeRow["kind"]): void {
    this.db.prepare(`DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?`).run(from, to, kind);
  }

  /** Deletes every edge of one kind. Returns how many. */
  deleteEdgesOfKind(kind: EdgeRow["kind"]): number {
    return this.db.prepare(`DELETE FROM edges WHERE kind = ?`).run(kind).changes;
  }

  listEdges(): EdgeRow[] {
    const rows = this.db
      .prepare(`SELECT from_id AS "from", to_id AS "to", kind, weight, at FROM edges`)
      .all() as EdgeRow[];
    return rows;
  }

  /** touched/uses edges originating from a given agent, for shared-object overlap. */
  targetsOf(agentId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT to_id AS toId FROM edges WHERE from_id = ? AND kind IN ('touched','uses')`)
      .all(agentId) as Array<{ toId: string }>;
    return new Set(rows.map((r) => r.toId));
  }

  // ── placement evidence (placement-evidence-lib.ts) ───────────────────

  /** Adds rows a session doesn't have yet (same kind+key = same evidence); returns how many were new. */
  addPlacementEvidence(sessionId: string, rows: readonly EvidenceRow[]): number {
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO placement_evidence (session_id, kind, key, subject, at) VALUES (?, ?, ?, ?, ?)`);
    return this.transaction(() => rows.reduce((n, r) => n + insert.run(sessionId, r.kind, r.key, r.subject, r.at).changes, 0));
  }

  placementEvidenceOf(sessionId: string): Array<Pick<EvidenceRow, "kind" | "subject">> {
    return this.db
      .prepare(`SELECT kind, subject FROM placement_evidence WHERE session_id = ? AND kind != 'pending-ship'`)
      .all(sessionId) as Array<Pick<EvidenceRow, "kind" | "subject">>;
  }

  /** Sessions with at least one pr / push / agent-edit row. */
  sessionsWithPlacementEvidence(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT session_id AS id FROM placement_evidence WHERE kind != 'pending-ship'`).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Ship commands of this session whose output hasn't been read yet (tool_use ids). */
  pendingShipUses(sessionId: string): Set<string> {
    const rows = this.db.prepare(`SELECT key FROM placement_evidence WHERE session_id = ? AND kind = 'pending-ship'`).all(sessionId) as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key));
  }

  syncPendingShipUses(sessionId: string, pending: Iterable<string>, resolved: Iterable<string>, at: string): void {
    const add = this.db.prepare(`INSERT OR IGNORE INTO placement_evidence (session_id, kind, key, subject, at) VALUES (?, 'pending-ship', ?, '', ?)`);
    const del = this.db.prepare(`DELETE FROM placement_evidence WHERE session_id = ? AND kind = 'pending-ship' AND key = ?`);
    this.transaction(() => {
      for (const id of resolved) del.run(sessionId, id);
      for (const id of pending) add.run(sessionId, id, at);
    });
  }

  // ── decisions ────────────────────────────────────────────────────────

  insertDecision(d: JevDecision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, at, kind, subjects, choice, probabilities, confidence, source, summary)
         VALUES (@id, @at, @kind, @subjects, @choice, @probabilities, @confidence, @source, @summary)`,
      )
      .run({
        id: d.id,
        at: d.at,
        kind: d.kind,
        subjects: JSON.stringify(d.subjects),
        choice: d.choice,
        probabilities: JSON.stringify(d.probabilities),
        confidence: d.confidence,
        source: d.source,
        summary: d.summary,
      });
    // Keep only the newest 50.
    this.db.exec(`
      DELETE FROM decisions WHERE id NOT IN (
        SELECT id FROM decisions ORDER BY at DESC LIMIT 50
      )
    `);
  }

  /** Deletes the decisions of these kinds. Returns how many. */
  deleteDecisionsOfKinds(kinds: readonly DecisionKind[]): number {
    if (kinds.length === 0) return 0;
    return this.db.prepare(`DELETE FROM decisions WHERE kind IN (${kinds.map(() => "?").join(",")})`).run(...kinds).changes;
  }

  listDecisions(limit = 50): JevDecision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      at: r.at as string,
      kind: r.kind as DecisionKind,
      subjects: JSON.parse(r.subjects as string) as string[],
      choice: r.choice as string,
      probabilities: JSON.parse(r.probabilities as string) as Record<string, number>,
      confidence: r.confidence as number,
      source: r.source as "jev" | "rules",
      summary: r.summary as string,
    }));
  }

  // ── day_tokens (local-date token bucket, so "tokens today" never rescans) ──

  bumpDayTokens(date: string, delta: number): void {
    if (delta === 0) return;
    this.db
      .prepare(
        `INSERT INTO day_tokens (date, tokens) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET tokens = tokens + excluded.tokens`,
      )
      .run(date, delta);
  }

  getDayTokens(date: string): number {
    const row = this.db.prepare(`SELECT tokens FROM day_tokens WHERE date = ?`).get(date) as
      | { tokens: number }
      | undefined;
    return row?.tokens ?? 0;
  }

  // ── meta (small persisted counters) ─────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    cwd: row.cwd as string,
    islandId: row.island_id as string,
    targetIslandId: row.target_island_id as string,
    roamTicksLeft: row.roam_ticks_left as number,
    title: row.title as string,
    startedAt: row.started_at as string,
    lastActive: row.last_active as string,
    jsonlMtime: row.jsonl_mtime as number,
    messageCount: row.message_count as number,
    model: (row.model as string | null) ?? null,
    cntEdit: row.cnt_edit as number,
    cntResearch: row.cnt_research as number,
    cntBash: row.cnt_bash as number,
    cntTextOnly: row.cnt_text_only as number,
    cntAssistantTotal: row.cnt_assistant_total as number,
    tokens: (row.tokens as number | null) ?? 0,
    lastLineKind: ((row.last_line_kind as string | null) ?? "user") as LastLineKind,
    lastToolName: (row.last_tool_name as string | null) ?? null,
    lastTextIsQuestion: Boolean(row.last_text_is_question),
    lastUsageMessageId: (row.last_usage_message_id as string | null) ?? null,
    customTitle: (row.custom_title as string | null | undefined) ?? null,
    aiTitle: (row.ai_title as string | null | undefined) ?? null,
  };
}
