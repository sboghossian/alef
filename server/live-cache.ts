// The one shared live detector. `ctx.detectLive()` is called from ~30 places (every worldViews(),
// /api/world, each WS connect, every tick), and each call used to run a blocking `ps aux` plus one
// blocking `lsof` per claude process. On a loaded box that froze the whole event loop for tens of
// seconds at a time. Now the probe runs off the loop (live.ts, async), at most one at a time, and
// readers get the latest result synchronously.

import type { LiveProbe } from "./live.js";

/** What the last probe said, for checks that must tell "ps timed out" from "nothing is running". */
export interface LiveStatus {
  /** True when the latest probe read the process table. */
  ok: boolean;
  /** When the latest probe finished (ms), or null before the first one. */
  at: number | null;
  /** How long the latest probe took. */
  durationMs: number | null;
  /** When the map `current()` serves was read (the last good probe), or null. */
  lastGoodAt: number | null;
  error: string | null;
}

export interface LiveDetectorOptions {
  probe: () => Promise<LiveProbe>;
  /** A read older than this starts a background refresh (the reader still gets the old map). */
  maxAgeMs?: number;
  /** A last good map older than this is no longer served after a failed probe: empty instead. */
  keepGoodMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface LiveDetector {
  /** The latest cwd → claude-process count. Never blocks; starts a refresh when stale. */
  current(): Map<string, number>;
  /** Runs a probe now, or joins the one in flight. Never rejects. */
  refresh(): Promise<void>;
  status(): LiveStatus;
}

export const LIVE_MAX_AGE_MS = 3_000;
const KEEP_GOOD_MS = 120_000;

export function createLiveDetector(opts: LiveDetectorOptions): LiveDetector {
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? LIVE_MAX_AGE_MS;
  const keepGoodMs = opts.keepGoodMs ?? KEEP_GOOD_MS;
  let good: { at: number; cwds: Map<string, number> } | null = null;
  let last: { at: number; ok: boolean; durationMs: number; error: string | null } | null = null;
  let inFlight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    const t0 = now();
    inFlight = opts
      .probe()
      .then(
        (r) => {
          const at = now();
          last = { at, ok: r.ok, durationMs: at - t0, error: r.ok ? null : (r.error ?? "probe failed") };
          if (r.ok) good = { at, cwds: r.cwds };
        },
        (err: unknown) => {
          const at = now();
          last = { at, ok: false, durationMs: at - t0, error: String(err) };
          opts.onError?.(err);
        },
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    current() {
      const t = now();
      if (!last || t - last.at >= maxAgeMs) void refresh();
      if (!good || t - good.at > keepGoodMs) return new Map();
      return new Map(good.cwds);
    },
    refresh,
    status() {
      return {
        ok: last?.ok ?? false,
        at: last?.at ?? null,
        durationMs: last?.durationMs ?? null,
        lastGoodAt: good?.at ?? null,
        error: last ? last.error : "not probed yet",
      };
    },
  };
}
