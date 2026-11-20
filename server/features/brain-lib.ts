// Pure helpers for the "brain" feature: wikilink parsing/resolution, the backlink index
// and the brain-graph.json slimming. No IO here except walkVault/buildVaultIndex, which
// only read files under the vault root.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { BrainGraphResponse, BrainGroup, BrainNode } from "../../shared/features/brain.js";
import type { VaultNote as FeedNote } from "../../shared/features/vault.js";
import { redactSecrets } from "../heuristics.js";
import { buildIndex, type BM25Index, type RecallDoc } from "./recall/bm25.js";
import { cleanMarkdown, titleOf } from "./recall/corpus.js";
import { isSecretPath } from "./safe-path.js";

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", ".git.nosync", ".home", ".claude", ".gstack", "node_modules", "_quarantine-dead-placeholders"]);
const MAX_NOTE_BYTES_FOR_INDEX = 512 * 1024;
const SEARCH_SNIPPET_CHARS = 240;

/** Raw wikilink targets in a note: [[target]], [[target|alias]], [[target#heading]], ![[embed]]. */
export function parseWikilinks(markdown: string): string[] {
  const out: string[] = [];
  const re = /!?\[\[([^\]\n]{1,300})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const inner = m[1] ?? "";
    const target = (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
    if (target) out.push(target);
  }
  return out;
}

function stripMd(p: string): string {
  return p.replace(/\.md$/i, "");
}

/** Obsidian-style resolver: exact vault path (without .md) first, else basename (shortest path wins). */
export class LinkResolver {
  private readonly byPath = new Map<string, string>();
  private readonly byBase = new Map<string, string>();

  constructor(notePaths: readonly string[]) {
    const sorted = [...notePaths].sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const p of sorted) {
      const key = stripMd(p).toLowerCase();
      if (!this.byPath.has(key)) this.byPath.set(key, p);
      const base = key.split("/").pop() ?? key;
      if (!this.byBase.has(base)) this.byBase.set(base, p);
    }
  }

  resolve(target: string): string | null {
    const key = stripMd(target.replace(/^\/+/, "")).toLowerCase();
    if (!key) return null;
    return this.byPath.get(key) ?? (key.includes("/") ? null : this.byBase.get(key) ?? null);
  }
}

export interface VaultNote {
  path: string; // vault-relative with .md
  title: string;
  links: string[]; // resolved vault-relative paths (deduped, self excluded)
}

export interface VaultIndex {
  builtAt: string;
  notes: VaultNote[];
  bm25: BM25Index;
  /** tag (no leading "#", lowercased) -> real occurrence count across the whole vault. Round 11,
   *  package D: the Legend's "tags" count. Inline #tags only; see extractTags. */
  tagCounts: Record<string, number>;
}

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// A tag starts with a letter (never purely numeric, so "#123" issue refs and "#1" ordinals
// don't count), and may contain letters/digits/_/-// for nested tags ("#project/foo").
const TAG_RE = /(^|[\s(>])#([A-Za-z][\w/-]*)/g;

/** Real inline #tags in a note's raw markdown (frontmatter and code fences/inline code excluded
 *  so a code sample's "# comment" or a heading-in-code never counts). Lowercased so "#Growth"
 *  and "#growth" are the same tag. */
export function extractTags(markdown: string): string[] {
  const noFrontmatter = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const stripped = noFrontmatter.replace(CODE_FENCE_RE, " ").replace(INLINE_CODE_RE, " ");
  const out = new Set<string>();
  for (const m of stripped.matchAll(TAG_RE)) {
    const t = m[2];
    if (t) out.add(t.toLowerCase());
  }
  return [...out];
}

/** All note paths (vault-relative, .md) — skips dot/system dirs and secret-looking files. */
export async function walkVault(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() ?? root;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name) && !it.name.startsWith(".")) stack.push(join(dir, it.name));
      } else if (it.isFile() && it.name.toLowerCase().endsWith(".md")) {
        const rel = relative(root, join(dir, it.name));
        if (!isSecretPath(rel)) out.push(rel);
      }
    }
  }
  return out.sort();
}

/** Extensions Obsidian itself treats as an embeddable attachment (images, PDFs, audio, video,
 *  office docs) — deliberately NOT "every non-.md file", which would also count vault
 *  infrastructure like 60-Meta/brain-graph.json or a stray .json/.yml config as an "attachment". */
const ATTACHMENT_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif",
  "pdf",
  "mp3", "wav", "m4a", "ogg", "flac", "aac",
  "mp4", "mov", "webm", "mkv",
  "docx", "pptx", "xlsx", "csv",
]);

/** Real attachment files under the vault, same skip-dir rules as walkVault. A count only — no
 *  paths kept — since a 60k+ node vault makes even that cheap-but-real. */
