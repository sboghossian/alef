import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildUserMessage,
  emptyTrace,
  forkDecision,
  LineSplitter,
  parseStreamLine,
  safeFileName,
  sniffImage,
  TEXT_INLINE_MAX,
  traceEvent,
  turnVerdict,
  validateAttachment,
  type ValidAttachment,
} from "../features/chat-lib.js";

const SID = "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("buildClaudeArgs", () => {
  it("new chat: --session-id, stream-json both ways, --verbose, partials, model, mode, no prompts", () => {
    expect(buildClaudeArgs({ sessionId: SID, resume: false, fork: false, model: "haiku", mode: "plan" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", "haiku", "--permission-mode", "plan", "--permission-prompts", "none", "--session-id", SID,
    ]);
  });
  it("continue: --resume, fork adds --fork-session, normal → default", () => {
    const a = buildClaudeArgs({ sessionId: SID, resume: true, fork: false, model: "opus", mode: "normal" });
    expect(a.slice(-2)).toEqual(["--resume", SID]);
    expect(a).toContain("default");
    const f = buildClaudeArgs({ sessionId: SID, resume: true, fork: true, model: "sonnet", mode: "acceptEdits" });
    expect(f.slice(-3)).toEqual(["--resume", SID, "--fork-session"]);
    expect(f).toContain("acceptEdits");
  });
  it("fork is ignored for a brand-new session", () => {
    expect(buildClaudeArgs({ sessionId: SID, resume: false, fork: true, model: "haiku", mode: "normal" })).not.toContain("--fork-session");
  });
});

describe("LineSplitter", () => {
  it("joins partial lines across chunks and flushes the tail", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(":2}\n\n  \n")).toEqual(['{"b":2}']);
    expect(s.push('{"c":3}')).toEqual([]);
    expect(s.flush()).toEqual(['{"c":3}']);
    expect(s.flush()).toEqual([]);
  });
  it("drops a runaway unterminated line", () => {
    const s = new LineSplitter(10);
    s.push("x".repeat(50));
    expect(s.flush()).toEqual([]);
  });
});

describe("parseStreamLine", () => {
  it("ignores malformed, empty, non-object and unknown lines", () => {
    expect(parseStreamLine("{not json")).toEqual([]);
    expect(parseStreamLine("")).toEqual([]);
    expect(parseStreamLine("[1,2]")).toEqual([]);
    expect(parseStreamLine('"str"')).toEqual([]);
    expect(parseStreamLine('{"type":"system","subtype":"hook_started"}')).toEqual([]);
    expect(parseStreamLine('{"type":"weird"}')).toEqual([]);
  });
  it("init → session id + model", () => {
    expect(parseStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "claude-haiku-4-5" }))).toEqual([
      { kind: "init", sessionId: SID, model: "claude-haiku-4-5" },
    ]);
  });
  it("text deltas from stream_event; other deltas and subagent lines skipped", () => {
    const d = (delta: unknown, parent: string | null = null): string => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta }, parent_tool_use_id: parent });
    expect(parseStreamLine(d({ type: "text_delta", text: "ok" }))).toEqual([{ kind: "text-delta", text: "ok" }]);
    expect(parseStreamLine(d({ type: "input_json_delta", partial_json: "{" }))).toEqual([]);
    expect(parseStreamLine(d({ type: "text_delta", text: "x" }, "toolu_1"))).toEqual([]);
  });
  it("assistant message → text + tool chips (redacted, one-line summary)", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "Running it" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la\n  && pwd" } }, { type: "thinking", thinking: "…" }] },
    });
    expect(parseStreamLine(line)).toEqual([
      { kind: "assistant-text", text: "Running it" },
      { kind: "tool", tool: { id: "t1", name: "Bash", summary: "ls -la && pwd" } },
    ]);
  });
  it("tool results and permission denials", () => {
    const tr = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "denied" }] }] } });
    expect(parseStreamLine(tr)).toEqual([{ kind: "tool-result", toolUseId: "t1", isError: true, preview: "denied" }]);
    const pd = JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Bash" });
    expect(parseStreamLine(pd)).toEqual([{ kind: "denied", toolName: "Bash", reason: "nobody could approve it here" }]);
  });
  it("result → ok, cost, per-turn usage, denials; errors are not ok", () => {
    const r = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.0123, duration_ms: 900,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      permission_denials: [{ tool_name: "Write" }],
    });
    expect(parseStreamLine(r)).toEqual([
      { kind: "result", ok: true, subtype: "success", text: "ok", costUsd: 0.0123, durationMs: 900, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5 }, denials: ["Write"] },
    ]);
    const bad = parseStreamLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    expect(bad[0]).toMatchObject({ kind: "result", ok: false, subtype: "error_max_turns", costUsd: null, usage: { inputTokens: 0 } });
  });
});

