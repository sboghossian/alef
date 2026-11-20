// I/O around placement-evidence-lib.ts: reading evidence out of transcripts (a home-run
// session's own, and its subagents' under <session>/subagents/), and mapping a GitHub
// "owner/repo" to the local repo island whose clone pushes there.
//
// Transcripts are untrusted data: only the fields placement-evidence-lib.ts matches are read.
// A remote URL can carry a token; only the "owner/repo" parsed out of it is kept, never logged.

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorldDb } from "./db.js";
import { parseLine } from "./jsonl-events.js";
import { githubRepoOfRemoteUrl, mayCarryEvidence, newEvidenceFold, pickCloneRoot, foldEvidence, type EvidenceFold, type FoldOpts } from "./placement-evidence-lib.js";
import { isCatchAll } from "./features/topics-lib.js";

const NEWLINE = 0x0a;

/** Every subagent transcript of a session: `<dir>/agent-*.jsonl` and
 *  `<dir>/workflows/<run>/agent-*.jsonl`, where `<dir>` is `<project>/<session>/subagents`. */
export async function listSubagentTranscripts(subagentsDir: string): Promise<string[]> {
  const agents = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl")).map((f) => join(dir, f));
    } catch {
      return [];
    }
  };
  const out = await agents(subagentsDir);
  let runs: string[] = [];
  try {
    runs = await readdir(join(subagentsDir, "workflows"));
  } catch {
    // no workflows
  }
  for (const run of runs.sort()) out.push(...(await agents(join(subagentsDir, "workflows", run))));
  return out;
}

/** The subagents folder of a session whose own transcript is `transcript`. */
export function subagentsDirOf(transcript: string, sessionId: string): string {
  return join(dirname(transcript), sessionId, "subagents");
}

/**
 * Folds the complete lines of `path` in [start, end) into a fresh evidence fold (seeded with the
 * session's pending ship commands). Returns the fold and the offset just past the last complete
 * line, which is where the next read must start. Lines that can't carry evidence are never parsed.
 */
export async function readEvidence(
  path: string,
  start: number,
  end: number,
  seedPending: Iterable<string>,
  opts: FoldOpts & { fallbackAt: string },
): Promise<{ fold: EvidenceFold; offset: number }> {
  const fold = newEvidenceFold(seedPending);
  if (end <= start) return { fold, offset: start };
  let buffer = Buffer.alloc(0);
  let base = start;
  for await (const chunk of createReadStream(path, { start, end: end - 1 })) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    let from = 0;
    for (let nl = buffer.indexOf(NEWLINE, from); nl !== -1; nl = buffer.indexOf(NEWLINE, from)) {
      const raw = buffer.toString("utf8", from, nl);
      if (mayCarryEvidence(raw, fold.pending.size > 0)) {
        const line = parseLine(raw);
        if (line) foldEvidence(fold, line, line.timestamp ?? opts.fallbackAt, opts);
      }
      from = nl + 1;
    }
    base += from;
    buffer = buffer.subarray(from);
  }
  return { fold, offset: base };
}

/**
 * Reads what's new in a session's subagent transcripts (each from its own stored offset) and
 * records their evidence for the parent. Returns how many evidence rows were new. Re-reading a
 * line adds nothing (rows are keyed), so an offset lost to a crash only costs a re-read.
 */
export async function indexSubagentEvidence(db: WorldDb, transcript: string, sessionId: string, cwd: string): Promise<number> {
  let added = 0;
  for (const path of await listSubagentTranscripts(subagentsDirOf(transcript, sessionId))) {
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    const prev = db.getFileOffset(path);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    const start = prev && prev.byteOffset <= st.size ? prev.byteOffset : 0;
    try {
      const { fold, offset } = await readEvidence(path, start, st.size, db.pendingShipUses(sessionId), { agentEdits: true, cwd, fallbackAt: st.mtime.toISOString() });
      added += db.addPlacementEvidence(sessionId, fold.rows);
      db.syncPendingShipUses(sessionId, fold.pending, fold.resolved, st.mtime.toISOString());
      db.setFileOffset({ path, size: st.size, mtime: st.mtimeMs, byteOffset: offset, malformedCount: prev?.malformedCount ?? 0 });
    } catch {
      // deleted or unreadable mid-read: retried from the same offset next time
    }
  }
  return added;
}

export interface RemoteResolver {
  /** "owner/repo" of the GitHub remote `origin` of the git checkout at `root`, or null. */
  githubRepoOf(root: string): Promise<string | null>;
}

async function hasGitDir(root: string): Promise<boolean> {
  try {
    await lstat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

function originUrl(root: string): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 3_000, maxBuffer: 16 * 1024 }, (err, stdout) => done(err ? null : String(stdout)));
  });
}

/** `git remote get-url origin` per checkout, only where a `.git` exists, cached per root and
 *  forgotten every `ttlMs` (a clone or a remote added later is noticed without a restart). */
export function createRemoteResolver(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): RemoteResolver {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const maxEntries = opts.maxEntries ?? 2_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Promise<string | null>>();
  let bornAt = now();
  return {
    githubRepoOf(root) {
      if (now() - bornAt > ttlMs || cache.size >= maxEntries) {
        cache.clear();
        bornAt = now();
      }
      let hit = cache.get(root);
      if (!hit) {
        hit = (async () => ((await hasGitDir(root)) ? githubRepoOfRemoteUrl((await originUrl(root)) ?? "") : null))();
        cache.set(root, hit);
      }
      return hit;
    },
  };
}

export const defaultRemoteResolver: RemoteResolver = createRemoteResolver();

/** "owner/repo" → the island of the local checkout whose origin is that repo. Only islands that
 *  already exist, own a cwd, and are a repo's main checkout (worktrees and subfolders are aliases
 *  of it) count; a remote with no local island maps nowhere, so no island is ever created here. */
export async function githubRepoIslands(db: WorldDb, homeDir: string, remotes: RemoteResolver): Promise<Map<string, string>> {
  const aliases = new Set(db.listCwdAliases().map((a) => a.cwd));
  const cwds = [...db.listIslandSlugs().keys()].filter((cwd) => !aliases.has(cwd) && !isCatchAll({ id: "", path: cwd }, homeDir));
  const repos = await Promise.all(cwds.map((cwd) => remotes.githubRepoOf(cwd)));
  const clones = new Map<string, string[]>();
  cwds.forEach((cwd, i) => {
    const repo = repos[i];
    if (repo) clones.set(repo, [...(clones.get(repo) ?? []), cwd]);
  });
  const out = new Map<string, string>();
  for (const [repo, roots] of clones) {
    const root = pickCloneRoot(roots, homeDir);
    const island = root ? db.getIslandForCwd(root) : null;
    if (island) out.set(repo, island);
  }
  return out;
}
