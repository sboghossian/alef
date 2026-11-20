import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstalledSkill } from "../../shared/features/skills.js";
import {
  AUTOPILOT_LOG_TAIL_CAP_BYTES,
  buildInstituteSnapshot,
  DARWIN_MAX_FILES,
  DARWIN_SUGGESTION_CAP,
  formatStudyStatusLine,
  parseAutopilotLog,
  readAutopilotEnabled,
  readLogTail,
  gitRunnerFor,
  namesSkill,
  parseFileVersions,
  parseNameOnlyLog,
  reflectionSections,
  revisionRows,
  scanDarwinHistories,
  scanFailureFixPairs,
  scanFailureModes,
  scanResidentSkills,
  scanSkillRevisions,
  skillOfPath,
  splitFailureModes,
} from "../features/institute-lib.js";
import { countKnownFailureModeEntries } from "../features/memory-layers-lib.js";

async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function skill(overrides: Partial<InstalledSkill> & Pick<InstalledSkill, "slug" | "path">): InstalledSkill {
  return { name: overrides.slug, description: "", origin: "user", pluginId: null, updatedAt: null, ...overrides };
}

// ---------------------------------------------------------------- readLogTail

describe("readLogTail", () => {
  it("null when the file doesn't exist — never ran, not an empty log", async () => {
    expect(await readLogTail("/definitely/not/here/autopilot.log")).toBeNull();
  });

  it("an existing empty file is a real, non-partial empty read", async () => {
    const dir = await tmp("aw-inst-log-empty-");
    const path = join(dir, "autopilot.log");
    await writeFile(path, "");
    expect(await readLogTail(path)).toEqual({ text: "", partial: false });
  });

  it("a file at or under the cap is read whole, not flagged partial", async () => {
    const dir = await tmp("aw-inst-log-small-");
    const path = join(dir, "autopilot.log");
    await writeFile(path, "2026-09-27 08:42:26 fork launched (survivors=12)\n");
    const tail = await readLogTail(path, 1024);
    expect(tail).toEqual({ text: "2026-09-27 08:42:26 fork launched (survivors=12)\n", partial: false });
  });

  it("a file bigger than the cap is truncated to its last `capBytes`, flagged partial", async () => {
    const dir = await tmp("aw-inst-log-trunc-");
    const path = join(dir, "autopilot.log");
    await writeFile(path, "AAAAAAAAAA" + "BBBBBBBBBB"); // 20 bytes
    const tail = await readLogTail(path, 10);
    expect(tail).toEqual({ text: "BBBBBBBBBB", partial: true });
  });

  it("a real-sized (~5MB) log is capped to the default 512KB tail and still parses cleanly", async () => {
    const dir = await tmp("aw-inst-log-5mb-");
    const path = join(dir, "autopilot.log");
    const oldLine = "2026-01-01 00:00:00 skip: turns=0 < threshold=8\n"; // never reached once truncated
    const filler = oldLine.repeat(Math.ceil((5 * 1024 * 1024) / oldLine.length));
    const tailLines = "2026-09-27 08:42:26 fork launched (survivors=12)\n2026-09-27 08:42:59 fork: claude exited rc=1\nfork: no draft / unparseable output\n";
    await writeFile(path, filler + tailLines);

    const tail = await readLogTail(path);
    expect(tail?.partial).toBe(true);
    expect(tail?.text.length).toBe(AUTOPILOT_LOG_TAIL_CAP_BYTES);
    expect(tail?.text.endsWith(tailLines)).toBe(true);

    const stats = parseAutopilotLog(tail?.text ?? "");
    expect(stats.forksFailed).toBeGreaterThanOrEqual(1);
    expect(stats.lastFailureLine).toBe("fork: no draft / unparseable output");
  });
});

// ---------------------------------------------------------------- parseAutopilotLog

