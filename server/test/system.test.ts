import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemNode, SystemResponse } from "../../shared/features/system.js";
import type { RunningServer } from "../index.js";
import { createSystemFeature, type SystemReaders } from "../features/system.js";
import { parseServices, tcpUp } from "../features/system-probe.js";
import { buildPlanes, type SystemSources } from "../features/system-nodes.js";
import type { Settled } from "../features/system-lib.js";
import { bootTestServer } from "./helpers.js";
import { LAYER_FAST } from "./system-layers-fixtures.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ok = <T,>(value: T): Settled<T> => ({ ok: true, value });
const bad = (error = "boom"): Settled<never> => ({ ok: false, error });

function sources(over: Partial<SystemSources> = {}): SystemSources {
  return {
    host: ok({ load1: 2, cpus: 10, uptimeSec: 90_000 }),
    claudeVersion: ok("2.1.300"),
    settings: ok({ model: "opus", effort: "high", hookCount: 28, hookEvents: ["PreToolUse", "Stop"], hookByEvent: [{ event: "PreToolUse", count: 20 }, { event: "Stop", count: 8 }], permissionHook: true, denyCount: 4, allowCount: 120 }),
    harness: ok({ skills: 140, agents: 12, mcp: 9, mcpNames: ["linear", "exa"] }),
    memory: ok({ files: 80, byType: { project: 50, feedback: 20, user: 10 }, indexLines: 150 }),
    vault: ok({ path: "/secret/vault", notes: 61000, lastCommitMs: NOW - 3_600_000, mirrorMs: NOW - 3_600_000, ahead: 0, brainGraphMs: NOW - 3_600_000 }),
    mini: ok({ configured: true, reachable: true }),
    routines: ok({ total: 20, loaded: 18, paused: 2, running: 0, failed: 0, firedToday: 6, voiceLoaded: true }),
    services: ok([{ host: "yalla", port: 5100, managed: true, up: true, dir: "x", public: false }, { host: "aleph", port: 5101, managed: true, up: true, dir: "x", public: false }]),
    launchd: ok({ launchctlRead: true, jobs: [
      { label: "com.stephane.a", kind: "scheduled", schedule: "every 15 min", loaded: true, running: false, lastExit: 0 },
      { label: "com.stephane.b", kind: "scheduled", schedule: "daily 08:00", loaded: true, running: false, lastExit: 1 },
      { label: "dev.dashable.yalla", kind: "always-on", schedule: "keep alive", loaded: true, running: true, lastExit: null },
    ] }),
    tunnel: ok({ hostnames: ["yalla.dashable.dev", "aleph.dashable.dev"] }),
    prompts: ok({ sessionsToday: 9, liveNow: null }),
    outputs: ok({ prsToday: 3, shippedToday: 2, artifactsToday: 1 }),
    ...over,
  };
}

const nodes = (s: SystemSources): Map<string, SystemNode> => new Map(buildPlanes(NOW, s).flatMap((p) => p.nodes).map((n) => [n.id, n]));

