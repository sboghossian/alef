import { describe, expect, it } from "vitest";
import { TOUR_IDLE, TOUR_STEPS, STEP_SECONDS, parseTourMemory, recoverStuckTour, shouldAutoStart, stepCounter, tourReducer } from "./tour-lib";

describe("tour steps", () => {
  it("about ten steps, about two minutes, unique ids, every caption plain and non-empty", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(9);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(11);
    expect(TOUR_STEPS.length * STEP_SECONDS).toBeGreaterThanOrEqual(100);
    expect(TOUR_STEPS.length * STEP_SECONDS).toBeLessThanOrEqual(140);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.caption.length).toBeGreaterThan(40);
      expect(s.caption.length).toBeLessThan(260);
    }
  });

  it("visits every system place in route order: gates → Jev tower → plants → the semantic library", () => {
    const places = TOUR_STEPS.flatMap((s) => (s.target.kind === "place" ? [s.target.id] : []));
    expect(places).toEqual(["gate:UserPromptSubmit", "jev", "plant:opus", "semantic"]);
    expect(TOUR_STEPS[0]?.target.kind).toBe("overview");
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]?.target.kind).toBe("moon");
    expect(TOUR_STEPS.some((s) => s.target.kind === "routines")).toBe(true);
    expect(TOUR_STEPS.some((s) => s.target.kind === "harness")).toBe(true);
  });

  it("the memory stop is the Institute of Truth, never the School", () => {
    const memory = TOUR_STEPS.find((s) => s.target.kind === "place" && s.target.id === "semantic");
    expect(memory?.title).toBe("The Institute of Truth");
    expect(memory?.caption).toMatch(/second brain/);
    for (const s of TOUR_STEPS) expect(`${s.title} ${s.caption}`).not.toMatch(/\bschool\b/i);
  });

  it("never says Jev moves agents: a plane is a live agent's own edit in another district", () => {
    for (const s of TOUR_STEPS) expect(s.caption).not.toMatch(/nudge|visit each other/i);
  });
});

describe("tour state machine", () => {
  it("start → next … → finish on the last Next", () => {
    let s = tourReducer(TOUR_IDLE, { type: "start" });
    expect(s).toEqual({ active: true, index: 0 });
    for (let i = 1; i < TOUR_STEPS.length; i++) {
      s = tourReducer(s, { type: "next" });
      expect(s).toEqual({ active: true, index: i });
    }
    expect(tourReducer(s, { type: "next" })).toEqual(TOUR_IDLE);
  });

  it("Back stops at the first step; Skip and Esc leave from anywhere", () => {
    const s = tourReducer(TOUR_IDLE, { type: "start" });
    expect(tourReducer(s, { type: "back" })).toEqual({ active: true, index: 0 });
    const mid = { active: true, index: 4 };
    expect(tourReducer(mid, { type: "back" })).toEqual({ active: true, index: 3 });
    expect(tourReducer(mid, { type: "skip" })).toEqual(TOUR_IDLE);
    expect(tourReducer(mid, { type: "escape" })).toEqual(TOUR_IDLE);
  });

  it("next / back / goto do nothing while idle; goto clamps and rejects junk", () => {
    expect(tourReducer(TOUR_IDLE, { type: "next" })).toEqual(TOUR_IDLE);
    expect(tourReducer(TOUR_IDLE, { type: "back" })).toEqual(TOUR_IDLE);
    expect(tourReducer(TOUR_IDLE, { type: "goto", index: 3 })).toEqual(TOUR_IDLE);
    const s = { active: true, index: 2 };
    expect(tourReducer(s, { type: "goto", index: 99 })).toEqual({ active: true, index: TOUR_STEPS.length - 1 });
    expect(tourReducer(s, { type: "goto", index: -5 })).toEqual({ active: true, index: 0 });
    expect(tourReducer(s, { type: "goto", index: 1.5 })).toEqual(s);
  });

  it("restart after finishing begins at step 1 again (replayable)", () => {
    expect(tourReducer({ active: true, index: 7 }, { type: "start" })).toEqual({ active: true, index: 0 });
  });

  it("an empty step list is always idle", () => {
    expect(tourReducer(TOUR_IDLE, { type: "start" }, 0)).toEqual(TOUR_IDLE);
  });

  it("step counter", () => {
    expect(stepCounter(0)).toBe(`Step 1 of ${TOUR_STEPS.length}`);
    expect(stepCounter(2, 10)).toBe("Step 3 of 10");
    expect(stepCounter(40, 10)).toBe("Step 10 of 10");
  });
});

describe("remembering the tour", () => {
  it("parses stored flags; malformed = never", () => {
    expect(parseTourMemory(null)).toEqual({ seen: false, autoStarted: false });
    expect(parseTourMemory("{nope")).toEqual({ seen: false, autoStarted: false });
    expect(parseTourMemory("42")).toEqual({ seen: false, autoStarted: false });
    expect(parseTourMemory('{"seen":"yes","autoStarted":1}')).toEqual({ seen: false, autoStarted: false });
    expect(parseTourMemory('{"seen":true,"autoStarted":true}')).toEqual({ seen: true, autoStarted: true });
  });

  it("auto-starts at most once, only after the welcome card, never once seen", () => {
    expect(shouldAutoStart({ seen: false, autoStarted: false }, true)).toBe(true);
    expect(shouldAutoStart({ seen: false, autoStarted: false }, false)).toBe(false);
    expect(shouldAutoStart({ seen: false, autoStarted: true }, true)).toBe(false);
    expect(shouldAutoStart({ seen: true, autoStarted: false }, true)).toBe(false);
  });
});

describe("recoverStuckTour", () => {
  it("turns an auto-started, never-finished tour into a seen one", () => {
    expect(recoverStuckTour({ seen: false, autoStarted: true })).toEqual({ seen: true, autoStarted: true });
  });
  it("leaves every other memory alone", () => {
    expect(recoverStuckTour({ seen: false, autoStarted: false })).toBeNull();
    expect(recoverStuckTour({ seen: true, autoStarted: true })).toBeNull();
    expect(recoverStuckTour({ seen: true, autoStarted: false })).toBeNull();
  });
  it("the recovered memory never auto-starts again", () => {
    const fixed = recoverStuckTour(parseTourMemory('{"seen":false,"autoStarted":true}'));
    expect(fixed && shouldAutoStart(fixed, true)).toBe(false);
  });
});
