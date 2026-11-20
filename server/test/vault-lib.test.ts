import { describe, expect, it } from "vitest";
import type { VaultNote, VaultNotesQuery } from "../../shared/features/vault.js";
import {
  dayToIso,
  dayToMonth,
  dowOf,
  folderOf,
  inboundCounts,
  vaultClimb,
  vaultEchoes,
  vaultFocus,
  vaultGaps,
  vaultGrowth,
  vaultMeetings,
  vaultNotes,
  vaultPeople,
  vaultProjects,
  vaultPulse,
  vaultSources,
  vaultTopics,
  weekOf,
} from "../features/vault-lib.js";

const DAY_MS = 86_400_000;
function isoDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
}

/** 2026-10-26, a Monday. Every fixture below is written as an offset from it. */
const T = isoDay("2026-10-26");
const ago = (k: number): number => T - k;

let seq = 0;
function note(p: Partial<VaultNote> = {}): VaultNote {
  seq++;
  const id = p.id ?? `n${String(seq).padStart(6, "0")}`;
  return {
    id,
    path: `00-Inbox/${id}.md`,
    kind: "n",
    type: "",
    day: null,
    hour: null,
    project: "",
    umbrella: "",
    tags: [],
    links: [],
    ghosts: [],
    minutes: null,
    mentionWeeks: null,
    mentionLast: null,
    up: null,
    upRule: "",
    ...p,
  };
}

/** `count` notes at one path prefix and day, for building bulk fixtures. */
function many(count: number, p: Partial<VaultNote>): VaultNote[] {
  return Array.from({ length: count }, () => note(p));
}

// ---------------------------------------------------------------- helpers

describe("day, week and folder helpers", () => {
  it("dayToIso and dayToMonth", () => {
    expect(dayToIso(0)).toBe("1970-01-01");
    expect(dayToIso(T)).toBe("2026-10-26");
    expect(dayToIso(isoDay("2024-02-29"))).toBe("2024-02-29");
    expect(dayToMonth(T)).toBe("2026-10");
    expect(dayToMonth(-1)).toBe("1969-12");
  });

  it("weekOf is absolute weeks since the epoch, floored", () => {
    expect(weekOf(0)).toBe(0);
    expect(weekOf(6)).toBe(0);
    expect(weekOf(7)).toBe(1);
    expect(weekOf(-1)).toBe(-1);
    expect(weekOf(T)).toBe(2964);
    // the bucket containing 2026-10-26 starts on Thursday 2026-10-22
    expect(dayToIso(weekOf(T) * 7)).toBe("2026-10-22");
  });

  it("dowOf is Monday-first: the +3 moves the Thursday epoch onto it", () => {
    expect(dowOf(0)).toBe(3); // 1970-01-01, Thursday
    expect(dowOf(-1)).toBe(2); // 1969-12-31, Wednesday
    expect(dowOf(isoDay("2000-01-01"))).toBe(5); // Saturday
    expect(dowOf(T)).toBe(0); // 2026-10-26, Monday
    expect(dowOf(T - 1)).toBe(6); // 2026-10-25, Sunday
    expect(dowOf(T + 6)).toBe(6);
    expect(dowOf(T + 7)).toBe(0);
  });

  it("folderOf is the text before the first slash, empty at the vault root", () => {
    expect(folderOf("30-Knowledge/people/Ann.md")).toBe("30-Knowledge");
    expect(folderOf("a/b.md")).toBe("a");
    expect(folderOf("root.md")).toBe("");
    expect(folderOf("")).toBe("");
  });
});

