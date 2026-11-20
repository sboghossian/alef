// Today's real sessions → the plants of the 🏠 Home garden (features/garden.ts). DOM-free, so
// garden-plants-lib.test.ts covers it. Rewrite engine: garden-lib.ts (idea: MarkovJunior, MIT,
// Maxim Gumin, github.com/mxgmn/MarkovJunior).
//
//   one session started today → one seed on a fixed lattice of slots GAP cells apart (the hashed
//                               slot, or the nearest free one), so `capacity` plants always fit
//   its activity (messages)   → stem height, log-scaled and capped so a giant session can't fill the sky
//   shipped or delivered      → it blooms (shipped = a merged PR; delivered = a PR or a push)
//   live right now            → a closed bud at the tip that sways (the renderer does the swaying)
//   idle, no outcome          → stays green, no flower
//   the date + the session id → each plant's own PRNG, so a plant looks the same when others appear
//
// Every plant grows in its own small window (WIN cells wide) by its own rewrite program, then the
// windows are drawn side by side. Only real data goes in: a session with no usable id or start time
// is skipped, never invented.

import type { WorldAgent } from "../../../shared/types";
import { Grid, Program, compileNodes, hashSeed, mulberry32, type Node, type Rule, type RuleIndex } from "./garden-lib";

export const SOIL_ROWS = 4;
/** Columns one plant's window holds; slots are one window apart so windows never overlap. */
export const WIN = 9;
export const HALF = 4;
export const GAP = WIN;
export const MIN_STEM = 4;
export const MAX_STEM = 28;
/** Number of flower colours; a district picks one by hashing its id. */
export const FLOWER_COLOURS = 8;

export interface Plant {
  id: string;
  title: string;
  /** Column of its stem in the grid. */
  x: number;
  stem: number;
  colour: number;
  bloom: boolean;
  live: boolean;
  startedAt: number;
}

/** The fields of a session the garden reads. */
export type SessionLike = Partial<Pick<WorldAgent, "id" | "islandId" | "title" | "displayName" | "startedAt" | "messageCount" | "status">>;

/** Local midnight of the day containing `now`. */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "YYYY-MM-DD" in local time: the garden's seed. */
export function localDayKey(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Stem height from a message count: log-scaled, clamped to [MIN_STEM, MAX_STEM]. */
export function stemHeight(messages: unknown): number {
  const n = typeof messages === "number" && Number.isFinite(messages) && messages > 0 ? messages : 0;
  return Math.max(MIN_STEM, Math.min(MAX_STEM, Math.round(MIN_STEM + 3 * Math.log2(1 + n))));
}

export function flowerColour(islandId: unknown): number {
  return hashSeed(typeof islandId === "string" ? islandId : "") % FLOWER_COLOURS;
}

/** Plants a garden `width` cells wide can hold: one per lattice slot. */
export function capacity(width: number): number {
  return width < WIN ? 0 : Math.floor((width - WIN) / GAP) + 1;
}

/** Column of lattice slot k, the lattice centred in the garden. */
export function slotX(width: number, k: number): number {
  const cap = capacity(width);
  return HALF + Math.floor((width - WIN - (cap - 1) * GAP) / 2) + k * GAP;
}

export interface PlantOptions {
  now: number;
  width: number;
  /** Does this session count as bloomed? (Home passes outcomeOf: shipped or delivered.) */
  blooms: (id: string) => boolean;
  /** Display name of a session; defaults to its title. */
  nameOf?: (a: SessionLike) => string;
}

export interface Garden {
  plants: Plant[];
  /** Sessions that started today but didn't fit (the newest `capacity` are planted). */
  overflow: number;
}

/** Pure: sessions in, plants out. Anything that isn't a session started today is left out. */
export function plantsForDay(agents: readonly unknown[], o: PlantOptions): Garden {
  const from = localDayStart(o.now);
  const today: Array<{ a: SessionLike & { id: string }; t: number }> = [];
  const seen = new Set<string>();
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as SessionLike;
    if (typeof a.id !== "string" || !a.id || seen.has(a.id)) continue;
    const t = typeof a.startedAt === "string" ? Date.parse(a.startedAt) : NaN;
    if (!Number.isFinite(t) || t < from || t > o.now + 60_000) continue;
    seen.add(a.id);
    today.push({ a: a as SessionLike & { id: string }, t });
  }
  today.sort((p, q) => p.t - q.t || (p.a.id < q.a.id ? -1 : 1));
  const cap = capacity(o.width);
  const kept = today.slice(Math.max(0, today.length - cap));
  const free = new Array<boolean>(cap).fill(true);
  const plants: Plant[] = [];
  for (const { a, t } of kept) {
    // The hashed slot, else the nearest free one scanning outwards; kept.length <= cap guarantees one.
    const want = hashSeed(a.id) % cap;
    let k = want;
    for (let d = 0; d < cap; d++) {
      const spot = [want + d, want - d].find((c) => c >= 0 && c < cap && free[c]);
      if (spot !== undefined) {
        k = spot;
        break;
      }
    }
    free[k] = false;
    const named = (o.nameOf ? o.nameOf(a) : typeof a.title === "string" ? a.title : "").trim();
    plants.push({
      id: a.id,
      title: named || "Untitled session",
      x: slotX(o.width, k),
      stem: stemHeight(a.messageCount),
      colour: flowerColour(a.islandId),
      bloom: o.blooms(a.id),
      live: a.status === "live",
      startedAt: t,
    });
  }
  return { plants, overflow: today.length - kept.length };
}

