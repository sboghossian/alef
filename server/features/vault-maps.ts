// The four "map" sections of the 🗄️ Vault view — Atlas, Flows, Hubs, Constellation — ported from
// the "Alex's Brain" artifact's renderAtlas / renderFlows / renderHubs / renderConstellation.
// Same rules as the artifact, reproduced here so the client gets a small payload, not 32k notes.
//
// Pure: every function takes the parsed feed (and `today` where dates matter) and returns plain
// data. No I/O, no clock, no randomness — the Constellation layout is a seeded, deterministic
// force simulation, so the same feed always draws the same map.

import type {
  VaultAtlas,
  VaultAtlasFolder,
  VaultConstellation,
  VaultFlows,
  VaultFlowsMode,
  VaultHub,
  VaultHubs,
  VaultNote,
  VaultStar,
  VaultTie,
} from "../../shared/features/vault.js";
import { dayToIso, folderOf, inboundCounts, toRef } from "./vault-lib.js";

const OTHER = "Other";

/** Atlas: loose-note cells sent for the treemap (the artifact draws up to 400; 120 reads the same). */
const ATLAS_NOTE_CAP = 120;
const ATLAS_LIST_CAP = 10;
const ATLAS_NEWEST_CAP = 8;

/** Flows: named groups before the rest fold into "Other" (artifact: 13 folders, 12 umbrellas). */
const FLOW_GROUPS: Readonly<Record<VaultFlowsMode, number>> = { folders: 13, umbrellas: 12 };

/** Hubs: a note needs this many links to be plotted at all. */
const HUB_MIN_LINKS = 3;
/** Scatter points sent. The artifact plots 1,600; past ~800 the cloud reads the same and costs 2x. */
const HUB_POINT_CAP = 800;
const KEYSTONE_CAP = 12;
const SILO_CAP = 8;
const SILO_MIN_LINKS = 30;
const BRIDGE_AREAS = 5;

/** Constellation: projects need this many notes to be a star, and at most this many are drawn. */
const STAR_MIN_NOTES = 3;
const STAR_CAP = 140;
/** A target linked from 2..14 projects ties them; one linked from more (like "ai") ties everything and says nothing. */
const TIE_MAX_PROJECTS = 14;
const TIE_MIN_W = 2;
/** Backbone: each project keeps its 4 strongest ties, plus any tie this strong. */
const BACKBONE_PER_STAR = 4;
const BACKBONE_STRONG = 20;
const TIE_DRAW_CAP = 320;
const ISLAND_MIN_NOTES = 5;
const LIST_CAP = 10;
const ISLAND_CAP = 8;

/** The big four folders are split one level deeper, as the artifact does: "10-Sessions" alone says nothing. */
const SPLIT: ReadonlySet<string> = new Set(["10-Sessions", "30-Knowledge", "40-Resources", "50-Archives"]);

/** The area a note belongs to: its top folder, or folder/subfolder for the big four, or "(root)". */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length > 2 && SPLIT.has(parts[0] ?? "")) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? (parts[0] ?? "(root)") : "(root)";
}

