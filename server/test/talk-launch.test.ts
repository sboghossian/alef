// Decision 1a (2026-09-28): every launch/resume runs in a world tmux session Alef can reach, and the
// audit's deferred talk.ts bugs (a–e). All through a fake TalkExec and fake executors: no real
// tmux, osascript or claude, and ~/.claude.json is a fixture in a fake $HOME.

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAIN_TERMINAL_NOTE, TALK_INSTALL_HINT, type StrandedDispatch, type TalkActionResult, type TalkBinding } from "../../shared/features/talk.js";
import type { DispatchResult, ReactivateResult } from "../../shared/types.js";
import { createLaunchOnce } from "../features/launch-once.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import { createTalkFeature, loadTalkBindings, PARENT_SESSION_ENV_VARS, pastStartupDialogs, projectDirPrefix, withoutParentSessionEnv, type TalkExec } from "../features/talk.js";
import type { RunningServer } from "../index.js";
import { buildPlanDispatchCommand, dispatchDir } from "../reactivate.js";
import { bootTestServer, makeTempDb, userLine } from "./helpers.js";

const TRUST_PANE = `
────────────────────────────────────────────────────────────────────────────────
  Accessing workspace: /Users/x/project

  Quick safety check: Is this a project you created or one you trust? (Like
  your own code, a well-known open source project, or work from your team).
  If not, take a moment to review what's in this folder first.

  Claude Code'll be able to read, edit, and execute files here.

  ❯ No, exit
    Yes, I trust this folder

  Enter to confirm · Esc to cancel`;
const PROMPT_PANE = "────────\n❯ \n────────\n  ? for shortcuts";
const WORKING_PANE = "⏺ Reading the FAQ first.\n\n✻ Thinking… (3s · esc to interrupt)";

interface Call {
  args: readonly string[];
}

/** `#{pane_start_command}` as real tmux prints it (its args_escape): a command holding spaces or
 *  quotes comes back wrapped in "…", with its own `\` and `"` escaped. Pinned to the live capture below. */
function tmuxQuoted(cmd: string): string {
  return `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
// Captured read-only via `tmux display-message -p -t '=aw-68597ce4:' '#{pane_start_command}'` on
// tmux 3.7c, 2026-09-27 (the same capture as talk.test.ts's REAL_LOOPS_LAUNCH_START_CMD).
const REAL_LOOPS_LAUNCH_START_CMD = String.raw`"claude --permission-mode plan \"$(cat '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt')\"; rm -f '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt'"`;

/** A fake tmux: sessions come and go with new-session / kill; every live pane shows `state.pane`.
 *  `exitOnStart`: claude exits at once, so tmux destroys the session and its output (remain-on-exit
 *  is off). `startCommands`: start commands of sessions no new-session here made. */
function fakeTmux(state: {
  pane: string;
  tmux?: string | null;
  terminalError?: Error;
  exitOnStart?: boolean;
  startCommands?: Record<string, string>;
  hasSessionError?: Error;
}): TalkExec & { calls: Call[]; terminals: string[]; live: Set<string> } {
  const calls: Call[] = [];
  const terminals: string[] = [];
  const live = new Set<string>();
  return {
    calls,
    terminals,
    live,
    findTmux: async () => (state.tmux === undefined ? "/opt/homebrew/bin/tmux" : state.tmux),
    async run(_file, args) {
      calls.push({ args });
      const name = (i: number): string => String(args[i]).replace(/^=/, "").replace(/:$/, "");
      if (args[0] === "new-session") {
        if (live.has(name(3))) throw new Error(`duplicate session: ${name(3)}`);
        if (!state.exitOnStart) live.add(name(3));
      }
      if (args[0] === "has-session" && state.hasSessionError) throw state.hasSessionError;
      if (args[0] === "has-session" && !live.has(name(2))) throw new Error(`can't find session: ${name(2)}`);
      if (args[0] === "if-shell") live.delete(name(3));
    },
    async capture(_t, name) {
      if (!live.has(name)) throw new Error(`can't find session: ${name}`);
      return state.pane;
    },
    captureAll: async () => state.pane,
    async startCommand(_t, name) {
      const call = calls.find((c) => c.args[0] === "new-session" && c.args[3] === name);
      // As real tmux prints it (re-quoted), never the raw argv: the raw form hid a lost plan mode.
      return call ? tmuxQuoted(String(call.args[6])) : (state.startCommands?.[name] ?? "");
    },
    paneCounts: async () => "1 1",
    openTerminal(cmd) {
      if (state.terminalError) throw state.terminalError;
      terminals.push(cmd);
    },
  };
}

