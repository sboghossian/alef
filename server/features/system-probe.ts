// The default readers behind GET /api/system. Every one is async (fs/promises, execFile, a TCP
// connect with a deadline), read-only, and returns plain data; system.ts wraps each in its own
// timeout. Nothing here starts, stops or writes anything. Not unit-tested against the real disk:
// system.test.ts injects its own sources and tests the TCP probe against a local server.

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import net from "node:net";
import { cpus, homedir, loadavg, uptime } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discoverHooks, discoverMcpServers, discoverSkills } from "../harness.js";
import { countMemoryFiles } from "./atlas-lib.js";
import { discoverDefaultAutomations } from "./automations.js";
import { createTtlCache } from "./cache-lib.js";
import { latestCensusPrs } from "./census.js";
import { latestOutcomeRecords, latestOutcomesColdDone } from "./outcomes.js";
import type { FeatureContext } from "./registry.js";
import type { HarnessInfo, HostInfo, MemoryInfo, MiniInfo, OutputsInfo, PromptsInfo, RoutinesInfo, ServiceHost, SettingsInfo, VaultInfo } from "./system-nodes.js";
import { vaultRoot } from "../config.js";

const run = promisify(execFile);
const TCP_TIMEOUT_MS = 500;

export interface ProbeDirs {
  home: string;
  vaultRoot: string;
  memoryDir: string;
}

