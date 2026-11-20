// A tiny Markov-style rewriting engine for the 🏠 Home garden (features/garden.ts). DOM-free, so
// garden-lib.test.ts covers it.
//
// Idea from MarkovJunior (github.com/mxgmn/MarkovJunior, MIT, Maxim Gumin): a grid of symbols and
// rewrite rules `in → out`. A node finds where its rules match and rewrites: `one` applies ONE
// random match, `all` applies every non-overlapping match. Nodes run in sequence, each until it has
// nothing left to do. This is an independent TypeScript implementation of that idea, not a port.
//
// Rules are small rectangles written as rows of one-character cells. In `in`, `*` matches any cell;
// in `out`, `*` leaves the cell alone. `mirror` also tries the left-right flip, `rotate` the four
// quarter turns (and, with `mirror`, their flips). All randomness comes from a seeded PRNG, so the
// same seed and the same inputs always give the same grid.

/** FNV-1a over UTF-16 code units: a stable 32-bit seed from any string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32: a small, fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ANY = "*";

export class Grid {
  readonly cells: string[];
  constructor(
    readonly w: number,
    readonly h: number,
    fill = ".",
  ) {
    this.cells = new Array<string>(Math.max(0, w) * Math.max(0, h)).fill(fill);
  }
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  get(x: number, y: number): string {
    return this.inside(x, y) ? (this.cells[y * this.w + x] as string) : "";
  }
  set(x: number, y: number, c: string): void {
    if (this.inside(x, y)) this.cells[y * this.w + x] = c;
  }
  rows(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) out.push(this.cells.slice(y * this.w, (y + 1) * this.w).join(""));
    return out;
  }
  count(c: string): number {
    let n = 0;
    for (const v of this.cells) if (v === c) n++;
    return n;
  }
}

export interface Rule {
  /** Rows of cells, top to bottom. All rows the same length. */
  in: readonly string[];
  /** Same shape as `in`. */
  out: readonly string[];
  mirror?: boolean;
  rotate?: boolean;
}

/** One orientation of a rule, flattened. */
interface Variant {
  w: number;
  h: number;
  inp: string[];
  out: string[];
}

function toCells(rows: readonly string[]): string[][] {
  return rows.map((r) => Array.from(r));
}

function shapeOk(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((r, i) => r.length > 0 && Array.from(r).length === Array.from(a[0] as string).length && Array.from(r).length === Array.from(b[i] as string).length);
}

const flip = (m: string[][]): string[][] => m.map((r) => r.slice().reverse());
const turn = (m: string[][]): string[][] => (m[0] as string[]).map((_, x) => m.map((r) => r[x] as string).reverse());

/** Every distinct orientation of a rule. A malformed rule (ragged or mismatched rows) has none. */
export function compileRule(rule: Rule): Variant[] {
  if (!shapeOk(rule.in, rule.out)) return [];
  let pairs: Array<[string[][], string[][]]> = [[toCells(rule.in), toCells(rule.out)]];
  if (rule.rotate) {
    for (let i = 0; i < 3; i++) {
      const [a, b] = pairs[pairs.length - 1] as [string[][], string[][]];
      pairs.push([turn(a), turn(b)]);
    }
  }
  if (rule.mirror) pairs = pairs.concat(pairs.map(([a, b]) => [flip(a), flip(b)] as [string[][], string[][]]));
  const seen = new Set<string>();
  const list: Variant[] = [];
  for (const [a, b] of pairs) {
    const key = JSON.stringify([a, b]);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ w: (a[0] as string[]).length, h: a.length, inp: a.flat(), out: b.flat() });
  }
  return list;
}

interface Match {
  x: number;
  y: number;
  v: Variant;
}

function matchesAt(g: Grid, v: Variant, x: number, y: number): boolean {
  for (let j = 0; j < v.h; j++) {
    for (let i = 0; i < v.w; i++) {
      const want = v.inp[j * v.w + i] as string;
      if (want !== ANY && g.get(x + i, y + j) !== want) return false;
    }
  }
  return true;
}

/** Variants indexed by one anchor cell (a non-wildcard `in` cell, preferably not the common sky `.`),
 *  so a sweep looks at each grid cell once instead of trying every rule at every position. */
export type RuleIndex = Map<string, Array<{ v: Variant; ax: number; ay: number }>>;

export function indexVariants(variants: readonly Variant[]): RuleIndex {
  const idx: RuleIndex = new Map();
  for (const v of variants) {
    let at = -1;
    for (let k = 0; k < v.inp.length; k++) {
      const c = v.inp[k] as string;
      if (c === ANY) continue;
      if (at < 0 || (v.inp[at] === "." && c !== ".")) at = k;
    }
    if (at < 0) continue; // an all-wildcard pattern matches everywhere and rewrites nothing useful
    const c = v.inp[at] as string;
    const list = idx.get(c) ?? [];
    list.push({ v, ax: at % v.w, ay: Math.floor(at / v.w) });
    idx.set(c, list);
  }
  return idx;
}

