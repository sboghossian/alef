// Wire types for the "neighbours" feature: each session's first and last MESSAGE, i.e. its first
// and last user or assistant transcript line (server/features/neighbours-lib.ts). The agent
// panel's crew rows window on these. They are deliberately NOT WorldAgent.startedAt / lastActive:
// the indexer moves those on any timestamped line (queue-operation, frame-link, attachment…) and
// falls back to the transcript's mtime when a pass reads only untimestamped lines.
//
// GET /api/neighbours/windows -> NeighboursWindowsResponse (ready: false and no rows until the
// server's one read-only scan of the already-indexed transcripts is done; it then pushes them all);
// WS payload { kind: "windows" } carries changed rows. Not in the snapshot: one row per session ever
// indexed made it hundreds of KB on a busy machine.

export const NEIGHBOURS_FEATURE_ID = "neighbours";
export const NEIGHBOURS_WINDOWS_PATH = "/api/neighbours/windows";

export interface MessageWindow {
  /** Session id. */
  id: string;
  /** ISO time of its first user or assistant line. */
  first: string;
  /** ISO time of its last user or assistant line. */
  last: string;
}

export type NeighboursFeatureMessage = { kind: "windows"; windows: MessageWindow[] };

export interface NeighboursWindowsResponse {
  ready: boolean;
  windows: MessageWindow[];
}
