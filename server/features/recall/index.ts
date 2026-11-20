// "recall" feature: Ask Jev's "From your notes" section. Builds a BM25 index over a
// fixed, private, read-only corpus in the background at boot (never blocking the
// server), optionally reranked by local Ollama embeddings when reachable. See
// shared/features/recall.ts for the wire contract and corpus.ts for the privacy note.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecallOpenResult, RecallResult, RecallWebHit } from "../../../shared/features/recall.js";
import { isRecord, readJsonBody, respondJson } from "../../http.js";
import { log } from "../../log.js";
import type { ServerFeature } from "../registry.js";
import { bm25Scores, buildIndex, materialize, rankedChunkIndices, type BM25Index, type ScoredHit } from "./bm25.js";
import { defaultCorpusRoots, walkCorpus, type CorpusRoots } from "./corpus.js";
import { jevWebLogFor, JevWebLog } from "./jev-web.js";
import { cosine, embedOne, probeOllama } from "./ollama.js";

const INDEX_VERSION = 2; // bump to invalidate the on-disk cache when the build logic changes
const RERANK_POOL = 8;
const POOL_EMBED_TIMEOUT_MS = 1200;
const RRF_K = 60;
const MAX_QUESTION_CHARS = 500;
const MAX_HITS = 3;
const MAX_WEB_HITS = 3;

interface CachedIndex extends BM25Index {
  version: number;
}

async function loadCache(cachePath: string): Promise<BM25Index | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CachedIndex>;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.chunks) || !parsed.postings) return null;
    return { n: parsed.n ?? parsed.chunks.length, avgdl: parsed.avgdl ?? 0, chunks: parsed.chunks, postings: parsed.postings };
  } catch {
    return null;
  }
}

async function saveCache(cachePath: string, index: BM25Index): Promise<void> {
  try {
    await mkdir(join(cachePath, ".."), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ version: INDEX_VERSION, ...index }), "utf8");
  } catch (err) {
    log.warn("recall", "index cache write failed (non-fatal)", String(err));
  }
}

async function semanticRerank(
  idx: BM25Index,
  bmRanked: readonly number[],
  bmScores: ReadonlyMap<number, number>,
  host: string,
  query: string,
  k: number,
): Promise<ScoredHit[] | null> {
  const pool = bmRanked.slice(0, RERANK_POOL);
  if (!pool.length) return null;
  const qvec = await embedOne(host, query, POOL_EMBED_TIMEOUT_MS);
  if (!qvec) return null;

  const vectors = await Promise.all(
    pool.map(async (ci) => {
      const chunk = idx.chunks[ci];
      if (!chunk) return null;
      const vec = await embedOne(host, `${chunk.title}\n${chunk.snippet}`, POOL_EMBED_TIMEOUT_MS);
      return vec ? ([ci, cosine(qvec, vec)] as const) : null;
    }),
  );
  const cosines = new Map(vectors.filter((v): v is readonly [number, number] => v !== null));
  if (!cosines.size) return null;

  const bmRank = new Map<number, number>();
  bmRanked.forEach((ci, i) => bmRank.set(ci, i));
  const semRank = new Map<number, number>();
  [...cosines.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([ci], i) => semRank.set(ci, i));

  const fused = new Map<number, number>();
  for (const ci of pool) {
    let s = 0;
    const bmR = bmRank.get(ci);
    const semR = semRank.get(ci);
    if (bmR !== undefined) s += 1 / (RRF_K + bmR);
    if (semR !== undefined) s += 1 / (RRF_K + semR);
    if (s > 0) fused.set(ci, s);
  }
  if (!fused.size) return null;
  return materialize(idx, rankedChunkIndices(idx, fused), fused, k);
}

export interface RecallFeatureOptions {
  roots?: CorpusRoots;
  /** Directory the BM25 index cache is written into (default: <cwd>/data). */
  cacheDir?: string;
  /** Skips the boot-time Ollama probe (tests: no network, deterministic BM25-only). */
  skipOllamaProbe?: boolean;
  /** Jev's kept web trips (default: data/jev-web.jsonl beside world.db). */
  jevWebPath?: string;
}

/** Factory so tests point at fixture corpora instead of Alex's real, private
 *  memory + vault files, and each instance owns its own index/cache (no shared
 *  module state across tests). */
