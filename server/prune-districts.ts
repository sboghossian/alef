// One-time prune of empty districts (directed 2026-10-14). Until the indexer fix of that day, every
// incremental pass of a session minted an island for the cwd its first line carried, which is
// wherever the shell had `cd`'d to (~/justinian-direction/gov5, ~/gainable-gtm/teardown…), and put
// that pass's files there. No session ever sat on those islands, yet each was served as a city
// and counted as a district (trust-targets said "71 of 104"). This pass:
//
//   1. remaps sessions onto their canonical repo's island under today's rules (canonical-repo.ts:
//      subfolders, worktrees, gone loop worktrees ~/.alef-worktrees/<slug>/… → agent-world);
//   2. empties every island no session sits on whose folder is not a repo root of its own:
//        folds-into-repo  its folder resolves to another repo root → aliased to that root's island,
//                         its objects moved there (canonical-backfill.ts's shape);
//        loose            a non-repo, deleted or privacy-guarded folder → each object goes to the
//                         island of the session that touched it last (where the fixed indexer
//                         would put it); an object no session reaches stays where it is.
//      A repo root with no sessions (aleph: 66 fossils) keeps its island and objects: it has
//      history, and the client already shows it only while fossils sit on it (archive-lib.ts).
//
// Nothing is deleted: no session, transcript, edge, object or cwd_islands row. An emptied island
// simply stops being served (the snapshot serves islands that agents or objects sit on).
//
// SAFETY (LOOP.md data-migration rule): db.backup() once before the first write, then every write
// and the done flag in ONE transaction, the flag last. Every decision is read from db state + the
// file system, so a rerun after a crash (nothing committed) or after success (nothing left to
// move) converges on the same result.

import { readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MUSEUM_ISLAND_ID } from "../shared/features/artifacts.js";
import { createCanonicalRepoResolver, dbLoopProof, ensureIslandForCwd, ownRepoRoot, type CanonicalRepoResolver } from "./canonical-repo.js";
import type { WorldDb } from "./db.js";
import { isCatchAllCwd } from "./home-placement.js";
import { log } from "./log.js";

export const PRUNE_DONE_KEY = "EXAMPLE-FAKE-0";
export const PRUNE_BACKUP_KEY = "prune_districts_backup";

export type IslandClass = "system" | "live" | "repo" | "folds-into-repo" | "loose";

export interface IslandVerdict {
  islandId: string;
  cwd: string | null;
  cls: IslandClass;
  /** folds-into-repo: the repo root it folds into. */
  root: string | null;
}

/** Why each island the world knows exists (read-only; fs only through `resolver`). */
export function classifyIslands(db: WorldDb, homeDir: string, resolver: CanonicalRepoResolver): IslandVerdict[] {
  const withSessions = db.listSessionIslandIds();
  return db
    .listIslandIds()
    .sort()
    .map((islandId): IslandVerdict => {
      const cwd = db.getIslandCwd(islandId);
      if (islandId === "harness" || islandId === MUSEUM_ISLAND_ID) return { islandId, cwd, cls: "system", root: null };
      if (withSessions.has(islandId)) return { islandId, cwd, cls: "live", root: null };
      const root = cwd && !isCatchAllCwd(cwd, homeDir) ? resolver.rootOf(cwd) : null;
      if (root && root === cwd) return { islandId, cwd, cls: "repo", root: null };
      if (root) return { islandId, cwd, cls: "folds-into-repo", root };
      return { islandId, cwd, cls: "loose", root: null };
    });
}

export interface PruneResult {
  ran: boolean;
  sessionsRemapped: number;
  objectsMoved: number;
  islandsBefore: number;
  islandsAfter: number;
}

export interface PruneOptions {
  resolver?: CanonicalRepoResolver;
  /** Test seam: runs inside the transaction, after every write and before the flag. */
  beforeCommit?: () => void;
}

/** Step 1: every non-catch-all session onto its canonical repo's island. Returns sessions moved. */
function remapSessions(db: WorldDb, homeDir: string, resolver: CanonicalRepoResolver): number {
  let moved = 0;
  for (const s of db.listSessions()) {
    if (isCatchAllCwd(s.cwd, homeDir)) continue; // home-placement.ts owns those
    const root = resolver.rootOf(s.cwd);
    if (!root || root === s.cwd) continue;
    const target = ensureIslandForCwd(db, root);
    if (db.getIslandForCwd(s.cwd) !== target) db.aliasCwdToRoot(s.cwd, root, target);
    if (s.islandId !== target) {
      db.setSessionIslandId(s.id, target);
      moved++;
    }
  }
  return moved;
}