const AGENT = "5e5e5e5e-aaaa-4bbb-8ccc-dddddddddddd";

describe("world launches (dispatch, reactivate) and the audit's talk fixes", () => {
  let server: RunningServer | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    await server?.close();
    server = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function boot(
    exec: TalkExec,
    opts: { dispatchCalls?: string[][]; reactivateCalls?: string[][]; live?: boolean; now?: () => number } = {},
  ): Promise<{ base: string; home: string; cwd: string; claudeJson: string; projectsDir: string; feature: ServerFeature; ctx: FeatureContext }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-launch-home-")));
    dirs.push(home);
    const cwd = join(home, "Code", "proj");
    await mkdir(join(cwd, ".git"), { recursive: true });
    const claudeJson = join(home, ".claude.json");
    await writeFile(claudeJson, JSON.stringify({ numStartups: 1, projects: { [join(home, "Code", "other")]: { allowedTools: [], hasTrustDialogAccepted: true } } }, null, 2), { mode: 0o600 });
    const feature = createTalkFeature(exec, opts.now ?? Date.now, { home }, { sleep: async () => {}, trust: { homeDir: home, sleep: async () => {} } });
    const b = await bootTestServer({
      dispatchExecutor: (c, f) => void opts.dispatchCalls?.push([c, f]),
      reactivateExecutor: (c, id) => void opts.reactivateCalls?.push([c, id]),
      configOverrides: { features: [feature], claudeJsonPath: claudeJson, liveDetector: () => (opts.live ? new Map([[cwd, 1]]) : new Map()) },
    });
    server = b.server;
    dirs.push(b.dir);
    b.server.db.setIslandForCwd(cwd, "proj");
    // One indexed session in the project, dormant (last written an hour ago) unless `live`.
    const proj = join(b.dir, "projects", "-proj");
    await mkdir(proj, { recursive: true });
    const at = new Date(Date.now() - (opts.live ? 0 : 3600_000));
    await writeFile(join(proj, `${AGENT}.jsonl`), `${userLine({ cwd, timestamp: at.toISOString(), text: "an older task" })}\n`);
    await utimes(join(proj, `${AGENT}.jsonl`), at, at);
    const { runIndexPass } = await import("../indexer.js");
    await runIndexPass(b.server.db, { projectsDir: join(b.dir, "projects") });
    // For driving this feature's onTick directly (the same db and closure the routes use).
    const ctx = { db: b.server.db, config: { projectsDir: join(b.dir, "projects") }, broadcast: () => {}, emit: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as FeatureContext;
    return { base: b.base, home, cwd, claudeJson, projectsDir: join(b.dir, "projects"), feature, ctx };
  }
  const post = (base: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const newSessions = (exec: { calls: Call[] }): Call[] => exec.calls.filter((c) => c.args[0] === "new-session");
  const extras = async (base: string): Promise<Record<string, unknown>> => ((await (await fetch(`${base}/api/world`)).json()) as { extras: Record<string, unknown> }).extras;

  it("the dispatch bar's POST /api/dispatch starts claude in a world tmux session, bound, with Terminal attached to it", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE });
    const { base, cwd } = await boot(exec);
    const res = await post(base, "/api/dispatch", { islandId: "proj", prompt: "Fix the flaky login test" });
    expect(res.status).toBe(200);
    const r = (await res.json()) as DispatchResult;
    expect(r).toMatchObject({ ok: true, islandId: "proj", cwd, mode: "tmux" });
    expect(r.tmuxName).toMatch(/^aw-[0-9a-f]{8}$/);
    expect(r.waitingOn).toBeUndefined();
    const [call] = newSessions(exec);
    expect(call?.args.slice(0, 6)).toEqual(["new-session", "-d", "-s", r.tmuxName, "-c", cwd]);
    expect(String(call?.args[6])).toMatch(new RegExp(`^unset ${PARENT_SESSION_ENV_VARS.join(" ")}; cd '`));
    expect(String(call?.args[6])).toContain(`"$(cat '${dispatchDir()}/`);
    expect(exec.terminals).toEqual([`'/opt/homebrew/bin/tmux' attach -t '=${r.tmuxName}'`]);
    expect(((await extras(base))["talk.bindings"] as TalkBinding[]).map((b) => b.tmuxName)).toEqual([r.tmuxName]);
  });

  it("without tmux, /api/dispatch falls back to a plain Terminal and says so; /api/talk/dispatch still answers 409", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE, tmux: null });
    const dispatchCalls: string[][] = [];
    const { base, cwd } = await boot(exec, { dispatchCalls });
    const r = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "hello there" })).json()) as DispatchResult;
    expect(r).toMatchObject({ ok: true, mode: "terminal", warning: PLAIN_TERMINAL_NOTE, cwd });
    expect(dispatchCalls).toHaveLength(1);
    expect(exec.calls).toEqual([]);
    const strict = await post(base, "/api/talk/dispatch", { islandId: "proj", prompt: "hello again" });
    expect(strict.status).toBe(409);
    expect(((await strict.json()) as TalkActionResult).error).toBe(TALK_INSTALL_HINT);
  });

  // (b) The UI said "Failed" while claude ran detached, and a retry made an orphan.
  it("(b) Terminal failing to open is a warning on a success: the session runs, stays bound, and a retry starts nothing new", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE, terminalError: new Error("Command failed: osascript -e …\n0:43: execution error: Not authorized to send Apple events to Terminal. (-1743)") });
    const { base } = await boot(exec);
    const res = await post(base, "/api/dispatch", { islandId: "proj", prompt: "Write the release notes" });
    expect(res.status).toBe(200);
    const r = (await res.json()) as DispatchResult;
    expect(r.ok).toBe(true);
    expect(r.warning).toBe(`couldn't open Terminal (0:43: execution error: Not authorized to send Apple events to Terminal. (-1743)); it's running in tmux ${r.tmuxName}: use Attach or the Screen`);
    expect(((await extras(base))["talk.bindings"] as TalkBinding[]).map((b) => b.tmuxName)).toEqual([r.tmuxName]);
    const retry = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Write the release notes" })).json()) as DispatchResult;
    expect(retry).toMatchObject({ ok: true, tmuxName: r.tmuxName, reused: true });
    expect(newSessions(exec)).toHaveLength(1);
  });

  // (e) A double-click inside the ~2s launch window spawned 2 sessions.
  it("(e) a double-click (two identical dispatches at once) starts one session; both answers name it", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE });
    const { base } = await boot(exec);
    const [a, b] = await Promise.all([post(base, "/api/dispatch", { islandId: "proj", prompt: "Same prompt" }), post(base, "/api/dispatch", { islandId: "proj", prompt: "Same prompt" })]);
    const ra = (await a.json()) as DispatchResult;
    const rb = (await b.json()) as DispatchResult;
    expect(newSessions(exec)).toHaveLength(1);
    expect(ra.tmuxName).toBe(rb.tmuxName);
    expect([ra.reused, rb.reused].filter(Boolean)).toHaveLength(1);
    // A different prompt is a different launch.
    await post(base, "/api/dispatch", { islandId: "proj", prompt: "Another prompt" });
    expect(newSessions(exec)).toHaveLength(2);
  });

  // (c) The trust dialog was only reported 120s later, in the Inbox.
  it("(c) a launch whose pane shows claude's trust dialog says so in its own answer, and is listed as stranded at once", async () => {
    const exec = fakeTmux({ pane: TRUST_PANE });
    const { base, cwd } = await boot(exec);
    const r = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Align the FAQ with the DPA" })).json()) as DispatchResult;
    expect(r).toMatchObject({ ok: true, mode: "tmux", waitingOn: "trust", cwd });
    const stranded = (await extras(base))["talk.stranded"] as StrandedDispatch[];
    expect(stranded).toEqual([expect.objectContaining({ tmuxName: r.tmuxName, blockedOn: "trust", closable: true, promptHead: "Align the FAQ with the DPA", cwd })]);
  });

  // (a) /api/talk/reactivate and "Resume here" started a second `claude --resume` of a running session.
  it("(a) resuming a session that is running elsewhere answers 409 on both routes and starts nothing", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE });
    const reactivateCalls: string[][] = [];
    const { base } = await boot(exec, { live: true, reactivateCalls });
    for (const path of [`/api/talk/reactivate/${AGENT}`, `/api/reactivate/${AGENT}`]) {
      const res = await post(base, path);
      expect(res.status).toBe(409);
      expect(((await res.json()) as TalkActionResult).error).toMatch(/already running \(in VS Code or Terminal\)/);
    }
    expect(exec.calls.filter((c) => c.args[0] === "new-session")).toEqual([]);
    expect(exec.terminals).toEqual([]);
    expect(reactivateCalls).toEqual([]);
  });

  it("resuming a dormant session: tmux + bound to it; again while that session lives only attaches (never a second claude)", async () => {
    const exec = fakeTmux({ pane: WORKING_PANE });
    const { base, cwd } = await boot(exec);
    const r = (await (await post(base, `/api/reactivate/${AGENT}`)).json()) as ReactivateResult;
    expect(r).toMatchObject({ ok: true, agentId: AGENT, mode: "tmux", tmuxName: "aw-5e5e5e5e", cwd });
    expect(String(newSessions(exec)[0]?.args[6])).toBe(withoutParentSessionEnv(`claude --resume '${AGENT}'`));
    const again = (await (await post(base, `/api/talk/reactivate/${AGENT}`)).json()) as TalkActionResult;
    expect(again).toMatchObject({ ok: true, tmuxName: "aw-5e5e5e5e" });
    expect(again.attached || again.reused).toBe(true);
    expect(newSessions(exec)).toHaveLength(1);
  });

  it("without tmux, a dormant session's /api/reactivate opens a plain Terminal and says so", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE, tmux: null });
    const reactivateCalls: string[][] = [];
    const { base, cwd } = await boot(exec, { reactivateCalls });
    const r = (await (await post(base, `/api/reactivate/${AGENT}`)).json()) as ReactivateResult;
    expect(r).toMatchObject({ ok: true, agentId: AGENT, mode: "terminal", warning: PLAIN_TERMINAL_NOTE });
    expect(reactivateCalls).toEqual([[cwd, AGENT]]);
  });

  // Review finding (PR #55): claude exiting at once (`--resume` of a missing conversation, a folder
  // gone, claude not on tmux's PATH) took its tmux session and output with it, yet the launch said
  // "running in tmux". Now it is a failure, the binding is dropped, and a retry starts fresh.
  it("claude exiting during the launch watch is a failure, not a success in tmux: binding dropped, a retry starts fresh", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE, exitOnStart: true });
    const { base } = await boot(exec);
    const res = await post(base, "/api/dispatch", { islandId: "proj", prompt: "Fix the flaky login test" });
    const r = (await res.json()) as DispatchResult;
    expect(res.status).toBe(500);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/claude exited right after starting \(its tmux session aw-[0-9a-f]{8} has ended\), so nothing is running/);
    expect((await extras(base))["talk.bindings"]).toEqual([]);
    expect((await extras(base))["talk.stranded"]).toEqual([]);
    const retry = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Fix the flaky login test" })).json()) as DispatchResult;
    expect(retry.ok).toBe(false);
    expect(retry.reused).toBeUndefined();
    expect(newSessions(exec)).toHaveLength(2);
    for (const path of [`/api/reactivate/${AGENT}`, `/api/talk/reactivate/${AGENT}`]) {
      const resume = await post(base, path);
      expect(resume.status).toBe(500);
      expect(((await resume.json()) as TalkActionResult).error).toMatch(/claude exited right after starting \(its tmux session aw-5e5e5e5e has ended\)/);
    }
    expect((await extras(base))["talk.bindings"]).toEqual([]);
  });

  // Invariant 3 (never a second claude): a failure invites a retry, so only tmux saying the session
  // is gone makes one. A has-session that times out while claude runs keeps the launch a success.
  it("a has-session that fails for another reason (a timeout) after the watch is not read as claude exiting", async () => {
    const exec = fakeTmux({ pane: PROMPT_PANE, hasSessionError: new Error("Command failed: /opt/homebrew/bin/tmux has-session -t =aw-x\n(killed: timeout)") });
    const { base } = await boot(exec);
    const r = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Fix the flaky login test" })).json()) as DispatchResult;
    expect(r).toMatchObject({ ok: true, mode: "tmux" });
    expect(((await extras(base))["talk.bindings"] as TalkBinding[]).map((b) => b.tmuxName)).toEqual([r.tmuxName]);
  });

  describe("Trust <folder> & relaunch (decision 2b)", () => {
    it("grants trust (one key), Closes the stuck session under Close's invariant, and relaunches the same prompt in plan mode", async () => {
      const state = { pane: TRUST_PANE };
      const exec = fakeTmux(state);
      const { base, cwd, claudeJson } = await boot(exec);
      // A ▶ Launch (plan mode) stuck on the dialog, as startWorldSession would start it.
      const prompt = "Open a PR aligning the FAQ's 'end-to-end encryption' with the DPA";
      const file = join(dispatchDir(), "abababab-1111-4111-8111-111111111111.txt");
      await mkdir(dispatchDir(), { recursive: true });
      await writeFile(file, prompt, { mode: 0o600 });
      const { startWorldSession } = await import("../features/talk.js");
      const ctxLike = { db: server!.db, broadcast: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } };
      const stuck = await startWorldSession(ctxLike as unknown as Parameters<typeof startWorldSession>[0], cwd, buildPlanDispatchCommand(file), { plan: true });
      expect(stuck).toMatchObject({ ok: true, waitingOn: "trust" });
      const stuckName = stuck.ok ? stuck.tmuxName : "";
      // The mode is recorded at launch; tmux's own copy of the command comes back re-quoted.
      expect(((await extras(base))["talk.bindings"] as TalkBinding[]).find((b) => b.tmuxName === stuckName)?.plan).toBe(true);
      expect(await exec.startCommand("/opt/homebrew/bin/tmux", stuckName)).toMatch(/^"unset .*claude --permission-mode plan \\"\$\(cat '/);
      const before = await readFile(claudeJson, "utf8");

      state.pane = TRUST_PANE; // still on the dialog when the Close re-checks its screen
      const execRun = exec.run.bind(exec);
      exec.run = async (f, args) => {
        await execRun(f, args);
        if (args[0] === "if-shell") state.pane = PROMPT_PANE; // the relaunch starts in a trusted folder
      };
      const res = await post(base, `/api/talk/stranded/${stuckName}/trust-relaunch`);
      const r = (await res.json()) as TalkActionResult;
      expect(res.status).toBe(200);
      expect(r).toMatchObject({ ok: true, trusted: true, relaunchedFrom: stuckName, mode: "tmux", cwd });
      expect(r.tmuxName).not.toBe(stuckName);
      expect(r.waitingOn).toBeUndefined();

      // Trust: exactly one new entry, for the realpath'd folder.
      const after = JSON.parse(await readFile(claudeJson, "utf8")) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
      expect(after.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
      expect(Object.keys(after.projects).sort()).toEqual([...Object.keys((JSON.parse(before) as { projects: object }).projects), cwd].sort());
      // Close: the atomic single-pane kill ran on the stuck session; its scrollback went to the fake home's trash.
      expect(exec.calls.filter((c) => c.args[0] === "if-shell").map((c) => c.args[3])).toEqual([`=${stuckName}:`]);
      expect(exec.live.has(stuckName)).toBe(false);
      // Relaunch: the same prompt, still plan mode, from a new prompt file.
      const relaunch = newSessions(exec).find((c) => c.args[3] === r.tmuxName);
      const cmd = String(relaunch?.args[6]);
      expect(cmd).toContain("claude --permission-mode plan");
      const newFile = /\$\(cat '([^']+)'\)/.exec(cmd)?.[1] ?? "";
      expect(newFile).not.toBe(file);
      expect(await readFile(newFile, "utf8")).toBe(prompt);
      // Its Inbox row is gone; the new session isn't stranded, and it is recorded as plan mode too.
      expect(((await extras(base))["talk.stranded"] as StrandedDispatch[]).map((s) => s.tmuxName)).toEqual([]);
      expect(((await extras(base))["talk.bindings"] as TalkBinding[]).find((b) => b.tmuxName === r.tmuxName)?.plan).toBe(true);
    });

    // Review finding (PR #55): the mode was read back from tmux's #{pane_start_command}, which real
    // tmux re-quotes, so a plan-mode launch was relaunched in default mode. A binding saved before
    // the mode was recorded can't rule plan mode out, so it relaunches in plan mode (fail closed).
    it("a binding with no recorded mode, whose pane runs a real tmux-quoted ▶ Launch, relaunches in plan mode", async () => {
      const state: { pane: string; startCommands: Record<string, string> } = { pane: TRUST_PANE, startCommands: {} };
      const exec = fakeTmux(state);
      const { base, cwd, feature, ctx } = await boot(exec);
      const prompt = "Open a PR aligning the FAQ's 'end-to-end encryption' with the DPA";
      const file = join(dispatchDir(), "cdcdcdcd-2222-4222-8222-222222222222.txt");
      await mkdir(dispatchDir(), { recursive: true });
      await writeFile(file, prompt, { mode: 0o600 });
      const name = "aw-1e9ac7d0";
      // As the code before this fix saved it (no `plan`), with the start command real tmux prints.
      server!.db.setMeta("talk.bindings", JSON.stringify([{ agentId: null, tmuxName: name, cwd, startedAt: new Date().toISOString() }]));
      exec.live.add(name);
      state.startCommands[name] = tmuxQuoted(withoutParentSessionEnv(buildPlanDispatchCommand(file)));
      await feature.onTick?.(ctx); // lists it: a young binding on the trust dialog
      expect(((await extras(base))["talk.stranded"] as StrandedDispatch[]).map((s) => [s.tmuxName, s.blockedOn, s.closable])).toEqual([[name, "trust", true]]);
      const execRun = exec.run.bind(exec);
      exec.run = async (f, args) => {
        await execRun(f, args);
        if (args[0] === "if-shell") state.pane = PROMPT_PANE;
      };
      const res = await post(base, `/api/talk/stranded/${name}/trust-relaunch`);
      const r = (await res.json()) as TalkActionResult;
      expect(res.status).toBe(200);
      expect(r).toMatchObject({ ok: true, trusted: true, relaunchedFrom: name });
      const cmd = String(newSessions(exec).find((c) => c.args[3] === r.tmuxName)?.args[6]);
      expect(cmd).toMatch(/; claude --permission-mode plan "\$\(cat '/);
      expect(cmd).not.toContain("&& claude \"$(cat");
    });

    it("a default-mode dispatch stuck on the dialog relaunches in default mode (the mode recorded at launch)", async () => {
      const state = { pane: TRUST_PANE };
      const exec = fakeTmux(state);
      const { base, cwd } = await boot(exec);
      const r0 = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Draft the changelog entry" })).json()) as DispatchResult;
      expect(r0.waitingOn).toBe("trust");
      expect(((await extras(base))["talk.bindings"] as TalkBinding[]).find((b) => b.tmuxName === r0.tmuxName)?.plan).toBe(false);
      const execRun = exec.run.bind(exec);
      exec.run = async (f, args) => {
        await execRun(f, args);
        if (args[0] === "if-shell") state.pane = PROMPT_PANE;
      };
      const res = await post(base, `/api/talk/stranded/${r0.tmuxName}/trust-relaunch`);
      const r = (await res.json()) as TalkActionResult;
      expect(res.status).toBe(200);
      const cmd = String(newSessions(exec).find((c) => c.args[3] === r.tmuxName)?.args[6]);
      expect(cmd).toContain(`; cd '${cwd}' && claude "$(cat '`);
      expect(cmd).not.toContain("--permission-mode");
    });

    it("when Close refuses (another session in the project is active), it trusts the folder but relaunches nothing", async () => {
      const exec = fakeTmux({ pane: TRUST_PANE });
      const { base, cwd, claudeJson, projectsDir } = await boot(exec);
      const r0 = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Draft the changelog entry" })).json()) as DispatchResult;
      expect(r0.waitingOn).toBe("trust");
      // Someone else is now working in the same project (a transcript written since the launch, in
      // Claude Code's own project dir for it): Close must refuse (#29's invariant).
      const proj = join(projectsDir, projectDirPrefix(cwd));
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, "6f6f6f6f-aaaa-4bbb-8ccc-dddddddddddd.jsonl"), `${userLine({ cwd, timestamp: new Date().toISOString(), text: "busy" })}\n`);
      const res = await post(base, `/api/talk/stranded/${r0.tmuxName}/trust-relaunch`);
      expect(res.status).toBe(409);
      const r = (await res.json()) as TalkActionResult;
      expect(r.trusted).toBe(true);
      expect(r.error).toMatch(/wasn't closed, so nothing was relaunched/);
      expect(newSessions(exec)).toHaveLength(1);
      expect(exec.live.has(r0.tmuxName ?? "")).toBe(true);
      expect((JSON.parse(await readFile(claudeJson, "utf8")) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    });

    it("refuses a row that isn't waiting on the trust dialog, and changes nothing", async () => {
      const exec = fakeTmux({ pane: PROMPT_PANE });
      const { base, claudeJson } = await boot(exec);
      const before = await readFile(claudeJson, "utf8");
      const r0 = (await (await post(base, "/api/dispatch", { islandId: "proj", prompt: "Anything at all here" })).json()) as DispatchResult;
      const res = await post(base, `/api/talk/stranded/${r0.tmuxName}/trust-relaunch`);
      expect(res.status).toBe(409);
      expect(await readFile(claudeJson, "utf8")).toBe(before);
      expect(exec.calls.some((c) => c.args[0] === "if-shell")).toBe(false);
    });
  });
});

describe("loadTalkBindings keeps the launch's recorded mode", () => {
  it("plan true/false survive a reload; anything else reads as not recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aw-bindings-"));
    const db = await makeTempDb(dir);
    const at = "2026-09-28T10:00:00.000Z";
    db.setMeta(
      "talk.bindings",
      JSON.stringify([
        { agentId: null, tmuxName: "aw-plan0001", cwd: "/p", startedAt: at, plan: true },
        { agentId: null, tmuxName: "aw-dflt0001", cwd: "/p", startedAt: at, plan: false },
        { agentId: null, tmuxName: "aw-old00001", cwd: "/p", startedAt: at },
        { agentId: null, tmuxName: "aw-junk0001", cwd: "/p", startedAt: at, plan: "yes" },
      ]),
    );
    expect(loadTalkBindings(db).map((b) => [b.tmuxName, b.plan])).toEqual([
      ["aw-plan0001", true],
      ["aw-dflt0001", false],
      ["aw-old00001", undefined],
      ["aw-junk0001", undefined],
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the fake's tmuxQuoted", () => {
  it("reproduces real tmux's #{pane_start_command} for a ▶ Launch byte for byte", () => {
    const file = "/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt";
    expect(tmuxQuoted(buildPlanDispatchCommand(file))).toBe(REAL_LOOPS_LAUNCH_START_CMD);
  });
});

describe("pastStartupDialogs", () => {
  it("is false on a dialog or a blank pane, true on claude's input box, its output, or a shell", () => {
    expect(pastStartupDialogs(TRUST_PANE)).toBe(false);
    expect(pastStartupDialogs("")).toBe(false);
    expect(pastStartupDialogs(PROMPT_PANE)).toBe(true);
    expect(pastStartupDialogs(WORKING_PANE)).toBe(true);
    expect(pastStartupDialogs("Last login: Mon\nalex@mac ~ % ")).toBe(true);
  });
});

describe("createLaunchOnce", () => {
  it("shares an in-flight launch, repeats a success within the window, never remembers a failure", async () => {
    let t = 0;
    const once = createLaunchOnce(() => t, 10_000);
    let n = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = async (): Promise<{ ok: boolean; id: number }> => {
      n++;
      await gate;
      return { ok: true, id: n };
    };
    const a = once.run("k", slow);
    const b = once.run("k", slow);
    release();
    expect(await a).toEqual({ ok: true, id: 1 });
    expect(await b).toEqual({ ok: true, id: 1, reused: true });
    t = 9_999;
    expect(await once.run("k", slow)).toEqual({ ok: true, id: 1, reused: true });
    t = 10_000;
    expect(await once.run("k", async () => ({ ok: true, id: 2 }))).toEqual({ ok: true, id: 2 });
    expect(await once.run("f", async () => ({ ok: false, id: 3 }))).toEqual({ ok: false, id: 3 });
    expect(await once.run("f", async () => ({ ok: true, id: 4 }))).toEqual({ ok: true, id: 4 });
  });
});

// (d) Tested in a fake, as the audit asked: the tmux server that Alef started carries the VS Code
// session's CLAUDECODE / CLAUDE_CODE_CHILD_SESSION / CLAUDE_CODE_SESSION_ID (read off its process
// env, 2026-09-28), and every pane's claude inherited them. The launch command must unset them.
describe("(d) the parent session's markers never reach the launched claude", () => {
  it("a fake claude run through the launch command (via /bin/sh -c, as tmux does) sees none of them, and keeps the rest", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "aw-fake-claude-")));
    try {
      const out = join(bin, "env.txt");
      await writeFile(join(bin, "claude"), `#!/bin/sh\nenv > '${out}'\n`);
      await chmod(join(bin, "claude"), 0o755);
      const leaked: Record<string, string> = {
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ID: "79d96151-06e5-423f-989b-0228b0c79c2e",
        CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        CLAUDE_CODE_SESSION_ATTENDED: "1",
        CLAUDE_PID: "4242",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/fake.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "fake-token",
      };
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, KEEP_ME: "yes", ...leaked };
      // Without the fix, the fake claude inherits every marker (the leak).
      execFileSync("/bin/sh", ["-c", "claude"], { env });
      const leakedEnv = await readFile(out, "utf8");
      for (const k of Object.keys(leaked)) expect(leakedEnv).toContain(`${k}=`);
      // With it, none of them; everything else passes through.
      execFileSync("/bin/sh", ["-c", withoutParentSessionEnv("claude")], { env });
      const clean = await readFile(out, "utf8");
      for (const k of Object.keys(leaked)) expect(clean).not.toMatch(new RegExp(`^${k}=`, "m"));
      expect(clean).toMatch(/^KEEP_ME=yes$/m);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});
