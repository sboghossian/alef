// Wire types for the "home" feature: the 🏠 Home view's server side (Alex, 2026-09-29).
//
//   GET  /api/home/digest?range=today|week|month → DigestResponse: "What happened" FACTS (counted
//        by code from the features that already measure them) + the cached AI summary of them
//   POST /api/home/digest/summary {range}        → DigestResponse, after writing a fresh summary
//        now (the Regenerate button; the daily cost cap still applies)
//   GET  /api/home/automations                   → HomeAutomationsResponse (Tower workers + routines)
//   GET  /api/home/decisions                     → HomeDecisionsResponse (the president's ledger)
//
// NO THEATRE: every count below comes from a real signal (outcomes, census, sickness, careers,
// the president's ledger, the world index). A source that has not loaded yet says `ready: false`
// and is never shown as 0. The summary is written by Haiku from the FACTS JSON only (no
// transcript text, no note contents) and is thrown away when it names a number the facts don't
// hold (server/features/home-lib.ts validateSummary).
//
// Untrusted text: PR titles (GitHub), automation keys and district names (derived from prompts and
// folders) and the summary (a model's words) render with textContent only.

import type { CareerState, RunMark } from "./careers.js";
import type { SicknessKind } from "./sickness.js";

export const DIGEST_RANGES = ["today", "week", "month"] as const;
export type DigestRange = (typeof DIGEST_RANGES)[number];

export function isDigestRange(v: unknown): v is DigestRange {
  return typeof v === "string" && (DIGEST_RANGES as readonly string[]).includes(v);
}

/** Rolling windows: today = since local midnight, week = the last 7 days, month = the last 30. */
export const RANGE_DAYS: Readonly<Record<DigestRange, number | null>> = { today: null, week: 7, month: 30 };

export const RANGE_LABEL: Readonly<Record<DigestRange, string>> = {
  today: "today, since midnight",
  week: "the last 7 days",
  month: "the last 30 days",
};

export interface DigestSessions {
  /** Sessions whose first message falls in the range. */
  started: number;
  /** Sessions with at least one message in the range (lastActive ≥ from). */
  active: number;
  /** Of those, the ones not running now. */
  ended: number;
  /** Right now, whatever the range. */
  liveNow: number;
  waitingNow: number;
  /** Districts with at least one active session (the total: topDistricts is cut to 5). */
  districts: number;
  /** Active sessions per district, the busiest 5. */
  topDistricts: { name: string; sessions: number }[];
}

/** Verdicts (the outcomes feature) of the sessions that ended in the range. They add up to `ended`. */
export interface DigestOutcomes {
  ready: boolean;
  shipped: number;
  delivered: number;
  failed: number;
  stopped: number;
  abandoned: number;
  finished: number;
  /** Read to the end, no outcome evidence (most chats and research: not a failure). */
  noEvidence: number;
  /** No final verdict yet (not scanned, or not read to its end). */
  unjudged: number;
}

/** PRs your sessions opened (their transcripts link them) that GitHub reports MERGED in the range. */
export interface DigestMergedPrs {
  ready: boolean;
  total: number;
  /** Repos with at least one merged PR (the length of byRepo, stated so nobody counts it). */
  repos: number;
  byRepo: { repo: string; count: number }[];
}

/** PRs merged into Alef itself (the census feature's `gh pr list`). */
export interface DigestAlefUpgrades {
  ready: boolean;
  error: string | null;
  total: number;
  /** The newest 8 of `total`. `title` is GitHub text: render with textContent. */
  latestPrs: { number: number; title: string }[];
}

export interface DigestSickness {
  /** False until the sickness scan first reached the end of every transcript. */
  ready: boolean;
  opened: number;
  healed: number;
  /** Sick right now (open, chronic or exposed), whatever the range. */
  openNow: number;
  openedByKind: { kind: SicknessKind; count: number }[];
}

/** Automation runs (careers' lineages) that started in the range, marked the way the Tower marks them. */
export interface DigestAutomations {
  ready: boolean;
  runs: number;
  clean: number;
  wrote: number;
  bad: number;
  unknown: number;
  /** Workers (lineages) with at least one run in the range (the total: topWorkers is cut to 8). */
  workersRan: number;
  /** The busiest 8 of them, most runs first. */
  topWorkers: { key: string; runs: number; clean: number; wrote: number; bad: number; unknown: number }[];
}

/** The president's ledger: proposals shown in the range, and Alex's clicks in the range. */
export interface DigestJev {
  ready: boolean;
  shown: number;
  launched: number;
  dismissed: number;
  merged: number;
  retired: number;
}

