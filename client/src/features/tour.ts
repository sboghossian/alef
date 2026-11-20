// The guided tour (round 11 C): "Take the tour" in the Orbit sidebar's Explain section (or the
// palette) walks through ~10 steps in about two minutes. The camera flies to each part of the
// system (a district, a house, the hook gates, the Jev tower, the power plants, the memory
// library, Harness City, the routines factory, the moon) and a caption card explains it, with
// Back / Next / Skip; Esc leaves. Replayable any time. It starts on its own at most ONCE per
// browser (after the welcome card was dismissed, never under automation), and remembers it was
// seen; leaving the page mid-tour counts as seen too, and so does an older stuck auto-start
// (recoverStuckTour). Help's "Take the tour" button restarts it. Steps and the state machine are pure (tour-lib.ts, tested); this file is the camera + DOM.

import * as THREE from "three";
import { PLANET_R } from "../layout";
import { log } from "../log";
import { tiltFor } from "../scene/rig";
import { sceneParts } from "../scene/scene-bus";
import { WELCOME_KEY, prefersReducedMotion } from "../ui/kit";
import { h } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { placeTop } from "./system-places";
import { TOUR_IDLE, TOUR_STEPS, parseTourMemory, recoverStuckTour, shouldAutoStart, stepCounter, tourReducer, type TourAction, type TourState, type TourStep } from "./tour-lib";
import "./explain.css";

const MEMORY_KEY = "alef.tour";
const FLY_S = 1.6;

let ctxRef: ClientContext | null = null;
let state: TourState = TOUR_IDLE;
let card: HTMLElement | null = null;
let fly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; t0: number } | null = null;
let keepAwakeAt = 0;

function readMemory(): ReturnType<typeof parseTourMemory> {
  try {
    return parseTourMemory(localStorage.getItem(MEMORY_KEY));
  } catch {
    return parseTourMemory(null);
  }
}

function writeMemory(patch: Partial<ReturnType<typeof parseTourMemory>>): void {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify({ ...readMemory(), ...patch }));
  } catch {
    /* private mode: the tour just isn't remembered */
  }
}

// ---------------------------------------------------------------- where each step looks

function busiestDistrict(ctx: ClientContext): string | null {
  const score = new Map<string, number>();
  for (const a of ctx.store.agents.values()) {
    if (a.islandId === "harness") continue;
    score.set(a.islandId, (score.get(a.islandId) ?? 0) + (a.status === "live" ? 1000 : 0) + 1);
  }
  let best: string | null = null;
  let bestN = -1;
  for (const [id, n] of score) if (n > bestN && ctx.cityPosition(id)) [best, bestN] = [id, n];
  return best;
}

function recentHouse(ctx: ClientContext): THREE.Vector3 | undefined {
  const agents = [...ctx.store.agents.values()].sort(
    (a, b) => (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) || Date.parse(b.lastActive) - Date.parse(a.lastActive),
  );
  for (const a of agents) {
    const p = ctx.agentPosition(a.id);
    if (p) return p;
  }
  return undefined;
}

/** One factory of the routines ring (the ring's centre is Harness City itself): the one nearest
 *  the quarter, so the flight from the memory buildings is short. */
function routinesSpot(ctx: ClientContext): THREE.Vector3 | undefined {
  const o = ctx.scene.getObjectByName("routines-district");
  const ref = placeTop("procedural") ?? ctx.camera.position;
  let best: THREE.Vector3 | undefined;
  for (const child of o?.children ?? []) {
    if (!(child instanceof THREE.Group)) continue;
    const p = child.getWorldPosition(new THREE.Vector3());
    if (!best || p.distanceToSquared(ref) < best.distanceToSquared(ref)) best = p;
  }
  return best;
}

