import { describe, expect, it } from "vitest";
import type { ShelfBoardItem } from "../../../shared/features/shelf-board";
import { DEFAULT_SHELF_SECTIONS } from "../../../shared/features/shelf-seed";
import { menuEntries } from "./shelf-cards";
import { actionFor, artifactIdOf, districtCounts, hiddenAfter, matchesShelfFilter, NO_SHELF_FILTER, pinnedMap, projectForPath, safeHref, shelvesOf, shownKind, shownTitle, typeCounts } from "./shelf-lib";

function item(p: Partial<ShelfBoardItem> & Pick<ShelfBoardItem, "id" | "type">): ShelfBoardItem {
  return { url: null, path: null, title: p.id, kind: p.type, firstSeen: null, lastSeen: null, count: 1, sessions: [], district: null, source: "user", typed: false, score: 1, ...p };
}

const ITEMS = [
  item({ id: "gh", type: "github", title: "sboghossian/agent-world#84", kind: "PR #84", url: "https://github.com/sboghossian/agent-world/pull/84", district: "agent-world", typed: true }),
  item({ id: "ln", type: "linear", title: "TICK-2520", kind: "issue", district: "acme" }),
  item({ id: "lk", type: "link", title: "news.site/a", kind: "news.site", url: "https://news.site/a", district: "acme" }),
  item({ id: "fd", type: "folder", title: "agent-world", path: "/Users/s/Documents/Code/agent-world/client", district: "agent-world" }),
  item({ id: "ar", type: "artifact", title: "Justinian", url: "https://claude.ai/artifact/9AoBQEKbh1CLe91VE9evrG", hasPreview: true }),
];

describe("shelf view filters", () => {
  it("searches titles, URLs and kinds, and counts types under the other filters", () => {
    expect(ITEMS.filter((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, query: "agent-world" })).map((i) => i.id)).toEqual(["gh", "fd"]);
    expect(ITEMS.filter((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, types: ["link", "linear"] })).map((i) => i.id)).toEqual(["ln", "lk"]);
    expect(ITEMS.filter((i) => matchesShelfFilter(i, { ...NO_SHELF_FILTER, typedOnly: true })).map((i) => i.id)).toEqual(["gh"]);
    const f = { ...NO_SHELF_FILTER, types: ["github"], districts: ["acme"] };
    expect(typeCounts(ITEMS, f)).toMatchObject({ github: 0, linear: 1, link: 1, folder: 0, artifact: 0 });
    expect(districtCounts(ITEMS, { ...NO_SHELF_FILTER })).toEqual([{ id: "acme", count: 2 }, { id: "agent-world", count: 2 }]);
  });

  it("never searches hidden text under redact", () => {
    expect(matchesShelfFilter(ITEMS[0] as ShelfBoardItem, { ...NO_SHELF_FILTER, query: "sboghossian" }, true)).toBe(false);
    expect(matchesShelfFilter(ITEMS[0] as ShelfBoardItem, { ...NO_SHELF_FILTER, query: "github" }, true)).toBe(true);
    expect(shownTitle(ITEMS[0] as ShelfBoardItem, true, 2)).toBe("GitHub 3");
    expect(shownKind(ITEMS[0] as ShelfBoardItem, true)).toBe("PR #…");
    expect(shownKind(ITEMS[2] as ShelfBoardItem, true)).toBe("link");
    expect(shownTitle(ITEMS[0] as ShelfBoardItem, false, 2)).toBe("sboghossian/agent-world#84");
  });
});

