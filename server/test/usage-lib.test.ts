import { describe, expect, it } from "vitest";
import {
  activeMsForGap,
  activeMsFromEvents,
  costForModel,
  IDLE_GAP_MS,
  INITIAL_CURSOR,
  normalizeModelId,
  priceForModel,
  reduceLine,
  ZERO_TOKENS,
  type TokenBucket,
} from "../../shared/features/usage.js";
import { parseUsageLine } from "../features/usage-parse.js";

function tokens(partial: Partial<TokenBucket>): TokenBucket {
  return { ...ZERO_TOKENS, ...partial };
}

describe("costForModel", () => {
  it("prices input/output tokens for a known model", () => {
    const { costUsd, unpricedTokens } = costForModel("claude-sonnet-5", tokens({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(costUsd).toBeCloseTo(2.0 + 10.0, 6);
    expect(unpricedTokens).toBe(0);
  });

  it("prices cache write (5m + 1h) and cache read tokens at their own multipliers", () => {
    const { costUsd } = costForModel(
      "claude-sonnet-5",
      tokens({ cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
    );
    // sonnet-5 input $2/MTok: 5m write 1.25x=$2.50, 1h write 2x=$4.00, read 0.1x=$0.20
    expect(costUsd).toBeCloseTo(2.5 + 4.0 + 0.2, 6);
  });

  it("applies a model-specific cache-read override (Opus 5.5: 0.05x, not the 0.1x default)", () => {
    const { costUsd } = costForModel("claude-opus-5-5", tokens({ cacheReadTokens: 1_000_000 }));
    expect(costUsd).toBeCloseTo(4.0 * 0.05, 6);
  });

  it("returns null cost + the full unpriced token count for an unknown model — never guesses", () => {
    const t = tokens({ inputTokens: 10, outputTokens: 20, cacheWrite5mTokens: 3, cacheWrite1hTokens: 4, cacheReadTokens: 5 });
    const { costUsd, unpricedTokens } = costForModel("claude-nonexistent-9", t);
    expect(costUsd).toBeNull();
    expect(unpricedTokens).toBe(10 + 20 + 3 + 4 + 5);
  });

  it("an empty (zero) token bucket on a known model costs exactly $0, not null", () => {
    expect(costForModel("claude-haiku-4-5", ZERO_TOKENS)).toEqual({ costUsd: 0, unpricedTokens: 0 });
  });

  it("prices Claude Code's <synthetic> placeholder turns at exactly $0, never 'unpriced'", () => {
    // A real transcript line (2026-09-19, trimmed): Claude Code writes these itself, they never reach the API.
    const raw = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-19T15:48:39.676Z",
      cwd: "/Users/alexboghossian",
      sessionId: "805bf816-cb11-4843-9b6e-aba3da2ff3df",
      isApiErrorMessage: false,
      message: {
        id: "90324123-4a02-4072-80b5-ff83b7b009a3",
        model: "<synthetic>",
        role: "assistant",
        stop_reason: "stop_sequence",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } },
        content: [{ type: "text", text: "No response requested." }],
      },
    });
    const facts = parseUsageLine(raw);
    const delta = facts ? reduceLine(INITIAL_CURSOR, facts).tokenDelta : null;
    expect(delta?.model).toBe("<synthetic>"); // the store records it, as usage.db's 35 real rows show
    expect(costForModel(delta?.model ?? "", delta?.tokens ?? ZERO_TOKENS)).toEqual({ costUsd: 0, unpricedTokens: 0 });
    expect(priceForModel("<synthetic>")).not.toBeNull();
  });

  it("normalizeModelId strips a dated-snapshot or [alias] suffix so it still resolves", () => {
    expect(normalizeModelId("claude-opus-4-6-20260115")).toBe("claude-opus-4-6");
    expect(normalizeModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
    expect(priceForModel("claude-sonnet-5[1m]")).toEqual(priceForModel("claude-sonnet-5"));
  });

  it("claude-sonnet-5-5 carries the official 2026-09-29 price ($2 in, $10 out, $0.20 cache hit, $2.50 / $4 cache write)", () => {
    expect(priceForModel("claude-sonnet-5-5")).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 });
    expect(priceForModel("claude-sonnet-5-5[1m]")).toEqual(priceForModel("claude-sonnet-5-5"));
  });
});

