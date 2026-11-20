// "logs": the whole town's log, read-only, for the right sidebar's Logs tab (📜). Taps
// server/log.ts (every line this process logs, including job 2's action-feedback lines — see
// the CONTRACT in shared/features/logs.ts) and feed.ts (feed events, minus "activity"). GET
// /api/logs + batched WS pushes; a persisted NDJSON tail survives a server restart.
//
// The default instance below is built at module load (this file is imported by
// server/features/index.ts, which server/index.ts imports before it logs anything), so its
// server/log.ts tap is live from the very first line the process writes.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogEntry, LogsMessage, LogsResponse } from "../../shared/features/logs.js";
import { respondJson } from "../http.js";
import { onLogLine } from "../log.js";
import { onFeedItems } from "./feed.js";
import { draftFromFeedItem, draftFromLogLine, LogRing, parseLogsQuery, parseNdjson, queryEntries, serializeNdjson } from "./logs-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const CAP = 2000;
const TICK_MS = 500;
const PERSIST_EVERY_MS = 1000;
const PERSIST_MAX_BYTES = 2 * 1024 * 1024;
const WS_BATCH_CAP = 200;

const __dirname = dirname(fileURLToPath(import.meta.url)); // server/features
const REPO_ROOT = join(__dirname, "..", "..");

/** Same resolution as defaultConfig() in server/index.ts: ALEF_DB_PATH, else data/world.db at
 *  the repo root. The log file lives beside it, in the world db's directory. */
function defaultLogFilePath(): string {
  const dbPath = process.env.ALEF_DB_PATH || join(REPO_ROOT, "data", "world.db");
  return join(dirname(dbPath), "town-log.ndjson");
}

export interface LogsFeatureOptions {
  cap?: number;
  /** Overrides the persisted-file path (tests). Omitted + VITEST set: persistence is off, since
   *  other tests import the default feature list and must never touch a real file. */
  filePath?: string;
  now?: () => number;
}

export function createLogsFeature(opts: LogsFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const ring = new LogRing({ cap: opts.cap ?? CAP, now });
  const bootId = randomUUID();
  const filePath = opts.filePath ?? (process.env.VITEST ? null : defaultLogFilePath());
  const pendingWs: LogEntry[] = [];
  const toPersist = new Map<number, LogEntry>();
  let lastPersistAt = 0;

  function queue(entry: LogEntry): void {
    const wsIdx = pendingWs.findIndex((e) => e.seq === entry.seq);
    if (wsIdx >= 0) pendingWs[wsIdx] = entry;
    else pendingWs.push(entry);
    if (filePath) toPersist.set(entry.seq, entry);
  }

  if (filePath) {
    try {
      if (existsSync(filePath)) {
        ring.seed(parseNdjson(readFileSync(filePath, "utf8")).slice(-CAP));
        // seed() renumbers the loaded entries 1..N for THIS boot's ring only — the file on disk
        // still holds their old seqs. Without a rewrite here, this boot's own appends (which
        // continue from N) can collide with those stale seqs once the file has accumulated more
        // than CAP entries across boots, and parseNdjson's dedupe-by-seq would then silently
        // interleave old and new boots on the next load. Compacting right after seeding keeps the
        // file's seqs in lockstep with the ring's, so future appends are always unique.
        writeFileSync(filePath, serializeNdjson(ring.list()), "utf8");
      }
    } catch (err) {
      // fs errors never go through `log` — that would recurse straight back into this tap.
      process.stderr.write(`[logs] failed to load ${filePath}: ${String(err)}\n`);
    }
    const loaded = ring.list().length;
    queue(ring.push({ level: "info", source: "server", scope: "logs", message: `server started · loaded ${loaded} earlier entries`, detail: null, action: null }));
  }

  // Both taps live for the process, same as feed.ts's own appendToFeed/flushInbox pair.
  onLogLine((line) => queue(ring.push(draftFromLogLine(line))));
  onFeedItems((items) => {
    for (const item of items) {
      const draft = draftFromFeedItem(item);
      // item.at is the feed item's own time (a decision's real timestamp, not ingest time) — the
      // feed's first tick on every boot replays up to 50 old decisions, and stamping them "now"
      // made them look brand-new every restart.
      if (draft) queue(ring.push(draft, item.at));
    }
  });

  function persist(): void {
    if (!filePath || toPersist.size === 0) return;
    const batch = [...toPersist.values()];
    toPersist.clear();
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, serializeNdjson(batch), "utf8");
      const size = existsSync(filePath) ? statSync(filePath).size : 0;
      if (size > PERSIST_MAX_BYTES) writeFileSync(filePath, serializeNdjson(ring.list().slice(-CAP)), "utf8");
    } catch (err) {
      process.stderr.write(`[logs] persistence failed: ${String(err)}\n`);
    }
  }

  return {
    id: "logs",
    tickIntervalMs: TICK_MS,
    routes: [
      {
        method: "GET",
        path: "/api/logs",
        handler(req, res) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const parsed = parseLogsQuery(url.searchParams);
          if (!parsed.ok) {
            respondJson(res, 400, { ok: false, error: parsed.error });
            return;
          }
          const entries = queryEntries(ring.list(), parsed.query);
          respondJson(res, 200, { ok: true, bootId, cursor: ring.cursor(), entries } satisfies LogsResponse);
        },
      },
    ],
    onTick(ctx: FeatureContext) {
      if (pendingWs.length > 0) {
        const batch = pendingWs.splice(0, pendingWs.length);
        for (let i = 0; i < batch.length; i += WS_BATCH_CAP) {
          ctx.emit({ kind: "entries", bootId, entries: batch.slice(i, i + WS_BATCH_CAP) } satisfies LogsMessage);
        }
      }
      if (now() - lastPersistAt >= PERSIST_EVERY_MS) {
        lastPersistAt = now();
        persist();
      }
    },
  };
}

export const logsFeature = createLogsFeature();
