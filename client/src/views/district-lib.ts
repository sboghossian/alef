// Pure logic for the 🏘️ District view: which districts (cities) are listed, in what order, and
// the "today" stats card for one of them. No DOM, no THREE. Tested in district-lib.test.ts.

import { displayIslandName } from "../../../shared/display";
import type { SubagentRecord } from "../../../shared/features/subagents";
import type { Island, WorldAgent, WorldObject } from "../../../shared/types";
import type { DistrictCostToday } from "../features/usage-lib";
import type { FilterState } from "../shell/views";

export type DistrictShow = "all" | "live" | "dormant";
export type DistrictSort = "activity" | "agents" | "name";

export interface DistrictStats {
  id: string;
  agents: number;
  live: number;
  waiting: number;
  /** Agents whose session was active since local midnight. */
  activeToday: number;
  /** Summed session tokens of the agents active today (session totals, not today-only). */
  tokensToday: number;
  subagentsToday: number;
  subagentsLive: number;
  files: number;
  lastActive: string;
}

export function startOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function districtStats(
  island: Pick<Island, "id" | "lastActive">,
  agents: readonly WorldAgent[],
  objects: readonly WorldObject[],
  subagents: readonly SubagentRecord[],
  nowMs: number,
): DistrictStats {
  const midnight = startOfDay(nowMs);
  const mine = agents.filter((a) => a.islandId === island.id);
  const ids = new Set(mine.map((a) => a.id));
  const today = mine.filter((a) => Date.parse(a.lastActive) >= midnight);
  const subs = subagents.filter((s) => ids.has(s.parentSessionId));
  const last = mine.reduce((m, a) => (a.lastActive > m ? a.lastActive : m), island.lastActive ?? "");
  return {
    id: island.id,
    agents: mine.length,
    live: mine.filter((a) => a.status === "live").length,
    waiting: mine.filter((a) => a.status === "live" && a.awaitingInput).length,
    activeToday: today.length,
    tokensToday: today.reduce((s, a) => s + (Number.isFinite(a.tokens) ? a.tokens : 0), 0),
    subagentsToday: subs.filter((s) => Date.parse(s.lastActive) >= midnight).length,
    subagentsLive: subs.filter((s) => s.status === "running").length,
    files: objects.filter((o) => o.islandId === island.id && o.kind === "file").length,
    lastActive: last,
  };
}

/** Live agents weigh most, then today's work, then subagents. */
export function activityScore(s: DistrictStats): number {
  return s.live * 100 + s.waiting * 50 + s.activeToday * 10 + s.subagentsLive * 5 + s.subagentsToday;
}

export interface DistrictFilter {
  show: DistrictShow;
  sort: DistrictSort;
  /** A district picked in the sidebar list, or null. */
  picked: string | null;
}

export function districtFilterFrom(state: FilterState): DistrictFilter {
  const show = state.show?.[0];
  const sort = state.sort?.[0];
  return {
    show: show === "live" || show === "dormant" ? show : "all",
    sort: sort === "agents" || sort === "name" ? sort : "activity",
    picked: state.district?.[0] ?? null,
  };
}

/** Districts to walk through, filtered and ordered. The harness city (skills/hooks/MCPs) stays in. */
export function orderDistricts(
  islands: readonly Pick<Island, "id" | "name">[],
  stats: (id: string) => DistrictStats,
  f: Pick<DistrictFilter, "show" | "sort">,
): string[] {
  const rows = islands
    .map((i) => ({ i, s: stats(i.id) }))
    .filter(({ s }) => (f.show === "live" ? s.live > 0 : f.show === "dormant" ? s.live === 0 : true));
  const name = (i: Pick<Island, "id" | "name">): string => displayName(i).toLowerCase();
  rows.sort((a, b) => {
    let d = 0;
    if (f.sort === "activity") d = activityScore(b.s) - activityScore(a.s) || (a.s.lastActive < b.s.lastActive ? 1 : a.s.lastActive > b.s.lastActive ? -1 : 0);
    else if (f.sort === "agents") d = b.s.agents - a.s.agents;
    return d || (name(a.i) < name(b.i) ? -1 : name(a.i) > name(b.i) ? 1 : 0);
  });
  return rows.map((r) => r.i.id);
}

/** `path` is optional so the sort-order helper below (which only ever has {id, name} in its own
 *  tests) still type-checks; a real Island always has one, and only then can a catch-all (home
 *  dir, "/", the vault) resolve to its friendly name instead of its raw folder slug. */
export function displayName(i: Pick<Island, "id" | "name"> & { path?: string }): string {
  if (i.id === "harness") return "Harness City";
  if (typeof i.path === "string") return displayIslandName({ name: i.name, path: i.path });
  return i.name || i.id;
}

/** Next / previous district, wrapping; the first one when `current` is not in the list. */
export function stepDistrict(order: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return order[0]!;
  return order[(i + dir + order.length) % order.length]!;
}

/** The stat tile's small caption, under the $ figure. Deliberately says nothing about a
 *  session count or "here" in a way that implies these are the district's own houses: the
 *  cost is attributed by where the WORK happened (each transcript line's cwd, via
 *  server/features/usage.ts's `islandForCwd`), not by where the doing agent's house sits
 *  (`agent.islandId`, what the rest of this card and the houses list right below it use). A
 *  session housed in a different district can be the one whose work this district's total
 *  came from — checked against a read-only .backup of the live world.db/usage.db on
 *  2026-09-28: agent-world's entire $7.11 that day came from a session housed elsewhere. See
 *  districtCostLine's tooltip for the full sentence and DISTRICT_COST_ATTRIBUTION_NOTE for
 *  the card's own explanation. */
export const DISTRICT_COST_CAPTION = "est. cost of work here today";

/** The cost tile's tooltip (and, appended, the district-list row's hint) — the full
 *  attribution sentence DISTRICT_COST_CAPTION's comment explains, since a bare "$X · N
 *  sessions" reads as "these N houses cost $X" (they may have none). Null when there's no
 *  usage-store row for this district today (distinct from a real $0: it means the endpoint
 *  hasn't attributed anything here at all, e.g. before the first poll resolves). `formatUsd`
 *  is injected so this stays DOM-free and independently testable. */
export function districtCostLine(cost: DistrictCostToday | undefined, formatUsd: (costUsd: number) => string): string | null {
  if (!cost) return null;
  return `${formatUsd(cost.costUsd)} — est. cost of work done in this district's folders today, by any agent, wherever its house is (${cost.sessions} session${cost.sessions === 1 ? "" : "s"}).`;
}

/** Shown under the stats row whenever the cost tile is (district.ts): the card-level
 *  explanation of the same by-folder attribution, for readers who never hover the tile. */
export const DISTRICT_COST_ATTRIBUTION_NOTE = "Cost above is billed by where the work happened (each session's folder), not by where its house sits — a session housed in a different district can be the one that spent it.";

/** Houses in a district, live first then most recent; capped for labels. */
export function houseOrder<T extends Pick<WorldAgent, "id" | "status" | "awaitingInput" | "lastActive">>(agents: readonly T[], max: number): T[] {
  return [...agents]
    .sort((a, b) => {
      const r = (x: T): number => (x.status === "live" ? (x.awaitingInput ? 0 : 1) : 2);
      return r(a) - r(b) || (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id < b.id ? -1 : 1);
    })
    .slice(0, max);
}
