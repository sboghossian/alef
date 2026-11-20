// Wire types for the "workspace" feature (vision wave 3, gwt-broadcast): the Town square's global
// workspace computed on the SERVER, from server-side sources, with the same shared scorer the
// client runs (shared/workspace/scorer.ts), then broadcast to Jev and the resident.
//
//   GET /api/workspace            -> WorkspaceResponse (the top 5 now, the counts, what fed it)
//   GET /api/workspace/influence  -> InfluenceResponse (per Jev proposal and resident journal entry:
//                                    was its subject in the top 5 it was shown?)
//
// Entry and record text quotes session titles, transcript lines and model output: untrusted.

import type { WorkspaceCounts, WorkspaceEntry } from "../workspace/scorer.js";

export const WORKSPACE_FEATURE_ID = "workspace";

/** How many records each source handed the scorer on the last computation. */
export interface WorkspaceSourceCounts {
  /** Server feed ring items seen in the window (activity, Jev, approvals, tripwires, graduations, Mac). */
  ring: number;
  awaiting: number;
  messages: number;
  subagents: number;
  runEndings: number;
  routineRuns: number;
  stranded: number;
  tripwireHits: number;
  sickness: number;
  health: boolean;
  presidentBoard: boolean;
  resident: boolean;
}

export interface WorkspaceResponse {
  ok: true;
  /** ISO of the last computation; null before the first tick. */
  computedAt: string | null;
  top: WorkspaceEntry[];
  counts: WorkspaceCounts;
  sources: WorkspaceSourceCounts | null;
  /** ISO of the oldest feed ring item this process saw: the ring starts empty on every boot, so
   *  until it is 2 h old the window is not fully covered. */
  ringSince: string | null;
}

/** Why a subject counted as in the workspace: the same topic key (a Health check, a routine's
 *  failure), a shared session, a shared district (a merge proposal only), or at least 2 shared
 *  distinctive keywords. Strongest first. */
export type InfluenceBasis = "topic" | "session" | "district" | "words";

export interface InfluenceRecord {
  id: string;
  source: "jev" | "resident";
  /** ISO: when the reader was shown the broadcast (Jev's ranking, the reflection). */
  at: string;
  /** The proposal's id (jev only). */
  proposalId?: string;
  /** The proposal's line or the journal entry, one line, capped. Untrusted. */
  subject: string;
  /** jev only: Jev ranked it, or the rules fallback did (Jev never saw the broadcast then). */
  rankedBy?: "jev" | "rules";
  /** Entries it was shown; null when there was no fresh broadcast at the time. */
  shown: number | null;
  about: boolean;
  basis: InfluenceBasis | null;
  /** Keys of the entries its subject matched. */
  matched: string[];
  /** The shared keywords, when basis is "words" (so every match can be audited). */
  words: string[];
}

export interface InfluenceShare {
  records: number;
  /** Records that were shown a non-empty broadcast. */
  withBroadcast: number;
  about: number;
  /** about / withBroadcast; null when withBroadcast is 0 (undefined, not 0%). */
  share: number | null;
  byBasis: Record<InfluenceBasis, number>;
}

export interface InfluenceWindow {
  /** Proposals Jev ranked while shown the broadcast. */
  jev: InfluenceShare;
  /** Proposals the rules fallback ranked (Jev gave no answer): the baseline, since nothing there read the broadcast. */
  rules: InfluenceShare;
  resident: InfluenceShare;
}

export interface InfluenceResponse {
  ok: true;
  /** Always "computed": matched by code (see InfluenceBasis), never reported by a model. */
  label: "computed";
  method: string;
  /** ISO of the oldest record kept; null when there is none (the share is undefined). */
  since: string | null;
  last24h: InfluenceWindow;
  all: InfluenceWindow;
  /** Newest first. */
  recent: InfluenceRecord[];
}
