// HTTP + WS entry point. Wires the indexer (every 10s), the harness scan,
// live-detection, and the Jev director (every 60s) together, and serves the
// contract in shared/types.ts on :5179.
// Hub file: new features go in server/features/<id>.ts, not here (docs/FEATURES.md).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { describeAction, shouldLogRequest } from "./action-log.js";
import { checkRequest } from "./guard.js";
import type {
  AgentActivity,
  Island,
  JevState,
  ServerMessage,
  WorldAgent,
  WorldEdge,
  WorldObject,
  WorldSnapshot,
  WorldStats,
} from "../shared/types.js";
import type { HostLoad } from "../shared/features/completeness.js";
import { openDb, WorldDb, type ObjectWithUsage } from "./db.js";
import { runDirectorTick, type AgentSnapshot, type FetchLike } from "./director.js";
import { serverFeatures } from "./features/index.js";
import { ServerFeatureRegistry, type ServerFeature } from "./features/registry.js";
import { loadTalkBindings } from "./features/talk.js";
import { discoverHarness } from "./harness.js";
import {
  deriveRole,
  discountUnstartedDispatches,
  isAwaitingInput,
  isLive,
  localDateKey,
  processVouchedSessions,
  sanitizeTitle,
  ROLE_COLORS,
  type Role,
} from "./heuristics.js";
import { runCanonicalRepoBackfill } from "./canonical-backfill.js";
import { runCcTitlesBackfill } from "./cc-titles-backfill.js";
import { ccDisplayName } from "./cc-titles-lib.js";
import { runHomePlacementBackfill } from "./home-placement.js";
import { runPruneDistricts } from "./prune-districts.js";
import { respondJson, responseOutcome } from "./http.js";
import { runIndexPass } from "./indexer.js";
import { deltaMessages, diffWorld, emptyBaseline, SnapshotLedger } from "./world-delta.js";
import { probeLiveClaudeCwds } from "./live.js";
import { createLiveDetector, type LiveStatus } from "./live-cache.js";
import { startLoopLagMonitor } from "./loop-lag.js";
import { describeAttempts, loadTypesafeKeyAtBoot } from "./jev-key.js";
import { log } from "./log.js";
import {
  openTerminalDispatchExecutor,
  openTerminalExecutor,
  openVsCodeExecutor,
  type DispatchExecutor,
  type OpenEditorExecutor,
  type ReactivateExecutor,
} from "./reactivate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 5179;
const INDEX_INTERVAL_MS = 10_000;
const DIRECTOR_INTERVAL_MS = 60_000;
const FILE_OBJECTS_PER_ISLAND_CAP = 30;
const ACTIVITY_BUFFER_CAP = 200;
const ACTIVITY_BATCH_CAP = 50;
/** Boot waits at most this long for the first ps/lsof probe, then listens with whatever it has. */
const FIRST_LIVE_PROBE_WAIT_MS = 6_000;

export interface ServerConfig {
  projectsDir: string;
  claudeDir: string;
  claudeJsonPath: string;
  dbPath: string;
  port: number;
  /** Plain-Terminal launchers: the talk feature's fallback for /api/reactivate and /api/dispatch
   *  when tmux is missing. Every other launch runs in a world tmux session (features/talk.ts). */
  reactivateExecutor: ReactivateExecutor;
  dispatchExecutor: DispatchExecutor;
  openEditorExecutor: OpenEditorExecutor;
  /** Test-only escape hatches for the director/ask-jev TypeSafe calls. Left undefined in
   *  defaultConfig() so production keeps reading TYPESAFE_API_KEY from the environment;
   *  tests set an explicit "" + a fake fetchImpl so a real key on the host is never used. */
  typesafeApiKey?: string;
  typesafeFetchImpl?: FetchLike;
  /** Running-claude detector (ps + lsof). Tests inject a stub: the real scan is slow and reads the host. */
  liveDetector?: () => Map<string, number>;
  /** Interface to bind. Defaults to loopback: the API can open Terminal, never expose it to the LAN. */
  host?: string;
  /** Enabled feature plugins. Defaults to server/features/index.ts; tests pass their own. */
  features?: readonly ServerFeature[];
  /** Index pass period. Defaults to INDEX_INTERVAL_MS; tests shorten it. */
  indexIntervalMs?: number;
}

