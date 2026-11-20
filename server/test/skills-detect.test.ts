import { describe, expect, it } from "vitest";
import { detectSkillEvents, detectSkillEventsBatch, detectSkillEventsFromLine } from "../features/skills-detect.js";
import { assistantLine, userLine } from "./helpers.js";

const CWD = "/ws/p";
const T1 = "2026-09-25T10:00:00.000Z";
const T2 = "2026-09-25T10:00:05.000Z";

function routerLine(timestamp: string, stdout: string): string {
  return JSON.stringify({ type: "attachment", timestamp, attachment: { hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", stdout } });
}

describe("detectSkillEvents", () => {
  it("detects a Skill tool_use as an invoke event, ignoring other tools on the same line", () => {
    const line = assistantLine({ cwd: CWD, timestamp: T1, toolUses: [{ name: "Skill", input: { skill: "grill-me" } }, { name: "Bash", input: { command: "ls" } }] });
    expect(detectSkillEvents("s1", [line])).toEqual([{ sessionId: "s1", skillName: "grill-me", kind: "invoke", at: T1 }]);
  });

  it("detects one invoke per Skill tool_use, including plugin-namespaced skills", () => {
    const line = assistantLine({ cwd: CWD, timestamp: T1, toolUses: [{ name: "Skill", input: { skill: "grok:grok-delegation" } }, { name: "Skill", input: { skill: "linear" } }] });
    expect(detectSkillEvents("s1", [line])).toEqual([
      { sessionId: "s1", skillName: "grok:grok-delegation", kind: "invoke", at: T1 },
      { sessionId: "s1", skillName: "linear", kind: "invoke", at: T1 },
    ]);
  });

  it("detects a typed /<name> slash command from a user line's command-name tag", () => {
    const line = userLine({ cwd: CWD, timestamp: T1, text: "<command-message>inbox-sweep</command-message>\n<command-name>/inbox-sweep</command-name>\n<command-args>go</command-args>" });
    expect(detectSkillEvents("s1", [line])).toEqual([{ sessionId: "s1", skillName: "inbox-sweep", kind: "slash", at: T1 }]);
  });

  it("matches the verified real shape: message.content as a plain string, not an array", () => {
    const raw = JSON.stringify({
      type: "user",
      timestamp: T1,
      cwd: CWD,
      sessionId: "s1",
      message: { role: "user", content: "<command-message>x</command-message>\n<command-name>/acme-preflight</command-name>\n<command-args>check</command-args>" },
    });
    expect(detectSkillEvents("s1", [raw])).toEqual([{ sessionId: "s1", skillName: "acme-preflight", kind: "slash", at: T1 }]);
  });

  it("ignores ordinary user text with no command-name tag", () => {
    const line = userLine({ cwd: CWD, timestamp: T1, text: "can you fix the bug in login.ts" });
    expect(detectSkillEvents("s1", [line])).toEqual([]);
  });

  it("skips a malformed JSON line without throwing", () => {
    expect(() => detectSkillEvents("s1", ["{not json", "", "   "])).not.toThrow();
    expect(detectSkillEvents("s1", ["{not json"])).toEqual([]);
  });

  it("detects every slug the skill-router hook suggested, from its real UserPromptSubmit stdout shape", () => {
    const stdout =
      "## Skill Router\n\nTop 2 skills semantically matched to this prompt (TF-IDF). Consider invoking the most relevant via the Skill tool if it fits the user's intent — don't force one if none truly apply.\n\n- **/irac-prompt** _(score 16.31)_ — Restructure any rough build...\n- **/lawvable-submit** _(score 13.25)_ — Package and submit a Claude skill...\n";
    const line = routerLine(T2, stdout);
    expect(detectSkillEvents("s1", [line])).toEqual([
      { sessionId: "s1", skillName: "irac-prompt", kind: "suggested", at: T2 },
      { sessionId: "s1", skillName: "lawvable-submit", kind: "suggested", at: T2 },
    ]);
  });

  it("never mistakes a line that merely mentions the phrase for a real router attachment", () => {
    const line = userLine({ cwd: CWD, timestamp: T1, text: "what does the Skill Router hook actually do?" });
    expect(detectSkillEvents("s1", [line])).toEqual([]);
  });

  it("falls back to the epoch timestamp when a line carries none", () => {
    const raw = JSON.stringify({ type: "assistant", cwd: CWD, message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "remember" } }] } });
    expect(detectSkillEvents("s1", [raw])).toEqual([{ sessionId: "s1", skillName: "remember", kind: "invoke", at: new Date(0).toISOString() }]);
  });
});

describe("detectSkillEventsBatch", () => {
  it("tags every event with its own session id, preserving per-session order", () => {
    const a = assistantLine({ cwd: CWD, timestamp: T1, toolUses: [{ name: "Skill", input: { skill: "a" } }] });
    const b = assistantLine({ cwd: CWD, timestamp: T2, toolUses: [{ name: "Skill", input: { skill: "b" } }] });
    const batch = new Map([
      ["s1", [a]],
      ["s2", [b]],
    ]);
    expect(detectSkillEventsBatch(batch)).toEqual([
      { sessionId: "s1", skillName: "a", kind: "invoke", at: T1 },
      { sessionId: "s2", skillName: "b", kind: "invoke", at: T2 },
    ]);
  });
});

// detectSkillEventsFromLine is skills-backfill.ts's building block: it needs the line's own
// timestamp (in ms) to decide whether a line is before or after its cutoff, independent of
// whether the line matched anything.
describe("detectSkillEventsFromLine", () => {
  it("returns the line's timestamp in ms alongside its events", () => {
    const line = assistantLine({ cwd: CWD, timestamp: T1, toolUses: [{ name: "Skill", input: { skill: "grill-me" } }] });
    expect(detectSkillEventsFromLine("s1", line)).toEqual({ atMs: Date.parse(T1), events: [{ sessionId: "s1", skillName: "grill-me", kind: "invoke", at: T1 }] });
  });

  it("returns atMs even for a line that matches nothing", () => {
    const line = userLine({ cwd: CWD, timestamp: T1, text: "no skill here" });
    expect(detectSkillEventsFromLine("s1", line)).toEqual({ atMs: Date.parse(T1), events: [] });
  });

  it("returns { atMs: null, events: [] } for malformed JSON — never throws", () => {
    expect(() => detectSkillEventsFromLine("s1", "{not json")).not.toThrow();
    expect(detectSkillEventsFromLine("s1", "{not json")).toEqual({ atMs: null, events: [] });
  });

  it("returns atMs: null for a line that parses but carries no timestamp at all", () => {
    const raw = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "x" } }] } });
    const result = detectSkillEventsFromLine("s1", raw);
    expect(result.atMs).toBeNull();
    expect(result.events).toEqual([{ sessionId: "s1", skillName: "x", kind: "invoke", at: new Date(0).toISOString() }]); // the live path still gets an event (epoch fallback); only atMs is null
  });
});
