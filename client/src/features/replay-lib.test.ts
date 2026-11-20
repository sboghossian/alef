import { describe, expect, it } from "vitest";
import { bucketByHour, heatIntensity, localDateKey, replayLoadState, replayStatusText } from "./replay-lib";

describe("localDateKey", () => {
  it("pads month and day", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("matches a two-digit month/day date without padding needed", () => {
    expect(localDateKey(new Date(2026, 8, 24))).toBe("2026-09-24");
  });
});

describe("bucketByHour", () => {
  it("counts events into their local hour", () => {
    const events = [
      { at: new Date(2026, 8, 24, 8, 5).toISOString() },
      { at: new Date(2026, 8, 24, 8, 45).toISOString() },
      { at: new Date(2026, 8, 24, 14, 0).toISOString() },
    ];
    const buckets = bucketByHour(events);
    expect(buckets).toHaveLength(24);
    expect(buckets[8]).toBe(2);
    expect(buckets[14]).toBe(1);
    expect(buckets[0]).toBe(0);
  });

  it("returns all zeros for no events", () => {
    expect(bucketByHour([])).toEqual(new Array(24).fill(0));
  });
});

describe("heatIntensity", () => {
  it("is 0 for no events or no max", () => {
    expect(heatIntensity(0, 10)).toBe(0);
    expect(heatIntensity(5, 0)).toBe(0);
  });

  it("is 1 at the max and curved (sqrt) below it", () => {
    expect(heatIntensity(10, 10)).toBe(1);
    expect(heatIntensity(5, 10)).toBeCloseTo(Math.sqrt(0.5), 10);
  });
});

describe("replayLoadState / replayStatusText", () => {
  it("a null response (getJson's failure signal) is 'error', never mistaken for a quiet day", () => {
    const state = replayLoadState(false, "2026-09-24", null);
    expect(state).toEqual({ kind: "error", date: "2026-09-24" });
    expect(replayStatusText(state)).toBe("Couldn't load 2026-09-24: the server didn't answer.");
  });

  it("a real response with zero events is 'empty', with its own distinct wording", () => {
    const state = replayLoadState(false, "2026-09-24", { events: [], truncated: false });
    expect(state).toEqual({ kind: "empty" });
    expect(replayStatusText(state)).toBe("No activity that day.");
  });

  it("a response with events reports the count and whether it was sampled", () => {
    const state = replayLoadState(false, "2026-09-24", { events: [1, 2, 3], truncated: true });
    expect(state).toEqual({ kind: "events", count: 3, sampled: true });
    expect(replayStatusText(state)).toBe("3 events (sampled)");
    expect(replayStatusText(replayLoadState(false, "2026-09-24", { events: [1], truncated: false }))).toBe("1 events");
  });

  it("loading wins over a stale null/empty response so a fetch-in-flight never flashes an error", () => {
    expect(replayLoadState(true, "2026-09-24", null)).toEqual({ kind: "loading" });
    expect(replayStatusText({ kind: "loading" })).toBe("Loading…");
  });
});
