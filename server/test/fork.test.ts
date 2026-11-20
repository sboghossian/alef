// "fork" feature tests. Everything runs against throwaway git repos under the OS temp dir with
// a stubbed home (its own ~/.claude, vault, dashable configs, ~/.alef-worktrees). The real
// home, gh, tmux, lsof and claude are never touched: gh, the launcher and the port lookup are stubs.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ForkRemoveResult, ForkResult, ForkStatusResponse } from "../../shared/features/fork.js";
import { createForkFeature, PLAN_COMMAND, worldPlanLauncher, type ForkLauncher } from "../features/fork.js";
import {
  deniedReason,
  isReadOnlyGitArgs,
  loadDenyRules,
  parseCloudflaredIngress,
  parsePrJson,
  parseServicesYml,
  parseStatusV2,
  realForkGit,
  slugify,
  type GhPrView,
} from "../features/fork-lib.js";
import type { FeatureContext } from "../features/registry.js";
import { createTalkFeature, withoutParentSessionEnv, type TalkExec } from "../features/talk.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { bootTestServer, userLine } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-C", cwd, ...args], { encoding: "utf8" });
}

async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  await writeFile(join(dir, "README.md"), "hi\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const PR_JSON = JSON.stringify({
  number: 42,
  state: "OPEN",
  title: "Add the thing\u0007",
  url: "https://github.com/o/r/pull/42",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", context: "vercel", state: "SUCCESS" },
  ],
});

