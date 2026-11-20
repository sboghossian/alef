// "metrics" feature (Round 9 build item 4): the bottom data dock's numbers.
//
// Live gauges — live/waiting agents, tool calls in flight, active subagents, host CPU
// load, host memory used — are sampled every 30s into a small in-process ring buffer
// (metrics-lib.ts's RingBuffer). Nothing new on disk, and nothing here survives a
// dev-server restart — that's fine, a gauge's history before this process started was
// never meaningful anyway.
//
// Tokens and est. $ are NOT sampled here: they're read straight from the "usage"
// feature's own per-day sqlite store (usage-store.ts) through its exact pure cost maths
// (shared/features/usage.js's costForModel) — never a second, parallel estimate of the
// same number. That store's grain is one calendar day, coarser than the gauges for the
// 1h/24h views; inventing finer buckets would mean inventing new maths this feature
// doesn't own, so the bar chart is honestly as coarse as the real data.
//
// "subagents active" is likewise read fresh off the subagents feature's own sqlite store
// (subagents/store.ts) through its own pure buildRecords/statsFor projection each tick,
// rather than keeping a second, potentially-stale copy of "is this subagent still
// running" in sync here.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { respondJson } from "../http.js";
import {
  isMetricsRange,
  METRICS_LATEST_KEY,
  type GaugeValues,
  type MetricPoint,
  type MetricSeries,
  type MetricsError,
  type MetricsLatestExtra,
  type MetricsRange,
  type MetricsResponse,
} from "../../shared/features/metrics.js";
import { addTokens, costForModel, totalTokens, ZERO_TOKENS, type TokenBucket } from "../../shared/features/usage.js";
import { bucketSamples, availableBytesFromVmStat, bucketSpecFor, dateKeyToMs, dayKeysForRange, memUsedPct, RingBuffer, type GaugeSample } from "./metrics-lib.js";
import { fleetTracker, type FleetTracker } from "./fleet-tracker.js";
import { UsageStore, usageStorePathFor } from "./usage-store.js";
import { buildRecords, statsFor } from "./subagents/pass.js";
import { SubagentStore, storePathFor as subagentsStorePathFor } from "./subagents/store.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const SAMPLE_INTERVAL_MS = 30_000;
/** 7 days of 30s samples, so the ring buffer alone can always cover the widest range —
 *  in practice a dev-server restart (tsx watch) resets it far more often than that. */
const RING_CAPACITY = Math.ceil((7 * 24 * 3_600_000) / SAMPLE_INTERVAL_MS);

interface Runtime {
  ring: RingBuffer<GaugeSample>;
  tracker: FleetTracker;
}

const runtimes = new Map<string, Runtime>();

function runtime(ctx: FeatureContext, tracker: FleetTracker): Runtime {
  const key = ctx.config.dbPath;
  let rt = runtimes.get(key);
  if (!rt) {
    rt = { ring: new RingBuffer<GaugeSample>(RING_CAPACITY), tracker };
    runtimes.set(key, rt);
  }
  return rt;
}

function pendingToolCalls(tracker: FleetTracker): number {
  let n = 0;
  for (const t of tracker.sessions.values()) n += t.pending.size;
  return n;
}

/** Fresh read of the subagents feature's own store: cheap (a handful of small JSON
 *  blobs) and always current, unlike keeping a shadow copy in sync with its writer. */
function liveSubagents(ctx: FeatureContext): number {
  let store: SubagentStore | null = null;
  try {
    store = new SubagentStore(subagentsStorePathFor(ctx.config.dbPath));
    const now = Date.now();
    return statsFor(buildRecords(store, now), now, null).live;
  } catch (err) {
    ctx.log.error("metrics", "reading subagents store failed", String(err));
    return 0;
  } finally {
    store?.close();
  }
}

const run = promisify(execFile);
async function freeBytes(): Promise<number> {
  if (process.platform !== "darwin") return os.freemem();
  try {
    const { stdout } = await run("vm_stat", [], { timeout: 3000 });
    return availableBytesFromVmStat(stdout) ?? os.freemem();
  } catch {
    return os.freemem();
  }
}

async function sample(ctx: FeatureContext, rt: Runtime): Promise<void> {
  await rt.tracker.ensureColdScan(ctx.config.projectsDir);
  const agents = ctx.worldViews().agents;
  const live = agents.filter((a) => a.status === "live");
  const gauge: GaugeSample = {
    t: Date.now(),
    cpuLoad: os.loadavg()[0] ?? 0,
    memUsedPct: memUsedPct(os.totalmem(), await freeBytes()),
    liveAgents: live.length,
    waitingAgents: live.filter((a) => a.awaitingInput).length,
    toolCalls: pendingToolCalls(rt.tracker),
    subagentsActive: liveSubagents(ctx),
  };
  rt.ring.push(gauge);
}

