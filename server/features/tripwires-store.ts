// data/tripwires.jsonl: the lesson-tripwire hit log, so a hit survives a server restart.
//
// Append-only: every new hit is one JSON line (the TripwireHit itself), appended in the order the
// tracker found it. No line is ever rewritten and no file is renamed or deleted. When the current
// generation file reaches TRIPWIRES_ROTATE_BYTES the next append starts a new one: tripwires.jsonl,
// then tripwires.1.jsonl, tripwires.2.jsonl, … At boot the feature reads the newest two
// generations back (`load`, oldest line first) and folds them into its tracker
// (TripwireTracker.restore), which dedupes them exactly like live hits.
//
// data/ lives under ~/Documents (iCloud Drive), so every open is guarded, not just raced: stat()
// first refuses an evicted ("dataless") file or anything that isn't a regular file before open()
// is ever called, and a bounded race (archive.ts's withTimeout) is the second line of defence. An
// operation that timed out leaves its path "stalled": nothing opens that path again until the
// operation settles, so a stuck file pins at most one libuv thread. Appends run one at a time on a
// promise chain; a write that timed out may still land later, so it is counted as unconfirmed,
// never as written.

import { appendFile, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TripwireHit, TripwirePersistence } from "../../shared/features/tripwires.js";
import { isDataless, READ_TIMEOUT_MS, TIMED_OUT, withTimeout } from "./archive.js";
import { parseHitLines } from "./tripwires-lib.js";

/** A generation file this size or larger gets no more lines: the next append starts a new one. */
export const TRIPWIRES_ROTATE_BYTES = 5 * 1024 * 1024;

/** The fold never reads less than this of a generation (a tiny test rotation still reads whole lines). */
const READ_FLOOR_BYTES = 1024 * 1024;

const GEN_RE = /^tripwires(?:\.([1-9]\d{0,5}))?\.jsonl$/;

export function tripwiresFileName(gen: number): string {
  return gen === 0 ? "tripwires.jsonl" : `tripwires.${gen}.jsonl`;
}

/** The generation a file name belongs to, or null when it isn't one of ours. */
export function tripwiresGeneration(name: string): number | null {
  const m = GEN_RE.exec(name);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

type Guarded<T> = { ok: true; value: T } | { ok: false; error: string; ambiguous: boolean };

/** Runs one fs operation per path with a timeout; a timed-out path is refused until it settles. */
export class PathGuard {
  private readonly stalled = new Set<string>();

  constructor(private readonly timeoutMs: number) {}

  async run<T>(path: string, op: () => Promise<T>): Promise<Guarded<T>> {
    if (this.stalled.has(path)) return { ok: false, error: "an earlier read or write of it has not finished", ambiguous: false };
    const p = op();
    let r: T | typeof TIMED_OUT;
    try {
      r = await withTimeout(p, this.timeoutMs);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ambiguous: false };
    }
    if (r === TIMED_OUT) {
      this.stalled.add(path);
      const settle = (): void => void this.stalled.delete(path);
      p.then(settle, settle);
      return { ok: false, error: `timed out after ${this.timeoutMs} ms`, ambiguous: true };
    }
    return { ok: true, value: r };
  }
}

/** Size of a regular, locally present file; 0 when it doesn't exist. Refuses anything else. */
async function localFileSize(path: string): Promise<number> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  if (!st.isFile()) throw new Error("not a regular file");
  if (isDataless(st)) throw new Error("evicted to iCloud (dataless), not opened");
  return st.size;
}

/** The whole file, or only its last `max` bytes (from the first full line) when it is larger. */
async function readTail(path: string, max: number): Promise<string> {
  const size = await localFileSize(path);
  if (size <= max) return readFile(path, "utf8");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, size - max);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return text.slice(text.indexOf("\n") + 1);
  } finally {
    await fh.close();
  }
}

/** A text file read through the guard (stat first, bounded, never a dataless or special file). */
export async function readTextGuarded(guard: PathGuard, path: string, maxBytes: number): Promise<Guarded<string>> {
  return guard.run(path, () => readTail(path, maxBytes));
}

export interface TripwireStoreOptions {
  rotateBytes?: number;
  timeoutMs?: number;
}

