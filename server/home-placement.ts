// Where a session run from a catch-all cwd (home dir, or "/" — see isCatchAll) actually belongs.
// Most live agents run with cwd = $HOME, which is not a project, so every one of them would
// otherwise pile onto one shared island (or "root" for cwd = "/") even when their transcript
// shows they worked entirely inside one repo. Two votes, strongest first:
//
//   1. shipped: the repo its PRs and pushes went to (placement-evidence-lib.ts), mapped to the
//      local clone whose `origin` is that GitHub repo. Explicit shipping beats any file count.
//   2. touched: once its touched files — its own touched-file edges plus the files its subagents
//      edited — point clearly enough at one repo, that repo — reusing the exact grouping the
//      "code" feature already builds to offer a session its own touched repos (code-repos.ts).
//
// Recomputed from *persisted* state — every touched-file edge and evidence row the session has
// ever gained, not just the current indexer pass's — so it is safe (and correct) to call every
// time a catch-all session gains a new one, regardless of which pass any of it arrived in.
// Idempotent: recomputing with the same edges yields the same island and writes nothing when the
// session is already there. A repo with no island yet gets one, the exact way the indexer
// assigns one for any new cwd (assignIslandId + setIslandForCwd).

import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { defaultCanonicalResolver, ensureIslandForCwd, type CanonicalRepoResolver } from "./canonical-repo.js";
import type { FileOffsetRow, SessionRow, WorldDb } from "./db.js";
import { createGitRootResolver, groupTouchedByRepo, pickDominantRepo, type GitRootResolver } from "./features/code-repos.js";
import { isCatchAll } from "./features/topics-lib.js";
import { log } from "./log.js";
import { pickShipRepo, shipScores, type EvidenceRow } from "./placement-evidence-lib.js";
import { defaultRemoteResolver, githubRepoIslands, listSubagentTranscripts, readEvidence, subagentsDirOf, type RemoteResolver } from "./placement-evidence.js";
import type { CodeRepo } from "../shared/features/code.js";

const FILE_PREFIX = "file:";

/** True when `cwd` is a catch-all folder — the same rule the topic-continents feature uses for
 *  an island's representative path, applied directly to a session's own cwd. */
export function isCatchAllCwd(cwd: string, homeDir: string): boolean {
  return isCatchAll({ id: "", path: cwd }, homeDir);
}

/** One resolver, reused across every indexer pass for its cache (mirrors the "code" feature,
 *  which builds exactly one for the same reason). */
export const defaultGitRootResolver: GitRootResolver = createGitRootResolver();

/** `repos` with each root replaced by its canonical repo (canonical-repo.ts) and merged, so
 *  touches spread over several worktrees of one repo count as that one repo. */
export function mergeByCanonicalRepo(repos: readonly CodeRepo[], canonical: CanonicalRepoResolver): CodeRepo[] {
  const merged = new Map<string, CodeRepo>();
  for (const r of repos) {
    const root = canonical.rootOf(r.root) ?? r.root;
    const prev = merged.get(root);
    merged.set(root, prev ? { ...prev, files: prev.files + r.files } : { ...r, root });
  }
  return [...merged.values()].sort((a, b) => b.files - a.files || a.label.localeCompare(b.label));
}

/** Where a catch-all session belongs: an existing island its work shipped to, a repo root its
 *  touches dominate (its island may not exist yet), or null = its catch-all island. */
export type Placement = { via: "shipped"; repo: string; islandId: string } | { via: "touched"; root: string } | null;

export interface PlacementResolvers {
  gitRoots?: GitRootResolver;
  canonical?: CanonicalRepoResolver;
  remotes?: RemoteResolver;
}

/** Read-only: computes a catch-all session's placement from its persisted edges and evidence. */
export async function wantedPlacement(db: WorldDb, sessionId: string, homeDir: string, r: PlacementResolvers = {}): Promise<Placement> {
  const evidence = db.placementEvidenceOf(sessionId);
  const shipped = pickShipRepo(shipScores(evidence));
  if (shipped) {
    const islandId = (await githubRepoIslands(db, homeDir, r.remotes ?? defaultRemoteResolver)).get(shipped);
    if (islandId) return { via: "shipped", repo: shipped, islandId };
  }
  const touched = new Set([...db.targetsOf(sessionId)].filter((id) => id.startsWith(FILE_PREFIX)).map((id) => id.slice(FILE_PREFIX.length)));
  for (const e of evidence) if (e.kind === "agent-edit") touched.add(e.subject);
  const repos = touched.size > 0 ? mergeByCanonicalRepo(await groupTouchedByRepo([...touched], r.gitRoots ?? defaultGitRootResolver, homeDir), r.canonical ?? defaultCanonicalResolver(homeDir)) : [];
  const dominant = pickDominantRepo(repos);
  return dominant ? { via: "touched", root: dominant.root } : null;
}

