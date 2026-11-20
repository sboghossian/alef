import { describe, expect, it } from "vitest";
import { RingBuffer, availableBytesFromVmStat, bucketSamples, bucketSpecFor, dateKeyToMs, dayKeysForRange, memUsedPct } from "../features/metrics-lib.js";

describe("RingBuffer", () => {
  it("keeps insertion order within capacity", () => {
    const r = new RingBuffer<number>(3);
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    expect(r.size).toBe(2);
  });

  it("evicts the oldest item once over capacity (FIFO)", () => {
    const r = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });

  it("throws on a non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
  });
});

describe("bucketSpecFor", () => {
  it("gives an evenly-divisible span/bucket pair for every range", () => {
    for (const range of ["1h", "24h", "7d"] as const) {
      const spec = bucketSpecFor(range);
      expect(spec.spanMs % spec.bucketMs).toBe(0);
      expect(spec.bucketMs).toBeGreaterThan(0);
    }
  });
});

describe("bucketSamples", () => {
  const spec = { spanMs: 10 * 60_000, bucketMs: 60_000 }; // 10 buckets, 1 min each
  const now = 1_000 * 60_000; // arbitrary round number

  it("returns bucketCount all-zero points when there are no samples", () => {
    const points = bucketSamples([], spec, now);
    expect(points).toHaveLength(10);
    expect(points.every((p) => p.v === 0)).toBe(true);
    expect(points[9]!.t).toBe(now);
  });

  it("places a single sample in its bucket and carries it forward, never backward", () => {
    const sampleAt = now - 10_000; // inside the last (10th) bucket
    const points = bucketSamples([{ t: sampleAt, v: 42 }], spec, now);
    expect(points.slice(0, 9).every((p) => p.v === 0)).toBe(true);
    expect(points[9]!.v).toBe(42);
  });

  it("carries the last known value forward through an empty bucket", () => {
    const start = now - spec.spanMs;
    const points = bucketSamples(
      [
        { t: start + 1, v: 10 }, // bucket 0, just after the window opens
        { t: start + 3 * 60_000 + 1, v: 20 }, // bucket 3
      ],
      spec,
      now,
    );
    expect(points[0]!.v).toBe(10);
    expect(points[1]!.v).toBe(10); // carried forward, not reset to 0
    expect(points[2]!.v).toBe(10);
    expect(points[3]!.v).toBe(20);
    expect(points[9]!.v).toBe(20); // carried to the end
  });

  it("averages multiple samples landing in the same bucket", () => {
    const t = now - 5_000; // last bucket
    const points = bucketSamples(
      [
        { t, v: 10 },
        { t: t + 1, v: 20 },
      ],
      spec,
      now,
    );
    expect(points[9]!.v).toBe(15);
  });

  it("ignores samples outside the window and non-finite samples", () => {
    const points = bucketSamples(
      [
        { t: now - 999_999_999, v: 5 }, // way before the window
        { t: now + 999_999_999, v: 5 }, // in the future
        { t: NaN, v: 5 },
        { t: now - 1_000, v: NaN },
      ],
      spec,
      now,
    );
    expect(points.every((p) => p.v === 0)).toBe(true);
  });
});

describe("memUsedPct", () => {
  it("computes a normal percentage", () => {
    expect(memUsedPct(100, 25)).toBe(75);
  });

  it("is 0 when total is 0 or negative", () => {
    expect(memUsedPct(0, 0)).toBe(0);
    expect(memUsedPct(-10, 0)).toBe(0);
  });

  it("clamps to 0 when free somehow exceeds total", () => {
    expect(memUsedPct(100, 150)).toBe(0);
  });

  it("is 100 when nothing is free", () => {
    expect(memUsedPct(100, 0)).toBe(100);
  });
});

describe("dayKeysForRange", () => {
  it("1h in the middle of the day covers just today", () => {
    const now = new Date(2026, 8, 25, 15, 0, 0).getTime();
    expect(dayKeysForRange("1h", now)).toEqual(["2026-09-25"]);
  });

  it("1h just after local midnight spans into yesterday", () => {
    const now = new Date(2026, 8, 25, 0, 15, 0).getTime();
    expect(dayKeysForRange("1h", now)).toEqual(["2026-09-24", "2026-09-25"]);
  });

  it("24h in the middle of the day covers today and yesterday", () => {
    const now = new Date(2026, 8, 25, 15, 0, 0).getTime();
    expect(dayKeysForRange("24h", now)).toEqual(["2026-09-24", "2026-09-25"]);
  });

  it("7d covers 8 calendar dates in the general case", () => {
    const now = new Date(2026, 8, 25, 15, 0, 0).getTime();
    const keys = dayKeysForRange("7d", now);
    expect(keys[0]).toBe("2026-09-18");
    expect(keys[keys.length - 1]).toBe("2026-09-25");
    expect(keys).toHaveLength(8);
  });
});

describe("dateKeyToMs", () => {
  it("parses a valid key to that date's local midnight", () => {
    expect(dateKeyToMs("2026-09-25")).toBe(new Date(2026, 8, 25, 0, 0, 0, 0).getTime());
  });

  it("returns NaN for a malformed key", () => {
    expect(Number.isNaN(dateKeyToMs("not-a-date"))).toBe(true);
    expect(Number.isNaN(dateKeyToMs("2026-9-25"))).toBe(true);
  });
});

describe("availableBytesFromVmStat", () => {
  it("sums free + inactive + speculative + purgeable pages", () => {
    const t = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:        10.\nPages active:   500.\nPages inactive:    20.\nPages speculative:  5.\nPages purgeable:   1.\n";
    expect(availableBytesFromVmStat(t)).toBe(36 * 16384);
  });
  it("returns null on unparseable text", () => {
    expect(availableBytesFromVmStat("")).toBeNull();
    expect(availableBytesFromVmStat("Pages free: 10.")).toBeNull();
  });
});
