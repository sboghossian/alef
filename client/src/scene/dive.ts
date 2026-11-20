// Inbox → Room (also the call-for-you bubbles and voice "open its room"): on a visible planet the
// camera swoops down through the agent's house, and the Room opens when the swoop lands. Only a
// DRAWING frame of main.ts's render loop moves the camera, so a swoop needs 3D to be drawing. With
// WebGL off (2D-only boot) or its context lost, the house still exists (the scene graph is built,
// never drawn) and a swoop would park the Room forever: the click must open it directly.
//
// INVARIANT: while 3D is not drawing, a click opens the Room at once, and a swoop already in flight
// when 3D stops opens its Room on the next frame. A parked Room opens at most once, so a context
// restore never opens one by itself.

import type { AlefView } from "../shell/views";

export interface DiveInputs {
  /** The active view (shell.current()), null before the shell mounts. */
  view: Pick<AlefView, "usesPlanet" | "coversPlanet"> | null;
  /** agentsVisual.houseTopOf found the house. */
  hasHouse: boolean;
  reducedMotion: boolean;
  /** glStatus.drawing(): false when WebGL never started and while its context is lost. */
  drawing: boolean;
}

/** "swoop": fly through the house and park the Room until the landing. "direct": open it now. */
export function diveRoute(i: DiveInputs): "swoop" | "direct" {
  const planetShowing = i.view?.usesPlanet === true && i.view.coversPlanet !== true;
  return i.hasHouse && planetShowing && !i.reducedMotion && i.drawing ? "swoop" : "direct";
}

/** Is the parked Room due on this frame? At its landing time, or at once when 3D stops drawing
 *  mid-swoop: nothing would land it then, and a later restore would open it out of the blue. */
export function diveDue(at: number, elapsed: number, drawing: boolean): boolean {
  return !drawing || elapsed >= at;
}

/** The Room a swoop opens when it lands. main.ts calls take() on EVERY frame, drawing or not. */
export interface DiveLanding {
  park(agentId: string, at: number): void;
  /** The agent whose Room opens now, or null. Clears what it returns. */
  take(elapsed: number, drawing: boolean): string | null;
}

export function createDiveLanding(): DiveLanding {
  let parked: { agentId: string; at: number } | null = null;
  return {
    park(agentId, at) {
      parked = { agentId, at };
    },
    take(elapsed, drawing) {
      if (!parked || !diveDue(parked.at, elapsed, drawing)) return null;
      const id = parked.agentId;
      parked = null;
      return id;
    },
  };
}
