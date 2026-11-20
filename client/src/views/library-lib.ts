// Pure helpers of the 📚 Library view (library.ts): the route param (which lens, which project), the
// shelf-item -> project mapping computed client-side, the per-project count strip, the shared search
// and how fresh a project's notes are. The old Shelf and Projects helpers (shelf-lib.ts,
// projects-lib.ts) stay as they were; this file only joins the two.

import type { ProjectItem } from "../../../shared/features/projects";
import type { ShelfBoardItem, ShelfItemType } from "../../../shared/features/shelf-board";
import { SHELF_ITEM_TYPES } from "../../../shared/features/shelf-board";
import { artifactIdOf } from "./shelf-lib";
import { searchText as projectSearchText } from "./projects-lib";

// ---------------------------------------------------------------- lenses + route param

export type Lens = "project" | "type" | "pinned";
export const LENSES: ReadonlyArray<{ id: Lens; label: string; hint: string }> = [
  { id: "project", label: "By project", hint: "Projects, each with what our sessions made or linked for it" },
  { id: "type", label: "By type", hint: "Pinned shelves, then everything found in sessions, by type" },
  { id: "pinned", label: "Pinned", hint: "Only your pinned shelves" },
];

/** Pseudo-project holding the items no project claims. */
export const UNFILED_ID = "__unfiled";

const LENS_PREFIX = "lens:";

/** #/library -> By project; #/library/lens:type | lens:pinned -> that lens; #/library/<projectId> -> By project with that drawer open. */
export function parseLibraryParam(param: string | null): { lens: Lens; projectId: string | null } {
  if (!param) return { lens: "project", projectId: null };
  if (param.startsWith(LENS_PREFIX)) {
    const l = param.slice(LENS_PREFIX.length);
    return { lens: l === "type" || l === "pinned" ? l : "project", projectId: null };
  }
  return { lens: "project", projectId: param };
}

export function libraryParam(lens: Lens, projectId: string | null = null): string | null {
  if (lens === "project") return projectId;
  return `${LENS_PREFIX}${lens}`;
}

// ---------------------------------------------------------------- shelf item -> project

