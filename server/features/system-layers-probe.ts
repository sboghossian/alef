// Extra read-only readers behind the layered System map. Same rules as system-probe.ts: async,
// no spawn, no writes, names/counts/ages only (never a settings value, env or a file body shown).
// system.ts wraps each in its own deadline, so one slow folder only greys its own card.

import Database from "better-sqlite3";
import { access, constants, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ProbeDirs } from "./system-probe.js";
import { countConductCases, countConstitutionLayers, countSince, countWikilinks, skillDescription } from "./system-layers-lib.js";

export interface ConductInfo { cases: number | null; claimLint: boolean; constitution: number | null }
export interface RuntimeInfo { name: string; present: boolean | null; how: string }
export interface FleetApp { name: string; ageMs: number }
export interface JevInfo { router: boolean; cardsToday: number | null; cardsTotal: number | null }
export interface SkillMeta { name: string; description: string; mtimeMs: number }
export interface RecallInfo { chunks: number; mtimeMs: number }
export interface McpMeta { hosted: string[]; local: string[]; plugins: string[] }
export interface MemoryExtra { wikilinks: number | null; sessionsIndexed: number | null; codegraph: boolean; workflows: number | null; memoryToday: number | null; inboxToday: number | null }

const exists = (p: string): Promise<boolean> => access(p, constants.F_OK).then(() => true, () => false);
const text = (p: string): Promise<string | null> => readFile(p, "utf8").catch(() => null);
const startOfToday = (nowMs: number): number => new Date(new Date(nowMs).setHours(0, 0, 0, 0)).getTime();

export async function readConduct(d: ProbeDirs): Promise<ConductInfo> {
  const [cases, constitution, lint] = await Promise.all([
    text(join(d.home, ".claude", "evals", "agent-conduct", "CASES.md")),
    text(join(d.home, ".claude", "CLAUDE.md")),
    exists(join(d.home, ".claude", "hooks", "memory-claim-lint.py")),
  ]);
  return { cases: cases === null ? null : countConductCases(cases), claimLint: lint, constitution: constitution === null ? null : countConstitutionLayers(constitution) };
}

/** Is `bin` an executable on PATH (or a few usual places), or is `App.app` installed? No process is spawned. */
async function found(bin: string[], apps: string[], d: ProbeDirs, pathEnv: string): Promise<string | null> {
  const dirs = [...pathEnv.split(delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", join(d.home, ".local", "bin")];
  for (const b of bin) for (const dir of new Set(dirs)) if (await exists(join(dir, b))) return `${b} on PATH`;
  for (const a of apps) for (const root of ["/Applications", join(d.home, "Applications")]) if (await exists(join(root, `${a}.app`))) return `${a}.app`;
  return null;
}

export async function readRuntimes(d: ProbeDirs, pathEnv = process.env.PATH ?? ""): Promise<RuntimeInfo[]> {
  const want: Array<[string, string[], string[]]> = [["Claude Code", ["claude"], ["Claude"]], ["OpenAI Codex", ["codex"], ["Codex"]], ["Cursor", ["cursor"], ["Cursor"]], ["Ollama", ["ollama"], ["Ollama"]], ["llama.cpp", ["llama-server", "llama-cli"], ["LM Studio"]]];
  const out = await Promise.all(want.map(async ([name, bin, apps]): Promise<RuntimeInfo> => {
    const how = await found(bin, apps, d, pathEnv);
    return { name, present: how !== null, how: how ?? "not found" };
  }));
  return [...out, { name: "ExampleVendor", present: null, how: "hosted, nothing to detect on this Mac" }];
}

/** Agent apps under ~/Documents/Code: folders whose name says agent / cockpit / claude-* / bridge / boo / aleph. */
const FLEET_NAME = /(agent|aleph|alef|cockpit|claude-|bridge|boo-|resident|donna|jev)/i;
export async function readFleet(d: ProbeDirs, nowMs: number): Promise<FleetApp[]> {
  const root = join(d.home, "Documents", "Code");
  const names = (await readdir(root)).filter((n) => FLEET_NAME.test(n) && !n.startsWith(".")).slice(0, 40);
  const found = await Promise.all(names.map(async (n) => {
    const s = await stat(join(root, n)).catch(() => null);
    return s?.isDirectory() ? { name: n, ageMs: nowMs - s.mtimeMs } : null;
  }));
  return found.filter((x): x is FleetApp => x !== null).sort((a, b) => a.ageMs - b.ageMs).slice(0, 12);
}

export async function readJev(d: ProbeDirs, nowMs: number): Promise<JevInfo> {
  const [router, log] = await Promise.all([exists(join(d.home, "Documents", "Code", "agent-world", "hooks", "jev-router.mjs")), text(join(d.home, ".claude", "logs", "route-card.jsonl"))]);
  const c = log === null ? null : countSince(log, startOfToday(nowMs));
  return { router, cardsToday: c?.today ?? null, cardsTotal: c?.total ?? null };
}

export async function readSkillMeta(d: ProbeDirs): Promise<SkillMeta[]> {
  const dir = join(d.home, ".claude", "skills");
  const entries = await readdir(dir);
  const all = await Promise.all(entries.filter((n) => !n.startsWith("_") && !n.startsWith(".")).map(async (n): Promise<SkillMeta | null> => {
    const file = join(dir, n, "SKILL.md");
    const s = await stat(file).catch(() => null);
    if (!s) return null;
    const md = await readFile(file, "utf8").catch(() => "");
    return { name: n, description: skillDescription(md), mtimeMs: s.mtimeMs };
  }));
  return all.filter((x): x is SkillMeta => x !== null);
}

/** Names only: ~/.claude.json (mcpServers keys, claudeAiMcpEverConnected) and installed_plugins.json keys. Never a URL, header or env. */
export async function readMcpMeta(d: ProbeDirs): Promise<McpMeta> {
  const [cj, pj] = await Promise.all([text(join(d.home, ".claude.json")), text(join(d.home, ".claude", "plugins", "installed_plugins.json"))]);
  const parsed = (s: string | null): Record<string, unknown> => {
    try {
      const v = s === null ? null : (JSON.parse(s) as unknown);
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const c = parsed(cj);
  const p = parsed(pj);
  const keys = (v: unknown): string[] => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v) : []);
  const hosted = Array.isArray(c.claudeAiMcpEverConnected) ? c.claudeAiMcpEverConnected.filter((x): x is string => typeof x === "string") : [];
  if (cj === null && pj === null) throw new Error("ENOENT");
  return { hosted, local: keys(c.mcpServers).sort(), plugins: keys(p.plugins).sort() };
}

async function countMdFiles(dir: string, depth: number, cap = 20_000): Promise<number> {
  let n = 0;
  const walk = async (p: string, left: number): Promise<void> => {
    if (n >= cap) return;
    for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && left > 0) await walk(join(p, e.name), left - 1);
      else if (e.isFile() && e.name.endsWith(".md")) n += 1;
    }
  };
  await walk(dir, depth);
  return n;
}

