// IO half of the Atlas's Jev step (pure half: atlas-jev-lib.ts). One filer per world db: it holds
// the verdict cache (data/atlas-jev.json next to world.db, like topics.json), answers lookups from
// it synchronously during a build, and asks Jev in the background for at most `perBuild` uncached
// leaves per build, one batched TypeSafe Choice call through the shared client (director.ts's
// callJev, the same endpoint/auth/timeout as ask-jev, council and topics).
//
// Never in a request's path: a build only reads the cache, then request() starts one batch if none
// is running; its answers show on a later build. A complete build (no source pending or failed)
// prunes the cache to the leaves that still exist, so renamed or removed leaves don't pile up.
// The cache starts empty only when its file doesn't exist yet (ENOENT). Any other read error
// leaves the filer unloaded: Jev reads "unavailable", nothing is asked, pruned or saved (so a
// transient error can't overwrite a good cache with an empty one), and the next build retries;
// that is logged once when it starts and once when the file reads again, not on every build.
// A file that reads but isn't a cache is set aside before starting empty, never dropped:
// <cache>.corrupt-<ms>-<n> when it doesn't parse (or has no version), <cache>.v<version>-<ms>-<n>
// when it's another version's; `n` keeps two in one millisecond apart, and only the
// ASIDE_KEEP newest copies are kept. Saves write a pid-named temp file, then rename.
// No key, a thrown call, a timeout or a non-200 all end the same way: the leaf reads
// "Jev unavailable" until the retry (JEV_RETRY_MS) is due, and the atlas still answers 200.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { callJev, TIMEOUT_MS, type FetchLike } from "../director.js";
import type { log as logger } from "../log.js";
import { DEPARTMENTS } from "./atlas-lib.js";
import { buildJevBody, emptyJevCache, JEV_MAX_ATTEMPTS, JEV_PER_BUILD, jevKey, parseJevAnswers, parseJevCache, type JevAsk, type JevCacheFile, type JevLookup } from "./atlas-jev-lib.js";

/** A failed or empty call is retried no sooner than this. */
export const JEV_RETRY_MS = 10 * 60_000;
/** Set-aside copies of unusable cache files kept (newest first); older ones are deleted. */
export const ASIDE_KEEP = 3;

export interface AtlasJevOptions {
  /** The cache file. */
  path: string;
  /** Read at each use: "" = no key (Jev unavailable). */
  apiKey: () => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  perBuild?: number;
  retryMs?: number;
  now?: () => number;
  log: Pick<typeof logger, "info" | "warn">;
}

export interface AtlasJev {
  /** Reads the cache file until one read succeeds (missing = empty; unreadable = retried next time). */
  load(): Promise<void>;
  lookup(ask: JevAsk): JevLookup;
  /** Starts one background batch for the first `perBuild` uncached asks, unless one is running,
   *  Jev is unavailable, or nothing is uncached. Never throws, never waits. */
  request(asks: readonly JevAsk[]): void;
  /** Drops every cached verdict and attempt count whose key isn't in `keep` (the keys of every
   *  leaf that exists now); saves only when something was dropped. Returns how many were. */
  prune(keep: ReadonlySet<string>): number;
  /** Resolves once no batch is running and every save has landed (tests; a clean shutdown). */
  idle(): Promise<void>;
  /** Batched calls made and leaves asked since boot. */
  readonly stats: { calls: number; asked: number };
}

