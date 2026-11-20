// Pure logic for the 🧠 Brain view: folder colours (from the vault's own Obsidian graph colour
// groups, brightened for the comic kit), graph filtering, a deterministic force layout that runs
// in small steps (never blocks a frame), neighbour lookup, the local graph of one note and
// wikilink → note-path resolution. DOM-free; tested in brain-lib.test.ts.

import type { BrainLink, BrainNode } from "../../../shared/features/brain";

// ---------------------------------------------------------------- folders + colours

export const VAULT_NAME = "alex_claude";

/** Top-level folders in the order the filter shows them. Colours follow .obsidian/graph.json. */
export const FOLDER_COLORS: Readonly<Record<string, string>> = {
  "00-Inbox": "#ff4d8d",
  "10-Sessions": "#448aff",
  "20-Projects": "#22c55e",
  "30-Knowledge": "#ff8c00",
  "40-Resources": "#f5b20b",
  "50-Wiki": "#ef4444",
  "50-Archives": "#8f86a6",
  "60-Meta": "#8b7fd6",
  Clippings: "#0ea5e9",
};
const OTHER_COLOR = "#b8b0cc";

export function folderColor(folder: string): string {
  return FOLDER_COLORS[folder] ?? OTHER_COLOR;
}

/** Human labels for brain-graph.json's own "f" kind (round 11, package D's Legend "types"
 *  toggle). An id this doesn't know about (a future kind) still renders — just as itself. */
export const GROUP_LABELS: Readonly<Record<string, string>> = {
  knowledge: "Knowledge",
  resource: "Resources",
  session: "Sessions",
  project: "Projects",
  meta: "Meta",
  wiki: "Wiki",
  archive: "Archives",
  other: "Other / dated notes",
};

export function groupLabel(id: string): string {
  return GROUP_LABELS[id] ?? id;
}

/** Human label for a vault folder id -- the folder-axis twin of groupLabel() above. The vault
 *  sorts its top-level folders with a two-digit prefix ("10-Sessions") and parks the ones it
 *  wants out of the way behind an underscore ("_quarantine-dead-placeholders"). Both are filing
 *  machinery, not names, and on a globe label there is room for about one word: "10-" spends
 *  three characters of it saying nothing. So the prefix comes off and the separators become
 *  spaces.
 *
 *  Display ONLY. The id keeps doing every job it did -- region keys, folder colours, filter
 *  state, data- attributes and the legend's toggles all still speak ids, so nothing downstream
 *  can be confused by two folders that happen to prettify alike. A shape this doesn't know
 *  still renders, just as itself. */
