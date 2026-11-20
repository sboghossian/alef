// Hold-to-confirm for the Feed's inline Approve / Deny. It reuses the courier's HoldToConfirm
// state machine (features/courier/hold.ts), one per visible approval: a decision fires only
// after a fresh press held for 1s, on an item that has been on screen for 0.6s. Releasing
// early, a key auto-repeat, or the item leaving the feed sends nothing. Then FeedSends /
// sendDecision: the row says "Sending…" and reads "Approved" only once the server took it.
// Pure, no DOM.

import { HOLD, HoldToConfirm, type HoldAction, type HoldFire, type PressResult } from "../features/courier/hold";

export class FeedHolds {
  private readonly holds = new Map<string, HoldToConfirm>();

  constructor(
    private readonly holdMs: number = HOLD.holdMs,
    private readonly armMs: number = HOLD.armMs,
  ) {}

  /** The approvals currently rendered in the feed. New ones start their arm timer at `now`; gone ones are dropped. */
  sync(visibleIds: readonly string[], now: number): void {
    const keep = new Set(visibleIds);
    for (const id of this.holds.keys()) if (!keep.has(id)) this.holds.delete(id);
    for (const id of visibleIds) {
      if (this.holds.has(id)) continue;
      const h = new HoldToConfirm(this.holdMs, this.armMs);
      h.setTarget(id, now);
      this.holds.set(id, h);
    }
  }

  press(id: string, action: HoldAction, now: number, repeat = false): PressResult {
    const h = this.holds.get(id);
    if (!h) return "no-target";
    return h.press(action, now, { boosting: false, repeat });
  }

  release(id: string, action: HoldAction): void {
    this.holds.get(id)?.release(action);
  }

  /** Every frame while something is held. Each completed hold is returned exactly once. */
  tick(now: number): HoldFire[] {
    const out: HoldFire[] = [];
    for (const h of this.holds.values()) {
      const fire = h.update(now, false);
      if (fire) out.push(fire);
    }
    return out;
  }

  progress(id: string, now: number): { action: HoldAction | null; value: number } {
    const h = this.holds.get(id);
    return { action: h?.holding() ?? null, value: h?.progress(now) ?? 0 };
  }

  armed(id: string, now: number): boolean {
    return this.holds.get(id)?.armed(now) ?? false;
  }

  /** True while any hold is filling (the UI keeps its animation frame alive). */
  busy(): boolean {
    for (const h of this.holds.values()) if (h.holding()) return true;
    return false;
  }
}

// ---- sending a decision: the row is resolved only after the server said yes ----

/** An approval row whose decision is in flight ("Sending…", buttons off), or was refused (the row
 *  stays actionable and shows why). No state = nothing sent yet, or it went through. */
export type SendState = { phase: "sending"; action: HoldAction } | { phase: "failed"; action: HoldAction; reason: string };

export class FeedSends {
  private readonly states = new Map<string, SendState>();

  get(id: string): SendState | undefined {
    return this.states.get(id);
  }

  sending(id: string): boolean {
    return this.states.get(id)?.phase === "sending";
  }

  /** Forgets approvals that are no longer shown open (answered, expired, gone). */
  sync(openIds: readonly string[]): void {
    const keep = new Set(openIds);
    for (const id of this.states.keys()) if (!keep.has(id) && !this.sending(id)) this.states.delete(id);
  }

  /** One decision in flight per approval: false when one already is. */
  begin(id: string, action: HoldAction): boolean {
    if (this.sending(id)) return false;
    this.states.set(id, { phase: "sending", action });
    return true;
  }

  succeed(id: string): void {
    this.states.delete(id);
  }

  fail(id: string, action: HoldAction, reason: string): void {
    this.states.set(id, { phase: "failed", action, reason });
  }
}

export interface SendDeps {
  /** The real POST; rejects with the (readable) reason when the server did not take it. */
  decide(approvalId: string, action: HoldAction): Promise<void>;
  /** Marks the Feed item ("ap:<id>") decided. */
  resolve(itemId: string, outcome: HoldAction): void;
  /** Re-render: the row enters and leaves "Sending…". */
  changed(): void;
}

/** Sends one decision from the Feed. Returns true when the server took it. */
export async function sendDecision(sends: FeedSends, approvalId: string, action: HoldAction, deps: SendDeps): Promise<boolean> {
  if (!sends.begin(approvalId, action)) return false;
  deps.changed();
  try {
    await deps.decide(approvalId, action);
    sends.succeed(approvalId);
    deps.resolve(`ap:${approvalId}`, action);
    return true;
  } catch (err) {
    sends.fail(approvalId, action, err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    deps.changed();
  }
}
