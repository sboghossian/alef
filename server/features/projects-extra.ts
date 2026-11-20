// Three small readers the Projects feature joins onto its scan, ported from the retired roadmap
// service: preview screenshots (matched to a project by folder name, served read-only from a folder
// of images), Obsidian session notes counted per project and source (explicit `project:` frontmatter
// only), and the optional hand-written notes file (data/projects-notes.json). Everything is async and
// bounded; all file text is untrusted data.

import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { SESSION_SOURCES, type ProjectNotes, type SessionSource, type VaultSessions } from "../../shared/features/projects.js";
import { yieldToLoop } from "./cache-lib.js";
import { readHead } from "./projects-scan.js";

// ---------------------------------------------------------------- previews

export const PREVIEW_TYPES: Readonly<Record<string, string>> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
export const PREVIEW_MAX_BYTES = 2_000_000;

/** lowercased project name -> file name, for image files of `dir` (empty when it is missing). */
export async function listPreviews(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of names.sort()) {
    const ext = extname(f).toLowerCase();
    if (!PREVIEW_TYPES[ext]) continue;
    let stem = f.slice(0, -ext.length);
    try {
      stem = decodeURIComponent(stem);
    } catch {
      /* keep the raw stem */
    }
    const key = stem.toLowerCase();
    if (!out.has(key) || ext === ".webp") out.set(key, f);
  }
  return out;
}

/** Previews across folders in order (Alef's own copy first, then the roadmap's): per project name the first folder holding one wins. */
export async function listPreviewsIn(dirs: readonly string[]): Promise<Map<string, { dir: string; file: string }>> {
  const out = new Map<string, { dir: string; file: string }>();
  for (const dir of dirs) for (const [key, file] of await listPreviews(dir)) if (!out.has(key)) out.set(key, { dir, file });
  return out;
}

