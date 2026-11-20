// Pure-ish building blocks for the "fork" feature: the deny list (parsed from the dashable
// configs, read-only), git status / gh PR parsing, slugs, and the only git + gh runners the
// feature uses. Every subprocess is execFile with an argv array and a timeout, never a shell.
//
// Allowed git writes are exactly `worktree add` and `worktree remove` (never --force); the
// read runner refuses any other subcommand than status / rev-parse / worktree list. gh is
// only ever asked `pr view`.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChecksRollup, ForkPr } from "../../shared/features/fork.js";
import { isRefusedRoot } from "./code-repos.js";
import { vaultRoot } from "../config.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- paths

/** macOS volumes are case-insensitive by default: compare folded there (errs toward denying). */
const fold = (p: string): string => (process.platform === "darwin" ? p.toLowerCase() : p);

export function isInside(root: string, candidate: string): boolean {
  const r = fold(resolve(root));
  const c = fold(resolve(candidate));
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** realpath, or the lexical resolve when the path does not exist (yet). */
export async function realOrResolved(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** Folders that iCloud (or another sync client) may mirror: never a worktree home. */
export function syncedRoots(home: string): string[] {
  return [join(home, "Documents"), join(home, "Desktop"), join(home, "Library", "Mobile Documents"), join(home, "Library", "CloudStorage")];
}

// ---------------------------------------------------------------- dashable configs (read-only)

export interface LiveService {
  host: string;
  port: number | null;
  dir: string | null;
}

function stripYamlValue(raw: string): string {
  const noComment = raw.replace(/\s+#.*$/, "").trim();
  return noComment.replace(/^["']|["']$/g, "");
}

/** Parses ~/.dashable/services.yml entries (`- host:` blocks with `port:` and `dir:`). */
export function parseServicesYml(text: string): LiveService[] {
  const out: LiveService[] = [];
  let cur: LiveService | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const start = /^\s*-\s+host:\s*(.+)$/.exec(line);
    if (start?.[1]) {
      if (cur) out.push(cur);
      cur = { host: stripYamlValue(start[1]), port: null, dir: null };
      continue;
    }
    if (!cur) continue;
    const port = /^\s+port:\s*(.+)$/.exec(line);
    if (port?.[1]) {
      const n = Number(stripYamlValue(port[1]));
      if (Number.isInteger(n) && n > 0 && n < 65536) cur.port = n;
      continue;
    }
    const dir = /^\s+dir:\s*(.+)$/.exec(line);
    if (dir?.[1]) cur.dir = stripYamlValue(dir[1]) || null;
  }
  if (cur) out.push(cur);
  return out;
}

/** Parses the cloudflared ingress (`hostname:` then `service: http://127.0.0.1:<port>`). */
export function parseCloudflaredIngress(text: string): { host: string; port: number }[] {
  const out: { host: string; port: number }[] = [];
  let host: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*-?\s*hostname:\s*(\S+)/.exec(line);
    if (h?.[1]) {
      host = stripYamlValue(h[1]);
      continue;
    }
    const s = /^\s*service:\s*https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)/.exec(line);
    if (s?.[1] && host) {
      out.push({ host, port: Number(s[1]) });
      host = null;
    }
  }
  return out;
}

/** A services.yml `dir`: absolute, `~/…`, or relative to ~/Documents/Code. */
export function resolveServiceDir(dir: string, home: string): string {
  if (dir.startsWith("~/")) return resolve(home, dir.slice(2));
  if (isAbsolute(dir)) return resolve(dir);
  return resolve(home, "Documents", "Code", dir);
}

// ---------------------------------------------------------------- deny list

export interface DenyRule {
  dir: string;
  reason: string;
}

export interface DenySources {
  home: string;
  cloudflaredConfig: string;
  servicesYml: string;
  vault: string;
}

export function defaultDenySources(home: string): DenySources {
  return {
    home,
    cloudflaredConfig: join(home, ".cloudflared", "dashable", "config.yml"),
    servicesYml: join(home, ".dashable", "services.yml"),
    vault: vaultRoot(home),
  };
}

/** cwd of the process listening on each port (lsof). Injectable: tests never scan the host. */
export type PortCwdLookup = (ports: readonly number[]) => Promise<Map<number, string>>;

export const realPortCwds: PortCwdLookup = async (ports) => {
  const want = new Set(ports);
  const out = new Map<number, string>();
  if (want.size === 0) return out;
  const pidsByPort = new Map<number, Set<number>>();
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) {
        const port = Number(/:(\d+)$/.exec(line)?.[1] ?? NaN);
        if (want.has(port) && pid > 0) {
          const set = pidsByPort.get(port) ?? new Set<number>();
          set.add(pid);
          pidsByPort.set(port, set);
        }
      }
    }
  } catch {
    return out; // lsof missing or failed (exit 1 = nothing listening): services.yml still applies
  }
  const pids = [...new Set([...pidsByPort.values()].flatMap((s) => [...s]))];
  if (pids.length === 0) return out;
  const cwdByPid = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { timeout: 5000, maxBuffer: 1024 * 1024 });
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid > 0) cwdByPid.set(pid, line.slice(1));
    }
  } catch {
    return out;
  }
  for (const [port, set] of pidsByPort) {
    for (const pid of set) {
      const cwd = cwdByPid.get(pid);
      if (cwd) {
        out.set(port, cwd);
        break;
      }
    }
  }
  return out;
};

