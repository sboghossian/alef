// Pure helpers for the "council" panel: no DOM, so plain vitest can exercise them.
// council.ts (the ClientFeature) wires these into the actual panel markup.

import type { CouncilPersonaResult, CouncilResult } from "../../../shared/features/council";
import type { AgentActivity, WorldAgent } from "../../../shared/types";

const MAX_CONTEXT_CHARS = 2000;
const DEFAULT_MAX_ACTIVITIES = 3;

/** Builds the one-line "what is this agent doing" context string prefilled into the
 *  council form from the agent details panel's quick action. Pure and DOM-free so the
 *  quick-action's copy can be tested without booting the panel. */
export function buildAgentContextSummary(
  agent: Pick<WorldAgent, "title" | "islandId" | "status"> | undefined,
  activities: readonly Pick<AgentActivity, "agentId" | "summary">[],
  agentId: string,
  maxActivities = DEFAULT_MAX_ACTIVITIES,
): string {
  if (!agent) return "";
  const recent = activities
    .filter((a) => a.agentId === agentId && a.summary.length > 0)
    .slice(-maxActivities)
    .reverse()
    .map((a) => a.summary);
  const parts = [`Agent: "${agent.title}"`, `Project: ${agent.islandId}`, `Status: ${agent.status}`];
  if (recent.length > 0) parts.push(`Recent activity: ${recent.join("; ")}`);
  return parts.join(" · ").slice(0, MAX_CONTEXT_CHARS);
}

/** Rounded percentage for a bar/label; clamps to [0, 100]. */
export function pct(probability: number): number {
  return Math.max(0, Math.min(100, Math.round(probability * 100)));
}

/** True when a persona's Choice/Score answers came back (ok:true, so it has real data to plot). */
export function personaAnswered(p: CouncilPersonaResult): boolean {
  return p.ok && p.topChoice !== null && p.risk !== null;
}

/** One line summarizing the split, e.g. "3/4 agree on \"Ship now\"" or "no live signal this round". */
export function agreementSummary(result: Pick<CouncilResult, "aggregate" | "personas">): string {
  const answering = result.personas.filter((p) => p.ok).length;
  if (answering === 0) return "no live signal this round";
  const majority = Object.entries(result.aggregate.split).sort((a, b) => b[1] - a[1])[0];
  if (!majority) return "no live signal this round";
  return `${majority[1]}/${answering} agree on "${majority[0]}"`;
}
