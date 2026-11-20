// Runs brain-jobs.ts jobs on one lazily started worker thread (brain-worker.ts, booted through the
// plain-JS brain-worker-boot.mjs, which registers tsx for that thread), so their CPU never lands on
// the event loop. When a worker can't start, jobs run in-process and the start is retried with
// backoff (30 s, doubling, capped at 30 min) instead of giving up for the life of the server; the
// current mode and the last failure are served under /api/health. The worker holds no state
// between jobs and exits after ten quiet minutes.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { runBrainJob, type BrainJob, type BrainJobResult } from "./brain-jobs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const IDLE_EXIT_MS = 10 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

export type BrainWorkerMode = "worker" | "in-process";

export interface BrainWorkerStatus {
  /** "worker" once a worker answered, "in-process" while a failed start waits for its retry, null before either. */
  mode: BrainWorkerMode | null;
  /** Consecutive failed starts (0 once a worker came up). */
  failures: number;
  /** Why the last start failed, while running in-process. */
  reason?: string;
  /** ISO time of the next start attempt, while running in-process. */
  retryAt?: string;
}

export interface BrainJobRunner {
  run<J extends BrainJob>(job: J): Promise<BrainJobResult<J>>;
  /** "worker" once a worker answered, "in-process" while a failed start waits for its retry, null before either. */
  mode(): BrainWorkerMode | null;
  status(): BrainWorkerStatus;
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  job: BrainJob;
}

type WorkerMessage = { ready: true } | { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** The parent's execArgv plus the tsx loader when the parent wasn't started through it (vitest). The
 *  boot entry registers tsx for the thread itself; this only keeps the loader global where Node allows it. */
export function workerExecArgv(parentArgv: readonly string[] = process.execArgv, repoRoot: string = REPO_ROOT): string[] {
  if (parentArgv.some((a) => a.includes("tsx"))) return [...parentArgv];
  const loader = join(repoRoot, "node_modules", "tsx", "dist", "esm", "index.mjs");
  return existsSync(loader) ? [...parentArgv, "--import", pathToFileURL(loader).href] : [...parentArgv];
}

export interface BrainJobRunnerOptions {
  /** Called on every failed start (backoff keeps these rare), with the delay before the next try. */
  onFallback?: (reason: string, retryInMs: number) => void;
  entry?: URL;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  idleExitMs?: number;
}

export function createBrainJobRunner(opts: BrainJobRunnerOptions = {}): BrainJobRunner {
  const entry = opts.entry ?? new URL("./brain-worker-boot.mjs", import.meta.url);
  const now = opts.now ?? Date.now;
  const retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
  const idleExitMs = opts.idleExitMs ?? IDLE_EXIT_MS;
  let worker: Worker | null = null;
  let mode: BrainWorkerMode | null = null;
  let failures = 0;
  let reason: string | undefined;
  let retryAt: number | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let idleTimer: NodeJS.Timeout | null = null;

  function inProcess<J extends BrainJob>(job: J): Promise<BrainJobResult<J>> {
    return runBrainJob(job);
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (pending.size > 0 || !worker) return;
    idleTimer = setTimeout(() => void stopWorker(), idleExitMs);
    idleTimer.unref();
  }

  async function stopWorker(): Promise<void> {
    const w = worker;
    worker = null;
    if (w) await w.terminate().catch(() => undefined);
  }

  function failAll(err: unknown): void {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  function start(): Worker {
    const w = new Worker(entry, { execArgv: workerExecArgv() });
    let up = false;
    w.unref();
    w.on("message", (msg: WorkerMessage) => {
      if ("ready" in msg) {
        up = true;
        mode = "worker";
        failures = 0;
        reason = undefined;
        retryAt = null;
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      armIdle();
    });
    const onDead = (err: unknown): void => {
      if (worker !== w) return;
      worker = null;
      if (!up) {
        // Never came up: run what was waiting in-process, and everything until the retry.
        failures += 1;
        reason = String(err);
        const delay = Math.min(retryBaseMs * 2 ** (failures - 1), retryMaxMs);
        retryAt = now() + delay;
        mode = "in-process";
        opts.onFallback?.(reason, delay);
        const waiting = [...pending.values()];
        pending.clear();
        for (const p of waiting) runBrainJob(p.job).then(p.resolve, p.reject);
        return;
      }
      failAll(err instanceof Error ? err : new Error(String(err)));
    };
    w.on("error", onDead);
    w.on("exit", (code) => onDead(new Error(`brain worker exited (${code})`)));
    return w;
  }

  return {
    run<J extends BrainJob>(job: J): Promise<BrainJobResult<J>> {
      if (retryAt !== null && now() < retryAt) return inProcess(job);
      if (!worker) worker = start();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const id = nextId++;
      const w = worker;
      return new Promise<BrainJobResult<J>>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, job });
        w.postMessage({ id, job });
      });
    },
    mode: () => mode,
    status(): BrainWorkerStatus {
      if (mode !== "in-process" || retryAt === null) return { mode, failures };
      return { mode, failures, ...(reason ? { reason } : {}), retryAt: new Date(retryAt).toISOString() };
    },
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      await stopWorker();
    },
  };
}
