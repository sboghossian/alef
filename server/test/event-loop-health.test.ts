import { afterEach, describe, expect, it } from "vitest";
import { createLiveDetector } from "../live-cache.js";
import { lsofCwdsOrNull, parseLsofCwds, parsePsAux, type LiveProbe } from "../live.js";
import { readWindow, startLoopLagMonitor } from "../loop-lag.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("live.ts parsers", () => {
  it("parsePsAux keeps pid + full command and drops the header, blank lines and our own pid", () => {
    const raw = [
      "USER   PID  %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND",
      "me     101  0.0  0.1  1   1   ??  S    6:00AM  0:00 /opt/homebrew/bin/claude --resume abc",
      "me     202  0.0  0.1  1   1   ??  S    6:00AM  0:00 node server.js",
      "",
      "me     303  0.0  0.1  1   1   ??  S    6:00AM  0:00 ps aux",
    ].join("\n");
    expect(parsePsAux(raw, 202)).toEqual([
      { pid: 101, command: "/opt/homebrew/bin/claude --resume abc" },
      { pid: 303, command: "ps aux" },
    ]);
  });

  it("parseLsofCwds reads one lsof -Fpn answer for many pids (a gone pid just has no line)", () => {
    const out = "p75961\nfcwd\nn/Users/me\np76580\nfcwd\nn/Users/me/Documents/Code/a repo\np80451\nfcwd\n";
    expect([...parseLsofCwds(out)]).toEqual([
      [75961, "/Users/me"],
      [76580, "/Users/me/Documents/Code/a repo"],
    ]);
  });
});

describe("lsofCwdsOrNull", () => {
  const out = "p1\nfcwd\nn/a\n";
  it("keeps a clean answer, and a partial one when lsof only exited 1 for a gone pid", () => {
    expect([...(lsofCwdsOrNull(null, out) ?? [])]).toEqual([[1, "/a"]]);
    expect([...(lsofCwdsOrNull(Object.assign(new Error("exit 1"), { killed: false, signal: null }), out) ?? [])]).toEqual([[1, "/a"]]);
  });

  it("is null (a failed probe, not 'nothing running') when lsof timed out or gave nothing", () => {
    expect(lsofCwdsOrNull(Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" as const }), out)).toBeNull();
    expect(lsofCwdsOrNull(Object.assign(new Error("exit 1"), { killed: false, signal: null }), "")).toBeNull();
  });
});

describe("createLiveDetector", () => {
  it("never blocks: the first read is empty and starts one probe; concurrent reads share it", async () => {
    let calls = 0;
    const d = deferred<LiveProbe>();
    const live = createLiveDetector({ probe: () => (calls++, d.promise) });
    expect(live.current().size).toBe(0);
    expect(live.current().size).toBe(0);
    void live.refresh();
    expect(calls).toBe(1);
    d.resolve({ ok: true, cwds: new Map([["/a", 2]]) });
    await live.refresh();
    expect(live.current().get("/a")).toBe(2);
    expect(live.status()).toMatchObject({ ok: true, error: null });
  });

  it("serves the old map while a stale read refreshes in the background", async () => {
    let t = 0;
    let n = 0;
    const live = createLiveDetector({ probe: async () => ({ ok: true, cwds: new Map([["/a", ++n]]) }), now: () => t, maxAgeMs: 3_000 });
    await live.refresh();
    t = 1_000;
    expect(live.current().get("/a")).toBe(1); // fresh: no new probe
    t = 4_000;
    expect(live.current().get("/a")).toBe(1); // stale: still the old answer, probe started
    await live.refresh();
    expect(live.current().get("/a")).toBe(2);
    expect(n).toBe(2);
  });

  it("a failed probe (ps timed out) keeps the last good map for a while and says it failed", async () => {
    let t = 0;
    let fail = false;
    const live = createLiveDetector({
      probe: async () => (fail ? { ok: false, cwds: new Map(), error: "ps aux timed out or failed" } : { ok: true, cwds: new Map([["/a", 1]]) }),
      now: () => t,
      keepGoodMs: 60_000,
    });
    await live.refresh();
    fail = true;
    t = 10_000;
    await live.refresh();
    expect(live.current().get("/a")).toBe(1);
    expect(live.status()).toMatchObject({ ok: false, error: "ps aux timed out or failed", lastGoodAt: 0 });
    t = 70_000;
    await live.refresh();
    expect(live.current().size).toBe(0); // too old to vouch for anything now
  });

  it("a probe that throws is reported, never rethrown", async () => {
    const errors: unknown[] = [];
    const live = createLiveDetector({ probe: async () => Promise.reject(new Error("boom")), onError: (e) => errors.push(e) });
    await expect(live.refresh()).resolves.toBeUndefined();
    expect(live.status().ok).toBe(false);
    expect(live.status().error).toContain("boom");
    expect(errors).toHaveLength(1);
  });
});

describe("loop-lag", () => {
  it("readWindow converts ns to ms and reads an empty window as zeros", () => {
    const h = { count: 3, percentile: (p: number) => (p === 50 ? 21_000_000 : 400_000_000), max: 2_621_000_000, mean: 30_000_000 };
    expect(readWindow(h, 0)).toEqual({ since: new Date(0).toISOString(), p50Ms: 21, p99Ms: 400, maxMs: 2621, meanMs: 30 });
    expect(readWindow({ count: 0, percentile: () => Number.NaN, max: 0, mean: Number.NaN }, 0).p99Ms).toBe(0);
  });

  it("sees a synchronous block, logs the minute as a warning and rolls the window", async () => {
    const lines: Array<{ level: string; extra: unknown }> = [];
    const mon = startLoopLagMonitor({
      log: { info: (_s, _m, extra) => lines.push({ level: "info", extra }), warn: (_s, _m, extra) => lines.push({ level: "warn", extra }) },
      intervalMs: 1_500,
      resolutionMs: 10,
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const until = Date.now() + 1_100;
      while (Date.now() < until) {
        /* block the loop on purpose */
      }
      await new Promise((r) => setTimeout(r, 50)); // the delay is recorded once the loop runs again
      expect(mon.snapshot().current.maxMs).toBeGreaterThanOrEqual(1_000);
      await new Promise((r) => setTimeout(r, 1_600));
      expect(lines[0]?.level).toBe("warn");
      expect(mon.snapshot().lastWindow?.maxMs).toBeGreaterThanOrEqual(1_000);
    } finally {
      mon.stop();
    }
  });
});

describe("GET /api/health", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("answers with the event-loop lag and the live probe's status", async () => {
    const boot = await bootTestServer();
    server = boot.server;
    const body = (await (await fetch(`${boot.base}/api/health`)).json()) as {
      ok: boolean;
      indexedSessions: number;
      eventLoop: { lastWindow: unknown; current: { maxMs: number; p99Ms: number } };
      live: { ok: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.indexedSessions).toBe(0);
    expect(body.eventLoop.lastWindow).toBeNull();
    expect(typeof body.eventLoop.current.maxMs).toBe("number");
    expect(body.live.ok).toBe(true); // an injected detector is trusted
  });
});
