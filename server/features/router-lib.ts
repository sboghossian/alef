// Pure logic for the "router" feature (round 10 §2, the Jev router). See
// shared/features/router.ts for the wire contract and server/features/router.ts for the
// HTTP route, the corpus index and the TypeSafe call. Kept free of fs/network so every
// rule here is a fast, deterministic vitest — no fixture corpus, no fake server needed.

import { isChoiceAnswer, type ChoiceAnswer } from "../director.js";
import {
  DELIVERABLES,
  MODEL_TIERS,
  TASK_SIZES,
  type Deliverable,
  type Dispatch,
  type ModelTier,
  type RouteCardSummary,
  type RouterNote,
  type RouterTool,
  type TaskSize,
} from "../../shared/features/router.js";
import { tokenize } from "./recall/bm25.js";

export const MAX_PROMPT_CHARS = 4000;
/** Notes offered to Jev for scoring in the one batched call — kept small so the call
 *  (1 choice question + up to this many score questions) stays comfortably inside budget. */
export const MAX_JEV_CANDIDATES = 8;
export const MAX_NOTES_OUT = 4;
/** Below this Jev "relevant" probability, a 3rd/4th note isn't worth padding the list with. */
export const NOTE_RELEVANCE_FLOOR = 0.35;
const MAX_WHY_CHARS = 200;
const MAX_NOTE_WHY_CHARS = 140;
/** Tool candidates offered to Jev for scoring. A few more than make it onto the card, so
 *  Jev has something to prune — the point of asking it at all. */
export const MAX_TOOL_CANDIDATES = 6;
export const MAX_TOOLS_OUT = 4;
/** Stricter than NOTE_RELEVANCE_FLOOR on purpose. A surplus note costs a glance; a surplus
 *  tool costs an auth check and a round trip, which is the computation this is meant to
 *  avoid — so a tool has to be more likely relevant than not to earn its line. */
export const TOOL_RELEVANCE_FLOOR = 0.5;

// ── Rules fallback: deterministic model-tier classification ────────────────────────────
// Mirrors ~/.claude/CLAUDE.md's "Routing — 4-tier": Haiku = mechanical (search, boilerplate,
// renames, file moves, doc edits); Fable = legal drafting, document extraction and
// quality-judged public artifacts; Opus = orchestration/architecture/hard backend/security/
// taste; Sonnet = everything else (UI, standard features, CRUD, refactors) and is the safe
// default when no keyword fires. Used whenever Jev is unavailable (no key, error, timeout,
// rate-limited) — and as the seed for `why` even when Jev picks the same tier.
//
// Order matters on a collision: Haiku is checked first (its triggers are narrow and
// unambiguous, and it's the cheapest tier to be wrong about); Fable next, because its
// triggers are domain nouns rather than engineering ones, so they are the least likely to
// fire by accident — but only if they stay that way, which is why "contract" (an API/wire
// contract) and "clause" (a WHERE clause) are deliberately NOT in the list below; Opus next
// (getting this one wrong costs quality, not just money); Sonnet is the catch-all.

const HAIKU_PHRASES = [
  "rename",
  "boilerplate",
  "scaffold",
  "move file",
  "move files",
  "search for",
  "find all",
  "grep",
  "doc edit",
  "documentation edit",
  "typo",
  "sort imports",
  "unused import",
  "reformat",
] as const;

const FABLE_PHRASES = [
  "legal draft",
  "legal drafting",
  "legal memo",
  "legal brief",
  "legal opinion",
  "nda",
  "engagement letter",
  "term sheet",
  "founder agreement",
  "shareholder agreement",
  "blog post",
  "press release",
  "website copy",
  "landing page copy",
  "document extraction",
  "redline",
] as const;

const OPUS_PHRASES = [
  "architecture",
  "architect",
  "orchestrat",
  "security",
  "auth",
  "authentication",
  "authorization",
  "encryption",
  "credential",
  "threat model",
  "race condition",
  "concurrency",
  "distributed system",
  "migration",
  "redesign",
  "hard backend",
  "taste",
  "system design",
] as const;

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

