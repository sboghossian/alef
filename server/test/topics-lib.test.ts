import { describe, expect, it } from "vitest";
import {
  buildJevBody,
  buildTopicsMap,
  classifySession,
  isCatchAll,
  majorityGroup,
  parseAssignments,
  parseJevAnswers,
  parseTaxonomy,
  ruleGroup,
  type SessionInput,
} from "../features/topics-lib.js";
import { isTopicsMap } from "../../shared/features/topics.js";

const RAW_TAXONOMY = {
  fallbackGroup: null,
  groups: [
    { key: "WEB", name: "ACME · Website", hint: "acme.ai pages" },
    { key: "GTM", name: "Growth", hint: "outbound" },
    { key: "RESEARCH", name: "Research", hint: "benchmarks" },
    { key: "SETUP", name: "Setup", hint: "skills, hooks" },
    { key: "AUTO", name: "Automated", hint: "unattended" },
  ],
  rules: [{ pattern: "narrative step of Alex's /daily-recap", group: "AUTO" }, { pattern: "([", group: "WEB" }],
};
const tax = parseTaxonomy(RAW_TAXONOMY);

function s(id: string, title: string, islandId = "home", extra: Partial<SessionInput> = {}): SessionInput {
  return { id, title, islandId, catchAll: islandId === "home", headless: false, ...extra };
}

describe("parseTaxonomy", () => {
  it("keeps valid groups, skips bad regexes, appends OTHER when there is no fallback", () => {
    expect(tax.groups.map((g) => g.key)).toEqual(["WEB", "GTM", "RESEARCH", "SETUP", "AUTO", "OTHER"]);
    expect(tax.rules).toHaveLength(1);
    expect(tax.fallback).toBe("OTHER");
  });
  it("uses the file's fallbackGroup when it names a known group", () => {
    expect(parseTaxonomy({ ...RAW_TAXONOMY, fallbackGroup: "setup" }).fallback).toBe("SETUP");
  });
  it("survives empty and malformed input", () => {
    for (const raw of [null, 42, "x", {}, { groups: "no", rules: {} }, { groups: [{ key: "bad key!" }, null] }]) {
      const t = parseTaxonomy(raw);
      expect(t.fallback).toBe("OTHER");
      expect(t.groups.map((g) => g.key)).toEqual(["OTHER"]);
    }
  });
});

describe("parseAssignments", () => {
  it("reads id → group and ignores junk", () => {
    const a = parseAssignments({ a: "web", b: 3, c: null });
    expect([...a.entries()]).toEqual([["a", "WEB"]]);
    expect(parseAssignments([1, 2]).size).toBe(0);
    expect(parseAssignments(null).size).toBe(0);
  });
});

describe("classification precedence", () => {
  const assignments = new Map([["x", "GTM"], ["ghost", "NOPE"]]);
  const jev = new Map([["x", "SETUP"], ["y", "RESEARCH"], ["z", "NOPE"]]);
  const ctx = { taxonomy: tax, assignments, jev };

  it("1. an existing assignment beats rules and Jev", () => {
    expect(classifySession(s("x", "fix the acme.ai website blog", "acme-ai-next", { catchAll: false }), ctx)).toEqual({ group: "GTM", source: "assigned" });
  });
  it("an assignment to an unknown group is ignored", () => {
    expect(classifySession(s("ghost", "fix the website"), ctx)).toEqual({ group: "WEB", source: "rule" });
  });
  it("2. taxonomy title rules, then headless, then folder, then unambiguous keywords", () => {
    expect(ruleGroup(s("a", "You are the narrative step of Alex's /daily-recap. A script"), tax)).toBe("AUTO");
    expect(ruleGroup(s("a", "anything", "home", { headless: true }), tax)).toBe("AUTO");
    expect(ruleGroup(s("a", "yalla-brief /yalla-brief"), tax)).toBe("AUTO");
    expect(ruleGroup(s("a", "hello", "acme-ai-next", { catchAll: false }), tax)).toBe("WEB");
    expect(ruleGroup(s("a", "hello", "legal-taxonomy", { catchAll: false }), tax)).toBe("RESEARCH");
    expect(ruleGroup(s("a", "on acme.ai homepage fix the hero"), tax)).toBe("WEB");
  });
  it("catch-all folders never get a folder rule", () => {
    expect(ruleGroup(s("a", "hello", "home"), tax)).toBeNull();
  });
  it("an ambiguous keyword title goes to Jev instead of guessing", () => {
    expect(ruleGroup(s("a", "benchmark the outbound campaign"), tax)).toBeNull();
  });
  it("3. cached Jev answer, 4. null (caller falls back) — unknown Jev group ignored", () => {
    expect(classifySession(s("y", "hmm"), ctx)).toEqual({ group: "RESEARCH", source: "jev" });
    expect(classifySession(s("z", "hmm"), ctx)).toBeNull();
    expect(classifySession(s("new", "hmm"), ctx)).toBeNull();
  });
});

