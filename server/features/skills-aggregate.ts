// Pure aggregation: turns a raw skill-event log + the installed-skill inventory into the
// "Top used" and "Graveyard" tabs. No IO here — server/features/skills.ts wires this to the
// store and the inventory scan.

import type { InstalledSkill, SkillEvent, SkillUsageRow } from "../../shared/features/skills.js";

const DAY_MS = 86_400_000;
export const FIRED_30D_MS = 30 * DAY_MS;
export const FIRED_90D_MS = 90 * DAY_MS;
/** A typed "/name" is usually immediately followed by the Skill tool_use it triggers, in the
 *  same session, seconds apart. Collapsing anything in the same session within this window
 *  into one firing avoids double-counting that pair as two invocations. */
export const DEDUP_WINDOW_MS = 5 * 60_000;

const ORIGIN_PRIORITY: Record<InstalledSkill["origin"], number> = { user: 0, plugin: 1, project: 2 };

/** slug -> the highest-priority InstalledSkill for it (user beats plugin beats project; a
 *  genuine slug collision across origins is rare, so ties just keep the first-priority one). */
export function indexInstalledBySlug(installed: readonly InstalledSkill[]): Map<string, InstalledSkill> {
  const byPriority = [...installed].sort((a, b) => ORIGIN_PRIORITY[a.origin] - ORIGIN_PRIORITY[b.origin]);
  const out = new Map<string, InstalledSkill>();
  for (const s of byPriority) if (!out.has(s.slug)) out.set(s.slug, s);
  return out;
}

interface FiredStats {
  fired30d: number;
  fired90d: number;
  firedTotal: number;
  lastFiredAt: string | null;
}

/** Collapses "invoke"/"slash" events into one firing per (session, skill, dedup bucket),
 *  then buckets each skill's firings into the 30d/90d/total windows. */
function firedStatsBySkill(events: readonly SkillEvent[], nowMs: number): Map<string, FiredStats> {
  const seen = new Set<string>();
  const firings = new Map<string, number[]>(); // skillName -> firing timestamps (ms)
  for (const e of events) {
    if (e.kind !== "invoke" && e.kind !== "slash") continue;
    const atMs = Date.parse(e.at);
    if (!Number.isFinite(atMs)) continue;
    const bucket = Math.floor(atMs / DEDUP_WINDOW_MS);
    const key = `${e.sessionId}\u0000${e.skillName}\u0000${bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = firings.get(e.skillName);
    if (list) list.push(atMs);
    else firings.set(e.skillName, [atMs]);
  }
  const out = new Map<string, FiredStats>();
  for (const [skillName, times] of firings) {
    let fired30d = 0;
    let fired90d = 0;
    let lastMs = -Infinity;
    for (const t of times) {
      if (nowMs - t <= FIRED_30D_MS) fired30d += 1;
      if (nowMs - t <= FIRED_90D_MS) fired90d += 1;
      if (t > lastMs) lastMs = t;
    }
    out.set(skillName, { fired30d, fired90d, firedTotal: times.length, lastFiredAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null });
  }
  return out;
}

function suggestedTotalsBySkill(events: readonly SkillEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "suggested") continue;
    out.set(e.skillName, (out.get(e.skillName) ?? 0) + 1);
  }
  return out;
}

/** null-safe ascending compare of ISO dates; a null (unknown age) sorts last. */
function byAgeAscending(a: SkillUsageRow, b: SkillUsageRow): number {
  const ua = a.installed?.updatedAt ?? null;
  const ub = b.installed?.updatedAt ?? null;
  if (ua === ub) return a.slug.localeCompare(b.slug);
  if (ua === null) return 1;
  if (ub === null) return -1;
  return ua < ub ? -1 : 1;
}

function byUsageDescending(a: SkillUsageRow, b: SkillUsageRow): number {
  if (b.fired90d !== a.fired90d) return b.fired90d - a.fired90d;
  if (b.firedTotal !== a.firedTotal) return b.firedTotal - a.firedTotal;
  const la = a.lastFiredAt ?? "";
  const lb = b.lastFiredAt ?? "";
  return lb.localeCompare(la);
}

export interface UsageAggregate {
  topUsed: SkillUsageRow[];
  graveyard: SkillUsageRow[];
}

/** Builds the Top-used and Graveyard tabs. "Fired" = invoke or slash events, deduped per
 *  session per skill per DEDUP_WINDOW_MS; "suggested" is counted separately and never
 *  promotes a skill out of the graveyard on its own — a suggestion the user declined isn't
 *  a use. */
export function aggregateSkillUsage(events: readonly SkillEvent[], installed: readonly InstalledSkill[], nowMs: number): UsageAggregate {
  const bySlug = indexInstalledBySlug(installed);
  const fired = firedStatsBySkill(events, nowMs);
  const suggested = suggestedTotalsBySkill(events);

  const skillNames = new Set<string>([...fired.keys(), ...suggested.keys(), ...bySlug.keys()]);
  const rows: SkillUsageRow[] = [];
  for (const slug of skillNames) {
    const f = fired.get(slug);
    rows.push({
      slug,
      installed: bySlug.get(slug) ?? null,
      fired30d: f?.fired30d ?? 0,
      fired90d: f?.fired90d ?? 0,
      firedTotal: f?.firedTotal ?? 0,
      suggestedTotal: suggested.get(slug) ?? 0,
      lastFiredAt: f?.lastFiredAt ?? null,
    });
  }

  const topUsed = rows.filter((r) => r.firedTotal > 0).sort(byUsageDescending);
  const graveyard = rows.filter((r) => r.installed !== null && r.fired30d === 0 && r.fired90d === 0).sort(byAgeAscending);
  return { topUsed, graveyard };
}
