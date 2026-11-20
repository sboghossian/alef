// buildWorldViews's island metadata: an island's path/name must come from its own cwd_islands
// assignment, not from "whichever session happens to be first" — that heuristic silently breaks
// for a home-placed session (home-placement.ts), which keeps its own (home dir) cwd while living
// on a repo's island.

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFeature } from "../features/registry.js";
import { createTalkFeature, type TalkExec } from "../features/talk.js";
import { respondJson } from "../http.js";
import { runDirectorTick } from "../director.js";
import { buildWorldViews, type RunningServer } from "../index.js";
import { log } from "../log.js";
import { bootTestServer, makeTempDb, makeTempProjectsDir } from "./helpers.js";
import type { WorldDb } from "../db.js";

function seedSession(
  db: WorldDb,
  id: string,
  cwd: string,
  islandId: string,
): void {
  db.upsertSession({
    id,
    cwd,
    islandId,
    title: "t",
    startedAt: "2026-09-20T10:00:00.000Z",
    lastActive: "2026-09-20T10:00:00.000Z",
    jsonlMtime: 0,
    messageCountDelta: 1,
    model: null,
    cntEditDelta: 0,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 0,
  });
}

describe("buildWorldViews: island path/name", () => {
  it("an ordinary (non-placed) island's path/name come from its own cwd", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const ownProject = join(dir, "ws", "own-project");
    db.setIslandForCwd(ownProject, "own-project");
    seedSession(db, "11111111-0000-0000-0000-0000000000a1", ownProject, "own-project");

    const views = buildWorldViews(db, new Map(), new Date());
    const island = views.islands.find((i) => i.id === "own-project");
    expect(island?.path).toBe(ownProject);
    expect(island?.name).toBe("own-project");

    db.close();
  });

  it("a home-placed island's path/name are the REPO's, not the placed session's own (home) cwd", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    const repoA = join(dir, "code", "repo-a");
    db.setIslandForCwd(home, "home");
    db.setIslandForCwd(repoA, "repo-a"); // what home-placement.ts does once it picks repo-a
    // This session's own cwd is still home — home-placement.ts never rewrites cwd — but its
    // island is repo-a's.
    seedSession(db, "11111111-0000-0000-0000-0000000000a2", home, "repo-a");

    const views = buildWorldViews(db, new Map(), new Date());
    const island = views.islands.find((i) => i.id === "repo-a");
    expect(island?.path).toBe(repoA);
    expect(island?.name).toBe("repo-a");
    expect(island?.path).not.toBe(home); // the regression this test guards against

    // The session itself still reports its true cwd.
    const agent = views.agents.find((a) => a.id === "11111111-0000-0000-0000-0000000000a2");
    expect(agent?.cwd).toBe(home);
    expect(agent?.islandId).toBe("repo-a");

    db.close();
  });

  it("an Alef launch that never started does not make an older session in its folder live", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const aw = join(dir, "code", "agent-world");
    db.setIslandForCwd(aw, "agent-world");
    // a9c4eac1's real shape: a finished headless run, last written 2026-09-27T05:42:58Z
    db.upsertSession({
      id: "a9c4eac1-7596-4857-8403-3a45e96ab91e",
      cwd: aw,
      islandId: "agent-world",
      title: "/upskill",
      startedAt: "2026-09-27T05:42:33.265Z",
      lastActive: "2026-09-27T05:42:58.277Z",
      jsonlMtime: Date.parse("2026-09-27T05:42:58.277Z"),
      messageCountDelta: 3,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 0,
      cntAssistantTotalDelta: 1,
    });
    const now = new Date("2026-09-28T02:12:00.000Z");
    const live = new Map([[aw, 1]]); // the claude stuck on the trust dialog in aw-e10a9ec9
    const status = (): string | undefined => buildWorldViews(db, live, now).agents.find((a) => a.id.startsWith("a9c4eac1"))?.status;
    expect(status()).toBe("live"); // no binding known: the process vouches, as before

    // talk.bindings exactly as the live app persisted it for that launch
    db.setMeta("talk.bindings", JSON.stringify([{ agentId: null, tmuxName: "aw-e10a9ec9", cwd: aw, startedAt: "2026-09-28T01:56:14.429Z" }]));
    expect(status()).toBe("dormant");

    db.close();
  });

  it("harness keeps its special-cased empty path", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    db.upsertObjectShell({ id: "skill:foo", kind: "skill", name: "foo", islandId: "harness" });

    const views = buildWorldViews(db, new Map(), new Date());
    const island = views.islands.find((i) => i.id === "harness");
    expect(island?.path).toBe("");
    expect(island?.name).toBe("Harness");

    db.close();
  });
});

