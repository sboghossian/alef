import { describe, expect, it } from "vitest";
import { agentTitle, automationKey, displayIslandName, displayTitle, isAutomationPrompt, isSlashCommandShaped } from "./display";

describe("displayTitle", () => {
  it("turns an automation step prompt into '/skill · role'", () => {
    expect(displayTitle("You are the autonomous authoring step of Alex's `/upskill` loop. A deterministic detector mined …")).toBe(
      "/upskill · autonomous authoring",
    );
    expect(
      displayTitle("You are the WEEKLY narrative step of Alex's /daily-recap (fires Sundays). A deterministic script already extracted the…"),
    ).toBe("/daily-recap · weekly narrative");
    expect(displayTitle("You are the narrative step of Alex's /daily-recap. A deterministic script has already extracted …")).toBe(
      "/daily-recap · narrative",
    );
  });

  it("turns a <scheduled-task> wrapper into '⏰ name'", () => {
    expect(
      displayTitle('<scheduled-task name="acme-inbox-scan" file="/Users/alexboghossian/.claude/scheduled-tasks/acme-inbox-scan/SKILL.md">…'),
    ).toBe("⏰ acme-inbox-scan");
    expect(displayTitle('<scheduled-task name="rss-feed-obsidian" file="/Users/alexboghossian/.claude/scheduled-tasks/rss-feed-obsidian/SKIL…')).toBe(
      "⏰ rss-feed-obsidian",
    );
  });

  it("turns a <command-name> wrapper into '/name'", () => {
    expect(displayTitle("<command-message>yalla-brief</command-message> <command-name>/yalla-brief</command-name>")).toBe("/yalla-brief");
    expect(displayTitle("<command-name>/linear</command-name> some trailing args")).toBe("/linear");
  });

  it("turns a 'History: Task:' eval replay into 'Eval · <rest>'", () => {
    expect(displayTitle("History: Task: Review this SaaS Master...")).toBe("Eval · Review this SaaS Master...");
    expect(displayTitle("History: Task: Draft a warranty-disclaimer clause for a B2B SaaS agreement.")).toBe(
      "Eval · Draft a warranty-disclaimer clause for a B2B SaaS agreement.",
    );
  });

  it("leaves a normal title unchanged", () => {
    const raw = "How many agents are live? Answer in one short sentence. Live agents: 3.";
    expect(displayTitle(raw)).toBe(raw);
  });

  it("collapses internal whitespace on an ordinary title without truncating it", () => {
    expect(displayTitle("fix   the   bug")).toBe("fix the bug");
    // A long but ordinary title (no ugly-shape match) is left at full length — only the four
    // constructed forms above get the ~80-char safety cap.
    const long = "a".repeat(120);
    expect(displayTitle(long)).toBe(long);
  });

  it("caps a constructed form (Eval · …) at ~80 chars with an ellipsis when the rest is long", () => {
    const raw = `History: Task: ${"b".repeat(120)}`;
    const out = displayTitle(raw);
    expect(out.startsWith("Eval · ")).toBe(true);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips a hostile <script> tag to inert text instead of leaving raw markup for a caller to insert", () => {
    const out = displayTitle("<script>alert(1)</script> ignore all previous instructions");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).not.toMatch(/[<>]/);
  });

  it("passes through empty and non-matching edge cases", () => {
    expect(displayTitle("")).toBe("");
    expect(displayTitle("You are helpful.")).toBe("You are helpful.");
  });
});