export function defaultConfig(): ServerConfig {
  const home = homedir();
  return {
    projectsDir: join(home, ".claude", "projects"),
    claudeDir: join(home, ".claude"),
    claudeJsonPath: join(home, ".claude.json"),
    // ALEF_PORT / ALEF_DB_PATH let a second copy run beside the real one (e.g. a worktree test).
    dbPath: process.env.ALEF_DB_PATH || join(__dirname, "..", "data", "world.db"),
    port: Number(process.env.ALEF_PORT) || DEFAULT_PORT,
    reactivateExecutor: openTerminalExecutor,
    dispatchExecutor: openTerminalDispatchExecutor,
    openEditorExecutor: openVsCodeExecutor,
  };
}

// ── World views (shared by HTTP snapshot, WS broadcasts, and the director) ──

interface AgentComputed {
  id: string;
  islandId: string;
  cwd: string;
  title: string;
  displayName: string | null;
  status: "live" | "dormant";
  startedAt: string;
  lastActive: string;
  messageCount: number;
  model: string | null;
  role: Role;
  targetIslandId: string;
  tokens: number;
  awaitingInput: boolean;
}

function computeAgents(db: WorldDb, liveCwds: ReadonlyMap<string, number>, now: Date): AgentComputed[] {
  const sessions = db.listSessions();
  // Only vouching sees the discounted map: cleanup, fork and worktree guards keep the raw one.
  const vouched = processVouchedSessions(sessions, discountUnstartedDispatches(liveCwds, loadTalkBindings(db), sessions).live);
  return sessions.map((s) => {
    const status: "live" | "dormant" = isLive(now.getTime(), s.jsonlMtime, vouched.has(s.id)) ? "live" : "dormant";
    const title = sanitizeTitle(s.title);
    return {
      id: s.id,
      islandId: s.islandId,
      cwd: s.cwd,
      title,
      displayName: ccDisplayName(s, title),
      status,
      startedAt: s.startedAt,
      lastActive: s.lastActive,
      messageCount: s.messageCount,
      model: s.model,
      role: deriveRole(s),
      targetIslandId: s.targetIslandId,
      tokens: s.tokens,
      awaitingInput: isAwaitingInput(status, {
        kind: s.lastLineKind,
        toolName: s.lastToolName,
        textIsQuestion: s.lastTextIsQuestion,
      }),
    };
  });
}

function capObjects(all: ObjectWithUsage[]): ObjectWithUsage[] {
  const byIslandFiles = new Map<string, ObjectWithUsage[]>();
  const rest: ObjectWithUsage[] = [];
  for (const o of all) {
    if (o.kind === "file") {
      const arr = byIslandFiles.get(o.islandId) ?? [];
      arr.push(o);
      byIslandFiles.set(o.islandId, arr);
    } else {
      rest.push(o);
    }
  }
  const files: ObjectWithUsage[] = [];
  for (const arr of byIslandFiles.values()) {
    arr.sort((a, b) => b.usage - a.usage);
    files.push(...arr.slice(0, FILE_OBJECTS_PER_ISLAND_CAP));
  }
  return [...files, ...rest];
}

interface WorldViews {
  agents: WorldAgent[];
  objects: WorldObject[];
  edges: WorldEdge[];
  islands: Island[];
  agentSnapshots: AgentSnapshot[];
}

