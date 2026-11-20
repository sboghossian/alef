// The IO half of the "projects" feature: list ~/Documents/Code, read one folder's facts (git, README,
// manifests, deploy config) and list one level of a folder. Everything is async, bounded and
// timed out: a stuck folder (an iCloud dataless file, a hung git) costs its own facts, never the
// scan or the event loop. Nothing here opens a privacy-guarded folder (privacy-guard.ts), a
// credential-looking folder's files, or a dataless file (size > 0 with no blocks: reading it
// downloads it and can hang).

import { execFile } from "node:child_process";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { COMMIT_COUNT_CAP, TREE_MAX_ENTRIES, type ProjectGit, type ProjectTreeEntry } from "../../shared/features/projects.js";
import { isPrivacyGuarded } from "../privacy-guard.js";
import { isRefusedRoot } from "./code-repos.js";
import { branchOfHead, DEPLOY_FILES, githubRemote, homepageOf, isSkippedFolderName, originUrl, readmeLine, type StackInput } from "./projects-lib.js";
import { FALLBACK_ALIASES, noteFromText, parseCanonicalAliases, type VaultProjectNote } from "./project-match-lib.js";
import { isSecretPath } from "./safe-path.js";

/** Folder names whose files are never opened (README/package reads skipped); the folder is still listed. */
const CREDENTIAL_NAME_RE = /secret|credential|token|passw(?:or)?d|passwd|keychain|keys?(?:[-_.]|$)|passwordmanager|api[-_]?key|\.env|private[-_]?key/i;
export const isCredentialName = (name: string): boolean => CREDENTIAL_NAME_RE.test(name);

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Top-level directories of `codeDir` (real directories only: a symlink is skipped, so a link can't
 *  lead the scan out of the folder), dot-folders and node_modules left out. Sorted by name. */
export async function listCodeFolders(codeDir: string): Promise<string[]> {
  if (isPrivacyGuarded(codeDir, process.env.HOME ?? "/")) return [];
  // A missing or unreadable folder lists nothing (the districts still make the list), never a failed scan.
  const r = await withTimeout(readdir(codeDir, { withFileTypes: true }), 8_000).catch(() => "timeout" as const);
  if (r === "timeout") return [];
  return r
    .filter((e) => e.isDirectory() && !isSkippedFolderName(e.name))
    .map((e) => join(codeDir, e.name))
    .sort((a, b) => a.localeCompare(b));
}

/** Reads at most `max` bytes of a plain file; null when absent, not a file, dataless or unreadable. */
export async function readHead(path: string, max: number): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || (st.size > 0 && st.blocks === 0)) return null;
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(max, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** Runs git with a hard timeout (the child is killed); null on any failure or timeout. */
function git(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => resolve(err ? null : stdout.toString().trim()));
  });
}

export interface FolderFacts {
  isGit: boolean;
  git: ProjectGit | null;
  readme: string | null;
  stack: StackInput;
  deploy: string | null;
  /** True when a git command timed out. */
  timedOut: boolean;
  /** True when the folder was left unread (guarded, refused root). */
  unread: boolean;
  /** Main working tree of the repo when this folder is a LINKED worktree (its .git is a file pointing
   *  at <main>/.git/worktrees/<name>); null otherwise. */
  worktreeOf: string | null;
  /** True when that worktree is stale: the main repo no longer lists it (git commands fail there). */
  worktreeStale: boolean;
  /** File-time dating for a folder with no readable commit: newest mtime of the folder and its
   *  top-level entries, and how many entries counted. Null when not computed. */
  files: FilesDate | null;
}

export interface FilesDate {
  newest: string | null;
  entries: number;
}

export const EMPTY_FACTS: FolderFacts = { isGit: false, git: null, readme: null, stack: {}, deploy: null, timedOut: false, unread: true, worktreeOf: null, worktreeStale: false, files: null };

/** Where a folder's git data lives. `.git` a directory: there. `.git` a file ("gitdir: <path>"): a
 *  linked worktree (or a moved gitdir such as .git.nosync); HEAD lives in the gitdir, config in the
 *  common dir (`<gitdir>/commondir`). `worktreeOf` is the main working tree when the common dir is a
 *  "<main>/.git" and the gitdir sits in its worktrees/. Null when there is no readable .git. */
