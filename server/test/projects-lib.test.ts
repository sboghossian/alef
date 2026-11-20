import { describe, expect, it } from "vitest";
import { branchOfHead, categorize, foldCopies, githubRemote, guessStack, homepageOf, isSkippedFolderName, originUrl, pathKey, readmeLine, slugOf, stageOf, unionProjects } from "../features/projects-lib.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();
const facts = (o: Partial<Parameters<typeof stageOf>[0]> = {}): Parameters<typeof stageOf>[0] => ({ commits: 5, lastCommit: daysAgo(3), lastActive: null, deploy: null, isGit: true, now: NOW, ...o });

describe("unionProjects", () => {
  it("merges a district whose path is a Code folder into one entry that keeps the sessions", () => {
    const u = unionProjects([{ id: "agent-world", name: "agent-world", path: "/Users/x/Documents/Code/agent-world", sessions: 12, lastActive: "2026-10-13T00:00:00Z" }], ["/Users/x/Documents/Code/agent-world", "/Users/x/Documents/Code/atlas"], "linux");
    expect(u).toHaveLength(2);
    expect(u[0]).toMatchObject({ id: "agent-world", islandId: "agent-world", sessions: 12 });
    expect(u[1]).toMatchObject({ id: "atlas", islandId: null, sessions: 0 });
  });

  it("treats a differently-cased or trailing-slash path as the same folder on macOS only", () => {
    const d = [{ id: "a", name: "a", path: "/Users/x/Documents/Code/Alpha/", sessions: 2, lastActive: null }];
    expect(unionProjects(d, ["/Users/x/Documents/Code/alpha"], "darwin")).toHaveLength(1);
    expect(unionProjects(d, ["/Users/x/Documents/Code/alpha"], "linux")).toHaveLength(2);
    expect(pathKey("/a/b/", "linux")).toBe("/a/b");
  });

  it("sums two districts on one path and keeps the newest lastActive; clashing ids get a suffix", () => {
    const u = unionProjects(
      [
        { id: "x", name: "x", path: "/r/x", sessions: 1, lastActive: "2026-01-01T00:00:00Z" },
        { id: "y", name: "x", path: "/r/x", sessions: 4, lastActive: "2026-02-01T00:00:00Z" },
        { id: "x", name: "x elsewhere", path: "/other/x", sessions: 1, lastActive: null },
      ],
      ["/r/z/x"],
      "linux",
    );
    expect(u.find((e) => e.path === "/r/x")).toMatchObject({ sessions: 5, lastActive: "2026-02-01T00:00:00Z" });
    expect(new Set(u.map((e) => e.id)).size).toBe(u.length);
    expect(u.map((e) => e.id)).toContain("x-2");
  });

  it("skips dot-folders and node_modules by name", () => {
    expect(["node_modules", ".git", ".claude", "src"].map(isSkippedFolderName)).toEqual([true, true, true, false]);
    expect(slugOf("Maya 1 year")).toBe("maya-1-year");
  });
});

describe("stageOf", () => {
  it("idea: no commit and no session", () => {
    expect(stageOf(facts({ commits: 0, lastCommit: null })).stage).toBe("idea");
    expect(stageOf(facts({ commits: null, lastCommit: null, isGit: false })).stage).toBe("idea");
  });
  it("building: a commit in the last 14 days, even when deployed", () => {
    expect(stageOf(facts({ lastCommit: daysAgo(14) })).stage).toBe("building");
    expect(stageOf(facts({ lastCommit: daysAgo(2), deploy: "vercel.json" })).stage).toBe("building");
  });
  it("a recent session counts as building for a folder with no commits", () => {
    const s = stageOf(facts({ commits: 0, lastCommit: null, lastActive: daysAgo(1), isGit: false }));
    expect(s.stage).toBe("building");
    expect(s.reason).toContain("session");
  });
  it("shipped: a deploy config and not recent", () => {
    const s = stageOf(facts({ lastCommit: daysAgo(40), deploy: "wrangler.toml" }));
    expect(s.stage).toBe("shipped");
    expect(s.reason).toContain("wrangler.toml");
    expect(stageOf(facts({ lastCommit: daysAgo(300), deploy: "vercel.json" })).stage).toBe("shipped");
  });
  it("dormant: over 60 days with no deploy; between 15 and 60 days stays building", () => {
    expect(stageOf(facts({ lastCommit: daysAgo(61) })).stage).toBe("dormant");
    expect(stageOf(facts({ lastCommit: daysAgo(60) })).stage).toBe("building");
    expect(stageOf(facts({ lastCommit: daysAgo(30) })).reason).toContain("no deploy config");
  });
  it("activity is the newer of the last commit and the last session", () => {
    expect(stageOf(facts({ lastCommit: daysAgo(100), lastActive: daysAgo(2) })).activityAt).toBe(daysAgo(2));
  });
});

