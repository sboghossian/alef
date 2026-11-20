import { describe, expect, it } from "vitest";
import { parseLine } from "../jsonl-events.js";
import {
  buildMessage,
  firstLine,
  incomingMessagesOnLine,
  messageId,
  messagePreview,
  parseRef,
  pruneMessages,
  resolveByName,
  sendMessagesOnLine,
  type NameCandidate,
} from "../features/village-lib.js";

function assistantLine(input: Record<string, unknown>, model = "claude-opus-5-5[1m]"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-26T10:00:00.000Z",
    message: { id: "msg_1", model, content: [{ type: "tool_use", id: "t1", name: "SendMessage", input }] },
  });
}

function userLine(text: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-09-26T10:01:00.000Z",
    message: { content: [{ type: "text", text }] },
  });
}

const AGENTS: NameCandidate[] = [
  { id: "a1b2c3d4e5f60001", title: "Write a blog post about pricing", cwd: "/Users/x/Documents/Code/acme-ai-next" },
  { id: "9988776655440002", title: "Fix the flaky test", cwd: "/Users/x/Documents/Code/agent-world" },
];

describe("firstLine", () => {
  it("collapses whitespace and takes the first non-blank line", () => {
    expect(firstLine("\n\n  hello   world  \nsecond line")).toBe("hello world");
  });
  it("truncates with an ellipsis", () => {
    expect(firstLine("a".repeat(200), 10)).toBe("aaaaaaaaa…");
  });
  it("empty input stays empty", () => {
    expect(firstLine("   \n  ")).toBe("");
  });
});

describe("messagePreview", () => {
  it("previews plain text", () => {
    expect(messagePreview("start on task #1")).toBe("start on task #1");
  });
  it("labels an empty string", () => {
    expect(messagePreview("")).toBe("(empty message)");
  });
  it("labels protocol objects", () => {
    expect(messagePreview({ type: "shutdown_request" })).toBe("[shutdown request]");
    expect(messagePreview({ type: "shutdown_response", approve: true, request_id: "r1" })).toBe("[shutdown approved]");
    expect(messagePreview({ type: "plan_approval_response", approve: false, request_id: "r1" })).toBe("[plan sent back]");
    expect(messagePreview({ type: "mystery" })).toBe("[mystery]");
  });
  it("falls back for anything else", () => {
    expect(messagePreview(42)).toBe("(message)");
  });
});

describe("sendMessagesOnLine", () => {
  it("extracts to + preview from a SendMessage tool_use", () => {
    const parsed = parseLine(assistantLine({ to: "researcher", message: "start on task #1", summary: "assign" }));
    expect(sendMessagesOnLine(parsed)).toEqual([{ toRaw: "researcher", preview: "start on task #1" }]);
  });
  it("ignores other tools and non-assistant lines", () => {
    const bash = parseLine(JSON.stringify({ type: "assistant", timestamp: "t", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] } }));
    expect(sendMessagesOnLine(bash)).toEqual([]);
    expect(sendMessagesOnLine(null)).toEqual([]);
  });
  it("skips a call with no `to`", () => {
    const parsed = parseLine(assistantLine({ message: "hello" }));
    expect(sendMessagesOnLine(parsed)).toEqual([]);
  });
});

describe("incomingMessagesOnLine", () => {
  it("extracts the cross-session-message wrapper", () => {
    const line = userLine('<cross-session-message from="worker [a1b2c3]">status: tests are green</cross-session-message>');
    expect(incomingMessagesOnLine(line)).toEqual([{ fromRaw: "worker [a1b2c3]", preview: "status: tests are green" }]);
  });
  it("also matches the agent-message tag", () => {
    const line = userLine('<agent-message from="main">go ahead</agent-message>');
    expect(incomingMessagesOnLine(line)).toEqual([{ fromRaw: "main", preview: "go ahead" }]);
  });
  it("returns nothing for a plain user line", () => {
    expect(incomingMessagesOnLine(userLine("just a normal prompt"))).toEqual([]);
  });
  it("never throws on malformed JSON", () => {
    expect(incomingMessagesOnLine("not json at all cross-session-message")).toEqual([]);
  });
});

describe("parseRef", () => {
  it("splits name and ref", () => {
    expect(parseRef("worker [a1b2c3]")).toEqual({ name: "worker", ref: "a1b2c3" });
  });
  it("has no ref when there is none", () => {
    expect(parseRef("main")).toEqual({ name: "main", ref: null });
  });
});

describe("resolveByName", () => {
  it("resolves by id-prefix ref", () => {
    expect(resolveByName("worker [a1b2c3]", AGENTS)).toBe("a1b2c3d4e5f60001");
  });
  it("resolves by cwd basename", () => {
    expect(resolveByName("agent-world", AGENTS)).toBe("9988776655440002");
  });
  it("resolves by exact title match", () => {
    expect(resolveByName("Fix the flaky test", AGENTS)).toBe("9988776655440002");
  });
  it("never guesses when nothing lines up", () => {
    expect(resolveByName("someone-else", AGENTS)).toBeNull();
  });
});

describe("buildMessage", () => {
  it("a sent message always knows its real sender", () => {
    const m = buildMessage("sent", "2026-09-26T10:00:00.000Z", "9988776655440002", { toRaw: "acme-ai-next", preview: "hi" }, AGENTS);
    expect(m.fromSessionId).toBe("9988776655440002");
    expect(m.toSessionId).toBe("a1b2c3d4e5f60001");
    expect(m.direction).toBe("sent");
  });
  it("a received message always knows its real recipient", () => {
    const m = buildMessage("received", "2026-09-26T10:00:00.000Z", "a1b2c3d4e5f60001", { fromRaw: "agent-world", preview: "hi" }, AGENTS);
    expect(m.toSessionId).toBe("a1b2c3d4e5f60001");
    expect(m.fromSessionId).toBe("9988776655440002");
  });
  it("stays honest when the name does not resolve", () => {
    const m = buildMessage("sent", "2026-09-26T10:00:00.000Z", "9988776655440002", { toRaw: "nobody", preview: "hi" }, AGENTS);
    expect(m.toSessionId).toBeNull();
    expect(m.toRaw).toBe("nobody");
  });
});

describe("messageId", () => {
  it("is stable for the same inputs and differs otherwise", () => {
    const a = messageId("sent", "t", "x", "y", "hi");
    const b = messageId("sent", "t", "x", "y", "hi");
    const c = messageId("sent", "t", "x", "y", "bye");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("pruneMessages", () => {
  const base = { direction: "sent" as const, fromSessionId: "s1", fromRaw: "s1", toSessionId: "s2", toRaw: "s2", preview: "p" };
  it("drops anything older than maxAgeMs and sorts newest first", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const messages = [
      { id: "old", at: "2026-09-24T00:00:00.000Z", ...base },
      { id: "new", at: "2026-09-26T11:00:00.000Z", ...base },
      { id: "mid", at: "2026-09-26T09:00:00.000Z", ...base },
    ];
    const out = pruneMessages(messages, now, 24 * 60 * 60_000, 10);
    expect(out.map((m) => m.id)).toEqual(["new", "mid"]);
  });
  it("caps the result and de-dupes by id (last write wins)", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const messages = [
      { id: "a", at: "2026-09-26T11:00:00.000Z", ...base, preview: "first" },
      { id: "a", at: "2026-09-26T11:00:00.000Z", ...base, preview: "second" },
      { id: "b", at: "2026-09-26T10:00:00.000Z", ...base },
    ];
    const out = pruneMessages(messages, now, 24 * 60 * 60_000, 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("a");
    expect(out[0]?.preview).toBe("second");
  });
});
