// Client store for the Alef resident's live state. features/resident.ts feeds it from every source
// it has: the snapshot, the "resident" WS { kind: "state" } push, and the state an Approve /
// Dismiss / kill-switch POST returns. Readers that must stay current on an open page (the Town
// square's global workspace) subscribe with onChange. village-data.ts keeps its own snapshot-only
// copy for the diorama's resident room.

import { isResidentState, type ResidentState } from "../../../shared/features/resident";

class ResidentData {
  state: ResidentState | null = null;
  private readonly fns = new Set<() => void>();

  /** Takes a state off the wire. False (and nothing changes) when it isn't a valid one. */
  accept(v: unknown): boolean {
    if (!isResidentState(v)) return false;
    this.state = v;
    for (const fn of this.fns) fn();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

export const residentData = new ResidentData();
