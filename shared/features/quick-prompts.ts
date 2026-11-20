// Types for the "quick-prompts" feature: chips above the dispatch bar + matching
// palette commands. Most chips are pure client-side (focus a panel, focus the
// dispatch bar); "What happened today?" needs a server-built digest so Jev only ever
// CHOOSES among real, already-summarized agents instead of generating free text.

export interface TodayDigestRequest {
  /** Reserved for future filtering; empty body today. */
  scope?: "today";
}

export interface TodayAgent {
  agentId: string;
  reason: string; // short, deterministic: e.g. "acme-ai-next · 12 messages"
}

export interface TodayDigestResult {
  ok: boolean;
  /** One deterministic line built from real counts, e.g. "3 agents worked across 2 cities today." */
  summary: string;
  agents: TodayAgent[]; // best first, <=5, chosen by Jev when available, else most recent
  source: "jev" | "rules";
  error?: string;
}
