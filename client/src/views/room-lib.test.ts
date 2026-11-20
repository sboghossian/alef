import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../../shared/types";
import {
  autoGridSize,
  clockHands,
  gridDims,
  gridSizeFrom,
  GRID_SIZES,
  type KeyValueStore,
  lampMood,
  MANUAL_GRID_SIZES,
  matchesFilter,
  noteError,
  orderAgents,
  parsePinIds,
  pickAgent,
  PinStore,
  plantStage,
  progressLabel,
  progressPct,
  roomBucket,
  roomFilterFrom,
  stepAgent,
  stickyNotes,
  tileAgents,
  uptime,
  eventPassedThrough,
  type AgentFacts,
} from "./room-lib";

function agent(id: string, over: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id,
    islandId: "agent-world",
    cwd: "/x/agent-world",
    title: id,
    status: "live",
    startedAt: "2026-09-25T08:00:00Z",
    lastActive: "2026-09-25T09:00:00Z",
    messageCount: 1,
    model: "claude-opus-5-5[1m]",
    role: "builder",
    color: "#fff",
    targetIslandId: "agent-world",
    tokens: 0,
    awaitingInput: false,
    ...over,
  };
}

const none: AgentFacts = { state: undefined, hasTerminal: false };

describe("roomBucket / filters", () => {
  it("buckets dormant, waiting and live", () => {
    expect(roomBucket(agent("a", { status: "dormant", awaitingInput: true }), "waiting")).toBe("dormant");
    expect(roomBucket(agent("a", { awaitingInput: true }), "working")).toBe("waiting");
    expect(roomBucket(agent("a"), "permission")).toBe("waiting");
    expect(roomBucket(agent("a"), "working")).toBe("live");
  });

  it("defaults to active agents only", () => {
    const f = roomFilterFrom({});
    expect(f.buckets).toEqual(["live", "waiting"]);
    expect(matchesFilter(agent("a", { status: "dormant" }), none, f)).toBe(false);
    expect(matchesFilter(agent("a"), none, f)).toBe(true);
  });

  it("shows dormant ones when the chip is on, and filters city, model and terminal", () => {
    const f = roomFilterFrom({ state: ["dormant"], city: ["acme"], model: ["haiku", "bogus"], terminal: ["on"] });
    expect(f.models).toEqual(["haiku"]);
    const d = agent("d", { status: "dormant", islandId: "acme", model: "claude-haiku-4-5" });
    expect(matchesFilter(d, { state: "sleeping", hasTerminal: true }, f)).toBe(true);
    expect(matchesFilter(d, { state: "sleeping", hasTerminal: false }, f)).toBe(false);
    expect(matchesFilter({ ...d, islandId: "other" }, { state: "sleeping", hasTerminal: true }, f)).toBe(false);
    expect(matchesFilter({ ...d, model: "claude-opus-5" }, { state: "sleeping", hasTerminal: true }, f)).toBe(false);
  });
});

describe("agent picker ordering", () => {
  it("puts agents that need you first, then working, idle, asleep; recent first inside a tier", () => {
    const list = [
      agent("sleep", { status: "dormant", lastActive: "2026-09-25T10:00:00Z" }),
      agent("idle-old", { lastActive: "2026-09-25T07:00:00Z" }),
      agent("idle-new", { lastActive: "2026-09-25T09:30:00Z" }),
      agent("work"),
      agent("ask", { awaitingInput: true }),
      agent("perm"),
    ];
    const states: Record<string, AgentFacts["state"]> = { work: "working", perm: "permission", "idle-old": "idle", "idle-new": "idle" };
    const out = orderAgents(list, (id) => ({ state: states[id], hasTerminal: false })).map((a) => a.id);
    expect(out).toEqual(["perm", "ask", "work", "idle-new", "idle-old", "sleep"]);
  });

  it("is stable on ties (by id)", () => {
    const out = orderAgents([agent("b"), agent("a")], () => none).map((a) => a.id);
    expect(out).toEqual(["a", "b"]);
  });

  it("picks the requested agent or falls back to the first", () => {
    const ordered = [agent("x"), agent("y")];
    expect(pickAgent("y", ordered, () => true)).toBe("y");
    expect(pickAgent("gone", ordered, () => false)).toBe("x");
    expect(pickAgent(null, [], () => false)).toBeNull();
  });

  it("steps with wrap-around", () => {
    const ordered = [agent("x"), agent("y"), agent("z")];
    expect(stepAgent(ordered, "z", 1)).toBe("x");
    expect(stepAgent(ordered, "x", -1)).toBe("z");
    expect(stepAgent(ordered, "nope", 1)).toBe("x");
    expect(stepAgent([], "x", 1)).toBeNull();
  });
});