/** Camera position (world) for a step; null = stay where it is. */
function cameraFor(step: TourStep, ctx: ClientContext): THREE.Vector3 | null {
  const t = step.target;
  let point: THREE.Vector3 | undefined;
  switch (t.kind) {
    case "overview":
      return ctx.camera.position.clone().setLength(PLANET_R * 3.3);
    case "moon": {
      const m = ctx.scene.getObjectByName("jev-moon")?.getWorldPosition(new THREE.Vector3());
      if (!m) return null;
      // Behind the moon, looking back at it and the planet.
      return m.clone().setLength(m.length() + 42);
    }
    case "district": {
      const id = busiestDistrict(ctx);
      point = id ? ctx.cityPosition(id) : undefined;
      break;
    }
    case "house":
      point = recentHouse(ctx);
      break;
    case "place":
      point = placeTop(t.id);
      break;
    case "harness":
      point = ctx.cityPosition("harness");
      break;
    case "routines":
      point = routinesSpot(ctx);
      break;
  }
  if (!point) return null;
  // Like the hub's flyToCity: land "south" of the spot so the flyover tilt frames it at 3/4.
  // Heights are above the target itself (a tower top sits well above the ground).
  const hgt = step.height;
  const base = Math.max(PLANET_R, point.length());
  const dir = point.clone().normalize();
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
  // 1.4× the hub's offset: the caption card covers the bottom of the view, so the spot sits higher.
  const cam = dir.multiplyScalar(base).addScaledVector(north, -hgt * 1.4 * tiltFor(hgt)).normalize();
  return cam.multiplyScalar(base + hgt);
}

/** Tell the hub a user is in charge of the camera (stops auto-rotate and the idle drift), the
 *  same way orbit-system's debug framing does: a zero wheel event on the canvas. */
function holdCamera(): void {
  sceneParts().rig?.renderer.domElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 }));
}

function flyTo(pos: THREE.Vector3 | null, ctx: ClientContext): void {
  if (!pos) return;
  holdCamera();
  if (prefersReducedMotion()) {
    ctx.camera.position.copy(pos);
    fly = null;
    return;
  }
  fly = { from: ctx.camera.position.clone().normalize(), to: pos.clone().normalize(), fromDist: ctx.camera.position.length(), toDist: pos.length(), t0: ctx.elapsed() };
}

const q = new THREE.Quaternion();
const qi = new THREE.Quaternion();
const dirTmp = new THREE.Vector3();

/** Timed on the render clock (not summed frame dt), so a slow frame never stretches the flight. */
function updateFly(ctx: ClientContext): void {
  if (!fly) return;
  const t = Math.min(1, (ctx.elapsed() - fly.t0) / FLY_S);
  const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  q.setFromUnitVectors(fly.from, fly.to);
  dirTmp.copy(fly.from).applyQuaternion(qi.identity().slerp(q, e));
  const hop = Math.sin(Math.PI * e) * fly.from.angleTo(fly.to) * 16;
  ctx.camera.position.copy(dirTmp).multiplyScalar(fly.fromDist + (fly.toDist - fly.fromDist) * e + hop);
  if (t >= 1) fly = null;
}

// ---------------------------------------------------------------- the caption card

