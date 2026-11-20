import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { mergeNotes, validateNotes } from "../../scripts/merge-project-notes.mjs";
// @ts-expect-error -- plain .mjs script without type declarations
import { headLines } from "../../scripts/project-notes-evidence.mjs";

type Result = { notes?: Record<string, unknown>; why?: string };
const validate = validateNotes as (v: unknown) => Result;
const merge = mergeNotes as (old: Record<string, unknown>, fresh: Record<string, unknown>, names?: Record<string, string>) => { out: Record<string, Record<string, unknown>>; counts: Record<string, number> };
const lines = headLines as (t: string, n: number) => string;

const good = { desc: "A tool.", longDesc: "More.", milestones: ["2026-09: shipped x"], nextSteps: [], started: "2026-01", liveUrl: "https://a.dev", asOf: "2026-10-14", sources: ["README"] };

describe("merge-project-notes validation", () => {
  it("accepts a well-formed entry", () => {
    expect(validate(good).notes).toMatchObject({ desc: "A tool.", started: "2026-01", sources: ["README"] });
  });
  it("rejects over-long, non-string, bad-url, bad-date and over-count entries", () => {
    for (const bad of [{ desc: "x".repeat(141) }, { longDesc: "x".repeat(501) }, { milestones: Array(7).fill("m") }, { nextSteps: [1] }, { liveUrl: "javascript:alert(1)" }, { started: "2026-13" }, { asOf: "today" }, { sources: "README" }]) {
      expect(validate({ ...good, ...bad }).notes).toBeUndefined();
    }
    expect(validate(null).notes).toBeUndefined();
  });
});

describe("mergeNotes", () => {
  it("replaces fresh ids (keyed by name), keeps the rest marked stale, counts rejects", () => {
    const old = { Alpha: { desc: "old" }, Beta: { desc: "keep" } };
    const { out, counts } = merge(old, { alpha: good, gamma: { desc: 5 } }, { alpha: "Alpha" });
    expect(out.Alpha).toMatchObject({ desc: "A tool.", asOf: "2026-10-14" });
    expect(out.Alpha?.stale).toBeUndefined();
    expect(out.Beta).toEqual({ desc: "keep", stale: true });
    expect(counts).toEqual({ updated: 1, kept: 1, rejected: 1 });
  });
});

describe("evidence line filter", () => {
  it("drops secret-looking lines and caps the line count", () => {
    expect(lines("a\nsk-abc123\nghp_x\n-----BEGIN KEY\nb", 10)).toBe("a\nb");
    expect(lines("1\n2\n3", 2)).toBe("1\n2");
  });
});
