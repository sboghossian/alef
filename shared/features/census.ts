// Wire types for the "census" feature: the real numbers behind Alex's Alef vision post —
// sessions ever, sub-minions born (generations), and upgrades merged into Alef itself — each
// shown with its formula, window and source, never invented. NO-THEATRE: an unfetched or
// failed `gh pr list` is reported as an error, never silently rounded down to 0.
//
//   GET /api/census                        -> CensusResponse
//   WS  "census" feature message            -> CensusMessage (the merged-PR summary changed)
//   WorldSnapshot.extras["census.summary"]  -> CensusMergedSummary (small: no PR bodies/comments)
//
// "Sessions that lived here" and "Sub-minions born" are NOT part of this wire contract for the
// numbers themselves: sessions-ever is computed client-side from WorldSnapshot.agents.length +
// extras["archive.summary"].total (shared/features/archive.ts), and sub-minions is this
// feature's own `generations` block, folded server-side from the subagents feature's own
// records (shared/features/subagents.ts) — never re-derived from a different source.

/** One depth's headcount of subagent records: 1 = spawned directly by a session, 2 = spawned by
 *  a depth-1 subagent, etc. Keys are stringified depths on the wire (plain JSON object). */
export type CensusByDepth = Record<number, number>;

export interface CensusGenerations {
  /** Every subagent record folded in, regardless of depth. */
  total: number;
  /** ISO of the earliest record's startedAt, or null when there are none yet. */
  since: string | null;
  byDepth: CensusByDepth;
  /** 1 (the parent sessions themselves) + the deepest depth seen; 0 when there are no records yet. */
  generations: number;
  /** Distinct parent session ids that spawned at least one subagent. */
  parents: number;
}

export interface CensusReview {
  /** A PR comment whose body starts "alef-review: MERGE|BLOCK <sha>", where <sha> is a prefix
   *  of the PR's headRefOid and the comment was posted at or before the PR's mergedAt. */
  recorded: boolean;
  verdict: "MERGE" | "BLOCK" | null;
  model: string | null;
}

export interface CensusPr {
  number: number;
  /** One line, ≤120 chars. Untrusted GitHub text: render with textContent, never innerHTML. */
  title: string;
  mergedAt: string; // ISO
  branch: string; // headRefName
  headSha: string; // headRefOid
  /** The PR body contained a line "Alef-Loop: iteration <n>". The raw body is never kept. */
  loopMarked: boolean;
  review: CensusReview;
  /** The id from a PR body line "President pick: <id>" (the loop built what Jev picked with
   *  scripts/president-pick.ts), else null. "none" never counts. Absent from servers older than
   *  loop-governance. Untrusted PR text: render with textContent. */
  presidentPick?: string | null;
  /** The id from a PR body line "Council: <id>" (the loop copies the line scripts/council-round.ts
   *  printed for the council it built this PR from), else null: the PR names no loop council.
   *  Absent from servers older than this field (the census then says the link is unknown).
   *  Untrusted PR text: render with textContent. */
  councilId?: string | null;
}

export interface CensusMergedSummary {
  /** Merged PRs from the last successful `gh pr list`. Holds the last GOOD count even while
   *  `error` is set (a failed fetch never resets this to 0). */
  total: number;
  reviewRecorded: number;
  loopMarked: number;
  /** Newest-first, ≤10. Link targets are built from `number` only, client-side. */
  recent: CensusPr[];
  /** When the fetch that produced the fields above completed. Null before the first one lands
   *  (the honest "gh hasn't run yet" state — never shown as 0). */
  fetchedAt: string | null;
  /** "owner/repo" once the local checkout's GitHub remote is resolved, else null. */
  repo: string | null;
  /** Set when the most recent attempt failed; the fields above are the last good list, if any. */
  error: string | null;
}

export interface CensusResponse {
  /** null until the subagents feature has published at least once (its cold pass over
   *  subagents.db can take several seconds on a fresh boot) — the honest "not indexed yet"
   *  state, never a fabricated 0. Distinct from a CensusGenerations whose own `total` is a
   *  genuine 0 (indexed, and there just aren't any subagent records). */
  generations: CensusGenerations | null;
  merged: CensusMergedSummary;
}

export const CENSUS_SUMMARY_KEY = "census.summary";

export type CensusMessage = { kind: "merged"; merged: CensusMergedSummary };

// ---------------------------------------------------------------- validation (untrusted wire)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isByDepth(v: unknown): v is CensusByDepth {
  if (!isRecord(v)) return false;
  return Object.entries(v).every(([k, n]) => Number.isFinite(Number(k)) && typeof n === "number");
}

export function isCensusGenerations(v: unknown): v is CensusGenerations {
  if (!isRecord(v)) return false;
  if (typeof v.total !== "number" || typeof v.generations !== "number" || typeof v.parents !== "number") return false;
  if (v.since !== null && typeof v.since !== "string") return false;
  return isByDepth(v.byDepth);
}

function isCensusReview(v: unknown): v is CensusReview {
  if (!isRecord(v)) return false;
  if (typeof v.recorded !== "boolean") return false;
  if (v.verdict !== null && v.verdict !== "MERGE" && v.verdict !== "BLOCK") return false;
  return v.model === null || typeof v.model === "string";
}

export function isCensusPr(v: unknown): v is CensusPr {
  if (!isRecord(v)) return false;
  return (
    typeof v.number === "number" &&
    typeof v.title === "string" &&
    typeof v.mergedAt === "string" &&
    typeof v.branch === "string" &&
    typeof v.headSha === "string" &&
    typeof v.loopMarked === "boolean" &&
    isCensusReview(v.review) &&
    (v.presidentPick === undefined || v.presidentPick === null || typeof v.presidentPick === "string") &&
    (v.councilId === undefined || v.councilId === null || typeof v.councilId === "string")
  );
}

export function isCensusMergedSummary(v: unknown): v is CensusMergedSummary {
  if (!isRecord(v)) return false;
  if (typeof v.total !== "number" || typeof v.reviewRecorded !== "number" || typeof v.loopMarked !== "number") return false;
  if (!Array.isArray(v.recent) || !v.recent.every(isCensusPr)) return false;
  if (v.fetchedAt !== null && typeof v.fetchedAt !== "string") return false;
  if (v.repo !== null && typeof v.repo !== "string") return false;
  return v.error === null || typeof v.error === "string";
}

export function parseCensusResponse(v: unknown): CensusResponse | null {
  if (!isRecord(v)) return null;
  if (v.generations !== null && !isCensusGenerations(v.generations)) return null;
  if (!isCensusMergedSummary(v.merged)) return null;
  return { generations: v.generations as CensusGenerations | null, merged: v.merged };
}

export function parseCensusMessage(v: unknown): CensusMessage | null {
  if (!isRecord(v) || v.kind !== "merged" || !isCensusMergedSummary(v.merged)) return null;
  return { kind: "merged", merged: v.merged };
}