describe("majorityGroup", () => {
  it("picks the most common, breaking ties by taxonomy order", () => {
    expect(majorityGroup(["GTM", "WEB", "GTM"], ["WEB", "GTM"])).toBe("GTM");
    expect(majorityGroup(["GTM", "WEB"], ["WEB", "GTM"])).toBe("WEB");
    expect(majorityGroup(["ZZ", "GTM"], ["WEB", "GTM"])).toBe("GTM");
    expect(majorityGroup([], ["WEB"])).toBeNull();
  });
});

describe("isCatchAll", () => {
  it("matches the home dir and the root only", () => {
    expect(isCatchAll({ id: "h", path: "/Users/me" }, "/Users/me")).toBe(true);
    expect(isCatchAll({ id: "h", path: "/Users/me/" }, "/Users/me")).toBe(true);
    expect(isCatchAll({ id: "r", path: "/" }, "/Users/me")).toBe(true);
    expect(isCatchAll({ id: "c", path: "/Users/me/Code/x" }, "/Users/me")).toBe(false);
    expect(isCatchAll({ id: "e", path: "" }, "/Users/me")).toBe(false);
  });
});

describe("buildTopicsMap", () => {
  const islands = [
    { id: "home", path: "/Users/me" },
    { id: "acme-ai-next", path: "/Users/me/Code/acme-ai-next" },
    { id: "mixed", path: "/Users/me/Code/mixed" },
    { id: "legal-taxonomy", path: "" },
    { id: "empty-thing", path: "" },
  ];
  const sessions: SessionInput[] = [
    s("h1", "fix the acme.ai website"),
    s("h2", "totally unclear"),
    s("h3", "yalla-brief /yalla-brief"),
    s("w1", "anything", "acme-ai-next", { catchAll: false }),
    s("m1", "the website again", "mixed", { catchAll: false }),
    s("m2", "outbound campaign", "mixed", { catchAll: false }),
    s("m3", "more outbound", "mixed", { catchAll: false }),
  ];
  const { map, needJev } = buildTopicsMap({ taxonomy: tax, islands, sessions, assignments: new Map(), jev: new Map(), homeDir: "/Users/me", jevStatus: "disabled", now: 0 });

  it("unclassifiable sessions land in the fallback group and are queued for Jev", () => {
    expect(map.sessions.h2).toEqual({ group: "OTHER", source: "fallback" });
    expect(needJev.map((x) => x.id)).toEqual(["h2"]);
    expect(map.pendingJev).toBe(1);
  });
  it("islands take the majority group of their sessions", () => {
    expect(map.islands.mixed).toBe("GTM");
    expect(map.islands["acme-ai-next"]).toBe("WEB");
  });
  it("session-less islands use a folder rule, else the fallback", () => {
    expect(map.islands["legal-taxonomy"]).toBe("RESEARCH");
    expect(map.islands["empty-thing"]).toBe("OTHER");
  });
  it("marks catch-all islands and lists only used groups, most sessions first", () => {
    expect(map.catchAll).toEqual(["home"]);
    expect(map.groups[0]?.key).toBe("WEB");
    expect(map.groups.every((g) => g.sessions > 0 || g.cities > 0)).toBe(true);
    expect(map.groups.find((g) => g.key === "SETUP")).toBeUndefined();
    expect(isTopicsMap(map)).toBe(true);
  });
  it("is deterministic", () => {
    const again = buildTopicsMap({ taxonomy: tax, islands, sessions: [...sessions].reverse(), assignments: new Map(), jev: new Map(), homeDir: "/Users/me", jevStatus: "disabled", now: 0 });
    expect(again.map.islands).toEqual(map.islands);
    expect(again.map.groups).toEqual(map.groups);
  });
});

describe("Jev body + answers", () => {
  const batch = [s("aa", "who knows"), s("bb", "no idea", "proj", { catchAll: false })];
  const { body, keys } = buildJevBody(batch, tax);

  it("asks one choice question per session with every group as a criterion", () => {
    const questions = body.questions as Record<string, { type: string; criteria: Record<string, string> }>;
    expect(Object.keys(questions)).toEqual(["s0", "s1"]);
    expect(Object.keys(questions.s0!.criteria)).toEqual(tax.groups.map((g) => g.key));
    expect(keys.get("s1")).toBe("bb");
  });
  it("keeps valid answers and skips malformed or unknown ones", () => {
    const got = parseJevAnswers({ answers: { s0: { choice: "SETUP", probabilities: {}, confidence: 0.8 }, s1: { choice: "MARS" } } }, keys, tax);
    expect([...got.entries()]).toEqual([["aa", "SETUP"]]);
    expect(parseJevAnswers(null, keys, tax).size).toBe(0);
    expect(parseJevAnswers({ answers: "x" }, keys, tax).size).toBe(0);
  });
});

describe("isTopicsMap", () => {
  it("rejects malformed maps", () => {
    expect(isTopicsMap(null)).toBe(false);
    expect(isTopicsMap({ groups: [], sessions: {}, islands: {}, catchAll: "x" })).toBe(false);
    expect(isTopicsMap({ groups: [{ key: "A", name: "A", color: "red", sessions: 1, cities: 0 }], sessions: {}, islands: {}, catchAll: [] })).toBe(false);
  });
});