const HAIKU_RULES = HAIKU_PHRASES.map((p) => ({ phrase: p, re: phraseRegex(p) }));
const FABLE_RULES = FABLE_PHRASES.map((p) => ({ phrase: p, re: phraseRegex(p) }));
const OPUS_RULES = OPUS_PHRASES.map((p) => ({ phrase: p, re: phraseRegex(p) }));

export function classifyModelRules(prompt: string): { model: ModelTier; why: string } {
  const haikuHit = HAIKU_RULES.find((r) => r.re.test(prompt));
  if (haikuHit) return { model: "haiku", why: `rules: mechanical ("${haikuHit.phrase}")` };
  const fableHit = FABLE_RULES.find((r) => r.re.test(prompt));
  if (fableHit) return { model: "fable", why: `rules: drafting/extraction ("${fableHit.phrase}")` };
  const opusHit = OPUS_RULES.find((r) => r.re.test(prompt));
  if (opusHit) return { model: "opus", why: `rules: architecture/security ("${opusHit.phrase}")` };
  return { model: "sonnet", why: "rules: no strong signal, default to standard-feature tier" };
}

// ── Candidate tools ────────────────────────────────────────────────────────────────────
// Keyword rules propose; Jev prunes. The regexes only have to be high-RECALL (a false
// positive is a candidate Jev throws away), which is what lets them stay this blunt.
//
// hooks/jev-router.mjs carries its own copy of this table. That duplication is deliberate:
// the hook must still name tools when this server is not listening at all, and a hook that
// imported from the app would fail closed on every prompt the moment the app moved.

const TOOL_TABLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\blinear\b|\bGRO-\d+|\bticket\b/i, "Linear MCP"],
  [/\b(e-?mail|inbox|spark)\b/i, "spark CLI"],
  [/\b(calendar|meeting|agenda)\b/i, "spark CLI (calendar)"],
  [/\bposthog\b|\bsignups?\b|\bfunnel\b/i, "PostHog MCP"],
  [/\bfigma\b/i, "Figma MCP"],
  [/\bnotion\b/i, "Notion MCP"],
  [/\bhubspot\b|\bcrm\b/i, "HubSpot MCP"],
  [/\bhiggsfield\b/i, "Higgsfield MCP"],
  [/\b(pull request|PR #?\d+|github)\b/i, "gh CLI"],
  [/https?:\/\/|\bscreenshot\b|\bbrowse\b|\bqa\b/i, "/browse"],
  [/\bvercel\b|\bdeploy\b/i, "vercel / acme-deploy-verify"],
];

/** Unique tool names the prompt's keywords suggest, in table order, capped for the Jev call. */
export function toolCandidates(prompt: string): string[] {
  const text = typeof prompt === "string" ? prompt : "";
  const out: string[] = [];
  for (const [re, name] of TOOL_TABLE) {
    if (re.test(text) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_TOOL_CANDIDATES) break;
  }
  return out;
}

export function toolId(index: number): string {
  return `tool_${index}`;
}

/** Keeps the tools Jev rates at or above the floor, best first. With no Jev answer at all
 *  (`relevance === null`) the keyword matches stand as-is — degraded, never empty. */
export function pickTools(candidates: readonly string[], relevance: ReadonlyMap<number, number> | null): RouterTool[] {
  if (candidates.length === 0) return [];
  if (!relevance) {
    return candidates.slice(0, MAX_TOOLS_OUT).map((name) => ({ name, why: "keyword match" }));
  }
  return candidates
    .map((name, i) => ({ name, rel: relevance.get(i) ?? 0 }))
    .filter((t) => t.rel >= TOOL_RELEVANCE_FLOOR)
    .sort((a, b) => b.rel - a.rel)
    .slice(0, MAX_TOOLS_OUT)
    .map((t) => ({ name: t.name, why: `Jev: needed · ${Math.round(t.rel * 100)}%`.slice(0, MAX_NOTE_WHY_CHARS) }));
}

// ── Candidate notes ─────────────────────────────────────────────────────────────────────

/** A BM25 hit from the local index, trimmed to what's safe to hand to Jev: a title only,
 *  never the snippet/body (same "titles only cross into a TypeSafe call" rule recall.ts
 *  documents for the identical corpus). */
export interface NoteCandidate {
  path: string;
  title: string;
  bm25Score: number;
}

/** Interleaves memory-vector hits with BM25 hits (vector first, it catches the paraphrases
 *  keyword search misses), drops repeated paths, and caps the list for the Jev call. Either
 *  side may be empty: no vector index, or a vector query that missed its time budget. */
export function mergeCandidates(vector: readonly NoteCandidate[], bm25: readonly NoteCandidate[], max = MAX_JEV_CANDIDATES): NoteCandidate[] {
  const out: NoteCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < max && (i < vector.length || i < bm25.length); i += 1) {
    for (const c of [vector[i], bm25[i]]) {
      if (c && !seen.has(c.path) && out.length < max) {
        seen.add(c.path);
        out.push(c);
      }
    }
  }
  return out;
}