export async function countAttachments(root: string): Promise<number> {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() ?? root;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name) && !it.name.startsWith(".")) stack.push(join(dir, it.name));
      } else if (it.isFile() && !it.name.startsWith(".")) {
        const ext = it.name.toLowerCase().split(".").pop() ?? "";
        if (ATTACHMENT_EXTENSIONS.has(ext)) count++;
      }
    }
  }
  return count;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A copy that does not share storage with its source. V8 keeps a whole parent string alive
 *  behind a slice, so without this every note's full text (≈210MB for the real vault)
 *  stayed resident behind its 240-char snippet and title. */
function detach(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

/** Reads every note once: titles, resolved outlinks, a BM25 index for search, and vault-wide
 *  tag counts (round 11, package D's Legend). */
export async function buildVaultIndex(root: string, now: () => Date = () => new Date()): Promise<VaultIndex> {
  const paths = await walkVault(root);
  const resolver = new LinkResolver(paths);
  const read = await mapLimit(paths, 32, async (p): Promise<{ note: VaultNote; doc: RecallDoc; tags: string[] }> => {
    let raw = "";
    try {
      const abs = join(root, p);
      if ((await stat(abs)).size <= MAX_NOTE_BYTES_FOR_INDEX) raw = await readFile(abs, "utf8");
    } catch {
      /* unreadable (dataless iCloud file, raced delete): index the name only */
    }
    const title = detach(redactSecrets(titleOf(p.split("/").pop() ?? p, raw)));
    const links = new Set<string>();
    for (const t of parseWikilinks(raw)) {
      const r = resolver.resolve(t);
      if (r && r !== p) links.add(r);
    }
    const snippet = detach(redactSecrets(cleanMarkdown(raw).slice(0, SEARCH_SNIPPET_CHARS)));
    return { note: { path: p, title, links: [...links] }, doc: { path: p, title, snippet }, tags: extractTags(raw) };
  });
  const tagCounts: Record<string, number> = {};
  for (const r of read) for (const t of r.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  return { builtAt: now().toISOString(), notes: read.map((r) => r.note), bm25: buildIndex(read.map((r) => r.doc)), tagCounts };
}

/** Reverse link map: target path → notes linking to it. */
export function backlinkMap(notes: readonly VaultNote[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of notes) {
    for (const l of n.links) {
      const arr = map.get(l) ?? [];
      arr.push(n.path);
      map.set(l, arr);
    }
  }
  return map;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface RawGraphNode {
  i?: unknown;
  l?: unknown;
  p?: unknown;
  f?: unknown;
  d?: unknown;
  c?: unknown;
}

/** Top-level folder -> the "f" kind export_brain_graph.py writes, so the Brain's group filter
 *  reads the same whichever source built the graph. */
const FOLDER_KIND: Readonly<Record<string, string>> = {
  "10-Sessions": "session",
  "20-Projects": "project",
  "30-Knowledge": "knowledge",
  "40-Resources": "resource",
  "50-Wiki": "wiki",
  "50-Archives": "archive",
  "60-Meta": "meta",
};

/** export_brain_graph.py's get_label: drop a leading date, dashes to spaces, 50 chars. */
function feedLabel(pathNoExt: string): string {
  const base = pathNoExt.split("/").pop() ?? pathNoExt;
  const name = base.replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/-/g, " ").trim();
  return (name.length > 50 ? `${name.slice(0, 47)}...` : name) || base;
}

/** The vault's hourly graph feed (the one Vault reads) as a brain-graph.json-shaped object, so
 *  Brain and Vault draw the same notes and links. Notes only (attachments are not nodes); every
 *  resolved link kept, deduplicated as an undirected pair. No communities: nothing draws them. */
export function feedToGraph(notes: readonly FeedNote[]): { nodes: RawGraphNode[]; edges: Array<[number, number]>; links: number } {
  const index = new Map<string, number>();
  // The feed's own link count (every resolved link, one per direction, attachments included),
  // so Brain's "vault: N links" reads the same number as Vault's freshness line.
  const known = new Set(notes.map((n) => n.id));
  let links = 0;
  for (const n of notes) if (n.kind === "n") for (const t of n.links) if (known.has(t)) links++;
  const kept = notes.filter((n) => n.kind === "n");
  kept.forEach((n, i) => index.set(n.id, i));
  const degree = new Array<number>(kept.length).fill(0);
  const pairs = new Set<number>();
  const edges: Array<[number, number]> = [];
  kept.forEach((n, a) => {
    for (const target of n.links) {
      const b = index.get(target);
      if (b === undefined || b === a) continue;
      const key = a < b ? a * kept.length + b : b * kept.length + a;
      if (pairs.has(key)) continue;
      pairs.add(key);
      edges.push([a, b]);
      degree[a] = (degree[a] ?? 0) + 1;
      degree[b] = (degree[b] ?? 0) + 1;
    }
  });
  const nodes = kept.map((n, i): RawGraphNode => {
    const p = n.path.replace(/\.md$/i, "");
    return { i, l: feedLabel(p), p, f: FOLDER_KIND[folderOfPath(p)] ?? "other", d: degree[i] ?? 0, c: -1 };
  });
  return { nodes, edges, links };
}

/** The vault's link count: the feed's own when the graph came from it, else the file's edges. */
function linkTotal(obj: { links?: unknown }, rawEdges: readonly unknown[]): number {
  return typeof obj.links === "number" ? obj.links : rawEdges.length;
}

/** "20-Projects/x/plan" -> "20-Projects"; a root-level file -> "". */
function folderOfPath(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Top-`limit` nodes + the edges between them, grouped by top-level folder. Ranked by edges
 *  present in the file first (brain-graph.json keeps only 30k of the vault's links, so ranking
 *  by vault degree alone gave 1500 nodes with 153 drawable edges; this gives ~5.8k), then by
 *  vault degree. */
export function slimGraph(parsed: unknown, limit: number, generatedAt: string | null): BrainGraphResponse {
  const obj = typeof parsed === "object" && parsed !== null ? (parsed as { nodes?: unknown; edges?: unknown; links?: unknown }) : {};
  const rawNodes = Array.isArray(obj.nodes) ? (obj.nodes as RawGraphNode[]) : [];
  const rawEdges = Array.isArray(obj.edges) ? (obj.edges as unknown[]) : [];
  const fileDegree = new Map<number, number>();
  for (const e of rawEdges) {
    if (!Array.isArray(e) || typeof e[0] !== "number" || typeof e[1] !== "number") continue;
    fileDegree.set(e[0], (fileDegree.get(e[0]) ?? 0) + 1);
    fileDegree.set(e[1], (fileDegree.get(e[1]) ?? 0) + 1);
  }
  const nodes: BrainNode[] = rawNodes
    .filter((n) => typeof n.i === "number" && typeof n.p === "string")
    .map((n) => {
      const path = String(n.p);
      return {
        id: n.i as number,
        label: redactSecrets(decodeEntities(typeof n.l === "string" ? n.l : path)).slice(0, 120),
        path: decodeEntities(path),
        folder: folderOfPath(path),
        group: typeof n.f === "string" ? n.f : "other",
        degree: typeof n.d === "number" ? n.d : 0,
        community: typeof n.c === "number" ? n.c : -1,
      };
    })
    .sort((a, b) => (fileDegree.get(b.id) ?? 0) - (fileDegree.get(a.id) ?? 0) || b.degree - a.degree || a.id - b.id)
    .slice(0, limit);
  const keep = new Set(nodes.map((n) => n.id));
  const edges: Array<[number, number]> = [];
  for (const e of rawEdges) {
    if (!Array.isArray(e) || typeof e[0] !== "number" || typeof e[1] !== "number") continue;
    if (keep.has(e[0]) && keep.has(e[1])) edges.push([e[0], e[1]]);
  }
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
  const groups: BrainGroup[] = [...counts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
  return { ok: true, nodes, edges, groups, total: { nodes: rawNodes.length, edges: linkTotal(obj, rawEdges) }, generatedAt };
}

export interface VaultLegendCounts {
  totalNodes: number;
  totalLinks: number;
  folders: BrainGroup[]; // sorted by count desc
  groups: BrainGroup[]; // sorted by count desc
}

/** Folder + group ("f" kind) counts over EVERY node in brain-graph.json — round 11, package
 *  D's Legend needs the real vault-wide totals, not `slimGraph`'s top-N slice (a folder with
 *  only low-degree notes would otherwise vanish from the Legend entirely). */
export function vaultLegend(parsed: unknown): VaultLegendCounts {
  const obj = typeof parsed === "object" && parsed !== null ? (parsed as { nodes?: unknown; edges?: unknown; links?: unknown }) : {};
  const rawNodes = Array.isArray(obj.nodes) ? (obj.nodes as RawGraphNode[]) : [];
  const rawEdges = Array.isArray(obj.edges) ? (obj.edges as unknown[]) : [];
  const folderCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const n of rawNodes) {
    if (typeof n.p !== "string") continue;
    const folder = folderOfPath(decodeEntities(n.p));
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    const group = typeof n.f === "string" ? n.f : "other";
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }
  const toRows = (m: Map<string, number>): BrainGroup[] => [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
  return { totalNodes: rawNodes.length, totalLinks: linkTotal(obj, rawEdges), folders: toRows(folderCounts), groups: toRows(groupCounts) };
}
