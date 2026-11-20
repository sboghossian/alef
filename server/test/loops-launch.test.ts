import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPS_MAX_PROMPT_CHARS } from "../../shared/features/loops.js";
import { buildLoopsLaunchCommand, validateLaunch, worldPlanLoopsLauncher } from "../features/loops-launch.js";
import type { FeatureContext } from "../features/registry.js";
import { createTalkFeature, type TalkExec } from "../features/talk.js";

describe("validateLaunch", () => {
  let home = "";
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  it("refuses a null cwd (nothing to launch in)", async () => {
    const r = await validateLaunch("/home/x", null, "hello");
    expect(r).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it("refuses empty (or whitespace-only) task text", async () => {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    const proj = join(home, "Documents", "Code", "demo");
    await mkdir(proj, { recursive: true });
    expect((await validateLaunch(home, proj, "")).ok).toBe(false);
    expect((await validateLaunch(home, proj, "   \n  ")).ok).toBe(false);
  });

  it(`refuses task text over ${LOOPS_MAX_PROMPT_CHARS} characters, accepts exactly that many`, async () => {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    const proj = join(home, "Documents", "Code", "demo");
    await mkdir(proj, { recursive: true });
    expect((await validateLaunch(home, proj, "a".repeat(LOOPS_MAX_PROMPT_CHARS + 1))).ok).toBe(false);
    expect((await validateLaunch(home, proj, "a".repeat(LOOPS_MAX_PROMPT_CHARS))).ok).toBe(true);
  });

  it("refuses a cwd outside the home directory, even when it exists", async () => {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    const outside = await mkdtemp(join(tmpdir(), "aw-loops-outside-"));
    try {
      expect(await validateLaunch(home, outside, "hi")).toEqual({ ok: false, status: 403, error: expect.any(String) });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a cwd that does not exist, and one that is a file rather than a directory", async () => {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    expect((await validateLaunch(home, join(home, "nope"), "hi")).ok).toBe(false);
    const file = join(home, "a-file");
    await writeFile(file, "x", "utf8");
    expect((await validateLaunch(home, file, "hi")).ok).toBe(false);
  });

  it("accepts a real directory inside home with in-bounds task text", async () => {
    home = await mkdtemp(join(tmpdir(), "aw-loops-home-"));
    const proj = join(home, "Documents", "Code", "demo");
    await mkdir(proj, { recursive: true });
    const r = await validateLaunch(home, proj, "do the thing");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cwd).toContain("demo");
      expect(r.prompt).toBe("do the thing");
    }
  });
});

describe("buildLoopsLaunchCommand", () => {
  it("is structurally always plan mode and never embeds a prompt directly", () => {
    const cmd = buildLoopsLaunchCommand("/tmp/aw/prompt.txt");
    expect(cmd).toContain("claude --permission-mode plan");
    expect(cmd).not.toContain("dangerously-skip-permissions");
    expect(cmd).not.toContain("acceptEdits");
    expect(cmd).toContain("$(cat '/tmp/aw/prompt.txt')");
  });

  it("shell-quotes a path containing a single quote instead of passing it through raw", () => {
    const cmd = buildLoopsLaunchCommand("/tmp/it's/prompt.txt");
    expect(cmd).toContain(String.raw`cat '/tmp/it'\''s/prompt.txt'`);
  });
});

function fakeTalkExec(): TalkExec & { runs: (readonly string[])[]; terminals: string[] } {
  const runs: (readonly string[])[] = [];
  const terminals: string[] = [];
  return {
    runs,
    terminals,
    findTmux: async () => "/opt/homebrew/bin/tmux",
    async run(_file, args) {
      runs.push(args);
    },
    capture: async () => "",
    captureAll: async () => "",
    startCommand: async () => "",
    paneCounts: async () => "1 1",
    openTerminal: (cmd) => {
      terminals.push(cmd);
    },
  };
}

function fakeFeatureCtx(meta: Map<string, string>, sent: unknown[]): FeatureContext {
  return {
    db: {
      getMeta: (k: string) => meta.get(k) ?? null,
      setMeta: (k: string, v: string) => void meta.set(k, v),
    },
    broadcast: (m: unknown) => void sent.push(m),
  } as unknown as FeatureContext;
}

describe("worldPlanLoopsLauncher", () => {
  const capturedFiles: string[] = [];
  afterEach(async () => {
    for (const f of capturedFiles.splice(0)) await unlink(f).catch(() => {});
  });

  it("writes the prompt to a temp file (never shell-interpolated) and starts it through talk's startWorldSession, bound for talk/interrupt", async () => {
    const exec = fakeTalkExec();
    const meta = new Map<string, string>();
    const sent: unknown[] = [];
    const ctx = fakeFeatureCtx(meta, sent);
    // Rebinds talk's shared world-session starter to this fake exec (instant sleep: its blank fake
    // pane keeps the launch's startup-dialog watch polling to the end).
    createTalkFeature(exec, undefined, undefined, { sleep: async () => {} });

    const nasty = 'hello \'$(rm -rf /)\' `echo pwned` "; rm -rf ~; echo ';
    const out = await worldPlanLoopsLauncher("/w/t", nasty, ctx);
    expect(out.ok).toBe(true);
    expect(out.tmuxName).toMatch(/^aw-[0-9a-f]{8}$/);

    expect(exec.runs.map((a) => a[0])).toEqual(["new-session", "has-session"]); // still running after the launch watch
    const args = exec.runs[0]!;
    expect(args.slice(0, 5)).toEqual(["new-session", "-d", "-s", out.tmuxName, "-c"]);
    expect(args[5]).toBe("/w/t");
    const shellCmd = args[6]!;
    expect(shellCmd).toContain("--permission-mode plan");
    expect(shellCmd).not.toContain(nasty);

    const match = /\$\(cat '([^']+)'\)/.exec(shellCmd);
    expect(match).not.toBeNull();
    const promptFile = match![1]!;
    capturedFiles.push(promptFile);
    expect(await readFile(promptFile, "utf8")).toBe(nasty);

    expect(exec.terminals[0]).toMatch(/attach -t '=aw-/);
    expect(shellCmd.startsWith("unset CLAUDECODE ")).toBe(true); // the parent session's markers never reach the pane
    expect(JSON.parse(meta.get("talk.bindings") ?? "[]")).toEqual([expect.objectContaining({ agentId: null, cwd: "/w/t", plan: true })]);
    expect(sent[0]).toMatchObject({ type: "feature", feature: "talk" });
  });

  it("fails cleanly (no throw) when tmux is not installed", async () => {
    createTalkFeature({ findTmux: async () => null, run: async () => {}, capture: async () => "", captureAll: async () => "", startCommand: async () => "", paneCounts: async () => "1 1", openTerminal: () => {} });
    const ctx = fakeFeatureCtx(new Map(), []);
    const out = await worldPlanLoopsLauncher("/w/t", "hi", ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