/** "project_alef-repo.md" -> "project alef-repo": a readable title for a vector hit whose
 *  file the BM25 index does not hold, without reading the file. */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "").replace(/[_]+/g, " ").trim().slice(0, 120) || base;
}

export function candidateId(index: number): string {
  return `note_${index}`;
}

export interface ScoreAnswer {
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export function isScoreAnswer(x: unknown): x is ScoreAnswer {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.score === "number" && typeof o.confidence === "number" && typeof o.probabilities === "object" && o.probabilities !== null;
}

const MODEL_CRITERIA: Record<ModelTier, string> = {
  opus: "Orchestration, system/architecture design, hard backend work, security-sensitive logic, or a taste call.",
  fable: "Legal drafting, document extraction, or writing a public artifact that will be judged on its quality.",
  sonnet: "UI work, a standard feature, straightforward CRUD, or a refactor.",
  haiku: "Purely mechanical: search, boilerplate, renames, file moves, or a doc edit.",
};

// A TypeSafe Score question's `criteria` is an ORDERED low->high array of level labels
// (2..10 levels), not an object — confirmed against council-personas.ts's `riskLevels`
// (the working Score usage council-jev.ts already sends) and against a live 422 this file
// used to get back when it tried an object shape instead. The returned `probabilities` are
// keyed by that array's string index ("0", "1", ...), which is why RELEVANT_LEVEL_INDEX
// below is "1", not a named key.
const NOTE_RELEVANCE_LEVELS = ["Unrelated to the prompt", "Relevant to the prompt"] as const;
const TOOL_NEEDED_LEVELS = ["Not needed to handle the prompt", "Needed to handle the prompt"] as const;
const RELEVANT_LEVEL_INDEX = "1";

/** The one batched TypeSafe body: a Choice over the 4 model tiers, plus one Score question
 *  per candidate note (how relevant it is to the prompt) and one per candidate tool (whether
 *  the prompt actually needs it). Exported so a test can inspect the exact shape sent, same
 *  spirit as buildCouncilJevBody. */
export function buildRouterJevBody(
  prompt: string,
  candidates: readonly NoteCandidate[],
  tools: readonly string[] = [],
  skills: readonly SkillCandidate[] = [],
  bank: readonly AskQuestion[] = [],
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    // The batched call only needs enough of the prompt to judge tier + note relevance —
    // not the full multi-KB paste a coding prompt can be.
    prompt: prompt.slice(0, 800),
  };
  const questions: Record<string, unknown> = {
    model: {
      type: "choice",
      instructions: 'prompt (see state) is about to go to a coding agent. Which model tier best fits the work it describes?',
      criteria: MODEL_CRITERIA,
    },
  };
  if (candidates.length > 0) {
    state.notes = candidates.map((c, i) => ({ id: candidateId(i), title: c.title }));
    for (let i = 0; i < candidates.length; i += 1) {
      questions[candidateId(i)] = {
        type: "score",
        instructions: `notes[${i}] (see state) is a private note title. How relevant is it to handling "prompt"?`,
        criteria: NOTE_RELEVANCE_LEVELS,
      };
    }
  }
  if (tools.length > 0) {
    state.tools = tools.map((name, i) => ({ id: toolId(i), name }));
    for (let i = 0; i < tools.length; i += 1) {
      questions[toolId(i)] = {
        type: "score",
        instructions: `tools[${i}] (see state) is a tool available to the agent. Does handling "prompt" actually require it?`,
        criteria: TOOL_NEEDED_LEVELS,
      };
    }
  }
  Object.assign(questions, dispatchQuestions(state, skills, bank));
  return { model: "jev-latest", state, questions };
}

