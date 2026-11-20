// Saves a local copy of an artifact's source page (data/artifacts/<id>.html) so the Museum can
// preview it after the scratchpad that held it is wiped. Only .html/.htm pages, at most
// ARTIFACT_SNAPSHOT_MAX_BYTES, secrets redacted. Refused before any fs call: secret-looking paths
// (safe-path.ts) and macOS privacy-guarded folders (privacy-guard.ts: a launchd-started node hangs
// opening anything under ~/Desktop or ~/Downloads). Both checks run again on the realpath, so a
// symlink can't lead into either. All fs work is async; the event loop never waits on a read.

import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID_RE, ARTIFACT_SNAPSHOT_MAX_BYTES } from "../../shared/features/artifacts.js";
import { redactSecrets } from "../heuristics.js";
import { isPrivacyGuarded } from "../privacy-guard.js";
import { isSecretPath } from "./safe-path.js";

export type SnapshotError = "bad-path" | "secret" | "privacy-guarded" | "not-html" | "not-found" | "not-a-file" | "too-large";

export type SnapshotResult =
  | { ok: true; changed: boolean; mtimeMs: number; size: number }
  | { ok: false; error: SnapshotError };

export interface SnapshotOptions {
  home: string;
  platform?: NodeJS.Platform;
  maxBytes?: number;
}

/** Why `p` may never be read (lexical: no fs call), or null. */
export function refuseSource(p: string, opts: SnapshotOptions): SnapshotError | null {
  if (!p || !isAbsolute(p) || p.includes("\0") || p.length > 2048) return "bad-path";
  if (isSecretPath(p)) return "secret";
  if (isPrivacyGuarded(p, opts.home, opts.platform)) return "privacy-guarded";
  if (!/\.html?$/i.test(p)) return "not-html";
  return null;
}

export function snapshotPath(dir: string, id: string): string {
  if (!ARTIFACT_ID_RE.test(id)) throw new Error(`bad artifact id: ${id}`);
  return join(dir, `${id}.html`);
}

/** Copies `source` to `<dir>/<id>.html` unless `prev` (the source's stat at the last copy) still
 *  matches. A refusal or a missing source never touches an existing copy. */
export async function snapshotSource(
  source: string,
  dir: string,
  id: string,
  prev: { mtimeMs: number; size: number } | null,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const refused = refuseSource(source, opts);
  if (refused) return { ok: false, error: refused };
  let real: string;
  try {
    real = await realpath(source);
  } catch {
    return { ok: false, error: "not-found" };
  }
  // Check the resolved path against $HOME both as given and resolved (/var → /private/var, say).
  const realHome = await realpath(opts.home).catch(() => opts.home);
  const refusedReal = refuseSource(real, opts) ?? refuseSource(real, { ...opts, home: realHome });
  if (refusedReal) return { ok: false, error: refusedReal };
  let st;
  try {
    st = await stat(real);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!st.isFile()) return { ok: false, error: "not-a-file" };
  if (st.size > (opts.maxBytes ?? ARTIFACT_SNAPSHOT_MAX_BYTES)) return { ok: false, error: "too-large" };
  const dest = snapshotPath(dir, id);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    try {
      await stat(dest);
      return { ok: true, changed: false, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      /* the copy is gone: take it again */
    }
  }
  const text = redactSecrets((await readFile(real)).toString("utf8"));
  await mkdir(dir, { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { ok: true, changed: true, mtimeMs: st.mtimeMs, size: st.size };
}
