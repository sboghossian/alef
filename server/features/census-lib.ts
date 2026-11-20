// Pure logic for the "census" feature: parsing `gh pr list --json …` output into CensusPr
// records, and folding subagent records into a generation breakdown. No I/O, no clock reads
// beyond what is handed in — server/features/census.ts does the execFile / git calls and wires
// this to routes, ticks and snapshot extras.
//
// parseMergedPrs deliberately keeps only the FACTS derived from a PR's body/comments (whether a
// loop marker line is present, whether a review comment matches) and never the raw text itself:
// no PR body, no comment body or author, ever ends up in a CensusPr.

import type { CensusByDepth, CensusGenerations, CensusPr, CensusReview } from "../../shared/features/census.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collapses a PR title to one line, trimmed to `max` chars (untrusted GitHub text). */
export function oneLineTitle(raw: string, max = 120): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}

const LOOP_MARKER_RE = /^Alef-Loop: iteration \d+\s*$/m;

/** True when the PR body carries the loop's own "Alef-Loop: iteration <n>" marker line
 *  (proposed in this PR's body for ~/.alef-loop/LOOP.md step 6; not yet emitted by any PR). */
export function isLoopMarked(body: string): boolean {
  return LOOP_MARKER_RE.test(body);
}

const PRESIDENT_PICK_RE = /^President pick: ([A-Za-z0-9][A-Za-z0-9._:-]{0,79})(?:[ \t].*)?$/m;

/** The id on the PR body's "President pick: <id>" line (proposed for ~/.alef-loop/LOOP.md: the
 *  loop writes it when the PR builds what scripts/president-pick.ts printed), else null. Jev's
 *  "none" is not a pick. Only the id is kept, never the line's other text. */
export function presidentPickOf(body: string): string | null {
  const id = PRESIDENT_PICK_RE.exec(body)?.[1] ?? null;
  return id === null || id.toLowerCase() === "none" ? null : id;
}

const COUNCIL_LINE_RE = /^Council: ([A-Za-z0-9][A-Za-z0-9-]{0,63})(?:[ \t].*)?$/m;

/** The id on the PR body's "Council: <id>" line (proposed for ~/.alef-loop/LOOP.md: the loop copies
 *  the line scripts/council-round.ts printed for the council it built this PR from), else null.
 *  The PR's own record of its council, so "no loop council" never rests on what the 20-entry
 *  council history still holds. "none" is not an id. Only the id is kept, never the line's other text. */
export function councilIdOf(body: string): string | null {
  const id = COUNCIL_LINE_RE.exec(body)?.[1] ?? null;
  return id === null || id.toLowerCase() === "none" ? null : id;
}

const REVIEW_LINE_RE = /^alef-review:\s+(MERGE|BLOCK)\s+([0-9a-fA-F]{7,40})(?:\s+(\S.*?))?\s*$/;

interface ParsedReviewComment {
  verdict: "MERGE" | "BLOCK";
  sha: string;
  model: string | null;
}

/** Parses one comment's first line as an "alef-review: MERGE|BLOCK <sha> [<model>]" marker;
 *  null when the comment isn't one (any other comment, including a human one, is ignored). */
function parseReviewLine(body: string): ParsedReviewComment | null {
  const firstLine = (body.split("\n", 1)[0] ?? "").trim();
  const m = REVIEW_LINE_RE.exec(firstLine);
  if (!m || !m[1] || !m[2]) return null;
  return { verdict: m[1] as "MERGE" | "BLOCK", sha: m[2], model: m[3]?.trim() || null };
}

interface RawComment {
  body: string;
  createdAt: string;
}

/** The review recorded on this PR: the first comment whose sha is a prefix of `headRefOid` and
 *  which was posted at or before `mergedAt`. Comments are otherwise untrusted GitHub text, so a
 *  comment that fails any of these checks (wrong sha, posted after merge, malformed marker,
 *  ordinary discussion) never counts as a review — recorded stays false. */
export function reviewFor(comments: readonly RawComment[], headRefOid: string, mergedAt: string): CensusReview {
  const mergedAtMs = Date.parse(mergedAt);
  const oid = headRefOid.toLowerCase();
  for (const c of comments) {
    const parsed = parseReviewLine(c.body);
    if (!parsed) continue;
    if (!oid.startsWith(parsed.sha.toLowerCase())) continue;
    const createdAtMs = Date.parse(c.createdAt);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(mergedAtMs) || createdAtMs > mergedAtMs) continue;
    return { recorded: true, verdict: parsed.verdict, model: parsed.model };
  }
  return { recorded: false, verdict: null, model: null };
}

/** Parses `gh pr list --json number,title,mergedAt,headRefName,headRefOid,body,comments` stdout
 *  into CensusPr records. Returns `null` — never `[]` — when the text isn't a JSON array at all
 *  (malformed/truncated output, an auth banner mixed into stdout, …): that case is a FAILED
 *  fetch, not "0 PRs found", and the caller must keep the last good list rather than believe a
 *  fabricated zero. A malformed individual PR entry inside a genuinely-JSON array is skipped. */
export function parseMergedPrs(ghJson: string): CensusPr[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ghJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: CensusPr[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const { number, title, mergedAt, headRefName, headRefOid } = item;
    if (typeof number !== "number" || typeof title !== "string" || typeof mergedAt !== "string") continue;
    if (typeof headRefName !== "string" || typeof headRefOid !== "string") continue;
    const body = typeof item.body === "string" ? item.body : "";
    const rawComments = Array.isArray(item.comments) ? item.comments : [];
    const comments: RawComment[] = [];
    for (const c of rawComments) {
      if (isRecord(c) && typeof c.body === "string" && typeof c.createdAt === "string") comments.push({ body: c.body, createdAt: c.createdAt });
    }
    out.push({
      number,
      title: oneLineTitle(title),
      mergedAt,
      branch: headRefName,
      headSha: headRefOid,
      loopMarked: isLoopMarked(body),
      review: reviewFor(comments, headRefOid, mergedAt),
      presidentPick: presidentPickOf(body),
      councilId: councilIdOf(body),
    });
    // `body` and `comments` (and the local `comments`/`rawComments` above) fall out of scope
    // here — nothing from either is retained on the returned CensusPr.
  }
  return out;
}

/** Folds subagent records (shared/features/subagents.ts's own shape, via
 *  server/features/subagents/index.ts's latestSubagentRecords()) into the generation breakdown:
 *  depth 1 = spawned directly by a session, 2 = spawned by a depth-1 subagent, etc. `parents` is
 *  the count of distinct sessions that spawned at least one subagent (the same definition
 *  subagents/pass.ts's `statsFor` uses for SubagentStats.parents). */
export function generations(records: readonly SubagentRecord[]): CensusGenerations {
  const byDepth: CensusByDepth = {};
  const parentSet = new Set<string>();
  let maxDepth = 0;
  let sinceMs = Number.POSITIVE_INFINITY;
  for (const r of records) {
    byDepth[r.depth] = (byDepth[r.depth] ?? 0) + 1;
    if (r.depth > maxDepth) maxDepth = r.depth;
    parentSet.add(r.parentSessionId);
    const t = Date.parse(r.startedAt);
    if (Number.isFinite(t) && t < sinceMs) sinceMs = t;
  }
  const total = records.length;
  return {
    total,
    since: total > 0 && Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    byDepth,
    generations: total > 0 ? 1 + maxDepth : 0,
    parents: parentSet.size,
  };
}