describe("attachments", () => {
  const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");
  it("images by magic bytes, whatever the browser claimed", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    const v = validateAttachment({ name: "shot.txt", mime: "text/plain", dataBase64: b64(PNG) });
    expect(v).toMatchObject({ ok: true, kind: "image", mime: "image/png" });
  });
  it("text files: UTF-8, no NULs, allowed type or extension", () => {
    expect(validateAttachment({ name: "notes.md", mime: "", dataBase64: b64("# hi") })).toMatchObject({ ok: true, kind: "text", text: "# hi" });
    expect(validateAttachment({ name: "a.bin", mime: "application/octet-stream", dataBase64: b64("abc") })).toMatchObject({ ok: false });
    expect(validateAttachment({ name: "a.txt", mime: "text/plain", dataBase64: b64(Buffer.from([0x61, 0, 0x62])) })).toMatchObject({ ok: false, error: expect.stringContaining("binary") });
    expect(validateAttachment({ name: "a.txt", mime: "text/plain", dataBase64: b64(Buffer.from([0xc3, 0x28])) })).toMatchObject({ ok: false, error: expect.stringContaining("UTF-8") });
    expect(validateAttachment({ name: "fake.png", mime: "image/png", dataBase64: b64("not an image") })).toMatchObject({ ok: false });
  });
  it("rejects malformed, empty, non-base64 and oversized uploads", () => {
    expect(validateAttachment(null)).toMatchObject({ ok: false });
    expect(validateAttachment({ name: "x.txt" })).toMatchObject({ ok: false });
    expect(validateAttachment({ name: "x.txt", mime: "text/plain", dataBase64: "" })).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    expect(validateAttachment({ name: "x.txt", mime: "text/plain", dataBase64: "@@@" })).toMatchObject({ ok: false, error: expect.stringContaining("base64") });
    expect(validateAttachment({ name: "x.txt", mime: "text/plain", dataBase64: b64("x".repeat(100)) }, 50)).toMatchObject({ ok: false, error: expect.stringContaining("MB") });
  });
  it("safe file names: basename, no path or control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\a b$.txt")).toBe("a b_.txt");
    expect(safeFileName("\u0000")).toBe("file");
    expect(safeFileName(".hidden")).toBe("hidden");
  });
  it("user message: image blocks as base64, text inline or by path", () => {
    const img = validateAttachment({ name: "s.png", mime: "image/png", dataBase64: b64(PNG) }) as ValidAttachment;
    const txt = validateAttachment({ name: "n.md", mime: "text/markdown", dataBase64: b64("hello") }) as ValidAttachment;
    const big = validateAttachment({ name: "big.log", mime: "text/plain", dataBase64: b64("x".repeat(TEXT_INLINE_MAX + 1)) }) as ValidAttachment;
    const msg = JSON.parse(buildUserMessage("look", [{ att: img, path: "/u/s.png" }, { att: txt, path: "/u/n.md" }, { att: big, path: "/u/big.log" }])) as {
      type: string;
      message: { role: string; content: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] };
    };
    expect(msg.type).toBe("user");
    expect(msg.message.role).toBe("user");
    expect(msg.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    const text = msg.message.content[1]?.text ?? "";
    expect(text.startsWith("look")).toBe(true);
    expect(text).toContain("hello");
    expect(text).toContain("read it from /u/big.log");
    expect(text).not.toContain("x".repeat(1000));
  });
  it("plain text message is one text block", () => {
    expect(JSON.parse(buildUserMessage("reply with the word ok", []))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "reply with the word ok" }] },
      parent_tool_use_id: null,
    });
  });
});

describe("turnVerdict (never a silent success)", () => {
  const run = (lines: unknown[], exit: Partial<ReturnType<typeof emptyTrace>> = {}): ReturnType<typeof turnVerdict> => {
    const t = { ...emptyTrace(), exitCode: 0, ...exit };
    for (const l of lines) for (const ev of parseStreamLine(JSON.stringify(l))) traceEvent(t, ev);
    return turnVerdict(t);
  };
  const ok = { type: "result", subtype: "success", is_error: false, result: "" };
  it("a normal answer → null", () => {
    expect(run([{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }, { ...ok, result: "ok" }])).toBeNull();
  });
  it("exit 0 with no result → error, with stderr", () => {
    expect(run([], { stderrTail: "Not logged in" })).toMatchObject({ level: "error", text: expect.stringContaining("Not logged in") });
  });
  it("killed → says the signal", () => {
    expect(run([], { exitCode: null, signal: "SIGTERM" })?.text).toContain("SIGTERM");
  });
  it("denied with no reply → warn naming the tool", () => {
    const v = run([{ type: "system", subtype: "permission_denied", tool_name: "Bash" }, { ...ok, permission_denials: [{ tool_name: "Bash" }] }]);
    expect(v).toMatchObject({ level: "warn", text: expect.stringContaining("Bash") });
  });
  it("success with nothing written → warn", () => {
    expect(run([ok])).toMatchObject({ level: "warn" });
  });
  it("error result → error", () => {
    expect(run([{ type: "result", subtype: "error_during_execution", is_error: true }])).toMatchObject({ level: "error" });
  });
  it("stopped by the user → info", () => {
    expect(run([], { stoppedByUser: true, exitCode: 130 })).toEqual({ level: "info", text: "Stopped." });
  });
});

describe("forkDecision", () => {
  it("only a resumed, live-elsewhere, not-yet-forked session needs the fork", () => {
    expect(forkDecision({ liveElsewhere: true, alreadyForked: false, resume: true, acknowledged: false })).toBe("needs-ack");
    expect(forkDecision({ liveElsewhere: true, alreadyForked: false, resume: true, acknowledged: true })).toBe("fork");
    expect(forkDecision({ liveElsewhere: true, alreadyForked: true, resume: true, acknowledged: false })).toBe("same");
    expect(forkDecision({ liveElsewhere: false, alreadyForked: false, resume: true, acknowledged: false })).toBe("same");
    expect(forkDecision({ liveElsewhere: true, alreadyForked: false, resume: false, acknowledged: false })).toBe("same");
  });
});
