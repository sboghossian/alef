// H4 "fork": read-only git + PR status of an agent's repo (branch, ahead/behind, dirty count,
// the branch's PR via `gh pr view`), and "Fork into worktree": a new `fork/<slug>-<short>`
// branch checked out under ~/.alef-worktrees/<repo>/, optionally with a plan-mode claude in a
// world tmux session (`aw-<id>`, launched through talk's startWorldSession). Forks Alef made are kept in
// data/fork-worktrees.json; only those can be removed, and only while clean.
//
// Safety: the deny list (fork-lib.ts) is enforced here on real paths + git toplevel + the main
// repo, never by name alone; a repo with another live claude session is refused. Allowed git
// writes: worktree add / worktree remove (no --force). gh is read-only. Status lookups run off
// the request path, cached per repo for 60s, and are pushed over WS when they land.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ForkMessage, ForkRecord, ForkRemoveResult, ForkRepoStatus, ForkResult, ForkStatusResponse } from "../../shared/features/fork.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import { mergeRepos, pickRepo } from "./code.js";
import { createGitRootResolver, createTranscriptUsesCache, groupTouchedByRepo, isRefusedRoot, touchedAbsPaths, type GitRootResolver } from "./code-repos.js";
import {
  BASE_RE,
  defaultDenySources,
  deniedReason,
  ghFailureNote,
  isInside,
  parsePrJson,
  parseStatusV2,
  parseWorktreeList,
  realForkGit,
  realGhPrView,
  realOrResolved,
  realPortCwds,
  slugify,
  syncedRoots,
  loadDenyRules,
  type DenyLoad,
  type DenySources,
  type ForkGit,
  type GhPrView,
  type PortCwdLookup,
} from "./fork-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { startWorldSession } from "./talk.js";

const STATUS_TTL_MS = 60_000;
const DENY_TTL_MS = 5 * 60_000;
const MAX_CACHED = 64;
const FORK_ID_RE = /^[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
export const PLAN_COMMAND = "claude --permission-mode plan";

export type ForkLauncher = (cwd: string, ctx: FeatureContext) => Promise<{ ok: true; tmuxName: string } | { ok: false; error: string }>;

/** Starts a plan-mode claude in a world tmux session through talk, so the session is bound
 *  (talk + interrupt reach it) like any dispatch. The command is a constant; only the cwd varies. */
export const worldPlanLauncher: ForkLauncher = (cwd, ctx) => startWorldSession(ctx, cwd, PLAN_COMMAND, { plan: true });

export interface ForkDeps {
  home: string;
  git: ForkGit;
  gh: GhPrView;
  launcher: ForkLauncher;
  portCwds: PortCwdLookup;
  resolver: GitRootResolver;
  deny: DenySources;
  now: () => number;
  /** Where the fork records live. Default: <dir of the db>/fork-worktrees.json. */
  dataFile?: string;
}

interface Assessment {
  toplevel: string;
  mainRoot: string;
}

type Assess = { ok: true; a: Assessment } | { ok: false; status: number; reason: string };

interface CacheEntry {
  at: number;
  status: Omit<ForkRepoStatus, "forks">;
  mainRoot: string | null;
}

function fail(res: Parameters<typeof respondJson>[0], status: number, error: string): void {
  respondJson(res, status, { ok: false, error });
}

function errText(err: unknown): string {
  const stderr = err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string" ? err.stderr.trim() : "";
  return (stderr || String(err)).split("\n")[0]?.slice(0, 300) ?? "unknown error";
}

function isForkRecord(v: unknown): v is ForkRecord {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    FORK_ID_RE.test(v.id) &&
    typeof v.agentId === "string" &&
    typeof v.repoRoot === "string" &&
    typeof v.path === "string" &&
    typeof v.branch === "string" &&
    typeof v.base === "string" &&
    typeof v.createdAt === "string" &&
    (v.tmuxName === null || typeof v.tmuxName === "string")
  );
}

