// Topic continents (round 11 B): classifies every session into one of the owner's session-groups
// (~/.claude/session-groups/taxonomy.json + assignments.json — READ-ONLY, never written; the
// daemon that used to fill them is disabled for good) and maps every island to a continent.
// Precedence and the catch-all split live in topics-lib.ts. Jev (the shared TypeSafe client)
// sees at most JEV_BATCH still-unplaced sessions per pass in ONE batched Choice call; its answers
// are cached in data/topics.json so a session is only ever asked about once. Archived home/root
// sessions (the archive feature, via topics-link.ts) share that queue and cache: live sessions
// fill a batch first, archived ones fill the rest at most once per ARCHIVE_JEV_GAP_MS, so the
// archive backlog drains over time (ceil(backlog / JEV_BATCH) calls). No key = rules only.
//
// Recompute: at boot, then every tick when the session set, the owner's files or the Jev cache
// changed. A changed map is broadcast; the client lays the planet out once at load, so the new
// map applies on the next reload (the sidebar says so).

import { readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTopicsMap, type TopicsMap, type TopicsMessage } from "../../shared/features/topics.js";
import { callJev, TIMEOUT_MS, type FetchLike } from "../director.js";
import { respondJson } from "../http.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { buildJevBody, buildTopicsMap, isCatchAll, JEV_BATCH, parseAssignments, parseJevAnswers, parseTaxonomy, type SessionInput } from "./topics-lib.js";
import { topicsJevLink, type TopicsJevLink } from "./topics-link.js";

const TICK_MS = 60_000;
/** A failed Jev call is retried no sooner than this. */
const JEV_RETRY_MS = 10 * 60_000;
/** Archived sessions ride along in a Jev batch no more often than this. */
export const ARCHIVE_JEV_GAP_MS = 5 * 60_000;
/** A session unanswered (skipped, or answered outside the taxonomy) this many times settles to
 *  the taxonomy's fallback group and is never asked again — otherwise, since the batch is sorted
 *  by id, the same unanswerable session would sit at the front of every batch forever. */
export const JEV_MAX_ATTEMPTS = 3;
const HEAD_BYTES = 16 * 1024;

export interface TopicsFeatureOptions {
  groupsDir?: string; // defaults to ~/.claude/session-groups
  dataDir?: string; // defaults to the world.db directory
  homeDir?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  link?: TopicsJevLink; // defaults to the server-wide topicsJevLink
  archiveGapMs?: number;
}