// Roads: a `visited` edge is session -> island (trips-lib.ts). The client draws a road from each
// one whose `to` is a served island (main.ts roadPairs), so the snapshot must carry them.
describe("buildWorldViews: visited edges reach the client", () => {
  it("serves the director's session -> island visits for served islands only; every served edge's ends are served", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const a = join(dir, "ws", "a");
    const b = join(dir, "ws", "b");
    const c = join(dir, "ws", "c");
    db.setIslandForCwd(a, "island-a");
    db.setIslandForCwd(b, "island-b");
    db.setIslandForCwd(c, "island-c"); // a folder with no session and no object of its own
    seedSession(db, "agent-a", a, "island-a");
    seedSession(db, "agent-b", b, "island-b");
    // Objects keep the island of whoever upserted them last (here agent-a's), as the indexer does.
    db.upsertObjectShell({ id: `file:${b}/shared.ts`, kind: "file", name: "shared.ts", islandId: "island-a" });
    db.upsertObjectShell({ id: `file:${c}/notes.md`, kind: "file", name: "notes.md", islandId: "island-a" });
    db.upsertEdge({ from: "agent-a", to: `file:${b}/shared.ts`, kind: "touched", at: "2026-09-20T10:00:00.000Z" });
    db.upsertEdge({ from: "agent-a", to: `file:${c}/notes.md`, kind: "touched", at: "2026-09-20T10:00:00.000Z" });

    // The real director tick, fed the snapshots the server feeds it, derives and stores the visits (no API key: no fetch).
    await runDirectorTick(db, buildWorldViews(db, new Map(), new Date()).agentSnapshots, { apiKey: "", homeDir: join(dir, "no-home") });
    const stored = db.listEdges().filter((e) => e.kind === "visited").map((e) => [e.from, e.to]);
    expect(stored.sort()).toEqual([["agent-a", "island-b"], ["agent-a", "island-c"]]);

    const views = buildWorldViews(db, new Map(), new Date());
    const served = views.edges.filter((e) => e.kind === "visited").map((e) => [e.from, e.to]);
    // island-b is drawn (agent-b lives there), so its road is served; island-c is not drawn, so its visit stays in the db only.
    expect(served).toEqual([["agent-a", "island-b"]]);

    const agentIds = new Set(views.agents.map((x) => x.id));
    const objectIds = new Set(views.objects.map((x) => x.id));
    const islandIds = new Set(views.islands.map((x) => x.id));
    for (const e of views.edges) {
      expect(agentIds.has(e.from) || objectIds.has(e.from)).toBe(true);
      expect(agentIds.has(e.to) || objectIds.has(e.to) || (e.kind === "visited" && islandIds.has(e.to))).toBe(true);
    }

    db.close();
  });
});

// ── The per-request action log (server/action-log.ts): one line per non-GET request ──

