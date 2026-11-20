// "subagents" feature (round 5 G1a): makes the subagents a session spawned visible.
// Indexes subagents/agent-*.jsonl (and workflows/<wf>/agent-*.jsonl) in the background —
// the cold pass starts on first use (a client connecting, a request, or the first tick)
// and never blocks the hub's own index. Subagents stay child records of their session:
// snapshot extras (last 7 days), GET /api/subagents[?parent=<sessionId>], and WS
// messages when a record changes or a live subagent writes new lines. The same pass also
// reads how every top-level session transcript ended (endings.ts): the RunEnding list of
// sessions that failed or were stopped, in the snapshot and pushed when it changes.

import {
  RECENT_WINDOW_MS,
  SUBAGENTS_RECENT_KEY,
  SUBAGENTS_RUNS_KEY,
  SUBAGENTS_STATS_KEY,
  type RunEnding,
  type SubagentActivity,
  type SubagentRecord,
  type SubagentStats,
  type SubagentsMessage,
  type SubagentsResponse,
} from "../../../shared/features/subagents.js";
import { respondJson } from "../../http.js";
import type { FeatureContext, ServerFeature } from "../registry.js";
import { RunEndings } from "./endings.js";
import { buildRecords, runSubagentPass, statsFor } from "./pass.js";
import { SubagentStore, storePathFor } from "./store.js";

const MAX_LIST = 2000;
const MAX_RECENT = 500;
const MAX_UPSERT = 200;
const MAX_ACTIVITY = 50;

interface Runtime {
  store: SubagentStore;
  coldPassMs: number | null;
  cold: Promise<void> | null;
  running: Promise<void> | null;
  records: SubagentRecord[];
  /** Fingerprint of each record as last emitted, to emit only changes. */
  sent: Map<string, string>;
  endings: RunEndings;
  runs: RunEnding[];
  /** JSON of `runs` as last emitted. */
  runsSent: string;
}

const runtimes = new Map<string, Runtime>();

/** Module-level copy of the latest published records, set in `publish()` below. Lets another
 *  feature (the resident's "since last reflection" summary, the census feature's generations
 *  block) read the current subagent roll-up without importing this feature's per-db `Runtime`
 *  map. null until `publish()` has run at least once — the cold pass over subagents.db can take
 *  several seconds on a fresh boot, and an empty array here would be indistinguishable from a
 *  genuinely empty subagents.db. */
let latestRecords: readonly SubagentRecord[] | null = null;

export function latestSubagentRecords(): readonly SubagentRecord[] | null {
  return latestRecords;
}

/** Same idea for the run endings (what snapshotExtras serves as "subagents.runs"), for the Town
 *  square's server-side workspace (server/features/workspace.ts). [] until `publish()` has run. */
let latestRuns: readonly RunEnding[] = [];

export function latestRunEndings(): readonly RunEnding[] {
  return latestRuns;
}

function runtime(ctx: FeatureContext): Runtime {
  const key = ctx.config.dbPath;
  let rt = runtimes.get(key);
  if (!rt) {
    rt = { store: new SubagentStore(storePathFor(key)), coldPassMs: null, cold: null, running: null, records: [], sent: new Map(), endings: new RunEndings(), runs: [], runsSent: "[]" };
    rt.records = buildRecords(rt.store, Date.now());
    for (const r of rt.records) rt.sent.set(r.id, fingerprint(r));
    runtimes.set(key, rt);
  }
  return rt;
}

function fingerprint(r: SubagentRecord): string {
  return `${r.status}|${r.reason ?? ""}|${r.lastActive}|${r.tokens}|${r.model ?? ""}|${r.depth}|${r.description}`;
}

/** Every changed record, in as many upsert messages as it takes (≤ `max` records each): a change
 *  marked as sent is always emitted (a FOLD_VERSION re-fold can change hundreds at once). */
export function upsertMessages(changed: readonly SubagentRecord[], stats: SubagentStats, max = MAX_UPSERT): SubagentsMessage[] {
  const out: SubagentsMessage[] = [];
  for (let i = 0; i < changed.length; i += max) out.push({ kind: "upsert", subagents: changed.slice(i, i + max), stats });
  return out;
}

