import { describe, expect, it } from "vitest";
import { backoffMs, wsUrl } from "./net";

describe("backoffMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(4)).toBe(16_000);
    expect(backoffMs(5)).toBe(30_000);
    expect(backoffMs(50)).toBe(30_000);
  });
  it("treats negative attempts as the first one", () => {
    expect(backoffMs(-3)).toBe(1000);
  });
});

describe("wsUrl", () => {
  it("says what the tab already has on the first connect only", () => {
    expect(wsUrl({ protocol: "http:", host: "localhost:5178" })).toBe("ws://localhost:5178/ws");
    expect(wsUrl({ protocol: "https:", host: "alef.local" }, "2026-10-27T07:00:00.000Z")).toBe("wss://alef.local/ws?have=2026-10-27T07%3A00%3A00.000Z");
  });
});
