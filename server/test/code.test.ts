import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeDiffResponse, CodeFileResponse, CodeStatusResponse, CodeTouchedResponse, CodeTreeResponse } from "../../shared/features/code.js";
import { createCodeFeature, parsePorcelainZ, type GitRunner } from "../features/code.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { assistantLine, bootTestServer, userLine, writeSessionFile } from "./helpers.js";

const AGENT = "11111111-2222-4333-8444-555555555555";
const HOME_AGENT = "22222222-2222-4333-8444-555555555555";
const HOME_WORKER = "44444444-2222-4333-8444-555555555555";

interface GitCall {
  root: string;
  args: readonly string[];
}

describe("code", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function setup(): Promise<{ base: string; repo: string; repo2: string; outside: string; gitCalls: GitCall[] }> {
    const scratch = await mkdtemp(join(tmpdir(), "aw-code-"));
    const repo = join(scratch, "repo");
    const outside = join(scratch, "outside");
    const fakeHome = join(scratch, "home");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "node_modules", "x"), { recursive: true });
    await mkdir(join(repo, "dist"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    const repo2 = join(fakeHome, "code", "lib");
    await mkdir(join(repo2, ".git"), { recursive: true });
    await writeFile(join(repo2, "x.ts"), "export const x = 1;\n");
    await writeFile(join(repo2, "y.ts"), "export const y = 1;\n");
    await writeFile(join(repo, "src", "a.ts"), 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\n');
    await writeFile(join(repo, "README.md"), "# hi\n");
    await writeFile(join(repo, "node_modules", "x", "i.js"), "x");
    await writeFile(join(repo, "dist", "o.js"), "x");
    await writeFile(join(repo, ".env"), "SECRET=1");
    await writeFile(join(repo, "id_rsa"), "-----BEGIN");
    await writeFile(join(repo, "server.pem"), "pem");
    await writeFile(join(repo, "big.txt"), "x".repeat(600 * 1024));
    await writeFile(join(repo, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(join(outside, "passwd"), "root:x:0:0");
    await symlink(join(outside, "passwd"), join(repo, "leak.txt"));
    await symlink(outside, join(repo, "leakdir"));

    const gitCalls: GitCall[] = [];
    const git: GitRunner = async (root, args) => {
      gitCalls.push({ root, args });
      if (args[0] === "diff") return "diff --git a/src/a.ts b/src/a.ts\n+token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n";
      if (args[0] === "rev-parse") return "feat/x\n";
      if (args[0] === "status") return " M src/a.ts\0?? new.txt\0R  b.ts\0a.ts\0";
      return "";
    };
    const b = await bootTestServer({ configOverrides: { features: [createCodeFeature(git, fakeHome)] } });
    server = b.server;
    const projects = join(b.dir, "projects");
    const now = new Date().toISOString();
    await writeSessionFile(
      projects,
      "-repo",
      AGENT,
      [
        userLine({ cwd: repo, timestamp: now, text: "fix it" }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Read", input: { file_path: join(repo, "src", "a.ts") } }] }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Edit", input: { file_path: join(repo, "src", "a.ts"), old_string: "a", new_string: "b" } }] }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Write", input: { file_path: "/tmp/elsewhere.md", content: "x" } }] }),
      ].join("\n") + "\n",
    );
    await writeSessionFile(projects, "-home", HOME_AGENT, userLine({ cwd: fakeHome, timestamp: now, text: "hi" }) + "\n");
    // cwd = $HOME, but it worked in two repos: lib (2 files) and repo (1 file)
    await writeSessionFile(
      projects,
      "-home2",
      HOME_WORKER,
      [
        userLine({ cwd: fakeHome, timestamp: now, text: "work" }),
        assistantLine({ cwd: fakeHome, timestamp: now, toolUses: [{ name: "Read", input: { file_path: join(repo2, "x.ts") } }] }),
        assistantLine({ cwd: fakeHome, timestamp: now, toolUses: [{ name: "Edit", input: { file_path: "code/lib/y.ts", old_string: "1", new_string: "2" } }] }),
        assistantLine({ cwd: fakeHome, timestamp: now, toolUses: [{ name: "Read", input: { file_path: join(repo, "README.md") } }] }),
        assistantLine({ cwd: fakeHome, timestamp: now, toolUses: [{ name: "Read", input: { file_path: join(fakeHome, "notes.md") } }] }),
      ].join("\n") + "\n",
    );
    await runIndexPass(b.server.db, { projectsDir: projects });
    return { base: b.base, repo, repo2, outside, gitCalls };
  }

  const get = async <T>(base: string, path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };

  it("lists the tree without node_modules/.git/dist and marks secret files", async () => {
    const { base } = await setup();
    const { status, body } = await get<CodeTreeResponse>(base, `/api/code/${AGENT}/tree`);
    expect(status).toBe(200);
    const paths = body.entries.map((e) => e.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.startsWith("node_modules") || p.startsWith("dist") || p.startsWith(".git/"))).toBe(false);
    expect(body.entries.find((e) => e.path === ".env")?.blocked).toBe(true);
    expect(body.entries.find((e) => e.path === "leakdir")?.type).toBe("symlink");
    const sub = await get<CodeTreeResponse>(base, `/api/code/${AGENT}/tree?path=src`);
    expect(sub.body.entries.map((e) => e.path)).toEqual(["src/a.ts"]);
  });

  it("serves text files with secrets redacted", async () => {
    const { base } = await setup();
    const { status, body } = await get<CodeFileResponse>(base, `/api/code/${AGENT}/file?path=src/a.ts`);
    expect(status).toBe(200);
    expect(body.language).toBe("ts");
    expect(body.content).not.toContain("sk-ant-api03");
  });

  it("blocks traversal, absolute paths and symlink escapes", async () => {
    const { base, outside } = await setup();
    expect((await get(base, `/api/code/${AGENT}/file?path=../outside/passwd`)).status).toBe(403);
    expect((await get(base, `/api/code/${AGENT}/file?path=src/../../outside/passwd`)).status).toBe(403);
    expect((await get(base, `/api/code/${AGENT}/file?path=${encodeURIComponent(join(outside, "passwd"))}`)).status).toBe(400);
    expect((await get(base, `/api/code/${AGENT}/file?path=/etc/passwd`)).status).toBe(400);
    expect((await get(base, `/api/code/${AGENT}/file?path=leak.txt`)).status).toBe(403);
    expect((await get(base, `/api/code/${AGENT}/file?path=leakdir/passwd`)).status).toBe(403);
    expect((await get(base, `/api/code/${AGENT}/tree?path=..`)).status).toBe(403);
    expect((await get(base, `/api/code/${AGENT}/diff?path=../outside/passwd`)).status).toBe(403);
  });

  it("refuses secret files entirely", async () => {
    const { base } = await setup();
    for (const p of [".env", "id_rsa", "server.pem"]) {
      expect((await get(base, `/api/code/${AGENT}/file?path=${p}`)).status, p).toBe(403);
      expect((await get(base, `/api/code/${AGENT}/diff?path=${p}`)).status, p).toBe(403);
    }
  });

  it("refuses binaries (415) and files over 512KB (413)", async () => {
    const { base } = await setup();
    expect((await get(base, `/api/code/${AGENT}/file?path=img.bin`)).status).toBe(415);
    expect((await get(base, `/api/code/${AGENT}/file?path=big.txt`)).status).toBe(413);
  });

  it("lists files the session touched, with counts and last tool", async () => {
    const { base } = await setup();
    const { body } = await get<CodeTouchedResponse>(base, `/api/code/${AGENT}/touched`);
    const a = body.files.find((f) => f.path === "src/a.ts");
    expect(a).toMatchObject({ insideRepo: true, count: 2, edits: 1, lastTool: "Edit" });
    expect(body.files.find((f) => f.path === "/tmp/elsewhere.md")?.insideRepo).toBe(false);
    expect(body.files[0]?.path).toBe("/tmp/elsewhere.md"); // most recent first
  });

  it("diffs with an argv (path after --) and redacts; status parses porcelain -z", async () => {
    const { base, repo, gitCalls } = await setup();
    const diff = await get<CodeDiffResponse>(base, `/api/code/${AGENT}/diff?path=src/a.ts`);
    expect(diff.status).toBe(200);
    expect(diff.body.diff).not.toContain("sk-ant-api03");
    const call = gitCalls.find((c) => c.args[0] === "diff");
    expect(call?.root).toBe(repo);
    expect(call?.args.slice(-2)).toEqual(["--", "src/a.ts"]);
    const st = await get<CodeStatusResponse>(base, `/api/code/${AGENT}/status`);
    expect(st.body).toMatchObject({ git: true, branch: "feat/x" });
    expect(st.body.dirty).toEqual([
      { path: "src/a.ts", status: " M" },
      { path: "new.txt", status: "??" },
      { path: "b.ts", status: "R " },
    ]);
  });

  it("refuses an agent whose folder is the home dir, and bad ids", async () => {
    const { base } = await setup();
    expect((await get(base, `/api/code/${HOME_AGENT}/tree`)).status).toBe(409);
    expect((await get(base, `/api/code/not-a-uuid/tree`)).status).toBe(400);
    expect((await get(base, `/api/code/33333333-2222-4333-8444-555555555555/tree`)).status).toBe(404);
  });

  it("serves a $HOME session the repos it touched: most touched by default, others via ?repo=", async () => {
    const { base, repo, repo2, outside } = await setup();
    const tree = await get<CodeTreeResponse>(base, `/api/code/${HOME_WORKER}/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body.root).toBe(repo2);
    expect(tree.body.repos).toEqual([
      { root: repo2, label: "lib", files: 2, git: true },
      { root: repo, label: "repo", files: 1, git: true },
    ]);
    expect(tree.body.entries.map((e) => e.path)).toEqual(["x.ts", "y.ts"]);
    const touched = await get<CodeTouchedResponse>(base, `/api/code/${HOME_WORKER}/touched?repo=${encodeURIComponent(repo2)}`);
    expect(touched.body.files.filter((f) => f.insideRepo).map((f) => f.path).sort()).toEqual(["x.ts", "y.ts"]);
    const other = await get<CodeTreeResponse>(base, `/api/code/${HOME_WORKER}/tree?repo=${encodeURIComponent(repo)}`);
    expect(other.body.root).toBe(repo);
    expect((await get<CodeFileResponse>(base, `/api/code/${HOME_WORKER}/file?repo=${encodeURIComponent(repo)}&path=README.md`)).body.content).toBe("# hi\n");
    // Same safety rules inside a chosen repo…
    expect((await get(base, `/api/code/${HOME_WORKER}/file?repo=${encodeURIComponent(repo)}&path=.env`)).status).toBe(403);
    expect((await get(base, `/api/code/${HOME_WORKER}/file?repo=${encodeURIComponent(repo)}&path=leak.txt`)).status).toBe(403);
    expect((await get(base, `/api/code/${HOME_WORKER}/file?repo=${encodeURIComponent(repo2)}&path=../../../repo/README.md`)).status).toBe(403);
    // …and a repo the session never touched (or $HOME itself) is refused.
    expect((await get(base, `/api/code/${HOME_WORKER}/tree?repo=${encodeURIComponent(outside)}`)).status).toBe(403);
    expect((await get(base, `/api/code/${HOME_WORKER}/tree?repo=${encodeURIComponent(join(repo2, ".."))}`)).status).toBe(403);
    expect((await get(base, `/api/code/${HOME_WORKER}/tree?repo=relative/path`)).status).toBe(400);
    expect((await get(base, `/api/code/${AGENT}/tree?repo=${encodeURIComponent(repo2)}`)).status).toBe(403); // another session's repo
  });

  it("parsePorcelainZ caps", () => {
    const out = Array.from({ length: 10 }, (_, i) => ` M f${i}`).join("\0") + "\0";
    const r = parsePorcelainZ(out, 3);
    expect(r.files).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});
