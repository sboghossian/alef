// "careers" (agent-city piece 3, the 🏛 Tower): one worker per automation lineage, each with a
// career state computed by code from its real runs (careers-lib.ts has the state machine and the
// one department map). No model call.
//
// Inputs, all read-only and all already in memory:
//   - ctx.worldViews().agents: live and dormant sessions (the real /api/world agent shape);
//   - the archive's last built session list (archive.ts latestArchivedSessions): pruned sessions;
//   - the outcomes feature's records (outcomes.ts latestOutcomeRecords): each run's verdict;
//   - the routines scan (routines.ts latestRoutines): the com.stephane.<slug> link, shown only.
//
// Every 5 min (onTick) it recomputes every worker, pushes the summary over WS when it changed, and
// sends a "graduation" Feed item when a worker moves into trusted, probation or lapsed (or runs
// again after a retirement): careers-lib.ts careerFeedItem has the rules. Nothing is announced:
//   - before the archive list has loaded (late data would read as a wave of transitions), or
//     while careers.json can't be read (retirements would read as missing);
//   - on the first computation that records a worker (boot, or a lineage first seen after boot);
//   - while a run that could still enter a worker's standing window awaits the outcomes scanner
//     (every awaiting run newer than its 5th-newest run with a verdict: a record missing or not
//     read to the end, e.g. during outcomes' cold scan or right after a run, or one outcomes marks
//     provisional because the clock alone can still make it failed or abandoned). The move is
//     judged, and announced once, when those verdicts are final.
//
// The only file written is data/careers.json (next to world.db), and only by the POST routes:
// retire / unretire / name, each with {confirm:true}, each validating the key against the current
// worker list, each written to a .tmp then renamed, one at a time. The president's commencement
// "retire" proposal calls the same retire path (retireCareerWorker), from its own confirmed click. It holds Alex's intent
// (retiredAt, a display name), never a computed state. Retiring changes what Alef displays and
// nothing else: no launchd, skill, transcript or settings write, ever.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchivedSession } from "../../shared/features/archive.js";
import {
  CAREERS_SUMMARY_KEY,
  DEPARTMENTS,
  type CareerTrend,
  type CareerWorker,
  type CareersActionResult,
  type CareersMessage,
  type CareersResponse,
  type CareersSummary,
} from "../../shared/features/careers.js";
import type { FeedItem } from "../../shared/features/feed.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { Routine } from "../../shared/features/routines.js";
import type { WorldAgent } from "../../shared/types.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { latestArchivedSessions } from "./archive.js";
import {
  careerFeedItem,
  cleanName,
  computeCareers,
  emptyCareersFile,
  entryOf,
  parseCareersFile,
  recordOf,
  runSources,
  publishKey,
  summarize,
  type CareersFile,
  type ComputedWorker,
  type RecordedCareer,
} from "./careers-lib.js";
import { appendToFeed } from "./feed.js";
import { latestOutcomeRecords } from "./outcomes.js";
import type { FeatureContext, Route, ServerFeature } from "./registry.js";
import { latestRoutines } from "./routines.js";

const TICK_MS = 5 * 60_000;
const MAX_RAW_NAME = 200;

export interface CareersSources {
  outcomes(): readonly OutcomeRecord[];
  /** Null until the archive has built its list once. */
  archive(): readonly ArchivedSession[] | null;
  routines(): readonly Routine[];
}

export interface CareersFeatureOptions {
  /** Where careers.json lives; defaults to the world.db directory. */
  dataDir?: string;
  now?: () => number;
  tickIntervalMs?: number;
  /** Where transitions go; defaults to the live Feed (feed.ts appendToFeed). */
  feed?: (item: Omit<FeedItem, "seq">) => void;
  sources?: Partial<CareersSources>;
}

type StoreRead = { file: CareersFile; status: "ok" | "missing" | "malformed" | "lossy" } | { file: CareersFile; status: "unreadable"; code: string };

/** An answer a POST gives instead of writing. */
interface Refusal {
  status: number;
  body: CareersActionResult;
}

/** Every worker from the last computation made on settled inputs (the archive list loaded,
 *  careers.json readable); null before the first one. The president reads it for commencement. */
let settledWorkers: readonly CareerWorker[] | null = null;

export function latestCareerWorkers(): readonly CareerWorker[] | null {
  return settledWorkers;
}

/** Every worker's trend from that same settled computation; null before the first one (the
 *  vision ledger's "keep getting better" probe reads it). */
let settledTrends: readonly CareerTrend[] | null = null;

export function latestCareerTrends(): readonly CareerTrend[] | null {
  return settledTrends;
}

type Action = "retire" | "unretire" | "name";

export interface CareersFeature extends ServerFeature {
  /** The POST routes' own logic, after their body checks (confirm, name): the key is validated
   *  against the current workers inside careers.json's write queue. */
  act(ctx: FeatureContext, action: Action, key: string, name: string | null): Promise<{ status: number; body: CareersActionResult }>;
}

