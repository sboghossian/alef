// "workspace": the Town square's global workspace, computed on the SERVER (vision wave 3,
// gwt-broadcast). Until now only the client scored it, so the broadcast step that defines a global
// workspace never happened: neither Jev nor the resident ever saw the top 5. Every minute this
// feature reads the server's own sources, runs the shared scorer (shared/workspace/scorer.ts,
// the client's code) with its own hysteresis state, and publishes the top 5 (workspace-state.ts),
// where the president puts it in Jev's ranking state and the resident in its reflection prompt,
// both fenced as untrusted data. No model call happens here, and none is added anywhere.
//
// Sources (read-only): the feed ring (tapped with onFeedItems), sessions waiting on Alex,
// village messages, subagent records and run endings, talk's stranded launches, the Health
// checks, Jev's board, the resident's state, tripwire hits and open sickness cases.
//
// Influence: the president and the resident report what they were shown per proposal / journal
// entry (workspace-state.ts noteInfluence); each note becomes one record, appended to
// data/workspace-influence.jsonl (compacted to the newest INFLUENCE_KEEP records past
// INFLUENCE_MAX_BYTES), loaded back on boot, and summed at GET /api/workspace/influence.
//
//   GET /api/workspace            -> WorkspaceResponse
//   GET /api/workspace/influence  -> InfluenceResponse

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FeedItem as ServerFeedItem } from "../../shared/features/feed.js";
import type { PresidentBoard } from "../../shared/features/president.js";
import type { ResidentState } from "../../shared/features/resident.js";
import type { SicknessCase } from "../../shared/features/sickness.js";
import type { RunEnding, SubagentRecord } from "../../shared/features/subagents.js";
import type { StrandedDispatch } from "../../shared/features/talk.js";
import type { TripwireHit } from "../../shared/features/tripwires.js";
import type { VillageMessage } from "../../shared/features/village.js";
import type { InfluenceRecord, InfluenceResponse, WorkspaceResponse, WorkspaceSourceCounts } from "../../shared/features/workspace.js";
import { agentLookup, EMPTY_WORKSPACE, WORKSPACE, type HealthSummary, type WorkspaceResult, type WorkspaceSlot } from "../../shared/workspace/scorer.js";
import { respondJson } from "../http.js";
import { currentHealthChecks } from "./completeness.js";
import { onFeedItems } from "./feed.js";
import { currentPresidentBoard } from "./president.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { currentResidentState } from "./resident.js";
import { openSicknessCases } from "./sickness.js";
import { latestRunEndings, latestSubagentRecords, recentRecords } from "./subagents/index.js";
import { currentStranded } from "./talk.js";
import { recentTripwireHits } from "./tripwires.js";
import { recentVillageMessages } from "./village.js";
import { computeWorkspace, INFLUENCE_METHOD, influenceRecord, influenceWindow, parseInfluenceLines, recordedRecently, serverWorkspaceSources } from "./workspace-lib.js";
import { publishWorkspace, subscribeInfluence, type InfluenceNote } from "./workspace-state.js";

export const WORKSPACE_TICK_MS = 60_000;
export const INFLUENCE_FILE = "workspace-influence.jsonl";
export const INFLUENCE_KEEP = 5000;
export const INFLUENCE_MAX_BYTES = 2 * 1024 * 1024;
const RING_CAP = 5000;
const RECENT_RECORDS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** The server-side sources, read at tick time. Each defaults to the running feature's own state. */
export interface WorkspaceReaders {
  ring(): readonly ServerFeedItem[];
  messages(): readonly VillageMessage[];
  subagents(nowMs: number): readonly SubagentRecord[];
  runEndings(): readonly RunEnding[];
  resident(): ResidentState | null;
  stranded(): readonly StrandedDispatch[];
  health(): HealthSummary | null;
  presidentBoard(): PresidentBoard | null;
  tripwireHits(): readonly TripwireHit[];
  sickness(): readonly SicknessCase[];
}

export interface WorkspaceFeatureOptions {
  now?: () => number;
  tickIntervalMs?: number;
  /** Defaults to dirname(config.dbPath) (the repo's data/). */
  dataDir?: string;
  /** Test seams; production reads the running features. Passing `ring` skips the feed tap. */
  readers?: Partial<WorkspaceReaders>;
  /** Where influence notes come from; defaults to workspace-state.ts's subscribeInfluence. */
  subscribe?: (fn: (n: InfluenceNote) => void) => void;
  /** Where the top 5 goes; defaults to workspace-state.ts's publishWorkspace. */
  publish?: typeof publishWorkspace;
  /** Compaction: past `influenceMaxBytes` the log is rewritten to its newest `influenceKeep` records. */
  influenceKeep?: number;
  influenceMaxBytes?: number;
}

