import { describe, expect, it } from "vitest";
import {
  RAIL_PANES,
  RAIL_TABS,
  RIGHT_TABS,
  ViewHost,
  ViewRegistry,
  filtersActive,
  formatRoute,
  hidesLeftSidebar,
  initialFilterState,
  initialRoute,
  parseRoute,
  railPaneFor,
  railTabFor,
  resolveLegacyRoute,
  toggleFilter,
  type AlefView,
  type FilterSpec,
  type Selection,
  type ViewContext,
} from "./views";

describe("RIGHT_TABS", () => {
  it("still takes every old pane name for openRightTab, and no Inbox (Home's Needs you now is the Inbox)", () => {
    expect(RIGHT_TABS).toEqual(["loops", "feed", "mac", "help", "settings", "routines", "logs"]);
  });
});

describe("the rail's three labelled tabs (UX-7)", () => {
  it("is Activity (Feed + Logs), Loops, Controls (Mac, Routines, Settings)", () => {
    expect(RAIL_TABS.map((t) => [t.id, t.label, t.panes])).toEqual([
      ["activity", "Activity", ["feed", "logs"]],
      ["loops", "Loops", ["loops"]],
      ["controls", "Controls", ["mac", "routines", "settings"]],
    ]);
  });

  it("holds every pane but Help exactly once (Help is the ? overlay)", () => {
    expect([...RAIL_PANES].sort()).toEqual(RIGHT_TABS.filter((t) => t !== "help").sort());
    expect(new Set(RAIL_PANES).size).toBe(RAIL_PANES.length);
  });

  it("finds the labelled tab each old pane now sits under", () => {
    expect(railTabFor("feed")).toBe("activity");
    expect(railTabFor("logs")).toBe("activity");
    expect(railTabFor("loops")).toBe("loops");
    expect(railTabFor("mac")).toBe("controls");
    expect(railTabFor("routines")).toBe("controls");
    expect(railTabFor("settings")).toBe("controls");
  });

  it("opens a remembered or linked choice on a pane, falling back to the Feed", () => {
    expect(railPaneFor("logs")).toBe("logs");
    expect(railPaneFor("controls")).toBe("mac");
    expect(railPaneFor("activity")).toBe("feed");
    expect(railPaneFor("help")).toBe("feed");
    expect(railPaneFor("inbox")).toBe("feed");
    expect(railPaneFor(null)).toBe("feed");
  });
});

describe("hidesLeftSidebar (UX-11)", () => {
  it("hides it for a view with no filters", () => {
    expect(hidesLeftSidebar(0, false)).toBe(true);
  });

  it("keeps it while the search is wanted, and whenever there is something to filter", () => {
    expect(hidesLeftSidebar(0, true)).toBe(false);
    expect(hidesLeftSidebar(3, false)).toBe(false);
  });
});

const root = {} as HTMLElement;
const ctx = {} as ViewContext;

function fakeView(id: string, log: string[], extra: Partial<AlefView> = {}): AlefView {
  return {
    id,
    emoji: "•",
    name: id,
    mount: () => void log.push(`mount:${id}`),
    unmount: () => void log.push(`unmount:${id}`),
    ...extra,
  };
}

function host(views: AlefView[], log: string[], sel: Selection | null = null): { h: ViewHost; switched: string[] } {
  const switched: string[] = [];
  const h = new ViewHost({
    registry: new ViewRegistry(views),
    root: () => root,
    clearRoot: () => void log.push("clear"),
    ctx: () => ctx,
    filterState: () => ({ state: ["x"] }),
    onSwitched: (v, prev) => void switched.push(`${prev?.id ?? "-"}>${v.id}`),
    selection: () => sel,
    onMountError: (v) => void log.push(`error:${v.id}`),
  });
  return { h, switched };
}

