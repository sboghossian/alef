// Live-session detection. Two independent signals, either one is enough
// (see `isLive` in heuristics.ts):
//   1. the session's .jsonl was modified in the last 120s
//   2. `ps aux` shows a running `claude` process whose cwd (via `lsof`)
//      matches the session's cwd
//
// The ps/lsof probes are best-effort and time-boxed: on any failure (no
// permission, tool missing, sandboxed environment with no host process
// visibility) we simply report no matching processes rather than throwing —
// mtime-based detection still works on its own.

import { execFile } from "node:child_process";
import { log } from "./log.js";

/** stdout of `cmd args`, never blocking the event loop (the old execFileSync probes froze every
 *  endpoint for up to 5 s + 3 s per claude process on a loaded box). Rejects on error/timeout. */
function execText(cmd: string, args: readonly string[], timeoutMs: number, maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export interface ProcessRow {
  pid: number;
  command: string;
}

// The executable itself must be `claude` (CLI, VS Code native binary, `claude -p`), optionally
// suffixed `.exe` (the npm-installed CLI's real binary, e.g.
// .../claude-code/bin/claude.exe, even on macOS — the name is historical, not a Windows check).
// Matching "claude" anywhere caught shells sourcing ~/.claude/*, MCP bridges under ~/.claude/plugins, etc.
const CLAUDE_PROCESS_PATTERN = /^(?:\S*\/)?claude(?:\.exe)?(?:\s|$)/;

/** `ps aux` stdout → rows (this server's own pid left out). */
export function parsePsAux(raw: string, selfPid: number = process.pid): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const pid = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isNaN(pid) || pid === selfPid) continue;
    rows.push({ pid, command: parts.slice(10).join(" ") });
  }
  return rows;
}

/** Every running process, or null when ps can't be read (timed out on a loaded box, sandboxed). */
export async function listProcesses(): Promise<ProcessRow[] | null> {
  try {
    return parsePsAux(await execText("ps", ["aux"], 5000, 4 * 1024 * 1024));
  } catch (err) {
    log.warn("live", "ps aux unavailable", String(err));
    return null;
  }
}

export function filterClaudeProcesses<T extends ProcessRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => CLAUDE_PROCESS_PATTERN.test(r.command) && !/electron/i.test(r.command));
}

export interface ProcessTreeRow extends ProcessRow {
  ppid: number;
}

/** `ps -Ao pid=,ppid=,command=` stdout → rows. */
export function parseProcessTree(stdout: string): ProcessTreeRow[] {
  const rows: ProcessTreeRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
  }
  return rows;
}

/** Every pid with a running claude process somewhere below it (parent, grandparent, …). An Alef
 *  launch runs `zsh -c 'claude …; rm -f …'`: zsh stays claude's parent and foreground process-group
 *  leader, so tmux's #{pane_current_command} reads "zsh" for claude's whole life. A pane pid in
 *  this set still hosts a claude. */
export function claudeAncestorPids(rows: readonly ProcessTreeRow[]): Set<number> {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const out = new Set<number>();
  for (const r of filterClaudeProcesses(rows)) {
    for (let pid = r.ppid, hops = 0; pid > 1 && hops < 64; pid = parentOf.get(pid) ?? 0, hops++) out.add(pid);
  }
  return out;
}

/** claudeAncestorPids over the real process table, or null when ps can't be read (callers must
 *  then assume a claude may be running anywhere). */
export async function listClaudeAncestorPids(): Promise<Set<number> | null> {
  try {
    const rows = parseProcessTree(await execText("ps", ["-Ao", "pid=,ppid=,command="], 5000, 8 * 1024 * 1024));
    return rows.length > 0 ? claudeAncestorPids(rows) : null;
  } catch (err) {
    log.warn("live", "ps -Ao unavailable", String(err));
    return null;
  }
}

/** `lsof -Fpn` stdout (field output: `p<pid>` then `n<path>` lines) → pid → cwd. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number.parseInt(line.slice(1), 10);
      pid = Number.isNaN(n) ? null : n;
    } else if (line.startsWith("n/") && pid !== null && !out.has(pid)) {
      out.set(pid, line.slice(1));
    }
  }
  return out;
}

/** One lsof answer → pid → cwd, or null when it can't be trusted: killed (timed out, buffer
 *  overflow), or failed with nothing usable. lsof exits 1 when some pid has gone, and the rest of
 *  its output still counts; a timed-out lsof's partial output would read as "not running". */
export function lsofCwdsOrNull(err: (Error & { killed?: boolean; signal?: NodeJS.Signals | null }) | null, stdout: string): Map<number, string> | null {
  const cwds = parseLsofCwds(stdout);
  if (!err) return cwds;
  if (err.killed || err.signal) return null;
  return cwds.size > 0 ? cwds : null;
}

/** cwd of each pid, in ONE lsof call (it used to be one blocking lsof per claude process), or
 *  null when lsof failed (lsofCwdsOrNull). `-a -d cwd` restricts lsof to the cwd descriptor:
 *  without it the first "n/..." line is often the binary or a loaded library. */
export async function getProcessCwds(pids: readonly number[]): Promise<Map<number, string> | null> {
  if (pids.length === 0) return new Map();
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(lsofCwdsOrNull(err, typeof stdout === "string" ? stdout : ""));
    });
  });
}

/** One live probe: cwd → number of running claude processes in it, or ok:false when ps or lsof failed
 *  (the map is then empty and means "unknown", not "nothing is running"). */
export interface LiveProbe {
  ok: boolean;
  cwds: Map<string, number>;
  error?: string;
}

export async function probeLiveClaudeCwds(): Promise<LiveProbe> {
  const rows = await listProcesses();
  if (rows === null) return { ok: false, cwds: new Map(), error: "ps aux timed out or failed" };
  const claude = filterClaudeProcesses(rows);
  const byPid = await getProcessCwds(claude.map((r) => r.pid));
  // Failed, not "no claude anywhere": the detector then keeps serving the last good map.
  if (byPid === null) return { ok: false, cwds: new Map(), error: "lsof timed out or failed" };
  const cwds = new Map<string, number>();
  for (const r of claude) {
    const cwd = byPid.get(r.pid);
    if (cwd) cwds.set(cwd, (cwds.get(cwd) ?? 0) + 1);
  }
  return { ok: true, cwds };
}
