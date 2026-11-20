// Contract between server (indexer + director) and client (renderer).
// Server owns truth and targets; client only animates toward them.

export type AgentStatus = "live" | "dormant";
export type ObjectKind = "repo" | "file" | "skill" | "hook" | "mcp";
export type EdgeKind = "touched" | "visited" | "uses";
export type DecisionKind = "pair" | "roam" | "grow";

/** One island per project directory (a cwd agents ran in). "harness" is the reserved island for skills/hooks/MCPs. */
export interface Island {
  id: string; // stable slug, e.g. "acme-ai-next"; "harness" is reserved
  name: string;
  path: string; // absolute cwd; "" for harness
  agentCount: number;
  lastActive: string; // ISO
}

/** One agent = one Claude Code session (a .jsonl file). */
export interface WorldAgent {
  id: string; // session uuid
  islandId: string; // home island
  cwd: string;
  title: string; // first user prompt, trimmed to 80 chars. Classification input (topics, automationKey, autonomy): never replaced by displayName
  /** Claude Code's own name for the session: the user's /rename (custom-title), else its AI title
   *  (ai-title), sanitized server-side. Null/absent when it has neither: show displayTitle(title).
   *  Render through agentTitle() in shared/display.ts. */
  displayName?: string | null;
  status: AgentStatus;
  startedAt: string; // ISO
  lastActive: string; // ISO
  messageCount: number;
  model: string | null;
  role: string; // derived: "builder" | "writer" | "researcher" | "ops" | "generalist"
  color: string; // hex, derived from role
  targetIslandId: string; // where it is heading now (home unless it is live and touching files in another district)
  tokens: number; // input + output tokens summed from the session's usage records
  awaitingInput: boolean; // live AND last turn ended waiting on the user (AskUserQuestion pending, or final assistant text ends with "?")
}

export interface WorldObject {
  id: string; // e.g. "file:/abs/path", "repo:/abs/path", "skill:humanizer", "hook:PreToolUse:plan-gate", "mcp:linear"
  kind: ObjectKind;
  name: string;
  islandId: string; // files/repos → their island; skill/hook/mcp → "harness"
  usage: number; // count of sessions that touched/used it
  growth: number; // 0..1, building/crystal size; director may raise it
}

export interface WorldEdge {
  from: string; // agent id
  to: string; // object id, or island id for "visited" (a district the session's touched files prove it worked in)
  kind: EdgeKind;
  weight: number;
  at: string; // ISO of latest occurrence
}

export interface JevDecision {
  id: string;
  at: string; // ISO
  kind: DecisionKind;
  subjects: string[]; // agent ids / object ids the decision is about
  choice: string; // chosen option key
  probabilities: Record<string, number>;
  confidence: number; // 0..1 (1 for rules)
  source: "jev" | "rules";
  summary: string; // one human line, e.g. "acme-ai-next agent visits acme-leadgen"
}

export interface JevState {
  status: "online" | "fallback" | "disabled"; // disabled = no TYPESAFE_API_KEY
  lastTickAt: string | null;
  decisions: JevDecision[]; // newest first, max 50
}

/** What a live agent is doing right now, derived from new jsonl lines as they are appended.
 *  stage mapping (documented heuristic): new user prompt → "hook"; Read/Grep of memory/vault paths → "brain";
 *  TodoWrite/EnterPlanMode/ExitPlanMode/Skill → "plan"; assistant text/thinking → "reason"; any other tool_use → "tool". */
export type ActivityStage = "hook" | "brain" | "plan" | "reason" | "tool";

export interface AgentActivity {
  id: string;
  agentId: string;
  at: string; // ISO, from the jsonl line
  stage: ActivityStage;
  toolName: string | null; // e.g. "Edit", "Skill", "mcp__linear__save_issue"
  targetObjectId: string | null; // object the call hit, if it is in the world: "skill:x", "mcp:linear", "file:/abs"
  summary: string; // one short human line, sanitized (no secrets, ≤80 chars)
}

export interface WorldStats {
  liveCount: number;
  awaitingCount: number;
  tokensToday: number; // sum of usage tokens on jsonl lines timestamped since local midnight
}

export interface WorldSnapshot {
  generatedAt: string;
  stats: WorldStats;
  islands: Island[];
  agents: WorldAgent[];
  objects: WorldObject[]; // capped: top 30 files per island by usage; all skills/hooks/mcps
  edges: WorldEdge[]; // capped to edges whose endpoints are in the snapshot
  jev: JevState;
  /** Feature data from server/features/*: snapshotExtras(), merged. Absent when no feature contributes.
   *  Keys are prefixed with the feature id; the value types live in shared/features/<id>.ts. */
  extras?: Record<string, unknown>;
}

