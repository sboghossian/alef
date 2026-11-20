// Server feature registry. A feature is a module in server/features/<id>.ts that
// exports a ServerFeature; server/features/index.ts is the only list of enabled
// features. The hub (server/index.ts) never learns about individual features: it
// asks this registry for routes, index-pass hooks, timers and snapshot extras.
// See docs/FEATURES.md.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Island, ServerMessage, WorldAgent, WorldEdge, WorldObject } from "../../shared/types.js";
import type { WorldDb } from "../db.js";
import type { LiveStatus } from "../live-cache.js";
import type { ServerConfig } from "../index.js";
import type { log as logger } from "../log.js";
import type { DispatchExecutor, OpenEditorExecutor, ReactivateExecutor } from "../reactivate.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RouteParams = Readonly<Record<string, string>>;

export interface Route {
  method: HttpMethod;
  /** Exact path, or segments with `:name` params, e.g. "/api/open-editor/:agentId". Params are URI-decoded. */
  path: string;
  handler(req: IncomingMessage, res: ServerResponse, ctx: FeatureContext, params: RouteParams): void | Promise<void>;
}

/** A WebSocket (HTTP upgrade) endpoint owned by a feature, e.g. "/ws/term/:agentId".
 *  The hub has already applied the loopback Host/Origin guard before calling `handler`;
 *  the handler owns the socket from then on (complete the handshake or destroy it). */
export interface UpgradeRoute {
  path: string;
  handler(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: FeatureContext, params: RouteParams): void | Promise<void>;
}

/** The world as the snapshot sees it right now (live detection included). */
export interface WorldViews {
  agents: WorldAgent[];
  objects: WorldObject[];
  edges: WorldEdge[];
  islands: Island[];
}

/** Everything a feature may use from the hub. */
export interface ServerContext {
  db: WorldDb;
  config: ServerConfig;
  log: typeof logger;
  /** Running-claude detector: cwd → count. Never blocks: serves the latest async ps + lsof probe
   *  (≤ ~3 s old) and starts the next one in the background. */
  detectLive(): Map<string, number>;
  /** Whether the latest probe could read the process table at all. Optional for hand-built test
   *  contexts; a missing one means "assume it could". */
  liveStatus?(): LiveStatus;
  executors: { reactivate: ReactivateExecutor; dispatch: DispatchExecutor; openEditor: OpenEditorExecutor };
  /** Sends any ServerMessage to every connected client. Prefer `emit` for feature data. */
  broadcast(msg: ServerMessage): void;
  worldViews(): WorldViews;
}

/** ServerContext bound to one feature. */
export interface FeatureContext extends ServerContext {
  featureId: string;
  /** Broadcasts `{ type: "feature", feature: featureId, payload }`. */
  emit(payload: unknown): void;
}

export interface ServerFeature {
  /** Unique, kebab-case. Also the `feature` field of its WS messages. */
  id: string;
  routes?: Route[];
  /** WebSocket endpoints (never "/ws", which is the hub's). Guarded like every route. */
  upgrades?: UpgradeRoute[];
  /** After each incremental index pass (every 10s) that read new jsonl lines.
   *  Keys are session ids (= agent ids); values are the raw new lines, oldest first.
   *  Lines are untrusted data: parse, never execute. */
  onIndexPass?(ctx: FeatureContext, newLinesBySession: ReadonlyMap<string, readonly string[]>): void | Promise<void>;
  /** Awaited once at boot, before the server listens: the first snapshot any client gets (an open
   *  tab reconnecting after a restart included) already carries what this restores from disk.
   *  The hub waits at most START_HOOK_TIMEOUT_MS for it, then listens anyway. */
  onStart?(ctx: FeatureContext): void | Promise<void>;
  /** Runs every tickIntervalMs (default 10s), never overlapping itself. */
  onTick?(ctx: FeatureContext): void | Promise<void>;
  tickIntervalMs?: number;
  /** Merged into WorldSnapshot.extras. Prefix keys with your feature id; on a key clash the first feature wins. */
  snapshotExtras?(ctx: FeatureContext): Record<string, unknown>;
  /** Islands the feature adds to the snapshot only (never to `worldViews()`), e.g. the artifacts
   *  feature's Museum. An id the world already has ("harness" or an indexed folder) is ignored, and
   *  so is a later feature's copy of an id an earlier feature added. */
  snapshotIslands?(ctx: FeatureContext): Island[];
  /** Served under `features.<id>` in GET /api/health. Cheap and synchronous: no I/O. */
  health?(ctx: FeatureContext): Record<string, unknown>;
}

