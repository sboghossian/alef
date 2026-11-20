// Pure helpers for the "replay" feature: date-key parsing, even-stride sampling
// (capping a day's events without losing its shape), and the daily-report aggregation.
// No IO — replay.ts does the jsonl scanning and calls into this module.

import { basename } from "node:path";
import type { DailyReport, ReplayEvent } from "../../shared/features/replay.js";

/** The whole-line prefix of a chunk read from an append-only jsonl: `text` ends at the last
 *  newline, `consumed` is its byte length (a half-written trailing line is left for next time).
 *  Cutting at a "\n" byte never splits a UTF-8 sequence. */
export function completeLines(buf: Buffer): { text: string; consumed: number } {
  const nl = buf.lastIndexOf(0x0a);
  if (nl === -1) return { text: "", consumed: 0 };
  return { text: buf.subarray(0, nl + 1).toString("utf8"), consumed: nl + 1 };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local (host timezone) [start, end) millisecond bounds of a "YYYY-MM-DD" calendar day.
 *  Null for a malformed or impossible date (matches heuristics.ts's localDateKey format). */
export function dayBoundsMs(dateStr: string): { startMs: number; endMs: number } | null {
  const m = DATE_RE.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  // Reject "2026-02-30"-style overflow: Date normalizes it into March, which would silently
  // shift the window instead of failing the request.
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  const startMs = start.getTime();
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

/** Even-stride downsample that always keeps chronological order and the very last event
 *  (the most recent moment of the day is the one a scrubber lands on most). */
export function sampleEvents<T>(events: readonly T[], cap: number): { sampled: T[]; truncated: boolean } {
  if (cap <= 0 || events.length <= cap) return { sampled: [...events], truncated: false };
  const out: T[] = [];
  const stride = events.length / cap;
  for (let i = 0; i < cap; i++) {
    const idx = Math.min(events.length - 1, Math.floor(i * stride));
    out.push(events[idx] as T);
  }
  const last = events[events.length - 1] as T;
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return { sampled: out, truncated: true };
}

function topRows(counts: ReadonlyMap<string, number>, limit: number, nameOf: (key: string) => string): { name: string; count: number }[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ name: nameOf(key), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Aggregates a day's (already island-resolved) events + that day's token total into
 *  the "THE DAILY AGENT" report card. Pure — `events` should be the FULL day, not the
 *  capped/sampled set the client renders on the scrubber. */
export function aggregateReport(
  date: string,
  events: readonly ReplayEvent[],
  tokens: number,
  islandNames: ReadonlyMap<string, string>,
): DailyReport {
  const sessionIds = new Set<string>();
  const perCity = new Map<string, { events: number; sessions: Set<string> }>();
  const files = new Map<string, number>();
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();

  for (const e of events) {
    sessionIds.add(e.agentId);
    const c = perCity.get(e.islandId) ?? { events: 0, sessions: new Set<string>() };
    c.events += 1;
    c.sessions.add(e.agentId);
    perCity.set(e.islandId, c);
    if (e.targetObjectId?.startsWith("file:")) files.set(e.targetObjectId, (files.get(e.targetObjectId) ?? 0) + 1);
    if (e.targetObjectId?.startsWith("skill:")) skills.set(e.targetObjectId, (skills.get(e.targetObjectId) ?? 0) + 1);
    if (e.toolName) tools.set(e.toolName, (tools.get(e.toolName) ?? 0) + 1);
  }

  return {
    date,
    sessions: sessionIds.size,
    tokens,
    events: events.length,
    perCity: [...perCity.entries()]
      .map(([islandId, v]) => ({ islandId, name: islandNames.get(islandId) ?? islandId, events: v.events, sessions: v.sessions.size }))
      .sort((a, b) => b.events - a.events),
    topFiles: topRows(files, 10, (k) => basename(k.slice("file:".length))),
    topTools: topRows(tools, 10, (k) => k),
    topSkills: topRows(skills, 10, (k) => k.slice("skill:".length)),
  };
}
