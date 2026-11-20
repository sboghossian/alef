import { describe, expect, it } from "vitest";
import type { AgentActivity } from "../../../../shared/types";
import {
  activityRate01,
  arrivalPopScale,
  blendAnim,
  canBurstConfetti,
  creatureAnimFor,
  crossfadeK,
  facingCameraWindow,
  isGitCommitActivity,
  latestQuestionFor,
  sanitizeBubbleText,
  todoCompletedEdge,
  tryCelebrate,
} from "./game-feel-lib";

function activity(over: Partial<AgentActivity>): AgentActivity {
  return { id: "a1", agentId: "agent-1", at: "2026-09-25T12:00:00.000Z", stage: "tool", toolName: null, targetObjectId: null, summary: "", ...over };
}

describe("creatureAnimFor", () => {
  it("gives each state a distinct pattern", () => {
    expect(creatureAnimFor("working", 0).pattern).toBe("circle");
    expect(creatureAnimFor("permission", 0).pattern).toBe("pace");
    expect(creatureAnimFor("waiting", 0).pattern).toBe("pace");
    expect(creatureAnimFor("idle", 0).pattern).toBe("circle");
    expect(creatureAnimFor("sleeping", 0).pattern).toBe("curl");
  });

  it("working scales bob with activity rate", () => {
    const quiet = creatureAnimFor("working", 0);
    const busy = creatureAnimFor("working", 1);
    expect(busy.bobRate).toBeGreaterThan(quiet.bobRate);
    expect(busy.bobAmp).toBeGreaterThan(quiet.bobAmp);
  });

  it("clamps an out-of-range activity rate instead of throwing", () => {
    expect(() => creatureAnimFor("working", -5)).not.toThrow();
    expect(creatureAnimFor("working", -5)).toEqual(creatureAnimFor("working", 0));
    expect(creatureAnimFor("working", 99)).toEqual(creatureAnimFor("working", 1));
  });

  it("sleeping is curled and smaller", () => {
    const s = creatureAnimFor("sleeping", 0);
    expect(s.pattern).toBe("curl");
    expect(s.poseScale).toBeLessThan(1);
  });
});

describe("blendAnim", () => {
  const a = creatureAnimFor("idle", 0);
  const b = creatureAnimFor("permission", 0);

  it("k=0 returns a, k=1 returns b", () => {
    expect(blendAnim(a, b, 0)).toEqual(a);
    expect(blendAnim(a, b, 1)).toEqual(b);
  });

  it("interpolates numeric fields and snaps discrete fields at the midpoint", () => {
    const mid = blendAnim(a, b, 0.25);
    expect(mid.bobRate).toBeCloseTo(a.bobRate + (b.bobRate - a.bobRate) * 0.25, 5);
    expect(mid.pattern).toBe(a.pattern);
    expect(blendAnim(a, b, 0.75).pattern).toBe(b.pattern);
  });

  it("clamps k outside 0..1", () => {
    expect(blendAnim(a, b, -1)).toEqual(a);
    expect(blendAnim(a, b, 2)).toEqual(b);
  });
});

describe("crossfadeK", () => {
  it("is 0 right at the change and 1 once the duration has elapsed", () => {
    expect(crossfadeK(0)).toBe(0);
    expect(crossfadeK(0.3)).toBe(1);
    expect(crossfadeK(10)).toBe(1);
  });

  it("treats a non-positive duration as already settled", () => {
    expect(crossfadeK(0, 0)).toBe(1);
    expect(crossfadeK(0, -1)).toBe(1);
  });

  it("never goes negative for a time before the change", () => {
    expect(crossfadeK(-1)).toBe(0);
  });
});

describe("activityRate01", () => {
  const now = Date.parse("2026-09-25T12:01:00.000Z");

  it("is 0 for an empty activity list", () => {
    expect(activityRate01([], "agent-1", now)).toBe(0);
  });

  it("counts only the matching agent's recent events", () => {
    const list = [
      activity({ agentId: "agent-1", at: "2026-09-25T12:00:50.000Z" }),
      activity({ agentId: "agent-1", at: "2026-09-25T12:00:55.000Z" }),
      activity({ agentId: "agent-2", at: "2026-09-25T12:00:55.000Z" }),
    ];
    expect(activityRate01(list, "agent-1", now, 60_000, 8)).toBeCloseTo(2 / 8, 5);
  });

  it("ignores events outside the window", () => {
    const list = [activity({ agentId: "agent-1", at: "2026-09-25T11:00:00.000Z" })];
    expect(activityRate01(list, "agent-1", now)).toBe(0);
  });

  it("ignores a timestamp at or after now (clock skew / malformed line)", () => {
    const list = [activity({ agentId: "agent-1", at: "2026-09-25T12:05:00.000Z" }), activity({ agentId: "agent-1", at: "garbage" })];
    expect(activityRate01(list, "agent-1", now)).toBe(0);
  });

  it("saturates at 1 rather than exceeding it", () => {
    const list = Array.from({ length: 40 }, (_, i) => activity({ agentId: "agent-1", at: new Date(now - i * 100).toISOString() }));
    expect(activityRate01(list, "agent-1", now, 60_000, 8)).toBe(1);
  });
});

