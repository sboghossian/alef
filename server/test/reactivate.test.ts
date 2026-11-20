import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildResumeCommand, createVsCodeExecutor, isValidUuid, type ReactivateExecutor, type VsCodeExecutorDeps } from "../reactivate.js";
import { startServer, type RunningServer } from "../index.js";
import { makeTempProjectsDir } from "./helpers.js";

describe("isValidUuid", () => {
  it("accepts a well-formed uuid", () => {
    expect(isValidUuid("11111111-1111-1111-1111-111111111111")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("../../etc/passwd")).toBe(false);
    expect(isValidUuid("")).toBe(false);
  });
});

describe("buildResumeCommand", () => {
  it("shell-quotes a cwd containing spaces and quotes", () => {
    const cmd = buildResumeCommand("/Users/x/My Project's Dir", "11111111-1111-1111-1111-111111111111");
    expect(cmd).toContain("cd '/Users/x/My Project'\\''s Dir'");
    expect(cmd).toContain("claude --resume '11111111-1111-1111-1111-111111111111'");
  });
});

describe("createVsCodeExecutor (fake deps — never launches VS Code)", () => {
  function deps(over: Partial<VsCodeExecutorDeps> & { executable?: Set<string>; execImpl?: VsCodeExecutorDeps["exec"] } = {}): {
    deps: VsCodeExecutorDeps;
    calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }>;
  } {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const executable = over.executable ?? new Set<string>();
    const exec: VsCodeExecutorDeps["exec"] = async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      if (over.execImpl) return over.execImpl(file, args, timeoutMs);
    };
    return {
      calls,
      deps: {
        pathDirs: over.pathDirs ?? (() => []),
        isExecutable: over.isExecutable ?? (async (p) => executable.has(p)),
        exec,
        homeDir: over.homeDir ?? "/Users/fake",
      },
    };
  }

  it("prefers a `code` found on PATH, called with argv only and a 5s timeout", async () => {
    const { deps: d, calls } = deps({ pathDirs: () => ["/usr/local/bin", "/opt/homebrew/bin"], executable: new Set(["/opt/homebrew/bin/code"]) });
    await createVsCodeExecutor(d)("/ws/project");
    expect(calls).toEqual([{ file: "/opt/homebrew/bin/code", args: ["/ws/project"], timeoutMs: 5000 }]);
  });

  it("falls back to the GUI app's CLI shim under /Applications when PATH has no `code`", async () => {
    const shim = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const { deps: d, calls } = deps({ pathDirs: () => ["/usr/local/bin"], executable: new Set([shim]) });
    await createVsCodeExecutor(d)("/ws/todo.md");
    expect(calls).toEqual([{ file: shim, args: ["/ws/todo.md"], timeoutMs: 5000 }]);
  });

  it("falls back to the shim under ~/Applications when neither PATH nor /Applications has it", async () => {
    const shim = "/Users/fake/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const { deps: d, calls } = deps({ homeDir: "/Users/fake", executable: new Set([shim]) });
    await createVsCodeExecutor(d)("/ws/SKILL.md");
    expect(calls).toEqual([{ file: shim, args: ["/ws/SKILL.md"], timeoutMs: 5000 }]);
  });

  it("falls back to `open -a \"Visual Studio Code\"` when no code binary is found anywhere", async () => {
    const { deps: d, calls } = deps();
    await createVsCodeExecutor(d)("/ws/project");
    expect(calls).toEqual([{ file: "open", args: ["-a", "Visual Studio Code", "/ws/project"], timeoutMs: 5000 }]);
  });

  it("throws an honest error when even `open` fails", async () => {
    const { deps: d } = deps({ execImpl: () => Promise.reject(new Error("spawn open ENOENT")) });
    await expect(createVsCodeExecutor(d)("/ws/project")).rejects.toThrow(
      "VS Code isn't installed: no code command, and macOS couldn't open Visual Studio Code.",
    );
  });
});

describe("POST /api/reactivate/:agentId (integration, fake executor — never opens Terminal)", () => {
  let server: RunningServer | null = null;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function boot(executor: ReactivateExecutor): Promise<{ base: string; server: RunningServer }> {
    const dir = await makeTempProjectsDir();
    tmpDirs.push(dir);
    const s = await startServer({
      projectsDir: join(dir, "projects"),
      claudeDir: join(dir, "no-claude-dir"),
      claudeJsonPath: join(dir, "no-claude.json"),
      dbPath: join(dir, "world.db"),
      port: 0,
      reactivateExecutor: executor,
      dispatchExecutor: () => {
        throw new Error("dispatchExecutor must not be called in this test");
      },
      openEditorExecutor: () => {
        throw new Error("openEditorExecutor must not be called in this test");
      },
      typesafeApiKey: "", // never touch a real TYPESAFE_API_KEY that happens to be set on this host
    });
    server = s;
    return { base: `http://127.0.0.1:${s.port}`, server: s };
  }

  it("rejects a non-uuid agent id with 400, without calling the executor", async () => {
    const calls: Array<[string, string]> = [];
    const { base } = await boot((cwd, id) => {
      calls.push([cwd, id]);
    });

    const res = await fetch(`${base}/api/reactivate/not-a-uuid`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown (but well-formed) agent id with 404", async () => {
    const calls: Array<[string, string]> = [];
    const { base } = await boot((cwd, id) => {
      calls.push([cwd, id]);
    });

    const res = await fetch(`${base}/api/reactivate/99999999-9999-9999-9999-999999999999`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("calls the injected executor (never a real Terminal) for a known session and returns ok", async () => {
    const calls: Array<[string, string]> = [];
    const { base, server: s } = await boot((cwd, id) => {
      calls.push([cwd, id]);
    });

    const agentId = "abcdefab-1234-1234-1234-1234567890ab";
    s.db.setIslandForCwd("/ws/known-project", "known-project");
    s.db.upsertSession({
      id: agentId,
      cwd: "/ws/known-project",
      islandId: "known-project",
      title: "test session",
      startedAt: "2026-09-20T00:00:00.000Z",
      lastActive: "2026-09-20T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
    });

    const res = await fetch(`${base}/api/reactivate/${agentId}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agentId: string };
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agentId);
    expect(calls).toEqual([["/ws/known-project", agentId]]);
  });

  it("GET /api/health reports ok and a session count", async () => {
    const { base } = await boot(() => {});
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; indexedSessions: number };
    expect(body.ok).toBe(true);
    expect(body.indexedSessions).toBe(0);
  });
});
