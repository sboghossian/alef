// Folder trust for launches (shared/features/trust.ts has the meaning of each value). READ-ONLY:
// reads ctx.config.claudeJsonPath (~/.claude.json) fresh on every call, because Claude Code
// rewrites it all the time and it can be several MB, and never writes it. It also stats `.git`
// in the cwd's ancestors to find the git root, and reads a worktree's `.git`, `commondir` and
// `gitdir` files to find its main checkout, except inside a folder macOS privacy controls guard
// (privacy-guard.ts), where the git root counts as its own checkout and nothing in it is opened.
// Never throws.

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FolderTrust } from "../shared/features/trust.js";
import { isRecord } from "./http.js";
import { isPrivacyGuarded } from "./privacy-guard.js";

function accepted(projects: Record<string, unknown>, path: string): boolean {
  if (!Object.hasOwn(projects, path)) return false;
  const entry = projects[path];
  return isRecord(entry) && entry.hasTrustDialogAccepted === true;
}

/** Claude Code's git-root test: `.git` is a directory, or a file (worktrees, submodules). */
async function isGitRoot(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, ".git"));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/** Claude Code 2.1.283's canonical root for a git root (Le/Qt): when `.git` is a file naming a linked
 *  worktree's gitdir directly under <common>/worktrees/, and that gitdir's `gitdir` file points back
 *  at this `.git`, the main checkout (dirname of <common>). Otherwise null (a normal repo, a submodule,
 *  a moved worktree, a bare repo's worktree). */
async function mainCheckout(gitRoot: string): Promise<string | null> {
  try {
    const dotGit = (await readFile(join(gitRoot, ".git"), "utf8")).trim();
    if (!dotGit.startsWith("gitdir:")) return null;
    const gitdir = resolve(gitRoot, dotGit.slice(7).trim());
    const common = resolve(gitdir, (await readFile(join(gitdir, "commondir"), "utf8")).trim());
    if (resolve(dirname(gitdir)) !== join(common, "worktrees")) return null;
    const back = resolve(gitdir, (await readFile(join(gitdir, "gitdir"), "utf8")).trim());
    if ((await realpath(back)) !== join(await realpath(gitRoot), ".git")) return null;
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

export async function folderTrust(claudeJsonPath: string, cwd: string, homeDir: string = homedir()): Promise<FolderTrust> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed)) return "unknown";
  const projects = isRecord(parsed.projects) ? parsed.projects : {};
  // Claude Code 2.1.283 (oS/iS) walks up from the cwd and stops at the git root, so a trusted
  // ~/Documents covers a plain folder under it but not a repo under it (seen on this machine).
  // iN also accepts the canonical root's own entry, so a worktree of a trusted repo is trusted.
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (accepted(projects, dir)) return "trusted";
    if (dirname(dir) === dir) return "untrusted";
    if (!(await isGitRoot(dir))) continue;
    // A stat of `.git` is not gated by macOS privacy controls, opening it is: a guarded folder
    // (~/Downloads, say) is its own checkout, so it stays listed and trustable with no read inside.
    const main = isPrivacyGuarded(dir, homeDir) ? dir : await mainCheckout(dir);
    return main !== null && accepted(projects, main) ? "trusted" : "untrusted";
  }
}
