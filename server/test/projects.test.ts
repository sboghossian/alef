import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectsResponse, ProjectTreeResponse } from "../../shared/features/projects.js";
import { createProjectsFeature, worldDistricts } from "../features/projects.js";
import type { FeatureContext } from "../features/registry.js";
import { isCredentialName } from "../features/projects-scan.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function fixture(): Promise<{ home: string; code: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "projects-home-")));
  const code = join(home, "Documents", "Code");
  // alpha: a git repo with one commit, a README and a vercel.json
  await mkdir(join(code, "alpha", "src"), { recursive: true });
  await writeFile(join(code, "alpha", "README.md"), "# Alpha tool\n\nbody\n");
  await writeFile(join(code, "alpha", "package.json"), JSON.stringify({ dependencies: { react: "1" } }));
  await writeFile(join(code, "alpha", "vercel.json"), "{}");
  await writeFile(join(code, "alpha", ".env"), "TOKEN=hunter2");
  await writeFile(join(code, "alpha", "src", "a.ts"), "x");
  execFileSync("git", ["init", "-q", "-b", "main", join(code, "alpha")], { env: GIT_ENV });
  execFileSync("git", ["-C", join(code, "alpha"), "remote", "add", "origin", "git@github.com:ACME-Inc/alpha.git"]);
  execFileSync("git", ["-C", join(code, "alpha"), "add", "README.md"], { env: GIT_ENV });
  execFileSync("git", ["-C", join(code, "alpha"), "commit", "-q", "-m", "init"], { env: GIT_ENV });
  // plain folder, an empty repo, hidden + node_modules (never listed), a credential-looking folder
  await mkdir(join(code, "plain"), { recursive: true });
  await writeFile(join(code, "plain", "README.md"), "# Plain\n");
  await mkdir(join(code, "fresh"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", join(code, "fresh")]);
  await mkdir(join(code, ".hidden"), { recursive: true });
  await mkdir(join(code, "node_modules"), { recursive: true });
  await mkdir(join(code, "api-keys-notes"), { recursive: true });
  await writeFile(join(code, "api-keys-notes", "README.md"), "# LEAKY README");
  await writeFile(join(code, "api-keys-notes", "package.json"), JSON.stringify({ dependencies: { next: "1" } }));
  // a district inside a privacy-guarded folder
  await mkdir(join(home, "Desktop", "scratch"), { recursive: true });
  await writeFile(join(home, "Desktop", "scratch", "README.md"), "# NEVER READ");
  return { home, code };
}

describe("projects feature: wired into a real server", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(over: Parameters<typeof createProjectsFeature>[0] = {}): Promise<{ base: string; home: string; code: string }> {
    const fx = await fixture();
    const feature = createProjectsFeature({
      home: fx.home,
      codeDir: fx.code,
      vaultProjectsDir: join(fx.home, "no-vault"),
      districts: () => ({
        districts: [
          { id: "alpha", name: "alpha", path: join(fx.code, "alpha"), sessions: 3, lastActive: new Date().toISOString() },
          { id: "scratch", name: "scratch", path: join(fx.home, "Desktop", "scratch"), sessions: 1, lastActive: null },
        ],
        skipped: 2,
      }),
      artifacts: () => [{ id: "abcdef12", url: "u", title: "Deck", origin: "published", islandId: "alpha", sessions: [], firstAt: null, lastAt: null, publishCount: 1, hasPreview: false }],
      ...over,
    });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    return { base: b.base, ...fx };
  }

  it("unions districts with Code folders: one entry per folder, dot-folders and node_modules left out", async () => {
    const { base } = await boot();
    const body = (await (await fetch(`${base}/api/projects`)).json()) as ProjectsResponse;
    const names = body.items.map((p) => p.name).sort();
    expect(names).toEqual(["alpha", "api-keys-notes", "fresh", "plain", "scratch"]);
    const alpha = body.items.find((p) => p.name === "alpha");
    expect(alpha).toMatchObject({ kind: "repo", islandId: "alpha", sessions: 3, readme: "Alpha tool", stack: ["react"], deploy: "vercel.json", stage: "building", category: "acme" });
    expect(alpha?.git).toMatchObject({ remote: "ACME-Inc/alpha", branch: "main", commits: 1 });
    expect(alpha?.artifacts).toEqual({ count: 1, items: [{ id: "abcdef12", title: "Deck" }] });
    expect(body.skipped).toBe(2);
  });

  it("an empty repo is an idea (not a timeout); a plain folder is a folder", async () => {
    const { base } = await boot();
    const body = (await (await fetch(`${base}/api/projects`)).json()) as ProjectsResponse;
    expect(body.items.find((p) => p.name === "fresh")).toMatchObject({ kind: "repo", stage: "idea" });
    expect(body.items.find((p) => p.name === "plain")).toMatchObject({ kind: "folder", readme: "Plain" });
    expect(body.timedOut).toBe(0);
  });

  it("matches a vault note by its code_path before the folder name (DATA-7)", async () => {
    const vault = await realpath(await mkdtemp(join(tmpdir(), "projects-vault-")));
    await mkdir(join(vault, "20-Projects", "alpha-research"), { recursive: true });
    await mkdir(join(vault, "20-Projects", "Plain"), { recursive: true });
    await writeFile(join(vault, "20-Projects", "alpha-research", "_index.md"), "---\ncode_path: /Users/someone-else/Documents/Code/alpha\n---\n");
    const { base } = await boot({ vaultProjectsDir: join(vault, "20-Projects") });
    const body = (await (await fetch(`${base}/api/projects`)).json()) as ProjectsResponse;
    expect(body.items.find((p) => p.name === "alpha")).toMatchObject({ vaultNote: "alpha-research", vaultMatch: "code_path" });
    expect(body.items.find((p) => p.name === "plain")).toMatchObject({ vaultNote: "Plain", vaultMatch: "name" });
    expect(body.items.find((p) => p.name === "fresh")).toMatchObject({ vaultNote: null, vaultMatch: null });
  });

  it("a missing ~/Documents/Code still lists the districts", async () => {
    const { base } = await boot({ codeDir: join(tmpdir(), "no-such-code-dir-for-projects-test") });
    const body = (await (await fetch(`${base}/api/projects`)).json()) as ProjectsResponse;
    expect(body.ok).toBe(true);
    expect(body.items.map((p) => p.name).sort()).toEqual(["alpha", "scratch"]);
  });

  it("never reads files in a credential-looking folder or anything in a privacy-guarded one", async () => {
    const { base } = await boot();
    const raw = await (await fetch(`${base}/api/projects`)).text();
    expect(raw).not.toContain("LEAKY");
    expect(raw).not.toContain("NEVER READ");
    const body = JSON.parse(raw) as ProjectsResponse;
    expect(body.items.find((p) => p.name === "api-keys-notes")).toMatchObject({ readme: null, stack: [], unread: false });
    expect(body.items.find((p) => p.name === "scratch")).toMatchObject({ unread: true, readme: null, git: null });
    expect(isCredentialName("api-keys-notes")).toBe(true);
    expect(isCredentialName("agent-world")).toBe(false);
  });

  it("single-flight and cache: concurrent requests share one scan, later ones read the cache", async () => {
    let scans = 0;
    const { base } = await boot({
      districts: () => {
        scans += 1;
        return { districts: [], skipped: 0 };
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/api/projects`).then((r) => r.text())));
    expect(scans).toBe(1);
    await fetch(`${base}/api/projects`).then((r) => r.text());
    expect(scans).toBe(1);
  });

  it("serves a stale list at once and refreshes in the background once the TTL passes", async () => {
    let scans = 0;
    let t = 1_000_000;
    const { base } = await boot({
      ttlMs: 1000,
      now: () => t,
      districts: () => {
        scans += 1;
        return { districts: [], skipped: 0 };
      },
    });
    await fetch(`${base}/api/projects`).then((r) => r.text());
    t += 5000;
    const stale = (await (await fetch(`${base}/api/projects`)).json()) as ProjectsResponse;
    expect(stale.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(scans).toBe(2);
  });

  it("folds a linked worktree, a stale worktree and a same-remote clone into the main card", async () => {
    const { base, code } = await boot({ gitTimeoutMs: 8_000 }); // the scan is lazy: the folders below exist before the first GET
    const alpha = join(code, "alpha");
    execFileSync("git", ["-C", alpha, "worktree", "add", "-q", "-b", "wt1", join(code, "alpha-wt")], { env: GIT_ENV });
    execFileSync("git", ["-C", alpha, "worktree", "add", "-q", "-b", "wt2", join(code, "alpha-stale")], { env: GIT_ENV });
    await rm(join(alpha, ".git", "worktrees", "alpha-stale"), { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", alpha, join(code, "alpha-copy")], { env: GIT_ENV });
    execFileSync("git", ["-C", join(code, "alpha-copy"), "remote", "set-url", "origin", "https://github.com/ACME-Inc/alpha.git"]);
    const again = base;
    const body = (await (await fetch(`${again}/api/projects`)).json()) as ProjectsResponse;
    const names = body.items.map((p) => p.name);
    expect(names).not.toContain("alpha-wt");
    expect(names).not.toContain("alpha-stale");
    expect(names).not.toContain("alpha-copy");
    const card = body.items.find((p) => p.name === "alpha");
    expect(card?.folded.map((f) => [f.name, f.kind]).sort()).toEqual([["alpha-copy", "clone"], ["alpha-stale", "worktree"], ["alpha-wt", "worktree"]]);
    expect(card?.folded.find((f) => f.name === "alpha-stale")?.reason).toContain("stale");
    expect(card?.folded.find((f) => f.name === "alpha-copy")?.reason).toContain("most sessions");
    expect(body.folded).toBe(3);
    expect(body.timedOut).toBe(0);
    // a folded folder is still browsable through its own id
    const wt = card?.folded.find((f) => f.name === "alpha-wt");
    expect((await fetch(`${again}/api/projects/${wt?.id}/tree`)).status).toBe(200);
  });

  describe("tree guard", () => {
    const tree = async (base: string, id: string, path?: string): Promise<{ status: number; body: ProjectTreeResponse | { ok: false; error: string } }> => {
      const url = `${base}/api/projects/${encodeURIComponent(id)}/tree${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`;
      const res = await fetch(url);
      return { status: res.status, body: (await res.json()) as ProjectTreeResponse };
    };

    it("lists one level: folders first, no .git, no secret-looking names", async () => {
      const { base } = await boot();
      const { status, body } = await tree(base, "alpha");
      expect(status).toBe(200);
      const names = (body as ProjectTreeResponse).entries.map((e) => e.name);
      expect(names).toContain("src");
      expect(names).toContain("README.md");
      expect(names).not.toContain(".git");
      expect(names).not.toContain(".env");
      expect((body as ProjectTreeResponse).entries[0]).toMatchObject({ name: "src", dir: true, size: null });
      const sub = await tree(base, "alpha", "src");
      expect((sub.body as ProjectTreeResponse).entries.map((e) => e.name)).toEqual(["a.ts"]);
    });

    it("refuses traversal, absolute paths, secret paths and unknown ids", async () => {
      const { base } = await boot();
      expect((await tree(base, "alpha", "../plain")).status).toBeGreaterThanOrEqual(400);
      expect((await tree(base, "alpha", "../../..")).status).toBeGreaterThanOrEqual(400);
      expect((await tree(base, "alpha", "/etc")).status).toBe(400);
      expect((await tree(base, "alpha", "~")).status).toBe(400);
      expect((await tree(base, "alpha", ".git")).status).toBe(403);
      expect((await tree(base, "alpha", "a\0b")).status).toBeGreaterThanOrEqual(400);
      expect((await tree(base, "nope")).status).toBe(404);
      expect((await tree(base, "Bad Id!")).status).toBe(400);
    });

    it("refuses a symlink that leaves the project, and a privacy-guarded project", async () => {
      const { base, code, home } = await boot();
      await symlink(join(home, "Desktop"), join(code, "alpha", "out"));
      expect((await tree(base, "alpha", "out")).status).toBe(403);
      expect((await tree(base, "scratch")).status).toBe(403);
    });

    it("refuses a project whose symlink resolves into a privacy-guarded folder", async () => {
      const { base, code, home } = await boot({ districts: undefined });
      await symlink(join(home, "Desktop", "scratch"), join(code, "plain", "link"));
      // the link is inside the project root, but its real folder is guarded
      expect((await tree(base, "plain", "link")).status).toBe(403);
    });
  });
});

describe("worldDistricts", () => {
  it("drops the harness, empty paths and $HOME; keeps repos", () => {
    const ctx = {
      worldViews: () => ({
        agents: [],
        objects: [],
        edges: [],
        islands: [
          { id: "harness", name: "Harness", path: "", agentCount: 0, lastActive: "" },
          { id: "home", name: "home", path: "/Users/me", agentCount: 9, lastActive: "" },
          { id: "repo", name: "repo", path: "/Users/me/Documents/Code/repo", agentCount: 2, lastActive: "2026-10-01T00:00:00Z" },
        ],
      }),
    } as unknown as FeatureContext;
    const r = worldDistricts(ctx, "/Users/me");
    expect(r.districts.map((d) => d.id)).toEqual(["repo"]);
    expect(r.skipped).toBe(2);
  });
});
