// A4 — one named state per agent (rule adapted from claude-cockpit STEAL_FROM_SUPERSET #1):
//   permission  a PermissionRequest is queued in the world (A2), OR — only while the A2 hook is
//               not installed — a tool call has had no tool_result for >20s while live
//               (long-running tools like Agent are exempt). Once the hook has been seen, its
//               queue is the ground truth and a slow tool call reads as "working", not a prompt.
//   sleeping    dormant
//   waiting     awaitingInput (asked you something)
//   working     a tool call is in flight, or the agent wrote a line in the last 60s
//   idle        live, quiet
// Recomputed every tick; GET /api/agent-state serves them all (not the snapshot: one row per
// session); WS pushes only changes.

import { AGENT_STATES_PATH, type AgentState, type AgentStateMessage, type AgentStatesResponse } from "../../shared/features/agent-state.js";
import type { WorldAgent } from "../../shared/types.js";
import { respondJson } from "../http.js";
import { approvalsHookInstalled, pendingApprovalAgents } from "./approvals.js";
import { cachedAgents, fleetTracker, type FleetTracker, type PendingTool } from "./fleet-tracker.js";
import type { ServerFeature } from "./registry.js";

export const WORKING_WINDOW_MS = 60_000;
export const STUCK_TOOL_MS = 20_000;
/** Tools that legitimately run for minutes without a result: never read as "permission". */
const LONG_RUNNING_TOOLS = new Set(["Agent", "Task", "TaskOutput", "Monitor", "AskUserQuestion"]);

export interface StateInput {
  status: WorldAgent["status"];
  awaitingInput: boolean;
  lastActiveMs: number; // max(agent.lastActive, last jsonl line seen)
  pending: readonly PendingTool[];
  queuedApproval: boolean;
  /** The A2 hook is installed: unanswered tool calls are just slow, never inferred prompts. */
  hookInstalled?: boolean;
}

export function classifyAgent(s: StateInput, nowMs: number): AgentState {
  if (s.queuedApproval) return "permission";
  if (s.status !== "live") return "sleeping";
  if (s.awaitingInput) return "waiting";
  const quietMs = nowMs - s.lastActiveMs;
  const blocking = s.pending.some((p) => !LONG_RUNNING_TOOLS.has(p.name));
  if (blocking && !s.hookInstalled && quietMs > STUCK_TOOL_MS) return "permission";
  if (s.pending.length > 0) return "working";
  if (quietMs < WORKING_WINDOW_MS) return "working";
  return "idle";
}

export function computeStates(
  agents: readonly WorldAgent[],
  tracker: FleetTracker,
  queued: ReadonlySet<string>,
  nowMs: number,
  hookInstalled = false,
): Record<string, AgentState> {
  const out: Record<string, AgentState> = {};
  for (const a of agents) {
    const t = tracker.sessions.get(a.id);
    const lastActive = Date.parse(a.lastActive);
    out[a.id] = classifyAgent(
      {
        status: a.status,
        awaitingInput: a.awaitingInput,
        lastActiveMs: Math.max(Number.isFinite(lastActive) ? lastActive : 0, t?.lastLineMs ?? 0),
        pending: t ? [...t.pending.values()] : [],
        queuedApproval: queued.has(a.id),
        hookInstalled,
      },
      nowMs,
    );
  }
  return out;
}

export function createAgentStateFeature(
  tracker: FleetTracker = fleetTracker,
  queuedAgents: () => ReadonlySet<string> = pendingApprovalAgents,
  hookInstalled: () => boolean = approvalsHookInstalled,
): ServerFeature {
  let states: Record<string, AgentState> = {};
  return {
    id: "agent-state",
    tickIntervalMs: 5_000,
    routes: [
      {
        method: "GET",
        path: AGENT_STATES_PATH,
        handler(_req, res) {
          respondJson(res, 200, { states } satisfies AgentStatesResponse);
        },
      },
    ],
    async onIndexPass(ctx, batch) {
      await tracker.ensureColdScan(ctx.config.projectsDir);
      tracker.ingestBatch(batch);
    },
    async onTick(ctx) {
      await tracker.ensureColdScan(ctx.config.projectsDir);
      const next = computeStates(cachedAgents(ctx), tracker, queuedAgents(), Date.now(), hookInstalled());
      const changed: Record<string, AgentState> = {};
      for (const [id, s] of Object.entries(next)) if (states[id] !== s) changed[id] = s;
      states = next;
      if (Object.keys(changed).length > 0) ctx.emit({ kind: "states", states: changed } satisfies AgentStateMessage);
    },
  };
}

export const agentStateFeature = createAgentStateFeature();
