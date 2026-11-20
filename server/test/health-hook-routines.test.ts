// Health-to-100 (A and D): the approvals-hook check accepts the hook from ANY worktree of this
// repository (the live ~/.alef-live vs the dev checkout) and nothing else; the routines check calls
// a com.stephane.* plist that launchd doesn't have loaded "paused", with its resume command, never
// failing. Fixtures only: temp git repos, a temp settings.json, a fixture LaunchAgents folder and a
// canned `launchctl list`. Nothing here reads the real ~/.claude or runs launchctl.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evalRoutines } from "../features/completeness-checks.js";
import { hookScriptPaths, isSameRepoHookScript, resetGitIdentityCacheForTests, shellWords } from "../features/completeness-hook.js";
import { computeCheapChecks, readApprovalsHookInstalled, REAL_GATHERERS } from "../features/completeness.js";
import type { FeatureContext } from "../features/registry.js";
import { buildRoutines, type RoutineSources } from "../features/routines.js";
import { makeTempDb } from "./helpers.js";

const execFileAsync = promisify(execFile);
const HOOK = "hooks/permission-request.mjs";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args]);
}

async function repoWithHook(dir: string): Promise<void> {
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, HOOK), "// hook\n", "utf8");
  await git(dir, "init", "-q");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
}

function settingsWith(command: string): unknown {
  return { hooks: { PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command, timeout: 70 }] }] } };
}

describe("hookScriptPaths / shellWords", () => {
  it("splits a hook command like a shell and keeps only absolute hooks/permission-request.mjs paths", () => {
    expect(shellWords("/opt/homebrew/bin/node /Users/me/.alef-live/hooks/permission-request.mjs")).toEqual(["/opt/homebrew/bin/node", "/Users/me/.alef-live/hooks/permission-request.mjs"]);
    expect(hookScriptPaths("node '/Users/me/My Code/aw/hooks/permission-request.mjs'")).toEqual(["/Users/me/My Code/aw/hooks/permission-request.mjs"]); // install script's q()
    expect(hookScriptPaths('node "/a b/hooks/permission-request.mjs" --x')).toEqual(["/a b/hooks/permission-request.mjs"]);
    expect(hookScriptPaths("node /a\\ b/hooks/permission-request.mjs")).toEqual(["/a b/hooks/permission-request.mjs"]);
    expect(hookScriptPaths("node hooks/permission-request.mjs")).toEqual([]); // relative: never counts
    expect(hookScriptPaths("node /x/hooks/other.mjs")).toEqual([]);
    expect(shellWords("")).toEqual([]);
  });
});

