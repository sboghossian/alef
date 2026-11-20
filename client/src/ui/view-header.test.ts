import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { viewHeader } from "./view-header";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "view-header.css"), "utf8");

describe("viewHeader", () => {
  it("draws the view's line icon before an escaped title", () => {
    const html = viewHeader("Board <b>", undefined, undefined, { icon: "board" });
    expect(html).toMatch(/^<header class="view-head"><h2 class="view-head-title"><span class="view-head-ico" aria-hidden="true"><svg class="alef-ico"/);
    expect(html).toContain("Board &lt;b&gt;</h2>");
  });

  it("leaves the icon out when the name has none, rather than falling back to an emoji", () => {
    expect(viewHeader("Nowhere", undefined, undefined, { icon: "no-such-icon" })).not.toContain("view-head-ico");
  });

  it("renders a sub line only when one is given, even an empty one to fill in later", () => {
    expect(viewHeader("A")).not.toContain("view-head-sub");
    expect(viewHeader("A", "")).toContain('<p class="view-head-sub"></p>');
    expect(viewHeader("A", "x & y")).toContain('<p class="view-head-sub">x &amp; y</p>');
  });

  it("passes the actions through as HTML and adds the view's own class", () => {
    const html = viewHeader("Health", "s", '<div class="hv-tabs"></div>', { className: "hv-head" });
    expect(html).toContain('<header class="view-head hv-head">');
    expect(html).toContain('<div class="view-head-actions"><div class="hv-tabs"></div></div>');
  });

  it("is 22px / 700 in the display face, upright and in its own case", () => {
    const title = css.match(/\.view-head-title\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(title).toMatch(/font:\s*700 22px\/1\.2 var\(--display\)/);
    expect(title).not.toMatch(/italic|text-transform/);
    expect(css).toMatch(/\.view-head-sub\s*\{[^}]*color:\s*var\(--muted\)/);
  });
});
