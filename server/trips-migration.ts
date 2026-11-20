// One-time cleanup for honest trips (trips-lib.ts). Until now the director sent DORMANT agents to
// visit each other (Jev's "pair" and "roam" questions): their planes flew, `visited` edges joined
// two agents and drew a road between their cities, and each move went on the feed as a decision.
// None of those visits happened. This run removes them and replaces them with the visits the
// touched edges prove.
//
// Safety invariant: it deletes only edges of kind 'visited' and decisions of kind 'pair' or 'roam',
// and it resets only the roam columns (roam_ticks_left, target_island_id). When any such row exists,
// the db is backed up first (WAL-safe) to `<db>.pre-honest-trips-<ISO>.bak`; no backup, no migration
// this boot. A db with none of them (a fresh install) has nothing to lose, so it skips the backup.
// Every write and the flag commit in ONE transaction, the flag last, and everything it writes is
// recomputed from DB state, so a rerun after a crash converges and a rerun after success is a no-op.

import { basename, dirname, join } from "node:path";
import { defaultCanonicalResolver } from "./canonical-repo.js";
import type { EdgeRow, WorldDb } from "./db.js";
import { log } from "./log.js";
import { deriveVisits, newestTouch, type VisitEdge } from "./trips-lib.js";

export const HONEST_TRIPS_FLAG = "honest_trips_v1";
export const TRIPS_CURSOR_KEY = "trips_scanned_at";
const BACKUP_META_KEY = "honest_trips_backup";

/** Dbs whose backup failed in this process: skipped until the next boot, not retried every tick. */
const skippedThisBoot = new WeakSet<WorldDb>();

export interface TripsMigrationOptions {
  homeDir: string;
  now?: () => Date;
  /** Test seam: runs after the backup, before the transaction (a crash there must converge). */
  beforeCommit?: () => void;
}

export type TripsMigrationResult = "already" | "skipped" | "migrated";

/** The visits `edges` prove, against the sessions' current home islands and the island roots
 *  (plus the cached canonical-repo lookup for home-dir paths, pure fs, see canonical-repo.ts). */
export function visitsFromDb(db: WorldDb, edges: readonly EdgeRow[], homeDir: string): VisitEdge[] {
  const sessions = new Map(db.listSessions().map((s) => [s.id, s]));
  const canonical = defaultCanonicalResolver(homeDir);
  return deriveVisits(edges, sessions, db.listIslandSlugs(), homeDir, (dir) => canonical.rootOf(dir));
}

/** True when the cleanup would delete or reset anything (so it needs a backup first). */
function hasInventedTrips(db: WorldDb): boolean {
  return (
    db.listEdges().some((e) => e.kind === "visited") ||
    db.listDecisions().some((d) => d.kind === "pair" || d.kind === "roam") ||
    db.listSessions().some((s) => s.targetIslandId !== s.islandId || s.roamTicksLeft !== 0)
  );
}

export async function runHonestTripsMigration(db: WorldDb, opts: TripsMigrationOptions): Promise<TripsMigrationResult> {
  if (db.getMeta(HONEST_TRIPS_FLAG) === "1") return "already";
  if (skippedThisBoot.has(db)) return "skipped";
  const now = opts.now ?? (() => new Date());

  const file = db.filePath();
  if (file && db.getMeta(BACKUP_META_KEY) === null && hasInventedTrips(db)) {
    const dest = join(dirname(file), `${basename(file)}.pre-honest-trips-${now().toISOString().replace(/:/g, "-")}.bak`);
    try {
      await db.backupTo(dest);
    } catch (err) {
      skippedThisBoot.add(db);
      log.warn("trips", `could not back up the db before the honest-trips cleanup; skipping it this boot: ${String(err)}`);
      return "skipped";
    }
    db.setMeta(BACKUP_META_KEY, dest);
    log.info("trips", `backed up the db before the honest-trips cleanup: ${dest}`);
  }
  opts.beforeCommit?.();

  const counts = db.transaction(() => {
    const edgesDeleted = db.deleteEdgesOfKind("visited");
    const decisionsDeleted = db.deleteDecisionsOfKinds(["pair", "roam"]);
    const sentHome = db.resetAllRoamers();
    const edges = db.listEdges();
    const visits = visitsFromDb(db, edges, opts.homeDir);
    for (const v of visits) db.putEdge(v);
    const cursor = newestTouch(edges);
    if (cursor !== null) db.setMeta(TRIPS_CURSOR_KEY, cursor);
    db.setMeta(HONEST_TRIPS_FLAG, "1");
    return { edgesDeleted, decisionsDeleted, sentHome, visits: visits.length };
  });
  log.info(
    "trips",
    `honest trips: removed ${counts.edgesDeleted} invented visit edge(s) and ${counts.decisionsDeleted} pair/roam decision(s), sent ${counts.sentHome} agent(s) home, derived ${counts.visits} real visit(s) from touched files`,
  );
  return "migrated";
}
