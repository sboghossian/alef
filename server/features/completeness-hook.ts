// Health's "Approvals hook installed": which PermissionRequest hook commands count as THIS repo's
// hook. The live app runs from one worktree (~/.alef-live) and development happens in another
// (~/Documents/Code/agent-world), so a hook installed from either checkout is the same hook. A
// command counts when one of its arguments is `<dir>/hooks/permission-request.mjs`, that file
// exists, `<dir>` is a worktree's top level, and that worktree's `git rev-parse --git-common-dir`
// resolves to the same folder as this repo's. Any other path (another clone, a copy, a missing
// file) does not count. Read-only: `git rev-parse` and a stat, nothing else.

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HOOK_SCRIPT_SUFFIX = "/hooks/permission-request.mjs";

/** The words of a hook command the way a POSIX shell splits them: whitespace separates, single
 *  quotes are literal, double quotes allow \" and \\, a backslash outside quotes escapes the next
 *  character. Enough for what scripts/install-approvals-hook.mjs prints (it single-quotes a path
 *  with spaces). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      cur += end < 0 ? command.slice(i + 1) : command.slice(i + 1, end);
      i = end < 0 ? command.length : end;
      inWord = true;
    } else if (ch === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const c = command[i]!;
        if (c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
          cur += command[i + 1];
          i++;
        } else cur += c;
      }
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[i + 1];
      i++;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** Absolute `.../hooks/permission-request.mjs` paths named in a hook command. */
export function hookScriptPaths(command: string): string[] {
  return shellWords(command).filter((w) => isAbsolute(w) && w.endsWith(HOOK_SCRIPT_SUFFIX));
}

interface GitIdentity {
  /** realpath of `git rev-parse --git-common-dir`: shared by every worktree of one repository. */
  commonDir: string;
  /** realpath of `git rev-parse --show-toplevel`. */
  topLevel: string;
}

const IDENTITY_TTL_MS = 10 * 60_000;
const identityCache = new Map<string, { at: number; value: GitIdentity | null }>();

/** Test-only: forget cached `git rev-parse` answers. */
export function resetGitIdentityCacheForTests(): void {
  identityCache.clear();
}

async function gitIdentity(dir: string, nowMs: number): Promise<GitIdentity | null> {
  const hit = identityCache.get(dir);
  if (hit && nowMs - hit.at < IDENTITY_TTL_MS) return hit.value;
  let value: GitIdentity | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--git-common-dir", "--show-toplevel"], { timeout: 5000 });
    const [common, top] = stdout.split("\n").map((l) => l.trim());
    if (common && top) value = { commonDir: await realpath(resolve(dir, common)), topLevel: await realpath(top) };
  } catch {
    value = null; // not a git checkout, git missing, or a path that went away
  }
  identityCache.set(dir, { at: nowMs, value });
  return value;
}

/** True when `script` (an absolute `.../hooks/permission-request.mjs`) exists and sits at the top
 *  level of a worktree of the same git repository as `repoRoot`. `git rev-parse` answers are cached
 *  for 10 minutes per folder; the script's existence is checked every call. */
export async function isSameRepoHookScript(script: string, repoRoot: string, nowMs: number = Date.now()): Promise<boolean> {
  try {
    if (!(await stat(script)).isFile()) return false;
  } catch {
    return false;
  }
  const worktree = dirname(dirname(script));
  const [theirs, ours] = await Promise.all([gitIdentity(worktree, nowMs), gitIdentity(repoRoot, nowMs)]);
  if (!theirs || !ours) return false;
  let worktreeReal: string;
  try {
    worktreeReal = await realpath(worktree);
  } catch {
    return false;
  }
  return theirs.commonDir === ours.commonDir && theirs.topLevel === worktreeReal;
}
