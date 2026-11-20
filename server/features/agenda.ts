// GET /api/agenda — today's Calendar.app events via JXA (osascript -l JavaScript),
// ported from aleph's agendaDigest(). LAZY by design: this only runs when a route is
// hit (never at boot, never on a tick), because the first call can trigger a macOS
// Calendar permission prompt. Cached 5 minutes (successes and failures alike) so a
// denied/slow prompt can't be hammered by repeated clicks.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecord, respondJson } from "../http.js";
import type { ServerFeature } from "./registry.js";
import type { AgendaEvent, AgendaResult } from "../../shared/features/agenda.js";

const execFileAsync = promisify(execFile);
const JXA_TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60_000;

// Bounded to today only; runs entirely inside osascript so no event content is
// piped through a shell string. Mirrors aleph/server.js#agendaDigest.
const AGENDA_JXA = `
(function() {
  try {
    const cal = Application('Calendar');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const evts = [];
    for (const c of cal.calendars()) {
      for (const e of c.events()) {
        const s = e.startDate();
        const en = e.endDate();
        if (!s || s > todayEnd || en < todayStart) continue;
        evts.push({ title: e.summary(), start: s.toISOString(), end: en.toISOString() });
      }
    }
    evts.sort((a, b) => a.start < b.start ? -1 : 1);
    return JSON.stringify({ ok: true, events: evts });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
})()
`;

/** Resolves with osascript's raw stdout, or rejects. Injectable for tests. */
export type JxaRunner = () => Promise<string>;

async function runOsascript(): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", AGENDA_JXA], { timeout: JXA_TIMEOUT_MS });
  return stdout;
}

/** macOS TCC denial shows up as AppleEvent error -1743, or a "not authorized"/"not allowed" message. */
export function isPermissionDenied(message: string): boolean {
  return /-1743|not authoriz|not allowed/i.test(message);
}

export function parseAgenda(raw: string, now: Date = new Date()): AgendaResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const error = `Calendar JXA returned non-JSON: ${raw.slice(0, 80)}`;
    return { ok: false, today: [], next: null, error, permissionDenied: isPermissionDenied(error) };
  }
  if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.events)) {
    const error = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "Calendar JXA failed";
    return { ok: false, today: [], next: null, error, permissionDenied: isPermissionDenied(error) };
  }
  const events: AgendaEvent[] = parsed.events
    .filter((e): e is { title: unknown; start: unknown; end: unknown } => isRecord(e))
    .filter((e) => typeof e.title === "string" && typeof e.start === "string" && typeof e.end === "string")
    .map((e) => ({ title: e.title as string, start: e.start as string, end: e.end as string }));

  const upcoming = events.find((e) => new Date(e.start).getTime() > now.getTime());
  const next = upcoming
    ? { title: upcoming.title, start: upcoming.start, inMinutes: Math.round((new Date(upcoming.start).getTime() - now.getTime()) / 60_000) }
    : null;
  return { ok: true, today: events, next };
}

/** Factory so tests inject a fake JXA runner instead of shelling out to osascript
 *  (and each instance owns its own 5-minute cache, so tests never share state). */
export function createAgendaFeature(runner: JxaRunner = runOsascript): ServerFeature {
  let cache: { at: number; result: AgendaResult } | null = null;

  return {
    id: "agenda",
    routes: [
      {
        method: "GET",
        path: "/api/agenda",
        async handler(_req, res, ctx) {
          const now = Date.now();
          if (cache && now - cache.at < CACHE_MS) {
            respondJson(res, cache.result.ok ? 200 : 502, cache.result);
            return;
          }
          let result: AgendaResult;
          try {
            result = parseAgenda(await runner());
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = { ok: false, today: [], next: null, error: message, permissionDenied: isPermissionDenied(message) };
          }
          if (!result.ok) ctx.log.warn("agenda", "calendar JXA failed", result.error);
          cache = { at: now, result };
          respondJson(res, result.ok ? 200 : 502, result);
        },
      },
    ],
  };
}

export const agendaFeature: ServerFeature = createAgendaFeature();
