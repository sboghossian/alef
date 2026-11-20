import { describe, expect, it } from "vitest";
import { ageLabel, FEED_STALE_MS, freshness } from "./freshness";

describe("freshness", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("labels the age and goes stale past 3 h, the same threshold Health uses", () => {
    expect(FEED_STALE_MS).toBe(3 * 3_600_000);
    expect(freshness("2026-10-27T11:50:00Z", now)).toEqual({ ageMs: 600_000, label: "10 min ago", stale: false });
    expect(freshness("2026-10-27T09:00:00Z", now).stale).toBe(false);
    expect(freshness("2026-10-27T08:59:00Z", now)).toMatchObject({ label: "3 h ago", stale: true });
    expect(freshness("2026-10-27T13:00:00Z", now)).toMatchObject({ ageMs: 0, stale: false }); // clock skew
  });
  it("treats a missing build time as stale, and takes its own threshold", () => {
    expect(freshness("", now)).toEqual({ ageMs: null, label: "no build time", stale: true });
    expect(freshness("2026-10-27T11:00:00Z", now, 30 * 60_000).stale).toBe(true);
    expect(ageLabel(72 * 3_600_000)).toBe("3 d ago");
  });
});
