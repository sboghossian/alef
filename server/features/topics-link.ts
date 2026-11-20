// In-process hand-off between the archive and topics features, so archived home/root sessions
// use the SAME batched, cached Jev path as live ones (one Choice call per JEV_BATCH, cached by
// session id in data/topics.json, so each session is asked about once ever):
//   archive → `archived`: archived catch-all sessions no rule or cached answer placed yet
//   topics  → `jev`:      topics' Jev cache, read by archive to place those sessions
// Tests pass their own instance; the running server shares `topicsJevLink`.

import type { SessionInput } from "./topics-lib.js";

export class TopicsJevLink {
  archived: readonly SessionInput[] = [];
  jev: ReadonlyMap<string, string> = new Map();
  /** Bumped on every `jev` change, so the archive knows to re-place its sessions. */
  version = 0;

  setJev(jev: ReadonlyMap<string, string>): void {
    this.jev = new Map(jev);
    this.version++;
  }
}

export const topicsJevLink = new TopicsJevLink();
