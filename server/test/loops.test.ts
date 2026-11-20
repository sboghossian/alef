// Route-level tests for the Loops feature (H2). Invokes route handlers directly (the pattern
// feed.test.ts uses for a background-refresh feature) instead of a real HTTP server: `onTick`
// is awaited directly to force one deterministic rescan of synthetic fixtures, then each route's
// handler is called with a fake req/res. NEVER launches a real claude/tmux session: the launcher
// is always a stub here (loops-launch.test.ts covers the real worldPlanLoopsLauncher wiring).
// Folder trust reads a temp ~/.claude.json fixture, never the real one.

import type { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPS_NOT_READY_ERROR, type LoopsActionResult } from "../../shared/features/loops.js";
import { LAUNCH_REPEAT_WINDOW_MS } from "../../shared/features/talk.js";
import { resetFixesStoresForTests } from "../features/fixes-store.js";
import { createLoopsFeature, latestLoopsBoard } from "../features/loops.js";
import type { LoopsLaunchResult, LoopsLauncher } from "../features/loops-launch.js";
import type { FeatureContext, Route } from "../features/registry.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function fakeRes(): { res: ServerResponse; status: () => number; json: <T>() => T } {
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    end(data: string) {
      body = data;
    },
  };
  return { res: res as unknown as ServerResponse, status: () => statusCode, json: <T>() => JSON.parse(body) as T };
}

function fakeCtx(openEditorCalls: string[], claudeJsonPath = "/nonexistent/.claude.json"): FeatureContext {
  const ctx = {
    featureId: "loops",
    emit: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { claudeJsonPath },
    executors: {
      openEditor: async (cwd: string) => {
        openEditorCalls.push(cwd);
      },
      reactivate: async () => {},
      dispatch: async () => {},
    },
  };
  return ctx as unknown as FeatureContext;
}

async function call<T>(route: Route | undefined, ctx: FeatureContext, id: string): Promise<{ status: number; body: T }> {
  if (!route) throw new Error("route not found");
  const { res, status, json } = fakeRes();
  await route.handler({} as never, res, ctx, { id });
  return { status: status(), body: json<T>() };
}

