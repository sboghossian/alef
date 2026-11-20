// Honest trips (pure; covered by test/trips-lib.test.ts). A plane or a road means one thing: a
// session touched a file that lives in ANOTHER island's folder. Nothing is chosen or invented.
// "Touched" is the indexer's file target: a Read, Edit, Write, MultiEdit or NotebookEdit file_path,
// or a Glob/Grep path (jsonl-events.ts filePathFromToolUse), so a visit is reading or editing there.
// A session's own files (its transcript dir and scratchpad, both named by its session id) never count.
//
// The destination comes from the file's PATH, never from its object row: an object's island_id is
// just the island of whichever session last upserted it (indexer.ts upsertObjectShell), so two
// sessions editing one file would each see it on the other's island.
//
// Roots are the cwd_islands rows (db.listIslandSlugs()), which include the worktree and subfolder
// aliases canonical-repo.ts folded onto their repo's island. The longest root that contains the path
// wins. Catch-alls never claim a path: "/" and the system temp dirs (every session's scratchpad lives
// under /private/tmp/claude-<uid>/, which is no district's work). The home dir only claims what no
// other root does, and before it does, the path's canonical repo gets a say: an edit inside a linked
// worktree no session ever ran in (~/.acme-worktrees/<branch>) belongs to that repo's island.

export const FILE_PREFIX = "file:";
export const HARNESS_ISLAND = "harness";
/** Folders that hold other things' scratch files, like "/": an island rooted here claims nothing. */
export const TEMP_ROOTS: readonly string[] = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

/** The canonical repo root holding a directory (canonical-repo.ts CanonicalRepoResolver.rootOf), or null. */
export type RepoRootOf = (dir: string) => string | null;

/** The edge fields the trip logic reads (db.ts EdgeRow and shared WorldEdge both fit). */
export interface EdgeLike {
  from: string;
  to: string;
  kind: string;
  weight: number;
  at: string;
}

/** A session's visit to another island: one per (session, destination island). */
export interface VisitEdge {
  from: string; // session id
  to: string; // destination island id
  kind: "visited";
  weight: number; // touches on that island (sum of its touched-edge weights)
  at: string; // newest of those touches
}

/** A live session editing another island's files since the last tick: its plane flies there. */
export interface Trip {
  sessionId: string;
  islandId: string;
  at: string;
}

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** True for a path inside the session's own harness dirs (~/.claude/projects/<slug>/<id>/…, <id>.jsonl, its scratchpad). */
export function isOwnSessionPath(path: string, sessionId: string): boolean {
  return path.includes(`/${sessionId}/`) || path.endsWith(`/${sessionId}.jsonl`);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** A path → island lookup over `roots` (cwd → island id), longest root first. */
export function pathResolver(roots: ReadonlyMap<string, string>, homeDir: string, repoRootOf?: RepoRootOf): (path: string) => string | null {
  const home = trimSlash(homeDir);
  let homeIsland: string | null = null;
  const byRoot = new Map<string, string>();
  const sorted: Array<{ root: string; islandId: string }> = [];
  for (const [cwd, islandId] of roots) {
    if (islandId === HARNESS_ISLAND) continue;
    const root = trimSlash(cwd);
    byRoot.set(root, islandId);
    if (root === "" || TEMP_ROOTS.includes(root)) continue; // catch-alls, never a destination
    if (root === home) {
      homeIsland = islandId;
      continue; // the home dir: only for paths no other root claims (below)
    }
    sorted.push({ root, islandId });
  }
  sorted.sort((a, b) => b.root.length - a.root.length || (a.root < b.root ? -1 : 1));
  return (path: string) => {
    for (const r of sorted) if (isUnder(path, r.root)) return r.islandId;
    if (home === "" || homeIsland === null || !isUnder(path, home)) return null;
    const repo = repoRootOf?.(dirOf(path));
    const repoIsland = repo ? byRoot.get(trimSlash(repo)) : undefined;
    return repoIsland ?? homeIsland;
  };
}

/** The island whose folder holds `path`, or null (outside every island, e.g. /opt, a temp dir or "/"). */
export function islandOfPath(path: string, roots: ReadonlyMap<string, string>, homeDir: string, repoRootOf?: RepoRootOf): string | null {
  return pathResolver(roots, homeDir, repoRootOf)(path);
}

/**
 * Every (session, other island) pair the touched edges prove: a `touched` edge to `file:<path>`
 * whose path resolves to an island other than the session's home. Sessions not in
 * `sessionsById`, paths outside every island and the session's own files are skipped. Sorted by (from, to).
 */
export function deriveVisits(
  edges: readonly EdgeLike[],
  sessionsById: ReadonlyMap<string, { islandId: string }>,
  roots: ReadonlyMap<string, string>,
  homeDir: string,
  repoRootOf?: RepoRootOf,
): VisitEdge[] {
  const resolve = pathResolver(roots, homeDir, repoRootOf);
  const byKey = new Map<string, VisitEdge>();
  for (const e of edges) {
    if (e.kind !== "touched" || !e.to.startsWith(FILE_PREFIX)) continue;
    const session = sessionsById.get(e.from);
    if (!session) continue;
    const path = e.to.slice(FILE_PREFIX.length);
    if (isOwnSessionPath(path, e.from)) continue;
    const dest = resolve(path);
    if (dest === null || dest === session.islandId) continue;
    const key = `${e.from}\u0000${dest}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.weight += e.weight;
      if (e.at > prev.at) prev.at = e.at;
    } else {
      byKey.set(key, { from: e.from, to: dest, kind: "visited", weight: e.weight, at: e.at });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** What to write so the stored `visited` edges equal `derived` exactly: rows to put and rows to drop. */
export function diffVisits(
  stored: readonly EdgeLike[],
  derived: readonly VisitEdge[],
): { put: VisitEdge[]; remove: Array<{ from: string; to: string }> } {
  const have = new Map<string, EdgeLike>();
  for (const e of stored) if (e.kind === "visited") have.set(`${e.from}\u0000${e.to}`, e);
  const put: VisitEdge[] = [];
  const want = new Set<string>();
  for (const v of derived) {
    const key = `${v.from}\u0000${v.to}`;
    want.add(key);
    const cur = have.get(key);
    if (!cur || cur.weight !== v.weight || cur.at !== v.at) put.push(v);
  }
  const remove: Array<{ from: string; to: string }> = [];
  for (const [key, e] of have) if (!want.has(key)) remove.push({ from: e.from, to: e.to });
  return { put, remove };
}

/**
 * Live sessions that touched another island's files after `sinceIso`, one trip each, to the island
 * of their newest such touch (ties: island id order). A dormant session has no process, so it never
 * gets a trip however recent its visit edge.
 */
export function newTrips(visits: readonly VisitEdge[], sinceIso: string, liveIds: ReadonlySet<string>): Trip[] {
  const best = new Map<string, Trip>();
  for (const v of visits) {
    if (v.at <= sinceIso || !liveIds.has(v.from)) continue;
    const cur = best.get(v.from);
    if (!cur || v.at > cur.at || (v.at === cur.at && v.to < cur.islandId)) best.set(v.from, { sessionId: v.from, islandId: v.to, at: v.at });
  }
  return [...best.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}

/** The newest file-touch timestamp in `edges` (the trips cursor), or null when there is none. */
export function newestTouch(edges: readonly EdgeLike[]): string | null {
  let out: string | null = null;
  for (const e of edges) if (e.kind === "touched" && e.to.startsWith(FILE_PREFIX) && (out === null || e.at > out)) out = e.at;
  return out;
}
