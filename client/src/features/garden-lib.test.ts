import { describe, expect, it } from "vitest";
import { Grid, Program, compileRule, hashSeed, mulberry32, type Node } from "./garden-lib";

function grid(rows: string[]): Grid {
  const g = new Grid(rows[0]!.length, rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => g.set(x, y, c)));
  return g;
}

describe("seeded rng", () => {
  it("same seed gives the same sequence, different seeds differ", () => {
    const a = mulberry32(hashSeed("2026-09-30"));
    const b = mulberry32(hashSeed("2026-09-30"));
    const c = mulberry32(hashSeed("2026-10-01"));
    const sa = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(sa);
    expect(Array.from({ length: 5 }, c)).not.toEqual(sa);
    expect(sa.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});

describe("compileRule", () => {
  it("mirror and rotate add distinct orientations only", () => {
    expect(compileRule({ in: ["a."], out: ["ab"] })).toHaveLength(1);
    expect(compileRule({ in: ["a."], out: ["ab"], mirror: true })).toHaveLength(2);
    expect(compileRule({ in: ["a"], out: ["b"], mirror: true, rotate: true })).toHaveLength(1);
    expect(compileRule({ in: ["a."], out: ["ab"], rotate: true })).toHaveLength(4);
  });
  it("a ragged or mismatched rule compiles to nothing", () => {
    expect(compileRule({ in: ["ab", "c"], out: ["ab", "c"] })).toEqual([]);
    expect(compileRule({ in: ["a"], out: ["ab"] })).toEqual([]);
    expect(compileRule({ in: [], out: [] })).toEqual([]);
  });
});

describe("one vs all", () => {
  const rules = [{ in: ["a"], out: ["b"] }];
  it("one rewrites exactly one match per step", () => {
    const g = grid(["aaaa"]);
    const p = new Program(g, [{ kind: "one", rules }], mulberry32(1));
    p.step();
    expect(g.count("b")).toBe(1);
    expect(g.count("a")).toBe(3);
  });
  it("all rewrites every non-overlapping match in one step", () => {
    const g = grid(["aaaa"]);
    new Program(g, [{ kind: "all", rules }], mulberry32(1)).step();
    expect(g.rows()).toEqual(["bbbb"]);
  });
  it("all skips matches that would overwrite the same cells", () => {
    const g = grid(["aaa"]);
    // "aa" -> "bb" overlaps itself in the middle: only one of the two matches can apply per sweep.
    new Program(g, [{ kind: "all", rules: [{ in: ["aa"], out: ["bb"] }] }], mulberry32(3)).step();
    expect(g.count("b")).toBe(2);
    expect(g.count("a")).toBe(1);
  });
  it("an all sweep never undoes its own writes: overlapping footprints apply one at a time", () => {
    // a -> x and ab -> ac both write the `a` cell; only one may fire per sweep, whichever order the rng picks.
    const results = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const g = grid(["ab"]);
      new Program(g, [{ kind: "all", rules: [{ in: ["a"], out: ["x"] }, { in: ["ab"], out: ["ac"] }] }], mulberry32(seed)).step();
      results.add(g.rows()[0]!);
    }
    expect([...results].sort()).toEqual(["ac", "xb"]);
  });
  it("a rule that changes nothing ends its node instead of spinning", () => {
    const g = grid(["a"]);
    const p = new Program(g, [{ kind: "one", rules: [{ in: ["a"], out: ["a"] }] }, { kind: "all", rules: [{ in: ["a"], out: ["b"] }] }], mulberry32(1));
    expect(p.run()).toBe(1);
    expect(g.rows()).toEqual(["b"]);
  });
  it("steps caps a node, and a node with no match hands over to the next", () => {
    const g = grid(["aaaa"]);
    const nodes: Node[] = [{ kind: "one", rules, steps: 2 }, { kind: "all", rules: [{ in: ["b"], out: ["c"] }] }];
    const p = new Program(g, nodes, mulberry32(5));
    p.run();
    expect(g.count("c")).toBe(2);
    expect(g.count("a")).toBe(2);
    expect(p.finished).toBe(true);
  });
});

describe("mirroring and wildcards", () => {
  it("a mirrored rule fires on the flipped pattern", () => {
    const rule = { in: ["|."], out: ["|l"], mirror: true };
    const left = grid([".|"]);
    new Program(left, [{ kind: "one", rules: [rule] }], mulberry32(1)).step();
    expect(left.rows()).toEqual(["l|"]);
    const plain = grid([".|"]);
    new Program(plain, [{ kind: "one", rules: [{ in: ["|."], out: ["|l"] }] }], mulberry32(1)).step();
    expect(plain.rows()).toEqual([".|"]);
  });
  it("* matches anything in `in` and leaves the cell alone in `out`", () => {
    const g = grid(["xay"]);
    new Program(g, [{ kind: "one", rules: [{ in: ["*a*"], out: ["*b*"] }] }], mulberry32(1)).step();
    expect(g.rows()).toEqual(["xby"]);
  });
  it("patterns don't wrap around or read outside the grid", () => {
    const g = grid(["a.", ".."]);
    const p = new Program(g, [{ kind: "all", rules: [{ in: ["aa"], out: ["bb"] }] }], mulberry32(1));
    expect(p.step()).toBe(false);
  });
});

describe("determinism", () => {
  const nodes: Node[] = [{ kind: "one", rules: [{ in: [".", "a"], out: ["a", "|"] }], steps: 4 }, { kind: "all", rules: [{ in: ["*.", "|."], out: ["*.", "|l"], mirror: true }] }];
  const make = (seed: string): string[] => {
    const g = new Grid(9, 8, ".");
    for (const x of [1, 4, 7]) g.set(x, 7, "a");
    new Program(g, nodes, mulberry32(hashSeed(seed))).run();
    return g.rows();
  };
  it("same seed and inputs give the same grid; another seed can differ", () => {
    expect(make("s")).toEqual(make("s"));
    expect(new Set(["s", "t", "u", "v", "w", "x"].map(make).map((r) => r.join("/"))).size).toBeGreaterThan(1);
  });
  it("run() is capped so a rule set that never settles cannot hang", () => {
    const g = grid(["ab"]);
    const p = new Program(g, [{ kind: "one", rules: [{ in: ["a"], out: ["b"] }, { in: ["b"], out: ["a"] }] }], mulberry32(1));
    expect(p.run(50)).toBe(50);
  });
});
