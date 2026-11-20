// Wire types for the "subagents" feature (round 5 G1a): the subagents a session spawned
// with the `Agent` tool (or a Workflow), indexed from
//   ~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl
//   ~/.claude/projects/<project>/<sessionId>/subagents/workflows/<wfId>/agent-<agentId>.jsonl
// plus the sibling agent-<agentId>.meta.json ({agentType, description, toolUseId}) and the
// parent's tool_result / <task-notification> lines. Subagents are child records of a
// session, never top-level WorldAgents.
//
// HTTP:
//   GET /api/subagents                 → SubagentsResponse (all, newest first, ≤2000)
//   GET /api/subagents?parent=<id>     → SubagentsResponse (children + grandchildren of one session)

import type { ActivityStage } from "../types";

/** running = transcript written in the last 120s, or stopped mid-turn (a tool call or the model's
 *  reply still pending) less than 30 min ago (2 h on an unanswered prompt). done / failed / stopped
 *  come from the parent's tool_result or task-notification, else from how the transcript ends
 *  (server/features/subagents/fold.ts). failed = an API error, the parent's "failed", an interrupt
 *  nothing in the parent explains, or cut off mid-turn and silent past that bound. stopped = stopped
 *  / killed by its parent (a report, or a TaskStop within 1s of its interrupt), or interrupted
 *  within 1s of its parent's user interrupt. async_launched = launched in the background, never
 *  reported back, and cut off mid-turn. */
export type SubagentStatus = "running" | "done" | "failed" | "stopped" | "async_launched";

export interface SubagentFile {
  path: string; // absolute
  count: number; // tool calls that hit it
}

export interface SubagentRecord {
  id: string; // agentId, e.g. "abdff689abcb84b78"
  parentSessionId: string; // the session whose directory holds the transcript
  /** Set when another subagent spawned this one (its Agent tool_use id matches our meta toolUseId). */
  parentAgentId: string | null;
  workflowId: string | null; // "wf_…" for workflow agents
  description: string; // sanitized, ≤80 chars
  agentType: string | null; // "general-purpose", "senior-software-engineer", "workflow-subagent", …
  model: string | null; // model id actually reported on its assistant turns
  status: SubagentStatus;
  /** Why it failed or stopped, one sanitized line ("API Error: Request timed out", "cut off: a tool
   *  call never returned", "interrupted (cause unknown)", "stopped by its parent session"); null
   *  when it ran or ended normally. */
  reason: string | null;
  startedAt: string; // ISO
  lastActive: string; // ISO (transcript mtime)
  tokens: number; // input + output + cache_creation, deduped per message id
  toolCounts: Record<string, number>; // tool name → calls
  files: SubagentFile[]; // top 8 by count
  depth: number; // 1 = spawned by the session itself
}

export interface SubagentStats {
  total: number;
  today: number; // lastActive since local midnight
  live: number;
  parents: number; // distinct parent sessions
  deepest: number; // max depth
  /** Wall time of the first (cold) subagent pass after boot; null until it finished. */
  coldPassMs: number | null;
}

export interface SubagentsResponse {
  subagents: SubagentRecord[];
  stats: SubagentStats;
}

/** Snapshot extras keys. `recent` = subagents active in the last 7 days (≤500). */
export const SUBAGENTS_RECENT_KEY = "subagents.recent";
export const SUBAGENTS_STATS_KEY = "subagents.stats";
export const RECENT_WINDOW_MS = 7 * 86_400_000;

/** One activity line from a subagent transcript (same stage mapping as AgentActivity). */
export interface SubagentActivity {
  id: string;
  subagentId: string;
  parentSessionId: string;
  at: string;
  stage: ActivityStage;
  toolName: string | null;
  targetObjectId: string | null;
  summary: string;
}

/** A top-level session whose transcript did not end normally (its last turn is an API error, an
 *  interrupt: the user's in an interactive session, of unknown cause (failed) in a headless one, or
 *  was cut off mid-turn and silent 30+ min, 2 h on an unanswered prompt). Computed for every session
 *  transcript on disk, from deterministic markers only; the client decides which are automated. */
export interface RunEnding {
  sessionId: string;
  status: "failed" | "stopped";
  reason: string; // one sanitized line, same wording as SubagentRecord.reason
  at: string; // ISO (transcript mtime: when it went silent)
  /** The transcript says `entrypoint: "sdk-cli"`: a headless `claude -p` / Agent SDK run. */
  headless: boolean;
}

/** Snapshot extras key for the RunEnding list. */
export const SUBAGENTS_RUNS_KEY = "subagents.runs";

