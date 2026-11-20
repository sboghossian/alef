// "brain": a read-only window onto the vault (~/Documents/Code/alex_claude).
// Graph from 60-Meta/brain-graph.json (slimmed, degree-sorted), single notes (path-safe,
// ≤256KB, secrets redacted), backlinks and BM25 search from one lazily built background
// index cached in data/. Private: only counts are logged, never note content or titles.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BRAIN_NOTE_MAX_BYTES,
  type BrainBacklinksResponse,
  type BrainError,
  type BrainLegendResponse,
  type BrainLink,
  type BrainNoteResponse,
  type BrainSearchHit,
  type BrainSearchResponse,
} from "../../shared/features/brain.js";
import { redactSecrets } from "../heuristics.js";
import { respondJson, respondJsonText } from "../http.js";
import { backlinkMap, countAttachments, LinkResolver, parseWikilinks, type VaultIndex, type VaultLegendCounts, type VaultNote } from "./brain-lib.js";
import { createBrainJobRunner, type BrainJobRunner } from "./brain-worker-host.js";
import { search } from "./recall/bm25.js";
import { titleOf } from "./recall/corpus.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { readTextCapped, resolveInside, safePathStatus } from "./safe-path.js";
import { vaultRoot as defaultVaultRoot } from "../config.js";

// v2 (round 11, package D): the on-disk cache gained `tagCounts` — bump so an old-shaped cache
// file from before this round is discarded and rebuilt rather than silently missing tags.
const INDEX_VERSION = 2;
const INDEX_MAX_AGE_MS = 30 * 60_000;
const GRAPH_MAX_BYTES = 40 * 1024 * 1024;
const GRAPH_DEFAULT_LIMIT = 1500;
const GRAPH_MAX_LIMIT = 5000;
const BACKLINKS_CAP = 500;
const LEGEND_TAGS_CAP = 40;
const ATTACHMENTS_MAX_AGE_MS = 5 * 60_000; // a full vault walk; cheap but not free at 60k+ files
/** How often a request may re-stat brain-graph.json to notice a newer file (in the background). */
const GRAPH_RECHECK_MS = 5_000;
/** With no graph yet, how often the tick tries to warm it again (the file may simply not exist). */
const GRAPH_WARM_RETRY_MS = 5 * 60_000;
/** Distinct ?limit= answers kept ready (each is a few hundred KB of JSON). */
const GRAPH_BODIES_CAP = 6;

export interface BrainFeatureOptions {
  vaultRoot?: string;
  graphPath?: string;
  /** Vault whose graph feed the globe draws, ahead of graphPath. Defaults to vaultRoot; null
   *  reads graphPath only. */
  feedVault?: string | null;
  cacheDir?: string;
  now?: () => Date;
  /** Where the heavy parse/build work runs; defaults to a worker thread. */
  jobs?: BrainJobRunner;
}

function fail(res: Parameters<typeof respondJson>[0], status: number, error: string): void {
  respondJson(res, status, { ok: false, error } satisfies BrainError);
}

export interface BrainFeature extends ServerFeature {
  whenIndexed(): Promise<void>;
  /** BM25 over every vault note for other features (voice-brain's retrieval). Never waits: starts
   *  the background index when cold and answers `ready: false` until it lands. */
  searchNotes(ctx: FeatureContext, q: string, limit: number): { ready: boolean; hits: BrainSearchHit[] };
}

