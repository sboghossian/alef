import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemResponse } from "../../shared/features/system.js";
import type { RunningServer } from "../index.js";
import { classifyJob, parseTunnelHostnames, readLaunchd, readTunnel } from "../features/system-collectors.js";
import { parsePlistXml } from "../features/routines-lib.js";
import { REFRESH_MIN_GAP_MS, createSystemFeature, type SystemReaders } from "../features/system.js";
import { memoryByType, parseServices, readSettings } from "../features/system-probe.js";
import { buildPlanes } from "../features/system-nodes.js";
import { bootTestServer } from "./helpers.js";
import { LAYER_FAST } from "./system-layers-fixtures.js";

const POST = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
const NOW = Date.parse("2026-10-14T12:00:00Z");
const NONE = Object.fromEntries(["host", "claudeVersion", "settings", "harness", "memory", "vault", "mini", "routines", "launchd", "tunnel", "services", "prompts", "outputs"].map((k) => [k, { ok: false, error: "x" }]));
const plist = (label: string, body: string): string => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string>${body}</dict></plist>`;
const INTERVAL = "<key>StartInterval</key><integer>900</integer>";
const CAL = "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>";
const KEEP = "<key>KeepAlive</key><true/>";
const LIST = "PID\tStatus\tLabel\n-\t0\tcom.stephane.sched\n-\t1\tcom.stephane.cal\n4242\t0\tdev.dashable.svc\n";

let tmp = "";
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});
async function home(files: Record<string, string>): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "sysc-"));
  await mkdir(join(tmp, "Library", "LaunchAgents"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(tmp, "Library", "LaunchAgents", name), body);
  return tmp;
}

describe("launchd collector", () => {
  it("classifies KeepAlive over schedules, schedules, and everything else", () => {
    expect(classifyJob(parsePlistXml(plist("a", INTERVAL)))).toBe("scheduled");
    expect(classifyJob(parsePlistXml(plist("a", CAL)))).toBe("scheduled");
    expect(classifyJob(parsePlistXml(plist("a", KEEP + INTERVAL)))).toBe("always-on");
    expect(classifyJob(parsePlistXml(plist("a", "<key>KeepAlive</key><false/>")))).toBe("other");
    expect(classifyJob(parsePlistXml(plist("a", "<key>RunAtLoad</key><true/>")))).toBe("other");
    expect(classifyJob(null)).toBe("other");
  });
  it("reads plists with loaded, running and last exit; skips vendors, backups and binary plists", async () => {
    const h = await home({
      "com.stephane.sched.plist": plist("com.stephane.sched", INTERVAL),
      "com.stephane.cal.plist": plist("com.stephane.cal", CAL),
      "dev.dashable.svc.plist": plist("dev.dashable.svc", KEEP),
      "com.stephane.off.plist": plist("com.stephane.off", INTERVAL),
      "com.google.keystone.agent.plist": plist("com.google.keystone.agent", KEEP),
      "dev.dashable.boo.plist.bak.2026": "x",
      "com.stephane.bin.plist": "bplist00\u0000\u0001garbage",
    });
    const r = await readLaunchd(h, NOW, async () => LIST);
    const by = new Map(r.jobs.map((j) => [j.label, j]));
    expect(r.launchctlRead).toBe(true);
    expect(by.has("com.google.keystone.agent")).toBe(false);
    expect([...by.keys()].some((k) => k.includes("bak"))).toBe(false);
    expect(by.get("com.stephane.sched")).toMatchObject({ kind: "scheduled", schedule: "every 15 min", loaded: true, running: false, lastExit: 0 });
    expect(by.get("com.stephane.cal")).toMatchObject({ kind: "scheduled", lastExit: 1 });
    expect(by.get("dev.dashable.svc")).toMatchObject({ kind: "always-on", schedule: "keep alive", running: true });
    expect(by.get("com.stephane.off")).toMatchObject({ loaded: false });
    expect(by.get("com.stephane.bin")?.kind).toBe("other");
  });
  it("never surfaces EnvironmentVariables or program arguments (plists can hold API keys)", async () => {
    const env = "<key>EnvironmentVariables</key><dict><key>OPENAI_API_KEY</key><string>sk-SECRET-VALUE-123</string></dict>";
    const args = "<key>ProgramArguments</key><array><string>/bin/run</string><string>--token=TOPSECRET-ARG</string></array>";
    const h = await home({ "com.stephane.sec.plist": plist("com.stephane.sec", INTERVAL + env + args) });
    const r = await readLaunchd(h, NOW, async () => LIST);
    const dump = JSON.stringify(r);
    expect(r.jobs).toHaveLength(1);
    for (const secret of ["sk-SECRET-VALUE-123", "OPENAI_API_KEY", "TOPSECRET-ARG"]) expect(dump).not.toContain(secret);
  });
  it("tunnel parsing returns hostnames only, never the credentials-file path", () => {
    const yml = "tunnel: abc\ncredentials-file: /Users/x/.cloudflared/SECRET-CRED.json\ningress:\n  - hostname: a.dashable.dev\n    service: http://localhost:1\n  - service: http_status:404\n";
    const out = JSON.stringify(parseTunnelHostnames(yml));
    expect(out).toBe('["a.dashable.dev"]');
  });
  it("says load is unknown (not 'off') when launchctl list cannot be read", async () => {
    const h = await home({ "com.stephane.sched.plist": plist("com.stephane.sched", INTERVAL) });
    const r = await readLaunchd(h, NOW, async () => null);
    expect(r.launchctlRead).toBe(false);
    expect(r.jobs[0]?.loaded).toBeNull();
    const nodes = new Map(buildPlanes(NOW, { ...NONE, launchd: { ok: true, value: r } } as never).flatMap((p) => p.nodes).map((n) => [n.id, n]));
    expect(nodes.get("services.scheduled")?.status).toBe("unknown");
  });
  it("rejects when the LaunchAgents folder is missing, so the node reads unknown", async () => {
    tmp = await mkdtemp(join(tmpdir(), "sysc-"));
    await expect(readLaunchd(tmp, NOW, async () => LIST)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("tunnel and fleet map", () => {
  const CFG = "tunnel: abc\ncredentials-file: /Users/x/.cloudflared/SECRET.json\ningress:\n  - hostname: aleph.dashable.dev\n    service: http://127.0.0.1:4779\n  - hostname: yalla.dashable.dev\n    service: http://127.0.0.1:4787\n  - service: http_status:404\n";
  it("returns hostnames only", () => {
    expect(parseTunnelHostnames(CFG)).toEqual(["aleph.dashable.dev", "yalla.dashable.dev"]);
    expect(JSON.stringify(parseTunnelHostnames(CFG))).not.toContain("SECRET");
  });
  it("reads the config from ~/.cloudflared/dashable/config.yml", async () => {
    tmp = await mkdtemp(join(tmpdir(), "sysc-"));
    await mkdir(join(tmp, ".cloudflared", "dashable"), { recursive: true });
    await writeFile(join(tmp, ".cloudflared", "dashable", "config.yml"), CFG);
    expect((await readTunnel(tmp)).hostnames).toHaveLength(2);
  });
  it("parses folder and public flag of services.yml", () => {
    const yml = "services:\n  - host: crm\n    port: 4200\n    dir: acme-crm\n    public: true\n  - host: brain\n    port: 3838\n    dir: \"/abs/brain\"\n";
    expect(parseServices(yml)).toEqual([
      { host: "crm", port: 4200, managed: true, dir: "acme-crm", public: true },
      { host: "brain", port: 3838, managed: true, dir: "/abs/brain", public: false },
    ]);
  });
  it("shows a public hostname whose managed service is down as a warning", () => {
    const svc = { ok: true as const, value: [{ host: "yalla", port: 1, managed: true, up: false, dir: "yalla", public: true }, { host: "aleph", port: 2, managed: true, up: true, dir: "aleph", public: true }] };
    const n = new Map(buildPlanes(NOW, { ...NONE, tunnel: { ok: true, value: { hostnames: ["yalla.dashable.dev", "aleph.dashable.dev"] } }, services: svc } as never).flatMap((p) => p.nodes).map((x) => [x.id, x]));
    expect(n.get("services.public")).toMatchObject({ value: "2 public · 1 down", status: "warn" });
    expect(n.get("services.live")?.facts.find((f) => f.label === "Down")?.value).toBe("yalla :1 → yalla · public");
  });
});

describe("hooks per event, memory by type, MCP names", () => {
  it("counts hooks per event from settings.json", async () => {
    tmp = await mkdtemp(join(tmpdir(), "sysc-"));
    await mkdir(join(tmp, ".claude"), { recursive: true });
    const hooks = { PreToolUse: [{ hooks: [{ command: "a.sh" }, { command: "b.sh" }] }], Stop: [{ hooks: [{ command: "c.sh" }] }] };
    await writeFile(join(tmp, ".claude", "settings.json"), JSON.stringify({ hooks, model: "opus" }));
    const s = await readSettings({ home: tmp, vaultRoot: tmp, memoryDir: tmp });
    expect(s.hookByEvent).toEqual([{ event: "PreToolUse", count: 2 }, { event: "Stop", count: 1 }]);
    expect(s.hookCount).toBe(3);
  });
  it("buckets memory files by name prefix and ignores the index", () => {
    expect(memoryByType(["MEMORY.md", "feedback_a.md", "feedback_b.md", "project_x.md", "notes.md", "user_me.md", "img.png"])).toEqual({ feedback: 2, project: 1, user: 1, other: 1 });
  });
});

describe("system API: unknown, redact, refresh", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const base: Partial<SystemReaders> = {
    host: async () => ({ load1: 1, cpus: 8, uptimeSec: 100 }),
    claudeVersion: async () => "2.1.0",
    settings: async () => ({ model: "opus", effort: "high", hookCount: 1, hookEvents: ["Stop"], hookByEvent: [{ event: "Stop", count: 1 }], permissionHook: true, denyCount: 1, allowCount: 1 }),
    harness: async () => ({ skills: 1, agents: 1, mcp: 1, mcpNames: ["linear"] }),
    memory: async () => ({ files: 1, byType: { project: 1 }, indexLines: 1 }),
    vault: async () => ({ path: "/p", notes: 1, lastCommitMs: NOW, mirrorMs: NOW, ahead: 0, brainGraphMs: NOW }),
    mini: async () => ({ configured: false, reachable: null }),
    routines: async () => ({ total: 1, loaded: 1, paused: 0, running: 0, failed: 0, firedToday: 0, voiceLoaded: null }),
    launchd: async () => ({ launchctlRead: true, jobs: [{ label: "com.stephane.secretjob", kind: "scheduled", schedule: "daily 08:00", loaded: true, running: false, lastExit: 0 }] }),
    tunnel: async () => ({ hostnames: ["hidden-me.dashable.dev"] }),
    services: async () => [{ host: "svc", port: 1, managed: true, up: true, dir: "folder-secret", public: true }],
    prompts: async () => ({ sessionsToday: 0, liveNow: null }),
    outputs: async () => ({ prsToday: null, shippedToday: null, artifactsToday: null }),
  };
  it("a stuck launchd or tunnel source makes only its nodes unknown", async () => {
    const boot = await bootTestServer({ configOverrides: { features: [createSystemFeature({ layerReaders: LAYER_FAST, sourceTimeoutMs: 60, readers: { ...base, launchd: () => new Promise(() => undefined), tunnel: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })) } })] } });
    server = boot.server;
    const body = (await (await fetch(`${boot.base}/api/system`)).json()) as SystemResponse;
    const n = new Map(body.planes.flatMap((p) => p.nodes).map((x) => [x.id, x]));
    expect(body.unavailable.sort()).toEqual(["launchd", "tunnel"]);
    for (const id of ["services.scheduled", "services.always", "services.public"]) expect(n.get(id)?.status).toBe("unknown");
    expect(n.get("services.live")?.status).toBe("ok");
  });
  it("redacts hostnames and folders", async () => {
    const boot = await bootTestServer({ configOverrides: { features: [createSystemFeature({ layerReaders: LAYER_FAST, readers: base })] } });
    server = boot.server;
    const plain = await (await fetch(`${boot.base}/api/system`)).text();
    const hidden = await (await fetch(`${boot.base}/api/system?redact=1`)).text();
    for (const secret of ["hidden-me.dashable.dev", "folder-secret"]) {
      expect(plain).toContain(secret);
      expect(hidden).not.toContain(secret);
    }
  });
  it("refresh forces a rebuild, joins nothing stale, and a second press inside the gap gets 429", async () => {
    let clock = NOW;
    let hostCalls = 0;
    const readers: Partial<SystemReaders> = { ...base, host: async () => (hostCalls++, { load1: 1, cpus: 8, uptimeSec: 1 }) };
    const boot = await bootTestServer({ configOverrides: { features: [createSystemFeature({ layerReaders: LAYER_FAST, readers, ttlMs: 600_000, now: () => clock })] } });
    server = boot.server;
    await fetch(`${boot.base}/api/system`);
    expect(hostCalls).toBe(1);
    const r1 = await fetch(`${boot.base}/api/system/refresh`, POST);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as SystemResponse).planes.length).toBe(8);
    expect(hostCalls).toBe(2);
    const r2 = await fetch(`${boot.base}/api/system/refresh`, POST);
    expect(r2.status).toBe(429);
    expect(((await r2.json()) as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(hostCalls).toBe(2);
    clock += REFRESH_MIN_GAP_MS + 1;
    expect((await fetch(`${boot.base}/api/system/refresh`, POST)).status).toBe(200);
    expect(hostCalls).toBe(3);
  });
  it("concurrent refreshes in flight share one build", async () => {
    let hostCalls = 0;
    const readers: Partial<SystemReaders> = { ...base, host: async () => (hostCalls++, await new Promise((r) => setTimeout(r, 80)), { load1: 1, cpus: 8, uptimeSec: 1 }) };
    const boot = await bootTestServer({ configOverrides: { features: [createSystemFeature({ layerReaders: LAYER_FAST, readers })] } });
    server = boot.server;
    const rs = await Promise.all([1, 2, 3].map(() => fetch(`${boot.base}/api/system/refresh`, POST)));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(hostCalls).toBe(1);
  });
});