describe("routes", () => {
  it("parses and formats #/<view>/<param>", () => {
    expect(parseRoute("#/orbit")).toEqual({ view: "orbit", param: null });
    expect(parseRoute("#/room/abc-123")).toEqual({ view: "room", param: "abc-123" });
    expect(parseRoute("#/Board")).toEqual({ view: "board", param: null });
    expect(parseRoute(formatRoute("room", "a/b c"))).toEqual({ view: "room", param: "a/b c" });
    expect(formatRoute("canvas")).toBe("#/canvas");
  });
  it("rejects non-view hashes", () => {
    for (const h of ["", "#", "#orbit", "#/", "#/1abc", "#/room/%E0%A4%A", "#/a b"]) expect(parseRoute(h)).toBeNull();
  });
});

describe("resolveLegacyRoute", () => {
  it("#/control-room lands on Room's multi-room grid", () => {
    expect(resolveLegacyRoute({ view: "control-room", param: null })).toEqual({ view: "room", param: "all" });
  });
  it("a stale #/one-on-one/<id> lands on that agent's Room", () => {
    expect(resolveLegacyRoute({ view: "one-on-one", param: "abc-123" })).toEqual({ view: "room", param: "abc-123" });
    expect(resolveLegacyRoute({ view: "one-on-one", param: null })).toEqual({ view: "room", param: null });
  });
  it("#/projects[/<id>] and #/shelf land in the Library, on the matching lens", () => {
    expect(resolveLegacyRoute({ view: "projects", param: null })).toEqual({ view: "library", param: null });
    expect(resolveLegacyRoute({ view: "projects", param: "acme" })).toEqual({ view: "library", param: "acme" });
    expect(resolveLegacyRoute({ view: "shelf", param: null })).toEqual({ view: "library", param: "lens:type" });
    expect(initialRoute("#/shelf", "", "home")).toEqual({ route: { view: "library", param: "lens:type" }, aliased: true });
    expect(initialRoute("", "?view=projects", "home").route.view).toBe("library");
  });
  it("#/atlas (the skills Atlas) lands on Setup › Capabilities; the Vault's #/vault/atlas is untouched", () => {
    expect(resolveLegacyRoute({ view: "atlas", param: null })).toEqual({ view: "capabilities", param: null });
    expect(initialRoute("#/atlas", "", "home")).toEqual({ route: { view: "capabilities", param: null }, aliased: true });
    const folders = { view: "vault", param: "atlas" };
    expect(resolveLegacyRoute(folders)).toBe(folders);
    expect(initialRoute("#/vault/people", "", "home")).toEqual({ route: { view: "vault", param: "people" }, aliased: false });
    expect(initialRoute("#/brain", "", "home")).toEqual({ route: { view: "brain", param: null }, aliased: false });
  });
  it("passes every other route through unchanged", () => {
    expect(resolveLegacyRoute({ view: "orbit", param: null })).toEqual({ view: "orbit", param: null });
    expect(resolveLegacyRoute({ view: "room", param: "xyz" })).toEqual({ view: "room", param: "xyz" });
  });
});

describe("ViewRegistry", () => {
  it("rejects duplicate ids, bad ids and clashing keys", () => {
    const l: string[] = [];
    expect(() => new ViewRegistry([fakeView("a", l), fakeView("a", l)])).toThrow(/duplicate view/);
    expect(() => new ViewRegistry([fakeView("A b", l)])).toThrow(/bad view id/);
    expect(() => new ViewRegistry([fakeView("a", l, { keys: ["b"] }), fakeView("c", l, { keys: ["B"] })])).toThrow(/used by both/);
    expect(() => new ViewRegistry([])).toThrow(/no views/);
  });
  it("maps keys case-insensitively and knows home", () => {
    const l: string[] = [];
    const r = new ViewRegistry([fakeView("orbit", l, { keys: ["1"] }), fakeView("board", l, { keys: ["6", "b"] })]);
    expect(r.forKey("B")).toBe("board");
    expect(r.forKey("6")).toBe("board");
    expect(r.forKey("x")).toBeUndefined();
    expect(r.home().id).toBe("orbit");
  });
});