describe("categorize", () => {
  const f = (name: string, o: { remote?: string | null; readme?: string | null; vaultNote?: string | null } = {}) => categorize({ name, remote: o.remote ?? null, readme: o.readme ?? null, vaultNote: o.vaultNote ?? null });
  it("ACME-Inc owner wins over any word", () => {
    expect(f("random", { remote: "ACME-Inc/random" })).toMatchObject({ category: "acme", reason: "GitHub owner ACME-Inc" });
  });
  it("names rules fire in order and say why", () => {
    expect(f("acme-ai-next")).toMatchObject({ category: "acme", reason: 'name mentions "acme"' });
    expect(f("claude-office").category).toBe("infra");
    expect(f("divorce-practice").category).toBe("legal");
    expect(f("maya-booklet").category).toBe("personal");
  });
  it("matches whole words: 'client' is not 'cli', 'flawless' is not 'law'", () => {
    expect(f("client-portal").category).toBe("side");
    expect(f("flawless").category).toBe("side");
  });
  it("uses the vault note slug and the README line; the default is side with a reason", () => {
    expect(f("zzz", { vaultNote: "legal-zzz" })).toMatchObject({ category: "legal", reason: 'vault note mentions "legal"' });
    expect(f("zzz", { readme: "A court-filing helper" }).reason).toBe('README mentions "court"');
    const d = f("zzz", { remote: "sboghossian/zzz" });
    expect(d.category).toBe("side");
    expect(d.reason).toContain("sboghossian");
  });
});