export function createBrainFeature(opts: BrainFeatureOptions = {}): BrainFeature {
  const vaultRoot = opts.vaultRoot ?? defaultVaultRoot();
  const graphPath = opts.graphPath ?? join(vaultRoot, "60-Meta", "brain-graph.json");
  const feedVault = opts.feedVault === null ? undefined : (opts.feedVault ?? vaultRoot);
  const cachePath = join(opts.cacheDir ?? join(process.cwd(), "data"), "brain-index.json");
  const now = opts.now ?? (() => new Date());

  let index: VaultIndex | null = null;
  let backlinks = new Map<string, string[]>();
  let titles = new Map<string, string>();
  let resolver: LinkResolver | null = null;
  let building: Promise<void> | null = null;
  let attachmentsCache: { at: number; count: number } | null = null;
  let jobsRunner: BrainJobRunner | null = opts.jobs ?? null;
  function jobs(ctx: FeatureContext): BrainJobRunner {
    jobsRunner ??= createBrainJobRunner({
      onFallback: (reason, retryInMs) => ctx.log.warn("brain", `worker thread unavailable; parsing on the main thread, retrying in ${Math.round(retryInMs / 1000)}s`, reason),
    });
    return jobsRunner;
  }

  function install(next: VaultIndex): void {
    index = next;
    backlinks = backlinkMap(next.notes);
    titles = new Map(next.notes.map((n: VaultNote) => [n.path, n.title]));
    resolver = new LinkResolver(next.notes.map((n) => n.path));
  }

  /** Starts (once) loading the cache and rebuilding in the background when stale. Never awaited
   *  by a request. Parse, build and stringify all run in the worker (brain-jobs.ts). */
  function ensureIndex(ctx: FeatureContext): Promise<void> {
    if (index && now().getTime() - Date.parse(index.builtAt) < INDEX_MAX_AGE_MS) return Promise.resolve();
    if (building) return building;
    building = (async () => {
      if (!index) {
        const cached = await jobs(ctx).run({ kind: "index-cache", cachePath, vaultRoot, version: INDEX_VERSION });
        if (cached.index) {
          install(cached.index);
          if (now().getTime() - Date.parse(cached.index.builtAt) < INDEX_MAX_AGE_MS) return;
        }
      }
      const built = await jobs(ctx).run({ kind: "index-build", cachePath, vaultRoot, version: INDEX_VERSION, nowMs: now().getTime() });
      install(built.index);
      ctx.log.info("brain", `indexed ${built.index.notes.length} notes in ${built.buildMs}ms`);
      if (built.writeError) ctx.log.warn("brain", "index cache write failed (non-fatal)", built.writeError);
    })()
      .catch((err: unknown) => ctx.log.error("brain", "index build failed", String(err)))
      .finally(() => {
        building = null;
      });
    return building;
  }

  let attachmentsRefresh: Promise<void> | null = null;
  function refreshAttachments(): void {
    if (attachmentsRefresh || !attachmentsCache || now().getTime() - attachmentsCache.at < ATTACHMENTS_MAX_AGE_MS) return;
    attachmentsRefresh = countAttachments(vaultRoot)
      .then((count) => {
        attachmentsCache = { at: now().getTime(), count };
      })
      .catch(() => undefined)
      .finally(() => {
        attachmentsRefresh = null;
      });
  }

  // ── brain-graph.json: parsed and slimmed once per file version, off the event loop ──
  type GraphState = { mtimeMs: number; generatedAt: string; sourcePath: string; bodies: Map<number, string>; legend: VaultLegendCounts };
  let graph: GraphState | null = null;
  let graphLoad: Promise<{ status: number; error: string } | null> | null = null;
  let graphCheckedAt = 0;

  /** Parses the file in the worker and readies every wanted limit. Single-flight; a failed reload
   *  keeps the last good graph. Returns the error when there is no graph to serve. */
  function loadGraph(ctx: FeatureContext, limits: number[]): Promise<{ status: number; error: string } | null> {
    if (graphLoad) return graphLoad.then(() => (graph && limits.every((l) => graph?.bodies.has(l)) ? null : loadGraph(ctx, limits)));
    graphCheckedAt = now().getTime();
    graphLoad = (async () => {
      const r = await jobs(ctx).run({ kind: "graph", graphPath, feedVault, limits, maxBytes: GRAPH_MAX_BYTES });
      if (!r.ok) {
        if (graph) ctx.log.warn("brain", "brain-graph.json reload failed; serving the last good graph", r.error);
        return graph ? null : { status: r.status, error: r.error };
      }
      const keep = graph && graph.mtimeMs === r.mtimeMs && graph.sourcePath === r.sourcePath ? graph.bodies : new Map<number, string>();
      for (const [k, body] of Object.entries(r.bodies)) keep.set(Number(k), body);
      while (keep.size > GRAPH_BODIES_CAP) keep.delete(keep.keys().next().value ?? 0);
      graph = { mtimeMs: r.mtimeMs, generatedAt: r.generatedAt, sourcePath: r.sourcePath, bodies: keep, legend: r.legend };
      return null;
    })()
      .catch((err: unknown) => {
        ctx.log.error("brain", "brain-graph.json load failed", String(err));
        return graph ? null : { status: 500, error: "brain graph unreadable" };
      })
      .finally(() => {
        graphLoad = null;
      });
    return graphLoad;
  }

  /** At most every GRAPH_RECHECK_MS, a background stat; a newer file reloads every kept limit. */
  function revalidateGraph(ctx: FeatureContext): void {
    const t = now().getTime();
    if (!graph || graphLoad || t - graphCheckedAt < GRAPH_RECHECK_MS) return;
    graphCheckedAt = t;
    const known = graph;
    void stat(known.sourcePath).then(
      (st) => {
        if (st.mtimeMs !== known.mtimeMs) void loadGraph(ctx, [...known.bodies.keys()]);
      },
      () => undefined, // gone: keep serving the last good graph
    );
  }

  /** The graph state with `limit` ready, or the error to answer with. */
  async function graphWith(ctx: FeatureContext, limit: number | null): Promise<GraphState | { status: number; error: string }> {
    if (graph && (limit === null || graph.bodies.has(limit))) {
      revalidateGraph(ctx);
      return graph;
    }
    const err = await loadGraph(ctx, [limit ?? GRAPH_DEFAULT_LIMIT]);
    return err ?? graph ?? { status: 500, error: "brain graph unreadable" };
  }

  function link(path: string): BrainLink {
    return { path, title: titles.get(path) ?? path.replace(/\.md$/, "").split("/").pop() ?? path };
  }

  function notePathParam(req: { url?: string }): string {
    const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
    return raw && !/\.md$/i.test(raw) ? `${raw}.md` : raw;
  }

  let lastCtx: FeatureContext | null = null;

  return {
    id: "brain",
    // First tick (10 s after boot): warm the default graph in the background so the Brain tab's
    // first open is served from cache; later ticks notice a newer brain-graph.json.
    async onTick(ctx) {
      if (graph) return revalidateGraph(ctx);
      if (now().getTime() - graphCheckedAt < GRAPH_WARM_RETRY_MS) return; // no file last time: don't spin
      await loadGraph(ctx, [GRAPH_DEFAULT_LIMIT]);
    },
    whenIndexed: () => (lastCtx ? ensureIndex(lastCtx) : Promise.resolve()),
    searchNotes(ctx, q, limit) {
      lastCtx = ctx;
      void ensureIndex(ctx);
      if (!index || !q.trim()) return { ready: index !== null, hits: [] };
      return { ready: true, hits: search(index.bm25, q.slice(0, 500), Math.min(50, Math.max(1, limit))) };
    },
    routes: [
      {
        method: "GET",
        path: "/api/brain/graph",
        async handler(req, res, ctx) {
          lastCtx = ctx;
          const url = new URL(req.url ?? "/", "http://localhost");
          const n = Number(url.searchParams.get("limit") ?? GRAPH_DEFAULT_LIMIT);
          const limit = Number.isFinite(n) ? Math.min(GRAPH_MAX_LIMIT, Math.max(1, Math.round(n))) : GRAPH_DEFAULT_LIMIT;
          const g = await graphWith(ctx, limit);
          if ("error" in g) return fail(res, g.status, g.error);
          const body = g.bodies.get(limit);
          if (body === undefined) return fail(res, 500, "brain graph unreadable");
          respondJsonText(res, 200, body); // a BrainGraphResponse, serialised once in the worker
        },
      },
      {
        // Round 11, package D: vault-wide folder/type/tag/link/attachment totals for the
        // Legend's toggles — every node in brain-graph.json, never just /graph's top-N slice.
        method: "GET",
        path: "/api/brain/legend",
        async handler(_req, res, ctx) {
          lastCtx = ctx;
          void ensureIndex(ctx); // tag counts come from this background index; kicks it off if cold
          const g = await graphWith(ctx, null);
          if ("error" in g) return fail(res, g.status, g.error);
          // A full vault walk: only the very first legend waits for it; after that it refreshes
          // in the background and the last count is served.
          if (!attachmentsCache) attachmentsCache = { at: now().getTime(), count: await countAttachments(vaultRoot) };
          else refreshAttachments();
          const legend = g.legend;
          const tags = Object.entries(index?.tagCounts ?? {})
            .map(([tag, count]) => ({ id: tag, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, LEGEND_TAGS_CAP);
          respondJson(res, 200, {
            ok: true,
            generatedAt: g.generatedAt,
            totalNodes: legend.totalNodes,
            totalLinks: legend.totalLinks,
            folders: legend.folders,
            groups: legend.groups,
            attachments: attachmentsCache.count,
            tags,
            tagsReady: index !== null,
          } satisfies BrainLegendResponse);
        },
      },
      {
        method: "GET",
        path: "/api/brain/note",
        async handler(req, res, ctx) {
          lastCtx = ctx;
          void ensureIndex(ctx);
          const rel = notePathParam(req);
          if (!rel) return fail(res, 400, "path required");
          const target = await resolveInside(vaultRoot, rel);
          if (!target.ok) return fail(res, safePathStatus(target.error), target.error);
          const read = await readTextCapped(target.abs, BRAIN_NOTE_MAX_BYTES);
          if (!read.ok) return fail(res, read.status, read.error);
          const st = await stat(target.abs);
          const outlinks: BrainLink[] = [];
          if (resolver) {
            const seen = new Set<string>();
            for (const t of parseWikilinks(read.text)) {
              const r = resolver.resolve(t);
              if (r && r !== target.rel && !seen.has(r)) {
                seen.add(r);
                outlinks.push(link(r));
              }
            }
          }
          respondJson(res, 200, {
            ok: true,
            path: target.rel,
            title: redactSecrets(titleOf(target.rel.split("/").pop() ?? target.rel, read.text)),
            markdown: redactSecrets(read.text),
            size: read.size,
            modifiedAt: st.mtime.toISOString(),
            outlinks,
            backlinks: index ? (backlinks.get(target.rel) ?? []).slice(0, BACKLINKS_CAP).map(link) : null,
          } satisfies BrainNoteResponse);
        },
      },
      {
        method: "GET",
        path: "/api/brain/backlinks",
        async handler(req, res, ctx) {
          lastCtx = ctx;
          void ensureIndex(ctx);
          const rel = notePathParam(req);
          if (!rel) return fail(res, 400, "path required");
          const target = await resolveInside(vaultRoot, rel);
          if (!target.ok) return fail(res, safePathStatus(target.error), target.error);
          respondJson(res, 200, {
            ok: true,
            path: target.rel,
            ready: index !== null,
            backlinks: (backlinks.get(target.rel) ?? []).slice(0, BACKLINKS_CAP).map(link),
          } satisfies BrainBacklinksResponse);
        },
      },
      {
        method: "GET",
        path: "/api/brain/search",
        async handler(req, res, ctx) {
          lastCtx = ctx;
          void ensureIndex(ctx);
          const url = new URL(req.url ?? "/", "http://localhost");
          const q = (url.searchParams.get("q") ?? "").slice(0, 500);
          const n = Number(url.searchParams.get("limit") ?? 20);
          const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.round(n))) : 20;
          if (!q.trim()) return fail(res, 400, "q required");
          if (!index) return respondJson(res, 200, { ok: true, ready: false, hits: [], indexed: 0 } satisfies BrainSearchResponse);
          respondJson(res, 200, { ok: true, ready: true, hits: search(index.bm25, q, limit), indexed: index.notes.length } satisfies BrainSearchResponse);
        },
      },
    ],
    snapshotExtras() {
      return { "brain.indexed": index?.notes.length ?? 0 };
    },
    // Where parsing runs: "worker", "in-process" (with the start failure and the next retry), or
    // null before the first job.
    health() {
      return { worker: jobsRunner?.status() ?? { mode: null, failures: 0 } };
    },
  };
}

export const brainFeature = createBrainFeature();