describe("repo-owned rules mined from OTHER (EXTRA_RULES + mined keywords)", () => {
  const full = parseTaxonomy({
    groups: ["WEB", "GTM", "CONTENT", "PROD", "TEAM", "RESEARCH", "SETUP", "PERSONAL", "AUTO"].map((key) => ({ key, name: key, hint: "" })),
    rules: [],
  });
  const g = (title: string): string | null => ruleGroup(s("a", title), full);

  it("automation prompts land in AUTO", () => {
    expect(g('<scheduled-task name="rss-feed-obsidian" file="/Users/me/.claude/scheduled-tasks/rss-feed-obsidian/SKILL.md">')).toBe("AUTO");
    expect(g('<scheduled-task name="acme-inbox-scan" file="x">skills and hooks')).toBe("AUTO"); // beats the SETUP keywords
    expect(g("<command-message>ig-innovation</command-message> <command-name>/ig-innovation</command-name>")).toBe("AUTO");
    expect(g("You are a triage classifier for Alex's idea inbox. Read the note and return STRICT JSON")).toBe("AUTO");
    expect(g("You are drafting a NON-EXECUTABLE proposed plan from one of Alex's raw idea notes.")).toBe("AUTO");
    expect(g("Classify each Claude Code session into exactly one group. GROUPS:")).toBe("AUTO");
    expect(g("History: Task: Review this Arabic MSA ...")).toBe("AUTO");
    expect(g("## Task the user asked Which model should I use for this legal task?")).toBe("AUTO");
    expect(g("Read brief.yaml here and propose concrete build steps. You are one node of a Side fleet running in READ-ONLY mode.")).toBe("AUTO");
    expect(g("Reply with exactly: PONG")).toBe("AUTO");
    expect(g("Create a file called hello.txt containing exactly the word: side")).toBe("AUTO");
  });
  it("…but not the same words in a hand-typed prompt", () => {
    expect(g("I want to create a scheduled-task for the rss feed")).not.toBe("AUTO");
    expect(g("what is my history with Sam?")).not.toBe("AUTO");
    expect(g("reply to this email for me")).toBeNull();
    expect(g("create a file with the Q3 numbers")).toBeNull();
    expect(g("/daily-recap is broken, fix the skill")).toBe("SETUP");
    // review finding (2026-09-27): a bare "^History:" sent a hand-typed prompt to AUTO too.
    expect(g("History: the Ottoman land code and how it shaped Lebanese property law")).not.toBe("AUTO");
  });
  it("mined topical keywords place unambiguous titles", () => {
    expect(g("merge: https://github.com/ACME-Inc/acme-ai/pull/171")).toBe("WEB");
    expect(g("In HubSpot crm, Fix bouncing emails and dead phone numbers please.")).toBe("GTM");
    expect(g("CON | High Score Upgrade Nudge create email copyright for this nudge !")).toBe("GTM");
    expect(g("Create a press release for this new feature we just released on ACME.")).toBe("CONTENT");
    expect(g("in download, you can see Jad's submission of use case. Evaluate honestly")).toBe("TEAM");
    expect(g("is this useful? https://github.com/superset-sh/superset.git given our existing setup")).toBe("RESEARCH");
    expect(g("is my alex_claude system fully working?")).toBe("SETUP");
    expect(g("lets continue building unspeakable world.")).toBe("PERSONAL");
  });
  it("mined keywords stay out of look-alikes and ambiguous titles", () => {
    expect(g("clone https://github.com/makermate/claw3d.git Set up a new project")).toBeNull(); // building, not evaluating
    expect(g("is this useful? https://github.com/ACME-Inc/acme-ai.git")).toBe("WEB"); // own repo is not research
    expect(g("<ide_opened_file>The user opened the file /Users/me/Code/alex_claude/20-Projects/x.md")).toBeNull();
    expect(g("top 20 use cases you can test today")).toBeNull();
    expect(g("I want to write the press release for the website launch")).toBeNull(); // CONTENT + WEB: Jev decides
    expect(g("hello")).toBeNull();
  });
  it("review finding (2026-09-27): over-broad mined keywords no longer misfire", () => {
    // applicant/candidate is a normal legal term at a legal-AI company: needs a hiring context word.
    expect(g("Draft a response for the applicant regarding their submission")).not.toBe("TEAM");
    // a bare possessive "'s use case" caught any product name, not just a person being evaluated.
    expect(g("Clio's use case for solo law firms")).not.toBe("TEAM");
    // \bstark\b alone caught the plain English word; the real side project is "project stark".
    expect(g("that's a stark contrast to what we shipped last quarter")).not.toBe("PERSONAL");
    expect(g("what is this movie about the legal AI market")).not.toBe("PERSONAL");
    // \bstripe\b alone caught unrelated engineering work; needs a billing/revenue context word.
    expect(g("Stripe webhook failure in checkout")).not.toBe("GTM");
  });
});