export function createRecallFeature(opts: RecallFeatureOptions = {}): ServerFeature {
  const roots = opts.roots ?? defaultCorpusRoots();
  const cachePath = join(opts.cacheDir ?? join(process.cwd(), "data"), "recall-index.json");

  let ownLog: JevWebLog | null = null;
  /** Jev's earlier web finds for the question: a separate small index, never ranked with the notes. */
  async function webHits(dbPath: string, question: string): Promise<RecallWebHit[]> {
    const log = opts.jevWebPath ? (ownLog ??= new JevWebLog(opts.jevWebPath)) : jevWebLogFor(dbPath);
    if (!log) return [];
    await log.refresh();
    return log.search(question, MAX_WEB_HITS).map(({ title, url, host, question: q, at, score }) => ({ title, url, host, question: q, at, score }));
  }

  const state: { index: BM25Index | null; ready: boolean; semanticHost: string | null } = {
    index: null,
    ready: false,
    semanticHost: null,
  };

  // Fire-and-forget at construction time (module/feature load), never awaited by a
  // request — matches "build lazily in background at boot, never block the server".
  void (async () => {
    const t0 = Date.now();
    const cached = await loadCache(cachePath);
    if (cached) {
      state.index = cached;
      state.ready = true;
    }
    const docs = await walkCorpus(roots);
    const built = buildIndex(docs);
    state.index = built;
    state.ready = true;
    void saveCache(cachePath, built);

    if (!opts.skipOllamaProbe) {
      const probe = await probeOllama();
      state.semanticHost = probe.reachable ? probe.host : null;
    }
    log.info("recall", `indexed ${built.n} docs in ${Date.now() - t0}ms${state.semanticHost ? " (+ollama semantic rerank)" : ""}`);
  })();

  return {
    id: "recall",
    routes: [
      {
        method: "POST",
        path: "/api/recall",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, { ok: false, hits: [], mode: "bm25", ready: state.ready, error: "invalid JSON body" } satisfies RecallResult);
            return;
          }
          const question = isRecord(body) && typeof body.question === "string" ? body.question : null;
          if (question === null || question.length < 1 || question.length > MAX_QUESTION_CHARS) {
            respondJson(res, 400, {
              ok: false,
              hits: [],
              mode: "bm25",
              ready: state.ready,
              error: `question must be 1..${MAX_QUESTION_CHARS} characters`,
            } satisfies RecallResult);
            return;
          }
          let found: RecallWebHit[] = [];
          try {
            found = await webHits(ctx.config.dbPath, question);
          } catch (err) {
            log.warn("recall", "Jev's web finds could not be read", String(err));
          }
          const web = found.length ? { web: found } : {};
          const idx = state.index;
          if (!idx || !state.ready) {
            respondJson(res, 200, { ok: true, hits: [], mode: "bm25", ready: false, ...web } satisfies RecallResult);
            return;
          }
          const scores = bm25Scores(idx, question);
          if (!scores.size) {
            respondJson(res, 200, { ok: true, hits: [], mode: "bm25", ready: true, ...web } satisfies RecallResult);
            return;
          }
          const bmRanked = rankedChunkIndices(idx, scores);
          if (state.semanticHost) {
            const hybrid = await semanticRerank(idx, bmRanked, scores, state.semanticHost, question, MAX_HITS);
            if (hybrid) {
              respondJson(res, 200, { ok: true, hits: hybrid, mode: "hybrid", ready: true, ...web } satisfies RecallResult);
              return;
            }
          }
          respondJson(res, 200, { ok: true, hits: materialize(idx, bmRanked, scores, MAX_HITS), mode: "bm25", ready: true, ...web } satisfies RecallResult);
        },
      },
      {
        method: "POST",
        path: "/api/recall/open",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies RecallOpenResult);
            return;
          }
          const path = isRecord(body) && typeof body.path === "string" ? body.path : null;
          if (!path) {
            respondJson(res, 400, { ok: false, error: "path required" } satisfies RecallOpenResult);
            return;
          }
          const insideCorpus = path.startsWith(`${roots.memoryDir}/`) || path.startsWith(`${roots.vaultProjectsDir}/`);
          const { islands } = ctx.worldViews();
          const insideKnownCwd = islands.some((i) => i.id !== "harness" && i.path && path.startsWith(`${i.path}/`));
          if (!insideCorpus || !insideKnownCwd) {
            respondJson(res, 403, { ok: false, error: "not inside a known agent cwd" } satisfies RecallOpenResult);
            return;
          }
          try {
            await ctx.executors.openEditor(path);
            respondJson(res, 200, { ok: true } satisfies RecallOpenResult);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) } satisfies RecallOpenResult);
          }
        },
      },
    ],
    snapshotExtras() {
      return { "recall.ready": state.ready, "recall.docCount": state.index?.n ?? 0 };
    },
  };
}

export const recallFeature: ServerFeature = createRecallFeature();