/** Step 2: empties folds-into-repo and loose islands. Returns objects moved. */
function emptyPhantoms(db: WorldDb, homeDir: string, resolver: CanonicalRepoResolver): number {
  let moved = 0;
  for (const v of classifyIslands(db, homeDir, resolver)) {
    if (v.cls === "folds-into-repo" && v.cwd && v.root) {
      const target = ensureIslandForCwd(db, v.root);
      if (target === v.islandId) continue;
      db.aliasCwdToRoot(v.cwd, v.root, target);
      moved += db.objectsWithLatestToucher(v.islandId).length;
      db.moveIslandObjects(v.islandId, target);
    } else if (v.cls === "loose") {
      for (const o of db.objectsWithLatestToucher(v.islandId)) {
        if (!o.toucherIslandId || o.toucherIslandId === v.islandId) continue;
        db.setObjectIsland(o.id, o.toucherIslandId);
        moved++;
      }
    }
  }
  return moved;
}

/** The one-time prune (see the header). Safe to call on every boot: flagged runs are no-ops. */
export async function runPruneDistricts(db: WorldDb, homeDir: string, opts: PruneOptions = {}): Promise<PruneResult> {
  const islandsBefore = db.listIslandIds().length;
  const skipped: PruneResult = { ran: false, sessionsRemapped: 0, objectsMoved: 0, islandsBefore, islandsAfter: islandsBefore };
  if (db.getMeta(PRUNE_DONE_KEY) === "1") return skipped;
  // Its own resolver: a gone loop worktree folds into agent-world only with proof, and here the
  // db can give it (a cwd under that slug already on agent-world's island; dbLoopProof).
  const ownRoot = ownRepoRoot(homeDir);
  const resolver = opts.resolver ?? createCanonicalRepoResolver(homeDir, { loop: ownRoot ? { root: ownRoot, proof: dbLoopProof(db, ownRoot) } : null });

  const file = db.filePath();
  if (file && db.getMeta(PRUNE_BACKUP_KEY) === null) {
    const prefix = `${basename(file)}.pre-prune-districts-`;
    // A backup an earlier boot wrote but couldn't record (the meta write hit SQLITE_BUSY): reuse
    // it, so a db that stays busy doesn't gain a fresh full copy every boot.
    const earlier = (await readdir(dirname(file)).catch(() => [] as string[])).filter((f) => f.startsWith(prefix) && f.endsWith(".bak")).sort()[0];
    const dest = join(dirname(file), earlier ?? `${prefix}${new Date().toISOString().replace(/:/g, "-")}.bak`);
    try {
      // Written beside, renamed once complete: a backup cut short by a crash is never reused.
      if (!earlier) {
        await db.backupTo(`${dest}.partial`);
        await rename(`${dest}.partial`, dest);
      }
    } catch (err) {
      // No backup, no migration: skip it this boot (read-only dir, full disk…) and retry next boot.
      log.warn("prune-districts", `could not back up the db first; skipping the prune this boot: ${String(err)}`);
      return skipped;
    }
    db.setMeta(PRUNE_BACKUP_KEY, dest);
    log.info("prune-districts", `${earlier ? "reusing the backup taken" : "backed up the db"} before pruning empty districts: ${dest}`);
  }

  const counts = db.transaction(() => {
    const sessionsRemapped = remapSessions(db, homeDir, resolver);
    const objectsMoved = emptyPhantoms(db, homeDir, resolver);
    opts.beforeCommit?.();
    db.setMeta(PRUNE_DONE_KEY, "1");
    return { sessionsRemapped, objectsMoved };
  });
  const islandsAfter = db.listIslandIds().length;
  log.info("prune-districts", `pruned empty districts: ${islandsBefore} → ${islandsAfter} islands, ${counts.sessionsRemapped} sessions remapped, ${counts.objectsMoved} objects moved`);
  return { ran: true, ...counts, islandsBefore, islandsAfter };
}