export function createAtlasJev(opts: AtlasJevOptions): AtlasJev {
  const now = opts.now ?? Date.now;
  const perBuild = Math.max(1, opts.perBuild ?? JEV_PER_BUILD);
  const retryMs = opts.retryMs ?? JEV_RETRY_MS;
  let file: JevCacheFile = emptyJevCache();
  /** A read succeeded (or there was no file): only then may the filer ask, prune or save. */
  let loaded = false;
  let loading: Promise<void> | null = null;
  /** The last load failed to read: warned once, until a read succeeds. */
  let unreadable = false;
  let asideSeq = 0;
  let running: Promise<void> | null = null;
  /** Saves run one after another: a prune and a batch never write the temp file at once. */
  let saving: Promise<void> = Promise.resolve();
  const stats = { calls: 0, asked: 0 };

  const available = (): boolean => loaded && opts.apiKey() !== "" && now() >= file.retryAt;

  function persist(): Promise<void> {
    if (!loaded) return Promise.resolve(); // never overwrite a cache we couldn't read
    const tmp = `${opts.path}.${process.pid}.tmp`;
    const write = async (): Promise<void> => {
      await mkdir(dirname(opts.path), { recursive: true });
      await writeFile(tmp, JSON.stringify(file), "utf8");
      await rename(tmp, opts.path);
    };
    const next = saving.then(write);
    saving = next.catch(() => undefined);
    return next;
  }

  const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Moves the cache file to <cache>.<tag>-<ms>-<n> (a name not taken yet), then deletes all but
   *  the ASIDE_KEEP newest such copies. Returns the new name. */
  async function setAside(tag: string): Promise<string> {
    let aside: string | null = null;
    for (let i = 0; i < 100 && aside === null; i++) {
      const name = `${opts.path}.${tag}-${now()}-${asideSeq++}`;
      aside = await stat(name).then(
        () => null,
        () => name,
      );
    }
    if (aside === null) throw new Error("no free name to set the cache aside");
    await rename(opts.path, aside);
    const re = new RegExp(`^${escapeRe(basename(opts.path))}\\.(?:corrupt|v[A-Za-z0-9._]+)-(\\d+)-(\\d+)$`);
    const copies = (await readdir(dirname(opts.path)).catch(() => [] as string[]))
      .map((n) => {
        const m = re.exec(n);
        return m ? { n, ms: Number(m[1]), seq: Number(m[2]) } : null;
      })
      .filter((c): c is { n: string; ms: number; seq: number } => c !== null)
      .sort((a, b) => b.ms - a.ms || b.seq - a.seq);
    await Promise.all(copies.slice(ASIDE_KEEP).map((c) => rm(join(dirname(opts.path), c.n), { force: true }).catch(() => undefined)));
    return aside;
  }

  async function batch(todo: readonly JevAsk[]): Promise<void> {
    const at = new Date(now()).toISOString();
    try {
      const { body, keys } = buildJevBody(todo, DEPARTMENTS);
      stats.calls += 1;
      stats.asked += todo.length;
      const raw = await callJev(opts.apiKey(), body, opts.fetchImpl ?? (globalThis.fetch as FetchLike), opts.timeoutMs ?? TIMEOUT_MS * 3);
      const answers = parseJevAnswers(raw, keys);
      todo.forEach((ask, i) => {
        const k = jevKey(ask);
        const a = answers.get(i);
        if (a) {
          file.entries[k] = { name: ask.name, dept: a.dept, confidence: a.confidence, at };
          delete file.attempts[k];
          return;
        }
        const n = (file.attempts[k] ?? 0) + 1;
        if (n >= JEV_MAX_ATTEMPTS) {
          file.entries[k] = { name: ask.name, dept: null, confidence: 0, at };
          delete file.attempts[k];
        } else file.attempts[k] = n;
      });
      if (answers.size === 0) file.retryAt = now() + retryMs;
      opts.log.info("atlas", `jev filed ${answers.size}/${todo.length} leaves`);
    } catch (err) {
      file.retryAt = now() + retryMs;
      opts.log.warn("atlas", "jev call failed: unfiled leaves read 'Jev unavailable' until the retry", String(err));
    }
    try {
      await persist();
    } catch (err) {
      opts.log.warn("atlas", "jev cache not saved", String(err));
    }
  }

  return {
    load() {
      if (loaded) return Promise.resolve();
      loading ??= (async () => {
        let text: string;
        try {
          text = await readFile(opts.path, "utf8");
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            loaded = true; // first run: empty
            return;
          }
          if (!unreadable) opts.log.warn("atlas", "jev cache unreadable: Jev off and nothing saved until it reads", String(err));
          unreadable = true;
          return;
        }
        if (unreadable) opts.log.info("atlas", "jev cache reads again");
        unreadable = false;
        let raw: unknown = null;
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          /* not JSON: set aside below */
        }
        const version = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).version : undefined;
        if (version !== 1) {
          const tag = version === undefined ? "corrupt" : `v${String(version).replace(/[^A-Za-z0-9._]/g, "_").slice(0, 20)}`;
          try {
            const aside = await setAside(tag);
            opts.log.warn("atlas", `jev cache ${tag === "corrupt" ? "didn't parse" : `is version ${String(version)}`}: kept as ${basename(aside)}, starting empty`);
            loaded = true;
          } catch (err) {
            opts.log.warn("atlas", "jev cache isn't usable and couldn't be set aside: Jev off until it can", String(err));
          }
          return;
        }
        file = parseJevCache(raw);
        loaded = true;
      })().finally(() => {
        loading = null;
      });
      return loading;
    },
    lookup(ask) {
      const e = file.entries[jevKey(ask)];
      if (e) return { kind: "answer", dept: e.dept, confidence: e.confidence };
      return available() ? { kind: "pending" } : { kind: "unavailable" };
    },
    request(asks) {
      if (running || !available()) return;
      const seen = new Set<string>();
      const todo: JevAsk[] = [];
      for (const a of asks) {
        const k = jevKey(a);
        if (seen.has(k) || file.entries[k]) continue;
        seen.add(k);
        todo.push(a);
        if (todo.length >= perBuild) break;
      }
      if (!todo.length) return;
      running = batch(todo).finally(() => {
        running = null;
      });
    },
    prune(keep) {
      if (!loaded) return 0;
      let dropped = 0;
      for (const k of Object.keys(file.entries)) {
        if (!keep.has(k)) {
          delete file.entries[k];
          dropped++;
        }
      }
      for (const k of Object.keys(file.attempts)) {
        if (!keep.has(k)) {
          delete file.attempts[k];
          dropped++;
        }
      }
      if (dropped > 0) {
        opts.log.info("atlas", `jev cache: pruned ${dropped} verdict(s) of leaves that no longer exist`);
        persist().catch((err: unknown) => opts.log.warn("atlas", "jev cache not saved", String(err)));
      }
      return dropped;
    },
    async idle() {
      await (running ?? Promise.resolve());
      await saving;
    },
    stats,
  };
}