describe("idle-gap active time", () => {
  it("activeMsForGap counts a gap up to the cutoff, caps a longer one, and floors a first/backwards event at 0", () => {
    expect(activeMsForGap(null, 1000)).toBe(0); // first event ever: nothing to span yet
    expect(activeMsForGap(1000, 1000 + 60_000)).toBe(60_000); // 1 min < 5 min cutoff: counted in full
    expect(activeMsForGap(1000, 1000 + 20 * 60_000)).toBe(IDLE_GAP_MS); // 20 min idle: capped at 5
    expect(activeMsForGap(5000, 1000)).toBe(0); // out of order: never negative
  });

  it("activeMsFromEvents sums capped gaps across a whole (empty or single-event) session", () => {
    expect(activeMsFromEvents([])).toBe(0); // empty session
    expect(activeMsFromEvents([1000])).toBe(0); // a single event spans nothing
    const base = 1_000_000;
    expect(activeMsFromEvents([base, base + 60_000, base + 120_000, base + 120_000 + 20 * 60_000])).toBe(60_000 + 60_000 + IDLE_GAP_MS);
  });
});

describe("reduceLine", () => {
  const model = "claude-sonnet-5";
  const t = tokens({ inputTokens: 100, outputTokens: 10 });

  it("counts a new turn's tokens and advances the gap/cursor", () => {
    const r = reduceLine(INITIAL_CURSOR, { atMs: 1000, model, messageId: "m1", tokens: t });
    expect(r.tokenDelta).toEqual({ model, tokens: t });
    expect(r.activeMsDelta).toBe(0); // first event: nothing to span yet
    expect(r.next).toEqual({ lastMessageId: "m1", lastEventMs: 1000 });
  });

  it("does not double-count a turn streamed across several lines with the same message.id", () => {
    const first = reduceLine(INITIAL_CURSOR, { atMs: 1000, model, messageId: "m1", tokens: t });
    const second = reduceLine(first.next, { atMs: 1200, model, messageId: "m1", tokens: t }); // same id, same cumulative usage
    expect(second.tokenDelta).toBeNull();
    expect(second.activeMsDelta).toBe(200); // time still advances even when tokens don't
  });

  it("counts a later turn with a new message.id after the first", () => {
    const first = reduceLine(INITIAL_CURSOR, { atMs: 1000, model, messageId: "m1", tokens: t });
    const second = reduceLine(first.next, { atMs: 61_000, model, messageId: "m2", tokens: t });
    expect(second.tokenDelta).toEqual({ model, tokens: t });
    expect(second.activeMsDelta).toBe(60_000);
  });

  it("caps a long idle gap between two turns at IDLE_GAP_MS", () => {
    const first = reduceLine(INITIAL_CURSOR, { atMs: 0, model, messageId: "m1", tokens: t });
    const second = reduceLine(first.next, { atMs: 30 * 60_000, model, messageId: "m2", tokens: t });
    expect(second.activeMsDelta).toBe(IDLE_GAP_MS);
  });

  it("a non-assistant line (no model/tokens/messageId) still advances the time cursor", () => {
    const first = reduceLine(INITIAL_CURSOR, { atMs: 1000, model: null, messageId: null, tokens: null });
    expect(first.tokenDelta).toBeNull();
    expect(first.next.lastEventMs).toBe(1000);
    const second = reduceLine(first.next, { atMs: 2000, model: null, messageId: null, tokens: null });
    expect(second.activeMsDelta).toBe(1000);
  });

  it("a line with no timestamp is a pure no-op (cursor unchanged)", () => {
    const r = reduceLine(INITIAL_CURSOR, { atMs: null, model, messageId: "m1", tokens: t });
    expect(r).toEqual({ next: INITIAL_CURSOR, activeMsDelta: 0, tokenDelta: null });
  });

  it("an empty session (no lines at all) never leaves the initial cursor", () => {
    expect(INITIAL_CURSOR).toEqual({ lastMessageId: null, lastEventMs: null });
  });

  it("re-feeding the last-committed line against the cursor it produced is a safe no-op (the backfill resumes exactly there, never earlier)", () => {
    const step = reduceLine(INITIAL_CURSOR, { atMs: 1000, model, messageId: "m1", tokens: t });
    const replay = reduceLine(step.next, { atMs: 1000, model, messageId: "m1", tokens: t });
    expect(replay.tokenDelta).toBeNull();
    expect(replay.activeMsDelta).toBe(0);
    expect(replay.next).toEqual(step.next);
  });
});
