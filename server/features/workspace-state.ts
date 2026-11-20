// The Town square's BROADCAST (the step Global Workspace Theory is named for): the server-side
// workspace (workspace.ts) publishes its top 5 here every minute; the president puts it in Jev's
// ranking state and the resident in its reflection prompt, both fenced as untrusted data. Each of
// them then reports back what it was shown, per Jev proposal and per journal entry, and
// workspace.ts turns those notes into the influence share (GET /api/workspace/influence).
//
// No feature imports on purpose: president.ts and resident.ts import this file, and workspace.ts
// imports them (for their current state), so a cycle is never possible.

import type { PresidentProposal } from "../../shared/features/president.js";
import { agoText, URGENCY_LABEL, type WorkspaceEntry } from "../../shared/workspace/scorer.js";
import { fenceSafe, oneLine } from "./resident-lib.js";

/** A top 5 older than this is never handed out: the workspace tick stalled or kept failing. */
export const BROADCAST_STALE_MS = 5 * 60_000;
/** One broadcast line, at most (the resident's per-reflection cost is capped through this). */
export const BROADCAST_LINE_MAX = 150;

export interface WorkspaceBroadcast {
  computedAt: number;
  top: readonly WorkspaceEntry[];
}

/** Who reads the broadcast. Each is shown the top 5 minus the entries it produced itself (Jev's
 *  own proposals and decisions, the resident's own proposals and journal): what it already said is
 *  not news to it, and it could never count as its own influence. */
export type BroadcastAudience = "jev" | "resident";
const OWN_ORIGIN: Readonly<Record<BroadcastAudience, string>> = { jev: "Jev", resident: "resident" };

let latest: WorkspaceBroadcast | null = null;

export function publishWorkspace(b: WorkspaceBroadcast): void {
  latest = b;
}

/** The last top 5 as published (every origin), or null before the first; the vision ledger's
 *  town-square probe checks it against talk's stranded launches. */
export function latestWorkspaceBroadcast(): WorkspaceBroadcast | null {
  return latest;
}

/** The entries `audience` is shown now; null when there is no fresh broadcast (none computed yet,
 *  or the last one is older than BROADCAST_STALE_MS). An empty list is a real, empty square. */
export function workspaceFor(audience: BroadcastAudience, nowMs: number = Date.now()): WorkspaceEntry[] | null {
  if (!latest || nowMs - latest.computedAt > BROADCAST_STALE_MS) return null;
  return latest.top.filter((e) => e.origin !== OWN_ORIGIN[audience]);
}

/** The entries as the model reads them: one defanged line each (fenceSafe), capped, most salient
 *  first. The caller wraps them in its own UNTRUSTED_DATA fence. */
export function broadcastLines(entries: readonly WorkspaceEntry[], nowMs: number): string[] {
  return entries.map((e, i) => {
    const where = e.districts.length > 1 ? `${e.districts.length} districts` : (e.districts[0] ?? "no district");
    return fenceSafe(oneLine(`${i + 1}. ${URGENCY_LABEL[e.urgency]} · ${e.origin} · ${agoText(nowMs - e.at)} · ${where} · ${e.text}`, BROADCAST_LINE_MAX));
  });
}

/** What a reader was shown when it produced a proposal or a journal entry. `shown` is null when
 *  there was no fresh broadcast to show. For a proposal the rules fallback ranked (no Jev answer),
 *  `shown` is what Jev WOULD have been shown: the baseline the influence share is read against. */
export type InfluenceNote =
  | { source: "jev"; at: number; proposal: PresidentProposal; rankedBy: "jev" | "rules"; shown: readonly WorkspaceEntry[] | null }
  | { source: "resident"; at: number; journal: string; shown: readonly WorkspaceEntry[] | null };

const PENDING_CAP = 200;
const pending: InfluenceNote[] = [];
let sink: ((n: InfluenceNote) => void) | null = null;

/** Hands a note to the running workspace feature, or holds it (capped) until that feature's first tick. */
export function noteInfluence(n: InfluenceNote): void {
  if (sink) {
    sink(n);
    return;
  }
  pending.push(n);
  if (pending.length > PENDING_CAP) pending.splice(0, pending.length - PENDING_CAP);
}

/** The workspace feature subscribes once it knows where to persist; held notes flush first. */
export function subscribeInfluence(fn: (n: InfluenceNote) => void): void {
  sink = fn;
  for (const n of pending.splice(0)) fn(n);
}
