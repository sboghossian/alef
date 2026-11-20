// The Alef resident: one long-lived agent that lives in the world and evolves. It is a
// sandboxed actor — it may only change files under its own home (~/.alef-resident), and the
// server (not its prompt) enforces that. Anything outside its home becomes a proposal in the
// Inbox that needs Alex's click. Snapshot key: "resident.state".

export const RESIDENT_FEATURE_ID = "resident";
export const RESIDENT_SNAPSHOT_KEY = "resident.state";

/** One entry in the append-only write log: every file the resident changed, and why. */
export interface ResidentWrite {
  at: string; // ISO time
  path: string; // relative to the resident home, e.g. "journal/2026-09-26.md"
  bytes: number;
  reason: string;
}

/** Something the resident wants done outside its sandbox. Never executed without a click. */
export interface ResidentProposal {
  id: string;
  at: string;
  kind: "session" | "skill" | "memory" | "note";
  title: string;
  why: string;
  status: "open" | "approved" | "dismissed";
}

export interface ResidentState {
  name: string; // shown on its room plaque
  enabled: boolean; // kill switch
  bornAt: string; // first run, ISO
  day: number; // days alive, 1-based
  lastTickAt: string | null; // last Jev tick
  lastReflectAt: string | null; // last hourly Haiku reflection that wrote its artifact
  lastError: string | null;
  goals: string[]; // current goals (from goals.md)
  skills: string[]; // names of skills it has written for itself
  journalTail: string[]; // last few journal lines, newest last
  recentWrites: ResidentWrite[]; // newest last
  proposals: ResidentProposal[]; // open first
  spend: { todayUsd: number; capUsd: number }; // est. cost of today's Haiku runs vs the cap
}

// ── Wire contract (routes + WS) ─────────────────────────────────────────────────────────────
//   GET  /api/resident                          -> ResidentState
//   POST /api/resident/enabled {enabled}        -> ResidentActionResult (the kill switch)
//   POST /api/resident/proposals/:id/approve    -> ResidentActionResult (v1: marks approved only)
//   POST /api/resident/proposals/:id/dismiss    -> ResidentActionResult
//   WS "resident" feature message               -> ResidentMessage
//   WorldSnapshot.extras["resident.state"]      -> ResidentState
//
// Goals, skills, journal lines and proposal text are written by a model that read fleet text:
// untrusted. Render escaped, never execute.

/** Default daily cap on the estimated spend of the hourly Haiku reflection. */
export const RESIDENT_DEFAULT_CAP_USD = 0.5;

export interface ResidentActionResult {
  ok: boolean;
  error?: string;
  state?: ResidentState;
}

export type ResidentMessage = { kind: "state"; state: ResidentState };

const PROPOSAL_KINDS: readonly string[] = ["session", "skill", "memory", "note"];
const PROPOSAL_STATUSES: readonly string[] = ["open", "approved", "dismissed"];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isResidentWrite(v: unknown): v is ResidentWrite {
  return isObj(v) && typeof v.at === "string" && typeof v.path === "string" && typeof v.bytes === "number" && typeof v.reason === "string";
}

export function isResidentProposal(v: unknown): v is ResidentProposal {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    typeof v.kind === "string" &&
    PROPOSAL_KINDS.includes(v.kind) &&
    typeof v.title === "string" &&
    typeof v.why === "string" &&
    typeof v.status === "string" &&
    PROPOSAL_STATUSES.includes(v.status)
  );
}

/** Validates `extras["resident.state"]` / a WS payload before the client trusts it. */
export function isResidentState(v: unknown): v is ResidentState {
  if (!isObj(v)) return false;
  const spend = v.spend;
  return (
    typeof v.name === "string" &&
    typeof v.enabled === "boolean" &&
    typeof v.bornAt === "string" &&
    typeof v.day === "number" &&
    (v.lastTickAt === null || typeof v.lastTickAt === "string") &&
    (v.lastReflectAt === null || typeof v.lastReflectAt === "string") &&
    (v.lastError === null || typeof v.lastError === "string") &&
    isStringArray(v.goals) &&
    isStringArray(v.skills) &&
    isStringArray(v.journalTail) &&
    Array.isArray(v.recentWrites) &&
    v.recentWrites.every(isResidentWrite) &&
    Array.isArray(v.proposals) &&
    v.proposals.every(isResidentProposal) &&
    isObj(spend) &&
    typeof spend.todayUsd === "number" &&
    typeof spend.capUsd === "number"
  );
}
