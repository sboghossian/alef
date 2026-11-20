// Pure rules of the "projects" feature (no IO): folder → id, category, stage, stack guess, README
// line, and the union of Alef districts with ~/Documents/Code folders. projects.ts reads the disk;
// everything it decides is here so a test can pin it. Each rule stores the reason it fired, so the
// view can say why a project sits where it does.

import { basename, resolve, sep } from "node:path";
import {
  BUILDING_DAYS,
  DORMANT_DAYS,
  type ProjectCategory,
  type ProjectStage,
} from "../../shared/features/projects.js";

const DAY_MS = 86_400_000;

export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80) || "project";

/** Folder names the Code scan skips outright. */
export function isSkippedFolderName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** One key per real folder: case-folded (macOS), no trailing separator. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(p);
  const t = r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
  return platform === "darwin" ? t.toLowerCase() : t;
}

// ---------------------------------------------------------------- the union

export interface DistrictInput {
  id: string;
  name: string;
  path: string;
  sessions: number;
  lastActive: string | null;
}

export interface UnionEntry {
  id: string;
  name: string;
  path: string;
  islandId: string | null;
  sessions: number;
  lastActive: string | null;
}

/** Districts first (they carry sessions), then Code folders not already covered. A district whose
 *  path IS a Code folder (or lives inside one: its repo root) becomes that folder's entry, never a
 *  second one. Ids: the district id, else the folder's slug; a clash gets "-2", "-3"… */
export function unionProjects(districts: readonly DistrictInput[], codeFolders: readonly string[], platform: NodeJS.Platform = process.platform): UnionEntry[] {
  const byKey = new Map<string, UnionEntry>();
  const used = new Set<string>();
  const claim = (want: string): string => {
    let id = slugOf(want);
    for (let n = 2; used.has(id); n += 1) id = `${slugOf(want)}-${n}`;
    used.add(id);
    return id;
  };
  for (const d of districts) {
    const key = pathKey(d.path, platform);
    const hit = byKey.get(key);
    if (hit) {
      hit.sessions += d.sessions;
      if (d.lastActive && (!hit.lastActive || d.lastActive > hit.lastActive)) hit.lastActive = d.lastActive;
      continue;
    }
    byKey.set(key, { id: claim(d.id), name: d.name, path: resolve(d.path), islandId: d.id, sessions: d.sessions, lastActive: d.lastActive });
  }
  for (const folder of codeFolders) {
    const key = pathKey(folder, platform);
    if (byKey.has(key)) continue;
    const name = basename(folder);
    byKey.set(key, { id: claim(name), name, path: resolve(folder), islandId: null, sessions: 0, lastActive: null });
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------- category

/** First rule that fires wins. `hay` is name + remote + README line, lower-cased. */
const CATEGORY_RULES: readonly { cat: ProjectCategory; words: readonly string[] }[] = [
  { cat: "acme", words: ["acme", "justinian", "eulex", "oneic", "sovereign-acme"] },
  { cat: "personal", words: ["maya", "lisbon", "family", "apartment", "finance", "networth", "booklet", "storybook", "leila", "travel", "wedding"] },
  { cat: "legal", words: ["legal", "law", "court", "contract", "divorce", "clause", "citation", "cite", "gdpr", "arbitration", "lawyer"] },
  { cat: "infra", words: ["claude", "agent", "alef", "aleph", "mcp", "cli", "hook", "infra", "dashable", "skill", "bridge", "conductor", "fleet", "cockpit", "overlay", "sandbox", "harness", "codegraph", "worktree", "watchdog", "sync"] },
];

/** Whole-token match (longer words also match as a prefix: "legal" → "legaltech"), so "cli" never fires on "client". */
const hasWord = (hay: string, w: string): boolean => hay.split(/[^a-z0-9]+/).some((t) => t === w || (w.length >= 5 && t.startsWith(w)));

export interface CategoryFacts {
  name: string;
  remote: string | null;
  readme: string | null;
  vaultNote: string | null;
}

export function categorize(f: CategoryFacts): { category: ProjectCategory; reason: string } {
  const owner = f.remote?.split("/")[0]?.toLowerCase() ?? "";
  if (owner === "acme-inc") return { category: "acme", reason: "GitHub owner ACME-Inc" };
  const name = f.name.toLowerCase();
  const slug = f.vaultNote?.toLowerCase() ?? "";
  const fields: [string, string][] = [
    ["name", name],
    ...(slug ? ([["vault note", slug]] as [string, string][]) : []),
    ["remote", (f.remote ?? "").toLowerCase()],
    ["README", (f.readme ?? "").toLowerCase()],
  ];
  for (const rule of CATEGORY_RULES) {
    for (const [label, hay] of fields) {
      const w = rule.words.find((x) => hasWord(hay, x));
      if (w) return { category: rule.cat, reason: `${label} mentions "${w}"` };
    }
  }
  return { category: "side", reason: owner ? `no rule matched; your own repo (${owner})` : "no rule matched: filed as a side project" };
}

// ---------------------------------------------------------------- stage

export interface StageFacts {
  commits: number | null;
  lastCommit: string | null;
  lastActive: string | null;
  deploy: string | null;
  isGit: boolean;
  now: number;
  /** File-time dating (projects-scan filesDate) for a folder with no readable commit. */
  files?: { newest: string | null; entries: number } | null;
}

/** A folder with this many dated entries or fewer (and no commit, no session) is still an idea. */
export const NEAR_EMPTY_ENTRIES = 1;

const daysSince = (iso: string | null, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / DAY_MS));
};

