// Wire types for the "village" feature: real links between Claude Code sessions, shown as
// rope bridges + a Town square feed in the #/room/all 3D village diorama (client/src/views/
// village-3d.ts). The only link type that needs server-side indexing is (c) inter-session
// messages — same-repo (a) and parent→subagent (b) links are derived client-side from data
// other features already have (WorldAgent.islandId, shared/features/subagents.ts).
//
// A message is an OBSERVATION off untrusted transcript text (server/features/village-lib.ts):
// the `to`/`from` a SendMessage call or a `<cross-session-message>` wrapper uses is a Claude
// Code session/teammate NAME, which is not part of WorldAgent (sessions have no stored "name"
// field here) — so `fromSessionId`/`toSessionId` are a best-effort resolution and are `null`
// when nothing lines up. Never invent a resolution: unresolved stays unresolved. Snapshot key:
// "village.messages".

export const VILLAGE_FEATURE_ID = "village";
export const VILLAGE_MESSAGES_KEY = "village.messages";
/** Server prunes anything older than this on every snapshot read. */
export const VILLAGE_MESSAGE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Server + client both cap the list here (newest first). */
export const VILLAGE_MESSAGE_CAP = 200;

export type VillageMessageDirection = "sent" | "received";

export interface VillageMessage {
  /** Stable per observation (see server/features/village-lib.ts's messageId). */
  id: string;
  at: string; // ISO
  /** How this was observed: off the sender's own SendMessage call ("sent"), or off the
   *  `<cross-session-message>` wrapper the receiver's transcript shows ("received"). The same
   *  real message can appear as both an independent "sent" and "received" row when both ends
   *  are indexed sessions — they are not correlated into one row (see village-lib.ts). */
  direction: VillageMessageDirection;
  /** Resolved sender session id, when known. Always set (= the indexed session) for "sent". */
  fromSessionId: string | null;
  /** The raw name/ref as it appeared in the transcript (always present, for an honest fallback label). */
  fromRaw: string;
  /** Resolved recipient session id, when known. Always set (= the indexed session) for "received". */
  toSessionId: string | null;
  toRaw: string;
  /** Plain text, first line only, ≤140 chars. */
  preview: string;
}

export type VillageFeatureMessage = { kind: "messages"; messages: VillageMessage[] };
