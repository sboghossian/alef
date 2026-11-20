// POST /api/quick-prompts/today — backs the "What happened today?" chip. Builds a
// short, deterministic digest from real agent data (no free-text generation: Jev, if
// available, only CHOOSES among today's already-real agents via the same TypeSafe
// Choice mechanism as /api/ask-jev; otherwise a deterministic rules ranking).

import type { TodayAgent, TodayDigestResult } from "../../shared/features/quick-prompts.js";
import type { WorldAgent } from "../../shared/types.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type FetchLike } from "../director.js";
import { respondJson } from "../http.js";
import { log } from "../log.js";
import type { ServerFeature } from "./registry.js";

const MAX_CANDIDATES = 15; // bounds the TypeSafe call's token size
const MAX_AGENTS = 5;

function localMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/** Today's agents, most-recently-active first. */
export function agentsActiveToday(agents: readonly WorldAgent[], now: Date): WorldAgent[] {
  const startMs = localMidnight(now).getTime();
  return agents.filter((a) => new Date(a.lastActive).getTime() >= startMs).sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

/** One deterministic line built entirely from real counts — never a generated claim. */
export function buildSummary(today: readonly WorldAgent[]): string {
  if (!today.length) return "No agent activity today yet.";
  const cities = new Set(today.map((a) => a.islandId));
  return `${today.length} ${today.length === 1 ? "agent" : "agents"} worked across ${cities.size} ${cities.size === 1 ? "city" : "cities"} today.`;
}

function reasonFor(a: WorldAgent): string {
  return `${a.islandId} · ${a.messageCount} messages`;
}

/** Deterministic fallback: most messages first (a cheap proxy for "did the most"), ties by recency. */
export function rulesRank(candidates: readonly WorldAgent[]): TodayAgent[] {
  return [...candidates]
    .sort((a, b) => (b.messageCount !== a.messageCount ? b.messageCount - a.messageCount : a.lastActive < b.lastActive ? 1 : -1))
    .slice(0, MAX_AGENTS)
    .map((a) => ({ agentId: a.id, reason: reasonFor(a) }));
}

async function chooseWithJev(
  candidates: readonly WorldAgent[],
  apiKey: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<TodayAgent[] | null> {
  const criteria: Record<string, string> = {};
  for (const a of candidates) criteria[a.id] = `${a.islandId} · ${a.title} · ${a.messageCount} messages`;
  const body = {
    model: "jev-latest",
    state: { candidates: candidates.map((a) => ({ id: a.id, island: a.islandId, title: a.title, messages: a.messageCount })) },
    questions: {
      today: {
        type: "choice",
        instructions:
          "candidates (see state) are Claude Code sessions active today. Which one did the most notable work? " +
          "(the probabilities you return over ALL candidates double as a relevance ranking — that's what we use.)",
        criteria,
      },
    },
  };
  try {
    const raw = await callJev(apiKey, body, fetchImpl, timeoutMs);
    if (typeof raw !== "object" || raw === null) throw new Error("typesafe response not an object");
    const answers = (raw as Record<string, unknown>).answers;
    if (typeof answers !== "object" || answers === null) throw new Error("typesafe response missing answers");
    const today = (answers as Record<string, unknown>).today;
    if (!isChoiceAnswer(today)) throw new Error('typesafe response missing/invalid answer for "today"');
    const ranked = Object.entries(today.probabilities).sort((a, b) => b[1] - a[1]).slice(0, MAX_AGENTS);
    return ranked.map(([agentId]) => {
      const a = candidates.find((c) => c.id === agentId);
      return { agentId, reason: a ? reasonFor(a) : "" };
    });
  } catch (err) {
    log.warn("quick-prompts", "typesafe call failed, falling back to rules", String(err));
    return null;
  }
}

export const quickPromptsFeature: ServerFeature = {
  id: "quick-prompts",
  routes: [
    {
      method: "POST",
      path: "/api/quick-prompts/today",
      async handler(_req, res, ctx) {
        const { agents } = ctx.worldViews();
        const today = agentsActiveToday(agents, new Date());
        const summary = buildSummary(today);
        if (!today.length) {
          respondJson(res, 200, { ok: true, summary, agents: [], source: "rules" } satisfies TodayDigestResult);
          return;
        }
        const candidates = today.slice(0, MAX_CANDIDATES);
        const apiKey = ctx.config.typesafeApiKey ?? process.env.TYPESAFE_API_KEY;
        const fetchImpl = (ctx.config.typesafeFetchImpl ?? (globalThis.fetch as FetchLike)) as FetchLike;
        if (apiKey) {
          const chosen = await chooseWithJev(candidates, apiKey, fetchImpl, TIMEOUT_MS);
          if (chosen) {
            respondJson(res, 200, { ok: true, summary, agents: chosen, source: "jev" } satisfies TodayDigestResult);
            return;
          }
        }
        respondJson(res, 200, { ok: true, summary, agents: rulesRank(candidates), source: "rules" } satisfies TodayDigestResult);
      },
    },
  ],
};
