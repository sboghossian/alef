// The subagents feature's own small sqlite file (data/subagents.db next to world.db), so
// the hub schema in server/db.ts stays untouched. Holds per-file byte offsets, each
// subagent's folded state (as JSON), parent reports and stops, and nested-spawn links. Deleting the
// file forces a full rebuild from the source transcripts, which are only ever read.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ParentReport, ParentStop, SubagentState } from "./fold.js";

export interface OffsetRow {
  size: number;
  mtime: number;
  offset: number;
}

export class SubagentStore {
  private readonly db: Database.Database;
  readonly states = new Map<string, SubagentState>();
  readonly reports = new Map<string, ParentReport>();
  /** Parent session id → the stops seen in its transcript (TaskStops, user interrupts). */
  readonly stops = new Map<string, ParentStop[]>();
  /** Agent tool_use id → subagent id that made the call (nested spawns). */
  readonly spawnOwner = new Map<string, string>();
  private readonly offsets = new Map<string, OffsetRow>();
  private readonly metaRows = new Map<string, string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sa_offsets (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, byte_offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sa_state (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sa_reports (agent_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sa_spawns (tool_use_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sa_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sa_stops (parent_session_id TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, PRIMARY KEY (parent_session_id, at, by));
    `);
    for (const r of this.db.prepare("SELECT parent_session_id AS parent, at, by FROM sa_stops").all() as Array<{ parent: string; at: string; by: string }>) {
      if (r.by === "user" || r.by === "task") this.addStop(r.parent, { at: r.at, by: r.by });
    }
    for (const r of this.db.prepare("SELECT key, value FROM sa_meta").all() as Array<{ key: string; value: string }>) this.metaRows.set(r.key, r.value);
    for (const r of this.db.prepare("SELECT path, size, mtime, byte_offset AS offset FROM sa_offsets").all() as Array<OffsetRow & { path: string }>) {
      this.offsets.set(r.path, { size: r.size, mtime: r.mtime, offset: r.offset });
    }
    for (const r of this.db.prepare("SELECT id, json FROM sa_state").all() as Array<{ id: string; json: string }>) {
      try {
        this.states.set(r.id, JSON.parse(r.json) as SubagentState);
      } catch {
        /* a garbled row is skipped; deleting subagents.db rebuilds everything */
      }
    }
    for (const r of this.db.prepare("SELECT agent_id, json FROM sa_reports").all() as Array<{ agent_id: string; json: string }>) {
      try {
        this.reports.set(r.agent_id, JSON.parse(r.json) as ParentReport);
      } catch {
        /* ignore */
      }
    }
    for (const r of this.db.prepare("SELECT tool_use_id, owner_id FROM sa_spawns").all() as Array<{ tool_use_id: string; owner_id: string }>) {
      this.spawnOwner.set(r.tool_use_id, r.owner_id);
    }
  }

  offset(path: string): OffsetRow | undefined {
    return this.offsets.get(path);
  }

  private addStop(parent: string, s: ParentStop): void {
    const list = this.stops.get(parent) ?? [];
    if (!list.some((x) => x.at === s.at && x.by === s.by)) list.push(s);
    this.stops.set(parent, list);
  }

  /** A small key → value flag (e.g. the parent fold version), undefined until first committed. */
  meta(key: string): string | undefined {
    return this.metaRows.get(key);
  }

  /** Persists everything touched in one pass in a single transaction (meta rows last). */
  commit(changes: {
    offsets: Map<string, OffsetRow>;
    states: Iterable<SubagentState>;
    reports: Iterable<ParentReport>;
    spawns: Iterable<[string, string]>;
    /** [parent session id, stop] pairs; a stop already stored is ignored. */
    stops?: Iterable<[string, ParentStop]>;
    meta?: Iterable<[string, string]>;
  }): void {
    const upOffset = this.db.prepare(
      "INSERT INTO sa_offsets (path, size, mtime, byte_offset) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, byte_offset = excluded.byte_offset",
    );
    const upState = this.db.prepare("INSERT INTO sa_state (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json");
    const upReport = this.db.prepare("INSERT INTO sa_reports (agent_id, json) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json");
    const upSpawn = this.db.prepare("INSERT INTO sa_spawns (tool_use_id, owner_id) VALUES (?, ?) ON CONFLICT(tool_use_id) DO UPDATE SET owner_id = excluded.owner_id");
    const upMeta = this.db.prepare("INSERT INTO sa_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const upStop = this.db.prepare("INSERT OR IGNORE INTO sa_stops (parent_session_id, at, by) VALUES (?, ?, ?)");
    const stops = [...(changes.stops ?? [])];
    const meta = [...(changes.meta ?? [])];
    const tx = this.db.transaction(() => {
      for (const [path, o] of changes.offsets) {
        upOffset.run(path, o.size, o.mtime, o.offset);
        this.offsets.set(path, o);
      }
      for (const s of changes.states) {
        upState.run(s.id, JSON.stringify(s));
        this.states.set(s.id, s);
      }
      for (const r of changes.reports) {
        upReport.run(r.agentId, JSON.stringify(r));
        this.reports.set(r.agentId, r);
      }
      for (const [toolUseId, owner] of changes.spawns) {
        upSpawn.run(toolUseId, owner);
        this.spawnOwner.set(toolUseId, owner);
      }
      for (const [parent, s] of stops) upStop.run(parent, s.at, s.by);
      for (const [key, value] of meta) upMeta.run(key, value);
    });
    tx();
    // The in-memory copy follows the commit only once it succeeded.
    for (const [parent, s] of stops) this.addStop(parent, s);
    for (const [key, value] of meta) this.metaRows.set(key, value);
  }

  close(): void {
    this.db.close();
  }
}

/** data/subagents.db beside the world db (":memory:" stays in memory). */
export function storePathFor(worldDbPath: string): string {
  return worldDbPath === ":memory:" ? ":memory:" : join(dirname(worldDbPath), "subagents.db");
}