interface TopicsFile {
  version: 1;
  jev: Record<string, string>;
  headless: Record<string, boolean>;
  map: TopicsMap | null;
  /** Unanswered-Jev-attempt count per session id; cleared once the session settles (answer or
   *  fallback). Persisted so a restart doesn't reset a session's strike count. */
  attempts: Record<string, number>;
  /** Persisted so a process restart (e.g. `tsx watch`) doesn't lose the back-off and fire an
   *  immediate call. 0 = no back-off pending. */
  jevRetryAt: number;
  archiveJevAt: number;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** True when the session's jsonl says it was a `claude -p` run (entrypoint "sdk-cli"). */
async function readHeadless(file: string): Promise<boolean> {
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, bytesRead).toString("utf8").includes('"entrypoint":"sdk-cli"');
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** The running feature's last computed map (alumni.ts reads it for the Research library), or null
 *  before the first computation. Read-only: the object is the one this feature serves at GET /api/topics. */
let latestMap: TopicsMap | null = null;
export function latestTopicsMap(): TopicsMap | null {
  return latestMap;
}

export function createTopicsFeature(opts: TopicsFeatureOptions = {}): ServerFeature {
  const home = opts.homeDir ?? homedir();
  const groupsDir = opts.groupsDir ?? join(home, ".claude", "session-groups");
  const now = opts.now ?? Date.now;
  const link = opts.link ?? topicsJevLink;
  const archiveGapMs = opts.archiveGapMs ?? ARCHIVE_JEV_GAP_MS;

  let file: TopicsFile = { version: 1, jev: {}, headless: {}, map: null, attempts: {}, jevRetryAt: 0, archiveJevAt: 0 };
  let loaded = false;
  let signature = "";
  let running: Promise<TopicsMap | null> | null = null;

  const dataPath = (ctx: FeatureContext): string => join(opts.dataDir ?? dirname(ctx.config.dbPath), "topics.json");

  /** Sync on purpose: snapshotExtras() is sync and the very first snapshot should already carry
   *  the last persisted map (the client lays the planet out from that snapshot). Small file. */
  function load(ctx: FeatureContext): void {
    if (loaded) return;
    loaded = true;
    let raw: Partial<TopicsFile> | null = null;
    try {
      raw = JSON.parse(readFileSync(dataPath(ctx), "utf8")) as Partial<TopicsFile>;
    } catch {
      /* first run or unreadable cache: start empty */
    }
    if (raw && raw.version === 1) {
      file = {
        version: 1,
        jev: raw.jev ?? {},
        headless: raw.headless ?? {},
        map: isTopicsMap(raw.map) ? raw.map : null,
        attempts: raw.attempts && typeof raw.attempts === "object" ? raw.attempts : {},
        jevRetryAt: typeof raw.jevRetryAt === "number" ? raw.jevRetryAt : 0,
        archiveJevAt: typeof raw.archiveJevAt === "number" ? raw.archiveJevAt : 0,
      };
    }
    link.setJev(new Map(Object.entries(file.jev)));
  }

  async function signatureOf(ctx: FeatureContext): Promise<string> {
    const { agents, islands } = ctx.worldViews();
    const ids = (xs: readonly { id: string }[]): string => xs.map((x) => x.id).sort().join(",");
    return [ids(agents), ids(islands), await mtime(join(groupsDir, "taxonomy.json")), await mtime(join(groupsDir, "assignments.json")), Object.keys(file.jev).length].join("|");
  }

  async function persist(ctx: FeatureContext): Promise<void> {
    const path = dataPath(ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(file), "utf8");
    await rename(`${path}.tmp`, path);
  }

  /** Fills `file.headless` for sessions not seen before (one small read per new session). */
  async function detectHeadless(ctx: FeatureContext, ids: readonly string[]): Promise<boolean> {
    const missing = new Set(ids.filter((id) => !(id in file.headless)));
    if (missing.size === 0) return false;
    let dirs: string[] = [];
    try {
      dirs = await readdir(ctx.config.projectsDir);
    } catch {
      return false;
    }
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = await readdir(join(ctx.config.projectsDir, d));
      } catch {
        continue;
      }
      for (const n of names) {
        const id = n.endsWith(".jsonl") ? n.slice(0, -6) : "";
        if (!missing.has(id)) continue;
        file.headless[id] = await readHeadless(join(ctx.config.projectsDir, d, n));
        missing.delete(id);
      }
    }
    for (const id of missing) file.headless[id] = false; // no jsonl found: treat as interactive
    return true;
  }

  async function recompute(ctx: FeatureContext, force = false): Promise<TopicsMap | null> {
    load(ctx);
    const taxonomyPath = join(groupsDir, "taxonomy.json");
    const assignmentsPath = join(groupsDir, "assignments.json");
    const { agents, islands } = ctx.worldViews();
    const sig = await signatureOf(ctx);
    const headlessChanged = await detectHeadless(ctx, agents.map((a) => a.id));
    const apiKey = opts.apiKey ?? ctx.config.typesafeApiKey ?? process.env.TYPESAFE_API_KEY ?? "";
    const retryDue = file.map !== null && file.map.pendingJev > 0 && apiKey !== "" && now() >= file.jevRetryAt;
    const liveIds = new Set(agents.map((a) => a.id));
    const archived = link.archived.filter((s) => !(s.id in file.jev) && !liveIds.has(s.id));
    const archiveDue = archived.length > 0 && apiKey !== "" && now() >= file.jevRetryAt && now() >= file.archiveJevAt;
    if (!force && sig === signature && !headlessChanged && !retryDue && !archiveDue && file.map) return file.map;

    const taxonomy = parseTaxonomy(await readJson(taxonomyPath));
    const assignments = parseAssignments(await readJson(assignmentsPath));
    const islandInputs = islands.map((i) => ({ id: i.id, path: i.path }));
    const catchAllIds = new Set(islandInputs.filter((i) => isCatchAll(i, home)).map((i) => i.id));
    const sessions: SessionInput[] = agents.map((a) => ({ id: a.id, title: a.title, islandId: a.islandId, catchAll: catchAllIds.has(a.islandId), headless: file.headless[a.id] === true }));
    const jevCache = new Map(Object.entries(file.jev));

    let jevStatus: TopicsMap["jev"] = apiKey ? "online" : "disabled";
    let { map, needJev } = buildTopicsMap({ taxonomy, islands: islandInputs, sessions, assignments, jev: jevCache, homeDir: home, jevStatus, now: now() });

    const batch = [...needJev].sort((a, b) => a.id.localeCompare(b.id)).slice(0, JEV_BATCH);
    const room = JEV_BATCH - batch.length;
    if (room > 0 && archived.length > 0 && apiKey && now() >= file.jevRetryAt && now() >= file.archiveJevAt) {
      batch.push(...[...archived].sort((a, b) => a.id.localeCompare(b.id)).slice(0, room));
      file.archiveJevAt = now() + archiveGapMs;
    }
    if (batch.length > 0 && apiKey && now() >= file.jevRetryAt) {
      try {
        const { body, keys } = buildJevBody(batch, taxonomy);
        const raw = await callJev(apiKey, body, opts.fetchImpl ?? (globalThis.fetch as FetchLike), opts.timeoutMs ?? TIMEOUT_MS * 3);
        const answers = parseJevAnswers(raw, keys, taxonomy);
        for (const [id, g] of answers) {
          jevCache.set(id, g);
          delete file.attempts[id];
        }
        // Jev skipped it, or answered outside the taxonomy (parseJevAnswers already dropped that):
        // either way this session got no usable answer this round. Since the batch is sorted by
        // id, an unanswerable session would otherwise sit at the front of every batch forever.
        let settled = 0;
        for (const s of batch) {
          if (answers.has(s.id)) continue;
          const attempts = (file.attempts[s.id] ?? 0) + 1;
          if (attempts >= JEV_MAX_ATTEMPTS) {
            jevCache.set(s.id, taxonomy.fallback);
            delete file.attempts[s.id];
            settled++;
          } else {
            file.attempts[s.id] = attempts;
          }
        }
        file.jev = Object.fromEntries(jevCache);
        if (answers.size > 0 || settled > 0) link.setJev(jevCache);
        ctx.log.info("topics", `jev placed ${answers.size}/${batch.length} sessions`);
        if (settled > 0) ctx.log.info("topics", `jev gave up on ${settled} session(s) after ${JEV_MAX_ATTEMPTS} attempts; settled ${taxonomy.fallback}`);
        if (answers.size === 0) file.jevRetryAt = now() + JEV_RETRY_MS;
      } catch (err) {
        jevStatus = "fallback";
        file.jevRetryAt = now() + JEV_RETRY_MS;
        ctx.log.warn("topics", "jev classify failed, keeping fallback group", String(err));
      }
      ({ map, needJev } = buildTopicsMap({ taxonomy, islands: islandInputs, sessions, assignments, jev: jevCache, homeDir: home, jevStatus, now: now() }));
    }

    const changed = JSON.stringify({ ...file.map, generatedAt: "" }) !== JSON.stringify({ ...map, generatedAt: "" });
    file.map = map;
    latestMap = map;
    signature = await signatureOf(ctx);
    await persist(ctx);
    if (changed) ctx.emit({ kind: "map", map } satisfies TopicsMessage);
    return map;
  }

  function refresh(ctx: FeatureContext, force = false): Promise<TopicsMap | null> {
    if (running) return running;
    running = recompute(ctx, force)
      .catch((err: unknown) => {
        ctx.log.error("topics", "recompute failed", String(err));
        return file.map;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    id: "topics",
    tickIntervalMs: TICK_MS,
    async onTick(ctx) {
      await refresh(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/topics",
        async handler(_req, res, ctx) {
          const map = await refresh(ctx);
          if (!map) return respondJson(res, 503, { ok: false, error: "topics not computed yet" });
          respondJson(res, 200, map);
        },
      },
    ],
    snapshotExtras(ctx) {
      load(ctx);
      if (!file.map) {
        void refresh(ctx); // first snapshot after boot: fills in for the next one
        return {};
      }
      return { "topics.map": file.map };
    },
  };
}

export const topicsFeature = createTopicsFeature();
