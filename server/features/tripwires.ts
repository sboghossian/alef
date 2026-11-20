// "tripwires": the world notices when a live session repeats a lesson the fleet already learned.
// A higher-order self-monitor: the Alef loop writes lessons down (journal, LOOP.md, MEMORY.md
// standing warnings), and these deterministic rules (tripwires-defs.ts) watch the tool calls
// live sessions make right now:
//   - a session's own calls come through the indexer's new-lines hook (onIndexPass: the same raw
//     lines the feed and activity machinery see; parsed with parseLine, never executed);
//   - its subagents' calls (the loop's builders are subagents) come from the subagents feature's
//     own scanner (listSubagentFiles + streamLines), read on each tick from a per-file offset,
//     only for transcripts written within the live window. They count for the parent session.
//
// Observe and flag only: nothing here blocks, interrupts or messages a session. A hit is
// deduped per session + tripwire, kept in memory (newest first, capped), pushed over WS, served
// in the snapshot and at GET /api/tripwires. The resident reads recentTripwireHits() to journal
// them and reflect on which lessons keep recurring. No model calls.
//
// Memory that lasts: every new hit is appended to data/tripwires.jsonl (tripwires-store.ts:
// append-only, a new generation file at 5 MB), and the first hook to run after boot folds the log
// back into the tracker before any line is ingested, so a restart neither loses hits nor reports a
// second hit for a session + lesson it already had. Folded hits are never re-pushed over WS. The
// fold (and the first coverage count) run in onStart, which the hub awaits before it listens, so
// the first snapshot after a restart already holds them.
//
// Coverage: "N lessons written, 12 guarded", counted on the existing tick (at most every
// COVERAGE_TTL_MS) from the files lessons get written to, against the rules' own `source` fields.
// Counts only (tripwires-lib.ts's buildCoverage): no lesson is ever turned into a rule.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { displayIslandName } from "../../shared/display.js";
import {
  TRIPWIRES_COVERAGE_KEY,
  TRIPWIRES_HITS_KEY,
  type LessonSourceId,
  type TripwireCoverage,
  type TripwireHit,
  type TripwiresMessage,
  type TripwiresResponse,
} from "../../shared/features/tripwires.js";
import type { WorldDb } from "../db.js";
import { respondJson } from "../http.js";
import { READ_TIMEOUT_MS } from "./archive.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { listSubagentFiles, streamLines } from "./subagents/scan.js";
import { TRIPWIRE_DEFS, TRIPWIRES_VERSION } from "./tripwires-defs.js";
import {
  buildCoverage,
  compileTripwires,
  countConductCases,
  countFeedbackMemories,
  countJournalLessons,
  countStandingWarnings,
  LIVE_WINDOW_MS,
  ruleViews,
  TripwireTracker,
  type LessonCountResult,
  type TrackerOptions,
} from "./tripwires-lib.js";
import { PathGuard, readTextGuarded, TripwireStore } from "./tripwires-store.js";

const compiled = compileTripwires(TRIPWIRE_DEFS);
const MAX_TRACKED_FILES = 5000;
/** Lesson files are recounted at most this often (they change a few times a day). */
export const COVERAGE_TTL_MS = 10 * 60_000;
/** A lesson file bigger than this is counted from its last 2 MB only (the journal is ~40 KB). */
const LESSON_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** The files lessons get written to (see LESSON_SOURCE_SPECS in tripwires-lib.ts). */
export interface LessonSourcePaths {
  journal: string;
  /** The auto-memory folder: MEMORY.md (standing warnings) and the feedback_*.md files. */
  memoryDir: string;
  conductCases: string;
}

export function defaultLessonSourcePaths(home: string = homedir()): LessonSourcePaths {
  return {
    journal: join(home, ".alef-loop", "journal.md"),
    memoryDir: join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory"),
    conductCases: join(home, ".claude", "evals", "agent-conduct", "CASES.md"),
  };
}