function renderCard(ctx: ClientContext): void {
  if (!state.active) {
    card?.remove();
    card = null;
    document.body.classList.remove("alef-touring");
    return;
  }
  const step = TOUR_STEPS[state.index];
  if (!step) return;
  document.body.classList.add("alef-touring");
  if (!card) {
    card = h("section", "xp-tour-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Guided tour");
    document.body.append(card);
  }
  const last = state.index === TOUR_STEPS.length - 1;
  const head = h("div", "xp-tour-head");
  head.append(h("span", "xp-tour-count", stepCounter(state.index)), h("h3", "xp-tour-title", step.title));
  const bar = h("div", "xp-tour-bar");
  const fill = h("i");
  fill.style.width = `${((state.index + 1) / TOUR_STEPS.length) * 100}%`;
  bar.append(fill);
  const btns = h("div", "xp-tour-btns");
  const mk = (text: string, action: TourAction, cls: string, title: string): HTMLButtonElement => {
    const b = h("button", `alef-fchip ${cls}`, text);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", () => dispatch(action, ctx));
    return b;
  };
  const back = mk("← Back", { type: "back" }, "xp-back", "Previous step");
  back.disabled = state.index === 0;
  btns.append(mk("Skip tour", { type: "skip" }, "xp-skip", "Leave the tour (Esc)"), back, mk(last ? "Finish ✓" : "Next →", { type: "next" }, "xp-next on", last ? "End the tour" : "Next step"));
  card.replaceChildren(head, bar, h("p", "xp-tour-cap", step.caption), btns);
  (btns.lastElementChild as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

function dispatch(action: TourAction, ctx: ClientContext): void {
  const wasActive = state.active;
  const prevIndex = state.index;
  state = tourReducer(state, action);
  if (wasActive && !state.active) {
    writeMemory({ seen: true });
    fly = null;
    log.info("tour", action.type === "next" ? "tour finished" : `tour left at step ${prevIndex + 1}`);
  }
  if (state.active && (!wasActive || state.index !== prevIndex)) {
    const step = TOUR_STEPS[state.index];
    if (step) flyTo(cameraFor(step, ctx), ctx);
  }
  renderCard(ctx);
}

/** Start (or restart) the tour; switches to the Orbit first. */
export function startTour(): void {
  const ctx = ctxRef;
  if (!ctx) return;
  if (ctx.activeView() !== "orbit") ctx.showView("orbit");
  dispatch({ type: "start" }, ctx);
}

export function tourActive(): boolean {
  return state.active;
}

// ---------------------------------------------------------------- feature

export const tourFeature: ClientFeature = {
  id: "tour",
  mount(ctx) {
    ctxRef = ctx;
    window.addEventListener(
      "keydown",
      (ev) => {
        if (!state.active) return;
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          dispatch({ type: "escape" }, ctx);
        } else if (ev.key === "ArrowRight" && !(ev.target instanceof HTMLInputElement)) dispatch({ type: "next" }, ctx);
        else if (ev.key === "ArrowLeft" && !(ev.target instanceof HTMLInputElement)) dispatch({ type: "back" }, ctx);
      },
      true,
    );
    // Closing or reloading mid-tour never reaches dispatch's "left" branch: count it as seen here,
    // and recover a memory an older build left stuck at {seen:false, autoStarted:true}.
    window.addEventListener("pagehide", () => {
      if (state.active) writeMemory({ seen: true });
    });
    const recovered = recoverStuckTour(readMemory());
    if (recovered) {
      writeMemory(recovered);
      log.info("tour", "an unfinished auto-started tour now counts as seen (Help can restart it)");
    }
    // Auto-start: once ever, on the Orbit, after the welcome card, never under automation.
    let welcomed = false;
    try {
      welcomed = localStorage.getItem(WELCOME_KEY) === "1";
    } catch {
      welcomed = false;
    }
    const params = new URLSearchParams(location.search);
    const automated = navigator.webdriver === true || params.has("perf") || params.get("tour") === "0";
    // ?tour=1[&step=N] starts it (screenshots / a shared link); N is 1-based.
    if (params.get("tour") === "1") {
      window.setTimeout(() => {
        startTour();
        const n = Number(params.get("step"));
        if (Number.isInteger(n) && n > 1) dispatch({ type: "goto", index: n - 1 }, ctx);
      }, 1500);
    }
    else if (!automated && shouldAutoStart(readMemory(), welcomed)) {
      window.setTimeout(() => {
        if (ctx.activeView() !== "orbit" || state.active) return;
        writeMemory({ autoStarted: true });
        startTour();
      }, 4000);
    }
  },
  onFrame(_dt, ctx) {
    if (!state.active) return;
    updateFly(ctx);
    // Keep the hub's idle camera (20s) from drifting away while a caption is being read.
    const now = ctx.elapsed();
    if (now - keepAwakeAt > 6) {
      keepAwakeAt = now;
      holdCamera();
    }
    if (ctx.activeView() !== "orbit") dispatch({ type: "skip" }, ctx);
  },
  onEscape(ctx) {
    if (!state.active) return false;
    dispatch({ type: "escape" }, ctx);
    return true;
  },
  paletteCommands: () => [
    {
      id: "start",
      title: "Take the tour: how the system works (2 min)",
      kind: "command",
      keywords: ["tour", "guide", "explain", "help", "onboarding", "how does it work"],
      run: () => startTour(),
    },
  ],
};