describe("node status mapping", () => {
  it("builds the eight planes with live values", () => {
    const planes = buildPlanes(NOW, sources());
    expect(planes.map((p) => p.id)).toEqual(["prompts", "engine", "machines", "guardrails", "skills", "memory", "services", "outputs"]);
    const n = nodes(sources());
    expect(n.get("engine.hooks")).toMatchObject({ value: "28 hooks", status: "ok" });
    expect(n.get("engine.model")?.value).toBe("opus @ high");
    expect(n.get("machines.mac")?.status).toBe("ok");
    expect(n.get("services.live")).toMatchObject({ value: "2/2 answering", status: "ok" });
    expect(n.get("skills.mcp")?.status).toBe("unknown"); // configured, not probed: never shown as healthy
  });
  it("marks a source that failed as unknown on exactly its nodes", () => {
    const n = nodes(sources({ settings: bad("took over 4000 ms") }));
    for (const id of ["engine.model", "engine.hooks", "guardrails.hooks", "guardrails.permission", "guardrails.deny"]) {
      expect(n.get(id)).toMatchObject({ status: "unknown", value: "unknown" });
    }
    expect(n.get("engine.hooks")?.facts[0]?.value).toBe("took over 4000 ms");
    expect(n.get("machines.mac")?.status).toBe("ok");
    expect(n.get("skills.skills")?.status).toBe("ok");
  });
  it("goes amber or red on the real warning signs", () => {
    const n = nodes(
      sources({
        host: ok({ load1: 30, cpus: 10, uptimeSec: 10 }),
        mini: ok({ configured: true, reachable: false }),
        settings: ok({ model: null, effort: null, hookCount: 0, hookEvents: [], hookByEvent: [], permissionHook: false, denyCount: 0, allowCount: 0 }),
        vault: ok({ path: "/v", notes: null, lastCommitMs: NOW - 10 * 86_400_000, mirrorMs: NOW - 3_600_000, ahead: 4, brainGraphMs: null }),
        services: ok([{ host: "a", port: 1, managed: true, up: false, dir: null, public: false }, { host: "b", port: 2, managed: true, up: false, dir: null, public: false }, { host: "c", port: 3, managed: true, up: false, dir: null, public: false }, { host: "d", port: 4, managed: true, up: true, dir: "x", public: false }]),
        routines: ok({ total: 5, loaded: 3, paused: 2, running: 0, failed: 1, firedToday: 0, voiceLoaded: false }),
      }),
    );
    expect(n.get("machines.mac")?.status).toBe("bad");
    expect(n.get("machines.mini")?.status).toBe("bad");
    expect(n.get("engine.hooks")?.status).toBe("bad");
    expect(n.get("guardrails.permission")?.status).toBe("warn");
    expect(n.get("machines.vault")?.status).toBe("bad");
    expect(n.get("machines.mirror")).toMatchObject({ status: "warn", value: "tip committed 1 h ago" });
    expect(n.get("memory.brain")?.status).toBe("unknown");
    expect(n.get("services.live")?.status).toBe("bad");
    expect(n.get("services.down")).toMatchObject({ value: "3 not answering", status: "bad" });
    expect(n.get("services.scheduled")?.status).toBe("warn");
    expect(n.get("prompts.voice")?.status).toBe("warn");
  });
  it("hides the artifacts node when nothing counted them, and plane status is the worst node", () => {
    const planes = buildPlanes(NOW, sources({ outputs: ok({ prsToday: 1, shippedToday: 0, artifactsToday: null }) }));
    expect(planes.find((p) => p.id === "outputs")?.nodes.map((n) => n.id)).toEqual(["outputs.prs", "outputs.shipped"]);
    const worse = buildPlanes(NOW, sources({ mini: ok({ configured: true, reachable: false }) }));
    expect(worse.find((p) => p.id === "machines")?.status).toBe("bad");
  });
});

