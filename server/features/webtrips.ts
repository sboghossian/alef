// "webtrips": who leaves the planet. Alef sends only Jev out (websearch.ts, one click at a time,
// each search kept in data/jev-web.jsonl); Alex's sessions browse on their own, and each house
// counts its web trips here: WebSearch, WebFetch, exa, firecrawl, obscura's navigate and curl/wget
// to a remote host (webtrips-lib.ts, built on the sickness detectors' web-call classifier), with
// the hosts they named. READ-ONLY: transcripts are only read, nothing is written, no web call made.
//
// A call the harness refused before it ran (a permission rule, a hook, the user, the auto-mode
// classifier, a headless run with no allow rule, WebFetch's domain check) never left the Mac: its
// tool_result line takes the trip back, or keeps it from counting when that line is read first.
//
// Two sources, deduplicated by tool_use id (the same call read twice counts once):
//   - a bounded cold pass on the tick: every main transcript from 0 to its size when first seen,
//     and every subagent transcript from a cursor as it grows (the indexer never passes those),
//     newest first, at most budgetBytes per tick;
//   - the indexer's new lines for main transcripts (onIndexPass), which cover everything after
//     the size the cold pass stopped at.
// A session's count is served only once ALL its transcripts are read to their end: a half-read
// session shows nothing rather than a number that is too low.
//
//   GET /api/webtrips                     → WebTripsResponse (town totals + Jev's trips)
//   GET /api/webtrips/session/:sessionId  → WebTripsSessionResponse
//   GET /api/webtrips/jev                 → { ok, jev: JevTrips }

import { stat } from "node:fs/promises";
import {
  type JevTrips,
  type TripTool,
  type WebTripsResponse,
  type WebTripsSessionResponse,
  type WebTripsSummary,
} from "../../shared/features/webtrips.js";
import { respondJson } from "../http.js";
import { jevWebLogFor, JevWebLog } from "./recall/jev-web.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { MAX_LINE_BYTES } from "./sickness-lib.js";
import { readWindow } from "./sickness-scan.js";
import { listSessionFiles, listSubagentFiles } from "./subagents/scan.js";
import { addTrip, byToolRecord, deniedCallsInLine, denyTrip, newTally, toEntry, topHosts, tripsInLine, type TripTally } from "./webtrips-lib.js";

/** Bytes read per tick: ~2.6 GB of transcripts here, so the first pass takes ~40 ticks (~10 min). */
export const WEBTRIPS_BUDGET_BYTES = 64 * 1024 * 1024;
/** Main transcripts are <uuid>.jsonl; the indexer passes any top-level .jsonl. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WebTripsFeatureOptions {
  budgetBytes?: number;
  tickIntervalMs?: number;
  /** Jev's kept trips (default: data/jev-web.jsonl beside world.db). */
  jevWebPath?: string;
}

interface Cursor {
  path: string;
  sessionId: string;
  sub: boolean;
  /** Just past the last complete line read. */
  offset: number;
  /** Read up to here. Main: its size when first seen (the indexer's lines cover the rest), never
   *  moved. Subagent: its size at the latest listing. */
  target: number;
  mtimeMs: number;
  /** Inside a line over MAX_LINE_BYTES: drop bytes until its newline. */
  skipping: boolean;
  /** The target at which the last line had no newline yet: wait for the file to grow. */
  stalledAt: number | null;
  /** Web trips this transcript added to the count (net of the ones taken back as refused). */
  trips: number;
}

const caughtUp = (c: Cursor): boolean => c.offset >= c.target || c.stalledAt === c.target;

export interface WebTripsFeature extends ServerFeature {
  /** The town totals now (the vision ledger and tests read them). */
  summary(): WebTripsSummary;
  /** Jev's kept trips have been read from data/jev-web.jsonl at least once: before that, the
   *  summary's `jev` is a placeholder 0, never a measured one. */
  jevRead(): boolean;
}