const MODEL_KEYS: readonly ModelTier[] = MODEL_TIERS;

export interface ParsedRouterAnswers {
  model: ModelTier;
  modelWhy: string;
  /** candidate index -> Jev's "relevant" probability + its confidence. A candidate with no
   *  entry here (a missing/malformed per-note answer) just drops that note, not the whole call. */
  noteRelevance: Map<number, { relevantProb: number; confidence: number }>;
  /** tool index -> Jev's "needed" probability. Empty when no tools were offered. A missing
   *  answer scores 0, so an unanswered tool is pruned rather than waved through. */
  toolRelevance: Map<number, number>;
  /** The dispatch answers. Each field is null when Jev did not answer it, so one bad
   *  answer drops that line of the card, not the card. */
  history: number | null;
  web: number | null;
  deliver: Deliverable | null;
  size: TaskSize | null;
  /** skill candidate index -> P(fits) */
  skillFit: Map<number, number>;
  /** question-bank index -> P(the answer would change the work) */
  askNeed: Map<number, number>;
}

/** Throws on a missing/invalid "model" answer (the caller falls back to rules); a bad
 *  per-note answer is tolerated and simply excluded from `noteRelevance`. */
export function parseRouterJevAnswers(raw: unknown, candidateCount: number, toolCount = 0, skillCount = 0, askCount = 0): ParsedRouterAnswers {
  if (typeof raw !== "object" || raw === null) throw new Error("typesafe response not an object");
  const answers = (raw as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) throw new Error("typesafe response missing answers");
  const a = answers as Record<string, unknown>;

  const modelAnswer = a.model;
  if (!isChoiceAnswer(modelAnswer)) throw new Error('typesafe response missing/invalid answer for "model"');
  const typed: ChoiceAnswer = modelAnswer;
  if (!(MODEL_KEYS as readonly string[]).includes(typed.choice)) {
    throw new Error(`typesafe response chose an unknown model tier "${typed.choice}"`);
  }
  const model = typed.choice as ModelTier;
  const modelWhy = `Jev: ${model} · ${Math.round(typed.confidence * 100)}% confidence`;

  const noteRelevance = new Map<number, { relevantProb: number; confidence: number }>();
  for (let i = 0; i < candidateCount; i += 1) {
    const ans = a[candidateId(i)];
    if (!isScoreAnswer(ans)) continue;
    // Score probabilities are keyed by NOTE_RELEVANCE_LEVELS's string index, not a name —
    // "1" is that array's "Relevant to the prompt" level.
    noteRelevance.set(i, { relevantProb: ans.probabilities[RELEVANT_LEVEL_INDEX] ?? 0, confidence: ans.confidence });
  }

  const toolRelevance = new Map<number, number>();
  for (let i = 0; i < toolCount; i += 1) {
    const ans = a[toolId(i)];
    if (!isScoreAnswer(ans)) continue;
    toolRelevance.set(i, ans.probabilities[RELEVANT_LEVEL_INDEX] ?? 0);
  }
  return { model, modelWhy, noteRelevance, toolRelevance, ...parseDispatchAnswers(a, skillCount, askCount) };
}

