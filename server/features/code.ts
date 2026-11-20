// "code": a read-only view of an agent's repository (tree, file, touched files, diff, git status).
// Repos = git root of the agent's cwd (cwd itself when not in git; $HOME and "/" refused) plus
// the git roots of the files the session touched (code-repos.ts), chosen with `?repo=`.
// Every path goes through safe-path.ts (lexical + realpath containment, secret refusal).
// git runs through execFile with an argv array; user paths only ever follow "--".

import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CODE_DIFF_MAX_BYTES,
  CODE_FILE_MAX_BYTES,
  CODE_TREE_CAP,
  type CodeDiffResponse,
  type CodeError,
  type CodeFileResponse,
  type CodeRepo,
  type CodeStatusFile,
  type CodeStatusResponse,
  type CodeTouchedFile,
  type CodeTouchedResponse,
  type CodeTreeEntry,
  type CodeTreeResponse,
} from "../../shared/features/code.js";
import { redactSecrets } from "../heuristics.js";
import { respondJson } from "../http.js";
import { filePathFromToolUse } from "../jsonl-events.js";
import { isValidUuid } from "../reactivate.js";
import { findGitRoot } from "../repo-root.js";
import type { FeatureContext, Route, RouteParams } from "./registry.js";
import type { ServerFeature } from "./registry.js";
import { createTtlCache } from "./cache-lib.js";
import { createGitRootResolver, createTranscriptUsesCache, groupTouchedByRepo, isRefusedRoot, repoLabels, touchedAbsPaths, type GitRootResolver } from "./code-repos.js";
import { isSecretPath, readTextCapped, resolveInside, safePathStatus } from "./safe-path.js";
import type { TranscriptEntry } from "./transcript.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo", ".cache", ".venv", "__pycache__", ".git.nosync"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const STATUS_CAP = 500;

export type GitRunner = (root: string, args: readonly string[], maxBuffer: number) => Promise<string>;

export const realGit: GitRunner = async (root, args, maxBuffer) => {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return stdout;
};

function fail(res: Parameters<typeof respondJson>[0], status: number, error: string): void {
  respondJson(res, status, { ok: false, error } satisfies CodeError);
}

export interface RepoRoot {
  root: string;
  git: boolean;
}

/** The agent's repo root, or an HTTP error. */
export function repoRootFor(ctx: FeatureContext, agentId: string, home = homedir()): { ok: true; repo: RepoRoot } | { ok: false; status: number; error: string } {
  if (!isValidUuid(agentId)) return { ok: false, status: 400, error: "invalid agent id" };
  const session = ctx.db.getSession(agentId);
  if (!session) return { ok: false, status: 404, error: "unknown agent id" };
  const gitRoot = findGitRoot(session.cwd);
  const root = gitRoot ?? session.cwd;
  const abs = resolve(root);
  if (abs === "/" || abs === resolve(home)) return { ok: false, status: 409, error: "this agent's folder is not a project (home or /)" };
  return { ok: true, repo: { root: abs, git: gitRoot !== null } };
}

export function languageOf(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ext;
}

/** Breadth-first listing under `start` (never follows symlinks), capped. File sizes of one
 *  directory are lstat'ed in parallel (one sequential lstat per file was the slow part). */
