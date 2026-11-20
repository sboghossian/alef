// The station catalog (Round 9 mission control): one visual identity per "tool station" —
// {label, emoji, color, description} — shared by the Feed's chips, the Canvas's tool nodes and
// Harness City's buildings, so the same kind of call reads the same everywhere. `stationOf`
// classifies every raw tool name the indexer/activity code produces (see server/jsonl-events.ts,
// server/activity.ts and client/src/features/orbit-lib.ts's TOOL_GROUPS, which this mirrors at a
// coarser, 10-station grain). `stationForObjectKind` does the same for the Harness WorldObjects
// (skill/hook/mcp) that become buildings. `mcpTint` gives each individual MCP server a stable
// colour of its own, independent of the 9 station hues, for when "MCP" alone isn't specific enough.
//
// Colours: 9 chromatic hues spaced 20-44° apart around the wheel (HSL, tuned per-hue for WCAG
// contrast >= 3:1 against the app's cream background #fffdf6 — see stations.test.ts), plus a
// neutral grey for "other" that competes with none of them. Distinct hues at different lightness
// (not just saturation) is the approach Okabe & Ito's widely-cited 2008 colour-blind-safe palette
// uses; this set isn't run through an actual CVD simulator, so treat "colour-blind-safe" here as a
// careful, checked-by-formula design choice, not a verified guarantee.

import type { ObjectKind } from "./types";

export type StationId = "bash" | "edit" | "read" | "web" | "mcp" | "skill" | "hook" | "subagent" | "plan" | "other";

export interface Station {
  id: StationId;
  label: string;
  emoji: string;
  /** "#rrggbb", readable on the app's cream background (contrast >= 3:1, see stations.test.ts). */
  color: string;
  description: string;
}

export const STATION_ORDER: readonly StationId[] = ["bash", "edit", "read", "web", "mcp", "skill", "hook", "subagent", "plan", "other"];

export const STATIONS: Record<StationId, Station> = {
  bash: { id: "bash", label: "Bash", emoji: "💻", color: "#0F6CB3", description: "Runs a shell command (Bash, BashOutput, KillShell)." },
  edit: { id: "edit", label: "Edit", emoji: "✏️", color: "#C33C13", description: "Writes or edits a file (Edit, Write, MultiEdit, NotebookEdit)." },
  read: { id: "read", label: "Read", emoji: "🔎", color: "#0F8A51", description: "Reads or searches files (Read, Grep, Glob)." },
  web: { id: "web", label: "Web", emoji: "🌐", color: "#0B818E", description: "Fetches or searches the web (WebFetch, WebSearch, a browser tool)." },
  mcp: { id: "mcp", label: "MCP", emoji: "🔌", color: "#8E30A6", description: "Calls an MCP server tool (mcp__<server>__…); each server gets its own tint too." },
  skill: { id: "skill", label: "Skill", emoji: "🧩", color: "#AE7209", description: "Runs a packaged Skill." },
  hook: { id: "hook", label: "Hook", emoji: "🪝", color: "#422FBC", description: "A settings.json hook firing, or a new prompt reaching the agent." },
  subagent: { id: "subagent", label: "Subagent", emoji: "🛸", color: "#BB1B66", description: "Spawns or talks to another agent (Agent/Task, SendMessage, Monitor, Workflow)." },
  plan: { id: "plan", label: "Plan", emoji: "📋", color: "#778613", description: "Plans or tracks todos (TodoWrite, plan mode, task lists)." },
  other: { id: "other", label: "Other", emoji: "🔹", color: "#4D4D4D", description: "Everything else: reasoning, AskUserQuestion, ToolSearch, worktrees." },
};

export function station(id: StationId): Station {
  return STATIONS[id];
}

export function allStations(): readonly Station[] {
  return STATION_ORDER.map((id) => STATIONS[id]);
}

const BASH_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
// "Task" alone (the Agent tool's old name) is a subagent spawn; the *TaskXxx* family (TaskCreate,
// TaskUpdate, …) is a todo/task-list tool grouped with TodoWrite — same split client/src/features/
// orbit-lib.ts's TOOL_GROUPS already uses for the Tool Yard buildings.
const SUBAGENT_TOOLS = new Set(["Agent", "Task", "SendMessage", "Monitor", "Workflow"]);
const PLAN_TOOLS = new Set(["TodoWrite", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop"]);

/** Classifies one raw tool_use name (AgentActivity.toolName) into a station. `mcp__<server>__*`
 *  always wins (checked first); everything unrecognised — AskUserQuestion, ToolSearch,
 *  EnterWorktree/ExitWorktree, a future tool this table hasn't seen yet — is "other". */
export function stationOf(toolName: string | null | undefined): StationId {
  if (!toolName) return "other";
  if (toolName.startsWith("mcp__")) return "mcp";
  if (BASH_TOOLS.has(toolName)) return "bash";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (READ_TOOLS.has(toolName)) return "read";
  if (WEB_TOOLS.has(toolName) || /browser/i.test(toolName)) return "web";
  if (toolName === "Skill") return "skill";
  if (SUBAGENT_TOOLS.has(toolName)) return "subagent";
  if (PLAN_TOOLS.has(toolName)) return "plan";
  return "other";
}

/** For an AgentActivity: prefers the tool name (so a Skill/TodoWrite call gets its own station
 *  even though its ActivityStage is "plan"); falls back to the stage only when there is no tool
 *  name at all — the "hook" stage (a new prompt, or the PermissionRequest hook) and "reason"
 *  (assistant thinking/text between tool calls, which has no station of its own). */
export function stationOfActivity(a: { stage: string; toolName: string | null }): StationId {
  if (a.toolName) return stationOf(a.toolName);
  return a.stage === "hook" ? "hook" : "other";
}

/** skill/hook/mcp WorldObjects (Harness City's shops/arches/antennas) map straight onto their
 *  matching station; file/repo objects have no station of their own. */
export function stationForObjectKind(kind: ObjectKind): StationId {
  if (kind === "skill") return "skill";
  if (kind === "hook") return "hook";
  if (kind === "mcp") return "mcp";
  return "other";
}

/** mcp__<server>__<tool> → "<server>", or null if `toolName` isn't an MCP tool call. */
export function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const idx = rest.indexOf("__");
  const server = idx === -1 ? rest : rest.slice(0, idx);
  return server.length > 0 ? server : null;
}

// ---------------------------------------------------------------- colour helpers

function hashString(s: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** HSL (0-360, 0-100, 0-100) → "#rrggbb". Self-contained: shared/ has no DOM/CSS dependency. */
export function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number): number => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number): string =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Stable per-MCP-server tint (same server name → same colour, everywhere: Feed, Canvas, the
 *  Harness antennas). Hashed independently of the 9 station hues so it's never mistaken for one
 *  of them; same saturation/lightness recipe as the rest of the palette, so it stays readable on
 *  cream. Collisions between two server names landing on a near-identical hue are possible (360
 *  buckets, unbounded server names) — a nice-to-have visual aid, not a uniqueness guarantee. */
export function mcpTint(server: string): string {
  const hue = hashString(server) % 360;
  return hslToHex(hue, 65, 40);
}
