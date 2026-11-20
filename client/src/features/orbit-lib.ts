// Pure, DOM/THREE-free logic for the orbit features (filters, lifecycle stages, tool yard).
// Everything here is unit-tested in orbit-lib.test.ts.

import type { ActivityStage, WorldAgent } from "../../../shared/types";

// ---------------------------------------------------------------- filters

export type StateFilter = "all" | "live" | "waiting" | "today" | "dormant";
export const STATE_FILTERS: readonly StateFilter[] = ["all", "live", "waiting", "today", "dormant"];

export type KindKey = "drones" | "files" | "harness" | "factories" | "planes" | "weather" | "system";
export const KIND_KEYS: readonly KindKey[] = ["drones", "files", "harness", "factories", "planes", "weather", "system"];
export const KIND_LABELS: Record<KindKey, string> = {
  drones: "Subagent drones",
  files: "Files",
  harness: "Harness buildings",
  factories: "Factories (routines)",
  planes: "Planes",
  weather: "Weather",
  system: "System (ring, machines, tool yard)",
};

export interface OrbitFilterState {
  state: StateFilter;
  /** One district in focus (others fade to 15%), or null for all. */
  district: string | null;
  /** true = shown. */
  kinds: Record<KindKey, boolean>;
}

export function defaultFilterState(): OrbitFilterState {
  return { state: "all", district: null, kinds: { drones: true, files: true, harness: true, factories: true, planes: true, weather: true, system: true } };
}

export function isStateFilter(v: unknown): v is StateFilter {
  return typeof v === "string" && (STATE_FILTERS as readonly string[]).includes(v);
}

/** Local midnight for `nowMs`. */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Does an agent pass the state filter? `live` agent-state "permission" also counts as waiting on you. */
export function agentMatchesState(
  filter: StateFilter,
  agent: Pick<WorldAgent, "status" | "awaitingInput" | "lastActive">,
  nowMs: number,
  liveState?: string,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "live":
      return agent.status === "live";
    case "dormant":
      return agent.status === "dormant";
    case "waiting":
      return agent.awaitingInput === true || liveState === "waiting" || liveState === "permission";
    case "today": {
      const t = Date.parse(agent.lastActive);
      return Number.isFinite(t) && t >= startOfLocalDay(nowMs);
    }
  }
}

/** Parses ?filter=, ?district=, ?hide=a,b (debug/screenshot params) onto a state. Unknown values are ignored. */
export function filterStateFromSearch(search: string, base: OrbitFilterState = defaultFilterState()): OrbitFilterState {
  const p = new URLSearchParams(search);
  const next: OrbitFilterState = { state: base.state, district: base.district, kinds: { ...base.kinds } };
  const f = p.get("filter");
  if (isStateFilter(f)) next.state = f;
  const d = p.get("district");
  if (d) next.district = d;
  for (const k of (p.get("hide") ?? "").split(",")) {
    if ((KIND_KEYS as readonly string[]).includes(k)) next.kinds[k as KindKey] = false;
  }
  return next;
}

/** Angular radius (radians) of a focused district's un-washed cap: the city plus its ring road and plaza. */
export function focusCapAngle(cityRadius: number, planetRadius: number): number {
  return (cityRadius + 5) / planetRadius;
}

/** Whether a district's callout label should dim: everything but the focused district washes out
 *  and shrinks. Compares island ids, never rendered label text — two islands can share a display
 *  name (e.g. two catch-all islands both showing as "Vault" before that was tightened, or any two
 *  real projects a user happens to name the same), and text comparison would dim/undim the wrong
 *  one. `islandId` is `undefined` for a callout that never got one wired up; that reads as "not
 *  the focused district" like everything else. */
export function labelShouldDim(islandId: string | undefined, focusDistrict: string | null): boolean {
  return focusDistrict !== null && islandId !== focusDistrict;
}

// ---------------------------------------------------------------- lifecycle ring

export type LifecycleStage = "prompt" | "hook" | "plan" | "reason" | "tools" | "subagents" | "verify" | "persist" | "response";
export const LIFECYCLE: readonly { id: LifecycleStage; label: string; signal: string }[] = [
  { id: "prompt", label: "Prompt", signal: "A new user prompt in a session transcript." },
  { id: "hook", label: "Hook", signal: "Each prompt (UserPromptSubmit hooks run) and each permission request routed to the world." },
  { id: "plan", label: "Plan / Skill", signal: "TodoWrite, plan mode or a Skill call." },
  { id: "reason", label: "Reason", signal: "Assistant thinking or text between tool calls." },
  { id: "tools", label: "Tools", signal: "Any other tool call (Read, Grep, Bash, MCP…)." },
  { id: "subagents", label: "Subagents", signal: "An Agent (Task) tool call." },
  { id: "verify", label: "Verify", signal: "A Bash command running tests, typecheck or lint (test|vitest|jest|pytest|tsc|lint)." },
  { id: "persist", label: "Persist", signal: "Write / Edit / NotebookEdit, or a git commit." },
  { id: "response", label: "Response", signal: "A live agent's turn ends (working → waiting/idle): the final answer." },
];

