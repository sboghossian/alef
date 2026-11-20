// Pan / zoom / fit math for the canvas view. Pure: screen = world * k + (x, y).
// (Same model as abcd's System surface: anchor-preserving wheel zoom, fit-to-bounds.)

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_K = 0.12;
export const MAX_K = 2.5;

export function clampK(k: number, min = MIN_K, max = MAX_K): number {
  return Math.min(max, Math.max(min, k));
}

export function worldToScreen(v: View, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * v.k + v.x, y: wy * v.k + v.y };
}

export function screenToWorld(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
}

/** Zoom by `factor` keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(v: View, factor: number, sx: number, sy: number, min = MIN_K, max = MAX_K): View {
  const k = clampK(v.k * factor, min, max);
  const r = k / v.k;
  return { k, x: sx - (sx - v.x) * r, y: sy - (sy - v.y) * r };
}

/** The view that shows all of `b` inside a vw×vh viewport with `pad` px of margin, centered. */
export function fitView(b: Rect, vw: number, vh: number, pad = 40, min = MIN_K, max = 1.2): View {
  const w = Math.max(1, b.w);
  const hh = Math.max(1, b.h);
  const k = clampK(Math.min((vw - pad * 2) / w, (vh - pad * 2) / hh), min, max);
  return { k, x: (vw - w * k) / 2 - b.x * k, y: (vh - hh * k) / 2 - b.y * k };
}

/** Centers world point (wx, wy) at the viewport's center, keeping k. */
export function centerOn(v: View, wx: number, wy: number, vw: number, vh: number): View {
  return { k: v.k, x: vw / 2 - wx * v.k, y: vh / 2 - wy * v.k };
}

/** Keeps at least `margin` px of the content on screen, so it can never be panned away. */
export function clampPan(v: View, content: Rect, vw: number, vh: number, margin = 80): View {
  const left = content.x * v.k + v.x;
  const right = (content.x + content.w) * v.k + v.x;
  const top = content.y * v.k + v.y;
  const bottom = (content.y + content.h) * v.k + v.y;
  let { x, y } = v;
  const m = Math.min(margin, vw / 2, vh / 2);
  if (right < m) x += m - right;
  if (left > vw - m) x -= left - (vw - m);
  if (bottom < m) y += m - bottom;
  if (top > vh - m) y -= top - (vh - m);
  return { k: v.k, x, y };
}

/** The world rectangle the viewport shows, grown by `overscanPx` screen pixels per side. */
export function visibleWorld(v: View, vw: number, vh: number, overscanPx = 0): Rect {
  const o = overscanPx / v.k;
  return { x: -v.x / v.k - o, y: -v.y / v.k - o, w: vw / v.k + o * 2, h: vh / v.k + o * 2 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Wheel delta → zoom factor (trackpad pinch arrives as ctrl+wheel with small deltas). */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (pinch ? 0.01 : 0.0018));
}