describe("parseAutopilotLog", () => {
  it("real line shapes: launched / rc=1 failure / no-draft / threshold skip / permission skip / a bare Killed line", () => {
    const log = [
      "2026-09-27 08:42:26 fork launched (survivors=12)",
      "2026-09-27 08:42:59 fork: claude exited rc=1",
      "fork: no draft / unparseable output",
      "2026-09-27 19:36:06 skip: turns=0 < threshold=8",
      "SKIPPED permission-denied-cannot-write-to-proposed-dir",
      "     78173 Killed: 9                  | \"$CLAUDE_BIN\" -p --model sonnet",
    ].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats).toEqual({
      forksLaunched: 1,
      forksFailed: 1,
      forksOk: 0,
      noDraft: 1,
      permissionSkips: 1,
      thresholdSkips: 1,
      lastRunAt: new Date("2026-09-27T08:42:26").toISOString(),
      lastSuccessAt: null,
      lastDraftAt: null,
      lastExitRc: 1,
      lastFailureLine: "fork: no draft / unparseable output",
    });
  });

  it("a successful run (rc=0) sets lastSuccessAt and forksOk, independent of failures around it", () => {
    const log = ["2026-06-08 08:58:00 fork launched (survivors=12)", "2026-06-08 08:59:05 fork: claude exited rc=0", "2026-06-08 08:59:05 fork: SKIPPED nothing clears the bar"].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.forksOk).toBe(1);
    expect(stats.forksFailed).toBe(0);
    expect(stats.lastSuccessAt).toBe(new Date("2026-06-08T08:59:05").toISOString());
    expect(stats.lastExitRc).toBe(0);
    // A clean exit is not a draft: this run was SKIPPED, so lastDraftAt must stay null even
    // though lastSuccessAt is set. (The confirmed bug conflated the two.)
    expect(stats.lastDraftAt).toBeNull();
  });

  it("real bug reproduction: 'fork: AUTHORED' sets lastDraftAt, and a LATER clean SKIPPED run does not clear or replace it", () => {
    // Shaped exactly like the real ~/.claude/upskill-state/autopilot.log: the last actual draft
    // was authored on 2026-05-24, but the last CLEAN EXIT (rc=0, SKIPPED) was 2026-06-08 — 15
    // days later, with nothing drafted in between.
    const log = [
      "2026-05-24 17:26:40 fork launched (survivors=45)",
      "2026-05-24 17:28:01 fork: claude exited rc=0",
      "2026-05-24 17:28:01 fork: AUTHORED transcribe-instagram-video",
      "2026-06-08 08:58:00 fork launched (survivors=12)",
      "2026-06-08 08:59:05 fork: claude exited rc=0",
      "2026-06-08 08:59:05 fork: SKIPPED all candidates are system artifacts",
    ].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.lastDraftAt).toBe(new Date("2026-05-24T17:28:01").toISOString());
    expect(stats.lastSuccessAt).toBe(new Date("2026-06-08T08:59:05").toISOString());
    expect(stats.lastExitRc).toBe(0);
  });

  it("'fork: AUTHORED' with a wrapper-written suffix still sets lastDraftAt (real line shape)", () => {
    const log = ["2026-05-24 17:53:50 fork: AUTHORED transcribe-instagram-video (wrapper-written, 84 lines)"].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.lastDraftAt).toBe(new Date("2026-05-24T17:53:50").toISOString());
  });

  it("a non-permission SKIPPED reason is not counted as a permission skip", () => {
    const stats = parseAutopilotLog("SKIPPED all candidates are system artifacts or duplicates of existing skills");
    expect(stats.permissionSkips).toBe(0);
  });

  it("a killed/rc!=1 exit (e.g. rc=137, rc=126) still counts as a failure, not just literal rc=1", () => {
    const log = ["2026-07-01 13:50:57 fork: claude exited rc=137", "2026-07-01 13:50:57 fork: no draft / unparseable output"].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.forksFailed).toBe(1);
    expect(stats.forksOk).toBe(0);
    expect(stats.lastExitRc).toBe(137);
  });

  it("keeps the LAST lastRunAt/lastSuccessAt when several appear, in file order", () => {
    const log = [
      "2026-05-24 17:14:35 fork launched (survivors=45)",
      "2026-05-24 17:20:34 fork: claude exited rc=0",
      "2026-06-08 08:58:00 fork launched (survivors=12)",
      "2026-06-08 08:59:05 fork: claude exited rc=0",
    ].join("\n");
    const stats = parseAutopilotLog(log);
    expect(stats.lastRunAt).toBe(new Date("2026-06-08T08:58:00").toISOString());
    expect(stats.lastSuccessAt).toBe(new Date("2026-06-08T08:59:05").toISOString());
    expect(stats.lastExitRc).toBe(0);
  });

  it("empty text: a real all-zero, all-null result, not a thrown error", () => {
    expect(parseAutopilotLog("")).toEqual({
      forksLaunched: 0,
      forksFailed: 0,
      forksOk: 0,
      noDraft: 0,
      permissionSkips: 0,
      thresholdSkips: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      lastDraftAt: null,
      lastExitRc: null,
      lastFailureLine: null,
    });
  });

  it("reproduces the measured shape: many failures, one earlier success, the rest quiet skips", () => {
    const lines: string[] = ["2026-05-24 17:20:34 fork launched (survivors=45)", "2026-05-24 17:20:34 fork: claude exited rc=0"];
    for (let i = 0; i < 5; i++) {
      lines.push(`2026-09-2${i} 08:42:26 fork launched (survivors=12)`, `2026-09-2${i} 08:42:59 fork: claude exited rc=1`, "fork: no draft / unparseable output");
    }
    for (let i = 0; i < 3; i++) lines.push(`2026-09-2${i} 09:00:00 skip: turns=1 < threshold=8`);
    const stats = parseAutopilotLog(lines.join("\n"));
    expect(stats.forksLaunched).toBe(6);
    expect(stats.forksOk).toBe(1);
    expect(stats.forksFailed).toBe(5);
    expect(stats.noDraft).toBe(5);
    expect(stats.thresholdSkips).toBe(3);
  });
});

// ---------------------------------------------------------------- readAutopilotEnabled

describe("readAutopilotEnabled", () => {
  it("reads the enabled flag when present", async () => {
    const dir = await tmp("aw-inst-cfg-");
    const path = join(dir, "autopilot.json");
    await writeFile(path, JSON.stringify({ enabled: true, turn_threshold: 8 }));
    expect(await readAutopilotEnabled(path)).toBe(true);
    await writeFile(path, JSON.stringify({ enabled: false }));
    expect(await readAutopilotEnabled(path)).toBe(false);
  });

  it("null when the file is missing, malformed JSON, or has no boolean enabled field", async () => {
    expect(await readAutopilotEnabled("/definitely/not/here/autopilot.json")).toBeNull();
    const dir = await tmp("aw-inst-cfg-bad-");
    const badJson = join(dir, "a.json");
    await writeFile(badJson, "{not valid json");
    expect(await readAutopilotEnabled(badJson)).toBeNull();
    const noField = join(dir, "b.json");
    await writeFile(noField, JSON.stringify({ turn_threshold: 8 }));
    expect(await readAutopilotEnabled(noField)).toBeNull();
  });
});