async function readOptional(path: string): Promise<{ state: "missing" } | { state: "ok"; text: string } | { state: "error"; error: string }> {
  try {
    return { state: "ok", text: await readFile(path, "utf8") };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return { state: "missing" };
    return { state: "error", error: String(err) };
  }
}

export type DenyLoad = { ok: true; rules: DenyRule[]; alwaysLiveDirs: number } | { ok: false; error: string };

/** Builds the deny list. Fails closed when a dashable config exists but cannot be read or
 *  parsed, or when only one of the two exists (a half-present map is not trustworthy). */
export async function loadDenyRules(src: DenySources, portCwds: PortCwdLookup): Promise<DenyLoad> {
  const home = src.home;
  const rules: DenyRule[] = [
    { dir: join(home, ".claude"), reason: "~/.claude (the harness, skills-repo included)" },
    { dir: join(home, ".acme-worktrees"), reason: "acme-ai-next worktrees" },
    { dir: src.vault, reason: "the vault" },
  ];
  const [cf, svc] = await Promise.all([readOptional(src.cloudflaredConfig), readOptional(src.servicesYml)]);
  if (cf.state === "error") return { ok: false, error: `cannot read ${src.cloudflaredConfig}: ${cf.error}` };
  if (svc.state === "error") return { ok: false, error: `cannot read ${src.servicesYml}: ${svc.error}` };
  if (cf.state !== svc.state) return { ok: false, error: "only one of the dashable config files exists; refusing until both are readable" };
  const liveDirs = new Set<string>();
  if (cf.state === "ok" && svc.state === "ok") {
    const services = parseServicesYml(svc.text);
    const ingress = parseCloudflaredIngress(cf.text);
    if (services.length === 0 && svc.text.trim().length > 0) return { ok: false, error: `parsed no service from ${src.servicesYml}` };
    if (ingress.length === 0 && /hostname:/.test(cf.text)) return { ok: false, error: `parsed no ingress from ${src.cloudflaredConfig}` };
    for (const s of services) {
      if (!s.dir) continue;
      const dir = resolveServiceDir(s.dir, home);
      liveDirs.add(dir);
      rules.push({ dir, reason: `always-live service ${s.host}.dashable.dev${s.port ? ` (port ${s.port})` : ""}` });
    }
    // Belt and braces: the cwd of whatever listens on every tunnelled port (both files' ports).
    const ports = [...new Set([...ingress.map((i) => i.port), ...services.flatMap((s) => (s.port ? [s.port] : []))])];
    const cwds = await portCwds(ports);
    for (const [port, cwd] of cwds) {
      if (isRefusedRoot(cwd, home)) continue; // "/" or $HOME: too broad to mean anything
      const host = ingress.find((i) => i.port === port)?.host ?? `port ${port}`;
      liveDirs.add(resolve(cwd));
      rules.push({ dir: resolve(cwd), reason: `directory of the process serving ${host} (port ${port})` });
    }
  }
  // Symlinked folders: deny the real path too.
  const withReal: DenyRule[] = [];
  for (const r of rules) {
    withReal.push(r);
    const real = await realOrResolved(r.dir);
    if (real !== resolve(r.dir)) withReal.push({ dir: real, reason: r.reason });
  }
  return { ok: true, rules: withReal, alwaysLiveDirs: liveDirs.size };
}

/** First reason `paths` (already real paths) may not be forked, or null. A path is refused when
 *  it is inside a denied dir, when it contains one (a repo holding a live service), when it
 *  mentions acme-ai-next anywhere, or when it is "/" / $HOME / a secret dir. */
