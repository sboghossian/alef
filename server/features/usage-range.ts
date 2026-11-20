// The usage panel's range view (7 / 30 / 90 days): cost by model (doughnut), activity by local
// clock hour (24 bars) and cost by city, all summed from the usage store's own tables. Pure given
// a store and a clock, so tests run it on an in-memory store.

import { localDateKey } from "../heuristics.js";
import { totalTokens, costForModel, type CityUsage, type RangeModel, type UsageRangeDays, type UsageRangeResponse } from "../../shared/features/usage.js";
import type { UsageStore } from "./usage-store.js";

/** The inclusive local date keys a `days`-day range covers, ending today. */
export function rangeBounds(days: number, nowMs: number): { from: string; to: string } {
  const end = new Date(nowMs);
  const start = new Date(nowMs);
  start.setDate(start.getDate() - (days - 1));
  return { from: localDateKey(start), to: localDateKey(end) };
}

export function buildRange(store: UsageStore, days: UsageRangeDays, nowMs: number, islandName: (id: string) => string): UsageRangeResponse {
  const { from, to } = rangeBounds(days, nowMs);
  const { rows, sessionsByIsland } = store.rangeTokenRows(from, to);
  const activeByIsland = store.rangeTimeByIsland(from, to);
  const models = new Map<string, RangeModel>();
  const cities = new Map<string, CityUsage>();
  const cityFor = (islandId: string): CityUsage => {
    let c = cities.get(islandId);
    if (!c) {
      c = { islandId, name: islandName(islandId), costUsd: 0, unpricedTokens: 0, activeMs: activeByIsland.get(islandId) ?? 0, sessions: sessionsByIsland.get(islandId) ?? 0 };
      cities.set(islandId, c);
    }
    return c;
  };
  let totalCostUsd = 0;
  let totalUnpricedTokens = 0;
  for (const r of rows) {
    const { costUsd, unpricedTokens } = costForModel(r.model, r.tokens);
    const m = models.get(r.model) ?? { model: r.model, costUsd: null, tokens: 0, unpricedTokens: 0 };
    m.tokens += totalTokens(r.tokens);
    m.unpricedTokens += unpricedTokens;
    if (costUsd !== null) m.costUsd = (m.costUsd ?? 0) + costUsd;
    models.set(r.model, m);
    const c = cityFor(r.islandId);
    if (costUsd !== null) c.costUsd += costUsd;
    c.unpricedTokens += unpricedTokens;
    totalCostUsd += costUsd ?? 0;
    totalUnpricedTokens += unpricedTokens;
  }
  for (const id of activeByIsland.keys()) cityFor(id); // a city with time but no tokens still lists
  const perCity = [...cities.values()].sort((a, b) => b.costUsd - a.costUsd);
  return {
    ok: true,
    days,
    from,
    to,
    totalCostUsd,
    totalUnpricedTokens,
    totalActiveMs: perCity.reduce((n, c) => n + c.activeMs, 0),
    perCity,
    models: [...models.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens),
    byHour: store.hourTotals(from, to),
  };
}
