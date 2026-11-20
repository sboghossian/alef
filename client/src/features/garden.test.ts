// The garden's DOM side on a tiny stub (this project runs client tests in Node, no jsdom): mount,
// hit-testing and clicks, pausing while hidden, and that dispose leaves nothing behind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewContext } from "../shell/views";
import { mountGarden, cellColour, PETAL_COLOURS, refreshGarden } from "./garden";

type Handler = (ev: Record<string, unknown>) => void;

class El {
  kids: El[] = [];
  parent: El | null = null;
  style: Record<string, string> = {};
  title = "";
  hidden = false;
  width = 0;
  height = 0;
  clientWidth = 800;
  textContent = "";
  className = "";
  attrs = new Map<string, string>();
  handlers = new Map<string, Set<Handler>>();
  constructor(readonly tag: string) {}
  append(...n: El[]): void {
    for (const k of n) {
      k.parent = this;
      this.kids.push(k);
    }
  }
  replaceChildren(...n: El[]): void {
    this.kids = [];
    this.append(...n);
  }
  remove(): void {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  addEventListener(t: string, f: Handler): void {
    (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)!).add(f);
  }
  removeEventListener(t: string, f: Handler): void {
    this.handlers.get(t)?.delete(f);
  }
  emit(t: string, ev: Record<string, unknown>): void {
    for (const f of this.handlers.get(t) ?? []) f(ev);
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: 200 };
  }
  getContext(): unknown {
    return { imageSmoothingEnabled: true, fillStyle: "", clearRect: () => {}, fillRect: vi.fn() };
  }
  find(cls: string): El[] {
    return [...(this.className.split(" ").includes(cls) ? [this] : []), ...this.kids.flatMap((k) => k.find(cls))];
  }
  count(): number {
    return 1 + this.kids.reduce((n, k) => n + k.count(), 0);
  }
}

let docHandlers: Map<string, Set<Handler>>;
let observers: Array<{ observed: boolean; cb: () => void }>;
let mqListeners: Set<() => void>;
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 30, 12));
  docHandlers = new Map();
  observers = [];
  mqListeners = new Set();
  hidden = false;
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    createElement: (t: string) => new El(t),
    addEventListener: (t: string, f: Handler) => void (docHandlers.get(t) ?? docHandlers.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: Handler) => void docHandlers.get(t)?.delete(f),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      rec = { observed: false, cb: (): void => {} };
      constructor(cb: () => void) {
        this.rec.cb = cb;
        observers.push(this.rec);
      }
      observe(): void {
        this.rec.observed = true;
      }
      disconnect(): void {
        this.rec.observed = false;
      }
    },
  );
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: (_t: string, f: () => void) => void mqListeners.add(f),
    removeEventListener: (_t: string, f: () => void) => void mqListeners.delete(f),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const agent = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, islandId: "isl", title: `title ${id}`, startedAt: new Date(2026, 8, 30, 9).toISOString(), messageCount: 20, status: "dormant", ...o });

function boot(agents: Array<Record<string, unknown>>) {
  const host = new El("div");
  const picked: unknown[] = [];
  const ctx = {
    store: { agents: new Map(agents.map((a) => [a.id as string, a])) },
    selection: { get: () => null, set: (s: unknown) => void picked.push(s) },
  } as unknown as Pick<ViewContext, "store" | "selection">;
  const dispose = mountGarden(host as unknown as HTMLElement, ctx);
  const canvas = host.find("home-garden-canvas")[0]!;
  return { host, ctx, dispose, canvas, picked };
}

describe("mount", () => {
  it("labels the canvas and lists the plants as plain text", () => {
    const { host, canvas } = boot([agent("a"), agent("b", { status: "live" })]);
    expect(canvas.attrs.get("aria-label")).toBe("Today's garden: 2 sessions, 0 in bloom");
    const list = host.find("sr-only")[0]!;
    expect(list.kids.map((k) => k.textContent)).toEqual(["title a", "title b, running now"]);
    expect(list.kids.every((k) => k.tag === "li" && k.kids.length === 0)).toBe(true);
  });
  it("an empty day says so and lists nothing", () => {
    const { host, canvas } = boot([agent("old", { startedAt: new Date(2026, 8, 29, 9).toISOString() })]);
    expect(canvas.attrs.get("aria-label")).toBe("Today's garden: 0 sessions, 0 in bloom");
    const note = host.find("home-garden-note")[0]!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Nothing planted yet today");
    expect(host.find("sr-only")[0]!.kids).toHaveLength(0);
  });
  it("garbage in the store doesn't throw", () => {
    expect(() => boot([{ id: "x" }, { id: "y", startedAt: 5 }, agent("ok")])).not.toThrow();
  });
});

