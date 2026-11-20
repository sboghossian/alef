import { afterEach, describe, expect, it } from "vitest";
import { ZERO_TOKENS, type TokenBucket } from "../../shared/features/usage.js";
import { UsageStore } from "../features/usage-store.js";

function tokens(partial: Partial<TokenBucket>): TokenBucket {
  return { ...ZERO_TOKENS, ...partial };
}

describe("UsageStore", () => {
  let store: UsageStore | null = null;
  afterEach(() => {
    store?.close();
    store = null;
  });

  it("addTokens is additive per (date, session, model) and readable back by day or by session", () => {
    store = new UsageStore(":memory:");
    store.addTokens("2026-09-24", "acme-ai-next", "s1", "claude-sonnet-5", tokens({ inputTokens: 10, outputTokens: 1 }));
    store.addTokens("2026-09-24", "acme-ai-next", "s1", "claude-sonnet-5", tokens({ inputTokens: 5 }));
    store.addTokens("2026-09-24", "acme-ai-next", "s1", "claude-haiku-4-5", tokens({ inputTokens: 100 }));

    const day = store.dayTokenRows("2026-09-24");
    expect(day).toHaveLength(2);
    const sonnetRow = day.find((r) => r.model === "claude-sonnet-5")!;
    expect(sonnetRow.tokens).toEqual(tokens({ inputTokens: 15, outputTokens: 1 }));

    const mix = store.sessionModelMix("s1");
    expect(mix.get("claude-sonnet-5")).toEqual(tokens({ inputTokens: 15, outputTokens: 1 }));
    expect(mix.get("claude-haiku-4-5")).toEqual(tokens({ inputTokens: 100 }));
    expect(store.dayTokenRows("2026-09-25")).toEqual([]); // a different day sees nothing
  });

  it("addActiveMs is additive per (date, session), ignores non-positive deltas, and sums across sessions for sessionActiveMs", () => {
    store = new UsageStore(":memory:");
    store.addActiveMs("2026-09-24", "acme-ai-next", "s1", 1000);
    store.addActiveMs("2026-09-24", "acme-ai-next", "s1", 2000);
    store.addActiveMs("2026-09-24", "acme-ai-next", "s1", 0); // no-op
    store.addActiveMs("2026-09-25", "acme-ai-next", "s1", 500); // a different day for the same session

    expect(store.dayTimeRows("2026-09-24")).toEqual([{ islandId: "acme-ai-next", sessionId: "s1", activeMs: 3000 }]);
    expect(store.sessionActiveMs("s1")).toBe(3500); // both days combined
  });

  it("getCursor/setCursor round-trips and never regresses last_event_ms across an out-of-order write", () => {
    store = new UsageStore(":memory:");
    expect(store.getCursor("s1")).toEqual({ lastMessageId: null, lastEventMs: null });
    store.setCursor("s1", { lastMessageId: "m1", lastEventMs: 5000 });
    expect(store.getCursor("s1")).toEqual({ lastMessageId: "m1", lastEventMs: 5000 });
    // A later write with an EARLIER lastEventMs (e.g. the backfill catching up on older
    // lines after the live path already advanced this session) must not move it backwards.
    store.setCursor("s1", { lastMessageId: "m0", lastEventMs: 1000 });
    expect(store.getCursor("s1").lastEventMs).toBe(5000);
  });

  it("sessionIslandId resolves from either table and is null for an unknown session", () => {
    store = new UsageStore(":memory:");
    expect(store.sessionIslandId("nope")).toBeNull();
    store.addActiveMs("2026-09-24", "acme-ai-next", "s1", 1000);
    expect(store.sessionIslandId("s1")).toBe("acme-ai-next");
  });

  it("file offset + meta round-trip (used by the backfill pass)", () => {
    store = new UsageStore(":memory:");
    expect(store.getFileOffset("/x.jsonl")).toBe(0);
    store.setFileOffset("/x.jsonl", 4096);
    expect(store.getFileOffset("/x.jsonl")).toBe(4096);
    expect(store.getMeta("backfill_done")).toBeNull();
    store.setMeta("backfill_done", "1");
    expect(store.getMeta("backfill_done")).toBe("1");
  });
});