/** Moves a catch-all session to `placement` (its catch-all island for null). Never touches a
 *  session whose cwd isn't a catch-all, and never its cwd. */
export function applyPlacement(db: WorldDb, session: SessionRow, placement: Placement, homeDir: string): void {
  if (!isCatchAllCwd(session.cwd, homeDir)) return;
  const want =
    placement?.via === "shipped"
      ? placement.islandId
      : placement?.via === "touched"
        ? ensureIslandForCwd(db, placement.root)
        : (db.getIslandForCwd(session.cwd) ?? session.islandId);
  if (want !== session.islandId) db.setSessionIslandId(session.id, want);
}

/**
 * Re-homes `sessionId` onto the repo its work shipped to, else the git repo its touched files
 * dominantly belong to, if any, or leaves it on its (already-assigned) catch-all island otherwise.
 * A no-op for a session whose cwd isn't a catch-all — a non-home cwd's island is never touched here.
 */
export async function placeByTouchedFiles(
  db: WorldDb,
  sessionId: string,
  homeDir: string,
  resolver: GitRootResolver = defaultGitRootResolver,
  canonical: CanonicalRepoResolver = defaultCanonicalResolver(homeDir),
  remotes: RemoteResolver = defaultRemoteResolver,
): Promise<void> {
  const session = db.getSession(sessionId);
  if (!session || !isCatchAllCwd(session.cwd, homeDir)) return;
  const placement = await wantedPlacement(db, sessionId, homeDir, { gitRoots: resolver, canonical, remotes });
  const now = db.getSession(sessionId);
  if (now) applyPlacement(db, now, placement, homeDir);
}

const BACKFILL_META_KEY = "home_placement_backfilled";

/**
 * One-time catch-up for sessions that were already indexed before this feature existed: the
 * indexer only calls placeByTouchedFiles when a session gains a NEW touched-file edge, so a
 * dormant session sitting on a catch-all island with plenty of already-persisted edges would
 * otherwise never be reconsidered. This walks every already-catch-all session once, recomputing
 * from its existing edges — no re-parsing of any jsonl. Safe to call on every boot: a single
 * `meta` flag makes every call after the first a no-op.
 */
export async function runHomePlacementBackfill(
  db: WorldDb,
  homeDir: string,
  resolver: GitRootResolver = defaultGitRootResolver,
  evidenceOpts: EvidenceBackfillOptions = {},
): Promise<void> {
  if (db.getMeta(BACKFILL_META_KEY) !== "1") {
    for (const session of db.listSessions()) {
      if (isCatchAllCwd(session.cwd, homeDir)) await placeByTouchedFiles(db, session.id, homeDir, resolver);
    }
    db.setMeta(BACKFILL_META_KEY, "1");
  }
  // Never let this one-time migration stop the world from booting.
  await runPlacementEvidenceBackfill(db, homeDir, { gitRoots: resolver, ...evidenceOpts }).catch((err: unknown) =>
    log.warn("home-placement", `placement-evidence backfill failed; the world boots without it: ${String(err)}`),
  );
}

const EVIDENCE_BACKFILL_META_KEY = "placement_evidence_backfilled";
const EVIDENCE_BACKUP_META_KEY = "placement_evidence_backup";

export interface EvidenceBackfillOptions extends PlacementResolvers {
  /** Test seam: runs after the read-only scan, before anything is written. */
  beforeWrite?: () => void;
  /** Test seam: runs after the evidence is written, before the placement transaction. */
  beforeCommit?: () => void;
}

