import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainGraphResponse, BrainLegendResponse } from "../../shared/features/brain.js";
import { runGraphJob, type GraphJob } from "../features/brain-jobs.js";
import { createBrainJobRunner, workerExecArgv, type BrainJobRunner } from "../features/brain-worker-host.js";
import { createBrainFeature } from "../features/brain.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = pathToFileURL(join(REPO, "server", "features", "brain-worker-boot.mjs")).href;

const GRAPH_A = { nodes: [{ i: 0, l: "pricing", p: "50-Wiki/pricing", f: "wiki", d: 3, c: 0 }, { i: 1, l: "growth", p: "growth", f: "other", d: 2, c: 0 }], edges: [[0, 1]] };
const GRAPH_B = { nodes: [{ i: 0, l: "renamed", p: "50-Wiki/renamed", f: "wiki", d: 1, c: 0 }], edges: [] };

async function makeVault(): Promise<{ scratch: string; vault: string; graphPath: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "aw-brain-worker-"));
  const vault = join(scratch, "vault");
  await mkdir(join(vault, "60-Meta"), { recursive: true });
  await writeFile(join(vault, "growth.md"), "# Growth\nSee [[pricing]].\n");
  const graphPath = join(vault, "60-Meta", "brain-graph.json");
  await writeFile(graphPath, JSON.stringify(GRAPH_A));
  return { scratch, vault, graphPath };
}

describe("workerExecArgv", () => {
  it("adds the tsx loader when the parent wasn't started through tsx, and leaves it alone when it was", () => {
    const added = workerExecArgv(["--conditions", "x"]);
    expect(added.slice(0, 2)).toEqual(["--conditions", "x"]);
    expect(added[2]).toBe("--import");
    expect(added[3]).toMatch(/tsx\/dist\/esm\/index\.mjs$/);
    const kept = ["--import", "file:///x/node_modules/tsx/dist/esm/index.mjs"];
    expect(workerExecArgv(kept)).toEqual(kept);
  });
});

describe("createBrainJobRunner", () => {
  const runners: BrainJobRunner[] = [];
  let scratch = "";
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.close()));
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("runs a graph job on a worker thread and hands back ready JSON bodies", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    const runner = createBrainJobRunner();
    runners.push(runner);
    const r = await runner.run({ kind: "graph", graphPath: v.graphPath, limits: [1, 10], maxBytes: 1 << 20 });
    expect(runner.mode()).toBe("worker");
    if (!r.ok) throw new Error(r.error);
    expect((JSON.parse(r.bodies["1"] ?? "{}") as BrainGraphResponse).nodes.map((n) => n.label)).toEqual(["pricing"]);
    expect((JSON.parse(r.bodies["10"] ?? "{}") as BrainGraphResponse).nodes).toHaveLength(2);
    expect(r.legend.totalNodes).toBe(2);
  });

  it("falls back to in-process when the worker can't start, and says so once", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    const reasons: string[] = [];
    const runner = createBrainJobRunner({ entry: pathToFileURL(join(v.scratch, "no-such-worker.mjs")), onFallback: (r) => reasons.push(r) });
    runners.push(runner);
    const [a, b] = await Promise.all([
      runner.run({ kind: "graph", graphPath: v.graphPath, limits: [10], maxBytes: 1 << 20 }),
      runner.run({ kind: "graph", graphPath: join(v.scratch, "missing.json"), limits: [10], maxBytes: 1 << 20 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, status: 404, error: "brain-graph.json not found" });
    expect(runner.mode()).toBe("in-process");
    expect(reasons).toHaveLength(1);
    expect((await runner.run({ kind: "index-cache", cachePath: join(v.scratch, "none.json"), vaultRoot: v.vault, version: 2 })).index).toBeNull();
  });

  it("retries a failed worker start with backoff, and goes back to the worker once it starts", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    let nowMs = 1_000_000;
    const reasons: number[] = [];
    const entryPath = join(v.scratch, "late-worker.mjs");
    const runner = createBrainJobRunner({ entry: pathToFileURL(entryPath), now: () => nowMs, retryBaseMs: 1000, onFallback: (_r, retryIn) => reasons.push(retryIn) });
    runners.push(runner);
    const job: GraphJob = { kind: "graph", graphPath: v.graphPath, limits: [10], maxBytes: 1 << 20 };

    expect((await runner.run(job)).ok).toBe(true);
    expect(runner.status()).toMatchObject({ mode: "in-process", failures: 1, retryAt: new Date(nowMs + 1000).toISOString() });
    expect(runner.status().reason).toMatch(/late-worker/);
    // Inside the backoff window: in-process, no new start.
    nowMs += 500;
    await runner.run(job);
    expect(reasons).toEqual([1000]);
    // Past it, still broken: the next wait doubles.
    nowMs += 600;
    await runner.run(job);
    expect(reasons).toEqual([1000, 2000]);
    expect(runner.status().failures).toBe(2);

    // The entry appears: past the window the runner starts a worker again and reports it.
    await writeFile(entryPath, `await import(${JSON.stringify(BOOT)});\n`);
    nowMs += 2001;
    expect((await runner.run(job)).ok).toBe(true);
    expect(runner.status()).toEqual({ mode: "worker", failures: 0 });
  });

  it("runGraphJob draws the vault's graph feed ahead of brain-graph.json, and falls back without one", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    const fallback = await runGraphJob({ kind: "graph", graphPath: v.graphPath, feedVault: v.vault, limits: [10], maxBytes: 1 << 20 });
    if (!fallback.ok) throw new Error(fallback.error);
    expect(fallback.sourcePath).toBe(v.graphPath);

    const feed = join(v.vault, "60-Meta", "graph-feed");
    await mkdir(feed, { recursive: true });
    const tsv = (f: string[]): string => [...f, ...Array<string>(12 - f.length).fill("")].join("\t");
    await writeFile(join(feed, "manifest.json"), JSON.stringify({ generated: "2026-10-27T03:00:00+00:00", stats: { notes: 3 }, shards: [{ name: "shard-00.tsv", nodes: 4 }] }));
    await writeFile(
      join(feed, "shard-00.tsv"),
      [tsv(["a", "30-Knowledge/2026-10-01-pricing-model.md", "n", "", "", "", "", "", "b,c"]), tsv(["b", "growth.md", "n", "", "", "", "", "", "a"]), tsv(["c", "10-Sessions/s.md"]), tsv(["x", "img.png", "a"])].join("\n"),
    );
    const r = await runGraphJob({ kind: "graph", graphPath: v.graphPath, feedVault: v.vault, limits: [10], maxBytes: 1 << 20 });
    if (!r.ok) throw new Error(r.error);
    expect(r.sourcePath).toBe(join(feed, "manifest.json"));
    expect(r.generatedAt).toBe("2026-10-27T03:00:00+00:00");
    const g = JSON.parse(r.bodies["10"] ?? "{}") as BrainGraphResponse;
    expect(g.nodes.map((n) => [n.label, n.path, n.group, n.degree])).toEqual([
      ["pricing model", "30-Knowledge/2026-10-01-pricing-model", "knowledge", 2],
      ["growth", "growth", "other", 1],
      ["s", "10-Sessions/s", "session", 1],
    ]);
    expect(g.edges).toHaveLength(2); // a-b once, though both notes link it; the attachment is no node
    expect(r.legend.totalNodes).toBe(3);
    expect(r.legend.totalLinks).toBe(3); // the feed counts each direction, as Vault does
  });

  it("runGraphJob refuses a file over the size cap without parsing it", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    expect(await runGraphJob({ kind: "graph", graphPath: v.graphPath, limits: [10], maxBytes: 10 })).toEqual({ ok: false, status: 413, error: "brain graph too large" });
  });
});

