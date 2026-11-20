// Pure geometry and formatting for the 🗄️ Vault sections. Everything here is numbers in, numbers
// out: no DOM, no fetch, no Date.now(). The view (vault.ts) turns what these return into SVG.
//
// Every chart the ten sections draw is one of eight shapes, so they all live here and are each
// unit-tested once rather than re-derived per section:
//   bars            Pulse's monthly stack, Meetings' weekly hours, Topics' families, Gaps' folders
//   share           Sources' 100% monthly mix
//   area            Growth's cumulative stack
//   stream          Focus's centred streamgraph
//   calendar        Pulse's 53x7 year of days
//   grid            Meetings' weekday x hour
//   spark           Topics' 26-week trend
//   scatter         People's log-log days-since vs total
//   bands           Sources' tool -> umbrella flow
//
// Coordinates are in an abstract 0..w / 0..h box the view maps onto a viewBox, so nothing here
// needs to know the real pixel size.

import { freshness } from "../ui/freshness";

/** A rectangle in chart space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One stacked series, already resolved to rectangles. */
export interface StackedBar extends Rect {
  /** Index of the bucket (the x position) this bar sits in. */
  i: number;
  /** Index of the series within the stack, outermost last. */
  s: number;
  value: number;
}

// ---------------------------------------------------------------- scales

/** The smallest round number at or above `max`, so an axis reads 40 and not 37. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= max) return candidate;
  }
  return 10 * mag;
}

/** Evenly spaced slots across `w`, each inset by `gap` on both sides. */
export function band(i: number, n: number, w: number, gap = 0): Rect {
  if (n <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const slot = w / n;
  const inner = Math.max(0, slot - gap * 2);
  return { x: i * slot + gap, y: 0, w: inner, h: 0 };
}

/** Sums each bucket across every series. `parts` arrays shorter than `n` read as zero. */
export function bucketTotals(series: readonly { readonly parts: readonly number[] }[], n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const s of series) for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (s.parts[i] ?? 0);
  return out;
}

// ---------------------------------------------------------------- bars

/**
 * A stacked bar chart. Series stack in the order given, first at the bottom.
 * `max` defaults to the nicest round number above the tallest bucket total.
 */
export function bars(
  series: readonly { readonly parts: readonly number[] }[],
  n: number,
  w: number,
  h: number,
  opts: { gap?: number; max?: number } = {},
): { bars: StackedBar[]; max: number } {
  const totals = bucketTotals(series, n);
  const max = opts.max ?? niceMax(Math.max(0, ...totals));
  const out: StackedBar[] = [];
  const baseline = new Array<number>(n).fill(0);
  for (let s = 0; s < series.length; s++) {
    const parts = series[s]?.parts ?? [];
    for (let i = 0; i < n; i++) {
      const value = parts[i] ?? 0;
      if (value <= 0) continue;
      const slot = band(i, n, w, opts.gap ?? 0);
      const below = baseline[i] ?? 0;
      const barH = (value / max) * h;
      out.push({ i, s, value, x: slot.x, w: slot.w, y: h - below - barH, h: barH });
      baseline[i] = below + barH;
    }
  }
  return { bars: out, max };
}

/** The same, normalised so every bucket fills the full height (a 100% stack). Empty buckets stay empty. */
export function share(series: readonly { readonly parts: readonly number[] }[], n: number, w: number, h: number, gap = 0): StackedBar[] {
  const totals = bucketTotals(series, n);
  const out: StackedBar[] = [];
  const baseline = new Array<number>(n).fill(0);
  for (let s = 0; s < series.length; s++) {
    const parts = series[s]?.parts ?? [];
    for (let i = 0; i < n; i++) {
      const value = parts[i] ?? 0;
      const total = totals[i] ?? 0;
      if (value <= 0 || total <= 0) continue;
      const slot = band(i, n, w, gap);
      const below = baseline[i] ?? 0;
      const barH = (value / total) * h;
      out.push({ i, s, value, x: slot.x, w: slot.w, y: h - below - barH, h: barH });
      baseline[i] = below + barH;
    }
  }
  return out;
}

// ---------------------------------------------------------------- area + stream

/** `parts[i]` -> an x,y point, with x spread across `w` and y measured down from the top. */
function points(parts: readonly number[], n: number, w: number, h: number, max: number, offset: readonly number[]): { x: number; y: number }[] {
  const step = n > 1 ? w / (n - 1) : 0;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) out.push({ x: i * step, y: h - (((offset[i] ?? 0) + (parts[i] ?? 0)) / max) * h });
  return out;
}