export type SubagentsMessage =
  | { kind: "upsert"; subagents: SubagentRecord[]; stats: SubagentStats }
  | { kind: "activity"; items: SubagentActivity[] }
  | { kind: "runs"; endings: RunEnding[] };

export interface SpawnedEdge {
  from: string; // parent session id, or "subagent:<id>" for a nested spawn
  to: string; // "subagent:<id>"
  kind: "spawned";
  at: string;
}

export const SUBAGENT_NODE_PREFIX = "subagent:";

export function subagentNodeId(id: string): string {
  return `${SUBAGENT_NODE_PREFIX}${id}`;
}

export function spawnedEdges(list: readonly SubagentRecord[]): SpawnedEdge[] {
  return list.map((s) => ({
    from: s.parentAgentId ? subagentNodeId(s.parentAgentId) : s.parentSessionId,
    to: subagentNodeId(s.id),
    kind: "spawned" as const,
    at: s.startedAt,
  }));
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "stopped", "async_launched"]);
const STAGES: ReadonlySet<string> = new Set(["hook", "brain", "plan", "reason", "tool"]);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Validates one record off the wire (client side). */
export function parseSubagentRecord(v: unknown): SubagentRecord | null {
  if (!isRec(v)) return null;
  if (typeof v.id !== "string" || typeof v.parentSessionId !== "string" || typeof v.description !== "string") return null;
  if (!strOrNull(v.parentAgentId) || !strOrNull(v.workflowId) || !strOrNull(v.agentType) || !strOrNull(v.model)) return null;
  if (typeof v.status !== "string" || !STATUSES.has(v.status)) return null;
  if (typeof v.startedAt !== "string" || typeof v.lastActive !== "string") return null;
  if (typeof v.tokens !== "number" || typeof v.depth !== "number" || !isRec(v.toolCounts) || !Array.isArray(v.files)) return null;
  const toolCounts: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.toolCounts)) if (typeof n === "number") toolCounts[k] = n;
  const files: SubagentFile[] = [];
  for (const f of v.files) if (isRec(f) && typeof f.path === "string" && typeof f.count === "number") files.push({ path: f.path, count: f.count });
  return {
    id: v.id,
    parentSessionId: v.parentSessionId,
    parentAgentId: v.parentAgentId,
    workflowId: v.workflowId,
    description: v.description,
    agentType: v.agentType,
    model: v.model,
    status: v.status as SubagentStatus,
    reason: typeof v.reason === "string" ? v.reason : null, // absent from an older server
    startedAt: v.startedAt,
    lastActive: v.lastActive,
    tokens: v.tokens,
    toolCounts,
    files,
    depth: v.depth,
  };
}

export function parseSubagentList(v: unknown): SubagentRecord[] {
  return Array.isArray(v) ? v.map(parseSubagentRecord).filter((r): r is SubagentRecord => r !== null) : [];
}

/** Validates the RunEnding list off the wire (client side); malformed entries are dropped. */
export function parseRunEndings(v: unknown): RunEnding[] {
  if (!Array.isArray(v)) return [];
  const out: RunEnding[] = [];
  for (const e of v) {
    if (!isRec(e) || typeof e.sessionId !== "string" || (e.status !== "failed" && e.status !== "stopped")) continue;
    if (typeof e.reason !== "string" || typeof e.at !== "string" || typeof e.headless !== "boolean") continue;
    out.push({ sessionId: e.sessionId, status: e.status, reason: e.reason, at: e.at, headless: e.headless });
  }
  return out;
}

export function parseSubagentStats(v: unknown): SubagentStats | null {
  if (!isRec(v)) return null;
  const n = (k: string): number => (typeof v[k] === "number" ? (v[k] as number) : 0);
  return {
    total: n("total"),
    today: n("today"),
    live: n("live"),
    parents: n("parents"),
    deepest: n("deepest"),
    coldPassMs: typeof v.coldPassMs === "number" ? v.coldPassMs : null,
  };
}

export function parseSubagentActivity(v: unknown): SubagentActivity | null {
  if (!isRec(v)) return null;
  if (typeof v.id !== "string" || typeof v.subagentId !== "string" || typeof v.parentSessionId !== "string") return null;
  if (typeof v.at !== "string" || typeof v.stage !== "string" || !STAGES.has(v.stage) || typeof v.summary !== "string") return null;
  if (!strOrNull(v.toolName) || !strOrNull(v.targetObjectId)) return null;
  return {
    id: v.id,
    subagentId: v.subagentId,
    parentSessionId: v.parentSessionId,
    at: v.at,
    stage: v.stage as ActivityStage,
    toolName: v.toolName,
    targetObjectId: v.targetObjectId,
    summary: v.summary,
  };
}