describe("README, stack and git text parsing", () => {
  it("readmeLine: first heading, else first prose line; markup and badges stripped", () => {
    expect(readmeLine("[![ci](x)](y)\n\n# Agent **World**\n\nbody")).toBe("Agent World");
    expect(readmeLine("```\ncode\n```\nA small tool for [things](http://x).\n")).toBe("A small tool for things.");
    expect(readmeLine("\n\n")).toBeNull();
  });
  it("guessStack reads deps, python files and manifests", () => {
    const pkg = JSON.stringify({ dependencies: { next: "1", react: "1" }, devDependencies: { typescript: "5", vitest: "1" } });
    expect(guessStack({ packageJson: pkg })).toEqual(["nextjs", "react", "typescript", "vitest"]);
    expect(guessStack({ packageJson: "{not json" })).toEqual(["nodejs"]);
    expect(guessStack({ requirements: "fastapi==0.1\npandas\n", cargo: true })).toEqual(["python", "fastapi", "pandas", "rust"]);
    expect(guessStack({})).toEqual([]);
  });
  it("homepage only counts when it is a live URL", () => {
    expect(homepageOf(JSON.stringify({ homepage: "https://x.dev" }))).toBe("https://x.dev");
    expect(homepageOf(JSON.stringify({ homepage: "./docs" }))).toBeNull();
  });
  it("githubRemote / originUrl / branchOfHead", () => {
    expect(githubRemote("git@github.com:sboghossian/agent-world.git")).toBe("sboghossian/agent-world");
    expect(githubRemote("https://github.com/ACME-Inc/acme-ai")).toBe("ACME-Inc/acme-ai");
    expect(githubRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(originUrl('[core]\n\tx = 1\n[remote "origin"]\n\turl = git@github.com:a/b.git\n[branch "main"]\n')).toBe("git@github.com:a/b.git");
    expect(branchOfHead("ref: refs/heads/feat/x\n")).toBe("feat/x");
    expect(branchOfHead("0123abcd")).toBeNull();
  });
});

describe("stageOf: dating a folder with no commit and no session by its file times", () => {
  const none = { commits: null, lastCommit: null, lastActive: null, isGit: false } as const;
  it("dates by the newest mtime and says so in the reason", () => {
    const s = stageOf(facts({ ...none, files: { newest: daysAgo(4), entries: 7 } }));
    expect(s).toMatchObject({ stage: "building", activityAt: daysAgo(4) });
    expect(s.reason).toContain("dated by the mtimes of the folder and its 7 top-level entries");
    expect(stageOf(facts({ ...none, files: { newest: daysAgo(200), entries: 3 } })).stage).toBe("dormant");
    expect(stageOf(facts({ ...none, files: { newest: daysAgo(30), entries: 3 } })).stage).toBe("building");
    expect(stageOf(facts({ ...none, deploy: "vercel.json", files: { newest: daysAgo(30), entries: 3 } })).stage).toBe("shipped");
  });
  it("stays an idea only when empty, near-empty or undatable", () => {
    expect(stageOf(facts({ ...none, files: { newest: daysAgo(1), entries: 0 } }))).toMatchObject({ stage: "idea", reason: expect.stringContaining("empty") });
    expect(stageOf(facts({ ...none, files: { newest: daysAgo(1), entries: 1 } })).stage).toBe("idea");
    expect(stageOf(facts({ ...none, files: null })).reason).toContain("could not be read");
  });
});

describe("foldCopies", () => {
  const e = (id: string, o: Partial<Parameters<typeof foldCopies>[0][number]> = {}) => ({ id, path: `/c/${id}`, worktreeOf: null, remote: null, sessions: 0, activityAt: null, ...o });
  it("folds a linked worktree into its main repo, and a stale one says so", () => {
    const m = foldCopies([e("main"), e("wt", { worktreeOf: "/c/main" }), e("old", { worktreeOf: "/c/main", stale: true }), e("lost", { worktreeOf: "/elsewhere/repo" })], "linux");
    expect(m.get("wt")).toEqual({ into: "main", reason: "a git worktree of main" });
    expect(m.get("old")?.reason).toContain("stale");
    expect(m.has("lost")).toBe(false); // main repo not listed: stays its own card
    expect(m.has("main")).toBe(false);
  });
  it("folds clones by remote into the one with the most sessions, then the newest activity", () => {
    const m = foldCopies([e("a", { remote: "o/r", activityAt: "2026-10-01" }), e("b", { remote: "O/R", sessions: 3 }), e("c", { remote: "o/r" }), e("solo", { remote: "o/x" })], "linux");
    expect(m.get("a")?.into).toBe("b");
    expect(m.get("c")?.reason).toContain("most sessions");
    expect(m.has("b") || m.has("solo")).toBe(false);
    const n = foldCopies([e("a", { remote: "o/r", activityAt: "2026-10-01" }), e("b", { remote: "o/r", activityAt: "2026-09-01" })], "linux");
    expect(n.get("b")).toMatchObject({ into: "a", reason: expect.stringContaining("newest activity") });
  });
  it("follows a worktree of a folded clone to the canonical card", () => {
    const m = foldCopies([e("next", { remote: "o/r", sessions: 9 }), e("org", { remote: "o/r" }), e("wt", { worktreeOf: "/c/org", remote: "o/r" })], "linux");
    expect(m.get("wt")).toMatchObject({ into: "next", reason: "a git worktree of org" });
    expect(m.get("org")?.into).toBe("next");
  });
});
