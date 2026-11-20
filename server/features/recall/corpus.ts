// Reads the fixed, read-only, private corpus for "From your notes": Alex's
// Claude Code memory files and vault project indexes on THIS machine. Never sends
// this content anywhere except into the local BM25 index (see docs/FEATURES.md's
// onIndexPass note: untrusted/private data is parsed, never executed, never shipped
// off-box beyond a short title in a TypeSafe call).

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../heuristics.js";
import type { RecallDoc } from "./bm25.js";
import { memoryDir, vaultRoot } from "../../config.js";

const MAX_FILE_BYTES = 200 * 1024;
const SNIPPET_CHARS = 160;
const BRAIN_GRAPH_MAX_BYTES = 20 * 1024 * 1024;
const BRAIN_GRAPH_TOP_N = 2000; // "titles if cheap" — top N by graph degree, not all ~38k nodes

export interface CorpusRoots {
  memoryDir: string;
  vaultProjectsDir: string;
  brainGraphPath: string;
}

export function defaultCorpusRoots(): CorpusRoots {
  const home = homedir();
  return {
    memoryDir: memoryDir(home),
    vaultProjectsDir: join(vaultRoot(home), "20-Projects"),
    brainGraphPath: join(vaultRoot(home), "60-Meta", "brain-graph.json"),
  };
}

/** Strips vault boilerplate that would otherwise pollute the title/snippet (frontmatter,
 *  the auto-generated "Smart Connections" footer, wiki links, images, code fences). */
export function cleanMarkdown(txt: string): string {
  return txt
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\n---\s*\n## Smart Connections[\s\S]*$/m, "")
    .replace(/\[\[([^\]|]+)\|[^\]]+\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/[#>*_~|-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function titleOf(fileBaseName: string, raw: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fm?.[1]) {
    const nm = fm[1].match(/^\s*(?:name|title)\s*:\s*(.+)$/im);
    if (nm?.[1]) {
      const v = nm[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v.slice(0, 120);
    }
  }
  let inFrontmatter = false;
  for (const ln of raw.split("\n")) {
    if (ln.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    const t = ln.replace(/^#+\s*/, "").trim();
    if (!t || t.startsWith("[[") || /^[a-z_]+\s*:/.test(t)) continue;
    return t.slice(0, 120);
  }
  return fileBaseName
    .replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-/g, " ")
    .slice(0, 120);
}

async function readMarkdownDoc(path: string): Promise<RecallDoc | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const clean = cleanMarkdown(raw);
  if (!clean) return null;
  const title = redactSecrets(titleOf(path.split("/").pop() ?? path, raw));
  const snippet = redactSecrets(clean.slice(0, SNIPPET_CHARS));
  return { path, title, snippet };
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => join(dir, e.name));
}

/** Top-level *.md only — matches the corpus definition in tasks/todo.md exactly
 *  (not a recursive vault walk: the _L2/ subdirectory etc. is intentionally excluded). */
async function walkMemoryDocs(memoryDir: string): Promise<RecallDoc[]> {
  const files = await listMarkdownFiles(memoryDir);
  const docs = await Promise.all(files.map(readMarkdownDoc));
  return docs.filter((d): d is RecallDoc => d !== null);
}

async function walkVaultIndexDocs(vaultProjectsDir: string): Promise<RecallDoc[]> {
  let entries;
  try {
    entries = await readdir(vaultProjectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths = entries.filter((e) => e.isDirectory()).map((e) => join(vaultProjectsDir, e.name, "_index.md"));
  const docs = await Promise.all(paths.map(readMarkdownDoc));
  return docs.filter((d): d is RecallDoc => d !== null);
}

interface BrainGraphNode {
  l?: unknown; // label (title)
  p?: unknown; // vault-relative path
  d?: unknown; // degree (connectivity) — used to rank, not shown
}

/** brain-graph.json is ~7MB / ~38k nodes: titles only, and only the top-N by degree
 *  ("if cheap" — parsing it is a single JSON.parse, well under a second; keeping all
 *  38k as BM25 documents would not be). Pseudo-paths (no real file to open). */
async function walkBrainGraphTitles(brainGraphPath: string): Promise<RecallDoc[]> {
  let st;
  try {
    st = await stat(brainGraphPath);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > BRAIN_GRAPH_MAX_BYTES) return [];
  let raw: string;
  try {
    raw = await readFile(brainGraphPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return (nodes as BrainGraphNode[])
    .filter((n) => typeof n.l === "string" && n.l.trim().length > 1)
    .sort((a, b) => (typeof b.d === "number" ? b.d : 0) - (typeof a.d === "number" ? a.d : 0))
    .slice(0, BRAIN_GRAPH_TOP_N)
    .map((n) => {
      const title = redactSecrets(String(n.l).slice(0, 120));
      const p = typeof n.p === "string" ? n.p : title;
      return { path: `brain-graph:${p}`, title, snippet: title };
    });
}

export async function walkCorpus(roots: CorpusRoots = defaultCorpusRoots()): Promise<RecallDoc[]> {
  const [memory, vault, brain] = await Promise.all([
    walkMemoryDocs(roots.memoryDir),
    walkVaultIndexDocs(roots.vaultProjectsDir),
    walkBrainGraphTitles(roots.brainGraphPath),
  ]);
  return [...memory, ...vault, ...brain];
}
