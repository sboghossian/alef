// Types for the "router" feature (round 10): one global endpoint, POST /api/router/route,
// that a UserPromptSubmit hook (hooks/jev-router.mjs, outside this app) calls for EVERY
// Claude Code prompt on this Mac — not just Alef's own sessions. A hook can only ever
// return `additionalContext`; it cannot switch the model or rewrite the prompt (verified
// from the raw Claude Code docs, 2026-09-26). So this endpoint gives ADVICE — a model-tier
// recommendation plus a short list of memory/vault notes worth reading — never a command.
//
// Inside Alef's own chat panel (round 10 §1), the same advice is instead applied, not just
// shown — that's the "chat" package's job, not this one.

export interface RouterRequest {
  /** The prompt text the hook saw. 1..MAX_PROMPT_CHARS (see router-lib.ts). */
  prompt: string;
  /** The session's cwd, if the hook has one. Accepted for future project-aware routing;
   *  v1 does not use it to change the model pick or the note candidates. */
  cwd?: string;
}

/** The four tiers ~/.claude/CLAUDE.md routes between. Fable is narrow on purpose — legal
 *  drafting, document extraction, quality-judged public artifacts — but it has to be in the
 *  union, because a tier missing here is a tier Jev is never offered and can never pick. */
export type ModelTier = "opus" | "fable" | "sonnet" | "haiku";

/** Dearest first. The one list both the Jev choice allowlist (server/features/router-lib.ts)
 *  and the canvas's router lane iterate, so a new tier cannot be half-added. */
export const MODEL_TIERS: readonly ModelTier[] = ["opus", "fable", "sonnet", "haiku"];

export interface RouterNote {
  /** Absolute path on this machine (a memory .md, a vault _index.md, or "brain-graph:<p>"). */
  path: string;
  title: string;
  /** <=140 chars: why this note surfaced (a BM25 match or a Jev relevance score). */
  why: string;
}

export interface RouterTool {
  /** How Alex names the tool, e.g. "Linear MCP", "spark CLI", "/browse". */
  name: string;
  /** <=140 chars: why it surfaced (a keyword match, or Jev's own relevance). */
  why: string;
}

/** What the Dispatch card says comes out of the work. */
export type Deliverable = "answer" | "file" | "artifact" | "doc" | "pr";
export const DELIVERABLES: readonly Deliverable[] = ["answer", "file", "artifact", "doc", "pr"];

/** quick = act inline, big = hand parts to sub-agents at the card's tier. */
export type TaskSize = "quick" | "standard" | "big";
export const TASK_SIZES: readonly TaskSize[] = ["quick", "standard", "big"];

/** The rest of what the one batched Jev call decides, beyond tier, notes and tools.
 *  Probabilities are 0..1; any field Jev did not answer is null. */
export interface Dispatch {
  /** P(the task depends on project history). Under 0.5 the hook tells the session to act
   *  now and leaves the notes off the card. */
  history: number | null;
  /** P(the task needs fresh information from the web). */
  web: number | null;
  deliver: Deliverable | null;
  size: TaskSize | null;
  /** The installed skill Jev thinks covers the work, if any cleared SKILL_FIT_FLOOR. */
  skill: { name: string; p: number } | null;
  /** 0..3 questions worth asking Alex before starting, from the fixed question bank. */
  ask: string[];
}

export interface RouterResult {
  ok: boolean;
  /** null when routing couldn't be decided at all (never happens in practice — the rules
   *  fallback always returns a tier — but kept nullable per the round10-plan contract). */
  model: ModelTier | null;
  /** <=200 chars: why that model tier, and whether it came from Jev or the rules fallback. */
  why: string;
  /** Best first, 0..4 (empty when the corpus index isn't ready yet or nothing matched). */
  notes: RouterNote[];
  /** Tools/MCPs worth having open, best first, 0..4. Keyword rules propose the candidates
   *  and Jev prunes them, so a prompt that merely says the word "deploy" no longer drags a
   *  deploy toolchain onto the card. Absent on an older server; the hook falls back to its
   *  own keyword table then, so it still works with nothing listening. */
  tools?: RouterTool[];
  /** Absent on the rules fallback and on an older server; the hook prints the plain route
   *  card then. */
  dispatch?: Dispatch;
  /** Wall-clock time this call took, in ms. */
  ms: number;
}

// ── Route-card telemetry ────────────────────────────────────────────────────────────────
// What the router has ACTUALLY decided, read back from the log the hook appends to
// (~/.claude/logs/route-card.jsonl, one prompt-free line per prompt). The canvas's "Jev
// router" lane showed only whether the hook looked installed, which is why it read as dead
// while 747 real decisions sat in this log unused.

export const ROUTER_CARDS_KEY = "router.cards";

export interface RouteCardSummary {
  /** Decisions parsed, newest-capped (see MAX_ROUTE_CARDS_PARSED). */
  total: number;
  /** Of those, the ones timestamped since local midnight. */
  today: number;
  /** Decisions per tier. Every ModelTier is present, including ones at 0 — a tier the
   *  router never picks is the single most useful thing this summary can show. */
  byTier: Record<ModelTier, number>;
  /** Prompts where the hook reached no server at all, so no tier was advised. */
  down: number;
  /** Decisions that came from the keyword rules rather than Jev. */
  rules: number;
  /** Follow-up prompts where the hook reused the session's last card and called nothing. */
  cached?: number;
  /** ISO timestamp of the newest decision, or null when the log is empty/unreadable. */
  lastAt: string | null;
}

function isTier(x: unknown): x is ModelTier {
  return typeof x === "string" && (MODEL_TIERS as readonly string[]).includes(x);
}

/** Validates an extras payload. Returns null rather than a zeroed summary on anything
 *  malformed, so the canvas can tell "no telemetry" apart from "telemetry says zero". */
export function parseRouteCardSummary(x: unknown): RouteCardSummary | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  const nums = ["total", "today", "down", "rules"] as const;
  if (nums.some((k) => typeof o[k] !== "number" || !Number.isFinite(o[k] as number))) return null;
  if (typeof o.byTier !== "object" || o.byTier === null) return null;
  const raw = o.byTier as Record<string, unknown>;
  const byTier = {} as Record<ModelTier, number>;
  for (const t of MODEL_TIERS) {
    const v = raw[t];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    byTier[t] = v;
  }
  if (o.lastAt !== null && typeof o.lastAt !== "string") return null;
  const cached = typeof o.cached === "number" && Number.isFinite(o.cached) ? { cached: o.cached } : {};
  return { total: o.total as number, today: o.today as number, byTier, down: o.down as number, rules: o.rules as number, ...cached, lastAt: o.lastAt as string | null };
}