const VERIFY_RE = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|eslint)\b/i;
const COMMIT_RE = /\bgit\s+(-C\s+\S+\s+)?commit\b/i;
const PUSH_RE = /\bgit\s+(-C\s+\S+\s+)?push\b/i;
const PERSIST_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** Stages a shell command proves: tests/typecheck/lint → verify, git commit → persist. */
export function stagesForCommand(command: string): LifecycleStage[] {
  const out: LifecycleStage[] = [];
  if (VERIFY_RE.test(command)) out.push("verify");
  if (COMMIT_RE.test(command)) out.push("persist");
  return out;
}

export function isGitPush(command: string): boolean {
  return PUSH_RE.test(command);
}

/** Lifecycle stations one activity line lights. `summary` is the server's text; for Bash it is
 *  "Bash: <redacted command, ≤80 chars>". */
export function stagesForActivity(a: { stage: ActivityStage; toolName: string | null; summary: string }): LifecycleStage[] {
  if (a.stage === "hook") return ["prompt", "hook"];
  if (a.stage === "plan") return ["plan"];
  if (a.stage === "reason") return ["reason"];
  const tool = a.toolName ?? "";
  if (SUBAGENT_TOOLS.has(tool)) return ["subagents"];
  const out: LifecycleStage[] = ["tools"];
  if (PERSIST_TOOLS.has(tool)) out.push("persist");
  if (tool === "Bash") {
    const cmd = a.summary.replace(/^Bash:?\s*/, "");
    for (const s of stagesForCommand(cmd)) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** working/permission → waiting/idle = the turn ended with a response. */
export function isTurnEnd(prev: string | undefined, next: string | undefined): boolean {
  return (prev === "working" || prev === "permission") && (next === "waiting" || next === "idle");
}

// ---------------------------------------------------------------- tool yard

/** Built-in Claude Code tools get a building each; Task* tools share one, Agent/Task share one. */
const TOOL_GROUPS: Record<string, string> = {
  Bash: "Bash",
  BashOutput: "Bash",
  KillShell: "Bash",
  Read: "Read",
  Edit: "Edit",
  MultiEdit: "Edit",
  Write: "Write",
  NotebookEdit: "NotebookEdit",
  Grep: "Grep",
  Glob: "Glob",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  Agent: "Agent",
  Task: "Agent",
  TodoWrite: "Todo/Task",
  TaskCreate: "Todo/Task",
  TaskUpdate: "Todo/Task",
  TaskList: "Todo/Task",
  TaskGet: "Todo/Task",
  TaskOutput: "Todo/Task",
  TaskStop: "Todo/Task",
  Skill: "Skill",
  AskUserQuestion: "AskUserQuestion",
  EnterPlanMode: "PlanMode",
  ExitPlanMode: "PlanMode",
  ToolSearch: "ToolSearch",
  Monitor: "Monitor",
  SendMessage: "SendMessage",
  Workflow: "Workflow",
  EnterWorktree: "Worktree",
  ExitWorktree: "Worktree",
};

/** The yard building a tool call belongs to; null for MCP tools (they are antennas) and unknown names. */
export function builtinToolKey(toolName: string | null | undefined): string | null {
  if (!toolName || toolName.startsWith("mcp__")) return null;
  return TOOL_GROUPS[toolName] ?? null;
}

/** Sums raw per-tool counts into yard buildings (drops MCP / unknown). */
export function yardCounts(rows: readonly { name: string; count: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = builtinToolKey(r.name);
    if (!key || !(r.count > 0)) continue;
    out.set(key, (out.get(key) ?? 0) + r.count);
  }
  return out;
}

export interface YardBuilding {
  key: string;
  count: number;
  /** Building height in world units. */
  height: number;
}

/** One building per tool actually used, busiest first; height grows with log(count) so Bash doesn't dwarf the rest. */
export function toolYardBuildings(counts: ReadonlyMap<string, number>, maxBuildings = 18): YardBuilding[] {
  const rows = [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...rows.map(([, c]) => c));
  return rows.slice(0, maxBuildings).map(([key, count]) => ({
    key,
    count,
    height: 0.6 + 2.6 * (Math.log1p(count) / Math.log1p(max)),
  }));
}

/** Local YYYY-MM-DD for the replay API, `daysAgo` days before `nowMs`. */
export function localDate(nowMs: number, daysAgo = 0): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - daysAgo);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export const TOOLYARD_KEY_PREFIX = "alef.toolyard.";

/** The cached tool-yard days (`alef.toolyard.<YYYY-MM-DD>`) dated before `oldestKept`: past days
 *  are cached forever, so without this every day ever opened stays in localStorage. */
export function staleToolyardKeys(keys: Iterable<string>, oldestKept: string): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (!k.startsWith(TOOLYARD_KEY_PREFIX)) continue;
    const date = k.slice(TOOLYARD_KEY_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < oldestKept) out.push(k);
  }
  return out;
}
