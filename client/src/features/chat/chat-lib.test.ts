import { describe, expect, it } from "vitest";
import { attachmentProblem, formatTokens, formatUsd, needsForkWarning, parseChatEvent, parseChatView, segments } from "./chat-lib";

describe("needsForkWarning", () => {
  it("only before the first send of a live-elsewhere, unforked, unacknowledged chat", () => {
    expect(needsForkWarning({ liveElsewhere: true, turns: 0, forked: false, acknowledged: false })).toBe(true);
    expect(needsForkWarning({ liveElsewhere: true, turns: 0, forked: false, acknowledged: true })).toBe(false);
    expect(needsForkWarning({ liveElsewhere: true, turns: 1, forked: false, acknowledged: false })).toBe(false);
    expect(needsForkWarning({ liveElsewhere: true, turns: 0, forked: true, acknowledged: false })).toBe(false);
    expect(needsForkWarning({ liveElsewhere: false, turns: 0, forked: false, acknowledged: false })).toBe(false);
  });
});

describe("attachmentProblem", () => {
  it("accepts images and text, rejects the rest", () => {
    expect(attachmentProblem({ name: "a.png", size: 10, type: "image/png" }, 0)).toBeNull();
    expect(attachmentProblem({ name: "a.ts", size: 10, type: "" }, 0)).toBeNull();
    expect(attachmentProblem({ name: "a.svg", size: 10, type: "image/svg+xml" }, 0)).toContain("PNG");
    expect(attachmentProblem({ name: "a.zip", size: 10, type: "application/zip" }, 0)).toContain("only images");
  });
  it("empty, oversized, too many", () => {
    expect(attachmentProblem({ name: "a.txt", size: 0, type: "text/plain" }, 0)).toContain("empty");
    expect(attachmentProblem({ name: "a.txt", size: 11 * 1024 * 1024, type: "text/plain" }, 0)).toContain("MB");
    expect(attachmentProblem({ name: "a.txt", size: 1, type: "text/plain" }, 4)).toContain("At most");
  });
});

describe("formatting", () => {
  it("tokens and cost", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(25_000)).toBe("25k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
    expect(formatUsd(null)).toBe("–");
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});

describe("wire validation", () => {
  it("rejects malformed events and views", () => {
    expect(parseChatEvent(null)).toBeNull();
    expect(parseChatEvent({ kind: "evil", html: "<img>" })).toBeNull();
    expect(parseChatEvent({ kind: "text-delta" })).toBeNull();
    expect(parseChatEvent({ kind: "tool", tool: { name: "Bash" } })).toBeNull();
    expect(parseChatEvent({ kind: "text-delta", text: "hi" })).toEqual({ kind: "text-delta", text: "hi" });
    expect(parseChatView({ id: "c-1" })).toBeNull();
  });
});

describe("segments (markdown-ish, never HTML)", () => {
  it("plain text stays one text segment, HTML included verbatim", () => {
    expect(segments("<b>hi</b>")).toEqual([{ kind: "text", text: "<b>hi</b>" }]);
    expect(segments("")).toEqual([]);
  });
  it("fences, inline code, bold", () => {
    expect(segments("run `ls` **now**\n```sh\necho 1\n```\ndone")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "ls" },
      { kind: "text", text: " " },
      { kind: "bold", text: "now" },
      { kind: "text", text: "\n" },
      { kind: "block", lang: "sh", text: "echo 1" },
      { kind: "text", text: "\ndone" },
    ]);
  });
  it("an unclosed fence (still streaming) runs to the end", () => {
    expect(segments("a\n```js\nlet x")).toEqual([{ kind: "text", text: "a\n" }, { kind: "block", lang: "js", text: "let x" }]);
  });
});
