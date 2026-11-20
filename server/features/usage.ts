// "usage" feature (Round 8 H1 + H5): est. API-equivalent cost in USD, and active time,
// per session / city / day — computed from message.usage token fields in assistant jsonl
// lines against shared/features/usage.ts's price table. Always "est." / "API-equivalent",
// never "spend" or "bill": these are local token-count estimates, not a real invoice.
//
// Ingestion is split in two, both feeding the same sqlite aggregates (usage-store.ts):
//  - Live: onIndexPass gets each session's genuinely-new jsonl lines for free (the shared
//    indexer already read them) and folds them through the pure reducer in shared/usage.ts.
//  - Backfill: the indexer's own startup pass never forwards lines to features, so
//    onIndexPass alone would only ever cover "from whenever this feature first ran"
//    onward. onTick drives a background one-time historical catch-up (usage-backfill.ts)
//    for every date up to that moment, so Replay's day queries and today's status chip are
//    correct from the first request, not just after enough new live traffic accumulates.

import { isValidUuid } from "../reactivate.js";
import { respondJson } from "../http.js";
import { localDateKey } from "../heuristics.js";
import {
  costForModel,
  reduceLine,
  type CityUsage,
  type ModelMixRow,
  type SessionCursor,
  type SessionUsageError,
  type SessionUsageResponse,
  isUsageRangeDays,
  type UsageDayError,
  type UsageDayResponse,
  type UsageRangeResponse,
  type UsageTodayExtra,
} from "../../shared/features/usage.js";
import { createTtlCache } from "./cache-lib.js";
import { buildRange, rangeBounds } from "./usage-range.js";
import { runBackfillPass } from "./usage-backfill.js";
import { parseUsageLine } from "./usage-parse.js";
import { HOUR_BACKFILL_CUTOFF_KEY, UsageStore, usageStorePathFor, type TimeRow, type TokenRow } from "./usage-store.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_CACHE_TTL_MS = 5_000;
const RANGE_CACHE_TTL_MS = 30_000;

interface Runtime {
  store: UsageStore;
  /** The moment this feature's store was first opened (persisted, so it survives dev
   *  restarts): everything strictly before it is the backfill's territory, everything at
   *  or after it is onIndexPass's — see the file header. */
  cutoffMs: number;
  /** Set when the store migrated from v2 (usage-store.ts): usage_hour before it is the "hour"
   *  backfill's, from it on the live path's. Null: usage_hour shares `cutoffMs`. */
  hourCutoffMs: number | null;
  backfillRunning: Promise<void> | null;
  dayCache: ReturnType<typeof createTtlCache<string, UsageDayResponse>>;
  rangeCache: ReturnType<typeof createTtlCache<number, UsageRangeResponse>>;
}

const runtimes = new Map<string, Runtime>();

function runtime(ctx: FeatureContext): Runtime {
  const key = ctx.config.dbPath;
  let rt = runtimes.get(key);
  if (!rt) {
    const store = new UsageStore(usageStorePathFor(key));
    const stored = store.getMeta("backfill_cutoff_ms");
    const cutoffMs = stored ? Number(stored) : Date.now();
    if (!stored) store.setMeta("backfill_cutoff_ms", String(cutoffMs));
    const hourStored = store.getMeta(HOUR_BACKFILL_CUTOFF_KEY);
    const hourCutoffMs = hourStored ? Number(hourStored) : null;
    rt = { store, cutoffMs, hourCutoffMs, backfillRunning: null, dayCache: createTtlCache({ ttlMs: DAY_CACHE_TTL_MS, max: 16 }), rangeCache: createTtlCache({ ttlMs: RANGE_CACHE_TTL_MS, max: 3 }) };
    runtimes.set(key, rt);
  }
  return rt;
}

function islandForCwd(ctx: FeatureContext, cwd: string | null): string {
  if (!cwd) return "unknown";
  return ctx.db.getIslandForCwd(cwd) ?? `cwd:${cwd}`;
}

