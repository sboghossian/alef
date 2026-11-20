// The view-group table is a presentation layer over the registry, so the invariants that keep
// it honest are: every registered view belongs to exactly one group, no group mixes planet
// views with flat ones (that would fire the planet fade on every sub-mode switch), and nothing
// can quietly disappear when a view is added or retired.
//
// There is no jsdom here and importing views/index.ts would pull in all 14 view modules, so the
// registry check reads that file as text — the same lightweight approach as shell.css.test.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VIEW_GROUPS,
  defaultViewFor,
  groupForKey,
  groupOf,
  groupedViewIds,
  groupingProblems,
  subButtonFor,
  switcherScrollLeft,
  ungroupedViewIds,
  visibleGroups,
  type ViewGroup,
} from "./groups";

const here = dirname(fileURLToPath(import.meta.url));

/** View ids registered in views/index.ts, read from source: `homeView` -> "home". */
function registeredViewIds(): string[] {
  const src = readFileSync(join(here, "..", "views", "index.ts"), "utf8");
  const block = /export const alefViews[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!block)
    throw new Error("could not find the alefViews array in views/index.ts");
  return [...block[1]!.matchAll(/(\w+)View\s*,/g)].map((m) =>
    m[1]!.toLowerCase(),
  );
}

/** Views that keep the shared 3D canvas live, read from each view module's `usesPlanet: true`. */
function planetViewIds(ids: readonly string[]): Set<string> {
  const planet = new Set<string>();
  for (const id of ids) {
    const src = readFileSync(join(here, "..", "views", `${id}.ts`), "utf8");
    if (/usesPlanet:\s*true/.test(src)) planet.add(id);
  }
  return planet;
}

