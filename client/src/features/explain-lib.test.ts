import { describe, expect, it } from "vitest";
import type { CliStationSnapshot } from "../../../shared/features/cli-station";
import type { EpisodicStats, ProceduralStats, SemanticStats } from "../../../shared/features/memory-layers";
import type { WakeRecallSummary } from "../../../shared/features/wake-recall";
import type { WorldAgent } from "../../../shared/types";
import {
  KIND_LABELS,
  MODEL_BUILD_STAGES,
  buildingCard,
  campusActions,
  carCard,
  cliStationCard,
  clinicCard,
  districtCard,
  episodicCard,
  hallCard,
  gateCard,
  harnessCard,
  houseCard,
  instituteOfTruthCard,
  isToday,
  jevTowerCard,
  moonCard,
  plantCard,
  proceduralCard,
  routinesCard,
  schoolCard,
  semanticCard,
  stationCard,
  subagentsCard,
} from "./explain-lib";
import { lampState, parseInstituteBlock } from "./system-places-lib";

const SINCE = Date.parse("2026-09-26T00:00:00Z");

function agent(over: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id: "a1",
    islandId: "c1",
    cwd: "/x",
    title: "Fix the build",
    status: "live",
    startedAt: "2026-09-26T08:00:00Z",
    lastActive: "2026-09-26T09:00:00Z",
    messageCount: 12,
    model: "claude-opus-5-5",
    role: "builder",
    color: "#fff",
    targetIslandId: "c1",
    tokens: 12345,
    awaitingInput: false,
    ...over,
  };
}

const live = (card: { live: Array<[string, string]> }): Record<string, string> => Object.fromEntries(card.live);

describe("labels", () => {
  it("every kind has a short plain label", () => {
    for (const text of Object.values(KIND_LABELS)) {
      expect(text.length).toBeGreaterThan(5);
      expect(text.length).toBeLessThanOrEqual(42);
    }
    expect(KIND_LABELS.house).toMatch(/session/i);
    expect(KIND_LABELS.drone).toMatch(/subagent/i);
    expect(KIND_LABELS.moon).toMatch(/Jev/);
  });
});

