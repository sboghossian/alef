// Path safety for every read-only file endpoint (code, brain, shelf preview).
// A request path is resolved against a fixed root and must stay inside it twice:
// lexically (no "../", no absolute escape) and after realpath (no symlink escape).
// Secret-looking files (.env*, *.pem, id_*, *.key, …) are refused before any read.

import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export type SafePathError = "bad-path" | "outside-root" | "secret" | "not-found";

export type SafeResolve = { ok: true; abs: string; rel: string } | { ok: false; error: SafePathError };

const SECRET_BASENAME_RES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_[^/]*$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keychain(-db)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^credentials(\.[a-z]+)?$/i,
  /^\.git-credentials$/i,
  /^\.claude\.json$/i, // Claude Code's own state: OAuth account, per-project settings
];
/** Credential files known by their last two path segments (gh's token, docker and kube auth). */
const SECRET_TAILS = new Set(["gh/hosts.yml", ".docker/config.json", ".kube/config"]);
/** Directory segments whose whole subtree is refused. */
const SECRET_DIR_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".git", ".git.nosync"]);

/** True when a (relative or absolute) path names a file we never serve. */
export function isSecretPath(p: string): boolean {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (SECRET_BASENAME_RES.some((re) => re.test(name))) return true;
  if (SECRET_TAILS.has(parts.slice(-2).join("/").toLowerCase())) return true;
  return parts.slice(0, -1).some((seg) => SECRET_DIR_SEGMENTS.has(seg));
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Validates the shape of a user-supplied relative path (no NUL, no absolute, bounded length). */
export function isPlausibleRelPath(raw: string): boolean {
  if (raw.length > 1024 || raw.includes("\0")) return false;
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("~")) return false;
  return true;
}

/** Resolves `rel` inside `root` (both checks: lexical and realpath). `rel` "" = the root itself.
 *  With `allowAbsolute`, an absolute path is accepted when it is itself inside the root. */
export async function resolveInside(root: string, rel: string, opts: { allowAbsolute?: boolean } = {}): Promise<SafeResolve> {
  if (rel.length > 1024 || rel.includes("\0")) return { ok: false, error: "bad-path" };
  if (!opts.allowAbsolute && !isPlausibleRelPath(rel)) return { ok: false, error: "bad-path" };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, error: "not-found" };
  }
  const lexical = resolve(root, rel);
  const lexicalRoot = resolve(root);
  if (!inside(lexicalRoot, lexical) && !inside(realRoot, lexical)) return { ok: false, error: "outside-root" };
  // Refuse secret names before touching the disk, so a refusal never reveals whether one exists.
  if (isSecretPath(relative(inside(lexicalRoot, lexical) ? lexicalRoot : realRoot, lexical))) return { ok: false, error: "secret" };
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!inside(realRoot, real)) return { ok: false, error: "outside-root" };
  const relOut = relative(realRoot, real);
  if (isSecretPath(relOut) || isSecretPath(basename(lexical))) return { ok: false, error: "secret" };
  return { ok: true, abs: real, rel: relOut };
}

/** HTTP status for a SafePathError. */
export function safePathStatus(e: SafePathError): number {
  return e === "bad-path" ? 400 : e === "not-found" ? 404 : 403;
}

export type TextRead = { ok: true; text: string; size: number } | { ok: false; status: number; error: string };

/** Reads a small text file: refuses dirs, files over `maxBytes` (413) and binaries (415: a NUL in the first 8KB). */
export async function readTextCapped(abs: string, maxBytes: number): Promise<TextRead> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!st.isFile()) return { ok: false, status: 400, error: "not a file" };
  if (st.size > maxBytes) return { ok: false, status: 413, error: `file is larger than ${Math.round(maxBytes / 1024)}KB` };
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, 8192).includes(0)) return { ok: false, status: 415, error: "binary file" };
    return { ok: true, text: data.toString("utf8"), size: bytesRead };
  } finally {
    await fh.close();
  }
}
