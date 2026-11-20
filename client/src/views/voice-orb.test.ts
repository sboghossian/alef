import { describe, expect, it } from "vitest";
import { easeOrb, ORB_STATES } from "./voice-orb";

describe("easeOrb", () => {
  it("converges on the target state's params", () => {
    let p = { ...ORB_STATES.idle };
    for (let i = 0; i < 200; i++) p = easeOrb(p, "speaking");
    expect(p.mouth).toBeCloseTo(ORB_STATES.speaking.mouth, 3);
    expect(p.hue).toBeCloseTo(ORB_STATES.speaking.hue, 1);
  });

  it("moves only part of the way per frame (no snapping)", () => {
    const p = easeOrb({ ...ORB_STATES.idle }, "thinking", 0.1);
    expect(p.spin).toBeGreaterThan(ORB_STATES.idle.spin);
    expect(p.spin).toBeLessThan(ORB_STATES.thinking.spin);
  });

  it("speaking opens the mouth wider than any other state", () => {
    const others = (["idle", "listening", "thinking"] as const).map((s) => ORB_STATES[s].mouth);
    expect(Math.max(...others)).toBeLessThan(ORB_STATES.speaking.mouth);
  });
});
