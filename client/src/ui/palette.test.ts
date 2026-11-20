import { describe, expect, it } from "vitest";
import type { Island, WorldAgent, WorldObject } from "../../../shared/types";
import { paletteRows, type PaletteData } from "./palette";

const island = (id: string, agentCount: number): Island => ({ id, name: id, path: `/p/${id}`, agentCount, lastActive: "2026-09-24T00:00:00Z" });
const agent = (id: string, islandId: string, title: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id,
  islandId,
  cwd: `/p/${islandId}`,
  title,
  status: "dormant",
  startedAt: "2026-09-20T00:00:00Z",
  lastActive: "2026-09-23T00:00:00Z",
  messageCount: 3,
  model: null,
  role: "builder",
  color: "#2563eb",
  targetIslandId: islandId,
  tokens: 10,
  awaitingInput: false,
  ...extra,
});
const obj = (id: string, name: string): WorldObject => ({ id, kind: "skill", name, islandId: "harness", usage: 4, growth: 0.2 });

const data: PaletteData = {
  islands: () => [island("harness", 0), island("acme-ai-next", 9), island("yalla-brief", 20)],
  agents: () => [
    agent("a1", "acme-ai-next", "Fix the pricing page"),
    agent("a2", "yalla-brief", "Morning brief layout", { status: "live", awaitingInput: true }),
  ],
  objects: () => [obj("skill:humanizer", "humanizer")],
  dispatchCity: () => "yalla-brief",
};

describe("paletteRows", () => {
  it("empty query surfaces waiting agents first, then live agents and big cities", () => {
    const rows = paletteRows("", data);
    expect(rows[0]).toMatchObject({ kind: "waiting", action: { type: "agent", id: "a2" } });
    expect(rows.some((r) => r.action.type === "city" && r.action.id === "yalla-brief")).toBe(true);
  });

  it("fuzzy matches agents, cities and objects, then appends Ask Jev and Dispatch actions", () => {
    const rows = paletteRows("pricing", data);
    expect(rows[0]?.action).toEqual({ type: "agent", id: "a1" });
    const tail = rows.slice(-2).map((r) => r.action);
    expect(tail[0]).toEqual({ type: "ask", query: "pricing" });
    expect(tail[1]).toEqual({ type: "dispatch", query: "pricing", islandId: "yalla-brief" });
  });

  it("finds harness objects and cities", () => {
    expect(paletteRows("humaniz", data)[0]?.action).toEqual({ type: "object", id: "skill:humanizer" });
    expect(paletteRows("yalla", data).some((r) => r.action.type === "city" && r.action.id === "yalla-brief")).toBe(true);
  });

  it("omits Dispatch when the dispatch city is unknown", () => {
    const rows = paletteRows("x", { ...data, dispatchCity: () => "nope" });
    expect(rows.some((r) => r.action.type === "dispatch")).toBe(false);
  });

  it("fuzzy matches feature commands and returns their namespaced id", () => {
    const withCmds: PaletteData = {
      ...data,
      commands: () => [{ id: "weather:refresh", title: "Refresh weather", keywords: ["storm"], run: () => {} }],
    };
    expect(paletteRows("storm", withCmds)[0]).toMatchObject({ kind: "command", action: { type: "command", id: "weather:refresh" } });
    expect(paletteRows("storm", data).some((r) => r.action.type === "command")).toBe(false);
  });
});
