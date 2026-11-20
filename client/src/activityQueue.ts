import type { AgentActivity } from "../../shared/types";

/**
 * Throttles activity visuals so a burst of 50 lines does not strobe:
 * keeps only the newest pending activity per agent, caps the queue, and
 * releases at most one item per `intervalMs`.
 */
export class ActivityQueue {
  private pending: AgentActivity[] = [];
  private lastRelease = -Infinity;

  constructor(
    private readonly intervalMs = 280,
    private readonly maxPending = 10,
  ) {}

  push(list: AgentActivity[]): void {
    for (const a of list) {
      this.pending = this.pending.filter((p) => p.agentId !== a.agentId);
      this.pending.push(a);
    }
    if (this.pending.length > this.maxPending) this.pending = this.pending.slice(-this.maxPending);
  }

  /** The next activity to animate, or null if it is too soon / nothing is queued. */
  take(nowMs: number): AgentActivity | null {
    if (!this.pending.length || nowMs - this.lastRelease < this.intervalMs) return null;
    this.lastRelease = nowMs;
    return this.pending.shift() ?? null;
  }

  get size(): number {
    return this.pending.length;
  }
}
