import { describe, expect, it } from "vitest";
import type { ArtifactItem } from "../../../shared/features/artifacts";
import { MUSEUM_ISLAND_ID } from "../../../shared/features/artifacts";
import { cityRadiusForLots, lotLocal } from "../layout";
import { artifactLabel, BOARD_REACH, BOARD_W, groupByMonth, monthLabel, planBoards, towerSlots, TOWER_FOOT_R } from "./artifacts-lib";

const item = (id: string, islandId: string | null, lastAt: string | null, title: string | null = `T ${id}`): ArtifactItem => ({
  id,
  url: `https://claude.ai/artifact/${id}`,
  title,
  origin: islandId ? "published" : "referenced",
  islandId,
  sessions: [],
  firstAt: lastAt,
  lastAt,
  publishCount: islandId ? 1 : 0,
  hasPreview: false,
});

/** Footprint radius of the biggest thing standing on a lot: a house (0.6 box, 0.5 roof cone, ×1.2). */
const HOUSE_REACH = 0.5 * 1.2;

describe("towerSlots", () => {
  it("hangs one board per face per row, inside the tower's height", () => {
    const h = 3.2; // the shortest tower (scene/cities.ts towerHeightFor with 0 agents)
    const slots = towerSlots(h);
    expect(slots.length % 8).toBe(0);
    expect(slots.length).toBeGreaterThanOrEqual(40);
    for (const s of slots) {
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(h);
      const r = Math.hypot(s.x, s.z);
      expect(r).toBeGreaterThan(TOWER_FOOT_R * Math.cos(Math.PI / 8) * 0.8); // on the wall, not inside it
      expect(r).toBeLessThan(BOARD_REACH);
    }
    // Two boards in one row never overlap.
    const row = slots.filter((s) => s.y === slots[0]!.y);
    for (let i = 0; i < row.length; i++) {
      const a = row[i]!;
      const b = row[(i + 1) % row.length]!;
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(BOARD_W);
    }
  });

  it("never reaches a lot: no overlap with files or houses even in a full city", () => {
    for (const lots of [0, 1, 30, 120, 400]) {
      const radius = cityRadiusForLots(lots);
      for (let i = 0; i < Math.max(lots, 1); i++) {
        const [x, z] = lotLocal(i);
        expect(Math.hypot(x, z) - HOUSE_REACH).toBeGreaterThan(BOARD_REACH + 0.2);
      }
      expect(radius).toBeGreaterThan(BOARD_REACH);
    }
  });
});

describe("planBoards", () => {
  const towers = new Set(["isle-a", "isle-b", MUSEUM_ISLAND_ID]);
  const input = (items: ArtifactItem[]) => ({ items, hasTower: (id: string) => towers.has(id), towerHeight: () => 3.2 });

  it("puts each artifact on its district tower and every artifact on the Museum's, newest first", () => {
    const items = [item("a1", "isle-a", "2026-10-01T00:00:00Z"), item("a2", "isle-a", "2026-10-03T00:00:00Z"), item("b1", "isle-b", "2026-10-02T00:00:00Z"), item("r1", null, "2026-10-04T00:00:00Z"), item("x1", "no-tower", "2026-10-05T00:00:00Z")];
    const plan = planBoards(input(items));
    expect(plan.filter((p) => p.cityId === "isle-a").map((p) => p.item.id)).toEqual(["a2", "a1"]);
    expect(plan.filter((p) => p.cityId === "isle-b").map((p) => p.item.id)).toEqual(["b1"]);
    expect(plan.filter((p) => p.museum).map((p) => p.item.id)).toEqual(["x1", "r1", "a2", "b1", "a1"]);
    expect(plan.some((p) => p.cityId === "no-tower")).toBe(false);
    // Distinct slots per tower.
    const keys = plan.map((p) => `${p.cityId}:${p.slot.x.toFixed(3)}:${p.slot.z.toFixed(3)}:${p.slot.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stops at the tower's slot count (the gallery still lists the rest)", () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`m${String(i).padStart(4, "0")}`, "isle-a", `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`));
    const plan = planBoards(input(many));
    expect(plan.filter((p) => p.cityId === "isle-a")).toHaveLength(towerSlots(3.2).length);
    expect(plan.filter((p) => p.museum)).toHaveLength(towerSlots(3.2).length);
  });

  it("skips the Museum when its city isn't drawn", () => {
    expect(planBoards({ items: [item("a1", "isle-a", null)], hasTower: (id) => id === "isle-a", towerHeight: () => 3.2 }).every((p) => !p.museum)).toBe(true);
  });
});

describe("groupByMonth + labels", () => {
  it("groups newest month first, undated last", () => {
    const g = groupByMonth([item("a", "i", "2026-09-30T23:00:00Z"), item("b", "i", null), item("c", "i", "2026-10-02T00:00:00Z"), item("d", "i", "2026-10-09T00:00:00Z")]);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["October 2026", ["d", "c"]],
      ["September 2026", ["a"]],
      ["Undated", ["b"]],
    ]);
    expect(monthLabel("2026-13")).toBe("Undated");
  });

  it("a referenced link seen again today stays in the month it was first seen", () => {
    const pasted = { ...item("r", null, "2026-10-14T00:00:00Z"), firstAt: "2026-08-01T00:00:00Z" };
    const made = item("p", "i", "2026-10-02T00:00:00Z");
    expect(groupByMonth([pasted, made]).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["October 2026", ["p"]],
      ["August 2026", ["r"]],
    ]);
  });

  it("never shows a title in redact mode", () => {
    const it0 = item("a", "i", "2026-10-02T00:00:00Z", "Secret board");
    expect(artifactLabel(it0, false)).toBe("Secret board");
    expect(artifactLabel(it0, true)).toBe("Artifact · October 2026");
    expect(artifactLabel(item("b", "i", null, null), false)).toBe("Artifact · Undated");
  });
});
