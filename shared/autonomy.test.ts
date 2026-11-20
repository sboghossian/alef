import { describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS, LOW_MESSAGE_TURNS, autonomyLevel, type AutonomySessionInput } from "./autonomy";

function s(over: Partial<AutonomySessionInput> = {}): AutonomySessionInput {
  return { title: "fix the login bug on the pricing page", messageCount: 320, cwd: "/Users/alexboghossian/Documents/Code/agent-world", ...over };
}

describe("AUTONOMY_LEVELS", () => {
  it("is 5 ordered levels, 1..5, left (driven by you) to right (the resident)", () => {
    expect(AUTONOMY_LEVELS.map((m) => m.level)).toEqual([1, 2, 3, 4, 5]);
    expect(AUTONOMY_LEVELS.every((m) => m.title.length > 0 && m.hint.length > 0)).toBe(true);
  });
});

describe("autonomyLevel: level 1 (driven by you)", () => {
  it("a real back-and-forth session with no automation/headless signal defaults to level 1", () => {
    const r = autonomyLevel(s({ title: "there is a ACME prompt library in our website acme.ai maybe we should", messageCount: 639 }));
    expect(r.level).toBe(1);
    expect(r.reason).toContain("639 messages");
  });

  it("messages strictly above the low-turn threshold stay level 1", () => {
    expect(autonomyLevel(s({ messageCount: LOW_MESSAGE_TURNS + 1 })).level).toBe(1);
  });
});

describe("autonomyLevel: level 2 (seeded by you)", () => {
  it("a short, non-automation session (<= the low-turn threshold) reads as a single seeded prompt", () => {
    const r = autonomyLevel(s({ title: "clean up the stale feature branches", messageCount: LOW_MESSAGE_TURNS }));
    expect(r.level).toBe(2);
    expect(r.reason).toContain(`${LOW_MESSAGE_TURNS} messages`);
  });

  it("messageCount 0 with no other signal is still level 2, not a crash", () => {
    expect(autonomyLevel(s({ title: "ok", messageCount: 0 })).level).toBe(2);
  });
});

describe("autonomyLevel: level 3 (scheduled / named automation)", () => {
  it("a launchd-dispatched skill title (name /name — real observed shape) is level 3 even with many messages", () => {
    const r = autonomyLevel(s({ title: "inbox-sweep /inbox-sweep — headless run, nobody is there to answer. Do every action.", messageCount: 47 }));
    expect(r.level).toBe(3);
    expect(r.reason).toContain("/inbox-sweep");
  });

  it("a scheduled-task wrapper is level 3", () => {
    const r = autonomyLevel(s({ title: '<scheduled-task name="rss-feed-obsidian" file="…">do the thing', messageCount: 12 }));
    expect(r.level).toBe(3);
    expect(r.reason).toContain("rss-feed-obsidian");
  });

  it("a /daily-recap narrative step is level 3", () => {
    const r = autonomyLevel(s({ title: "You are the narrative step of Alex's /daily-recap. A deterministic script has already…", messageCount: 200 }));
    expect(r.level).toBe(3);
    expect(r.reason).toContain("/daily-recap");
  });

  it("scheduled/named beats a low message count for level 2", () => {
    const r = autonomyLevel(
      s({ title: "ig-innovation /ig-innovation — headless run, nobody is there to answer. Triage the saved items.", messageCount: 1 }),
    );
    expect(r.level).toBe(3);
  });

  it("a bare '/skill' command shape with no headless marker is NOT trusted as automation (it's what an interactive slash command looks like too — GRO-review finding)", () => {
    // Real archive title shapes from the review: a human typing a slash command interactively
    // produces the exact same COMMAND_NAME/STRIPPED_COMMAND text a launchd script would.
    const liveTagged = s({
      title: "<command-message>linear</command-message> <command-name>/linear</command-name> <command-args>for the agency work with: the outbound sequence</command-args>",
      messageCount: 240,
    });
    expect(autonomyLevel(liveTagged).level).not.toBe(3);
    expect(autonomyLevel(liveTagged).level).toBe(1);

    const portfolio = s({ title: "<command-name>/portfolio</command-name> <command-args>ship this to my portfolio site</command-args>", messageCount: 240 });
    expect(autonomyLevel(portfolio).level).toBe(1);

    const linkedinPost = s({ title: "<command-message>linkedin-post</command-message> <command-name>/linkedin-post</command-name>", messageCount: 240 });
    expect(autonomyLevel(linkedinPost).level).toBe(1);

    // Already tag-stripped (archived) shapes: "qa /qa", "grill-me /grill-me" — same ambiguity.
    expect(autonomyLevel(s({ title: "qa /qa", messageCount: 240 })).level).toBe(1);
    expect(autonomyLevel(s({ title: "grill-me /grill-me", messageCount: 240 })).level).toBe(1);
  });

  it("the bare '/skill' shape STILL counts as automation for a confirmed launchd skill, even with no headless marker (KNOWN_HEADLESS_COMMAND_SKILLS) — ✅ verified against a live GET /api/world, 2026-09-27: this is the real title shape yalla-brief/ig-innovation runs use", () => {
    expect(autonomyLevel(s({ title: "yalla-brief /yalla-brief", messageCount: 178 })).level).toBe(3);
    expect(autonomyLevel(s({ title: "ig-innovation /ig-innovation", messageCount: 86 })).level).toBe(3);
  });
});

