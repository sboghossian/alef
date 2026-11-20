// Discovers the fixed "harness" island: skills, hooks and MCP servers
// configured for Claude Code on this machine. READ ONLY — never writes
// anything under ~/.claude or ~/.claude.json.

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "./log.js";

export interface HarnessObject {
  id: string;
  kind: "skill" | "hook" | "mcp";
  name: string;
}

const INTERPRETERS = new Set(["bash", "sh", "zsh", "python3", "python", "node", "npx"]);

/** Best-effort "what script does this hook run" from a raw shell command string. */
export function commandBasename(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let idx = 0;
  while (idx < tokens.length) {
    const bare = (tokens[idx] ?? "").replace(/^["']|["']$/g, "");
    if (INTERPRETERS.has(bare)) {
      idx += 1;
      continue;
    }
    break;
  }
  const target = (tokens[idx] ?? tokens[0] ?? command).replace(/^["']|["']$/g, "");
  return basename(target) || target;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function discoverSkills(claudeDir: string): Promise<HarnessObject[]> {
  const skillsDir = join(claudeDir, "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: HarnessObject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    try {
      await readFile(skillMd, "utf8");
      skills.push({ id: `skill:${entry.name}`, kind: "skill", name: entry.name });
    } catch {
      // not a skill dir (e.g. `_proposed`), skip
    }
  }
  return skills;
}

export async function discoverHooks(settingsPath: string): Promise<HarnessObject[]> {
  const settings = await readJson(settingsPath);
  const hooksConfig = settings?.hooks;
  if (typeof hooksConfig !== "object" || hooksConfig === null) return [];

  const out: HarnessObject[] = [];
  for (const [event, groups] of Object.entries(hooksConfig as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        const command = (h as { command?: unknown } | null)?.command;
        if (typeof command !== "string" || command.length === 0) continue;
        const name = commandBasename(command);
        out.push({ id: `hook:${event}:${name}`, kind: "hook", name: `${event}:${name}` });
      }
    }
  }
  return out;
}

export async function discoverMcpServers(claudeJsonPath: string, settingsPath: string): Promise<HarnessObject[]> {
  const names = new Set<string>();
  for (const path of [claudeJsonPath, settingsPath]) {
    const json = await readJson(path);
    const servers = json?.mcpServers;
    if (typeof servers === "object" && servers !== null) {
      for (const name of Object.keys(servers as Record<string, unknown>)) names.add(name);
    }
  }
  return [...names].map((name) => ({ id: `mcp:${name}`, kind: "mcp" as const, name }));
}

export interface HarnessDirs {
  claudeDir: string; // ~/.claude
  claudeJsonPath: string; // ~/.claude.json
}

export async function discoverHarness(dirs: HarnessDirs): Promise<HarnessObject[]> {
  const settingsPath = join(dirs.claudeDir, "settings.json");
  const [skills, hooks, mcps] = await Promise.all([
    discoverSkills(dirs.claudeDir),
    discoverHooks(settingsPath),
    discoverMcpServers(dirs.claudeJsonPath, settingsPath),
  ]);
  log.info("harness", `discovered ${skills.length} skills, ${hooks.length} hooks, ${mcps.length} mcp servers`);
  return [...skills, ...hooks, ...mcps];
}