export function buildWorldViews(db: WorldDb, liveCwds: ReadonlyMap<string, number>, now: Date): WorldViews {
  const computed = computeAgents(db, liveCwds, now);

  const agents: WorldAgent[] = computed.map((a) => ({
    id: a.id,
    islandId: a.islandId,
    cwd: a.cwd,
    title: a.title,
    displayName: a.displayName,
    status: a.status,
    startedAt: a.startedAt,
    lastActive: a.lastActive,
    messageCount: a.messageCount,
    model: a.model,
    role: a.role,
    color: ROLE_COLORS[a.role],
    targetIslandId: a.targetIslandId,
    tokens: a.tokens,
    awaitingInput: a.awaitingInput,
  }));
  const agentSnapshots: AgentSnapshot[] = computed.map((a) => ({
    id: a.id,
    islandId: a.islandId,
    title: a.title,
    role: a.role,
    status: a.status,
    lastActive: a.lastActive,
  }));

  const capped = capObjects(db.listObjectsWithUsage());
  const objects: WorldObject[] = capped.map((o) => ({
    id: o.id,
    kind: o.kind,
    name: o.name,
    islandId: o.islandId,
    usage: o.usage,
    growth: o.growth,
  }));

  const includedIds = new Set<string>([...agents.map((a) => a.id), ...objects.map((o) => o.id)]);
  // The islands this snapshot serves: harness plus every island an agent or object lives on.
  const islandIds = new Set<string>(["harness", ...computed.map((a) => a.islandId), ...capped.map((o) => o.islandId)]);
  // A `visited` edge is session -> island (trips-lib.ts). It is served when that island is, so the client can draw its road.
  const edges: WorldEdge[] = db
    .listEdges()
    .filter((e) => includedIds.has(e.from) && (includedIds.has(e.to) || (e.kind === "visited" && islandIds.has(e.to))))
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, at: e.at }));

  // An island's path/name come from its own cwd_islands assignment — NOT from "whichever agent
  // happens to be first below" — because a catch-all session (home-placement.ts) keeps its own
  // (home dir) cwd while its island is some repo's, so it must never be mistaken for that
  // repo's canonical cwd.
  const islandMeta = new Map<string, { path: string; name: string }>();
  islandMeta.set("harness", { path: "", name: "Harness" });
  for (const id of islandIds) {
    if (islandMeta.has(id)) continue;
    const path = db.getIslandCwd(id) ?? "";
    const base = path.split("/").filter(Boolean).pop();
    islandMeta.set(id, { path, name: base ?? id });
  }
  const islandAgentCount = new Map<string, number>();
  const islandLastActive = new Map<string, string>();
  for (const a of computed) {
    islandAgentCount.set(a.islandId, (islandAgentCount.get(a.islandId) ?? 0) + 1);
    const cur = islandLastActive.get(a.islandId);
    if (!cur || a.lastActive > cur) islandLastActive.set(a.islandId, a.lastActive);
  }
  const islands: Island[] = [...islandMeta.entries()].map(([id, meta]) => ({
    id,
    name: meta.name,
    path: meta.path,
    agentCount: islandAgentCount.get(id) ?? 0,
    lastActive: islandLastActive.get(id) ?? new Date(0).toISOString(),
  }));

  return { agents, objects, edges, islands, agentSnapshots };
}

function buildStats(db: WorldDb, agents: readonly WorldAgent[], now: Date): WorldStats {
  return {
    liveCount: agents.filter((a) => a.status === "live").length,
    awaitingCount: agents.filter((a) => a.awaitingInput).length,
    tokensToday: db.getDayTokens(localDateKey(now)),
  };
}

function buildSnapshot(
  db: WorldDb,
  views: WorldViews,
  now: Date,
  extras: Record<string, unknown> | undefined,
  featureIslands: (taken: ReadonlySet<string>) => Island[] = () => [],
): WorldSnapshot {
  const islands = [...views.islands, ...featureIslands(new Set(views.islands.map((i) => i.id)))];
  const jev: JevState = {
    status: (db.getMeta("jev_status") as JevState["status"] | null) ?? "disabled",
    lastTickAt: db.getMeta("jev_last_tick_at"),
    decisions: db.listDecisions(50),
  };
  return {
    generatedAt: now.toISOString(),
    stats: buildStats(db, views.agents, now),
    islands,
    agents: views.agents,
    objects: views.objects,
    edges: views.edges,
    jev,
    ...(extras ? { extras } : {}),
  };
}