export interface TripwireLoad {
  /** Hits from the newest two generations, oldest first (file order). */
  hits: TripwireHit[];
  errors: string[];
}

export class TripwireStore {
  private gen = 0;
  /** False when the data dir couldn't be listed at boot: the current generation is unknown, so
   *  nothing is appended (a line in the wrong generation would be missed by the next fold). */
  private writable = true;
  private chain: Promise<void> = Promise.resolve();
  private readonly guard: PathGuard;
  private readonly rotateBytes: number;
  private readonly state: Omit<TripwirePersistence, "file"> = { restored: 0, appended: 0, unconfirmed: 0, lastError: null };

  constructor(
    private readonly dataDir: string,
    opts: TripwireStoreOptions = {},
  ) {
    this.rotateBytes = opts.rotateBytes ?? TRIPWIRES_ROTATE_BYTES;
    this.guard = new PathGuard(opts.timeoutMs ?? READ_TIMEOUT_MS);
  }

  /** Finds the current generation and reads the newest two back. Never throws. */
  async load(): Promise<TripwireLoad> {
    const errors: string[] = [];
    const listed = await this.guard.run(this.dataDir, () => readdir(this.dataDir));
    if (!listed.ok) {
      // No data dir yet means no log yet (the first append creates it); anything else is worth saying.
      if (!/ENOENT/.test(listed.error)) {
        this.writable = false;
        errors.push(`couldn't list ${this.dataDir}: ${listed.error}`);
        this.state.lastError = errors[0]!;
      }
      return { hits: [], errors };
    }
    const gens = listed.value
      .map(tripwiresGeneration)
      .filter((g): g is number => g !== null)
      .sort((a, b) => a - b);
    this.gen = gens.length ? gens[gens.length - 1]! : 0;
    const hits: TripwireHit[] = [];
    for (const g of gens.filter((x) => x >= this.gen - 1)) {
      const name = tripwiresFileName(g);
      // A generation stops taking lines at rotateBytes (plus at most one batch), so this bounds
      // the read even for a file someone grew by hand.
      const r = await readTextGuarded(this.guard, join(this.dataDir, name), Math.max(this.rotateBytes * 2, READ_FLOOR_BYTES));
      if (!r.ok) {
        errors.push(`${name}: ${r.error}`);
        continue;
      }
      hits.push(...parseHitLines(r.value));
    }
    if (errors.length) this.state.lastError = errors[errors.length - 1]!;
    return { hits, errors };
  }

  noteRestored(n: number): void {
    this.state.restored = n;
  }

  /** Queues the hits (in the order given) behind every earlier append. Resolves when this batch is
   *  done either way; never rejects. The result is in `status()`. */
  append(hits: readonly TripwireHit[]): Promise<void> {
    if (hits.length === 0) return this.chain;
    const body = hits.map((h) => JSON.stringify(h)).join("\n") + "\n";
    const run = async (): Promise<void> => {
      if (!this.writable) {
        this.state.unconfirmed += hits.length;
        return;
      }
      const cur = join(this.dataDir, tripwiresFileName(this.gen));
      let r: Guarded<boolean> = await this.guard.run(cur, async () => {
        if ((await localFileSize(cur)) >= this.rotateBytes) return false; // full: start the next generation
        await mkdir(this.dataDir, { recursive: true });
        await appendFile(cur, body, "utf8");
        return true;
      });
      let name = tripwiresFileName(this.gen);
      if (r.ok && !r.value) {
        this.gen += 1;
        name = tripwiresFileName(this.gen);
        const next = join(this.dataDir, name);
        r = await this.guard.run(next, async () => {
          await localFileSize(next); // refuses a dataless or special file that happens to hold the name
          await appendFile(next, body, "utf8");
          return true;
        });
      }
      if (r.ok) this.state.appended += hits.length;
      else {
        this.state.unconfirmed += hits.length;
        this.state.lastError = `${name}: ${r.error}${r.ambiguous ? " (the write may still land)" : ""}`;
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /** Resolves once every append queued so far has finished (each is bounded by the guard). */
  settled(): Promise<void> {
    return this.chain;
  }

  status(): TripwirePersistence {
    return { file: tripwiresFileName(this.gen), ...this.state };
  }
}
