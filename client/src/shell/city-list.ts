// The rich "Districts" list every view can put in the left sidebar (Orbit, Board…): one row per
// city with a state dot, a "2 live · 5 today" line, a 7-day sparkline of sessions last active
// per day, the agent count, and an activity sort key. Pure (tested in city-list.test.ts).

import type { Island, WorldAgent } from "../../../shared/types";
import { activityScore, cityDisplayName, cityStats, startOfLocalDay } from "../ui/world";
import type { FilterOption } from "./views";

const DAY = 86_400_000;

/** Sessions whose last activity fell on each of the last `days` local days, oldest first, per city. */
export function citySparks(agents: readonly WorldAgent[], now = Date.now(), days = 7): Map<string, number[]> {
  const today = startOfLocalDay(now);
  const first = today - (days - 1) * DAY;
  const out = new Map<string, number[]>();
  for (const a of agents) {
    const t = Date.parse(a.lastActive);
    if (!Number.isFinite(t) || t < first || t > now + DAY) continue;
    // Local-day index, robust to DST (a day is 23–25 h): walk from today's midnight.
    let idx = days - 1;
    let start = today;
    while (t < start && idx > 0) {
      idx--;
      start = startOfLocalDay(start - 1);
    }
    const row = out.get(a.islandId) ?? new Array<number>(days).fill(0);
    row[idx] = (row[idx] ?? 0) + 1;
    out.set(a.islandId, row);
  }
  return out;
}

export interface CityListOpts {
  /** Leave Harness City out (it has no agents of its own). */
  skipHarness?: boolean;
  /** Keep only cities matching every one of these (e.g. "live"). */
  only?: readonly ("waiting" | "live" | "today")[];
  /** Round 11: the group (topic continent) each city's row sits under, for grouped lists. */
  groupOf?: (islandId: string) => string | undefined;
}

export function cityListOptions(islands: readonly Island[], agents: readonly WorldAgent[], opts: CityListOpts = {}, now = Date.now()): FilterOption[] {
  const stats = cityStats([...agents], now);
  const sparks = citySparks(agents, now);
  return islands
    .filter((i) => !(opts.skipHarness && i.id === "harness"))
    .filter((i) => {
      const s = stats.get(i.id);
      return (opts.only ?? []).every((o) => (o === "waiting" ? (s?.awaiting ?? 0) > 0 : o === "live" ? (s?.live ?? 0) > 0 : (s?.activeToday ?? 0) > 0));
    })
    .map((i) => {
      const s = stats.get(i.id);
      const dot = s?.awaiting ? "awaiting" : s?.live ? "live" : s?.activeToday ? "today" : "asleep";
      const bits = [s?.awaiting ? `${s.awaiting} waiting` : "", s?.live ? `${s.live} live` : "", s?.activeToday ? `${s.activeToday} today` : ""].filter(Boolean);
      const spark = sparks.get(i.id);
      return {
        value: i.id,
        label: cityDisplayName(i),
        count: i.id === "harness" ? undefined : i.agentCount,
        dot,
        meta: bits.join(" · ") || undefined,
        hint: `${cityDisplayName(i)}: ${bits.join(" · ") || "quiet"}${spark ? ` · last 7 days: ${spark.join(" ")}` : ""}`,
        spark: spark && spark.some((n) => n > 0) ? spark : undefined,
        activity: activityScore(s),
        group: opts.groupOf?.(i.id),
      };
    })
    .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
}