// ---------------------------------------------------------------- formatStudyStatusLine

describe("formatStudyStatusLine", () => {
  it("null stats: never ran / can't see it, not a 0-run claim", () => {
    expect(formatStudyStatusLine(null)).toMatch(/never run/);
  });

  it("matches the measured real-log shape: last DRAFT date, aside for the (later) last clean exit, N of M runs failed", () => {
    // Real ~/.claude/upskill-state/autopilot.log shape: the last draft was 2026-05-24, but the
    // last clean exit was 2026-06-08 (a SKIPPED run, no draft). The confirmed bug used
    // lastSuccessAt here, so it read "No new draft since 2026-06-08" — 15 days later than the
    // pipeline actually last worked.
    const stats = {
      forksLaunched: 159,
      forksFailed: 148,
      forksOk: 10,
      noDraft: 148,
      permissionSkips: 4,
      thresholdSkips: 1803,
      lastRunAt: "2026-09-27T08:42:26.000Z",
      lastSuccessAt: "2026-06-08T08:59:05.000Z",
      lastDraftAt: "2026-05-24T17:28:01.000Z",
      lastExitRc: 0,
      lastFailureLine: "x",
    };
    expect(formatStudyStatusLine(stats)).toBe("No new draft since 2026-05-24 (last clean exit 2026-06-08): 148 of 159 study runs failed (autopilot.log)");
  });

  it("draft date same as the last clean exit date: no redundant aside", () => {
    const stats = {
      forksLaunched: 3,
      forksFailed: 0,
      forksOk: 3,
      noDraft: 0,
      permissionSkips: 0,
      thresholdSkips: 0,
      lastRunAt: "2026-09-28T00:00:00.000Z",
      lastSuccessAt: "2026-09-28T00:10:00.000Z",
      lastDraftAt: "2026-09-28T00:10:00.000Z",
      lastExitRc: 0,
      lastFailureLine: null,
    };
    expect(formatStudyStatusLine(stats)).toBe("No new draft since 2026-09-28: 0 of 3 study runs failed (autopilot.log)");
  });

  it("a clean exit happened but nothing has EVER been authored", () => {
    const stats = {
      forksLaunched: 5,
      forksFailed: 0,
      forksOk: 5,
      noDraft: 5,
      permissionSkips: 0,
      thresholdSkips: 0,
      lastRunAt: "2026-09-28T00:00:00.000Z",
      lastSuccessAt: "2026-09-28T00:10:00.000Z",
      lastDraftAt: null,
      lastExitRc: 0,
      lastFailureLine: null,
    };
    expect(formatStudyStatusLine(stats)).toBe("No draft ever produced (last clean exit 2026-09-28): 0 of 5 study runs failed (autopilot.log)");
  });

  it("no launches at all", () => {
    const stats = { forksLaunched: 0, forksFailed: 0, forksOk: 0, noDraft: 0, permissionSkips: 0, thresholdSkips: 0, lastRunAt: null, lastSuccessAt: null, lastDraftAt: null, lastExitRc: null, lastFailureLine: null };
    expect(formatStudyStatusLine(stats)).toBe("No study runs recorded yet (autopilot.log)");
  });

  it("launches exist but none has ever succeeded", () => {
    const stats = { forksLaunched: 4, forksFailed: 4, forksOk: 0, noDraft: 4, permissionSkips: 0, thresholdSkips: 0, lastRunAt: "2026-09-27T00:00:00.000Z", lastSuccessAt: null, lastDraftAt: null, lastExitRc: 1, lastFailureLine: "x" };
    expect(formatStudyStatusLine(stats)).toBe("4 of 4 study runs failed — none has ever succeeded (autopilot.log)");
  });
});

// ---------------------------------------------------------------- scanDarwinHistories