export function folderLabel(id: string): string {
  if (!id) return "Vault root";
  const words = id
    .replace(/^_+/, "")
    .replace(/^\d{2}-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!words) return id; // a folder named "__" or "99-": better its id than an empty pill
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------- Legend toggles (round 11, D)

/** ANDs the sidebar "Folders" chips (an inclusive keep-list; empty = no restriction) with the
 *  Legend's own per-folder toggles (an exclusive off-list over the real vault-wide folder set;
 *  empty = no restriction) into the single keep-list `filterGraph` expects. The two controls
 *  stay fully independent — unchecking a folder in the Legend never moves a chip, and vice
 *  versa — so neither can silently "lose" a selection the other made. */
export function combineFolderFilters(chipsSelected: readonly string[], allFolders: readonly string[], off: ReadonlySet<string>): string[] {
  if (chipsSelected.length === 0 && off.size === 0) return [];
  const base = chipsSelected.length ? chipsSelected : allFolders;
  return base.filter((id) => !off.has(id));
}

/** Same idea for the Legend's "Types" toggles, which have no sidebar chips counterpart. */
export function combineGroupFilters(allGroups: readonly string[], off: ReadonlySet<string>): string[] {
  return off.size === 0 ? [] : allGroups.filter((id) => !off.has(id));
}

/** Memory files mirrored into the vault (the agent's auto-memory). */
export function isMemoryPath(path: string): boolean {
  return /(^|\/)memory(\/|$)/i.test(path) || /(^|\/)MEMORY(\.md)?$/.test(path);
}

/** Log-scaled: hub notes link to thousands of notes, so a linear/sqrt size would swallow the graph. */
export function nodeRadius(degree: number): number {
  return Math.min(22, 3 + Math.log2(1 + Math.max(0, degree)) * 1.5);
}

/** obsidian://open?vault=…&file=… (file without ".md", as Obsidian expects). */
export function obsidianUrl(path: string, vault = VAULT_NAME): string {
  const file = path.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

// ---------------------------------------------------------------- filtering

export interface GraphFilter {
  /** Top-level folders to keep; empty = all. */
  folders: readonly string[];
  /** Round 11, package D: the Legend's "type" toggles (brain-graph.json's own "f" kind:
   *  knowledge/resource/session/project/meta/wiki/archive/other). Empty/omitted = all, same
   *  keep-list convention as `folders`. */
  groups?: readonly string[];
  memoryOnly: boolean;
  /** Keep notes about this project (path or label mentions it) and their direct neighbours. */
  project: string | null;
}

export interface Graph {
  nodes: BrainNode[];
  edges: Array<[number, number]>;
}

export function projectMatch(node: BrainNode, project: string): boolean {
  const p = project.toLowerCase();
  const path = node.path.toLowerCase();
  return path.includes(`20-projects/${p}`) || path.split("/").some((seg) => seg === p) || node.label.toLowerCase() === p;
}

export function filterGraph(g: Graph, f: GraphFilter): Graph {
  const folders = new Set(f.folders);
  const groups = new Set(f.groups ?? []);
  let keep = new Set<number>();
  for (const n of g.nodes) {
    if (folders.size && !folders.has(n.folder)) continue;
    if (groups.size && !groups.has(n.group)) continue;
    if (f.memoryOnly && !isMemoryPath(n.path)) continue;
    keep.add(n.id);
  }
  if (f.project) {
    const core = new Set<number>();
    for (const n of g.nodes) if (keep.has(n.id) && projectMatch(n, f.project)) core.add(n.id);
    const withNeighbours = new Set(core);
    for (const [a, b] of g.edges) {
      if (core.has(a) && keep.has(b)) withNeighbours.add(b);
      if (core.has(b) && keep.has(a)) withNeighbours.add(a);
    }
    keep = withNeighbours;
  }
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter(([a, b]) => keep.has(a) && keep.has(b)) };
}

export function neighbourMap(edges: ReadonlyArray<readonly [number, number]>): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  const add = (a: number, b: number): void => {
    let s = m.get(a);
    if (!s) m.set(a, (s = new Set()));
    s.add(b);
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  return m;
}

// ---------------------------------------------------------------- layout

export interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Seeded PRNG (mulberry32) so the same graph always lands the same way. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Start positions: each folder gets a sector on a ring; its notes spiral out from there (big ones central). */
export function seedLayout(nodes: readonly BrainNode[]): Map<number, Pos> {
  const folders = [...new Set(nodes.map((n) => n.folder))].sort();
  const R = 140 + Math.sqrt(nodes.length) * 22;
  const centers = new Map<string, { x: number; y: number }>();
  folders.forEach((f, i) => {
    const a = (i / Math.max(1, folders.length)) * Math.PI * 2;
    centers.set(f, { x: Math.cos(a) * R, y: Math.sin(a) * R });
  });
  const idx = new Map<string, number>();
  const rand = rng(nodes.length + 7);
  const out = new Map<number, Pos>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (const n of [...nodes].sort((a, b) => b.degree - a.degree || a.id - b.id)) {
    const c = centers.get(n.folder) ?? { x: 0, y: 0 };
    const k = idx.get(n.folder) ?? 0;
    idx.set(n.folder, k + 1);
    const r = 14 * Math.sqrt(k + 0.5);
    const a = k * golden;
    out.set(n.id, { x: c.x + Math.cos(a) * r + (rand() - 0.5) * 4, y: c.y + Math.sin(a) * r + (rand() - 0.5) * 4, vx: 0, vy: 0 });
  }
  return out;
}

export interface ForceOpts {
  linkDistance: number;
  linkStrength: number;
  repel: number;
  gravity: number;
  damping: number;
}

export const DEFAULT_FORCES: ForceOpts = { linkDistance: 46, linkStrength: 0.05, repel: 900, gravity: 0.012, damping: 0.82 };

/**
 * One simulation step. Repulsion only between nodes in neighbouring grid cells (O(n) instead of
 * O(n²)), springs along edges, weak gravity to the centre. Returns the mean movement (0 = settled).
 */
export function stepLayout(pos: Map<number, Pos>, edges: ReadonlyArray<readonly [number, number]>, alpha: number, o: ForceOpts = DEFAULT_FORCES): number {
  const cell = 90;
  const grid = new Map<string, number[]>();
  const ids = [...pos.keys()];
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(id);
    else grid.set(key, [id]);
  }
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const other of list) {
          if (other <= id) continue;
          const q = pos.get(other);
          if (!q) continue;
          let ddx = p.x - q.x;
          let ddy = p.y - q.y;
          let d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) {
            ddx = ((id * 13) % 7) - 3 || 1;
            ddy = ((other * 7) % 5) - 2 || 1;
            d2 = ddx * ddx + ddy * ddy;
          }
          if (d2 > cell * cell * 4) continue;
          const f = (o.repel * alpha) / d2;
          const d = Math.sqrt(d2);
          p.vx += (ddx / d) * f;
          p.vy += (ddy / d) * f;
          q.vx -= (ddx / d) * f;
          q.vy -= (ddy / d) * f;
        }
      }
  }
  for (const [a, b] of edges) {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - o.linkDistance) * o.linkStrength * alpha;
    p.vx += (dx / d) * f;
    p.vy += (dy / d) * f;
    q.vx -= (dx / d) * f;
    q.vy -= (dy / d) * f;
  }
  let moved = 0;
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    p.vx = (p.vx - p.x * o.gravity * alpha) * o.damping;
    p.vy = (p.vy - p.y * o.gravity * alpha) * o.damping;
    const cap = 30;
    p.vx = Math.max(-cap, Math.min(cap, p.vx));
    p.vy = Math.max(-cap, Math.min(cap, p.vy));
    p.x += p.vx;
    p.y += p.vy;
    moved += Math.abs(p.vx) + Math.abs(p.vy);
  }
  return ids.length ? moved / ids.length : 0;
}