describe("the group table", () => {
  it("covers every registered view exactly once", () => {
    const ids = registeredViewIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(groupingProblems(ids)).toEqual([]);
    expect(ungroupedViewIds(ids)).toEqual([]);
  });

  it("never mixes planet views with flat ones in one group", () => {
    const ids = registeredViewIds();
    const planet = planetViewIds(ids);
    // Guard the guard: if nothing reports usesPlanet the check below would pass vacuously.
    expect(planet.size).toBeGreaterThan(0);
    for (const g of VIEW_GROUPS) {
      const kinds = new Set(g.views.map((id) => planet.has(id)));
      expect(kinds.size, `group "${g.id}" mixes planet and flat views`).toBe(1);
    }
  });

  it("has unique group ids and no empty group", () => {
    expect(groupingProblems(groupedViewIds())).toEqual([]);
  });

  it("number keys 1–5 open the groups in bar order, and no view claims one of them", () => {
    expect(VIEW_GROUPS.map((g) => g.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(groupForKey("1")?.id).toBe("today");
    expect(groupForKey("4")?.id).toBe("brain");
    expect(groupForKey("9")).toBeNull();
    const groupKeys = new Set(VIEW_GROUPS.map((g) => g.key));
    for (const id of registeredViewIds()) {
      const src = readFileSync(join(here, "..", "views", `${id}.ts`), "utf8");
      const keys = [...(/\bkeys:\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
      for (const k of keys) expect(groupKeys.has(k), `view "${id}" claims group key "${k}"`).toBe(false);
    }
  });

  it("flags two groups sharing a key", () => {
    const bad: ViewGroup[] = [
      { id: "g", emoji: "", name: "G", key: "1", views: ["a"] },
      { id: "h", emoji: "", name: "H", key: "1", views: ["b"] },
    ];
    expect(groupingProblems(["a", "b"], bad)).toEqual(['key "1" opens both "g" and "h"']);
  });
});

describe("the five destinations (Wave 12 IA)", () => {
  it("are Today, Work, World, Brain, Setup on keys 1-5", () => {
    expect(VIEW_GROUPS.map((g) => `${g.key} ${g.name}`)).toEqual(["1 Today", "2 Work", "3 World", "4 Brain", "5 Setup"]);
  });

  it("put every view where the IA says", () => {
    const where = (id: string): string | undefined => groupOf(id)?.id;
    expect(["home", "board"].map(where)).toEqual(["today", "today"]);
    expect(["code", "canvas", "voice", "library"].map(where)).toEqual(["work", "work", "work", "work"]);
    expect(["orbit", "district", "room", "courier"].map(where)).toEqual(["world", "world", "world", "world"]);
    expect(["brain", "vault"].map(where)).toEqual(["brain", "brain"]);
    expect(["health", "system", "capabilities", "routines"].map(where)).toEqual(["setup", "setup", "setup", "setup"]);
  });

  it("makes Brain one destination: no sub-pills, the Vault lights it", () => {
    const brain = groupOf("brain")!;
    expect(brain.views).toEqual(["brain"]); // one view: the bar draws no sub-switcher (shell.ts renderSwitcher)
    expect(subButtonFor("vault", brain)).toBe("brain");
  });

  it("opens Setup on Health (the Fix queue), then Machine, Capabilities, Routines", () => {
    expect(groupOf("health")!.views).toEqual(["health", "system", "capabilities", "routines"]);
    expect(defaultViewFor(groupOf("health")!, null)).toBe("health");
  });

  it("has no Atlas view any more (it is Capabilities; #/atlas redirects)", () => {
    expect(registeredViewIds()).not.toContain("atlas");
    expect(registeredViewIds()).toContain("capabilities");
    expect(groupOf("atlas")).toBeNull();
  });
});

describe("groupOf", () => {
  it("finds the group holding a view", () => {
    expect(groupOf("orbit")?.id).toBe("world");
    expect(groupOf("brain")?.id).toBe("brain");
    expect(groupOf("health")?.id).toBe("setup");
  });

  it("returns null for a view no group claims", () => {
    expect(groupOf("nonesuch")).toBeNull();
  });

  it("claims a view reached from inside another, and lights its host's button", () => {
    const brain = groupOf("vault");
    expect(brain?.id).toBe("brain");
    expect(brain?.views).not.toContain("vault"); // no second button beside Brain
    expect(subButtonFor("vault", brain)).toBe("brain");
    expect(subButtonFor("health", groupOf("health"))).toBe("health");
    expect(ungroupedViewIds(["brain", "vault", "capabilities"])).toEqual([]);
  });

  it("flags an inside view whose host has no button in that group", () => {
    const bad: ViewGroup[] = [{ id: "g", emoji: "", name: "G", key: "1", views: ["a"], inside: { b: "c" } }];
    expect(groupingProblems(["a", "b", "c"], bad)).toEqual(['"b" in "g" lights "c", which has no button there']);
  });
});

describe("defaultViewFor", () => {
  const group: ViewGroup = {
    id: "g",
    emoji: "x",
    name: "G",
    key: "1",
    views: ["a", "b", "c"],
  };

  it("reopens the sub-mode last used in that group", () => {
    expect(defaultViewFor(group, "c")).toBe("c");
  });

  it("falls back to the first view when nothing is remembered", () => {
    expect(defaultViewFor(group, null)).toBe("a");
    expect(defaultViewFor(group, undefined)).toBe("a");
  });

  it("ignores a remembered view that no longer belongs to the group", () => {
    expect(defaultViewFor(group, "gone")).toBe("a");
  });
});

describe("ungroupedViewIds", () => {
  it("surfaces a newly registered view so it cannot vanish from the bar", () => {
    const ids = [...groupedViewIds(), "brand-new"];
    expect(ungroupedViewIds(ids)).toEqual(["brand-new"]);
  });
});

describe("visibleGroups", () => {
  it("drops views that are not registered", () => {
    const ids = groupedViewIds().filter((id) => id !== "courier");
    const world = visibleGroups(ids).find((g) => g.id === "world");
    expect(world?.views).not.toContain("courier");
    expect(world?.views).toContain("orbit");
  });

  it("drops a group left with no views at all", () => {
    const ids = groupedViewIds().filter(
      (id) => !["system", "health"].includes(id),
    );
    expect(visibleGroups(ids).map((g) => g.id)).not.toContain("system");
  });

  it("keeps every group when the full registry is present", () => {
    expect(visibleGroups(groupedViewIds()).map((g) => g.id)).toEqual(
      VIEW_GROUPS.map((g) => g.id),
    );
  });
});

// The escape hatch is the whole reason this is safe to ship: with the flag off the bar must be
// today's flat one-button-per-view row. No jsdom here, so this is a content check on shell.ts —
// it fails if the flag or the flat-bar branch is ever removed, which would make the grouping
// one-way. It asserts nothing about rendering.
describe("the shell keeps a way back to the flat bar", () => {
  const shell = readFileSync(join(here, "shell.ts"), "utf8");

  it("remembers the flag under its own key", () => {
    expect(shell).toMatch(/new Remembered\(storage, "view-groups"/);
  });

  it("falls back to the flat view buttons when the flag is off", () => {
    expect(shell).toMatch(/if \(groupsOn\.get\(\)\) \{/);
    expect(shell).toMatch(/\} else \{\s*groupSlot\.replaceChildren\(\.\.\.viewButtons\.values\(\)\);/);
  });

  // The wiring, not the arithmetic: switcherScrollLeft's own cases are above. This fails if the
  // bar ever goes back to calling scrollIntoView on the lit chip (which hid the group pill at
  // phone width), or if the flat-bar fallback is dropped -- with the flag off there are no
  // group pills, so without it nothing would be kept in sight at all.
  it("leaves the switcher's scroll to switcherScrollLeft, flat bar included", () => {
    expect(shell).toMatch(/switcher\.scrollLeft = switcherScrollLeft\(/);
    expect(shell).toMatch(/span\("\.alef-group-btn\.on", "\.alef-view-btn\.on"\)/);
    expect(shell, "scrollIntoView on the switcher is what this replaced").not.toMatch(
      /\.alef-sub-btn\.on"\)[\s\S]{0,200}scrollIntoView/,
    );
  });

  it("offers the toggle in Settings", () => {
    expect(shell).toMatch(/groupsOn\.toggle\(\)/);
    expect(shell).toMatch(/appSettings\.append\([^)]*groupsBtn/);
  });

  it("builds the group bar from the table, with Room's param as the one special case", () => {
    const block = /two-level switcher([\s\S]*?)function renderSwitcher/.exec(shell);
    expect(block, "the switcher block moved — update this test").toBeTruthy();
    // Room is the only view that opens with a param, so it is named on purpose. Every other id
    // must come from the table: a name here would mean a view the grouping could strand.
    expect(block![1], "Room must still open with its param, or #/room/<id> breaks").toMatch(
      /id === "room" \? roomParam\(\) : null/,
    );
    for (const id of groupedViewIds()) {
      if (id === "room") continue;
      expect(block![1], `view id "${id}" is hardcoded in the switcher`).not.toContain(`"${id}"`);
    }
  });
});

// The numbers below are the real phone measurement taken in Phase 5: a 233px strip, five 38px
// group pills with 4px gaps, a separator, then the active group's sub-mode chips. On a wide
// window every span already fits and nothing moves; it is only at this width that the two
// levels compete, so these are the cases that decide the rule.
describe("switcherScrollLeft", () => {
  const W = 233;
  const PILLS = [
    { left: 0, right: 38 }, // now
    { left: 42, right: 80 }, // world
    { left: 84, right: 122 }, // work
    { left: 126, right: 164 }, // mind
    { left: 168, right: 206 }, // system
  ] as const;

  it("does not scroll at all when everything already fits", () => {
    expect(switcherScrollLeft(0, 1200, { left: 214, right: 266 }, PILLS[0])).toBe(0);
  });

  it("keeps the active group pill on screen even when that costs the sub-mode chip", () => {
    // Home, in Now: the chip sits at 214-266 and wants scroll 33 -- which is exactly what the
    // bar did before this helper existed, hiding the lit pill 31px off the left edge.
    expect(switcherScrollLeft(0, W, { left: 214, right: 266 }, PILLS[0])).toBe(0);
  });

  it("shows both levels when they happen to fit together", () => {
    // Brain, in Mind: the pill is far enough along the strip that the chip can come in behind it.
    const s = switcherScrollLeft(0, W, { left: 214, right: 260 }, PILLS[3]);
    expect(s).toBe(27);
    expect(PILLS[3].left).toBeGreaterThanOrEqual(s); // pill still fully visible
    expect(PILLS[3].right).toBeLessThanOrEqual(s + W);
  });

  it("scrolls back when the lit pill has been left off to the left", () => {
    expect(switcherScrollLeft(120, W, null, PILLS[0])).toBe(0);
  });

  it("scrolls forward when the lit pill is off to the right", () => {
    expect(switcherScrollLeft(0, 100, null, PILLS[4])).toBe(106);
  });

  it("handles a group with no sub-switcher, and never returns a negative scroll", () => {
    expect(switcherScrollLeft(0, W, null, null)).toBe(0);
    expect(switcherScrollLeft(-50, W, null, null)).toBe(0);
  });
});
