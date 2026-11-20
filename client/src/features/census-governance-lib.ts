// Pure logic for the census panel's merge-governance rows (loop-governance): which loop-round
// council judged what a merged PR built, the review recorded on its merged SHA, and the PR body's
// President pick. Kept apart from census-lib.ts so the two evolve without touching each other.

import type { CensusPr } from "../../../shared/features/census";
import { parseCouncilRef, type CouncilResult } from "../../../shared/features/council";

export type CouncilLink =
  | { state: "linked"; council: CouncilResult }
  | { state: "none" }
  | { state: "unknown"; why: "not reported by the server" | "history unavailable" | "not in the kept history" }
  | { state: "not-linked"; id: string; why: "not a loop-round council" | "that council reached no pick" | "that council picked another branch" | "that council ran after the merge" };

/** Why the council a PR names didn't judge what it built, or null when it did: a loop-round
 *  council (scripts/council-round.ts) whose pick was the PR's head branch, run at or before the
 *  merge. A council that ran after the merge judged nothing that shipped. */
function notLinkedWhy(c: CouncilResult, pr: Pick<CensusPr, "branch" | "mergedAt">): Extract<CouncilLink, { state: "not-linked" }>["why"] | null {
  const ref = parseCouncilRef(c.ref);
  if (!ref) return "not a loop-round council";
  if (ref.branch === null) return "that council reached no pick";
  if (ref.branch !== pr.branch) return "that council picked another branch";
  return Date.parse(c.at) <= Date.parse(pr.mergedAt) ? null : "that council ran after the merge";
}

/** The PR body's "Council: <id>" line is the record. No line: none (the PR names no loop council),
 *  whatever the history holds. A line: linked when the kept history (the last 20 councils, panel
 *  and loop together) holds that council and it judged this branch, not-linked when it holds it
 *  and it didn't, and unknown when the history is unreadable or no longer holds it (never "none"). */
export function councilLinkOf(pr: Pick<CensusPr, "councilId" | "branch" | "mergedAt">, history: readonly CouncilResult[] | null): CouncilLink {
  if (pr.councilId === undefined) return { state: "unknown", why: "not reported by the server" };
  if (pr.councilId === null) return { state: "none" };
  if (history === null) return { state: "unknown", why: "history unavailable" };
  const council = history.find((c) => c.id === pr.councilId);
  if (!council) return { state: "unknown", why: "not in the kept history" };
  const why = notLinkedWhy(council, pr);
  return why === null ? { state: "linked", council } : { state: "not-linked", id: council.id, why };
}

function councilPart(pr: CensusPr, link: CouncilLink): string {
  switch (link.state) {
    case "linked":
      return `Council ${link.council.id.slice(0, 8)} → PR #${pr.number}`;
    case "none":
      return "no loop council";
    case "not-linked":
      return `Council ${link.id.slice(0, 8)} not linked (${link.why})`;
    case "unknown":
      return link.why === "not in the kept history" && pr.councilId ? `council ${pr.councilId.slice(0, 8)} unknown (${link.why})` : `council unknown (${link.why})`;
  }
}

/** The governance facts of one merge, as the text parts of its row: "Council <id8> → PR #n", "no
 *  loop council", "Council <id8> not linked (<why>)" or "council unknown (<why>)", the review
 *  recorded on the merged SHA, and the President pick line when the body had one. Every part
 *  comes from a record: the PR body, the council history, a PR comment. */
export function mergeGovernanceParts(pr: CensusPr, history: readonly CouncilResult[] | null): string[] {
  const parts = [councilPart(pr, councilLinkOf(pr, history))];
  const r = pr.review;
  parts.push(r.recorded ? `review recorded: ${r.verdict ?? "?"} ${pr.headSha.slice(0, 7)}${r.model ? ` ${r.model}` : ""}` : "no review recorded");
  if (pr.presidentPick) parts.push(`President pick: ${pr.presidentPick}`);
  return parts;
}

/** GET /api/council/history's list, or null when the answer is missing or malformed (a PR that
 *  names a council then reads unknown). Entries need a string id and at, like the store's. */
export function councilHistoryOf(v: unknown): CouncilResult[] | null {
  if (typeof v !== "object" || v === null) return null;
  const history = (v as { history?: unknown }).history;
  if (!Array.isArray(history)) return null;
  return history.filter((c): c is CouncilResult => typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string" && typeof (c as { at?: unknown }).at === "string");
}

export interface GovernanceCounts {
  merges: number;
  /** null when any listed merge's link is unknown (a named council the history is unreadable or
   *  no longer holds, or a server without the field): unknown is never counted as 0. */
  councilLinked: number | null;
  /** How many listed merges have an unknown link. */
  councilUnknown: number;
  reviewRecorded: number;
  presidentPicked: number;
}

/** Counts over the merges the panel lists (the last ≤10) against the councils the server keeps. */
export function governanceCounts(recent: readonly CensusPr[], history: readonly CouncilResult[] | null): GovernanceCounts {
  const links = recent.map((pr) => councilLinkOf(pr, history).state);
  const unknown = links.filter((s) => s === "unknown").length;
  return {
    merges: recent.length,
    councilLinked: unknown > 0 ? null : links.filter((s) => s === "linked").length,
    councilUnknown: unknown,
    reviewRecorded: recent.filter((pr) => pr.review.recorded).length,
    presidentPicked: recent.filter((pr) => Boolean(pr.presidentPick)).length,
  };
}
