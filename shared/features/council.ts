// Types (+ the one shared validator) for the "council" feature: a 4-persona Jev
// debate ported from ~/Documents/Code/crucible (pragmatist / visionary / skeptic /
// user-advocate) plus one headless Claude synthesis call. Server and client both
// import `validateCouncilRequest` so the accepted shape can never drift between them.
// See docs/FEATURES.md.

export type CouncilPersonaId = "pragmatist" | "visionary" | "skeptic" | "user-advocate";

export const COUNCIL_DECISION_MAX = 1000;
export const COUNCIL_MIN_OPTIONS = 2;
export const COUNCIL_MAX_OPTIONS = 5;
export const COUNCIL_OPTION_MAX = 200;
export const COUNCIL_CONTEXT_MAX = 2000;
export const COUNCIL_DEFAULT_OPTIONS: readonly [string, string] = ["Yes", "No"];
export const COUNCIL_HISTORY_LIMIT = 20;

export interface CouncilRequest {
  decision: string; // 1..COUNCIL_DECISION_MAX chars
  options: string[]; // 2..5, already normalized (trimmed, non-empty)
  context?: string; // optional agent title/cwd/recent-activity summary
}

/** One option's share of a persona's Choice answer. */
export interface CouncilOptionShare {
  option: string;
  probability: number;
}

export interface CouncilPersonaRisk {
  /** 0..(levels.length-1), probability-weighted position on the ordered risk levels. */
  score: number;
  /** The risk level with the highest probability, e.g. "High delivery risk". */
  level: string;
  confidence: number;
}

export interface CouncilPersonaResult {
  persona: CouncilPersonaId;
  label: string; // "The Pragmatist"
  lens: string; // one-line structural bias, shown as a tooltip/subtitle
  ok: boolean;
  /** Set when ok is false (Jev unavailable, or this persona's answer was missing/invalid). */
  error?: string;
  topChoice: string | null; // option text, or null when ok is false
  distribution: CouncilOptionShare[]; // same order as CouncilRequest.options
  confidence: number; // the Choice answer's confidence, 0 when !ok
  risk: CouncilPersonaRisk | null; // null when !ok
}

export interface CouncilAggregate {
  /** Fraction (0..1) of the personas that answered whose topChoice matches the majority option. */
  agreement: number;
  /** option text -> number of personas whose topChoice was that option. */
  split: Record<string, number>;
  lowestConfidencePersona: CouncilPersonaId | null;
}

export interface CouncilVerdict {
  ok: boolean;
  /** True when the synth call failed or returned too little to trust — the Jev table still stands alone. */
  unavailable?: boolean;
  pick?: string;
  why?: string;
  dissent?: string;
  changeMind?: string;
  error?: string;
}

export interface CouncilResult {
  id: string;
  at: string; // ISO
  decision: string;
  options: string[];
  context?: string;
  personas: CouncilPersonaResult[];
  aggregate: CouncilAggregate;
  verdict: CouncilVerdict;
  /** "keyword" = Jev was unavailable or the batched call failed; every persona is ok:false. */
  source: "jev" | "keyword";
  /** Absent on a council run from the panel. Set by scripts/council-round.ts (see CouncilRef). */
  ref?: CouncilRef;
}

/** A council that judged the self-improvement loop's top candidates (scripts/council-round.ts,
 *  run by the loop, never scheduled by Alef). `branch` is the branch the council's pick gets
 *  built on, or null when the council reached no pick. The census links it to the merged PR whose
 *  body names it ("Council: <id>"), and only when that PR's head branch is `branch` and the
 *  council ran before the merge. */
export interface CouncilRef {
  kind: "loop-round";
  branch: string | null;
}

export const COUNCIL_BRANCH_MAX = 100;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** A plain git branch name ("feat/loop-governance"): no spaces, no "..", no leading "-" or "/",
 *  no ".lock" suffix. Anything else is refused rather than cleaned up. */
export function isSafeBranchName(v: unknown): v is string {
  return typeof v === "string" && v.length <= COUNCIL_BRANCH_MAX && BRANCH_RE.test(v) && !v.includes("..") && !v.endsWith(".lock");
}

/** A stored or wire `ref`, or null when it isn't a valid CouncilRef (the store drops it). */
export function parseCouncilRef(v: unknown): CouncilRef | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { kind?: unknown; branch?: unknown };
  if (o.kind !== "loop-round") return null;
  if (o.branch === null) return { kind: "loop-round", branch: null };
  return isSafeBranchName(o.branch) ? { kind: "loop-round", branch: o.branch } : null;
}

export interface CouncilRunResponse {
  ok: boolean;
  result?: CouncilResult;
  error?: string;
}

export interface CouncilHistoryResponse {
  ok: boolean;
  history: CouncilResult[]; // newest first, <= COUNCIL_HISTORY_LIMIT
}

/** Server: validates a raw JSON body. Client: validates already-typed form values.
 *  Either way `raw` fields are treated as unknown so both call sites can share this
 *  one function instead of keeping two copies of the same rules in sync. */
export function validateCouncilRequest(raw: {
  decision?: unknown;
  options?: unknown;
  context?: unknown;
}): { ok: true; value: CouncilRequest } | { ok: false; error: string } {
  const decision = typeof raw.decision === "string" ? raw.decision.trim() : "";
  if (decision.length < 1 || decision.length > COUNCIL_DECISION_MAX) {
    return { ok: false, error: `decision must be 1..${COUNCIL_DECISION_MAX} characters` };
  }

  let options: string[] = [];
  if (Array.isArray(raw.options)) {
    options = raw.options
      .filter((o): o is string => typeof o === "string")
      .map((o) => o.trim())
      .filter((o) => o.length > 0 && o.length <= COUNCIL_OPTION_MAX);
  }
  if (options.length === 0) options = [...COUNCIL_DEFAULT_OPTIONS];
  if (options.length < COUNCIL_MIN_OPTIONS || options.length > COUNCIL_MAX_OPTIONS) {
    return {
      ok: false,
      error: `options must be ${COUNCIL_MIN_OPTIONS}..${COUNCIL_MAX_OPTIONS} (leave empty to let Jev pick from Yes/No)`,
    };
  }

  const context = typeof raw.context === "string" ? raw.context.trim().slice(0, COUNCIL_CONTEXT_MAX) : "";
  return { ok: true, value: { decision, options, context: context || undefined } };
}