/** idea: no commit and no session. building: a commit or session in the last 14 days. shipped: a
 *  deploy config (or homepage) and not building. dormant: nothing for over 60 days. Otherwise
 *  building (quiet, but under 60 days). */
export function stageOf(f: StageFacts): { stage: ProjectStage; reason: string; activityAt: string | null } {
  const commitAt = f.lastCommit && !Number.isNaN(Date.parse(f.lastCommit)) ? f.lastCommit : null;
  const sessionAt = f.lastActive && !Number.isNaN(Date.parse(f.lastActive)) ? f.lastActive : null;
  let activityAt = commitAt && sessionAt ? (commitAt > sessionAt ? commitAt : sessionAt) : (commitAt ?? sessionAt);
  let what = commitAt && (!sessionAt || commitAt >= sessionAt) ? "commit" : "session";
  let how = "";
  const hasWork = (f.commits ?? 0) > 0 || commitAt !== null || sessionAt !== null;
  if (!hasWork) {
    // No commit and no session: date the folder by file times (newest mtime of the folder itself and
    // its top-level entries); only an empty or near-empty folder stays an idea.
    const base = f.isGit ? "a repo with no readable commit and no sessions" : "no git history and no sessions";
    const files = f.files ?? null;
    if (!files?.newest || Number.isNaN(Date.parse(files.newest))) return { stage: "idea", reason: `${base}; its file times could not be read`, activityAt };
    if (files.entries <= NEAR_EMPTY_ENTRIES) return { stage: "idea", reason: `${base}; ${files.entries === 0 ? "an empty folder" : "a single entry"}`, activityAt };
    activityAt = files.newest;
    what = "file change";
    how = ` · ${base}: dated by the mtimes of the folder and its ${files.entries} top-level entries`;
  }
  const age = daysSince(activityAt, f.now);
  if (age !== null && age <= BUILDING_DAYS) return { stage: "building", reason: `${what} ${age} d ago (within ${BUILDING_DAYS} d)${how}`, activityAt };
  if (f.deploy) return { stage: "shipped", reason: `has a deploy config (${f.deploy}); last ${what} ${age ?? "?"} d ago${how}`, activityAt };
  if (age === null || age > DORMANT_DAYS) return { stage: "dormant", reason: age === null ? "no readable date for its last commit or session" : `nothing for ${age} d (over ${DORMANT_DAYS}; last ${what})${how}`, activityAt };
  return { stage: "building", reason: `last ${what} ${age} d ago (under ${DORMANT_DAYS} d), no deploy config${how}`, activityAt };
}

