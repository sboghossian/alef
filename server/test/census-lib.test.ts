// Pure "census" logic: parsing `gh pr list --json …` output into CensusPr records (review
// recording, loop marker, title sanitizing) and folding subagent records into generations.
// Every gh fixture below carries exactly the fields census.ts actually asks for:
// number,title,mergedAt,headRefName,headRefOid,body,comments.

import { describe, expect, it } from "vitest";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import { councilIdOf, generations, isLoopMarked, oneLineTitle, parseMergedPrs, presidentPickOf, reviewFor } from "../features/census-lib.js";

const SHA_A = "abc123def4567890abc123def4567890abc1234";
const SHA_B = "deadbeef00112233445566778899aabbccddeeff";

function pr(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    number: 1,
    title: "A plain title",
    mergedAt: "2026-09-20T10:00:00Z",
    headRefName: "feat/thing",
    headRefOid: SHA_A,
    body: "Just a normal PR body.",
    comments: [],
    ...overrides,
  };
}

describe("oneLineTitle", () => {
  it("collapses newlines/whitespace to one line", () => {
    expect(oneLineTitle("fix: the\nthing\n  that broke")).toBe("fix: the thing that broke");
  });

  it("truncates at 120 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = oneLineTitle(long);
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short title untouched", () => {
    expect(oneLineTitle("short")).toBe("short");
  });
});

describe("isLoopMarked", () => {
  it("matches the exact loop marker line", () => {
    expect(isLoopMarked("Some intro.\n\nAlef-Loop: iteration 5\n\nMore text.")).toBe(true);
  });

  it("does not match ordinary mentions of the words", () => {
    expect(isLoopMarked("This iteration of the loop merged fine.")).toBe(false);
    expect(isLoopMarked("Alef-Loop: iteration five")).toBe(false); // not a number
  });

  it("empty body is not marked", () => {
    expect(isLoopMarked("")).toBe(false);
  });
});

describe("reviewFor", () => {
  it("records a comment whose sha prefixes headRefOid and was posted before mergedAt", () => {
    const comments = [{ body: "alef-review: MERGE abc123d opus-5.5", createdAt: "2026-09-20T09:00:00Z" }];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toEqual({ recorded: true, verdict: "MERGE", model: "opus-5.5" });
  });

  it("accepts createdAt exactly equal to mergedAt", () => {
    const comments = [{ body: "alef-review: BLOCK abc123d", createdAt: "2026-09-20T10:00:00Z" }];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toMatchObject({ recorded: true, verdict: "BLOCK" });
  });

  it("ignores a comment with no marker (ordinary discussion)", () => {
    const comments = [{ body: "LGTM, nice work!", createdAt: "2026-09-20T09:00:00Z" }];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toEqual({ recorded: false, verdict: null, model: null });
  });

  it("ignores a marker whose sha is for a different PR", () => {
    const comments = [{ body: `alef-review: MERGE ${SHA_B.slice(0, 10)}`, createdAt: "2026-09-20T09:00:00Z" }];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toEqual({ recorded: false, verdict: null, model: null });
  });

  it("ignores a marker posted after the merge", () => {
    const comments = [{ body: "alef-review: MERGE abc123d", createdAt: "2026-09-20T11:00:00Z" }];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toEqual({ recorded: false, verdict: null, model: null });
  });

  it("skips a non-matching comment and finds a later matching one", () => {
    const comments = [
      { body: "just chatting", createdAt: "2026-09-20T08:00:00Z" },
      { body: "alef-review: MERGE abc123d sonnet-5", createdAt: "2026-09-20T09:30:00Z" },
    ];
    expect(reviewFor(comments, SHA_A, "2026-09-20T10:00:00Z")).toEqual({ recorded: true, verdict: "MERGE", model: "sonnet-5" });
  });
});

