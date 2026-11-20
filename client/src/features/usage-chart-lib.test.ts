import { describe, expect, it } from "vitest";
import type { RangeModel } from "../../../shared/features/usage";
import { hourBars, hourLabel, mixSlices, peakHour, ringArcs, shortModel } from "./usage-chart-lib";

const m = (model: string, costUsd: number | null, tokens = 1000): RangeModel => ({ model, costUsd, tokens, unpricedTokens: costUsd === null ? tokens : 0 });

describe("shortModel", () => {
  it("drops the vendor prefix and a date suffix", () => {
    expect(shortModel("claude-opus-4-6-20260101")).toBe("opus-4-6");
    expect(shortModel("claude-sonnet-5-5")).toBe("sonnet-5-5");
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
  });
});

describe("mixSlices", () => {
  it("weights by cost, sorts big first and shares add to 1", () => {
    const s = mixSlices([m("claude-haiku-4-5", 1), m("claude-opus-4-6", 3)]);
    expect(s.map((x) => x.label)).toEqual(["opus-4-6", "haiku-4-5"]);
    expect(s[0]?.share).toBeCloseTo(0.75, 10);
    expect(s.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1, 10);
  });
  it("falls back to tokens when nothing is priced, and drops zero rows", () => {
    const s = mixSlices([m("mystery", null, 300), m("other-mystery", null, 100), m("empty", 0, 0)]);
    expect(s.map((x) => x.label)).toEqual(["mystery", "other-mystery"]);
    expect(s[0]?.share).toBeCloseTo(0.75, 10);
  });
  it("folds everything past 6 slices into one 'other (n)' slice", () => {
    const s = mixSlices(Array.from({ length: 9 }, (_, i) => m(`claude-m${i}`, 10 - i)));
    expect(s).toHaveLength(6);
    expect(s[5]?.label).toBe("other (4)");
    expect(s.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1, 10);
  });
  it("merges ids that shorten to the same label into one slice", () => {
    const s = mixSlices([m("claude-opus-4-6", 2), m("claude-opus-4-6-20260101", 1), m("claude-haiku-4-5", 1)]);
    expect(s.map((x) => x.label)).toEqual(["opus-4-6", "haiku-4-5"]);
    expect(s[0]?.share).toBeCloseTo(0.75, 10);
  });
  it("is empty for no data", () => {
    expect(mixSlices([])).toEqual([]);
  });
});

describe("ringArcs", () => {
  it("draws one path per slice; a lone 100% slice becomes two half rings (an SVG arc cannot span 360)", () => {
    const one = ringArcs(mixSlices([m("a", 5)]), 50, 50, 40);
    expect(one).toHaveLength(1);
    expect(one[0]?.d.match(/M/g)).toHaveLength(2);
    const two = ringArcs(mixSlices([m("a", 5), m("b", 5)]), 50, 50, 40);
    expect(two.every((a) => a.d.startsWith("M") && !a.d.includes("NaN"))).toBe(true);
  });
  it("sets the large-arc flag only past half a turn", () => {
    const [big, small] = ringArcs(mixSlices([m("a", 8), m("b", 2)]), 50, 50, 40);
    expect(big?.d).toContain(" 0 1 1 ");
    expect(small?.d).toContain(" 0 0 1 ");
  });
});

describe("hourBars", () => {
  it("always gives 24 bars scaled to the busiest hour", () => {
    const bars = hourBars([0, 0, 0, 0, 0, 0, 0, 0, 0, 3_600_000, 0, 1_800_000]);
    expect(bars).toHaveLength(24);
    expect(bars[9]?.frac).toBe(1);
    expect(bars[11]?.frac).toBe(0.5);
    expect(peakHour(bars)?.hour).toBe(9);
  });
  it("is all zero with no activity and tolerates short arrays", () => {
    const bars = hourBars([]);
    expect(bars.every((b) => b.frac === 0)).toBe(true);
    expect(peakHour(bars)).toBeNull();
  });
  it("labels hours on a 12 hour clock", () => {
    expect([hourLabel(0), hourLabel(9), hourLabel(12), hourLabel(23)]).toEqual(["12 am", "9 am", "12 pm", "11 pm"]);
  });
});
