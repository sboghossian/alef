// Pure geometry + labels for the usage panel's two charts (no DOM): the model-mix doughnut and the
// 24-bar activity-by-hour chart. usage.ts turns these into inline SVG; the rules (small slices
// fold into "other", bars scale to the busiest hour, shares add to 100) are pinned in
// usage-chart-lib.test.ts.

import type { RangeModel } from "../../../shared/features/usage";

/** One legend/slice row. `value` is the slice weight (cost when priced, else tokens). */
export interface MixSlice {
  label: string;
  value: number;
  share: number;
  color: string;
}

const PALETTE = ["#7aa7ff", "#ffd23f", "#62d98b", "#ff8a8a", "#b9a6ff", "#5ad1d1", "#ffb06b"] as const;
const OTHER_COLOR = "#8a8f99";
export const MAX_SLICES = 6;

/** "claude-opus-4-6-20260101" -> "opus-4-6": the family and version, without the vendor prefix or date suffix. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "") || model;
}

/**
 * Slices for the model mix. Weighted by est. cost; a model with no price entry (cost null) is
 * weighted by nothing and listed under "unpriced" only when every model is unpriced, in which case
 * tokens weigh. Beyond MAX_SLICES the smallest fold into "other". Shares sum to 1 (or all 0 when empty).
 */
export function mixSlices(models: readonly RangeModel[]): MixSlice[] {
  const priced = models.some((m) => m.costUsd !== null && m.costUsd > 0);
  // Ids that shorten to one label (a dated and an undated id, a [1m] variant) are one slice.
  const byLabel = new Map<string, number>();
  for (const m of models) {
    const label = shortModel(m.model);
    byLabel.set(label, (byLabel.get(label) ?? 0) + (priced ? (m.costUsd ?? 0) : m.tokens));
  }
  const rows = [...byLabel]
    .map(([label, value]) => ({ label, value }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const head = rows.length > MAX_SLICES ? rows.slice(0, MAX_SLICES - 1) : rows;
  const tail = rows.length > MAX_SLICES ? rows.slice(MAX_SLICES - 1) : [];
  const folded = tail.length ? [{ label: `other (${tail.length})`, value: tail.reduce((n, r) => n + r.value, 0) }] : [];
  const all = [...head, ...folded];
  const total = all.reduce((n, r) => n + r.value, 0);
  return all.map((r, i) => ({ ...r, share: total > 0 ? r.value / total : 0, color: folded.length && i === all.length - 1 ? OTHER_COLOR : (PALETTE[i % PALETTE.length] as string) }));
}

export interface ArcSlice extends MixSlice {
  /** SVG path of the ring segment. */
  d: string;
}

const pt = (cx: number, cy: number, r: number, turn: number): string => `${(cx + r * Math.sin(turn * 2 * Math.PI)).toFixed(2)} ${(cy - r * Math.cos(turn * 2 * Math.PI)).toFixed(2)}`;

/** Ring segments (outer radius r, inner radius r*hole) starting at 12 o'clock. A single 100% slice is drawn as two halves. */
export function ringArcs(slices: readonly MixSlice[], cx: number, cy: number, r: number, hole = 0.62): ArcSlice[] {
  const ri = r * hole;
  let start = 0;
  return slices.map((s) => {
    const end = start + s.share;
    const span = s.share >= 0.9999 ? 0.4999 : s.share;
    const seg = (a: number, b: number): string => `M${pt(cx, cy, r, a)} A${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${pt(cx, cy, r, b)} L${pt(cx, cy, ri, b)} A${ri} ${ri} 0 ${b - a > 0.5 ? 1 : 0} 0 ${pt(cx, cy, ri, a)} Z`;
    const d = s.share >= 0.9999 ? `${seg(start, start + 0.5)} ${seg(start + 0.5, start + 1)}` : seg(start, start + span);
    start = end;
    return { ...s, d };
  });
}

export interface HourBar {
  hour: number;
  ms: number;
  /** 0..1 of the busiest hour. */
  frac: number;
  label: string;
}

/** "3 pm" style hour label; 0 -> "12 am". */
export function hourLabel(h: number): string {
  const n = h % 12 === 0 ? 12 : h % 12;
  return `${n} ${h < 12 ? "am" : "pm"}`;
}

/** 24 bars scaled to the busiest hour (all 0 when there is no activity). Tolerates a short/odd array. */
export function hourBars(byHour: readonly number[]): HourBar[] {
  const ms = Array.from({ length: 24 }, (_, h) => Math.max(0, byHour[h] ?? 0));
  const max = Math.max(0, ...ms);
  return ms.map((v, hour) => ({ hour, ms: v, frac: max > 0 ? v / max : 0, label: hourLabel(hour) }));
}

/** The busiest hour, or null when there is no activity. */
export function peakHour(bars: readonly HourBar[]): HourBar | null {
  let best: HourBar | null = null;
  for (const b of bars) if (b.ms > 0 && (!best || b.ms > best.ms)) best = b;
  return best;
}