describe("autonomyLevel: fleet-probe and eval-harness are headless test/bench machinery, not scheduled automations", () => {
  it("a fleet-probe smoke test is level 4, never level 3 — it's Alef's own test harness, not something Alex scheduled", () => {
    const r = autonomyLevel(s({ title: "Reply with exactly: PONG", messageCount: 2 }));
    expect(r.level).toBe(4);
    expect(r.reason).toContain("fleet-probe");
  });

  it("an eval-harness replay is level 4, never level 3", () => {
    const r = autonomyLevel(s({ title: "History: Task: Review this SaaS Master Services Agreement...", messageCount: 30 }));
    expect(r.level).toBe(4);
    expect(r.reason).toContain("eval-harness");
  });
});

describe("autonomyLevel: a confirmed launchd prompt with no slash-command shape at all", () => {
  it("the eulex-bench daily scorer (launchd-scheduled claude -p, no /skill name) is level 3 (scheduled), not the level-1 default", () => {
    // Real title + messageCount shape from the review: entrypoint sdk-cli, 1 human turn, but
    // messageCount 63-136 (tool_use/tool_result turns all count) since WorldAgent has no separate
    // human-turn field — see the module doc.
    const r = autonomyLevel(s({ title: "Score today's eulex-bench run in ~/.eulex-bench/bench/results and post a summary", messageCount: 96 }));
    expect(r.level).toBe(3);
  });
});

describe("autonomyLevel: level 4 (unnamed headless / subagent / workflow)", () => {
  it("a bare 'headless run' phrase with no automation name attached is level 4", () => {
    const r = autonomyLevel(s({ title: "headless run: reconcile the invoice queue overnight", messageCount: 40 }));
    expect(r.level).toBe(4);
  });

  it("'nobody is there to answer' alone (no name /name prefix) is level 4", () => {
    const r = autonomyLevel(s({ title: "nobody is there to answer, so proceed without confirmation", messageCount: 9 }));
    expect(r.level).toBe(4);
  });
});

describe("autonomyLevel: level 5 (the resident)", () => {
  it("a session whose cwd is inside ~/.alef-resident is the resident, regardless of title", () => {
    const r = autonomyLevel(s({ cwd: "/Users/alexboghossian/.alef-resident", title: "fix the login bug", messageCount: 500 }));
    expect(r.level).toBe(5);
  });

  it("a nested resident path (journal, skills/…) still matches", () => {
    expect(autonomyLevel(s({ cwd: "/Users/alexboghossian/.alef-resident/journal" })).level).toBe(5);
  });

  it("a cwd that merely contains the substring without the dot-segment boundary does not match", () => {
    expect(autonomyLevel(s({ cwd: "/Users/alexboghossian/not-alef-resident-at-all" })).level).not.toBe(5);
  });

  it("resident cwd wins over an automation-shaped title (precedence: resident first)", () => {
    expect(autonomyLevel(s({ cwd: "/Users/alexboghossian/.alef-resident", title: "<scheduled-task name=\"x\">go" })).level).toBe(5);
  });
});

describe("autonomyLevel: unknown sessions get the nearest defensible level, with a reason", () => {
  it("every result carries a non-empty reason string", () => {
    const cases: AutonomySessionInput[] = [
      s({ messageCount: 0, title: "" }),
      s({ messageCount: 5000, title: "a".repeat(600) }),
      s({ cwd: "/" }),
    ];
    for (const c of cases) {
      const r = autonomyLevel(c);
      expect(r.reason.length).toBeGreaterThan(0);
      expect([1, 2, 3, 4, 5]).toContain(r.level);
    }
  });
});