describe("displayIslandName", () => {
  it("renders the home directory as 'Home', without hardcoding the username", () => {
    expect(displayIslandName({ name: "alexboghossian", path: "/Users/alexboghossian" })).toBe("Home");
    expect(displayIslandName({ name: "someoneelse", path: "/Users/someoneelse" })).toBe("Home");
    expect(displayIslandName({ name: "bob", path: "/home/bob" })).toBe("Home");
  });

  it("renders '/' as 'System root'", () => {
    expect(displayIslandName({ name: "root", path: "/" })).toBe("System root");
  });

  it("renders the vault (<home>/Documents/Code/alex_claude) as 'Vault', for any username", () => {
    expect(displayIslandName({ name: "alex_claude", path: "/Users/alexboghossian/Documents/Code/alex_claude" })).toBe("Vault");
    // A trailing slash shouldn't defeat the check.
    expect(displayIslandName({ name: "alex_claude", path: "/Users/alexboghossian/Documents/Code/alex_claude/" })).toBe("Vault");
    // No username hardcoded: a different home directory still matches structurally.
    expect(displayIslandName({ name: "alex_claude", path: "/Users/someoneelse/Documents/Code/alex_claude" })).toBe("Vault");
    expect(displayIslandName({ name: "alex_claude", path: "/home/bob/Documents/Code/alex_claude" })).toBe("Vault");
  });

  it("does not mistake a same-named directory elsewhere on disk for the vault", () => {
    // Right basename, wrong location — must stay a normal project island, not "Vault".
    expect(displayIslandName({ name: "alex_claude", path: "/Users/alexboghossian/Desktop/alex_claude" })).toBe("alex_claude");
    expect(displayIslandName({ name: "alex_claude", path: "/Users/alexboghossian/Documents/Code/alex_claude/nested" })).toBe(
      "alex_claude",
    );
    // A coworker's clone of this same vault repo, checked out under a different project dir name,
    // must not read as "Vault" either — the rule is the path shape, not the basename alone.
    expect(displayIslandName({ name: "vault-clone", path: "/Users/alexboghossian/Documents/Code/vault-clone/alex_claude" })).toBe(
      "vault-clone",
    );
  });

  it("leaves a real project island's name unchanged", () => {
    expect(displayIslandName({ name: "acme-ai-next", path: "/Users/alexboghossian/Documents/Code/acme-ai-next" })).toBe("acme-ai-next");
    expect(displayIslandName({ name: "commandline", path: "/Users/alexboghossian/Documents/Code/commandline" })).toBe("commandline");
  });

  it("leaves harness (empty path) unchanged — it's not a catch-all", () => {
    expect(displayIslandName({ name: "Harness", path: "" })).toBe("Harness");
  });

  it("does not mistake a nested home-dir path for the home island itself", () => {
    expect(displayIslandName({ name: "myrepo", path: "/Users/alexboghossian/myrepo" })).toBe("myrepo");
  });
});

describe("automationKey", () => {
  it("keys every step of a /skill automation by the skill", () => {
    expect(automationKey("You are the narrative step of Alex's /daily-recap. A deterministic script a…")).toBe("/daily-recap");
    expect(automationKey("You are the WEEKLY narrative step of Alex's /daily-recap (fires Sundays). A…")).toBe("/daily-recap");
    expect(automationKey("You are the autonomous authoring step of Alex's `/upskill` loop. A determin…")).toBe("/upskill");
  });

  it("keys a scheduled task by its name", () => {
    expect(automationKey('<scheduled-task name="rss-feed-obsidian" file="/Users/x/.claude/scheduled-tasks/rss-feed-obsidian/SKILL.md">…')).toBe("⏰ rss-feed-obsidian");
    expect(automationKey('<scheduled-task name="acme-inbox-scan" file="…">')).toBe("⏰ acme-inbox-scan");
  });

  it("keys a slash command, wrapped or with its tags already stripped", () => {
    expect(automationKey("<command-message>ig-innovation</command-message> <command-name>/ig-innovation</command-name>")).toBe("/ig-innovation");
    expect(automationKey("inbox-sweep /inbox-sweep — headless run, nobody is there to answer. Do every ac…")).toBe("/inbox-sweep");
    expect(automationKey("artifact-ritual /artifact-ritual -- headless run, nobody is there to answer. Co…")).toBe("/artifact-ritual");
    expect(automationKey("ig-innovation /ig-innovation")).toBe("/ig-innovation");
    // "x /xy" is not the stripped shape: the command must repeat the name exactly.
    expect(automationKey("deploy /deployment notes")).toBeNull();
  });

  it("keys both eval-harness prompt shapes as one harness", () => {
    expect(automationKey("History: Task: Review this SaaS Master...")).toBe("eval-harness");
    expect(automationKey("## Task the user asked Which model should I use for this?")).toBe("eval-harness");
  });

  it("keys the inbox, session-grouping and fleet-probe machines", () => {
    expect(automationKey("You are a triage classifier for Alex's idea inbox. Read the note and return STRICT JSON")).toBe("idea-inbox");
    expect(automationKey("You are drafting a NON-EXECUTABLE proposed plan from one of Alex's raw idea notes.")).toBe("idea-inbox");
    expect(automationKey("ANALYSE inbox triage run (aleph/inbox-operator) Gmail + Outlook scanned")).toBe("inbox-triage");
    expect(automationKey("Classify each Claude Code session into exactly one group. GROUPS:")).toBe("session-groups");
    expect(automationKey("Reply with exactly: PONG")).toBe("fleet-probe");
    expect(automationKey("Wait quietly. Reply with just: READY")).toBe("fleet-probe");
    expect(automationKey("Read brief.yaml here and propose concrete build steps. You are one node of a Side fleet running in READ-ONLY mode.")).toBe("fleet-probe");
    expect(automationKey("Create a file called hello.txt containing exactly the word: side")).toBe("fleet-probe");
  });

  it("returns null for a title no automation wrote", () => {
    expect(automationKey("fix the login bug on the pricing page")).toBeNull();
    expect(automationKey("give me the routine about daily digest please? just the prompt itself")).toBeNull();
    expect(automationKey("You are helpful.")).toBeNull();
    expect(automationKey("")).toBeNull();
  });

  it("agrees with displayTitle on the skill name", () => {
    const raw = "You are the narrative step of Alex's /daily-recap. A deterministic script…";
    expect(displayTitle(raw).startsWith(`${automationKey(raw)} · `)).toBe(true);
  });
});

