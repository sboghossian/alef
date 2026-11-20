import { describe, expect, it } from "vitest";
import { isCensusPr, type CensusPr } from "../../../shared/features/census";
import { COUNCIL_HISTORY_LIMIT, type CouncilResult } from "../../../shared/features/council";
import { councilHistoryOf, councilLinkOf, governanceCounts, mergeGovernanceParts } from "./census-governance-lib";

function council(id: string, at: string, ref?: unknown): CouncilResult {
  const base: CouncilResult = { id, at, decision: "Loop round", options: ["Candidate A (x)", "Candidate B (y)"], personas: [], aggregate: { agreement: 0, split: {}, lowestConfidencePersona: null }, verdict: { ok: false }, source: "jev" };
  return ref === undefined ? base : ({ ...base, ref } as CouncilResult);
}

/** A merged PR whose body has no "Council: <id>" line unless `over` says otherwise. */
function merged(number: number, branch: string, mergedAt: string, over: Partial<CensusPr> = {}): CensusPr {
  return { number, title: "t", mergedAt, branch, headSha: "46478eb6".padEnd(40, "0"), loopMarked: false, review: { recorded: false, verdict: null, model: null }, councilId: null, ...over };
}

// The live history today: 20 panel councils from 2026-09-25, none with a ref.
const PANEL_HISTORY = Array.from({ length: 20 }, (_, i) => council(`panel-${i}`, `2026-09-25T18:${String(i).padStart(2, "0")}:00.000Z`));

describe("councilLinkOf: the PR body's Council line is the record", () => {
  const loop63 = council("0123456789abcdef", "2026-09-28T13:00:00.000Z", { kind: "loop-round", branch: "feat/loop-governance" });
  const pr63 = merged(63, "feat/loop-governance", "2026-09-28T15:00:00Z", { councilId: loop63.id });

  it("links the council the line names when it is kept, picked the PR's branch and ran before the merge", () => {
    const link = councilLinkOf(pr63, [loop63, ...PANEL_HISTORY]);
    expect(link.state === "linked" && link.council.id).toBe(loop63.id);
  });

  it("never links a named council that ran after the merge, reached no pick, picked another branch, or is a panel council", () => {
    const named = (c: CouncilResult) => mergeGovernanceParts({ ...pr63, councilId: c.id }, [c])[0];
    expect(named(council("late0000", "2026-09-28T15:00:01.000Z", { kind: "loop-round", branch: "feat/loop-governance" }))).toBe("Council late0000 not linked (that council ran after the merge)");
    expect(named(council("nopick00", "2026-09-28T13:00:00.000Z", { kind: "loop-round", branch: null }))).toBe("Council nopick00 not linked (that council reached no pick)");
    expect(named(council("other000", "2026-09-28T13:00:00.000Z", { kind: "loop-round", branch: "feat/other" }))).toBe("Council other000 not linked (that council picked another branch)");
    expect(named(council("badref00", "2026-09-28T13:00:00.000Z", { kind: "loop-round", branch: "feat/loop-governance; x" }))).toBe("Council badref00 not linked (not a loop-round council)");
    expect(named(council("panel000", "2026-09-28T13:00:00.000Z"))).toBe("Council panel000 not linked (not a loop-round council)");
    expect(governanceCounts([{ ...pr63, councilId: "panel000" }], [council("panel000", "2026-09-28T13:00:00.000Z")])).toMatchObject({ councilLinked: 0, councilUnknown: 0 });
  });

  it("no Council line is 'no loop council' whatever the history holds: full, short or unreadable", () => {
    const bare = merged(59, "feat/alumni-legacy", "2026-09-28T10:58:04Z");
    for (const history of [PANEL_HISTORY, PANEL_HISTORY.slice(0, 3), [], null]) expect(mergeGovernanceParts(bare, history)[0]).toBe("no loop council");
    expect(governanceCounts([bare], null)).toMatchObject({ councilLinked: 0, councilUnknown: 0 });
  });

  it("a server that sends no councilId (older than this field) is unknown, never 'none'", () => {
    const { councilId: _drop, ...older } = pr63;
    expect(councilLinkOf(older, PANEL_HISTORY)).toEqual({ state: "unknown", why: "not reported by the server" });
    expect(mergeGovernanceParts(older, PANEL_HISTORY)[0]).toBe("council unknown (not reported by the server)");
  });

  it("the wire accepts councilId as a string, null or absent, nothing else", () => {
    const { councilId: _drop, ...older } = pr63;
    expect(isCensusPr(pr63)).toBe(true);
    expect(isCensusPr({ ...pr63, councilId: null })).toBe(true);
    expect(isCensusPr(older)).toBe(true);
    expect(isCensusPr({ ...pr63, councilId: 12 })).toBe(false);
  });
});

