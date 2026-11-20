// Pure helpers for the archive feature (fossils): per-district / per-continent counts, the extra
// Districts rows for archived-only districts, the fossil field layout, and which islands earn a
// district right now (visibleIslands — the one shared decision every island-list/city-visibility
// surface calls, re-evaluated live as agents and the archive summary change). DOM- and THREE-free;
// covered by archive-lib.test.ts.

import type { ArchivePlace, ArchiveSummary } from "../../../shared/features/archive";
import { MUSEUM_ISLAND_ID } from "../../../shared/features/artifacts";
import type { Island, WorldAgent } from "../../../shared/types";
import type { FilterOption } from "../shell/views";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Tangent-plane area per fossil (≈ 0.35 × 0.35 units): r² grows by this / π per fossil. */
export const FOSSIL_AREA = 0.42;

/** Continent (group key) of an island, from the topic layout; undefined without topics. */
export type ContinentOf = (islandId: string) => string | undefined;

/** Archived sessions per island row in the Districts list. Topic fossils (home-dir runs) count
 *  toward the home catch-all island; archived-only districts are separate rows. */
export function archivedByIsland(summary: ArchiveSummary): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, n: number): void => {
    out.set(id, (out.get(id) ?? 0) + n);
  };
  for (const p of summary.places) {
    if (p.kind === "island") add(p.ref, p.count);
    else if (p.kind === "topic" && summary.homeIslandId) add(summary.homeIslandId, p.count);
  }
  return out;
}

/** Every island id with ≥1 agent right now (live or dormant), read from the live agents map —
 *  never from Island.agentCount, which is a snapshot-time count: upsertAgents (a single agent
 *  arriving over the websocket) never touches store.islands, so agentCount there can be stale
 *  between full snapshot refreshes. Deriving straight from store.agents means an island's first
 *  agent flips it visible immediately, with no lag and no relayout. */
export function islandIdsWithAgents(agents: readonly Pick<WorldAgent, "islandId">[]): Set<string> {
  return new Set(agents.map((a) => a.islandId));
}

/** Whether an island has earned a district right now: an agent there this instant
 *  (agentIslandIds, from islandIdsWithAgents — never the possibly-stale Island.agentCount), ≥1
 *  archived fossil placed on it (archivedByIsland — includes home-dir "topic" fossils, counted
 *  toward homeIslandId), or it is "harness", the one reserved system island (skills/hooks/MCPs,
 *  the System Quarter, the routines factories — all anchored to it, never their own cwd island),
 *  or the Museum (the artifacts feature's island: no sessions, it holds every artifact).
 *
 *  When `summary` is null — the archive vault scan hasn't finished yet, e.g. right after a fresh
 *  server boot, before server/features/archive.ts's async index is ready — this fails OPEN: every
 *  island stays visible until we actually know it has no fossils. A fossil-only island (aleph, 66
 *  fossils) must never be dropped by a race with that scan; once the summary loads, whoever calls
 *  this re-evaluates (onArchiveChange) and hides it in place if it truly has nothing — never by
 *  rebuilding a layout, since positions never depended on this to begin with.
 *
 *  Everything else exists only because a file was touched under that path (cwd_islands assigns it
 *  an id, but no session ever ran there and the vault never mentions it); the shared single filter
 *  every island-list surface (the planet's city/label toggle, the Districts sidebar, the District
 *  view) calls before listing or drawing islands, so a folder that only holds touched files never
 *  clutters the planet. The island itself, and any object whose islandId points at it, stay in the
 *  store either way — this only controls what gets drawn or listed as its own district. */
export function visibleIslands<T extends Pick<Island, "id">>(
  islands: readonly T[],
  agentIslandIds: ReadonlySet<string>,
  summary: ArchiveSummary | null,
): T[] {
  if (!summary) return [...islands];
  const fossils = archivedByIsland(summary);
  return islands.filter((i) => i.id === "harness" || i.id === MUSEUM_ISLAND_ID || agentIslandIds.has(i.id) || (fossils.get(i.id) ?? 0) > 0);
}

/** The continent a place's fossils lie in (its city's continent for "island" places). */
export function placeGroup(p: ArchivePlace, continentOf: ContinentOf): string | undefined {
  return p.kind === "island" ? continentOf(p.ref) : p.group || undefined;
}

/** Archived sessions per topic continent. */
export function archivedByGroup(summary: ArchiveSummary, continentOf: ContinentOf): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of summary.places) {
    const g = placeGroup(p, continentOf);
    if (g) out.set(g, (out.get(g) ?? 0) + p.count);
  }
  return out;
}

export const ARCHIVED_DISTRICT_PREFIX = "archived:";

export function isArchivedDistrict(id: string): boolean {
  return id.startsWith(ARCHIVED_DISTRICT_PREFIX);
}

/** Adds archived counts to the live district rows and appends one row per archived-only district. */
export function withArchiveRows(rows: readonly FilterOption[], summary: ArchiveSummary | null, continentOf: ContinentOf): FilterOption[] {
  if (!summary) return [...rows];
  const byIsland = archivedByIsland(summary);
  const out = rows.map((r) => {
    const n = byIsland.get(r.value) ?? 0;
    if (!n) return r;
    return {
      ...r,
      count: (r.count ?? 0) + n,
      meta: [r.meta, `${n} archived`].filter(Boolean).join(" · "),
      hint: `${r.hint ?? r.label} · ${n} archived (vault-only) sessions`,
    };
  });
  for (const p of summary.places) {
    if (p.kind !== "archived") continue;
    out.push({
      value: p.key,
      label: `🦴 ${p.ref}`,
      count: p.count,
      dot: "asleep",
      meta: `archived · ${p.count} fossil${p.count === 1 ? "" : "s"}`,
      hint: `${p.ref}: ${p.count} archived session${p.count === 1 ? "" : "s"} (vault notes only; the transcripts were pruned). Click to list them.`,
      activity: 0,
      group: placeGroup(p, continentOf),
    });
  }
  return out;
}

/** Sunflower spiral in a tangent plane, starting at radius `r0`: fossil `i` → (x, z). */
export function fossilOffset(i: number, r0: number, seed = 0): [number, number] {
  const r = Math.sqrt(r0 * r0 + (FOSSIL_AREA / Math.PI) * (i + 0.5));
  const a = i * GOLDEN_ANGLE + seed;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** FNV-1a, for deterministic per-place angles. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