describe("loops routes", () => {
  let home = "";
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  async function setup(launcher: LoopsLauncher, opts: { scan?: boolean; claudeJson?: (codeDir: string) => unknown } = {}, now?: () => number) {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    // realpath now (macOS: /tmp -> /private/tmp) so paths built from `home` already match what
    // the routes' own realpath-based safe-path checks (resolveInside) will return.
    home = await realpath(home);
    const codeDir = join(home, "Documents", "Code");
    await mkdir(join(codeDir, "demo", "tasks"), { recursive: true });
    await writeFile(join(codeDir, "demo", "tasks", "todo.md"), "## Open\n- [ ] Ship the thing\n", "utf8");

    const whatsupPath = join(home, "todos.json");
    await writeFile(
      whatsupPath,
      JSON.stringify({
        generated: "2026-09-25T08:00",
        items: [
          // matches the scan item above -> merged, openPath from the scan file (inside home)
          { id: "w-match", task: "Ship the thing", project: "demo", lens: "do_today", score: 90, source_type: "todo_md", source_file: join(codeDir, "demo", "tasks", "todo.md") },
          // unmatched, but "demo" resolves to a real dir under codeDir -> launchable
          { id: "w-launch-ok", task: "Do the launch thing", project: "demo", lens: "one_step", score: 50, source_type: "todo_md", source_file: null },
          // an absolute source_file OUTSIDE home -> open must be refused even though it's "absolute"
          { id: "w-outside", task: "Something else entirely", project: "other", lens: "high_leverage", score: 70, source_type: "memory", source_file: "/etc/some-memory.md" },
          // a live pseudo-ref: no openPath, and its project has no real directory -> no launchCwd
          { id: "w-live", task: "A live-only item", project: "somewhere-else", lens: "waiting", score: 40, source_type: "live", source_file: "linear:TICK-9" },
        ],
      }),
      "utf8",
    );

    let claudeJsonPath: string | undefined;
    if (opts.claudeJson) {
      claudeJsonPath = join(home, "claude.json");
      await writeFile(claudeJsonPath, JSON.stringify(opts.claudeJson(codeDir)), "utf8");
    }
    const feature = createLoopsFeature({ whatsupPath, codeDir, homeDir: home, launcher, now });
    const openEditorCalls: string[] = [];
    const ctx = fakeCtx(openEditorCalls, claudeJsonPath);
    if (opts.scan !== false) await feature.onTick?.(ctx); // deterministic: forces the one rescan this test needs
    const openRoute = feature.routes?.find((r) => r.path === "/api/loops/:id/open");
    const launchRoute = feature.routes?.find((r) => r.path === "/api/loops/:id/launch");
    return { ctx, feature, openRoute, launchRoute, openEditorCalls, codeDir };
  }

  it("POST .../open: 404 for an unknown id", async () => {
    const { openRoute, ctx } = await setup(async () => ({ ok: true }));
    const r = await call<{ ok: boolean; error?: string }>(openRoute, ctx, "no-such-id");
    expect(r).toEqual({ status: 404, body: { ok: false, error: expect.any(String) } });
  });

  it("POST .../open: 400 when the item has no source file (a live pseudo-ref)", async () => {
    const { openRoute, ctx } = await setup(async () => ({ ok: true }));
    const r = await call<{ ok: boolean }>(openRoute, ctx, "w-live");
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it("POST .../open: refuses a source file outside the home directory even though the cached path is absolute", async () => {
    const { openRoute, ctx, openEditorCalls } = await setup(async () => ({ ok: true }));
    const r = await call<{ ok: boolean }>(openRoute, ctx, "w-outside");
    expect(r.status).toBe(403);
    expect(openEditorCalls).toEqual([]);
  });

  it("POST .../open: calls the openEditor executor with the resolved path for a real, in-home file", async () => {
    const { openRoute, ctx, openEditorCalls, codeDir } = await setup(async () => ({ ok: true }));
    const r = await call<{ ok: boolean }>(openRoute, ctx, "w-match");
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(openEditorCalls).toEqual([join(codeDir, "demo", "tasks", "todo.md")]);
  });

  it("POST .../launch: 404 for an unknown id, without calling the launcher", async () => {
    const launches: unknown[] = [];
    const { launchRoute, ctx } = await setup(async (cwd, prompt) => {
      launches.push([cwd, prompt]);
      return { ok: true, tmuxName: "aw-deadbeef" };
    });
    const r = await call<{ ok: boolean }>(launchRoute, ctx, "no-such-id");
    expect(r.status).toBe(404);
    expect(launches).toEqual([]);
  });

  it("POST .../launch: 400 when the item has no resolvable project directory, without calling the launcher", async () => {
    const launches: unknown[] = [];
    const { launchRoute, ctx } = await setup(async (cwd, prompt) => {
      launches.push([cwd, prompt]);
      return { ok: true, tmuxName: "aw-deadbeef" };
    });
    const r = await call<{ ok: boolean }>(launchRoute, ctx, "w-live");
    expect(r.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("POST .../launch: validates cwd + task text, then calls the launcher with the resolved cwd and the item's task as the prompt", async () => {
    const launches: [string, string][] = [];
    const { launchRoute, ctx, codeDir } = await setup(async (cwd, prompt) => {
      launches.push([cwd, prompt]);
      return { ok: true, tmuxName: "aw-deadbeef" };
    });
    const r = await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok");
    expect(r).toEqual({ status: 200, body: { ok: true, tmuxName: "aw-deadbeef", trust: "unknown", cwd: join(codeDir, "demo") } });
    expect(launches).toEqual([[join(codeDir, "demo"), "Do the launch thing"]]);
  });

  // 2026-09-28: two launches (aw-5c67d47b, aw-e10a9ec9) sat on Claude's "trust this folder"
  // dialog while the toast said "Launched". The response now says whether that dialog is coming.
  it("POST .../launch: carries the folder's trust state from ~/.claude.json", async () => {
    const launcher: LoopsLauncher = async () => ({ ok: true, tmuxName: "aw-deadbeef" });
    const untrusted = await setup(launcher, { claudeJson: (codeDir) => ({ projects: { [join(codeDir, "other")]: { hasTrustDialogAccepted: true } } }) });
    const u = await call<LoopsActionResult>(untrusted.launchRoute, untrusted.ctx, "w-launch-ok");
    expect(u.body).toMatchObject({ ok: true, trust: "untrusted", cwd: join(untrusted.codeDir, "demo") });
    await rm(home, { recursive: true, force: true });

    const trusted = await setup(launcher, { claudeJson: (codeDir) => ({ projects: { [join(codeDir, "demo")]: { hasTrustDialogAccepted: true } } }) });
    const t = await call<LoopsActionResult>(trusted.launchRoute, trusted.ctx, "w-launch-ok");
    expect(t.body).toMatchObject({ ok: true, trust: "trusted" });
  });

  it("POST .../launch: a failed launch carries no trust claim", async () => {
    const { launchRoute, ctx } = await setup(async () => ({ ok: false, error: "osascript failed" }), { claudeJson: () => ({ projects: {} }) });
    const r = await call<LoopsActionResult>(launchRoute, ctx, "w-launch-ok");
    expect(r).toEqual({ status: 500, body: { ok: false, error: "osascript failed" } });
  });

  // Right after a restart itemsById is empty until the first rescan; a 404 "unknown item" there
  // read as if the item were gone.
  it("POST .../open and .../launch: 503 'still reading' before the first scan, then work once it has run", async () => {
    const launches: unknown[] = [];
    const { launchRoute, openRoute, ctx, feature } = await setup(
      async (cwd, prompt) => {
        launches.push([cwd, prompt]);
        return { ok: true, tmuxName: "aw-deadbeef" };
      },
      { scan: false },
    );
    expect(await call<LoopsActionResult>(launchRoute, ctx, "w-launch-ok")).toEqual({ status: 503, body: { ok: false, error: LOOPS_NOT_READY_ERROR } });
    expect(await call<LoopsActionResult>(openRoute, ctx, "w-match")).toEqual({ status: 503, body: { ok: false, error: LOOPS_NOT_READY_ERROR } });
    expect(launches).toEqual([]);
    await feature.onTick?.(ctx);
    expect((await call<LoopsActionResult>(launchRoute, ctx, "w-launch-ok")).status).toBe(200);
    expect((await call<LoopsActionResult>(launchRoute, ctx, "no-such-id")).status).toBe(404);
  });

  it("POST .../launch: surfaces a launcher failure as a 500", async () => {
    const { launchRoute, ctx } = await setup(async () => ({ ok: false, error: "tmux is not installed" }));
    const r = await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok");
    expect(r).toEqual({ status: 500, body: { ok: false, error: "tmux is not installed" } });
  });

  it("POST .../launch: a second click while the first is still starting gets the same session, and the launcher runs once", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { launchRoute, ctx } = await setup(async () => {
      calls++;
      await gate;
      return { ok: true, tmuxName: "aw-deadbeef" };
    });
    const first = call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok");
    const second = call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok");
    release();
    expect((await first).body).toMatchObject({ ok: true, tmuxName: "aw-deadbeef" });
    expect(await second).toMatchObject({ status: 200, body: { ok: true, tmuxName: "aw-deadbeef", reused: true } });
    expect(calls).toBe(1);
    // within LAUNCH_REPEAT_WINDOW_MS after it started, another click still gets that same session
    expect((await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok")).body).toMatchObject({ tmuxName: "aw-deadbeef", reused: true });
    expect(calls).toBe(1);
  });

  it("POST .../launch: after LAUNCH_REPEAT_WINDOW_MS, launching the same item again is a deliberate new click", async () => {
    let t = 1_000_000;
    let calls = 0;
    const { launchRoute, ctx } = await setup(
      async () => {
        calls++;
        return { ok: true, tmuxName: `aw-0000000${calls}` };
      },
      {},
      () => t,
    );
    expect((await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok")).body.tmuxName).toBe("aw-00000001");
    t += LAUNCH_REPEAT_WINDOW_MS;
    expect((await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok")).body.tmuxName).toBe("aw-00000002");
    expect(calls).toBe(2);
  });

  it("POST .../launch: a failed launch is never remembered, so a retry really retries", async () => {
    let calls = 0;
    const { launchRoute, ctx } = await setup(async () => {
      calls++;
      return calls === 1 ? { ok: false, error: "new-session failed" } : { ok: true, tmuxName: "aw-deadbeef" };
    });
    expect((await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok")).status).toBe(500);
    expect((await call<LoopsLaunchResult>(launchRoute, ctx, "w-launch-ok")).body).toEqual({ ok: true, tmuxName: "aw-deadbeef", trust: "unknown", cwd: expect.any(String) });
    expect(calls).toBe(2);
  });

  it("POST .../done: ticks only the item's own line of its todo.md, then the item leaves the board", async () => {
    const { feature, ctx, codeDir } = await setup(async () => ({ ok: true }));
    const todo = join(codeDir, "demo", "tasks", "todo.md");
    await writeFile(todo, "## Open\r\n- [ ] Ship the thing\r\n- [ ] Keep this one\r\n", "utf8");
    const done = feature.routes?.find((r) => r.path === "/api/loops/:id/done");
    const r = await call<LoopsActionResult>(done, ctx, "w-match");
    expect(r).toEqual({ status: 200, body: { ok: true, line: 2 } });
    expect(await readFile(todo, "utf8")).toBe("## Open\r\n- [x] Ship the thing\r\n- [ ] Keep this one\r\n");
    expect(latestLoopsBoard()?.items.find((i) => i.id === "w-match")?.sources).toEqual(["whatsup"]); // whatsup still lists it until it regenerates
  });

  it("POST .../done: refuses a whatsup-only item and a todo written twice, writing nothing", async () => {
    const { feature, ctx, codeDir } = await setup(async () => ({ ok: true }));
    const done = feature.routes?.find((r) => r.path === "/api/loops/:id/done");
    expect((await call<LoopsActionResult>(done, ctx, "w-launch-ok")).status).toBe(400);
    const todo = join(codeDir, "demo", "tasks", "todo.md");
    const twice = "## Open\n- [ ] Ship the thing\n## Also\n- [ ] Ship the thing.\n";
    await writeFile(todo, twice, "utf8");
    const r = await call<LoopsActionResult>(done, ctx, "w-match");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/2 times/);
    expect(await readFile(todo, "utf8")).toBe(twice);
  });

  it("POST .../launch: records the session it started on the item's Fix queue row", async () => {
    resetFixesStoresForTests();
    const { launchRoute, ctx } = await setup(async () => ({ ok: true, tmuxName: "aw-deadbeef" }));
    const dbPath = join(home, "data", "world.db");
    const withDb = { ...ctx, config: { ...ctx.config, dbPath } } as FeatureContext;
    expect((await call<LoopsActionResult>(launchRoute, withDb, "w-launch-ok")).status).toBe(200);
    const stored = JSON.parse(await readFile(join(home, "data", "fixes.json"), "utf8")) as { launches: Record<string, { tmuxName: string; sessionId: null }> };
    expect(stored.launches["loop:w-launch-ok"]).toMatchObject({ tmuxName: "aw-deadbeef", sessionId: null });
  });
});

describe("loops routes on a booted server", () => {
  let server: RunningServer | null = null;
  let home = "";
  afterEach(async () => {
    if (server) await server.close();
    server = null;
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  it("answers 503 until the first scan, then launches with the fixture's folder trust", async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "aw-loops-boot-")));
    const codeDir = join(home, "Documents", "Code");
    await mkdir(join(codeDir, "acme-www", "tasks"), { recursive: true });
    await writeFile(join(codeDir, "acme-www", "tasks", "todo.md"), "## Open\n- [ ] Align the FAQ with the DPA\n", "utf8");
    const whatsupPath = join(home, "todos.json");
    await writeFile(
      whatsupPath,
      JSON.stringify({ generated: "2026-09-28T08:00", items: [{ id: "w-faq", task: "Align the FAQ with the DPA", project: "acme-www", lens: "do_today", score: 90, source_type: "todo_md", source_file: null }] }),
      "utf8",
    );
    // The 2026-09-28 shape: the home dir explicitly false, acme-www absent.
    const claudeJsonPath = join(home, ".claude.json");
    await writeFile(claudeJsonPath, JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: false } } }), "utf8");

    const launches: [string, string][] = [];
    const launcher: LoopsLauncher = async (cwd, prompt) => {
      launches.push([cwd, prompt]);
      return { ok: true, tmuxName: "aw-5c67d47b" };
    };
    const booted = await bootTestServer({ configOverrides: { claudeJsonPath, features: [createLoopsFeature({ whatsupPath, codeDir, homeDir: home, launcher })] } });
    server = booted.server;
    const post = async (): Promise<{ status: number; body: LoopsActionResult }> => {
      const res = await fetch(`${booted.base}/api/loops/w-faq/launch`, { method: "POST", headers: { "content-type": "application/json" } });
      return { status: res.status, body: (await res.json()) as LoopsActionResult };
    };

    const early = await post();
    expect(early).toEqual({ status: 503, body: { ok: false, error: LOOPS_NOT_READY_ERROR } });
    expect(launches).toEqual([]);

    let r = early;
    for (let i = 0; i < 100 && r.status === 503; i++) {
      await new Promise((done) => setTimeout(done, 20));
      r = await post();
    }
    expect(r).toEqual({ status: 200, body: { ok: true, tmuxName: "aw-5c67d47b", trust: "untrusted", cwd: join(codeDir, "acme-www") } });
    expect(launches).toEqual([[join(codeDir, "acme-www"), "Align the FAQ with the DPA"]]);
  });
});
