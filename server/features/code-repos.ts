// Repo grouping for the "code" feature. Most live agents run with cwd = $HOME, which is not a
// project, so the view would be empty. Instead we take the files the session itself touched,
// resolve each one's git root (nearest ancestor holding a `.git` dir or file; one cached answer
// per directory, never a git process per file) and offer those roots as the repos to browse.
// A root is only ever servable when it came from that session's own touched files.
//
// Also caches each session's tool uses incrementally: the transcript is append-only, so a
// repeat request parses only the bytes written since the last one.

import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { CodeRepo } from "../../shared/features/code.js";
import { filePathFromToolUse } from "../jsonl-events.js";
import { completeLines } from "./replay-lib.js";
import { isSecretPath } from "./safe-path.js";
import { findSessionJsonl, parseTranscript, type TranscriptEntry } from "./transcript.js";

/** True when `p` exists (any type). Injectable so tests can fake a tree. */
export type Exists = (p: string) => Promise<boolean>;

export const fsExists: Exists = async (p) => {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
};

export interface GitRootResolver {
  /** Git root of the directory `dir` (itself or an ancestor), or null. */
  rootOfDir(dir: string): Promise<string | null>;
  /** Git root of a file path (resolved from its parent directory). */
  rootOfFile(absFile: string): Promise<string | null>;
}

/** Walks up to the nearest `.git`, caching every directory it visits. Bounded (cleared when full)
 *  and forgotten every `ttlMs`, so a repo created later is found without a restart. */
export function createGitRootResolver(exists: Exists = fsExists, opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}): GitRootResolver {
  const maxEntries = opts.maxEntries ?? 20_000;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Promise<string | null>>();
  let bornAt = now();

  function rootOfDir(dir: string): Promise<string | null> {
    const d = resolve(dir);
    if (now() - bornAt > ttlMs) {
      cache.clear();
      bornAt = now();
    }
    const hit = cache.get(d);
    if (hit) return hit;
    if (cache.size >= maxEntries) cache.clear();
    const p = (async (): Promise<string | null> => {
      if (await exists(join(d, ".git"))) return d;
      const up = dirname(d);
      if (up === d || d === parse(d).root) return null;
      return rootOfDir(up);
    })();
    cache.set(d, p);
    return p;
  }

  return {
    rootOfDir,
    rootOfFile: (absFile) => rootOfDir(dirname(resolve(absFile))),
  };
}

/** A root we never serve: "/", $HOME or any ancestor of it, or a secret-looking dir (.ssh, .git…). */
export function isRefusedRoot(root: string, home = homedir()): boolean {
  const r = resolve(root);
  const h = resolve(home);
  if (r === parse(r).root) return true;
  if (r === h || h.startsWith(r.endsWith(sep) ? r : r + sep)) return true;
  return isSecretPath(join(r, "x")); // any secret segment, the root's own name included (.ssh, .aws…)
}

/** Absolute paths of the files a session's tool calls referenced (relative ones against `cwd`). */
export function touchedAbsPaths(entries: readonly TranscriptEntry[], cwd: string): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    for (const use of e.toolUses) {
      const raw = filePathFromToolUse({ name: use.name, input: use.input });
      if (!raw) continue;
      out.add(isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw));
    }
  }
  return [...out];
}

/** Short unique labels: the root's basename, or "parent/name" when two roots share a basename. */
export function repoLabels(roots: readonly string[]): Map<string, string> {
  const byBase = new Map<string, number>();
  for (const r of roots) byBase.set(basename(r), (byBase.get(basename(r)) ?? 0) + 1);
  return new Map(roots.map((r) => [r, (byBase.get(basename(r)) ?? 0) > 1 ? `${basename(dirname(r))}/${basename(r)}` : basename(r)]));
}

/** Groups touched files by git root: most touched files first, then by label. Files outside any
 *  repo, and refused roots ($HOME, "/", secret dirs), are left out. */
export async function groupTouchedByRepo(absPaths: readonly string[], resolver: GitRootResolver, home = homedir()): Promise<CodeRepo[]> {
  const roots = await Promise.all(absPaths.map((p) => resolver.rootOfFile(p)));
  const counts = new Map<string, number>();
  roots.forEach((root, i) => {
    const file = absPaths[i];
    if (!root || !file || isRefusedRoot(root, home) || file === root) return;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  });
  const labels = repoLabels([...counts.keys()]);
  return [...counts.entries()]
    .map(([root, files]) => ({ root, label: labels.get(root) ?? basename(root), files, git: true }))
    .sort((a, b) => b.files - a.files || a.label.localeCompare(b.label));
}

/** The one repo a catch-all session's touched files dominantly belong to, or null when there
 *  isn't a clear one. `repos` is `groupTouchedByRepo`'s output (most-touched first): the winner
 *  needs at least 2 touched files, no tie with the runner-up, and at least half of every touch
 *  that resolved to *some* repo. Used by home-placement.ts to re-home a session run from a
 *  catch-all cwd (see isCatchAll) onto the repo it actually worked in. */
export function pickDominantRepo(repos: readonly CodeRepo[]): CodeRepo | null {
  const [top, runnerUp] = repos;
  if (!top || top.files < 2 || runnerUp?.files === top.files) return null;
  const total = repos.reduce((sum, r) => sum + r.files, 0);
  return top.files / total >= 0.5 ? top : null;
}

// ---------------------------------------------------------------- incremental transcript cache

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

interface SessionUses {
  path: string;
  ino: number;
  offset: number;
  entries: TranscriptEntry[]; // tool-use entries only (text dropped: we never need it here)
}

/** Keeps each session's tool-use entries, re-parsing only bytes appended since the last call. */
export function createTranscriptUsesCache(maxSessions = 24): { entries(projectsDir: string, sessionId: string): Promise<TranscriptEntry[] | null> } {
  const cache = new Map<string, SessionUses>();
  const inflight = new Map<string, Promise<TranscriptEntry[] | null>>();

  async function load(projectsDir: string, sessionId: string): Promise<TranscriptEntry[] | null> {
    const path = await findSessionJsonl(projectsDir, sessionId);
    if (!path) return null;
    const st = await stat(path);
    if (st.size > MAX_TRANSCRIPT_BYTES) return null;
    const key = `${projectsDir}\n${sessionId}`;
    const prev = cache.get(key);
    const cur: SessionUses = prev && prev.path === path && prev.ino === st.ino && prev.offset <= st.size ? prev : { path, ino: st.ino, offset: 0, entries: [] };
    if (cur.offset < st.size) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(st.size - cur.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, cur.offset);
        const chunk = buf.subarray(0, bytesRead);
        const whole = completeLines(chunk);
        let parsed = parseTranscript(whole.text);
        let consumed = whole.consumed;
        // A final line with no "\n" yet counts once it is complete JSON (a half-written one never is).
        const tail = consumed < chunk.length ? parseTranscript(chunk.subarray(consumed).toString("utf8")) : [];
        if (tail.length > 0) {
          parsed = parsed.concat(tail);
          consumed = chunk.length;
        }
        cur.offset += consumed;
        for (const e of parsed) if (e.toolUses.length > 0) cur.entries.push({ at: e.at, role: e.role, texts: [], toolUses: e.toolUses });
      } finally {
        await fh.close();
      }
    }
    cache.delete(key);
    cache.set(key, cur);
    while (cache.size > maxSessions) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return cur.entries;
  }

  return {
    entries(projectsDir, sessionId) {
      const key = `${projectsDir}\n${sessionId}`;
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = load(projectsDir, sessionId)
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
