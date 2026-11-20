// The brain feature's heavy work, as plain jobs: JSON in, plain data out. brain-worker.ts runs them
// on a worker thread so the 11 MB brain-graph.json parse, its per-request slim (~200 ms) and the
// vault rebuild + stringify never block the event loop every other endpoint shares. The index
// cache job only moves the file read: the parsed index still crosses back by structured clone,
// whose deserialisation on the main thread costs about what JSON.parse did (measured: ~100 ms vs
// ~80 ms for a 17 MB index). brain-worker-host.ts runs them in-process when a worker can't start.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildVaultIndex, feedToGraph, slimGraph, vaultLegend, type VaultIndex, type VaultLegendCounts } from "./brain-lib.js";
import { VaultFeedReader, vaultFeedDir } from "./vault-feed.js";

export interface GraphJob {
  kind: "graph";
  graphPath: string;
  /** The vault whose 60-Meta/graph-feed (the one Vault reads) is preferred over graphPath. */
  feedVault?: string;
  limits: number[];
  maxBytes: number;
}

export type GraphJobResult =
  | { ok: true; mtimeMs: number; generatedAt: string; sourcePath: string; bodies: Record<string, string>; legend: VaultLegendCounts }
  | { ok: false; status: number; error: string };

/** Builds the graph once, then answers every limit as a ready JSON body. The vault's hourly
 *  graph feed comes first, so Brain and Vault always show the same notes; brain-graph.json is
 *  the fallback for a vault without a feed. */
export async function runGraphJob(job: GraphJob): Promise<GraphJobResult> {
  if (job.feedVault) {
    const manifest = `${vaultFeedDir({ vaultDir: job.feedVault })}/manifest.json`;
    const st = await stat(manifest).catch(() => null);
    const feed = st ? await new VaultFeedReader({ vaultDir: job.feedVault }).refresh() : null;
    if (st && feed && feed.notes.length) {
      const parsed = feedToGraph(feed.notes);
      const generatedAt = feed.meta.generatedAt || new Date(st.mtimeMs).toISOString();
      const bodies: Record<string, string> = {};
      for (const limit of job.limits) bodies[String(limit)] = JSON.stringify(slimGraph(parsed, limit, generatedAt));
      return { ok: true, mtimeMs: st.mtimeMs, generatedAt, sourcePath: manifest, bodies, legend: vaultLegend(parsed) };
    }
  }
  let st;
  try {
    st = await stat(job.graphPath);
  } catch {
    return { ok: false, status: 404, error: "brain-graph.json not found" };
  }
  if (st.size > job.maxBytes) return { ok: false, status: 413, error: "brain graph too large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(job.graphPath, "utf8"));
  } catch {
    return { ok: false, status: 500, error: "brain graph unreadable" };
  }
  const generatedAt = new Date(st.mtimeMs).toISOString();
  const bodies: Record<string, string> = {};
  for (const limit of job.limits) bodies[String(limit)] = JSON.stringify(slimGraph(parsed, limit, generatedAt));
  return { ok: true, mtimeMs: st.mtimeMs, generatedAt, sourcePath: job.graphPath, bodies, legend: vaultLegend(parsed) };
}

export interface IndexCacheJob {
  kind: "index-cache";
  cachePath: string;
  vaultRoot: string;
  version: number;
}

export type IndexCacheJobResult = { index: VaultIndex | null };

/** The on-disk index cache, when it exists and matches this version and vault (else null). */
export async function runIndexCacheJob(job: IndexCacheJob): Promise<IndexCacheJobResult> {
  try {
    const parsed = JSON.parse(await readFile(job.cachePath, "utf8")) as Partial<VaultIndex> & { version?: number; vaultRoot?: string };
    if (parsed.version === job.version && parsed.vaultRoot === job.vaultRoot && Array.isArray(parsed.notes) && parsed.bm25 && parsed.builtAt) {
      return { index: { builtAt: parsed.builtAt, notes: parsed.notes, bm25: parsed.bm25, tagCounts: parsed.tagCounts ?? {} } };
    }
  } catch {
    /* no cache yet */
  }
  return { index: null };
}

export interface IndexBuildJob {
  kind: "index-build";
  cachePath: string;
  vaultRoot: string;
  version: number;
  nowMs: number;
}

export type IndexBuildJobResult = { index: VaultIndex; buildMs: number; writeError: string | null };

/** Walks the vault, builds the index and writes the cache file (tmp + rename). */
export async function runIndexBuildJob(job: IndexBuildJob): Promise<IndexBuildJobResult> {
  const t0 = Date.now();
  const index = await buildVaultIndex(job.vaultRoot, () => new Date(job.nowMs + (Date.now() - t0)));
  const buildMs = Date.now() - t0;
  let writeError: string | null = null;
  try {
    await mkdir(dirname(job.cachePath), { recursive: true });
    const tmp = `${job.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: job.version, vaultRoot: job.vaultRoot, ...index }), "utf8");
    await rename(tmp, job.cachePath);
  } catch (err) {
    writeError = String(err);
  }
  return { index, buildMs, writeError };
}

export type BrainJob = GraphJob | IndexCacheJob | IndexBuildJob;

export type BrainJobResult<J extends BrainJob> = J extends GraphJob ? GraphJobResult : J extends IndexCacheJob ? IndexCacheJobResult : IndexBuildJobResult;

export async function runBrainJob<J extends BrainJob>(job: J): Promise<BrainJobResult<J>> {
  switch (job.kind) {
    case "graph":
      return (await runGraphJob(job)) as BrainJobResult<J>;
    case "index-cache":
      return (await runIndexCacheJob(job)) as BrainJobResult<J>;
    case "index-build":
      return (await runIndexBuildJob(job)) as BrainJobResult<J>;
  }
}
