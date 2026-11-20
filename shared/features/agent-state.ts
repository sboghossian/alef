// Wire types for the "agent-state" feature (A4): one named state per agent.
//   working    — a tool call is in flight, or the agent wrote a line in the last 60s
//   permission — a PermissionRequest is queued in the world (A2), or a tool call has
//                sat unanswered for >20s while the session is live
//   waiting    — the agent asked you something (awaitingInput)
//   idle       — live but quiet
//   sleeping   — dormant (no live claude process, no recent writes)

export type AgentState = "working" | "permission" | "waiting" | "idle" | "sleeping";

export const AGENT_STATES: readonly AgentState[] = ["working", "permission", "waiting", "idle", "sleeping"];

/** GET /api/agent-state: agentId → state, every agent (not in the snapshot: one row per session). */
export const AGENT_STATES_PATH = "/api/agent-state";
export interface AgentStatesResponse {
  states: Record<string, AgentState>;
}

/** WS payload: states that changed since the last push. */
export interface AgentStateMessage {
  kind: "states";
  states: Record<string, AgentState>;
}

export function isAgentState(v: unknown): v is AgentState {
  return typeof v === "string" && (AGENT_STATES as readonly string[]).includes(v);
}
