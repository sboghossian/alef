import { describe, expect, it } from "vitest";
import type { CouncilPersonaResult, CouncilResult } from "../../../shared/features/council";
import { agreementSummary, buildAgentContextSummary, pct, personaAnswered } from "./council-lib";

describe("buildAgentContextSummary", () => {
  const agent = { title: "email to Jessica about the contract", islandId: "acme-ai-next", status: "live" as const };

  it("returns empty for an unknown agent", () => {
    expect(buildAgentContextSummary(undefined, [], "a1")).toBe("");
  });

  it("includes title, project and status with no activity", () => {
    expect(buildAgentContextSummary(agent, [], "a1")).toBe('Agent: "email to Jessica about the contract" · Project: acme-ai-next · Status: live');
  });

  it("appends the most recent activities for this agent only, newest first", () => {
    const activities = [
      { agentId: "a1", summary: "edited server/db.ts" },
      { agentId: "other", summary: "should not appear" },
      { agentId: "a1", summary: "ran the test suite" },
    ];
    const out = buildAgentContextSummary(agent, activities, "a1");
    expect(out).toContain("Recent activity: ran the test suite; edited server/db.ts");
    expect(out).not.toContain("should not appear");
  });

  it("caps the total length", () => {
    const longAgent = { title: "x".repeat(3000), islandId: "i", status: "live" as const };
    expect(buildAgentContextSummary(longAgent, [], "a1").length).toBeLessThanOrEqual(2000);
  });
});

describe("pct", () => {
  it("rounds and clamps to 0..100", () => {
    expect(pct(0.756)).toBe(76);
    expect(pct(-1)).toBe(0);
    expect(pct(2)).toBe(100);
  });
});

describe("personaAnswered", () => {
  const base: CouncilPersonaResult = {
    persona: "pragmatist",
    label: "The Pragmatist",
    lens: "l",
    ok: true,
    topChoice: "a",
    distribution: [],
    confidence: 0.5,
    risk: { score: 1, level: "x", confidence: 0.5 },
  };

  it("is true only when ok, topChoice and risk are all present", () => {
    expect(personaAnswered(base)).toBe(true);
    expect(personaAnswered({ ...base, ok: false })).toBe(false);
    expect(personaAnswered({ ...base, topChoice: null })).toBe(false);
    expect(personaAnswered({ ...base, risk: null })).toBe(false);
  });
});

describe("agreementSummary", () => {
  it("reports the majority split", () => {
    const result: Pick<CouncilResult, "aggregate" | "personas"> = {
      aggregate: { agreement: 0.75, split: { "Ship now": 3, "Wait a sprint": 1 }, lowestConfidencePersona: "skeptic" },
      personas: [
        { persona: "pragmatist", label: "l", lens: "l", ok: true, topChoice: "Ship now", distribution: [], confidence: 0.5, risk: null },
        { persona: "visionary", label: "l", lens: "l", ok: true, topChoice: "Ship now", distribution: [], confidence: 0.5, risk: null },
        { persona: "skeptic", label: "l", lens: "l", ok: true, topChoice: "Wait a sprint", distribution: [], confidence: 0.5, risk: null },
        { persona: "user-advocate", label: "l", lens: "l", ok: true, topChoice: "Ship now", distribution: [], confidence: 0.5, risk: null },
      ],
    };
    expect(agreementSummary(result)).toBe('3/4 agree on "Ship now"');
  });

  it('reports "no live signal" when nobody answered', () => {
    const result: Pick<CouncilResult, "aggregate" | "personas"> = {
      aggregate: { agreement: 0, split: {}, lowestConfidencePersona: null },
      personas: [{ persona: "pragmatist", label: "l", lens: "l", ok: false, topChoice: null, distribution: [], confidence: 0, risk: null }],
    };
    expect(agreementSummary(result)).toBe("no live signal this round");
  });
});