export async function walkTree(root: string, start: string, cap = CODE_TREE_CAP): Promise<{ entries: CodeTreeEntry[]; truncated: boolean }> {
  const entries: CodeTreeEntry[] = [];
  const queue: string[] = [start];
  let truncated = false;
  while (queue.length > 0) {
    const dir = queue.shift() ?? "";
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    const kept = items.filter((it) => it.isSymbolicLink() || (it.isDirectory() && !IGNORED_DIRS.has(it.name)) || it.isFile());
    const room = cap - entries.length;
    const batch = kept.slice(0, room);
    const sizes = await Promise.all(
      batch.map(async (it) => {
        if (!it.isFile() || it.isSymbolicLink()) return 0;
        try {
          return (await lstat(join(dir, it.name))).size;
        } catch {
          return 0; // raced
        }
      }),
    );
    batch.forEach((it, i) => {
      const abs = join(dir, it.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (it.isSymbolicLink()) {
        entries.push({ path: rel, type: "symlink" });
      } else if (it.isDirectory()) {
        entries.push({ path: rel, type: "dir" });
        queue.push(abs);
      } else {
        entries.push({ path: rel, type: "file", size: sizes[i] ?? 0, ...(isSecretPath(rel) ? { blocked: true } : {}) });
      }
    });
    if (kept.length > room) {
      truncated = true;
      return { entries, truncated };
    }
  }
  return { entries, truncated };
}

/** Files a session referenced through tool calls, most recent first. */
export function touchedFiles(entries: readonly TranscriptEntry[], root: string, cwd: string): CodeTouchedFile[] {
  const byPath = new Map<string, CodeTouchedFile & { order: number }>();
  let order = 0;
  for (const e of entries) {
    for (const use of e.toolUses) {
      const raw = filePathFromToolUse({ name: use.name, input: use.input });
      if (!raw) continue;
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
      const insideRepo = abs === root || abs.startsWith(`${root}/`);
      const key = insideRepo ? relative(root, abs) : abs;
      const prev = byPath.get(key);
      const isEdit = EDIT_TOOLS.has(use.name);
      order += 1;
      byPath.set(key, {
        path: key,
        insideRepo,
        count: (prev?.count ?? 0) + 1,
        edits: (prev?.edits ?? 0) + (isEdit ? 1 : 0),
        lastTool: use.name,
        lastAt: use.at ?? prev?.lastAt ?? null,
        order,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => b.order - a.order).map(({ order: _o, ...f }) => f);
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(out: string, cap = STATUS_CAP): { files: CodeStatusFile[]; truncated: boolean } {
  const parts = out.split("\0");
  const files: CodeStatusFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (p.length < 4) continue;
    const status = p.slice(0, 2);
    files.push({ path: p.slice(3), status });
    if (status[0] === "R" || status[0] === "C") i += 1; // rename/copy: next field is the source path
    if (files.length >= cap) return { files, truncated: i < parts.length - 2 };
  }
  return { files, truncated: false };
}

/** Every repo a session can browse: its cwd's repo first (when it is a project), then the git
 *  roots of the files it touched, most files first. Pure given the grouped touched repos. */
export function mergeRepos(cwdRepo: { root: string; git: boolean } | null, touchedRepos: readonly CodeRepo[]): CodeRepo[] {
  const rest = touchedRepos.filter((r) => r.root !== cwdRepo?.root);
  const first: CodeRepo[] = cwdRepo ? [{ root: cwdRepo.root, label: "", files: touchedRepos.find((r) => r.root === cwdRepo.root)?.files ?? 0, git: cwdRepo.git }] : [];
  const all = [...first, ...rest.map((r) => ({ ...r }))];
  const labels = repoLabels(all.map((r) => r.root));
  return all.map((r) => ({ ...r, label: labels.get(r.root) ?? r.label }));
}

/** Picks the repo a request is about: `?repo=` must be one of `repos` exactly; none = the first. */
export function pickRepo(repos: readonly CodeRepo[], repoParam: string): { ok: true; repo: CodeRepo } | { ok: false; status: number; error: string } {
  if (repoParam) {
    if (repoParam.length > 4096 || repoParam.includes("\0") || !isAbsolute(repoParam)) return { ok: false, status: 400, error: "bad-path" };
    const want = resolve(repoParam);
    const hit = repos.find((r) => r.root === want);
    return hit ? { ok: true, repo: hit } : { ok: false, status: 403, error: "repo-not-allowed" };
  }
  const first = repos[0];
  return first ? { ok: true, repo: first } : { ok: false, status: 409, error: "this agent's folder is not a project (home or /) and it touched no file in a git repo" };
}

type Handler = (
  req: Parameters<Route["handler"]>[0],
  res: Parameters<Route["handler"]>[1],
  ctx: FeatureContext,
  repo: RepoRoot,
  agentId: string,
  info: { repos: CodeRepo[]; entries: TranscriptEntry[] | null },
) => Promise<void>;

export function createCodeFeature(git: GitRunner = realGit, home = homedir(), resolver: GitRootResolver = createGitRootResolver()): ServerFeature {
  const uses = createTranscriptUsesCache();
  // Tree listings are the heavy part (up to 2000 entries); the same root/path is reused for 10s
  // and concurrent identical requests share one walk.
  const trees = createTtlCache<string, { entries: CodeTreeEntry[]; truncated: boolean }>({ ttlMs: 10_000, max: 32 });

  function route(sub: string, handler: Handler, opts: { needRepos: boolean }): Route {
    return {
      method: "GET",
      path: `/api/code/:agentId/${sub}`,
      async handler(req, res, ctx, params: RouteParams) {
        const agentId = params.agentId ?? "";
        if (!isValidUuid(agentId)) return fail(res, 400, "invalid agent id");
        const session = ctx.db.getSession(agentId);
        if (!session) return fail(res, 404, "unknown agent id");
        const cwdGit = await resolver.rootOfDir(session.cwd);
        const cwdRoot = resolve(cwdGit ?? session.cwd);
        const cwdRepo = isRefusedRoot(cwdRoot, home) ? null : { root: cwdRoot, git: cwdGit !== null };
        const repoParam = q(req, "repo");
        // Fast path: no repo asked for and the cwd is a project: no transcript needed.
        if (!repoParam && cwdRepo && !opts.needRepos) {
          return handler(req, res, ctx, cwdRepo, agentId, { repos: [], entries: null });
        }
        const entries = await uses.entries(ctx.config.projectsDir, agentId);
        const touchedRepos = await groupTouchedByRepo(touchedAbsPaths(entries ?? [], session.cwd), resolver, home);
        const repos = mergeRepos(cwdRepo, touchedRepos);
        const picked = pickRepo(repos, repoParam);
        if (!picked.ok) return fail(res, picked.status, picked.error);
        await handler(req, res, ctx, { root: picked.repo.root, git: picked.repo.git }, agentId, { repos, entries });
      },
    };
  }
  const q = (req: Parameters<Route["handler"]>[0], key: string): string => new URL(req.url ?? "/", "http://localhost").searchParams.get(key) ?? "";

  return {
    id: "code",
    routes: [
      route(
        "tree",
        async (req, res, _ctx, repo, _agentId, info) => {
          const rel = q(req, "path");
          const target = await resolveInside(repo.root, rel);
          if (!target.ok) return fail(res, safePathStatus(target.error), target.error);
          const { entries, truncated } = await trees.get(target.abs, () => walkTree(target.abs, target.abs));
          const prefix = target.rel ? `${target.rel.split("\\").join("/")}/` : "";
          respondJson(res, 200, {
            ok: true,
            root: repo.root,
            repos: info.repos,
            path: target.rel,
            entries: entries.map((e) => ({ ...e, path: prefix + e.path })),
            truncated,
          } satisfies CodeTreeResponse);
        },
        { needRepos: true },
      ),
      route("file", async (req, res, _ctx, repo) => {
        const rel = q(req, "path");
        if (!rel) return fail(res, 400, "path required");
        const target = await resolveInside(repo.root, rel);
        if (!target.ok) return fail(res, safePathStatus(target.error), target.error);
        const read = await readTextCapped(target.abs, CODE_FILE_MAX_BYTES);
        if (!read.ok) return fail(res, read.status, read.error);
        respondJson(res, 200, {
          ok: true,
          path: target.rel,
          size: read.size,
          language: languageOf(target.rel),
          content: redactSecrets(read.text),
        } satisfies CodeFileResponse);
      }, { needRepos: false }),
      route(
        "touched",
        async (_req, res, ctx, repo, agentId, info) => {
          const cwd = ctx.db.getSession(agentId)?.cwd ?? repo.root;
          respondJson(res, 200, {
            ok: true,
            root: repo.root,
            repos: info.repos,
            files: info.entries ? touchedFiles(info.entries, repo.root, cwd) : [],
          } satisfies CodeTouchedResponse);
        },
        { needRepos: true },
      ),
      route("diff", async (req, res, ctx, repo) => {
        const rel = q(req, "path");
        if (!rel) return fail(res, 400, "path required");
        const target = await resolveInside(repo.root, rel);
        // A deleted file no longer resolves, but its diff is still meaningful: allow a
        // lexically-contained, non-secret path that is simply missing.
        let relPath: string;
        if (target.ok) relPath = target.rel;
        else if (target.error === "not-found" && !isSecretPath(rel) && !rel.includes("\0") && !isAbsolute(rel)) {
          const lexical = resolve(repo.root, rel);
          if (!lexical.startsWith(`${repo.root}/`)) return fail(res, 403, "outside-root");
          relPath = relative(repo.root, lexical);
        } else return fail(res, safePathStatus(target.error), target.error);
        if (!repo.git) return respondJson(res, 200, { ok: true, path: relPath, diff: "", truncated: false, git: false } satisfies CodeDiffResponse);
        try {
          const out = await git(repo.root, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", relPath], CODE_DIFF_MAX_BYTES * 4);
          const truncated = Buffer.byteLength(out) > CODE_DIFF_MAX_BYTES;
          const diff = truncated ? Buffer.from(out).subarray(0, CODE_DIFF_MAX_BYTES).toString("utf8") : out;
          respondJson(res, 200, { ok: true, path: relPath, diff: redactSecrets(diff), truncated, git: true } satisfies CodeDiffResponse);
        } catch (err) {
          ctx.log.warn("code", "git diff failed", String(err).slice(0, 200));
          fail(res, 500, "git diff failed");
        }
      }, { needRepos: false }),
      route("status", async (_req, res, ctx, repo) => {
        if (!repo.git) {
          return respondJson(res, 200, { ok: true, root: repo.root, git: false, branch: null, dirty: [], truncated: false } satisfies CodeStatusResponse);
        }
        try {
          const [branchOut, statusOut] = await Promise.all([
            git(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"], 64 * 1024).catch(() => ""),
            git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], 8 * 1024 * 1024),
          ]);
          const { files, truncated } = parsePorcelainZ(statusOut);
          respondJson(res, 200, {
            ok: true,
            root: repo.root,
            git: true,
            branch: branchOut.trim() || null,
            dirty: files,
            truncated,
          } satisfies CodeStatusResponse);
        } catch (err) {
          ctx.log.warn("code", "git status failed", String(err).slice(0, 200));
          fail(res, 500, "git status failed");
        }
      }, { needRepos: false }),
    ],
  };
}

export const codeFeature = createCodeFeature();
