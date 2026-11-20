// Pure half of the client "tripwires" feature (no DOM): merge hits from the snapshot and WS,
// pick one agent's hits for its panel badge, and turn a hit into a Feed item of kind "tripwire".
// Hit text (snippet, district) is untrusted: callers render it with textContent / escapeHtml.

import { TRIPWIRES_HIT_CAP, type TripwireHit } from "../../../shared/features/tripwires";
import type { FeedItem } from "../shell/feed-types";

export const BADGE_PREFIX = "⚠ repeats lesson: ";
const BADGE_LESSON_MAX = 90;

/** Newest first, one entry per hit id (a later copy of the same id replaces the earlier one), capped. */
export function mergeHits(prev: readonly TripwireHit[], incoming: readonly TripwireHit[], cap = TRIPWIRES_HIT_CAP): TripwireHit[] {
  const byId = new Map<string, TripwireHit>();
  for (const h of prev) byId.set(h.id, h);
  for (const h of incoming) byId.set(h.id, h);
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1)).slice(0, cap);
}

/** This agent's hits, newest first. */
export function hitsForAgent(hits: readonly TripwireHit[], agentId: string): TripwireHit[] {
  return hits.filter((h) => h.sessionId === agentId);
}

/** "⚠ repeats lesson: <lesson>", the lesson capped so a badge stays one line. */
export function badgeText(hit: TripwireHit): string {
  const lesson = hit.lesson.length > BADGE_LESSON_MAX ? `${hit.lesson.slice(0, BADGE_LESSON_MAX - 1).trimEnd()}…` : hit.lesson;
  return `${BADGE_PREFIX}${lesson}`;
}

/** A hit as one Feed row. `agentTitle` is the session's display title when the store knows it. */
export function hitToFeedItem(hit: TripwireHit, agentTitle: string | undefined): FeedItem {
  const at = Date.parse(hit.at);
  return {
    id: `tw:${hit.id}`,
    kind: "tripwire",
    at: Number.isFinite(at) ? at : Date.now(),
    title: `Repeats a lesson: ${hit.lesson}`,
    detail: [agentTitle ?? `session ${hit.sessionId.slice(0, 8)}`, hit.subagentId ? "via a subagent" : null, hit.district, hit.snippet].filter(Boolean).join(" · "),
    agentId: hit.sessionId,
  };
}
