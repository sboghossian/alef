// Pure half of the Fix queue section (fix-queue.ts): where each action posts, the lines a row
// reads, the caption and the Health chip's tooltip. No DOM, so vitest runs it as is.

import { SNOOZE_DAYS, type DismissalKind } from "../../../shared/features/completeness";
import { FIX_SOURCE_LABEL, FIX_SOURCES, type FixCounts, type FixesResponse, type FixLaunch, type FixRow, type FixSource } from "../../../shared/features/fixes";
import { relativeTime } from "../ui/fuzzy";

/** Open rows shown before "Show all". */
export const FIX_QUEUE_PREVIEW = 8;

/** Where a snooze / won't fix / undo for `row` posts. A Health row is the check's own dismissal
 *  (POST /api/completeness/:checkId/…), so the checklist and the Town square move with it. */
export function dismissRequest(row: Pick<FixRow, "id" | "source">, kind: DismissalKind | null): { url: string; body: Record<string, unknown> } {
  const verb = kind ? "dismiss" : "undismiss";
  const body = kind ? { kind, days: SNOOZE_DAYS } : {};
  if (row.source === "health") return { url: `/api/completeness/${encodeURIComponent(row.id.slice("health:".length))}/${verb}`, body };
  return { url: `/api/fixes/${encodeURIComponent(row.id)}/${verb}`, body };
}

/** "Sickness · demo · 2d ago": where it came from, where it runs, how old it is. */
export function rowMeta(row: Pick<FixRow, "source" | "cityId" | "since">, now: number, cityName: (id: string) => string = (id) => id): string {
  const parts: string[] = [FIX_SOURCE_LABEL[row.source]];
  if (row.cityId) parts.push(cityName(row.cityId));
  if (row.since) parts.push(`since ${relativeTime(row.since, now)}`);
  return parts.join(" · ");
}

/** What the session a fix started is doing: started when, which session, its verdict once known. */
export function launchLine(l: FixLaunch, now: number): string {
  const started = `Fix started ${relativeTime(l.at, now)}`;
  if (!l.sessionId) return l.tmuxName ? `${started} in ${l.tmuxName}, waiting for its session to appear` : `${started} in a plain Terminal (Alef can't follow it)`;
  const session = `session ${l.sessionId.slice(0, 8)}`;
  if (!l.outcome || l.outcome === "unknown") return `${started} · ${session} · no verdict yet`;
  if (l.outcome === "active") return `${started} · ${session} · still working`;
  return `${started} · ${session} · ${l.outcome}${l.outcomeReason ? `: ${l.outcomeReason}` : ""}`;
}

/** The words for a set-aside row. */
export function asideText(row: Pick<FixRow, "dismissed">, now: number): string {
  const d = row.dismissed;
  if (!d) return "";
  if (d.kind === "wont-fix") return `Won't fix (set ${relativeTime(d.at, now)})`;
  return d.until ? `Snoozed until ${new Date(d.until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Snoozed";
}

export function openCount(open: FixCounts): number {
  return FIX_SOURCES.reduce((n, s) => n + open[s], 0);
}

const PENDING_NAME: Record<FixSource, string> = {
  health: "Health checks",
  sickness: "Sickness",
  "vault-project": "the vault",
  "vault-ghost": "the vault",
  loop: "Loops",
  abandoned: "session outcomes",
};

/** Under the heading: how many, by source, and what hasn't been read yet (never shown as 0). */
export function queueCaption(r: Pick<FixesResponse, "open" | "pending">): string {
  const n = openCount(r.open);
  const bySource = new Map<string, number>();
  for (const s of FIX_SOURCES) if (r.open[s] > 0) bySource.set(FIX_SOURCE_LABEL[s], (bySource.get(FIX_SOURCE_LABEL[s]) ?? 0) + r.open[s]);
  const head = n === 0 ? "Nothing to fix" : `${n} to fix: ${[...bySource].map(([label, k]) => `${k} ${label}`).join(", ")}`;
  const pending = [...new Set(r.pending.map((s) => PENDING_NAME[s]))];
  return pending.length ? `${head} · still reading ${pending.join(", ")}` : head;
}

/** The status bar's Health chip tooltip line for the queue; "" before the server answered once. */
export function chipQueueLine(open: number | null): string {
  if (open === null) return "";
  return open === 0 ? "Fix queue: nothing to fix" : `Fix queue: ${open} thing${open === 1 ? "" : "s"} to fix`;
}

export function isFixesResponse(v: unknown): v is FixesResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.ok === true && Array.isArray(r.rows) && typeof r.open === "object" && r.open !== null && Array.isArray(r.pending);
}
