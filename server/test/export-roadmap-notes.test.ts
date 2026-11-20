import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { parseLiteral, projectMetaOf } from "../../scripts/export-roadmap-notes.mjs";

const parse = parseLiteral as (src: string) => unknown;
const metaOf = projectMetaOf as (code: string) => Record<string, unknown>;

describe("export-roadmap-notes literal parser (never evaluates the roadmap's code)", () => {
  it("reads the PROJECT_META shape: bare and quoted keys, single quotes, plain templates, comments, trailing commas", () => {
    const code = `const x = 1;\nconst PROJECT_META = {\n  // a comment\n  'my-app': { desc: 'It\\'s live', started: "2026-01-02", milestones: [\`one\`, "two",], n: -1.5, ok: true, url: null, /* note */ },\n  other: {},\n};\nfunction f() {}\n`;
    expect(metaOf(code)).toEqual({ "my-app": { desc: "It's live", started: "2026-01-02", milestones: ["one", "two"], n: -1.5, ok: true, url: null }, other: {} });
  });

  it("refuses anything that is not a literal instead of running it", () => {
    for (const bad of ["{ a: process.exit(1) }", "{ a: b }", "{ a: `x${1}` }", "{ ...other }", "{ a: 'x' + 'y' }", "{ a: (() => 1)() }", "{ a: 1 } ; evil()"]) {
      expect(() => parse(bad), bad).toThrow(/not a plain literal/);
    }
  });

  it("decodes escapes and keeps a __proto__ key as plain data", () => {
    const v = parse(`{ "__proto__": { polluted: true }, s: "\\u00e9\\x41\\n" }`) as Record<string, unknown>;
    expect(v.s).toBe("éA\n");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fails loudly when PROJECT_META is missing", () => {
    expect(() => metaOf("const OTHER = {};\n")).toThrow(/PROJECT_META not found/);
  });
});
