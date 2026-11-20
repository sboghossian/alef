// Event-loop lag: how long a timer had to wait for the loop. Every endpoint shares one loop, so a
// synchronous hot spot anywhere shows up here first. Logged once a minute and served on
// /api/health, so a stall can be seen (and dated) instead of guessed from slow requests.

import { monitorEventLoopDelay } from "node:perf_hooks";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export interface LoopLagWindow {
  /** When this window started (ISO). */
  since: string;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface LoopLagMonitor {
  /** The last full minute (null until one has passed) and the window still running. */
  snapshot(): { lastWindow: LoopLagWindow | null; current: LoopLagWindow };
  stop(): void;
}

/** Above this max lag in a window the minute's line is a warning, not info. */
export const LOOP_LAG_WARN_MS = 1_000;

const round = (ns: number): number => (Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0); // ns → ms, 0.1 ms

export function readWindow(h: Pick<IntervalHistogram, "percentile" | "max" | "mean" | "count">, since: number): LoopLagWindow {
  const empty = h.count === 0;
  return {
    since: new Date(since).toISOString(),
    p50Ms: empty ? 0 : round(h.percentile(50)),
    p99Ms: empty ? 0 : round(h.percentile(99)),
    maxMs: empty ? 0 : round(h.max),
    meanMs: empty ? 0 : round(h.mean),
  };
}

export function startLoopLagMonitor(opts: {
  log: { info(scope: string, message: string, extra?: unknown): void; warn(scope: string, message: string, extra?: unknown): void };
  intervalMs?: number;
  resolutionMs?: number;
  now?: () => number;
}): LoopLagMonitor {
  const now = opts.now ?? Date.now;
  const h = monitorEventLoopDelay({ resolution: opts.resolutionMs ?? 20 });
  h.enable();
  let since = now();
  let lastWindow: LoopLagWindow | null = null;
  const timer = setInterval(() => {
    lastWindow = readWindow(h, since);
    h.reset();
    since = now();
    const fields = { p50Ms: lastWindow.p50Ms, p99Ms: lastWindow.p99Ms, maxMs: lastWindow.maxMs };
    if (lastWindow.maxMs >= LOOP_LAG_WARN_MS) opts.log.warn("loop", "event-loop lag (last minute)", fields);
    else opts.log.info("loop", "event-loop lag (last minute)", fields);
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return {
    snapshot: () => ({ lastWindow, current: readWindow(h, since) }),
    stop() {
      clearInterval(timer);
      h.disable();
    },
  };
}