describe("action log", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await server.close();
    server = null;
  });

  type Call = { level: "info" | "warn" | "error"; message: string; fields: Record<string, unknown> };
  function spyActions(): Call[] {
    const calls: Call[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(log, level).mockImplementation((scope: string, message: string, extra?: unknown) => {
        if (scope === "action") calls.push({ level, message, fields: extra as Record<string, unknown> });
      });
    }
    return calls;
  }
  /** Lets 'finish' and 'close' both fire before counting (a double log would show up here). */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

  const echo: ServerFeature = {
    id: "echo",
    routes: [
      { method: "POST", path: "/api/echo/ok", handler: (_req, res) => respondJson(res, 200, { ok: true }) },
      { method: "POST", path: "/api/echo/refused", handler: (_req, res) => respondJson(res, 200, { ok: false, error: "nothing to refuse\nsecond line" }) },
      // Never answers: the client gives up first.
      { method: "POST", path: "/api/echo/hang", handler: (req) => new Promise<void>((r) => req.socket.once("close", () => r())) },
    ],
  };

  async function boot(overrides: Parameters<typeof bootTestServer>[0] = {}): Promise<string> {
    const booted = await bootTestServer({ ...overrides, configOverrides: { features: [echo], ...overrides.configOverrides } });
    server = booted.server;
    return booted.base;
  }
  const post = (base: string, path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, ...init });

  it("logs a refused reactivate exactly once, as a warn with the server's reason", async () => {
    const calls = spyActions();
    // /api/reactivate is the talk feature's (it owns the tmux sessions a resume starts); no tmux here.
    const noTmux: TalkExec = { findTmux: async () => null, run: async () => {}, capture: async () => "", captureAll: async () => "", startCommand: async () => "", paneCounts: async () => "", openTerminal: () => {} };
    const base = await boot({ configOverrides: { features: [echo, createTalkFeature(noTmux)] } });
    const res = await post(base, "/api/reactivate/not-a-uuid");
    expect(res.status).toBe(400);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("warn");
    expect(calls[0]!.fields).toMatchObject({ kind: "action", method: "POST", route: "/api/reactivate/not-a-uuid", status: 400, ok: false, reason: "invalid agent id" });
    expect(Number.isInteger(calls[0]!.fields.durationMs)).toBe(true);
    expect(calls[0]!.message).toMatch(/^POST \/api\/reactivate\/not-a-uuid → 400 in \d+ms: invalid agent id$/);
  });

  it("never logs a GET", async () => {
    const calls = spyActions();
    const base = await boot();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/world`)).status).toBe(200);
    await settle();
    expect(calls).toEqual([]);
  });

  it("logs the guard's own refusals (a text/plain POST gets its 415)", async () => {
    const calls = spyActions();
    const base = await boot();
    const res = await post(base, "/api/dispatch", { headers: { "content-type": "text/plain" }, body: "hi" });
    expect(res.status).toBe(415);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.level).toBe("warn");
    expect(calls[0]!.fields).toMatchObject({ route: "/api/dispatch", status: 415, ok: false, reason: "content-type must be application/json" });
  });

  it("logs a feature POST that worked as info, and a 200 {ok:false} as warn with its first line", async () => {
    const calls = spyActions();
    const base = await boot();
    expect((await post(base, "/api/echo/ok?x=1")).status).toBe(200);
    expect((await post(base, "/api/echo/refused")).status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await settle();
    expect(calls).toHaveLength(2);
    const ok = calls.find((c) => c.fields.route === "/api/echo/ok");
    const refused = calls.find((c) => c.fields.route === "/api/echo/refused");
    expect(ok).toMatchObject({ level: "info", fields: { status: 200, ok: true, reason: null } });
    expect(refused).toMatchObject({ level: "warn", fields: { status: 200, ok: false, reason: "nothing to refuse" } });
  });

  it("logs status 0 when the client hangs up before the response finished", async () => {
    const calls = spyActions();
    const base = await boot();
    const ac = new AbortController();
    const pending = post(base, "/api/echo/hang", { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await pending;
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: "error", fields: { route: "/api/echo/hang", status: 0, ok: false, reason: "client closed the connection" } });
  });
});

describe("POST /api/reactivate refuses a running session", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  const agentId = "a9c4eac1-7596-4857-8403-3a45e96ab91e";
  const cwd = "/ws/agent-world";
  function seed(db: WorldDb, jsonlMtime: number): void {
    db.setIslandForCwd(cwd, "agent-world");
    db.upsertSession({
      id: agentId,
      cwd,
      islandId: "agent-world",
      title: "/upskill",
      startedAt: "2026-09-27T05:42:33.265Z",
      lastActive: "2026-09-27T05:42:58.277Z",
      jsonlMtime,
      messageCountDelta: 3,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 0,
      cntAssistantTotalDelta: 1,
    });
  }

  it("answers 409 for a live session and never calls the executor", async () => {
    const calls: Array<[string, string]> = [];
    const booted = await bootTestServer({
      reactivateExecutor: (c, id) => void calls.push([c, id]),
      configOverrides: { liveDetector: () => new Map([[cwd, 1]]) },
    });
    server = booted.server;
    seed(booted.server.db, Date.now());
    const res = await fetch(`${booted.base}/api/reactivate/${agentId}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; agentId: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.agentId).toBe(agentId);
    expect(body.error).toMatch(/already running \(in VS Code or Terminal\), so resuming it would start a second copy/);
    expect(calls).toEqual([]);
  });

  it("still resumes a dormant session", async () => {
    const calls: Array<[string, string]> = [];
    const booted = await bootTestServer({ reactivateExecutor: (c, id) => void calls.push([c, id]) });
    server = booted.server;
    seed(booted.server.db, Date.parse("2026-09-27T05:42:58.277Z"));
    const res = await fetch(`${booted.base}/api/reactivate/${agentId}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(calls).toEqual([[cwd, agentId]]);
  });
});