export function bounds(pos: ReadonlyMap<number, Pos>, ids?: Iterable<number>): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids ?? pos.keys()) {
    const p = pos.get(id);
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return { x: -100, y: -100, w: 200, h: 200 };
  return { x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 };
}

// ---------------------------------------------------------------- notes + links

/** "20-Projects/x/plan" and "20-Projects/x/plan.md" name the same note. */
export function notePath(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function baseName(path: string): string {
  return (notePath(path).split("/").pop() ?? path).toLowerCase();
}

// ---------------------------------------------------------------- climb

/** Why a climb step goes where it goes, as a reader would say it. Rules come from brain_climb.py. */
export function climbRuleLabel(rule: string): string {
  switch (rule) {
    case "broader":
      return "a kind of";
    case "topic":
    case "mentions":
      return "about";
    case "project":
      return "in project";
    case "parent":
      return "under umbrella";
    case "folder":
    case "top":
      return "filed in";
    case "home":
      return "no genus yet";
    default:
      return "";
  }
}

/** A climb step's label: the note name, or its folder for an `_index` note. */
export function climbStepTitle(path: string): string {
  const parts = notePath(path).split("/");
  const name = parts.pop() ?? path;
  if (name === "_index") return (parts.pop() ?? name).replace(/^\d+-/, "");
  return name.replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/[-_]+/g, " ").trim() || name;
}

/**
 * Where a [[wikilink]] target points: an exact outlink of the open note first (the server
 * resolved those), then a graph node with that path / basename / label. Null = unresolved.
 */
