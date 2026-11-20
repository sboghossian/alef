import { describe, expect, it } from "vitest";
import { parseAutopilotLog } from "../../../server/features/institute-lib";
import type { SkillEvent, StudyPipelineStatus } from "../../../shared/features/skills";
import type { TripwireHit } from "../../../shared/features/tripwires";
import {
  bucketBySession,
  candidateEmptyReason,
  graveyardWindowLabel,
  GRAVEYARD_WINDOW_DAYS,
  INSTITUTE_TAB_ID,
  SKILLS_TABS,
  isSkillEvent,
  mergeEvents,
  MAX_EVENTS_PER_SESSION,
  pairsLine,
  parseSkillEvents,
  repeatingLessons,
  residentSkillsLine,
  revisionsLine,
  skillKindLabel,
} from "./skills-lib";

function ev(o: Partial<SkillEvent> & Pick<SkillEvent, "skillName" | "at">): SkillEvent {
  return { sessionId: "s1", kind: "invoke", ...o };
}

describe("isSkillEvent / parseSkillEvents", () => {
  it("accepts a well-shaped event and rejects malformed ones", () => {
    expect(isSkillEvent(ev({ skillName: "x", at: "2026-09-25T00:00:00.000Z" }))).toBe(true);
    expect(isSkillEvent(null)).toBe(false);
    expect(isSkillEvent("not an object")).toBe(false);
    expect(isSkillEvent({})).toBe(false);
    expect(isSkillEvent({ sessionId: "", skillName: "x", kind: "invoke", at: "t" })).toBe(false); // empty sessionId
    expect(isSkillEvent({ sessionId: "s1", skillName: "x", kind: "bogus", at: "t" })).toBe(false); // unknown kind
    expect(isSkillEvent({ sessionId: "s1", skillName: "x", kind: "invoke" })).toBe(false); // missing at
  });

  it("parseSkillEvents filters an untrusted array down to the valid entries, and treats a non-array as empty", () => {
    const good = ev({ skillName: "grill-me", at: "2026-09-25T00:00:00.000Z" });
    expect(parseSkillEvents([good, { junk: true }, null, "nope"])).toEqual([good]);
    expect(parseSkillEvents(undefined)).toEqual([]);
    expect(parseSkillEvents({ not: "an array" })).toEqual([]);
  });
});

describe("mergeEvents", () => {
  it("dedupes by full identity and sorts oldest-first", () => {
    const a = ev({ skillName: "a", at: "2026-09-25T10:00:00.000Z" });
    const b = ev({ skillName: "b", at: "2026-09-25T09:00:00.000Z" });
    const aAgain = ev({ skillName: "a", at: "2026-09-25T10:00:00.000Z" }); // identical to a
    expect(mergeEvents([a], [b, aAgain])).toEqual([b, a]);
  });

  it("keeps two events for the same skill+session+kind that differ only by timestamp", () => {
    const a = ev({ skillName: "a", at: "2026-09-25T10:00:00.000Z" });
    const aLater = ev({ skillName: "a", at: "2026-09-25T10:05:00.000Z" });
    expect(mergeEvents([a], [aLater])).toEqual([a, aLater]);
  });

  it("caps the merged list at MAX_EVENTS_PER_SESSION, dropping the oldest first", () => {
    const many = Array.from({ length: MAX_EVENTS_PER_SESSION + 10 }, (_, i) => ev({ skillName: `s${i}`, at: new Date(i * 60_000).toISOString() }));
    const merged = mergeEvents([], many);
    expect(merged).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(merged[0]?.skillName).toBe("s10"); // the oldest 10 were dropped
    expect(merged[merged.length - 1]?.skillName).toBe(`s${MAX_EVENTS_PER_SESSION + 9}`);
  });
});

describe("bucketBySession", () => {
  it("groups events by sessionId, preserving relative order within each group", () => {
    const events = [ev({ sessionId: "s1", skillName: "a", at: "t1" }), ev({ sessionId: "s2", skillName: "b", at: "t2" }), ev({ sessionId: "s1", skillName: "c", at: "t3" })];
    const grouped = bucketBySession(events);
    expect([...grouped.keys()].sort()).toEqual(["s1", "s2"]);
    expect(grouped.get("s1")?.map((e) => e.skillName)).toEqual(["a", "c"]);
    expect(grouped.get("s2")?.map((e) => e.skillName)).toEqual(["b"]);
  });
});

describe("skillKindLabel", () => {
  it("labels each kind distinctly", () => {
    expect(skillKindLabel("invoke")).toBe("ran");
    expect(skillKindLabel("slash")).toBe("typed");
    expect(skillKindLabel("suggested")).toBe("suggested");
  });
});