function live(notes: readonly VaultNote[]): VaultNote[] {
  return notes.filter((n) => n.kind !== "a");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- Atlas

interface AtlasNode {
  name: string;
  dir: string;
  kids: Map<string, AtlasNode>;
  notes: VaultNote[];
  count: number;
  recent: number;
  last: number;
}

function atlasTree(notes: readonly VaultNote[], today: number): AtlasNode {
  const mk = (name: string, dir: string): AtlasNode => ({ name, dir, kids: new Map(), notes: [], count: 0, recent: 0, last: -Infinity });
  const bump = (node: AtlasNode, n: VaultNote): void => {
    node.count++;
    if (n.day === null || n.day > today) return;
    if (n.day >= today - 7) node.recent++;
    if (n.day > node.last) node.last = n.day;
  };
  const root = mk("Vault", "");
  for (const n of notes) {
    const parts = n.path.split("/");
    let node = root;
    bump(node, n);
    for (const part of parts.slice(0, -1)) {
      let k = node.kids.get(part);
      if (!k) {
        k = mk(part, `${node.dir}${part}/`);
        node.kids.set(part, k);
      }
      node = k;
      bump(node, n);
    }
    node.notes.push(n);
  }
  return root;
}

/** One folder of the vault for the Atlas treemap. `path` walks down from the root; unknown segments stop the walk. */
export function vaultAtlas(notes: readonly VaultNote[], today: number, path: readonly string[], inbound = inboundCounts(notes)): VaultAtlas {
  const tree = atlasTree(live(notes), today);
  let node = tree;
  const walked: string[] = [];
  for (const seg of path) {
    const k = node.kids.get(seg);
    if (!k) break;
    node = k;
    walked.push(seg);
  }
  const linksOf = (n: VaultNote): number => n.links.length + (inbound.get(n.id) ?? 0);
  const byLinks = (a: VaultNote, b: VaultNote): number => linksOf(b) - linksOf(a) || cmp(a.path, b.path);
  const under: VaultNote[] = [];
  const walk = (x: AtlasNode): void => {
    under.push(...x.notes);
    for (const k of x.kids.values()) walk(k);
  };
  walk(node);

  const subfolders: VaultAtlasFolder[] = [...node.kids.values()]
    .map((k) => ({ name: k.name, dir: k.dir, count: k.count, recent: k.recent }))
    .sort((a, b) => b.count - a.count || cmp(a.name, b.name));
  return {
    path: walked,
    name: node.name,
    dir: node.dir,
    count: node.count,
    recent: node.recent,
    last: Number.isFinite(node.last) ? dayToIso(node.last) : null,
    subfolders,
    loose: node.notes.length,
    notes: [...node.notes].sort(byLinks).slice(0, ATLAS_NOTE_CAP).map((n) => toRef(n, inbound)),
    mostLinked: [...under].sort(byLinks).slice(0, ATLAS_LIST_CAP).map((n) => toRef(n, inbound)),
    newest: under
      .filter((n): n is VaultNote & { day: number } => n.day !== null && n.day <= today)
      .sort((a, b) => b.day - a.day || cmp(a.path, b.path))
      .slice(0, ATLAS_NEWEST_CAP)
      .map((n) => toRef(n, inbound)),
  };
}

// ---------------------------------------------------------------- Flows

/** Links between areas (or umbrellas) of the vault, folded to the biggest groups plus "Other". */
export function vaultFlows(notes: readonly VaultNote[], mode: VaultFlowsMode): VaultFlows {
  const all = live(notes);
  const keyOf = (n: VaultNote): string | null => (mode === "umbrellas" ? n.umbrella || null : areaOf(n.path));
  const counts = new Map<string, number>();
  for (const n of all) {
    const k = keyOf(n);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const keys = [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k]) => k);
  const max = FLOW_GROUPS[mode];
  const named = keys.slice(0, max);
  const hasOther = keys.length > max;
  const names = hasOther ? [...named, OTHER] : named;
  const G = names.length;
  const idx = new Map(named.map((k, i) => [k, i]));
  const groupOf = (n: VaultNote): number => {
    const k = keyOf(n);
    if (!k) return -1;
    return idx.get(k) ?? (hasOther ? G - 1 : -1);
  };

  const byId = new Map(all.map((n) => [n.id, n]));
  const matrix = Array.from({ length: G }, () => new Array<number>(G).fill(0));
  const noteCounts = new Array<number>(G).fill(0);
  for (const n of all) {
    const a = groupOf(n);
    if (a < 0) continue;
    noteCounts[a] = (noteCounts[a] ?? 0) + 1;
    for (const t of n.links) {
      const target = byId.get(t);
      if (!target) continue;
      const b = groupOf(target);
      const row = matrix[a];
      if (b >= 0 && row) row[b] = (row[b] ?? 0) + 1;
    }
  }
  const at = (a: number, b: number): number => matrix[a]?.[b] ?? 0;
  const cross = names.map((_, i) => {
    let s = 0;
    for (let j = 0; j < G; j++) if (j !== i) s += at(i, j) + at(j, i);
    return s;
  });
  return { mode, names, notes: noteCounts, matrix, cross, self: names.map((_, i) => at(i, i)) };
}

