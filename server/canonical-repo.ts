// A session's district is its CANONICAL REPO: the main working tree of the git repo that holds
// its cwd. Without this, a linked worktree (~/.acme-worktrees/tick-1791) or a subfolder
// (agent-world/server) each got an island of their own, splitting one repo's work across many.
//
//   subfolder        → nearest ancestor holding a `.git` (dir or file)
//   linked worktree  → its `.git` FILE reads `gitdir: <main>/.git/worktrees/<name>`; the main
//                      repo root is <main>, confirmed by <main>/.git being a real directory
//   deleted cwd      → the same rules from its nearest existing ancestor; failing that, the
//                      repo every linked worktree beside it belongs to (inferFromWorktreeSiblings)
//   loop worktree    → ~/.alef-worktrees/<slug>/… whose <slug> folder is gone (or orphaned):
//                      agent-world's main repo, but only with proof the slug was agent-world's
//                      (LoopRule: its registration, its `.git` file, or a db row); without proof,
//                      null as before, since other repos' worktrees live there too.
//   anything else    → null: no enclosing repo, a catch-all (home, "/"), a refused root, or a
//                      folder macOS privacy controls guard (privacy-guard.ts: returned before any fs
//                      call, since everything here is synchronous on the event loop)
//
// Pure fs: never spawns git. A `.git` file that is malformed, points somewhere without the
// `.git/worktrees/<name>` shape (a submodule, say), or at a missing path falls back to the
// worktree's own top level — still one island per checkout, never an exception.
//
// The answer is persisted per cwd (cwd_islands + cwd_aliases, see WorldDb.aliasCwdToRoot), so a
// worktree deleted after merge keeps its sessions on the repo's island.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldDb } from "./db.js";
import { isRefusedRoot } from "./features/code-repos.js";
import { isCatchAll } from "./features/topics-lib.js";
import { assignIslandId } from "./heuristics.js";
import { isPrivacyGuarded } from "./privacy-guard.js";

type Kind = "dir" | "file" | null;

