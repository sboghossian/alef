import { describe, expect, it } from "vitest";
import type { CouncilPersonaResult } from "../../shared/features/council.js";
import { buildSynthPrompt, parseSynthOutput, runCouncilSynth, type SynthRunner } from "../features/council-synth.js";

function okPersona(): CouncilPersonaResult {
  return {
    persona: "pragmatist",
    label: "The Pragmatist",
    lens: "feasibility first",
    ok: true,
    topChoice: "Ship now",
    distribution: [
      { option: "Ship now", probability: 0.7 },
      { option: "Wait a sprint", probability: 0.3 },
    ],
    confidence: 0.8,
    risk: { score: 1, level: "Some delivery risk", confidence: 0.6 },
  };
}

function failedPersona(): CouncilPersonaResult {
  return { persona: "skeptic", label: "The Skeptic", lens: "evidence first", ok: false, error: "Jev unavailable", topChoice: null, distribution: [], confidence: 0, risk: null };
}

describe("buildSynthPrompt", () => {
  it("includes the decision, numbered options, context, and a strict 4-line output contract", () => {
    const prompt = buildSynthPrompt({ decision: "Ship the council feature?", options: ["Ship now", "Wait"], context: "mid-refactor", personas: [okPersona(), failedPersona()] });
    expect(prompt).toContain("Decision: Ship the council feature?");
    expect(prompt).toContain("1) Ship now");
    expect(prompt).toContain("2) Wait");
    expect(prompt).toContain("Context: mid-refactor");
    expect(prompt).toContain('picks "Ship now"');
    expect(prompt).toContain("no signal — Jev unavailable");
    expect(prompt).toContain("PICK:");
    expect(prompt).toContain("WHY:");
    expect(prompt).toContain("DISSENT:");
    expect(prompt).toContain("CHANGE:");
  });

  it("shows a placeholder when no context is given", () => {
    expect(buildSynthPrompt({ decision: "d", options: ["a", "b"], personas: [] })).toContain("Context: (none given)");
  });
});

describe("parseSynthOutput", () => {
  it("parses a well-formed 4-line verdict", () => {
    const raw = "PICK: Ship now\nWHY: It unblocks the round-8 merge.\nDISSENT: Risk of a rushed edge case.\nCHANGE: A failing e2e test.";
    expect(parseSynthOutput(raw)).toEqual({ ok: true, pick: "Ship now", why: "It unblocks the round-8 merge.", dissent: "Risk of a rushed edge case.", changeMind: "A failing e2e test." });
  });

  it("joins a multi-line value under one label", () => {
    const raw = "PICK: Ship now\nWHY: First sentence.\nSecond sentence.\nDISSENT: d\nCHANGE: c";
    expect(parseSynthOutput(raw).why).toBe("First sentence. Second sentence.");
  });

  it("is case-insensitive on labels", () => {
    const raw = "pick: Ship now\nwhy: because\ndissent: none\nchange: nothing";
    expect(parseSynthOutput(raw).pick).toBe("Ship now");
  });

  it("treats empty or too-short output as a failure regardless of what the caller thinks happened", () => {
    expect(parseSynthOutput("")).toEqual({ ok: false, unavailable: true, error: "empty or too-short output" });
    expect(parseSynthOutput("ok")).toEqual({ ok: false, unavailable: true, error: "empty or too-short output" });
  });

  it("falls back to showing the raw text when no labels are present, rather than failing outright", () => {
    const raw = "I think you should ship it now because the feature is ready and well-tested.";
    const v = parseSynthOutput(raw);
    expect(v.ok).toBe(true);
    expect(v.pick).toBeUndefined();
    expect(v.why).toBe(raw);
  });
});

describe("runCouncilSynth", () => {
  const input = { decision: "d", options: ["a", "b"], personas: [okPersona()] };

  it("returns the parsed verdict on a successful run", async () => {
    const runner: SynthRunner = async () => ({ stdout: "PICK: a\nWHY: because\nDISSENT: maybe not\nCHANGE: new data", stderr: "" });
    const verdict = await runCouncilSynth(input, runner, 1000);
    expect(verdict).toEqual({ ok: true, pick: "a", why: "because", dissent: "maybe not", changeMind: "new data" });
  });

  it("never throws: a runner rejection (timeout, missing binary, non-zero exit) becomes unavailable:true", async () => {
    const runner: SynthRunner = async () => {
      throw new Error("Command failed: killed");
    };
    const verdict = await runCouncilSynth(input, runner, 1000);
    expect(verdict).toEqual({ ok: false, unavailable: true, error: "Error: Command failed: killed" });
  });

  it("treats a headless claude -p that exits 0 with empty stdout as a failure, not a success", async () => {
    const runner: SynthRunner = async () => ({ stdout: "", stderr: "" });
    const verdict = await runCouncilSynth(input, runner, 1000);
    expect(verdict.ok).toBe(false);
    expect(verdict.unavailable).toBe(true);
  });
});