// ---------------------------------------------------------------- Hubs

/** Notes by how many links they carry and how many areas those links reach. */
export function vaultHubs(notes: readonly VaultNote[]): VaultHubs {
  const all = live(notes);
  const byId = new Map(all.map((n) => [n.id, n]));
  const sources = new Map<string, string[]>();
  for (const n of all) {
    for (const t of new Set(n.links)) {
      let s = sources.get(t);
      if (!s) sources.set(t, (s = []));
      s.push(n.id);
    }
  }
  const pts: (VaultHub & { score: number })[] = [];
  for (const n of all) {
    const ins = sources.get(n.id) ?? [];
    const links = n.links.length + ins.length;
    if (links < HUB_MIN_LINKS) continue;
    const areas = new Set<string>();
    for (const id of [...n.links, ...ins]) {
      const other = byId.get(id);
      if (other) areas.add(areaOf(other.path));
    }
    const name = n.path.slice(n.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    pts.push({ id: n.id, path: n.path, name, folder: folderOf(n.path), links, areas: areas.size, score: areas.size * Math.log2(links + 1) });
  }
  const strip = ({ score: _score, ...h }: VaultHub & { score: number }): VaultHub => h;
  const byLinks = [...pts].sort((a, b) => b.links - a.links || cmp(a.path, b.path));
  return {
    total: pts.length,
    bridges: pts.filter((p) => p.areas >= BRIDGE_AREAS).length,
    points: byLinks.slice(0, HUB_POINT_CAP).map(strip),
    keystones: [...pts].sort((a, b) => b.score - a.score || cmp(a.path, b.path)).slice(0, KEYSTONE_CAP).map(strip),
    silos: byLinks.filter((p) => p.links >= SILO_MIN_LINKS && p.areas <= 1).slice(0, SILO_CAP).map(strip),
  };
}

// ---------------------------------------------------------------- Constellation

interface SimNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * A small, deterministic port of the d3-force setup the artifact uses: many-body charge -170,
 * links of distance 58 with log-weighted strength, x/y centring 0.07, collide r + 6, 320 ticks.
 * Starts from d3's own phyllotaxis placement, so no randomness is involved.
 */
export function layoutStars(radii: readonly number[], ties: readonly VaultTie[], ticks = 320): { x: number; y: number }[] {
  const nodes: SimNode[] = radii.map((r, i) => {
    const radius = 10 * Math.sqrt(0.5 + i);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), vx: 0, vy: 0, r };
  });
  const maxLog = Math.log(1 + Math.max(1, ...ties.map((t) => t.w)));
  const degree = new Array<number>(nodes.length).fill(0);
  for (const t of ties) {
    degree[t.a] = (degree[t.a] ?? 0) + 1;
    degree[t.b] = (degree[t.b] ?? 0) + 1;
  }
  let alpha = 1;
  const alphaDecay = 1 - Math.pow(0.001, 1 / 300);
  for (let tick = 0; tick < ticks; tick++) {
    alpha += (0 - alpha) * alphaDecay;
    // links
    for (const t of ties) {
      const s = nodes[t.a];
      const g = nodes[t.b];
      if (!s || !g) continue;
      let dx = g.x + g.vx - s.x - s.vx;
      let dy = g.y + g.vy - s.y - s.vy;
      const l0 = Math.hypot(dx, dy) || 1e-6;
      const strength = 0.05 + (0.3 * Math.log(1 + t.w)) / maxLog;
      const l = ((l0 - 58) / l0) * alpha * strength;
      dx *= l;
      dy *= l;
      const da = degree[t.a] ?? 1;
      const db = degree[t.b] ?? 1;
      const bias = da / (da + db);
      g.vx -= dx * bias;
      g.vy -= dy * bias;
      s.vx += dx * (1 - bias);
      s.vy += dy * (1 - bias);
    }
    // charge (exact O(n^2): n <= 140)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!a) continue;
      for (let j = 0; j < nodes.length; j++) {
        const b = nodes[j];
        if (i === j || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = Math.max(1, dx * dx + dy * dy);
        const w = (-170 * alpha) / d2;
        a.vx += dx * w;
        a.vy += dy * w;
      }
    }
    // centring
    for (const n of nodes) {
      n.vx -= n.x * 0.07 * alpha;
      n.vy -= n.y * 0.07 * alpha;
    }
    // collide
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (!a || !b) continue;
        const dx = b.x + b.vx - a.x - a.vx;
        const dy = b.y + b.vy - a.y - a.vy;
        const want = a.r + b.r + 12;
        const d = Math.hypot(dx, dy) || 1e-6;
        if (d >= want) continue;
        const push = ((want - d) / d) * 0.5;
        a.vx -= dx * push;
        a.vy -= dy * push;
        b.vx += dx * push;
        b.vy += dy * push;
      }
    }
    for (const n of nodes) {
      n.vx *= 0.6;
      n.vy *= 0.6;
      n.x += n.vx;
      n.y += n.vy;
    }
  }
  return nodes.map((n) => ({ x: n.x, y: n.y }));
}