export function deniedReason(paths: readonly string[], rules: readonly DenyRule[], home: string): string | null {
  for (const p of paths) {
    if (/acme-ai-next/i.test(p)) return `${p} is acme-ai-next (shared, never forked from here)`;
    if (isRefusedRoot(p, home)) return `${p} is not a project folder`;
    for (const r of rules) {
      if (isInside(r.dir, p)) return `${p} is inside ${r.reason}`;
      if (isInside(p, r.dir)) return `${p} contains ${r.reason}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- git

export interface ForkGit {
  /** Read-only git: status, rev-parse, worktree list. Anything else throws. */
  read(root: string, args: readonly string[]): Promise<string>;
  /** `git worktree add -b <branch> <path> <baseSha>` (hooks disabled). */
  worktreeAdd(repo: string, branch: string, path: string, baseSha: string): Promise<void>;
  /** `git worktree remove <path>`, never --force: git itself refuses a dirty worktree. */
  worktreeRemove(repo: string, path: string): Promise<void>;
}

export function isReadOnlyGitArgs(args: readonly string[]): boolean {
  const [a, b] = args;
  if (a === "status" || a === "rev-parse") return true;
  return a === "worktree" && b === "list";
}

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

export const realForkGit: ForkGit = {
  async read(root, args) {
    if (!isReadOnlyGitArgs(args)) throw new Error(`git ${args[0] ?? ""} is not a read-only command`);
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV });
    return stdout;
  },
  async worktreeAdd(repo, branch, path, baseSha) {
    await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, "worktree", "add", "-b", branch, path, baseSha], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV });
  },
  async worktreeRemove(repo, path) {
    await execFileAsync("git", ["-C", repo, "worktree", "remove", path], { timeout: 60_000, maxBuffer: 1024 * 1024, env: GIT_ENV });
  },
};

export interface BranchStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
}

/** Parses `git status --porcelain=v2 --branch`. */
export function parseStatusV2(out: string): BranchStatus {
  const st: BranchStatus = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      st.branch = name === "(detached)" ? null : name;
    } else if (line.startsWith("# branch.upstream ")) st.upstream = line.slice("# branch.upstream ".length).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      st.ahead = Number(m?.[1] ?? 0);
      st.behind = Number(m?.[2] ?? 0);
    } else if (!line.startsWith("#")) st.dirty++;
  }
  return st;
}

/** Paths from `git worktree list --porcelain`. */
export function parseWorktreeList(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

export const BASE_RE = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;

/** "Fix the login bug!" → "fix-the-login-bug" (≤32, [a-z0-9-]); "" when nothing is left. */
export function slugify(s: string, max = 32): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

// ---------------------------------------------------------------- gh (read-only)

export type GhResult = { ok: true; stdout: string } | { ok: false; kind: "missing" | "failed"; message: string };
/** Runs `gh pr view <branch> --json …` in `cwd`. The only gh call this feature makes. */
export type GhPrView = (cwd: string, branch: string) => Promise<GhResult>;

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let ghPathCache: { at: number; path: string | null } | null = null;

async function findGh(): Promise<string | null> {
  if (ghPathCache && Date.now() - ghPathCache.at < 5 * 60_000) return ghPathCache.path;
  let found: string | null = null;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const d of new Set(dirs)) {
    const p = join(d, "gh");
    if (await isExecutable(p)) {
      found = p;
      break;
    }
  }
  ghPathCache = { at: Date.now(), path: found };
  return found;
}

export const PR_JSON_FIELDS = "number,state,title,url,statusCheckRollup";

export const realGhPrView: GhPrView = async (cwd, branch) => {
  if (branch.startsWith("-")) return { ok: false, kind: "failed", message: "odd branch name" };
  const gh = await findGh();
  if (!gh) return { ok: false, kind: "missing", message: "gh not installed" };
  try {
    const { stdout } = await execFileAsync(gh, ["pr", "view", branch, "--json", PR_JSON_FIELDS], {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string" ? err.stderr : String(err);
    return { ok: false, kind: "failed", message: stderr };
  }
};

/** Maps a failed `gh pr view` to a user-facing note; null when it just means "no PR". */
export function ghFailureNote(r: Extract<GhResult, { ok: false }>): string | null {
  if (r.kind === "missing") return "gh not installed";
  const m = r.message.toLowerCase();
  if (m.includes("no pull requests found")) return null;
  if (m.includes("no git remotes") || m.includes("none of the git remotes") || m.includes("not a git repository")) return "no GitHub remote";
  if (m.includes("gh auth login") || m.includes("authentication")) return "gh is not logged in";
  const first = r.message.split("\n").find((l) => l.trim().length > 0) ?? "unknown error";
  return `gh failed: ${clean(first, 160)}`;
}

function clean(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses `gh pr view --json number,state,title,url,statusCheckRollup` output (null on junk). */
export function parsePrJson(stdout: string): ForkPr | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.number !== "number" || typeof v.url !== "string" || !/^https:\/\/\S+$/.test(v.url)) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const rollup = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  for (const c of rollup) {
    if (!isObj(c)) continue;
    const conclusion = typeof c.conclusion === "string" ? c.conclusion.toUpperCase() : "";
    const status = typeof c.status === "string" ? c.status.toUpperCase() : "";
    const state = typeof c.state === "string" ? c.state.toUpperCase() : "";
    const outcome = state || (status && status !== "COMPLETED" ? "PENDING" : conclusion);
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) passed++;
    else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""].includes(outcome)) pending++;
    else failed++;
  }
  const checks: ChecksRollup = failed > 0 ? "failure" : pending > 0 ? "pending" : passed > 0 ? "success" : "none";
  return {
    number: v.number,
    state: typeof v.state === "string" ? clean(v.state, 20) : "UNKNOWN",
    title: typeof v.title === "string" ? clean(v.title, 200) : "",
    url: v.url,
    checks,
    passed,
    failed,
    pending,
  };
}