interface Computed {
  workers: ComputedWorker[];
  summary: CareersSummary;
  inputs: CareersResponse["inputs"];
  storeReadable: boolean;
  agents: readonly WorldAgent[];
}

export function createCareersFeature(opts: CareersFeatureOptions = {}): CareersFeature {
  const now = opts.now ?? Date.now;
  const feed = opts.feed ?? appendToFeed;
  const sources: CareersSources = {
    outcomes: opts.sources?.outcomes ?? latestOutcomeRecords,
    archive: opts.sources?.archive ?? latestArchivedSessions,
    routines: opts.sources?.routines ?? (() => latestRoutines().routines),
  };

  let file: CareersFile | null = null;
  /** Each worker's last settled state; null until the first computation with the archive loaded. */
  let recorded: Map<string, RecordedCareer> | null = null;
  let summary: CareersSummary | null = null;
  let summaryJson = "";
  let writes: Promise<unknown> = Promise.resolve();

  const dataPath = (ctx: FeatureContext): string => join(opts.dataDir ?? dirname(ctx.config.dbPath), "careers.json");

  /** Reads careers.json now. Sync: snapshotExtras is sync. */
  function readStore(ctx: FeatureContext): StoreRead {
    let text: string;
    try {
      text = readFileSync(dataPath(ctx), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "read error";
      return code === "ENOENT" ? { file: emptyCareersFile(), status: "missing" } : { file: emptyCareersFile(), status: "unreadable", code };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      /* not JSON */
    }
    const parsed = parseCareersFile(raw);
    if (!parsed) return { file: emptyCareersFile(), status: "malformed" };
    // Entries it had to drop would be lost by the next write: that file is kept aside too.
    const had = isRecord(raw) && isRecord(raw.workers) ? Object.keys(raw.workers).length : 0;
    return { file: parsed, status: had === Object.keys(parsed.workers).length ? "ok" : "lossy" };
  }

  /** What the states are computed with, cached once read (only Alef's POSTs write the file, and
   *  they refresh it). A missing or malformed file reads as empty (nothing retired or named). An
   *  unreadable one (EACCES, an iCloud placeholder…) also reads as empty but is never cached: it is
   *  read again next time, and the tick records nothing until it can be read. */
  function load(ctx: FeatureContext): { file: CareersFile; readable: boolean } {
    if (file) return { file, readable: true };
    const r = readStore(ctx);
    if (r.status === "unreadable") return { file: r.file, readable: false };
    file = r.file;
    return { file, readable: true };
  }

  /** `agents` defaults to ctx.worldViews().agents, which scans live processes (ps + lsof, sync):
   *  a POST passes the list it already has instead of scanning twice. */
  function compute(ctx: FeatureContext, agents: readonly WorldAgent[] = ctx.worldViews().agents): Computed {
    const archived = sources.archive();
    const outcomes = sources.outcomes();
    const routines = sources.routines();
    const store = load(ctx);
    const workers = computeCareers({
      runs: runSources(agents, archived ?? []),
      records: new Map(outcomes.map((r) => [r.sessionId, r])),
      file: store.file,
      routines,
      nowMs: now(),
    });
    const s = summarize(workers.map((w) => w.worker));
    summary = s;
    const inputs = { liveRuns: agents.length, archivedRuns: archived?.length ?? 0, archiveLoaded: archived !== null, outcomeRecords: outcomes.length, routines: routines.length };
    if (archived !== null && store.readable) {
      settledWorkers = workers.map((w) => w.worker);
      settledTrends = workers.map((w) => w.trend);
    }
    return { workers, summary: s, inputs, storeReadable: store.readable, agents };
  }

  function publish(ctx: FeatureContext, s: CareersSummary, workers: readonly { worker: CareerWorker }[]): void {
    const json = publishKey(s, workers.map((w) => w.worker));
    if (json === summaryJson) return;
    summaryJson = json;
    ctx.emit({ kind: "summary", summary: s } satisfies CareersMessage);
  }

  function tick(ctx: FeatureContext): void {
    const c = compute(ctx);
    publish(ctx, c.summary, c.workers);
    if (!c.inputs.archiveLoaded || !c.storeReadable) return; // a partial world: never the baseline, never a transition
    const nowIso = new Date(now()).toISOString();
    const next = recorded ?? new Map<string, RecordedCareer>();
    for (const w of c.workers) {
      if (w.awaiting > 0) continue; // a verdict that could move it is still coming: keep the last settled state
      const prev = next.get(w.worker.key);
      next.set(w.worker.key, recordOf(w));
      if (!prev) continue; // boot, or first seen after boot: recorded silently
      const item = careerFeedItem(prev, w, nowIso);
      if (item) feed(item);
    }
    recorded = next;
  }

  /**
   * careers.json read-modify-write, one at a time. Inside the queue it reads the file from disk
   * again, so `mutate` always sees what is there. A file it can't read (EACCES, an iCloud
   * placeholder) is never written over: the request fails. A file it can't parse, or whose
   * entries it had to drop, is kept aside as careers.json.malformed-<time> before the new one is
   * renamed into place. `mutate` returns the new file, or an answer to give instead of writing.
   */
  function update(ctx: FeatureContext, mutate: (f: CareersFile) => CareersFile | Refusal): Promise<Refusal | null> {
    const run = writes.then(async (): Promise<Refusal | null> => {
      const current = readStore(ctx);
      if (current.status === "unreadable") return { status: 500, body: { ok: false, error: `careers.json exists but couldn't be read (${current.code}), so nothing was written` } };
      file = current.file;
      const next = mutate(current.file);
      if (!("workers" in next)) return next;
      const path = dataPath(ctx);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, `${JSON.stringify(next, null, 1)}\n`, "utf8");
      if (current.status === "malformed" || current.status === "lossy") await rename(path, `${path}.malformed-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`);
      await rename(`${path}.tmp`, path);
      file = next;
      return null;
    });
    writes = run.catch(() => undefined);
    return run;
  }

  async function act(ctx: FeatureContext, action: Action, key: string, name: string | null): Promise<{ status: number; body: CareersActionResult }> {
    const at = new Date(now()).toISOString();
    let refused: Refusal | null;
    let agents: readonly WorldAgent[] | undefined;
    try {
      refused = await update(ctx, (f) => {
        // Checked inside the queue, against the file as it is now (a double click gets a 409).
        const before = compute(ctx);
        agents = before.agents;
        const state = before.workers.find((w) => w.worker.key === key)?.worker.state;
        if (state === undefined) return { status: 404, body: { ok: false, error: "no worker with that key" } };
        const entry = entryOf(f, key) ?? { retiredAt: null, name: null, updatedAt: at };
        if (action === "retire" && state === "retired") return { status: 409, body: { ok: false, error: "already retired" } };
        if (action === "unretire" && entry.retiredAt === null) return { status: 409, body: { ok: false, error: "not retired" } };
        const changed = { ...entry, updatedAt: at, ...(action === "retire" ? { retiredAt: at } : action === "unretire" ? { retiredAt: null } : { name }) };
        return { ...f, workers: { ...f.workers, [key]: changed } };
      });
    } catch (err) {
      ctx.log.error("careers", `${action} failed to write careers.json`, String(err));
      return { status: 500, body: { ok: false, error: "couldn't write careers.json" } };
    }
    if (refused) return refused;
    const after = compute(ctx, agents);
    publish(ctx, after.summary, after.workers);
    const w = after.workers.find((x) => x.worker.key === key)?.worker;
    ctx.log.info("careers", `${action} ${key}`, { state: w?.state ?? null });
    return { status: 200, body: { ok: true, key, state: w?.state, name: w?.name ?? null } };
  }

  function routeFor(action: Action): Route {
    return {
      method: "POST",
      path: `/api/careers/:key/${action}`,
      async handler(req, res, ctx, params) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies CareersActionResult);
        }
        if (!isRecord(body) || body.confirm !== true) return respondJson(res, 400, { ok: false, error: `confirm: true is required to ${action === "name" ? "name" : action} a worker` } satisfies CareersActionResult);
        let name: string | null = null;
        if (action === "name") {
          if (!(body.name === null || (typeof body.name === "string" && body.name.length <= MAX_RAW_NAME))) return respondJson(res, 400, { ok: false, error: "name must be a string (≤ 40 characters kept) or null" } satisfies CareersActionResult);
          name = body.name === null ? null : cleanName(body.name);
        }
        const r = await act(ctx, action, params.key ?? "", name);
        respondJson(res, r.status, r.body satisfies CareersActionResult);
      },
    };
  }

  return {
    id: "careers",
    act,
    tickIntervalMs: opts.tickIntervalMs ?? TICK_MS,
    onTick: tick,
    snapshotExtras(ctx) {
      return { [CAREERS_SUMMARY_KEY]: summary ?? compute(ctx).summary };
    },
    routes: [
      {
        method: "GET",
        path: "/api/careers",
        handler(_req, res, ctx) {
          const c = compute(ctx);
          respondJson(res, 200, {
            ok: true,
            at: new Date(now()).toISOString(),
            inputs: c.inputs,
            departments: DEPARTMENTS,
            summary: c.summary,
            workers: c.workers.map((w) => w.worker),
            trends: c.workers.map((w) => w.trend),
          } satisfies CareersResponse);
        },
      },
      routeFor("retire"),
      routeFor("unretire"),
      routeFor("name"),
    ],
  };
}

export const careersFeature: CareersFeature = createCareersFeature();

/** Retires a worker through the registered careers feature's own path (the same checks and the
 *  same careers.json write as POST /api/careers/:key/retire), from another feature's route: the
 *  president's commencement Retire. `ctx` is rebound to careers so its summary reaches careers' clients. */
export function retireCareerWorker(ctx: FeatureContext, key: string): Promise<{ status: number; body: CareersActionResult }> {
  const careersCtx: FeatureContext = { ...ctx, featureId: careersFeature.id, emit: (payload) => ctx.broadcast({ type: "feature", feature: careersFeature.id, payload }) };
  return careersFeature.act(careersCtx, "retire", key, null);
}
