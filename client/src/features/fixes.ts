// "fixes" feature: keeps the Fix queue's open count (server/features/fixes.ts) where the shell can
// see it: the status bar's Health chip tooltip, and the Health view's Fix queue section, which
// re-reads the queue when the count moves. The queue itself is views/fix-queue.ts.

import { FIX_SOURCES, FIXES_EXTRAS_KEY, type FixesSummary, type FixSource } from "../../../shared/features/fixes";
import { chipQueueLine } from "../views/fix-queue-lib";
import { setHealthChipNote } from "./completeness";
import { isRecord } from "./fleet-overlay";
import type { ClientFeature } from "./registry";

let latest: FixesSummary | null = null;
const listeners = new Set<(s: FixesSummary) => void>();

function parseSummary(v: unknown): FixesSummary | null {
  if (!isRecord(v) || typeof v.open !== "number" || typeof v.generatedAt !== "string" || !Array.isArray(v.pending)) return null;
  return { generatedAt: v.generatedAt, open: v.open, pending: (v.pending as unknown[]).filter((p): p is FixSource => (FIX_SOURCES as readonly unknown[]).includes(p)) };
}

function apply(s: FixesSummary): void {
  latest = s;
  setHealthChipNote(chipQueueLine(s.open));
  for (const fn of listeners) fn(s);
}

/** The queue's latest summary, or null before the server sent one. */
export function currentFixesSummary(): FixesSummary | null {
  return latest;
}

/** Called on every summary the server pushes (the open count changed). Returns its unsubscribe. */
export function onFixesSummary(fn: (s: FixesSummary) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const fixesFeature: ClientFeature = {
  id: "fixes",
  onSnapshot(world) {
    const s = parseSummary(world.extras?.[FIXES_EXTRAS_KEY]);
    if (s) apply(s);
  },
  onMessage(msg) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "summary") return;
    const s = parseSummary(p.summary);
    if (s) apply(s);
  },
};
