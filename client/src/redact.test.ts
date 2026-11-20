import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../shared/types";
import { agentTitle } from "../../shared/display";
import { redactAgent } from "./redact";

describe("redactAgent", () => {
  it("hides Claude Code's name for the session too, not just the first prompt", () => {
    const a = { id: "854b06bf-d6aa-425d-8805-507e5e566858", islandId: "alexboghossian", title: "draft the trust post", displayName: "trust sm post" } as WorldAgent;
    const r = redactAgent(a);
    expect(r.displayName).toBeNull();
    expect(agentTitle(r)).toBe("alexboghossian session 854b");
  });
});
