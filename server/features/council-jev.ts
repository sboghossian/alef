// The Jev round: one batched TypeSafe request carrying all 4 personas' Choice + Score
// questions over the same state (independent questions run in parallel — see
// docs.typesafe.ai), then in-code aggregation (agreement / split / lowest-confidence
// persona). Falls back to a "keyword" (no live Jev signal) result when there is no
// API key or the call fails, same spirit as server/ask-jev.ts and server/director.ts,
// which this module reuses `callJev`/`isChoiceAnswer`/`TIMEOUT_MS` from.

import type { CouncilAggregate, CouncilOptionShare, CouncilPersonaResult, CouncilRequest } from "../../shared/features/council.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type ChoiceAnswer, type FetchLike } from "../director.js";
import { COUNCIL_PERSONAS, type CouncilPersonaDef } from "./council-personas.js";

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

export interface CouncilJevOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function choiceKey(id: CouncilPersonaDef["id"]): string {
  return `${id}_choice`;
}
function riskKey(id: CouncilPersonaDef["id"]): string {
  return `${id}_risk`;
}
function optionKey(i: number): string {
  return `opt${i}`;
}

/** Builds the one batched request body: state (decision/options/context) + 8 questions
 *  (4 personas x Choice+Score). Exported so a test can inspect the exact shape sent. */
export function buildCouncilJevBody(request: CouncilRequest): Record<string, unknown> {
  const state: Record<string, unknown> = { decision: request.decision, options: request.options };
  if (request.context) state.context = request.context;

  const questions: Record<string, unknown> = {};
  for (const persona of COUNCIL_PERSONAS) {
    const criteria: Record<string, string> = {};
    request.options.forEach((opt, i) => (criteria[optionKey(i)] = opt));
    questions[choiceKey(persona.id)] = { type: "choice", instructions: persona.choiceInstructions, criteria };
    questions[riskKey(persona.id)] = { type: "score", instructions: persona.riskInstructions, criteria: persona.riskLevels };
  }

  return { model: "jev-latest", state, questions };
}

function emptyPersonaResult(persona: CouncilPersonaDef, error: string): CouncilPersonaResult {
  return { persona: persona.id, label: persona.label, lens: persona.lens, ok: false, error, topChoice: null, distribution: [], confidence: 0, risk: null };
}

/** All 4 personas as "no live Jev signal" — used when there's no API key or the batched call fails/times out. */
export function keywordCouncilPersonas(reason: string): CouncilPersonaResult[] {
  return COUNCIL_PERSONAS.map((p) => emptyPersonaResult(p, reason));
}

function personaFromAnswers(
  persona: CouncilPersonaDef,
  request: CouncilRequest,
  answers: Record<string, unknown>,
): CouncilPersonaResult {
  const choiceRaw = answers[choiceKey(persona.id)];
  const riskRaw = answers[riskKey(persona.id)];
  if (!isChoiceAnswer(choiceRaw)) return emptyPersonaResult(persona, `missing/invalid answer for "${choiceKey(persona.id)}"`);
  if (!isScoreAnswer(riskRaw)) return emptyPersonaResult(persona, `missing/invalid answer for "${riskKey(persona.id)}"`);

  const choice: ChoiceAnswer = choiceRaw;
  const distribution: CouncilOptionShare[] = request.options.map((opt, i) => ({
    option: opt,
    probability: choice.probabilities[optionKey(i)] ?? 0,
  }));
  const optIndex = Number.parseInt(choice.choice.replace("opt", ""), 10);
  const topChoice = Number.isInteger(optIndex) ? (request.options[optIndex] ?? null) : null;

  const risk: ScoreAnswer = riskRaw;
  let topLevelIdx = 0;
  let topLevelP = -1;
  for (const [k, p] of Object.entries(risk.probabilities)) {
    if (p > topLevelP) {
      topLevelP = p;
      topLevelIdx = Number.parseInt(k, 10) || 0;
    }
  }

  return {
    persona: persona.id,
    label: persona.label,
    lens: persona.lens,
    ok: topChoice !== null,
    error: topChoice === null ? `unknown choice key "${choice.choice}"` : undefined,
    topChoice,
    distribution,
    confidence: choice.confidence,
    risk: { score: risk.score, level: persona.riskLevels[topLevelIdx] ?? persona.riskLevels[0] ?? "", confidence: risk.confidence },
  };
}

/** Runs the Jev round. Never throws: on any failure (no key, network, timeout, bad
 *  shape) every persona comes back ok:false and `source` is "keyword". */
export async function runCouncilJevRound(
  request: CouncilRequest,
  options: CouncilJevOptions = {},
): Promise<{ personas: CouncilPersonaResult[]; source: "jev" | "keyword" }> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { personas: keywordCouncilPersonas("Jev unavailable (no API key)"), source: "keyword" };

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const body = buildCouncilJevBody(request);

  try {
    const raw = await callJev(apiKey, body, fetchImpl, timeoutMs);
    if (typeof raw !== "object" || raw === null) throw new Error("typesafe response not an object");
    const answers = (raw as Record<string, unknown>).answers;
    if (typeof answers !== "object" || answers === null) throw new Error("typesafe response missing answers");
    const personas = COUNCIL_PERSONAS.map((p) => personaFromAnswers(p, request, answers as Record<string, unknown>));
    return { personas, source: "jev" };
  } catch {
    return { personas: keywordCouncilPersonas("typesafe call failed, no live signal this round"), source: "keyword" };
  }
}

/** Aggregates the persona round in code: the majority option, the split (option ->
 *  count of personas that picked it), agreement (majority share among personas that
 *  answered), and which answering persona was least sure of itself. */
export function aggregateCouncil(personas: readonly CouncilPersonaResult[]): CouncilAggregate {
  const answering = personas.filter((p) => p.ok && p.topChoice !== null);
  if (answering.length === 0) return { agreement: 0, split: {}, lowestConfidencePersona: null };

  const split: Record<string, number> = {};
  for (const p of answering) split[p.topChoice!] = (split[p.topChoice!] ?? 0) + 1;

  let majorityOption = answering[0]!.topChoice!;
  let majorityCount = 0;
  for (const [opt, count] of Object.entries(split)) {
    if (count > majorityCount) {
      majorityCount = count;
      majorityOption = opt;
    }
  }

  let lowest: CouncilPersonaResult | null = null;
  for (const p of answering) {
    const combined = p.risk ? Math.min(p.confidence, p.risk.confidence) : p.confidence;
    const lowestCombined = lowest ? Math.min(lowest.confidence, lowest.risk?.confidence ?? lowest.confidence) : Infinity;
    if (combined < lowestCombined) lowest = p;
  }

  return { agreement: majorityCount / answering.length, split, lowestConfidencePersona: lowest?.persona ?? null };
}
