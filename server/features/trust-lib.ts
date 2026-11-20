// Grants Claude Code's folder trust for ONE folder by writing ONE key of ~/.claude.json:
// projects[<realpath cwd>].hasTrustDialogAccepted = true. Only ever called from an explicit click
// (POST /api/trust, and the Inbox's "Trust <folder> & relaunch"). Never by send-keys: the trust
// dialog itself is never answered by Alef.
//
// SAFETY INVARIANT (LOOP.md Destructive-route rule: this overwrites a file Claude Code owns):
//  1. The folder is an existing directory strictly under $HOME, lexically AND after realpath (no
//     symlink escape), and never $HOME itself or /.
//  2. Only that one key changes. The file must round-trip exactly (JSON.parse, then JSON.stringify
//     with its own indentation, reproduces every byte), or nothing is written; the structural diff
//     between the old and new object must be that one key and nothing else. A folder with no entry
//     gets Claude Code's own default entry with the key set, exactly as its trust dialog writes it
//     (2.1.283 `sS()`/`nne`), because its reader (`Is()`) returns a stored entry without merging
//     defaults, so a bare { hasTrustDialogAccepted } entry would lack fields it reads.
//  3. Claude Code rewrites this file often, under its own lock: a `<file>.lock` directory
//     (proper-lockfile, `lockfilePath: "${file}.lock"` in 2.1.283). Alef takes that same lock for
//     the few milliseconds it needs (never removes one it didn't create), re-reads the file right
//     before the rename, writes a temp file with the same mode and renames it over the original
//     (atomic), then re-reads it to verify. A change between the read and the rename means a retry,
//     at most TRUST_WRITE_TRIES times, then a visible failure. A symlinked ~/.claude.json (stow,
//     chezmoi) is written through: the temp file goes next to the link's target and is renamed onto
//     it, so the link stays a link, as Claude Code's own writer does (`allowSymlink: true`); the
//     lock stays next to the link, where Claude Code takes it.
//  4. Before the first write of the day, the exact bytes read go to
//     ~/.alef-trash/<day>/claude-json/claude.json.<time> at mode 0600 (the file can hold tokens).
//  5. Nothing read from the file is logged or returned except the folder path.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord } from "../http.js";
import { trashDateKey } from "./cleanup-lib.js";
import { trashRootOf } from "./cleanup-trash.js";
import { isSecretPath } from "./safe-path.js";

export const TRUST_WRITE_TRIES = 3;
/** Waits between attempts to take Claude Code's config lock (about 1.5s in all). */
export const CLAUDE_LOCK_WAITS_MS: readonly number[] = [50, 100, 200, 400, 800];

/** Claude Code 2.1.283's default project entry (`nne`), with the trust key set. Fresh objects every call. */
export function defaultTrustedProjectEntry(): Record<string, unknown> {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

export type TrustCwdCheck = { ok: true; path: string } | { ok: false; status: 400 | 403 | 404; error: string };

function under(root: string, p: string): boolean {
  return p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Invariant 1: `cwd` is an existing directory strictly under `homeDir`, lexically and by realpath. */
export async function validateTrustCwd(homeDir: string, cwd: unknown): Promise<TrustCwdCheck> {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 1024 || cwd.includes("\0")) return { ok: false, status: 400, error: "cwd must be a folder path" };
  if (!isAbsolute(cwd)) return { ok: false, status: 400, error: "cwd must be an absolute path" };
  let realHome: string;
  try {
    realHome = await realpath(homeDir);
  } catch {
    return { ok: false, status: 404, error: "home folder not found" };
  }
  const lexical = resolve(cwd);
  if (lexical === "/" || lexical === resolve(homeDir) || lexical === realHome) return { ok: false, status: 403, error: "refusing to trust your whole home folder or /: pick a project folder" };
  if (!under(resolve(homeDir), lexical) && !under(realHome, lexical)) return { ok: false, status: 403, error: "refusing a folder outside your home folder" };
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return { ok: false, status: 404, error: "folder not found" };
  }
  if (real === "/" || real === realHome) return { ok: false, status: 403, error: "refusing to trust your whole home folder or /: pick a project folder" };
  if (!under(realHome, real)) return { ok: false, status: 403, error: "refusing a folder outside your home folder (it resolves elsewhere)" };
  // As a folder, every segment of it is a directory segment (isSecretPath only checks those above a file).
  if (isSecretPath(`${relative(realHome, real)}/_`)) return { ok: false, status: 403, error: "refusing a secrets folder" };
  try {
    if (!(await stat(real)).isDirectory()) return { ok: false, status: 400, error: "not a folder" };
  } catch {
    return { ok: false, status: 404, error: "folder not found" };
  }
  return { ok: true, path: real };
}

