// Pure, DOM/THREE-free logic for "game feel" (P4a, round 10): per-state creature animation,
// celebration rate limits, the todo-completion edge detector, the "SHIPPED!" git-commit
// detector, and the waiting-agent bubble text. Kept separate from game-feel.ts / life.ts /
// celebrate.ts / call-for-you.ts (which touch THREE/DOM) so it is trivially unit-testable
// under vitest, the way sky-lib.ts is split from sky.ts.

import type { AgentState } from "../../../../shared/features/agent-state";
import type { AgentActivity } from "../../../../shared/types";

// ---------------------------------------------------------------- creature state -> animation

export interface CreatureAnim {
  /** Multiplies the existing per-family bob frequency. */
  bobRate: number;
  /** Extra bob amplitude, world units. */
  bobAmp: number;
  /** How the creature moves around its lot. */
  pattern: "circle" | "pace" | "curl";
  /** Overall pose scale (>1 = a small "jump", <1 = curled small). */
  poseScale: number;
  /** Pauses to face the camera on a cycle (see facingCameraWindow). */
  facesCamera: boolean;
}

const ANIM_BY_STATE: Record<AgentState, (rate: number) => CreatureAnim> = {
  working: (rate) => ({ bobRate: 1.6 + rate * 2.6, bobAmp: 0.05 + rate * 0.14, pattern: "circle", poseScale: 1, facesCamera: false }),
  permission: () => ({ bobRate: 3.6, bobAmp: 0.24, pattern: "pace", poseScale: 1.16, facesCamera: true }),
  waiting: () => ({ bobRate: 0.9, bobAmp: 0.06, pattern: "pace", poseScale: 1, facesCamera: true }),
  idle: () => ({ bobRate: 0.35, bobAmp: 0.03, pattern: "circle", poseScale: 1, facesCamera: false }),
  sleeping: () => ({ bobRate: 0.16, bobAmp: 0.012, pattern: "curl", poseScale: 0.82, facesCamera: false }),
};

/** `activityRate` is 0..1 (see activityRate01); out-of-range values are clamped. */
export function creatureAnimFor(state: AgentState, activityRate: number): CreatureAnim {
  return ANIM_BY_STATE[state](Math.max(0, Math.min(1, activityRate)));
}

/** Linear blend of two poses, `k` 0 (a) .. 1 (b). The discrete fields snap at the midpoint. */
export function blendAnim(a: CreatureAnim, b: CreatureAnim, k: number): CreatureAnim {
  const t = Math.max(0, Math.min(1, k));
  return {
    bobRate: a.bobRate + (b.bobRate - a.bobRate) * t,
    bobAmp: a.bobAmp + (b.bobAmp - a.bobAmp) * t,
    poseScale: a.poseScale + (b.poseScale - a.poseScale) * t,
    pattern: t < 0.5 ? a.pattern : b.pattern,
    facesCamera: t < 0.5 ? a.facesCamera : b.facesCamera,
  };
}

/** 0..1 crossfade progress `durationS` after a state change (0 = just changed, 1 = settled).
 *  A non-positive duration is treated as "already settled" rather than dividing by zero. */
export function crossfadeK(secondsSinceChange: number, durationS = 0.3): number {
  if (durationS <= 0) return 1;
  return Math.max(0, Math.min(1, secondsSinceChange / durationS));
}

/** Counts one agent's AgentActivity rows within the last `windowMs` and normalizes 0..1 against
 *  `saturateAt` events (that many tool calls in the window reads as "fully busy"). Timestamps at
 *  or after `nowMs` (a clock skew / malformed line) are ignored rather than counted. */
export function activityRate01(activities: readonly AgentActivity[], agentId: string, nowMs: number, windowMs = 60_000, saturateAt = 8): number {
  if (saturateAt <= 0) return 0;
  let n = 0;
  for (const a of activities) {
    if (a.agentId !== agentId) continue;
    const at = Date.parse(a.at);
    if (Number.isFinite(at) && at <= nowMs && nowMs - at <= windowMs) n++;
  }
  return Math.max(0, Math.min(1, n / saturateAt));
}

/** True during a `windowS`-long slice of every `periodS` seconds — the "pause and look at you
 *  every ~4s" cadence. `phase` offsets each agent so a fleet doesn't turn in lockstep. */
export function facingCameraWindow(elapsedS: number, phase: number, periodS = 4, windowS = 1): boolean {
  if (periodS <= 0) return false;
  const t = (((elapsedS + phase) % periodS) + periodS) % periodS;
  return t < windowS;
}

/** Arrival "pop": 0 -> 1.1 -> 1 over the 0..1 progress of a fixed-duration window. Piecewise
 *  linear (cheap, no per-frame trig) with a single comic overshoot. */
export function arrivalPopScale(progress01: number): number {
  const u = Math.max(0, Math.min(1, progress01));
  return u < 0.6 ? (u / 0.6) * 1.1 : 1.1 - ((u - 0.6) / 0.4) * 0.1;
}

// ---------------------------------------------------------------- celebrations

/** At most one celebration per agent per `cooldownMs` (default 20s). Mutates `lastByAgent`. */
export function tryCelebrate(lastByAgent: Map<string, number>, agentId: string, nowMs: number, cooldownMs = 20_000): boolean {
  const last = lastByAgent.get(agentId);
  if (last !== undefined && nowMs - last < cooldownMs) return false;
  lastByAgent.set(agentId, nowMs);
  return true;
}

/** At most `max` (default 3) confetti bursts on screen at once. `active` holds each burst's
 *  expiry (ms); expired entries are pruned first, so a stuck caller can't wedge the cap open. */
export function canBurstConfetti(active: number[], nowMs: number, max = 3): boolean {
  for (let i = active.length - 1; i >= 0; i--) {
    if ((active[i] ?? 0) <= nowMs) active.splice(i, 1);
  }
  return active.length < max;
}

/** True exactly on the transition into "every todo done" (total > 0, done === total) — never
 *  for an empty list, and never twice in a row for the same already-all-done list. */
export function todoCompletedEdge(wasAllDone: boolean | undefined, done: number, total: number): boolean {
  const isAllDone = total > 0 && done === total;
  return isAllDone && wasAllDone !== true;
}

// ---------------------------------------------------------------- "SHIPPED!" (git commit)

/** A Bash activity whose summary is the "git commit" line the indexer already formats as
 *  "Bash: git commit -m …" (server/activity.ts). */
export function isGitCommitActivity(a: Pick<AgentActivity, "toolName" | "summary">): boolean {
  return a.toolName === "Bash" && /^Bash:\s*git\s+commit\b/.test(a.summary);
}

// ---------------------------------------------------------------- waiting-agent bubble text

/** Strips control characters and collapses whitespace, then caps at `max` chars with an
 *  ellipsis. Never throws on odd input (empty, whitespace-only, already-short, unicode). */
export function sanitizeBubbleText(text: string, max = 60): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The most recent "reason"-stage activity for `agentId` that reads like a question, newest
 *  first, from the shared activity ring buffer (client/src/state.ts, last ~50 fleet-wide
 *  events). Undefined when none is found — the caller falls back to a generic line. */
export function latestQuestionFor(activities: readonly AgentActivity[], agentId: string): string | undefined {
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i];
    if (a && a.agentId === agentId && a.stage === "reason" && a.summary.trim().endsWith("?")) return a.summary;
  }
  return undefined;
}
