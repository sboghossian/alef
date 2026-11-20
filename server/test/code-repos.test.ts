import { describe, expect, it } from "vitest";
import { createGitRootResolver, groupTouchedByRepo, isRefusedRoot, pickDominantRepo, repoLabels, touchedAbsPaths, type Exists } from "../features/code-repos.js";
import { mergeRepos, pickRepo } from "../features/code.js";
import type { TranscriptEntry } from "../features/transcript.js";
import type { CodeRepo } from "../../shared/features/code.js";

const HOME = "/Users/me";
/** A fake disk: these paths "exist"; every exists() call is recorded. */
function fakeDisk(paths: string[]): { exists: Exists; calls: string[] } {
  const set = new Set(paths);
  const calls: string[] = [];
  return {
    calls,
    exists: async (p) => {
      calls.push(p);
      return set.has(p);
    },
  };
}

describe("git root resolution", () => {
  it("walks up to the nearest .git (dir or worktree file) and caches every directory", async () => {
    const disk = fakeDisk(["/Users/me/code/app/.git", "/Users/me/code/app/packages/wt/.git"]);
    const r = createGitRootResolver(disk.exists);
    expect(await r.rootOfFile("/Users/me/code/app/src/deep/a.ts")).toBe("/Users/me/code/app");
    expect(await r.rootOfFile("/Users/me/code/app/packages/wt/x.ts")).toBe("/Users/me/code/app/packages/wt");
    expect(await r.rootOfFile("/Users/me/notes/todo.md")).toBeNull();
    const before = disk.calls.length;
    expect(await r.rootOfFile("/Users/me/code/app/src/deep/b.ts")).toBe("/Users/me/code/app");
    expect(await r.rootOfFile("/Users/me/code/app/src/c.ts")).toBe("/Users/me/code/app");
    expect(disk.calls.length).toBe(before); // all from cache: no fs call per file
  });
  it("forgets its cache after the TTL", async () => {
    let t = 0;
    const disk = fakeDisk(["/r/.git"]);
    const r = createGitRootResolver(disk.exists, { ttlMs: 1000, now: () => t });
    await r.rootOfFile("/r/a.ts");
    const n = disk.calls.length;
    t = 2000;
    await r.rootOfFile("/r/a.ts");
    expect(disk.calls.length).toBeGreaterThan(n);
  });
});

describe("grouping touched files by repo", () => {
  const entry = (...paths: string[]): TranscriptEntry => ({ at: null, role: "assistant", texts: [], toolUses: paths.map((p) => ({ name: "Read", input: { file_path: p }, at: null })) });

  it("groups by root, most touched first, skipping non-repo files and refused roots", async () => {
    const disk = fakeDisk(["/Users/me/code/app/.git", "/Users/me/code/lib/.git", "/Users/me/.ssh/.git", "/Users/me/.git-home-marker"]);
    const r = createGitRootResolver(disk.exists);
    const paths = touchedAbsPaths(
      [entry("/Users/me/code/app/a.ts", "/Users/me/code/app/b.ts", "code/lib/x.ts", "/Users/me/notes.md", "/Users/me/.ssh/config"), entry("/Users/me/code/app/a.ts")],
      HOME,
    );
    expect(paths).toContain("/Users/me/code/lib/x.ts"); // relative resolved against cwd
    const repos = await groupTouchedByRepo(paths, r, HOME);
    expect(repos).toEqual([
      { root: "/Users/me/code/app", label: "app", files: 2, git: true },
      { root: "/Users/me/code/lib", label: "lib", files: 1, git: true },
    ]);
  });
  it("never offers $HOME, its ancestors, / or secret dirs as roots", () => {
    expect(isRefusedRoot("/", HOME)).toBe(true);
    expect(isRefusedRoot("/Users", HOME)).toBe(true);
    expect(isRefusedRoot("/Users/me", HOME)).toBe(true);
    expect(isRefusedRoot("/Users/me/.ssh", HOME)).toBe(true);
    expect(isRefusedRoot("/Users/me/.aws/x", HOME)).toBe(true);
    expect(isRefusedRoot("/Users/me/code/app", HOME)).toBe(false);
    expect(isRefusedRoot("/Users/me/.claude/skills-repo", HOME)).toBe(false);
  });
  it("labels clashing basenames with their parent", () => {
    expect([...repoLabels(["/a/web", "/b/web", "/c/api"]).values()]).toEqual(["a/web", "b/web", "api"]);
  });
  it("puts the cwd repo first and only accepts a repo from the session's own list", () => {
    const touched = [
      { root: "/w/lib", label: "lib", files: 5, git: true },
      { root: "/w/app", label: "app", files: 2, git: true },
    ];
    const repos = mergeRepos({ root: "/w/app", git: true }, touched);
    expect(repos.map((x) => [x.root, x.files])).toEqual([["/w/app", 2], ["/w/lib", 5]]);
    expect(pickRepo(repos, "")).toMatchObject({ ok: true, repo: { root: "/w/app" } });
    // $HOME session: no cwd repo, so the most touched repo is the default
    expect(pickRepo(mergeRepos(null, touched), "")).toMatchObject({ ok: true, repo: { root: "/w/lib" } });
    expect(pickRepo(repos, "/w/lib/../lib")).toMatchObject({ ok: true, repo: { root: "/w/lib" } });
    expect(pickRepo(repos, "/etc")).toEqual({ ok: false, status: 403, error: "repo-not-allowed" });
    expect(pickRepo(repos, "w/lib")).toMatchObject({ ok: false, status: 400 });
    expect(pickRepo([], "")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("pickDominantRepo (home-placement's threshold rule)", () => {
  const repo = (root: string, files: number): CodeRepo => ({ root, label: root, files, git: true });

  it("picks the one repo with an outright majority of every resolvable touch", () => {
    expect(pickDominantRepo([repo("/w/app", 3), repo("/w/lib", 1)])).toEqual(repo("/w/app", 3));
  });
  it("stays (null) on a tie for first place, even though each half meets 50%", () => {
    expect(pickDominantRepo([repo("/w/app", 2), repo("/w/lib", 2)])).toBeNull();
  });
  it("stays (null) when the leader is under 50% of every resolvable touch", () => {
    expect(pickDominantRepo([repo("/w/app", 3), repo("/w/lib", 2), repo("/w/misc", 2)])).toBeNull();
  });
  it("stays (null) with only 1 touched file, even though it is 100% of the total", () => {
    expect(pickDominantRepo([repo("/w/app", 1)])).toBeNull();
  });
  it("stays (null) with no resolvable touches at all", () => {
    expect(pickDominantRepo([])).toBeNull();
  });
  it("picks the sole repo once it has 2+ touches", () => {
    expect(pickDominantRepo([repo("/w/app", 2)])).toEqual(repo("/w/app", 2));
  });
});
