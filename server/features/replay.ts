// GET /api/replay?date=YYYY-MM-DD — a time-ordered activity feed for one past day plus
// a daily report card. Built straight from session jsonl (same parseLine/deriveActivity
// the live indexer uses), not from a stored activity table — there isn't one; activity
// is only ever broadcast, never persisted (see docs/FEATURES.md's onIndexPass note).
// Cached per day: each file keeps its byte offset, so a repeat request only parses the lines
// appended since (jsonl is append-only); identical concurrent requests share one scan.

import { randomUUID } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReplayError, ReplayEvent, ReplayResponse } from "../../shared/features/replay.js";
import { deriveActivity } from "../activity.js";
import { respondJson } from "../http.js";
import { parseLine } from "../jsonl-events.js";
import { createTtlCache, yieldToLoop } from "./cache-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { aggregateReport, completeLines, dayBoundsMs, sampleEvents } from "./replay-lib.js";

const EVENT_CAP = 5000;
/** Day scans kept warm (each holds that day's events for every file touched since it began). */
const DAY_STATES_MAX = 4;

/** Only files that could plausibly hold a line from `sinceMs` onward (their last write is
 *  on/after that instant) — jsonl is append-only, so an untouched-since-before file can't.
 *  Stats run in parallel per project dir (one sequential stat per file was the cold cost). */
async function listJsonlFilesSince(projectsDir: string, sinceMs: number): Promise<Array<{ path: string; size: number; mtimeMs: number; ino: number }>> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const perDir = await Promise.all(
    projectDirs.map(async (dir) => {
      const full = join(projectsDir, dir);
      let entries: string[];
      try {
        entries = await readdir(full);
      } catch {
        return [];
      }
      const stats = await Promise.all(
        entries
          .filter((f) => f.endsWith(".jsonl"))
          .map(async (f) => {
            const filePath = join(full, f);
            try {
              const st = await stat(filePath);
              return st.mtimeMs >= sinceMs ? { path: filePath, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : null;
            } catch {
              return null; // deleted mid-scan
            }
          }),
      );
      return stats.filter((x): x is { path: string; size: number; mtimeMs: number; ino: number } => x !== null);
    }),
  );
  return perDir.flat();
}

/** One file's contribution to one day: parsed up to `offset` (a line boundary). */
interface FileDayState {
  ino: number;
  offset: number;
  cwd: string | null;
  events: ReplayEvent[];
}

async function readRange(filePath: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Parses the bytes appended to a file since the last scan (all of it the first time) and adds
 *  that day's events to `st`. Only whole lines are consumed; a half-written last line waits. */
async function scanFileTail(ctx: FeatureContext, file: { path: string; size: number; ino: number }, prev: FileDayState | undefined, bounds: { startMs: number; endMs: number }): Promise<FileDayState> {
  const st: FileDayState = prev && prev.ino === file.ino && prev.offset <= file.size ? prev : { ino: file.ino, offset: 0, cwd: null, events: [] };
  if (st.offset === file.size) return st;
  const buf = await readRange(file.path, st.offset, file.size);
  let { text, consumed } = completeLines(buf);
  // A last line with no trailing newline yet: take it only when it is already whole JSON
  // (a half-written line never is), so a finished file without a final "\n" still counts.
  if (consumed < buf.length) {
    const rest = buf.subarray(consumed).toString("utf8");
    if (parseLine(rest)) {
      text += rest;
      consumed = buf.length;
    }
  }
  st.offset += consumed;
  const sessionId = basename(file.path, ".jsonl");
  for (const lineStr of text.split("\n")) {
    if (!lineStr) continue;
    const parsed = parseLine(lineStr);
    if (!parsed) continue;
    if (parsed.cwd && !st.cwd) st.cwd = parsed.cwd;
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < bounds.startMs || ts >= bounds.endMs) continue;
    if (!st.cwd) continue; // every real jsonl line carries cwd; a file with none is unattributable
    const cwd = st.cwd;
    const islandId = ctx.db.getIslandForCwd(cwd) ?? "unknown";
    for (const d of deriveActivity(parsed, cwd, parsed.timestamp!)) {
      st.events.push({
        id: randomUUID(),
        agentId: sessionId,
        islandId,
        at: d.at,
        stage: d.stage,
        toolName: d.toolName,
        targetObjectId: d.targetObjectId,
        summary: d.summary,
      });
    }
  }
  return st;
}

export function createReplayFeature(opts: { responseTtlMs?: number } = {}): ServerFeature {
  // `${projectsDir}\n${date}` → per-file incremental state for that day (LRU, DAY_STATES_MAX).
  const dayStates = new Map<string, Map<string, FileDayState>>();
  // Identical concurrent requests share one scan; a finished one is reused for 3s.
  const responses = createTtlCache<string, ReplayResponse>({ ttlMs: opts.responseTtlMs ?? 3_000, max: 8 });
  // A day that ended over 10 minutes ago only gains lines by clock skew: keep its answer 10 min.
  const pastDays = createTtlCache<string, ReplayResponse>({ ttlMs: opts.responseTtlMs ?? 10 * 60_000, max: 8 });

  async function scanDay(ctx: FeatureContext, date: string, bounds: { startMs: number; endMs: number }): Promise<ReplayEvent[]> {
    const key = `${ctx.config.projectsDir}\n${date}`;
    const prevFiles = dayStates.get(key) ?? new Map<string, FileDayState>();
    dayStates.delete(key);
    const files = await listJsonlFilesSince(ctx.config.projectsDir, bounds.startMs);
    const next = new Map<string, FileDayState>();
    for (const f of files) {
      try {
        next.set(f.path, await scanFileTail(ctx, f, prevFiles.get(f.path), bounds));
      } catch {
        /* unreadable / raced: skip this pass */
      }
      await yieldToLoop(); // a cold day is hundreds of MB of JSON: never hold the loop for all of it
    }
    dayStates.set(key, next);
    while (dayStates.size > DAY_STATES_MAX) {
      const oldest = dayStates.keys().next();
      if (oldest.done) break;
      dayStates.delete(oldest.value);
    }
    const events = [...next.values()].flatMap((s) => s.events);
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return events;
  }

  return {
    id: "replay",
    routes: [
      {
        method: "GET",
        path: "/api/replay",
        async handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const date = url.searchParams.get("date") ?? "";
          const bounds = dayBoundsMs(date);
          if (!bounds) {
            respondJson(res, 400, { ok: false, error: "date must be a valid YYYY-MM-DD" } satisfies ReplayError);
            return;
          }
          try {
            const settled = bounds.endMs + 10 * 60_000 < Date.now();
            const body = await (settled ? pastDays : responses).get(`${ctx.config.projectsDir}\n${date}`, async () => {
              const events = await scanDay(ctx, date, bounds);
              const tokens = ctx.db.getDayTokens(date);
              const islandNames = new Map(ctx.worldViews().islands.map((i) => [i.id, i.name]));
              const report = aggregateReport(date, events, tokens, islandNames);
              const { sampled, truncated } = sampleEvents(events, EVENT_CAP);
              return { ok: true, date, events: sampled, truncated, report } satisfies ReplayResponse;
            });
            respondJson(res, 200, body);
          } catch (err) {
            ctx.log.error("replay", "scan failed", String(err));
            respondJson(res, 500, { ok: false, error: String(err) } satisfies ReplayError);
          }
        },
      },
    ],
  };
}

export const replayFeature: ServerFeature = createReplayFeature();
