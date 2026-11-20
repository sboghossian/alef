import { describe, expect, it } from "vitest";
import { ambientGains, newlyAwaiting } from "./sound-lib";

describe("newlyAwaiting", () => {
  it("returns only agents that are awaiting now and weren't before", () => {
    const prev = new Set(["a"]);
    const agents = [
      { id: "a", awaitingInput: true }, // already known, no ding
      { id: "b", awaitingInput: true }, // new — ding
      { id: "c", awaitingInput: false }, // not awaiting, no ding
    ];
    expect(newlyAwaiting(prev, agents)).toEqual(["b"]);
  });

  it("returns nothing when nobody is newly awaiting", () => {
    expect(newlyAwaiting(new Set(), [])).toEqual([]);
    expect(newlyAwaiting(new Set(["a"]), [{ id: "a", awaitingInput: true }])).toEqual([]);
  });
});

describe("ambientGains", () => {
  it("is silent (no rain layer) in clear weather", () => {
    expect(ambientGains("clear", 0).rain).toBe(0);
  });

  it("adds a rain layer for rain, louder for storm", () => {
    const rain = ambientGains("rain", 50).rain;
    const storm = ambientGains("storm", 50).rain;
    expect(rain).toBeGreaterThan(0);
    expect(storm).toBeGreaterThan(rain);
  });

  it("wind rises gently with cloud cover but always stays low", () => {
    const clear = ambientGains("clear", 0).wind;
    const overcast = ambientGains("cloudy", 100).wind;
    expect(overcast).toBeGreaterThan(clear);
    expect(overcast).toBeLessThan(0.3);
  });

  it("treats a null kind/cloud cover as calm", () => {
    expect(ambientGains(null, null)).toEqual({ wind: 0.04, rain: 0 });
  });
});
