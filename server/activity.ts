// Pure derivation of an AgentActivity draft from one parsed jsonl line. No DB, no
// IO — kept trivial to unit test. The indexer calls this once per NEW line while
// streaming a session file, only when it wants activity collected (never during
// the cold first pass — see runIndexPass's `collectActivity` option).
//
// Stage mapping (mirrors the doc comment on ActivityStage in shared/types.ts):
//   new user prompt                                -> "hook"
//   Read/Grep of memory/vault paths                 -> "brain"
//   TodoWrite/EnterPlanMode/ExitPlanMode/Skill       -> "plan"
//   assistant text/thinking (no tool use)            -> "reason"
//   any other tool_use                               -> "tool"
//
// Bash lines carry their command ("Bash: git commit -m …"): secrets redacted, whitespace
// collapsed, a leading `cd …`/`export …` preamble dropped, capped at 80 chars. That text is what
// the Feed and the lifecycle stations (orbit-lib's Verify / Persist / GitHub push) classify.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ActivityStage } from "../shared/types.js";
import { redactSecrets, sanitizeTitle } from "./heuristics.js";
import { vaultRoot } from "./config.js";
import { filePathFromToolUse, mcpServerFromToolUse, type ParsedLine, type ToolUse } from "./jsonl-events.js";

const PLAN_TOOLS = new Set(["TodoWrite", "EnterPlanMode", "ExitPlanMode"]);

const VAULT_ROOT = vaultRoot();
const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

// "~/.claude/projects/<any>/memory/..." or anywhere under the vault (config.ts vaultRoot()).
export function isMemoryOrVaultPath(absPath: string): boolean {
  if (absPath === VAULT_ROOT || absPath.startsWith(`${VAULT_ROOT}/`)) return true;
  if (absPath.startsWith(`${CLAUDE_PROJECTS_ROOT}/`)) {
    const rel = absPath.slice(CLAUDE_PROJECTS_ROOT.length + 1);
    const parts = rel.split("/");
    if (parts.length >= 2 && parts[1] === "memory") return true;
  }
  return false;
}

function displayPath(cwd: string, absPath: string): string {
  if (absPath === cwd) return ".";
  if (absPath.startsWith(`${cwd}/`)) return absPath.slice(cwd.length + 1);
  return absPath;
}

function mcpToolShortName(name: string): string {
  const rest = name.slice("mcp__".length);
  const idx = rest.indexOf("__");
  return idx === -1 ? rest : rest.slice(idx + 2);
}

const SUMMARY_MAX = 80;

// Command-shaped secrets redactSecrets (opaque tokens only) does not catch. Order matters:
// quoted values before bare ones.
const COMMAND_SECRET_RES: ReadonlyArray<[RegExp, string]> = [
  // Authorization-style headers: -H 'Authorization: …', -H "X-Api-Key: …", Cookie: …
  [/((?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)\s*:\s*)[^'"\n]+/gi, "$1[redacted]"],
  // Bearer / Basic / Token schemes anywhere
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/g, "$1 [redacted]"],
  // --password=…, --token …, --api-key=…, --secret …, --client-secret=…
  [/(--?(?:[a-z0-9]+-)*(?:password|passwd|token|secret|api-?key|access-?key|private-?key|auth|credentials?)(?:-[a-z0-9]+)*(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
  // NAME=value where NAME looks secret: API_KEY=…, GITHUB_TOKEN=…, DB_PASSWORD=…, export AWS_SECRET_ACCESS_KEY=…
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|AUTH|CREDENTIALS?|COOKIE)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]"],
  // user:password@ in URLs
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[redacted]@"],
];

/** Redacts secrets from a shell command (named credentials, auth headers, URL passwords, then
 *  redactSecrets' opaque tokens such as sk-…, ghp_…). */
export function redactCommand(command: string): string {
  let t = command;
  for (const [re, to] of COMMAND_SECRET_RES) t = t.replace(re, to);
  return redactSecrets(t);
}

// A leading `cd dir &&`, `export X=… &&`, `source f;` says nothing about what the command does
// and would push the real verb past the 80-char cut.
const PREAMBLE_RE = /^(?:(?:cd|pushd|export|source|set|unset)\b[^;&|]*|\.\s+\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s*(?:&&|;)\s*/;

/** "Bash: <command>" for an activity line: redacted, one line, preamble dropped, ≤80 chars. */
export function bashSummary(command: unknown): string {
  if (typeof command !== "string") return "Bash";
  let cmd = command.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 8; i++) {
    const m = PREAMBLE_RE.exec(cmd);
    if (!m || m[0].length >= cmd.length) break;
    cmd = cmd.slice(m[0].length);
  }
  cmd = redactCommand(cmd).trim();
  if (!cmd) return "Bash";
  const text = `Bash: ${cmd}`;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}

/** An AgentActivity minus `id`/`agentId`, which the caller (indexer) fills in. */
export interface ActivityDraft {
  at: string;
  stage: ActivityStage;
  toolName: string | null;
  targetObjectId: string | null;
  summary: string;
}

function draftForToolUse(use: ToolUse, cwd: string, at: string): ActivityDraft {
  if (use.name === "Skill") {
    const skill = typeof use.input.skill === "string" ? use.input.skill : "";
    return {
      at,
      stage: "plan",
      toolName: use.name,
      targetObjectId: skill ? `skill:${skill}` : null,
      summary: sanitizeTitle(`Skill ${skill}`),
    };
  }
  if (PLAN_TOOLS.has(use.name)) {
    return { at, stage: "plan", toolName: use.name, targetObjectId: null, summary: sanitizeTitle(use.name) };
  }

  const rawPath = filePathFromToolUse(use);
  if (rawPath) {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const stage: ActivityStage = isMemoryOrVaultPath(abs) ? "brain" : "tool";
    return {
      at,
      stage,
      toolName: use.name,
      targetObjectId: `file:${abs}`,
      summary: sanitizeTitle(`${use.name} ${displayPath(cwd, abs)}`),
    };
  }

  if (use.name.startsWith("mcp__")) {
    const server = mcpServerFromToolUse(use);
    const shortName = mcpToolShortName(use.name);
    return {
      at,
      stage: "tool",
      toolName: use.name,
      targetObjectId: server ? `mcp:${server}` : null,
      summary: sanitizeTitle(`${server ?? "mcp"} · ${shortName}`),
    };
  }

  if (use.name === "Bash") return { at, stage: "tool", toolName: use.name, targetObjectId: null, summary: bashSummary(use.input.command) };
  return { at, stage: "tool", toolName: use.name, targetObjectId: null, summary: sanitizeTitle(use.name) };
}

/** Derives zero or more activity drafts from one already-parsed jsonl line.
 *  `cwd` must already be resolved by the caller (same value used to resolve file edges). */
export function deriveActivity(line: ParsedLine, cwd: string, at: string): ActivityDraft[] {
  if (line.isUserLine) {
    if (!line.isUserText || !line.userText) return [];
    return [{ at, stage: "hook", toolName: null, targetObjectId: null, summary: sanitizeTitle(line.userText) }];
  }
  if (line.isAssistant) {
    if (line.toolUses.length === 0) {
      const summary = line.assistantText ? sanitizeTitle(line.assistantText) : "thinking…";
      return [{ at, stage: "reason", toolName: null, targetObjectId: null, summary }];
    }
    return line.toolUses.map((use) => draftForToolUse(use, cwd, at));
  }
  return [];
}