describe("shelf view actions", () => {
  const projects = [{ id: "agent-world", path: "/Users/s/Documents/Code/agent-world" }, { id: "code", path: "/Users/s/Documents/Code" }];
  const pf = (p: string): string | null => projectForPath(p, projects);
  it("routes clicks: preview, projects drill-down, panel", () => {
    expect(actionFor(ITEMS[4] as ShelfBoardItem, pf)).toBe("preview");
    expect(actionFor({ ...(ITEMS[4] as ShelfBoardItem), hasPreview: false }, pf)).toBe("panel");
    expect(actionFor(ITEMS[3] as ShelfBoardItem, pf)).toBe("projects");
    expect(pf("/Users/s/Documents/Code/agent-world/client")).toBe("agent-world");
    expect(pf("/Users/s/Documents/Code/other")).toBe("code");
    expect(pf("/Users/s/Documents/Codex")).toBeNull();
    expect(actionFor(ITEMS[0] as ShelfBoardItem, pf)).toBe("panel");
    expect(artifactIdOf("https://claude.ai/code/artifact/abc-123/")).toBe("abc-123");
  });

  it("only links http(s)", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://news.site/a")).toBe("https://news.site/a");
  });

  it("lays out one shelf per section, Unsorted catching unknown ones", () => {
    const shelves = shelvesOf({
      sections: [...DEFAULT_SHELF_SECTIONS],
      pins: [
        { itemId: "a", section: "Growth", type: "link", url: null, path: null, title: "a", pinnedAt: "" },
        { itemId: "b", section: "Gone", type: "link", url: null, path: null, title: "b", pinnedAt: "" },
      ],
    });
    expect(shelves.map((s) => s.section)).toEqual([...DEFAULT_SHELF_SECTIONS]);
    expect(shelves.find((s) => s.section === "Growth")?.pins.map((p) => p.itemId)).toEqual(["a"]);
    expect(shelves.find((s) => s.section === "Unsorted")?.pins.map((p) => p.itemId)).toEqual(["b"]);
  });
});

describe("multi-shelf cards", () => {
  const pin = (itemId: string, section: string) => ({ itemId, section, type: "link" as const, url: null, path: null, title: itemId, pinnedAt: "" });
  it("maps an item to every shelf it sits on, and shows it on each", () => {
    const state = { sections: ["Product", "Growth", "Unsorted"], pins: [pin("a", "Product"), pin("b", "Growth"), pin("a", "Growth")] };
    expect([...pinnedMap(state.pins)]).toEqual([["a", ["Product", "Growth"]], ["b", ["Growth"]]]);
    expect(shelvesOf(state).map((s) => [s.section, s.pins.map((p) => p.itemId)])).toEqual([["Product", ["a"]], ["Growth", ["b", "a"]], ["Unsorted", []]]);
  });

  it("builds the ⋯ menu: move / also pin to the other shelves, unpin here or everywhere", () => {
    const calls: string[] = [];
    const env = { pinned: new Map([["a", ["Product", "Growth"]]]), sections: ["Product", "Growth", "Sales", "Unsorted"], pin: (id: string, s: string) => calls.push(`pin ${id} ${s}`), move: (id: string, f: string, t: string) => calls.push(`move ${id} ${f}>${t}`), unpin: (id: string, s?: string) => calls.push(`unpin ${id} ${s ?? "*"}`) };
    const onShelf = menuEntries("a", "Product", env);
    expect(onShelf.map((e) => ("heading" in e ? `# ${e.heading}` : e.label))).toEqual(["# Move to…", "Sales", "Unsorted", "# Also pin to…", "Sales", "Unsorted", "# Unpin", "Unpin from Product", "Unpin from all 2 shelves"]);
    for (const e of onShelf) if ("run" in e) e.run();
    expect(calls).toEqual(["move a Product>Sales", "move a Product>Unsorted", "pin a Sales", "pin a Unsorted", "unpin a Product", "unpin a *"]);
    expect(menuEntries("z", null, env).map((e) => ("heading" in e ? `# ${e.heading}` : e.label))).toEqual(["# Pin to…", "Product", "Growth", "Sales", "Unsorted"]);
  });

  it("counts the cards hidden past a row's right edge", () => {
    const cards = [0, 1, 2, 3, 4].map((i) => ({ left: i * 212, right: i * 212 + 200 }));
    expect(hiddenAfter(cards, 0, 760)).toBe(2); // the 4th is clipped, the 5th is off-screen
    expect(hiddenAfter(cards, 300, 760)).toBe(0);
    expect(hiddenAfter(cards, 0, 2000)).toBe(0);
  });
});