/** Every place a variant matches, in scan order (deterministic). */
export function findMatches(g: Grid, variants: readonly Variant[] | RuleIndex): Match[] {
  const idx = variants instanceof Map ? variants : indexVariants(variants);
  const found: Match[] = [];
  for (let cy = 0; cy < g.h; cy++) {
    for (let cx = 0; cx < g.w; cx++) {
      const list = idx.get(g.cells[cy * g.w + cx] as string);
      if (!list) continue;
      for (const { v, ax, ay } of list) {
        const x = cx - ax;
        const y = cy - ay;
        if (x < 0 || y < 0 || x + v.w > g.w || y + v.h > g.h) continue;
        if (matchesAt(g, v, x, y)) found.push({ x, y, v });
      }
    }
  }
  return found;
}

/** Grid indices a match writes: every non-`*` output cell (its whole footprint, as in MarkovJunior). */
function footprint(g: Grid, m: Match): number[] {
  const cells: number[] = [];
  for (let j = 0; j < m.v.h; j++) {
    for (let i = 0; i < m.v.w; i++) if (m.v.out[j * m.v.w + i] !== ANY) cells.push((m.y + j) * g.w + m.x + i);
  }
  return cells;
}

/** Would writing this match change any cell? */
function changes(g: Grid, m: Match): boolean {
  for (let j = 0; j < m.v.h; j++) {
    for (let i = 0; i < m.v.w; i++) {
      const o = m.v.out[j * m.v.w + i] as string;
      if (o !== ANY && o !== g.cells[(m.y + j) * g.w + m.x + i]) return true;
    }
  }
  return false;
}

function write(g: Grid, m: Match): void {
  for (let j = 0; j < m.v.h; j++) {
    for (let i = 0; i < m.v.w; i++) {
      const o = m.v.out[j * m.v.w + i] as string;
      if (o !== ANY) g.set(m.x + i, m.y + j, o);
    }
  }
}

export interface Node {
  kind: "one" | "all";
  rules: readonly Rule[];
  /** Stop after this many applications (default: until no rule would change anything). */
  steps?: number;
}

/** A sequence of nodes over one grid. `step()` does one application of the current node. */
export class Program {
  private idx = 0;
  private done = 0;
  private readonly compiled: RuleIndex[];
  /** `compiled` (from compileNodes on the same rules) lets many programs share one compile. */
  constructor(
    readonly grid: Grid,
    private readonly nodes: readonly Node[],
    private readonly rng: Rng,
    compiled?: RuleIndex[],
  ) {
    this.compiled = compiled ?? compileNodes(nodes);
  }

  get finished(): boolean {
    return this.idx >= this.nodes.length;
  }

  private next(): void {
    this.idx++;
    this.done = 0;
  }

  /** One application. Returns false once every node is exhausted. A node ends when its step cap is
   *  reached or when no match would change a cell (so a no-op rule cannot spin). */
  step(): boolean {
    while (!this.finished) {
      const node = this.nodes[this.idx] as Node;
      if (node.steps !== undefined && this.done >= node.steps) {
        this.next();
        continue;
      }
      const all = findMatches(this.grid, this.compiled[this.idx] as RuleIndex).filter((m) => changes(this.grid, m));
      if (all.length === 0) {
        this.next();
        continue;
      }
      if (node.kind === "one") {
        write(this.grid, all[Math.floor(this.rng() * all.length)] as Match);
      } else {
        // Fisher-Yates with the seeded rng, then keep matches whose whole footprint is still free.
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [all[i], all[j]] = [all[j] as Match, all[i] as Match];
        }
        const taken = new Set<number>();
        for (const m of all) {
          const cells = footprint(this.grid, m);
          if (cells.some((c) => taken.has(c))) continue;
          for (const c of cells) taken.add(c);
          write(this.grid, m);
        }
      }
      this.done++;
      return true;
    }
    return false;
  }

  /** Run to the end (capped, so a rule set that never settles cannot hang). Returns the step count. */
  run(cap = 100_000): number {
    let n = 0;
    while (n < cap && this.step()) n++;
    return n;
  }
}

/** Compile every node's rules once, for reuse across programs with the same rules. */
export function compileNodes(nodes: readonly Node[]): RuleIndex[] {
  return nodes.map((n) => indexVariants(n.rules.flatMap(compileRule)));
}