describe("services.yml and the TCP probe", () => {
  it("reads host and port pairs and ignores comments", () => {
    const yml = "# c\nservices:\n  - host: growth\n    port: 3737\n    dir: x\n  # - host: ghost\n  - host: crm\n    port: 4200\n    env:\n      PORT: \"4200\"\n";
    expect(parseServices(yml)).toEqual([{ host: "growth", port: 3737, managed: true, dir: "x", public: false }, { host: "crm", port: 4200, managed: true, dir: null, public: false }]);
  });
  it("marks managed: false entries as manual so they never count as down", () => {
    const yml = "services:\n  - host: crm\n    port: 4200\n  - host: crm-alias\n    port: 4200\n    managed: false  # same process\n";
    expect(parseServices(yml)).toEqual([{ host: "crm", port: 4200, managed: true, dir: null, public: false }, { host: "crm-alias", port: 4200, managed: false, dir: null, public: false }]);
  });
  it("sees a listening port as up and a closed one as down within the deadline", async () => {
    const srv = net.createServer((c) => c.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await tcpUp("127.0.0.1", port, 500)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    const t0 = Date.now();
    expect(await tcpUp("127.0.0.1", port, 500)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("GET /api/system", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const fast = (calls: Record<string, number>): Partial<SystemReaders> => {
    const s = sources();
    const mk = <K extends keyof SystemSources>(k: K) => async (): Promise<never> => {
      calls[k] = (calls[k] ?? 0) + 1;
      const v = s[k];
      if (!v.ok) throw new Error(v.error);
      return v.value as never;
    };
    return { host: mk("host"), claudeVersion: mk("claudeVersion"), settings: mk("settings"), harness: mk("harness"), memory: mk("memory"), vault: mk("vault"), mini: mk("mini"), routines: mk("routines"), launchd: mk("launchd"), tunnel: mk("tunnel"), services: mk("services"), prompts: mk("prompts"), outputs: mk("outputs") };
  };

  it("answers with a stuck source as unknown instead of hanging, and the rest stay live", async () => {
    const calls: Record<string, number> = {};
    const feature = createSystemFeature({ layerReaders: LAYER_FAST, sourceTimeoutMs: 80, readers: { ...fast(calls), vault: () => new Promise(() => undefined) } });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;
    const t0 = Date.now();
    const res = await fetch(`${boot.base}/api/system`);
    const body = (await res.json()) as SystemResponse;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(body.unavailable).toEqual(["vault"]);
    const all = new Map(body.planes.flatMap((p) => p.nodes).map((n) => [n.id, n]));
    expect(all.get("machines.vault")?.status).toBe("unknown");
    expect(all.get("engine.hooks")?.status).toBe("ok");
  });

  it("shares one build between concurrent requests and serves the cache inside its ttl", async () => {
    const calls: Record<string, number> = {};
    const feature = createSystemFeature({ layerReaders: LAYER_FAST, ttlMs: 60_000, readers: fast(calls) });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;
    await Promise.all([1, 2, 3, 4].map((i) => fetch(`${boot.base}/api/system?n=${i}`).then((r) => r.json())));
    await fetch(`${boot.base}/api/system`);
    expect(calls.host).toBe(1);
    expect(calls.settings).toBe(1);
  });

  it("hides hostnames and paths with ?redact=1", async () => {
    const calls: Record<string, number> = {};
    const readers: Partial<SystemReaders> = { ...fast(calls), services: async () => [{ host: "private-host", port: 1, managed: true, up: true, dir: "x", public: false }], vault: async () => ({ path: "/Users/x/vault", notes: 1, lastCommitMs: NOW, mirrorMs: NOW, ahead: 0, brainGraphMs: NOW }) };
    const boot = await bootTestServer({ configOverrides: { features: [createSystemFeature({ layerReaders: LAYER_FAST, readers })] } });
    server = boot.server;
    const plain = await (await fetch(`${boot.base}/api/system`)).text();
    const hidden = await (await fetch(`${boot.base}/api/system?redact=1`)).text();
    expect(plain).toContain("private-host");
    expect(plain).toContain("/Users/x/vault");
    expect(hidden).not.toContain("private-host");
    expect(hidden).not.toContain("/Users/x/vault");
    expect(hidden).toContain("hidden");
  });
});

describe("always-live counts only managed services", () => {
  it("leaves manual entries out of the ratio and the down list", () => {
    const n = nodes(sources({ services: ok([{ host: "a", port: 1, managed: true, up: true, dir: "x", public: false }, { host: "b", port: 2, managed: false, up: false, dir: null, public: false }]) }));
    expect(n.get("services.live")?.value).toBe("1/1 answering · 1 manual");
    expect(n.get("services.live")?.status).toBe("ok");
    expect(n.get("services.down")?.value).toBe("none");
  });
});