// ---------------------------------------------------------------- stack + README

/** Dependency / keyword → stack label. Labels double as devicon names in the client. */
const NODE_DEPS: readonly [RegExp, string][] = [
  [/^next$/, "nextjs"],
  [/^react$/, "react"],
  [/^vue$/, "vuejs"],
  [/^svelte$|^@sveltejs\//, "svelte"],
  [/^vite$/, "vitejs"],
  [/^typescript$/, "typescript"],
  [/^tailwindcss$/, "tailwindcss"],
  [/^express$/, "express"],
  [/^three$/, "threejs"],
  [/^playwright|^puppeteer/, "playwright"],
  [/^electron$/, "electron"],
  [/^astro$/, "astro"],
  [/^hono$/, "hono"],
  [/^wrangler$|^@cloudflare\//, "cloudflare"],
  [/^prisma$|^@prisma\//, "prisma"],
  [/^vitest$/, "vitest"],
  [/^d3$/, "d3js"],
];
const PY_DEPS: readonly [RegExp, string][] = [
  [/^fastapi/, "fastapi"],
  [/^django/, "django"],
  [/^flask/, "flask"],
  [/^pandas/, "pandas"],
  [/^numpy/, "numpy"],
  [/^torch|^pytorch/, "pytorch"],
  [/^streamlit/, "streamlit"],
  [/^playwright/, "playwright"],
  [/^anthropic/, "anthropic"],
];
export const STACK_MAX = 6;

/** Names of the dependencies in a package.json text (dependencies + devDependencies). */
export function nodeDepNames(packageJson: string): string[] {
  try {
    const j: unknown = JSON.parse(packageJson);
    if (typeof j !== "object" || j === null) return [];
    const o = j as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies"]) {
      const d = o[key];
      if (typeof d === "object" && d !== null) for (const n of Object.keys(d)) names.add(n);
    }
    return [...names];
  } catch {
    return [];
  }
}

export interface StackInput {
  packageJson?: string | null;
  pyproject?: string | null;
  requirements?: string | null;
  cargo?: boolean;
  goMod?: boolean;
  swift?: boolean;
}

export function guessStack(i: StackInput): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    if (!out.includes(s) && out.length < STACK_MAX) out.push(s);
  };
  if (i.packageJson != null) {
    const deps = nodeDepNames(i.packageJson);
    for (const [re, label] of NODE_DEPS) if (deps.some((d) => re.test(d))) add(label);
    if (out.length === 0) add("nodejs");
  }
  const py = `${i.pyproject ?? ""}\n${i.requirements ?? ""}`;
  if (i.pyproject != null || i.requirements != null) {
    add("python");
    const lines = py.toLowerCase().split(/\r?\n/).map((l) => l.replace(/^[\s"'-]+/, ""));
    for (const [re, label] of PY_DEPS) if (lines.some((l) => re.test(l))) add(label);
  }
  if (i.cargo) add("rust");
  if (i.goMod) add("go");
  if (i.swift) add("swift");
  return out;
}

/** package.json "homepage" (a live URL), or null. */
export function homepageOf(packageJson: string): string | null {
  try {
    const j: unknown = JSON.parse(packageJson);
    const h = typeof j === "object" && j !== null ? (j as Record<string, unknown>).homepage : null;
    return typeof h === "string" && /^https?:\/\//.test(h) ? h.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** First heading, else first prose line, of a README text; markup stripped, 160 chars. */
export function readmeLine(text: string): string | null {
  const clean = (s: string): string =>
    s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`>#]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  let fallback: string | null = null;
  let fence = false;
  for (const raw of text.slice(0, 4000).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) fence = !fence;
    if (fence || !line || line.startsWith("<!--") || line.startsWith("---") || line.startsWith("[![") || line.startsWith("![")) continue;
    const c = clean(line);
    if (!c) continue;
    if (/^#{1,3}\s/.test(line)) return c.slice(0, 160);
    fallback ??= c.slice(0, 160);
  }
  return fallback;
}

/** "owner/repo" from a GitHub origin URL (https or ssh), else null. */
export function githubRemote(url: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Remote url from a .git/config text (the [remote "origin"] block). */
export function originUrl(gitConfig: string): string | null {
  const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(gitConfig);
  return m?.[1] ?? null;
}

/** Branch name from .git/HEAD text, or null for a detached head. */
export function branchOfHead(head: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return m?.[1]?.slice(0, 120) ?? null;
}

/** Files whose presence means "this is deployed somewhere". */
export const DEPLOY_FILES: readonly string[] = ["vercel.json", "wrangler.toml", "wrangler.json", "wrangler.jsonc", "netlify.toml", "fly.toml", "render.yaml", "Procfile", "app.yaml", "railway.json", "railway.toml"];

// ---------------------------------------------------------------- worktrees + clones fold

export interface FoldInput {
  id: string;
  path: string;
  /** Main working tree when this folder is a linked git worktree. */
  worktreeOf: string | null;
  /** The worktree is stale (pruned from its main repo). */
  stale?: boolean;
  /** "owner/repo" of origin. */
  remote: string | null;
  sessions: number;
  /** Newest commit or session (ISO), for picking the canonical clone. */
  activityAt: string | null;
}

/** Which entries fold into another card, and why. Two rules, in order:
 *  1. a linked worktree folds into its main repo's card (when that repo is listed);
 *  2. folders with the same GitHub remote (clones, backups) fold into ONE canonical folder: the one
 *     with the most sessions, then the newest activity, then the shortest path.
 *  A worktree of a folded clone ends on the canonical card (folds are followed to the end). */
export function foldCopies(entries: readonly FoldInput[], platform: NodeJS.Platform = process.platform): Map<string, { into: string; reason: string }> {
  const out = new Map<string, { into: string; reason: string }>();
  const byPath = new Map(entries.map((e) => [pathKey(e.path, platform), e]));
  for (const e of entries) {
    if (!e.worktreeOf) continue;
    const main = byPath.get(pathKey(e.worktreeOf, platform));
    if (main && main.id !== e.id) out.set(e.id, { into: main.id, reason: e.stale ? `a stale git worktree of ${basename(main.path)} (git no longer lists it)` : `a git worktree of ${basename(main.path)}` });
  }
  const groups = new Map<string, FoldInput[]>();
  for (const e of entries) {
    if (out.has(e.id) || !e.remote) continue;
    const k = e.remote.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [remote, group] of groups) {
    if (group.length < 2) continue;
    const canon = [...group].sort((a, b) => b.sessions - a.sessions || (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.path.length - b.path.length || a.path.localeCompare(b.path))[0] as FoldInput;
    const why = canon.sessions > 0 ? "it has the most sessions" : "it has the newest activity";
    for (const e of group) if (e.id !== canon.id) out.set(e.id, { into: canon.id, reason: `same GitHub remote (${remote}) as ${basename(canon.path)}, kept as the main card because ${why}` });
  }
  // Follow chains (worktree → clone → canonical) to the end; a cycle can't happen (rule 2 only targets non-folded canonicals).
  for (const [id, f] of out) {
    let into = f.into;
    for (let hop = 0; out.has(into) && hop < 8; hop += 1) into = (out.get(into) as { into: string }).into;
    if (into !== f.into) out.set(id, { into, reason: f.reason });
  }
  return out;
}
