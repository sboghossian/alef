import { describe, expect, it } from "vitest";
import { COUNCIL_PERSONAS } from "../features/council-personas.js";

describe("COUNCIL_PERSONAS", () => {
  it("has exactly the 4 personas ported from crucible", () => {
    expect(COUNCIL_PERSONAS.map((p) => p.id)).toEqual(["pragmatist", "visionary", "skeptic", "user-advocate"]);
  });

  it("gives every persona a non-empty lens, choice instructions and risk instructions", () => {
    for (const p of COUNCIL_PERSONAS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.lens.length).toBeGreaterThan(0);
      expect(p.choiceInstructions.length).toBeGreaterThan(0);
      expect(p.riskInstructions.length).toBeGreaterThan(0);
    }
  });

  it("gives every persona 2..10 ordered risk levels (TypeSafe's Score bounds)", () => {
    for (const p of COUNCIL_PERSONAS) {
      expect(p.riskLevels.length).toBeGreaterThanOrEqual(2);
      expect(p.riskLevels.length).toBeLessThanOrEqual(10);
      expect(new Set(p.riskLevels).size).toBe(p.riskLevels.length); // no duplicate levels
    }
  });

  it("ids are unique", () => {
    expect(new Set(COUNCIL_PERSONAS.map((p) => p.id)).size).toBe(COUNCIL_PERSONAS.length);
  });
});