/** Files in `dir` modified at or after `since` (one level, stat only, capped). */
async function touchedSince(dir: string, since: number, cap = 1500): Promise<number | null> {
  const names = await readdir(dir).catch(() => null);
  if (names === null) return null;
  const times = await Promise.all(names.slice(0, cap).map((n) => stat(join(dir, n)).then((s) => s.mtimeMs, () => 0)));
  return times.filter((t) => t >= since).length;
}

/** Wikilinks across the memory folder, notes under 10-Sessions, a code graph index, workflow files. */
export async function readMemoryExtra(d: ProbeDirs, nowMs: number): Promise<MemoryExtra> {
  const names = (await readdir(d.memoryDir).catch(() => [] as string[])).filter((n) => n.endsWith(".md"));
  const counts = await Promise.all(names.slice(0, 2000).map(async (n) => countWikilinks((await text(join(d.memoryDir, n))) ?? "")));
  const [sessions, codegraph, workflows, memoryToday, inboxToday] = await Promise.all([
    countMdFiles(join(d.vaultRoot, "10-Sessions"), 3),
    exists(join(d.home, ".codegraph")).then((a) => a || exists(join(d.vaultRoot, ".codegraph"))),
    readdir(join(d.home, ".claude", "workflows")).then((l) => l.length, () => null),
    touchedSince(d.memoryDir, startOfToday(nowMs)),
    touchedSince(join(d.vaultRoot, "00-Inbox"), startOfToday(nowMs)),
  ]);
  return { wikilinks: names.length === 0 ? null : counts.reduce((a, b) => a + b, 0), sessionsIndexed: sessions > 0 ? sessions : null, codegraph, workflows, memoryToday, inboxToday };
}

/**
 * Chunk count of the memory-vector skill's store (~/.gstack/memory/vectors.db, see
 * ~/.claude/skills/memory-vector/store.js). Opened READ-ONLY and never created; the `chunks` table is
 * plain SQLite, so the sqlite-vec extension is not needed to count it. Throws (-> "unknown" + reason).
 */
export async function readRecall(d: ProbeDirs): Promise<RecallInfo> {
  const file = join(d.home, ".gstack", "memory", "vectors.db");
  const st = await stat(file);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number } | undefined;
    return { chunks: row?.n ?? 0, mtimeMs: st.mtimeMs };
  } finally {
    db.close();
  }
}