export async function gitLayout(folder: string): Promise<{ gitDir: string; commonDir: string; worktreeOf: string | null; stale: boolean } | null> {
  const dotGit = join(folder, ".git");
  const st = await lstat(dotGit).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit, worktreeOf: null, stale: false };
  if (!st.isFile()) return null;
  const text = await readHead(dotGit, 1024);
  const m = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  const gitDir = isAbsolute(raw) ? resolve(raw) : resolve(folder, raw);
  const inWorktrees = basename(dirname(gitDir)) === "worktrees" && basename(dirname(dirname(gitDir))) === ".git";
  const common = (await readHead(join(gitDir, "commondir"), 1024))?.trim();
  // A stale worktree (its admin dir was pruned, so no commondir): the path still names its main repo.
  const commonDir = common ? (isAbsolute(common) ? resolve(common) : resolve(gitDir, common)) : inWorktrees ? dirname(dirname(gitDir)) : gitDir;
  const linked = inWorktrees && commonDir !== gitDir && basename(commonDir) === ".git";
  return { gitDir, commonDir, worktreeOf: linked ? dirname(commonDir) : null, stale: linked && !common };
}

/** Names never used to date a folder: Finder and editors rewrite them without anyone working there. */
const DATE_SKIP = new Set([".DS_Store", ".localized", "Icon\r", ".git", ".git.nosync", "node_modules", ".idea", ".vscode"]);
const DATE_MAX_ENTRIES = 300;

/** Dates a folder by its own mtime and its top-level entries' mtimes (lstat only: no file is opened,
 *  no recursion, a dataless file is skipped, at most DATE_MAX_ENTRIES entries, 4 s budget). */
