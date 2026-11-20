// One way to say how old a feed is and when it has gone stale, so Vault, Brain and anything else
// built on the vault's hourly graph feed agree with each other and with Health's check.

import { FEED_STALE_MS } from "../../../shared/features/vault";

export { FEED_STALE_MS };

/** 30 s → "just now", 47 h → "47 h ago", 72 h → "3 d ago". */
export function ageLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** Age of an ISO build time. No (or an unreadable) time counts as stale: nothing says it is fresh. */
export function freshness(iso: string, nowMs: number, staleMs = FEED_STALE_MS): { ageMs: number | null; label: string; stale: boolean } {
  const built = Date.parse(iso);
  if (!Number.isFinite(built)) return { ageMs: null, label: "no build time", stale: true };
  const ageMs = Math.max(0, nowMs - built);
  return { ageMs, label: ageLabel(ageMs), stale: ageMs > staleMs };
}