describe("parseMergedPrs", () => {
  it("parses a realistic gh fixture: one recorded review, one plain, one wrong-sha, one late comment", () => {
    const fixture = [
      pr({
        number: 40,
        title: "feat: real thing\nwith a second line",
        headRefOid: SHA_A,
        body: "Does the thing.\n\nAlef-Loop: iteration 3\n",
        mergedAt: "2026-09-20T10:00:00Z",
        comments: [{ body: "alef-review: MERGE abc123d opus-5.5", createdAt: "2026-09-20T09:00:00Z" }],
      }),
      pr({
        number: 41,
        title: "fix: another thing",
        headRefOid: "1111111111111111111111111111111111111a",
        body: "No marker here.",
        mergedAt: "2026-09-21T10:00:00Z",
        comments: [{ body: "nice", createdAt: "2026-09-21T09:00:00Z" }],
      }),
      pr({
        number: 42,
        title: "chore: wrong sha marker",
        headRefOid: "2222222222222222222222222222222222222b",
        body: "Body.",
        mergedAt: "2026-09-22T10:00:00Z",
        comments: [{ body: `alef-review: MERGE ${SHA_B.slice(0, 10)}`, createdAt: "2026-09-22T09:00:00Z" }],
      }),
      pr({
        number: 43,
        title: "chore: comment after merge",
        headRefOid: "3333333333333333333333333333333333333c",
        body: "Body.",
        mergedAt: "2026-09-23T10:00:00Z",
        comments: [{ body: "alef-review: MERGE 333333333333", createdAt: "2026-09-23T11:00:00Z" }],
      }),
    ];
    const out = parseMergedPrs(JSON.stringify(fixture));
    expect(out).not.toBeNull();
    expect(out?.map((p) => p.number)).toEqual([40, 41, 42, 43]);
    expect(out?.[0]).toMatchObject({ number: 40, title: "feat: real thing with a second line", loopMarked: true, review: { recorded: true, verdict: "MERGE", model: "opus-5.5" } });
    expect(out?.[1]).toMatchObject({ number: 41, loopMarked: false, review: { recorded: false, verdict: null, model: null } });
    expect(out?.[2]).toMatchObject({ number: 42, review: { recorded: false, verdict: null, model: null } });
    expect(out?.[3]).toMatchObject({ number: 43, review: { recorded: false, verdict: null, model: null } });
    // never retained: the PR type has no body/comments fields to begin with.
    expect(out?.[0]).not.toHaveProperty("body");
    expect(out?.[0]).not.toHaveProperty("comments");
  });

  it("keeps only the id of a 'President pick: <id>' body line (never the line's other text)", () => {
    const out = parseMergedPrs(
      JSON.stringify([
        pr({ number: 1, body: "Builds it.\r\nPresident pick: backlog-19 (p 55%, p(none) 25%)\r\nAlef-Loop: iteration 4\r\n" }),
        pr({ number: 2, body: "President pick: board:health-tests" }),
        pr({ number: 3, body: "President pick: none (p(none) 60% beats every candidate)" }),
        pr({ number: 4, body: "Mentions President pick: backlog-1 mid-line only." }),
        pr({ number: 5 }),
      ]),
    );
    expect(out?.map((p) => p.presidentPick)).toEqual(["backlog-19", "board:health-tests", null, null, null]);
    expect(out?.[0]?.loopMarked).toBe(true);
  });

  it("presidentPickOf refuses ids that aren't plain tokens", () => {
    expect(presidentPickOf("President pick: <img src=x>")).toBeNull();
    expect(presidentPickOf("President pick: NONE")).toBeNull();
    expect(presidentPickOf(`President pick: ${"a".repeat(81)}`)).toBeNull();
    expect(presidentPickOf("President pick: backlog-1a\tmore")).toBe("backlog-1a");
  });

  it("returns null (not []) on non-JSON output — a failed fetch, never a fabricated zero", () => {
    expect(parseMergedPrs("gh: command not found")).toBeNull();
    expect(parseMergedPrs("")).toBeNull();
  });

  it("returns null on JSON that isn't an array", () => {
    expect(parseMergedPrs(JSON.stringify({ error: "bad" }))).toBeNull();
  });

  it("returns [] for a genuinely empty merged list", () => {
    expect(parseMergedPrs("[]")).toEqual([]);
  });

  it("keeps only the id of a 'Council: <id>' body line, the council the loop built this PR from", () => {
    const id = "3f2b8c1e-9a4d-4e6b-8f1a-2c3d4e5f6a7b";
    const out = parseMergedPrs(
      JSON.stringify([
        pr({ number: 1, body: `Builds it.\r\nCouncil: ${id}\r\nPresident pick: backlog-19\r\n` }),
        pr({ number: 2, body: `Council: ${id} (recorded in the council history)` }),
        pr({ number: 3, body: "Council: none" }),
        pr({ number: 4, body: `The census shows Council: ${id} mid-line only.` }),
        pr({ number: 5 }),
      ]),
    );
    expect(out?.map((p) => p.councilId)).toEqual([id, id, null, null, null]);
    expect(out?.[0]?.presidentPick).toBe("backlog-19");
  });

  it("councilIdOf refuses ids that aren't plain tokens", () => {
    expect(councilIdOf("Council: <img src=x>")).toBeNull();
    expect(councilIdOf("Council: NONE")).toBeNull();
    expect(councilIdOf(`Council: ${"a".repeat(65)}`)).toBeNull();
    expect(councilIdOf("Council: a/b")).toBeNull();
    expect(councilIdOf("Council: c-1\tmore")).toBe("c-1");
    expect(councilIdOf("council: c-1")).toBeNull();
  });

  it("skips a malformed entry inside an otherwise-valid array", () => {
    const out = parseMergedPrs(JSON.stringify([pr({ number: 1 }), { number: "not-a-number" }, pr({ number: 2 })]));
    expect(out?.map((p) => p.number)).toEqual([1, 2]);
  });
});

