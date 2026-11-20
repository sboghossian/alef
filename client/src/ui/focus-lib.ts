// Round 5 E2/E3: the view-mode state machine behind Focus (F) and Zen (Z). Pure, no DOM,
// so the transitions are unit-tested; main.ts applies the effects (chrome mode, camera).

import type { ChromeMode } from "./kit";

export type BaseView = { mode: "normal" } | { mode: "focus"; agentId: string };
export type ViewState = BaseView | { mode: "zen"; prev: BaseView };

export type ViewEvent =
  /** F (or the Focus button). `target` = selected / hovered agent, null when there is none. */
  | { type: "focus"; target: string | null }
  | { type: "escape" }
  | { type: "zen" }
  /** Any key / click while in zen. */
  | { type: "wake" }
  /** A permission request arrived: zen steps aside so the card can show. */
  | { type: "approval" }
  /** The focused agent disappeared from the store. */
  | { type: "gone"; agentId: string };

export const NORMAL: BaseView = { mode: "normal" };

export function nextView(s: ViewState, e: ViewEvent): ViewState {
  if (s.mode === "zen") return e.type === "wake" || e.type === "approval" || e.type === "escape" ? s.prev : s;
  switch (e.type) {
    case "focus":
      if (s.mode === "focus") return e.target && e.target !== s.agentId ? { mode: "focus", agentId: e.target } : NORMAL;
      return e.target ? { mode: "focus", agentId: e.target } : s;
    case "escape":
      return s.mode === "focus" ? NORMAL : s;
    case "zen":
      return { mode: "zen", prev: s };
    case "gone":
      return s.mode === "focus" && s.agentId === e.agentId ? NORMAL : s;
    default:
      return s;
  }
}

/** Which chrome mode a view needs. `hiddenBefore` = H was on when the view was entered. */
export function chromeModeFor(v: ViewState, hiddenBefore: boolean): ChromeMode {
  if (v.mode === "zen") return "zen";
  if (v.mode === "focus") return "focus";
  return hiddenBefore ? "hidden" : "normal";
}

export function focusedAgent(v: ViewState): string | null {
  if (v.mode === "focus") return v.agentId;
  if (v.mode === "zen" && v.prev.mode === "focus") return v.prev.agentId;
  return null;
}

/** Soft chime: the focused agent just started waiting for you (from working / idle / unknown). */
export function enteredWaiting(prev: string | undefined, next: string | undefined): boolean {
  return next === "waiting" && prev !== "waiting" && prev !== undefined;
}