function homeRel(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Reads each lesson source (read-only, guarded) and counts it. Never throws. */
export async function countLessonSources(paths: LessonSourcePaths, guard: PathGuard, home: string = homedir()): Promise<Record<LessonSourceId, LessonCountResult>> {
  const text = async (path: string, count: (t: string) => number): Promise<LessonCountResult> => {
    const r = await readTextGuarded(guard, path, LESSON_FILE_MAX_BYTES);
    return r.ok ? { path: homeRel(path, home), ok: true, lessons: count(r.value) } : { path: homeRel(path, home), ok: false, error: r.error };
  };
  const listing = async (dir: string): Promise<LessonCountResult> => {
    const r = await guard.run(dir, () => readdir(dir));
    return r.ok ? { path: `${homeRel(dir, home)}/`, ok: true, lessons: countFeedbackMemories(r.value) } : { path: `${homeRel(dir, home)}/`, ok: false, error: r.error };
  };
  const [journal, standing, feedback, cases] = await Promise.all([
    text(paths.journal, countJournalLessons),
    text(join(paths.memoryDir, "MEMORY.md"), countStandingWarnings),
    listing(paths.memoryDir),
    text(paths.conductCases, countConductCases),
  ]);
  return { journal, "standing-warnings": standing, "feedback-memories": feedback, "conduct-cases": cases };
}

let current: TripwireTracker | null = null;

/** Hits the running feature has seen, newest first ([] before its first pass). */
export function recentTripwireHits(): TripwireHit[] {
  return current?.hits() ?? [];
}

function districtOf(db: WorldDb, islandId: string): string | null {
  const path = db.getIslandCwd(islandId) ?? "";
  const name = (path && basename(path)) || islandId;
  return displayIslandName({ name, path });
}

export interface TripwiresFeatureOptions extends Partial<TrackerOptions> {
  now?: () => number;
  tickIntervalMs?: number;
  /** Where tripwires.jsonl (and its generations) live; defaults to the world.db directory. */
  dataDir?: string;
  /** Bytes per generation file; defaults to TRIPWIRES_ROTATE_BYTES. Small in tests. */
  rotateBytes?: number;
  /** The files the coverage line counts; defaults to the real ones under $HOME. */
  lessonSources?: LessonSourcePaths;
}

export function createTripwiresFeature(opts: TripwiresFeatureOptions = {}): ServerFeature {
  const liveWindowMs = opts.liveWindowMs ?? LIVE_WINDOW_MS;
  const tracker = new TripwireTracker(compiled, { home: opts.home ?? homedir(), cap: opts.cap, liveWindowMs });
  const now = opts.now ?? Date.now;
  const rules = ruleViews(compiled);
  const lessonSources = opts.lessonSources ?? defaultLessonSourcePaths();
  const readGuard = new PathGuard(READ_TIMEOUT_MS);
  /** Subagent transcript → the byte offset just past its last line we read. */
  const offsets = new Map<string, number>();
  let store: TripwireStore | null = null;
  let folded: Promise<void> | null = null;
  let coverage: TripwireCoverage | null = null;
  let coverageAt = -Infinity;
  let counting: Promise<void> | null = null;

  /** The log, folded into the tracker once, before anything is ingested (every entry point awaits
   *  this first). Never rejects: a log that can't be read leaves the tracker as it was. */
  function whenFolded(ctx: FeatureContext): Promise<void> {
    folded ??= (async () => {
      const s = new TripwireStore(opts.dataDir ?? dirname(ctx.config.dbPath), { rotateBytes: opts.rotateBytes });
      const { hits, errors } = await s.load();
      const kept = tracker.restore(hits);
      s.noteRestored(kept.length);
      store = s;
      current = tracker;
      for (const e of errors) ctx.log.warn("tripwires", `hit log: ${e}`);
      if (kept.length) ctx.log.info("tripwires", `restored ${kept.length} hit(s) from the hit log`);
    })().catch((err: unknown) => ctx.log.warn("tripwires", "hit log fold failed", String(err)));
    return folded;
  }

  /** Recounts the lesson sources when the last count is older than COVERAGE_TTL_MS. Never rejects. */
  function refreshCoverage(ctx: FeatureContext): Promise<void> {
    if (now() - coverageAt < COVERAGE_TTL_MS) return Promise.resolve();
    counting ??= (async () => {
      try {
        const counts = await countLessonSources(lessonSources, readGuard);
        coverage = buildCoverage(counts, TRIPWIRE_DEFS, new Date(now()).toISOString());
        coverageAt = now();
      } catch (err) {
        ctx.log.warn("tripwires", "lesson coverage count failed", String(err));
      } finally {
        counting = null;
      }
    })();
    return counting;
  }

  function where(ctx: FeatureContext, sessionId: string): { cwd: string; district: string | null } {
    const row = ctx.db.getSession(sessionId);
    return { cwd: row?.cwd ?? "", district: row ? districtOf(ctx.db, row.islandId) : null };
  }

  function publish(ctx: FeatureContext, fresh: readonly TripwireHit[]): void {
    if (fresh.length === 0) return;
    // Queued in the order the tracker found them; the store records the outcome, never throws.
    void store?.append(fresh);
    for (const h of fresh) ctx.log.info("tripwires", `${h.tripwireId} · ${h.sessionId.slice(0, 8)}${h.subagentId ? ` (subagent ${h.subagentId.slice(0, 8)})` : ""} · ${h.snippet}`);
    ctx.emit({ kind: "hits", hits: [...fresh] } satisfies TripwiresMessage);
  }

  return {
    id: "tripwires",
    tickIntervalMs: opts.tickIntervalMs ?? 10_000,
    routes: [
      {
        method: "GET",
        path: "/api/tripwires",
        async handler(_req, res, ctx) {
          await Promise.all([whenFolded(ctx), refreshCoverage(ctx)]);
          await store?.settled(); // the status below then covers every hit found before this GET
          const persistence = store?.status() ?? { file: "tripwires.jsonl", restored: 0, appended: 0, unconfirmed: 0, lastError: "the hit log was not read" };
          respondJson(res, 200, { ok: true, version: TRIPWIRES_VERSION, rules, hits: tracker.hits(), coverage, persistence } satisfies TripwiresResponse);
        },
      },
    ],
    async onStart(ctx) {
      // The hub awaits this before it listens, so the first snapshot (an open tab reconnecting
      // after a restart replaces its list with it) already holds the folded log and the coverage.
      await Promise.all([whenFolded(ctx), refreshCoverage(ctx)]);
    },
    async onIndexPass(ctx, newLinesBySession) {
      await whenFolded(ctx);
      current = tracker;
      const fresh: TripwireHit[] = [];
      const nowMs = now();
      for (const [sessionId, lines] of newLinesBySession) fresh.push(...tracker.ingest(sessionId, lines, { ...where(ctx, sessionId), nowMs }));
      publish(ctx, fresh);
    },
    async onTick(ctx) {
      await whenFolded(ctx);
      current = tracker;
      await refreshCoverage(ctx);
      const nowMs = now();
      const fresh: TripwireHit[] = [];
      try {
        for (const ref of await listSubagentFiles(ctx.config.projectsDir)) {
          let lines: string[];
          let end: number;
          try {
            const { size, mtimeMs } = await stat(ref.path);
            if (nowMs - mtimeMs > liveWindowMs) continue; // not live: never read
            const prev = offsets.get(ref.path);
            if (prev === size) continue;
            const start = prev !== undefined && prev <= size ? prev : 0;
            const read: string[] = [];
            end = await streamLines(ref.path, start, (buf) => {
              if (buf.includes('"tool_use"')) read.push(buf.toString("utf8"));
            });
            lines = read;
          } catch {
            continue; // deleted, unreadable or not a file mid-scan: skip it, never the rest
          }
          offsets.delete(ref.path); // re-insert: the map's order is least recently read first
          offsets.set(ref.path, end);
          if (offsets.size > MAX_TRACKED_FILES) offsets.delete(offsets.keys().next().value ?? "");
          if (lines.length) fresh.push(...tracker.ingest(ref.parentSessionId, lines, { ...where(ctx, ref.parentSessionId), nowMs, subagentId: ref.agentId }));
        }
      } finally {
        publish(ctx, fresh); // hits already recorded always reach the clients
      }
    },
    snapshotExtras(ctx) {
      void whenFolded(ctx); // a snapshot before the first tick still starts the fold
      return { [TRIPWIRES_HITS_KEY]: tracker.hits(), [TRIPWIRES_COVERAGE_KEY]: coverage };
    },
  };
}

export const tripwiresFeature = createTripwiresFeature();