describe("ViewHost", () => {
  it("unmounts the old view, clears root, mounts the new one, then replays filters + selection", () => {
    const log: string[] = [];
    const sel: Selection = { kind: "agent", id: "a1" };
    const board = fakeView("board", log, {
      onFilter: (s) => void log.push(`filter:${s.state?.join()}`),
      onSelect: (s) => void log.push(`select:${s?.id}`),
    });
    const { h, switched } = host([fakeView("orbit", log), board], log, sel);
    h.show("orbit");
    h.show("board");
    expect(log).toEqual(["mount:orbit", "unmount:orbit", "clear", "mount:board", "filter:x", "select:a1"]);
    expect(switched).toEqual(["->orbit", "orbit>board"]);
    expect(h.previousRoute()).toEqual({ view: "orbit", param: null });
  });

  it("is a no-op for the same route and uses onParam for a new param (else remounts)", () => {
    const log: string[] = [];
    const room = fakeView("room", log, { onParam: (p) => void log.push(`param:${p}`) });
    const plain = fakeView("plain", log);
    const { h } = host([room, plain], log);
    h.show("room", "a");
    h.show("room", "a");
    h.show("room", "b");
    expect(log).toEqual(["mount:room", "param:b"]);
    expect(h.route()).toEqual({ view: "room", param: "b" });
    log.length = 0;
    h.show("plain", "x");
    h.show("plain", "y");
    expect(log).toEqual(["unmount:room", "clear", "mount:plain", "unmount:plain", "clear", "mount:plain"]);
  });

  it("show() resolves retired ids, so showView(\"projects\", id) and showView(\"shelf\") reach the Library", () => {
    const log: string[] = [];
    const { h } = host([fakeView("orbit", log), fakeView("library", log)], log);
    expect(h.show("projects", "p1")).toEqual({ view: "library", param: "p1" });
    expect(h.show("shelf")).toEqual({ view: "library", param: "lens:type" });
  });

  it("falls back to home for unknown ids and survives throwing hooks", () => {
    const log: string[] = [];
    const bad = fakeView("bad", log, {
      mount: () => {
        throw new Error("boom");
      },
      unmount: () => {
        throw new Error("boom");
      },
    });
    const { h } = host([fakeView("orbit", log), bad], log);
    expect(h.show("nope", "p")).toEqual({ view: "orbit", param: null });
    h.show("bad");
    expect(log).toContain("error:bad");
    h.show("orbit");
    expect(h.current()?.id).toBe("orbit");
  });

  it("routes select / focus / escape to the active view only", () => {
    const log: string[] = [];
    const a = fakeView("a", log, { onFocus: (on) => void log.push(`focus-a:${on}`), onEscape: () => true });
    const b = fakeView("b", log, { onSelect: (s) => void log.push(`sel-b:${s?.id ?? "none"}`) });
    const { h } = host([a, b], log);
    h.show("a");
    h.focus(true);
    expect(h.escape()).toBe(true);
    h.select({ kind: "city", id: "c" });
    h.show("b");
    h.select({ kind: "city", id: "c2" });
    expect(h.escape()).toBe(false);
    expect(log.filter((x) => x.includes("-"))).toEqual(["focus-a:true", "sel-b:none", "sel-b:c2"]);
  });

  it("ignores an async mount that finishes after the user switched away", async () => {
    const log: string[] = [];
    let resolve: () => void = () => {};
    const slow = fakeView("slow", log, {
      mount: () => new Promise<void>((r) => (resolve = r)),
      onFilter: () => void log.push("slow-filter"),
    });
    const { h } = host([fakeView("orbit", log), slow], log);
    h.show("slow");
    h.show("orbit");
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).not.toContain("slow-filter");
  });
});

