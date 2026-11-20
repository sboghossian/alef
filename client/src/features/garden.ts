// 🏠 Home garden: a pixel-art band at the top of Home that grows from today's real sessions.
// The rules and the mapping live in garden-lib.ts (a small Markov-style rewriting engine; idea from
// MarkovJunior, MIT, Maxim Gumin, github.com/mxgmn/MarkovJunior) and garden-plants-lib.ts
// (sessions started today → plants, each grown in its own window). This file only draws and wires
// the pointer:
//
//   - on mount the rewrite steps replay over about 2 s; with prefers-reduced-motion, or when the
//     garden changes later (a session ends, a PR merges), the final state is drawn at once;
//   - live sessions keep a swaying bud; ONE setTimeout loop drives replay and sway, and it stops on
//     dispose and while the tab is hidden;
//   - hovering a plant puts its session title in the canvas tooltip, clicking it selects the session
//     (the shell opens the details panel);
//   - the canvas has an aria-label and a visually hidden list of the plants for screen readers.
// Session titles are untrusted text: textContent and the title attribute only.

import { agentTitle } from "../../../shared/display";
import type { WorldAgent } from "../../../shared/types";
import { prefersReducedMotion } from "../ui/kit";
import type { ViewContext } from "../shell/views";
import { h } from "./fleet-overlay";
import { FLOWER_COLOURS, buildGarden, gardenFinished, gardenLabel, localDayKey, plantAt, plantsForDay, runGarden, sproutPlant, stepGarden, type BuiltGarden, type Plant } from "./garden-plants-lib";
import { onOutcomes, outcomeOf } from "./outcomes";

export const CELL_CSS_PX = 5;
export const BAND_CSS_PX = 200;
const REPLAY_MS = 2000;
const SWAY_MS = 90;
const REFRESH_DEBOUNCE_MS = 1000;
const RESIZE_DEBOUNCE_MS = 150;
const EMPTY_NOTE = "Nothing planted yet today";

/** Flower colours, indexed like FLOWER_COLOURS. Bright and saturated on cream and pale sky. */
export const PETAL_COLOURS: readonly string[] = ["#ff5d73", "#ff9f1c", "#a86bff", "#3fa9ff", "#ff7ad9", "#e83e8c", "#1fd1b0", "#ff3b3b"];
const CELL_COLOURS: Readonly<Record<string, string>> = {
  "=": "#3ec14f",
  T: "#2f9e44",
  "#": "#a56a38",
  "%": "#7d4a26",
  o: "#e3d2b0",
  "|": "#2d9d4a",
  s: "#1f7d3a",
  b: "#2d9d4a",
  c: "#57cf62",
  l: "#63d96b",
  L: "#2fae55",
  g: "#8be04e",
  t: "#8be04e",
  E: "#ff7aa2",
  S: "#2fae55",
  Y: "#ffd23f",
  y: "#ffd23f",
};

/** Colour of a cell (`petal` is the plant's flower colour), or null for sky and the invisible helpers. */
export function cellColour(c: string, petal = PETAL_COLOURS[0] as string): string | null {
  return c === "P" ? petal : (CELL_COLOURS[c] ?? null);
}

type Deps = Pick<ViewContext, "store" | "selection">;

/** Sessions the garden reads: everything the store holds; plantsForDay keeps only today's. */
function agentsOf(c: Deps): WorldAgent[] {
  return [...c.store.agents.values()];
}

function plantsKey(list: readonly Plant[]): string {
  return JSON.stringify(list.map((p) => [p.id, p.x, p.stem, p.bloom, p.live, p.title, p.colour]));
}

function deviceRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/** The mounted garden's re-read hook; Home's store listeners call it (the store has no unsubscribe). */
let gardenRefresh: (() => void) | null = null;
export function refreshGarden(): void {
  gardenRefresh?.();
}

/** Mounts the garden into `host` (an empty element). Returns the disposer. If setup throws
 *  partway, everything already set up is undone before the error goes on. */
