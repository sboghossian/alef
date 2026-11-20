// POST /api/ask-jev: "who worked on X?" — a keyword prefilter over every known
// agent narrows the field to <=40 candidates, then one TypeSafe Choice call (the
// same client/key/timeout as director.ts) picks the best match. User-initiated,
// so unlike the director this isn't on a cadence; index.ts is responsible for
// rejecting concurrent calls with 429 before this ever runs.

import type { AskJevMatch, AskJevRequest, AskJevResult } from "../shared/types.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type ChoiceAnswer, type FetchLike } from "./director.js";
import type { WorldDb } from "./db.js";
import { log } from "./log.js";

const MAX_CANDIDATES = 40;
const MAX_MATCHES = 3;
const NONE_KEY = "none";

export interface AskJevAgentInput {
  id: string;
  islandId: string;
  cwd: string;
  title: string;
  lastActive: string; // ISO
}

export interface AskJevOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

// Real session titles are natural-language prompts, so they are full of function
// words ("on", "the", "who", ...). Without filtering these out of the QUESTION,
// a query like "who worked on the Jessica email?" scores every unrelated prompt
// that happens to contain "on" or "the" right alongside the one that actually
// mentions Jessica, and the real match gets crowded out of the top 40. Confirmed
// against real data: a genuine "Jessica" transcript session ranked outside the
// top 40 candidates until this filter was added.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "had", "has", "have",
  "he", "her", "hers", "him", "his", "how", "i", "in", "is", "it", "its", "me", "my",
  "of", "on", "or", "our", "she", "that", "the", "their", "them", "they", "this", "to",
  "was", "we", "were", "what", "when", "where", "which", "who", "whom", "whose", "why",
  "will", "with", "would", "you", "your",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function queryTokens(question: string): string[] {
  return tokenize(question).filter((t) => !STOPWORDS.has(t));
}

/** Word set, not a raw lowercased string — so a query token has to match a whole word
 *  (e.g. "on" in the query won't match inside "documentation"), not just a substring. */
function wordSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

function fileBasenamesFor(db: WorldDb, agentId: string): string[] {
  const names: string[] = [];
  for (const target of db.targetsOf(agentId)) {
    if (!target.startsWith("file:")) continue;
    const base = target.slice("file:".length).split("/").pop();
    if (base) names.push(base.toLowerCase());
  }
  return names;
}

/** Scores every agent against the question's (stopword-filtered) tokens — a title-word
 *  match counts more than a cwd/island word match, and a touched-file basename match
 *  most of all, since that's the most specific signal — then returns the top `limit`,
 *  ties broken by most-recently-active. */
export function prefilterCandidates(
  db: WorldDb,
  question: string,
  agents: readonly AskJevAgentInput[],
  limit = MAX_CANDIDATES,
): AskJevAgentInput[] {
  const tokens = queryTokens(question);
  const scored = agents.map((agent) => {
    const titleWords = wordSet(agent.title);
    const islandWords = wordSet(agent.islandId);
    const cwdWords = wordSet(agent.cwd);
    const basenameWordSets = fileBasenamesFor(db, agent.id).map(wordSet);
    let score = 0;
    for (const tok of tokens) {
      if (titleWords.has(tok)) score += 3;
      if (islandWords.has(tok)) score += 1;
      if (cwdWords.has(tok)) score += 1;
      for (const bw of basenameWordSets) if (bw.has(tok)) score += 2;
    }
    return { agent, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.agent.lastActive < b.agent.lastActive ? 1 : a.agent.lastActive > b.agent.lastActive ? -1 : 0;
  });
  return scored.slice(0, limit).map((s) => s.agent);
}

function keywordResult(candidates: readonly AskJevAgentInput[]): AskJevResult {
  const matches: AskJevMatch[] = candidates.slice(0, MAX_MATCHES).map((c) => ({ agentId: c.id, probability: 0 }));
  return { ok: true, matches, confidence: 0, source: "keyword" };
}

function extractAskAnswer(raw: unknown): ChoiceAnswer {
  if (typeof raw !== "object" || raw === null) throw new Error("typesafe response not an object");
  const answers = (raw as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) throw new Error("typesafe response missing answers");
  const ask = (answers as Record<string, unknown>).ask;
  if (!isChoiceAnswer(ask)) throw new Error('typesafe response missing/invalid answer for "ask"');
  return ask;
}

export async function runAskJev(
  db: WorldDb,
  agents: readonly AskJevAgentInput[],
  request: AskJevRequest,
  options: AskJevOptions = {},
): Promise<AskJevResult> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const candidates = prefilterCandidates(db, request.question, agents);
  if (candidates.length === 0) return { ok: true, matches: [], confidence: 0, source: "keyword" };
  if (!apiKey) return keywordResult(candidates);

  const criteria: Record<string, string | null> = {};
  for (const c of candidates) criteria[c.id] = `${c.islandId} · ${c.title} · ${c.lastActive.slice(0, 10)}`;
  criteria[NONE_KEY] = "No listed session matches the question";

  const body = {
    model: "jev-latest",
    state: {
      question: request.question,
      candidates: candidates.map((c) => ({ id: c.id, island: c.islandId, title: c.title, lastActive: c.lastActive })),
    },
    questions: {
      ask: {
        type: "choice",
        instructions:
          'question (see state) is what Alex is asking about. candidates (see state) are Claude Code ' +
          'sessions. Which one is he asking about? Choose "none" if no listed session matches.',
        criteria,
      },
    },
  };

  try {
    const raw = await callJev(apiKey, body, fetchImpl, timeoutMs);
    const answer = extractAskAnswer(raw);
    const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0 || ranked[0]![0] === NONE_KEY) {
      return { ok: true, matches: [], confidence: answer.confidence, source: "jev" };
    }
    const matches: AskJevMatch[] = ranked
      .filter(([key]) => key !== NONE_KEY)
      .slice(0, MAX_MATCHES)
      .map(([agentId, probability]) => ({ agentId, probability }));
    return { ok: true, matches, confidence: answer.confidence, source: "jev" };
  } catch (err) {
    log.warn("ask-jev", "typesafe call failed, falling back to keyword ranking", String(err));
    return keywordResult(candidates);
  }
}
