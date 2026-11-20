// Pure helpers for the "metrics" feature: a bounded ring buffer for the 30s-sampled live
// gauges, the bucket width per requested range, the bucket-averaging that turns raw
// samples into a fixed-length MetricSeries, and the calendar-day keys a range covers (for
// reading the usage store, which only has day granularity). No IO — metrics.ts does the
// sampling (os.loadavg, the world snapshot, the fleet tracker, the subagents store) and
// calls into this module.

import { localDateKey } from "../heuristics.js";
import type { GaugeValues, MetricPoint, MetricsRange } from "../../shared/features/metrics.js";

/** One 30s sample of every live gauge. */
export interface GaugeSample extends GaugeValues {
  t: number;
}

/** Fixed-capacity FIFO of the last `capacity` items, oldest first. */
export class RingBuffer<T> {
  private buf: T[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error("RingBuffer capacity must be > 0");
  }

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  toArray(): readonly T[] {
    return this.buf;
  }

  get size(): number {
    return this.buf.length;
  }
}

export interface BucketSpec {
  spanMs: number;
  bucketMs: number;
}

/** Bucket width per range: fine enough to look smooth against a 30s sample cadence,
 *  coarse enough that a small inline SVG stays legible. */
export function bucketSpecFor(range: MetricsRange): BucketSpec {
  switch (range) {
    case "1h":
      return { spanMs: 3_600_000, bucketMs: 2 * 60_000 }; // 30 buckets, 2 min each
    case "24h":
      return { spanMs: 24 * 3_600_000, bucketMs: 30 * 60_000 }; // 48 buckets, 30 min each
    case "7d":
      return { spanMs: 7 * 24 * 3_600_000, bucketMs: 4 * 3_600_000 }; // 42 buckets, 4h each
  }
}

/** Buckets timestamped samples into fixed-width, evenly-spaced buckets covering exactly
 *  [nowMs - spec.spanMs, nowMs], each valued by the average of the samples that land in
 *  it. An empty bucket carries the last known value forward (never fakes a dip to 0 just
 *  because nothing was sampled yet, e.g. right after a dev-server restart cleared the
 *  ring buffer); a bucket before the very first sample stays 0 (nothing to carry).
 *  Samples outside the window, or with a non-finite t/v, are ignored. */
export function bucketSamples(samples: readonly { t: number; v: number }[], spec: BucketSpec, nowMs: number): MetricPoint[] {
  const bucketCount = Math.max(1, Math.round(spec.spanMs / spec.bucketMs));
  const startMs = nowMs - bucketCount * spec.bucketMs;
  const sums = new Array<number>(bucketCount).fill(0);
  const counts = new Array<number>(bucketCount).fill(0);
  for (const s of samples) {
    if (!Number.isFinite(s.t) || !Number.isFinite(s.v)) continue;
    if (s.t <= startMs || s.t > nowMs) continue;
    const idx = Math.min(bucketCount - 1, Math.floor((s.t - startMs) / spec.bucketMs));
    sums[idx] = (sums[idx] ?? 0) + s.v;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const points: MetricPoint[] = [];
  let carry = 0;
  let seen = false;
  for (let i = 0; i < bucketCount; i++) {
    const t = startMs + (i + 1) * spec.bucketMs;
    const count = counts[i] ?? 0;
    if (count > 0) {
      carry = (sums[i] ?? 0) / count;
      seen = true;
    }
    points.push({ t, v: seen ? carry : 0 });
  }
  return points;
}

/** System memory used, as a 0..100 percentage. Never negative or over 100 even if the
 *  inputs are momentarily inconsistent (a free-memory reading can exceed total on some
 *  hosts' cgroup-backed os.totalmem()). */
export function memUsedPct(totalBytes: number, freeBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const used = Math.max(0, totalBytes - freeBytes);
  return Math.min(100, (used / totalBytes) * 100);
}

/** Reclaimable bytes from macOS `vm_stat` output: free + inactive + speculative + purgeable
 *  pages. os.freemem() counts only "free", so on macOS it reads ~99% used while the file cache
 *  is full. null when the text doesn't parse (not macOS, or the format changed). */
export function availableBytesFromVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!size) return null;
  const pages = (name: string): number => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return total > 0 ? total * Number(size) : null;
}

/** Calendar date keys (local, "YYYY-MM-DD", oldest first) covered by a range — the usage
 *  store's own grain. `1h`/`24h` normally return 1-2 dates (2 only right after local
 *  midnight); `7d` normally returns 8 (a 7-day span usually touches 8 calendar dates).
 *  The `t += 86_400_000` stride can land off-midnight on a DST-transition day; that only
 *  ever shifts which dates line up, never throws or infinite-loops. */
export function dayKeysForRange(range: MetricsRange, nowMs: number): string[] {
  const startMs = nowMs - bucketSpecFor(range).spanMs;
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(nowMs);
  end.setHours(0, 0, 0, 0);
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) out.push(localDateKey(new Date(t)));
  return out;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight ms for a "YYYY-MM-DD" key (dayKeysForRange's own format). NaN for a
 *  malformed key — callers must check (Number.isNaN), never assume it's always valid. */
export function dateKeyToMs(key: string): number {
  const m = DATE_KEY_RE.exec(key);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}