describe("mergeGovernanceParts / governanceCounts", () => {
  const linked = merged(63, "feat/loop-governance", "2026-09-28T15:00:00Z", {
    review: { recorded: true, verdict: "MERGE", model: "opus-5.5" },
    presidentPick: "backlog-19",
    councilId: "0123456789abcdef",
  });
  const bare = merged(59, "feat/alumni-legacy", "2026-09-28T10:58:04Z");
  const history = [council("0123456789abcdef", "2026-09-28T13:00:00.000Z", { kind: "loop-round", branch: "feat/loop-governance" }), ...PANEL_HISTORY];

  it("names the council, the review on the merged SHA and the President pick, each from its record", () => {
    expect(mergeGovernanceParts(linked, history)).toEqual(["Council 01234567 → PR #63", "review recorded: MERGE 46478eb opus-5.5", "President pick: backlog-19"]);
    expect(mergeGovernanceParts(bare, history)).toEqual(["no loop council", "no review recorded"]);
  });

  it("says a named council is unknown (never 'none') when the history couldn't be read", () => {
    expect(mergeGovernanceParts(linked, null)[0]).toBe("council unknown (history unavailable)");
    expect(governanceCounts([linked, bare], null)).toEqual({ merges: 2, councilLinked: null, councilUnknown: 1, reviewRecorded: 1, presidentPicked: 1 });
  });

  it("counts today's shape honestly: 10 merges without a Council line, 20 panel councils, nothing linked or recorded", () => {
    const recent = Array.from({ length: 10 }, (_, i) => merged(50 + i, `feat/f${i}`, "2026-09-28T10:00:00Z"));
    expect(governanceCounts(recent, PANEL_HISTORY)).toEqual({ merges: 10, councilLinked: 0, councilUnknown: 0, reviewRecorded: 0, presidentPicked: 0 });
    expect(governanceCounts([linked, bare], history)).toEqual({ merges: 2, councilLinked: 1, councilUnknown: 0, reviewRecorded: 1, presidentPicked: 1 });
  });

  it("reads GET /api/council/history defensively", () => {
    expect(councilHistoryOf({ ok: true, history: [council("a", "2026-09-28T13:00:00.000Z"), { id: 1 }, null] })?.map((c) => c.id)).toEqual(["a"]);
    expect(councilHistoryOf(null)).toBeNull();
    expect(councilHistoryOf({ ok: false })).toBeNull();
  });
});

describe("a named council pushed out of the 20-entry history is unknown, never 'no loop council'", () => {
  // Both reviewers' case: the loop council runs at the round judge (10:00), BEFORE the build. One
  // panel council lands during the build (11:00), PR #70 opens at 12:00 and merges at 13:00, then
  // 19 more panel councils (14:xx) fill the shared history and push the loop council out. Fewer
  // than 20 councils ran after the PR opened, so no date test can tell this from "no council".
  const loop = council("10000000-aaaa", "2026-09-28T10:00:00.000Z", { kind: "loop-round", branch: "feat/a" });
  const duringBuild = council("build-1", "2026-09-28T11:00:00.000Z");
  const afterMerge = (n: number) => Array.from({ length: n }, (_, i) => council(`later-${i}`, `2026-09-28T14:${String(59 - i).padStart(2, "0")}:00.000Z`));
  const pr70 = merged(70, "feat/a", "2026-09-28T13:00:00Z", { councilId: loop.id });

  it("links while the loop council is still kept (the control)", () => {
    const kept = [...afterMerge(COUNCIL_HISTORY_LIMIT - 2), duringBuild, loop];
    expect(kept).toHaveLength(COUNCIL_HISTORY_LIMIT);
    expect(mergeGovernanceParts(pr70, kept)[0]).toBe("Council 10000000 → PR #70");
    expect(governanceCounts([pr70], kept)).toMatchObject({ councilLinked: 1, councilUnknown: 0 });
  });

  it("once it is pushed out, the row says unknown and council-linked is null, not 0", () => {
    const evicted = [...afterMerge(COUNCIL_HISTORY_LIMIT - 1), duringBuild];
    expect(evicted).toHaveLength(COUNCIL_HISTORY_LIMIT);
    expect(councilLinkOf(pr70, evicted)).toEqual({ state: "unknown", why: "not in the kept history" });
    expect(mergeGovernanceParts(pr70, evicted)[0]).toBe("council 10000000 unknown (not in the kept history)");
    expect(governanceCounts([pr70], evicted)).toEqual({ merges: 1, councilLinked: null, councilUnknown: 1, reviewRecorded: 0, presidentPicked: 0 });
  });

  it("any number of councils during the build changes nothing: the line, not a date, decides", () => {
    for (let during = 0; during <= COUNCIL_HISTORY_LIMIT; during += 1) {
      const history = Array.from({ length: COUNCIL_HISTORY_LIMIT }, (_, i) => council(`x-${i}`, i < during ? "2026-09-28T11:00:00.000Z" : "2026-09-28T14:00:00.000Z"));
      expect(councilLinkOf(pr70, history).state).toBe("unknown");
    }
  });
});
