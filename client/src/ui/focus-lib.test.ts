import { describe, expect, it } from "vitest";
import { chromeModeFor, enteredWaiting, focusedAgent, NORMAL, nextView, type ViewState } from "./focus-lib";

describe("focus / zen state machine", () => {
  it("F with a target enters focus; F again or Esc exits", () => {
    const f = nextView(NORMAL, { type: "focus", target: "a1" });
    expect(f).toEqual({ mode: "focus", agentId: "a1" });
    expect(nextView(f, { type: "focus", target: "a1" })).toEqual(NORMAL);
    expect(nextView(f, { type: "focus", target: null })).toEqual(NORMAL);
    expect(nextView(f, { type: "escape" })).toEqual(NORMAL);
  });
  it("F with nothing selected or hovered does nothing", () => {
    expect(nextView(NORMAL, { type: "focus", target: null })).toBe(NORMAL);
  });
  it("F on another agent while focused switches focus", () => {
    const f: ViewState = { mode: "focus", agentId: "a1" };
    expect(nextView(f, { type: "focus", target: "b2" })).toEqual({ mode: "focus", agentId: "b2" });
  });
  it("Esc in normal is not consumed (same object back)", () => {
    expect(nextView(NORMAL, { type: "escape" })).toBe(NORMAL);
  });
  it("zen remembers where it came from and any key returns there", () => {
    const f: ViewState = { mode: "focus", agentId: "a1" };
    const z = nextView(f, { type: "zen" });
    expect(z.mode).toBe("zen");
    expect(focusedAgent(z)).toBe("a1");
    expect(nextView(z, { type: "focus", target: "x" })).toBe(z); // keys other than wake are swallowed
    expect(nextView(z, { type: "wake" })).toEqual(f);
    expect(nextView(nextView(NORMAL, { type: "zen" }), { type: "escape" })).toEqual(NORMAL);
  });
  it("an approval auto-exits zen", () => {
    expect(nextView(nextView(NORMAL, { type: "zen" }), { type: "approval" })).toEqual(NORMAL);
    const f: ViewState = { mode: "focus", agentId: "a1" };
    expect(nextView(f, { type: "approval" })).toBe(f); // focus stays: the card shows it
  });
  it("losing the focused agent drops back to normal", () => {
    const f: ViewState = { mode: "focus", agentId: "a1" };
    expect(nextView(f, { type: "gone", agentId: "zz" })).toBe(f);
    expect(nextView(f, { type: "gone", agentId: "a1" })).toEqual(NORMAL);
  });
  it("maps views to chrome modes, restoring H's hidden state after focus/zen", () => {
    expect(chromeModeFor(NORMAL, false)).toBe("normal");
    expect(chromeModeFor(NORMAL, true)).toBe("hidden");
    expect(chromeModeFor({ mode: "focus", agentId: "a" }, true)).toBe("focus");
    expect(chromeModeFor({ mode: "zen", prev: NORMAL }, false)).toBe("zen");
  });
});

describe("enteredWaiting (focus chime)", () => {
  it("chimes on working/idle → waiting only", () => {
    expect(enteredWaiting("idle", "waiting")).toBe(true);
    expect(enteredWaiting("working", "waiting")).toBe(true);
    expect(enteredWaiting("waiting", "waiting")).toBe(false);
    expect(enteredWaiting(undefined, "waiting")).toBe(false); // first sighting is not a transition
    expect(enteredWaiting("idle", "working")).toBe(false);
  });
});
