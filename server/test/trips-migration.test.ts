// The one-time honest-trips cleanup against LOOP.md's data-migration rule: backup first, one
// transaction with the flag last, converges after a crash (tested on a copy), a failed backup
// changes nothing, a rerun is a no-op. The seeded rows have the live world.db's shapes: agent<->agent
// `visited` pairs, pair/roam decisions, dormant roamers, touched file edges across islands.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, WorldDb } from "../db.js";
import { HONEST_TRIPS_FLAG, runHonestTripsMigration, TRIPS_CURSOR_KEY } from "../trips-migration.js";
import type { JevDecision } from "../../shared/types.js";
import { makeTempProjectsDir } from "./helpers.js";

const HOME = "/ws-home";
const NOW = () => new Date("2026-09-28T04:00:00.000Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const dirs: string[] = [];
const dbs: WorldDb[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function open(path: string): WorldDb {
  const db = new WorldDb(openDb(path));
  dbs.push(db);
  return db;
}

function decision(id: string, kind: JevDecision["kind"], at: string): JevDecision {
  return { id, at, kind, subjects: [A], choice: "x", probabilities: { x: 1 }, confidence: 1, source: "rules", summary: `${kind} ${id}` };
}

/** A db shaped like the live one before this change. */
async function legacyDb(): Promise<{ db: WorldDb; dir: string }> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const db = open(join(dir, "world.db"));
  db.setIslandForCwd("/ws/a", "island-a");
  db.setIslandForCwd("/ws/b", "island-b");
  for (const [id, cwd, island] of [[A, "/ws/a", "island-a"], [B, "/ws/b", "island-b"]] as const) {
    db.upsertSession({ id, cwd, islandId: island, startedAt: "2026-09-27T00:00:00.000Z", lastActive: "2026-09-27T00:00:00.000Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 1, cntAssistantTotalDelta: 1 });
  }
  // What Jev's pair/roam left behind: both agents dormant yet "visiting", a road between them.
  db.setTarget(A, "island-b", 2);
  db.setTarget(B, "island-a", 3);
  db.upsertEdge({ from: A, to: B, kind: "visited", at: "2026-09-28T03:00:00.000Z" });
  db.upsertEdge({ from: B, to: A, kind: "visited", at: "2026-09-28T03:00:00.000Z" });
  // Real work: A edited two files in island-b's folder, B only its own.
  db.upsertEdge({ from: A, to: "file:/ws/b/x.ts", kind: "touched", at: "2026-09-27T10:00:00.000Z" });
  db.upsertEdge({ from: A, to: "file:/ws/b/y.ts", kind: "touched", at: "2026-09-27T11:00:00.000Z", weightDelta: 2 });
  db.upsertEdge({ from: B, to: "file:/ws/b/x.ts", kind: "touched", at: "2026-09-27T12:00:00.000Z" });
  db.upsertEdge({ from: A, to: "skill:humanizer", kind: "uses", at: "2026-09-27T09:00:00.000Z" });
  db.insertDecision(decision("d-pair", "pair", "2026-09-28T03:00:00.000Z"));
  db.insertDecision(decision("d-roam", "roam", "2026-09-28T03:01:00.000Z"));
  db.insertDecision(decision("d-grow", "grow", "2026-09-28T03:02:00.000Z"));
  db.setMeta("roam_cursor", "322");
  return { db, dir };
}

function state(db: WorldDb): unknown {
  return {
    edges: db.listEdges().sort((x, y) => `${x.kind}|${x.from}|${x.to}`.localeCompare(`${y.kind}|${y.from}|${y.to}`)),
    decisions: db.listDecisions().map((d) => d.id),
    sessions: db.listSessions().map((s) => [s.id, s.islandId, s.targetIslandId, s.roamTicksLeft]).sort(),
    flag: db.getMeta(HONEST_TRIPS_FLAG),
    cursor: db.getMeta(TRIPS_CURSOR_KEY),
    roamCursor: db.getMeta("roam_cursor"),
  };
}

const baks = async (dir: string) => (await readdir(dir)).filter((f) => f.includes(".pre-honest-trips-"));

describe("runHonestTripsMigration", () => {
  it("backs up, then deletes only visited edges and pair/roam decisions, sends everyone home, derives real visits, flag last", async () => {
    const { db, dir } = await legacyDb();

    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: NOW })).toBe("migrated");

    expect(await baks(dir)).toEqual(["world.db.pre-honest-trips-2026-09-28T04-00-00.000Z.bak"]);
    const backup = open(join(dir, "world.db.pre-honest-trips-2026-09-28T04-00-00.000Z.bak"));
    expect(backup.listEdges().filter((e) => e.kind === "visited")).toHaveLength(2); // the old rows are recoverable

    const edges = db.listEdges();
    expect(edges.filter((e) => e.kind === "visited")).toEqual([{ from: A, to: "island-b", kind: "visited", weight: 3, at: "2026-09-27T11:00:00.000Z" }]);
    expect(edges.filter((e) => e.kind === "touched")).toHaveLength(3); // untouched
    expect(edges.filter((e) => e.kind === "uses")).toHaveLength(1);
    expect(db.listDecisions().map((d) => d.kind)).toEqual(["grow"]);
    for (const s of db.listSessions()) expect([s.targetIslandId, s.roamTicksLeft]).toEqual([s.islandId, 0]);
    expect(db.getMeta(HONEST_TRIPS_FLAG)).toBe("1");
    expect(db.getMeta(TRIPS_CURSOR_KEY)).toBe("2026-09-27T12:00:00.000Z");
    expect(db.getMeta("roam_cursor")).toBe("322"); // other meta untouched
  });

  it("a crash between the backup and the transaction changes nothing, and a rerun converges (on a copy)", async () => {
    const { db, dir } = await legacyDb();
    await db.backupTo(join(dir, "copy-crash.db"));
    await db.backupTo(join(dir, "copy-clean.db"));
    const crashed = open(join(dir, "copy-crash.db"));
    const clean = open(join(dir, "copy-clean.db"));
    const before = state(crashed);

    await expect(
      runHonestTripsMigration(crashed, { homeDir: HOME, now: NOW, beforeCommit: () => { throw new Error("killed"); } }),
    ).rejects.toThrow("killed");
    expect(state(crashed)).toEqual(before); // flag unset, legacy rows still there
    expect((await baks(dir)).filter((f) => f.startsWith("copy-crash"))).toHaveLength(1);

    expect(await runHonestTripsMigration(crashed, { homeDir: HOME, now: () => new Date("2026-09-28T05:00:00.000Z") })).toBe("migrated");
    expect((await baks(dir)).filter((f) => f.startsWith("copy-crash"))).toHaveLength(1); // no second backup
    expect(await runHonestTripsMigration(clean, { homeDir: HOME, now: NOW })).toBe("migrated");
    expect(state(crashed)).toEqual(state(clean));
  });

  it("a failed backup leaves no flag and deletes nothing, and is not retried until the next boot", async () => {
    const { db, dir } = await legacyDb();
    const before = state(db);
    const backup = vi.spyOn(db, "backupTo").mockRejectedValue(new Error("ENOSPC"));

    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: NOW })).toBe("skipped");
    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: NOW })).toBe("skipped");
    expect(backup).toHaveBeenCalledTimes(1);
    expect(state(db)).toEqual(before);
    expect(db.getMeta(HONEST_TRIPS_FLAG)).toBeNull();

    backup.mockRestore();
    const nextBoot = open(join(dir, "world.db"));
    expect(await runHonestTripsMigration(nextBoot, { homeDir: HOME, now: NOW })).toBe("migrated");
  });

  it("a fresh db with nothing invented skips the backup and still derives its visits", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = open(join(dir, "world.db"));
    db.setIslandForCwd("/ws/a", "island-a");
    db.setIslandForCwd("/ws/b", "island-b");
    db.upsertSession({ id: A, cwd: "/ws/a", islandId: "island-a", startedAt: "2026-09-27T00:00:00.000Z", lastActive: "2026-09-27T00:00:00.000Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 1, cntAssistantTotalDelta: 1 });
    db.upsertEdge({ from: A, to: "file:/ws/b/x.ts", kind: "touched", at: "2026-09-27T10:00:00.000Z" });
    const backup = vi.spyOn(db, "backupTo");

    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: NOW })).toBe("migrated");
    expect(backup).not.toHaveBeenCalled();
    expect(await baks(dir)).toEqual([]);
    expect(db.listEdges().filter((e) => e.kind === "visited").map((e) => [e.from, e.to])).toEqual([[A, "island-b"]]);
    expect(db.getMeta(HONEST_TRIPS_FLAG)).toBe("1");
  });

  it("a rerun after success is a no-op: no backup, no writes", async () => {
    const { db, dir } = await legacyDb();
    await runHonestTripsMigration(db, { homeDir: HOME, now: NOW });
    const after = state(db);
    const backup = vi.spyOn(db, "backupTo");

    expect(await runHonestTripsMigration(db, { homeDir: HOME, now: () => new Date("2026-09-29T00:00:00.000Z") })).toBe("already");
    expect(backup).not.toHaveBeenCalled();
    expect(state(db)).toEqual(after);
    expect(await baks(dir)).toHaveLength(1);
  });
});
