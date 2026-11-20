import { describe, expect, it } from "vitest";
import { activeFilterChips, clearedFilterState, initialFilterState, orderListRows, removeChip, setSearchText, type FilterSpec } from "./views";

const specs: FilterSpec[] = [
  { id: "time", label: "Time", type: "segmented", options: [{ value: "all", label: "All" }, { value: "today", label: "Today" }] },
  { id: "cols", label: "Columns", type: "chips", multi: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
  { id: "memory", label: "Memory only", type: "toggle" },
  { id: "q", label: "Search the vault", type: "search" },
  { id: "tree", label: "Explorer", type: "section", render: () => undefined },
];

describe("search + section specs", () => {
  it("search keeps trimmed text, section has no state", () => {
    const s = initialFilterState(specs, { q: ["  hello "], tree: ["x"] });
    expect(s.q).toEqual(["hello"]);
    expect("tree" in s).toBe(false);
    expect(setSearchText(s, specs[3]!, "   ").q).toEqual([]);
    expect(setSearchText(s, specs[3]!, " vault ").q).toEqual(["vault"]);
  });
});

describe("active filter chips", () => {
  it("lists only narrowing values, with labels", () => {
    const s = initialFilterState(specs, { time: ["today"], cols: ["a", "b"], memory: ["on"], q: ["notes"] });
    expect(activeFilterChips(specs, s).map((c) => c.label)).toEqual(["Today", "Alpha", "Beta", "Memory only", "“notes”"]);
    expect(activeFilterChips(specs, initialFilterState(specs))).toEqual([]);
  });
  it("removeChip drops one value; segmented goes back to its first option", () => {
    const s = initialFilterState(specs, { time: ["today"], cols: ["a", "b"] });
    const [time, alpha] = activeFilterChips(specs, s);
    expect(removeChip(specs, s, time!).time).toEqual(["all"]);
    expect(removeChip(specs, s, alpha!).cols).toEqual(["b"]);
  });
  it("a group sitting at its own default is a choice, not an active filter", () => {
    const withDefault: FilterSpec[] = [{ id: "repo", label: "Repo", type: "list", default: ["r1"], options: [{ value: "r1", label: "one" }, { value: "r2", label: "two" }] }];
    expect(activeFilterChips(withDefault, initialFilterState(withDefault))).toEqual([]);
    expect(activeFilterChips(withDefault, { repo: ["r2"] }).map((c) => c.label)).toEqual(["two"]);
  });
  it("a segmented group resting on its default is not active; reset goes back to it", () => {
    const seg: FilterSpec[] = [{ id: "pace", label: "Pause", type: "segmented", default: ["normal"], options: [{ value: "snappy", label: "Snappy" }, { value: "normal", label: "Normal" }] }];
    expect(activeFilterChips(seg, initialFilterState(seg))).toEqual([]);
    const s = { pace: ["snappy"] };
    expect(activeFilterChips(seg, s).map((c) => c.label)).toEqual(["Snappy"]);
    expect(removeChip(seg, s, activeFilterChips(seg, s)[0]!).pace).toEqual(["normal"]);
    expect(clearedFilterState(seg).pace).toEqual(["normal"]);
  });
  it("clearedFilterState resets everything", () => {
    const c = clearedFilterState(specs);
    expect(c).toEqual({ time: ["all"], cols: [], memory: [], q: [] });
    expect(activeFilterChips(specs, c)).toEqual([]);
  });
});

describe("orderListRows", () => {
  const rows = [
    { value: "b", label: "beta", count: 1 },
    { value: "a", label: "Alpha", count: 5 },
    { value: "c", label: "gamma", count: 9, activity: 0 },
  ];
  it("pins first in pin order, then by activity (activity overrides count) or A–Z", () => {
    expect(orderListRows(rows, "activity", []).map((r) => r.value)).toEqual(["a", "b", "c"]);
    expect(orderListRows(rows, "name", []).map((r) => r.value)).toEqual(["a", "b", "c"]);
    expect(orderListRows(rows, "given", ["c", "b"]).map((r) => r.value)).toEqual(["c", "b", "a"]);
    expect(orderListRows(rows, "name", ["zzz"]).map((r) => r.value)).toEqual(["a", "b", "c"]);
  });
});
