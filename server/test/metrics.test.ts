// Route + onTick tests for the "metrics" feature. onTick is called directly (the pattern
// usage.test.ts/loops.test.ts use for a background-sampling feature) so the ring buffer
// fills deterministically instead of waiting on a real 30s timer.

import { afterEach, describe, expect, it } from "vitest";
import type { MetricsError, MetricsResponse } from "../../shared/features/metrics.js";
import { costForModel } from "../../shared/features/usage.js";
import { createMetricsFeature } from "../features/metrics.js";
import { FleetTracker } from "../features/fleet-tracker.js";
import type { FeatureContext } from "../features/registry.js";
import { UsageStore, usageStorePathFor } from "../features/usage-store.js";
import type { RunningServer } from "../index.js";
import { log } from "../log.js";
import { bootTestServer } from "./helpers.js";
import type { WorldAgent } from "../../shared/types.js";

const agent = (id: string, opts: Partial<WorldAgent> = {}): WorldAgent =>
  ({
    id,
    islandId: "acme-ai-next",
    cwd: "/ws/acme",
    title: id,
    status: "live",
    startedAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messageCount: 1,
    model: "claude-sonnet-5",
    role: "generalist",
    color: "#000",
    targetIslandId: "acme-ai-next",
    tokens: 0,
    awaitingInput: false,
    ...opts,
  }) as WorldAgent;

function makeCtx(dir: string, tracker: FleetTracker, agents: WorldAgent[]): FeatureContext {
  return {
    db: {} as unknown as FeatureContext["db"],
    config: { projectsDir: `${dir}/projects`, dbPath: `${dir}/world.db` } as unknown as FeatureContext["config"],
    log,
    detectLive: () => new Map(),
    executors: { reactivate: () => Promise.reject(new Error("unused")), dispatch: () => Promise.reject(new Error("unused")), openEditor: () => Promise.reject(new Error("unused")) },
    broadcast: () => {},
    worldViews: () => ({ agents, objects: [], edges: [], islands: [] }),
    featureId: "metrics",
    emit: () => {},
  };
}

describe("GET /api/metrics", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("400s on an invalid range", async () => {
    const feature = createMetricsFeature();
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    const res = await fetch(`${base}/api/metrics?range=3d`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as MetricsError).ok).toBe(false);
  });

  it("defaults to 1h when range is omitted, with no data sampled yet", async () => {
    const feature = createMetricsFeature();
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    const res = await fetch(`${base}/api/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(body.ok).toBe(true);
    expect(body.range).toBe("1h");
    const keys = body.series.map((s2) => s2.key).sort();
    expect(keys).toEqual(["costUsd", "cpuLoad", "liveAgents", "memUsedPct", "subagentsActive", "toolCalls", "tokens", "waitingAgents"].sort());
    const live = body.series.find((s2) => s2.key === "liveAgents")!;
    expect(live.points).toHaveLength(30); // 1h / 2min buckets
    expect(live.points.every((p) => p.v === 0)).toBe(true); // never sampled: 0, not fabricated
  });

  it("24h and 7d use their own bucket counts", async () => {
    const feature = createMetricsFeature();
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    const day = (await (await fetch(`${base}/api/metrics?range=24h`)).json()) as MetricsResponse;
    const week = (await (await fetch(`${base}/api/metrics?range=7d`)).json()) as MetricsResponse;
    expect(day.series.find((s2) => s2.key === "cpuLoad")!.points).toHaveLength(48);
    expect(week.series.find((s2) => s2.key === "cpuLoad")!.points).toHaveLength(42);
  });

  it("onTick samples live/waiting agents and tool calls in flight into the ring buffer", async () => {
    const tracker = new FleetTracker();
    // One tool_use with no matching tool_result yet = one call still "in flight".
    tracker.ingestLine("sess-1", JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }));
    const feature = createMetricsFeature(tracker);
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const agents = [agent("a", { status: "live", awaitingInput: true }), agent("b", { status: "live", awaitingInput: false }), agent("c", { status: "dormant" })];
    const ctx = makeCtx(dir, tracker, agents);
    await feature.onTick!(ctx);

    const res = await fetch(`${base}/api/metrics?range=1h`);
    const body = (await res.json()) as MetricsResponse;
    const last = (key: string): number => {
      const series = body.series.find((s2) => s2.key === key)!;
      return series.points[series.points.length - 1]!.v;
    };
    expect(last("liveAgents")).toBe(2);
    expect(last("waitingAgents")).toBe(1);
    expect(last("toolCalls")).toBe(1);
    expect(last("subagentsActive")).toBe(0); // no subagents.db data: real 0, not fabricated
  });

  it("reads tokens/est. $ straight from the usage store's own per-day totals and cost maths", async () => {
    const feature = createMetricsFeature();
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const store = new UsageStore(usageStorePathFor(`${dir}/world.db`));
    const today = new Date().toISOString().slice(0, 10);
    store.addTokens(today, "acme-ai-next", "sess-1", "claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    });
    store.close();

    const res = await fetch(`${base}/api/metrics?range=1h`);
    const body = (await res.json()) as MetricsResponse;
    const tokensSeries = body.series.find((s2) => s2.key === "tokens")!;
    const costSeries = body.series.find((s2) => s2.key === "costUsd")!;
    expect(tokensSeries.kind).toBe("bar");
    expect(tokensSeries.points[tokensSeries.points.length - 1]!.v).toBe(1_000_000);
    const expected = costForModel("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }).costUsd;
    expect(costSeries.points[costSeries.points.length - 1]!.v).toBeCloseTo(expected!, 6);
  });
});
