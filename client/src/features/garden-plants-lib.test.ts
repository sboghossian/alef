import { describe, expect, it } from "vitest";
import { GAP, HALF, MAX_STEM, MIN_STEM, WIN, buildGarden, capacity, compose, flowerColour, gardenFinished, gardenLabel, localDayKey, plantAt, plantsForDay, runGarden, slotX, sproutPlant, stemHeight, stepGarden, type Plant, type PlantOptions } from "./garden-plants-lib";

const NOON = new Date(2026, 8, 30, 12, 0, 0).getTime();
const at = (h: number, m = 0): string => new Date(2026, 8, 30, h, m, 0).toISOString();
const opts = (o: Partial<PlantOptions> = {}): PlantOptions => ({ now: NOON, width: 200, blooms: () => false, ...o });
const agent = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, islandId: "isl", title: `t-${id}`, startedAt: at(9), messageCount: 10, status: "dormant", ...o });
const many = (n: number, o: Record<string, unknown> = {}): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => agent(`${(i * 2654435761 >>> 0).toString(16)}-${i}-sess`, { startedAt: new Date(NOON - (n - i) * 60_000).toISOString(), ...o }));

describe("plantsForDay", () => {
  it("plants one seed per session started today, ordered by start time", () => {
    const g = plantsForDay([agent("b", { startedAt: at(10) }), agent("a", { startedAt: at(8) }), agent("old", { startedAt: new Date(2026, 8, 29, 23, 59).toISOString() })], opts());
    expect(g.plants.map((p) => p.id)).toEqual(["a", "b"]);
    expect(g.overflow).toBe(0);
  });
  it("puts a session in the same column on every call", () => {
    const list = many(20);
    expect(plantsForDay(list, opts()).plants.map((p) => p.x)).toEqual(plantsForDay(list, opts()).plants.map((p) => p.x));
  });
  it("a full garden still fits: capacity plants, one per lattice slot, never closer than GAP", () => {
    for (const width of [24, 40, 120, 192, 280, 384, 768]) {
      const cap = capacity(width);
      for (const n of [1, Math.ceil(cap / 2), cap, cap + 5, 200]) {
        const g = plantsForDay(many(n), opts({ width }));
        expect(g.plants).toHaveLength(Math.min(n, cap));
        expect(g.overflow).toBe(Math.max(0, n - cap));
        const xs = g.plants.map((p) => p.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(GAP);
        if (xs.length) {
          expect(xs[0]!).toBeGreaterThanOrEqual(HALF);
          expect(xs.at(-1)!).toBeLessThanOrEqual(width - 1 - HALF);
        }
      }
    }
    expect(slotX(384, 0)).toBeGreaterThanOrEqual(HALF);
  });
  it("log-scales and caps the stem so one giant session doesn't eat the sky", () => {
    expect(stemHeight(0)).toBe(MIN_STEM);
    expect(stemHeight(1000)).toBeGreaterThan(stemHeight(10));
    expect(stemHeight(1e9)).toBe(MAX_STEM);
    expect(stemHeight(200) - stemHeight(100)).toBeLessThan(stemHeight(20) - stemHeight(10) + 1);
  });
  it("blooms only what the caller says shipped, and marks live sessions", () => {
    const g = plantsForDay([agent("a"), agent("b", { status: "live" })], opts({ blooms: (id) => id === "a" }));
    expect(g.plants.map((p) => [p.id, p.bloom, p.live])).toEqual([["a", true, false], ["b", false, true]]);
  });
  it("keeps the newest sessions when the garden is full and reports the rest", () => {
    const width = 40;
    const cap = capacity(width);
    const list = Array.from({ length: cap + 3 }, (_, i) => agent(`s${i}`, { startedAt: at(1, i) }));
    const g = plantsForDay(list, opts({ width }));
    expect(g.plants).toHaveLength(cap);
    expect(g.overflow).toBe(3);
    expect(g.plants.at(-1)!.id).toBe(`s${cap + 2}`);
    expect(gardenLabel(g.plants, g.overflow)).toContain("3 older");
  });
  it("skips malformed and partial agent data instead of inventing plants", () => {
    const junk: unknown[] = [null, undefined, 5, "x", [], {}, { id: "" }, { id: "nostart" }, { id: "bad", startedAt: "not a date" }, { id: 7, startedAt: at(9) }, agent("dup"), agent("dup"), { id: "future", startedAt: new Date(NOON + 86_400_000).toISOString() }];
    expect(plantsForDay(junk, opts()).plants.map((p) => p.id)).toEqual(["dup"]);
  });
  it("copes with missing title, island and message count, and a title that sanitises to blank", () => {
    const g = plantsForDay([{ id: "a", startedAt: at(9) }, { id: "b", startedAt: at(10), messageCount: Number.NaN, title: 5 }, agent("c", { startedAt: at(11) })], opts({ nameOf: (a) => (a.id === "c" ? " " : "") }));
    expect(g.plants).toHaveLength(3);
    expect(g.plants.every((p) => p.title === "Untitled session")).toBe(true);
    expect(g.plants[0]!.stem).toBe(MIN_STEM);
    expect(flowerColour(undefined)).toBe(flowerColour(""));
  });
  it("an empty day plants nothing", () => {
    expect(plantsForDay([], opts())).toEqual({ plants: [], overflow: 0 });
    expect(gardenLabel([])).toBe("Today's garden: 0 sessions, 0 in bloom");
  });
});

describe("buildGarden", () => {
  const plant = (o: Partial<Plant>): Plant => ({ id: "p", title: "p", x: 10, stem: 12, colour: 2, bloom: false, live: false, startedAt: 0, ...o });
  const grow = (plants: Plant[], day = "2026-09-30", width = 40) => {
    const b = buildGarden(plants, width, 40, day);
    runGarden(b);
    return b;
  };
  const stemCells = (b: ReturnType<typeof grow>, x: number): number => {
    let n = 0;
    for (let y = 0; y < b.groundY; y++) if (compose(b).get(x, y) === "|") n++;
    return n;
  };
  it("grows a stem to its height and stops under the cap", () => {
    const b = grow([plant({})]);
    expect(stemCells(b, 10)).toBeGreaterThanOrEqual(10);
    expect(compose(b).get(10, b.groundY - 12)).toBe("g");
  });
  it("only a bloomed plant flowers, in its own shape and colour slot; idle plants stay green", () => {
    const b = grow([plant({ bloom: true, x: 10 }), plant({ id: "q", x: 19, bloom: false }), plant({ id: "r", x: 28, live: true })]);
    const rows = compose(b);
    expect(rows.count("Y")).toBe(1);
    expect(rows.count("P")).toBeGreaterThanOrEqual(12);
    expect(b.sprites.filter((s) => s.grid.count("P") > 0).map((s) => s.plant.id)).toEqual(["p"]);
    expect(b.sprites.find((s) => s.plant.id === "q")!.grid.count("g")).toBe(1);
  });
  it("a live plant shows a closed bud", () => {
    const g = grow([plant({ live: true })]).sprites[0]!.grid;
    expect(g.count("E")).toBe(1);
    expect(g.count("Y")).toBe(0);
  });
  it("busy sessions carry side branches with their own smaller blooms", () => {
    const g = grow([plant({ stem: 28, bloom: true })]).sprites[0]!.grid;
    expect(g.count("y")).toBeGreaterThanOrEqual(1);
    expect(grow([plant({ stem: 28, bloom: false })]).sprites[0]!.grid.count("y")).toBe(0);
  });
  it("blooms drawn equal blooms claimed when the garden is full", () => {
    for (const width of [120, 192, 384]) {
      const g = plantsForDay(many(capacity(width) + 4), opts({ width, blooms: (id) => id.length % 2 === 0 }));
      const b = grow(g.plants, "2026-09-30", width);
      expect(compose(b).count("Y")).toBe(g.plants.filter((p) => p.bloom).length);
      expect(b.sprites.every((s) => s.x0 >= 0 && s.x0 + WIN <= width)).toBe(true);
    }
  });
  it("same date and plants give the same garden; another date changes leaves", () => {
    const rows = (day: string): string => compose(grow([plant({ stem: 20 }), plant({ id: "b", x: 25, bloom: true })], day)).rows().join("/");
    expect(rows("d1")).toBe(rows("d1"));
    expect(new Set(["d1", "d2", "d3", "d4", "d5"].map(rows)).size).toBeGreaterThan(1);
  });
  it("a plant looks the same when other sessions appear (own PRNG per plant)", () => {
    const solo = grow([plant({ id: "a", x: 10, stem: 24 })]).sprites[0]!.grid.rows();
    const crowd = grow([plant({ id: "a", x: 10, stem: 24 }), plant({ id: "b", x: 19 }), plant({ id: "c", x: 28, stem: 20 })]).sprites[0]!.grid.rows();
    expect(crowd).toEqual(solo);
  });
  it("steps one tick at a time and reports when every plant is done", () => {
    const b = buildGarden([plant({})], 40, 40, "d");
    expect(gardenFinished(b)).toBe(false);
    let n = 0;
    while (stepGarden(b) && n < 500) n++;
    expect(gardenFinished(b)).toBe(true);
    expect(n).toBeLessThanOrEqual(b.ticks);
  });
  it("empty day: bare soil, grass line and one sprout", () => {
    const b = grow([sproutPlant(40)]);
    const g = compose(b);
    expect(g.count("=")).toBe(40);
    expect(g.count("|")).toBeGreaterThanOrEqual(3);
    expect(b.sprites).toHaveLength(1);
  });
  it("runs fast: 200 sessions at 384 cells build and grow in a frame or two", () => {
    const g = plantsForDay(many(200, { messageCount: 60 }), opts({ width: 384, blooms: (id) => id.length % 3 === 0 }));
    const t = performance.now();
    const b = buildGarden(g.plants, 384, 40, "2026-09-30");
    runGarden(b);
    const ms = performance.now() - t;
    expect(g.plants.length).toBe(capacity(384));
    expect(ms).toBeLessThan(50); // measured ~3 ms on an idle machine; generous for a loaded one
  });
});

describe("plantAt / labels", () => {
  const p = (x: number, stem = 10): Plant => ({ id: `p${x}`, title: "T", x, stem, colour: 0, bloom: true, live: false, startedAt: 0 });
  it("hits the plant near the column within its height, else nothing", () => {
    const plants = [p(10), p(20)];
    expect(plantAt(plants, 11, 40, 45)?.id).toBe("p10");
    expect(plantAt(plants, 15, 40, 45)).toBeNull();
    expect(plantAt(plants, 10, 10, 45)).toBeNull();
    expect(plantAt(plants, 10, 46, 45)).toBeNull();
  });
  it("label counts sessions and blooms", () => {
    expect(gardenLabel([p(1), { ...p(9), bloom: false }])).toBe("Today's garden: 2 sessions, 1 in bloom");
    expect(gardenLabel([p(1)])).toBe("Today's garden: 1 session, 1 in bloom");
  });
  it("the seed key is the local date", () => {
    expect(localDayKey(NOON)).toBe("2026-09-30");
  });
});
