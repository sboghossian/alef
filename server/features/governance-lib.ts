// Governance decisions on the feed (vision wave 3: "every decision goes out on a live feed the
// whole town can see"). Pure builders for the items the president, council, resident and census
// features append with feed.ts's appendToFeed at each real decision point:
//   - gov:jev       Jev ranked the president's board (which candidates, how many it proposed, p(none));
//   - gov:click     Alex launched, dismissed, merged or retired a president proposal, or
//                   approved / dismissed one of the resident's;
//   - gov:council   a council verdict (server/features/council.ts, after synthesis);
//   - gov:resident  the resident filed or withdrew a proposal;
//   - gov:census    a PR merged into this repo (census.ts, diffed against a persisted seen-set).
// INVARIANTS:
//   - one item per real event: ids are stable per event, and every caller emits only after the
//     event happened (a write that returned ok, a launcher that answered ok), never per tick;
//   - titles are written here, by code. Text that came from a todo file, a model, a transcript or
//     GitHub goes only into `detail` (a census title's tail is the repo slug the git remote named
//     and a PR number), after govText has flattened, redacted and defanged it. The Town square
//     reads failure wording off a title (client workspace-lib's FAILURE_RE), so an untrusted
//     "fix the failing build" never turns a click into a false alarm;
//   - kind is always "decision" with a gov: tag; the store's own decisions never carry one.

import type { CensusPr } from "../../shared/features/census.js";
import type { CouncilResult } from "../../shared/features/council.js";
import { govTag, type FeedItem } from "../../shared/features/feed.js";
import type { LedgerOutcome, PresidentProposal } from "../../shared/features/president.js";
import type { ResidentProposal } from "../../shared/features/resident.js";
import { redactSecrets } from "../heuristics.js";

export type FeedDraft = Omit<FeedItem, "seq">;

const DETAIL_MAX = 600;
/** Control chars, C1, zero-width and bidi overrides: none of them belongs in one feed line. */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/** One line of untrusted text for a feed detail: invisible characters folded to spaces, secrets
 *  redacted, fence tokens defanged (a later prompt may quote the feed inside an UNTRUSTED_DATA
 *  fence), whitespace collapsed, capped with an ellipsis. */
