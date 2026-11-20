// Alef's local voice: one persistent Piper worker (scripts/piper-worker.py in .venv-piper) that
// loads the voice once and then writes each sentence to a wav in ~0.1 s. Shared by the tts route
// and the voice brain. The worker exits by itself when its stdin closes (server restart/exit).
// Install (once): python3.12 -m venv .venv-piper && .venv-piper/bin/pip install piper-tts, and the
// voice files in data/piper/ (see data/piper/LICENSE-NOTE.md). Voice: ALEF_PIPER_VOICE, default
// en_GB-northern_english_male-medium (rhasspy/piper-voices, dataset CC BY-SA 4.0).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../http.js";
import { LineSplitter } from "./chat-lib.js";
import { piperPaths, piperRequestLine, piperWorkerArgs, type PiperPaths } from "./voice-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface PiperEngine {
  /** Venv python, worker script and voice model all present. */
  available(): boolean;
  /** Writes `text` as a wav to `outPath`. Rejects on worker failure/timeout. */
  synthesize(text: string, outPath: string): Promise<void>;
  voice(): string;
  close(): void;
}

type Spawn = (cmd: string, args: readonly string[]) => ChildProcess;

const realSpawn: Spawn = (cmd, args) => spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"] });

interface Waiter {
  resolve(): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPiperEngine(paths: PiperPaths, spawnImpl: Spawn = realSpawn, exists: (p: string) => boolean = existsSync): PiperEngine {
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let seq = 0;
  const waiters = new Map<string, Waiter>();

  const failAll = (err: Error): void => {
    for (const w of waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    waiters.clear();
  };

  const start = (): Promise<void> => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      const proc = spawnImpl(paths.python, piperWorkerArgs(paths));
      child = proc;
      const lines = new LineSplitter(64 * 1024);
      let isReady = false;
      const readyTimer = setTimeout(() => {
        if (!isReady) {
          reject(new Error("piper worker did not start in time"));
          proc.kill();
        }
      }, READY_TIMEOUT_MS);
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) {
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(msg)) continue;
          if (msg.ready === true) {
            isReady = true;
            clearTimeout(readyTimer);
            resolve();
          } else if (msg.ready === false) {
            clearTimeout(readyTimer);
            reject(new Error(typeof msg.error === "string" ? msg.error : "piper worker failed to load"));
          } else if (typeof msg.id === "string") {
            const w = waiters.get(msg.id);
            if (!w) continue;
            waiters.delete(msg.id);
            clearTimeout(w.timer);
            if (msg.ok === true) w.resolve();
            else w.reject(new Error(typeof msg.error === "string" ? msg.error : "piper synthesis failed"));
          }
        }
      });
      proc.stderr?.on("data", () => {
        // onnxruntime warnings; failures arrive as JSON on stdout
      });
      proc.stdin?.on("error", () => {
        // EPIPE if the worker died; the exit handler reports it
      });
      const onGone = (why: string): void => {
        clearTimeout(readyTimer);
        if (child === proc) {
          child = null;
          ready = null;
        }
        failAll(new Error(why));
        reject(new Error(why));
      };
      proc.on("error", (err) => onGone(`piper worker failed: ${String(err)}`));
      proc.on("exit", (code) => onGone(`piper worker exited (${code ?? "signal"})`));
    });
    // A failed start must not poison later attempts.
    ready.catch(() => {
      ready = null;
    });
    return ready;
  };

  return {
    available() {
      return exists(paths.python) && exists(paths.script) && exists(paths.model);
    },
    voice() {
      return paths.model.split("/").pop()?.replace(/\.onnx$/, "") ?? "piper";
    },
    async synthesize(text, outPath) {
      await start();
      const proc = child;
      if (!proc?.stdin) throw new Error("piper worker is not running");
      const id = `r${++seq}`;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error("piper synthesis timed out"));
        }, REQUEST_TIMEOUT_MS);
        waiters.set(id, { resolve, reject, timer });
        proc.stdin?.write(piperRequestLine(id, text, outPath));
      });
    },
    close() {
      failAll(new Error("piper engine closed"));
      child?.stdin?.end();
      child?.kill();
      child = null;
      ready = null;
    },
  };
}

/** The process-wide engine (voice from ALEF_PIPER_VOICE, default en_GB-northern_english_male-medium). */
export const piperEngine: PiperEngine = createPiperEngine(piperPaths(REPO_ROOT, process.env.ALEF_PIPER_VOICE || undefined));

/** data/voice-tmp next to the world db (the OS temp dir for in-memory test dbs). */
export function voiceTmpDir(dbPath: string): string {
  return dbPath === ":memory:" ? join(tmpdir(), "agent-world-voice-tmp") : join(dirname(dbPath), "voice-tmp");
}

/** Piper is on unless ALEF_PIPER=0 (tests) or the venv/voice isn't installed. */
export function piperEnabled(engine: PiperEngine = piperEngine): boolean {
  return process.env.ALEF_PIPER !== "0" && engine.available();
}