// ---------------------------------------------------------------- the rules
//
// Cells inside one plant's window. Sky `.`, invisible cap `^` (a ceiling that stops the stem),
// invisible markers `m` (thick base) and `q` (branch point), growing tip `t`, stem `|`, thick stem
// `s`, branch `b` `c`, leaves `l` (light) `L` (dark), green tip `g`, live bud `E` with sepals `S`,
// petals `P`, flower centre `Y` (main) or `y` (side bloom).

/** Four 5x5 flower shapes, `.` = leave the cell alone. Rows top to bottom; the centre `Y` sits on the cap row. */
export const SHAPES: readonly (readonly string[])[] = [
  [".PPP.", "PPPPP", "PPYPP", "PPPPP", ".PPP."], // round
  ["P.P.P", ".PPP.", "PPYPP", ".PPP.", "P.P.P"], // daisy
  ["..P..", ".PPP.", "PPYPP", ".PPP.", "..P.."], // star
  ["P.P.P", "PPPPP", "PPYPP", ".PPP.", "..P.."], // tulip
];
const ANYCELL = "*";
const star = (rows: readonly string[]): string[] => rows.map((r) => r.replaceAll(".", ANYCELL));

const GROW: Rule[] = [
  { in: [".", "t"], out: ["t", "|"] },
  { in: ["m|"], out: ["s*"] },
  { in: ["q|"], out: ["b*"], mirror: true },
  { in: [".*", "*b"], out: ["c*", "**"], mirror: true },
];
// A pair of two-cell leaves angled up from the stem, at least three rows from the next pair.
const LEAVES: Rule = { in: ["*.*.*", ".***.", "*.|.*", "*.*.*"], out: ["*****", "l***L", "*l*L*", "*****"], mirror: true };
const SIDE_BLOOM: Rule = { in: ["...", ".c.", "***"], out: ["PPP", "PyP", "***"], mirror: true };

function endRules(kind: "bloom" | "live" | "plain", shape: number): Rule[] {
  if (kind === "bloom") return [{ in: [".....", ".....", "..^..", "..t..", "*****"], out: star(SHAPES[shape % SHAPES.length] as string[]) }, SIDE_BLOOM];
  if (kind === "live") return [{ in: ["^", "t"], out: ["E", "|"] }, { in: [".E.", ".|."], out: ["***", "S*S"] }];
  return [{ in: ["^", "t"], out: [".", "g"] }, { in: [".g.", ".|."], out: ["***", "l*L"] }];
}

const compiledCache = new Map<string, RuleIndex[]>();
function nodesFor(kind: "bloom" | "live" | "plain", shape: number, leafSteps: number): { nodes: Node[]; compiled: RuleIndex[] } {
  const nodes: Node[] = [
    { kind: "all", rules: GROW },
    { kind: "all", rules: endRules(kind, shape) },
    // Leaves last: they only take cells the flowers and branches left free.
    { kind: "one", rules: [LEAVES], steps: leafSteps },
  ];
  const key = `${kind}:${kind === "bloom" ? shape % SHAPES.length : 0}`;
  let compiled = compiledCache.get(key);
  if (!compiled) {
    compiled = compileNodes(nodes);
    compiledCache.set(key, compiled);
  }
  return { nodes, compiled };
}

// ---------------------------------------------------------------- the garden

export interface Sprite {
  plant: Plant;
  /** Grid column of the window's left edge. */
  x0: number;
  grid: Grid;
  program: Program;
}

