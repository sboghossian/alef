import { describe, expect, it } from "vitest";
import type { Island } from "../../shared/types";
import { CITY_SURFACE, FRONT_DIR, applyDistrictMergesToLayout, cityPoint, computeCityLayout, fibonacciSphere, lotLocal } from "./layout";

function island(id: string, lastActive: string, agentCount = 1): Island {
  return { id, name: id, path: `/tmp/${id}`, agentCount, lastActive };
}

describe("fibonacciSphere", () => {
  it("returns unit vectors spread over both hemispheres", () => {
    const pts = fibonacciSphere(30);
    expect(pts).toHaveLength(30);
    for (const p of pts) expect(p.length()).toBeCloseTo(1, 6);
    expect(pts.some((p) => p.y > 0.5)).toBe(true);
    expect(pts.some((p) => p.y < -0.5)).toBe(true);
  });
});

describe("computeCityLayout", () => {
  it("returns an empty map for no islands", () => {
    expect(computeCityLayout([], new Map()).size).toBe(0);
  });

  it("puts the most recent island facing the camera and harness right after it", () => {
    const islands = [
      island("old", "2026-01-01T00:00:00Z"),
      island("harness", "1970-01-01T00:00:00Z", 0),
      island("newest", "2026-09-24T00:00:00Z"),
      island("mid", "2026-06-01T00:00:00Z"),
    ];
    const layout = computeCityLayout(islands, new Map([["newest", 50]]));
    const newest = layout.get("newest");
    expect(newest?.rank).toBe(0);
    expect(newest?.dir.dot(FRONT_DIR)).toBeCloseTo(1, 6);
    expect(layout.get("harness")?.rank).toBe(1);
    expect(layout.get("old")?.rank).toBe(3);
    // Footprint grows with the number of lots.
    expect(newest?.radius ?? 0).toBeGreaterThan(layout.get("old")?.radius ?? Infinity);
  });

  it("keeps cities well apart for a realistic count", () => {
    const islands = Array.from({ length: 28 }, (_, i) => island(`i${i}`, new Date(2026, 0, i + 1).toISOString()));
    const dirs = [...computeCityLayout(islands, new Map()).values()].map((c) => c.dir);
    let minAngle = Infinity;
    for (let a = 0; a < dirs.length; a++) {
      for (let b = a + 1; b < dirs.length; b++) {
        const da = dirs[a];
        const db = dirs[b];
        if (da && db) minAngle = Math.min(minAngle, da.angleTo(db));
      }
    }
    expect(minAngle).toBeGreaterThan(0.4); // ~20 units of arc on a 50-unit planet
  });

  it("builds an orthonormal tangent frame and places lots on the plateau", () => {
    const layout = computeCityLayout([island("a", "2026-09-01T00:00:00Z")], new Map([["a", 10]]));
    const c = layout.get("a");
    if (!c) throw new Error("missing city");
    expect(Math.abs(c.t1.dot(c.dir))).toBeLessThan(1e-9);
    expect(Math.abs(c.t2.dot(c.dir))).toBeLessThan(1e-9);
    expect(Math.abs(c.t1.dot(c.t2))).toBeLessThan(1e-9);
    const [x, z] = lotLocal(3);
    expect(cityPoint(c, x, z, 0).length()).toBeCloseTo(CITY_SURFACE, 6);
    expect(Math.hypot(x, z)).toBeLessThan(c.radius);
  });
});

describe("applyDistrictMergesToLayout", () => {
  it("aliases every merged-away id onto the target's exact CityLayout (same reference)", () => {
    const islands = [island("keep", "2026-09-24T00:00:00Z"), island("d1", "2026-01-01T00:00:00Z"), island("d2", "2026-01-02T00:00:00Z")];
    const layout = computeCityLayout(islands, new Map());
    const target = layout.get("keep");
    const result = applyDistrictMergesToLayout(layout, [{ districts: ["d1", "d2", "keep"], into: "keep" }]);
    expect(result).toBe(layout); // mutates and returns the same map
    expect(layout.get("d1")).toBe(target);
    expect(layout.get("d2")).toBe(target);
    expect(layout.get("keep")).toBe(target); // "into" itself is a no-op, never re-pointed at anything odd
  });

  it("every original id keeps resolving after the merge (agent placement never breaks)", () => {
    const islands = [island("keep", "2026-09-24T00:00:00Z"), island("gone", "2026-01-01T00:00:00Z")];
    const layout = computeCityLayout(islands, new Map());
    applyDistrictMergesToLayout(layout, [{ districts: ["gone", "keep"], into: "keep" }]);
    expect(layout.get("gone")?.dir.equals(layout.get("keep")!.dir)).toBe(true);
  });

  it("skips a merge whose target isn't laid out, without throwing", () => {
    const islands = [island("keep", "2026-09-24T00:00:00Z")];
    const layout = computeCityLayout(islands, new Map());
    expect(() => applyDistrictMergesToLayout(layout, [{ districts: ["a", "b"], into: "no-such-island" }])).not.toThrow();
    expect(layout.has("a")).toBe(false);
  });

  it("is a no-op for no merges, and for an empty layout", () => {
    const islands = [island("keep", "2026-09-24T00:00:00Z")];
    const layout = computeCityLayout(islands, new Map());
    applyDistrictMergesToLayout(layout, []);
    expect(layout.size).toBe(1);
    expect(applyDistrictMergesToLayout(new Map(), [{ districts: ["a"], into: "b" }]).size).toBe(0);
  });
});