describe("cards from real data", () => {
  it("isToday handles junk", () => {
    expect(isToday("2026-09-26T01:00:00Z", SINCE)).toBe(true);
    expect(isToday("2026-09-25T23:00:00Z", SINCE)).toBe(false);
    expect(isToday("garbage", SINCE)).toBe(false);
    expect(isToday(null, SINCE)).toBe(false);
  });

  it("district: live / all counts, today only when something happened", () => {
    const c = districtCard("agent-world", [agent(), agent({ status: "dormant", lastActive: "2026-09-01T00:00:00Z" })], 3, SINCE);
    expect(live(c)).toEqual({ "Live now": "1", Sessions: "2" });
    expect(c.today).toEqual(["1 session active today", "3 activity lines seen since this page opened"]);
    expect(districtCard("empty", [], 0, SINCE).today).toEqual([]);
  });

  it("house: state, model family, counts", () => {
    const c = houseCard(agent(), "working", 1, 2, SINCE);
    expect(c.title).toBe("🏠 Fix the build");
    expect(live(c)).toMatchObject({ State: "working", Model: "Opus (claude-opus-5-5)", Messages: "12", Subagents: "2" });
    expect(c.today[1]).toBe("1 activity line seen since this page opened");
    const asleep = houseCard(agent({ status: "dormant", model: null, title: "" }), null, 0, 0, SINCE);
    expect(asleep.title).toBe("🏠 Untitled session");
    expect(live(asleep)).toMatchObject({ State: "asleep", Model: "unknown" });
  });

  it("subagents: no data is said, not zeroed", () => {
    expect(live(subagentsCard(null))).toEqual({ Subagents: "no data yet" });
    const c = subagentsCard({ total: 911, today: 13, live: 5, parents: 99 });
    expect(live(c)).toEqual({ "Flying now": "5", "All subagents": "911", "Parent sessions": "99" });
    expect(c.today).toEqual(["13 subagents active today"]);
  });

  it("station, harness, building", () => {
    expect(stationCard("bash", "Fix", 4).today).toEqual(["4 Bash calls seen since this page opened (Fix)"]);
    expect(stationCard("edit", null, 0).today).toEqual([]);
    expect(live(harnessCard([{ kind: "skill" }, { kind: "skill" }, { kind: "hook" }, { kind: "mcp" }, { kind: "file" }]))).toEqual({ Skills: "2", Hooks: "1", "MCP servers": "1" });
    expect(live(buildingCard({ kind: "mcp", name: "linear", usage: 1 }))).toEqual({ "Used by": "1 session" });
  });

  it("Jev tower: the router hook state is reported honestly", () => {
    const jev = { status: "online" as const, decisions: [] };
    expect(live(jevTowerCard(jev, "likely", 3142, 0, 2, SINCE))["Router hook"]).toMatch(/likely/);
    const absent = jevTowerCard(jev, "absent", null, 0, 0, SINCE);
    expect(live(absent)["Router hook"]).toBe("not seen");
    expect(live(absent)["Notes it can suggest"]).toBe("no data");
    expect(absent.what).toMatch(/No Jev router hook/);
    expect(absent.today).toEqual([]);
  });

  it("moon: decisions today + the last one", () => {
    const c = moonCard(
      {
        status: "fallback",
        lastTickAt: null,
        decisions: [{ id: "d", at: "2026-09-26T08:00:00Z", kind: "pair", subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "a visits b" }],
      },
      SINCE,
    );
    expect(c.today[0]).toBe("1 decision today (of the last 1 kept)");
    expect(c.today[1]).toMatch(/a visits b \(rules\)$/);
    expect(live(c)).toMatchObject({ Status: "fallback", "Last tick": "never" });
  });

  it("never says Jev moves agents: planes come from a live agent's own file touches, car trips from its own skill/MCP calls", () => {
    const jevMovesAgents = /nudge|visit each other|which agents visit|Jev sends|sends (it|them|agents)/i;
    const moon = moonCard({ status: "online", lastTickAt: null, decisions: [] }, SINCE);
    const car = carCard("Fix the build", null);
    for (const c of [moon, car]) expect(c.what).not.toMatch(jevMovesAgents);
    expect(moon.what).toMatch(/grows the harness skills and MCP servers you use most/); // director.ts's only question: grow
    expect(car.what).toMatch(/skill or MCP server/); // main.ts animateActivity: only skill/MCP targets start a trip
  });

  it("plant carries the model build-stages strip; gate reports its scripts honestly", () => {
    const p = plantCard({ family: "opus", label: "Opus", live: 3, today: 7, total: 174 }, 2);
    expect(live(p)).toEqual({ "Live sessions": "3", "All sessions": "174" });
    expect(p.today).toEqual(["7 sessions active today", "2 couriers passed through since this page opened"]);
    expect(p.buildStages).toBe(MODEL_BUILD_STAGES);
    const g = gateCard({ event: "Stop", configured: false, scripts: [] }, 0);
    expect(g.what).toMatch(/No script is configured/);
    expect(live(g)).toEqual({ Scripts: "none" });
    const many = gateCard({ event: "UserPromptSubmit", configured: true, scripts: ["a", "b", "c", "d", "e", "f", "g", "h"] }, 1);
    expect(live(many).Runs).toBe("a, b, c, d, e, f +2");
  });

  it("model build stages: only Data and Serving carry a number", () => {
    expect(MODEL_BUILD_STAGES.map((s) => s.stage)).toEqual(["Data", "Tokens", "Transformer", "Pre-training", "Post-training", "Serving"]);
    const withNumbers = MODEL_BUILD_STAGES.filter((s) => /\d/.test(s.text)).map((s) => s.stage);
    expect(withNumbers).toEqual(["Data", "Serving"]);
  });

  it("episodic archive: transcripts, subagent transcripts, recall index; no data is said, not zeroed", () => {
    expect(live(episodicCard(null, 0))).toMatchObject({ "Session transcripts": "no data", "Subagent transcripts": "no data", "Recall index": "no data" });
    const stats: EpisodicStats = { transcriptFiles: 1199, subagentTranscriptFiles: 941, recallIndex: { present: true, sizeBytes: 39_000_000, lastIndexedAt: "2026-09-26T12:00:00Z" } };
    const c = episodicCard(stats, 3);
    expect(live(c)["Session transcripts"]).toBe((1199).toLocaleString());
    expect(live(c)["Recall index"]).toMatch(/MB/);
    expect(live(c)["Thinks at"]).toBe("read time");
    expect(c.today).toEqual(["3 couriers passed since this page opened"]);
  });

  it("semantic library: confidence mix and staleness; excludes nothing the caller didn't compute", () => {
    expect(live(semanticCard(null, 0))["Memory files"]).toBe("no data");
    const stats: SemanticStats = { fileCount: 435, confidence: { verified: 105, reported: 23, hypothesis: 11, unmarked: 296 }, staleDays: 60, staleCount: 40 };
    const c = semanticCard(stats, 5);
    expect(live(c)).toMatchObject({ "Memory files": "435", "✅ Verified": "105", "📣 Reported": "23", "🧪 Hypothesis": "11", Unmarked: "296", "Stale (60+ days)": "40" });
    expect(live(c)["Thinks at"]).toBe("write time");
  });

  it("procedural workshop: skills + patches; frozen thinking time", () => {
    expect(live(proceduralCard(null, 0))["Skills"]).toBe("no data");
    const stats: ProceduralStats = { skillCount: 170, patchedSkillCount: 1, patchEntryCount: 1 };
    const c = proceduralCard(stats, 0);
    expect(live(c)).toEqual({ Skills: "170", "Patched skills": "1", "Patch entries": "1", "Thinks at": "never (frozen)" });
  });

  it("CLI station: empty/missing registry says so in plain words, not a zero row", () => {
    expect(cliStationCard(null).what).toMatch(/No CLIs registered yet/);
    expect(cliStationCard({ registryPresent: false, clis: [], invalidCount: 0, scannedAt: "" }).what).toMatch(/No CLIs registered yet/);
    expect(cliStationCard({ registryPresent: true, clis: [], invalidCount: 0, scannedAt: "" }).what).toMatch(/No CLIs registered yet/);
    const snap: CliStationSnapshot = {
      registryPresent: true,
      invalidCount: 1,
      scannedAt: "",
      clis: [
        { name: "recall", tool: "transcripts", purpose: "search", entry: "/x", language: "python3", created: "2026-09-23", author: "agent", tests: null },
        { name: "jev-search", tool: "search", purpose: "rank", entry: "/y", language: "python3", created: "2026-09-26", author: "agent", tests: null },
      ],
    };
    const c = cliStationCard(snap);
    expect(live(c)).toEqual({ CLIs: "2", "Invalid entries": "1", "Most recent": "jev-search" });
  });

  it("routines: counts, failing names, recent runs; null = no data", () => {
    expect(live(routinesCard(null))).toEqual({ Routines: "no data" });
    const c = routinesCard([
      { shortName: "a", running: true, lastExitStatus: 0, ranRecently: true },
      { shortName: "b", running: false, lastExitStatus: 1, ranRecently: false },
      { shortName: "c", running: false, lastExitStatus: null, ranRecently: false },
    ]);
    expect(live(c)).toEqual({ Routines: "3", "Running now": "1", Failing: "b" });
    expect(c.today).toEqual(["Ran in the last 5 min: a"]);
  });
});