export interface BuiltGarden {
  width: number;
  height: number;
  /** Row of the topmost grass cell: where stems start. */
  groundY: number;
  /** Grass tufts, grass line, soil and pebbles, drawn under the plants. `=` grass, `T` tuft, `#` soil, `%` dark soil, `o` pebble. */
  ground: Grid;
  sprites: Sprite[];
  /** Upper bound on the steps any one sprite needs: the replay's length. */
  ticks: number;
}

function sprite(p: Plant, groundY: number, day: string): Sprite {
  const g = new Grid(WIN, groundY, ".");
  const stem = Math.min(p.stem, groundY - 6);
  const base = groundY - 1;
  g.set(HALF, base, "t");
  g.set(HALF, base - stem, "^");
  for (let k = 0; k < Math.min(9, Math.floor(stem / 3)); k++) g.set(HALF - 1, base - k, "m");
  // Busy sessions grow side branches, on alternating sides, above the thick base.
  const first = hashSeed(p.id) & 1 ? 1 : -1;
  const heights = stem >= 24 ? [0.5, 0.75] : stem >= 15 ? [0.55] : [];
  heights.forEach((f, i) => g.set(HALF + (i % 2 ? -first : first), base - Math.round(stem * f), "q"));
  const kind = p.bloom ? "bloom" : p.live ? "live" : "plain";
  const { nodes, compiled } = nodesFor(kind, hashSeed(p.id) % SHAPES.length, Math.ceil(stem / 3));
  return { plant: p, x0: p.x - HALF, grid: g, program: new Program(g, nodes, mulberry32(hashSeed(`garden:${day}:${p.id}`)), compiled) };
}

/** Sky, the ground layer, and one growing window per plant. */
export function buildGarden(plants: readonly Plant[], width: number, height: number, day: string): BuiltGarden {
  const groundY = height - SOIL_ROWS;
  const ground = new Grid(width, height, ".");
  const rng = mulberry32(hashSeed(`ground:${day}:${width}`));
  for (let x = 0; x < width; x++) {
    ground.set(x, groundY, "=");
    for (let y = groundY + 1; y < height; y++) ground.set(x, y, y >= height - 2 ? "%" : "#");
    if (rng() < 0.22) ground.set(x, groundY - 1, "T");
    if (rng() < 0.07) ground.set(x, groundY + 1 + Math.floor(rng() * (SOIL_ROWS - 1)), "o");
  }
  const sprites = plants.map((p) => sprite(p, groundY, day));
  const tallest = Math.max(0, ...plants.map((p) => Math.min(p.stem, groundY - 6)));
  return { width, height, groundY, ground, sprites, ticks: tallest + Math.ceil(tallest / 3) + 8 };
}

/** One step of every unfinished sprite. False once all are done. */
export function stepGarden(b: BuiltGarden): boolean {
  let any = false;
  for (const s of b.sprites) if (s.program.step()) any = true;
  return any;
}

export function runGarden(b: BuiltGarden): void {
  for (const s of b.sprites) s.program.run();
}

export function gardenFinished(b: BuiltGarden): boolean {
  return b.sprites.every((s) => s.program.finished);
}

/** Ground plus every window laid over it (non-sky cells win). For tests and static drawing. */
export function compose(b: BuiltGarden): Grid {
  const out = new Grid(b.width, b.height, ".");
  out.cells.splice(0, out.cells.length, ...b.ground.cells);
  for (const s of b.sprites) {
    for (let y = 0; y < s.grid.h; y++) {
      for (let x = 0; x < s.grid.w; x++) {
        const c = s.grid.get(x, y);
        if (c !== "." && c !== "^") out.set(s.x0 + x, y, c);
      }
    }
  }
  return out;
}

/** Empty day: bare soil and one small sprout in the middle. */
export function sproutPlant(width: number): Plant {
  return { id: "", title: "", x: Math.floor(width / 2), stem: 5, colour: 0, bloom: false, live: false, startedAt: 0 };
}

/** The plant under a cell, if any: within 3 columns of its stem and between its flower top and the ground. */
export function plantAt(plants: readonly Plant[], cx: number, cy: number, groundY: number): Plant | null {
  let best: Plant | null = null;
  let bestD = Infinity;
  for (const p of plants) {
    const d = Math.abs(p.x - cx);
    if (d > 3 || cy > groundY || cy < groundY - p.stem - 3) continue;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** "Today's garden: N sessions, M in bloom" (+ how many didn't fit). */
export function gardenLabel(plants: readonly Plant[], overflow = 0): string {
  const n = plants.length + overflow;
  const bloomed = plants.filter((p) => p.bloom).length;
  return `Today's garden: ${n} ${n === 1 ? "session" : "sessions"}, ${bloomed} in bloom${overflow ? ` (${overflow} older ones not drawn)` : ""}`;
}
