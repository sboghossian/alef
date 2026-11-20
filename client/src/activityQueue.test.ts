import { describe, expect, it } from "vitest";
import type { AgentActivity } from "../../shared/types";
import { ActivityQueue } from "./activityQueue";

const act = (id: string, agentId: string): AgentActivity => ({
  id,
  agentId,
  at: "2026-09-24T10:00:00Z",
  stage: "tool",
  toolName: "Edit",
  targetObjectId: null,
  summary: `line ${id}`,
});

describe("ActivityQueue", () => {
  it("keeps only the newest pending activity per agent", () => {
    const q = new ActivityQueue(100, 10);
    q.push([act("1", "a"), act("2", "a"), act("3", "b"), act("4", "a")]);
    expect(q.size).toBe(2);
    expect(q.take(0)?.id).toBe("3");
    expect(q.take(100)?.id).toBe("4");
  });

  it("releases at most one item per interval", () => {
    const q = new ActivityQueue(250, 10);
    q.push([act("1", "a"), act("2", "b")]);
    expect(q.take(1000)?.id).toBe("1");
    expect(q.take(1100)).toBeNull();
    expect(q.take(1250)?.id).toBe("2");
    expect(q.take(2000)).toBeNull();
  });

  it("caps a burst of 50 distinct agents", () => {
    const q = new ActivityQueue(100, 8);
    q.push(Array.from({ length: 50 }, (_, i) => act(String(i), `agent${i}`)));
    expect(q.size).toBe(8);
    expect(q.take(0)?.id).toBe("42");
  });
});