/**
 * One-time catch-up for sessions indexed before placement evidence existed: their transcripts'
 * offsets are past their pr-links and pushes, and their subagents' transcripts were never read.
 * Reads each catch-all session's transcript up to its stored offset plus all its subagent
 * transcripts, records the evidence, then re-places every session that has any.
 *
 * Crash-safe (LOOP.md data-migration rule): the db is backed up once (WAL-safe) to
 * `world.db.pre-placement-evidence-<ISO>.bak` before the first attempt, and no backup means no
 * migration this boot. The scan only reads. Evidence rows are keyed, so writing them twice adds
 * nothing; the placement moves and the done flag commit in ONE transaction, the flag last,
 * computed from what the db holds. An interrupted run leaves the flag unset and the next boot
 * converges to the same state.
 */
export async function runPlacementEvidenceBackfill(db: WorldDb, homeDir: string, opts: EvidenceBackfillOptions = {}): Promise<void> {
  if (db.getMeta(EVIDENCE_BACKFILL_META_KEY) === "1") return;

  const file = db.filePath();
  if (file && db.getMeta(EVIDENCE_BACKUP_META_KEY) === null) {
    const dest = join(dirname(file), `${basename(file)}.pre-placement-evidence-${new Date().toISOString().replace(/:/g, "-")}.bak`);
    try {
      await db.backupTo(dest);
    } catch (err) {
      log.warn("home-placement", `could not back up the db before the placement-evidence backfill; skipping it this boot: ${String(err)}`);
      return;
    }
    db.setMeta(EVIDENCE_BACKUP_META_KEY, dest);
    log.info("home-placement", `backed up the db before the placement-evidence backfill: ${dest}`);
  }

  // Phase 1 (read only): every catch-all session's evidence, from its transcript up to the stored
  // offset (the indexer reads on from there) and its subagents' transcripts as they are now.
  const catchAll = new Map(db.listSessions().filter((s) => isCatchAllCwd(s.cwd, homeDir)).map((s) => [s.id, s]));
  const found: Array<{ id: string; rows: EvidenceRow[]; pending: Set<string>; at: string }> = [];
  const offsets: FileOffsetRow[] = [];
  let unreadable = 0;
  for (const off of db.listFileOffsets()) {
    const id = basename(off.path, ".jsonl");
    const session = catchAll.get(id);
    if (!session || !off.path.endsWith(".jsonl")) continue;
    try {
      const own = await readEvidence(off.path, 0, off.byteOffset, [], { agentEdits: false, cwd: session.cwd, fallbackAt: session.lastActive });
      found.push({ id, rows: own.fold.rows, pending: own.fold.pending, at: session.lastActive });
    } catch {
      unreadable += 1;
    }
    for (const path of await listSubagentTranscripts(subagentsDirOf(off.path, id))) {
      try {
        const st = await stat(path);
        const sub = await readEvidence(path, 0, st.size, [], { agentEdits: true, cwd: session.cwd, fallbackAt: st.mtime.toISOString() });
        found.push({ id, rows: sub.fold.rows, pending: sub.fold.pending, at: st.mtime.toISOString() });
        offsets.push({ path, size: st.size, mtime: st.mtimeMs, byteOffset: sub.offset, malformedCount: 0 });
      } catch {
        unreadable += 1;
      }
    }
  }
  opts.beforeWrite?.();

  // Phase 2 (idempotent): record it. A subagent offset only ever moves forward.
  db.transaction(() => {
    for (const f of found) {
      db.addPlacementEvidence(f.id, f.rows);
      db.syncPendingShipUses(f.id, f.pending, [], f.at);
    }
    for (const o of offsets) {
      const prev = db.getFileOffset(o.path);
      if (!prev || prev.byteOffset < o.byteOffset) db.setFileOffset(o);
    }
  });

  // Phase 3 (read only, from db state): where each catch-all session with evidence belongs now.
  const placements = new Map<string, Placement>();
  for (const id of db.sessionsWithPlacementEvidence()) {
    if (catchAll.has(id)) placements.set(id, await wantedPlacement(db, id, homeDir, opts));
  }
  opts.beforeCommit?.();

  // Phase 4 (one transaction, flag last).
  db.transaction(() => {
    for (const [id, placement] of placements) {
      const session = db.getSession(id);
      if (session) applyPlacement(db, session, placement, homeDir);
    }
    db.setMeta(EVIDENCE_BACKFILL_META_KEY, "1");
  });
  log.info("home-placement", `placement-evidence backfill done: ${placements.size} home-run sessions carry evidence${unreadable ? `, ${unreadable} transcripts missing or unreadable` : ""}`);
}
