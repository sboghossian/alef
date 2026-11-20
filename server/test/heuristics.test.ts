import { describe, expect, it } from "vitest";
import { discountUnstartedDispatches, isAwaitingInput, localDateKey, processVouchedSessions, sanitizeTitle } from "../heuristics.js";

// Real shapes, read off the live app on 2026-09-28 ~02:12Z (GET /api/world, ps + lsof):
// three Alef launches (all agentId null: two stuck on the folder-trust dialog, one at an empty
// prompt) plus two VS Code sessions in $HOME. 5 claude processes in 4 cwds.
const HOME = "/Users/alexboghossian";
const CODE = `${HOME}/Documents/Code`;
const REAL_BINDINGS = [
  { agentId: null, tmuxName: "aw-68597ce4", cwd: `${CODE}/acme-www`, startedAt: "2026-09-26T08:33:12.168Z" },
  { agentId: null, tmuxName: "aw-5c67d47b", cwd: `${CODE}/legal-taxonomy`, startedAt: "2026-09-28T01:56:07.790Z" },
  { agentId: null, tmuxName: "aw-e10a9ec9", cwd: `${CODE}/agent-world`, startedAt: "2026-09-28T01:56:14.429Z" },
];
const REAL_LIVE = new Map([
  [HOME, 2],
  [`${CODE}/acme-www`, 1],
  [`${CODE}/legal-taxonomy`, 1],
  [`${CODE}/agent-world`, 1],
]);
const REAL_SESSIONS = [
  { id: "96cbb6d9-8ad1-4f35-9e73-bb608a13fc6d", cwd: HOME, startedAt: "2026-09-25T13:20:40.819Z", jsonlMtime: Date.parse("2026-09-28T02:12:48.720Z") },
  { id: "943ddee1-a73d-470c-835a-55084c09c69f", cwd: HOME, startedAt: "2026-09-27T05:41:49.300Z", jsonlMtime: Date.parse("2026-09-28T02:12:33.889Z") },
  // A headless /upskill run whose process is long gone: the stuck aw-e10a9ec9 claude vouched for it.
  { id: "a9c4eac1-7596-4857-8403-3a45e96ab91e", cwd: `${CODE}/agent-world`, startedAt: "2026-09-27T05:42:33.265Z", jsonlMtime: Date.parse("2026-09-27T05:42:58.277Z") },
];

describe("discountUnstartedDispatches", () => {
  it("drops the claude processes of Alef launches that never wrote a transcript (real 2026-09-28 data)", () => {
    const out = discountUnstartedDispatches(REAL_LIVE, REAL_BINDINGS, REAL_SESSIONS);
    expect(out.unstarted).toBe(3);
    expect([...out.live]).toEqual([[HOME, 2]]);
  });
  it("so a stuck launch no longer vouches for an older, finished session in its folder", () => {
    expect(processVouchedSessions(REAL_SESSIONS, REAL_LIVE).has("a9c4eac1-7596-4857-8403-3a45e96ab91e")).toBe(true); // the bug
    const vouched = processVouchedSessions(REAL_SESSIONS, discountUnstartedDispatches(REAL_LIVE, REAL_BINDINGS, REAL_SESSIONS).live);
    expect([...vouched].sort()).toEqual(["943ddee1-a73d-470c-835a-55084c09c69f", "96cbb6d9-8ad1-4f35-9e73-bb608a13fc6d"]);
  });
  it("an adopted binding (agentId set) is not discounted", () => {
    const out = discountUnstartedDispatches(new Map([["/aw", 1], ["/h", 2]]), [
      { cwd: "/aw", agentId: null, startedAt: "2026-09-28T01:00:00.000Z" },
      { cwd: "/h", agentId: "11111111-2222-3333-4444-555555555555", startedAt: "2026-09-28T01:00:00.000Z" },
    ], []);
    expect([...out.live]).toEqual([["/h", 2]]);
    expect(out.unstarted).toBe(1);
  });
  it("clamps at the process count: more bindings than processes never goes negative", () => {
    const b = { cwd: "/aw", agentId: null, startedAt: "2026-09-28T01:00:00.000Z" };
    const out = discountUnstartedDispatches(new Map([["/aw", 1]]), [b, { ...b }, { ...b }], []);
    expect(out.live.size).toBe(0);
    expect(out.unstarted).toBe(1);
  });
  it("a binding whose folder has a session started since it was launched may be running it: not discounted", () => {
    const live = new Map([["/aw", 1]]);
    const binding = { cwd: "/aw", agentId: null, startedAt: "2026-09-28T01:00:00.000Z" };
    // e.g. a promptless ▶ Launch the user typed into 15 min later (too late for adoption's window)
    const own = { id: "s-new", cwd: "/aw", startedAt: "2026-09-28T01:15:00.000Z" };
    expect(discountUnstartedDispatches(live, [binding], [own])).toEqual({ live: new Map([["/aw", 1]]), unstarted: 0 });
    // an older session in the folder is no such evidence
    expect(discountUnstartedDispatches(live, [binding], [{ ...own, startedAt: "2026-09-27T01:00:00.000Z" }]).unstarted).toBe(1);
  });
  it("a newer session already bound to another launch is not this launch's", () => {
    const live = new Map([["/aw", 2]]);
    const stuck = { cwd: "/aw", agentId: null, startedAt: "2026-09-28T01:00:00.000Z" };
    const twin = { cwd: "/aw", agentId: "11111111-2222-3333-4444-555555555555", startedAt: "2026-09-28T01:00:05.000Z" };
    const twinSession = { id: "11111111-2222-3333-4444-555555555555", cwd: "/aw", startedAt: "2026-09-28T01:00:20.000Z" };
    expect(discountUnstartedDispatches(live, [stuck, twin], [twinSession])).toEqual({ live: new Map([["/aw", 1]]), unstarted: 1 });
  });
  it("an unreadable launch time is not proof of anything: not discounted", () => {
    const out = discountUnstartedDispatches(new Map([["/aw", 1]]), [{ cwd: "/aw", agentId: null, startedAt: "garbage" }], []);
    expect(out).toEqual({ live: new Map([["/aw", 1]]), unstarted: 0 });
  });
});

