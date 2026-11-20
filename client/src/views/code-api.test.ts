import { describe, expect, it } from "vitest";
import { explainError } from "./code-api";

describe("explainError", () => {
  it("turns B's refusal codes into plain words and never hides a secret refusal", () => {
    expect(explainError(403, "secret")).toMatch(/secret/);
    expect(explainError(403, "outside-root")).toMatch(/outside/);
    expect(explainError(404, "not-found")).toMatch(/no longer exists/);
    expect(explainError(413, "too big")).toMatch(/too big/);
    expect(explainError(415, "binary")).toMatch(/binary/);
    expect(explainError(500, "")).toBe("The server answered 500.");
  });
});
