import { describe, expect, it } from "vitest";
import type { DigestFacts, HomeAutomationRow, HomeDecisionRow } from "../../../shared/features/home";
import type { PresidentBoard } from "../../../shared/features/president";
import type { FeedItem } from "../shell/feed-types";
import { ago, automationWords, decisionLabel, decisionStatus, decisionText, factLines, jevTimeline, nextShown, until } from "./home-lib";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    range: "today",
    label: "today, since midnight",
    days: null,
    from: "2026-09-28T22:00:00.000Z",
    to: "2026-09-29T12:00:00.000Z",
    sessions: { started: 4, active: 6, ended: 3, liveNow: 2, waitingNow: 1, districts: 1, topDistricts: [{ name: "acme-ai-next", sessions: 3 }] },
    outcomes: { ready: true, shipped: 1, delivered: 0, failed: 1, stopped: 0, abandoned: 0, finished: 0, noEvidence: 1, unjudged: 0 },
    mergedPrs: { ready: true, total: 1, repos: 1, byRepo: [{ repo: "acme-inc/acme-ai", count: 1 }] },
    alefUpgrades: { ready: true, error: null, total: 1, latestPrs: [{ number: 70, title: "test: pin the clock" }] },
    sickness: { ready: true, opened: 2, healed: 1, openNow: 24, openedByKind: [{ kind: "broken-build", count: 2 }] },
    automations: { ready: true, runs: 3, clean: 1, wrote: 1, bad: 1, unknown: 0, workersRan: 1, topWorkers: [{ key: "/upskill", runs: 1, clean: 0, wrote: 0, bad: 1, unknown: 0 }] },
    jev: { ready: true, shown: 1, launched: 1, dismissed: 0, merged: 0, retired: 0 },
    ...over,
  };
}

describe("factLines", () => {
  it("one line per source, each linked to where it comes from", () => {
    const lines = factLines(facts());
    expect(lines.map((l) => [l.id, l.link.kind === "view" ? l.link.view : l.link.kind === "panel" ? l.link.panel : l.link.kind === "tab" ? l.link.tab : "needs"])).toEqual([
      ["sessions", "board"],
      ["outcomes", "board"],
      ["merged", "board"],
      ["alef", "census"],
      ["sickness", "clinic"],
      ["automations", "careers"],
      ["jev", "needs"],
    ]);
    expect(lines[0]!.text).toBe("6 sessions active · 4 started · 3 ended · 2 running now · 1 waiting on you");
    expect(lines[0]!.sub).toEqual(["Busiest: acme-ai-next 3"]);
    expect(lines[1]!.text).toBe("Of the 3 sessions that ended: 1 shipped · 1 failed · 1 no outcome evidence");
    expect(lines[1]!.tone).toBe("bad");
    expect(lines[3]!.sub).toEqual(["#70 test: pin the clock"]);
    expect(lines[5]!.text).toBe("3 automation runs: 1 clean · 1 only wrote · 1 bad");
  });

  it("a source that hasn't loaded reads 'not known yet', never a 0", () => {
    const lines = factLines(
      facts({
        outcomes: { ready: false, shipped: 0, delivered: 0, failed: 0, stopped: 0, abandoned: 0, finished: 0, noEvidence: 0, unjudged: 0 },
        mergedPrs: { ready: false, total: 0, repos: 0, byRepo: [] },
        alefUpgrades: { ready: false, error: "gh: not logged in", total: 0, latestPrs: [] },
        sickness: { ready: false, opened: 0, healed: 0, openNow: 0, openedByKind: [] },
        automations: { ready: false, runs: 0, clean: 0, wrote: 0, bad: 0, unknown: 0, workersRan: 0, topWorkers: [] },
        jev: { ready: false, shown: 0, launched: 0, dismissed: 0, merged: 0, retired: 0 },
      }),
    );
    for (const l of lines.slice(1)) {
      expect(l.tone, l.id).toBe("quiet");
      expect(l.text, l.id).not.toMatch(/\b0\b/);
    }
    expect(lines[3]!.text).toContain("gh: not logged in");
  });

  it("an empty day still states its zeros for sessions (the index is always loaded)", () => {
    const l = factLines(facts({ sessions: { started: 0, active: 0, ended: 0, liveNow: 0, waitingNow: 0, districts: 0, topDistricts: [] } }))[0]!;
    expect(l.text).toBe("0 sessions active · 0 started · 0 ended");
    expect(l.sub).toEqual([]);
  });
});