/** owner/repo (lower case) of a github.com URL, else of an "owner/repo" token in the kind badge. */
export function githubRepoOf(url: string | null, kind: string): string | null {
  if (url) {
    try {
      const u = new URL(url);
      if (/^(www\.)?github\.com$/i.test(u.hostname)) {
        const [owner, repo] = u.pathname.split("/").filter(Boolean);
        if (owner && repo) return `${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase();
      }
    } catch {
      /* not a URL: fall through to the kind */
    }
  }
  const m = /\b([\w.-]+\/[\w.-]+)\b/.exec(kind);
  return m ? m[1]!.replace(/\.git$/i, "").toLowerCase() : null;
}

export interface ProjectIndex {
  /** Folder paths (the project's own and its folded worktrees/clones) -> project id. */
  paths: Array<{ path: string; id: string }>;
  remotes: Map<string, string>;
  artifacts: Map<string, string>;
  islands: Map<string, string>;
}

export function buildProjectIndex(projects: readonly ProjectItem[]): ProjectIndex {
  const idx: ProjectIndex = { paths: [], remotes: new Map(), artifacts: new Map(), islands: new Map() };
  for (const p of projects) {
    if (p.path) idx.paths.push({ path: p.path, id: p.id });
    for (const f of p.folded ?? []) if (f.path) idx.paths.push({ path: f.path, id: p.id });
    const remote = p.git?.remote?.toLowerCase();
    if (remote && !idx.remotes.has(remote)) idx.remotes.set(remote, p.id);
    for (const a of p.artifacts?.items ?? []) if (!idx.artifacts.has(a.id)) idx.artifacts.set(a.id, p.id);
    if (p.islandId && !idx.islands.has(p.islandId)) idx.islands.set(p.islandId, p.id);
  }
  return idx;
}

/** Which project an item belongs to: a path inside its folder (longest folder wins), else a GitHub
 *  item by repo, else an artifact by id, else the item's district; null = Unfiled. */
export function projectIdForItem(i: Pick<ShelfBoardItem, "type" | "path" | "url" | "kind" | "district">, idx: ProjectIndex): string | null {
  if (i.path) {
    let best: { id: string; len: number } | null = null;
    for (const p of idx.paths) {
      if (i.path !== p.path && !i.path.startsWith(`${p.path}/`)) continue;
      if (!best || p.path.length > best.len) best = { id: p.id, len: p.path.length };
    }
    if (best) return best.id;
  }
  if (i.type === "github") {
    const repo = githubRepoOf(i.url, i.kind);
    const hit = repo ? idx.remotes.get(repo) : undefined;
    if (hit) return hit;
  }
  if (i.type === "artifact") {
    const id = artifactIdOf(i.url);
    const hit = id ? idx.artifacts.get(id) : undefined;
    if (hit) return hit;
  }
  return (i.district && idx.islands.get(i.district)) || null;
}

export interface ItemsByProject {
  byProject: Map<string, ShelfBoardItem[]>;
  unfiled: ShelfBoardItem[];
}

export function groupItemsByProject(items: readonly ShelfBoardItem[], projects: readonly ProjectItem[]): ItemsByProject {
  const idx = buildProjectIndex(projects);
  const byProject = new Map<string, ShelfBoardItem[]>();
  const unfiled: ShelfBoardItem[] = [];
  for (const i of items) {
    const id = projectIdForItem(i, idx);
    if (!id) unfiled.push(i);
    else (byProject.get(id) ?? byProject.set(id, []).get(id)!).push(i);
  }
  return { byProject, unfiled };
}

// ---------------------------------------------------------------- the card's count strip

export type StripKey = "artifacts" | "links" | "github" | "linear" | "files";
export const STRIP_META: ReadonlyArray<{ key: StripKey; emoji: string; label: string }> = [
  { key: "artifacts", emoji: "🖼", label: "artifacts" },
  { key: "links", emoji: "🔗", label: "links" },
  { key: "github", emoji: "🐙", label: "GitHub" },
  { key: "linear", emoji: "📐", label: "Linear" },
  { key: "files", emoji: "📄", label: "files" },
];
const STRIP_OF: Record<ShelfItemType, StripKey> = { artifact: "artifacts", dashable: "links", link: "links", github: "github", linear: "linear", folder: "files", file: "files" };

export function stripCounts(items: readonly Pick<ShelfBoardItem, "type">[]): Record<StripKey, number> {
  const out: Record<StripKey, number> = { artifacts: 0, links: 0, github: 0, linear: 0, files: 0 };
  for (const i of items) out[STRIP_OF[i.type]] += 1;
  return out;
}

/** Items grouped by type in the fixed type order, empty types dropped, best score first. */
export function groupItemsByType<T extends Pick<ShelfBoardItem, "type" | "score">>(items: readonly T[]): Array<{ type: ShelfItemType; items: T[] }> {
  return SHELF_ITEM_TYPES.map((type) => ({ type, items: items.filter((i) => i.type === type).sort((a, b) => b.score - a.score) })).filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------- shared search

const words = (q: string): string[] => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
export const hasQuery = (q: string): boolean => words(q).length > 0;

/** A project matches by name, README, stack, remote and its notes. Under ?redact=1 a search never hits
 *  (a hit or a miss would reveal a hidden name). */
export function projectMatchesQuery(p: ProjectItem, query: string, redact: boolean): boolean {
  const w = words(query);
  if (w.length === 0) return true;
  if (redact) return false;
  const n = p.notes;
  const text = `${projectSearchText(p)} ${n?.desc ?? ""} ${n?.longDesc ?? ""} ${(n?.nextSteps ?? []).join(" ")} ${(n?.milestones ?? []).join(" ")}`.toLowerCase();
  return w.every((x) => text.includes(x));
}

// ---------------------------------------------------------------- notes freshness

/** The honest line under a project's notes: when they were last refreshed, or that they are old.
 *  Reads asOf and stale defensively: notes written before those fields existed lack them. */
export function notesFreshness(notes: { asOf?: string | null; stale?: boolean }): string {
  if (notes.asOf && !notes.stale) return `notes as of ${notes.asOf}`;
  if (notes.asOf) return `notes as of ${notes.asOf} (may be out of date)`;
  return "notes from the old roadmap, not refreshed";
}