/** Ranks candidates (Jev relevance when available, else BM25 order), keeps 0..MAX_NOTES_OUT,
 *  and stops padding past the 2nd note once Jev relevance drops below the floor. In rules
 *  mode (`relevance === null`) every candidate is equally "no better signal than BM25", so
 *  it fills up to the cap without the floor cutoff. */
export function pickNotes(
  candidates: readonly NoteCandidate[],
  relevance: ReadonlyMap<number, { relevantProb: number; confidence: number }> | null,
): RouterNote[] {
  if (candidates.length === 0) return [];

  const ranked = candidates
    .map((c, i) => ({ c, rel: relevance?.get(i) ?? null }))
    .sort((a, b) => {
      // With Jev relevance in play, a candidate Jev didn't answer for ranks last (its raw
      // BM25 score lives on an unrelated scale and must never outrank a real probability).
      const av = relevance ? (a.rel ? a.rel.relevantProb : -1) : a.c.bm25Score;
      const bv = relevance ? (b.rel ? b.rel.relevantProb : -1) : b.c.bm25Score;
      return bv - av;
    });

  const out: RouterNote[] = [];
  for (const { c, rel } of ranked) {
    if (out.length >= MAX_NOTES_OUT) break;
    if (relevance && out.length >= 2 && rel && rel.relevantProb < NOTE_RELEVANCE_FLOOR) break;
    const why = rel ? `Jev: relevant · ${Math.round(rel.relevantProb * 100)}%` : `BM25 match · ${c.bm25Score.toFixed(2)}`;
    out.push({ path: c.path, title: c.title, why: why.slice(0, MAX_NOTE_WHY_CHARS) });
  }
  return out;
}

export function clampWhy(why: string): string {
  return why.slice(0, MAX_WHY_CHARS);
}

// ── Rate limiting (Jev call budget, not the endpoint itself — the endpoint always answers,
// falling back to rules when the budget is spent) ───────────────────────────────────────

export interface RateLimiter {
  /** True and consumes one slot if under budget for the current window; false (consumes
   *  nothing) once the window's budget is spent. */
  tryAcquire(): boolean;
}

/** Fixed-window limiter: simple, deterministic, and enough for "don't drain the shared
 *  TypeSafe budget when every prompt on the Mac hits this endpoint". */
export function createRateLimiter(maxPerWindow: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  let windowStart = now();
  let count = 0;
  return {
    tryAcquire() {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        count = 0;
      }
      if (count >= maxPerWindow) return false;
      count += 1;
      return true;
    },
  };
}

// ── Route-card telemetry ────────────────────────────────────────────────────────────────

/** Lines parsed from the tail of the log. The hook appends one line per prompt forever, so
 *  this is a bound on the work a snapshot does, not on what the log may hold. */
export const MAX_ROUTE_CARDS_PARSED = 5000;

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Counts what the router actually decided, from the raw jsonl the hook writes. Pure: the
 *  caller does the reading. A malformed line is skipped rather than failing the summary —
 *  this is telemetry, and a half-written last line is normal when a prompt is in flight. */
export function summarizeRouteCards(text: string, now: number = Date.now()): RouteCardSummary {
  const byTier = {} as Record<ModelTier, number>;
  for (const t of MODEL_TIERS) byTier[t] = 0;
  const summary: RouteCardSummary = { total: 0, today: 0, byTier, down: 0, rules: 0, cached: 0, lastAt: null };

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const midnight = startOfLocalDay(now);
  for (const line of lines.slice(-MAX_ROUTE_CARDS_PARSED)) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const o = row as Record<string, unknown>;
    summary.total += 1;

    const ts = typeof o.ts === "string" ? o.ts : null;
    if (ts) {
      const t = Date.parse(ts);
      if (Number.isFinite(t)) {
        if (t >= midnight) summary.today += 1;
        // The log is append-ordered, but a clock change or a concurrent write can put an
        // older line last, so this keeps the max rather than trusting the final line.
        if (summary.lastAt === null || ts > summary.lastAt) summary.lastAt = ts;
      }
    }

    const model = o.model;
    if (typeof model === "string" && model in byTier) byTier[model as ModelTier] += 1;
    else if (o.source === "cached") summary.cached = (summary.cached ?? 0) + 1; // a follow-up that reused the last card
    else summary.down += 1; // model null = the hook reached no server
    if (o.source === "rules") summary.rules += 1;
  }
  return summary;
}

