// Which vault 20-Projects/<slug> note belongs to a project (DATA-7). Pure, so every rule is
// unit-tested (server/test/project-match-lib.test.ts). Four rules, the first that hits wins:
//   1. code_path  the note's frontmatter names the project's folder. The vault is shared by two
//                 Macs with different home folders, so a path is compared from its Documents/Code/
//                 part on ("/Users/<anyone>/Documents/Code/x" and "~/Documents/Code/x/" are x);
//   2. github     the note's frontmatter names the project's GitHub repo (its own or a folded clone's);
//   3. alias      brain_taxonomy.py's CANONICAL table turns the folder name into the slug the vault
//                 files it under ("alex-brain" -> alex-claude-brain, "acme-ai" -> acme);
//   4. name       the folder name itself, ignoring case and separators (the only rule before).
// Note text is untrusted: only a few frontmatter scalars are read, never executed or logged.

import type { VaultMatchRule } from "../../shared/features/projects.js";
import { githubRemote } from "./projects-lib.js";

export interface VaultProjectNote {
  /** The 20-Projects/<slug> folder name. */
  slug: string;
  /** Frontmatter `code_path`, as written. */
  codePath: string | null;
  /** Frontmatter `github`, as written (a URL or owner/repo). */
  github: string | null;
}

export interface VaultMatch {
  slug: string;
  by: VaultMatchRule;
}

export interface MatchTarget {
  /** Folder name. */
  name: string;
  /** Absolute folder path. */
  path: string;
  /** "owner/repo" of the project and of every clone folded into it. */
  remotes: readonly string[];
  /** Paths of the folders folded into it (worktrees, clones). */
  foldedPaths?: readonly string[];
}

/** A note's leading YAML block (group 1: its lines; undefined when the block is empty). */
export const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

/** Top-level `key: value` scalars of a note's YAML frontmatter (quotes stripped). Lists, nested
 *  maps and anything after the closing `---` are ignored. Empty when the note has none. */
export function frontmatterOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return out;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (v) out[kv[1]!] = v;
  }
  return out;
}

/** The parts of a note's head the matcher reads. */
export function noteFromText(slug: string, text: string): VaultProjectNote {
  const fm = frontmatterOf(text);
  return { slug, codePath: fm.code_path ?? null, github: fm.github ?? null };
}

/** A path as the matcher compares it: what follows Documents/Code/ (lowercased, no trailing
 *  slash), else the absolute path with ~ expanded. Null for an empty value. */
export function codeKey(path: string, home: string): string | null {
  const p = path.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, "");
  if (!p) return null;
  const at = p.indexOf("/Documents/Code/");
  return at >= 0 ? p.slice(at + "/Documents/Code/".length).toLowerCase() : p.toLowerCase();
}

/** "owner/repo" (lowercased) from a GitHub URL, an ssh remote or a bare owner/repo; else null. */
export function repoKey(v: string): string | null {
  const t = v.trim();
  const remote = githubRemote(t) ?? (/^[\w.-]+\/[\w.-]+$/.test(t) ? t.replace(/\.git$/, "") : null);
  return remote ? remote.toLowerCase() : null;
}

/** brain_taxonomy.py's CANONICAL as of 2026-10-27, used when the vault's own copy can't be read. */
export const FALLBACK_ALIASES: ReadonlyMap<string, string> = new Map([
  ["acme-ai", "acme"],
  ["acme-legal-ai", "acme"],
  ["myacme", "acme"],
  ["efirm", "acme"],
  ["bandidos", "acme-sovereign"],
  ["acme-vision", "acme-sovereign"],
  ["sovereign-acme-ai", "acme-sovereign"],
  ["alex-claude", "alex-claude-brain"],
  ["alex-brain", "alex-claude-brain"],
  ["acme-ai-sweep", "acme"],
  ["acme-ai-onit", "acme"],
]);

/** The `CANONICAL = { "old": "new", … }` table out of brain_taxonomy.py's source (the vault's
 *  single source of truth for slugs). Null when the file holds no such table. */
export function parseCanonicalAliases(py: string): Map<string, string> | null {
  const block = /^CANONICAL\s*=\s*\{([\s\S]*?)^\}/m.exec(py);
  if (!block) return null;
  const out = new Map<string, string>();
  for (const m of block[1]!.matchAll(/["']([^"'\n]+)["']\s*:\s*["']([^"'\n]+)["']/g)) out.set(m[1]!, m[2]!);
  return out.size > 0 ? out : null;
}

const WORKTREE = /^acme-wt-[\w-]+$/;

/** brain_taxonomy.canonical(): acme.ai website worktrees roll up to acme-ai-next; otherwise the
 *  name lowercased and hyphenated, then looked up in the alias table. */
export function canonicalSlug(name: string, aliases: ReadonlyMap<string, string>): string {
  const s = name.trim().replace(/^["']|["']$/g, "");
  if (WORKTREE.test(s)) return "acme-ai-next";
  const slug = s.replace(/[\s_]+/g, "-").toLowerCase();
  return aliases.get(slug) ?? slug;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The vault note for a project, and which rule found it. Null when none does. */
export function matchProjectNote(t: MatchTarget, notes: readonly VaultProjectNote[], aliases: ReadonlyMap<string, string>, home: string): VaultMatch | null {
  const paths = new Set([t.path, ...(t.foldedPaths ?? [])].map((p) => codeKey(p, home)).filter((k): k is string => k !== null));
  const byPath = notes.find((n) => n.codePath !== null && paths.has(codeKey(n.codePath, home) ?? "\0"));
  if (byPath) return { slug: byPath.slug, by: "code_path" };
  const repos = new Set(t.remotes.map((r) => r.toLowerCase()));
  const byRepo = repos.size ? notes.find((n) => n.github !== null && repos.has(repoKey(n.github) ?? "\0")) : undefined;
  if (byRepo) return { slug: byRepo.slug, by: "github" };
  const want = norm(t.name);
  if (!want) return null;
  const alias = canonicalSlug(t.name, aliases);
  if (norm(alias) !== want) {
    const hit = notes.find((n) => norm(n.slug) === norm(alias));
    if (hit) return { slug: hit.slug, by: "alias" };
  }
  const byName = notes.find((n) => norm(n.slug) === want);
  return byName ? { slug: byName.slug, by: "name" } : null;
}