describe("processVouchedSessions", () => {
  const sessions = [
    { id: "old", cwd: "/home", jsonlMtime: 1 },
    { id: "mid", cwd: "/home", jsonlMtime: 5 },
    { id: "new", cwd: "/home", jsonlMtime: 9 },
    { id: "other", cwd: "/repo", jsonlMtime: 9 },
  ];
  it("one process in a shared cwd vouches only for the newest session there", () => {
    expect([...processVouchedSessions(sessions, new Map([["/home", 1]]))]).toEqual(["new"]);
  });
  it("N processes vouch for the N newest", () => {
    expect([...processVouchedSessions(sessions, new Map([["/home", 2]]))].sort()).toEqual(["mid", "new"]);
  });
  it("no processes → nothing vouched", () => {
    expect(processVouchedSessions(sessions, new Map()).size).toBe(0);
  });
});

describe("sanitizeTitle", () => {
  it("strips tags and collapses whitespace", () => {
    expect(sanitizeTitle("<command-message>inbox-sweep</command-message>\n\n  do it")).toBe("inbox-sweep do it");
  });
  it("redacts secret-looking tokens", () => {
    const t = sanitizeTitle("what's this? croma_live_FAKE0000TEST0000TOKEN0000 doc");
    expect(t).toBe("what's this? [redacted] doc");
    expect(sanitizeTitle("key sk-ant-abcdefghijklmnopqrstu here")).toBe("key [redacted] here");
  });
  it("keeps normal URLs readable and caps length", () => {
    expect(sanitizeTitle("see https://linear.app/acmeai/issue/TICK-1972/x")).toContain("TICK-1972");
    expect(sanitizeTitle("a".repeat(10) + " " + "word ".repeat(40)).length).toBeLessThanOrEqual(80);
  });
  it("empty → placeholder", () => {
    expect(sanitizeTitle("   ")).toBe("(untitled session)");
  });
});

describe("sanitizeTitle slugs", () => {
  it("does not redact lowercase URL slugs", () => {
    const t = sanitizeTitle("https://linear.app/acmeai/issue/TICK-1976/ask-elias-to-map-the-customer-journey-v2");
    expect(t).not.toContain("[redacted]");
  });
});

describe("localDateKey", () => {
  it("formats as zero-padded YYYY-MM-DD in local time", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05"); // month 0 = January
    expect(localDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isAwaitingInput", () => {
  it("true when live and the last tool call was AskUserQuestion", () => {
    expect(isAwaitingInput("live", { kind: "assistant_tool", toolName: "AskUserQuestion", textIsQuestion: false })).toBe(true);
  });
  it("false when live but the last tool call was something else", () => {
    expect(isAwaitingInput("live", { kind: "assistant_tool", toolName: "Edit", textIsQuestion: false })).toBe(false);
  });
  it("true when live and the last assistant text ends in a question mark", () => {
    expect(isAwaitingInput("live", { kind: "assistant_text", toolName: null, textIsQuestion: true })).toBe(true);
  });
  it("false when live and the last assistant text does not end in a question mark", () => {
    expect(isAwaitingInput("live", { kind: "assistant_text", toolName: null, textIsQuestion: false })).toBe(false);
  });
  it("false when the last line was the user's, regardless of liveness", () => {
    expect(isAwaitingInput("live", { kind: "user", toolName: null, textIsQuestion: false })).toBe(false);
  });
  it("false when dormant even if the last tool call was AskUserQuestion", () => {
    expect(isAwaitingInput("dormant", { kind: "assistant_tool", toolName: "AskUserQuestion", textIsQuestion: false })).toBe(false);
  });
});