// ── Dispatch: what else the same batched call decides ──────────────────────────────────
// The one call that picks the tier also answers: does the task need project history,
// does it need the web, what should come out of it, how big it is, which installed skill
// fits, and which of a fixed bank of questions are worth asking Alex first. Code makes
// every candidate (skills from the inventory, questions from QUESTION_BANK); Jev only
// judges them, never invents one. Yes/no questions use the same 2-level Score shape the
// note and tool questions already send, so no new TypeSafe question type is involved.

export interface SkillCandidate {
  slug: string;
  description: string;
}

export interface AskQuestion {
  id: string;
  text: string;
}

/** Skills offered to Jev per prompt. Enough to cover a near-miss, few enough that the
 *  batch stays inside the hook's budget. */
export const MAX_SKILL_CANDIDATES = 5;
/** A skill has to be more likely right than not: a wrong skill hint costs a whole
 *  detour, so the bar matches TOOL_RELEVANCE_FLOOR. */
export const SKILL_FIT_FLOOR = 0.5;
/** Questions only earn a place when Jev is fairly sure the answer changes the work; the
 *  default is to act on the likeliest reading, not to interview. */
export const ASK_FLOOR = 0.6;
export const MAX_ASK_OUT = 3;
const MAX_SKILL_DESC_CHARS = 240;

/** General questions that, when unanswered, most often change the work. Seeded from the
 *  50-question artifact interview (2026-10-29); kept short because every entry is one
 *  more Score question on every prompt. */
export const QUESTION_BANK: readonly AskQuestion[] = [
  { id: "audience", text: "Who is this for: just you, or someone else (team, client, public)?" },
  { id: "done", text: "What should you be able to do with the result when it is done?" },
  { id: "base", text: "Is there an existing file, page or PR this should build on?" },
  { id: "constraint", text: "Any hard constraint: deadline, format, tool or budget?" },
  { id: "outside", text: "Should this change anything outside the project (send, publish, deploy, merge)?" },
  { id: "project", text: "Which project or brand does this belong to?" },
];

const YES_NO_LEVELS = ["No", "Yes"] as const;
const YES_LEVEL_INDEX = "1";

const DELIVER_CRITERIA: Record<Deliverable, string> = {
  answer: "A reply in the conversation: an answer, an explanation, a decision.",
  file: "A file on disk or a code change that does not need review as a pull request.",
  artifact: "A page to look at or use: a diagram, dashboard, explainer, tool or deck.",
  doc: "A document people will read and edit: a plan, spec, memo or notes.",
  pr: "A code change in a repository that goes through a pull request.",
};

const SIZE_CRITERIA: Record<TaskSize, string> = {
  quick: "A few tool calls at most: a lookup, a small edit, a short answer.",
  standard: "A focused piece of work: one feature, one fix, one document.",
  big: "Many steps or files, or several independent parts worth handing to sub-agents.",
};

export function skillId(index: number): string {
  return `skill_${index}`;
}

export function askId(index: number): string {
  return `ask_${index}`;
}

/** Top installed skills by word overlap between the prompt and the skill's slug and
 *  description. High recall on purpose: Jev prunes. A skill whose words never appear in
 *  the prompt is not offered at all. */