describe("filter state", () => {
  const specs: FilterSpec[] = [
    { id: "scope", label: "Time", type: "segmented", options: [{ value: "today", label: "Today" }, { value: "all", label: "All" }] },
    { id: "state", label: "State", type: "chips", multi: true, options: [{ value: "live", label: "Live" }, { value: "waiting", label: "Waiting" }] },
    { id: "city", label: "District", type: "list", options: [{ value: "c1", label: "One" }, { value: "c2", label: "Two" }] },
    { id: "mine", label: "Mine", type: "toggle" },
  ];

  it("starts from defaults / remembered values, dropping unknown values", () => {
    expect(initialFilterState(specs)).toEqual({ scope: ["today"], state: [], city: [], mine: [] });
    const s = initialFilterState(specs, { scope: ["all"], state: ["live", "gone"], city: ["c2", "c1"], mine: ["on"] });
    expect(s).toEqual({ scope: ["all"], state: ["live"], city: ["c2"], mine: ["on"] });
  });

  it("toggles per type and reports whether anything narrows", () => {
    let s = initialFilterState(specs);
    expect(filtersActive(specs, s)).toBe(false);
    s = toggleFilter(s, specs[1]!, "live");
    s = toggleFilter(s, specs[1]!, "waiting");
    expect(s.state).toEqual(["live", "waiting"]);
    s = toggleFilter(s, specs[2]!, "c1");
    s = toggleFilter(s, specs[2]!, "c2");
    expect(s.city).toEqual(["c2"]);
    s = toggleFilter(s, specs[2]!, "c2");
    expect(s.city).toEqual([]);
    s = toggleFilter(s, specs[0]!, "all");
    expect(s.scope).toEqual(["all"]);
    s = toggleFilter(s, specs[3]!, "on");
    expect(s.mine).toEqual(["on"]);
    expect(filtersActive(specs, s)).toBe(true);
  });
});

// 🏠 Home (2026-09-29): the first registered view is the default route and the unknown-route fallback.
describe("the default route is the home view", () => {
  it("an empty hash, a bare #/ or an unparseable hash open the home view", () => {
    for (const hash of ["", "#", "#/", "#/%E0%A4%A"]) expect(initialRoute(hash, "", "home"), hash).toEqual({ route: { view: "home", param: null }, aliased: false });
  });

  it("a real route wins, a retired one is aliased, and the old query links still work", () => {
    expect(initialRoute("#/orbit", "", "home")).toEqual({ route: { view: "orbit", param: null }, aliased: false });
    expect(initialRoute("#/control-room", "", "home")).toEqual({ route: { view: "room", param: "all" }, aliased: true });
    expect(initialRoute("", "?board=1", "home").route.view).toBe("board");
    expect(initialRoute("", "?canvas=1", "home").route.view).toBe("canvas");
    expect(initialRoute("", "?room=abc", "home").route).toEqual({ view: "room", param: "abc" });
    expect(initialRoute("", "?view=brain", "home").route.view).toBe("brain");
  });

  it("an unknown route falls back to the first registered view (Home), and Orbit keeps its key", () => {
    const log: string[] = [];
    const views = [fakeView("home", log), fakeView("orbit", log, { keys: ["1"], usesPlanet: true })];
    const { h } = host(views, log);
    expect(h.show("nope")).toEqual({ view: "home", param: null });
    expect(new ViewRegistry(views).home().id).toBe("home");
    expect(new ViewRegistry(views).forKey("1")).toBe("orbit");
    expect(h.show("orbit")).toEqual({ view: "orbit", param: null });
  });

  // Imports every view and all they pull in (three.js, xterm…), transformed cold: 4-6 s on its own,
  // more under the full suite, so the 5 s default timed out on a correct registry.
  it("the real registry lists Home first, not on the planet, leaves 1–5 to the groups and keeps 6–9", async () => {
    const { alefViews } = await import("../views/index");
    const reg = new ViewRegistry(alefViews);
    expect(reg.home().id).toBe("home");
    expect(reg.home().usesPlanet).not.toBe(true);
    for (const k of ["1", "2", "3", "4", "5"]) expect(reg.forKey(k)).toBeUndefined();
    expect(["6", "7", "8", "9", "b", "v"].map((k) => reg.forKey(k))).toEqual(["board", "voice", "code", "brain", "board", "canvas"]);
    expect(reg.get("orbit")?.usesPlanet).toBe(true);
  }, 30_000);
});
