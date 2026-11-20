import { describe, expect, it } from "vitest";
import type { FlagStore } from "../../ui/kit";
import {
  DEFAULT_FM_VOLUME,
  duckMultiplier,
  effectiveVolume,
  FM_MUTED_KEY,
  FM_VOLUME_KEY,
  FM_WAS_PLAYING_KEY,
  isFmToggleKey,
  loadFmState,
  popoverBottomOffset,
  saveFmMuted,
  saveFmVolume,
  saveFmWasPlaying,
} from "./claude-fm-logic";

function memoryStore(initial: Record<string, string> = {}): FlagStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function throwingStore(): FlagStore {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
}

describe("loadFmState", () => {
  it("defaults to the default volume, unmuted, not previously playing", () => {
    expect(loadFmState(memoryStore())).toEqual({ volume: DEFAULT_FM_VOLUME, muted: false, wasPlaying: false });
  });

  it("reads back a saved state", () => {
    const store = memoryStore({ [FM_VOLUME_KEY]: "42", [FM_MUTED_KEY]: "1", [FM_WAS_PLAYING_KEY]: "1" });
    expect(loadFmState(store)).toEqual({ volume: 42, muted: true, wasPlaying: true });
  });

  it("clamps a corrupt or out-of-range volume instead of trusting it", () => {
    expect(loadFmState(memoryStore({ [FM_VOLUME_KEY]: "not-a-number" })).volume).toBe(DEFAULT_FM_VOLUME);
    expect(loadFmState(memoryStore({ [FM_VOLUME_KEY]: "999" })).volume).toBe(100);
    expect(loadFmState(memoryStore({ [FM_VOLUME_KEY]: "-5" })).volume).toBe(0);
  });

  it("treats a null store (SSR/tests) and a throwing store the same as a first visit", () => {
    expect(loadFmState(null)).toEqual({ volume: DEFAULT_FM_VOLUME, muted: false, wasPlaying: false });
    expect(loadFmState(throwingStore())).toEqual({ volume: DEFAULT_FM_VOLUME, muted: false, wasPlaying: false });
  });
});

describe("save*", () => {
  it("round-trips volume, muted and wasPlaying through a real-shaped store", () => {
    const store = memoryStore();
    saveFmVolume(store, 77);
    saveFmMuted(store, true);
    saveFmWasPlaying(store, true);
    expect(loadFmState(store)).toEqual({ volume: 77, muted: true, wasPlaying: true });
  });

  it("clamps and rounds whatever volume it's given before saving", () => {
    const store = memoryStore();
    saveFmVolume(store, 250.6);
    expect(loadFmState(store).volume).toBe(100);
  });

  it("never throws against a store that rejects every call", () => {
    const store = throwingStore();
    expect(() => saveFmVolume(store, 50)).not.toThrow();
    expect(() => saveFmMuted(store, true)).not.toThrow();
    expect(() => saveFmWasPlaying(store, true)).not.toThrow();
  });
});

describe("duckMultiplier / effectiveVolume", () => {
  it("is full volume when nothing is ducking it", () => {
    expect(duckMultiplier(false)).toBe(1);
  });

  it("drops to 30% while ducking", () => {
    expect(duckMultiplier(true)).toBe(0.3);
  });

  it("computes the volume actually sent to the player", () => {
    expect(effectiveVolume({ volume: 60, muted: false }, false)).toBe(60);
    expect(effectiveVolume({ volume: 60, muted: false }, true)).toBe(18);
  });

  it("is silent when muted, ducking or not", () => {
    expect(effectiveVolume({ volume: 80, muted: true }, false)).toBe(0);
    expect(effectiveVolume({ volume: 80, muted: true }, true)).toBe(0);
  });

  it("restores exactly the prior volume once ducking ends", () => {
    const state = { volume: 55, muted: false };
    const ducked = effectiveVolume(state, true);
    const restored = effectiveVolume(state, false);
    expect(ducked).toBeLessThan(restored);
    expect(restored).toBe(55);
  });
});

describe("isFmToggleKey", () => {
  const base = { key: "m", metaKey: false, ctrlKey: false, altKey: false, isTyping: false, overlayOpen: false };

  it("fires on a bare m or M", () => {
    expect(isFmToggleKey(base)).toBe(true);
    expect(isFmToggleKey({ ...base, key: "M" })).toBe(true);
  });

  it("ignores every other key", () => {
    expect(isFmToggleKey({ ...base, key: "n" })).toBe(false);
    expect(isFmToggleKey({ ...base, key: " " })).toBe(false);
  });

  it("is ignored while typing in an input", () => {
    expect(isFmToggleKey({ ...base, isTyping: true })).toBe(false);
  });

  it("is ignored while an overlay (palette/help/dialog) owns the keyboard", () => {
    expect(isFmToggleKey({ ...base, overlayOpen: true })).toBe(false);
  });

  it("is ignored with any modifier held (so cmd+m / ctrl+m never fire it)", () => {
    expect(isFmToggleKey({ ...base, metaKey: true })).toBe(false);
    expect(isFmToggleKey({ ...base, ctrlKey: true })).toBe(false);
    expect(isFmToggleKey({ ...base, altKey: true })).toBe(false);
  });
});

describe("popoverBottomOffset", () => {
  it("clears the status bar alone when there's no prompt box open (round 9's old, buggy behavior as a floor)", () => {
    // status bar 34px, no prompt box, button top 34px from the bottom: both distances agree.
    expect(popoverBottomOffset(34, 34)).toBe(42);
  });

  it("clears the taller of the shell chrome and the button's own top — the round 9 fix", () => {
    // Status bar (34) + an expanded multi-line prompt box (60) = 94px of chrome the button's
    // own top (34, since the button sits inside the status bar) does not account for.
    expect(popoverBottomOffset(34 + 60, 34)).toBe(94 + 8);
  });

  it("falls back to the button-relative distance if the shell vars ever read as 0", () => {
    expect(popoverBottomOffset(0, 50)).toBe(58);
  });

  it("takes an explicit gap", () => {
    expect(popoverBottomOffset(100, 40, 20)).toBe(120);
  });
});