export function mountGarden(host: HTMLElement, c: Deps): () => void {
  const undo: Array<() => void> = [];
  const dispose = (): void => {
    while (undo.length) {
      try {
        undo.pop()?.();
      } catch {
        // one failed undo must not strand the rest
      }
    }
  };
  try {
    return setup(host, c, undo, dispose);
  } catch (err) {
    dispose();
    throw err;
  }
}

function setup(host: HTMLElement, c: Deps, undo: Array<() => void>, dispose: () => void): () => void {
  const wrap = h("div", "home-garden");
  const canvas = h("canvas", "home-garden-canvas");
  canvas.style.cursor = "default";
  const note = h("p", "home-garden-note");
  note.hidden = true;
  const sr = h("ul", "sr-only");
  wrap.append(canvas, note, sr);
  host.append(wrap);
  undo.push(() => wrap.remove());

  let gctx: CanvasRenderingContext2D | null = null;
  try {
    gctx = canvas.getContext("2d");
  } catch {
    gctx = null;
  }

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let plants: Plant[] = [];
  let built: BuiltGarden | null = null;
  let tickMs = 16;
  let px = CELL_CSS_PX;
  let key = "";
  let lastCells = 0;
  const reduced = prefersReducedMotion();
  undo.push(() => {
    disposed = true;
    for (const t of [timer, refreshTimer, resizeTimer]) if (t) clearTimeout(t);
    timer = refreshTimer = resizeTimer = null;
  });

  undo.push(onOutcomes(() => scheduleRefresh()));

  const widthCells = (): number => {
    const w = wrap.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0) || 960;
    return Math.max(24, Math.floor(w / CELL_CSS_PX));
  };

  function readPlants(width: number): { plants: Plant[]; overflow: number; empty: boolean } {
    const g = plantsForDay(agentsOf(c), {
      now: Date.now(),
      width,
      blooms: (id) => {
        const o = outcomeOf(id);
        return o === "shipped" || o === "delivered";
      },
      nameOf: (a) => agentTitle({ title: typeof a.title === "string" ? a.title : "", displayName: a.displayName }),
    });
    return g.plants.length ? { ...g, empty: false } : { plants: [sproutPlant(width)], overflow: 0, empty: true };
  }

  function paint(t: number): void {
    const b = built;
    if (!gctx || !b) return;
    gctx.imageSmoothingEnabled = false;
    gctx.clearRect(0, 0, canvas.width, canvas.height);
    const cell = (x: number, y: number, col: string): void => {
      gctx!.fillStyle = col;
      gctx!.fillRect(x * px, y * px, px, px);
    };
    for (let y = 0; y < b.ground.h; y++) {
      for (let x = 0; x < b.ground.w; x++) {
        const col = cellColour(b.ground.cells[y * b.ground.w + x] as string);
        if (col) cell(x, y, col);
      }
    }
    for (const s of b.sprites) {
      const petal = PETAL_COLOURS[s.plant.colour % FLOWER_COLOURS] as string;
      const sway = s.plant.live && !reduced;
      for (let y = 0; y < s.grid.h; y++) {
        // A live bud leans up to ~1.4 cells at the top of its stem, none at the ground.
        const dx = sway ? Math.round(Math.sin(t / 550 + s.x0) * Math.min(1, (b.groundY - y) / Math.max(1, s.plant.stem)) * 1.4) : 0;
        for (let x = 0; x < s.grid.w; x++) {
          const col = cellColour(s.grid.cells[y * s.grid.w + x] as string, petal);
          if (col) cell(s.x0 + x + dx, y, col);
        }
      }
    }
  }

  const now = (): number => (typeof performance !== "undefined" ? performance.now() : 0);

  function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** Replay step, or a sway redraw while a live bud is on screen; then wait for the next. */
  function loop(): void {
    timer = null;
    const b = built;
    if (disposed || !b || (typeof document !== "undefined" && document.hidden)) return;
    if (!gardenFinished(b)) {
      stepGarden(b);
      paint(now());
      timer = setTimeout(loop, tickMs);
    } else if (!reduced && plants.some((p) => p.live)) {
      paint(now());
      timer = setTimeout(loop, SWAY_MS);
    }
  }

  function start(): void {
    if (timer || disposed) return;
    timer = setTimeout(loop, 0);
  }

  function describe(overflow: number, empty: boolean): void {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", empty ? "Today's garden: 0 sessions, 0 in bloom" : gardenLabel(plants, overflow));
    note.hidden = !empty;
    note.textContent = empty ? EMPTY_NOTE : "";
    // Plain text, not buttons: dozens of hidden focusable buttons would put invisible focus stops before the prompt box.
    sr.replaceChildren(...(empty ? [] : plants.map((p) => h("li", "", `${p.title}${p.bloom ? ", in bloom" : ""}${p.live ? ", running now" : ""}`))));
  }

  /** (Re)build from the store. `replay` animates the rewrite steps; otherwise the final state at once. */
  function rebuild(replay: boolean): void {
    if (disposed) return;
    stop();
    const width = widthCells();
    const height = Math.floor(BAND_CSS_PX / CELL_CSS_PX);
    const read = readPlants(width);
    plants = read.plants;
    px = Math.max(1, Math.round(CELL_CSS_PX * deviceRatio()));
    canvas.width = width * px;
    canvas.height = height * px;
    canvas.style.width = `${width * CELL_CSS_PX}px`;
    canvas.style.height = `${height * CELL_CSS_PX}px`;
    lastCells = width;
    built = buildGarden(plants, width, height, localDayKey(Date.now()));
    key = plantsKey(plants);
    describe(read.overflow, read.empty);
    if (replay && !reduced) {
      tickMs = Math.min(60, Math.max(12, Math.round(REPLAY_MS / built.ticks)));
      paint(0);
    } else {
      runGarden(built);
      paint(now());
    }
    start();
  }

  function scheduleRefresh(): void {
    if (disposed || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!disposed && plantsKey(readPlants(widthCells()).plants) !== key) rebuild(false);
    }, REFRESH_DEBOUNCE_MS);
  }
  gardenRefresh = scheduleRefresh;
  undo.push(() => {
    if (gardenRefresh === scheduleRefresh) gardenRefresh = null;
  });

  function scheduleResize(): void {
    if (disposed) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!disposed && widthCells() !== lastCells) rebuild(false);
    }, RESIZE_DEBOUNCE_MS);
  }

  function cellAt(ev: MouseEvent): { x: number; y: number } | null {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height || !built) return null;
    return { x: Math.floor(((ev.clientX - r.left) / r.width) * built.width), y: Math.floor(((ev.clientY - r.top) / r.height) * built.height) };
  }
  function hit(ev: MouseEvent): Plant | null {
    const p = cellAt(ev);
    const empty = plants.length === 1 && plants[0]?.id === "";
    return p && built && !empty ? plantAt(plants, p.x, p.y, built.groundY) : null;
  }
  const onMove = (ev: MouseEvent): void => {
    const p = hit(ev);
    canvas.title = p ? p.title : "";
    canvas.style.cursor = p ? "pointer" : "default";
  };
  const onClick = (ev: MouseEvent): void => {
    const p = hit(ev);
    if (p) c.selection.set({ kind: "agent", id: p.id });
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("click", onClick);
  undo.push(() => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("click", onClick);
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    undo.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(wrap);
    undo.push(() => ro.disconnect());
  }
  // A DPR change (zoom, moving to another screen) needs a fresh backing store even when the width is the same.
  if (typeof matchMedia === "function") {
    let mq: MediaQueryList | null = null;
    const watch = (): void => {
      mq?.removeEventListener("change", onDpr);
      mq = matchMedia(`(resolution: ${deviceRatio()}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    const onDpr = (): void => {
      if (disposed) return;
      rebuild(false);
      watch();
    };
    watch();
    undo.push(() => mq?.removeEventListener("change", onDpr));
  }

  rebuild(true);

  return dispose;
}