describe("pointer", () => {
  it("hovering a plant shows its title, clicking it selects that session, empty ground does neither", () => {
    const { canvas, picked } = boot([agent("a", { messageCount: 200 })]);
    // One plant, so it sits on some slot; find its column by sweeping the canvas.
    let found: number | null = null;
    for (let x = 0; x < 800 && found === null; x += 5) {
      canvas.emit("pointermove", { clientX: x + 2, clientY: 150 });
      if (canvas.title) found = x + 2;
    }
    expect(found).not.toBeNull();
    expect(canvas.title).toBe("title a");
    expect(canvas.style.cursor).toBe("pointer");
    canvas.emit("click", { clientX: found, clientY: 150 });
    expect(picked).toEqual([{ kind: "agent", id: "a" }]);
    canvas.emit("pointermove", { clientX: found === 2 ? 700 : 2, clientY: 5 });
    expect(canvas.title).toBe("");
    canvas.emit("click", { clientX: found === 2 ? 700 : 2, clientY: 5 });
    expect(picked).toHaveLength(1);
  });
  it("the empty-state sprout is not selectable", () => {
    const { canvas, picked } = boot([]);
    for (let x = 0; x < 800; x += 5) canvas.emit("click", { clientX: x, clientY: 170 });
    expect(picked).toEqual([]);
  });
});

describe("timers", () => {
  it("replays over about 2 s, then goes quiet when nothing is live", () => {
    boot([agent("a")]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps one timer running for a live bud, and pauses while the tab is hidden", () => {
    boot([agent("a", { status: "live" })]);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(1);
    hidden = true;
    vi.advanceTimersByTime(500); // the pending tick fires once, sees the hidden tab and stops
    expect(vi.getTimerCount()).toBe(0);
    hidden = false;
    for (const f of docHandlers.get("visibilitychange") ?? []) f({});
    expect(vi.getTimerCount()).toBe(1);
  });
  it("a burst of resizes rebuilds once, and only when the width really changed", () => {
    const { host, canvas } = boot([agent("a")]);
    vi.advanceTimersByTime(4000);
    const before = canvas.width;
    host.find("home-garden")[0]!.clientWidth = 400;
    for (let i = 0; i < 5; i++) observers[0]!.cb();
    expect(canvas.width).toBe(before);
    vi.advanceTimersByTime(200);
    expect(canvas.width).toBeLessThan(before);
  });
  it("a devicePixelRatio change rebuilds the backing store at the new ratio", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 800 });
    const { canvas } = boot([agent("a")]);
    expect(canvas.width).toBe(160 * 5);
    (globalThis as unknown as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 2;
    for (const f of [...mqListeners]) f();
    expect(canvas.width).toBe(160 * 10);
    expect(canvas.style.width).toBe("800px");
  });
  it("a store change rebuilds after a debounce, only if the plants differ", () => {
    const { ctx, host } = boot([agent("a")]);
    vi.advanceTimersByTime(4000);
    (ctx.store.agents as Map<string, unknown>).set("b", agent("b"));
    refreshGarden();
    refreshGarden();
    vi.advanceTimersByTime(1100);
    expect(host.find("sr-only")[0]!.kids).toHaveLength(2);
  });
});

describe("dispose", () => {
  it("leaves no timers, listeners, observers or nodes behind", () => {
    const { host, canvas, dispose } = boot([agent("a", { status: "live" })]);
    refreshGarden();
    host.find("home-garden")[0]!.clientWidth = 300;
    observers[0]!.cb();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect([...canvas.handlers.values()].every((s) => s.size === 0)).toBe(true);
    expect([...docHandlers.values()].every((s) => s.size === 0)).toBe(true);
    expect(observers.every((o) => !o.observed)).toBe(true);
    expect(mqListeners.size).toBe(0);
    expect(host.kids).toHaveLength(0);
    refreshGarden(); // the hook is unset: harmless
    expect(vi.getTimerCount()).toBe(0);
  });
  it("undoes a mount that throws partway", () => {
    const host = new El("div");
    vi.stubGlobal("ResizeObserver", class { constructor() { throw new Error("boom"); } });
    const ctx = { store: { agents: new Map() }, selection: { get: () => null, set: () => {} } } as unknown as Pick<ViewContext, "store" | "selection">;
    expect(() => mountGarden(host as unknown as HTMLElement, ctx)).toThrow("boom");
    expect(host.kids).toHaveLength(0);
    expect([...docHandlers.values()].every((s) => s.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    refreshGarden();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("colours", () => {
  it("petals take the plant's colour; sky and helper cells are not drawn", () => {
    expect(cellColour("P", "#123456")).toBe("#123456");
    expect(cellColour(".")).toBeNull();
    expect(cellColour("^")).toBeNull();
    expect(cellColour("m")).toBeNull();
    expect(PETAL_COLOURS.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
  });
});