describe("INSTITUTE_TAB_ID", () => {
  it("stays 'candidates' so old deep links keep working", () => {
    expect(INSTITUTE_TAB_ID).toBe("candidates");
  });

  it("the study tab reads 'School': 'Institute' now names the Institute of Truth, never a Skills tab", () => {
    expect(SKILLS_TABS.map((t) => t.label)).toEqual(["Top used", "Graveyard", "School"]);
    expect(SKILLS_TABS.find((t) => t.id === INSTITUTE_TAB_ID)?.label).toBe("School");
    for (const t of SKILLS_TABS) expect(t.label).not.toMatch(/institute/i);
  });
});

describe("graveyardWindowLabel", () => {
  const now = Date.parse("2026-09-28T00:00:00.000Z");

  it("at 24 days of history: the real, shorter window", () => {
    const start = new Date(now - 24 * 24 * 60 * 60 * 1000).toISOString();
    expect(graveyardWindowLabel(start, now)).toBe(`0 fires since ${start.slice(0, 10)} (24 days of history)`);
  });

  it("at 120 days of history: falls back to the nominal 90-day label", () => {
    const start = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString();
    expect(graveyardWindowLabel(start, now)).toBe(`0 fires in ${GRAVEYARD_WINDOW_DAYS} days`);
  });

  it("exactly 90 days: the boundary also falls back to the nominal label", () => {
    const start = new Date(now - GRAVEYARD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(graveyardWindowLabel(start, now)).toBe(`0 fires in ${GRAVEYARD_WINDOW_DAYS} days`);
  });

  it("no history yet, or an unparseable date: the nominal label, not a crash", () => {
    expect(graveyardWindowLabel(null, now)).toBe(`0 fires in ${GRAVEYARD_WINDOW_DAYS} days`);
    expect(graveyardWindowLabel("not a date", now)).toBe(`0 fires in ${GRAVEYARD_WINDOW_DAYS} days`);
  });
});

function studyStatus(overrides: Partial<StudyPipelineStatus> = {}): StudyPipelineStatus {
  return { line: "some status line", enabled: true, stats: null, logPartial: false, ...overrides };
}

describe("candidateEmptyReason", () => {
  it("autopilot.log missing entirely", () => {
    expect(candidateEmptyReason(studyStatus({ stats: null, line: "autopilot.log not found — the study pipeline has never run" }))).toMatch(/never run/);
  });

  it("the pipeline has never launched a study run", () => {
    const stats = { forksLaunched: 0, forksFailed: 0, forksOk: 0, noDraft: 0, permissionSkips: 0, thresholdSkips: 0, lastRunAt: null, lastSuccessAt: null, lastDraftAt: null, lastExitRc: null, lastFailureLine: null };
    expect(candidateEmptyReason(studyStatus({ stats }))).toMatch(/hasn't launched/);
  });

  it("recent runs are failing (the last completed run's exit was non-zero)", () => {
    // Real-shaped log: built through parseAutopilotLog, not hand-rolled — a launch line and its
    // exit line NEVER share a timestamp in a real log, so a fixture that makes them equal (the
    // confirmed bug's test did exactly that) proves nothing about real behavior.
    const log = [
      "2026-09-27 08:42:26 fork launched (survivors=12)",
      "2026-09-27 08:42:59 fork: claude exited rc=1",
      "fork: no draft / unparseable output",
    ].join("\n");
    const stats = parseAutopilotLog(log);
    const line = "No new draft since 2026-05-24 (last clean exit 2026-06-08): 1 of 1 study runs failed (autopilot.log)";
    expect(candidateEmptyReason(studyStatus({ stats, line }))).toBe(`No candidates — the study pipeline is failing: ${line}`);
  });

  it("healthy: the last completed run exited rc=0 (confirmed-bug reproduction — launch and exit times always differ)", () => {
    // This is the exact shape from the confirmed finding: launched at 10:00:00, clean exit at
    // 10:01:10. The old lastRunAt !== lastSuccessAt check was always true here (different
    // timestamps), so a healthy pipeline was reported as failing.
    const log = ["2026-09-28 10:00:00 fork launched (survivors=1)", "2026-09-28 10:01:10 fork: claude exited rc=0", "2026-09-28 10:01:10 fork: SKIPPED nothing clears the bar"].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.lastRunAt).not.toBe(stats.lastSuccessAt); // sanity: proves this is a real-shaped, non-degenerate fixture
    expect(candidateEmptyReason(studyStatus({ stats }))).toMatch(/nothing has cleared the leverage bar/);
  });

  it("healthy even when the clean run also authored a draft", () => {
    const log = ["2026-09-28 10:00:00 fork launched (survivors=1)", "2026-09-28 10:01:10 fork: claude exited rc=0", "2026-09-28 10:01:10 fork: AUTHORED some-skill"].join("\n");
    const stats = parseAutopilotLog(log);
    expect(candidateEmptyReason(studyStatus({ stats }))).toMatch(/nothing has cleared the leverage bar/);
  });
});

function hit(overrides: Partial<TripwireHit> & Pick<TripwireHit, "tripwireId" | "at">): TripwireHit {
  return { id: `${overrides.tripwireId}-${overrides.at}`, sessionId: "s1", subagentId: null, district: null, lesson: "a lesson", severity: "warn", source: "journal", tool: "Bash", snippet: "cmd", ...overrides };
}

describe("repeatingLessons", () => {
  it("groups by tripwireId and keeps only 3+ hits, using the latest hit's lesson text", () => {
    const hits: TripwireHit[] = [
      hit({ tripwireId: "rtk-hides-secrets", at: "2026-09-25T00:00:00.000Z", lesson: "old wording" }),
      hit({ tripwireId: "rtk-hides-secrets", at: "2026-09-26T00:00:00.000Z", lesson: "old wording" }),
      hit({ tripwireId: "rtk-hides-secrets", at: "2026-09-27T00:00:00.000Z", lesson: "latest wording wins" }),
      hit({ tripwireId: "only-twice", at: "2026-09-27T00:00:00.000Z" }),
      hit({ tripwireId: "only-twice", at: "2026-09-26T00:00:00.000Z" }),
    ];
    const lessons = repeatingLessons(hits);
    expect(lessons).toEqual([{ tripwireId: "rtk-hides-secrets", lesson: "latest wording wins", hitCount: 3, severity: "warn" }]);
  });

  it("no lesson has repeated 3+ times: empty, not an error", () => {
    expect(repeatingLessons([hit({ tripwireId: "a", at: "t1" }), hit({ tripwireId: "b", at: "t2" })])).toEqual([]);
  });

  it("empty hit list", () => {
    expect(repeatingLessons([])).toEqual([]);
  });

  it("sorts by hit count descending, then tripwireId", () => {
    const many = (id: string, n: number): TripwireHit[] => Array.from({ length: n }, (_, i) => hit({ tripwireId: id, at: `2026-09-2${i}T00:00:00.000Z` }));
    const lessons = repeatingLessons([...many("b", 3), ...many("a", 5)]);
    expect(lessons.map((l) => l.tripwireId)).toEqual(["a", "b"]);
  });
});

describe("measured-change headlines (School tab)", () => {
  const since = "2026-08-29T12:00:00.000Z";
  it("revisionsLine states the window and the source, and a failed read as a failure", () => {
    expect(revisionsLine({ ok: true, error: null, days: 30, since, commits: 38, skillCount: 27, skills: [] })).toBe(
      "38 commits changed the SKILL.md of 27 skills in the last 30 days (since 2026-08-29; git log on skills-repo, read-only). One sync commit can carry several edits.",
    );
    expect(revisionsLine({ ok: true, error: null, days: 30, since, commits: 0, skillCount: 0, skills: [] })).toBe("No SKILL.md changed in the last 30 days (since 2026-08-29; git log on skills-repo, read-only).");
    expect(revisionsLine({ ok: false, error: "fatal: not a git repository", days: 30, since, commits: 0, skillCount: 0, skills: [] })).toBe("Couldn't read skills-repo's git log: fatal: not a git repository.");
  });

  it("pairsLine never calls a later revision a fix, and names what it couldn't read", () => {
    const base = { ok: true, error: null, historySince: "2026-05-20T08:11:28.000Z", entries: [], logged: 0, followed: 0, uncommitted: 0, outsideRepo: 1, truncated: false };
    expect(pairsLine(base)).toBe(
      "0 failure modes logged in a skills-repo commit since 2026-05-20; 0 followed by a later SKILL.md revision (a later edit to the skill, not proof it fixed that failure). 1 entry in skills outside skills-repo (their history isn't read).",
    );
    expect(pairsLine({ ...base, ok: false, error: "skills-repo not found", outsideRepo: 0 })).toBe("Couldn't read the failure-mode history: skills-repo not found.");
  });

  it("residentSkillsLine: 0 written is said with its window; otherwise written and cited", () => {
    const r = { ok: true, error: null, written: 0, cited: 0, skills: [], journalDays: 3, journalSince: "2026-09-26", auditSince: "2026-09-26T05:00:00.000Z" };
    expect(residentSkillsLine(r)).toBe("The resident has written 0 skills in its sandbox (its audit log since 2026-09-26).");
    expect(residentSkillsLine({ ...r, written: 2, cited: 1 })).toBe("The resident wrote 2 skills in its sandbox; 1 named again in a later reflection or proposal (3 journal days read since 2026-09-26; its audit log since 2026-09-26).");
    expect(residentSkillsLine({ ...r, ok: false, error: "no resident home" })).toBe("Couldn't read the resident's home: no resident home.");
  });
});
