// Wire types for the "alumni" feature (agent-city piece 6, the 🎓 Hall): what a session leaves
// behind when it is retired, and a read-only view of the fleet's own history. The event log
// (data/alumni.jsonl) and its folds live in server/features/alumni.ts, which is the only writer;
// this file is the contract the client validates GET /api/alumni against, plus emeritiOf, the one
// bit of client-usable pure logic (the Hall's Emeriti section reads GET /api/careers directly).
//
//   GET /api/alumni?range=week|month|all   -> AlumniResponse
//   Panel id "alumni" is fixed (campus-landmarks depends on it).

import type { CareersResponse, CareerWorker } from "./careers.js";
import { isSessionOutcome, type OutcomePr, type PrState, type SessionOutcome } from "./outcomes.js";

export const ALUMNI_PANEL_ID = "alumni";
export const ALUMNI_RANGES = ["week", "month", "all"] as const;
export type AlumniRange = (typeof ALUMNI_RANGES)[number];
export const DEFAULT_ALUMNI_RANGE: AlumniRange = "month";

/** One session's record at the moment it was retired. Untrusted fields (name, reason, learnings,
 *  vaultNote, …) ultimately come from a transcript or the vault: render with textContent only. */
export interface LegacyCard {
  sessionId: string;
  /** agentTitle()-style display name at retire time. */
  name: string;
  /** City / repo name at retire time, or "" when it never had one (e.g. a home-dir session). */
  city: string;
  startedAt: string;
  lastActive: string;
  outcome: SessionOutcome;
  reason: string | null;
  prs: OutcomePr[];
  /** claude.ai artifact links, from the outcome record. */
  artifacts: string[];
  /** Memory / lesson files it wrote, from the outcome record. */
  learnings: string[];
  /** Est. API-equivalent USD from the usage store; null when the store has no rows for it. */
  costUsd: number | null;
  /** Tripwire ids this session hit while it ran. */
  tripwireLessons: string[];
  /** Vault-relative note path (archive.ts), or null when the archive doesn't know this id. */
  vaultNote: string | null;
  retiredAt: string;
  trashBatch: string;
}

/** One line of data/alumni.jsonl (server/features/alumni.ts owns the file). "voided" is a
 *  compensating event for a card written before every retire guard had actually passed (a late
 *  guard refusal, a rename failure, or the trash-root check) — currentAlumni() folds it exactly
 *  like "restored": the session it names is never a current alumnus because of it. */
export type AlumniEvent =
  | ({ kind: "retired" } & LegacyCard)
  | { kind: "restored"; sessionId: string; at: string }
  | { kind: "voided"; sessionId: string; at: string; trashBatch: string };

/** A session as the Hall's Engineering bay / Research library rows show it (lighter than a full
 *  legacy card: these sessions haven't necessarily been retired). */
export interface HallSession {
  sessionId: string;
  name: string;
  outcome: SessionOutcome;
  reason: string | null;
  lastActive: string;
  prs: OutcomePr[];
  artifacts: string[];
  learnings: string[];
}

export interface EngineeringRepo {
  repo: string;
  sessions: HallSession[];
}

export interface AlumniResponse {
  ok: true;
  generatedAt: string;
  range: AlumniRange;
  /** Currently-retired sessions (a restore removes one; a re-retire brings it back), filtered to `range`. */
  cards: LegacyCard[];
  /** Shipped / delivered indexed sessions, grouped by repo, most sessions first; filtered to `range`. */
  engineeringBay: EngineeringRepo[];
  /** Indexed sessions in the RESEARCH topic group with at least one artifact or learning; filtered to `range`. */
  researchLibrary: HallSession[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const PR_STATES: readonly string[] = ["MERGED", "OPEN", "CLOSED", "unknown", "unchecked"] satisfies readonly PrState[];

function isOutcomePr(v: unknown): v is OutcomePr {
  if (!isRecord(v)) return false;
  return (
    typeof v.repo === "string" &&
    typeof v.number === "number" &&
    typeof v.url === "string" &&
    typeof v.state === "string" &&
    PR_STATES.includes(v.state) &&
    (v.mergedAt === null || typeof v.mergedAt === "string") &&
    (v.checkedAt === null || typeof v.checkedAt === "string") &&
    typeof v.firstSeenAt === "string"
  );
}

function isOutcomePrArray(v: unknown): v is OutcomePr[] {
  return Array.isArray(v) && v.every(isOutcomePr);
}

function isHallSession(v: unknown): v is HallSession {
  if (!isRecord(v)) return false;
  return (
    typeof v.sessionId === "string" &&
    typeof v.name === "string" &&
    isSessionOutcome(v.outcome) &&
    (v.reason === null || typeof v.reason === "string") &&
    typeof v.lastActive === "string" &&
    isOutcomePrArray(v.prs) &&
    isStringArray(v.artifacts) &&
    isStringArray(v.learnings)
  );
}

function isEngineeringRepo(v: unknown): v is EngineeringRepo {
  return isRecord(v) && typeof v.repo === "string" && Array.isArray(v.sessions) && v.sessions.every(isHallSession);
}

function isLegacyCard(v: unknown): v is LegacyCard {
  if (!isRecord(v)) return false;
  return (
    typeof v.sessionId === "string" &&
    typeof v.name === "string" &&
    typeof v.city === "string" &&
    typeof v.startedAt === "string" &&
    typeof v.lastActive === "string" &&
    isSessionOutcome(v.outcome) &&
    (v.reason === null || typeof v.reason === "string") &&
    isOutcomePrArray(v.prs) &&
    isStringArray(v.artifacts) &&
    isStringArray(v.learnings) &&
    (v.costUsd === null || typeof v.costUsd === "number") &&
    isStringArray(v.tripwireLessons) &&
    (v.vaultNote === null || typeof v.vaultNote === "string") &&
    typeof v.retiredAt === "string" &&
    typeof v.trashBatch === "string"
  );
}

/** GET /api/alumni, validated; null when it isn't that shape (the client trusts nothing it parses). */
export function parseAlumniResponse(v: unknown): AlumniResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.generatedAt !== "string") return null;
  if (typeof v.range !== "string" || !(ALUMNI_RANGES as readonly string[]).includes(v.range)) return null;
  if (!Array.isArray(v.cards) || !v.cards.every(isLegacyCard)) return null;
  if (!Array.isArray(v.engineeringBay) || !v.engineeringBay.every(isEngineeringRepo)) return null;
  if (!Array.isArray(v.researchLibrary) || !v.researchLibrary.every(isHallSession)) return null;
  return {
    ok: true,
    generatedAt: v.generatedAt,
    range: v.range as AlumniRange,
    cards: v.cards,
    engineeringBay: v.engineeringBay,
    researchLibrary: v.researchLibrary,
  };
}

/** Retired workers (careers-registry), for the Hall's Emeriti section. Null hides the section
 *  entirely (careers data unavailable, e.g. the fetch failed), as opposed to [] (careers data
 *  loaded fine, none retired) — an unavailable source is never shown as a truthful zero. */
export function emeritiOf(careers: CareersResponse | null): CareerWorker[] | null {
  if (!careers) return null;
  return careers.workers.filter((w) => w.state === "retired");
}
