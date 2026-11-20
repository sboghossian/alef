// Wire types for the "feed" feature: ONE ordered stream of everything happening —
// agent activity, Jev decisions, approvals (requested / resolved), routine runs.
//
//   GET /api/feed?since=<seq>&limit=   → FeedResponse (items with seq > since, oldest first; limit ≤500, default 200:
//                                         the NEWEST `limit` of them)
//   GET /api/feed?since=<seq>&before=<seq>&limit=   → the same, only items with seq < before (paging back)
//   WS  { type:"feature", feature:"feed", payload: FeedMessage }   pushes new items as they happen
// seq is monotonic per server boot; when bootId changes, drop the local feed and refetch from 0.

// "tripwire": any server feature may publish one with appendToFeed (server/features/feed.ts); the
// client bridges it into the live Feed, where the Town square's global workspace scores it
// (client/src/features/feed-bridge.ts, workspace-lib.ts).
// "graduation": the outcomes feature's transition of a session into shipped or delivered
// (server/features/outcomes.ts), once per session and outcome, only for evidence under 24h old.
// "decision": the store's Jev decisions (director.ts) and the governance decisions (GovTag below).
// The server keeps every item for at least 2 h (a time floor, not only a count cap: feed.ts).
export type FeedKind = "activity" | "decision" | "approval" | "approval-resolved" | "routine" | "mac" | "tripwire" | "graduation";

export interface FeedItem {
  id: string; // stable per source item
  seq: number; // monotonic within one bootId
  at: string; // ISO, source time
  kind: FeedKind;
  agentId: string | null;
  title: string; // one sanitized line
  detail: string | null;
  /** activity: ActivityStage · routine: "started" | "finished" · approval: tool name ·
   *  decision: the store's DecisionKind ("grow"…), or a GovTag for a governance decision. */
  tag: string | null;
}

// Governance decisions (server/features/governance-lib.ts builds them): kind "decision" with a
// "gov:<source>" tag, one item per real event. The client bridge forwards exactly these
// (client/src/features/feed-bridge.ts): "gov:jev" (Jev's own ranking of the president's board)
// as a Jev decision, every other source as a system line. The store's own decisions (tag
// "grow"…) never carry the prefix, so the two never double up.
export const GOV_TAG_PREFIX = "gov:";
/** jev: Jev ranked the president's board · click: Alex launched, dismissed, merged or retired a
 *  proposal (the president's or the resident's) · council: a council verdict · resident: the
 *  resident filed or withdrew a proposal · census: a PR merged into this repo · health: the Health
 *  keeper's nightly pass ("Health: N%", server/features/health-keeper.ts). */
export type GovSource = "jev" | "click" | "council" | "resident" | "census" | "health";
export type GovTag = `gov:${GovSource}`;

export function govTag(source: GovSource): GovTag {
  return `${GOV_TAG_PREFIX}${source}`;
}

/** Which of the store's own decisions (director.ts) reach a Feed. "grow" is the planet's cosmetic
 *  growth step, ~1 a minute: it stays in the store (the planet draws it, Explain counts it) but is
 *  not news, so neither the server feed nor the client's live Feed carry it. */
export function isFeedDecision(d: { kind: string }): boolean {
  return d.kind !== "grow";
}

export interface FeedResponse {
  ok: true;
  bootId: string;
  cursor: number; // highest seq on the server
  items: FeedItem[];
}

export interface FeedMessage {
  kind: "items";
  bootId: string;
  items: FeedItem[];
}