async function syncHarnessObjects(db: WorldDb, config: ServerConfig): Promise<void> {
  const objs = await discoverHarness({ claudeDir: config.claudeDir, claudeJsonPath: config.claudeJsonPath });
  for (const o of objs) db.upsertObjectShell({ id: o.id, kind: o.kind, name: o.name, islandId: "harness" });
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

/** Logs a non-GET request exactly once, after its response finished (status 0 when the client
 *  hung up first). Installed before the guard, so refused requests are logged too. */
function logActionWhenDone(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  if (!shouldLogRequest(method)) return;
  const t0 = Date.now();
  let logged = false;
  const done = (status: number): void => {
    if (logged) return;
    logged = true;
    const line = describeAction({ method, path: req.url ?? "/", status, outcome: responseOutcome(res), durationMs: Date.now() - t0 });
    log[line.level]("action", line.message, line.fields);
  };
  res.once("finish", () => done(res.statusCode));
  res.once("close", () => done(res.writableFinished ? res.statusCode : 0));
}

function fetchSiteOf(req: IncomingMessage): string | undefined {
  const v = req.headers["sec-fetch-site"];
  return Array.isArray(v) ? v[0] : v;
}

function broadcast(wss: WebSocketServer, msg: ServerMessage, except?: WebSocket): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

/** The `have` a /ws URL carries (net.ts: the generatedAt of the GET /api/world the tab just loaded). */
function haveOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get("have");
  } catch {
    return null;
  }
}

export interface RunningServer {
  close: () => Promise<void>;
  db: WorldDb;
  port: number;
}