/** Server → client over WS at /ws. The first message is a "snapshot", except when the client opened
 *  `/ws?have=<generatedAt>` with the generatedAt of the GET /api/world it just loaded: if the server
 *  still remembers that snapshot (≤30 s) and only rows and stats changed since, it sends just those
 *  (agents / agentsRemoved / objects / objectsRemoved / edges, then stats) instead. A reconnect never
 *  says `have`, so it always gets a full snapshot.
 *  After that the world rows travel as deltas against what every client was last sent: only rows
 *  that changed, ids that left, and the edge set only when it changed. Nothing is sent when nothing
 *  changed (server/world-delta.ts). */
export type ServerMessage =
  | { type: "snapshot"; world: WorldSnapshot }
  | { type: "agents"; agents: WorldAgent[] } // upserts: only the agents that changed
  | { type: "objects"; objects: WorldObject[] } // upserts: only the objects that changed
  | { type: "objectsRemoved"; ids: string[] } // objects no longer served (e.g. a file dropped out of its island's top 30)
  | { type: "edges"; edges: WorldEdge[] } // the FULL served edge set, sent only when it changed: replaces, never appends
  | { type: "decision"; decision: JevDecision; jevStatus: JevState["status"] }
  | { type: "activity"; activities: AgentActivity[] } // new since last push, oldest first, ≤50 per message
  | { type: "stats"; stats: WorldStats }
  | { type: "agentsRemoved"; ids: string[] } // sessions no longer served (retired: gone from the index and the world)
  /** Generic envelope for feature plugins (ctx.emit on the server, onMessage on the client).
   *  `payload` is typed per feature in shared/features/<feature>.ts; validate it before use. */
  | { type: "feature"; feature: string; payload: unknown };

/** HTTP API (server on :5179, proxied by Vite from :5178):
 *  GET  /api/world                → WorldSnapshot (gzip when the client accepts it, as every JSON answer ≥32 KB)
 *  POST /api/reactivate/:agentId  → ReactivateResult  (claude --resume <id> in a world tmux session + Terminal attached;
 *                                    a plain Terminal only when tmux is missing; 409 when the session is already running)
 *  GET  /api/health               → { ok: true, indexedSessions: number }
 *  POST /api/dispatch             body DispatchRequest → DispatchResult (claude "<prompt>" in a world tmux session in the
 *                                    island's cwd + Terminal attached; a plain Terminal only when tmux is missing)
 *  Both are served by the talk feature (server/features/talk.ts), which owns the tmux bindings.
 *  POST /api/ask-jev              body AskJevRequest   → AskJevResult
 *  POST /api/open-editor/:agentId → ReactivateResult (runs `code <cwd>`)
 */
export interface DispatchRequest {
  islandId: string; // must be a known non-harness island
  prompt: string; // 1..4000 chars
}
/** What a launch or resume did, beyond ok/error: where claude runs and what may still stop it.
 *  Shared by /api/dispatch, /api/reactivate, the talk routes and ▶ Launch (loops, president). */
export interface LaunchDetails {
  /** "tmux": claude runs in a world tmux session, so Stop, Talk, Note and the Screen reach it.
   *  "terminal": tmux is missing, so it runs in a plain Terminal window Alef can't reach. */
  mode?: "tmux" | "terminal";
  /** The world tmux session ("aw-…"), when mode is "tmux". */
  tmuxName?: string;
  /** It runs, but something around it failed (e.g. Terminal couldn't be opened on it). */
  warning?: string;
  /** A startup dialog its pane showed within a few seconds of the launch: nothing runs until it is answered. */
  waitingOn?: "trust" | "chrome";
  /** A repeat of the same launch within the idempotency window: nothing new was started. */
  reused?: boolean;
  /** Resume only: an existing tmux session was attached instead of starting another claude. */
  attached?: boolean;
}

export interface DispatchResult extends LaunchDetails {
  ok: boolean;
  islandId: string;
  cwd?: string;
  error?: string;
}

export interface AskJevRequest {
  question: string; // 1..500 chars, e.g. "who worked on the Jessica email?"
}
export interface AskJevMatch {
  agentId: string;
  probability: number;
}
export interface AskJevResult {
  ok: boolean;
  matches: AskJevMatch[]; // best first, ≤3; empty if Jev chose "none"
  confidence: number;
  source: "jev" | "keyword"; // keyword = Jev unavailable, prefilter ranking only
  error?: string;
}
export interface ReactivateResult extends LaunchDetails {
  ok: boolean;
  agentId: string;
  error?: string;
}
