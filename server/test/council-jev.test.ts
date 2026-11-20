import { describe, expect, it } from "vitest";
import type { CouncilPersonaResult, CouncilRequest } from "../../shared/features/council.js";
import type { FetchLike } from "../director.js";
import { aggregateCouncil, buildCouncilJevBody, isScoreAnswer, keywordCouncilPersonas, runCouncilJevRound } from "../features/council-jev.js";
import { COUNCIL_PERSONAS } from "../features/council-personas.js";

const REQUEST: CouncilRequest = { decision: "Ship the council feature this sprint?", options: ["Ship now", "Wait a sprint"] };

function personaResult(overrides: Partial<CouncilPersonaResult>): CouncilPersonaResult {
  return {
    persona: "pragmatist",
    label: "The Pragmatist",
    lens: "feasibility",
    ok: true,
    topChoice: "Ship now",
    distribution: [
      { option: "Ship now", probability: 0.7 },
      { option: "Wait a sprint", probability: 0.3 },
    ],
    confidence: 0.8,
    risk: { score: 1, level: "Some delivery risk", confidence: 0.6 },
    ...overrides,
  };
}

describe("isScoreAnswer", () => {
  it("accepts a well-formed Score answer and rejects a Choice-shaped one", () => {
    expect(isScoreAnswer({ score: 1.4, confidence: 0.5, probabilities: { "0": 0.2, "1": 0.8 } })).toBe(true);
    expect(isScoreAnswer({ choice: "a", confidence: 0.5, probabilities: { a: 1 } })).toBe(false); // no `score`
    expect(isScoreAnswer(null)).toBe(false);
  });
});

describe("buildCouncilJevBody", () => {
  it("batches 4 personas x (choice + score) = 8 questions in one request, over one shared state", () => {
    const body = buildCouncilJevBody(REQUEST);
    expect(body.model).toBe("jev-latest");
    const questions = body.questions as Record<string, { type: string; criteria: unknown }>;
    expect(Object.keys(questions)).toHaveLength(8);
    for (const p of COUNCIL_PERSONAS) {
      expect(questions[`${p.id}_choice`]!.type).toBe("choice");
      expect(questions[`${p.id}_choice`]!.criteria).toEqual({ opt0: "Ship now", opt1: "Wait a sprint" });
      expect(questions[`${p.id}_risk`]!.type).toBe("score");
      expect(questions[`${p.id}_risk`]!.criteria).toEqual(p.riskLevels);
    }
    const state = body.state as Record<string, unknown>;
    expect(state.decision).toBe(REQUEST.decision);
    expect(state.options).toEqual(REQUEST.options);
    expect(state.context).toBeUndefined();
  });

  it("includes context in state only when given", () => {
    const body = buildCouncilJevBody({ ...REQUEST, context: "Agent is mid-refactor of the renderer" });
    expect((body.state as Record<string, unknown>).context).toBe("Agent is mid-refactor of the renderer");
  });
});

describe("runCouncilJevRound", () => {
  it("returns keyword personas (no live signal) when there is no API key", async () => {
    const { personas, source } = await runCouncilJevRound(REQUEST, { apiKey: "" });
    expect(source).toBe("keyword");
    expect(personas).toHaveLength(4);
    for (const p of personas) {
      expect(p.ok).toBe(false);
      expect(p.topChoice).toBeNull();
    }
  });

  it("parses a mocked success into 4 ok persona results", async () => {
    const successFetch: FetchLike = async () => {
      const answers: Record<string, unknown> = {};
      for (const p of COUNCIL_PERSONAS) {
        answers[`${p.id}_choice`] = { choice: "opt0", probabilities: { opt0: 0.75, opt1: 0.25 }, confidence: 0.9 };
        answers[`${p.id}_risk`] = { score: 0.4, probabilities: { "0": 0.6, "1": 0.4 }, confidence: 0.55 };
      }
      return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
    };
    const { personas, source } = await runCouncilJevRound(REQUEST, { apiKey: "test-key", fetchImpl: successFetch });
    expect(source).toBe("jev");
    expect(personas).toHaveLength(4);
    for (const p of personas) {
      const def = COUNCIL_PERSONAS.find((d) => d.id === p.persona)!;
      expect(p.ok).toBe(true);
      expect(p.topChoice).toBe("Ship now");
      expect(p.distribution).toEqual([
        { option: "Ship now", probability: 0.75 },
        { option: "Wait a sprint", probability: 0.25 },
      ]);
      expect(p.risk?.level).toBe(def.riskLevels[0]); // riskLevels[0] (0.6) beat riskLevels[1] (0.4), per this persona's own wording
    }
  });

  it("falls back to keyword personas on a TypeSafe failure", async () => {
    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    const { personas, source } = await runCouncilJevRound(REQUEST, { apiKey: "test-key", fetchImpl: failingFetch });
    expect(source).toBe("keyword");
    expect(personas.every((p) => !p.ok)).toBe(true);
  });

  it("marks just one persona ok:false when only its answer is missing", async () => {
    const partialFetch: FetchLike = async () => {
      const answers: Record<string, unknown> = {};
      for (const p of COUNCIL_PERSONAS) {
        if (p.id === "skeptic") continue; // simulate a missing answer for one persona
        answers[`${p.id}_choice`] = { choice: "opt1", probabilities: { opt0: 0.1, opt1: 0.9 }, confidence: 0.7 };
        answers[`${p.id}_risk`] = { score: 1.5, probabilities: { "0": 0, "1": 1 }, confidence: 0.5 };
      }
      return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
    };
    const { personas, source } = await runCouncilJevRound(REQUEST, { apiKey: "test-key", fetchImpl: partialFetch });
    expect(source).toBe("jev");
    const skeptic = personas.find((p) => p.persona === "skeptic")!;
    expect(skeptic.ok).toBe(false);
    expect(personas.filter((p) => p.persona !== "skeptic").every((p) => p.ok)).toBe(true);
  });
});

describe("keywordCouncilPersonas", () => {
  it("returns all 4 personas, all ok:false, carrying the given reason", () => {
    const out = keywordCouncilPersonas("no key");
    expect(out).toHaveLength(4);
    expect(out.every((p) => p.ok === false && p.error === "no key")).toBe(true);
  });
});

describe("aggregateCouncil", () => {
  it("computes agreement, split and the lowest-confidence persona among 3 agreeing + 1 dissenting", () => {
    const personas: CouncilPersonaResult[] = [
      personaResult({ persona: "pragmatist", topChoice: "Ship now", confidence: 0.9, risk: { score: 1, level: "x", confidence: 0.9 } }),
      personaResult({ persona: "visionary", topChoice: "Ship now", confidence: 0.8, risk: { score: 1, level: "x", confidence: 0.8 } }),
      personaResult({ persona: "skeptic", topChoice: "Wait a sprint", confidence: 0.3, risk: { score: 2, level: "x", confidence: 0.2 } }),
      personaResult({ persona: "user-advocate", topChoice: "Ship now", confidence: 0.6, risk: { score: 1, level: "x", confidence: 0.6 } }),
    ];
    const agg = aggregateCouncil(personas);
    expect(agg.split).toEqual({ "Ship now": 3, "Wait a sprint": 1 });
    expect(agg.agreement).toBeCloseTo(0.75);
    expect(agg.lowestConfidencePersona).toBe("skeptic");
  });

  it("ignores ok:false personas and returns a null lowest-confidence persona when none answered", () => {
    expect(aggregateCouncil(keywordCouncilPersonas("no key"))).toEqual({ agreement: 0, split: {}, lowestConfidencePersona: null });
  });
});