describe("scanDarwinHistories", () => {
  it("reads rounds/lastDate/lastSuggestion for a real (symlinked-in-bounds) skill, picking the *_suggestion-named field", async () => {
    const claudeDir = await tmp("aw-inst-darwin-home-");
    const skillsDir = join(claudeDir, "skills");
    const repoDir = join(claudeDir, "skills-repo", "yalla");
    await mkdir(skillsDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await symlink(repoDir, join(skillsDir, "yalla"));
    await writeFile(
      join(repoDir, ".darwin-history.jsonl"),
      [
        JSON.stringify({ date: "2026-05-19", run: "a", observations: ["obs"], yalla_delta_suggestion: "older suggestion" }),
        JSON.stringify({ date: "2026-06-01", run: "b", observations: ["obs2"], yalla_delta_suggestion: "newer suggestion wins" }),
      ].join("\n"),
    );

    const rows = await scanDarwinHistories(skillsDir, claudeDir);
    expect(rows).toEqual([{ slug: "yalla", rounds: 2, lastDate: "2026-06-01", lastSuggestion: "newer suggestion wins" }]);
  });

  it("skips a malformed line but keeps reading the rest of the file", async () => {
    const claudeDir = await tmp("aw-inst-darwin-malformed-");
    await mkdir(join(claudeDir, "skills", "messy-skill"), { recursive: true });
    await writeFile(
      join(claudeDir, "skills", "messy-skill", ".darwin-history.jsonl"),
      ["not json at all {", JSON.stringify({ date: "2026-01-01", suggestion: "fine" }), "", "  "].join("\n"),
    );
    const rows = await scanDarwinHistories(join(claudeDir, "skills"), claudeDir);
    expect(rows).toEqual([{ slug: "messy-skill", rounds: 1, lastDate: "2026-01-01", lastSuggestion: "fine" }]);
  });

  it("refuses a skill directory whose symlink escapes claudeDir", async () => {
    const claudeDir = await tmp("aw-inst-darwin-claude-");
    const outside = await tmp("aw-inst-darwin-outside-");
    const skillsDir = join(claudeDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await mkdir(join(outside, "escaping-skill"), { recursive: true });
    await writeFile(join(outside, "escaping-skill", ".darwin-history.jsonl"), JSON.stringify({ date: "2026-01-01", suggestion: "should never be read" }));
    await symlink(join(outside, "escaping-skill"), join(skillsDir, "escaping-skill"));

    expect(await scanDarwinHistories(skillsDir, claudeDir)).toEqual([]);
  });

  it("a skill with no history file is silently absent, not a zero-round row", async () => {
    const claudeDir = await tmp("aw-inst-darwin-nohist-");
    const skillsDir = join(claudeDir, "skills", "grill-me");
    await mkdir(skillsDir, { recursive: true });
    expect(await scanDarwinHistories(join(claudeDir, "skills"), claudeDir)).toEqual([]);
  });

  it("truncates an overlong suggestion to DARWIN_SUGGESTION_CAP characters", async () => {
    const claudeDir = await tmp("aw-inst-darwin-long-");
    const skillsDir = join(claudeDir, "skills", "chatty-skill");
    await mkdir(skillsDir, { recursive: true });
    const long = "x".repeat(500);
    await writeFile(join(skillsDir, ".darwin-history.jsonl"), JSON.stringify({ date: "2026-01-01", suggestion: long }));
    const rows = await scanDarwinHistories(join(claudeDir, "skills"), claudeDir);
    expect(rows[0]?.lastSuggestion).toHaveLength(DARWIN_SUGGESTION_CAP);
    expect(rows[0]?.lastSuggestion).toBe(long.slice(0, DARWIN_SUGGESTION_CAP));
  });

  it("no skills directory at all: empty, not an error", async () => {
    expect(await scanDarwinHistories("/definitely/not/here/skills", "/definitely/not/here")).toEqual([]);
  });

  it("reads at most DARWIN_MAX_FILES skills, sorted by slug so the cutoff is deterministic", async () => {
    const claudeDir = await tmp("aw-inst-darwin-cap-");
    const skillsDir = join(claudeDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    const total = DARWIN_MAX_FILES + 5;
    await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const name = `skill-${String(i).padStart(3, "0")}`;
        const dir = join(skillsDir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".darwin-history.jsonl"), JSON.stringify({ date: "2026-01-01", suggestion: "s" }));
      }),
    );
    const rows = await scanDarwinHistories(skillsDir, claudeDir);
    expect(rows).toHaveLength(DARWIN_MAX_FILES);
    const slugs = new Set(rows.map((r) => r.slug));
    expect(slugs.has("skill-199")).toBe(true); // 0-indexed: the 200th sorted entry
    expect(slugs.has("skill-200")).toBe(false); // past the cap
  });
});

// ---------------------------------------------------------------- scanFailureModes

describe("scanFailureModes", () => {
  it("lists only skills with a non-empty auto-logged section, and its aggregate matches scanSkillPatches", async () => {
    const dir = await tmp("aw-inst-failmodes-");
    const patchedPath = join(dir, "patched", "SKILL.md");
    const cleanPath = join(dir, "clean", "SKILL.md");
    await mkdir(join(dir, "patched"), { recursive: true });
    await mkdir(join(dir, "clean"), { recursive: true });
    await writeFile(patchedPath, "# skill\n## Known failure modes (auto-logged)\n- one\n- two\n");
    await writeFile(cleanPath, "# skill\nno failures logged\n");

    const installed: InstalledSkill[] = [skill({ slug: "patched", name: "Patched", path: patchedPath }), skill({ slug: "clean", name: "Clean", path: cleanPath })];
    const result = await scanFailureModes(installed);
    expect(result.skills).toEqual([{ slug: "patched", name: "Patched", entryCount: 2 }]);
    expect(result.patchedSkillCount).toBe(1);
    expect(result.patchEntryCount).toBe(2);
  });

  it("empty installed list: empty, not an error", async () => {
    expect(await scanFailureModes([])).toEqual({ skills: [], patchedSkillCount: 0, patchEntryCount: 0 });
  });

  it("an unreadable SKILL.md path is skipped, not thrown", async () => {
    const installed: InstalledSkill[] = [skill({ slug: "ghost", name: "Ghost", path: "/definitely/not/here/SKILL.md" })];
    expect(await scanFailureModes(installed)).toEqual({ skills: [], patchedSkillCount: 0, patchEntryCount: 0 });
  });
});

