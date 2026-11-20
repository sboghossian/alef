import { describe, expect, it } from "vitest";
import { lateExtra } from "./late-extra";

/** A load whose answer the test hands over when it wants to. */
function deferredLoads<T>(): { load: () => Promise<T | null>; answer: (i: number, v: T | null) => Promise<void> } {
  const pending: Array<(v: T | null) => void> = [];
  return {
    load: () => new Promise<T | null>((r) => pending.push(r)),
    answer: async (i, v) => {
      pending[i]?.(v);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("lateExtra", () => {
  it("applies the loaded state, then replays merge pushes that landed while it was in flight", async () => {
    const state = new Map<string, string>();
    const d = deferredLoads<Record<string, string>>();
    const x = lateExtra(d.load, (v) => {
      for (const [k, s] of Object.entries(v)) state.set(k, s);
    });
    x.refresh();
    x.push("merge", () => state.set("a", "working")); // newer than the answer below
    expect(state.get("a")).toBe("working"); // applied at once
    await d.answer(0, { a: "idle", b: "idle" });
    expect(Object.fromEntries(state)).toEqual({ a: "working", b: "idle" });
  });

  it("drops an in-flight answer once a replace push carried the whole state", async () => {
    let state = "none";
    const d = deferredLoads<string>();
    const x = lateExtra(d.load, (v) => (state = v));
    x.refresh();
    x.push("replace", () => (state = "pushed"));
    await d.answer(0, "stale");
    expect(state).toBe("pushed");
  });

  it("only the newest refresh's answer counts; a failed load (null) changes nothing", async () => {
    const seen: string[] = [];
    const d = deferredLoads<string>();
    const x = lateExtra(d.load, (v) => seen.push(v));
    x.refresh();
    x.refresh();
    await d.answer(0, "old");
    await d.answer(1, null);
    expect(seen).toEqual([]);
    x.refresh();
    await d.answer(2, "fresh");
    expect(seen).toEqual(["fresh"]);
  });

  it("a push with no refresh in flight is just applied, never replayed", async () => {
    let n = 0;
    const d = deferredLoads<number>();
    const x = lateExtra(d.load, () => undefined);
    x.push("merge", () => n++);
    x.refresh();
    await d.answer(0, 1);
    expect(n).toBe(1);
  });
});