export async function filesDate(folder: string): Promise<FilesDate | null> {
  const r = await withTimeout(readdir(folder, { withFileTypes: true }), 4_000).catch(() => null);
  if (!r || r === "timeout") return null;
  const names = r.filter((e) => !DATE_SKIP.has(e.name)).slice(0, DATE_MAX_ENTRIES).map((e) => e.name);
  let newest = 0;
  let entries = 0;
  const own = await lstat(folder).catch(() => null);
  if (own) newest = own.mtimeMs;
  const stats = await withTimeout(mapLimit(names, 16, (n) => lstat(join(folder, n)).catch(() => null)), 4_000);
  if (stats !== "timeout") {
    for (const s of stats) {
      if (!s || (s.isFile() && s.size > 0 && s.blocks === 0)) continue;
      entries += 1;
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
  }
  return { newest: newest > 0 ? new Date(newest).toISOString() : null, entries };
}

export interface ProbeOptions {
  home: string;
  gitTimeoutMs: number;
}

export async function probeFolder(path: string, name: string, opts: ProbeOptions): Promise<FolderFacts> {
  if (isPrivacyGuarded(path, opts.home) || isRefusedRoot(path, opts.home)) return EMPTY_FACTS;
  const guardedFiles = isCredentialName(name);
  const layout = await gitLayout(path);
  const isGit = layout !== null;
  let git_: ProjectGit | null = null;
  let timedOut = false;
  if (layout) {
    const gitPath = layout.gitDir;
    const [head, config] = await Promise.all([readHead(join(gitPath, "HEAD"), 512), readHead(join(layout.commonDir, "config"), 64 * 1024)]);
    const url = config ? originUrl(config) : null;
    const [last, count] = await Promise.all([git(path, ["log", "-1", "--format=%cI"], opts.gitTimeoutMs), git(path, ["rev-list", "--count", `--max-count=${COMMIT_COUNT_CAP}`, "HEAD"], opts.gitTimeoutMs)]);
    const n = count !== null && /^\d+$/.test(count) ? Number(count) : null;
    // A fresh repo fails log/rev-list too; its branch ref and packed-refs are missing. Anything else that failed timed out.
    const branch = head ? branchOfHead(head) : null;
    const empty = branch !== null && !(await exists(join(layout.commonDir, "refs", "heads", branch))) && !(await exists(join(layout.commonDir, "packed-refs")));
    timedOut = (last === null || n === null) && !empty && !layout.stale;
    git_ = { remote: url ? githubRemote(url) : null, branch: head ? branchOfHead(head) : null, lastCommit: last && !Number.isNaN(Date.parse(last)) ? last : null, commits: n };
  }
  const worktreeOf = layout?.worktreeOf ?? null;
  const worktreeStale = layout?.stale ?? false;
  // No readable commit: date the folder by its file times instead (names and mtimes only).
  const files = git_?.lastCommit ? null : await filesDate(path);
  if (guardedFiles) return { isGit, git: git_, readme: null, stack: {}, deploy: null, timedOut, unread: false, worktreeOf, worktreeStale, files };
  const [readmeText, pkg, pyproject, requirements, cargo, goMod, swift] = await Promise.all([
    readFirst(path, ["README.md", "readme.md", "Readme.md", "README"], 4096),
    readHead(join(path, "package.json"), 256 * 1024),
    readHead(join(path, "pyproject.toml"), 16 * 1024),
    readHead(join(path, "requirements.txt"), 8 * 1024),
    exists(join(path, "Cargo.toml")),
    exists(join(path, "go.mod")),
    exists(join(path, "Package.swift")),
  ]);
  let deploy: string | null = null;
  for (const f of DEPLOY_FILES) {
    if (await exists(join(path, f))) {
      deploy = f;
      break;
    }
  }
  if (!deploy && pkg && homepageOf(pkg)) deploy = "package.json homepage";
  return { isGit, git: git_, readme: readmeText ? readmeLine(readmeText) : null, stack: { packageJson: pkg, pyproject, requirements, cargo, goMod, swift }, deploy, timedOut, unread: false, worktreeOf, worktreeStale, files };
}

async function readFirst(dir: string, names: readonly string[], max: number): Promise<string | null> {
  for (const n of names) {
    const t = await readHead(join(dir, n), max);
    if (t !== null) return t;
  }
  return null;
}

/** Runs `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const TREE_SKIP = new Set([".git", ".git.nosync", "node_modules", ".DS_Store"]);

export async function listOneLevel(abs: string): Promise<{ entries: ProjectTreeEntry[]; truncated: boolean } | "timeout"> {
  const r = await withTimeout(readdir(abs, { withFileTypes: true }), 5_000);
  if (r === "timeout") return "timeout";
  const kept = r.filter((e) => !TREE_SKIP.has(e.name) && !isSecretPath(e.name));
  kept.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const truncated = kept.length > TREE_MAX_ENTRIES;
  const entries = await mapLimit(kept.slice(0, TREE_MAX_ENTRIES), 16, async (e): Promise<ProjectTreeEntry> => {
    if (e.isDirectory()) return { name: e.name, dir: true, size: null };
    const st = await stat(join(abs, e.name)).catch(() => null);
    return { name: e.name, dir: false, size: st?.isFile() ? st.size : null };
  });
  return { entries, truncated };
}

/** Folder names of the vault's 20-Projects (empty when it is missing). */
export async function vaultSlugs(dir: string): Promise<string[]> {
  const r = await withTimeout(readdir(dir, { withFileTypes: true }), 4_000).catch(() => "timeout" as const);
  return r === "timeout" ? [] : r.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
}

/** Each note's matcher fields, by _index.md path, kept while its mtime holds: a rescan stats the
 *  index notes and reads only the ones that changed (the head, never a whole note). */
const noteCache = new Map<string, { mtimeMs: number; note: VaultProjectNote }>();

/** Every 20-Projects/<slug> with the code_path / github its _index.md frontmatter names (null
 *  when it has no index note or names neither). A slow vault costs the frontmatter, never the list. */
export async function vaultProjectNotes(dir: string): Promise<VaultProjectNote[]> {
  const slugs = await vaultSlugs(dir);
  const read = mapLimit(slugs, 16, async (slug): Promise<VaultProjectNote> => {
    const path = join(dir, slug, "_index.md");
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return { slug, codePath: null, github: null };
    const hit = noteCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.note;
    const head = await readHead(path, 4096);
    const note = head === null ? { slug, codePath: null, github: null } : noteFromText(slug, head);
    noteCache.set(path, { mtimeMs: st.mtimeMs, note });
    return note;
  });
  const r = await withTimeout(read, 8_000);
  return r === "timeout" ? slugs.map((slug) => noteCache.get(join(dir, slug, "_index.md"))?.note ?? { slug, codePath: null, github: null }) : r;
}

let aliasCache: { path: string; mtimeMs: number; aliases: ReadonlyMap<string, string> } | null = null;

/** brain_taxonomy.py's CANONICAL slug aliases, read from the vault (<vault>/60-Meta/scripts), so
 *  Alef and the capture pipeline file a folder under the same slug; the built-in copy when unreadable. */
export async function taxonomyAliases(vaultDir: string): Promise<ReadonlyMap<string, string>> {
  const path = join(vaultDir, "60-Meta", "scripts", "brain_taxonomy.py");
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return FALLBACK_ALIASES;
  if (aliasCache?.path === path && aliasCache.mtimeMs === st.mtimeMs) return aliasCache.aliases;
  const text = await readHead(path, 256 * 1024);
  const aliases = (text !== null ? parseCanonicalAliases(text) : null) ?? FALLBACK_ALIASES;
  aliasCache = { path, mtimeMs: st.mtimeMs, aliases };
  return aliases;
}