// ---------------------------------------------------------------- buildInstituteSnapshot

describe("buildInstituteSnapshot", () => {
  it("assembles all four scans into one snapshot", async () => {
    const claudeDir = await tmp("aw-inst-build-");
    const skillsDir = join(claudeDir, "skills");
    const upskillDir = join(claudeDir, "upskill-state");
    await mkdir(skillsDir, { recursive: true });
    await mkdir(upskillDir, { recursive: true });
    await writeFile(join(upskillDir, "autopilot.log"), "2026-06-08 08:59:05 fork: claude exited rc=0\n2026-06-08 08:58:00 fork launched (survivors=12)\n");
    await writeFile(join(upskillDir, "autopilot.json"), JSON.stringify({ enabled: true }));
    const skillPath = join(skillsDir, "grill-me", "SKILL.md");
    await mkdir(join(skillsDir, "grill-me"), { recursive: true });
    await writeFile(skillPath, "# grill-me\n## Known failure modes (auto-logged)\n- got it wrong once\n");

    const snapshot = await buildInstituteSnapshot({
      autopilotLogPath: join(upskillDir, "autopilot.log"),
      autopilotJsonPath: join(upskillDir, "autopilot.json"),
      skillsDir,
      claudeDir,
      installed: [skill({ slug: "grill-me", name: "grill-me", path: skillPath })],
      skillsRepoDir: join(claudeDir, "skills-repo"),
      residentHome: join(claudeDir, "no-resident"),
      nowMs: Date.parse("2026-09-28T12:00:00Z"),
    });

    expect(snapshot.study.enabled).toBe(true);
    expect(snapshot.study.stats?.forksOk).toBe(1);
    expect(snapshot.study.logPartial).toBe(false);
    expect(snapshot.darwin).toEqual([]); // no .darwin-history.jsonl written in this fixture
    expect(snapshot.failureModes.skills).toEqual([{ slug: "grill-me", name: "grill-me", entryCount: 1 }]);
    // No skills-repo and no resident home in this fixture: said so, never a silent 0.
    expect(snapshot.improvement.revisions).toMatchObject({ ok: false, commits: 0, days: 30 });
    expect(snapshot.improvement.revisions.error).toBeTruthy();
    expect(snapshot.improvement.pairs).toMatchObject({ ok: false, error: "skills-repo not found", outsideRepo: 1 });
    expect(snapshot.improvement.resident).toMatchObject({ ok: false, error: "no resident home", written: 0 });
  });

  it("a missing autopilot.log reads as never-ran, not zeroed-out stats", async () => {
    const claudeDir = await tmp("aw-inst-build-missing-");
    const skillsDir = join(claudeDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    const snapshot = await buildInstituteSnapshot({
      autopilotLogPath: join(claudeDir, "upskill-state", "autopilot.log"),
      autopilotJsonPath: join(claudeDir, "upskill-state", "autopilot.json"),
      skillsDir,
      claudeDir,
      installed: [],
      skillsRepoDir: join(claudeDir, "skills-repo"),
      residentHome: join(claudeDir, "no-resident"),
      nowMs: Date.parse("2026-09-28T12:00:00Z"),
    });
    expect(snapshot.study.stats).toBeNull();
    expect(snapshot.study.enabled).toBeNull();
    expect(snapshot.study.line).toMatch(/never run/);
  });
});

// ---------------------------------------------------------------- measured change (improvement-trend)

const T_NOW = Date.parse("2026-09-28T12:00:00Z");

/** git in a temp repo, hooks off, a fixed identity; `at` pins both author and committer time. */
function git(repo: string, args: string[], at?: string): string {
  const env = at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env;
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-C", repo, ...args], { encoding: "utf8", env });
}

async function commitFiles(repo: string, files: Record<string, string | null>, at: string, msg = "edit"): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git(repo, ["rm", "-q", path]);
      continue;
    }
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
    git(repo, ["add", path]);
  }
  git(repo, ["commit", "-q", "-m", msg], at);
}

const daysAgo = (d: number): string => new Date(T_NOW - d * 86_400_000).toISOString();

/** Every path under .git with its size and mtime: the read-only invariant's evidence. */
async function gitDirState(repo: string): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out.push(`${p} ${st.size} ${st.mtimeMs}`);
      }
    }
  }
  await walk(join(repo, ".git"));
  return out.sort().join("\n");
}

const SECTION = "## Known failure modes (auto-logged)";
const md = (body: string, entries: string[] = [], tail = "## Notes\nkeep\n"): string =>
  `---\nname: x\n---\n${body}\n${entries.length ? `\n${SECTION}\n\n${entries.map((e) => `- ${e}`).join("\n")}\n` : ""}\n${tail}`;