export function resolveLink(target: string, outlinks: readonly BrainLink[], nodes: readonly BrainNode[], fromPath = ""): string | null {
  const t = notePath(target.trim());
  if (!t) return null;
  const tl = t.toLowerCase();
  const tb = baseName(t);
  for (const l of outlinks) {
    const p = notePath(l.path);
    if (p.toLowerCase() === tl || p.toLowerCase().endsWith(`/${tl}`)) return p;
  }
  for (const l of outlinks) if (baseName(l.path) === tb || l.title.toLowerCase() === tb) return notePath(l.path);
  if (t.startsWith("../") || t.startsWith("./")) {
    const parts = notePath(fromPath).split("/").slice(0, -1);
    for (const seg of t.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    return parts.join("/");
  }
  const exact = nodes.find((n) => n.path.toLowerCase() === tl);
  if (exact) return exact.path;
  const byEnd = nodes.find((n) => n.path.toLowerCase().endsWith(`/${tl}`));
  if (byEnd) return byEnd.path;
  const byBase = nodes.find((n) => baseName(n.path) === tb || n.label.toLowerCase() === tb);
  return byBase ? byBase.path : null;
}

export interface LocalNode {
  path: string;
  title: string;
  kind: "center" | "out" | "back" | "both";
  x: number;
  y: number;
}

/** The open note in the middle, links it makes on the right arc, notes linking to it on the left. */
export function localGraph(center: { path: string; title: string }, outlinks: readonly BrainLink[], backlinks: readonly BrainLink[], max = 24): LocalNode[] {
  const c = notePath(center.path);
  const out = new Map<string, LocalNode>();
  for (const l of outlinks) {
    const p = notePath(l.path);
    if (p !== c && !out.has(p)) out.set(p, { path: p, title: l.title, kind: "out", x: 0, y: 0 });
  }
  for (const l of backlinks) {
    const p = notePath(l.path);
    if (p === c) continue;
    const hit = out.get(p);
    if (hit) hit.kind = "both";
    else out.set(p, { path: p, title: l.title, kind: "back", x: 0, y: 0 });
  }
  const list = [...out.values()].slice(0, max);
  const place = (arr: LocalNode[], from: number, to: number): void => {
    arr.forEach((n, i) => {
      const a = arr.length === 1 ? (from + to) / 2 : from + ((to - from) * i) / (arr.length - 1);
      n.x = Math.cos(a);
      n.y = Math.sin(a);
    });
  };
  const outs = list.filter((n) => n.kind !== "back");
  const backs = list.filter((n) => n.kind === "back");
  // One side empty: use the whole circle instead of crowding one arc.
  if (!backs.length) place(outs, -Math.PI / 2, Math.PI * 1.5 - (Math.PI * 2) / Math.max(1, outs.length));
  else if (!outs.length) place(backs, -Math.PI / 2, Math.PI * 1.5 - (Math.PI * 2) / Math.max(1, backs.length));
  else {
    place(outs, -Math.PI * 0.42, Math.PI * 0.42);
    place(backs, Math.PI * 0.58, Math.PI * 1.42);
  }
  return [{ path: c, title: center.title, kind: "center", x: 0, y: 0 }, ...list];
}

// ---------------------------------------------------------------- graph load retries

/** Attempts after the first failed graph load before the view gives up and says so. */
export const GRAPH_RETRY_MAX = 5;

/** How long to wait before retrying a failed /api/brain/graph load, or null when a retry can't
 *  help. A timeout or an unreachable server (status 0) and a 5xx are a busy or restarting server:
 *  back off 2 s, 4 s, 8 s, 16 s, 30 s. A 4xx (no graph file, too large) answers the same every time. */
export function graphRetryDelayMs(attempt: number, status: number): number | null {
  if (status !== 0 && status < 500) return null;
  if (attempt >= GRAPH_RETRY_MAX) return null;
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

/** The stats line while a retry is pending. */
export function graphRetryText(error: string, delayMs: number, attempt: number): string {
  return `Could not load the graph (${error}). Retrying in ${Math.round(delayMs / 1000)} s (${attempt + 1} of ${GRAPH_RETRY_MAX})…`;
}
