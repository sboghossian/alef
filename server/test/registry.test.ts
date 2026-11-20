import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../shared/types.js";
import type { WorldDb } from "../db.js";
import { serverFeatures } from "../features/index.js";
import {
  ServerFeatureRegistry,
  matchPath,
  mergeSnapshotExtras,
  type ServerContext,
  type ServerFeature,
} from "../features/registry.js";
import type { ServerConfig } from "../index.js";
import { log } from "../log.js";

function baseCtx(sent: ServerMessage[] = []): ServerContext {
  const unused = (): never => {
    throw new Error("not used in this test");
  };
  return {
    db: {} as WorldDb,
    config: {} as ServerConfig,
    log,
    detectLive: () => new Map(),
    executors: { reactivate: unused, dispatch: unused, openEditor: unused },
    broadcast: (msg) => sent.push(msg),
    worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
  };
}

const fakeReq = (method: string): IncomingMessage => ({ method }) as IncomingMessage;
const fakeRes = {} as ServerResponse;

describe("matchPath", () => {
  it("matches exact paths and nothing else", () => {
    expect(matchPath("/api/ask-jev", "/api/ask-jev")).toEqual({});
    expect(matchPath("/api/ask-jev", "/api/ask-jev/x")).toBeNull();
    expect(matchPath("/api/ask-jev", "/api/ask-jevx")).toBeNull();
  });

  it("extracts and URI-decodes :params, one segment each", () => {
    expect(matchPath("/api/open-editor/:agentId", "/api/open-editor/a%20b")).toEqual({ agentId: "a b" });
    expect(matchPath("/api/x/:a/y/:b", "/api/x/1/y/2")).toEqual({ a: "1", b: "2" });
    expect(matchPath("/api/open-editor/:agentId", "/api/open-editor/a/b")).toBeNull();
    expect(matchPath("/api/open-editor/:agentId", "/api/open-editor/")).toBeNull();
  });

  it("treats regex metacharacters in the pattern literally", () => {
    expect(matchPath("/api/a.b", "/api/aXb")).toBeNull();
    expect(matchPath("/api/a.b", "/api/a.b")).toEqual({});
  });
});

