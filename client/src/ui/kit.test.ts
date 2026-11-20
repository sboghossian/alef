import { describe, expect, it } from "vitest";
import { ChromeState, COLLAPSE_KEY_PREFIX, markWelcomed, shouldShowWelcome, WELCOME_KEY, wrapFocusIndex, type FlagStore } from "./kit";

const mem = (): FlagStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("wrapFocusIndex", () => {
  it("wraps forward and backward", () => {
    expect(wrapFocusIndex(3, 2, false)).toBe(0);
    expect(wrapFocusIndex(3, 0, true)).toBe(2);
    expect(wrapFocusIndex(3, 1, false)).toBe(2);
  });
  it("enters from outside at the first or last", () => {
    expect(wrapFocusIndex(4, -1, false)).toBe(0);
    expect(wrapFocusIndex(4, -1, true)).toBe(3);
  });
  it("empty list has nothing to focus", () => {
    expect(wrapFocusIndex(0, 0, false)).toBe(-1);
  });
});

describe("welcome flag", () => {
  it("shows once, then never again", () => {
    const s = mem();
    expect(shouldShowWelcome(s)).toBe(true);
    markWelcomed(s);
    expect(s.data.get(WELCOME_KEY)).toBe("1");
    expect(shouldShowWelcome(s)).toBe(false);
  });
  it("never nags when storage is missing or throws", () => {
    expect(shouldShowWelcome(null)).toBe(false);
    const broken: FlagStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(shouldShowWelcome(broken)).toBe(false);
    expect(() => markWelcomed(broken)).not.toThrow();
  });
});

describe("ChromeState (collapsible surfaces)", () => {
  it("restores each surface's remembered state from storage, defaults otherwise", () => {
    const s = mem();
    s.data.set(`${COLLAPSE_KEY_PREFIX}ticker`, "1");
    const c = new ChromeState(s);
    c.register("ticker");
    c.register("districts", true);
    c.register("hud");
    expect(c.isCollapsed("ticker")).toBe(true);
    expect(c.isCollapsed("districts")).toBe(true);
    expect(c.isCollapsed("hud")).toBe(false);
    expect(s.data.has(`${COLLAPSE_KEY_PREFIX}districts`)).toBe(false); // defaults are not written
  });
  it("remembers a user toggle across a reload", () => {
    const s = mem();
    const a = new ChromeState(s);
    a.register("dispatch");
    a.toggle("dispatch");
    expect(s.data.get(`${COLLAPSE_KEY_PREFIX}dispatch`)).toBe("1");
    const b = new ChromeState(s);
    b.register("dispatch");
    expect(b.isCollapsed("dispatch")).toBe(true);
  });
  it("H hides everything, then restores the previous per-surface states", () => {
    const s = mem();
    const c = new ChromeState(s);
    for (const id of ["a", "b", "c"]) c.register(id);
    c.setCollapsed("a", true);
    expect(c.toggleHideAll()).toBe(true);
    expect(["a", "b", "c"].map((id) => c.isCollapsed(id))).toEqual([true, true, true]);
    c.setCollapsed("b", false); // pop one open from its pill while hidden: a one-off
    expect(c.isCollapsed("b")).toBe(false);
    expect(s.data.get(`${COLLAPSE_KEY_PREFIX}b`)).toBeUndefined();
    c.toggleHideAll();
    expect(c.mode).toBe("normal");
    expect(["a", "b", "c"].map((id) => c.isCollapsed(id))).toEqual([true, false, false]);
    c.toggleHideAll();
    expect(c.isCollapsed("b")).toBe(true); // the one-off did not survive
  });
  it("focus and zen force-collapse without overwriting remembered state, and block H", () => {
    const s = mem();
    const c = new ChromeState(s);
    c.register("x");
    c.setMode("focus");
    expect(c.isCollapsed("x")).toBe(true);
    expect(c.toggleHideAll()).toBe(false);
    c.setMode("normal");
    expect(c.isCollapsed("x")).toBe(false);
    expect(s.data.get(`${COLLAPSE_KEY_PREFIX}x`)).toBeUndefined();
  });
  it("non-persisted surfaces never touch storage; broken storage never throws", () => {
    const s = mem();
    const c = new ChromeState(s);
    c.register("approval", false, false);
    c.setCollapsed("approval", true);
    expect(s.data.size).toBe(0);
    const broken: FlagStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const d = new ChromeState(broken);
    expect(() => d.register("y", true)).not.toThrow();
    expect(d.isCollapsed("y")).toBe(true);
    expect(() => d.toggle("y")).not.toThrow();
    expect(d.isCollapsed("y")).toBe(false);
  });
});
