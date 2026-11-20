// Pure extraction for the "shelf": URLs, claude.ai artifact links, files written and memory
// "learnings" from one parsed transcript. Transcript text is untrusted: only matched, never run.

import { isAbsolute, resolve } from "node:path";
import type { ShelfArtifact, ShelfFile, ShelfFileType, ShelfUrl } from "../../shared/features/shelf.js";
import { redactSecrets } from "../heuristics.js";
import type { TranscriptEntry } from "./transcript.js";

export const URL_RE = /https?:\/\/[^\s<>"'`\])}|\\]{2,500}/g;
export const ARTIFACT_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifacts?\/[A-Za-z0-9_-]{6,64}(?:[/?#]|$)/;
const WRITE_TOOLS = new Set(["Write", "NotebookEdit"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);
export const SENSITIVE_QUERY_KEYS = /^(token|access_token|id_token|key|api_key|apikey|secret|sig|signature|password|pwd|auth|code|session|x-amz-[a-z-]+)$/i;
const URL_CAP = 200;

/** http(s) only, trailing punctuation trimmed, sensitive query params dropped, secrets redacted. */
export function sanitizeUrl(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?*_~]+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) {
    u.username = "";
    u.password = "";
  }
  for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY_KEYS.test(k)) u.searchParams.delete(k);
  const out = redactSecrets(u.toString());
  return out.length <= 500 ? out : null;
}

/** The claude.ai artifact links in `text`: sanitized like every shelf URL, query and fragment
 *  dropped, deduped, in order of appearance. */
export function artifactUrlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    // an uppercase uuid reads as an opaque token to redactSecrets: ids are case-insensitive, so lower it first
    const url = sanitizeUrl(m[0].replace(/(\/code\/artifacts?\/)([0-9a-f]{8}-[0-9a-f-]{27})/i, (_, p: string, id: string) => p + id.toLowerCase()));
    if (url && ARTIFACT_RE.test(url)) out.add(url.split(/[?#]/)[0] ?? url);
  }
  return [...out];
}

function* stringsIn(v: unknown, depth = 0): Generator<string> {
  if (depth > 4) return;
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* stringsIn(x, depth + 1);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) yield* stringsIn(x, depth + 1);
}

export function fileTypeOf(path: string): ShelfFileType {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (["json", "yaml", "yml", "csv", "toml", "xml", "sql"].includes(ext)) return "data";
  if (["txt", "log"].includes(ext)) return "text";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "swift", "kt", "sh", "css", "scss", "c", "h", "cpp", "php", "vue", "svelte"].includes(ext)) return "code";
  return "other";
}

/** A memory/lessons file: ~/.claude/**\/memory/**, lessons.md, or a vault CLAUDE memory note. */
export function isLearningPath(abs: string): boolean {
  return /\/\.claude\/(?:projects\/[^/]+\/)?memory\//.test(abs) || /(?:^|\/)lessons\.md$/i.test(abs);
}

export interface ShelfExtract {
  urls: ShelfUrl[];
  artifacts: ShelfArtifact[];
  files: Array<Omit<ShelfFile, "previewable" | "exists">>;
}

export function extractShelf(entries: readonly TranscriptEntry[], cwd: string): ShelfExtract {
  const urls = new Map<string, ShelfUrl>();
  const artifacts = new Map<string, ShelfArtifact>();
  const files = new Map<string, Omit<ShelfFile, "previewable" | "exists"> & { order: number }>();
  let order = 0;

  const addUrl = (raw: string, at: string | null): void => {
    const url = sanitizeUrl(raw);
    if (!url) return;
    if (ARTIFACT_RE.test(url)) {
      const clean = url.split(/[?#]/)[0] ?? url;
      if (!artifacts.has(clean)) artifacts.set(clean, { url: clean, firstAt: at });
      return;
    }
    const prev = urls.get(url);
    if (prev) prev.count += 1;
    else if (urls.size < URL_CAP) urls.set(url, { url, host: new URL(url).host, count: 1, firstAt: at });
  };

  for (const e of entries) {
    for (const t of e.texts) for (const m of t.matchAll(URL_RE)) addUrl(m[0], e.at);
    for (const use of e.toolUses) {
      for (const s of stringsIn(use.input)) for (const m of s.matchAll(URL_RE)) addUrl(m[0], use.at);
      const isWrite = WRITE_TOOLS.has(use.name);
      if (!isWrite && !EDIT_TOOLS.has(use.name)) continue;
      const p = use.input.file_path ?? use.input.notebook_path;
      if (typeof p !== "string" || !p) continue;
      const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
      const prev = files.get(abs);
      order += 1;
      files.set(abs, {
        path: abs,
        type: fileTypeOf(abs),
        op: isWrite ? "write" : "edit",
        count: (prev?.count ?? 0) + 1,
        lastAt: use.at ?? prev?.lastAt ?? null,
        order,
      });
    }
  }
  return {
    urls: [...urls.values()],
    artifacts: [...artifacts.values()],
    files: [...files.values()].sort((a, b) => b.order - a.order).map(({ order: _o, ...f }) => f),
  };
}

export function previewContentType(path: string): string | null {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "md":
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "txt":
    case "log":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}
