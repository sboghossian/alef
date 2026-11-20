import { describe, expect, it } from "vitest";
import { INITIAL_HYSTERESIS, flyDuration, overshootEase, pixelRatioFor, resolveTier, stepHysteresis, type HysteresisState } from "./quality-lib";

describe("flyDuration", () => {
  it("floors at 0.6s for a near-zero arc (short hop)", () => {
    expect(flyDuration(0)).toBeCloseTo(0.6, 5);
  });

  it("caps at 1.5s for a half-planet arc (π)", () => {
    expect(flyDuration(Math.PI)).toBeCloseTo(1.5, 5);
  });

  it("scales linearly in between", () => {
    expect(flyDuration(Math.PI / 2)).toBeCloseTo(1.05, 5);
  });

  it("clamps out-of-range input instead of over/undershooting", () => {
    expect(flyDuration(-1)).toBe(0.6);
    expect(flyDuration(10)).toBe(1.5);
  });
});

describe("overshootEase", () => {
  it("starts at 0 and ends exactly at 1 (settles on arrival)", () => {
    expect(overshootEase(0)).toBeCloseTo(0, 6);
    expect(overshootEase(1)).toBe(1);
  });

  it("overshoots by about 6% before settling", () => {
    let max = 0;
    for (let i = 0; i <= 200; i++) max = Math.max(max, overshootEase(i / 200));
    expect(max).toBeGreaterThan(1.05);
    expect(max).toBeLessThan(1.07);
  });

  it("is monotonic-ish near the end (no double bounce)", () => {
    expect(overshootEase(0.95)).toBeGreaterThan(overshootEase(1));
  });
});

describe("stepHysteresis", () => {
  const allow = { allowStepDown: true };

  it("does not step down on a brief dip under 3s", () => {
    let s = stepHysteresis(INITIAL_HYSTERESIS, 20, 0, allow);
    s = stepHysteresis(s, 20, 1000, allow);
    expect(s.tier).toBe(0);
  });

  it("steps down one tier after 3s sustained under 40fps", () => {
    let s = stepHysteresis(INITIAL_HYSTERESIS, 20, 0, allow);
    s = stepHysteresis(s, 20, 3000, allow);
    expect(s.tier).toBe(1);
  });

  it("steps down at most one tier per sustained window, not straight to the floor", () => {
    let s = stepHysteresis(INITIAL_HYSTERESIS, 10, 0, allow);
    s = stepHysteresis(s, 10, 3000, allow);
    expect(s.tier).toBe(1);
    s = stepHysteresis(s, 10, 4000, allow);
    expect(s.tier).toBe(1); // needs another 3s from THIS low-streak before dropping to 2
    s = stepHysteresis(s, 10, 7000, allow);
    expect(s.tier).toBe(2);
  });

  it("never steps down past tier 2", () => {
    let s: HysteresisState = { tier: 2, lowSince: null, highSince: null };
    s = stepHysteresis(s, 5, 0, allow);
    s = stepHysteresis(s, 5, 5000, allow);
    expect(s.tier).toBe(2);
  });

  it("a mid-range fps (the 40-55 dead zone) resets progress instead of banking it", () => {
    let s = stepHysteresis(INITIAL_HYSTERESIS, 20, 0, allow);
    s = stepHysteresis(s, 45, 1000, allow); // back to the dead zone before 3s is up
    s = stepHysteresis(s, 20, 1500, allow);
    s = stepHysteresis(s, 20, 4000, allow); // only 2.5s since the reset
    expect(s.tier).toBe(0);
  });

  it("steps up one tier after 10s sustained over 55fps", () => {
    let s: HysteresisState = { tier: 2, lowSince: null, highSince: null };
    s = stepHysteresis(s, 60, 0, allow);
    s = stepHysteresis(s, 60, 10000, allow);
    expect(s.tier).toBe(1);
  });

  it("never steps down when allowStepDown is false (?perf=headless)", () => {
    let s = stepHysteresis(INITIAL_HYSTERESIS, 5, 0, { allowStepDown: false });
    s = stepHysteresis(s, 5, 60000, { allowStepDown: false });
    expect(s.tier).toBe(0);
  });

  it("can still step up when allowStepDown is false", () => {
    let s: HysteresisState = { tier: 2, lowSince: null, highSince: null };
    s = stepHysteresis(s, 60, 0, { allowStepDown: false });
    s = stepHysteresis(s, 60, 10000, { allowStepDown: false });
    expect(s.tier).toBe(1);
  });
});

describe("resolveTier", () => {
  it("passes through a fixed mode", () => {
    expect(resolveTier(2, 0)).toBe(2);
  });

  it("defers to the hysteresis tier in auto mode", () => {
    expect(resolveTier("auto", 1)).toBe(1);
  });
});

describe("pixelRatioFor", () => {
  it("caps tier 0 at 2x even on a high-dpr display", () => {
    expect(pixelRatioFor(0, 3)).toBe(2);
    expect(pixelRatioFor(0, 1)).toBe(1);
  });

  it("flattens tier 1 to 1.5x regardless of dpr", () => {
    expect(pixelRatioFor(1, 3)).toBe(1.5);
  });

  it("drops tier 2 to 1x", () => {
    expect(pixelRatioFor(2, 3)).toBe(1);
  });
});