/** The indentation JSON.stringify must use to reproduce `raw` exactly, or null when nothing does. */
export function roundTripIndent(raw: string, parsed: unknown): string | null {
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const seen = /^\{\r?\n([ \t]+)"/.exec(body)?.[1];
  for (const indent of new Set([seen ?? "  ", "  ", "\t", "    "])) {
    if (JSON.stringify(parsed, null, indent) === body) return indent;
  }
  return null;
}

function entryTrusted(parsed: unknown, path: string): boolean {
  if (!isRecord(parsed) || !isRecord(parsed.projects) || !Object.hasOwn(parsed.projects, path)) return false;
  const entry = parsed.projects[path];
  return isRecord(entry) && entry.hasTrustDialogAccepted === true;
}

/** Invariant 2, structurally: `after` equals `before` except projects[path].hasTrustDialogAccepted
 *  (or, for a folder that had no entry, except that one new default entry). */
export function onlyTrustKeyChanged(before: unknown, after: unknown, path: string): boolean {
  if (!isRecord(before) || !isRecord(after) || !isRecord(before.projects) || !isRecord(after.projects)) return false;
  if (!entryTrusted(after, path)) return false;
  const strip = (o: Record<string, unknown>, projects: Record<string, unknown>, hadEntry: boolean): string => {
    const nextProjects: Record<string, unknown> = { ...projects };
    if (hadEntry) {
      const entry = projects[path];
      if (!isRecord(entry)) return "not-an-entry";
      const { hasTrustDialogAccepted: _dropped, ...rest } = entry;
      nextProjects[path] = rest;
    } else {
      delete nextProjects[path];
    }
    return JSON.stringify({ ...o, projects: nextProjects });
  };
  const hadEntry = Object.hasOwn(before.projects, path);
  if (!hadEntry && JSON.stringify(after.projects[path]) !== JSON.stringify(defaultTrustedProjectEntry())) return false;
  return strip(before, before.projects, hadEntry) === strip(after, after.projects, hadEntry);
}

export interface TrustWriteDeps {
  /** ~/.claude.json */
  claudeJsonPath: string;
  /** Where the daily safety copy goes (its ~/.alef-trash). */
  homeDir: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Test seam: runs after the temp file is written, right before the pre-rename re-read (a racing writer). */
  beforeRename?: () => Promise<void>;
}

export type TrustWriteResult =
  | { ok: true; path: string; alreadyTrusted: boolean; backup: string | null }
  | { ok: false; status: 409 | 500; error: string };

function code(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

async function takeClaudeLock(lockPath: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (err) {
      if (code(err) !== "EEXIST") throw err;
    }
    const wait = CLAUDE_LOCK_WAITS_MS[i];
    if (wait === undefined) return false;
    await sleep(wait);
  }
}

/** Invariant 4: the first write of the day keeps a copy of exactly what was read. */
async function backupOncePerDay(deps: TrustWriteDeps, raw: string): Promise<string | null> {
  const at = deps.now();
  const dir = join(trashRootOf(deps.homeDir), trashDateKey(at), "claude-json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await readdir(dir)).some((f) => f.startsWith("claude.json."))) return null;
  // Not a dotfile, so it shows up in Finder and a plain `ls`.
  const file = join(dir, `claude.json.${at.toISOString().replace(/[:.]/g, "-")}`);
  await writeFile(file, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return file;
}

/** Sets projects[path].hasTrustDialogAccepted = true under the SAFETY INVARIANT above. `path` must
 *  come from validateTrustCwd. Never throws. */
export async function writeFolderTrust(deps: TrustWriteDeps, path: string): Promise<TrustWriteResult> {
  const lockPath = `${deps.claudeJsonPath}.lock`;
  let locked = false;
  try {
    locked = await takeClaudeLock(lockPath, deps.sleep);
  } catch (err) {
    return { ok: false, status: 500, error: `couldn't take Claude Code's config lock: ${code(err) ?? String(err)}` };
  }
  if (!locked) return { ok: false, status: 409, error: "Claude Code is writing ~/.claude.json right now (its lock is held). Nothing was written; try again in a moment." };
  let tmp: string | null = null;
  try {
    for (let attempt = 1; attempt <= TRUST_WRITE_TRIES; attempt++) {
      // Every read and the rename go to the file itself: renamed onto a symlink, the temp file
      // replaced the link and the link's target never got the key (PR #55 review).
      const target = await realpath(deps.claudeJsonPath);
      const raw = await readFile(target, "utf8");
      const mode = (await stat(target)).mode & 0o777;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, status: 409, error: "~/.claude.json isn't valid JSON right now, so Alef left it alone." };
      }
      if (!isRecord(parsed) || !isRecord(parsed.projects)) return { ok: false, status: 409, error: "~/.claude.json has no projects map, so Alef left it alone. Open Claude in any folder once, then try again." };
      if (entryTrusted(parsed, path)) return { ok: true, path, alreadyTrusted: true, backup: null };
      const indent = roundTripIndent(raw, parsed);
      if (indent === null) return { ok: false, status: 409, error: "~/.claude.json wouldn't be rewritten byte-for-byte, so Alef left it alone. Answer the trust dialog in Terminal instead." };
      const before: unknown = JSON.parse(raw);
      const entry = parsed.projects[path];
      if (isRecord(entry)) entry.hasTrustDialogAccepted = true;
      else parsed.projects[path] = defaultTrustedProjectEntry();
      const next = JSON.stringify(parsed, null, indent) + (raw.endsWith("\n") ? "\n" : "");
      if (!onlyTrustKeyChanged(before, JSON.parse(next), path)) return { ok: false, status: 500, error: "the change touched more than the trust key, so nothing was written" };
      const backup = await backupOncePerDay(deps, raw);
      tmp = `${target}.alef-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, next, { encoding: "utf8", mode, flag: "wx" });
      await chmod(tmp, mode);
      await deps.beforeRename?.();
      if ((await readFile(target, "utf8")) !== raw) {
        await unlink(tmp);
        tmp = null;
        continue; // someone wrote it after our read: start over from their version
      }
      await rename(tmp, target);
      tmp = null;
      let written: unknown;
      try {
        written = JSON.parse(await readFile(deps.claudeJsonPath, "utf8")); // what Claude Code reads, through any link
      } catch {
        return { ok: false, status: 500, error: "wrote ~/.claude.json but it no longer parses; today's copy is in ~/.alef-trash" };
      }
      if (!entryTrusted(written, path)) return { ok: false, status: 500, error: "wrote the trust entry, but ~/.claude.json was rewritten right after without it. Try again." };
      return { ok: true, path, alreadyTrusted: false, backup };
    }
    return { ok: false, status: 409, error: `~/.claude.json kept changing while Alef tried to write it (${TRUST_WRITE_TRIES} tries), so nothing was written. Try again.` };
  } catch (err) {
    return { ok: false, status: 500, error: `couldn't write ~/.claude.json: ${code(err) ?? String(err)}` };
  } finally {
    if (tmp) await unlink(tmp).catch(() => undefined);
    if (locked) await rmdir(lockPath).catch(() => undefined);
  }
}

export type GrantResult = { ok: true; path: string; alreadyTrusted: boolean; backup: string | null } | { ok: false; status: number; error: string };

/** validateTrustCwd + writeFolderTrust: the one entry point every click goes through. */
export async function grantFolderTrust(deps: TrustWriteDeps, cwd: unknown): Promise<GrantResult> {
  const checked = await validateTrustCwd(deps.homeDir, cwd);
  if (!checked.ok) return checked;
  return writeFolderTrust(deps, checked.path);
}