export function createWorkspaceFeature(opts: WorkspaceFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const publish = opts.publish ?? publishWorkspace;
  const subscribe = opts.subscribe ?? subscribeInfluence;
  const keep = opts.influenceKeep ?? INFLUENCE_KEEP;
  const maxBytes = opts.influenceMaxBytes ?? INFLUENCE_MAX_BYTES;

  // The feed ring, as this feature saw it: the items of the last window (plus a margin), capped.
  // The tap starts empty with the process: `ringSince` says from when the window is covered.
  const ring: ServerFeedItem[] = [];
  const ringSince = opts.readers?.ring ? null : new Date(now()).toISOString();
  if (!opts.readers?.ring) {
    onFeedItems((items) => {
      ring.push(...items);
      if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    });
  }
  const readers: WorkspaceReaders = {
    ring: () => ring,
    messages: recentVillageMessages,
    subagents: (nowMs) => recentRecords(latestSubagentRecords() ?? [], nowMs),
    runEndings: latestRunEndings,
    resident: currentResidentState,
    stranded: currentStranded,
    health: currentHealthChecks,
    presidentBoard: currentPresidentBoard,
    tripwireHits: recentTripwireHits,
    sickness: openSicknessCases,
    ...opts.readers,
  };

  let slot: WorkspaceSlot = {};
  let result: WorkspaceResult = EMPTY_WORKSPACE;
  let computedAt: number | null = null;
  let sourceCounts: WorkspaceSourceCounts | null = null;

  let records: InfluenceRecord[] = [];
  let loaded: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  function influencePath(ctx: FeatureContext): string {
    return join(opts.dataDir ?? dirname(ctx.config.dbPath), INFLUENCE_FILE);
  }

  /** Loads the records an earlier process kept, then starts taking notes (held ones first). */
  function ensureLoaded(ctx: FeatureContext): Promise<void> {
    loaded ??= (async () => {
      try {
        records = parseInfluenceLines(await readFile(influencePath(ctx), "utf8")).slice(-keep);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") ctx.log.warn("workspace", "influence log unreadable, starting empty", String(err));
      }
      subscribe((n) => record(ctx, n));
    })();
    return loaded;
  }

  /** One note -> one record, appended; one write at a time. A failed append keeps the record in
   *  memory (the share stays right until a restart) and says so in the log. Compaction rewrites
   *  the records up to this one (later ones append themselves next) through a tmp file + rename,
   *  so a crash mid-rewrite leaves the old file whole. */
  function record(ctx: FeatureContext, n: InfluenceNote): void {
    // Called synchronously from the president's refresh and the resident's reflection: a throw
    // here must never break the caller, only cost this one record (and say so).
    let r: InfluenceRecord;
    try {
      if (n.source === "jev" && recordedRecently(records, n.proposal.id, n.at)) return;
      const openCases = new Map(readers.sickness().map((c) => [c.id, c.sessionId] as const));
      r = influenceRecord(n, (id) => openCases.get(id));
    } catch (err) {
      ctx.log.warn("workspace", "influence note dropped", String(err));
      return;
    }
    records.push(r);
    if (records.length > keep) records.splice(0, records.length - keep);
    const path = influencePath(ctx);
    writes = writes
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(r)}\n`, "utf8");
        if ((await stat(path)).size <= maxBytes) return;
        const upTo = records.indexOf(r);
        const tmp = `${path}.tmp`;
        await writeFile(tmp, (upTo >= 0 ? records.slice(0, upTo + 1) : records).map((x) => `${JSON.stringify(x)}\n`).join(""), "utf8");
        await rename(tmp, path);
      })
      .catch((err: unknown) => ctx.log.warn("workspace", "influence record not persisted", String(err)));
  }

  function tick(ctx: FeatureContext): void {
    const nowMs = now();
    const from = nowMs - WORKSPACE.windowMs;
    if (!opts.readers?.ring) {
      const inWindow = ring.filter((i) => Date.parse(i.at) >= from);
      ring.splice(0, ring.length, ...inWindow);
    }
    const { agents, islands } = ctx.worldViews();
    const byId = new Map(agents.map((a) => [a.id, a] as const));
    const { sources, counts } = serverWorkspaceSources(
      {
        ring: readers.ring(),
        agents,
        islands,
        messages: readers.messages(),
        subagents: readers.subagents(nowMs),
        runEndings: readers.runEndings(),
        resident: readers.resident(),
        stranded: readers.stranded(),
        health: readers.health(),
        presidentBoard: readers.presidentBoard(),
        tripwireHits: readers.tripwireHits(),
        sickness: readers.sickness(),
      },
      nowMs,
    );
    result = computeWorkspace(sources, agentLookup(() => byId), slot, nowMs);
    slot = result.slot;
    computedAt = nowMs;
    sourceCounts = counts;
    publish({ computedAt: nowMs, top: result.top });
  }

  return {
    id: "workspace",
    tickIntervalMs: opts.tickIntervalMs ?? WORKSPACE_TICK_MS,
    async onTick(ctx) {
      await ensureLoaded(ctx);
      tick(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/workspace",
        handler(_req, res) {
          respondJson(res, 200, {
            ok: true,
            computedAt: computedAt === null ? null : new Date(computedAt).toISOString(),
            top: result.top,
            counts: result.counts,
            sources: sourceCounts,
            ringSince,
          } satisfies WorkspaceResponse);
        },
      },
      {
        method: "GET",
        path: "/api/workspace/influence",
        async handler(_req, res, ctx) {
          await ensureLoaded(ctx);
          const nowMs = now();
          const last24h = records.filter((r) => nowMs - Date.parse(r.at) <= DAY_MS);
          respondJson(res, 200, {
            ok: true,
            label: "computed",
            method: INFLUENCE_METHOD,
            since: records[0]?.at ?? null,
            last24h: influenceWindow(last24h),
            all: influenceWindow(records),
            recent: records.slice(-RECENT_RECORDS).reverse(),
          } satisfies InfluenceResponse);
        },
      },
    ],
  };
}

export const workspaceFeature = createWorkspaceFeature();
