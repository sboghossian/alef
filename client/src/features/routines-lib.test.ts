import { describe, expect, it } from "vitest";
import { factorySlots, formatCountdown } from "./routines-lib";

describe("factorySlots", () => {
  it("fills the first ring before starting a second", () => {
    const slots = factorySlots(10);
    expect(slots).toHaveLength(10);
    expect(slots.slice(0, 8).every((s) => s.ring === 0)).toBe(true);
    expect(slots[8]!.ring).toBe(1);
    expect(slots[9]!.ring).toBe(1);
  });

  it("is deterministic for the same count", () => {
    expect(factorySlots(5)).toEqual(factorySlots(5));
  });

  it("handles zero routines", () => {
    expect(factorySlots(0)).toEqual([]);
  });
});

describe("formatCountdown", () => {
  const now = Date.parse("2026-09-24T10:00:00.000Z");

  it("formats minutes only", () => {
    expect(formatCountdown(new Date(now + 45 * 60_000).toISOString(), now)).toBe("in 45m");
  });

  it("formats hours and minutes", () => {
    expect(formatCountdown(new Date(now + 3 * 3600_000 + 12 * 60_000).toISOString(), now)).toBe("in 3h 12m");
  });

  it("formats an exact hour with no minutes remainder", () => {
    expect(formatCountdown(new Date(now + 2 * 3600_000).toISOString(), now)).toBe("in 2h");
  });

  it("returns 'due now' for the past or the next few seconds", () => {
    expect(formatCountdown(new Date(now - 1000).toISOString(), now)).toBe("due now");
    expect(formatCountdown(new Date(now + 10_000).toISOString(), now)).toBe("due now");
  });

  it("returns an em dash for no known schedule", () => {
    expect(formatCountdown(null, now)).toBe("—");
  });
});
