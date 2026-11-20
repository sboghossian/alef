// Pure, DOM/THREE-free logic for adaptive render quality and the camera-fly easing it shares
// with main.ts's fly block (P4b, round 10). Everything here is unit-tested in quality-lib.test.ts.

export type QualityTier = 0 | 1 | 2;
export type QualityMode = QualityTier | "auto";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------- camera fly (shared with main.ts)

/** duration = clamp(0.6 + 0.9·arcAngle/π, 0.6, 1.5)s: short hops feel snappy, long ones stay readable. */
export function flyDuration(arcAngleRadians: number): number {
  return clamp(0.6 + (0.9 * arcAngleRadians) / Math.PI, 0.6, 1.5);
}

/** A ~6% overshoot-and-settle (easeOutBack) for the distance-only part of an arrival fly.
 *  f(0)=0, f(1)=1, peaks ≈1.06 around t≈0.6 — a "back" curve tuned to a 6% overshoot rather
 *  than the standard easing libraries' ~10%. */
export function overshootEase(t: number): number {
  const c1 = 1.2825;
  const c3 = c1 + 1;
  const u = clamp(t, 0, 1) - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// ---------------------------------------------------------------- adaptive quality tiers

export interface HysteresisState {
  tier: QualityTier;
  /** ms timestamp the fps first dropped below the step-down floor, or null while it isn't. */
  lowSince: number | null;
  /** ms timestamp the fps first rose above the step-up ceiling, or null while it isn't. */
  highSince: number | null;
}

export const INITIAL_HYSTERESIS: HysteresisState = { tier: 0, lowSince: null, highSince: null };

const STEP_DOWN_FPS = 40;
const STEP_UP_FPS = 55;
const STEP_DOWN_MS = 3000;
const STEP_UP_MS = 10000;

/** One hysteresis tick from a fresh fps reading. `allowStepDown` is false under `?perf=headless`
 *  so automated screenshots never see the quality drop mid-run. Sustained readings only: a fps
 *  back in the dead zone (40–55) resets both timers rather than banking partial progress. */
export function stepHysteresis(state: HysteresisState, fps: number, nowMs: number, opts: { allowStepDown: boolean }): HysteresisState {
  if (opts.allowStepDown && fps < STEP_DOWN_FPS) {
    const lowSince = state.lowSince ?? nowMs;
    if (state.tier < 2 && nowMs - lowSince >= STEP_DOWN_MS) return { tier: (state.tier + 1) as QualityTier, lowSince: null, highSince: null };
    return { tier: state.tier, lowSince, highSince: null };
  }
  if (fps > STEP_UP_FPS) {
    const highSince = state.highSince ?? nowMs;
    if (state.tier > 0 && nowMs - highSince >= STEP_UP_MS) return { tier: (state.tier - 1) as QualityTier, lowSince: null, highSince: null };
    return { tier: state.tier, lowSince: null, highSince };
  }
  return { tier: state.tier, lowSince: null, highSince: null };
}

/** "auto" defers to the hysteresis-chosen tier; a fixed mode wins outright. */
export function resolveTier(mode: QualityMode, autoTier: QualityTier): QualityTier {
  return mode === "auto" ? autoTier : mode;
}

/** tier 0: full-dpr (capped at 2x). tier 1: 1.5x flat. tier 2: 1x (no supersampling). */
export function pixelRatioFor(tier: QualityTier, dpr: number): number {
  if (tier === 0) return Math.min(dpr, 2);
  if (tier === 1) return 1.5;
  return 1;
}