export const DEFAULT_TICK_MS = 10_000;
/** The longest boot waits on any one onStart hook (a hook must never keep the server from listening). */
export const START_HOOK_TIMEOUT_MS = 10_000;

interface CompiledRoute {
  route: Route;
  feature: ServerFeature;
  regex: RegExp;
  keys: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles "/api/x/:id" to an anchored regex + param names. */
export function compilePath(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":") && seg.length > 1) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return escapeRegex(seg);
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`), keys };
}

/** Returns decoded params when `pathname` matches `pattern`, else null. Throws URIError on a malformed escape. */
export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const { regex, keys } = compilePath(pattern);
  return execCompiled(regex, keys, pathname);
}

function execCompiled(regex: RegExp, keys: string[], pathname: string): RouteParams | null {
  const m = regex.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1] ?? "");
  });
  return params;
}

/** Merges each feature's extras; first feature wins a key clash (the loser is logged). Undefined when no feature contributes. */
export function mergeSnapshotExtras(
  entries: ReadonlyArray<{ featureId: string; extras: Record<string, unknown> }>,
  warn: (msg: string) => void = () => {},
): Record<string, unknown> | undefined {
  if (entries.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const { featureId, extras } of entries) {
    for (const [key, value] of Object.entries(extras)) {
      const prev = owner.get(key);
      if (prev !== undefined) {
        warn(`snapshot extra "${key}" from ${featureId} ignored: already set by ${prev}`);
        continue;
      }
      owner.set(key, featureId);
      merged[key] = value;
    }
  }
  return merged;
}

export class ServerFeatureRegistry {
  private readonly routes: CompiledRoute[] = [];
  private readonly upgradeRoutes: { route: UpgradeRoute; feature: ServerFeature; regex: RegExp; keys: string[] }[] = [];
  private readonly ctxById = new Map<string, FeatureContext>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly features: readonly ServerFeature[],
    base: ServerContext,
  ) {
    for (const f of features) {
      if (this.ctxById.has(f.id)) throw new Error(`duplicate server feature id: ${f.id}`);
      this.ctxById.set(f.id, {
        ...base,
        featureId: f.id,
        emit: (payload) => base.broadcast({ type: "feature", feature: f.id, payload }),
      });
      for (const route of f.routes ?? []) this.routes.push({ route, feature: f, ...compilePath(route.path) });
      for (const route of f.upgrades ?? []) this.upgradeRoutes.push({ route, feature: f, ...compilePath(route.path) });
    }
  }

  private ctx(f: ServerFeature): FeatureContext {
    const c = this.ctxById.get(f.id);
    if (!c) throw new Error(`unregistered feature ${f.id}`);
    return c;
  }

  /** Runs the first matching feature route. Returns false when none matched. */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    for (const r of this.routes) {
      if (req.method !== r.route.method) continue;
      const params = execCompiled(r.regex, r.keys, pathname);
      if (!params) continue;
      await r.route.handler(req, res, this.ctx(r.feature), params);
      return true;
    }
    return false;
  }

  /** Hands an (already guarded) upgrade request to the first matching feature endpoint.
   *  Returns false when none matched, leaving the socket to the caller. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string): boolean {
    for (const r of this.upgradeRoutes) {
      const params = execCompiled(r.regex, r.keys, pathname);
      if (!params) continue;
      const ctx = this.ctx(r.feature);
      void (async () => {
        try {
          await r.route.handler(req, socket, head, ctx, params);
        } catch (err) {
          ctx.log.error(`feature:${r.feature.id}`, "upgrade handler failed", String(err));
          socket.destroy();
        }
      })();
      return true;
    }
    return false;
  }

  /** True when some feature wants raw new lines (the indexer only collects them then). */
  wantsIndexLines(): boolean {
    return this.features.some((f) => f.onIndexPass);
  }

  async indexPass(newLinesBySession: ReadonlyMap<string, readonly string[]>): Promise<void> {
    if (newLinesBySession.size === 0) return;
    for (const f of this.features) {
      if (!f.onIndexPass) continue;
      try {
        await f.onIndexPass(this.ctx(f), newLinesBySession);
      } catch (err) {
        this.ctx(f).log.error(`feature:${f.id}`, "onIndexPass failed", String(err));
      }
    }
  }

  snapshotExtras(): Record<string, unknown> | undefined {
    const entries: { featureId: string; extras: Record<string, unknown> }[] = [];
    for (const f of this.features) {
      if (!f.snapshotExtras) continue;
      try {
        entries.push({ featureId: f.id, extras: f.snapshotExtras(this.ctx(f)) });
      } catch (err) {
        this.ctx(f).log.error(`feature:${f.id}`, "snapshotExtras failed", String(err));
      }
    }
    const firstCtx = this.features[0] ? this.ctx(this.features[0]) : undefined;
    return mergeSnapshotExtras(entries, (m) => firstCtx?.log.warn("features", m));
  }

  /** Every feature's health(), keyed by feature id; a feature that throws reports its error instead. */
  health(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const f of this.features) {
      if (!f.health) continue;
      try {
        out[f.id] = f.health(this.ctx(f));
      } catch (err) {
        out[f.id] = { error: String(err) };
      }
    }
    return out;
  }

  /** Every feature's snapshotIslands, minus ids in `taken` and repeats (first feature wins). */
  snapshotIslands(taken: ReadonlySet<string>): Island[] {
    const out: Island[] = [];
    const seen = new Set(taken);
    for (const f of this.features) {
      if (!f.snapshotIslands) continue;
      try {
        for (const island of f.snapshotIslands(this.ctx(f))) {
          if (seen.has(island.id)) continue;
          seen.add(island.id);
          out.push(island);
        }
      } catch (err) {
        this.ctx(f).log.error(`feature:${f.id}`, "snapshotIslands failed", String(err));
      }
    }
    return out;
  }

  /** Runs every onStart hook in parallel, each bounded by `timeoutMs`. Never rejects: a hook that
   *  throws or runs late is logged, and one that runs late keeps running on its own. */
  async start(timeoutMs: number = START_HOOK_TIMEOUT_MS): Promise<void> {
    await Promise.all(
      this.features.map(async (f) => {
        const onStart = f.onStart;
        if (!onStart) return;
        const ctx = this.ctx(f);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), timeoutMs)));
        try {
          const run = (async () => onStart.call(f, ctx))();
          run.catch((err: unknown) => ctx.log.error(`feature:${f.id}`, "onStart failed", String(err)));
          if ((await Promise.race([run.then(() => "done" as const, () => "done" as const), late])) === "late") {
            ctx.log.warn(`feature:${f.id}`, `onStart still running after ${timeoutMs} ms; listening without it`);
          }
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  startTicks(): void {
    for (const f of this.features) {
      const onTick = f.onTick;
      if (!onTick) continue;
      const ctx = this.ctx(f);
      let running = false;
      this.timers.push(
        setInterval(() => {
          if (running) return;
          running = true;
          void (async () => {
            try {
              await onTick.call(f, ctx);
            } catch (err) {
              ctx.log.error(`feature:${f.id}`, "onTick failed", String(err));
            } finally {
              running = false;
            }
          })();
        }, f.tickIntervalMs ?? DEFAULT_TICK_MS),
      );
    }
  }

  stopTicks(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }
}