describe("readApprovalsHookInstalled: any worktree of the same repository (temp repo + worktree)", () => {
  let root = "";
  let main = "";
  let wt = "";
  let other = "";
  let copy = "";
  let claudeDir = "";

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "aw-hook-wt-")));
    main = join(root, "agent-world");
    wt = join(root, "alef-live");
    other = join(root, "other-clone");
    copy = join(root, "plain-copy");
    await repoWithHook(main);
    await git(main, "worktree", "add", "-q", "--detach", wt);
    await repoWithHook(other); // a different repository with the same file
    await mkdir(join(copy, "hooks"), { recursive: true });
    await writeFile(join(copy, HOOK), "// hook\n", "utf8"); // not a git checkout at all
    // A nested folder inside the worktree that also has hooks/permission-request.mjs: not the top level.
    await mkdir(join(wt, "sub", "hooks"), { recursive: true });
    await writeFile(join(wt, "sub", HOOK), "// hook\n", "utf8");
    claudeDir = join(root, "claude");
    await mkdir(claudeDir, { recursive: true });
  }, 30_000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetGitIdentityCacheForTests();
  });

  async function installed(command: string, repoRoot: string): Promise<boolean> {
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settingsWith(command)), "utf8");
    return readApprovalsHookInstalled(claudeDir, join(repoRoot, HOOK));
  }

  it("the hook from the OTHER worktree counts, both ways (live worktree vs dev checkout)", async () => {
    expect(await installed(`/opt/homebrew/bin/node ${join(wt, HOOK)}`, main)).toBe(true);
    expect(await installed(`/opt/homebrew/bin/node ${join(main, HOOK)}`, wt)).toBe(true);
  });

  it("this checkout's own hook still counts (the old exact-path rule)", async () => {
    expect(await installed(`node ${join(main, HOOK)}`, main)).toBe(true);
  });

  it("another repository's hook, a plain copy, a nested hooks folder and a missing file do NOT count", async () => {
    expect(await installed(`node ${join(other, HOOK)}`, main)).toBe(false);
    expect(await installed(`node ${join(copy, HOOK)}`, main)).toBe(false);
    expect(await installed(`node ${join(wt, "sub", HOOK)}`, main)).toBe(false);
    expect(await installed(`node ${join(root, "gone", HOOK)}`, main)).toBe(false);
  });

  it("a worktree whose hook file was deleted stops counting, even with its git answer cached", async () => {
    const wt2 = join(root, "wt2");
    await git(main, "worktree", "add", "-q", "--detach", wt2);
    expect(await installed(`node ${join(wt2, HOOK)}`, main)).toBe(true);
    await rm(join(wt2, HOOK));
    expect(await isSameRepoHookScript(join(wt2, HOOK), main)).toBe(false);
    expect(await installed(`node ${join(wt2, HOOK)}`, main)).toBe(false);
  });

  it("a hook under another event, or none at all, still reads as not installed", async () => {
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node ${join(wt, HOOK)}` }] }] } }), "utf8");
    expect(await readApprovalsHookInstalled(claudeDir, join(main, HOOK))).toBe(false);
  });
});

// ── D. routines: paused = plist kept, not loaded ─────────────────────────────────────────────

describe("evalRoutines: paused routines", () => {
  it("names a paused routine and its one-line resume command, and still passes", () => {
    const out = evalRoutines({ anyFailing: false, total: 16, paused: [{ label: "com.stephane.eulex-bench", shortName: "eulex-bench" }] });
    expect(out.state).toBe("pass");
    expect(out.detail).toBe(
      "16 routines (1 paused), none failing. Paused (plist kept, not loaded): eulex-bench. Resume: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stephane.eulex-bench.plist",
    );
  });

  it("several paused: all named, one resume example; a real failure still warns", () => {
    const paused = [
      { label: "com.stephane.a", shortName: "a" },
      { label: "com.stephane.b", shortName: "b" },
    ];
    expect(evalRoutines({ anyFailing: false, total: 3, paused }).detail).toContain("Paused (plist kept, not loaded): a, b. Resume one: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stephane.a.plist");
    const failing = evalRoutines({ anyFailing: true, total: 3, paused });
    expect(failing.state).toBe("warn");
    expect(failing.detail).toContain("Paused (plist kept, not loaded): a, b.");
  });

  it("no paused list keeps the old wording", () => {
    expect(evalRoutines({ anyFailing: false, total: 3 }).detail).toBe("3 routines, none failing.");
  });
});

const PLIST = (label: string, hour: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>/Users/x/run.sh</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>`;

describe("buildRoutines from a fixture LaunchAgents folder and a canned launchctl list", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-routines-paused-"));
    await mkdir(join(dir, "LaunchAgents"), { recursive: true });
    await writeFile(join(dir, "LaunchAgents", "com.stephane.eulex-bench.plist"), PLIST("com.stephane.eulex-bench", 3), "utf8");
    await writeFile(join(dir, "LaunchAgents", "com.stephane.yalla-brief.plist"), PLIST("com.stephane.yalla-brief", 8), "utf8");
    await writeFile(join(dir, "LaunchAgents", "com.other.thing.plist"), PLIST("com.other.thing", 1), "utf8");
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function sources(list: string | null): RoutineSources {
    return { launchAgentsDir: join(dir, "LaunchAgents"), scheduledTasksDir: join(dir, "no-tasks"), launchctlList: async () => list };
  }

  it("a plist launchd doesn't list is loaded:false (paused); a listed one is loaded:true", async () => {
    // eulex-bench was booted out (plist kept): only yalla-brief is in `launchctl list`.
    const list = "PID\tStatus\tLabel\n-\t0\tcom.stephane.yalla-brief\n123\t0\tcom.apple.something\n";
    const routines = await buildRoutines(new Date("2026-09-29T07:00:00Z"), sources(list));
    expect(routines.map((r) => [r.shortName, r.loaded, r.lastExitStatus])).toEqual([
      ["eulex-bench", false, null],
      ["yalla-brief", true, 0],
    ]);
  });

  it("launchctl list unreadable: nothing is called paused (loaded absent)", async () => {
    const routines = await buildRoutines(new Date("2026-09-29T07:00:00Z"), sources(null));
    expect(routines.every((r) => r.loaded === undefined)).toBe(true);
  });

  it("Health's routines check on that fixture: pass, naming eulex-bench and its resume command", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "aw-routines-check-"));
    try {
      const db = await makeTempDb(tmp);
      const ctx = {
        db,
        config: { projectsDir: join(tmp, "projects"), claudeDir: join(tmp, "no-claude"), dbPath: join(tmp, "world.db"), claudeJsonPath: join(tmp, "no-claude.json") },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        detectLive: () => new Map<string, number>(),
        worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
      } as unknown as FeatureContext;
      const list = "PID\tStatus\tLabel\n-\t0\tcom.stephane.yalla-brief\n";
      const gatherers = {
        ...REAL_GATHERERS,
        findTmux: async () => null,
        portCwds: async () => new Map<number, string>(),
        denySources: { home: tmp, cloudflaredConfig: join(tmp, "no-cf.yml"), servicesYml: join(tmp, "no-services.yml"), vault: join(tmp, "no-vault") },
        buildRoutines: (now: Date) => buildRoutines(now, sources(list)),
        codeDir: join(tmp, "no-code-dir"),
        whatsupPath: join(tmp, "no-whatsup.json"),
        nodePtySpawnHelperPath: join(tmp, "no-spawn-helper"),
        homeDir: tmp,
        residentHome: join(tmp, "no-resident"),
      };
      const checks = await computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, Date.now(), gatherers, async () => false);
      const check = checks.find((c) => c.id === "routines");
      expect(check?.state).toBe("pass");
      expect(check?.detail).toContain("2 routines (1 paused), none failing. Paused (plist kept, not loaded): eulex-bench.");
      expect(check?.detail).toContain("launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stephane.eulex-bench.plist");
      expect(check?.fixLabel).toBeUndefined(); // pass: no "Open Routines" nag
      db.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