describe("automation rows", () => {
  const worker: HomeAutomationRow = {
    id: "worker:/upskill",
    kind: "worker",
    name: "/upskill",
    key: "/upskill",
    state: "probation",
    lastRunAt: "2026-09-29T11:00:00.000Z",
    lastMark: "failed",
    lastWhy: "cut off: a tool call never returned",
    lastExit: null,
    schedule: "daily 08:30",
    nextRunAt: "2026-09-30T06:30:00.000Z",
    running: false,
  };

  it("a worker: its last run, the Tower's mark, its state, and the next scheduled run", () => {
    expect(automationWords(worker, NOW)).toEqual({ name: "/upskill", state: "↩ probation", last: "last run 1h ago · ✗ failed", next: "next in 18h 30m · daily 08:30", bad: true });
  });

  it("a routine no worker claims: launchd's exit code, never called proof", () => {
    const r: HomeAutomationRow = { ...worker, id: "routine:com.stephane.rss", kind: "routine", name: "rss", key: null, state: null, lastRunAt: null, lastMark: null, lastWhy: null, lastExit: 0, schedule: "every 15 min", nextRunAt: null, running: true };
    expect(automationWords(r, NOW)).toEqual({ name: "rss", state: "⏰ routine", last: "running now · last exit 0 (not proof it did anything)", next: "every 15 min", bad: false });
    expect(automationWords({ ...r, running: false, lastExit: 1 }, NOW).bad).toBe(true);
  });

  it("a day-only last run stays a date", () => {
    expect(ago("2026-07-28", NOW)).toBe("2026-07-28");
    expect(until("2026-09-29T12:00:20.000Z", NOW)).toBe("due now");
    expect(until("2026-10-03T12:00:00.000Z", NOW)).toBe("in 4d");
  });
});

describe("Jev decided lately", () => {
  const row = (over: Partial<HomeDecisionRow>): HomeDecisionRow => ({
    id: "treat-93802b548000",
    kind: "session",
    action: "launch",
    rankedBy: "jev",
    proposedAt: "2026-09-28T09:41:07.006Z",
    actedAt: "2026-09-29T04:13:05.722Z",
    outcome: "launched",
    status: "clicked",
    sessionId: null,
    verdict: null,
    ...over,
  });

  it("labels a proposal by its kind and the origin its id carries", () => {
    expect(decisionLabel(row({}))).toBe("Session idea (treat a sick lineage)");
    expect(decisionLabel(row({ id: "loop-a68b41d0" }))).toBe("Session idea (from an open loop)");
    expect(decisionLabel(row({ id: "abc" }))).toBe("Session idea");
    expect(decisionLabel(row({ kind: "merge", action: "merge" }))).toBe("District merge");
    expect(decisionLabel(row({ kind: "commencement", action: "retire" }))).toBe("Graduation: retire");
    expect(decisionStatus(row({})).text).toBe("you launched it");
    expect(decisionStatus(row({ status: "pending", outcome: null })).tone).toBe("wait");
    expect(decisionStatus(row({ status: "not-acted", outcome: null })).text).toBe("left the board unclicked");
  });

  it("finds its words on the board, else in the gov:click Feed item its click made, else says nothing", () => {
    const board: PresidentBoard = { generatedAt: "2026-09-29T04:00:00.000Z", source: "jev", proposals: [{ id: "loop-a68b41d0", kind: "session", task: "Fix the flaky test", city: "agent-world", model: "sonnet", why: "stale" }] };
    const feed: FeedItem[] = [
      { id: "srv:gov:click:president:treat-93802b548000:launched:2026-09-29T04:13:05.722Z", kind: "system", at: Date.parse("2026-09-29T04:13:05.722Z"), title: "Alex launched a session proposal from the president's board", detail: "OpenRouter key read into 17 transcripts · ranked by jev · tmux aw-e3e64295" },
    ];
    expect(decisionText(row({ id: "loop-a68b41d0", outcome: null, status: "pending" }), board, feed)).toBe("Fix the flaky test (agent-world)");
    expect(decisionText(row({}), board, feed)).toBe("OpenRouter key read into 17 transcripts");
    expect(decisionText(row({ id: "research-x", outcome: null, status: "not-acted" }), board, feed)).toBeNull();
  });

  it("merges the ledger with Jev's rankings, newest first", () => {
    const ranking: FeedItem = { id: "srv:gov:jev:2026-09-29T02:16:51.060Z", kind: "decision", at: Date.parse("2026-09-29T02:16:51.060Z"), title: "Jev ranked 49 candidates: 1 proposed, p(none) 0.10" };
    const t = jevTimeline([row({}), row({ id: "loop-1", actedAt: null, outcome: null, status: "not-acted", proposedAt: "2026-09-28T14:56:09.578Z" })], [ranking, { id: "act:1", kind: "activity", at: NOW, title: "thinking…" }]);
    expect(t.map((e) => e.row?.id ?? e.ranking?.id)).toEqual(["treat-93802b548000", "srv:gov:jev:2026-09-29T02:16:51.060Z", "loop-1"]);
  });
});

describe("Live feed paging", () => {
  it("one page more each time, never past the end", () => {
    expect(nextShown(25, 300)).toBe(50);
    expect(nextShown(290, 300)).toBe(300);
    expect(nextShown(10, 5)).toBe(5);
  });
});
