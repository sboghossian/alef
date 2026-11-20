// WCAG contrast for the colour pairs the chrome actually draws, computed from the palette in
// style.css rather than copied into the test, so moving a token re-checks every pair it is in.
// Text needs 4.5:1 (AA, normal size); a focus ring is a non-text indicator and needs 3:1.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const style = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "style.css"), "utf8");
const root = style.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

/** A palette token's hex value, following var() aliases (--focus-ring: var(--sky)). */
function token(name: string): string {
  const v = root.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (!v) throw new Error(`--${name} is not in style.css :root`);
  const alias = v.match(/^var\(--([\w-]+)\)$/);
  return alias ? token(alias[1]!) : v;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG ratio between two colours, given as tokens or #hex. */
function ratio(a: string, b: string): number {
  const la = luminance(a.startsWith("#") ? a : token(a));
  const lb = luminance(b.startsWith("#") ? b : token(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("palette contrast", () => {
  // [foreground, background, minimum, where it is drawn]
  const pairs: [string, string, number, string][] = [
    ["pink-text", "cream", 4.5, "pink text (inbox wait, kicker, agenda, claude-fm status)"],
    ["pink-text", "paper", 4.5, "pink text on a card"],
    ["ink", "pink", 4.5, "label on a pink primary button (canvas .cv-primary, Code tab badge)"],
    ["cream", "ink", 4.5, "a selected control's label, and its meta line (--ch-on-ink on --ch-on)"],
    ["muted", "cream", 4.5, "an unselected sub-mode in the top bar"],
    ["muted", "paper", 4.5, "a view header's sub line"],
    ["focus-ring", "cream", 3, "the focus ring on the bars"],
    ["focus-ring", "paper", 3, "the focus ring on a card"],
    ["focus-ring", "yellow", 3, "the focus ring on a yellow head"],
    // The semantic palette's text colours, on the surfaces and washes the views draw them on.
    ["bad-text", "paper", 4.5, "a failure line on a card"],
    ["bad-text", "pink-wash", 4.5, "an error banner"],
    ["ok-text", "ok-wash", 4.5, "a success chip"],
    ["amber-text", "yellow-wash", 4.5, "a warning note on a yellow wash"],
    ["amber-text", "cream", 4.5, "a warning note on the page"],
    ["muted", "yellow-soft", 4.5, "a meta line on the strongest yellow wash"],
    ["muted", "sky-wash", 4.5, "a meta line on a lavender panel"],
    ["muted", "pink-wash", 4.5, "a meta line on a pink wash"],
    ["sky", "paper", 4.5, "a link"],
  ];
  for (const [fg, bg, min, where] of pairs)
    it(`--${fg} on --${bg} clears ${min}:1 (${where})`, () => {
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
    });

  it("still needs --pink-text: --pink itself fails as text, and white fails on it", () => {
    expect(ratio("pink", "cream")).toBeLessThan(4.5);
    expect(ratio("#ffffff", "pink")).toBeLessThan(4.5);
  });
});