const ids = {
  app: "11111111-1111-4111-8111-111111111111",
  skills: "22222222-2222-4222-8222-222222222222",
  vault: "33333333-3333-4333-8333-333333333333",
  acme: "44444444-4444-4444-8444-444444444444",
  acmeWt: "55555555-5555-4555-8555-555555555555",
  svc: "66666666-6666-4666-8666-666666666666",
  mono: "77777777-7777-4777-8777-777777777777",
  port: "88888888-8888-4888-8888-888888888888",
  shared: "99999999-9999-4999-8999-999999999999",
  nogit: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("fork feature", () => {
  let tmp = "";
  let home = "";
  let base = "";
  let server: RunningServer | null = null;
  const live = new Map<string, number>();
  const launches: string[] = [];
  const ghCalls: string[] = [];
  const repos: Record<keyof typeof ids, string> = { app: "", skills: "", vault: "", acme: "", acmeWt: "", svc: "", mono: "", port: "", shared: "", nogit: "" };

  const gh: GhPrView = async (cwd, branch) => {
    ghCalls.push(`${cwd}@${branch}`);
    return { ok: true, stdout: PR_JSON };
  };
  const launcher: ForkLauncher = async (cwd) => {
    launches.push(cwd);
    return { ok: true, tmuxName: "aw-deadbeef" };
  };

  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "alef-fork-test-")));
    home = join(tmp, "home");
    const code = join(home, "Documents", "Code");
    repos.app = await makeRepo(join(tmp, "repos", "app"));
    repos.skills = await makeRepo(join(home, ".claude", "skills-repo"));
    repos.vault = await makeRepo(join(code, "alex_claude"));
    repos.acme = await makeRepo(join(tmp, "elsewhere", "acme-ai-next"));
    repos.acmeWt = await makeRepo(join(home, ".acme-worktrees", "feat-x"));
    repos.svc = await makeRepo(join(code, "livesvc"));
    repos.mono = await makeRepo(join(code, "mono"));
    await mkdir(join(repos.mono, "backend"), { recursive: true });
    repos.port = await makeRepo(join(tmp, "elsewhere", "portsvc"));
    repos.shared = await makeRepo(join(tmp, "repos", "shared"));
    await mkdir(join(repos.shared, "sub"), { recursive: true });
    repos.nogit = join(tmp, "repos", "plain");
    await mkdir(repos.nogit, { recursive: true });

    await mkdir(join(home, ".dashable"), { recursive: true });
    await mkdir(join(home, ".cloudflared", "dashable"), { recursive: true });
    await writeFile(
      join(home, ".dashable", "services.yml"),
      ["services:", "  # a comment", "  - host: svc", "    port: 4100", "    dir: livesvc", "", "  - host: mono-api", "    port: 4200", "    dir: mono/backend  # trailing comment", ""].join("\n"),
    );
    await writeFile(
      join(home, ".cloudflared", "dashable", "config.yml"),
      ["ingress:", "  - hostname: svc.dashable.dev", "    service: http://127.0.0.1:4100", "  - hostname: mystery.dashable.dev", "    service: http://127.0.0.1:4999", "  - service: http_status:404", ""].join("\n"),
    );

    const feature = createForkFeature({
      home,
      gh,
      launcher,
      portCwds: async (ports) => new Map(ports.includes(4999) ? [[4999, repos.port]] : []),
      dataFile: join(tmp, "data", "fork-worktrees.json"),
    });
    const b = await bootTestServer({ configOverrides: { features: [feature], liveDetector: () => new Map(live) } });
    server = b.server;
    base = b.base;
    const projects = join(b.dir, "projects");
    for (const [key, id] of Object.entries(ids)) {
      const cwd = repos[key as keyof typeof ids];
      const proj = join(projects, `-${key}`);
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, `${id}.jsonl`), userLine({ cwd, timestamp: new Date().toISOString(), text: `Fix the ${key} bug!` }) + "\n");
    }
    await runIndexPass(b.server.db, { projectsDir: projects });
  });

  afterAll(async () => {
    await server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const fork = async (id: string, body: unknown = {}): Promise<{ status: number; body: ForkResult }> => {
    const r = await post(`/api/fork/${id}/fork`, body);
    return { status: r.status, body: (await r.json()) as ForkResult };
  };

  async function settledStatus(id: string): Promise<ForkStatusResponse> {
    for (let i = 0; i < 100; i++) {
      const r = (await (await fetch(`${base}/api/fork/${id}`)).json()) as ForkStatusResponse;
      if (r.ok && !r.pending && r.status) return r;
      await new Promise((res) => setTimeout(res, 30));
    }
    throw new Error("status never settled");
  }

  it("reports branch, dirty count and the PR (gh stub) off the request path", async () => {
    await writeFile(join(repos.app, "scratch.txt"), "x");
    const first = (await (await fetch(`${base}/api/fork/${ids.app}`)).json()) as ForkStatusResponse;
    expect(first.ok && first.pending).toBe(true);
    const r = await settledStatus(ids.app);
    if (!r.ok || !r.status) throw new Error("no status");
    expect(r.root).toBe(repos.app);
    expect(r.status.branch).toBe("main");
    expect(r.status.dirty).toBe(1);
    expect(r.status.pr).toMatchObject({ number: 42, state: "OPEN", title: "Add the thing", checks: "pending", passed: 2, pending: 1 });
    expect(r.status.forkable).toEqual({ ok: true });
    expect(ghCalls).toContain(`${repos.app}@main`);
    await rm(join(repos.app, "scratch.txt"));
  });

  it("a folder that is not a git repo answers 409", async () => {
    expect((await fetch(`${base}/api/fork/${ids.nogit}`)).status).toBe(409);
  });

  it("validates inputs", async () => {
    expect((await fork("not-a-uuid")).status).toBe(400);
    expect((await fork(ids.app, { base: "-rf" })).status).toBe(400);
    expect((await fork(ids.app, { base: "a b" })).status).toBe(400);
    expect((await fork(ids.app, { launch: "yes" })).status).toBe(400);
    expect((await fork(ids.app, { repo: repos.skills })).status).toBe(403);
    expect((await fork(ids.app, { base: "no-such-branch" })).status).toBe(400);
    expect((await fork("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).status).toBe(404);
    const bad = await fetch(`${base}/api/fork/${ids.app}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("forks into ~/.alef-worktrees, launches through the launcher, and removes only when clean", async () => {
    const out = await fork(ids.app, { launch: true });
    expect(out.status).toBe(200);
    if (!out.body.ok) throw new Error(out.body.error);
    const f = out.body.fork;
    expect(f.path.startsWith(join(home, ".alef-worktrees", "app") + "/")).toBe(true);
    expect(f.branch).toMatch(/^fork\/fix-the-app-bug-[0-9a-f]{6}$/);
    expect(f.path.endsWith(f.branch.slice("fork/".length))).toBe(true);
    expect(f.repoRoot).toBe(repos.app);
    expect(out.body.launched).toBe(true);
    expect(f.tmuxName).toBe("aw-deadbeef");
    expect(launches).toEqual([f.path]);
    expect(git(repos.app, "worktree", "list", "--porcelain")).toContain(f.path);
    const saved = JSON.parse(await readFile(join(tmp, "data", "fork-worktrees.json"), "utf8")) as unknown[];
    expect(saved).toHaveLength(1);

    const st = await settledStatus(ids.app);
    expect(st.ok && st.status?.forks.map((x) => x.id)).toEqual([f.id]);

    // Dirty (untracked) → refused, the worktree stays.
    await writeFile(join(f.path, "wip.txt"), "wip");
    const dirty = await post("/api/fork/remove", { id: f.id });
    expect(dirty.status).toBe(409);
    expect(((await dirty.json()) as ForkRemoveResult).ok).toBe(false);
    expect(existsSync(f.path)).toBe(true);

    // A live session inside it → refused.
    await rm(join(f.path, "wip.txt"));
    live.set(f.path, 123);
    expect((await post("/api/fork/remove", { id: f.id })).status).toBe(409);
    live.clear();

    const ok = await post("/api/fork/remove", { id: f.id });
    expect(ok.status).toBe(200);
    expect(existsSync(f.path)).toBe(false);
    expect(git(repos.app, "branch", "--list", f.branch).trim()).not.toBe(""); // branch kept
    expect(JSON.parse(await readFile(join(tmp, "data", "fork-worktrees.json"), "utf8"))).toEqual([]);
  });

  it("remove refuses ids Alef did not create, and malformed ones", async () => {
    expect((await post("/api/fork/remove", { id: "0123456789ab" })).status).toBe(404);
    expect((await post("/api/fork/remove", { id: "../../etc" })).status).toBe(400);
  });

  describe("deny list (each rule)", () => {
    const denied = async (key: keyof typeof ids, status: number, needle: RegExp): Promise<void> => {
      const out = await fork(ids[key]);
      expect(out.status).toBe(status);
      if (out.body.ok) throw new Error("fork was allowed");
      expect(out.body.error).toMatch(needle);
    };
    it("~/.claude (skills-repo)", () => denied("skills", 403, /\.claude/));
    it("the vault", () => denied("vault", 403, /vault/));
    it("acme-ai-next anywhere in the path", () => denied("acme", 403, /acme-ai-next/));
    it("~/.acme-worktrees", () => denied("acmeWt", 403, /acme-ai-next worktrees/));
    it("a services.yml always-live dir", () => denied("svc", 403, /svc\.dashable\.dev/));
    it("a repo that contains an always-live dir", () => denied("mono", 403, /contains always-live service mono-api/));
    it("the cwd of the process on a tunnelled port (config.yml)", () => denied("port", 403, /mystery\.dashable\.dev/));
    it("a repo with another live claude session, but not the session's own cwd", async () => {
      live.set(join(repos.shared, "sub"), 999);
      await denied("shared", 409, /another live claude session/);
      live.clear();
      live.set(repos.shared, 1000); // the agent's own cwd
      const out = await fork(ids.shared);
      live.clear();
      expect(out.status).toBe(200);
      if (out.body.ok) {
        const rm1 = await post("/api/fork/remove", { id: out.body.fork.id });
        expect(rm1.status).toBe(200);
      }
    });
    it("shows the refusal in the status too", async () => {
      const r = await settledStatus(ids.vault);
      expect(r.ok && r.status?.forkable.ok).toBe(false);
    });
    it("never created a worktree for a denied repo", () => {
      for (const k of ["skills", "vault", "acme", "acmeWt", "svc", "mono", "port"] as const) {
        expect(git(repos[k], "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
      }
    });
  });

  it("fails closed when only one dashable config exists", async () => {
    const h2 = join(tmp, "home2");
    await mkdir(join(h2, ".dashable"), { recursive: true });
    await writeFile(join(h2, ".dashable", "services.yml"), "services:\n  - host: a\n    port: 1\n    dir: a\n");
    const load = await loadDenyRules(
      { home: h2, servicesYml: join(h2, ".dashable", "services.yml"), cloudflaredConfig: join(h2, "nope.yml"), vault: join(h2, "v") },
      async () => new Map(),
    );
    expect(load.ok).toBe(false);
  });
});

describe("fork-lib", () => {
  it("parses services.yml and the cloudflared ingress", () => {
    expect(parseServicesYml("services:\n  - host: a\n    port: 1\n    dir: x/y # c\n  - host: 'b'\n    dir: \"/abs\"\n")).toEqual([
      { host: "a", port: 1, dir: "x/y" },
      { host: "b", port: null, dir: "/abs" },
    ]);
    expect(parseCloudflaredIngress("ingress:\n  - hostname: a.d\n    service: http://127.0.0.1:3000\n  - service: http_status:404\n")).toEqual([{ host: "a.d", port: 3000 }]);
  });

  it("deniedReason covers inside, contains, and $HOME", () => {
    const rules = [{ dir: "/h/.claude", reason: "claude" }];
    expect(deniedReason(["/h/.claude/x"], rules, "/h")).toMatch(/inside claude/);
    expect(deniedReason(["/h"], rules, "/h")).toMatch(/not a project/);
    expect(deniedReason(["/h/code/ok"], rules, "/h")).toBeNull();
  });

  it("parses porcelain v2 status and gh PR json", () => {
    const st = parseStatusV2("# branch.oid abc\n# branch.head feat\n# branch.upstream origin/feat\n# branch.ab +2 -3\n1 .M N... 100644 100644 100644 a b f.ts\n? new.txt\n");
    expect(st).toEqual({ branch: "feat", upstream: "origin/feat", ahead: 2, behind: 3, dirty: 2 });
    expect(parseStatusV2("# branch.head (detached)\n").branch).toBeNull();
    expect(parsePrJson(JSON.stringify({ number: 1, url: "javascript:alert(1)" }))).toBeNull();
    expect(parsePrJson(JSON.stringify({ number: 1, url: "https://x/1", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))?.checks).toBe("failure");
  });

  it("the read-only git runner refuses write subcommands", async () => {
    expect(isReadOnlyGitArgs(["status"])).toBe(true);
    expect(isReadOnlyGitArgs(["worktree", "list"])).toBe(true);
    for (const a of [["push"], ["reset", "--hard"], ["checkout", "x"], ["worktree", "remove"], ["branch", "-D", "x"], ["stash"]]) {
      expect(isReadOnlyGitArgs(a)).toBe(false);
      await expect(realForkGit.read(tmpdir(), a)).rejects.toThrow(/read-only/);
    }
  });

  it("slugify", () => {
    expect(slugify("Fix the login bug!")).toBe("fix-the-login-bug");
    expect(slugify("---")).toBe("");
  });

  it("the world launcher starts a constant plan-mode command through talk, bound for talk/interrupt", async () => {
    const runs: (readonly string[])[] = [];
    const terminals: string[] = [];
    const exec: TalkExec = {
      findTmux: async () => "/bin/tmux",
      run: async (_f, args) => {
        runs.push(args);
      },
      capture: async () => "",
      captureAll: async () => "",
      startCommand: async () => "",
      paneCounts: async () => "1 1",
      openTerminal: (c) => {
        terminals.push(c);
      },
    };
    const meta = new Map<string, string>();
    const sent: unknown[] = [];
    const ctx = {
      db: { getMeta: (k: string) => meta.get(k) ?? null, setMeta: (k: string, v: string) => void meta.set(k, v) },
      broadcast: (m: unknown) => void sent.push(m),
    } as unknown as FeatureContext;
    // An instant sleep: its blank fake pane keeps the launch's startup-dialog watch polling to the end.
    createTalkFeature(exec, undefined, undefined, { sleep: async () => {} });
    const out = await worldPlanLauncher("/w/t", ctx);
    expect(out.ok).toBe(true);
    expect(runs[0]).toEqual(["new-session", "-d", "-s", expect.stringMatching(/^aw-[0-9a-f]{8}$/), "-c", "/w/t", withoutParentSessionEnv(PLAN_COMMAND)]);
    expect(terminals[0]).toMatch(/attach -t '=aw-/);
    expect(JSON.parse(meta.get("talk.bindings") ?? "[]")).toEqual([expect.objectContaining({ agentId: null, cwd: "/w/t" })]);
    expect(sent[0]).toMatchObject({ type: "feature", feature: "talk" });
    createTalkFeature({ ...exec, findTmux: async () => null });
    expect((await worldPlanLauncher("/w/t", ctx)).ok).toBe(false);
  });
});