describe("inboundCounts", () => {
  it("counts distinct linking notes per target", () => {
    const notes = [
      note({ id: "a", links: ["c", "c", "b"] }),
      note({ id: "b", links: ["c"] }),
      note({ id: "c" }),
    ];
    const m = inboundCounts(notes);
    expect(m.get("c")).toBe(2); // a (once, despite the duplicate) and b
    expect(m.get("b")).toBe(1);
    expect(m.get("a")).toBeUndefined();
    expect(inboundCounts([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------- pulse

function pulseFixture(): VaultNote[] {
  return [
    note({ path: "10-Sessions/claude-code/a.md", day: ago(0) }),
    note({ path: "10-Sessions/claude-code/b.md", day: ago(0) }),
    note({ path: "30-Knowledge/c.md", day: ago(1) }),
    note({ path: "30-Knowledge/d.md", day: ago(2) }),
    note({ path: "30-Knowledge/e.md", day: ago(3) }),
    note({ path: "20-Projects/p/x.md", day: ago(5) }),
    note({ path: "root.md", day: ago(6) }),
    note({ path: "30-Knowledge/f.md", day: ago(8) }),
    note({ path: "30-Knowledge/g.md", day: ago(10) }),
    note({ path: "30-Knowledge/h.md", day: ago(40) }),
    note({ path: "10-Sessions/claude-code/old.md", day: ago(100) }),
    // none of these may show up in any count below
    note({ path: "30-Knowledge/img.png", kind: "a", day: ago(0) }),
    note({ path: "30-Knowledge/future.md", day: T + 1 }),
    note({ path: "30-Knowledge/undated.md" }),
  ];
}

describe("vaultPulse", () => {
  const p = vaultPulse(pulseFixture(), T);

  it("lists dated days ascending, skipping empty days, attachments, future and undated", () => {
    expect(p.days).toHaveLength(10);
    expect(p.days[0]).toEqual({ day: dayToIso(ago(100)), n: 1 });
    expect(p.days[9]).toEqual({ day: "2026-10-26", n: 2 });
  });

  it("windows the counts with the day > today - N rule", () => {
    // last 7 days: today(2) + 1 + 2 + 3 + 5 + 6 ago = 7 notes; the 8-ago note is not in it
    expect(p.last7).toBe(7);
    expect(p.prev7).toBe(2); // 8 and 10 ago
    expect(p.activeDays30).toBe(8); // 0,1,2,3,5,6,8,10 ago; 40 ago is outside
  });

  it("streak runs back from today; longestStreak is the best run ever", () => {
    expect(p.streak).toBe(4); // 0..3 ago
    expect(p.longestStreak).toBe(4);
    expect(p.busiest).toEqual({ day: "2026-10-26", n: 2 });
  });

  it("streak survives a quiet today by counting from yesterday", () => {
    const notes = [note({ day: ago(1) }), note({ day: ago(2) }), note({ day: ago(4) })];
    const r = vaultPulse(notes, T);
    expect(r.streak).toBe(2);
    expect(r.longestStreak).toBe(2);
  });

  it("stacks months by top-level folder, oldest month first", () => {
    expect(p.months).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    const by = Object.fromEntries(p.stacks.map((s) => [s.key, s.parts]));
    expect(by["30-Knowledge"]).toEqual([0, 0, 1, 5]);
    expect(by["10-Sessions"]).toEqual([1, 0, 0, 2]);
    expect(by[""]).toEqual([0, 0, 0, 1]); // the root note
    expect(by["20-Projects"]).toEqual([0, 0, 0, 1]);
    expect(p.stacks.map((s) => s.key)).toEqual(["30-Knowledge", "10-Sessions", "", "20-Projects"]);
  });

  it("folds folders past the top 8 into a last series called Other", () => {
    // folder f0 gets 10 notes, f1 gets 9, ... f9 gets 1, all today
    const notes = Array.from({ length: 10 }, (_, i) => many(10 - i, { path: `f${i}/x.md`, day: T })).flat();
    const r = vaultPulse(notes, T);
    expect(r.stacks).toHaveLength(9);
    expect(r.stacks[8]).toEqual({ key: "Other", parts: [3] }); // f8 (2) + f9 (1)
    expect(r.stacks[0]?.key).toBe("f0");
  });
});

// ---------------------------------------------------------------- growth

describe("vaultGrowth", () => {
  const g = vaultGrowth(pulseFixture(), T);

  it("counts totals over live notes and reports the undated ones", () => {
    expect(g.total).toBe(13); // 11 dated + the future-dated one + the undated one
    expect(g.undated).toBe(1);
  });

  it("windows pace and the two 90-day halves", () => {
    expect(g.perDay30).toBeCloseTo(9 / 30, 10);
    expect(g.d90).toBe(10);
    expect(g.prev90).toBe(1); // the 100-ago note
  });

  it("ends each cumulative stack at the folder's dated size", () => {
    expect(g.months).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(g.baseline).toBe(0);
    const by = Object.fromEntries(g.stacks.map((s) => [s.key, s.parts]));
    expect(by["30-Knowledge"]).toEqual([0, 0, 1, 6]);
    expect(by["10-Sessions"]).toEqual([1, 1, 1, 3]);
    const finals = g.stacks.map((s) => s.parts[s.parts.length - 1] ?? 0);
    expect(finals.reduce((a, b) => a + b, 0)).toBe(11);
  });

  it("projects the next round numbers from the 30-day pace", () => {
    expect(g.milestones.map((m) => m.at)).toEqual([20, 30, 40]);
    // 7 more notes at 0.3 a day: ceil(23.33) = 24 days; 17 more: ceil(56.67) = 57 days
    expect(g.milestones[0]?.day).toBe(dayToIso(T + 24));
    expect(g.milestones[1]?.day).toBe(dayToIso(T + 57));
  });

  it("names the fastest folders over 90 days", () => {
    expect(g.fastest).toEqual([
      { key: "30-Knowledge", n: 6 },
      { key: "10-Sessions", n: 2 },
      { key: "", n: 1 },
      { key: "20-Projects", n: 1 },
    ]);
  });

  it("gives a null ETA when the pace is zero", () => {
    const r = vaultGrowth([note({ path: "a/x.md", day: ago(200) })], T);
    expect(r.perDay30).toBe(0);
    expect(r.milestones.every((m) => m.day === null)).toBe(true);
    expect(r.milestones.map((m) => m.at)).toEqual([10, 20, 30]);
  });

  it("projects round numbers by half a power of ten for a big vault", () => {
    const r = vaultGrowth(many(32_429, { path: "a/x.md", day: ago(1) }), T);
    expect(r.milestones.map((m) => m.at)).toEqual([35_000, 40_000, 45_000]);
  });

  it("folds notes older than the 48-month window into the baseline", () => {
    const notes = [note({ path: "a/old.md", day: ago(2000) }), note({ path: "a/new.md", day: ago(1) })];
    const r = vaultGrowth(notes, T);
    expect(r.months).toHaveLength(48);
    expect(r.baseline).toBe(1);
    // the old note is already in the first month, so the stack starts at 1 and ends at 2
    expect(r.stacks[0]?.parts[0]).toBe(1);
    expect(r.stacks[0]?.parts[47]).toBe(2);
  });
});

// ---------------------------------------------------------------- focus

function focusFixture(): VaultNote[] {
  const n = (project: string, umbrella: string, d: number): VaultNote => note({ path: `10-Sessions/x/${seq}.md`, project, umbrella, day: d });
  return [
    n("alpha", "work", ago(0)),
    n("beta", "work", ago(0)),
    n("alpha", "work", ago(1)),
    n("beta", "work", ago(2)),
    n("alpha", "work", ago(4)),
    n("alpha", "work", ago(6)), // previous week bucket
    n("delta", "work", ago(10)),
    n("beta", "work", ago(20)),
    n("beta", "work", ago(30)), // 28..55 ago: the "before" window
    n("gamma", "life", ago(60)),
    note({ path: "a/np.md", day: ago(1) }), // no project, no umbrella: ignored
  ];
}

describe("vaultFocus", () => {
  const f = vaultFocus(focusFixture(), T);

  it("labels 26 weeks ending at the current bucket", () => {
    expect(f.weeks).toHaveLength(26);
    expect(f.weeks[25]).toBe("2026-10-22");
    expect(f.weeks[24]).toBe("2026-10-15");
  });

  it("stacks by project, ranked by window total then name", () => {
    expect(f.byProject.map((s) => s.key)).toEqual(["alpha", "beta", "delta", "gamma"]);
    const alpha = f.byProject[0]?.parts ?? [];
    expect(alpha).toHaveLength(26);
    expect(alpha[25]).toBe(3); // today, 1 ago, 4 ago are all in bucket 2964
    expect(alpha[24]).toBe(1); // 6 ago
    expect(f.byUmbrella.map((s) => s.key)).toEqual(["work", "life"]);
  });

  it("counts touched keys and the mean projects per active day", () => {
    expect(f.touchedProjects).toBe(4);
    expect(f.touchedUmbrellas).toBe(2);
    // 7 active days in 30; today has alpha and beta, the others one each: 8 / 7
    expect(f.switchesPerDay).toBeCloseTo(8 / 7, 10);
  });

  it("names the biggest share this week", () => {
    expect(f.top?.key).toBe("alpha");
    expect(f.top?.share).toBeCloseTo(3 / 5, 10); // alpha 3 of 5 project-tagged notes in the bucket
  });

  it("orders attention shifts by the size of the move", () => {
    // last 28 days: alpha 4, beta 3, delta 1 (of 8). the 28 before: beta 1 of 1.
    expect(f.shiftProjects.map((s) => s.key)).toEqual(["beta", "alpha", "delta"]);
    const alpha = f.shiftProjects[1];
    expect(alpha?.now).toBeCloseTo(0.5, 10);
    expect(alpha?.before).toBe(0);
    expect(f.shiftProjects[0]?.before).toBe(1);
  });
});

// ---------------------------------------------------------------- meetings

function meetingFixture(): VaultNote[] {
  const m = (name: string, d: number, hour: number | null, minutes: number | null, project: string): VaultNote =>
    note({ path: `10-Sessions/meetings/${name}.md`, day: d, hour, minutes, project });
  return [
    m("m1", ago(0), 10, 60, "p1"),
    m("m2", ago(1), 14, 90, "p1"),
    m("m3", ago(7), 10, 90, "p2"),
    m("m4", ago(100), 21, 60, "p2"),
    m("m5", ago(400), 9, 120, "p2"),
    m("m6", ago(3), null, null, ""),
    note({ path: "00-Inbox/not-a-meeting.md", day: ago(0), hour: 10, minutes: 500 }),
  ];
}

describe("vaultMeetings", () => {
  const r = vaultMeetings(meetingFixture(), T);

  it("buckets hours and counts by week", () => {
    expect(r.weeks).toHaveLength(26);
    expect(r.counts[25]).toBe(3); // m1, m2, m6 are in the current bucket
    expect(r.hours[25]).toBe(2.5);
    expect(r.counts[24]).toBe(1); // m3, 7 days back
    expect(r.hours[24]).toBe(1.5);
    expect(r.counts[11]).toBe(1); // m4, 100 days back
    expect(r.hours[11]).toBe(1);
    expect(r.counts.reduce((a, b) => a + b, 0)).toBe(5); // m5 is outside the 26 weeks
  });

  it("derives this-week and rolling averages", () => {
    expect(r.hoursThisWeek).toBe(2.5);
    expect(r.countThisWeek).toBe(3);
    expect(r.avgHours12w).toBe(0.3); // 4 hours over 12 weeks, 0.33 rounded
    // m1, m2, m3 have minutes in the last 90 days; m6 has none and is left out of the mean
    expect(r.avgMinutes90).toBe(80);
  });

  it("builds a Monday-first weekday x hour grid, widened for late meetings", () => {
    expect(r.hourFrom).toBe(8);
    expect(r.hourTo).toBe(21); // m4 at 21:00 stretches the default 8..19
    const width = 14;
    expect(r.grid).toHaveLength(7 * width);
    expect(r.grid[0 * width + (10 - 8)]).toBe(2); // Mondays at 10: m1 and m3
    expect(r.grid[6 * width + (14 - 8)]).toBe(1); // Sunday at 14: m2
    expect(r.grid[5 * width + (21 - 8)]).toBe(1); // Saturday at 21: m4 (100 days back)
    expect(r.grid.reduce((a, b) => a + b, 0)).toBe(4); // m5 is over a year old, m6 has no hour
    expect(r.peak).toEqual({ dow: 0, hour: 10, n: 2 });
  });

  it("lists the longest recent meetings and hours by project", () => {
    expect(r.longest.map((x) => x.name)).toEqual(["m2", "m3", "m1"]);
    expect(r.longest[0]).toEqual({
      path: "10-Sessions/meetings/m2.md",
      name: "m2",
      day: "2026-10-25",
      minutes: 90,
      project: "p1",
    });
    expect(r.byProject).toEqual([
      { key: "p1", hours: 2.5 },
      { key: "p2", hours: 1.5 },
    ]);
  });
});

// ---------------------------------------------------------------- projects

function projectFixture(): VaultNote[] {
  return [
    note({ path: "20-Projects/alpha/_index.md", project: "alpha", umbrella: "work", day: ago(3) }),
    note({ path: "20-Projects/alpha/a.md", project: "alpha", umbrella: "work", day: ago(10) }),
    note({ path: "20-Projects/alpha/b.md", project: "alpha", umbrella: "life", day: ago(40) }),
    note({ path: "10-Sessions/claude-code/s1.md", project: "alpha", umbrella: "work", day: ago(1) }),
    note({ path: "30-Knowledge/b1.md", project: "beta", umbrella: "life", day: ago(70) }),
    note({ path: "30-Knowledge/b2.md", project: "beta", umbrella: "", day: ago(100) }),
    note({ path: "10-Sessions/claude-code/s2.md", project: "gamma" }),
    note({ path: "30-Knowledge/g1.md", project: "gamma" }),
    ...many(20, { path: "40-Resources/big.md", project: "big", umbrella: "work", day: ago(200) }),
    note({ path: "10-Sessions/claude-code/np.md" }), // no project: not a project session note
  ];
}

describe("vaultProjects", () => {
  const r = vaultProjects(projectFixture(), T);

  it("ranks projects by size and derives umbrella, recency and index", () => {
    expect(r.items.map((p) => p.slug)).toEqual(["big", "alpha", "beta", "gamma"]);
    const alpha = r.items.find((p) => p.slug === "alpha");
    expect(alpha).toEqual({
      slug: "alpha",
      umbrella: "work", // 3 notes say work, 1 says life
      notes: 4,
      last: dayToIso(ago(1)),
      n30: 3, // 1, 3 and 10 ago
      prev30: 1, // 40 ago
      indexPath: "20-Projects/alpha/_index.md",
    });
    const gamma = r.items.find((p) => p.slug === "gamma");
    expect(gamma).toMatchObject({ umbrella: "unfiled", last: null, n30: 0, indexPath: null });
    expect(r.items.find((p) => p.slug === "beta")?.umbrella).toBe("life");
  });

  it("rolls projects up by umbrella", () => {
    expect(r.umbrellas).toEqual([
      { key: "work", projects: 2, notes: 24, n30: 3 },
      { key: "life", projects: 1, notes: 2, n30: 0 },
      { key: "unfiled", projects: 1, notes: 2, n30: 0 },
    ]);
  });

  it("reports activity, session notes, the busiest project and big quiet ones", () => {
    expect(r.active30).toBe(1);
    expect(r.sessionNotes).toBe(2); // s1 and s2; the projectless one does not count
    expect(r.busiest).toBe("alpha");
    expect(r.quiet.map((p) => p.slug)).toEqual(["big"]);
  });

  it("caps the project rows at 60", () => {
    const notes = Array.from({ length: 80 }, (_, i) => note({ path: `a/${i}.md`, project: `p${String(i).padStart(2, "0")}`, day: T }));
    expect(vaultProjects(notes, T).items).toHaveLength(60);
  });
});

// ---------------------------------------------------------------- topics

function topicFixture(): VaultNote[] {
  return [
    ...many(3, { tags: ["ai/agents"], day: ago(5) }),
    ...many(3, { tags: ["ai/agents"], day: ago(45) }),
    ...many(4, { tags: ["ai/llm"], day: ago(2) }),
    ...many(5, { tags: ["status/draft"], day: ago(2) }), // noise family: never rising
    note({ tags: ["#plain", "plain"], day: ago(1) }), // one note, one tag, once
    note({ tags: ["plain"], day: ago(1) }),
    ...many(12, { tags: ["old/topic"], day: ago(40) }),
    ...many(11, { tags: ["old/other"], day: ago(40) }),
  ];
}

describe("vaultTopics", () => {
  const t = vaultTopics(topicFixture(), T);

  it("counts notes per family; a tag with no slash is (plain)", () => {
    expect(t.families).toEqual([
      { key: "old", n: 23 },
      { key: "ai", n: 10 },
      { key: "status", n: 5 },
      { key: "(plain)", n: 2 },
    ]);
  });

  it("windows each tag and applies the rising score n30 / (p90 / 3 + 1)", () => {
    const agents = t.items.find((x) => x.tag === "ai/agents");
    expect(agents).toMatchObject({ family: "ai", total: 6, n30: 3, p30: 3, p90: 3 });
    expect(agents?.score).toBeCloseTo(3 / (3 / 3 + 1), 10);
    const llm = t.items.find((x) => x.tag === "ai/llm");
    expect(llm?.weeks).toHaveLength(26);
    expect(llm?.weeks[25]).toBe(4);
    expect(llm?.score).toBe(4); // nothing before, so n30 / 1
  });

  it("strips a leading # and counts a tag once per note", () => {
    expect(t.items.find((x) => x.tag === "plain")?.total).toBe(2);
    expect(t.items.some((x) => x.tag.startsWith("#"))).toBe(false);
  });

  it("ranks rising by score and leaves out noise families and n30 under 3", () => {
    expect(t.rising.map((x) => x.tag)).toEqual(["ai/llm", "ai/agents"]);
  });

  it("lists quiet tags: p90 of 12+ and nothing in 30 days", () => {
    expect(t.quiet.map((x) => x.tag)).toEqual(["old/topic"]); // old/other has only 11
  });

  it("sends tag rows for at most 8 families, 15 per family", () => {
    const notes = Array.from({ length: 12 }, (_, f) =>
      Array.from({ length: 20 }, (_, i) => note({ tags: [`fam${String(f).padStart(2, "0")}/t${String(i).padStart(2, "0")}`], day: T })),
    ).flat();
    const r = vaultTopics(notes, T);
    expect(r.families).toHaveLength(12);
    expect(r.items).toHaveLength(8 * 15);
  });
});

// ---------------------------------------------------------------- people

function entity(path: string, weeks: [number, number][], last: number | null, extra: Partial<VaultNote> = {}): VaultNote {
  return note({ path, mentionWeeks: new Map(weeks.map(([d, c]) => [weekOf(d), c])), mentionLast: last, ...extra });
}

function peopleFixture(): VaultNote[] {
  return [
    entity("30-Knowledge/people/Ann.md", [[ago(3), 8], [ago(50), 4]], ago(3)),
    entity("30-Knowledge/people/Bob.md", [[ago(60), 15]], ago(60)),
    entity("30-Knowledge/people/Cy.md", [[ago(200), 3]], ago(200)),
    entity("30-Knowledge/people/Di.md", [[ago(300), 20]], ago(300)),
    note({ path: "30-Knowledge/people/Ed.md", mentionWeeks: new Map(), mentionLast: null }),
    entity("30-Knowledge/companies/Acme.md", [[ago(10), 10]], ago(10)),
    entity("40-Other/Zed.md", [[ago(1), 2]], ago(1), { type: "company" }),
    note({ path: "30-Knowledge/people/NoMentions.md" }), // mentionWeeks null: not an entity
  ];
}

describe("vaultPeople", () => {
  const r = vaultPeople(peopleFixture(), T);

  it("splits people from companies by type or companies folder", () => {
    expect(r.people.map((e) => e.name)).toEqual(["Di", "Bob", "Ann", "Cy", "Ed"]);
    expect(r.companies.map((e) => e.name)).toEqual(["Acme", "Zed"]);
    expect(r.withNote).toBe(7);
  });

  it("puts each entity in a band", () => {
    const band = (name: string): string | undefined => [...r.people, ...r.companies].find((e) => e.name === name)?.band;
    expect(band("Ann")).toBe("inner"); // seen 3 days ago, 12 mentions
    expect(band("Acme")).toBe("inner"); // exactly 10 mentions counts as known
    expect(band("Bob")).toBe("fading"); // 60 days ago, 15 mentions
    expect(band("Cy")).toBe("occasional"); // 3 mentions, seen 200 days ago
    expect(band("Zed")).toBe("occasional");
    expect(band("Di")).toBe("dormant"); // 20 mentions but 300 days quiet
    expect(band("Ed")).toBe("dormant");
  });

  it("derives totals, recency, 90-day mentions and 12 monthly buckets", () => {
    const ann = r.people.find((e) => e.name === "Ann");
    expect(ann).toMatchObject({ total: 12, last: dayToIso(ago(3)), daysSince: 3, n90: 12 });
    expect(ann?.months).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 8]); // Sep 4, Oct 8
  });

  it("handles an entity whose mention map is present but empty", () => {
    const ed = r.people.find((e) => e.name === "Ed");
    expect(ed).toEqual({
      path: "30-Knowledge/people/Ed.md",
      name: "Ed",
      total: 0,
      last: null,
      daysSince: null,
      n90: 0,
      months: new Array<number>(12).fill(0),
      band: "dormant",
    });
  });

  it("summarises the orbit", () => {
    expect(r.seen30).toBe(3); // Ann, Acme, Zed
    expect(r.inner).toBe(2);
    expect(r.fading).toBe(1);
    expect(r.reconnect.map((e) => e.name)).toEqual(["Bob"]);
    expect(r.top90.map((e) => e.name)).toEqual(["Bob", "Ann", "Acme", "Zed"]);
  });
});

// ---------------------------------------------------------------- sources

function sourceFixture(): VaultNote[] {
  const s = (path: string, d: number | null, umbrella: string, extra: Partial<VaultNote> = {}): VaultNote =>
    note({ path, day: d, umbrella, ...extra });
  return [
    s("10-Sessions/claude-code/a1.md", ago(5), "work"),
    s("10-Sessions/claude-code/a2.md", ago(10), "work"),
    s("10-Sessions/claude-code/a3.md", ago(20), "work"),
    s("10-Sessions/claude-code/a4.md", ago(50), "life"),
    s("10-Sessions/chatgpt/b1.md", ago(5), "work"),
    s("10-Sessions/chatgpt/b2.md", ago(60), "work"),
    s("10-Sessions/meetings/m.md", ago(2), ""),
    s("10-Sessions/foo.md", ago(10), "", { type: "jarvis-log" }), // no second segment: falls back to type
    s("10-Sessions/bar.md", null, "", { type: "" }),
    s("10-Sessions/claude-code/prev.md", ago(400), "work"), // a year earlier
    s("10-Sessions/chatgpt/p1.md", ago(400), "work"),
    s("10-Sessions/chatgpt/p2.md", ago(400), "work"),
    s("10-Sessions/chatgpt/p3.md", ago(400), "work"),
    s("30-Knowledge/z.md", ago(1), "work"), // not a session note
  ];
}

describe("vaultSources", () => {
  const r = vaultSources(sourceFixture(), T);

  it("derives the source from the second path segment, else the type, else other", () => {
    expect(r.sources).toEqual([
      { key: "chatgpt", total: 5, n30: 1, ai: true },
      { key: "claude-code", total: 5, n30: 3, ai: true },
      { key: "jarvis-log", total: 1, n30: 1, ai: true },
      { key: "meetings", total: 1, n30: 1, ai: false },
      { key: "other", total: 1, n30: 0, ai: false },
    ]);
    expect(r.captured).toBe(13);
  });

  it("builds source to umbrella bands over 90 days, dropping those under 2", () => {
    expect(r.flows).toEqual([
      { from: "claude-code", to: "work", n: 3 },
      { from: "chatgpt", to: "work", n: 2 },
    ]);
    expect(r.umbrellas).toEqual([
      { key: "work", n: 9 },
      { key: "unfiled", n: 3 },
      { key: "life", n: 1 },
    ]);
  });

  it("computes Claude's share of AI sessions now and a year earlier", () => {
    expect(r.claudeShare90).toBeCloseTo(4 / 7, 10); // claude 4 of claude 4 + chatgpt 2 + jarvis 1
    expect(r.claudeSharePrev).toBeCloseTo(1 / 4, 10);
    expect(r.topThisMonth).toBe("claude-code");
  });

  it("mixes sources by month from the first dated session", () => {
    expect(r.months).toHaveLength(14);
    expect(r.months[0]).toBe("2025-09");
    expect(r.months[13]).toBe("2026-10");
    const total = r.mix.reduce((a, s) => a + s.parts.reduce((x, y) => x + y, 0), 0);
    expect(total).toBe(12); // all dated sessions; the undated one is not in a time series
    expect(r.mix.every((s) => s.parts.length === 14)).toBe(true);
  });

  it("returns zero shares when there are no AI sessions", () => {
    const r2 = vaultSources([note({ path: "10-Sessions/meetings/m.md", day: T })], T);
    expect(r2.claudeShare90).toBe(0);
    expect(r2.claudeSharePrev).toBe(0);
  });
});

// ---------------------------------------------------------------- echoes

/** 30 old notes in a ring, each linking to the next two: 2 out + 2 in = 4 links apiece. */
function ringFixture(): VaultNote[] {
  const id = (i: number): string => `g${String(i % 30).padStart(2, "0")}`;
  const ring = Array.from({ length: 30 }, (_, i) =>
    note({ id: id(i), path: `30-Knowledge/${id(i)}.md`, day: ago(200 + i), links: [id(i + 1), id(i + 2)] }),
  );
  // 3 links in total, one short of a gem, however old
  const low = note({ id: "low", path: "30-Knowledge/low.md", day: ago(500), links: ["g00", "g01", "g02"] });
  return [...ring, low];
}

describe("vaultEchoes", () => {
  it("picks 8 forgotten gems and echoes the seed", () => {
    const e = vaultEchoes(ringFixture(), T, 11);
    expect(e.seed).toBe(11);
    expect(e.gems).toHaveLength(8);
    expect(new Set(e.gems.map((g) => g.id)).size).toBe(8);
    for (const g of e.gems) {
      expect(g.links).toBeGreaterThanOrEqual(4);
      expect(g.quietMonths).toBeGreaterThanOrEqual(6);
      expect(g.id).not.toBe("low"); // too few links
    }
  });

  it("counts quietMonths as whole calendar months", () => {
    // 200 days before 2026-10-26 is 2026-04-09: six months and 17 days
    const x = note({ id: "x", path: "a/x.md", day: ago(200) });
    const young = ["y1", "y2", "y3", "y4"].map((id) => note({ id, path: `a/${id}.md`, day: ago(3), links: ["x"] }));
    expect(vaultEchoes([x, ...young], T, 1).gems[0]?.quietMonths).toBe(6);
    // 2026-04-27 is 182 days back, so still a gem, but the 26th is short of the 27th: 5 months
    const y = note({ id: "x", path: "a/x.md", day: isoDay("2026-04-27") });
    expect(vaultEchoes([y, ...young], T, 1).gems[0]?.quietMonths).toBe(5);
  });

  it("walks along links from the first gem, never revisiting", () => {
    const notes = ringFixture();
    const e = vaultEchoes(notes, T, 11);
    expect(e.wander).toHaveLength(7); // the gem plus 6 hops
    expect(e.wander[0]?.id).toBe(e.gems[0]?.id);
    expect(new Set(e.wander.map((w) => w.id)).size).toBe(7);
    const byId = new Map(notes.map((n) => [n.id, n]));
    for (let i = 1; i < e.wander.length; i++) {
      const prev = byId.get(e.wander[i - 1]?.id ?? "");
      expect(prev?.links).toContain(e.wander[i]?.id);
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    const notes = ringFixture();
    const a = vaultEchoes(notes, T, 5);
    expect(vaultEchoes(notes, T, 5)).toEqual(a);
    expect(vaultEchoes([...notes].reverse(), T, 5)).toEqual(a); // feed order does not matter
    const b = vaultEchoes(notes, T, 6);
    expect(b.wander.map((w) => w.id)).not.toEqual(a.wander.map((w) => w.id));
    expect(b.gems.map((g) => g.id)).not.toEqual(a.gems.map((g) => g.id));
  });

  it("stops the walk early when a gem has nowhere to go", () => {
    const x = note({ id: "x", path: "30-Knowledge/x.md", day: ago(300) });
    const young = ["y1", "y2", "y3", "y4"].map((id) => note({ id, path: `a/${id}.md`, day: ago(10), links: ["x"] }));
    const e = vaultEchoes([x, ...young], T, 1);
    expect(e.gems.map((g) => g.id)).toEqual(["x"]); // 4 inbound links
    expect(e.wander.map((w) => w.id)).toEqual(["x"]);
  });

  it("returns empty arrays and still echoes the seed when no note is eligible", () => {
    const notes = [note({ day: ago(10), links: [] }), note({ day: ago(400) }), note({ day: null })];
    const e = vaultEchoes(notes, T, 42);
    expect(e).toEqual({ gems: [], onThisDay: [], wander: [], seed: 42 });
  });

  it("finds notes within 3 days of each anniversary, closest first, capped at 5", () => {
    const at = (iso: string, name: string): VaultNote => note({ path: `a/${name}.md`, day: isoDay(iso) });
    const notes = [
      at("2026-07-26", "exact"),
      at("2026-07-27", "plus1"),
      at("2026-07-24", "minus2"),
      at("2026-07-30", "toofar"), // 4 days off
      at("2025-10-29", "year"),
      ...Array.from({ length: 7 }, (_, i) => at("2023-10-26", `t${i}`)),
    ];
    const e = vaultEchoes(notes, T, 1);
    expect(e.onThisDay.map((b) => b.label)).toEqual(["3 months ago", "1 year ago", "3 years ago"]);
    expect(e.onThisDay[0]?.notes.map((n) => n.name)).toEqual(["exact", "plus1", "minus2"]);
    expect(e.onThisDay[1]?.notes.map((n) => n.name)).toEqual(["year"]);
    expect(e.onThisDay[2]?.notes).toHaveLength(5);
  });

  it("clamps an anniversary to the end of a shorter month", () => {
    const today = isoDay("2026-05-31"); // three months back is 02-31, which becomes 02-28
    const e = vaultEchoes([note({ path: "a/feb.md", day: isoDay("2026-02-28") })], today, 1);
    expect(e.onThisDay.map((b) => b.label)).toEqual(["3 months ago"]);
  });
});

// ---------------------------------------------------------------- gaps

function gapFixture(): VaultNote[] {
  return [
    note({ id: "n1", path: "30-Knowledge/a.md", type: "note", project: "alpha", links: ["n2"] }),
    note({ id: "n2", path: "30-Knowledge/b.md", type: "note" }),
    note({ id: "n3", path: "30-Knowledge/orphan1.md", type: "" }),
    note({ id: "n4", path: "40-Resources/orphan2.md", type: "", project: "beta", ghosts: ["Missing Page", "Other Page"] }),
    note({ id: "n5", path: "30-Knowledge/orphan3.md", type: "note", project: "gamma", ghosts: ["Missing Page"] }),
    note({ id: "n6", path: "loose.md", type: "note" }),
    note({ id: "w1", path: "30-Knowledge/Weekly Review Notes.md", type: "note", links: ["n1"] }),
    note({ id: "w2", path: "10-Sessions/weekly-review-notes.md", type: "note", links: ["n1"] }),
    note({ id: "i1", path: "a/index.md", type: "note", links: ["n1"] }),
    note({ id: "i2", path: "b/index.md", type: "note", links: ["n1"] }),
    note({ id: "ix", path: "20-Projects/alpha/_index.md", type: "project", links: ["n1"] }),
    note({ id: "att", path: "30-Knowledge/pic.png", kind: "a" }), // an orphan attachment: not counted
  ];
}

describe("vaultGaps", () => {
  const g = vaultGaps(gapFixture());

  it("counts live notes, orphans and untyped notes (undated ones included)", () => {
    expect(g.notes).toBe(11);
    expect(g.orphans).toBe(4); // n3, n4, n5, n6
    expect(g.linked).toBe(7);
    expect(g.untyped).toBe(2);
    expect(g.orphansByFolder).toEqual([
      { key: "30-Knowledge", n: 2 },
      { key: "", n: 1 },
      { key: "40-Resources", n: 1 },
    ]);
    expect(g.untypedByFolder).toEqual([
      { key: "30-Knowledge", n: 1 },
      { key: "40-Resources", n: 1 },
    ]);
  });

  it("counts every unresolved target, but leaves out of Write these next what imports want and what one note wants", () => {
    expect(g.ghostTotal).toBe(2);
    // "Missing Page": n4 (40-Resources, an import) + n5 = one note of Alex's; "Other Page": only n4.
    expect(g.writeNext).toEqual([]);
  });

  it("ranks targets two or more of Alex's own notes want, imports and clips left out", () => {
    const r = vaultGaps([
      note({ path: "30-Knowledge/a.md", type: "note", ghosts: ["Wanted", "Once"] }),
      note({ path: "10-Sessions/b.md", type: "session", ghosts: ["Wanted"] }),
      note({ path: "50-Wiki/c.md", type: "wiki", ghosts: ["Wanted"] }),
      note({ path: "Clippings/d.md", type: "", ghosts: ["Clipped", "Once"] }),
      note({ path: "Clippings/e.md", type: "", ghosts: ["Clipped"] }),
      note({ path: "30-Knowledge/notion-orb/f.md", type: "resource", ghosts: ["Imported"] }),
      note({ path: "30-Knowledge/notion-orb/g.md", type: "resource", ghosts: ["Imported"] }),
      note({ path: "40-Resources/h.md", type: "note", ghosts: ["Wanted"] }),
    ]);
    expect(r.ghostTotal).toBe(4);
    expect(r.writeNext).toEqual([{ key: "Wanted", n: 3 }]);
  });

  it("finds duplicates by normalised name and ignores short generic ones", () => {
    expect(g.duplicates).toEqual([
      { key: "weeklyreviewnotes", paths: ["10-Sessions/weekly-review-notes.md", "30-Knowledge/Weekly Review Notes.md"] },
    ]);
  });

  it("lists projects with no _index note, alphabetically", () => {
    expect(g.missingProjects).toEqual(["beta", "gamma"]);
    expect(g.projectsMissingNote).toBe(2);
  });

  it("matches a project to its folder without regard to case, as macOS does", () => {
    const gaps = vaultGaps([
      note({ id: "s", path: "10-Sessions/s.md", type: "session", project: "groot", links: ["ix"] }),
      note({ id: "ix", path: "20-Projects/Groot/_index.md", type: "project", links: ["s"] }),
    ]);
    expect(gaps.missingProjects).toEqual([]);
  });

  it("keeps a ghost target named by many notes to one row and caps the list at 20", () => {
    const named = many(30, { path: "a/x.md", ghosts: ["Popular"] });
    const spread = Array.from({ length: 25 }, (_, i) => many(2, { path: "a/y.md", ghosts: [`Ghost ${String(i).padStart(2, "0")}`] })).flat();
    const r = vaultGaps([...named, ...spread]);
    expect(r.ghostTotal).toBe(26);
    expect(r.writeNext).toHaveLength(20);
    expect(r.writeNext[0]).toEqual({ key: "Popular", n: 30 });
  });

  it("caps duplicates at 20 groups of at most 8 paths", () => {
    const notes = Array.from({ length: 25 }, (_, g) =>
      Array.from({ length: 10 }, (_, i) => note({ path: `d${i}/duplicate-group-${String(g).padStart(2, "0")}.md` })),
    ).flat();
    const r = vaultGaps(notes);
    expect(r.duplicates).toHaveLength(20);
    expect(r.duplicates.every((d) => d.paths.length === 8)).toBe(true);
  });
});

// ---------------------------------------------------------------- drill list

describe("vaultNotes", () => {
  const notes = [
    note({ id: "a", path: "30-Knowledge/a.md", day: ago(1), tags: ["x/y"], project: "p", umbrella: "u", type: "note", ghosts: ["G"], links: ["b", "c"] }),
    note({ id: "b", path: "30-Knowledge/b.md", day: ago(1), tags: ["x/y", "z"], links: ["a"] }),
    note({ id: "c", path: "40-Resources/c.md", day: ago(5), project: "p", type: "note" }),
    note({ id: "d", path: "30-Knowledge/d.md", day: null, tags: ["z"], ghosts: ["G"], umbrella: "u" }),
    note({ id: "e", path: "root.md", day: ago(9) }),
    note({ id: "f", path: "30-Knowledge/f.png", kind: "a", day: ago(1), tags: ["z"] }),
  ];
  const q = (kind: VaultNotesQuery["kind"], value: string): VaultNotesQuery => ({ kind, value });
  const ids = (r: { notes: { id: string }[] }): string[] => r.notes.map((n) => n.id);

  it("filters by each kind", () => {
    expect(ids(vaultNotes(notes, q("folder", "30-Knowledge"), 50))).toEqual(["a", "b", "d"]);
    expect(ids(vaultNotes(notes, q("folder", ""), 50))).toEqual(["e"]);
    expect(ids(vaultNotes(notes, q("tag", "z"), 50))).toEqual(["b", "d"]); // the attachment is excluded
    expect(ids(vaultNotes(notes, q("ghost", "G"), 50))).toEqual(["a", "d"]);
    expect(ids(vaultNotes(notes, q("project", "p"), 50))).toEqual(["a", "c"]);
    expect(ids(vaultNotes(notes, q("umbrella", "u"), 50))).toEqual(["a", "d"]);
    expect(ids(vaultNotes(notes, q("type", "note"), 50))).toEqual(["a", "c"]);
    expect(ids(vaultNotes(notes, q("day", dayToIso(ago(1))), 50))).toEqual(["a", "b"]);
    expect(vaultNotes(notes, q("tag", "nope"), 50)).toEqual({ notes: [], total: 0, truncated: false });
  });

  it("sorts newest first, then path, with undated notes last", () => {
    expect(ids(vaultNotes(notes, q("type", ""), 50))).toEqual(["b", "e", "d"]);
    const all = vaultNotes([...notes].reverse(), { kind: "folder", value: "30-Knowledge" }, 50);
    expect(ids(all)).toEqual(["a", "b", "d"]);
  });

  it("caps the list but reports the full total", () => {
    const r = vaultNotes(notes, q("folder", "30-Knowledge"), 2);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
    expect(vaultNotes(notes, q("folder", "30-Knowledge"), 3).truncated).toBe(false);
    expect(vaultNotes(notes, q("folder", "30-Knowledge"), 0)).toEqual({ notes: [], total: 3, truncated: true });
  });

  it("builds refs with name, folder, ISO day and outbound plus inbound link count", () => {
    const r = vaultNotes(notes, q("folder", "30-Knowledge"), 50);
    // a: 2 out + 1 in (from b) = 3; undated d has day null and no links
    expect(r.notes[0]).toEqual({ id: "a", path: "30-Knowledge/a.md", name: "a", folder: "30-Knowledge", day: dayToIso(ago(1)), links: 3 });
    expect(r.notes[2]).toMatchObject({ id: "d", day: null, links: 0 });
  });
});

// ---------------------------------------------------------------- edge cases

describe("edge cases", () => {
  const sections = (notes: VaultNote[]): Record<string, unknown> => ({
    pulse: vaultPulse(notes, T),
    growth: vaultGrowth(notes, T),
    focus: vaultFocus(notes, T),
    meetings: vaultMeetings(notes, T),
    projects: vaultProjects(notes, T),
    topics: vaultTopics(notes, T),
    people: vaultPeople(notes, T),
    sources: vaultSources(notes, T),
    echoes: vaultEchoes(notes, T, 3),
    gaps: vaultGaps(notes),
    notes: vaultNotes(notes, { kind: "folder", value: "" }, 10),
  });

  it("an empty feed gives well-formed empty payloads and never throws", () => {
    const s = sections([]);
    expect(s["pulse"]).toEqual({ days: [], months: [], stacks: [], last7: 0, prev7: 0, activeDays30: 0, streak: 0, longestStreak: 0, busiest: null });
    expect(s["growth"]).toMatchObject({ months: [], stacks: [], baseline: 0, total: 0, undated: 0, perDay30: 0, d90: 0, prev90: 0, fastest: [] });
    expect(s["focus"]).toMatchObject({ touchedProjects: 0, switchesPerDay: 0, top: null, shiftProjects: [], byProject: [] });
    expect(s["meetings"]).toMatchObject({ hoursThisWeek: 0, avgHours12w: 0, avgMinutes90: 0, peak: null, longest: [], byProject: [] });
    expect(s["projects"]).toEqual({ items: [], umbrellas: [], active30: 0, sessionNotes: 0, busiest: null, quiet: [] });
    expect(s["topics"]).toEqual({ families: [], items: [], rising: [], quiet: [] });
    expect(s["people"]).toMatchObject({ people: [], companies: [], withNote: 0, seen30: 0, inner: 0, fading: 0, reconnect: [], top90: [] });
    expect(s["sources"]).toMatchObject({ sources: [], flows: [], mix: [], captured: 0, claudeShare90: 0, claudeSharePrev: 0, topThisMonth: null });
    expect(s["echoes"]).toEqual({ gems: [], onThisDay: [], wander: [], seed: 3 });
    expect(s["gaps"]).toMatchObject({ notes: 0, linked: 0, orphans: 0, ghostTotal: 0, untyped: 0, writeNext: [], duplicates: [], missingProjects: [] });
    expect(s["notes"]).toEqual({ notes: [], total: 0, truncated: false });
    const meetings = s["meetings"] as { grid: number[]; hourFrom: number; hourTo: number; weeks: string[] };
    expect(meetings.grid).toHaveLength(7 * (meetings.hourTo - meetings.hourFrom + 1));
    expect(meetings.weeks).toHaveLength(26);
  });

  it("a feed of only undated notes leaves every time series empty but still counts them", () => {
    const notes = [note({ path: "a/x.md", project: "p", tags: ["t"] }), note({ path: "b/y.md" })];
    const s = sections(notes);
    expect(s["pulse"]).toMatchObject({ days: [], months: [], stacks: [], streak: 0 });
    expect(s["growth"]).toMatchObject({ months: [], stacks: [], total: 2, undated: 2 });
    expect(s["focus"]).toMatchObject({ byProject: [], top: null });
    expect(s["gaps"]).toMatchObject({ notes: 2, orphans: 2, untyped: 2 });
    expect(s["projects"]).toMatchObject({ items: [{ slug: "p", notes: 1, last: null, n30: 0 }] });
    expect(s["topics"]).toMatchObject({ items: [{ tag: "t", total: 1, n30: 0 }] });
  });

  it("a note with no tags, links, project or day is harmless everywhere", () => {
    const s = sections([note({ path: "bare.md" })]);
    expect(s["gaps"]).toMatchObject({ notes: 1, orphans: 1, linked: 0, missingProjects: [] });
    expect(s["topics"]).toEqual({ families: [], items: [], rising: [], quiet: [] });
    expect(s["projects"]).toMatchObject({ items: [] });
    expect(s["notes"]).toEqual({ notes: [{ id: expect.any(String), path: "bare.md", name: "bare", folder: "", day: null, links: 0 }], total: 1, truncated: false });
  });

  it("attachments never count", () => {
    const att = note({ path: "a/pic.png", kind: "a", day: T, tags: ["t"], project: "p", links: ["zzz"], ghosts: ["g"] });
    const s = sections([att]);
    expect(s["pulse"]).toMatchObject({ days: [] });
    expect(s["gaps"]).toMatchObject({ notes: 0, ghostTotal: 0 });
    expect(s["topics"]).toMatchObject({ items: [] });
    expect(s["projects"]).toMatchObject({ items: [] });
  });
});

// ---------------------------------------------------------------- scale and size

/** A deterministic, plausibly-shaped feed: many folders, projects, tags, entities and links. */
function bigFeed(count: number): VaultNote[] {
  let s = 12345;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n; // the low bits of this generator cycle, so use the high ones
  };
  const folders = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const out: VaultNote[] = [];
  for (let i = 0; i < count; i++) {
    const id = `b${String(i).padStart(6, "0")}`;
    const folder = folders[rnd(folders.length)] ?? "f00";
    const links: string[] = [];
    for (let k = 0; k < 4; k++) links.push(`b${String(rnd(count)).padStart(6, "0")}`);
    out.push(
      note({
        id,
        path: folder === "f00" ? `10-Sessions/tool${rnd(9)}/${id}.md` : folder === "f01" ? `10-Sessions/meetings/${id}.md` : `${folder}/${id}.md`,
        type: rnd(5) === 0 ? "" : "note",
        day: rnd(20) === 0 ? null : T - rnd(1500),
        hour: rnd(24),
        minutes: 15 + rnd(90),
        project: `proj${rnd(300)}`,
        umbrella: `u${rnd(12)}`,
        tags: [`fam${rnd(30)}/tag${rnd(800)}`, `plain${rnd(50)}`],
        links,
        ghosts: [`Ghost ${rnd(2000)}`],
        mentionWeeks: i % 150 === 0 ? new Map([[weekOf(T - rnd(400)), 1 + rnd(9)]]) : null,
        mentionLast: i % 150 === 0 ? T - rnd(400) : null,
      }),
    );
  }
  return out;
}

describe("scale", () => {
  it("keeps every section payload in the low tens of KB on a 5,000-note feed", () => {
    const notes = bigFeed(5000);
    const inbound = inboundCounts(notes);
    const sizes: Record<string, number> = {
      pulse: JSON.stringify(vaultPulse(notes, T)).length,
      growth: JSON.stringify(vaultGrowth(notes, T)).length,
      focus: JSON.stringify(vaultFocus(notes, T)).length,
      meetings: JSON.stringify(vaultMeetings(notes, T)).length,
      projects: JSON.stringify(vaultProjects(notes, T)).length,
      topics: JSON.stringify(vaultTopics(notes, T)).length,
      people: JSON.stringify(vaultPeople(notes, T)).length,
      sources: JSON.stringify(vaultSources(notes, T)).length,
      echoes: JSON.stringify(vaultEchoes(notes, T, 1, inbound)).length,
      gaps: JSON.stringify(vaultGaps(notes, inbound)).length,
    };
    for (const [name, size] of Object.entries(sizes)) expect(size, name).toBeLessThan(60_000);
  });

  it("runs the whole-feed passes on 32,000 notes without a quadratic blow-up", () => {
    const notes = bigFeed(32_000);
    const inbound = inboundCounts(notes);
    expect(vaultGaps(notes, inbound).notes).toBe(32_000);
    expect(vaultEchoes(notes, T, 1, inbound).gems.length).toBeGreaterThan(0);
    expect(vaultNotes(notes, { kind: "folder", value: "10-Sessions" }, 100, inbound).notes.length).toBe(100);
  }, 30_000);
});

describe("vaultClimb", () => {
  const home = note({ id: "home", path: "Home.md" });
  const wiki = note({ id: "wiki", path: "50-Wiki/_index.md", up: "home", upRule: "top" });
  const startup = note({ id: "start", path: "50-Wiki/startup.md", up: "wiki", upRule: "folder" });
  const pricing = note({ id: "price", path: "50-Wiki/pricing.md", up: "start", upRule: "broader" });
  const concept = note({ id: "rag", path: "30-Knowledge/concepts/rag.md", up: "price", upRule: "mentions" });
  const loner = note({ id: "lone", path: "30-Knowledge/concepts/lone.md", up: "home", upRule: "home" });
  const a = note({ id: "la", path: "loop/a.md", up: "lb", upRule: "broader" });
  const b = note({ id: "lb", path: "loop/b.md", up: "la", upRule: "broader" });
  const lost = note({ id: "lost", path: "lost.md", up: "gone", upRule: "folder" });
  const old = note({ id: "old", path: "old.md" });
  const all = [home, wiki, startup, pricing, concept, loner, a, b, lost, old];
  const byPath = new Map(all.map((n) => [n.path.toLowerCase(), n]));
  const byId = new Map(all.map((n) => [n.id, n]));

  it("follows up from a concept to Home, with the rule of each step", () => {
    const c = vaultClimb("30-Knowledge/concepts/RAG", byPath, byId);
    expect(c.end).toBe("root");
    expect(c.steps).toEqual([
      { path: "30-Knowledge/concepts/rag.md", rule: "" },
      { path: "50-Wiki/pricing.md", rule: "mentions" },
      { path: "50-Wiki/startup.md", rule: "broader" },
      { path: "50-Wiki/_index.md", rule: "folder" },
      { path: "Home.md", rule: "top" },
    ]);
  });

  it("says how a chain ends when it does not reach Home", () => {
    expect(vaultClimb("loop/a.md", byPath, byId).end).toBe("loop");
    expect(vaultClimb("lost.md", byPath, byId).end).toBe("dead-end");
    expect(vaultClimb("old.md", byPath, byId)).toEqual({ steps: [{ path: "old.md", rule: "" }], end: "unknown" });
    expect(vaultClimb("nowhere.md", byPath, byId)).toEqual({ steps: [], end: "unknown" });
    expect(vaultClimb("Home.md", byPath, byId).end).toBe("root");
  });

  it("counts unanchored notes in Gaps and drills into them by folder", () => {
    const g = vaultGaps(all);
    expect(g.unanchored).toBe(1);
    expect(g.unanchoredByFolder).toEqual([{ key: "30-Knowledge", n: 1 }]);
    expect(vaultNotes(all, { kind: "unanchored", value: "30-Knowledge" }, 10).notes.map((n) => n.path)).toEqual([
      "30-Knowledge/concepts/lone.md",
    ]);
    expect(vaultGaps([old]).unanchored).toBeNull(); // a feed with no climb column says nothing
  });
});
