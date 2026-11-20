import { describe, expect, it } from "vitest";
import type { CityUsage } from "../../../shared/features/usage";
import { reconcileDistrictCost } from "./usage-lib";

// Real shapes: trimmed from a live GET /api/usage/day (2026-09-27) — real districts
// ("agent-world", "harness") mixed with non-district city keys the same response actually
// returned (a worktree slug, a raw "cwd:<path>" fallback, and "unknown").
const perCity: CityUsage[] = [
  { islandId: "agent-world", name: "agent-world", costUsd: 3.42, unpricedTokens: 0, activeMs: 3_600_000, sessions: 4 },
  { islandId: "harness", name: "Harness City", costUsd: 0.11, unpricedTokens: 0, activeMs: 60_000, sessions: 1 },
  { islandId: "resident-feedback", name: "resident-feedback", costUsd: 0.85, unpricedTokens: 0, activeMs: 120_000, sessions: 1 },
  { islandId: "cwd:/Users/alexboghossian/.alef-worktrees/autonomy-axis", name: "autonomy-axis", costUsd: 0.24, unpricedTokens: 0, activeMs: 90_000, sessions: 1 },
  { islandId: "unknown", name: "unknown", costUsd: 0.02, unpricedTokens: 0, activeMs: 0, sessions: 1 },
];
const realIslandIds = new Set(["agent-world", "harness", "vault", "acme-ai-next"]);

describe("reconcileDistrictCost", () => {
  it("keeps rows whose key is a real district and folds the rest into unattributedCostUsd", () => {
    const r = reconcileDistrictCost(perCity, realIslandIds);
    expect(r.byDistrict.get("agent-world")).toEqual({ costUsd: 3.42, sessions: 4 });
    expect(r.byDistrict.get("harness")).toEqual({ costUsd: 0.11, sessions: 1 });
    expect(r.byDistrict.size).toBe(2);
    expect(r.unattributedCostUsd).toBeCloseTo(0.85 + 0.24 + 0.02, 10);
  });

  it("reconciles exactly against the day's totalCostUsd (no drift, nothing dropped or doubled)", () => {
    const totalCostUsd = perCity.reduce((s, c) => s + c.costUsd, 0);
    const r = reconcileDistrictCost(perCity, realIslandIds);
    let sum = r.unattributedCostUsd;
    for (const d of r.byDistrict.values()) sum += d.costUsd;
    expect(sum).toBeCloseTo(totalCostUsd, 10);
  });

  it("merges two rows that land on the same real district (defensive: buildCityRows already keys perCity by islandId, but a caller could still pass duplicates)", () => {
    const rows: CityUsage[] = [
      { islandId: "agent-world", name: "agent-world", costUsd: 1, unpricedTokens: 0, activeMs: 0, sessions: 2 },
      { islandId: "agent-world", name: "agent-world", costUsd: 0.5, unpricedTokens: 0, activeMs: 0, sessions: 1 },
    ];
    const r = reconcileDistrictCost(rows, new Set(["agent-world"]));
    expect(r.byDistrict.get("agent-world")).toEqual({ costUsd: 1.5, sessions: 3 });
    expect(r.unattributedCostUsd).toBe(0);
  });

  it("returns everything as unattributed when no city matches a real district", () => {
    const r = reconcileDistrictCost(perCity, new Set());
    expect(r.byDistrict.size).toBe(0);
    expect(r.unattributedCostUsd).toBeCloseTo(perCity.reduce((s, c) => s + c.costUsd, 0), 10);
  });

  it("returns nothing for an empty day (no usage yet)", () => {
    const r = reconcileDistrictCost([], realIslandIds);
    expect(r.byDistrict.size).toBe(0);
    expect(r.unattributedCostUsd).toBe(0);
  });
});
