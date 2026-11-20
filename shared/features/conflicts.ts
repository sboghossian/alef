// Wire types for the "conflicts" feature (A5): two sessions that wrote the same file
// within the last 30 minutes, where at least one of them is live.

export interface ConflictPair {
  a: string; // agent id (sorted: a < b)
  b: string;
  files: string[]; // absolute paths, ≤10
  at: string; // ISO of the latest write in the overlap
}

/** snapshot extras key "conflicts.pairs". */
export type ConflictsExtras = ConflictPair[];

/** WS payload: the full current set (it is small). */
export interface ConflictsMessage {
  kind: "pairs";
  pairs: ConflictPair[];
}