describe("the Institute of Truth", () => {
  // The real totals GET /api/wake-recall served on 2026-09-28 (a throwaway run over the real
  // transcripts; the offline recount of the same 210 heads agrees on every number).
  const measured: WakeRecallSummary = {
    ready: true,
    vaultNotes: 31390,
    totals: {
      sessions: 210,
      fed: 167,
      nothing: 36,
      unread: 7,
      pending: 0,
      headlessMisses: 34,
      reasons: { "timed-out": 13, failed: 8, "no-trace": 15 },
      notes: 994,
      promptRecalls: 91,
      promptRecallSessions: 75,
      today: { sessions: 7, fed: 5, nothing: 2 },
    },
  };
  const semantic: SemanticStats = { fileCount: 435, confidence: { verified: 105, reported: 23, hypothesis: 11, unmarked: 296 }, staleDays: 60, staleCount: 40 };

  it("fed N of M at wake, who woke with nothing and why, prompt recalls, the memory mix, vault and recall sizes", () => {
    const c = instituteOfTruthCard({ wake: measured, semantic, recall: { docCount: 3145, ready: true } });
    expect(c.title).toBe("🏛️ Institute of Truth");
    expect(c.what).toMatch(/second brain/);
    expect(c.what).toMatch(/Not the School/);
    expect(live(c)).toEqual({
      "Fed at wake": "167 of 203 sessions",
      "Woke with nothing": "36 (34 headless)",
      "Why nothing": "13 timed out · 8 failed · 15 left no trace",
      "Wake not read": "7 (first line over 256 KB)",
      "Notes injected at wake": (994).toLocaleString(),
      // Only each transcript's head is read, so this is not a total (the full transcripts held 4,012 in
      // 180 sessions that day): the row names its scope.
      "Prompt-time recalls": "91 in 75 sessions (first 256 KB of each transcript)",
      "Memory files": "435 (✅ 105 · 📣 23 · 🧪 11 · 296 unmarked)",
      "Vault notes": (31390).toLocaleString(),
      "Recall index": `${(3145).toLocaleString()} chunks`,
    });
    expect(c.today).toEqual(["7 sessions started today: 5 woke with notes, 2 with nothing"]);
  });

  it("missing sources say no data; a cold pass still running says so instead of partial numbers", () => {
    const none = live(instituteOfTruthCard({ wake: null, semantic: null, recall: null }));
    expect(none["Fed at wake"]).toBe("no data");
    expect(none["Memory files"]).toBe("no data");
    expect(none["Vault notes"]).toBe("no data");
    expect(none["Recall index"]).toBe("no data");
    const reading = instituteOfTruthCard({ wake: { ...measured, ready: false }, semantic, recall: { docCount: 0, ready: false } });
    expect(live(reading)["Fed at wake"]).toBe("reading transcripts…");
    expect(live(reading)["Wake not read"]).toBeUndefined();
    expect(live(reading)["Recall index"]).toBe("building");
    expect(reading.today).toEqual([]);
  });

  it("the three memory cards are the Institute of Truth's archive, library and workshop", () => {
    expect(episodicCard(null, 0).what).toMatch(/^The Institute of Truth's archive\./);
    expect(semanticCard(null, 0).what).toMatch(/^The Institute of Truth's library\./);
    expect(proceduralCard(null, 0).what).toMatch(/^The Institute of Truth's workshop\./);
  });
});

describe("campus cards (agent-city piece 7)", () => {
  const NOW = Date.parse("2026-09-28T09:00:00.000Z");
  const realStudy = {
    line: "No new draft since 2026-05-24 (last clean exit 2026-06-08): 149 of 160 study runs failed (autopilot.log)",
    enabled: true,
    stats: {
      forksLaunched: 160,
      forksFailed: 149,
      forksOk: 10,
      noDraft: 149,
      permissionSkips: 3,
      thresholdSkips: 1808,
      lastRunAt: "2026-09-28T05:32:02.000Z",
      lastSuccessAt: "2026-06-08T05:59:05.000Z",
      lastDraftAt: "2026-05-24T14:53:50.000Z",
      lastExitRc: 1,
      lastFailureLine: "2026-09-28 08:32:37 fork: no draft / unparseable output",
    },
    logPartial: false,
  };
  const inst = parseInstituteBlock({ ok: true, candidates: [], institute: { study: realStudy, darwin: [], failureModes: { skills: [], patchedSkillCount: 0, patchEntryCount: 0 } } });
  const rows = (c: { live: Array<[string, string]> }): Record<string, string> => Object.fromEntries(c.live);

  it("School with no data: every number says so, the lamp says why", () => {
    const card = schoolCard({ lamp: lampState(null, NOW), institute: null, candidates: null, hallPanel: false });
    const r = rows(card);
    expect(r["Lamp"]).toBe("no data: the Skills snapshot hasn't loaded");
    for (const k of ["Last draft", "Last clean exit", "Last study run", "Study runs failed", "Autopilot", "Candidates queued"]) expect(r[k]).toBe("no data");
    expect(card.title).toBe("🏫 School");
    expect(card.title).not.toMatch(/institute/i);
  });

  it("School on the real block: dim, real dates and counts, never a clean exit dressed as a draft", () => {
    const card = schoolCard({ lamp: lampState(inst?.block, NOW), institute: inst?.block ?? null, candidates: inst?.candidates ?? null, hallPanel: false });
    const r = rows(card);
    expect(r["Lamp"]).toBe("dim (red lamp): no new draft since 2026-05-24 (126 days)");
    expect(r["Last draft"]).toBe("2026-05-24");
    expect(r["Last clean exit"]).toBe("2026-06-08");
    expect(r["Study runs failed"]).toBe("149 of 160");
    expect(r["Autopilot"]).toBe("enabled");
    expect(r["Candidates queued"]).toBe("0");
  });

  it("Hall with no data: 'no data', never 0 banners or 0 shipped", () => {
    const r = rows(hallCard({ careers: null, banners: null, shipped: null, hallPanel: false, redacted: false }));
    expect(r["Banners"]).toBe("no data");
    expect(r["Trusted workers"]).toBe("no data");
    expect(r["Workers in the Tower"]).toBe("no data");
    expect(r["Shipped, last 7 days"]).toBe("no data");
  });

  it("Hall on today's real numbers: no trusted worker, no banner; 38 shipped this week", () => {
    const summary = { trusted: 0, probation: 3, enrolled: 4, lapsed: 21, returned: 0, retired: 0, total: 28 };
    const r = rows(hallCard({ careers: { summary, workers: [{ key: "/daily-recap", name: null, state: "enrolled" }] }, banners: { shown: 0, unshown: 0 }, shipped: { count: 38, undated: 0 }, hallPanel: false, redacted: false }));
    expect(r["Banners"]).toBe("0");
    expect(r["Trusted workers"]).toBe("none yet");
    expect(r["Workers in the Tower"]).toBe("28");
    expect(r["Shipped, last 7 days"]).toBe("38 sessions");
  });

  it("Hall past twelve trusted: says how many have no banner; names the trusted ones; counts undated ships", () => {
    const workers = Array.from({ length: 14 }, (_, i) => ({ key: `/w${i}`, name: i === 0 ? "Recap" : null, state: "trusted" as const }));
    const summary = { trusted: 14, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 14 };
    const r = rows(hallCard({ careers: { summary, workers }, banners: { shown: 12, unshown: 2 }, shipped: { count: 1, undated: 3 }, hallPanel: true, redacted: false }));
    expect(r["Banners"]).toBe("12 (+2 trusted without one: max 12)");
    expect(r["Trusted workers"]).toBe("14: Recap, /w1, /w2, /w3, /w4, /w5 +8");
    expect(r["Shipped, last 7 days"]).toBe("at least 1 session (3 shipped with no merge time)");
  });

  it("a server that sends no merge times (before this PR): a floor, never a bare 0", () => {
    // What the live :5179 served on 2026-09-28: 62 shipped rows, none dated.
    const r = rows(hallCard({ careers: null, banners: null, shipped: { count: 0, undated: 62 }, hallPanel: false, redacted: false }));
    expect(r["Shipped, last 7 days"]).toBe("unknown (62 shipped with no merge time)");
  });

  it("?redact=1: trusted workers are counted, never named (as on the AUTO lot callouts)", () => {
    const summary = { trusted: 2, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 2 };
    const workers = [
      { key: "/inbox-sweep", name: "Carillon", state: "trusted" as const },
      { key: "⏰ rss-feed-obsidian", name: null, state: "trusted" as const },
    ];
    const card = hallCard({ careers: { summary, workers }, banners: { shown: 2, unshown: 0 }, shipped: { count: 0, undated: 0 }, hallPanel: false, redacted: true });
    expect(rows(card)["Trusted workers"]).toBe("2 (names hidden)");
    expect(JSON.stringify(card)).not.toMatch(/Carillon|inbox-sweep|rss-feed/);
  });

  it("buttons: School tab and Tower always; the Hall only once its panel is registered", () => {
    expect(campusActions(false)).toEqual(["school", "tower"]);
    expect(campusActions(true)).toEqual(["school", "tower", "hall"]);
    expect(schoolCard({ lamp: lampState(null, NOW), institute: null, candidates: null, hallPanel: false }).actions).toEqual(["school", "tower"]);
    expect(hallCard({ careers: null, banners: null, shipped: null, hallPanel: true, redacted: false }).actions).toEqual(["school", "tower", "hall"]);
  });

  it("both places have an Explain tag", () => {
    expect(KIND_LABELS.school).toBe("School: where skills are studied");
    expect(KIND_LABELS.hall).toBe("Graduates' Hall: trusted workers");
  });
});

describe("the Clinic's card (vision wave 4)", () => {
  // GET /api/sickness's counts on 2026-09-28 ~16:00: 272 cases, 64 sick in 27 sessions.
  const counts = {
    total: 272,
    byKind: { "leaked-key": 23, "broken-build": 249, "steering-page": 0 },
    byState: { open: 23, chronic: 41, exposed: 0, treated: 0, healed: 208 },
    byLineage: {},
  };
  const lit = { state: "lit" as const, sessions: 27, why: "27 sick sessions" };

  it("real counts: the lamp, sick now, sessions, houses marked, treated/healed, all cases", () => {
    const c = clinicCard({ lamp: lit, counts, sickSessions: 27, source: "cases", marks: { shown: 27, unplaced: 0, unshown: 0, drawn: true }, drawing: true, today: { opened: 0, healed: 0 } });
    expect(c.title).toBe("🏥 Clinic");
    expect(live(c)).toEqual({
      Lamp: "lit: 27 sick sessions",
      "Sick now": "64 cases (23 open · 41 chronic · 0 exposed)",
      "Sick sessions": "27",
      "Houses marked": "27 houses",
      "Treated · healed": "0 treated (📣 reported by you) · 208 healed",
      "All cases": "272 (23 leaked key · 249 broken build · 0 steering page)",
    });
    expect(c.what).toMatch(/lit while any case is sick/);
    expect(c.today).toEqual([]); // nothing first seen or healed today: the card's "Nothing seen today yet."
  });

  it("today: cases first seen and healed since midnight, from the list", () => {
    const base = { lamp: lit, counts, sickSessions: 27, source: "cases" as const, marks: { shown: 27, unplaced: 0, unshown: 0, drawn: true }, drawing: true };
    expect(clinicCard({ ...base, today: { opened: 7, healed: 2 } }).today).toEqual(["7 cases first seen today · 2 healed today"]);
    expect(clinicCard({ ...base, today: { opened: 1, healed: 0 } }).today).toEqual(["1 case first seen today · 0 healed today"]);
    expect(clinicCard({ ...base, today: { opened: 0, healed: 3 } }).today).toEqual(["0 cases first seen today · 3 healed today"]);
  });

  it("no data says so, never 0", () => {
    const c = clinicCard({ lamp: { state: "unknown", sessions: null, why: "no data: the sickness list hasn't loaded" }, counts: null, sickSessions: null, source: null, marks: { shown: 0, unplaced: 0, unshown: 0, drawn: true }, drawing: true, today: null });
    const l = live(c);
    expect(c.today).toEqual(["no data (the case list hasn't loaded)"]); // never "nothing seen today"
    expect(l.Lamp).toBe("no data: the sickness list hasn't loaded");
    expect(l["Sick now"]).toMatch(/^no data/);
    expect(l["Sick sessions"]).toBe("no data");
    expect(l["Houses marked"]).toBe("no data");
    expect(l["All cases"]).toMatch(/^no data/);
  });

  it("says where the sessions came from, what isn't marked, and when nothing is drawn", () => {
    const snap = clinicCard({ lamp: lit, counts: null, sickSessions: 27, source: "snapshot", marks: { shown: 25, unplaced: 2, unshown: 0, drawn: true }, drawing: false, today: null });
    expect(live(snap)["Sick sessions"]).toBe("27 (from the last snapshot; the live list is loading)");
    expect(live(snap)["Houses marked"]).toBe("25 houses (2 sick sessions have no house on the planet) · 3D is off: not drawn");
    const one = clinicCard({ lamp: lit, counts, sickSessions: 1, source: "cases", marks: { shown: 0, unplaced: 1, unshown: 0, drawn: true }, drawing: true, today: { opened: 0, healed: 0 } });
    expect(live(one)["Houses marked"]).toBe("0 houses (1 sick session has no house on the planet)");
    const noQuarter = clinicCard({ lamp: lit, counts, sickSessions: 27, source: "cases", marks: { shown: 0, unplaced: 0, unshown: 0, drawn: false }, drawing: true, today: { opened: 0, healed: 0 } });
    expect(live(noQuarter)["Houses marked"]).toBe("none: no System Quarter on this planet");
    const dark = clinicCard({ lamp: { state: "dark", sessions: 0, why: "no sick case" }, counts, sickSessions: 0, source: "cases", marks: { shown: 0, unplaced: 0, unshown: 0, drawn: true }, drawing: true, today: { opened: 0, healed: 0 } });
    expect(live(dark).Lamp).toBe("dark: no sick case");
  });
});