describe("brain worker under tsx", () => {
  it("starts a real worker when the parent runs under the tsx CLI (dev, alef-live)", async () => {
    const v = await makeVault();
    try {
      const script = join(v.scratch, "boot-under-tsx.mts");
      const host = pathToFileURL(join(REPO, "server", "features", "brain-worker-host.ts")).href;
      await writeFile(
        script,
        [
          `import { createBrainJobRunner } from ${JSON.stringify(host)};`,
          `const runner = createBrainJobRunner();`,
          `const r = await runner.run({ kind: "graph", graphPath: ${JSON.stringify(v.graphPath)}, limits: [10], maxBytes: 1 << 20 });`,
          `process.stdout.write(JSON.stringify({ ok: r.ok, status: runner.status() }));`,
          `await runner.close();`,
        ].join("\n"),
      );
      const out = await new Promise<string>((resolve, reject) =>
        execFile(join(REPO, "node_modules", ".bin", "tsx"), [script], { cwd: REPO, timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${String(err)}\n${stderr}`)) : resolve(stdout))),
      );
      expect(JSON.parse(out)).toEqual({ ok: true, status: { mode: "worker", failures: 0 } });
    } finally {
      await rm(v.scratch, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("brain graph cache", () => {
  let server: RunningServer | null = null;
  let scratch = "";
  afterEach(async () => {
    await server?.close();
    server = null;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("serves the last good graph from memory, and picks up a newer file in the background", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    let nowMs = Date.now();
    const feature = createBrainFeature({ vaultRoot: v.vault, cacheDir: join(v.scratch, "data"), now: () => new Date(nowMs) });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    const graph = async (): Promise<{ status: number; body: BrainGraphResponse }> => {
      const res = await fetch(`${b.base}/api/brain/graph?limit=10`);
      return { status: res.status, body: (await res.json()) as BrainGraphResponse };
    };

    expect((await graph()).body.nodes.map((n) => n.label)).toEqual(["pricing", "growth"]);
    // The file is mid-rewrite (gone): requests keep the cached answer instead of failing.
    await rm(v.graphPath);
    nowMs += 10_000;
    const during = await graph();
    expect(during.status).toBe(200);
    expect(during.body.nodes).toHaveLength(2);
    const legend = (await (await fetch(`${b.base}/api/brain/legend`)).json()) as BrainLegendResponse;
    expect(legend.totalNodes).toBe(2);

    // A newer file lands: the next request past the recheck window still answers at once, and the
    // reload it started in the background shows up shortly after.
    await writeFile(v.graphPath, JSON.stringify(GRAPH_B));
    const later = new Date(Date.now() + 60_000);
    await utimes(v.graphPath, later, later);
    nowMs += 10_000;
    expect((await graph()).body.nodes).toHaveLength(2);
    let labels: string[] = [];
    for (let i = 0; i < 100 && labels[0] !== "renamed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      nowMs += 10_000;
      labels = (await graph()).body.nodes.map((n) => n.label);
    }
    expect(labels).toEqual(["renamed"]);
  });

  it("reports where parsing runs under /api/health", async () => {
    const v = await makeVault();
    scratch = v.scratch;
    const feature = createBrainFeature({ vaultRoot: v.vault, cacheDir: join(v.scratch, "data") });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    type Health = { features: { brain?: { worker: { mode: string | null; failures: number } } } };
    const health = async (): Promise<Health> => (await (await fetch(`${b.base}/api/health`)).json()) as Health;
    expect((await health()).features.brain?.worker).toEqual({ mode: null, failures: 0 });
    expect((await fetch(`${b.base}/api/brain/graph?limit=10`)).status).toBe(200);
    expect((await health()).features.brain?.worker).toEqual({ mode: "worker", failures: 0 });
  });
});