export function skillCandidates(prompt: string, skills: readonly SkillCandidate[]): SkillCandidate[] {
  const words = new Set(tokenize(prompt));
  if (words.size === 0) return [];
  return skills
    .map((s) => {
      const terms = new Set(tokenize(`${s.slug.replace(/[-:_]/g, " ")} ${s.description}`));
      let hits = 0;
      for (const w of words) if (terms.has(w)) hits += 1;
      return { s, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.s.slug.localeCompare(b.s.slug))
    .slice(0, MAX_SKILL_CANDIDATES)
    .map((x) => x.s);
}

function dispatchQuestions(state: Record<string, unknown>, skills: readonly SkillCandidate[], bank: readonly AskQuestion[]): Record<string, unknown> {
  const q: Record<string, unknown> = {
    history: {
      type: "score",
      instructions:
        'Does handling "prompt" depend on this person\'s project history or past decisions (earlier work, what was agreed, how their systems are set up), rather than on the prompt alone?',
      criteria: YES_NO_LEVELS,
    },
    web: {
      type: "score",
      instructions: 'Does handling "prompt" need fresh information from the public web (current prices, versions, news, docs)?',
      criteria: YES_NO_LEVELS,
    },
    deliver: { type: "choice", instructions: 'What should handling "prompt" produce?', criteria: DELIVER_CRITERIA },
    size: { type: "choice", instructions: 'How big is the work "prompt" asks for?', criteria: SIZE_CRITERIA },
  };
  if (skills.length > 0) {
    state.skills = skills.map((s, i) => ({ id: skillId(i), name: s.slug, description: s.description.slice(0, MAX_SKILL_DESC_CHARS) }));
    for (let i = 0; i < skills.length; i += 1) {
      q[skillId(i)] = {
        type: "score",
        instructions: `skills[${i}] (see state) is an installed skill. Is it made for exactly this kind of request? Answer No for a general workflow that could run almost any task, and No when its description says it starts on a keyword or phrase that "prompt" does not use.`,
        criteria: YES_NO_LEVELS,
      };
    }
  }
  if (bank.length > 0) {
    state.questions = bank.map((b, i) => ({ id: askId(i), text: b.text }));
    for (let i = 0; i < bank.length; i += 1) {
      q[askId(i)] = {
        type: "score",
        instructions: `questions[${i}] (see state) could be asked before starting. Is "prompt" unclear on it AND would the answer change how the work is done? Answer No when the prompt already settles it or any sensible default works.`,
        criteria: YES_NO_LEVELS,
      };
    }
  }
  return q;
}

function yesProb(x: unknown): number | null {
  return isScoreAnswer(x) ? (x.probabilities[YES_LEVEL_INDEX] ?? 0) : null;
}

function choiceOf<T extends string>(x: unknown, allowed: readonly T[]): T | null {
  return isChoiceAnswer(x) && (allowed as readonly string[]).includes(x.choice) ? (x.choice as T) : null;
}

function parseDispatchAnswers(a: Record<string, unknown>, skillCount: number, askCount: number) {
  const skillFit = new Map<number, number>();
  for (let i = 0; i < skillCount; i += 1) {
    const p = yesProb(a[skillId(i)]);
    if (p !== null) skillFit.set(i, p);
  }
  const askNeed = new Map<number, number>();
  for (let i = 0; i < askCount; i += 1) {
    const p = yesProb(a[askId(i)]);
    if (p !== null) askNeed.set(i, p);
  }
  return {
    history: yesProb(a.history),
    web: yesProb(a.web),
    deliver: choiceOf(a.deliver, DELIVERABLES),
    size: choiceOf(a.size, TASK_SIZES),
    skillFit,
    askNeed,
  };
}

/** Turns the parsed answers into the card's dispatch block. Null when Jev answered none of
 *  the dispatch questions (an older TypeSafe shape, or every one malformed), so the hook
 *  prints the plain route card rather than a dispatch block full of blanks. */
export function pickDispatch(
  parsed: Pick<ParsedRouterAnswers, "history" | "web" | "deliver" | "size" | "skillFit" | "askNeed">,
  skills: readonly SkillCandidate[],
  bank: readonly AskQuestion[],
): Dispatch | null {
  if (parsed.history === null && parsed.web === null && parsed.deliver === null && parsed.size === null) return null;
  let skill: Dispatch["skill"] = null;
  for (const [i, p] of parsed.skillFit) {
    const s = skills[i];
    if (s && p >= SKILL_FIT_FLOOR && (!skill || p > skill.p)) skill = { name: s.slug, p };
  }
  const ask = [...parsed.askNeed]
    .flatMap(([i, p]) => {
      const q = bank[i];
      return q && p >= ASK_FLOOR ? [{ text: q.text, p }] : [];
    })
    .sort((x, y) => y.p - x.p)
    .slice(0, MAX_ASK_OUT)
    .map((q) => q.text);
  return { history: parsed.history, web: parsed.web, deliver: parsed.deliver, size: parsed.size, skill, ask };
}

// ── Second wave: spreading activation over the vault graph ─────────────────────────────
// The notes most likely to matter are often one link away from the best keyword or vector
// hit (the decision note a project index links to, the memory a session cites). Before the
// one Jev call, the top seeds' outgoing links join the candidates, so Jev scores them in
// the same request. Still titles only.

export interface GraphNode {
  id: string;
  /** Vault-relative, with ".md". */
  path: string;
  kind: "n" | "a";
  links: readonly string[];
}

export interface GraphIndex {
  byPath: ReadonlyMap<string, GraphNode>;
  byId: ReadonlyMap<string, GraphNode>;
}

/** Seeds whose links are followed, links taken per seed, and the cap on the whole wave. */
export const WAVE_SEEDS = 2;
export const WAVE_PER_SEED = 2;
export const MAX_WAVE = 3;

/** Vault-relative path for a candidate, or null when it lives outside the vault. Working
 *  memory is symlinked into the vault at 60-Meta/claude-config/memory, so a memory file
 *  maps there by its file name. */
export function vaultRelative(path: string, vaultDir: string, memoryDir: string): string | null {
  if (path.startsWith("brain-graph:")) return path.slice("brain-graph:".length) || null;
  const root = vaultDir.endsWith("/") ? vaultDir : `${vaultDir}/`;
  if (path.startsWith(root)) return path.slice(root.length);
  const mem = memoryDir.endsWith("/") ? memoryDir : `${memoryDir}/`;
  if (path.startsWith(mem)) return `60-Meta/claude-config/memory/${path.slice(mem.length)}`;
  return null;
}

/** The linked notes of the first WAVE_SEEDS candidates that the graph knows, skipping
 *  attachments and anything already a candidate. `toRel` maps a candidate path into the
 *  vault; `toAbs` maps a linked note back to the path the card should print. */
export function graphWave(
  seeds: readonly NoteCandidate[],
  graph: GraphIndex,
  toRel: (path: string) => string | null,
  toAbs: (rel: string) => string,
): NoteCandidate[] {
  const taken = new Set<string>();
  for (const s of seeds) {
    const rel = toRel(s.path);
    if (rel) taken.add(rel);
  }
  const out: NoteCandidate[] = [];
  for (const seed of seeds.slice(0, WAVE_SEEDS)) {
    const rel = toRel(seed.path);
    const node = rel ? graph.byPath.get(rel) : undefined;
    if (!node) continue;
    let fromSeed = 0;
    for (const id of node.links) {
      if (out.length >= MAX_WAVE || fromSeed >= WAVE_PER_SEED) break;
      const linked = graph.byId.get(id);
      if (!linked || linked.kind !== "n" || taken.has(linked.path)) continue;
      taken.add(linked.path);
      fromSeed += 1;
      out.push({ path: toAbs(linked.path), title: titleFromPath(linked.path), bm25Score: 0 });
    }
  }
  return out;
}
