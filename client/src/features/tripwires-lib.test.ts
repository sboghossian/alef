import { describe, expect, it } from "vitest";
import { parseTripwireHits, type TripwireHit } from "../../../shared/features/tripwires";
import { FeedStore } from "../shell/feed";
import { BADGE_PREFIX, badgeText, hitsForAgent, hitToFeedItem, mergeHits } from "./tripwires-lib";

// Real hits: the shipped server tracker run (read-only) over the sessions a real GET /api/world
// listed as active in the last 24h (2026-09-27). Verbatim, including district and snippet.
const REAL: readonly TripwireHit[] = [
  {
    id: "943ddee1-a73d-470c-835a-55084c09c69f:ps-grep-counts-itself",
    sessionId: "943ddee1-a73d-470c-835a-55084c09c69f",
    subagentId: null,
    district: "Home",
    tripwireId: "ps-grep-counts-itself",
    lesson: "`ps | grep -c X` counts the grep itself: use `pgrep`, `grep -v grep` or a `[x]` pattern.",
    severity: "info",
    source: "~/.alef-loop/journal.md 2026-09-27 (iteration 4 dead end)",
    tool: "Bash",
    snippet: 'rtk proxy ps aux | grep -c "native-binary/claude"',
    at: "2026-09-27T08:16:45.561Z",
  },
  {
    id: "943ddee1-a73d-470c-835a-55084c09c69f:tests-through-rtk-filter",
    sessionId: "943ddee1-a73d-470c-835a-55084c09c69f",
    subagentId: null,
    district: "Home",
    tripwireId: "tests-through-rtk-filter",
    lesson: "Tests run through the rtk filter and then piped to tail/grep hide failures: `rtk proxy <tests> > log 2>&1`, grep the log for FAIL.",
    severity: "warn",
    source: "~/.alef-loop/LOOP.md step 4 · journal 2026-09-27",
    tool: "Bash",
    snippet: 'npx vitest run server/test/resident 2>&1 | grep -E "Test Files|Tests |FAIL|✗|×|Error"',
    at: "2026-09-27T05:44:25.135Z",
  },
];
const hit = (over: Partial<TripwireHit> = {}): TripwireHit => ({ ...REAL[1]!, ...over });

describe("parseTripwireHits", () => {
  it("keeps valid hits and drops malformed ones off the wire", () => {
    const good = hit();
    expect(parseTripwireHits([good, { ...good, severity: "fatal" }, { ...good, at: "yesterday" }, null, "x", { ...good, district: 3 }, { ...good, subagentId: undefined }])).toEqual([good]);
    expect(parseTripwireHits(undefined)).toEqual([]);
  });
});

describe("mergeHits / hitsForAgent", () => {
  it("dedupes by id (latest copy wins), sorts newest first and caps", () => {
    const [ps, tests] = [REAL[0]!, REAL[1]!];
    const tests2 = { ...tests, district: "agent-world" };
    expect(mergeHits([tests], [ps, tests2]).map((h) => [h.id, h.district])).toEqual([
      [ps.id, "Home"],
      [tests.id, "agent-world"],
    ]);
    expect(mergeHits([tests], [ps], 1).map((h) => h.id)).toEqual([ps.id]);
    expect(hitsForAgent(mergeHits([], REAL), ps.sessionId).map((h) => h.tripwireId)).toEqual(["ps-grep-counts-itself", "tests-through-rtk-filter"]);
    expect(hitsForAgent(REAL, "someone-else")).toEqual([]);
  });
});

describe("badgeText", () => {
  it('reads "⚠ repeats lesson: …" and stays one short line', () => {
    expect(badgeText(hit())).toBe(`${BADGE_PREFIX}${hit().lesson.slice(0, 89).trimEnd()}…`);
    expect(badgeText(REAL[0]!)).toBe(`${BADGE_PREFIX}${REAL[0]!.lesson}`); // 88 chars: fits
    expect(badgeText(hit({ lesson: "Short lesson." }))).toBe("⚠ repeats lesson: Short lesson.");
  });
});

describe("hitToFeedItem", () => {
  it("is a Feed item of kind tripwire the real FeedStore accepts and counts", () => {
    const item = hitToFeedItem(hit(), "Alef loop");
    expect(item).toEqual({
      id: `tw:${hit().id}`,
      kind: "tripwire",
      at: Date.parse(hit().at),
      title: `Repeats a lesson: ${hit().lesson}`,
      detail: `Alef loop · Home · ${hit().snippet}`,
      agentId: hit().sessionId,
    });
    const feed = new FeedStore();
    expect(feed.push(item)).toBe(true);
    expect(feed.push(hitToFeedItem(hit(), "Alef loop"))).toBe(false); // same hit again: no change
    expect(feed.counts().tripwire).toBe(1);
    expect(feed.list({ kinds: new Set(["tripwire"]) }).map((i) => i.id)).toEqual([item.id]);
  });

  it("falls back to a short session id and skips a missing district", () => {
    expect(hitToFeedItem(hit({ district: null }), undefined).detail).toBe(`session 943ddee1 · ${hit().snippet}`);
  });

  it("says when a subagent made the call", () => {
    expect(hitToFeedItem(hit({ subagentId: "a3f1c2d4e5" }), "Alef loop").detail).toBe(`Alef loop · via a subagent · Home · ${hit().snippet}`);
  });
});