export async function startServer(config: ServerConfig = defaultConfig()): Promise<RunningServer> {
  // Live detection off the event loop: one async probe at a time, readers get the latest map.
  // Tests inject a sync stub (config.liveDetector) and then the probe is never run.
  const liveCache = config.liveDetector ? null : createLiveDetector({ probe: probeLiveClaudeCwds });
  const injectedDetector = config.liveDetector;
  const detectLive: () => Map<string, number> = injectedDetector ?? (() => liveCache?.current() ?? new Map());
  const liveStatus = (): LiveStatus =>
    liveCache?.status() ?? { ok: true, at: Date.now(), durationMs: 0, lastGoodAt: Date.now(), error: null };
  const firstProbe = liveCache ? liveCache.refresh() : Promise.resolve();
  const loopLag = startLoopLagMonitor({ log });
  const db = new WorldDb(openDb(config.dbPath));

  const t0 = Date.now();
  const firstPass = await runIndexPass(db, { projectsDir: config.projectsDir });
  await syncHarnessObjects(db, config);
  const { linesBySession: _unused, ...firstPassStats } = firstPass;
  log.info("indexer", `initial pass done in ${Date.now() - t0}ms`, firstPassStats);
  // One-time catch-up for sessions indexed before home-placement.ts existed — see its own doc
  // comment. A no-op after the first successful run.
  await runHomePlacementBackfill(db, homedir());
  // Same pattern for districts-by-canonical-repo (canonical-backfill.ts): worktrees and
  // subfolders indexed before it existed move onto their repo's island, once.
  // Never let a one-time migration stop the world from booting.
  await runCanonicalRepoBackfill(db, homedir()).catch((err: unknown) => log.warn("canonical", `backfill failed; the world boots without it: ${String(err)}`));
  // Empty districts (prune-districts.ts): after the canonical backfill, whose rules it reuses.
  await runPruneDistricts(db, homedir()).catch((err: unknown) => log.warn("prune-districts", `prune failed; the world boots without it: ${String(err)}`));
  // Claude Code's own titles (cc-titles-backfill.ts) for sessions indexed before they were read.
  // Runs before the incremental index timer starts, so no pass races it.
  await runCcTitlesBackfill(db).catch((err: unknown) => log.warn("cc-titles", `backfill failed; the world boots without it: ${String(err)}`));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    logActionWhenDone(req, res);
    const rejection = checkRequest({
      method: req.method ?? "GET",
      host: req.headers.host,
      origin: req.headers.origin,
      contentType: req.headers["content-type"],
      fetchSite: fetchSiteOf(req),
    });
    if (rejection) {
      respondJson(res, rejection.status, { ok: false, error: rejection.error });
      return;
    }
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/api/world") {
          const snapshot = snapshotNow(buildWorldViews(db, detectLive(), new Date()));
          ledger.remember(snapshot);
          respondJson(res, 200, snapshot);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/health") {
          respondJson(res, 200, {
            ok: true,
            indexedSessions: db.countSessions(),
            eventLoop: loopLag.snapshot(),
            live: liveStatus(),
            host: { load1: Math.round((loadavg()[0] ?? 0) * 10) / 10, cpus: cpus().length } satisfies HostLoad,
            features: features.health(),
          });
          return;
        }
        // POST /api/dispatch and /api/reactivate/:agentId are served by the talk feature (it owns
        // the world tmux sessions they start); config's executors are its no-tmux fallback.
        if (await features.handle(req, res, url.pathname)) return;
        respondJson(res, 404, { ok: false, error: "not found" });
      } catch (err) {
        log.error("http", "unhandled request error", String(err));
        if (!res.headersSent) respondJson(res, 500, { ok: false, error: "internal error" });
        else res.end();
      }
    })();
  });

  // One upgrade router for every WebSocket path: the hub's /ws plus feature endpoints
  // (e.g. /ws/term/:agentId). Several `ws` servers bound to one http server abort each
  // other's paths with 400, so all of them run in noServer mode behind the same guard.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const rejection = checkRequest({ method: "GET", host: req.headers.host, origin: req.headers.origin, contentType: undefined, fetchSite: fetchSiteOf(req) });
    if (rejection) {
      socket.end(`HTTP/1.1 ${rejection.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (features.handleUpgrade(req, socket, head, pathname)) return;
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const features = new ServerFeatureRegistry(config.features ?? serverFeatures, {
    db,
    config,
    log,
    detectLive,
    liveStatus,
    executors: { reactivate: config.reactivateExecutor, dispatch: config.dispatchExecutor, openEditor: config.openEditorExecutor },
    broadcast: (msg) => broadcast(wss, msg),
    worldViews: () => buildWorldViews(db, detectLive(), new Date()),
  });
  const snapshotNow = (views: WorldViews): WorldSnapshot =>
    buildSnapshot(db, views, new Date(), features.snapshotExtras(), (taken) => features.snapshotIslands(taken));
  const ledger = new SnapshotLedger();

  // What every open client was last sent of the world rows (world-delta.ts): each push sends only
  // what differs from it, and nothing when nothing does.
  let sent = emptyBaseline();
  let sentStats: string | null = null;
  const pushWorld = (views: WorldViews, except?: WebSocket): void => {
    const { delta, next } = diffWorld(sent, views);
    sent = next;
    for (const msg of deltaMessages(delta)) broadcast(wss, msg, except);
  };
  const pushStats = (stats: WorldStats, except?: WebSocket): void => {
    const json = JSON.stringify(stats);
    if (json === sentStats) return;
    sentStats = json;
    broadcast(wss, { type: "stats", stats }, except);
  };

  wss.on("connection", (ws, req) => {
    const views = buildWorldViews(db, detectLive(), new Date());
    const snapshot = snapshotNow(views);
    const have = haveOf(req);
    const caughtUp = have ? ledger.catchUp(have, snapshot) : null;
    if (caughtUp) {
      // The tab already holds the snapshot its GET /api/world got: send only what changed since.
      for (const msg of deltaMessages(caughtUp)) ws.send(JSON.stringify(msg));
      ws.send(JSON.stringify({ type: "stats", stats: snapshot.stats } satisfies ServerMessage));
    } else {
      ws.send(JSON.stringify({ type: "snapshot", world: snapshot } satisfies ServerMessage));
    }
    // This tab now holds `views`: bring every other tab to the same rows so one baseline fits all.
    pushWorld(views, ws);
    pushStats(snapshot.stats, ws);
  });

  const activityBuffer: AgentActivity[] = [];

  let indexing = false;
  const indexTimer = setInterval(() => {
    if (indexing) return;
    indexing = true;
    void (async () => {
      try {
        const stats = await runIndexPass(db, {
          projectsDir: config.projectsDir,
          collectActivity: true,
          collectLines: features.wantsIndexLines(),
        });
        await syncHarnessObjects(db, config);
        const { linesBySession, ...passStats } = stats;
        log.info("indexer", "incremental pass", { ...passStats, activities: stats.activities.length });
        const liveCwds = detectLive();
        const views = buildWorldViews(db, liveCwds, new Date());
        pushWorld(views);

        if (stats.activities.length > 0) {
          activityBuffer.push(...stats.activities);
          if (activityBuffer.length > ACTIVITY_BUFFER_CAP) {
            activityBuffer.splice(0, activityBuffer.length - ACTIVITY_BUFFER_CAP);
          }
          for (let i = 0; i < stats.activities.length; i += ACTIVITY_BATCH_CAP) {
            broadcast(wss, { type: "activity", activities: stats.activities.slice(i, i + ACTIVITY_BATCH_CAP) });
          }
        }
        pushStats(buildStats(db, views.agents, new Date()));
        await features.indexPass(linesBySession);
      } catch (err) {
        log.error("indexer", "incremental pass failed", String(err));
      } finally {
        indexing = false;
      }
    })();
  }, config.indexIntervalMs ?? INDEX_INTERVAL_MS);

  let ticking = false;
  const directorTick = (): void => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        const liveCwds = detectLive();
        const { agentSnapshots } = buildWorldViews(db, liveCwds, new Date());
        const result = await runDirectorTick(db, agentSnapshots, {
          apiKey: config.typesafeApiKey,
          fetchImpl: config.typesafeFetchImpl,
        });
        db.setMeta("jev_status", result.status);
        db.setMeta("jev_last_tick_at", new Date().toISOString());
        log.info("director", `tick: status=${result.status} decisions=${result.decisions.length}`);
        for (const decision of result.decisions) {
          broadcast(wss, { type: "decision", decision, jevStatus: result.status });
        }
        if (result.decisions.length > 0) pushWorld(buildWorldViews(db, detectLive(), new Date()));
      } catch (err) {
        log.error("director", "tick failed", String(err));
      } finally {
        ticking = false;
      }
    })();
  };
  directorTick(); // first tick at boot, so Jev's status is real from the start
  const directorTimer = setInterval(directorTick, DIRECTOR_INTERVAL_MS);
  // Before listen: a tab reconnecting after a restart gets a first snapshot that already holds what
  // features restore from disk (e.g. the tripwire hit log), since a snapshot replaces its state.
  await features.start();
  features.startTicks();
  await Promise.race([firstProbe, new Promise<void>((r) => setTimeout(r, FIRST_LIVE_PROBE_WAIT_MS).unref())]);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(config.port, config.host ?? "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  log.info("server", `listening on :${actualPort}`);

  return {
    db,
    port: actualPort,
    close: async () => {
      clearInterval(indexTimer);
      clearInterval(directorTimer);
      loopLag.stop();
      features.stopTicks();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  // Before any feature reads it: the Jev key from the env, else ~/.config/brain-server/.env (server/jev-key.ts).
  const jevKey = loadTypesafeKeyAtBoot();
  log.info("server", jevKey.source ? `Jev key loaded from ${jevKey.tried.at(-1)?.label ?? jevKey.source}` : `Jev key not found (${describeAttempts(jevKey.tried)})`);
  startServer().catch((err) => {
    log.error("server", "fatal startup error", String(err));
    process.exit(1);
  });
}
