// Pure, DOM/WebAudio/YouTube-free helpers for the "claude-fm" client feature: persisted
// player state, the duck-while-something-else-talks volume math, and the `M` shortcut's
// typing/overlay guard. The impure glue (localStorage, the IFrame API, the DOM) lives in
// ./claude-fm.ts and ./youtube.ts; this file is what's unit-tested (see ./claude-fm-logic.test.ts).

import type { FlagStore } from "../../ui/kit";

export const FM_VOLUME_KEY = "agent-world.fm.volume";
export const FM_MUTED_KEY = "agent-world.fm.muted";
export const FM_WAS_PLAYING_KEY = "agent-world.fm.wasPlaying";

export const DEFAULT_FM_VOLUME = 60;
/** How much the music ducks under while Jev is speaking or a sound cue is playing. */
export const DUCK_MULTIPLIER = 0.3;

export interface FmState {
  /** 0..100, the YouTube IFrame API's own volume range. */
  volume: number;
  muted: boolean;
  /** Whether the user had it playing when the tab last closed — drives "Tap play to resume". */
  wasPlaying: boolean;
}

function clampVolume(v: number): number {
  return Math.round(Math.min(100, Math.max(0, v)));
}

/** Reads persisted state; a missing/blocked/corrupt store is the same as a first visit. */
export function loadFmState(store: FlagStore | null): FmState {
  const readNum = (key: string, fallback: number): number => {
    try {
      const raw = store?.getItem(key);
      const n = raw === null || raw === undefined ? NaN : Number(raw);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  };
  const readBool = (key: string): boolean => {
    try {
      return store?.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  return {
    volume: clampVolume(readNum(FM_VOLUME_KEY, DEFAULT_FM_VOLUME)),
    muted: readBool(FM_MUTED_KEY),
    wasPlaying: readBool(FM_WAS_PLAYING_KEY),
  };
}

function writeItem(store: FlagStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* private mode / quota: just won't be remembered */
  }
}

export function saveFmVolume(store: FlagStore | null, volume: number): void {
  writeItem(store, FM_VOLUME_KEY, String(clampVolume(volume)));
}

export function saveFmMuted(store: FlagStore | null, muted: boolean): void {
  writeItem(store, FM_MUTED_KEY, muted ? "1" : "0");
}

export function saveFmWasPlaying(store: FlagStore | null, wasPlaying: boolean): void {
  writeItem(store, FM_WAS_PLAYING_KEY, wasPlaying ? "1" : "0");
}

/** The multiplier to apply on top of the user's chosen volume. Pure so duck/restore is
 *  testable without WebAudio or the YouTube player. */
export function duckMultiplier(ducking: boolean): number {
  return ducking ? DUCK_MULTIPLIER : 1;
}

/** The volume (0..100, integer) to actually send to the player right now. */
export function effectiveVolume(state: Pick<FmState, "volume" | "muted">, ducking: boolean): number {
  if (state.muted) return 0;
  return clampVolume(state.volume * duckMultiplier(ducking));
}

export interface FmKeyGuardInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** The event target is a text input / textarea / select / contenteditable. */
  isTyping: boolean;
  /** A modal (palette, help, welcome, a dialog…) owns the keyboard right now. */
  overlayOpen: boolean;
}

/** True when a keydown should toggle Claude FM play/pause. Kept pure (no DOM in the
 *  signature) so the "ignored while typing" guard is testable without a real KeyboardEvent. */
export function isFmToggleKey(ev: FmKeyGuardInput): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (ev.isTyping || ev.overlayOpen) return false;
  return ev.key === "m" || ev.key === "M";
}

/** How far above the viewport's bottom edge the popover's own bottom edge should sit.
 *  `shellClearPx` is the status bar + prompt/dispatch box heights the shell itself already
 *  tracks (--alef-bottom + --alef-prompt); `buttonTopFromBottomPx` is the FM button's own top,
 *  measured from the bottom of the viewport. Round 9: docking above only the button's own top
 *  (inside the status bar) left the popover overlapping the prompt box's quick-prompt chips and
 *  per-view note text in Voice/Code/Brain, since the dispatch box sits ABOVE the status bar the
 *  button lives in. Taking the max of both keeps it clear of the taller of the two, and falls
 *  back to the old button-relative distance if the shell vars are ever unavailable. */
export function popoverBottomOffset(shellClearPx: number, buttonTopFromBottomPx: number, gapPx = 8): number {
  return Math.max(shellClearPx, buttonTopFromBottomPx) + gapPx;
}