function subagent(o: { id: string; parentSessionId: string; parentAgentId: string | null; depth: number; startedAt: string }): SubagentRecord {
  return {
    id: o.id,
    parentSessionId: o.parentSessionId,
    parentAgentId: o.parentAgentId,
    workflowId: null,
    description: "did some work",
    agentType: "general-purpose",
    model: "claude-sonnet-4-6",
    status: "done",
    reason: null,
    startedAt: o.startedAt,
    lastActive: o.startedAt,
    tokens: 1000,
    toolCounts: { Read: 3 },
    files: [],
    depth: o.depth,
  };
}

describe("generations", () => {
  it("folds a real /api/subagents-shaped list into a 3-generation breakdown", () => {
    const records: SubagentRecord[] = [
      subagent({ id: "d1a", parentSessionId: "sessA", parentAgentId: null, depth: 1, startedAt: "2026-09-10T00:00:00Z" }),
      subagent({ id: "d1b", parentSessionId: "sessA", parentAgentId: null, depth: 1, startedAt: "2026-09-11T00:00:00Z" }),
      subagent({ id: "d2a", parentSessionId: "sessA", parentAgentId: "d1a", depth: 2, startedAt: "2026-09-12T00:00:00Z" }),
      subagent({ id: "d1c", parentSessionId: "sessB", parentAgentId: null, depth: 1, startedAt: "2026-09-07T02:16:00Z" }),
    ];
    const gen = generations(records);
    expect(gen.total).toBe(4);
    expect(gen.byDepth).toEqual({ 1: 3, 2: 1 });
    expect(gen.generations).toBe(3); // parents (implicit) -> children (depth 1) -> grandchildren (depth 2)
    expect(gen.parents).toBe(2); // sessA, sessB
    expect(gen.since).toBe("2026-09-07T02:16:00.000Z");
    // sum of byDepth == total (the MEASURE invariant)
    expect(Object.values(gen.byDepth).reduce((a, b) => a + b, 0)).toBe(gen.total);
  });

  it("is honest about having nothing yet: total 0, since null, generations 0", () => {
    const gen = generations([]);
    expect(gen).toEqual({ total: 0, since: null, byDepth: {}, generations: 0, parents: 0 });
  });

  it("counts a distinct parentSessionId once no matter how many subagents it spawned", () => {
    const records: SubagentRecord[] = [
      subagent({ id: "a", parentSessionId: "s1", parentAgentId: null, depth: 1, startedAt: "2026-09-01T00:00:00Z" }),
      subagent({ id: "b", parentSessionId: "s1", parentAgentId: null, depth: 1, startedAt: "2026-09-02T00:00:00Z" }),
      subagent({ id: "c", parentSessionId: "s1", parentAgentId: null, depth: 1, startedAt: "2026-09-03T00:00:00Z" }),
    ];
    expect(generations(records).parents).toBe(1);
  });
});
