// Hold-to-confirm for REAL approval decisions made mid-flight. Pure state machine:
// a decision fires only after a fresh press held for holdMs on the same approval,
// with the card armed (visible for armMs) and the plane NOT boosting. Releasing early,
// boosting, or the approval changing cancels it; nothing is ever sent in those cases.

export type HoldAction = "allow" | "deny";

export const HOLD = { holdMs: 1000, armMs: 600 } as const;

export interface HoldFire {
  action: HoldAction;
  targetId: string;
}

export type PressResult = "started" | "no-target" | "not-armed" | "boosting" | "repeat" | "busy";

export class HoldToConfirm {
  private targetId: string | null = null;
  private shownAt = -Infinity;
  private action: HoldAction | null = null;
  private startedAt = 0;
  /** Fired (or cancelled by boost) and waiting for the key to come up before anything new. */
  private latched = false;

  constructor(
    private readonly holdMs: number = HOLD.holdMs,
    private readonly armMs: number = HOLD.armMs,
  ) {}

  /** The approval currently on the in-flight card (null = no card). A change cancels any hold. */
  setTarget(id: string | null, now: number): void {
    if (id === this.targetId) return;
    this.targetId = id;
    this.shownAt = now;
    this.action = null;
    this.latched = false;
  }

  target(): string | null {
    return this.targetId;
  }

  armed(now: number): boolean {
    return this.targetId !== null && now - this.shownAt >= this.armMs;
  }

  /** A key/button went down. `repeat` = OS key auto-repeat (never starts a hold). */
  press(action: HoldAction, now: number, opts: { boosting: boolean; repeat?: boolean }): PressResult {
    if (opts.repeat) return "repeat";
    if (this.targetId === null) return "no-target";
    if (!this.armed(now)) return "not-armed";
    if (opts.boosting) return "boosting";
    if (this.action !== null || this.latched) return "busy";
    this.action = action;
    this.startedAt = now;
    return "started";
  }

  /** The key/button came up: an unfinished hold is dropped (nothing sent). */
  release(action: HoldAction): void {
    if (this.action === action) this.action = null;
    if (this.action === null) this.latched = false;
  }

  /** Call every frame. Returns the decision exactly once when a hold completes. */
  update(now: number, boosting: boolean): HoldFire | null {
    if (this.action === null || this.targetId === null) return null;
    if (boosting) {
      this.action = null;
      this.latched = true;
      return null;
    }
    if (now - this.startedAt < this.holdMs) return null;
    const fire: HoldFire = { action: this.action, targetId: this.targetId };
    this.action = null;
    this.latched = true;
    return fire;
  }

  /** Which action is filling right now (null = none). */
  holding(): HoldAction | null {
    return this.action;
  }

  /** 0..1 fill of the radial meter. */
  progress(now: number): number {
    if (this.action === null) return 0;
    return Math.min(1, Math.max(0, (now - this.startedAt) / this.holdMs));
  }

  cancel(): void {
    this.action = null;
    this.latched = false;
  }
}
