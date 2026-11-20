// The resident's sandbox: the ONE function that may change a file for it. Everything the
// resident writes (journal, goals, skills, state, proposals) goes through `writeInHome`, which
// the server enforces, not the model's prompt:
//   - `rel` is a plain relative path from a fixed allowlist of shapes (no absolute, no "..",
//     no NUL, no backslash, no hidden segment);
//   - the home itself and every directory on the way must be a real directory, never a symlink
//     (lstat, one segment at a time), and the target must be absent or a regular file;
//   - writes go to an O_EXCL temp file then rename; appends open with O_NOFOLLOW;
//   - after the write, the realpath must still sit inside the home's realpath;
//   - every accepted write appends one ResidentWrite line to `writes.jsonl` (the audit log).
// Anything else is refused with an error and nothing is written.

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import type { ResidentWrite } from "../../shared/features/resident.js";
import { isPlausibleRelPath } from "./safe-path.js";

export const AUDIT_LOG = "writes.jsonl";
export const MAX_WRITE_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 200;

/** The only file shapes the resident may write. The audit log is written by the sandbox itself. */
const ALLOWED_REL: readonly RegExp[] = [
  /^state\.json$/,
  /^goals\.md$/,
  /^proposals\.json$/,
  /^journal\/\d{4}-\d{2}-\d{2}\.md$/,
  /^skills\/[a-z0-9][a-z0-9-]{0,47}\.md$/,
];

export type SandboxResult = { ok: true; write: ResidentWrite } | { ok: false; error: string };

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Shape check only (no disk): exported so tests can table-drive it. */
export function checkRelShape(rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return "empty path";
  if (!isPlausibleRelPath(rel)) return "absolute or malformed path";
  if (rel.includes("\\")) return "backslash in path";
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return "dot or empty segment";
  if (!ALLOWED_REL.some((re) => re.test(rel))) return "path not on the resident allowlist";
  return null;
}

/** Ensures `home` exists as a real (non-symlink) directory and returns its realpath. */
async function ensureHome(home: string): Promise<string> {
  try {
    const st = await lstat(home);
    if (st.isSymbolicLink()) throw new Error("resident home is a symlink");
    if (!st.isDirectory()) throw new Error("resident home is not a directory");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(home, { recursive: true, mode: 0o700 });
  }
  return realpath(home);
}

/** Walks the parent segments of `rel` under `home`, creating missing dirs one by one and refusing
 *  any symlink or non-directory on the way. Returns the absolute target path. */
async function walkParents(home: string, rel: string): Promise<string> {
  const parts = rel.split("/");
  let cur = home;
  for (const seg of parts.slice(0, -1)) {
    cur = join(cur, seg);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw new Error(`symlink on path: ${seg}`);
      if (!st.isDirectory()) throw new Error(`not a directory: ${seg}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(cur, { mode: 0o700 });
    }
  }
  const target = join(cur, parts[parts.length - 1]!);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) throw new Error("target is a symlink");
    if (!st.isFile()) throw new Error("target is not a regular file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return target;
}

async function appendNoFollow(abs: string, content: string): Promise<void> {
  const fh = await open(abs, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
}

async function replaceAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.tmp-${randomBytes(6).toString("hex")}`;
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function assertStillInside(realHome: string, abs: string): Promise<void> {
  const real = await realpath(abs);
  if (!inside(realHome, real)) throw new Error("write resolved outside the resident home");
}

/** The resident's only write path. `mode` "replace" swaps the whole file; "append" adds to it. */
export async function writeInHome(
  home: string,
  rel: string,
  content: string,
  reason: string,
  mode: "replace" | "append" = "replace",
  now: () => number = Date.now,
): Promise<SandboxResult> {
  const shape = checkRelShape(rel);
  if (shape) return { ok: false, error: shape };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) return { ok: false, error: `content over ${MAX_WRITE_BYTES} bytes` };
  if (content.includes("\0")) return { ok: false, error: "NUL in content" };
  try {
    const realHome = await ensureHome(home);
    const abs = await walkParents(realHome, rel);
    if (mode === "append") await appendNoFollow(abs, content);
    else await replaceAtomic(abs, content);
    await assertStillInside(realHome, abs);
    const write: ResidentWrite = { at: new Date(now()).toISOString(), path: rel, bytes, reason: reason.replace(/\s+/g, " ").slice(0, MAX_REASON_CHARS) };
    const auditAbs = await walkParents(realHome, AUDIT_LOG);
    await appendNoFollow(auditAbs, `${JSON.stringify(write)}\n`);
    return { ok: true, write };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Reads (same symlink rules, so a planted link can't pull outside text into a prompt) ──────

/** Walks `rel`'s parents without creating anything; null when a segment is missing. */
async function existingPath(realHome: string, rel: string): Promise<string | null> {
  let cur = realHome;
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw new Error(`symlink on path: ${seg}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  return cur;
}

async function realHomeIfExists(home: string): Promise<string | null> {
  try {
    const st = await lstat(home);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("resident home is not a real directory");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return realpath(home);
}

/** Reads a file in the home (at most its last `maxBytes`). null = the home or file doesn't exist.
 *  Throws on anything the sandbox refuses (symlinks, a path off the allowlist). */
export async function readInHome(home: string, rel: string, maxBytes = 256 * 1024): Promise<string | null> {
  if (rel !== AUDIT_LOG) {
    const shape = checkRelShape(rel);
    if (shape) throw new Error(shape);
  }
  const realHome = await realHomeIfExists(home);
  if (!realHome) return null;
  const abs = await existingPath(realHome, rel);
  if (!abs) return null;
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Names of the `.md` files in a home subdirectory ("skills", "journal"); [] when absent. */
export async function listInHome(home: string, dir: "skills" | "journal"): Promise<string[]> {
  const realHome = await realHomeIfExists(home);
  if (!realHome) return [];
  const abs = await existingPath(realHome, dir);
  if (!abs) return [];
  return (await readdir(abs, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
}

/** mtime of a home file, or null (used to check the reflection artifact was written this run). */
export async function mtimeInHome(home: string, rel: string): Promise<number | null> {
  const realHome = await realHomeIfExists(home);
  if (!realHome) return null;
  const abs = await existingPath(realHome, rel);
  if (!abs) return null;
  const st = await lstat(abs);
  return st.isFile() ? st.mtimeMs : null;
}