/** Folds one session's new raw lines through the pure reducer, persisting the result. */
function ingestSession(ctx: FeatureContext, rt: Runtime, sessionId: string, lines: readonly string[]): void {
  let cursor: SessionCursor = rt.store.getCursor(sessionId);
  for (const raw of lines) {
    const facts = parseUsageLine(raw);
    if (!facts || facts.atMs === null) continue;
    const islandId = islandForCwd(ctx, facts.cwd);
    const date = localDateKey(new Date(facts.atMs));
    const result = reduceLine(cursor, { atMs: facts.atMs, model: facts.model, messageId: facts.messageId, tokens: facts.tokens });
    cursor = result.next;
    if (result.activeMsDelta > 0) {
      rt.store.addActiveMs(date, islandId, sessionId, result.activeMsDelta);
      if (facts.atMs >= (rt.hourCutoffMs ?? rt.cutoffMs)) rt.store.addHourMs(date, new Date(facts.atMs).getHours(), result.activeMsDelta);
    }
    if (result.tokenDelta) rt.store.addTokens(date, islandId, sessionId, result.tokenDelta.model, result.tokenDelta.tokens);
  }
  rt.store.setCursor(sessionId, cursor);
}

function kickBackfill(ctx: FeatureContext, rt: Runtime): void {
  if (rt.backfillRunning) return;
  const base = { store: rt.store, projectsDir: ctx.config.projectsDir, getIslandForCwd: (cwd: string) => ctx.db.getIslandForCwd(cwd) };
  const hourCutoffMs = rt.hourCutoffMs;
  rt.backfillRunning = runBackfillPass({ ...base, cutoffMs: rt.cutoffMs, hours: hourCutoffMs === null })
    .then(() => (hourCutoffMs === null ? undefined : runBackfillPass({ ...base, cutoffMs: hourCutoffMs, mode: "hour" })))
    .catch((err: unknown) => ctx.log.error("usage", "backfill pass failed", String(err)))
    .finally(() => {
      rt.backfillRunning = null;
    });
}

interface CityAccumulator {
  costUsd: number;
  unpricedTokens: number;
  activeMs: number;
  sessions: Set<string>;
}

/** Groups token + time rows (already keyed by city) into the wire CityUsage[] shape
 *  (`name` left equal to `islandId`; the caller resolves real names, since only it has
 *  access to `ctx.worldViews()`). */
function buildCityRows(tokenRows: readonly TokenRow[], timeRows: readonly TimeRow[]): { perCity: CityUsage[]; totalCostUsd: number; totalUnpricedTokens: number; totalActiveMs: number } {
  const cities = new Map<string, CityAccumulator>();
  const cityFor = (islandId: string): CityAccumulator => {
    let c = cities.get(islandId);
    if (!c) {
      c = { costUsd: 0, unpricedTokens: 0, activeMs: 0, sessions: new Set() };
      cities.set(islandId, c);
    }
    return c;
  };
  for (const row of tokenRows) {
    const c = cityFor(row.islandId);
    c.sessions.add(row.sessionId);
    const { costUsd, unpricedTokens } = costForModel(row.model, row.tokens);
    if (costUsd !== null) c.costUsd += costUsd;
    c.unpricedTokens += unpricedTokens;
  }
  for (const row of timeRows) cityFor(row.islandId).activeMs += row.activeMs;

  let totalCostUsd = 0;
  let totalUnpricedTokens = 0;
  let totalActiveMs = 0;
  const perCity: CityUsage[] = [];
  for (const [islandId, c] of cities) {
    totalCostUsd += c.costUsd;
    totalUnpricedTokens += c.unpricedTokens;
    totalActiveMs += c.activeMs;
    perCity.push({ islandId, name: islandId, costUsd: c.costUsd, unpricedTokens: c.unpricedTokens, activeMs: c.activeMs, sessions: c.sessions.size });
  }
  return { perCity, totalCostUsd, totalUnpricedTokens, totalActiveMs };
}

function dayResponse(ctx: FeatureContext, rt: Runtime, date: string): UsageDayResponse {
  const built = buildCityRows(rt.store.dayTokenRows(date), rt.store.dayTimeRows(date));
  const islandNames = new Map(ctx.worldViews().islands.map((i) => [i.id, i.name]));
  return {
    ok: true,
    date,
    totalCostUsd: built.totalCostUsd,
    totalUnpricedTokens: built.totalUnpricedTokens,
    totalActiveMs: built.totalActiveMs,
    perCity: built.perCity.map((c) => ({ ...c, name: islandNames.get(c.islandId) ?? (c.islandId.startsWith("cwd:") ? c.islandId.slice(4) : c.islandId) })).sort((a, b) => b.costUsd - a.costUsd),
  };
}

