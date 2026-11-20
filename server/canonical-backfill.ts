// One-time catch-up for canonical repos (canonical-repo.ts), mirroring home-placement.ts's own
// backfill: sessions indexed before districts followed the canonical repo are moved in one pass.

import { join, dirname, basename } from "node:path";
import { defaultCanonicalResolver, ensureIslandForCwd, type CanonicalRepoResolver } from "./canonical-repo.js";
import type { WorldDb } from "./db.js";
import type { GitRootResolver } from "./features/code-repos.js";
import { defaultGitRootResolver, isCatchAllCwd, placeByTouchedFiles } from "./home-placement.js";
import { log } from "./log.js";

const BACKFILL_META_KEY = "canonical_repo_backfilled";
const BACKUP_META_KEY = "canonical_repo_backup";

export interface CanonicalBackfillOptions {
  resolver?: CanonicalRepoResolver;
  gitRoots?: GitRootResolver;
  /** Test seam: runs between the async placement phase and the final transaction. */
  beforeCommit?: () => void;
}

/**
 * Island ids to vacate, read from DB STATE (never from what this run happened to change): the
 * island an alias cwd had before, once no cwd owns it and no session sits on it, and where its
 * objects go (that cwd's island now). A rerun after a crash finds exactly the same set.
 */
function vacatedIslands(db: WorldDb): Map<string, string> {
  const owned = new Set(db.listIslandSlugs().values());
  const withSessions = new Set(db.listSessions().map((s) => s.islandId));
  const out = new Map<string, string>();
  for (const a of db.listCwdAliases()) {
    if (!a.prevIslandId || !a.islandId || a.prevIslandId === a.islandId) continue;
    if (owned.has(a.prevIslandId) || withSessions.has(a.prevIslandId)) continue;
    out.set(a.prevIslandId, a.islandId);
  }
  return out;
}

/**
 * One-time catch-up for islands assigned before canonical repos existed: every cwd_islands row
 * whose cwd is a worktree or a subfolder is repointed at its canonical repo's island, sessions
 * follow their cwd, and the objects of an island left with no cwd and no session move with it (so
 * the vacated island stops being drawn). Catch-all sessions are re-placed by home-placement.ts,
 * which now also canonicalizes. A cwd whose directory is gone and can't be inferred keeps its
 * island.
 *
 * Crash-safe: the async placement phase is idempotent, and every other write plus the meta flag
 * commit in ONE transaction, the flag last — an interrupted run leaves the flag unset and the next
 * boot converges to the same state. Before the first attempt, the db is backed up once (WAL-safe)
 * to `world.db.pre-canonical-<ISO>.bak` next to it.
 */
export async function runCanonicalRepoBackfill(db: WorldDb, homeDir: string, opts: CanonicalBackfillOptions = {}): Promise<void> {
  if (db.getMeta(BACKFILL_META_KEY) === "1") return;
  const resolver = opts.resolver ?? defaultCanonicalResolver(homeDir);
  const gitRoots = opts.gitRoots ?? defaultGitRootResolver;

  const file = db.filePath();
  if (file && db.getMeta(BACKUP_META_KEY) === null) {
    const dest = join(dirname(file), `${basename(file)}.pre-canonical-${new Date().toISOString().replace(/:/g, "-")}.bak`);
    try {
      await db.backupTo(dest);
    } catch (err) {
      // No backup, no migration: skip it this boot (read-only dir, full disk…) and retry next boot.
      log.warn("canonical", `could not back up the db before the canonical-repo backfill; skipping it this boot: ${String(err)}`);
      return;
    }
    db.setMeta(BACKUP_META_KEY, dest);
    log.info("canonical", `backed up the db before the canonical-repo backfill: ${dest}`);
  }

  // Phase 1 (async, idempotent, recomputed from persisted edges): catch-all sessions.
  for (const session of db.listSessions()) {
    if (isCatchAllCwd(session.cwd, homeDir)) await placeByTouchedFiles(db, session.id, homeDir, gitRoots, resolver);
  }
  opts.beforeCommit?.();

  // Phase 2 (one transaction, flag last): repoint cwds, move sessions, vacate islands.
  db.transaction(() => {
    for (const [cwd, islandId] of db.listIslandSlugs()) {
      if (isCatchAllCwd(cwd, homeDir)) continue;
      const root = resolver.rootOf(cwd);
      if (!root || root === cwd) continue;
      const target = ensureIslandForCwd(db, root);
      if (target !== islandId) db.aliasCwdToRoot(cwd, root, target);
    }
    for (const session of db.listSessions()) {
      if (isCatchAllCwd(session.cwd, homeDir)) continue;
      const want = db.getIslandForCwd(session.cwd);
      if (want && want !== session.islandId) db.setSessionIslandId(session.id, want);
    }
    for (const [from, to] of vacatedIslands(db)) db.moveIslandObjects(from, to);
    db.setMeta(BACKFILL_META_KEY, "1");
  });
}