describe("parseNameOnlyLog / revisionRows / skillOfPath", () => {
  it("only top-level <slug>/SKILL.md counts; one commit touching two skills is one commit, one revision each", () => {
    const out = `\x1eaaaaaaa\x1f2026-09-20T10:00:00+03:00\n\nalpha/SKILL.md\nbeta/SKILL.md\n\x1ebbbbbbb\x1f2026-09-25T10:00:00Z\n\nalpha/SKILL.md\nnested/deep/SKILL.md\n.claude/SKILL.md\n\x1enot-a-sha\x1f2026-09-25\n\nalpha/SKILL.md\n`;
    const commits = parseNameOnlyLog(out);
    expect(commits.map((c) => c.sha)).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(commits[0]!.at).toBe("2026-09-20T07:00:00.000Z");
    expect(revisionRows(commits)).toEqual({
      commits: 2,
      skills: [
        { slug: "alpha", commits: 2, lastAt: "2026-09-25T10:00:00.000Z" },
        { slug: "beta", commits: 1, lastAt: "2026-09-20T07:00:00.000Z" },
      ],
    });
    expect(skillOfPath("nested/deep/SKILL.md")).toBeNull();
    expect(skillOfPath(".claude/SKILL.md")).toBeNull();
    expect(skillOfPath("alpha/skill.md")).toBeNull();
  });
});

describe("splitFailureModes", () => {
  it("entries are the section's bullets (whitespace collapsed); the body is everything else, same section rules as countKnownFailureModeEntries", () => {
    const text = md("# Skill\nDo the thing.", ["**2026-09-23** — broke   once _(session c7281618)_", "second"]);
    const { entries, body } = splitFailureModes(text);
    expect(entries).toEqual(["**2026-09-23** — broke once _(session c7281618)_", "second"]);
    expect(entries).toHaveLength(countKnownFailureModeEntries(text));
    expect(body).toBe("---\nname: x\n---\n# Skill\nDo the thing.\n\n## Notes\nkeep");
    // Appending an entry changes only the entries, never the body.
    expect(splitFailureModes(md("# Skill\nDo the thing.", ["**2026-09-23** — broke once", "second", "third"])).body).toBe(body);
    expect(splitFailureModes("no section\n")).toEqual({ entries: [], body: "no section" });
  });
});

describe("parseFileVersions", () => {
  it("rebuilds the file after each commit from a whole-file hunk; skips merges and mode-only commits, reads a delete as null", () => {
    const out = [
      "",
      "aaaaaaa\x1f2026-09-01T00:00:00Z\n\ndiff --git a/s/SKILL.md b/s/SKILL.md\nnew file mode 100644\n--- /dev/null\n+++ b/s/SKILL.md\n@@ -0,0 +1,3 @@\n+one\n+\n+three\n\\ No newline at end of file\n",
      "bbbbbbb\x1f2026-09-02T00:00:00Z\n",
      "ccccccc\x1f2026-09-03T00:00:00Z\n\ndiff --git a/s/SKILL.md b/s/SKILL.md\n--- a/s/SKILL.md\n+++ b/s/SKILL.md\n@@ -1,3 +1,3 @@\n one\n \n-three\n+3\n",
      "ddddddd\x1f2026-09-04T00:00:00Z\n\ndiff --git a/s/SKILL.md b/s/SKILL.md\ndeleted file mode 100644\n--- a/s/SKILL.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-\n-3\n",
      "eeeeeee\x1f2026-09-05T00:00:00Z\n\ndiff --git a/s/SKILL.md b/s/SKILL.md\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n",
    ].join("\x1e");
    const { versions, unreadable } = parseFileVersions(out);
    expect(versions).toEqual([
      { sha: "aaaaaaa", at: "2026-09-01T00:00:00.000Z", content: "one\n\nthree" },
      { sha: "ccccccc", at: "2026-09-03T00:00:00.000Z", content: "one\n\n3" },
      { sha: "ddddddd", at: "2026-09-04T00:00:00.000Z", content: null },
    ]);
    expect(unreadable).toBe(1);
  });
});

