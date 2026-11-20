import { describe, expect, it } from "vitest";
import { creatureGeometry, FAMILIES, modelFamily, modelLabel } from "./creatures";

describe("modelFamily", () => {
  it("maps model ids to families", () => {
    expect(modelFamily("claude-opus-5-5[1m]")).toBe("opus");
    expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("gpt-6")).toBe("other");
    expect(modelFamily(null)).toBe("other");
    expect(modelFamily(undefined)).toBe("other");
  });
});

describe("modelLabel", () => {
  it("formats readable names", () => {
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel(null)).toBe("Claude");
    expect(modelLabel("gpt-6")).toBe("gpt-6");
  });
});

describe("creatureGeometry", () => {
  it("builds a coloured mesh for every family", () => {
    for (const f of FAMILIES) {
      const g = creatureGeometry(f);
      expect(g.getAttribute("position").count).toBeGreaterThan(20);
      expect(g.getAttribute("color")).toBeTruthy();
    }
  });
});