/** The preview file for a project: its own name first, then the names of the folders folded into it. */
export function previewFor<T>(names: readonly string[], previews: ReadonlyMap<string, T>): T | null {
  for (const n of names) {
    const hit = previews.get(n.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Reads a preview if its real path stays inside the real previews folder, is an image type and is a plain file under the size cap. */
export async function readPreview(dir: string, file: string): Promise<{ type: string; body: Buffer } | null> {
  const type = PREVIEW_TYPES[extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const root = await realpath(dir);
    const real = await realpath(join(root, file));
    if (!real.startsWith(root + sep)) return null;
    const st = await stat(real);
    if (!st.isFile() || st.size > PREVIEW_MAX_BYTES || (st.size > 0 && st.blocks === 0)) return null;
    return { type, body: await readFile(real) };
  } catch {
    return null;
  }
}

export const PREVIEW_MIRROR_MAX_BYTES = 20_000_000;

/**
 * Copies the image files of `src` into `dest` once, so the thumbnails survive the roadmap folder
 * being archived. Does nothing when `dest` already exists or `src` is missing. Same filters as
 * readPreview (image types, plain files inside `src` by real path, under the per-file cap, not
 * dataless), at most `capBytes` in all. Built in a temp folder and renamed into place, so `dest`
 * is either complete or absent. Returns the number of files copied, or null when it did nothing.
 */
export async function mirrorPreviews(src: string, dest: string, capBytes = PREVIEW_MIRROR_MAX_BYTES): Promise<number | null> {
  if (await stat(dest).then(() => true, () => false)) return null;
  const root = await realpath(src).catch(() => null);
  if (!root) return null;
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    let total = 0;
    let copied = 0;
    for (const f of (await readdir(root)).sort()) {
      if (!PREVIEW_TYPES[extname(f).toLowerCase()]) continue;
      const real = await realpath(join(root, f)).catch(() => null);
      if (!real || !real.startsWith(root + sep)) continue;
      const st = await stat(real);
      if (!st.isFile() || st.size > PREVIEW_MAX_BYTES || (st.size > 0 && st.blocks === 0) || total + st.size > capBytes) continue;
      await copyFile(real, join(tmp, f), constants.COPYFILE_EXCL);
      total += st.size;
      copied += 1;
      if (copied % 20 === 0) await yieldToLoop();
    }
    await rename(tmp, dest);
    return copied;
  } catch {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------- vault session notes

/** Legacy / synonym project labels in the vault, folded onto the folder name (the roadmap's own table). */
const SLUG_NORMALIZE: Readonly<Record<string, string>> = { "acme-legal-ai": "acme-ai", "alex-claude-brain": "alex_claude", "second-brain": "alex_claude" };
const GENERIC_LABELS = new Set(["documents-code", "home", "root", "unknown", ""]);

/** The `project:` value of a session note's frontmatter, lowercased and normalized; null when absent or generic. */
export function projectLabelOf(head: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(head);
  const m = /^project:\s*["']?([^\n"']*)/m.exec(fm?.[1] ?? "");
  if (!m) return null;
  const raw = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (GENERIC_LABELS.has(raw)) return null;
  return SLUG_NORMALIZE[raw] ?? raw;
}

const labelCache = new Map<string, { mtimeMs: number; label: string | null }>();

/** label -> count per source across vault 10-Sessions. mtime-cached, 40 notes at a time, yields to the loop. */
export async function scanVaultSessions(sessionsDir: string): Promise<Map<string, VaultSessions>> {
  const out = new Map<string, VaultSessions>();
  for (const source of SESSION_SOURCES) {
    const dir = join(sessionsDir, source);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (let i = 0; i < files.length; i += 40) {
      await Promise.all(
        files.slice(i, i + 40).map(async (f) => {
          const path = join(dir, f);
          try {
            const st = await stat(path);
            let hit = labelCache.get(path);
            if (!hit || hit.mtimeMs !== st.mtimeMs) {
              const head = await readHead(path, 1500);
              hit = { mtimeMs: st.mtimeMs, label: head === null ? null : projectLabelOf(head) };
              if (head !== null) labelCache.set(path, hit); // an unreadable (e.g. dataless) note is retried next scan
            }
            if (hit.label) {
              const row = out.get(hit.label) ?? {};
              row[source as SessionSource] = (row[source as SessionSource] ?? 0) + 1;
              out.set(hit.label, row);
            }
          } catch {
            /* a note that vanished mid-scan */
          }
        }),
      );
      await yieldToLoop();
    }
  }
  return out;
}

export function sessionsFor(names: readonly string[], byLabel: ReadonlyMap<string, VaultSessions>): VaultSessions | null {
  for (const n of names) {
    const hit = byLabel.get(n.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- notes file

const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 30).map((x) => x.slice(0, max)) : []);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const httpUrl = (v: unknown): string | null => {
  const s = str(v, 300);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

const dateOnly = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** data/projects-notes.json: { "<folder name>": { desc, longDesc, milestones[], nextSteps[], started, url | liveUrl, asOf?, sources?, stale? } }. Missing or malformed gives an empty map. */
export async function loadNotes(path: string | null): Promise<Map<string, ProjectNotes>> {
  const out = new Map<string, ProjectNotes>();
  if (!path) return out;
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    for (const [name, v] of Object.entries(raw)) {
      if (typeof v !== "object" || v === null) continue;
      const r = v as Record<string, unknown>;
      out.set(name.toLowerCase(), { desc: str(r.desc, 300), longDesc: str(r.longDesc, 1500), milestones: strs(r.milestones, 240), nextSteps: strs(r.nextSteps, 240), started: str(r.started, 10), liveUrl: httpUrl(r.liveUrl ?? r.url), asOf: dateOnly(r.asOf), sources: strs(r.sources, 80).slice(0, 8), stale: r.stale === true });
    }
  } catch {
    /* absent: the feature works without it */
  }
  return out;
}