describe("scanSkillRevisions + scanFailureFixPairs on a real temp git repo", () => {
  it("counts SKILL.md commits per skill in the 30-day window and pairs each logged failure mode with the first later revision, without writing to the repo", async () => {
    const root = await tmp("aw-inst-git-");
    const repo = join(root, "skills-repo");
    await mkdir(repo);
    git(repo, ["init", "-q"]);
    // Revisions: alpha (created 40 days ago: outside the window), edited 10 and 5 days ago; beta
    // created in the 10-day commit; a non-SKILL.md file and a nested SKILL.md never count.
    await commitFiles(repo, { "alpha/SKILL.md": md("alpha v1") }, daysAgo(40));
    await commitFiles(repo, { "alpha/SKILL.md": md("alpha v2"), "beta/SKILL.md": md("beta v1") }, daysAgo(10), "skills: sync");
    await commitFiles(repo, { "alpha/SKILL.md": md("alpha v3") }, daysAgo(5));
    await commitFiles(repo, { "alpha/notes.md": "x" }, daysAgo(3));
    await commitFiles(repo, { "pack/inner/SKILL.md": md("nested") }, daysAgo(2));
    // Pairs. gamma: an entry logged, a second logged by a log-only commit, then a real revision.
    await commitFiles(repo, { "gamma/SKILL.md": md("gamma v1") }, daysAgo(20));
    await commitFiles(repo, { "gamma/SKILL.md": md("gamma v1", ["E1 broke"]) }, daysAgo(9));
    await commitFiles(repo, { "gamma/SKILL.md": md("gamma v1", ["E1 broke", "E2 broke again"]) }, daysAgo(8));
    await commitFiles(repo, { "gamma/SKILL.md": md("gamma v2 fixed", ["E1 broke", "E2 broke again"]) }, daysAgo(7));
    // delta: created with an entry, never revised. epsilon: entry and body change in ONE commit
    // (not a later commit), nothing after. zeta: the fix removed the entry.
    await commitFiles(repo, { "delta/SKILL.md": md("delta v1", ["E3 never fixed"]) }, daysAgo(6));
    await commitFiles(repo, { "epsilon/SKILL.md": md("eps v1") }, daysAgo(6));
    await commitFiles(repo, { "epsilon/SKILL.md": md("eps v2", ["E4 same commit"]) }, daysAgo(4));
    await commitFiles(repo, { "zeta/SKILL.md": md("zeta v1", ["E6 fixed and removed"]) }, daysAgo(4));
    await commitFiles(repo, { "zeta/SKILL.md": md("zeta v2") }, daysAgo(1));
    // On disk, not committed: a new gamma entry.
    await writeFile(join(repo, "gamma", "SKILL.md"), md("gamma v2 fixed", ["E1 broke", "E2 broke again", "E5 not committed"]));
    // An installed skill outside skills-repo with 2 entries: counted, its history never read.
    const outside = join(root, "gstack", "browse", "SKILL.md");
    await mkdir(join(root, "gstack", "browse"), { recursive: true });
    await writeFile(outside, md("browse", ["a", "b"]));

    const before = await gitDirState(repo);
    const runner = gitRunnerFor(repo);
    const revisions = await scanSkillRevisions(runner, T_NOW);
    expect(revisions).toMatchObject({ ok: true, error: null, days: 30, since: daysAgo(30) });
    // 30-day SKILL.md commits: alpha×2 (one shared with beta), gamma×3, delta, epsilon×2, zeta×2 = 11; the nested one isn't a skill.
    expect(revisions.commits).toBe(11);
    expect(revisions.skills.find((r) => r.slug === "alpha")).toEqual({ slug: "alpha", commits: 2, lastAt: daysAgo(5) });
    expect(revisions.skills.find((r) => r.slug === "beta")).toEqual({ slug: "beta", commits: 1, lastAt: daysAgo(10) });
    expect(revisions.skills.map((r) => r.slug)).not.toContain("pack");
    expect(revisions.skillCount).toBe(6);

    const installed = [skill({ slug: "gamma", path: join(repo, "gamma", "SKILL.md") }), skill({ slug: "browse", path: outside })];
    const pairs = await scanFailureFixPairs({
      git: runner,
      realRepoDir: repo,
      installed,
      flagged: [
        { slug: "gamma", name: "gamma", entryCount: 3 },
        { slug: "browse", name: "browse", entryCount: 2 },
      ],
    });
    expect(pairs).toMatchObject({ ok: true, error: null, logged: 5, followed: 3, uncommitted: 1, outsideRepo: 2, truncated: false });
    expect(pairs.historySince).toBe(daysAgo(40));
    const byText = new Map(pairs.entries.map((e) => [e.text, e]));
    expect(byText.get("E1 broke")).toEqual({ slug: "gamma", text: "E1 broke", loggedAt: daysAgo(9), followedAt: daysAgo(7), stillListed: true });
    expect(byText.get("E2 broke again")).toMatchObject({ loggedAt: daysAgo(8), followedAt: daysAgo(7) });
    expect(byText.get("E3 never fixed")).toMatchObject({ slug: "delta", followedAt: null, stillListed: true });
    expect(byText.get("E4 same commit")).toMatchObject({ slug: "epsilon", loggedAt: daysAgo(4), followedAt: null });
    expect(byText.get("E6 fixed and removed")).toMatchObject({ slug: "zeta", followedAt: daysAgo(1), stillListed: false });
    expect(byText.has("E5 not committed")).toBe(false);
    // Newest logged first.
    expect(pairs.entries[0]!.loggedAt >= pairs.entries[pairs.entries.length - 1]!.loggedAt).toBe(true);

    // The invariant: nothing under .git changed (no index refresh, no lock, no ref), and the
    // uncommitted working-tree edit is still there, uncommitted.
    expect(await gitDirState(repo)).toBe(before);
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("M gamma/SKILL.md");
  });

  it("the runner refuses every git subcommand but log, before git runs", async () => {
    const repo = await tmp("aw-inst-git-ro-");
    git(repo, ["init", "-q"]);
    const before = await gitDirState(repo);
    for (const args of [["commit", "--allow-empty", "-m", "x"], ["checkout", "-b", "x"], ["reset", "--hard"], ["status"], []]) {
      await expect(gitRunnerFor(repo)(args)).rejects.toThrow(/^read-only: refused git/);
    }
    expect(await gitDirState(repo)).toBe(before);
  });

  it("a directory that isn't a git repo is an error said once, not a 0 (and never a walk up into another repo)", async () => {
    const outer = await tmp("aw-inst-git-outer-");
    git(outer, ["init", "-q"]);
    await commitFiles(outer, { "a/SKILL.md": md("in the OUTER repo") }, daysAgo(1));
    const notRepo = join(outer, "skills-repo");
    await mkdir(notRepo);
    const revisions = await scanSkillRevisions(gitRunnerFor(notRepo), T_NOW);
    expect(revisions.ok).toBe(false);
    expect(revisions.commits).toBe(0);
    expect(revisions.error).toMatch(/not a git repository/i);
    const pairs = await scanFailureFixPairs({ git: gitRunnerFor(notRepo), realRepoDir: notRepo, installed: [], flagged: [] });
    expect(pairs).toMatchObject({ ok: false, logged: 0 });
  });
});