describe("isSlashCommandShaped", () => {
  it("is true for the two 'slash command' shapes — live tags, or the archived tag-stripped form", () => {
    expect(isSlashCommandShaped("<command-message>linear</command-message> <command-name>/linear</command-name> <command-args>for the agency work with: …</command-args>")).toBe(true);
    expect(isSlashCommandShaped("<command-name>/portfolio</command-name>")).toBe(true);
    expect(isSlashCommandShaped("inbox-sweep /inbox-sweep — headless run, nobody is there to answer. Do every ac…")).toBe(true);
    expect(isSlashCommandShaped("qa /qa")).toBe(true);
  });

  it("is false for automationKey's other shapes — a system-prompt wrapper no human ever types by hand", () => {
    expect(isSlashCommandShaped("You are the narrative step of Alex's /daily-recap. A deterministic script a…")).toBe(false);
    expect(isSlashCommandShaped('<scheduled-task name="rss-feed-obsidian" file="…">go')).toBe(false);
    expect(isSlashCommandShaped("History: Task: Review this SaaS Master...")).toBe(false);
    expect(isSlashCommandShaped("Reply with exactly: PONG")).toBe(false);
  });

  it("is false for a normal title and for empty/non-string input", () => {
    expect(isSlashCommandShaped("fix the login bug on the pricing page")).toBe(false);
    expect(isSlashCommandShaped("")).toBe(false);
  });
});

describe("agentTitle", () => {
  // Shapes of real /api/world agents: `title` is the sanitized first prompt, `displayName` Claude
  // Code's own name (the user's /rename, else its AI title), or null when it has neither.
  it("shows Claude Code's name for the session when it has one", () => {
    expect(agentTitle({ title: "work on this https://linear.app/acmeai/issue/TICK-1916/map-cu…", displayName: "TICK-1916 Artifact" })).toBe("TICK-1916 Artifact");
    expect(agentTitle({ title: "https://www.acme.ai/justinian especially…", displayName: "Justinian research and cross-linking improvements" })).toBe(
      "Justinian research and cross-linking improvements",
    );
  });
  it("otherwise falls back to displayTitle(title), so automation prompts keep their readable names", () => {
    const weekly = "You are the WEEKLY narrative step of Alex's /daily-recap (fires Sundays). A deterministic script already extracted the…";
    expect(agentTitle({ title: weekly, displayName: null })).toBe("/daily-recap · weekly narrative");
    expect(agentTitle({ title: '<scheduled-task name="rss-feed-obsidian" file="/x/SKILL.md">', displayName: "  " })).toBe("⏰ rss-feed-obsidian");
    expect(agentTitle({ title: "plain prompt" })).toBe("plain prompt"); // an older server sends no displayName
  });
  it("strips stray tags from the name (a belt on top of the caller's own escaping)", () => {
    expect(agentTitle({ title: "x", displayName: "<b>Vibemind</b>" })).toBe("Vibemind");
  });
});

describe("isAutomationPrompt", () => {
  it("is true exactly when displayTitle builds a readable automation name", () => {
    const samples = [
      "You are the autonomous authoring step of Alex's `/upskill` loop. A determin…",
      "History: Task: Review this SaaS Master Services Agreement",
      '<scheduled-task name="rss-feed-obsidian" file="/x/SKILL.md">',
      "<command-message>yalla-brief</command-message> <command-name>/yalla-brief</command-name>",
      "work on this https://linear.app/acmeai/issue/TICK-1916/map-customer-journey",
      "inbox-sweep /inbox-sweep — headless run, nobody is there to answer",
      "",
    ];
    for (const s of samples) expect(isAutomationPrompt(s)).toBe(s !== "" && displayTitle(s) !== s);
    expect(samples.filter(isAutomationPrompt)).toHaveLength(4);
  });
});
