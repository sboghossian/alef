import { describe, expect, it } from "vitest";
import {
  ageLabel,
  feedStamp,
  arcBand,
  area,
  band,
  bands,
  bars,
  bucketTotals,
  calendar,
  chord,
  delta,
  DOW,
  grid,
  heat,
  int,
  monthLabel,
  monthLabels,
  niceMax,
  pct,
  scatter,
  share,
  since,
  spark,
  stream,
  treemap,
} from "./vault-lib";

const S = (parts: readonly number[]) => ({ parts });

describe("niceMax", () => {
  it("rounds up to the next readable step", () => {
    expect(niceMax(37)).toBe(50);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(1000)).toBe(1000);
  });

  it("never returns zero, so nothing divides by it", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe("band", () => {
  it("splits the width into equal slots", () => {
    expect(band(0, 4, 100)).toEqual({ x: 0, y: 0, w: 25, h: 0 });
    expect(band(3, 4, 100)).toEqual({ x: 75, y: 0, w: 25, h: 0 });
  });

  it("insets by the gap on both sides", () => {
    expect(band(0, 4, 100, 2)).toEqual({ x: 2, y: 0, w: 21, h: 0 });
  });

  it("never returns a negative width, however big the gap", () => {
    expect(band(0, 4, 100, 50).w).toBe(0);
  });

  it("is harmless with no buckets", () => {
    expect(band(0, 0, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("bucketTotals", () => {
  it("sums across series and treats a short series as zeros", () => {
    expect(bucketTotals([S([1, 2, 3]), S([10])], 3)).toEqual([11, 2, 3]);
  });

  it("returns zeros for no series", () => {
    expect(bucketTotals([], 3)).toEqual([0, 0, 0]);
  });
});

describe("bars", () => {
  it("stacks first series at the bottom and scales to a nice max", () => {
    const { bars: out, max } = bars([S([5]), S([5])], 1, 10, 100);
    expect(max).toBe(10);
    const bottom = out.find((b) => b.s === 0);
    const top = out.find((b) => b.s === 1);
    expect(bottom).toMatchObject({ y: 50, h: 50 });
    expect(top).toMatchObject({ y: 0, h: 50 });
  });

  it("honours an explicit max so two charts can share an axis", () => {
    const { bars: out, max } = bars([S([5])], 1, 10, 100, { max: 20 });
    expect(max).toBe(20);
    expect(out[0]?.h).toBe(25);
  });

  it("skips zero and negative values rather than drawing nothing", () => {
    expect(bars([S([0, -3, 2])], 3, 30, 10).bars.map((b) => b.i)).toEqual([2]);
  });

  it("returns no bars for an empty chart", () => {
    expect(bars([], 0, 10, 10).bars).toEqual([]);
    expect(bars([S([])], 3, 10, 10).bars).toEqual([]);
  });
});

describe("share", () => {
  it("fills the full height whatever the bucket total", () => {
    const out = share([S([1, 10]), S([3, 30])], 2, 20, 100);
    const first = out.filter((b) => b.i === 0);
    const second = out.filter((b) => b.i === 1);
    expect(first.reduce((a, b) => a + b.h, 0)).toBeCloseTo(100);
    expect(second.reduce((a, b) => a + b.h, 0)).toBeCloseTo(100);
    // Same 1:3 split in both buckets even though the second is ten times bigger.
    expect(first.find((b) => b.s === 0)?.h).toBeCloseTo(25);
    expect(second.find((b) => b.s === 0)?.h).toBeCloseTo(25);
  });

  it("leaves an empty bucket empty instead of dividing by zero", () => {
    expect(share([S([0, 4])], 2, 20, 100).map((b) => b.i)).toEqual([1]);
  });
});

describe("area", () => {
  it("returns one closed path per series", () => {
    const { paths, max } = area([S([1, 2]), S([1, 1])], 2, 100, 100);
    expect(paths).toHaveLength(2);
    expect(max).toBe(5);
    for (const p of paths) {
      expect(p.startsWith("M")).toBe(true);
      expect(p.endsWith("Z")).toBe(true);
    }
  });

  it("puts the first series on the floor", () => {
    const { paths } = area([S([2, 2])], 2, 100, 100, { max: 4 });
    // Floor at y=100, top of a half-height band at y=50.
    expect(paths[0]).toContain("M0.00 50.00");
    expect(paths[0]).toContain("L0.00 100.00");
  });

  it("is empty with no buckets", () => {
    expect(area([S([])], 0, 100, 100).paths).toEqual([""]);
  });
});

describe("stream", () => {
  it("centres each bucket's stack", () => {
    // One series of 2 against a max of 2: it fills the height, centred means flush.
    const { paths, max } = stream([S([2, 2])], 2, 100, 100);
    expect(max).toBe(2);
    expect(paths[0]).toContain("M0.00 0.00");
  });

  it("insets a thin bucket equally top and bottom", () => {
    const { paths } = stream([S([2, 1])], 2, 100, 100);
    // Bucket 1 holds 1 of a 2 max, so it occupies the middle half: y 25..75.
    expect(paths[0]).toContain("L100.00 25.00");
  });

  it("never divides by zero on an all-empty stream", () => {
    const { paths, max } = stream([S([0, 0])], 2, 100, 100);
    expect(max).toBe(1);
    expect(paths).toHaveLength(1);
  });
});

describe("spark", () => {
  it("draws an open line scaled to its own range", () => {
    expect(spark([0, 10], 100, 20)).toBe("M0.00 20.00L100.00 0.00");
  });

  it("sits flat in the middle when nothing varies", () => {
    expect(spark([5, 5, 5], 100, 20)).toBe("M0.00 10.00L50.00 10.00L100.00 10.00");
  });

  it("handles one point and none", () => {
    expect(spark([3], 100, 20)).toBe("M0.00 10.00");
    expect(spark([], 100, 20)).toBe("");
  });
});

describe("heat", () => {
  it("gives nothing to zero and one visible step to the smallest count", () => {
    expect(heat(0, 10)).toBe(0);
    expect(heat(1, 10)).toBe(1);
  });

  it("tops out at four", () => {
    expect(heat(10, 10)).toBe(4);
    expect(heat(99, 10)).toBe(4);
  });

  it("does not divide by a zero max", () => {
    expect(heat(3, 0)).toBe(1);
  });

  it("is log-scaled, so one huge day does not flatten the rest", () => {
    // A usual 100-note day against a 7,000-note import still reads as busy.
    expect(heat(100, 7000)).toBeGreaterThanOrEqual(3);
    expect(heat(5, 7000)).toBe(1);
  });
});

describe("calendar", () => {
  // 2026-10-26 is a Monday, so it sits in row 0 of the last column.
  const today = Math.floor(Date.parse("2026-10-26T00:00:00Z") / 86_400_000);

  it("puts today in row 0 of the last column on a Monday", () => {
    const cells = calendar(new Map([[today, 3]]), today, 53);
    const cell = cells.find((c) => c.key === today);
    expect(cell).toMatchObject({ col: 52, row: 0, n: 3 });
  });

  it("never emits a day after today", () => {
    const cells = calendar(new Map(), today, 4);
    expect(Math.max(...cells.map((c) => c.key))).toBe(today);
  });

  it("covers the requested number of weeks", () => {
    const cells = calendar(new Map(), today, 4);
    expect(new Set(cells.map((c) => c.col)).size).toBe(4);
    // Four weeks ending on a Monday: three full weeks plus today.
    expect(cells).toHaveLength(3 * 7 + 1);
  });

  it("gives every day heat 0 when the year is empty", () => {
    expect(calendar(new Map(), today, 2).every((c) => c.heat === 0)).toBe(true);
  });

  it("scales heat against the busiest day in the window only", () => {
    const cells = calendar(new Map([[today, 1], [today - 1, 8]]), today, 2);
    expect(cells.find((c) => c.key === today - 1)?.heat).toBe(4);
    expect(cells.find((c) => c.key === today)?.heat).toBe(1);
  });
});

describe("grid", () => {
  it("reads the server's row-major counts into 7 rows of hours", () => {
    // Two hours (9 and 10), seven weekdays: Monday 09:00 = 4.
    const counts = new Array<number>(14).fill(0);
    counts[0] = 4;
    const cells = grid(counts, 9, 10);
    expect(cells).toHaveLength(14);
    expect(cells.find((c) => c.row === 0 && c.col === 0)).toMatchObject({ key: 9, n: 4, heat: 4 });
    expect(cells.find((c) => c.row === 0 && c.col === 1)).toMatchObject({ key: 10, n: 0, heat: 0 });
  });

  it("is empty when the hour range is inverted", () => {
    expect(grid([], 10, 9)).toEqual([]);
  });
});

describe("scatter", () => {
  const items = [
    { key: "a", daysSince: 0, total: 100, n90: 40 },
    { key: "b", daysSince: 365, total: 1, n90: 0 },
  ];

  it("puts the freshest name at the left edge and the biggest total at the top", () => {
    const dots = scatter(items, 100, 100);
    const a = dots.find((d) => d.key === "a");
    expect(a?.x).toBeCloseTo(0);
    expect(a?.y).toBeCloseTo(0);
  });

  it("parks a never-seen name at the right edge", () => {
    const dots = scatter([{ key: "x", daysSince: null, total: 1, n90: 0 }], 100, 100, { maxDays: 365 });
    expect(dots[0]?.x).toBeCloseTo(100);
  });

  it("sizes by area, so the quiet name gets the floor radius", () => {
    const dots = scatter(items, 100, 100, { rMin: 2, rMax: 10 });
    expect(dots.find((d) => d.key === "b")?.r).toBeCloseTo(2);
    expect(dots.find((d) => d.key === "a")?.r).toBeCloseTo(10);
  });

  it("survives an empty list and an all-zero one", () => {
    expect(scatter([], 100, 100)).toEqual([]);
    const dots = scatter([{ key: "z", daysSince: 0, total: 0, n90: 0 }], 100, 100);
    expect(Number.isFinite(dots[0]?.x ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(dots[0]?.y ?? Number.NaN)).toBe(true);
  });
});

describe("bands", () => {
  const flows = [
    { from: "claude-code", to: "acme", n: 30 },
    { from: "claude-code", to: "side", n: 10 },
    { from: "chatgpt", to: "acme", n: 10 },
  ];

  it("lays both columns out tallest first", () => {
    const { left, right } = bands(flows, 100, 100, { pad: 0 });
    expect(left.map((l) => l.key)).toEqual(["claude-code", "chatgpt"]);
    expect(right.map((r) => r.key)).toEqual(["acme", "side"]);
  });

  it("gives each column box a height proportional to its flow", () => {
    const { left } = bands(flows, 100, 100, { pad: 0 });
    expect(left.find((l) => l.key === "claude-code")?.h).toBeCloseTo(80);
    expect(left.find((l) => l.key === "chatgpt")?.h).toBeCloseTo(20);
  });

  it("draws one closed cubic per flow", () => {
    const { bands: out } = bands(flows, 100, 100, { pad: 0 });
    expect(out).toHaveLength(3);
    for (const b of out) {
      expect(b.path.startsWith("M0 ")).toBe(true);
      expect(b.path.endsWith("Z")).toBe(true);
      expect(b.path).toContain("C");
    }
  });

  it("orders bands thickest first so the big flows read", () => {
    expect(bands(flows, 100, 100).bands.map((b) => b.n)).toEqual([30, 10, 10]);
  });

  it("returns nothing for no flows", () => {
    const { bands: out, left, right } = bands([], 100, 100);
    expect(out).toEqual([]);
    expect(left).toEqual([]);
    expect(right).toEqual([]);
  });
});

describe("formatting", () => {
  it("groups thousands", () => {
    expect(int(32438)).toBe("32,438");
    expect(int(7)).toBe("7");
  });

  it("shows a whole percent and an em dash for nonsense", () => {
    expect(pct(0.254)).toBe("25%");
    expect(pct(1)).toBe("100%");
    expect(pct(Number.NaN)).toBe("—");
  });

  it("signs a delta and names a flat one", () => {
    expect(delta(10, 4)).toEqual({ text: "↑ 6", dir: "up" });
    expect(delta(4, 10)).toEqual({ text: "↓ 6", dir: "down" });
    expect(delta(5, 5)).toEqual({ text: "level", dir: "flat" });
  });

  it("says how long ago in the words the cards use", () => {
    expect(since(null, 100)).toBe("never");
    expect(since(100, 100)).toBe("today");
    expect(since(99, 100)).toBe("yesterday");
    expect(since(95, 100)).toBe("5d ago");
    expect(since(40, 100)).toBe("2mo ago");
    expect(since(100 - 400, 100)).toBe("1y ago");
    expect(since(100 - 1000, 100)).toBe("3y ago");
  });

  it("labels a month, adding the year only where it turns over", () => {
    expect(monthLabel("2026-10")).toBe("Oct");
    expect(monthLabel("2026-10", true)).toBe("Oct 26");
    expect(monthLabels(["2025-11", "2025-12", "2026-01", "2026-02"])).toEqual(["Nov 25", "Dec", "Jan 26", "Feb"]);
  });

  it("starts the week on Monday, matching the server", () => {
    expect(DOW[0]).toBe("Mon");
    expect(DOW).toHaveLength(7);
  });
});

describe("treemap", () => {
  it("tiles the whole box, with areas in proportion to the values", () => {
    const vals = [6, 6, 4, 3, 2, 2, 1];
    const rects = treemap(vals, 60, 40);
    const total = vals.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(r.w * r.h).toBeCloseTo(((vals[i] ?? 0) / total) * 60 * 40, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(60 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(40 + 1e-9);
    });
  });

  it("keeps cells squarish rather than slivers", () => {
    const rects = treemap([1, 1, 1, 1], 100, 100);
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(1.01);
  });

  it("gives zero values an empty cell and survives an empty box", () => {
    expect(treemap([0, 5], 10, 10)[0]).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(treemap([], 10, 10)).toEqual([]);
    expect(treemap([3], 0, 10)[0]?.w).toBe(0);
  });
});

describe("chord", () => {
  it("sizes arcs by cross links and draws one ribbon per linked pair", () => {
    const m = [
      [5, 3, 0],
      [1, 0, 0],
      [0, 0, 9],
    ];
    const c = chord(m, 200, 80, 0);
    expect(c.arcs[2]).toBeNull(); // only self links: no arc
    const a0 = c.arcs[0];
    const a1 = c.arcs[1];
    expect(a0 && a1).toBeTruthy();
    if (a0 && a1) {
      expect(a0[1] - a0[0]).toBeCloseTo(Math.PI); // 4 of 8 cross links each side
      expect(a1[1] - a1[0]).toBeCloseTo(Math.PI);
    }
    expect(c.ribbons).toHaveLength(1);
    expect(c.ribbons[0]).toMatchObject({ i: 0, j: 1, n: 4 });
    expect(c.ribbons[0]?.path.startsWith("M")).toBe(true);
  });

  it("has nothing to draw when no link crosses groups", () => {
    expect(chord([[3]], 100, 40)).toEqual({ arcs: [null], ribbons: [] });
  });

  it("arcBand closes its shape", () => {
    expect(arcBand(100, 0, 1, 40, 50).endsWith("Z")).toBe(true);
  });
});

describe("feedStamp", () => {
  const now = Date.parse("2026-10-27T03:00:00Z");
  const meta = { ready: true, generatedAt: "2026-10-27T02:20:00Z", notes: 32452, links: 90000 };

  it("says how live the feed is, with its counts", () => {
    expect(feedStamp(meta, now)).toEqual({
      text: "Live vault · 32,452 notes · 90,000 links · feed built 40 min ago (2026-10-27 02:20 UTC)",
      stale: false,
    });
  });

  it("goes stale past 3 hours, and when the build time is missing", () => {
    expect(feedStamp({ ...meta, generatedAt: "2026-10-26T23:59:00Z" }, now).stale).toBe(true);
    expect(feedStamp({ ...meta, generatedAt: "" }, now).stale).toBe(true);
  });

  it("is a loading line until the first parse lands", () => {
    expect(feedStamp(null, now).stale).toBe(false);
    expect(feedStamp({ ...meta, ready: false }, now).text).toMatch(/Reading/);
  });

  it("names ages in the largest whole unit", () => {
    expect(ageLabel(30_000)).toBe("just now");
    expect(ageLabel(47 * 3_600_000)).toBe("47 h ago");
    expect(ageLabel(72 * 3_600_000)).toBe("3 d ago");
  });
});
