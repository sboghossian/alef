// Regression (PR #29 review): no CSS at all was added for the i-stranded-* classes the Inbox's
// stranded-dispatches section renders, so Attach and the destructive Close… inherited the plain
// `.alef-inbox button` full-width card style and looked identical, with no danger colouring on
// Close. There is no DOM/CSSOM test harness in this project (no jsdom), so this is a lightweight
// content check: it fails if the selectors this fix added are ever removed, without asserting
// anything about how they render.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "shell.css"), "utf8");
const shellTs = readFileSync(join(here, "shell.ts"), "utf8");
const style = readFileSync(join(here, "..", "style.css"), "utf8");

describe("shell.css: stranded-dispatch rows", () => {
  it("styles the stranded row as its own card, not a bare list item", () => {
    expect(css).toMatch(/\.alef-stranded\s+\.i-stranded\s*\{/);
  });

  it("lays out Attach/Close as a compact action row, not two full-width cards", () => {
    expect(css).toMatch(/\.alef-stranded\s+\.i-stranded-actions\s*\{/);
  });

  it("gives Close its own danger colouring, distinct from Attach", () => {
    expect(css).toMatch(/\.i-btn-danger\s*\{/);
  });
});

// Backlog 0a: with no WebGL (or a lost context) body.alef-no-3d must hide every planet-pinned
// overlay a non-planet view hides, or labels / chips pinned to a planet nobody can see float over
// the banner. Read from the real rule, so an overlay added to one list and not the other fails here.
describe("shell.css: body.alef-no-3d hides everything body.alef-no-planet hides", () => {
  const hideList = (cls: string): string[] => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = [...bare.matchAll(/([^{}]+)\{\s*display:\s*none\s*!important;\s*\}/g)]
      .map((m) => m[1] ?? "")
      .find((sel) => sel.includes(`body.${cls} `));
    return (rule ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(`body.${cls} `))
      .map((x) => x.slice(`body.${cls} `.length));
  };

  it("finds both rules", () => {
    expect(hideList("alef-no-planet").length).toBeGreaterThan(5);
    expect(hideList("alef-no-3d").length).toBeGreaterThan(5);
  });

  it("covers every alef-no-planet overlay, plus the canvas and the fps chip", () => {
    const no3d = new Set(hideList("alef-no-3d"));
    for (const sel of hideList("alef-no-planet")) expect(no3d.has(sel), sel).toBe(true);
    expect(no3d.has("#app > :not(#alef-no3d)")).toBe(true);
    expect(no3d.has("#sb-fps")).toBe(true);
  });
});

// The two-level switcher (shell/groups.ts) renders group pills and sub-mode chips into the same
// one-row bar. Same lightweight content check as above: it fails if these selectors are removed,
// which would leave the group bar inheriting nothing and the sub-chips unstyled.
describe("shell.css: the group bar", () => {
  it("always shows a group button's name, unlike the emoji-only view buttons", () => {
    expect(css).toMatch(/\.alef-group-btn\s+\.alef-view-name\s*\{/);
  });

  it("styles the hairline between the groups and the active group's sub-modes", () => {
    expect(css).toMatch(/\.alef-sub-sep\s*\{/);
  });

  it("gives sub-mode chips their own quieter style, and a visible active state", () => {
    expect(css).toMatch(/\.alef-sub-btn\s*\{/);
    // The active one takes the shared selected style: its slot is a .ch-seg (chrome.css).
    expect(shellTs).toMatch(/class:\s*"alef-views-subs ch-seg"/);
  });

  it("shows unselected sub-modes at full opacity, muted rather than faded (it read as disabled)", () => {
    const rule = css.match(/\.alef-sub-btn\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--muted\)/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.alef-sub-btn[^{]*\{[^}]*opacity/);
  });

  it("keeps a focus ring on sub-mode chips — they are the only way into a sub-mode by mouse", () => {
    // No rule of its own any more: the global :focus-visible ring, which nothing here turns off.
    expect(style).toMatch(/^:focus-visible\s*\{[^}]*outline:\s*var\(--focus-w\) solid var\(--focus-ring\)/m);
    expect(css).not.toMatch(/\.alef-sub-btn[^{]*\{[^}]*outline:\s*(none|0)/);
  });

  it("pins the group pills in a column of their own, so they sit still while sub-modes change", () => {
    expect(css).toMatch(/#alef-views\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.alef-views-groups\s*\{[^}]*grid-column:\s*2/);
    expect(css).toMatch(/\.alef-views-subs\s*\{[^}]*grid-column:\s*3/);
    // A lit pill must not be wider than an unlit one, or the centred cluster shifts.
    expect(css).toMatch(/\.alef-group-btn,\s*\.alef-group-btn\.on\s*\{\s*padding:/);
  });

  it("hides the group names on a phone, where there is no room for five words", () => {
    expect(css).toMatch(/\.alef-group-btn\s+\.alef-view-name\s*\{\s*display:\s*none/);
  });
});

// A11Y-3: the dispatch text field has outline:none (style.css), so the box itself must show focus.
describe("shell.css: the dispatch box shows keyboard focus", () => {
  it("turns its shadow hot on :focus-within, with the chrome token the left search uses", () => {
    expect(css).toMatch(/#alef-prompt\s+#dispatch:focus-within\s*\{\s*box-shadow:\s*var\(--ch-sh-md-hot\);/);
  });
});

// VIS-12: feed cards are neutral; the kind is a stripe, not a pastel fill.
describe("shell.css + feed-ui.css: quiet feed cards", () => {
  const feedCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "feed-ui.css"), "utf8");
  const bare = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (s: string, sel: RegExp): string[] => [...bare(s).matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => sel.test(m[1] ?? "")).map((m) => m[2] ?? "");

  it("draws a kind stripe from --k on a paper card", () => {
    const card = rules(css, /^\s*\.alef-feed-item\s*$/).join("");
    expect(card).toMatch(/border-left:\s*var\(--ch-stripe\)\s+solid\s+var\(--k/);
    expect(card).toMatch(/background:\s*var\(--paper\)/);
  });

  it("no feed card or Town square row takes a literal colour fill", () => {
    for (const body of [...rules(css, /\.alef-feed-item/), ...rules(feedCss, /\.alef-feed-(item|top-item)/)]) expect(body).not.toMatch(/background:\s*#/);
  });

  it("clamps a command row's title to one monospace line with an ellipsis", () => {
    const cmd = rules(feedCss, /\.alef-feed-item\.cmd\s+\.alef-feed-title/).join("");
    expect(cmd).toMatch(/white-space:\s*nowrap/);
    expect(cmd).toMatch(/text-overflow:\s*ellipsis/);
    expect(cmd).toMatch(/monospace/);
  });
});

describe("shell: keyboard order", () => {
  it("puts the skip links, then the top bar, before the view in DOM order", () => {
    const order = shellTs.match(/frag\.append\(([^)]*)\)/)?.[1]?.split(",").map((x) => x.trim()) ?? [];
    expect(order.slice(0, 4)).toEqual(["skipMain", "skipFeed", "top", "main"]);
  });

  it("styles the skip links to appear only while focused", () => {
    expect(css).toMatch(/\.alef-skip\s*\{[^}]*transform:\s*translateY\(-200%\)/);
    expect(css).toMatch(/\.alef-skip:focus\s*\{\s*transform:\s*none/);
  });
});

// UX-12: H folds the side rails and nothing else. With the top bar gone the five destinations
// vanished with it, and you could not tell where you were. Read from the real rule.
describe("shell.css: H hides the side rails only", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hiddenBy = (cls: string): string[] =>
    [...bare.matchAll(/([^{}]+)\{\s*display:\s*none;?\s*\}/g)]
      .flatMap((m) => (m[1] ?? "").split(","))
      .map((x) => x.trim())
      .filter((x) => x.startsWith(`body.${cls} `))
      .map((x) => x.slice(`body.${cls} `.length));

  it("hides #alef-left and #alef-right", () => {
    expect(hiddenBy("aw-chrome-hidden").sort()).toEqual(["#alef-left", "#alef-right"]);
  });

  it("never hides the top bar, the prompt box or the status bar", () => {
    const sels = [...bare.matchAll(/([^{}]+)\{/g)].flatMap((m) => (m[1] ?? "").split(",")).map((x) => x.trim());
    const hiddenOnes = sels.filter((x) => x.startsWith("body.aw-chrome-hidden"));
    expect(hiddenOnes.length).toBeGreaterThan(0);
    for (const sel of hiddenOnes) expect(sel).not.toMatch(/#alef-top|#alef-prompt|#alef-bottom/);
  });

  it("still hides everything in focus and zen", () => {
    for (const mode of ["aw-focus", "aw-zen"]) expect(hiddenBy(mode)).toEqual(expect.arrayContaining(["#alef-top", "#alef-left", "#alef-right", "#alef-bottom", "#alef-prompt"]));
  });

  it("parks the Show panels pill under the top bar, not over it", () => {
    expect(bare).toMatch(/#alef-hidden-pill\s*\{[^}]*top:\s*calc\(var\(--alef-top\)/);
  });

  it("says so in Help", () => {
    const help = readFileSync(join(here, "..", "ui", "help.ts"), "utf8");
    expect(help).toMatch(/keys: \["H"\], what: "Hide the two side rails/);
  });
});

// UX-11: a view with no filters gets no left sidebar; empty and error states sit centred.
describe("shell.css: no empty left sidebar, one centred state", () => {
  it("hides the left sidebar on desktop while the view has nothing to filter", () => {
    expect(css).toMatch(/body\.alef-left-empty:not\(\.alef-phone\) #alef-left\s*\{\s*display:\s*none;/);
    expect(shellTs).toContain("hidesLeftSidebar(currentSpecs.length");
  });

  it("styles the shared view state, and its overlay form", () => {
    expect(css).toMatch(/\.alef-state\s*\{[^}]*justify-items:\s*center/);
    expect(css).toMatch(/\.alef-state-overlay\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.alef-state-action\s*\{/);
  });
});

// UX-7: three labelled rail tabs; Help is an overlay, not a tab.
describe("shell: the right rail", () => {
  it("builds one tab per RAIL_TABS entry with its word always shown", () => {
    expect(shellTs).toMatch(/for \(const t of RAIL_TABS\)/);
    // The old rule hid every label but the active tab's: it must not come back.
    expect(css).not.toMatch(/\.alef-tab:not\(\.on\) \.alef-tab-label/);
  });

  it("opens Help as a dialog over everything (?), not in a rail pane", () => {
    expect(shellTs).toContain('class: "ui-backdrop alef-help-backdrop"');
    expect(shellTs).toMatch(/if \(tab === "help"\) openHelp\(\)/);
    expect(shellTs).not.toContain('paneEls.get("help")');
  });

  it("keeps a pane switch inside Activity and Controls, on the shared selected style", () => {
    expect(shellTs).toContain('class: "alef-subtabs ch-seg"');
    expect(css).toMatch(/\.alef-rail-panel\[hidden\]\s*\{\s*display:\s*none;/);
  });
});