export function createForkFeature(partial: Partial<ForkDeps> = {}): ServerFeature {
  const home = partial.home ?? homedir();
  const deps: ForkDeps = {
    home,
    git: partial.git ?? realForkGit,
    gh: partial.gh ?? realGhPrView,
    launcher: partial.launcher ?? worldPlanLauncher,
    portCwds: partial.portCwds ?? realPortCwds,
    resolver: partial.resolver ?? createGitRootResolver(),
    deny: partial.deny ?? defaultDenySources(home),
    now: partial.now ?? Date.now,
    dataFile: partial.dataFile,
  };
  const worktreesRoot = join(home, ".alef-worktrees");
  const uses = createTranscriptUsesCache();
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<void>>();
  let denyCache: { at: number; load: DenyLoad } | null = null;
  let records: ForkRecord[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** Runs write operations one at a time (fork/remove + the records file). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  const dataFile = (ctx: FeatureContext): string => deps.dataFile ?? join(dirname(resolve(ctx.config.dbPath)), "fork-worktrees.json");

  async function loadRecords(ctx: FeatureContext): Promise<ForkRecord[]> {
    if (records) return records;
    try {
      const parsed: unknown = JSON.parse(await readFile(dataFile(ctx), "utf8"));
      records = Array.isArray(parsed) ? parsed.filter(isForkRecord) : [];
    } catch {
      records = [];
    }
    return records;
  }

  async function saveRecords(ctx: FeatureContext, next: ForkRecord[]): Promise<void> {
    const file = dataFile(ctx);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
    records = next;
  }

  async function denyRules(): Promise<DenyLoad> {
    if (denyCache && deps.now() - denyCache.at < DENY_TTL_MS) return denyCache.load;
    const load = await loadDenyRules(deps.deny, deps.portCwds);
    denyCache = { at: deps.now(), load };
    return load;
  }

  /** The agent's git repos (cwd's repo first, then roots of the files it touched). */
  async function agentRepos(ctx: FeatureContext, agentId: string, cwd: string): Promise<{ root: string; label: string }[]> {
    const cwdGit = await deps.resolver.rootOfDir(cwd);
    const cwdRoot = cwdGit ? resolve(cwdGit) : null;
    const cwdRepo = cwdRoot && !isRefusedRoot(cwdRoot, home) ? { root: cwdRoot, git: true } : null;
    const entries = await uses.entries(ctx.config.projectsDir, agentId);
    const touched = await groupTouchedByRepo(touchedAbsPaths(entries ?? [], cwd), deps.resolver, home);
    return mergeRepos(cwdRepo, touched)
      .filter((r) => r.git)
      .map((r) => ({ root: r.root, label: r.label }));
  }

  /** Every deny rule, checked on the real source path, its git toplevel and its main repo. */
  async function assess(ctx: FeatureContext, sourceRoot: string, agentCwd: string): Promise<Assess> {
    const load = await denyRules();
    if (!load.ok) return { ok: false, status: 503, reason: `deny list unavailable: ${load.error}` };
    const realSrc = await realOrResolved(sourceRoot);
    const early = deniedReason([resolve(sourceRoot), realSrc], load.rules, home);
    if (early) return { ok: false, status: 403, reason: early };
    let toplevel: string;
    let mainRoot: string;
    let worktrees: string[];
    try {
      toplevel = await realOrResolved((await deps.git.read(realSrc, ["rev-parse", "--show-toplevel"])).trim());
      const common = await realOrResolved((await deps.git.read(realSrc, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
      if (basename(common) !== ".git") return { ok: false, status: 409, reason: "bare or unusual git layout (no .git dir); not supported" };
      mainRoot = dirname(common);
      worktrees = await Promise.all(parseWorktreeList(await deps.git.read(toplevel, ["worktree", "list", "--porcelain"])).map(realOrResolved));
    } catch (err) {
      return { ok: false, status: 409, reason: `not a usable git repo: ${errText(err)}` };
    }
    const denied = deniedReason([toplevel, mainRoot, ...worktrees], load.rules, home);
    if (denied) return { ok: false, status: 403, reason: denied };
    // Another live claude session in any worktree of this repo → refuse (its own cwd excepted).
    const ownCwd = await realOrResolved(agentCwd);
    const areas = [...new Set([toplevel, mainRoot, ...worktrees])];
    for (const cwd of ctx.detectLive().keys()) {
      const real = await realOrResolved(cwd);
      if (real === ownCwd) continue;
      if (areas.some((a) => isInside(a, real))) return { ok: false, status: 409, reason: `another live claude session is working in this repo (${real})` };
    }
    return { ok: true, a: { toplevel, mainRoot } };
  }

  async function computeStatus(ctx: FeatureContext, root: string, agentCwd: string): Promise<CacheEntry> {
    const base: Omit<ForkRepoStatus, "forks"> = {
      root,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: 0,
      pr: null,
      prNote: null,
      forkable: { ok: true },
      checkedAt: new Date(deps.now()).toISOString(),
    };
    try {
      Object.assign(base, parseStatusV2(await deps.git.read(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"])));
    } catch (err) {
      return { at: deps.now(), mainRoot: null, status: { ...base, prNote: null, forkable: { ok: false, reason: `git status failed: ${errText(err)}` } } };
    }
    if (base.branch) {
      const r = await deps.gh(root, base.branch);
      if (r.ok) {
        base.pr = parsePrJson(r.stdout);
        if (!base.pr) base.prNote = "gh returned an unreadable answer";
      } else base.prNote = ghFailureNote(r);
    } else base.prNote = "detached HEAD";
    const verdict = await assess(ctx, root, agentCwd);
    base.forkable = verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
    return { at: deps.now(), status: base, mainRoot: verdict.ok ? verdict.a.mainRoot : null };
  }

  async function withForks(ctx: FeatureContext, entry: CacheEntry): Promise<ForkRepoStatus> {
    const all = await loadRecords(ctx);
    const key = entry.mainRoot ?? (await realOrResolved(entry.status.root));
    return { ...entry.status, forks: all.filter((f) => f.repoRoot === key || isInside(key, f.repoRoot)) };
  }

  function refresh(ctx: FeatureContext, root: string, agentCwd: string): Promise<void> {
    const pending = inflight.get(root);
    if (pending) return pending;
    const p = (async () => {
      try {
        const entry = await computeStatus(ctx, root, agentCwd);
        cache.delete(root);
        cache.set(root, entry);
        while (cache.size > MAX_CACHED) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
        ctx.emit({ kind: "status", root, status: await withForks(ctx, entry) } satisfies ForkMessage);
      } catch (err) {
        ctx.log.warn("fork", `status refresh failed for ${root}`, String(err));
      } finally {
        inflight.delete(root);
      }
    })();
    inflight.set(root, p);
    return p;
  }

  async function doFork(ctx: FeatureContext, agentId: string, body: unknown): Promise<{ status: number; body: ForkResult }> {
    if (!isRecord(body)) return { status: 400, body: { ok: false, error: "body must be a JSON object" } };
    const repoParam = body.repo === undefined ? "" : body.repo;
    const baseParam = body.base === undefined ? "" : body.base;
    const launch = body.launch === undefined ? false : body.launch;
    if (typeof repoParam !== "string" || repoParam.length > 4096) return { status: 400, body: { ok: false, error: "repo must be a path string" } };
    if (typeof baseParam !== "string" || (baseParam !== "" && !BASE_RE.test(baseParam))) return { status: 400, body: { ok: false, error: "base must be a branch, tag or commit name" } };
    if (typeof launch !== "boolean") return { status: 400, body: { ok: false, error: "launch must be a boolean" } };

    const session = ctx.db.getSession(agentId);
    if (!session) return { status: 404, body: { ok: false, error: "unknown agent id" } };
    const repos = await agentRepos(ctx, agentId, session.cwd);
    const picked = pickRepo(
      repos.map((r) => ({ ...r, files: 0, git: true })),
      repoParam,
    );
    if (!picked.ok) return { status: picked.status, body: { ok: false, error: picked.error } };

    const verdict = await assess(ctx, picked.repo.root, session.cwd);
    if (!verdict.ok) return { status: verdict.status, body: { ok: false, error: verdict.reason } };
    const { toplevel, mainRoot } = verdict.a;

    let sha: string;
    try {
      sha = (await deps.git.read(toplevel, ["rev-parse", "--verify", "--quiet", `${baseParam || "HEAD"}^{commit}`])).trim();
    } catch {
      return { status: 400, body: { ok: false, error: `unknown base: ${baseParam || "HEAD"}` } };
    }
    if (!SHA_RE.test(sha)) return { status: 400, body: { ok: false, error: `unknown base: ${baseParam || "HEAD"}` } };

    // The worktree home: never in a synced folder, never inside a denied path.
    for (const synced of syncedRoots(home)) {
      if (isInside(synced, worktreesRoot)) return { status: 500, body: { ok: false, error: `${worktreesRoot} is inside a synced folder; refusing` } };
    }
    await mkdir(worktreesRoot, { recursive: true, mode: 0o755 });
    const realRoot = await realOrResolved(worktreesRoot);
    const load = await denyRules();
    if (!load.ok) return { status: 503, body: { ok: false, error: `deny list unavailable: ${load.error}` } };
    for (const synced of syncedRoots(home)) {
      if (isInside(await realOrResolved(synced), realRoot)) return { status: 500, body: { ok: false, error: `${worktreesRoot} resolves into a synced folder; refusing` } };
    }
    const rootDenied = deniedReason([realRoot], load.rules, home);
    if (rootDenied) return { status: 500, body: { ok: false, error: rootDenied } };

    const repoSlug = slugify(basename(mainRoot)) || "repo";
    const slug = slugify(session.title ?? "") || "session";
    let short = "";
    let target = "";
    for (let i = 0; i < 5; i++) {
      short = randomBytes(3).toString("hex");
      target = join(realRoot, repoSlug, `${slug}-${short}`);
      const taken = await stat(target).then(
        () => true,
        () => false,
      );
      if (!taken) break;
      target = "";
    }
    if (!target) return { status: 500, body: { ok: false, error: "could not pick a free worktree folder" } };
    const branch = `fork/${slug}-${short}`;
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    try {
      await deps.git.worktreeAdd(toplevel, branch, target, sha);
    } catch (err) {
      return { status: 500, body: { ok: false, error: `git worktree add failed: ${errText(err)}` } };
    }
    ctx.log.info("fork", `worktree ${target} (${branch} @ ${sha.slice(0, 8)}) from ${toplevel}`);

    let launched = false;
    let launchError: string | null = null;
    let tmuxName: string | null = null;
    if (launch) {
      const out = await deps.launcher(target, ctx);
      if (out.ok) {
        launched = true;
        tmuxName = out.tmuxName;
      } else launchError = out.error;
    }
    const record: ForkRecord = {
      id: randomBytes(6).toString("hex"),
      agentId,
      repoRoot: mainRoot,
      path: target,
      branch,
      base: sha,
      createdAt: new Date(deps.now()).toISOString(),
      tmuxName,
    };
    await saveRecords(ctx, [...(await loadRecords(ctx)), record]);
    cache.delete(picked.repo.root);
    return { status: 200, body: { ok: true, fork: record, launched, launchError } };
  }

  async function doRemove(ctx: FeatureContext, body: unknown): Promise<{ status: number; body: ForkRemoveResult }> {
    const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
    if (!FORK_ID_RE.test(id)) return { status: 400, body: { ok: false, error: "id must be a fork id" } };
    const all = await loadRecords(ctx);
    const rec = all.find((r) => r.id === id);
    if (!rec) return { status: 404, body: { ok: false, error: "not a worktree Alef created" } };
    const realRoot = await realOrResolved(worktreesRoot);
    const realPath = await realOrResolved(rec.path);
    if (!isInside(realRoot, realPath) || realPath === realRoot) return { status: 403, body: { ok: false, error: "that worktree is not under ~/.alef-worktrees; Alef will not remove it" } };
    const exists = await stat(realPath).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!exists) {
      // Nothing on disk to remove: forget it (git keeps a stale entry until `git worktree prune`).
      await saveRecords(ctx, all.filter((r) => r.id !== id));
      return { status: 200, body: { ok: true, id } };
    }
    for (const cwd of ctx.detectLive().keys()) {
      if (isInside(realPath, await realOrResolved(cwd))) return { status: 409, body: { ok: false, error: "a live claude session is running in this worktree; stop it first" } };
    }
    let dirty: number;
    try {
      const out = await deps.git.read(realPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
      dirty = out.split("\n").filter((l) => l.length > 0).length;
    } catch (err) {
      return { status: 409, body: { ok: false, error: `cannot read its git status: ${errText(err)}` } };
    }
    if (dirty > 0) {
      return {
        status: 409,
        body: { ok: false, error: `this worktree has ${dirty} uncommitted or untracked file${dirty === 1 ? "" : "s"}; commit or discard them yourself first (Alef never forces a removal)` },
      };
    }
    try {
      await deps.git.worktreeRemove(rec.repoRoot, realPath);
    } catch (err) {
      return { status: 409, body: { ok: false, error: `git worktree remove refused: ${errText(err)}` } };
    }
    ctx.log.info("fork", `removed worktree ${realPath} (branch ${rec.branch} kept)`);
    await saveRecords(ctx, all.filter((r) => r.id !== id));
    for (const [root, entry] of cache) if (entry.mainRoot === rec.repoRoot) cache.delete(root);
    return { status: 200, body: { ok: true, id } };
  }

  async function readBody(req: Parameters<typeof readJsonBody>[0]): Promise<{ ok: true; body: unknown } | { ok: false }> {
    try {
      return { ok: true, body: await readJsonBody(req) };
    } catch {
      return { ok: false };
    }
  }

  return {
    id: "fork",
    routes: [
      {
        method: "POST",
        path: "/api/fork/remove",
        async handler(req, res, ctx) {
          const b = await readBody(req);
          if (!b.ok) return fail(res, 400, "invalid JSON body");
          const out = await serial(() => doRemove(ctx, b.body));
          respondJson(res, out.status, out.body);
        },
      },
      {
        method: "GET",
        path: "/api/fork/:agentId",
        async handler(req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return fail(res, 400, "invalid agent id");
          const session = ctx.db.getSession(agentId);
          if (!session) return fail(res, 404, "unknown agent id");
          const repos = await agentRepos(ctx, agentId, session.cwd);
          const repoParam = new URL(req.url ?? "/", "http://localhost").searchParams.get("repo") ?? "";
          const picked = pickRepo(
            repos.map((r) => ({ ...r, files: 0, git: true })),
            repoParam,
          );
          if (!picked.ok) return fail(res, picked.status, picked.status === 409 ? "no git repo for this agent" : picked.error);
          const root = picked.repo.root;
          const entry = cache.get(root);
          const fresh = entry !== undefined && deps.now() - entry.at < STATUS_TTL_MS;
          if (!fresh) void refresh(ctx, root, session.cwd);
          respondJson(res, 200, {
            ok: true,
            repos,
            root,
            status: entry ? await withForks(ctx, entry) : null,
            pending: !fresh,
          } satisfies ForkStatusResponse);
        },
      },
      {
        method: "POST",
        path: "/api/fork/:agentId/fork",
        async handler(req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return fail(res, 400, "invalid agent id");
          const b = await readBody(req);
          if (!b.ok) return fail(res, 400, "invalid JSON body");
          const out = await serial(() => doFork(ctx, agentId, b.body));
          respondJson(res, out.status, out.body);
        },
      },
    ],
  };
}

export const forkFeature = createForkFeature();