export interface DigestFacts {
  range: DigestRange;
  /** RANGE_LABEL[range]. */
  label: string;
  /** RANGE_DAYS[range]. */
  days: number | null;
  from: string; // ISO
  to: string; // ISO
  sessions: DigestSessions;
  outcomes: DigestOutcomes;
  mergedPrs: DigestMergedPrs;
  alefUpgrades: DigestAlefUpgrades;
  sickness: DigestSickness;
  automations: DigestAutomations;
  jev: DigestJev;
}

export interface DigestSummary {
  /** A summary that passed validation (every number it names is in the facts it was written from). */
  text: string;
  at: string; // ISO: when it was written
  /** True when it was written from exactly the facts in this response (same hash). */
  current: boolean;
  costUsd: number;
}

export interface DigestResponse {
  ok: true;
  facts: DigestFacts;
  /** The last valid summary for this range, or null. */
  summary: DigestSummary | null;
  /** A summary is being written right now for this range. */
  writing: boolean;
  /** One honest line when there is no current summary: why (claude missing, discarded, cap…). */
  note: string | null;
  spend: { todayUsd: number; capUsd: number };
}

export interface HomeError {
  ok: false;
  error: string;
}

/** One automation on the Home feed: a Tower worker (careers), or a routine no worker claims. */
export interface HomeAutomationRow {
  /** "worker:<automationKey>" or "routine:<label>". */
  id: string;
  kind: "worker" | "routine";
  /** Display name: the worker's own name, else its key; a routine's short name. */
  name: string;
  /** The Tower's key (worker rows): what the Tower opens at. */
  key: string | null;
  state: CareerState | null;
  lastRunAt: string | null;
  /** The last run's Tower mark (worker rows), with its one-line reason. */
  lastMark: RunMark | null;
  lastWhy: string | null;
  /** launchd's last exit status, when a routine is linked (never proof the run did anything). */
  lastExit: number | null;
  schedule: string | null;
  nextRunAt: string | null;
  running: boolean;
}

export interface HomeAutomationsResponse {
  ok: true;
  /** False until careers has made its first settled computation (the archive list loaded). */
  ready: boolean;
  rows: HomeAutomationRow[];
}

export type HomeDecisionStatus = "clicked" | "dismissed" | "pending" | "not-acted";

/** One president ledger entry (shared/features/president.ts PresidentLedgerEntry), with its status. */
export interface HomeDecisionRow {
  id: string;
  kind: "session" | "merge" | "commencement";
  action: string;
  rankedBy: "jev" | "rules";
  proposedAt: string;
  actedAt: string | null;
  outcome: "launched" | "dismissed" | "retired" | "merged" | null;
  /** clicked (launched / merged / retired), dismissed, pending (on the board now), or not-acted
   *  (it left the board unclicked). */
  status: HomeDecisionStatus;
  /** A launch's adopted session and its outcome verdict, when talk adopted one. */
  sessionId: string | null;
  verdict: string | null;
}

export interface HomeDecisionsResponse {
  ok: true;
  /** False until the president has read president.json. */
  ready: boolean;
  /** Newest first (by actedAt, else proposedAt), ≤ 30. */
  rows: HomeDecisionRow[];
}

// ---------------------------------------------------------------- client-side guards

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/** Shape check of GET /api/home/digest (the fields the view reads). */
export function isDigestResponse(v: unknown): v is DigestResponse {
  if (!isRecord(v) || v.ok !== true || typeof v.writing !== "boolean" || !strOrNull(v.note)) return false;
  const f = v.facts;
  if (!isRecord(f) || !isDigestRange(f.range) || !str(f.from) || !str(f.to) || !str(f.label)) return false;
  for (const k of ["sessions", "outcomes", "mergedPrs", "alefUpgrades", "sickness", "automations", "jev"]) if (!isRecord(f[k])) return false;
  const s = v.summary;
  if (s !== null && (!isRecord(s) || !str(s.text) || !str(s.at) || typeof s.current !== "boolean")) return false;
  return isRecord(v.spend) && num(v.spend.todayUsd) && num(v.spend.capUsd);
}

export function isHomeAutomationsResponse(v: unknown): v is HomeAutomationsResponse {
  return isRecord(v) && v.ok === true && typeof v.ready === "boolean" && Array.isArray(v.rows) && v.rows.every((r) => isRecord(r) && str(r.id) && str(r.name) && (r.kind === "worker" || r.kind === "routine"));
}

export function isHomeDecisionsResponse(v: unknown): v is HomeDecisionsResponse {
  return isRecord(v) && v.ok === true && typeof v.ready === "boolean" && Array.isArray(v.rows) && v.rows.every((r) => isRecord(r) && str(r.id) && str(r.proposedAt) && str(r.status));
}
