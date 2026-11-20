// Verifies the one-time reindex migration: when tokens/last-line columns are added
// to a pre-existing sessions table (i.e., a data/world.db from before this feature
// existed), openDb() must wipe the derived index so the next indexer pass rebuilds
// it from source jsonl — otherwise a pre-existing install reports 0 tokens and wrong
// awaitingInput forever for every session it had already fully consumed.

import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { openDb, WorldDb } from "../db.js";
import { makeTempProjectsDir } from "./helpers.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Builds a sessions/file_offsets pair shaped like the schema from before tokens/
 *  last-line tracking existed, with one already-fully-indexed row in each — the
 *  exact situation a pre-existing data/world.db is in. */
async function makeOldSchemaDb(): Promise<string> {
  const dir = await makeTempProjectsDir();
  tmpDirs.push(dir);
  const path = join(dir, "world.db");
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE sessions (
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
    CREATE TABLE file_offsets (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      byte_offset INTEGER NOT NULL,
      malformed_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  raw
    .prepare(
      `INSERT INTO sessions (id, cwd, island_id, target_island_id, title, started_at, last_active, message_count)
       VALUES ('old-session', '/ws/old-project', 'old-project', 'old-project', 'pre-existing', '2026-09-20T00:00:00.000Z', '2026-09-24T00:00:00.000Z', 5)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO file_offsets (path, size, mtime, byte_offset) VALUES ('/ws/old-project/old-session.jsonl', 500, 12345, 500)`,
    )
    .run();
  raw.close();
  return path;
}

describe("openDb: one-time reindex on schema upgrade", () => {
  it("wipes sessions/file_offsets (forcing a full reindex) the first time the new columns are added", async () => {
    const path = await makeOldSchemaDb();

    const db = openDb(path);
    const sessionsLeft = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    const offsetsLeft = db.prepare(`SELECT COUNT(*) AS n FROM file_offsets`).get() as { n: number };
    expect(sessionsLeft.n).toBe(0);
    expect(offsetsLeft.n).toBe(0);

    // The new columns exist and behave (default 'user' / 0 / null), proving this is a
    // real schema upgrade in place, not a fresh empty db that merely lacks rows.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("tokens");
    expect(names).toContain("last_line_kind");
    expect(names).toContain("last_tool_name");
    expect(names).toContain("last_text_is_question");
    expect(names).toContain("last_usage_message_id");

    db.close();
  });

  it("does not wipe again on a second boot once the columns already exist", async () => {
    const path = await makeOldSchemaDb();

    const db1 = new WorldDb(openDb(path)); // first boot: migrates + wipes
    db1.setIslandForCwd("/ws/new-project", "new-project");
    db1.upsertSession({
      id: "new-session",
      cwd: "/ws/new-project",
      islandId: "new-project",
      title: "post-migration session",
      startedAt: "2026-09-24T00:00:00.000Z",
      lastActive: "2026-09-24T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
      tokensDelta: 42,
    });
    db1.close();

    const db2 = new WorldDb(openDb(path)); // second boot: columns already exist, must not wipe
    const session = db2.getSession("new-session");
    expect(session).not.toBeNull();
    expect(session?.tokens).toBe(42);
    db2.close();
  });
});

describe("honest-trips helpers", () => {
  async function freshDb(): Promise<WorldDb> {
    const dir = await makeTempProjectsDir();
    tmpDirs.push(dir);
    const db = new WorldDb(openDb(join(dir, "world.db")));
    db.setIslandForCwd("/ws/a", "island-a");
    for (const id of ["s-1", "s-2"]) {
      db.upsertSession({ id, cwd: "/ws/a", islandId: "island-a", startedAt: "2026-09-27T00:00:00.000Z", lastActive: "2026-09-27T00:00:00.000Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 1, cntAssistantTotalDelta: 1 });
    }
    return db;
  }

  it("putEdge writes the exact weight and time (no accumulation), deleteEdge drops one row", async () => {
    const db = await freshDb();
    db.putEdge({ from: "s-1", to: "island-b", kind: "visited", weight: 3, at: "2026-09-27T10:00:00.000Z" });
    db.putEdge({ from: "s-1", to: "island-b", kind: "visited", weight: 2, at: "2026-09-27T09:00:00.000Z" });
    expect(db.listEdges()).toEqual([{ from: "s-1", to: "island-b", kind: "visited", weight: 2, at: "2026-09-27T09:00:00.000Z" }]);
    db.deleteEdge("s-1", "island-b", "visited");
    expect(db.listEdges()).toEqual([]);
    db.close();
  });

  it("deleteEdgesOfKind and deleteDecisionsOfKinds delete only the kinds named", async () => {
    const db = await freshDb();
    db.upsertEdge({ from: "s-1", to: "s-2", kind: "visited", at: "2026-09-27T10:00:00.000Z" });
    db.upsertEdge({ from: "s-1", to: "file:/ws/a/x.ts", kind: "touched", at: "2026-09-27T10:00:00.000Z" });
    db.upsertEdge({ from: "s-1", to: "skill:humanizer", kind: "uses", at: "2026-09-27T10:00:00.000Z" });
    for (const kind of ["pair", "roam", "grow"] as const) {
      db.insertDecision({ id: `d-${kind}`, at: "2026-09-27T10:00:00.000Z", kind, subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: kind });
    }
    expect(db.deleteEdgesOfKind("visited")).toBe(1);
    expect(db.listEdges().map((e) => e.kind).sort()).toEqual(["touched", "uses"]);
    expect(db.deleteDecisionsOfKinds(["pair", "roam"])).toBe(2);
    expect(db.deleteDecisionsOfKinds([])).toBe(0);
    expect(db.listDecisions().map((d) => d.kind)).toEqual(["grow"]);
    db.close();
  });

  it("sendHome and resetAllRoamers snap target back to home and zero the roam ticks", async () => {
    const db = await freshDb();
    db.setTarget("s-1", "island-b", 3);
    db.setTarget("s-2", "island-c", 1);
    db.sendHome("s-1");
    expect(db.getSession("s-1")).toMatchObject({ targetIslandId: "island-a", roamTicksLeft: 0 });
    expect(db.getSession("s-2")).toMatchObject({ targetIslandId: "island-c", roamTicksLeft: 1 });
    expect(db.resetAllRoamers()).toBe(1);
    expect(db.resetAllRoamers()).toBe(0);
    expect(db.getSession("s-2")).toMatchObject({ targetIslandId: "island-a", roamTicksLeft: 0 });
    db.close();
  });
});