describe("mergeSnapshotExtras", () => {
  it("is undefined when no feature contributes", () => {
    expect(mergeSnapshotExtras([])).toBeUndefined();
  });

  it("merges keys across features; the first feature wins a clash and the clash is reported", () => {
    const warnings: string[] = [];
    const merged = mergeSnapshotExtras(
      [
        { featureId: "a", extras: { "a.todos": [1], shared: "from-a" } },
        { featureId: "b", extras: { "b.weather": "rain", shared: "from-b" } },
      ],
      (m) => warnings.push(m),
    );
    expect(merged).toEqual({ "a.todos": [1], "b.weather": "rain", shared: "from-a" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("shared");
  });
});

describe("ServerFeatureRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects duplicate feature ids", () => {
    expect(() => new ServerFeatureRegistry([{ id: "x" }, { id: "x" }], baseCtx())).toThrow(/duplicate/);
  });

  it("routes by method + path, passes params and a feature-bound ctx, and reports no match", async () => {
    const seen: { feature: string; params: Record<string, string> }[] = [];
    const features: ServerFeature[] = [
      { id: "one", routes: [{ method: "GET", path: "/api/one/:id", handler: (_q, _s, ctx, params) => void seen.push({ feature: ctx.featureId, params: { ...params } }) }] },
      { id: "two", routes: [{ method: "POST", path: "/api/one/:id", handler: (_q, _s, ctx, params) => void seen.push({ feature: ctx.featureId, params: { ...params } }) }] },
    ];
    const reg = new ServerFeatureRegistry(features, baseCtx());
    expect(await reg.handle(fakeReq("POST"), fakeRes, "/api/one/42")).toBe(true);
    expect(await reg.handle(fakeReq("GET"), fakeRes, "/api/one/7")).toBe(true);
    expect(await reg.handle(fakeReq("GET"), fakeRes, "/api/nope")).toBe(false);
    expect(await reg.handle(fakeReq("DELETE"), fakeRes, "/api/one/7")).toBe(false);
    expect(seen).toEqual([
      { feature: "two", params: { id: "42" } },
      { feature: "one", params: { id: "7" } },
    ]);
  });

  it("ctx.emit wraps the payload in a feature message tagged with the feature id", async () => {
    const sent: ServerMessage[] = [];
    const reg = new ServerFeatureRegistry(
      [{ id: "pinger", routes: [{ method: "POST", path: "/api/ping", handler: (_q, _s, ctx) => ctx.emit({ n: 1 }) }] }],
      baseCtx(sent),
    );
    await reg.handle(fakeReq("POST"), fakeRes, "/api/ping");
    expect(sent).toEqual([{ type: "feature", feature: "pinger", payload: { n: 1 } }]);
  });

  it("merges snapshotExtras, isolating a throwing feature", () => {
    const reg = new ServerFeatureRegistry(
      [
        { id: "a", snapshotExtras: () => ({ "a.x": 1 }) },
        { id: "bad", snapshotExtras: () => { throw new Error("boom"); } },
        { id: "c", snapshotExtras: () => ({ "c.y": 2 }) },
      ],
      baseCtx(),
    );
    expect(reg.snapshotExtras()).toEqual({ "a.x": 1, "c.y": 2 });
    expect(new ServerFeatureRegistry([{ id: "quiet" }], baseCtx()).snapshotExtras()).toBeUndefined();
  });

  it("collects snapshotIslands: taken ids and repeats skipped, a throwing feature isolated", () => {
    const isl = (id: string) => ({ id, name: id, path: "", agentCount: 0, lastActive: new Date(0).toISOString() });
    const reg = new ServerFeatureRegistry(
      [
        { id: "a", snapshotIslands: () => [isl("museum"), isl("harness")] },
        { id: "bad", snapshotIslands: () => { throw new Error("boom"); } },
        { id: "c", snapshotIslands: () => [isl("museum"), isl("annex")] },
      ],
      baseCtx(),
    );
    expect(reg.snapshotIslands(new Set(["harness"])).map((i) => i.id)).toEqual(["museum", "annex"]);
    expect(new ServerFeatureRegistry([{ id: "quiet" }], baseCtx()).snapshotIslands(new Set())).toEqual([]);
  });

  it("only asks the indexer for lines when a feature has onIndexPass, and skips empty passes", async () => {
    const calls: string[][] = [];
    expect(new ServerFeatureRegistry([{ id: "quiet" }], baseCtx()).wantsIndexLines()).toBe(false);
    const reg = new ServerFeatureRegistry(
      [
        { id: "bad", onIndexPass: () => { throw new Error("boom"); } },
        { id: "todo", onIndexPass: (_ctx, lines) => void calls.push([...lines.keys()]) },
      ],
      baseCtx(),
    );
    expect(reg.wantsIndexLines()).toBe(true);
    await reg.indexPass(new Map());
    expect(calls).toHaveLength(0);
    await reg.indexPass(new Map([["s1", ["{}"]]]));
    expect(calls).toEqual([["s1"]]);
  });

  it("runs onTick on its own interval without overlapping, and stops cleanly", async () => {
    vi.useFakeTimers();
    let started = 0;
    let release: () => void = () => {};
    const reg = new ServerFeatureRegistry(
      [
        {
          id: "slow",
          tickIntervalMs: 1000,
          onTick: () => {
            started++;
            return new Promise<void>((r) => (release = r));
          },
        },
      ],
      baseCtx(),
    );
    reg.startTicks();
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1); // still running: later ticks are skipped
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(2);
    reg.stopTicks();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toBe(2);
  });

  it("start() awaits every onStart hook, isolates a throwing one, and bounds a hanging one", async () => {
    vi.useFakeTimers();
    const done: string[] = [];
    const reg = new ServerFeatureRegistry(
      [
        { id: "slow-but-ok", onStart: () => new Promise<void>((r) => setTimeout(() => r(void done.push("slow-but-ok")), 500)) },
        { id: "bad", onStart: () => { throw new Error("boom"); } },
        { id: "hangs", onStart: () => new Promise<void>(() => {}) },
        { id: "quiet" },
      ],
      baseCtx(),
    );
    let started = false;
    const p = reg.start(2000).then(() => void (started = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toEqual(["slow-but-ok"]);
    expect(started).toBe(false); // still waiting on the hanging hook
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(started).toBe(true); // bounded: the server listens without it
  });

  it("the enabled list has unique ids and serves the moved routes", () => {
    const ids = serverFeatures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = serverFeatures.flatMap((f) => (f.routes ?? []).map((r) => `${r.method} ${r.path}`));
    expect(paths).toContain("POST /api/ask-jev");
    expect(paths).toContain("POST /api/open-editor/:agentId");
  });
});

describe("feature plugins wired into the real server", () => {
  it("serves feature routes, merges snapshot extras into /api/world, and hands onIndexPass the new raw lines", async () => {
    const { bootTestServer, writeSessionFile, userLine } = await import("./helpers.js");
    const passes: Map<string, readonly string[]>[] = [];
    const probe: ServerFeature = {
      id: "probe",
      routes: [{ method: "GET", path: "/api/probe/:x", handler: (_q, res, ctx, p) => { res.writeHead(200); res.end(`${ctx.featureId}:${p.x ?? ""}`); } }],
      snapshotExtras: () => ({ "probe.ok": true }),
      snapshotIslands: () => [{ id: "probe-isle", name: "Probe", path: "", agentCount: 0, lastActive: new Date(0).toISOString() }],
      onIndexPass: (_ctx, lines) => void passes.push(new Map(lines)),
    };
    const { base, server, dir } = await bootTestServer({ configOverrides: { features: [probe] } });
    try {
      expect(await (await fetch(`${base}/api/probe/hi`)).text()).toBe("probe:hi");
      const world = (await (await fetch(`${base}/api/world`)).json()) as { extras?: Record<string, unknown>; islands: { id: string }[] };
      expect(world.extras).toEqual({ "probe.ok": true });
      expect(world.islands.map((i) => i.id)).toContain("probe-isle");
      // Moved built-in routes are not served when the feature list omits them.
      expect((await fetch(`${base}/api/ask-jev`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);

      const line = userLine({ cwd: "/ws/p", timestamp: new Date().toISOString(), text: "hello" });
      await writeSessionFile(`${dir}/projects`, "-ws-p", "11111111-2222-3333-4444-555555555555", `${line}\n`);
      await vi.waitFor(() => expect(passes.length).toBeGreaterThan(0), { timeout: 15_000, interval: 250 });
      expect(passes[0]?.get("11111111-2222-3333-4444-555555555555")).toEqual([line]);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("omits extras from /api/world when no feature contributes (unchanged contract)", async () => {
    const { bootTestServer } = await import("./helpers.js");
    const { base, server } = await bootTestServer({ configOverrides: { features: [] } });
    try {
      const world = (await (await fetch(`${base}/api/world`)).json()) as Record<string, unknown>;
      expect("extras" in world).toBe(false);
    } finally {
      await server.close();
    }
  });
});
