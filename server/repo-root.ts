// Walks up from a cwd looking for a `.git` entry (directory, or a file — the
// latter is how git worktrees mark their root). Read-only; never touches git.
// Synchronous on the event loop, so a cwd inside a folder macOS privacy controls guard
// (privacy-guard.ts) gets no git root at all rather than any fs call there.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { isPrivacyGuarded } from "./privacy-guard.js";

export function findGitRoot(cwd: string, homeDir: string = homedir()): string | null {
  if (isPrivacyGuarded(cwd, homeDir)) return null;
  let dir = cwd;
  const { root } = parse(dir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