function sessionResponse(agentId: string, rt: Runtime): SessionUsageResponse {
  const mix = rt.store.sessionModelMix(agentId);
  const models: ModelMixRow[] = [...mix.entries()].map(([model, tokens]) => {
    const { costUsd, unpricedTokens } = costForModel(model, tokens);
    return { model, tokens, costUsd, unpricedTokens };
  });
  const totalCostUsd = models.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const totalUnpricedTokens = models.reduce((sum, m) => sum + m.unpricedTokens, 0);
  return {
    ok: true,
    agentId,
    islandId: rt.store.sessionIslandId(agentId),
    totalCostUsd,
    totalUnpricedTokens,
    activeMs: rt.store.sessionActiveMs(agentId),
    models: models.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
  };
}

const costByIslandCache = createTtlCache<string, Map<string, number>>({ ttlMs: 60_000, max: 4 });

/** Est. API-equivalent cost per island (district) id over the last `days` days, from this feature's own
 *  store (other features, e.g. Projects, join it by district). Cached 60 s, single-flight; empty on any failure. */
export function usageCostByIsland(ctx: FeatureContext, days: number): Promise<Map<string, number>> {
  return costByIslandCache
    .get(`${ctx.config.dbPath}|${days}`, () => {
      const { from, to } = rangeBounds(days, Date.now());
      const out = new Map<string, number>();
      for (const r of runtime(ctx).store.rangeTokenRows(from, to).rows) {
        const { costUsd } = costForModel(r.model, r.tokens);
        if (costUsd !== null) out.set(r.islandId, (out.get(r.islandId) ?? 0) + costUsd);
      }
      return Promise.resolve(out);
    })
    .catch(() => new Map<string, number>());
}

export function createUsageFeature(): ServerFeature {
  return {
    id: "usage",
    routes: [
      {
        method: "GET",
        path: "/api/usage/day",
        async handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const date = url.searchParams.get("date") ?? "";
          if (!DATE_RE.test(date)) {
            respondJson(res, 400, { ok: false, error: "date must be YYYY-MM-DD" } satisfies UsageDayError);
            return;
          }
          const rt = runtime(ctx);
          const body = await rt.dayCache.get(date, () => Promise.resolve(dayResponse(ctx, rt, date)));
          respondJson(res, 200, body);
        },
      },
      {
        method: "GET",
        path: "/api/usage/range",
        async handler(req, res, ctx) {
          const days = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("days") ?? "7");
          if (!isUsageRangeDays(days)) {
            respondJson(res, 400, { ok: false, error: "days must be 7, 30 or 90" } satisfies UsageDayError);
            return;
          }
          const rt = runtime(ctx);
          const names = new Map(ctx.worldViews().islands.map((i) => [i.id, i.name]));
          const name = (id: string): string => names.get(id) ?? (id.startsWith("cwd:") ? id.slice(4) : id);
          // Single-flight + 30 s TTL per range: a toggle burst shares one query.
          respondJson(res, 200, await rt.rangeCache.get(days, () => Promise.resolve(buildRange(rt.store, days, Date.now(), name))));
        },
      },
      {
        method: "GET",
        path: "/api/usage/session/:agentId",
        handler(_req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) {
            respondJson(res, 400, { ok: false, error: "invalid agent id" } satisfies SessionUsageError);
            return;
          }
          respondJson(res, 200, sessionResponse(agentId, runtime(ctx)));
        },
      },
    ],
    onIndexPass(ctx, newLinesBySession) {
      const rt = runtime(ctx);
      for (const [sessionId, lines] of newLinesBySession) ingestSession(ctx, rt, sessionId, lines);
    },
    onTick(ctx) {
      kickBackfill(ctx, runtime(ctx));
    },
    snapshotExtras(ctx) {
      const rt = runtime(ctx);
      const date = localDateKey(new Date());
      const built = buildCityRows(rt.store.dayTokenRows(date), rt.store.dayTimeRows(date));
      return {
        "usage.today": { date, costUsd: built.totalCostUsd, unpricedTokens: built.totalUnpricedTokens, activeMs: built.totalActiveMs } satisfies UsageTodayExtra,
      };
    },
  };
}

export const usageFeature: ServerFeature = createUsageFeature();