export function defaultDirs(home = homedir()): ProbeDirs {
  return { home, vaultRoot: vaultRoot(home), memoryDir: join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory") };
}

/** True when something accepts a TCP connection within `ms`. Never throws; the socket is always closed. */
export function tcpUp(host: string, port: number, ms = TCP_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (up: boolean): void => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function readHost(): Promise<HostInfo> {
  return Promise.resolve({ load1: loadavg()[0] ?? 0, cpus: cpus().length, uptimeSec: uptime() });
}

const version = createTtlCache<string, string | null>({ ttlMs: 10 * 60_000, max: 1 });
export function readClaudeVersion(): Promise<string | null> {
  return version.get("v", async () => {
    const { stdout } = await run("claude", ["--version"], { timeout: 2000 });
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null;
  });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function readSettings(d: ProbeDirs): Promise<SettingsInfo> {
  const path = join(d.home, ".claude", "settings.json");
  const [json, hooks] = await Promise.all([readJson(path), discoverHooks(path)]);
  const perms = typeof json.permissions === "object" && json.permissions !== null ? (json.permissions as Record<string, unknown>) : {};
  const hookCfg = typeof json.hooks === "object" && json.hooks !== null ? (json.hooks as Record<string, unknown>) : {};
  const counts = new Map<string, number>();
  for (const h of hooks) {
    const event = h.name.split(":")[0] ?? "";
    if (event) counts.set(event, (counts.get(event) ?? 0) + 1);
  }
  const hookByEvent = [...counts].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return {
    model: str(json.model),
    effort: str(json.effortLevel),
    hookCount: hooks.length,
    hookEvents: hookByEvent.map((e) => e.event),
    hookByEvent,
    permissionHook: len(hookCfg.PermissionRequest) > 0,
    denyCount: len(perms.deny),
    allowCount: len(perms.allow),
  };
}

export async function readHarness(d: ProbeDirs): Promise<HarnessInfo> {
  const claude = join(d.home, ".claude");
  const [skills, agents, mcp] = await Promise.all([
    discoverSkills(claude),
    readdir(join(claude, "agents")).catch(() => [] as string[]),
    discoverMcpServers(join(d.home, ".claude.json"), join(claude, "settings.json")),
  ]);
  return { skills: skills.length, agents: agents.filter((n) => n.endsWith(".md")).length, mcp: mcp.length, mcpNames: mcp.map((m) => m.name).sort() };
}

/** Memory files by the type prefix of their name (project_, feedback_, reference_, user_); anything else is "other". */
export function memoryByType(names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    if (!n.endsWith(".md") || n === "MEMORY.md") continue;
    const m = /^(project|feedback|reference|user)_/.exec(n);
    const t = m?.[1] ?? "other";
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

export async function readMemory(d: ProbeDirs): Promise<MemoryInfo> {
  const [files, index, names] = await Promise.all([countMemoryFiles(d.memoryDir), readFile(join(d.memoryDir, "MEMORY.md"), "utf8").catch(() => null), readdir(d.memoryDir).catch(() => [] as string[])]);
  return { files: files ?? 0, byType: memoryByType(names), indexLines: index === null ? null : index.split("\n").length - (index.endsWith("\n") ? 1 : 0) };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: 3500, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

const notes = createTtlCache<string, number | null>({ ttlMs: 10 * 60_000, max: 2 });
const seconds = (out: string | null): number | null => {
  const n = Number(out?.trim());
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
};

export async function readVault(d: ProbeDirs): Promise<VaultInfo> {
  const [last, mirror, ahead, brain, count] = await Promise.all([
    git(d.vaultRoot, ["log", "-1", "--format=%ct"]),
    git(d.vaultRoot, ["log", "-1", "--format=%ct", "@{u}"]),
    git(d.vaultRoot, ["rev-list", "--count", "@{u}..HEAD"]),
    stat(join(d.vaultRoot, "60-Meta", "brain-graph.json")).then((s) => s.mtimeMs, () => null),
    notes.get(d.vaultRoot, async () => {
      const out = await git(d.vaultRoot, ["ls-files", "-z", "--", "*.md"]);
      return out === null ? null : out.split("\0").filter(Boolean).length;
    }),
  ]);
  const aheadN = Number(ahead?.trim());
  return { path: d.vaultRoot, notes: count, lastCommitMs: seconds(last), mirrorMs: seconds(mirror), ahead: ahead !== null && Number.isFinite(aheadN) ? aheadN : null, brainGraphMs: brain };
}

/** A `Host *mini*` entry of ~/.ssh/config (read-only), then TCP 22. No such entry: not configured. */
export async function readMini(d: ProbeDirs): Promise<MiniInfo> {
  const text = await readFile(join(d.home, ".ssh", "config"), "utf8").catch(() => "");
  const m = /^\s*Host\s+(\S*mini\S*)\s*$([\s\S]*?)(?=^\s*Host\s|$(?![\s\S]))/im.exec(text);
  if (!m || m[1]?.includes("*")) return { configured: false, reachable: null };
  const target = /^\s*HostName\s+(\S+)/im.exec(m[2] ?? "")?.[1] ?? m[1] ?? "";
  const port = Number(/^\s*Port\s+(\d+)/im.exec(m[2] ?? "")?.[1] ?? 22);
  return { configured: true, reachable: await tcpUp(target, port) };
}

const startOfToday = (nowMs: number): number => new Date(new Date(nowMs).setHours(0, 0, 0, 0)).getTime();

export async function readRoutines(nowMs: number): Promise<RoutinesInfo> {
  const list = await discoverDefaultAutomations();
  const launchd = list.filter((a) => a.kind === "launchd");
  const today = startOfToday(nowMs);
  const voice = list.filter((a) => /aleph|voice/i.test(`${a.id} ${a.name}`) && a.kind === "launchd");
  return {
    total: launchd.length,
    loaded: launchd.filter((a) => a.loaded === true).length,
    paused: launchd.filter((a) => a.loaded === false).length,
    running: launchd.filter((a) => a.running).length,
    failed: launchd.filter((a) => a.lastExitStatus !== null && a.lastExitStatus !== 0).length,
    firedToday: list.filter((a) => a.lastRunAt !== null && Date.parse(a.lastRunAt) >= today).length,
    voiceLoaded: voice.length === 0 ? null : voice.some((a) => a.loaded === true),
  };
}

/** `- host:` / `port:` pairs of ~/.dashable/services.yml. Read-only; the file is never parsed as code. */
export function parseServices(yml: string): Array<{ host: string; port: number; managed: boolean; dir: string | null; public: boolean }> {
  const out: Array<{ host: string; port: number; managed: boolean; dir: string | null; public: boolean }> = [];
  for (const block of yml.split(/^\s*-\s+host:\s*/m).slice(1)) {
    const host = /^([\w.-]+)/.exec(block)?.[1];
    const port = Number(/^\s*port:\s*(\d+)/m.exec(block)?.[1]);
    const managed = !/^\s*managed:\s*false\b/m.test(block);
    const dir = /^\s*dir:\s*["']?([^\s"'#]+)/m.exec(block)?.[1] ?? null;
    const isPublic = /^\s*public:\s*true\b/m.test(block);
    if (host && Number.isInteger(port) && port > 0) out.push({ host, port, managed, dir, public: isPublic });
  }
  return out;
}

const live = createTtlCache<string, ServiceHost[]>({ ttlMs: 60_000, max: 1 });
/** The Refresh button: the next read of the fleet connects again instead of using the 60 s cache. */
export function dropFleetCache(): void {
  live.clear();
}

export function readServices(d: ProbeDirs): Promise<ServiceHost[]> {
  return live.get("all", async () => {
    const yml = await readFile(join(d.home, ".dashable", "services.yml"), "utf8");
    return Promise.all(parseServices(yml).map(async (s) => ({ ...s, up: await tcpUp("localhost", s.port) })));
  });
}

export function readPrompts(ctx: FeatureContext, nowMs: number): Promise<PromptsInfo> {
  const today = startOfToday(nowMs);
  return Promise.resolve({ sessionsToday: ctx.db.listSessions().filter((s) => Date.parse(s.startedAt) >= today).length, liveNow: null });
}

export function readOutputs(nowMs: number): Promise<OutputsInfo> {
  const today = startOfToday(nowMs);
  const prs = latestCensusPrs();
  const recs = latestOutcomeRecords();
  const read = recs.length > 0 || latestOutcomesColdDone();
  const shipped = recs.filter((r) => r.outcome === "shipped" && Date.parse(r.evidenceAt ?? r.lastActive) >= today).length;
  const artifacts = recs.filter((r) => Date.parse(r.lastActive) >= today).reduce((n, r) => n + r.artifacts.length, 0);
  return Promise.resolve({
    prsToday: prs.length === 0 ? null : prs.filter((p) => Date.parse(p.mergedAt) >= today).length,
    shippedToday: read ? shipped : null,
    artifactsToday: read ? artifacts : null,
  });
}
