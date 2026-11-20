// Pure logic for turning one day's per-city usage rows (GET /api/usage/day) into a
// per-district cost breakdown that matches the world's real districts (GET /api/world's
// islands), plus whatever doesn't attribute to one. No DOM, no fetch — tested in
// usage-lib.test.ts against real response shapes.
//
// Why this exists apart from usage.ts: server/features/usage.ts keys `perCity` by
// whatever `islandForCwd` resolved at ingest time, which is not always a real island id
// (a worktree cwd with no db mapping falls back to a raw "cwd:<path>" key, per that
// file's own header). The District view only ever wants real districts, so this collapses
// `perCity` against the world's actual island ids and keeps the remainder honest instead
// of showing it as a nonexistent district.

import type { CityUsage } from "../../../shared/features/usage";

export interface DistrictCostToday {
  costUsd: number;
  sessions: number;
}

export interface UsageReconciliation {
  /** costUsd/sessions for each REAL district (island id) that has usage today. */
  byDistrict: ReadonlyMap<string, DistrictCostToday>;
  /** `totalCostUsd`'s remainder once every real-district row is subtracted: usage rows
   *  keyed by something that isn't (yet) one of the world's districts — a worktree slug,
   *  a stale island id, "unknown", etc. Never negative. */
  unattributedCostUsd: number;
}

/** `realIslandIds`: the world's actual district ids (e.g. the keys of `ctx.store.islands`,
 *  itself loaded from /api/world) — never guessed from the usage rows themselves, so a
 *  city key that merely LOOKS like a district (a worktree slug, a stale id) still falls to
 *  `unattributedCostUsd` rather than masquerading as one.
 *
 *  Exact reconciliation: sum(byDistrict[*].costUsd) + unattributedCostUsd === the day's
 *  totalCostUsd, to the cent — both sides are a straight partition of `perCity` (every row
 *  goes to exactly one side, none dropped, none double-counted), so no separate rounding
 *  path can drift them apart. See usage-lib.test.ts. */
export function reconcileDistrictCost(perCity: readonly CityUsage[], realIslandIds: ReadonlySet<string>): UsageReconciliation {
  const byDistrict = new Map<string, DistrictCostToday>();
  let unattributedCostUsd = 0;
  for (const c of perCity) {
    if (!realIslandIds.has(c.islandId)) {
      unattributedCostUsd += c.costUsd;
      continue;
    }
    const prev = byDistrict.get(c.islandId);
    byDistrict.set(c.islandId, prev ? { costUsd: prev.costUsd + c.costUsd, sessions: prev.sessions + c.sessions } : { costUsd: c.costUsd, sessions: c.sessions });
  }
  return { byDistrict, unattributedCostUsd };
}

/** Subagent transcripts (`subagents/agent-*.jsonl`) are never read by the usage feature's
 *  ingestion (server/features/usage-backfill.ts's `jsonlFiles` and the shared indexer both
 *  only list each project dir's own top-level `.jsonl` files) — so a subagent's tokens
 *  never reach the usage store under any session id, parent or its own, and can't be
 *  rolled up here. Kept as a named constant (rather than a string literal at each call
 *  site) so a future change to the ingestion path has exactly one place to flip this. */
export const SUBAGENT_COST_ROLLED_UP = false;

export const SUBAGENT_COST_FOOTNOTE = "Subagent cost isn't included — the usage store only tracks top-level sessions, not the agents they spawn.";
