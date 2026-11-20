import { describe, expect, it } from "vitest";
import { createSwr, createTtlCache } from "../features/cache-lib.js";

describe("createTtlCache", () => {
  it("shares one in-flight load, reuses it within the TTL, reloads after", async () => {
    let t = 0;
    let loads = 0;
    const c = createTtlCache<string, number>({ ttlMs: 100, max: 4, now: () => t });
    const load = async (): Promise<number> => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return loads;
    };
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    t = 50;
    expect(await c.get("k", load)).toBe(1);
    t = 200;
    expect(await c.get("k", load)).toBe(2);
  });
  it("is bounded (LRU) and never caches a failure", async () => {
    const c = createTtlCache<number, number>({ ttlMs: 1e9, max: 2 });
    for (const k of [1, 2, 3]) await c.get(k, async () => k);
    expect(c.size).toBe(2);
    await expect(c.get(9, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await c.get(9, async () => 9)).toBe(9);
  });
});

describe("createSwr", () => {
  it("waits only when empty, then answers stale at once and refreshes in the background", async () => {
    let t = 0;
    let n = 0;
    let release: (() => void) | null = null;
    const swr = createSwr(
      async () => {
        n += 1;
        if (n > 1) await new Promise<void>((r) => (release = r));
        return n;
      },
      { now: () => t },
    );
    expect(await swr.get(1000)).toBe(1);
    t = 5000;
    const started = Date.now();
    expect(await swr.get(1000)).toBe(1); // stale value, immediately
    expect(Date.now() - started).toBeLessThan(50);
    expect(await swr.get(1000)).toBe(1); // refresh already running: not started twice
    expect(n).toBe(2);
    (release as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(swr.peek()?.value).toBe(2);
  });
});