/** Runs one pass, never two at once. The first one is the cold pass (no activity feed). */
async function pass(ctx: FeatureContext, rt: Runtime): Promise<void> {
  while (rt.running) await rt.running;
  const cold = rt.coldPassMs === null;
  const run = (async () => {
    const res = await runSubagentPass(rt.store, ctx.config.projectsDir, { collectActivity: !cold });
    rt.runs = await rt.endings.refresh(ctx.config.projectsDir, Date.now());
    if (cold) {
      rt.coldPassMs = res.durationMs;
      const recs = buildRecords(rt.store, Date.now());
      const stats = statsFor(recs, Date.now(), rt.coldPassMs);
      ctx.log.info("subagents", `cold pass done in ${res.durationMs}ms`, {
        files: res.filesSeen,
        read: res.filesRead,
        parents: res.parentsRead,
        mb: Math.round(res.bytesRead / 1e5) / 10,
        total: stats.total,
        today: stats.today,
        live: stats.live,
        parentSessions: stats.parents,
        deepest: stats.deepest,
      });
    }
    publish(ctx, rt, res.activities);
  })();
  rt.running = run;
  try {
    await run;
  } finally {
    rt.running = null;
  }
}

/** Recomputes records (status depends on the clock: running flips to done after 120s of
 *  silence, or to failed after 30 min silent mid-turn) and emits whatever changed, plus fresh
 *  activity and the run endings when they changed. */
function publish(ctx: FeatureContext, rt: Runtime, activities: SubagentActivity[]): void {
  const now = Date.now();
  rt.records = buildRecords(rt.store, now);
  latestRecords = rt.records;
  latestRuns = rt.runs;
  const changed: SubagentRecord[] = [];
  for (const r of rt.records) {
    const fp = fingerprint(r);
    if (rt.sent.get(r.id) !== fp) {
      rt.sent.set(r.id, fp);
      changed.push(r);
    }
  }
  const stats = statsFor(rt.records, now, rt.coldPassMs);
  for (const msg of upsertMessages(changed, stats)) ctx.emit(msg);
  const runsJson = JSON.stringify(rt.runs);
  if (runsJson !== rt.runsSent) {
    rt.runsSent = runsJson;
    const msg: SubagentsMessage = { kind: "runs", endings: rt.runs };
    ctx.emit(msg);
  }
  if (activities.length > 0) {
    const msg: SubagentsMessage = { kind: "activity", items: activities.slice(-MAX_ACTIVITY) };
    ctx.emit(msg);
  }
}

/** Starts the cold pass in the background once; later calls return the same promise. */
function ensureCold(ctx: FeatureContext): Promise<void> {
  const rt = runtime(ctx);
  rt.cold ??= pass(ctx, rt).catch((err: unknown) => {
    ctx.log.error("subagents", "cold pass failed", String(err));
  });
  return rt.cold;
}

export function recentRecords(records: readonly SubagentRecord[], nowMs: number): SubagentRecord[] {
  return records.filter((r) => r.status === "running" || nowMs - Date.parse(r.lastActive) <= RECENT_WINDOW_MS).slice(0, MAX_RECENT);
}

export const subagentsFeature: ServerFeature = {
  id: "subagents",
  tickIntervalMs: 5_000,
  routes: [
    {
      method: "GET",
      path: "/api/subagents",
      async handler(req, res, ctx) {
        await ensureCold(ctx);
        const rt = runtime(ctx);
        const url = new URL(req.url ?? "/", "http://localhost");
        const parent = url.searchParams.get("parent");
        const list = parent ? rt.records.filter((r) => r.parentSessionId === parent) : rt.records.slice(0, MAX_LIST);
        const body: SubagentsResponse = { subagents: list, stats: statsFor(rt.records, Date.now(), rt.coldPassMs) };
        respondJson(res, 200, body);
      },
    },
  ],
  async onTick(ctx) {
    await ensureCold(ctx);
    await pass(ctx, runtime(ctx));
  },
  snapshotExtras(ctx) {
    void ensureCold(ctx);
    const rt = runtime(ctx);
    const now = Date.now();
    return {
      [SUBAGENTS_RECENT_KEY]: recentRecords(rt.records, now),
      [SUBAGENTS_STATS_KEY]: statsFor(rt.records, now, rt.coldPassMs),
      [SUBAGENTS_RUNS_KEY]: rt.runs,
    };
  },
};