type GaugeKey = keyof GaugeValues;

const GAUGE_META: Record<GaugeKey, { label: string; unit: MetricSeries["unit"]; pick: (g: GaugeSample) => number }> = {
  liveAgents: { label: "Live agents", unit: "", pick: (g) => g.liveAgents },
  waitingAgents: { label: "Waiting on you", unit: "", pick: (g) => g.waitingAgents },
  toolCalls: { label: "Tool calls in flight", unit: "", pick: (g) => g.toolCalls },
  subagentsActive: { label: "Subagents active", unit: "", pick: (g) => g.subagentsActive },
  cpuLoad: { label: "CPU load", unit: "load", pick: (g) => g.cpuLoad },
  memUsedPct: { label: "Memory used", unit: "%", pick: (g) => g.memUsedPct },
};

const GAUGE_KEYS = Object.keys(GAUGE_META) as GaugeKey[];

function gaugeSeries(rt: Runtime, range: MetricsRange, nowMs: number): MetricSeries[] {
  const spec = bucketSpecFor(range);
  const samples = rt.ring.toArray();
  return GAUGE_KEYS.map((key) => {
    const meta = GAUGE_META[key];
    const raw = samples.map((s) => ({ t: s.t, v: meta.pick(s) }));
    return { key, label: meta.label, unit: meta.unit, kind: "area", points: bucketSamples(raw, spec, nowMs) } satisfies MetricSeries;
  });
}

/** Sums one day's tokens/cost across every city/session/model, through the usage
 *  feature's own store + pure cost maths (shared/features/usage.js) — never a second
 *  estimate of the same number. */
function dayTotals(store: UsageStore, date: string): { tokens: number; costUsd: number } {
  const byModel = new Map<string, TokenBucket>();
  for (const row of store.dayTokenRows(date)) byModel.set(row.model, addTokens(byModel.get(row.model) ?? ZERO_TOKENS, row.tokens));
  let tokens: TokenBucket = ZERO_TOKENS;
  let costUsd = 0;
  for (const [model, bucket] of byModel) {
    tokens = addTokens(tokens, bucket);
    const { costUsd: c } = costForModel(model, bucket);
    if (c !== null) costUsd += c;
  }
  return { tokens: totalTokens(tokens), costUsd };
}

function usageSeries(ctx: FeatureContext, range: MetricsRange, nowMs: number): MetricSeries[] {
  const tokensPoints: MetricPoint[] = [];
  const costPoints: MetricPoint[] = [];
  let store: UsageStore | null = null;
  try {
    store = new UsageStore(usageStorePathFor(ctx.config.dbPath));
    for (const date of dayKeysForRange(range, nowMs)) {
      const t = dateKeyToMs(date);
      if (Number.isNaN(t)) continue;
      const { tokens, costUsd } = dayTotals(store, date);
      tokensPoints.push({ t, v: tokens });
      costPoints.push({ t, v: costUsd });
    }
  } catch (err) {
    ctx.log.error("metrics", "reading usage store failed", String(err));
  } finally {
    store?.close();
  }
  return [
    { key: "tokens", label: "Tokens", unit: "", kind: "bar", points: tokensPoints },
    { key: "costUsd", label: "Est. $", unit: "$", kind: "bar", points: costPoints },
  ];
}

export function createMetricsFeature(tracker: FleetTracker = fleetTracker): ServerFeature {
  return {
    id: "metrics",
    tickIntervalMs: SAMPLE_INTERVAL_MS,
    routes: [
      {
        method: "GET",
        path: "/api/metrics",
        handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const rangeParam = url.searchParams.get("range") ?? "1h";
          if (!isMetricsRange(rangeParam)) {
            respondJson(res, 400, { ok: false, error: "range must be 1h, 24h or 7d" } satisfies MetricsError);
            return;
          }
          const now = Date.now();
          const series: MetricSeries[] = [...usageSeries(ctx, rangeParam, now), ...gaugeSeries(runtime(ctx, tracker), rangeParam, now)];
          respondJson(res, 200, { ok: true, range: rangeParam, series } satisfies MetricsResponse);
        },
      },
    ],
    async onTick(ctx) {
      await sample(ctx, runtime(ctx, tracker));
    },
    snapshotExtras(ctx) {
      const arr = runtime(ctx, tracker).ring.toArray();
      const last = arr[arr.length - 1];
      if (!last) return {};
      const extra: MetricsLatestExtra = {
        atMs: last.t,
        liveAgents: last.liveAgents,
        waitingAgents: last.waitingAgents,
        toolCalls: last.toolCalls,
        subagentsActive: last.subagentsActive,
        cpuLoad: last.cpuLoad,
        memUsedPct: last.memUsedPct,
      };
      return { [METRICS_LATEST_KEY]: extra };
    },
  };
}

export const metricsFeature: ServerFeature = createMetricsFeature();
