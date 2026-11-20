import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationRunResult, AutomationsResponse } from "../../shared/features/automations.js";
import { isKickstartableLabel, isSelfDescribedScheduled, parseSkillFrontmatter, scheduleEvidence, skillRefsIn, statedCadence } from "../features/automations-lib.js";
import { createAutomationsFeature } from "../features/automations.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function plist(label: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/echo</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
${extra}
</dict></plist>`;
}

describe("automations-lib", () => {
  it("parses folded frontmatter and detects rituals without matching ordinary skills", () => {
    const m = parseSkillFrontmatter("---\nname: inbox-sweep\ndescription: >-\n  Alex's 9 a.m. inbox ritual. Sweeps\n  every account.\nmetadata:\n  v: 1\n---\n# body");
    expect(m).toEqual({ name: "inbox-sweep", description: "Alex's 9 a.m. inbox ritual. Sweeps every account." });
    expect(isSelfDescribedScheduled(m ?? { name: "", description: "" })).toBe(false); // "9 a.m. ritual" alone is not a scheduler
    expect(isSelfDescribedScheduled({ name: "retro", description: "Weekly engineering retrospective. Analyzes commit history." })).toBe(false);
    expect(statedCadence("fires daily 08:00 Paris via launchd")).toBe("daily 08:00");
    expect(statedCadence("the 9 a.m. inbox ritual")).toBe("09:00");
  });
  it("counts a skill as scheduled only on real scheduler evidence (real descriptions, 2026-09-25)", () => {
    const yes = (description: string): boolean => isSelfDescribedScheduled({ name: "x", description });
    // positives, verbatim from ~/.claude/skills
    expect(yes('Use when Alex says "artifact ritual", or when the launchd job com.stephane.artifact-ritual fires at 08:00.')).toBe(true);
    expect(yes('Alex\'s 9 a.m. inbox ritual. Use when "clear my inbox", or when the 09:00 launchd job fires.')).toBe(true);
    expect(yes("Fires daily 08:00 Paris (Lisbon from 2026-08-03) via launchd; also invocable manually as /yalla-brief")).toBe(true);
    expect(yes('Use when "check my instagram saves", or when the launchd job fires. Also use when he pastes a link.')).toBe(true);
    expect(yes("Backward-looking log. Runs unattended at 08:10 via launchd.")).toBe(true);
    // negatives: manual rituals, passing mentions of a cadence, a cron, or "fires" about triggers
    expect(yes("Alex's weekly PLG conversion ritual for ACME. Use on the Monday growth-sync cadence.")).toBe(false);
    expect(yes('Alex\'s money ritual — weekly net-worth check-in. Use when "networth", or when the weekly/monthly nudge fires.')).toBe(false);
    expect(yes("Author a new SKILL.md. Does not touch the nightly knowledge-learner cron. triggers: upskill")).toBe(false);
    expect(yes("Routines (scheduled/event-driven runs), /rewind, /compact vs /clear")).toBe(false);
    expect(yes("Every ticket is a six-line contract. Fires automatically on any work over 15 minutes.")).toBe(false);
    expect(yes("Weekly engineering retrospective. Run a daily security audit.")).toBe(false);
  });
  it("finds skills a plist or scheduled task invokes, by skill path or slash command", () => {
    const known = new Set(["inbox-sweep", "yalla-brief", "bin", "sessions"]);
    expect(skillRefsIn("<string>/Users/s/.claude/skills/inbox-sweep/bin/run.sh</string>", known)).toEqual(["inbox-sweep"]);
    expect(skillRefsIn("claude -p \"/yalla-brief\" --permission-mode acceptEdits", known)).toEqual(["yalla-brief"]);
    expect(skillRefsIn("<string>/opt/homebrew/bin/bash</string>", known)).toEqual([]); // path segments are not slash commands
    expect(skillRefsIn("see ~/.claude/skills/unknown-skill/x and /nope", known)).toEqual([]);
    const meta = { name: "plg-ritual", description: "Weekly PLG ritual." };
    expect(scheduleEvidence(meta, { plist: false, scheduledTask: false })).toBeNull();
    expect(scheduleEvidence(meta, { plist: false, scheduledTask: true })).toBe("scheduled-task");
    expect(scheduleEvidence(meta, { plist: true, scheduledTask: true })).toBe("launchd-plist");
  });
  it("only kickstarts com.stephane.* labels", () => {
    expect(isKickstartableLabel("com.stephane.daily-recap")).toBe(true);
    expect(isKickstartableLabel("dev.dashable.yalla-brief")).toBe(false);
    expect(isKickstartableLabel("com.stephane.x; rm -rf /")).toBe(false);
  });
});

describe("automations routes", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function setup(): Promise<{ base: string; kicked: string[]; home: string }> {
    const home = await mkdtemp(join(tmpdir(), "aw-auto-"));
    const la = join(home, "Library", "LaunchAgents");
    const skills = join(home, ".claude", "skills");
    const out = join(home, "Documents", "Code", "yalla-brief", "out");
    await mkdir(la, { recursive: true });
    await mkdir(out, { recursive: true });
    await writeFile(join(la, "com.stephane.daily-recap.plist"), plist("com.stephane.daily-recap"));
    await writeFile(join(la, "com.stephane.bridge.plist"), plist("com.stephane.bridge", "<key>KeepAlive</key><true/>"));
    await writeFile(join(la, "dev.dashable.yalla-brief.plist"), plist("dev.dashable.yalla-brief"));
    await writeFile(join(la, "dev.dashable.tunnel.plist"), plist("dev.dashable.tunnel"));
    const skillDefs: Array<[string, string]> = [
      ["daily-recap", "Backward-looking log. Runs unattended at 08:10 via launchd."],
      ["yalla-brief", "Daily morning brief. Fires daily 08:00 via launchd."],
      ["plg-ritual", "Weekly PLG conversion ritual."],
      ["retro", "Weekly engineering retrospective."],
      ["ig-innovation", "Triage saves. Use when he says so, or when the launchd job fires."],
      ["brain-digest", "Digest the vault."],
      ["sweeper", "Cleans worktrees."],
    ];
    await writeFile(join(la, "com.stephane.worktree-janitor.plist"), plist("com.stephane.worktree-janitor", `<key>Program</key><string>${home}/.claude/skills/sweeper/bin/run.sh</string>`));
    await mkdir(join(home, ".claude", "scheduled-tasks", "nightly-digest"), { recursive: true });
    await writeFile(join(home, ".claude", "scheduled-tasks", "nightly-digest", "SKILL.md"), "---\nname: nightly-digest\n---\nRun /brain-digest and file it.\n");
    for (const [name, desc] of skillDefs) {
      await mkdir(join(skills, name), { recursive: true });
      await writeFile(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
    }
    await writeFile(join(out, "yalla-brief-2026-09-24.html"), "<p>old</p>");
    await writeFile(join(out, "yalla-brief-2026-09-25.html"), "<p>new</p>");
    await writeFile(join(out, "yalla-brief-2026-09-26.html"), ""); // empty: ignored
    const kicked: string[] = [];
    const feature = createAutomationsFeature({
      home,
      launchctlList: async () => "PID\tStatus\tLabel\n-\t0\tcom.stephane.daily-recap\n123\t0\tcom.stephane.bridge\n",
      kickstart: async (label) => void kicked.push(label),
      uid: 501,
    });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    return { base: b.base, kicked, home };
  }
  const run = async (base: string, id: string, body: unknown): Promise<{ status: number; body: AutomationRunResult }> => {
    const res = await fetch(`${base}/api/automations/${id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as AutomationRunResult };
  };

  it("lists launchd jobs + ritual skills with the latest output; never dev.dashable.* infra other than yalla-brief", async () => {
    const { base, home } = await setup();
    const body = (await (await fetch(`${base}/api/automations`)).json()) as AutomationsResponse;
    const ids = body.automations.map((a) => a.id);
    // plg-ritual / retro: nothing schedules them. brain-digest: a scheduled task runs it.
    // sweeper: run by the worktree-janitor plist, so it folds into that job (which keeps its name).
    expect(ids).toEqual(["brain-digest", "bridge", "daily-recap", "ig-innovation", "worktree-janitor", "yalla-brief"]);
    expect(body.automations.find((a) => a.id === "worktree-janitor")).toMatchObject({ kind: "launchd", name: "worktree-janitor", skill: "sweeper", dispatchCommand: "/sweeper" });
    expect(body.automations.find((a) => a.id === "brain-digest")).toMatchObject({ kind: "skill", dispatchCommand: "/brain-digest", scheduledBy: "scheduled-task" });
    const recap = body.automations.find((a) => a.id === "daily-recap");
    expect(recap).toMatchObject({ kind: "launchd", runnable: true, skill: "daily-recap", dispatchCommand: "/daily-recap", schedule: "daily 08:00", lastExitStatus: 0, loaded: true });
    expect(recap?.plistPath).toBe(join(home, "Library", "LaunchAgents", "com.stephane.daily-recap.plist"));
    expect(body.automations.find((a) => a.id === "worktree-janitor")?.loaded).toBe(false); // not in `launchctl list`: paused
    const yb = body.automations.find((a) => a.id === "yalla-brief");
    expect(yb).toMatchObject({ runnable: false, launchdLabel: "dev.dashable.yalla-brief", dispatchCommand: "/yalla-brief" });
    expect(yb?.latestOutput?.path).toBe(join(home, "Documents", "Code", "yalla-brief", "out", "yalla-brief-2026-09-25.html"));
    expect(body.automations.find((a) => a.id === "bridge")).toMatchObject({ runnable: false, running: true });
    expect(body.automations.find((a) => a.id === "ig-innovation")).toMatchObject({ kind: "skill", runnable: false, schedule: null, scheduledBy: "self-described" });
  });

  it("run requires { confirm: true } and kickstarts only com.stephane.* jobs", async () => {
    const { base, kicked } = await setup();
    expect((await run(base, "daily-recap", {})).status).toBe(400);
    expect((await run(base, "daily-recap", { confirm: "yes" })).status).toBe(400);
    expect(kicked).toEqual([]);
    expect(await run(base, "daily-recap", { confirm: true })).toEqual({ status: 200, body: { ok: true, id: "daily-recap", mode: "kickstart", label: "com.stephane.daily-recap" } });
    expect(kicked).toEqual(["com.stephane.daily-recap"]);
  });

  it("returns a dispatch command for skill-only and dashable jobs; refuses services and unknown ids", async () => {
    const { base, kicked } = await setup();
    expect((await run(base, "yalla-brief", { confirm: true })).body).toEqual({ ok: true, id: "yalla-brief", mode: "dispatch", command: "/yalla-brief" });
    expect((await run(base, "ig-innovation", { confirm: true })).body).toEqual({ ok: true, id: "ig-innovation", mode: "dispatch", command: "/ig-innovation" });
    expect((await run(base, "plg-ritual", { confirm: true })).status).toBe(404);
    expect((await run(base, "bridge", { confirm: true })).status).toBe(409);
    expect((await run(base, "tunnel", { confirm: true })).status).toBe(404);
    expect((await run(base, "..%2Fx", { confirm: true })).status).toBe(400);
    expect(kicked).toEqual([]);
  });
});