describe("props from data", () => {
  it("grows the plant with tokens", () => {
    expect(plantStage(0)).toBe(0);
    expect(plantStage(-5)).toBe(0);
    expect(plantStage(Number.NaN)).toBe(0);
    expect(plantStage(19_999)).toBe(0);
    expect(plantStage(20_000)).toBe(1);
    expect(plantStage(250_000)).toBe(2);
    expect(plantStage(1_200_000)).toBe(3);
    expect(plantStage(6_000_000)).toBe(4);
    expect(plantStage(90_000_000)).toBe(5);
  });

  it("formats uptime and clock hands", () => {
    const start = "2026-09-25T08:00:00Z";
    const at = (m: number): number => Date.parse(start) + m * 60_000;
    expect(uptime(start, at(42))).toBe("42m");
    expect(uptime(start, at(185))).toBe("3h 05m");
    expect(uptime(start, at(60 * 52))).toBe("2d 4h");
    expect(uptime("garbage", at(1))).toBeNull();
    expect(uptime(start, at(-10))).toBe("0m");
    expect(clockHands(start, at(90))).toEqual({ hour: 45, minute: 180 });
  });

  it("maps todos to sticky notes, open work first when the board is full", () => {
    expect(stickyNotes(undefined)).toEqual({ notes: [], hidden: 0 });
    const list = {
      agentId: "a",
      updatedAt: "x",
      items: [
        { content: "one", status: "completed" as const, activeForm: null },
        { content: "two", status: "in_progress" as const, activeForm: "Doing two" },
        { content: "three", status: "pending" as const, activeForm: null },
      ],
    };
    const all = stickyNotes(list);
    expect(all.notes.map((n) => `${n.tone}:${n.text}`)).toEqual(["done:one", "now:Doing two", "next:three"]);
    const two = stickyNotes(list, 2);
    expect(two.notes.map((n) => n.text)).toEqual(["Doing two", "three"]);
    expect(two.hidden).toBe(1);
  });

  it("lights the lamp from the state, never dark", () => {
    expect(lampMood(agent("a", { status: "dormant" }), undefined)).toBe("sleep");
    expect(lampMood(agent("a"), "permission")).toBe("alarm");
    expect(lampMood(agent("a", { awaitingInput: true }), "working")).toBe("ask");
    expect(lampMood(agent("a"), "working")).toBe("busy");
    expect(lampMood(agent("a"), "idle")).toBe("calm");
  });

  it("validates notes", () => {
    expect(noteError("  ")).toBe("Write something first.");
    expect(noteError("x".repeat(2001))).toMatch(/under/);
    expect(noteError("hello")).toBeNull();
  });
});

