import { describe, expect, it } from "vitest";
import { parseUsageLine } from "../features/usage-parse.js";

describe("parseUsageLine", () => {
  it("reads model, message id, and the full usage block (incl. cache_read + the 5m/1h split) off an assistant line", () => {
    const raw = JSON.stringify({
      type: "assistant",
      cwd: "/ws/proj",
      timestamp: "2026-09-24T08:00:00.000Z",
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 2,
          output_tokens: 560,
          cache_read_input_tokens: 25_664,
          cache_creation_input_tokens: 57_012, // present alongside the split; the split wins
          cache_creation: { ephemeral_1h_input_tokens: 57_012, ephemeral_5m_input_tokens: 3 },
        },
      },
    });
    const facts = parseUsageLine(raw);
    expect(facts).toEqual({
      cwd: "/ws/proj",
      atMs: Date.parse("2026-09-24T08:00:00.000Z"),
      isAssistant: true,
      model: "claude-opus-5-5",
      messageId: "msg_1",
      tokens: { inputTokens: 2, outputTokens: 560, cacheWrite5mTokens: 3, cacheWrite1hTokens: 57_012, cacheReadTokens: 25_664 },
    });
  });

  it("falls back to the flat cache_creation_input_tokens as a 5m write when there's no TTL split", () => {
    const raw = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-24T08:00:00.000Z",
      message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 40 } },
    });
    const facts = parseUsageLine(raw)!;
    expect(facts.tokens).toEqual({ inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 40, cacheWrite1hTokens: 0, cacheReadTokens: 0 });
  });

  it("an assistant line with no usage block has null tokens but still reports the model", () => {
    const raw = JSON.stringify({ type: "assistant", timestamp: "t", message: { id: "m", model: "claude-sonnet-5" } });
    expect(parseUsageLine(raw)).toEqual({ cwd: null, atMs: null, isAssistant: true, model: "claude-sonnet-5", messageId: "m", tokens: null });
  });

  it("a user line carries cwd/timestamp but no model/tokens", () => {
    const raw = JSON.stringify({ type: "user", cwd: "/ws/proj", timestamp: "2026-09-24T08:00:00.000Z", message: { role: "user", content: "hi" } });
    expect(parseUsageLine(raw)).toEqual({ cwd: "/ws/proj", atMs: Date.parse("2026-09-24T08:00:00.000Z"), isAssistant: false, model: null, messageId: null, tokens: null });
  });

  it("a blank line is not malformed", () => {
    expect(parseUsageLine("")).toEqual({ cwd: null, atMs: null, isAssistant: false, model: null, messageId: null, tokens: null });
    expect(parseUsageLine("   \n")).toEqual({ cwd: null, atMs: null, isAssistant: false, model: null, messageId: null, tokens: null });
  });

  it("invalid JSON returns null (malformed), never throws", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });

  it("well-formed but non-object JSON (e.g. a bare string or array) is treated as an empty, non-assistant line", () => {
    expect(parseUsageLine('"hello"')).toEqual({ cwd: null, atMs: null, isAssistant: false, model: null, messageId: null, tokens: null });
    expect(parseUsageLine("[1,2,3]")).toEqual({ cwd: null, atMs: null, isAssistant: false, model: null, messageId: null, tokens: null });
  });

  it("an unparseable timestamp yields atMs: null without discarding the rest of the line", () => {
    const raw = JSON.stringify({ type: "user", cwd: "/ws/proj", timestamp: "not-a-date", message: { role: "user", content: "hi" } });
    expect(parseUsageLine(raw)?.atMs).toBeNull();
  });
});