describe("scanResidentSkills (the resident's own skills, cited later)", () => {
  it("starts from an existing home: a skill counts as cited only when a LATER reflection or proposal names it", async () => {
    const home = await tmp("aw-inst-resident-");
    await mkdir(join(home, "skills"));
    await mkdir(join(home, "journal"));
    const wroteAt = new Date(2026, 8, 27, 9, 30).toISOString(); // local 09:30, as resident-lib writes journal times
    const audit = [
      { at: new Date(2026, 8, 26, 8, 0).toISOString(), path: "journal/2026-09-26.md", bytes: 10, reason: "hourly reflection" },
      { at: wroteAt, path: "skills/prompt-hygiene.md", bytes: 40, reason: "new skill: Prompt hygiene" },
      { at: wroteAt, path: "skills/unused-trick.md", bytes: 40, reason: "new skill: Unused trick" },
      { at: wroteAt, path: "skills/note-taking.md", bytes: 40, reason: "new skill: Note taking" },
      { at: new Date(2026, 8, 27, 11, 0).toISOString(), path: "skills/prompt-hygiene.md", bytes: 50, reason: "new skill: Prompt hygiene" },
    ];
    await writeFile(join(home, "writes.jsonl"), `${audit.map((a) => JSON.stringify(a)).join("\n")}\nnot json\n`);
    await writeFile(join(home, "skills", "prompt-hygiene.md"), "# Prompt hygiene\n\nKeep prompts short.\n");
    await writeFile(join(home, "skills", "unused-trick.md"), "# Unused trick\n\nNever used.\n");
    await writeFile(join(home, "skills", "note-taking.md"), "# Note taking\n\nWrite it down.\n");
    await writeFile(join(home, "skills", "no-audit.md"), "# No audit\n\nWritten before the log.\n");
    await writeFile(
      join(home, "journal", "2026-09-27.md"),
      [
        "# 2026-09-27 · day 2",
        "",
        "## 09:00 · reflection",
        "",
        "Thinking about an unused-trick before writing it.",
        "",
        "## 10:00 · reflection",
        "",
        "Used prompt-hygiene on the district summary. The no-audit note too.",
        "",
        "- 10:40 · Tripwire: a session repeated unused-trick (server line, not the resident's words)",
      ].join("\n"),
    );
    await writeFile(join(home, "proposals.json"), JSON.stringify([{ id: "rp-1-0", at: new Date(2026, 8, 28, 8, 0).toISOString(), kind: "note", title: "Share my Note taking skill", why: "it helped", status: "open" }]));

    const r = await scanResidentSkills(home);
    expect(r).toMatchObject({ ok: true, error: null, written: 4, cited: 2, journalDays: 1, journalSince: "2026-09-27", auditSince: audit[0]!.at });
    const bySlug = new Map(r.skills.map((s) => [s.slug, s]));
    expect(bySlug.get("prompt-hygiene")).toEqual({ slug: "prompt-hygiene", name: "Prompt hygiene", writtenAt: wroteAt, citedAt: new Date(2026, 8, 27, 10, 0).toISOString(), citedIn: "reflection" });
    expect(bySlug.get("unused-trick")).toMatchObject({ citedAt: null, citedIn: null }); // before its write, or a server event line
    expect(bySlug.get("note-taking")).toMatchObject({ citedIn: "proposal", citedAt: new Date(2026, 8, 28, 8, 0).toISOString() });
    expect(bySlug.get("no-audit")).toMatchObject({ writtenAt: null, citedAt: null }); // no write time: "later" can't be known
  });

  it("an empty home is 0 written, ok; a missing one says so", async () => {
    const home = await tmp("aw-inst-resident-empty-");
    expect(await scanResidentSkills(home)).toMatchObject({ ok: true, written: 0, cited: 0, journalDays: 0, journalSince: null, auditSince: null });
    expect(await scanResidentSkills(join(home, "nope"))).toMatchObject({ ok: false, error: "no resident home" });
  });

  it("namesSkill: the slug as a whole word or the full name; short or partial matches don't count", () => {
    expect(namesSkill("I used prompt-hygiene.", "prompt-hygiene", "Prompt hygiene")).toBe(true);
    expect(namesSkill("I used PROMPT HYGIENE", "prompt-hygiene", "Prompt hygiene")).toBe(true);
    expect(namesSkill("prompt-hygiene-v2 is different", "prompt-hygiene", "x")).toBe(false);
    expect(namesSkill("the ci is red", "ci", "CI")).toBe(false);
  });

  it("reflectionSections: local times, only reflection sections, server event lines dropped", () => {
    const s = reflectionSections("2026-09-28", "# 2026-09-28 · day 3\n\n## 00:26 · reflection\n\nhello\n\n- 05:41 · Tripwire: x\n## 01:30 · reflection\n\nworld\n");
    expect(s).toEqual([
      { atMs: new Date(2026, 8, 28, 0, 26).getTime(), text: "\nhello\n" },
      { atMs: new Date(2026, 8, 28, 1, 30).getTime(), text: "\nworld\n" },
    ]);
    expect(reflectionSections("not-a-day", "## 00:26 · reflection\nx")).toEqual([]);
  });
});