describe("facingCameraWindow", () => {
  it("is true right at the start of a cycle and false once the window passes", () => {
    expect(facingCameraWindow(0, 0, 4, 1)).toBe(true);
    expect(facingCameraWindow(1, 0, 4, 1)).toBe(false);
    expect(facingCameraWindow(3.9, 0, 4, 1)).toBe(false);
    expect(facingCameraWindow(4, 0, 4, 1)).toBe(true);
  });

  it("offsets by phase and wraps for negative elapsed", () => {
    expect(facingCameraWindow(-0.5, 0.5, 4, 1)).toBe(true);
  });

  it("is always false for a non-positive period", () => {
    expect(facingCameraWindow(0, 0, 0, 1)).toBe(false);
  });
});

describe("arrivalPopScale", () => {
  it("starts at 0, overshoots to 1.1, and settles at 1", () => {
    expect(arrivalPopScale(0)).toBe(0);
    expect(arrivalPopScale(0.6)).toBeCloseTo(1.1, 5);
    expect(arrivalPopScale(1)).toBeCloseTo(1, 5);
  });

  it("clamps out-of-range progress", () => {
    expect(arrivalPopScale(-1)).toBe(0);
    expect(arrivalPopScale(5)).toBeCloseTo(1, 5);
  });
});

describe("tryCelebrate", () => {
  it("allows the first celebration and blocks an immediate repeat", () => {
    const last = new Map<string, number>();
    expect(tryCelebrate(last, "a", 0)).toBe(true);
    expect(tryCelebrate(last, "a", 100)).toBe(false);
  });

  it("allows again once the cooldown passes, independently per agent", () => {
    const last = new Map<string, number>();
    tryCelebrate(last, "a", 0);
    expect(tryCelebrate(last, "a", 20_000)).toBe(true);
    expect(tryCelebrate(last, "b", 10)).toBe(true);
  });
});

describe("canBurstConfetti", () => {
  it("allows bursts up to the cap and prunes expired ones", () => {
    const active: number[] = [];
    expect(canBurstConfetti(active, 0, 3)).toBe(true);
    active.push(1000, 1000, 1000);
    expect(canBurstConfetti(active, 0, 3)).toBe(false);
    expect(canBurstConfetti(active, 2000, 3)).toBe(true); // all three expired by now
    expect(active).toEqual([]);
  });
});

describe("todoCompletedEdge", () => {
  it("is false for an empty list", () => {
    expect(todoCompletedEdge(undefined, 0, 0)).toBe(false);
  });

  it("fires exactly on the transition into all-done", () => {
    expect(todoCompletedEdge(false, 3, 3)).toBe(true);
    expect(todoCompletedEdge(undefined, 3, 3)).toBe(true);
  });

  it("does not re-fire for an already all-done list", () => {
    expect(todoCompletedEdge(true, 3, 3)).toBe(false);
  });

  it("is false while still in progress", () => {
    expect(todoCompletedEdge(false, 2, 3)).toBe(false);
  });
});

describe("isGitCommitActivity", () => {
  it("matches the indexer's Bash git-commit summary shape", () => {
    expect(isGitCommitActivity({ toolName: "Bash", summary: "Bash: git commit -m 'fix: thing'" })).toBe(true);
  });

  it("does not match a different Bash command", () => {
    expect(isGitCommitActivity({ toolName: "Bash", summary: "Bash: git status" })).toBe(false);
  });

  it("does not match a non-Bash tool even with commit-shaped text", () => {
    expect(isGitCommitActivity({ toolName: "Edit", summary: "Bash: git commit -m 'x'" })).toBe(false);
  });

  it("handles a null toolName without throwing", () => {
    expect(isGitCommitActivity({ toolName: null, summary: "Bash: git commit -m 'x'" })).toBe(false);
  });
});

describe("sanitizeBubbleText", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeBubbleText("  hello   world  ")).toBe("hello world");
  });

  it("truncates long text with an ellipsis, respecting max", () => {
    const long = "a".repeat(100);
    const out = sanitizeBubbleText(long, 60);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves an already-short string untouched (no ellipsis)", () => {
    expect(sanitizeBubbleText("short?")).toBe("short?");
  });

  it("handles an empty or whitespace-only string", () => {
    expect(sanitizeBubbleText("")).toBe("");
    expect(sanitizeBubbleText("   ")).toBe("");
  });

  it("strips control characters", () => {
    expect(sanitizeBubbleText("hi\u0000\u001fthere")).toBe("hi there");
  });
});

describe("latestQuestionFor", () => {
  it("finds the newest reason-stage summary ending in a question mark", () => {
    const list: AgentActivity[] = [
      activity({ agentId: "agent-1", stage: "reason", summary: "thinking" }),
      activity({ agentId: "agent-1", stage: "reason", summary: "Should I proceed?" }),
      activity({ agentId: "agent-2", stage: "reason", summary: "Different agent?" }),
    ];
    expect(latestQuestionFor(list, "agent-1")).toBe("Should I proceed?");
  });

  it("ignores non-reason stages and other agents", () => {
    const list: AgentActivity[] = [activity({ agentId: "agent-1", stage: "tool", summary: "Edit foo.ts?" })];
    expect(latestQuestionFor(list, "agent-1")).toBeUndefined();
  });

  it("returns undefined when there is no question", () => {
    expect(latestQuestionFor([], "agent-1")).toBeUndefined();
  });
});