/**
 * A star held by one weak tie drifts far out and, fitted to the square, shrinks everyone else to a
 * clump. Cap each star's distance from the centre at OUTLIER_SPREAD x the median distance; it keeps
 * its direction and its tie, it just stops costing the map its scale.
 */
const OUTLIER_SPREAD = 1.7;
export function pullInOutliers(pos: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  if (pos.length < 4) return pos.map((p) => ({ ...p }));
  // The median point, not the mean: the outliers being fixed would drag a mean toward themselves.
  const mid = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const cx = mid(pos.map((p) => p.x));
  const cy = mid(pos.map((p) => p.y));
  const dist = pos.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const sorted = [...dist].sort((a, b) => a - b);
  const cap = (sorted[Math.floor(sorted.length / 2)] ?? 0) * OUTLIER_SPREAD;
  return pos.map((p, i) => {
    const d = dist[i] ?? 0;
    if (cap <= 0 || d <= cap) return { ...p };
    const k = cap / d;
    return { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k };
  });
}

/** Projects as a network: two are tied when their notes link to the same targets. */
export function vaultConstellation(notes: readonly VaultNote[]): VaultConstellation {
  const all = live(notes);
  const byProject = new Map<string, { notes: VaultNote[]; umb: Map<string, number> }>();
  for (const n of all) {
    if (!n.project) continue;
    let p = byProject.get(n.project);
    if (!p) byProject.set(n.project, (p = { notes: [], umb: new Map() }));
    p.notes.push(n);
    if (n.umbrella) p.umb.set(n.umbrella, (p.umb.get(n.umbrella) ?? 0) + 1);
  }
  const projects = [...byProject]
    .map(([slug, p]) => ({
      slug,
      notes: p.notes,
      umbrella: [...p.umb].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? "unfiled",
    }))
    .filter((p) => p.notes.length >= STAR_MIN_NOTES)
    .sort((a, b) => b.notes.length - a.notes.length || cmp(a.slug, b.slug))
    .slice(0, STAR_CAP);

  // target note -> the projects whose notes link to it
  const targets = new Map<string, Set<number>>();
  projects.forEach((p, pi) => {
    for (const n of p.notes) {
      for (const t of n.links) {
        let s = targets.get(t);
        if (!s) targets.set(t, (s = new Set()));
        s.add(pi);
      }
    }
  });
  const weights = new Map<string, number>();
  for (const s of targets.values()) {
    if (s.size < 2 || s.size > TIE_MAX_PROJECTS) continue;
    const a = [...s].sort((x, y) => x - y);
    for (let x = 0; x < a.length; x++) {
      for (let y = x + 1; y < a.length; y++) {
        const k = `${a[x]}|${a[y]}`;
        weights.set(k, (weights.get(k) ?? 0) + 1);
      }
    }
  }
  const allTies: VaultTie[] = [...weights]
    .filter(([, w]) => w >= TIE_MIN_W)
    .map(([k, w]) => {
      const [a, b] = k.split("|").map(Number);
      return { a: a ?? 0, b: b ?? 0, w };
    })
    .sort((x, y) => y.w - x.w || x.a - y.a || x.b - y.b);

  const perStar = new Map<number, number>();
  const backbone: VaultTie[] = [];
  for (const t of allTies) {
    const na = perStar.get(t.a) ?? 0;
    const nb = perStar.get(t.b) ?? 0;
    if (t.w >= BACKBONE_STRONG || na < BACKBONE_PER_STAR || nb < BACKBONE_PER_STAR) {
      backbone.push(t);
      perStar.set(t.a, na + 1);
      perStar.set(t.b, nb + 1);
    }
  }
  const drawn = backbone.slice(0, TIE_DRAW_CAP);

  // Only projects with a drawn tie are stars; re-index ties onto them.
  const linked = [...new Set(drawn.flatMap((t) => [t.a, t.b]))].sort((x, y) => x - y);
  const remap = new Map(linked.map((pi, i) => [pi, i]));
  const ties = drawn.map((t) => ({ a: remap.get(t.a) ?? 0, b: remap.get(t.b) ?? 0, w: t.w }));
  const radii = linked.map((pi) => 4 + Math.sqrt(projects[pi]?.notes.length ?? 0) * 0.75);
  const pos = pullInOutliers(layoutStars(radii, ties));

  // Fit into a unit square with a margin, keeping the aspect ratio.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  pos.forEach((p, i) => {
    const r = radii[i] ?? 0;
    x0 = Math.min(x0, p.x - r);
    x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r);
    y1 = Math.max(y1, p.y + r);
  });
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const pad = 0.06;
  const sc = (1 - 2 * pad) / span;
  const ox = pad + ((1 - 2 * pad) - (x1 - x0) * sc) / 2;
  const oy = pad + ((1 - 2 * pad) - (y1 - y0) * sc) / 2;
  const stars: VaultStar[] = linked.map((pi, i) => {
    const p = projects[pi];
    const at = pos[i] ?? { x: 0, y: 0 };
    return {
      slug: p?.slug ?? "",
      umbrella: p?.umbrella ?? "unfiled",
      notes: p?.notes.length ?? 0,
      x: ox + (at.x - x0) * sc,
      y: oy + (at.y - y0) * sc,
      r: (radii[i] ?? 0) * sc,
    };
  });

  const deg = new Array<number>(projects.length).fill(0);
  for (const t of allTies) {
    deg[t.a] = (deg[t.a] ?? 0) + t.w;
    deg[t.b] = (deg[t.b] ?? 0) + t.w;
  }
  const slugOf = (pi: number): string => projects[pi]?.slug ?? "";
  return {
    stars,
    ties,
    umbrellas: [...new Set(stars.map((s) => s.umbrella))].sort(cmp),
    strongest: allTies.slice(0, LIST_CAP).map((t) => ({ a: slugOf(t.a), b: slugOf(t.b), w: t.w })),
    connected: projects
      .map((p, pi) => ({ slug: p.slug, w: deg[pi] ?? 0 }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w || cmp(a.slug, b.slug))
      .slice(0, LIST_CAP),
    islands: projects
      .filter((p, pi) => !remap.has(pi) && p.notes.length >= ISLAND_MIN_NOTES)
      .slice(0, ISLAND_CAP)
      .map((p) => ({ slug: p.slug, notes: p.notes.length })),
  };
}
