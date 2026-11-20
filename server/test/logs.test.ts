import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionLogFields, LogsMessage, LogsResponse } from "../../shared/features/logs.js";
import { appendToFeed, createFeedFeature } from "../features/feed.js";
import { createLogsFeature } from "../features/logs.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { log, onLogLine } from "../log.js";

function fakeCtx<T>(emitted: T[]): FeatureContext {
  const ctx = {
    featureId: "logs",
    emit: (p: unknown) => void emitted.push(p as T),
    db: { getSession: () => ({ cwd: "/repo" }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return ctx as unknown as FeatureContext;
}

async function getLogs(route: Route, ctx: FeatureContext, query: string): Promise<{ status: number; body: unknown }> {
  let body = "";
  let status = 0;
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (d: string) => {
      body = d;
    },
  };
  await route.handler({ url: `/api/logs${query}` } as never, res as never, ctx, {});
  return { status, body: JSON.parse(body) };
}

describe("logs feature", () => {
  it("log.info/warn/error lines show up in GET /api/logs", async () => {
    const feature = createLogsFeature({ now: () => 1000 });
    const route = feature.routes?.[0];
    if (!route) throw new Error("no route");
    const ctx = fakeCtx<LogsMessage>([]);
    log.info("logs-test-a", "an info line");
    log.warn("logs-test-b", "a warn line");
    log.error("logs-test-c", "an error line");
    const { status, body } = await getLogs(route, ctx, "?since=0");
    expect(status).toBe(200);
    const entries = (body as LogsResponse).entries;
    expect(entries.map((e) => [e.level, e.scope, e.message])).toEqual(
      expect.arrayContaining([
        ["info", "logs-test-a", "an info line"],
        ["warn", "logs-test-b", "a warn line"],
        ["error", "logs-test-c", "an error line"],
      ]),
    );
  });

  it("a well-formed action line becomes source action with its fields; a malformed one stays server", async () => {
    const feature = createLogsFeature({ now: () => 1000 });
    const route = feature.routes?.[0];
    if (!route) throw new Error("no route");
    const ctx = fakeCtx<LogsMessage>([]);
    const fields: ActionLogFields = { kind: "action", method: "POST", route: "/api/reactivate/abc", status: 200, ok: true, reason: null, durationMs: 9 };
    log.info("action", "POST /api/reactivate/abc → 200 in 9ms", fields);
    log.warn("action", "a malformed action line", { not: "valid" });
    const { body } = await getLogs(route, ctx, "?since=0");
    const entries = (body as LogsResponse).entries;
    const good = entries.find((e) => e.message.includes("POST /api/reactivate/abc"));
    const bad = entries.find((e) => e.message === "a malformed action line");
    expect(good?.source).toBe("action");
    expect(good?.action).toEqual(fields);
    expect(bad?.source).toBe("server");
    expect(bad?.action).toBeNull();
  });

  it("feed items become source-feed entries; 'activity' is skipped (the Feed tab already shows it)", async () => {
    const feature = createLogsFeature({ now: () => 1000 });
    const route = feature.routes?.[0];
    if (!route) throw new Error("no route");
    const ctx = fakeCtx<LogsMessage>([]);

    const feedFeature = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] } });
    const feedCtx = fakeCtx<unknown>([]);
    await feedFeature.onTick?.(feedCtx); // gives the feed a live context: appendToFeed flushes at once from here on

    appendToFeed({ id: "mac:1", at: "2026-09-28T00:00:00.000Z", kind: "mac", agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Opened Safari", detail: null, tag: null });
    appendToFeed({ id: "act:1", at: "2026-09-28T00:00:00.000Z", kind: "activity", agentId: "s1", title: "ran a tool", detail: "Bash", tag: "tool" });

    const { body } = await getLogs(route, ctx, "?since=0");
    const entries = (body as LogsResponse).entries;
    const mac = entries.find((e) => e.message === "Opened Safari");
    expect(mac?.source).toBe("feed");
    expect(mac?.scope).toBe("mac");
    expect(mac?.detail).toBe("aaaaaaaa");
    expect(entries.some((e) => e.message === "ran a tool")).toBe(false);
  });

  it("a feed item's own time (item.at) becomes the entry's ts, not ingest time — an old decision replayed on the feed's first tick must not read 'just now'", async () => {
    const feature = createLogsFeature({ now: () => Date.parse("2026-09-28T12:00:00.000Z") });
    const route = feature.routes?.[0];
    if (!route) throw new Error("no route");
    const ctx = fakeCtx<LogsMessage>([]);

    const feedFeature = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] } });
    const feedCtx = fakeCtx<unknown>([]);
    await feedFeature.onTick?.(feedCtx);

    appendToFeed({ id: "decision:old", at: "2026-06-08T03:03:15.000Z", kind: "decision", agentId: null, title: "an old decision", detail: null, tag: "note" });

    const { body } = await getLogs(route, ctx, "?since=0");
    const entries = (body as LogsResponse).entries;
    const old = entries.find((e) => e.message === "an old decision");
    expect(old?.ts).toBe("2026-06-08T03:03:15.000Z");
  });

  it("WS pushes arrive batched, at most 200 entries per push", async () => {
    const feature = createLogsFeature({ now: () => 1000 });
    const emitted: LogsMessage[] = [];
    const ctx = fakeCtx<LogsMessage>(emitted);
    for (let i = 0; i < 250; i++) log.info("batch-test", `line ${i}`);
    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.entries).toHaveLength(200);
    expect(emitted[1]?.entries).toHaveLength(50);
    expect(emitted[0]?.bootId).toBe(emitted[1]?.bootId);
  });

  it("a listener that itself logs terminates instead of recursing", () => {
    let calls = 0;
    const unsubscribe = onLogLine(() => {
      calls++;
      log.warn("recursive-from-listener", "this must not trigger another notify pass");
    });
    try {
      log.info("trigger", "go");
    } finally {
      unsubscribe();
    }
    expect(calls).toBe(1);
  });

  it("invalid query params → 400, naming the param", async () => {
    const feature = createLogsFeature({ now: () => 1000 });
    const route = feature.routes?.[0];
    if (!route) throw new Error("no route");
    const ctx = fakeCtx<LogsMessage>([]);
    const { status, body } = await getLogs(route, ctx, "?level=verbose");
    expect(status).toBe(400);
    expect((body as { ok: boolean }).ok).toBe(false);
    expect((body as { error: string }).error).toMatch(/level/);
  });

  it("a second instance on the same file loads the tail plus the 'server started' entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-world-logs-test-"));
    const filePath = join(dir, "town-log.ndjson");

    const a = createLogsFeature({ filePath, now: () => 1000 });
    const ctxA = fakeCtx<LogsMessage>([]);
    log.info("persisted-scope", "first line");
    log.warn("persisted-scope", "second line");
    await a.onTick?.(ctxA); // flushes the persist queue to disk
    expect(existsSync(filePath)).toBe(true);

    const b = createLogsFeature({ filePath, now: () => 2000 });
    const routeB = b.routes?.[0];
    if (!routeB) throw new Error("no route");
    const ctxB = fakeCtx<LogsMessage>([]);
    const { body } = await getLogs(routeB, ctxB, "?since=0");
    const messages = (body as LogsResponse).entries.map((e) => e.message);
    expect(messages).toContain("first line");
    expect(messages).toContain("second line");
    expect(messages.some((m) => m.startsWith("server started · loaded"))).toBe(true);
  });

  it("compacts the persisted file right after seeding, so a new boot's appended seqs never collide with the file's stale ones (regression: seed() renumbers 1..N without rewriting the file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-world-logs-test-"));
    const filePath = join(dir, "town-log.ndjson");

    // Boot 1: push past the load-slice cap (2000) so the next boot's seed() drops the head and
    // renumbers the tail — the exact condition that produces stale, un-rewritten file seqs.
    const a = createLogsFeature({ filePath, now: () => 1000 });
    const ctxA = fakeCtx<LogsMessage>([]);
    for (let i = 0; i < 2100; i++) log.info("seed-compact-boot1", `line ${i}`);
    await a.onTick?.(ctxA); // flushes the persist queue to disk

    // Boot 2: seeds from the tail of boot 1's file (renumbered 1..2000), then logs its own lines.
    const b = createLogsFeature({ filePath, now: () => 2000 });
    const ctxB = fakeCtx<LogsMessage>([]);
    log.info("seed-compact-boot2", "boot2 line A");
    log.info("seed-compact-boot2", "boot2 line B");
    await b.onTick?.(ctxB);

    // Boot 3: loads whatever boot 1 + boot 2 left on disk.
    const c = createLogsFeature({ filePath, now: () => 3000 });
    const routeC = c.routes?.[0];
    if (!routeC) throw new Error("no route");
    const ctxC = fakeCtx<LogsMessage>([]);
    const { body } = await getLogs(routeC, ctxC, "?since=0");
    const messages = (body as LogsResponse).entries.map((e) => e.message);

    // Pre-fix, boot 2's appends share seq numbers with boot 1's un-rewritten tail, so
    // parseNdjson's dedupe-by-seq buries them mid-list behind stale boot-1 lines. Post-fix they
    // land after everything boot 1 wrote.
    expect(messages).toContain("boot2 line A");
    expect(messages).toContain("boot2 line B");
    expect(messages).toContain("line 2099");
    expect(messages.indexOf("boot2 line B")).toBeGreaterThan(messages.indexOf("line 2099"));
  });

  it("persistence stays off under VITEST without an explicit filePath, even with ALEF_DB_PATH set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-world-logs-test-"));
    const prev = process.env.ALEF_DB_PATH;
    process.env.ALEF_DB_PATH = join(dir, "world.db");
    try {
      const feature = createLogsFeature({ now: () => 1000 }); // no filePath: VITEST is set
      const ctx = fakeCtx<LogsMessage>([]);
      log.info("no-persist-test", "should never touch disk");
      await feature.onTick?.(ctx);
      expect(existsSync(join(dir, "town-log.ndjson"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ALEF_DB_PATH;
      else process.env.ALEF_DB_PATH = prev;
    }
  });
});
