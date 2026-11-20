// Pure, DOM/THREE-free helpers for the "routines" client feature: where each factory
// sits in the district ring, and the human "in 3h 12m" countdown text.

export interface FactorySlot {
  ring: number;
  angle: number;
}

const PER_RING = 8;

/** Deterministic ring layout so the Nth routine always lands in the same slot between
 *  refreshes (routines are sorted by shortName before this is called). */
export function factorySlots(count: number): FactorySlot[] {
  return Array.from({ length: count }, (_, i) => ({
    ring: Math.floor(i / PER_RING),
    angle: (i % PER_RING) * ((Math.PI * 2) / PER_RING) + Math.floor(i / PER_RING) * 0.35,
  }));
}

/** "in 3h 12m" / "in 45m" / "due now" / "—" (no known schedule). */
export function formatCountdown(nextRunAtIso: string | null, nowMs: number): string {
  if (!nextRunAtIso) return "—";
  const diff = Date.parse(nextRunAtIso) - nowMs;
  if (!Number.isFinite(diff)) return "—";
  if (diff <= 0) return "due now";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}
