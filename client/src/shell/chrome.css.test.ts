// The chrome tokens (shell/chrome.css) are only worth having if the shell CSS actually reads
// them: a single literal left behind is a value that will not move when the frame's weight is
// dialled, and the next person copies the literal rather than the token. There is no CSSOM
// harness in this project (no jsdom), so these are content checks over the stylesheets as
// text -- the same lightweight approach as shell.css.test.ts -- and they assert nothing about
// how any of it renders.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(join(here, f), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");

const chrome = read("chrome.css");
/** The three stylesheets that draw the shell's frame, without their comments. */
const SHEETS = ["shell.css", "sidebar.css", "feed-ui.css"] as const;
const sheets = SHEETS.map((f) => [f, strip(read(f))] as const);

/** The text of every view and feature stylesheet, without comments. */
function viewAndFeatureCss(): string[] {
  const src = join(here, "..");
  return ["views", "features"].flatMap((dir) =>
    readdirSync(join(src, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".css"))
      .map((f) => strip(readFileSync(join(src, dir, f), "utf8"))),
  );
}

/** Every declaration of `prop` across the three sheets, as [file, value] pairs. */
function decls(prop: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [file, css] of sheets)
    for (const m of css.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]+)`, "g")))
      out.push([file, m[1]!.trim().replace(/\s+/g, " ")]);
  return out;
}

describe("chrome.css defines the frame's weight in one place", () => {
  it("keeps the radius ramp derived from --ch-r, so one number moves the family", () => {
    expect(chrome).toMatch(/--ch-r:\s*\d/);
    for (const step of ["in", "out", "pane", "field", "seg", "chip", "tag"])
      expect(chrome, `--ch-r-${step} must stay on the ramp`).toMatch(
        new RegExp(`--ch-r-${step}:\\s*calc\\(var\\(--ch-r\\)`),
      );
  });

  it("builds every drop-shadow out of the four depth steps", () => {
    for (const name of ["sm", "md", "lg", "xl", "sm-hot", "md-hot", "sm-flip"])
      expect(chrome, `--ch-sh-${name}`).toMatch(
        new RegExp(`--ch-sh-${name}:[^;]*var\\(--ch-d\\d\\)`),
      );
  });

  it("draws shadows in palette colours, so a theme change carries", () => {
    const shadows = [...chrome.matchAll(/--ch-(?:sh|edge)[\w-]*:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(shadows.length).toBeGreaterThan(8);
    for (const v of shadows)
      expect(v, `"${v}" must end in a var(), not a baked colour`).toMatch(/var\(--[\w-]+\)\s*$/);
  });

  // The views and features read the tokens too, so a token only they use is not dead.
  it("has no dead tokens: everything it defines is used by the shell, view or feature CSS", () => {
    const defined = [...chrome.matchAll(/^\s*(--ch-[\w-]+):/gm)].map((m) => m[1]!);
    expect(defined.length).toBeGreaterThan(20);
    const all = [...sheets.map(([, css]) => css), strip(chrome), ...viewAndFeatureCss()].join("\n");
    for (const t of defined)
      expect(all.split(`var(${t})`).length - 1, `${t} is defined but never used`).toBeGreaterThan(0);
  });
});

describe("the shell CSS reads the tokens instead of repeating literals", () => {
  it("has no literal drop-shadow left", () => {
    for (const [file, v] of decls("box-shadow"))
      expect(v, `${file}: box-shadow: ${v}`).toMatch(/^(none|var\(--ch-[\w-]+\))$/);
  });

  // `border: 0` and `border: none` are "no border at all", not a width, so they stay as they
  // are. What must not come back is a measured width written out in px.
  it("has no literal border width left", () => {
    for (const [file, v] of decls("border(?:-top|-bottom|-left|-right)?"))
      expect(v, `${file}: border: ${v}`).not.toMatch(/^[\d.]+px/);
  });

  // 50% means "a circle" and 999px means "a pill": both are shapes, not steps on the ramp, so
  // they stay literal on purpose. Every radius measured in px is a token.
  it("has no literal px radius left, bar the pill", () => {
    for (const [file, v] of decls("border-radius")) {
      const px = v.split(/\s+/).filter((p) => /px$/.test(p) && p !== "999px");
      expect(px, `${file}: border-radius: ${v}`).toEqual([]);
    }
  });
});

describe("one selected style", () => {
  it("defines it once, in the chrome's role tokens, for pressed, selected and .on", () => {
    expect(strip(chrome)).toMatch(
      /\.ch-seg\.ch-seg > :is\(\[aria-pressed="true"\], \[aria-selected="true"\], \.on\) \{\s*background: var\(--ch-on\);\s*color: var\(--ch-on-ink\);/,
    );
  });

  it("is what Library, Code, Health and the top bar use, instead of their own fills", () => {
    const src = join(here, "..");
    const css = (f: string): string => strip(readFileSync(join(src, f), "utf8"));
    expect(css("views/library.css")).not.toMatch(/aria-pressed="true"\]\s*\{[^}]*background/);
    expect(css("views/code.css")).not.toMatch(/(?:aria-pressed="true"\]|aria-selected="true"\]|\.cdv-phone-tab\.cdv-on)\s*\{[^}]*background/);
    expect(css("views/health.css")).not.toMatch(/hv-(?:tab|preset)-active/);
    expect(css("shell/shell.css")).not.toMatch(/\.alef-sub-btn\.on\s*\{/);
    for (const [f, cls] of [
      ["views/library.ts", '"lib-lens ch-seg"'],
      ["views/code.ts", '"cdv-box-head cdv-panel-tabs ch-seg"'],
      ["views/code.ts", '"cdv-seg ch-seg"'],
      ["views/health.ts", '"hv-presets ch-seg"'],
      ["views/health.ts", '"hv-tabs ch-seg"'],
      ["shell/shell.ts", '"alef-views-subs ch-seg"'],
    ] as const)
      expect(readFileSync(join(src, f), "utf8"), `${f} should mark ${cls}`).toContain(cls);
  });
});

// The views and features have not been moved onto the tokens yet: they still carry their own
// drop-shadows, hex colours and px font sizes by the hundred. Until a later pass drives those
// down, this is a ratchet: the counts may fall (lower the baseline when they do) but never rise,
// so new view CSS reaches for var(--ch-*) / var(--fs-*) / the palette instead of a literal.
describe("view and feature CSS: literals only ever go down", () => {
  const src = join(here, "..");
  const files = ["views", "features"].flatMap((dir) =>
    readdirSync(join(src, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".css"))
      .map((f) => join(dir, f)),
  );
  const count = (re: RegExp): { total: number; by: string } => {
    const per = files.map((f) => [f, strip(readFileSync(join(src, f), "utf8")).match(re)?.length ?? 0] as const);
    const by = per.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f} ${n}`).join(", ");
    return { total: per.reduce((s, [, n]) => s + n, 0), by };
  };
  /** Measured on main with the climb (#105) and all of waves 1-2 (#106-#113) in, lowered by Wave
   *  12's five destinations (the Brain tab bar on tokens), then by "tokens everywhere", which moved
   *  every view and feature onto --ch-*, the palette and the type scale (134 / 800 / 443 before).
   *  What is left is deliberate: categorical series colours, status halos, hero display sizes.
   *  Lower these as the counts fall. */
  const BASELINE = { boxShadow: 12, hex: 20, fontPx: 9 };
  const LITERALS = {
    // a box-shadow that is not none and not built only from var()s
    boxShadow: /box-shadow\s*:(?!\s*(?:none|var\(--[\w-]+\)(?:\s*,\s*var\(--[\w-]+\))*)\s*[;}])[^;}]+/g,
    hex: /#[0-9a-fA-F]{3,8}\b/g,
    // font-size: 12px, or a font: shorthand whose size is in px
    fontPx: /(?<![-\w])font(?:-size)?\s*:[^;}]*?\b\d+(?:\.\d+)?px/g,
  } as const;

  it("defines a six-step type scale for them to read", () => {
    const style = readFileSync(join(src, "style.css"), "utf8");
    for (const step of ["xs", "sm", "body", "md", "lg", "xl"])
      expect(style, `--fs-${step}`).toMatch(new RegExp(`--fs-${step}:\\s*\\S`));
  });

  for (const key of Object.keys(LITERALS) as (keyof typeof LITERALS)[])
    it(`has no more literal ${key} than the baseline (${BASELINE[key]})`, () => {
      const { total, by } = count(LITERALS[key]);
      expect(files.length).toBeGreaterThan(20);
      expect(total, `${key}: ${total} now, baseline ${BASELINE[key]}. Most in: ${by}`).toBeLessThanOrEqual(BASELINE[key]);
    });
});