function pathOf(top: readonly { x: number; y: number }[], bottom: readonly { x: number; y: number }[]): string {
  if (top.length === 0) return "";
  const parts: string[] = [];
  top.forEach((p, i) => parts.push(`${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`));
  for (let i = bottom.length - 1; i >= 0; i--) {
    const p = bottom[i];
    if (p) parts.push(`L${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return `${parts.join("")}Z`;
}

/** Stacked areas, first series at the bottom. One filled path per series, bottom-up. */
export function area(
  series: readonly { readonly parts: readonly number[] }[],
  n: number,
  w: number,
  h: number,
  opts: { max?: number } = {},
): { paths: string[]; max: number } {
  const totals = bucketTotals(series, n);
  const max = opts.max ?? niceMax(Math.max(0, ...totals));
  const baseline = new Array<number>(n).fill(0);
  const paths: string[] = [];
  for (const s of series) {
    const below = [...baseline];
    const top = points(s.parts, n, w, h, max, below);
    const bottom = points(new Array<number>(n).fill(0), n, w, h, max, below);
    paths.push(pathOf(top, bottom));
    for (let i = 0; i < n; i++) baseline[i] = (baseline[i] ?? 0) + (s.parts[i] ?? 0);
  }
  return { paths, max };
}

/**
 * A centred streamgraph: each bucket's stack is centred on h/2, so the shape shows how attention
 * was split rather than how much of it there was. `max` is the widest bucket, which keeps the
 * tallest week touching both edges.
 */
export function stream(series: readonly { readonly parts: readonly number[] }[], n: number, w: number, h: number): { paths: string[]; max: number } {
  const totals = bucketTotals(series, n);
  const max = Math.max(1, ...totals);
  // Start each bucket half a stack low so the stack grows symmetrically about the middle.
  const baseline = totals.map((t) => (max - t) / 2);
  const paths: string[] = [];
  for (const s of series) {
    const below = [...baseline];
    const top = points(s.parts, n, w, h, max, below);
    const bottom = points(new Array<number>(n).fill(0), n, w, h, max, below);
    paths.push(pathOf(top, bottom));
    for (let i = 0; i < n; i++) baseline[i] = (baseline[i] ?? 0) + (s.parts[i] ?? 0);
  }
  return { paths, max };
}

/** A single open line, for a sparkline. Flat at mid-height when every value is equal. */
export function spark(values: readonly number[], w: number, h: number): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const y = span > 0 ? h - ((v - min) / span) * h : h / 2;
      return `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)} ${y.toFixed(2)}`;
    })
    .join("");
}

// ---------------------------------------------------------------- grids

export interface Cell {
  col: number;
  row: number;
  /** The bucket this cell stands for: a day index for the calendar, an hour for the week grid. */
  key: number;
  n: number;
  /** 0 (empty) to 4 (busiest), for the five heat steps the stylesheet defines. */
  heat: number;
}

/**
 * 0 for nothing, else 1..4 on a log scale of `max`. Log, not linear: one bulk-import day (7,000
 * notes against a usual 100) would otherwise flatten every other day to the first step.
 * Keeps one visible step for a single note.
 */
export function heat(n: number, max: number): number {
  if (n <= 0) return 0;
  if (max <= 1) return 1;
  return Math.min(4, 1 + Math.floor((Math.log(n) / Math.log(max)) * 3.999));
}

/**
 * A GitHub-style year of days: 53 columns of 7 rows, ending on `today`. Row 0 is Monday, matching
 * the server's weekday convention. Columns run oldest-left. Days before the window are dropped.
 */
export function calendar(counts: ReadonlyMap<number, number>, today: number, weeks = 53): Cell[] {
  // Walk back to the Monday of today's week, then back `weeks - 1` more weeks.
  const dow = (((today % 7) + 7) % 7 + 3) % 7;
  const start = today - dow - (weeks - 1) * 7;
  let max = 0;
  for (let d = start; d <= today; d++) max = Math.max(max, counts.get(d) ?? 0);
  const out: Cell[] = [];
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const day = start + col * 7 + row;
      if (day > today) continue;
      const n = counts.get(day) ?? 0;
      out.push({ col, row, key: day, n, heat: heat(n, max) });
    }
  }
  return out;
}

/** A weekday x hour grid from the server's row-major counts (7 rows of `hours` columns). */
export function grid(counts: readonly number[], hourFrom: number, hourTo: number): Cell[] {
  const hours = Math.max(0, hourTo - hourFrom + 1);
  const max = Math.max(0, ...counts);
  const out: Cell[] = [];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < hours; col++) {
      const n = counts[row * hours + col] ?? 0;
      out.push({ col, row, key: hourFrom + col, n, heat: heat(n, max) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- scatter + bands

export interface Dot {
  x: number;
  y: number;
  r: number;
  key: string;
}

/**
 * A log-log scatter: x = days since last seen (fresher to the left), y = total mentions. Both axes
 * are log so the long tail of once-mentioned names does not crush the people he actually sees.
 * A null `days` (never seen) parks at the right edge.
 */
export function scatter(
  items: readonly { key: string; daysSince: number | null; total: number; n90: number }[],
  w: number,
  h: number,
  opts: { maxDays?: number; rMin?: number; rMax?: number } = {},
): Dot[] {
  const maxDays = opts.maxDays ?? Math.max(30, ...items.map((i) => i.daysSince ?? 0));
  const maxTotal = Math.max(1, ...items.map((i) => i.total));
  const max90 = Math.max(1, ...items.map((i) => i.n90));
  const rMin = opts.rMin ?? 2;
  const rMax = opts.rMax ?? 10;
  const lx = Math.log10(maxDays + 1) || 1;
  const ly = Math.log10(maxTotal + 1) || 1;
  return items.map((i) => ({
    key: i.key,
    x: (Math.log10((i.daysSince ?? maxDays) + 1) / lx) * w,
    y: h - (Math.log10(i.total + 1) / ly) * h,
    // Area, not radius, carries the 90-day count, so a 4x busier name looks 2x wider.
    r: rMin + Math.sqrt(i.n90 / max90) * (rMax - rMin),
  }));
}

export interface Band {
  from: string;
  to: string;
  n: number;
  /** A cubic from the left column's slot to the right column's, thickness = `h`. */
  path: string;
  h: number;
}

/**
 * Source -> umbrella bands. Both columns are laid out by total flow, tallest first, and each band
 * leaves its source and arrives at its target stacked in the same order, so crossings read.
 */
export function bands(
  flows: readonly { from: string; to: string; n: number }[],
  w: number,
  h: number,
  opts: { pad?: number } = {},
): { bands: Band[]; left: (Rect & { key: string })[]; right: (Rect & { key: string })[] } {
  const pad = opts.pad ?? 2;
  const sum = (xs: readonly { n: number }[]): number => xs.reduce((a, b) => a + b.n, 0);
  const column = (keyOf: (f: { from: string; to: string }) => string): (Rect & { key: string })[] => {
    const totals = new Map<string, number>();
    for (const f of flows) totals.set(keyOf(f), (totals.get(keyOf(f)) ?? 0) + f.n);
    const keys = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = sum(flows);
    const avail = Math.max(0, h - pad * Math.max(0, keys.length - 1));
    let y = 0;
    return keys.map(([key, n]) => {
      const boxH = total > 0 ? (n / total) * avail : 0;
      const box = { key, x: 0, y, w: 0, h: boxH };
      y += boxH + pad;
      return box;
    });
  };
  const left = column((f) => f.from);
  const right = column((f) => f.to);
  const cursorL = new Map<string, number>();
  const cursorR = new Map<string, number>();
  const boxOf = (col: readonly (Rect & { key: string })[], key: string): (Rect & { key: string }) | undefined => col.find((c) => c.key === key);
  const total = sum(flows);
  const avail = (col: readonly (Rect & { key: string })[]): number => Math.max(0, h - pad * Math.max(0, col.length - 1));
  const ordered = [...flows].sort((a, b) => b.n - a.n || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const out: Band[] = [];
  for (const f of ordered) {
    const l = boxOf(left, f.from);
    const r = boxOf(right, f.to);
    if (!l || !r) continue;
    const thickL = total > 0 ? (f.n / total) * avail(left) : 0;
    const thickR = total > 0 ? (f.n / total) * avail(right) : 0;
    const y0 = l.y + (cursorL.get(f.from) ?? 0);
    const y1 = r.y + (cursorR.get(f.to) ?? 0);
    cursorL.set(f.from, (cursorL.get(f.from) ?? 0) + thickL);
    cursorR.set(f.to, (cursorR.get(f.to) ?? 0) + thickR);
    const mid = w / 2;
    const path =
      `M0 ${y0.toFixed(2)}` +
      `C${mid.toFixed(2)} ${y0.toFixed(2)} ${mid.toFixed(2)} ${y1.toFixed(2)} ${w.toFixed(2)} ${y1.toFixed(2)}` +
      `L${w.toFixed(2)} ${(y1 + thickR).toFixed(2)}` +
      `C${mid.toFixed(2)} ${(y1 + thickR).toFixed(2)} ${mid.toFixed(2)} ${(y0 + thickL).toFixed(2)} 0 ${(y0 + thickL).toFixed(2)}Z`;
    out.push({ from: f.from, to: f.to, n: f.n, path, h: thickL });
  }
  return { bands: out, left, right };
}

// ---------------------------------------------------------------- treemap + chord

/**
 * A squarified treemap (Bruls, Huizing, van Wijk) of `values` into a w x h box. Returns one rect
 * per value, in input order; a zero or negative value gets an empty rect. `gap` is taken off each
 * cell's right and bottom edge so neighbours read as separate.
 */
export function treemap(values: readonly number[], w: number, h: number, gap = 0): Rect[] {
  const out: Rect[] = values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const order = values
    .map((v, i) => ({ v: Math.max(0, v), i }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v || a.i - b.i);
  const total = order.reduce((s, x) => s + x.v, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let box = { x: 0, y: 0, w, h };
  let k = 0;
  const worst = (row: readonly number[], side: number): number => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  while (k < order.length) {
    const side = Math.min(box.w, box.h);
    const row: number[] = [];
    let j = k;
    while (j < order.length) {
      const area = (order[j]?.v ?? 0) * scale;
      if (row.length > 0 && worst([...row, area], side) > worst(row, side)) break;
      row.push(area);
      j++;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    const horizontal = box.w >= box.h; // lay the row along the short side
    const thick = sum / side;
    let at = 0;
    row.forEach((area, n) => {
      const len = area / thick;
      const idx = order[k + n]?.i ?? 0;
      out[idx] = horizontal
        ? { x: box.x, y: box.y + at, w: Math.max(0, thick - gap), h: Math.max(0, len - gap) }
        : { x: box.x + at, y: box.y, w: Math.max(0, len - gap), h: Math.max(0, thick - gap) };
      at += len;
    });
    box = horizontal ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h } : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
    k = j;
  }
  return out;
}

export interface Chord {
  /** Per group: its outer arc as [start, end] angles (0 = 12 o'clock, clockwise), or null when it has no cross links. */
  arcs: ([number, number] | null)[];
  /** One ribbon per linked pair, i < j. */
  ribbons: { i: number; j: number; n: number; path: string }[];
}

/**
 * A chord diagram's geometry, as the artifact draws it: arcs sized by each group's cross links,
 * each arc split among its partners, a ribbon per pair curving through the centre.
 */
export function chord(matrix: readonly (readonly number[])[], size: number, radius: number, gap = 0.03): Chord {
  const G = matrix.length;
  const at = (a: number, b: number): number => matrix[a]?.[b] ?? 0;
  const cross = Array.from({ length: G }, (_, i) => {
    let s = 0;
    for (let j = 0; j < G; j++) if (j !== i) s += at(i, j) + at(j, i);
    return s;
  });
  const total = cross.reduce((a, b) => a + b, 0);
  const arcs: ([number, number] | null)[] = [];
  if (total <= 0) return { arcs: cross.map(() => null), ribbons: [] };
  const liveCount = cross.filter((c) => c > 0).length;
  const avail = Math.PI * 2 - gap * liveCount;
  let a = 0;
  for (let i = 0; i < G; i++) {
    const c = cross[i] ?? 0;
    if (c <= 0) {
      arcs.push(null);
      continue;
    }
    const span = (c / total) * avail;
    arcs.push([a, a + span]);
    a += span + gap;
  }
  const sub = Array.from({ length: G }, () => new Map<number, [number, number]>());
  for (let i = 0; i < G; i++) {
    const arc = arcs[i];
    if (!arc) continue;
    let p = arc[0];
    const span = arc[1] - arc[0];
    for (let j = 0; j < G; j++) {
      if (j === i) continue;
      const v = at(i, j) + at(j, i);
      if (!v) continue;
      const w = (v / (cross[i] ?? 1)) * span;
      sub[i]?.set(j, [p, p + w]);
      p += w;
    }
  }
  const c = size / 2;
  const pt = (ang: number, r: number): string => `${(c + r * Math.sin(ang)).toFixed(2)},${(c - r * Math.cos(ang)).toFixed(2)}`;
  const R = radius;
  const ribbons: Chord["ribbons"] = [];
  for (let i = 0; i < G; i++) {
    for (let j = i + 1; j < G; j++) {
      const v = at(i, j) + at(j, i);
      const si = sub[i]?.get(j);
      const sj = sub[j]?.get(i);
      if (!v || !si || !sj) continue;
      const [a0, a1] = si;
      const [b0, b1] = sj;
      const path =
        `M${pt(a0, R)} A${R},${R} 0 ${a1 - a0 > Math.PI ? 1 : 0},1 ${pt(a1, R)} Q${c},${c} ${pt(b0, R)} ` +
        `A${R},${R} 0 ${b1 - b0 > Math.PI ? 1 : 0},1 ${pt(b1, R)} Q${c},${c} ${pt(a0, R)}Z`;
      ribbons.push({ i, j, n: v, path });
    }
  }
  return { arcs, ribbons };
}

/** The outer band of a chord group, between radii r0 and r1. */
export function arcBand(size: number, s0: number, s1: number, r0: number, r1: number): string {
  const c = size / 2;
  const pt = (ang: number, r: number): string => `${(c + r * Math.sin(ang)).toFixed(2)},${(c - r * Math.cos(ang)).toFixed(2)}`;
  const large = s1 - s0 > Math.PI ? 1 : 0;
  return `M${pt(s0, r1)} A${r1},${r1} 0 ${large},1 ${pt(s1, r1)} L${pt(s1, r0)} A${r0},${r0} 0 ${large},0 ${pt(s0, r0)}Z`;
}

// ---------------------------------------------------------------- formatting

/** 1234 -> "1,234". Keeps counts readable without pulling in Intl for every cell. */
export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Shared with every other vault-fed header (ui/freshness.ts), re-exported for this file's callers.
export { ageLabel, FEED_STALE_MS } from "../ui/freshness";

/** The one-line freshness stamp under every section's title, so you can tell real from stale. */
export function feedStamp(
  meta: { ready: boolean; generatedAt: string; notes: number; links: number } | null,
  nowMs: number,
): { text: string; stale: boolean } {
  if (!meta?.ready) return { text: "Reading the vault's graph feed…", stale: false };
  const f = freshness(meta.generatedAt, nowMs);
  if (f.ageMs === null) return { text: `${int(meta.notes)} notes · feed has no build time`, stale: true };
  const at = meta.generatedAt.slice(0, 16).replace("T", " ");
  return { text: `Live vault · ${int(meta.notes)} notes · ${int(meta.links)} links · feed built ${f.label} (${at} UTC)`, stale: f.stale };
}

/** A share as a whole percent. */
export function pct(share: number): string {
  if (!Number.isFinite(share)) return "—";
  return `${Math.round(share * 100)}%`;
}

/** A change against a previous period, signed, with an arrow. Equal periods read "level". */
export function delta(now: number, before: number): { text: string; dir: "up" | "down" | "flat" } {
  const d = now - before;
  if (d === 0) return { text: "level", dir: "flat" };
  return { text: `${d > 0 ? "↑" : "↓"} ${int(Math.abs(d))}`, dir: d > 0 ? "up" : "down" };
}

/** Days since a day index, in the words the cards use. */
export function since(day: number | null, today: number): string {
  if (day === null) return "never";
  const d = today - day;
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  const years = d / 365;
  return `${years < 2 ? "1y" : `${Math.round(years)}y`} ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-10" -> "Oct", or "Oct 26" when the year changes within the window. */
export function monthLabel(ym: string, withYear = false): string {
  const [y, m] = ym.split("-");
  const i = Number.parseInt(m ?? "", 10) - 1;
  const name = MONTHS[i] ?? ym;
  return withYear && y ? `${name} ${y.slice(2)}` : name;
}

/** The month labels for a run of "YYYY-MM" buckets, year added only where the year turns over. */
export function monthLabels(months: readonly string[]): string[] {
  return months.map((m, i) => {
    const prev = months[i - 1];
    const turned = !prev || prev.slice(0, 4) !== m.slice(0, 4);
    return monthLabel(m, turned);
  });
}

export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