export function govText(raw: string, max: number): string {
  const flat = redactSecrets(raw.replace(INVISIBLE_RE, " "))
    .replace(/UNTRUSTED_DATA/gi, "UNTRUSTED-DATA")
    .replace(/<<</g, "‹‹‹")
    .replace(/>>>/g, "›››")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

function detailOf(parts: readonly string[]): string | null {
  const joined = parts.filter((p) => p.length > 0).join(" · ");
  if (!joined) return null;
  return joined.length > DETAIL_MAX ? `${joined.slice(0, DETAIL_MAX - 1).trimEnd()}…` : joined;
}

function p2(p: number): string {
  return p.toFixed(2);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── gov:jev — the president's refresh ─────────────────────────────────────────────────────────

export interface JevRanking {
  at: string; // ISO: when the refresh finished
  /** The sessions question, when Jev answered it: every candidate it saw, the ones now on the
   *  board (Jev's order, with its probability), and the "none of these" probability. */
  sessions: { candidates: number; proposed: readonly { text: string; p: number | null }[]; pNone: number | null } | null;
  /** The commencement question, when Jev answered it. */
  commencement: { candidates: number; proposed: number; pNone: number | null; choseNone: boolean } | null;
  /** The district-merge question, when Jev answered it. */
  merge: { proposed: boolean } | null;
}

/** One item per refresh in which Jev actually answered; null when it answered nothing (the rules
 *  fallback ranked the board: no Jev decision happened). */
export function jevRankingItem(r: JevRanking): FeedDraft | null {
  if (!r.sessions && !r.commencement && !r.merge) return null;
  const n = (r.sessions?.candidates ?? 0) + (r.commencement?.candidates ?? 0) + (r.merge ? 1 : 0);
  const k = (r.sessions?.proposed.length ?? 0) + (r.commencement?.proposed ?? 0) + (r.merge?.proposed ? 1 : 0);
  const pNone = r.sessions?.pNone ?? r.commencement?.pNone ?? null;
  const title = `Jev ranked ${plural(n, "candidate")}: ${k} proposed${pNone !== null ? `, p(none) ${p2(pNone)}` : ""}`;
  const parts: string[] = [];
  if (r.sessions) {
    const s = r.sessions;
    parts.push(`session ideas: ${s.proposed.length} of ${s.candidates} proposed${s.pNone !== null ? `, p(none) ${p2(s.pNone)}` : ""}`);
    for (const c of s.proposed.slice(0, 3)) parts.push(`"${govText(c.text, 90)}"${c.p !== null ? ` p ${p2(c.p)}` : ""}`);
  }
  if (r.commencement) {
    const c = r.commencement;
    parts.push(`graduation actions: ${c.proposed} of ${c.candidates} proposed${c.choseNone ? " (Jev chose none)" : ""}${c.pNone !== null ? `, p(none) ${p2(c.pNone)}` : ""}`);
  }
  if (r.merge) parts.push(`district merge: ${r.merge.proposed ? "proposed" : "held back"}`);
  return { id: `gov:jev:${r.at}`, at: r.at, kind: "decision", agentId: null, title, detail: detailOf(parts), tag: govTag("jev") };
}

/** What a board shows, for "did this refresh change anything": who ranked it, and its proposal
 *  ids in order. A refresh that leaves it as it was is no new decision (never one item per tick). */
export function boardSignature(board: { source: string; proposals: readonly { id: string }[] }): string {
  return `${board.source}|${board.proposals.map((p) => p.id).join("\n")}`;
}

// ── gov:click — Alex's clicks ─────────────────────────────────────────────────────────────

function proposalWords(p: PresidentProposal): string {
  return p.kind === "session" ? "a session proposal" : p.kind === "merge" ? "a district merge" : `a ${p.action} proposal`;
}

function proposalText(p: PresidentProposal): string {
  if (p.kind === "session") return `${govText(p.task, 200)} (${govText(p.city, 60)})`;
  if (p.kind === "merge") return `${plural(p.districts.length, "district")} into ${govText(p.into, 60)}`;
  return govText(p.title, 200);
}

const CLICK_VERB: Readonly<Record<LedgerOutcome, string>> = { launched: "launched", dismissed: "dismissed", merged: "approved", retired: "retired" };

/** A click on the president's board that took effect (the caller emits after its write or launch
 *  succeeded). One per click: the id carries the click time, so a proposal clicked again after its
 *  cooldown is a second event, and a repeated click the server answered from launch-once is none. */
export function presidentClickItem(p: PresidentProposal, outcome: LedgerOutcome, at: string, extra: { rankedBy: "jev" | "rules"; tmuxName?: string | null }): FeedDraft {
  const what = outcome === "retired" ? "a worker" : proposalWords(p);
  const title = `Alex ${CLICK_VERB[outcome]} ${what} from the president's board`;
  const detail = detailOf([proposalText(p), `ranked by ${extra.rankedBy}`, extra.tmuxName ? `tmux ${govText(extra.tmuxName, 60)}` : ""]);
  return { id: `gov:click:president:${p.id}:${outcome}:${at}`, at, kind: "decision", agentId: null, title, detail, tag: govTag("click") };
}

/** Alex approved or dismissed one of the resident's proposals (once: only an open one can be decided). */
export function residentClickItem(p: Pick<ResidentProposal, "id" | "kind" | "title">, status: "approved" | "dismissed", at: string): FeedDraft {
  return { id: `gov:click:resident:${p.id}:${status}`, at, kind: "decision", agentId: null, title: `Alex ${status} the resident's ${p.kind} proposal`, detail: detailOf([govText(p.title, 200)]), tag: govTag("click") };
}

// ── gov:resident — the resident's own proposals ───────────────────────────────────────────────

export function residentProposalItem(p: Pick<ResidentProposal, "id" | "kind" | "title">, event: "filed" | "withdrew", at: string): FeedDraft {
  return { id: `gov:resident:${event}:${p.id}`, at, kind: "decision", agentId: null, title: `The resident ${event} a ${p.kind} proposal`, detail: detailOf([govText(p.title, 200)]), tag: govTag("resident") };
}

// ── gov:council — a council verdict ───────────────────────────────────────────────────────────

export function councilVerdictItem(r: CouncilResult): FeedDraft {
  const answered = r.personas.filter((p) => p.ok && p.topChoice !== null).length;
  const majority = Math.max(0, ...Object.values(r.aggregate.split));
  const pick = r.verdict.ok ? r.verdict.pick : undefined;
  const title = r.verdict.ok && !r.verdict.unavailable ? (pick ? "The council reached a verdict" : "The council answered without a single pick") : "The council ran; its synthesis was unavailable";
  const jev = r.source === "jev" && answered > 0 ? `Jev personas: ${majority} of ${answered} on the majority option` : "Jev personas unavailable this round";
  const detail = detailOf([`"${govText(r.decision, 160)}"${pick ? ` → ${govText(pick, 120)}` : ""}`, jev]);
  return { id: `gov:council:${r.id}`, at: r.at, kind: "decision", agentId: null, title, detail, tag: govTag("council") };
}

// ── gov:census — a PR merged into this repo ───────────────────────────────────────────────────

/** How old a merge may be and still go out as news (a restart after a long downtime, or a PR the
 *  list only now returns, is history: it stays in the census panel, never "new" on the feed). */
export const MERGE_NEWS_MAX_AGE_MS = 24 * 60 * 60_000;
/** The seen-set keeps at most this many PR numbers (the census lists 300 merged PRs). */
export const MERGE_SEEN_CAP = 2000;
const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface MergeNews {
  items: FeedDraft[];
  /** The seen-set to persist: every PR number observed so far (the old set is never shrunk by a
   *  short list, so a glitchy partial answer can't make old merges look new later). Still null
   *  when there was nothing to seed it from. */
  seen: Set<number> | null;
  /** False when nothing about the seen-set changed (no write needed). */
  changed: boolean;
}

/**
 * The merges to announce. `seen === null` (no seen-set was ever persisted: the first run on this
 * db) seeds every listed PR silently. After that, a PR number never seen before goes out once,
 * if it merged within MERGE_NEWS_MAX_AGE_MS; older ones are only recorded as seen. An empty list
 * is no observation (this repo has merges: an empty answer is a glitch, and seeding from it would
 * make every later merge look new).
 */
export function mergeNews(prs: readonly CensusPr[], seen: ReadonlySet<number> | null, repo: string, nowMs: number): MergeNews {
  if (prs.length === 0) return { items: [], seen: seen === null ? null : new Set(seen), changed: false };
  const next = new Set(seen ?? []);
  const fresh: CensusPr[] = [];
  let changed = seen === null;
  for (const pr of prs) {
    if (next.has(pr.number)) continue;
    next.add(pr.number);
    changed = true;
    const age = nowMs - Date.parse(pr.mergedAt);
    if (seen !== null && Number.isFinite(age) && age <= MERGE_NEWS_MAX_AGE_MS) fresh.push(pr);
  }
  if (next.size > MERGE_SEEN_CAP) {
    const keep = [...next].sort((a, b) => b - a).slice(0, MERGE_SEEN_CAP);
    next.clear();
    for (const n of keep) next.add(n);
  }
  const ref = (n: number): string => (SLUG_RE.test(repo) ? `${repo}#${n}` : `PR #${n}`);
  const items = fresh
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
    .map(
      (pr): FeedDraft => ({
        id: `gov:census:${ref(pr.number)}`,
        at: pr.mergedAt,
        kind: "decision",
        agentId: null,
        // The PR reference ends the title so the client can link it (feed-bridge.ts graduationHref).
        title: `Alef upgraded itself: merged ${ref(pr.number)}`,
        detail: detailOf([govText(pr.title, 160), pr.review.recorded ? `review recorded (${pr.review.verdict ?? "?"})` : "no review recorded"]),
        tag: govTag("census"),
      }),
    );
  return { items, seen: next, changed };
}

/** The persisted seen-set (a JSON array of PR numbers); null when absent or unreadable. */
export function parseMergeSeen(raw: string | null): Set<number> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? new Set(v.filter((n): n is number => Number.isInteger(n) && n > 0)) : null;
  } catch {
    return null;
  }
}
