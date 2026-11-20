// Small in-memory caches for slow read-only endpoints. Pure (no IO); the clock is injectable
// so tests can drive expiry.
//
// - TtlCache: bounded LRU of loader results, each valid for `ttlMs`. Concurrent `get`s for
//   the same key share ONE in-flight load (no thundering herd when the client fires the same
//   request from several panels). A failed load is never cached.
// - Swr: one value, stale-while-revalidate. `get` answers from the last good value at once
//   and starts a background refresh when it is older than `maxAgeMs`; only the very first
//   call (nothing cached yet) waits for the loader.

export interface TtlCacheOptions {
  ttlMs: number;
  max: number;
  now?: () => number;
}

export interface TtlCache<K, V> {
  get(key: K, load: () => Promise<V>): Promise<V>;
  delete(key: K): void;
  clear(): void;
  readonly size: number;
}

export function createTtlCache<K, V>(opts: TtlCacheOptions): TtlCache<K, V> {
  const now = opts.now ?? Date.now;
  const done = new Map<K, { at: number; value: V }>();
  const inflight = new Map<K, Promise<V>>();

  return {
    get(key, load) {
      const hit = done.get(key);
      if (hit && now() - hit.at < opts.ttlMs) {
        done.delete(key); // refresh LRU order
        done.set(key, hit);
        return Promise.resolve(hit.value);
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = (async () => {
        try {
          const value = await load();
          done.delete(key);
          done.set(key, { at: now(), value });
          while (done.size > opts.max) {
            const oldest = done.keys().next();
            if (oldest.done) break;
            done.delete(oldest.value);
          }
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    delete(key) {
      done.delete(key);
    },
    clear() {
      done.clear();
    },
    get size() {
      return done.size;
    },
  };
}

export interface Swr<V> {
  /** Last good value (refreshing in the background when older than `maxAgeMs`); waits only when empty. */
  get(maxAgeMs: number): Promise<V>;
  /** Forces a fresh load (deduped with any refresh already running). */
  refresh(): Promise<V>;
  /** Drops the value so the next `get` waits for a fresh load. */
  invalidate(): void;
  peek(): { at: number; value: V } | null;
}

export function createSwr<V>(load: () => Promise<V>, opts: { now?: () => number; onError?: (err: unknown) => void } = {}): Swr<V> {
  const now = opts.now ?? Date.now;
  let current: { at: number; value: V } | null = null;
  let inflight: Promise<V> | null = null;

  function refresh(): Promise<V> {
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const value = await load();
        current = { at: now(), value };
        return value;
      } finally {
        inflight = null;
      }
    })();
    inflight = p;
    return p;
  }

  return {
    get(maxAgeMs) {
      if (!current) return refresh();
      if (now() - current.at >= maxAgeMs) {
        refresh().catch((err: unknown) => opts.onError?.(err));
      }
      return Promise.resolve(current.value);
    },
    refresh,
    invalidate() {
      current = null;
    },
    peek() {
      return current;
    },
  };
}

/** Lets pending IO callbacks and other requests run between chunks of CPU-heavy work. */
export function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
