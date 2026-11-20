// "system" (🧭 System view): the whole setup at a glance as one hub and spoke. ONE aggregator,
//
//   GET /api/system            -> SystemResponse (shared/features/system.ts)
//   GET /api/system?redact=1   -> same, hostnames and paths replaced by "hidden"
//
// Stale-while-revalidate like the atlas: 30 s, a request answers from the last build at once and a
// refresh runs in the background; concurrent refreshes join ONE build (cache-lib createSwr). Every
// source has its own deadline (settle): a slow or broken one makes only its nodes "unknown", it
// never holds the answer. Read-only: files, `git log`, `claude --version` and a 500 ms TCP connect
// per always-live port. It starts, stops and writes nothing. The readers are in system-probe.ts,
// the node and status rules in system-nodes.ts / system-lib.ts.

import { respondJson } from "../http.js";
import { createSwr, type Swr } from "./cache-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import type { SystemResponse } from "../../shared/features/system.js";
import { readLaunchd, readTunnel } from "./system-collectors.js";
import { dropFleetCache, defaultDirs, readClaudeVersion, readHarness, readHost, readMemory, readMini, readOutputs, readPrompts, readRoutines, readServices, readSettings, readVault, type ProbeDirs } from "./system-probe.js";
import { redactSystem, settle, type Settled } from "./system-lib.js";
import { buildPlanes, type SystemSources } from "./system-nodes.js";
import { buildLayers, type LayerSources } from "./system-layers.js";
import { readConduct, readFleet, readJev, readMcpMeta, readMemoryExtra, readRecall, readRuntimes, readSkillMeta } from "./system-layers-probe.js";

const TTL_MS = 30_000;
const SOURCE_TIMEOUT_MS = 4_000;
/** The Refresh button may force a rebuild at most this often (a build probes ports and runs launchctl). */
export const REFRESH_MIN_GAP_MS = 10_000;

/** One reader per source; the value type is the one the node builder expects. */
export type SystemReaders = { [K in keyof SystemSources]: (ctx: FeatureContext) => Promise<SystemSources[K] extends Settled<infer T> ? T : never> };

export type LayerReaders = { [K in keyof LayerSources]: (ctx: FeatureContext) => Promise<LayerSources[K] extends Settled<infer T> ? T : never> };

export interface SystemFeatureDeps {
  dirs?: ProbeDirs;
  readers?: Partial<SystemReaders>;
  layerReaders?: Partial<LayerReaders>;
  /** Per-source deadline (tests). */
  sourceTimeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

export function createSystemFeature(deps: SystemFeatureDeps = {}): ServerFeature {
  const dirs = deps.dirs ?? defaultDirs();
  const now = deps.now ?? Date.now;
  const ms = deps.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS;
  const ttl = deps.ttlMs ?? TTL_MS;
  const readers: SystemReaders = {
    host: () => readHost(),
    claudeVersion: () => readClaudeVersion(),
    settings: () => readSettings(dirs),
    harness: () => readHarness(dirs),
    memory: () => readMemory(dirs),
    vault: () => readVault(dirs),
    mini: () => readMini(dirs),
    routines: () => readRoutines(now()),
    launchd: () => readLaunchd(dirs.home, now()),
    tunnel: () => readTunnel(dirs.home),
    services: () => readServices(dirs),
    prompts: (ctx) => readPrompts(ctx, now()),
    outputs: () => readOutputs(now()),
    ...deps.readers,
  };
  const layerReaders: LayerReaders = {
    conduct: () => readConduct(dirs),
    runtimes: () => readRuntimes(dirs),
    fleet: () => readFleet(dirs, now()),
    jev: () => readJev(dirs, now()),
    skillMeta: () => readSkillMeta(dirs),
    mcpMeta: () => readMcpMeta(dirs),
    memoryExtra: () => readMemoryExtra(dirs, now()),
    recall: () => readRecall(dirs),
    ...deps.layerReaders,
  };
  const swrs = new Map<string, Swr<SystemResponse>>();
  const lastForced = new Map<string, number>();

  async function build(ctx: FeatureContext): Promise<SystemResponse> {
    const names = Object.keys(readers) as Array<keyof SystemSources>;
    const settled = await Promise.all(names.map((n) => settle(() => readers[n](ctx) as Promise<unknown>, ms)));
    const sources = Object.fromEntries(names.map((n, i) => [n, settled[i]])) as unknown as SystemSources;
    const lnames = Object.keys(layerReaders) as Array<keyof LayerSources>;
    const lsettled = await Promise.all(lnames.map((n) => settle(() => layerReaders[n](ctx) as Promise<unknown>, ms)));
    const lsources = Object.fromEntries(lnames.map((n, i) => [n, lsettled[i]])) as unknown as LayerSources;
    const unavailable = [...names.filter((_, i) => !settled[i]?.ok), ...lnames.filter((_, i) => !lsettled[i]?.ok)];
    if (unavailable.length) ctx.log.warn("system", `unknown this build: ${unavailable.join(", ")}`);
    const planes = buildPlanes(now(), sources);
    return { ok: true, version: 2, at: new Date(now()).toISOString(), planes, layers: buildLayers(now(), sources, lsources, planes), unavailable };
  }

  function swrFor(ctx: FeatureContext): Swr<SystemResponse> {
    const key = ctx.config.dbPath;
    let swr = swrs.get(key);
    if (!swr) {
      swr = createSwr(() => build(ctx), { now, onError: (err) => ctx.log.error("system", "build failed", String(err)) });
      swrs.set(key, swr);
    }
    return swr;
  }

  const systemFor = (ctx: FeatureContext): Promise<SystemResponse> => swrFor(ctx).get(ttl);

  return {
    id: "system",
    routes: [
      {
        method: "GET",
        path: "/api/system",
        async handler(req, res, ctx) {
          try {
            const full = await systemFor(ctx);
            const redact = new URL(req.url ?? "/", "http://localhost").searchParams.get("redact") === "1";
            respondJson(res, 200, redact ? redactSystem(full) : full);
          } catch (err) {
            respondJson(res, 503, { ok: false, error: String(err instanceof Error ? err.message : err) });
          }
        },
      },
      {
        // Refresh button: a forced recompute. Single-flight (swr.refresh joins a build already
        // running) and rate limited: a second press inside REFRESH_MIN_GAP_MS gets 429 + retryAfterMs.
        method: "POST",
        path: "/api/system/refresh",
        async handler(req, res, ctx) {
          const key = ctx.config.dbPath;
          const wait = REFRESH_MIN_GAP_MS - (now() - (lastForced.get(key) ?? -Infinity));
          if (wait > 0) return respondJson(res, 429, { ok: false, error: "refreshed a moment ago", retryAfterMs: Math.ceil(wait) });
          lastForced.set(key, now());
          try {
            dropFleetCache();
            const full = await swrFor(ctx).refresh();
            const redact = new URL(req.url ?? "/", "http://localhost").searchParams.get("redact") === "1";
            respondJson(res, 200, redact ? redactSystem(full) : full);
          } catch (err) {
            respondJson(res, 503, { ok: false, error: String(err instanceof Error ? err.message : err) });
          }
        },
      },
    ],
  };
}

export const systemFeature = createSystemFeature();
