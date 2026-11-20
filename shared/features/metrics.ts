// Wire types for the "metrics" feature (Round 9 build item 4 — the bottom data dock):
// GET /api/metrics?range=1h|24h|7d returns one time series per number worth watching
// live. Gauges (live/waiting agents, tool calls in flight, active subagents, host CPU
// load, host memory used) are sampled in-process every 30s into a small ring buffer
// (server/features/metrics-lib.ts). Tokens and est. $ are NOT sampled here — they're
// read straight from the "usage" feature's own per-day sqlite store through its exact
// pure cost maths (shared/features/usage.ts's costForModel), bucketed by calendar day
// (that store's own grain — see server/features/metrics.ts for why finer isn't invented).

export type MetricsRange = "1h" | "24h" | "7d";

export const METRICS_RANGES: readonly MetricsRange[] = ["1h", "24h", "7d"];

export function isMetricsRange(v: unknown): v is MetricsRange {
  return v === "1h" || v === "24h" || v === "7d";
}

/** The 6 live gauges, sampled every 30s — everything except tokens/costUsd. */
export interface GaugeValues {
  liveAgents: number;
  waitingAgents: number;
  toolCalls: number;
  subagentsActive: number;
  cpuLoad: number;
  memUsedPct: number;
}

export type MetricKey = keyof GaugeValues | "tokens" | "costUsd";

export const METRIC_KEYS: readonly MetricKey[] = ["tokens", "costUsd", "liveAgents", "waitingAgents", "toolCalls", "subagentsActive", "cpuLoad", "memUsedPct"];

/** "" = a bare count, "$" = est. USD, "%" = a percentage, "load" = a unix load-average number. */
export type MetricUnit = "" | "$" | "%" | "load";

export interface MetricPoint {
  /** ms epoch — the bucket's closing edge (gauges) or the calendar day's local midnight (tokens/costUsd). */
  t: number;
  v: number;
}

export interface MetricSeries {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  /** "bar" for the day-bucketed usage-store series (tokens/costUsd); "area" for a 30s-sampled gauge. */
  kind: "area" | "bar";
  points: MetricPoint[];
}

export interface MetricsResponse {
  ok: true;
  range: MetricsRange;
  series: MetricSeries[];
}

export interface MetricsError {
  ok: false;
  error: string;
}

/** Snapshot extras key "metrics.latest": the newest gauge sample, for an instant paint
 *  (same role as the usage feature's "usage.today") before a client's own /api/metrics
 *  fetch lands. Nothing in this build wires a client feature to it yet (out of this
 *  builder's owned files — see client/src/shell/dock-charts.ts's header comment); it's
 *  here so that wiring is a pure addition later, not a server change too. */
export interface MetricsLatestExtra extends GaugeValues {
  atMs: number;
}

export const METRICS_LATEST_KEY = "metrics.latest";