export function createWebTripsFeature(opts: WebTripsFeatureOptions = {}): WebTripsFeature {
  const budget = opts.budgetBytes ?? WEBTRIPS_BUDGET_BYTES;
  const tallies = new Map<string, TripTally>();
  const cursors = new Map<string, Cursor>(); // path → cursor
  const bySession = new Map<string, Cursor[]>();
  let listed = false;
  let announced = false;
  let ownLog: JevWebLog | null = null;
  let jev: JevTrips = { trips: 0, since: null, last: null };
  let jevReadOnce = false;

  const tallyOf = (id: string): TripTally => {
    let t = tallies.get(id);
    if (!t) {
      t = newTally();
      tallies.set(id, t);
    }
    return t;
  };

  function jevLog(ctx: FeatureContext): JevWebLog | null {
    if (opts.jevWebPath) return (ownLog ??= new JevWebLog(opts.jevWebPath));
    return jevWebLogFor(ctx.config.dbPath);
  }

  async function refreshJev(ctx: FeatureContext): Promise<JevTrips> {
    const log = jevLog(ctx);
    if (!log) return jev;
    await log.refresh();
    jev = log.stats();
    jevReadOnce = log.isLoaded();
    return jev;
  }

  function sessionReady(id: string): boolean {
    if (!listed) return false;
    return (bySession.get(id) ?? []).every(caughtUp);
  }

  function allReady(): boolean {
    if (!listed) return false;
    for (const c of cursors.values()) if (!caughtUp(c)) return false;
    return true;
  }

  function summary(): WebTripsSummary {
    const byTool = new Map<TripTool, number>();
    const hosts = new Map<string, number>();
    let trips = 0;
    let sessionsWithTrips = 0;
    for (const t of tallies.values()) {
      if (t.trips === 0) continue;
      sessionsWithTrips++;
      trips += t.trips;
      for (const [k, n] of t.byTool) byTool.set(k, (byTool.get(k) ?? 0) + n);
      for (const [h, n] of t.hosts) hosts.set(h, (hosts.get(h) ?? 0) + n);
    }
    const transcripts = { main: 0, mainWithTrips: 0, subagent: 0, subagentWithTrips: 0 };
    for (const c of cursors.values()) {
      if (c.sub) {
        transcripts.subagent++;
        if (c.trips > 0) transcripts.subagentWithTrips++;
      } else {
        transcripts.main++;
        // A main transcript's own calls may also arrive from the indexer: its session's own count says it.
        if ((tallies.get(c.sessionId)?.own ?? 0) > 0) transcripts.mainWithTrips++;
      }
    }
    return { ready: allReady(), transcripts, sessionsWithTrips, trips, byTool: byToolRecord(byTool), hosts: hosts.size, topHosts: topHosts(hosts, 10), jev };
  }

  /** Lists every transcript: new ones get a cursor, grown subagent ones a new target, gone ones
   *  are dropped (with their session's count once none of its transcripts is left). */
  async function relist(ctx: FeatureContext): Promise<void> {
    const [main, subs] = await Promise.all([listSessionFiles(ctx.config.projectsDir), listSubagentFiles(ctx.config.projectsDir)]);
    const refs = [
      ...main.map((m) => ({ path: m.path, sessionId: m.sessionId, sub: false })),
      ...subs.map((s) => ({ path: s.path, sessionId: s.parentSessionId, sub: true })),
    ];
    const seen = new Set<string>();
    for (const r of refs) {
      seen.add(r.path);
      const known = cursors.get(r.path);
      if (known && !known.sub) continue; // a main target never moves: nothing to stat
      let size: number;
      let mtimeMs: number;
      try {
        const st = await stat(r.path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // raced a delete
      }
      if (known) {
        known.target = Math.max(known.offset, size);
        known.mtimeMs = mtimeMs;
        continue;
      }
      cursors.set(r.path, { path: r.path, sessionId: r.sessionId, sub: r.sub, offset: 0, target: size, mtimeMs, skipping: false, stalledAt: null, trips: 0 });
    }
    for (const p of [...cursors.keys()]) if (!seen.has(p)) cursors.delete(p);
    bySession.clear();
    for (const c of cursors.values()) {
      const list = bySession.get(c.sessionId) ?? [];
      list.push(c);
      bySession.set(c.sessionId, list);
    }
    for (const id of [...tallies.keys()]) if (!bySession.has(id)) tallies.delete(id);
    listed = true;
  }

  async function readSome(): Promise<void> {
    const todo = [...cursors.values()].filter((c) => !caughtUp(c)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let spent = 0;
    for (const c of todo) {
      const remaining = budget - spent;
      if (remaining <= 0) break;
      // At least one whole line past the cursor, so a long line can never stall a file for good.
      const end = Math.min(c.target, c.offset + Math.max(remaining, MAX_LINE_BYTES + 1));
      const tally = tallyOf(c.sessionId);
      let r: { consumed: number; skipping: boolean };
      try {
        r = await readWindow(c.path, c.offset, end, c.skipping, (line) => {
          for (const found of tripsInLine(line)) if (addTrip(tally, found, c.sub)) c.trips++;
          for (const key of deniedCallsInLine(line)) if (denyTrip(tally, key) && c.trips > 0) c.trips--;
        });
      } catch {
        c.stalledAt = c.target; // deleted or unreadable mid-read: the next listing decides
        continue;
      }
      spent += end - c.offset;
      c.offset = r.consumed;
      c.skipping = r.skipping;
      if (end === c.target && c.offset < c.target) c.stalledAt = c.target; // the last line isn't complete yet
    }
  }

  return {
    id: "webtrips",
    tickIntervalMs: opts.tickIntervalMs ?? 15_000,
    summary,
    jevRead: () => jevReadOnce,
    routes: [
      {
        method: "GET",
        path: "/api/webtrips",
        async handler(_req, res, ctx) {
          await refreshJev(ctx);
          respondJson(res, 200, { ok: true, summary: summary() } satisfies WebTripsResponse);
        },
      },
      {
        method: "GET",
        path: "/api/webtrips/jev",
        async handler(_req, res, ctx) {
          respondJson(res, 200, { ok: true, jev: await refreshJev(ctx) });
        },
      },
      {
        method: "GET",
        path: "/api/webtrips/session/:sessionId",
        handler(_req, res, _ctx, params) {
          const id = params.sessionId ?? "";
          const ready = sessionReady(id);
          const hasFiles = (bySession.get(id)?.length ?? 0) > 0;
          const entry = ready && hasFiles ? toEntry(id, tallies.get(id) ?? newTally()) : null;
          respondJson(res, 200, { ok: true, ready, entry } satisfies WebTripsSessionResponse);
        },
      },
    ],
    onIndexPass(_ctx, newLinesBySession) {
      for (const [sessionId, lines] of newLinesBySession) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        for (const line of lines) {
          for (const found of tripsInLine(line)) addTrip(tallyOf(sessionId), found, false);
          for (const key of deniedCallsInLine(line)) denyTrip(tallyOf(sessionId), key);
        }
      }
    },
    async onTick(ctx) {
      const first = !listed;
      await relist(ctx);
      if (first) {
        let bytes = 0;
        for (const c of cursors.values()) bytes += c.target;
        ctx.log.info("webtrips", `cold pass: ${cursors.size} transcripts, ${Math.round(bytes / (1024 * 1024))} MB, read ${Math.round(budget / (1024 * 1024))} MB per tick, newest first`);
      }
      await readSome();
      await refreshJev(ctx);
      if (!announced && allReady()) {
        announced = true;
        const s = summary();
        ctx.log.info(
          "webtrips",
          `cold pass done: ${s.transcripts.mainWithTrips} of ${s.transcripts.main} main transcripts and ${s.transcripts.subagentWithTrips} of ${s.transcripts.subagent} subagent transcripts made web trips (${s.trips} trips, ${s.hosts} hosts); Jev's kept trips: ${s.jev.trips}`,
        );
      }
    },
  };
}

export const webTripsFeature = createWebTripsFeature();