describe("3D room maths", () => {
  it("centres the room on the stage and widens the FOV for narrow stages", async () => {
    const { stageProjection } = await import("./room-lib");
    const full = stageProjection(1600, 800, { left: 0, top: 0, width: 1600, height: 800 });
    expect(full.offsetX).toBe(0);
    expect(full.offsetY).toBe(0);
    expect(full.fov).toBeCloseTo(40, 5);
    const side = stageProjection(1280, 800, { left: 250, top: 100, width: 700, height: 600 });
    expect(side.offsetX).toBe(640 - 600);
    expect(side.offsetY).toBe(400 - 400);
    expect(side.fov).toBeGreaterThan(40);
    const phone = stageProjection(390, 844, { left: 0, top: 200, width: 390, height: 500 });
    expect(phone.fov).toBeGreaterThan(side.fov);
    expect(phone.fov).toBeLessThanOrEqual(150);
  });

  it("moves the creature per state, deterministically", async () => {
    const { creatureMotion } = await import("./room-lib");
    expect(creatureMotion("sleep", 0).y).toBeLessThan(0);
    expect(creatureMotion("sleep", 0).squash).toBeLessThan(1);
    expect(creatureMotion("busy", 1.23)).toEqual(creatureMotion("busy", 1.23));
    expect(creatureMotion("busy", 0).yaw).toBeGreaterThan(0.3); // turned to the monitor
    const hops = [0.1, 0.3, 0.5].map((t) => creatureMotion("ask", t).y);
    expect(Math.max(...hops)).toBeGreaterThan(0.2);
    expect(Math.abs(creatureMotion("alarm", 0.07).roll)).toBeGreaterThan(0);
  });

  it("fills shelf planks top first and caps", async () => {
    const { shelfSlots } = await import("./room-lib");
    expect(shelfSlots(0, 3, 4)).toEqual([]);
    expect(shelfSlots(5, 3, 4)).toEqual([
      { plank: 0, slot: 0 }, { plank: 0, slot: 1 }, { plank: 0, slot: 2 }, { plank: 0, slot: 3 }, { plank: 1, slot: 0 },
    ]);
    expect(shelfSlots(99, 3, 4)).toHaveLength(12);
  });

  it("lights the lamp per mood", async () => {
    const { lampLight } = await import("./room-lib");
    expect(lampLight("alarm").color).toBe(0xff5d8f);
    expect(lampLight("sleep").intensity).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------- multi-room grid (round 11:
// merged in from control-room-lib.test.ts when the Control room view folded into Room)

const factsOf =
  (states: Record<string, AgentFacts> = {}) =>
  (id: string): AgentFacts =>
    states[id] ?? none;

describe("autoGridSize / gridDims", () => {
  it("steps 1/2/4/6/9 with the count", () => {
    expect(autoGridSize(0)).toBe(1);
    expect(autoGridSize(1)).toBe(1);
    expect(autoGridSize(2)).toBe(2);
    expect(autoGridSize(3)).toBe(4);
    expect(autoGridSize(4)).toBe(4);
    expect(autoGridSize(5)).toBe(6);
    expect(autoGridSize(6)).toBe(6);
    expect(autoGridSize(7)).toBe(9);
    expect(autoGridSize(100)).toBe(9);
  });

  it("every size has an exact cols×rows", () => {
    for (const size of GRID_SIZES) {
      const { cols, rows } = gridDims(size);
      expect(cols * rows).toBe(size);
    }
  });

  it("negative/NaN counts never throw and stay at the smallest size", () => {
    expect(autoGridSize(-5)).toBe(1);
    expect(autoGridSize(NaN)).toBe(1);
    expect(autoGridSize(Infinity)).toBe(9);
  });
});

describe("gridSizeFrom", () => {
  it("auto (or nothing picked) falls back to the count", () => {
    expect(gridSizeFrom("auto", 5)).toBe(6);
    expect(gridSizeFrom(undefined, 5)).toBe(6);
  });

  it("a manual size wins over the count", () => {
    expect(gridSizeFrom("2", 9)).toBe(2);
    expect(gridSizeFrom("9", 1)).toBe(9);
  });

  it("an invalid manual value falls back to auto", () => {
    expect(gridSizeFrom("1", 5)).toBe(6); // 1 is not a manual option
    expect(gridSizeFrom("bogus", 5)).toBe(6);
    expect(gridSizeFrom("", 5)).toBe(6);
  });

  it("every manual size is a valid grid size", () => {
    for (const size of MANUAL_GRID_SIZES) expect(GRID_SIZES).toContain(size);
  });
});

describe("tileAgents", () => {
  it("orders needs-you first, then live, then most recent (Room's order)", () => {
    const a = agent("a", { lastActive: "2026-09-25T09:00:00Z" }); // idle live
    const b = agent("b", { awaitingInput: true, lastActive: "2026-09-25T08:00:00Z" }); // waiting
    const c = agent("c", { status: "dormant", lastActive: "2026-09-25T10:00:00Z" }); // dormant, most recent
    const out = tileAgents([a, b, c], factsOf(), [], 9);
    expect(out.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("pinned agents come first, in pin order, ahead of urgency", () => {
    const a = agent("a", { awaitingInput: true }); // would normally sort first
    const b = agent("b");
    const c = agent("c");
    const out = tileAgents([a, b, c], factsOf(), ["c", "b"], 9);
    expect(out.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("caps at the grid size", () => {
    const agents = ["a", "b", "c", "d"].map((id) => agent(id));
    expect(tileAgents(agents, factsOf(), [], 2)).toHaveLength(2);
  });

  it("a pin for an agent that no longer exists is silently skipped", () => {
    const a = agent("a");
    const out = tileAgents([a], factsOf(), ["ghost", "a"], 4);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("empty input never throws", () => {
    expect(tileAgents([], factsOf(), [], 4)).toEqual([]);
  });
});

describe("parsePinIds", () => {
  it("parses a JSON string array", () => {
    expect(parsePinIds('["a","b"]')).toEqual(["a", "b"]);
  });
  it("null/empty/malformed/wrong-shape input is never pins, never throws", () => {
    expect(parsePinIds(null)).toEqual([]);
    expect(parsePinIds("")).toEqual([]);
    expect(parsePinIds("{not json")).toEqual([]);
    expect(parsePinIds("42")).toEqual([]);
    expect(parsePinIds('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });
});

function fakeStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("PinStore", () => {
  it("starts empty with no storage (never throws)", () => {
    const s = new PinStore(null);
    expect(s.list()).toEqual([]);
    expect(s.has("a")).toBe(false);
  });

  it("loads existing pins from storage", () => {
    const s = new PinStore(fakeStore({ "alef.control-room.pins": '["a","b"]' }));
    expect(s.list()).toEqual(["a", "b"]);
    expect(s.has("b")).toBe(true);
  });

  it("toggle pins then unpins, persisting each time", () => {
    const store = fakeStore();
    const s = new PinStore(store);
    s.toggle("a", () => true);
    expect(s.list()).toEqual(["a"]);
    expect(parsePinIds(store.getItem("alef.control-room.pins"))).toEqual(["a"]);
    s.toggle("a", () => true);
    expect(s.list()).toEqual([]);
  });

  it("toggle drops pins whose agent no longer exists before adding the new one", () => {
    const s = new PinStore(fakeStore({ "alef.control-room.pins": '["gone","a"]' }));
    s.toggle("b", (id) => id === "a" || id === "b");
    expect(s.list()).toEqual(["a", "b"]);
  });

  it("prune removes stale pins once, and is a no-op when nothing changed", () => {
    const store = fakeStore({ "alef.control-room.pins": '["a","gone"]' });
    const s = new PinStore(store);
    s.prune((id) => id === "a");
    expect(s.list()).toEqual(["a"]);
    store.setItem("alef.control-room.pins", "SHOULD_NOT_BE_TOUCHED");
    s.prune((id) => id === "a");
    expect(store.getItem("alef.control-room.pins")).toBe("SHOULD_NOT_BE_TOUCHED");
  });

  it("a throwing store never throws back at the caller", () => {
    const angry: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const s = new PinStore(angry);
    expect(s.list()).toEqual([]);
    expect(() => s.toggle("a", () => true)).not.toThrow();
  });
});

describe("progress label/pct", () => {
  it("formats done/total, and – for an empty list", () => {
    expect(progressLabel(3, 7)).toBe("3/7");
    expect(progressLabel(0, 0)).toBe("–");
  });
  it("computes a clamped 0..100 percentage", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(3, 7)).toBe(43);
    expect(progressPct(7, 7)).toBe(100);
  });
});

describe("eventPassedThrough (village DOM over the 3D stage)", () => {
  /** Just enough of a DOM node: a parent link and a real contains(). */
  class FakeNode extends EventTarget {
    constructor(public parent: FakeNode | null = null) {
      super();
    }
    contains(n: unknown): boolean {
      for (let x: unknown = n; x instanceof FakeNode; x = x.parent) if (x === this) return true;
      return false;
    }
  }

  it("a Town square tab click still counts as the panel's after the panel re-rendered and detached the tab", () => {
    const stage = new FakeNode();
    const vlgFeed = new FakeNode(stage);
    const vlgDock = new FakeNode(stage);
    const tabs = new FakeNode(vlgFeed);
    const tab = new FakeNode(tabs);
    // The path the click will bubble along is fixed at dispatch: tab → tabs → panel → stage.
    const path: EventTarget[] = [tab, tabs, vlgFeed, stage];
    const click = { target: tab, composedPath: (): EventTarget[] => path };
    // The tab's own click handler re-renders the panel (replaceChildren): the tab is detached…
    tabs.parent = null;
    expect(vlgFeed.contains(click.target)).toBe(false);
    // …but the stage's click handler, reached by bubbling, must still see a click on the panel.
    expect(eventPassedThrough(click, [vlgFeed, vlgDock, null])).toBe(true);
    // A click on the stage itself (a room) is not on the village UI.
    expect(eventPassedThrough({ composedPath: () => [stage] }, [vlgFeed, vlgDock])).toBe(false);
  });
});