function kindOf(p: string): Kind {
  try {
    const st = statSync(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/** Main repo root a linked worktree's `.git` file points at, or null when it can't be trusted. */
function mainRootOfWorktree(top: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(top, ".git"), "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m?.[1]) return null;
  const gitdir = resolve(top, m[1]);
  const worktreesDir = dirname(gitdir);
  const dotGit = dirname(worktreesDir);
  if (basename(worktreesDir) !== "worktrees" || basename(dotGit) !== ".git") return null;
  if (kindOf(gitdir) !== "dir" || kindOf(dotGit) !== "dir") return null;
  const main = dirname(dotGit);
  return main === top ? null : main;
}

/** Walks up from existing directory `start` to the nearest `.git` and canonicalizes it. */
function walkUp(start: string, homeDir: string): string | null {
  let dir = start;
  const fsRoot = parse(dir).root;
  for (;;) {
    const kind = kindOf(join(dir, ".git"));
    if (kind === "dir") return isRefusedRoot(dir, homeDir) ? null : dir;
    if (kind === "file") {
      if (isRefusedRoot(dir, homeDir)) return null;
      const main = mainRootOfWorktree(dir);
      return main && !isRefusedRoot(main, homeDir) ? main : dir;
    }
    const up = dirname(dir);
    if (dir === fsRoot || up === dir) return null;
    dir = up;
  }
}

/**
 * For a cwd whose directory is gone (a worktree removed after merge) and whose nearest existing
 * ancestor `parent` is in no repo: when `parent` still holds at least two linked worktrees, all
 * of the same main repo, and no other repo, that repo. Anything less clear-cut is null — a guess
 * never beats today's island.
 */
function inferFromWorktreeSiblings(parent: string, homeDir: string): string | null {
  if (isRefusedRoot(parent, homeDir)) return null;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  const mains = new Set<string>();
  let worktrees = 0;
  for (const name of names) {
    const sibling = join(parent, name);
    const kind = kindOf(join(sibling, ".git"));
    if (kind === "dir") return null;
    if (kind !== "file") continue;
    const main = mainRootOfWorktree(sibling);
    if (!main) return null;
    mains.add(main);
    worktrees += 1;
  }
  const [main] = mains;
  return worktrees >= 2 && mains.size === 1 && main && !isRefusedRoot(main, homeDir) ? main : null;
}

/** Where Alef's loop worktrees live, under $HOME. */
export const LOOP_WORKTREES_DIR = ".alef-worktrees";

/** `<home>/.alef-worktrees/<slug>` for a path at or below it, else null. Pure string work. */
export function loopWorktreeOf(cwd: string, homeDir: string): string | null {
  const base = join(resolve(homeDir), LOOP_WORKTREES_DIR);
  const r = resolve(cwd);
  if (!r.startsWith(`${base}/`)) return null;
  const slug = r.slice(base.length + 1).split("/")[0];
  return slug ? join(base, slug) : null;
}

/** True when `slugDir` holds a linked worktree one level down (a fork container's layout). */
function holdsWorktrees(slugDir: string): boolean {
  try {
    return readdirSync(slugDir).some((name) => kindOf(join(slugDir, name, ".git")) !== null);
  } catch {
    return false;
  }
}

/** The rule for ~/.alef-worktrees/<slug>: `root` is agent-world's main repo, and a slug folds into
 *  it only with PROOF it was agent-world's (a guess never beats today's island): agent-world's
 *  `.git/worktrees/` still registers that exact path, the slug's `.git` file points there, or
 *  `proof` (a db lookup, e.g. dbLoopProof) says a cwd under it already sits on agent-world. */
export interface LoopRule {
  root: string;
  proof?: (slugDir: string) => boolean;
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Fs proof only: the slug's `.git` file names a gitdir under <root>/.git/worktrees/, or some
 *  <root>/.git/worktrees/<name>/gitdir names <slugDir>/.git. Bounded: one readdir of that dir. */
function fsProvesLoop(slugDir: string, root: string): boolean {
  const registry = join(root, ".git", "worktrees");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(join(slugDir, ".git")) ?? "");
  if (m?.[1] && resolve(slugDir, m[1]).startsWith(`${registry}/`)) return true;
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch {
    return false;
  }
  const want = join(slugDir, ".git");
  return names.some((n) => readText(join(registry, n, "gitdir"))?.trim() === want);
}

function provenLoop(slugDir: string, homeDir: string, loop: LoopRule | null): string | null {
  if (!loop || isRefusedRoot(loop.root, homeDir)) return null;
  return fsProvesLoop(slugDir, loop.root) || loop.proof?.(slugDir) === true ? loop.root : null;
}

/** A gone (or emptied-out) loop worktree's repo: under ~/.alef-worktrees/<slug> whose folder is
 *  gone, or is left without any `.git` of its own or one level down (neither a live worktree nor a
 *  fork container ~/.alef-worktrees/<repo>/), and only when provenLoop says it was agent-world's. */
function loopFallback(cwd: string, homeDir: string, loop: LoopRule | null): string | null {
  const slugDir = loop ? loopWorktreeOf(cwd, homeDir) : null;
  if (!slugDir) return null;
  const kind = kindOf(slugDir);
  const gone = kind === null || (kind === "dir" && kindOf(join(slugDir, ".git")) === null && !holdsWorktrees(slugDir));
  return gone ? provenLoop(slugDir, homeDir, loop) : null;
}

/** Canonical repo root for `cwd` (uncached; see createCanonicalRepoResolver). `loop` turns on the
 *  ~/.alef-worktrees/<slug> rule (LoopRule); null leaves it off. */
export function canonicalRepoRoot(cwd: string, homeDir: string, loop: LoopRule | null = null): string | null {
  if (!isAbsolute(cwd) || isCatchAll({ id: "", path: cwd }, homeDir) || isPrivacyGuarded(cwd, homeDir)) return null;
  let dir = resolve(cwd);
  if (kindOf(dir) === "dir") return orphanedLoop(walkUp(dir, homeDir), cwd, homeDir, loop) ?? loopFallback(cwd, homeDir, loop);
  while (kindOf(dir) !== "dir") {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return orphanedLoop(walkUp(dir, homeDir), cwd, homeDir, loop) ?? inferFromWorktreeSiblings(dir, homeDir) ?? loopFallback(cwd, homeDir, loop);
}

/** `found`, except a loop worktree whose `.git` file no longer leads to its main repo (walkUp then
 *  answers with the worktree's own top): agent-world's when provenLoop says so. */
function orphanedLoop(found: string | null, cwd: string, homeDir: string, loop: LoopRule | null): string | null {
  if (!found || !loop || found !== loopWorktreeOf(cwd, homeDir) || kindOf(join(found, ".git")) !== "file") return found;
  return provenLoop(found, homeDir, loop) ?? found;
}

/** A db proof for LoopRule: some cwd_islands row at or under <slugDir> already sits on the island
 *  of `root` (agent-world), e.g. a session that ran in that worktree while it existed. */
export function dbLoopProof(db: WorldDb, root: string): (slugDir: string) => boolean {
  return (slugDir) => {
    const island = db.getIslandForCwd(root);
    if (!island) return false;
    for (const [cwd, id] of db.listIslandSlugs()) if (id === island && (cwd === slugDir || cwd.startsWith(`${slugDir}/`))) return true;
    return false;
  };
}

/** agent-world's main repo, from this server's own checkout (a loop worktree or ~/.alef-live
 *  canonicalizes to it), or null when that can't be read. */
export function ownRepoRoot(homeDir: string): string | null {
  return canonicalRepoRoot(fileURLToPath(new URL("..", import.meta.url)), homeDir);
}

export interface CanonicalRepoResolver {
  rootOf(cwd: string): string | null;
}

/** canonicalRepoRoot with a per-cwd cache, bounded and forgotten every `ttlMs` so a repo or
 *  worktree created later is noticed without a restart. */
export function createCanonicalRepoResolver(
  homeDir: string,
  opts: { maxEntries?: number; ttlMs?: number; now?: () => number; loop?: LoopRule | null } = {},
): CanonicalRepoResolver {
  const loop = opts.loop ?? null;
  const maxEntries = opts.maxEntries ?? 5_000;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, string | null>();
  let bornAt = now();
  return {
    rootOf(cwd) {
      if (now() - bornAt > ttlMs || cache.size >= maxEntries) {
        cache.clear();
        bornAt = now();
      }
      if (cache.has(cwd)) return cache.get(cwd) ?? null;
      const root = canonicalRepoRoot(cwd, homeDir, loop);
      cache.set(cwd, root);
      return root;
    },
  };
}

const shared = new Map<string, CanonicalRepoResolver>();

/** One cached resolver per home dir, shared by the indexer, home placement and the backfill. */
export function defaultCanonicalResolver(homeDir: string): CanonicalRepoResolver {
  let r = shared.get(homeDir);
  if (!r) {
    const root = ownRepoRoot(homeDir);
    r = createCanonicalRepoResolver(homeDir, { loop: root ? { root } : null });
    shared.set(homeDir, r);
  }
  return r;
}

/** The island a cwd owns, created the indexer's usual way when it has none yet. */
export function ensureIslandForCwd(db: WorldDb, root: string): string {
  const existing = db.getIslandForCwd(root);
  if (existing) return existing;
  const id = assignIslandId(root, db.listIslandSlugs(), new Set(db.listIslandIds()));
  db.setIslandForCwd(root, id);
  return id;
}

/**
 * The island for a cwd seen for the first time: its canonical repo's island (created if needed,
 * and the cwd recorded as an alias of that root), or a fresh island of its own when it has no
 * enclosing repo. A cwd already assigned keeps its island — assignments are stable.
 */
export function islandForNewCwd(db: WorldDb, cwd: string, resolver: CanonicalRepoResolver): string {
  const existing = db.getIslandForCwd(cwd);
  if (existing) return existing;
  const root = resolver.rootOf(cwd);
  if (root && root !== cwd) {
    const islandId = ensureIslandForCwd(db, root);
    db.aliasCwdToRoot(cwd, root, islandId);
    return islandId;
  }
  return ensureIslandForCwd(db, cwd);
}
