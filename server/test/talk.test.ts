import { afterEach, describe, expect, it } from "vitest";
import { TALK_INSTALL_HINT, type StrandedDispatch, type TalkActionResult, type TalkBinding, type TalkStatus } from "../../shared/features/talk.js";
import type { RunningServer } from "../index.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import {
  ADOPT_WINDOW_MS,
  classifyStrandedPane,
  cleanTalkText,
  createTalkFeature,
  isValidPaneCounts,
  killIfSinglePaneCommand,
  lastNonBlankLine,
  planAdoptions,
  projectActiveSince,
  promptFileFromStartCommand,
  promptMatchesTitle,
  startWorldSession,
  withoutParentSessionEnv,
  type TalkExec,
} from "../features/talk.js";
import type { WorldDb } from "../db.js";
import { trashDateKey } from "../features/cleanup-lib.js";
import { trashRootOf } from "../features/cleanup-trash.js";
import { buildDispatchCommand, dispatchDir } from "../reactivate.js";
import { bootTestServer, makeTempDb, makeTempProjectsDir, userLine } from "./helpers.js";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const AGENT = "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";

interface Call {
  file: string;
  args: readonly string[];
}

function fakeExec(
  tmux: string | null,
  liveSessions = new Set<string>(),
  pane = "❯ \n  ? for shortcuts",
  startCmd = "",
): TalkExec & { calls: Call[]; terminals: string[] } {
  const calls: Call[] = [];
  const terminals: string[] = [];
  return {
    calls,
    terminals,
    async findTmux() {
      return tmux;
    },
    async run(file, args) {
      calls.push({ file, args });
      if (args[0] === "new-session") liveSessions.add(String(args[3]));
      if (args[0] === "has-session" && !liveSessions.has(String(args[2]).replace(/^=/, ""))) throw new Error("no session");
      if (args[0] === "kill-session") liveSessions.delete(String(args[2]).replace(/^=/, ""));
      // Default fake for the atomic if-shell+kill (killIfSinglePaneCommand): simulate tmux's own
      // condition still holding, so the embedded kill-session runs. Tests that need the condition
      // to read false at the exact moment of the kill override `run` themselves (see the "gained a
      // window or pane" test below) rather than through this shared default.
      if (args[0] === "if-shell") liveSessions.delete(String(args[3]).replace(/^=/, "").replace(/:$/, ""));
    },
    async capture() {
      return pane;
    },
    async captureAll() {
      return pane;
    },
    async startCommand() {
      return startCmd;
    },
    async paneCounts() {
      return "1 1";
    },
    openTerminal(cmd) {
      terminals.push(cmd);
    },
  };
}

describe("talk", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(exec: TalkExec): Promise<string> {
    const b = await bootTestServer({ configOverrides: { features: [createTalkFeature(exec)] } });
    server = b.server;
    // Index one session so reactivate/talk have a real agent. Dormant (its transcript last written
    // an hour ago): resuming a LIVE one answers 409 (see "refuses to resume a running session").
    const proj = join(b.dir, "projects", "-repo");
    await mkdir(proj, { recursive: true });
    const hourAgo = new Date(Date.now() - 3600_000);
    await writeFile(join(proj, `${AGENT}.jsonl`), userLine({ cwd: "/repo", timestamp: hourAgo.toISOString(), text: "hi" }) + "\n");
    await utimes(join(proj, `${AGENT}.jsonl`), hourAgo, hourAgo);
    const { runIndexPass } = await import("../indexer.js");
    await runIndexPass(b.server.db, { projectsDir: join(b.dir, "projects") });
    return b.base;
  }
  const post = (base: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("without tmux: status shows the install hint and actions answer 409", async () => {
    const exec = fakeExec(null);
    const base = await boot(exec);
    const status = (await (await fetch(`${base}/api/talk/status`)).json()) as TalkStatus;
    expect(status).toEqual({ available: false, hint: TALK_INSTALL_HINT, bindings: [] });
    const r = await post(base, `/api/talk/reactivate/${AGENT}`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as TalkActionResult).error).toBe(TALK_INSTALL_HINT);
    expect(exec.calls).toEqual([]);
    expect(exec.terminals).toEqual([]);
  });

  it("reactivate in tmux → talk sends literal text + Enter via argv", async () => {
    const exec = fakeExec("/opt/homebrew/bin/tmux");
    const base = await boot(exec);
    const r = (await (await post(base, `/api/talk/reactivate/${AGENT}`)).json()) as TalkActionResult;
    expect(r).toEqual({ ok: true, mode: "tmux", tmuxName: "aw-7d3f0c2a", cwd: "/repo" });
    expect(exec.calls[0]?.args).toEqual(["new-session", "-d", "-s", "aw-7d3f0c2a", "-c", "/repo", withoutParentSessionEnv(`claude --resume '${AGENT}'`)]);
    expect(exec.terminals).toEqual(["'/opt/homebrew/bin/tmux' attach -t '=aw-7d3f0c2a'"]);

    const text = `hello; rm -rf / $(whoami) 'quote'\nsecond line`;
    const sent = await post(base, `/api/talk/${AGENT}`, { text });
    expect(sent.status).toBe(200);
    const sends = exec.calls.filter((c) => c.args[0] === "send-keys");
    expect(sends.map((c) => c.args)).toEqual([
      ["send-keys", "-t", "aw-7d3f0c2a", "-l", "hello; rm -rf / $(whoami) 'quote' second line"],
      ["send-keys", "-t", "aw-7d3f0c2a", "Enter"],
    ]);
  });

  it("validates talk requests", async () => {
    const exec = fakeExec("/usr/bin/tmux");
    const base = await boot(exec);
    expect((await post(base, `/api/talk/not-a-uuid`, { text: "x" })).status).toBe(400);
    expect((await post(base, `/api/talk/${AGENT}`, { text: "" })).status).toBe(400);
    expect((await post(base, `/api/talk/${AGENT}`, { text: "x".repeat(2001) })).status).toBe(400);
    expect((await post(base, `/api/talk/${AGENT}`, { text: "hi" })).status).toBe(404); // no tmux binding
    expect((await post(base, `/api/talk/reactivate/${"0".repeat(8)}-0000-4000-8000-000000000000`)).status).toBe(404);
    expect(exec.calls.filter((c) => c.args[0] === "send-keys")).toEqual([]);
  });

  it("dispatch in tmux: prompt goes to a file, never into argv", async () => {
    const exec = fakeExec("/usr/bin/tmux");
    const base = await boot(exec);
    const status = (await (await fetch(`${base}/api/world`)).json()) as { islands: { id: string; path: string }[] };
    const island = status.islands.find((i) => i.path === "/repo");
    expect(island).toBeDefined();
    const r = (await (await post(base, "/api/talk/dispatch", { islandId: island?.id, prompt: "do $(evil)" })).json()) as TalkActionResult;
    expect(r.ok).toBe(true);
    const cmd = String(exec.calls[0]?.args[6]);
    expect(cmd).not.toContain("evil");
    expect(cmd).toMatch(/claude "\$\(cat '.*agent-world-dispatch\/.*\.txt'\)"/);
    expect((await post(base, "/api/talk/dispatch", { islandId: "harness", prompt: "x" })).status).toBe(400);
  });

  it("cleanTalkText drops control chars and folds newlines", () => {
    expect(cleanTalkText("a\r\nb\u001b[31mc\u0007")).toBe("a b[31mc");
  });
});

// Regression: found in live test 2026-09-24. Talk text + Enter landed on Claude's trust dialog and
// picked the default option; on a permission prompt Enter selects "1. Yes".
describe("paneShowsPrompt", () => {
  it("detects permission prompts, trust dialogs and menus", async () => {
    const { paneShowsPrompt } = await import("../features/talk.js");
    expect(paneShowsPrompt(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend")).toBe(true);
    expect(paneShowsPrompt(" ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel")).toBe(true);
    expect(paneShowsPrompt("❯ \n  ⏸ manual mode on · ? for shortcuts")).toBe(false);
  });
});

// ---- Stranded dispatches (▶ Launch / dispatch whose tmux session never grew a transcript) ----

// Captured read-only (`tmux capture-pane -p`) 2026-09-27 from the two real stuck sessions this
// feature exists for — aw-68597ce4 (acme-www, sitting at plan mode's empty prompt) and
// aw-e3199626 (acme-www, the "Claude in Chrome" first-run dialog). UI text and a project path only.
const REAL_EMPTY_PROMPT_PANE = `  ✔ Using flicker-free rendering · if you want to go back, use /tui default
    · Click to move your cursor in the text input
    · Click to expand collapsed tool results
    · By default, text auto-copies when you select it (/config to change)
    · Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use
  your terminal's native copy instead

⚠ 10 MCP servers need authentication · run /mcp

  Introducing Opus 5.5
  Get to finished work sooner with Opus 5.5. Switch anytime with /model.
  ⎿  SessionStart:startup says: iCloud sync artifacts in this project (2). These
     break builds with misleading errors.
     /Users/alexboghossian/Documents/Code/acme-www/apps/main/src/app/_routes
     /StationFPromoCodeButton.tsx
     /Users/alexboghossian/Documents/Code/acme-www/apps/main/src/app/_routes
     /StartupProgramTrackingController.tsx
     Fix: ~/.claude/scripts/icloud-doctor.sh fix . --deep
                                        ✔ Update installed · Restart to apply
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏸ plan mode on (shift+tab to cycle) · ← for agents`;

// Reconstructed from the exact strings shipped in the installed claude.exe binary (`strings` +
// grep, 2026-09-27: "Quick safety check: Is this a project you created or one you trust?" and
// the confirm button's label "Yes, I trust this folder", both found; "Do you trust the files in
// this folder" was NOT found anywhere in the binary) and its real confirm-dialog layout
// (cancelFirst, focus:"cancel", so the cursor starts on "No, exit"). Not a live `tmux
// capture-pane` — triggering the real first-run dialog would mean starting a nested `claude`
// process, which is out of scope here — but every word and the option order come from the binary
// itself, unlike the wrong wording this regression replaces.
const REAL_TRUST_DIALOG_PANE = `
────────────────────────────────────────────────────────────────────────────────
  Accessing workspace: /Users/x/project

  Quick safety check: Is this a project you created or one you trust? (Like
  your own code, a well-known open source project, or work from your team).
  If not, take a moment to review what's in this folder first.

  Claude Code'll be able to read, edit, and execute files here.

  ❯ No, exit
    Yes, I trust this folder

  Enter to confirm · Esc to cancel`;

const REAL_CHROME_PANE = `
────────────────────────────────────────────────────────────────────────────────
  Claude in Chrome extension detected

  Claude will use your Chrome browser by default — navigating sites, filling
  forms, and capturing screenshots in your existing session.

  Browser actions still go through Claude's regular permission prompts before
  they run. Turn browser tools off for future sessions with /chrome.

  ❯ No, keep browser tools off
    Yes, use my browser

  Enter to confirm · Esc to keep browser tools off`;

// A working agent after "Yes, use my browser", 23 lines like the real pane. claude.exe names its
// browser tools `Claude in Chrome[<tool>]` (that userFacingName template is in the installed
// binary); the ⏺/⎿ transcript layout around it is inferred, not captured.
const WORKING_BROWSER_PANE = `⏺ I'll check the FAQ wording on the live site first.

⏺ Claude in Chrome[navigate](url: "https://acme.ai/faq")
  ⎿  Navigated to https://acme.ai/faq

⏺ Claude in Chrome[get_page_text]
  ⎿  Frequently asked questions … +212 lines (ctrl+o to expand)

⏺ Claude in Chrome[find](query: "data processing agreement")
  ⎿  Found 3 matches

✻ Comparing it with the DPA… (38s · ↓ 1.9k tokens · esc to interrupt)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts`;

// A working agent whose prompt quotes both dialogs, then edits this feature's own source.
const DIALOG_WORDS_ON_SCREEN_PANE = `> Make the stranded-row detector recognise "Yes, I trust this folder" and
  "Claude in Chrome extension detected"

⏺ Update(server/features/talk.ts)
  ⎿  Updated server/features/talk.ts with 2 additions and 2 removals
       124 -const TRUST_DIALOG_RE = /Is this a project you created or one you trust|Yes, I trust this folder/;
       125 -const CHROME_DIALOG_RE = /Claude in Chrome|use my browser|keep browser tools off/;
       126 +  footer: "Enter to confirm · Esc to keep browser tools off",

✻ Thinking… (12s · esc to interrupt)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts`;

describe("classifyStrandedPane", () => {
  it("classifies the two real stuck panes", () => {
    expect(classifyStrandedPane(REAL_EMPTY_PROMPT_PANE)).toBe("empty-prompt");
    expect(classifyStrandedPane(REAL_CHROME_PANE)).toBe("chrome");
  });

  it("recognizes the real folder-trust dialog ahead of the generic menu detector", () => {
    // Regression: the old TRUST_DIALOG_RE matched wording ("Do you trust the files in this
    // folder") that the installed claude.exe binary does not contain at all, so a real
    // trust-blocked dispatch fell through to "menu" instead of "trust".
    expect(classifyStrandedPane(REAL_TRUST_DIALOG_PANE)).toBe("trust");
  });

  it("falls back to the generic menu for any other permission prompt", () => {
    expect(classifyStrandedPane(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend")).toBe("menu");
  });

  it("is 'exited' for a pane with no claude UI at all, ending in a shell prompt", () => {
    expect(classifyStrandedPane("Last login: Fri Sep 26 08:00:00 on ttys001\nsteph@Mac project % ")).toBe("exited");
  });

  it("is 'unknown' for a pane matching none of the above", () => {
    expect(classifyStrandedPane("just some ordinary output\nwith nothing recognizable")).toBe("unknown");
  });

  it("still finds the real Chrome dialog with tmux's trailing blank lines under it", () => {
    expect(classifyStrandedPane(`${REAL_CHROME_PANE}\n\n\n\n\n\n\n\n\n`)).toBe("chrome");
  });

  // Regression (PR #29 review, HIGH + MEDIUM): the dialogs' words anywhere in the last 25 lines
  // made a working agent's screen read as a startup dialog, so Close could kill it and adoption
  // skipped it. The dialog's footer must now be the pane's last line, with nothing but the dialog
  // between it and the rule above.
  it("never reads a working agent's screen as a startup dialog, whatever words it shows", () => {
    const startupDialogs = ["trust", "chrome"];
    expect(classifyStrandedPane(WORKING_BROWSER_PANE)).toBe("empty-prompt");
    expect(startupDialogs).not.toContain(classifyStrandedPane(DIALOG_WORDS_ON_SCREEN_PANE));
    const withTranscriptLine = REAL_CHROME_PANE.replace("Claude will use your Chrome", "⏺ Claude will use your Chrome");
    expect(startupDialogs).not.toContain(classifyStrandedPane(withTranscriptLine));
    const withInputBox = REAL_TRUST_DIALOG_PANE.replace("❯ No, exit", "❯ No, exit\n  ❯ fix the build");
    expect(startupDialogs).not.toContain(classifyStrandedPane(withInputBox));
  });
});

describe("lastNonBlankLine", () => {
  it("returns the last non-blank line, trimmed", () => {
    expect(lastNonBlankLine("a\nb  \n\n  \n")).toBe("b");
  });
  it("is null for an all-blank pane", () => {
    expect(lastNonBlankLine("\n  \n")).toBeNull();
  });
});

describe("isValidPaneCounts", () => {
  it("accepts tmux's own \"<windows> <panes>\" shape", () => {
    expect(isValidPaneCounts("1 1")).toBe(true);
    expect(isValidPaneCounts("2 3")).toBe(true);
    expect(isValidPaneCounts("10 20")).toBe(true);
  });
  // tmux's `display-message -p` does not error for a target that no longer exists — it just
  // leaves the format's variables unset, so the output is blank fields, not an error. That must
  // never be mistaken for some other real pane count.
  it("rejects the blank output tmux prints for a target that no longer exists, and anything else malformed", () => {
    expect(isValidPaneCounts("")).toBe(false);
    expect(isValidPaneCounts(" ")).toBe(false);
    expect(isValidPaneCounts("1")).toBe(false);
    expect(isValidPaneCounts("1 ")).toBe(false);
    expect(isValidPaneCounts("a b")).toBe(false);
    expect(isValidPaneCounts("1 1 1")).toBe(false);
    expect(isValidPaneCounts("1\n1")).toBe(false);
  });
});

describe("killIfSinglePaneCommand", () => {
  it("builds the one tmux command that re-checks the pane count and kills atomically", () => {
    expect(killIfSinglePaneCommand("aw-route1")).toEqual([
      "if-shell",
      "-F",
      "-t",
      "=aw-route1:",
      "#{&&:#{==:#{session_windows},1},#{==:#{window_panes},1}}",
      "kill-session -t =aw-route1",
    ]);
  });
  it("targets the exact session name given, for a differently-named binding", () => {
    const [, , , target, , killCmd] = killIfSinglePaneCommand("aw-deadbeef");
    expect(target).toBe("=aw-deadbeef:");
    expect(killCmd).toBe("kill-session -t =aw-deadbeef");
  });
});

describe("promptFileFromStartCommand", () => {
  const DISPATCH_DIR = "/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch";
  // Captured read-only via `tmux display-message -p -t '=aw-68597ce4:' '#{pane_start_command}'`
  // 2026-09-27 — tmux itself re-quotes the value (outer `"..."`, escaped inner `\"`) once the
  // command contains its own double quotes; the parser must see through that wrapping.
  const REAL_LOOPS_LAUNCH_START_CMD = String.raw`"claude --permission-mode plan \"$(cat '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt')\"; rm -f '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt'"`;

  it("recovers the prompt-file path from the real loops-launch (▶ Launch) start command", () => {
    expect(promptFileFromStartCommand(REAL_LOOPS_LAUNCH_START_CMD, DISPATCH_DIR)).toBe(`${DISPATCH_DIR}/c2031f70-81b8-4fd5-a4ce-dc4a21bbd7aa.txt`);
  });

  it("recovers it from the /api/talk/dispatch shape (built by the real buildDispatchCommand)", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const cmd = buildDispatchCommand("/Users/x/project", `${DISPATCH_DIR}/${uuid}.txt`);
    expect(promptFileFromStartCommand(cmd, DISPATCH_DIR)).toBe(`${DISPATCH_DIR}/${uuid}.txt`);
  });

  it("refuses a path outside the dispatch dir", () => {
    expect(promptFileFromStartCommand(`claude "$(cat '/etc/passwd')"`, DISPATCH_DIR)).toBeNull();
  });

  it("refuses a traversal out of the dispatch dir", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(promptFileFromStartCommand(`claude "$(cat '${DISPATCH_DIR}/../x/${uuid}.txt')"`, DISPATCH_DIR)).toBeNull();
  });

  it("returns null for a command with no prompt file (fork's plain PLAN_COMMAND)", () => {
    expect(promptFileFromStartCommand("claude --permission-mode plan", DISPATCH_DIR)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(promptFileFromStartCommand("", DISPATCH_DIR)).toBeNull();
  });

  it("still matches when the dispatch dir has a trailing slash (ALEF_DISPATCH_DIR=/x/dir/)", () => {
    // Regression: `dirname(path) !== dispatchDir` compared raw strings, and path.dirname() never
    // returns a trailing slash — so a trailing-slash (or relative) ALEF_DISPATCH_DIR silently
    // made every stranded row's promptHead null.
    const uuid = "11111111-1111-1111-1111-111111111111";
    const cmd = buildDispatchCommand("/Users/x/project", `${DISPATCH_DIR}/${uuid}.txt`);
    expect(promptFileFromStartCommand(cmd, `${DISPATCH_DIR}/`)).toBe(`${DISPATCH_DIR}/${uuid}.txt`);
  });
});

function fakeStrandedCtx(db: Awaited<ReturnType<typeof makeTempDb>>, sent: unknown[]): FeatureContext {
  return {
    db,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    broadcast: (m: unknown) => void sent.push(m),
    emit: (payload: unknown) => void sent.push({ type: "feature", feature: "talk", payload }),
  } as unknown as FeatureContext;
}

/** Indexes a session the way the indexer would: `title` is its first user message. */
function addSession(db: WorldDb, id: string, startedAt: string, title: string, cwd = "/repo", lastActive = new Date().toISOString()): void {
  db.upsertSession({
    id,
    cwd,
    islandId: "repo",
    title,
    startedAt,
    lastActive,
    jsonlMtime: 0,
    messageCountDelta: 1,
    model: null,
    cntEditDelta: 0,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 1,
    cntAssistantTotalDelta: 1,
  });
}

/** Writes a real prompt file into the (test-scoped) dispatch dir and returns it with the exact
 *  start command /api/talk/dispatch would have given its tmux pane. */
async function dispatchPromptFile(uuid: string, prompt: string): Promise<{ file: string; startCmd: string }> {
  await mkdir(dispatchDir(), { recursive: true });
  const file = join(dispatchDir(), `${uuid}.txt`);
  await writeFile(file, prompt, "utf8");
  return { file, startCmd: buildDispatchCommand("/repo", file) };
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

describe("promptMatchesTitle", () => {
  it("matches a first user message that carries the prompt, whitespace aside", () => {
    expect(promptMatchesTitle("Open PR aligning\n\n  the FAQ", "Open PR aligning the FAQ")).toBe(true);
  });
  it("matches a long prompt against the indexer's 600-char title cut", () => {
    const prompt = "word ".repeat(400);
    expect(promptMatchesTitle(prompt, prompt.slice(0, 600))).toBe(true);
  });
  it("does not match an unrelated session's first message, or an empty one", () => {
    expect(promptMatchesTitle("Open PR aligning the FAQ", "fix the build")).toBe(false);
    expect(promptMatchesTitle("Open PR aligning the FAQ", "")).toBe(false);
    expect(promptMatchesTitle("", "anything")).toBe(false);
  });
  // Regression (PR #29 review): the head matched anywhere in the title, at any length, so a
  // dispatch of "fix" was "proven" by any first message containing the word.
  it("never treats a short prompt as proof, however the title reads", () => {
    expect(promptMatchesTitle("fix", "please fix the flaky login test")).toBe(false);
    expect(promptMatchesTitle("fix", "fix")).toBe(false);
  });
  it("only matches at the start of the title, never in the middle", () => {
    expect(promptMatchesTitle("fix the flaky login test on CI", "please fix the flaky login test on CI")).toBe(false);
    expect(promptMatchesTitle("fix the flaky login test on CI", "fix the flaky login test on CI, then rebase")).toBe(true);
  });
});

describe("projectActiveSince", () => {
  const binding: TalkBinding = { agentId: null, tmuxName: "aw-p1", cwd: "/repo", startedAt: "2026-09-27T10:00:00.000Z" };
  it("counts a session in the cwd, or below it, active at or after the dispatch, whenever it started", () => {
    expect(projectActiveSince(binding, [{ cwd: "/repo", lastActive: "2026-09-27T10:00:00.000Z" }])).toBe(true);
    expect(projectActiveSince(binding, [{ cwd: "/repo/apps/web", lastActive: "2026-09-27T11:00:00.000Z" }])).toBe(true);
    expect(projectActiveSince({ ...binding, cwd: "/repo/" }, [{ cwd: "/repo", lastActive: "2026-09-27T11:00:00.000Z" }])).toBe(true);
  });
  it("ignores sessions last active before the dispatch, and other projects", () => {
    expect(projectActiveSince(binding, [{ cwd: "/repo", lastActive: "2026-09-27T09:59:59.000Z" }])).toBe(false);
    expect(projectActiveSince(binding, [{ cwd: "/repo-other", lastActive: "2026-09-27T11:00:00.000Z" }])).toBe(false);
  });
  it("counts a time that does not parse as active", () => {
    expect(projectActiveSince(binding, [{ cwd: "/repo", lastActive: "not a date" }])).toBe(true);
  });
});

describe("planAdoptions", () => {
  const prompt = "Open PR aligning acme.ai FAQ with the DPA";
  // Regression (PR #29 review, S2): a retry B of the same prompt, still on its trust dialog, won the
  // closest-start tie-break for the session its twin A was running once A's dialog was answered.
  it("leaves out a binding whose pane still shows the trust or Chrome dialog", () => {
    const a: TalkBinding = { agentId: null, tmuxName: "aw-older02", cwd: "/repo", startedAt: "2026-09-27T10:00:00.000Z" };
    const b: TalkBinding = { agentId: null, tmuxName: "aw-newer02", cwd: "/repo", startedAt: "2026-09-27T10:20:00.000Z" };
    const s = { id: "s", cwd: "/repo", startedAt: "2026-09-27T10:25:00.000Z", title: prompt };
    for (const dialog of [REAL_TRUST_DIALOG_PANE, REAL_CHROME_PANE]) {
      const plan = planAdoptions(
        [
          { binding: a, prompt, pane: REAL_EMPTY_PROMPT_PANE },
          { binding: b, prompt, pane: dialog },
        ],
        [s],
      );
      expect([...plan]).toEqual([["aw-older02", "s"]]);
    }
  });

  // Regression (PR #29 review, MEDIUM): a working agent showing "Claude in Chrome[...]" tool lines
  // classified as "chrome", so it was left out and never adopted (Talk and Interrupt answered 404).
  it("adopts for a working agent whose screen shows browser tool lines", () => {
    const w: TalkBinding = { agentId: null, tmuxName: "aw-brow2", cwd: "/repo", startedAt: "2026-09-27T10:00:00.000Z" };
    const s = { id: "s", cwd: "/repo", startedAt: "2026-09-27T10:00:05.000Z", title: prompt };
    expect([...planAdoptions([{ binding: w, prompt, pane: WORKING_BROWSER_PANE }], [s])]).toEqual([["aw-brow2", "s"]]);
  });

  // Regression (PR #29 review, LOW): the older dispatch A was answered and runs S; its retry B
  // idles at an empty prompt. Both carry S's prompt, B's start was closer, so B adopted S and
  // Talk typed into the wrong claude. Two unadopted bindings proving the same session adopt nothing.
  it("adopts nothing when two unadopted bindings both carry the session's prompt", () => {
    const a: TalkBinding = { agentId: null, tmuxName: "aw-oldr3", cwd: "/repo", startedAt: "2026-09-27T10:00:00.000Z" };
    const b: TalkBinding = { agentId: null, tmuxName: "aw-newr3", cwd: "/repo", startedAt: "2026-09-27T10:20:00.000Z" };
    const c: TalkBinding = { agentId: null, tmuxName: "aw-nopr3", cwd: "/repo", startedAt: "2026-09-27T10:24:00.000Z" };
    const s = { id: "s", cwd: "/repo", startedAt: "2026-09-27T10:25:00.000Z", title: prompt };
    const waiting = [
      { binding: a, prompt, pane: WORKING_BROWSER_PANE },
      { binding: b, prompt, pane: REAL_EMPTY_PROMPT_PANE },
    ];
    expect([...planAdoptions(waiting, [s])]).toEqual([]);
    // Nor does a third binding with no proof, however close its start.
    expect([...planAdoptions([...waiting, { binding: c, prompt: null, pane: REAL_EMPTY_PROMPT_PANE }], [s])]).toEqual([]);
  });

  it("twins that were both answered still each adopt their own session", () => {
    const a: TalkBinding = { agentId: null, tmuxName: "aw-twina", cwd: "/repo", startedAt: "2026-09-27T10:00:00.000Z" };
    const b: TalkBinding = { agentId: null, tmuxName: "aw-twinb", cwd: "/repo", startedAt: "2026-09-27T10:20:00.000Z" };
    const s1 = { id: "s1", cwd: "/repo", startedAt: "2026-09-27T10:01:00.000Z", title: prompt };
    const s2 = { id: "s2", cwd: "/repo", startedAt: "2026-09-27T10:21:00.000Z", title: prompt };
    const plan = planAdoptions(
      [
        { binding: b, prompt, pane: REAL_EMPTY_PROMPT_PANE },
        { binding: a, prompt, pane: REAL_EMPTY_PROMPT_PANE },
      ],
      [s2, s1],
    );
    expect(Object.fromEntries(plan)).toEqual({ "aw-twina": "s1", "aw-twinb": "s2" });
  });
});

describe("stranded dispatches (onTick + snapshotExtras)", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function setup(bindings: TalkBinding[]): Promise<{ ctx: FeatureContext; sent: unknown[] }> {
    dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    db.setMeta("talk.bindings", JSON.stringify(bindings));
    // Regression: this used to build the `sent` array it returned separately from the one it
    // wired into `ctx` (`fakeStrandedCtx(db, [])` — a fresh, un-returned array), so nothing that
    // asserted on `sent` was ever actually observing what the feature broadcast/emitted.
    const sent: unknown[] = [];
    return { ctx: fakeStrandedCtx(db, sent), sent };
  }

  it("a stranded dispatch (>2min, alive, agentId null) appears with its promptHead read from the real dispatch dir", async () => {
    const dispatchFileDir = dispatchDir();
    await mkdir(dispatchFileDir, { recursive: true });
    const promptFile = join(dispatchFileDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.txt");
    await writeFile(promptFile, "Open PR aligning acme.ai FAQ with the DPA", "utf8");
    const startCmd = `claude "$(cat '${promptFile}')"; rm -f '${promptFile}'`;

    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-stranded1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-stranded1"]), REAL_CHROME_PANE, startCmd);
    const feature = createTalkFeature(exec);

    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.stranded"]).toEqual([
      { tmuxName: "aw-stranded1", cwd: "/repo", startedAt, blockedOn: "chrome", closable: true, promptHead: "Open PR aligning acme.ai FAQ with the DPA", lastLine: expect.any(String) },
    ]);
  });

  it("a binding under STRANDED_AFTER_MS is not stranded", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-young1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-young1"]), REAL_EMPTY_PROMPT_PANE);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"]).toEqual([]);
  });

  it("a session that appears in that cwd after the binding gets adopted and drops out of stranded", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-adopted1", cwd: "/repo", startedAt }]);
    ctx.db.upsertSession({
      id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      cwd: "/repo",
      islandId: "repo",
      title: "real transcript",
      startedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
      lastActive: new Date().toISOString(),
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
    });
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-adopted1"]), REAL_EMPTY_PROMPT_PANE);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.stranded"]).toEqual([]);
    expect(extras["talk.bindings"]).toEqual([{ agentId: "cccccccc-cccc-4ccc-cccc-cccccccccccc", tmuxName: "aw-adopted1", cwd: "/repo", startedAt }]);
  });

  // Regression (PR #29 review): two null bindings in one cwd refused adoption for BOTH, forever, so
  // a live agent sat in the stranded list (and Close could kill it). Now each binding adopts the
  // session whose first message carries its own prompt — here the start times alone would cross
  // them: aw-first1's claude came up right after aw-second1 was dispatched.
  it("two null bindings sharing a cwd: each adopts the session carrying its own prompt, even when start times would cross them", async () => {
    const first = ago(30 * 60_000);
    const second = plus(first, 60_000);
    const { ctx } = await setup([
      { agentId: null, tmuxName: "aw-first1", cwd: "/repo", startedAt: first },
      { agentId: null, tmuxName: "aw-second1", cwd: "/repo", startedAt: second },
    ]);
    const a = await dispatchPromptFile("11111111-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "Refactor the session loader module");
    const b = await dispatchPromptFile("22222222-bbbb-4bbb-bbbb-bbbbbbbbbbbb", "Write the release notes for v2.4");
    addSession(ctx.db, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", plus(second, 1_000), "Refactor the session loader module");
    addSession(ctx.db, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", plus(second, 120_000), "Write the release notes for v2.4");
    const cmds: Record<string, string> = { "aw-first1": a.startCmd, "aw-second1": b.startCmd };
    const exec: TalkExec = { ...fakeExec("/usr/bin/tmux", new Set(["aw-first1", "aw-second1"]), REAL_EMPTY_PROMPT_PANE), startCommand: async (_t, name) => cmds[name] ?? "" };
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([
      { agentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", tmuxName: "aw-first1", cwd: "/repo", startedAt: first },
      { agentId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", tmuxName: "aw-second1", cwd: "/repo", startedAt: second },
    ]);
    expect(extras["talk.stranded"]).toEqual([]);
  });

  it("one stuck dispatch never blocks a later one in the same cwd (no prompts: closest start time wins)", async () => {
    const stuck = ago(34 * 60 * 60_000);
    const later = ago(5 * 60_000);
    const { ctx } = await setup([
      { agentId: null, tmuxName: "aw-stuck1", cwd: "/repo", startedAt: stuck },
      { agentId: null, tmuxName: "aw-later1", cwd: "/repo", startedAt: later },
    ]);
    addSession(ctx.db, "cccccccc-cccc-4ccc-cccc-cccccccccccc", plus(later, 2_000), "real transcript");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-stuck1", "aw-later1"]), REAL_EMPTY_PROMPT_PANE);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([
      { agentId: null, tmuxName: "aw-stuck1", cwd: "/repo", startedAt: stuck },
      { agentId: "cccccccc-cccc-4ccc-cccc-cccccccccccc", tmuxName: "aw-later1", cwd: "/repo", startedAt: later },
    ]);
    expect(extras["talk.stranded"].map((x) => x.tmuxName)).toEqual(["aw-stuck1"]);
  });

  // Regression (PR #29 review): the window was unbounded, so a dispatch stuck for 34h adopted an
  // unrelated session that started in the same project a day later.
  it("without its prompt as proof, a session starting more than ADOPT_WINDOW_MS after the dispatch is never adopted", async () => {
    const startedAt = ago(34 * 60 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-late1", cwd: "/repo", startedAt }]);
    const p = await dispatchPromptFile("33333333-cccc-4ccc-cccc-cccccccccccc", "Open PR aligning acme.ai FAQ with the DPA");
    addSession(ctx.db, "dddddddd-dddd-4ddd-dddd-dddddddddddd", plus(startedAt, ADOPT_WINDOW_MS + 60_000), "fix the flaky build");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-late1"]), REAL_EMPTY_PROMPT_PANE, p.startCmd);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([{ agentId: null, tmuxName: "aw-late1", cwd: "/repo", startedAt }]);
    expect(extras["talk.stranded"].map((x) => x.tmuxName)).toEqual(["aw-late1"]);
  });

  it("a session carrying the dispatch's prompt is adopted even long after the window (a trust dialog answered late)", async () => {
    const startedAt = ago(3 * 60 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-trust1", cwd: "/repo", startedAt }]);
    const p = await dispatchPromptFile("44444444-dddd-4ddd-dddd-dddddddddddd", "Open PR aligning acme.ai FAQ with the DPA");
    addSession(ctx.db, "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee", plus(startedAt, 2 * 60 * 60_000), "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-trust1"]), REAL_EMPTY_PROMPT_PANE, p.startCmd);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[] };
    expect(extras["talk.bindings"]).toEqual([{ agentId: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee", tmuxName: "aw-trust1", cwd: "/repo", startedAt }]);
  });

  // Regression (PR #29 review, MEDIUM): a prompt match skipped the window and was a substring
  // anywhere, at any length, so "fix" adopted an unrelated session started 34h later.
  it("a short prompt found somewhere in a late session's first message is no proof: the window still applies", async () => {
    const startedAt = ago(35 * 60 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-stuck9", cwd: "/repo", startedAt }]);
    const p = await dispatchPromptFile("45454545-dddd-4ddd-dddd-dddddddddddd", "fix");
    addSession(ctx.db, "46464646-eeee-4eee-eeee-eeeeeeeeeeee", plus(startedAt, 34 * 60 * 60_000), "please fix the flaky login test");
    const feature = createTalkFeature(fakeExec("/usr/bin/tmux", new Set(["aw-stuck9"]), REAL_EMPTY_PROMPT_PANE, p.startCmd));
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[] };
    expect(extras["talk.bindings"]).toEqual([{ agentId: null, tmuxName: "aw-stuck9", cwd: "/repo", startedAt }]);
  });

  // Regression (PR #29 review, S2): the retry still on its trust dialog took the session its
  // answered twin was running, and the twin was relisted as stranded (and Close killed it).
  it("a retry of the same prompt still on its trust dialog never takes the session its answered twin is running", async () => {
    const older = ago(40 * 60_000);
    const newer = plus(older, 20 * 60_000);
    const { ctx } = await setup([
      { agentId: null, tmuxName: "aw-older02", cwd: "/repo", startedAt: older },
      { agentId: null, tmuxName: "aw-newer02", cwd: "/repo", startedAt: newer },
    ]);
    const prompt = "Open PR aligning acme.ai FAQ with the DPA";
    const a = await dispatchPromptFile("47474747-aaaa-4aaa-aaaa-aaaaaaaaaaaa", prompt);
    const b = await dispatchPromptFile("48484848-bbbb-4bbb-bbbb-bbbbbbbbbbbb", prompt);
    addSession(ctx.db, "49494949-cccc-4ccc-cccc-cccccccccccc", plus(newer, 60_000), prompt);
    const cmds: Record<string, string> = { "aw-older02": a.startCmd, "aw-newer02": b.startCmd };
    const panes: Record<string, string> = { "aw-older02": REAL_EMPTY_PROMPT_PANE, "aw-newer02": REAL_TRUST_DIALOG_PANE };
    const exec: TalkExec = {
      ...fakeExec("/usr/bin/tmux", new Set(["aw-older02", "aw-newer02"])),
      capture: async (_t, name) => panes[name] ?? "",
      startCommand: async (_t, name) => cmds[name] ?? "",
    };
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([
      { agentId: "49494949-cccc-4ccc-cccc-cccccccccccc", tmuxName: "aw-older02", cwd: "/repo", startedAt: older },
      { agentId: null, tmuxName: "aw-newer02", cwd: "/repo", startedAt: newer },
    ]);
    expect(extras["talk.stranded"].map((x) => [x.tmuxName, x.blockedOn])).toEqual([["aw-newer02", "trust"]]);
  });

  // Regression (PR #29 review, MEDIUM): a dispatch that was never stuck, whose agent is using
  // browser tools, was not adopted and was listed as stranded on "the Chrome prompt".
  it("adopts a working agent whose screen shows Claude in Chrome tool lines, and never lists it", async () => {
    const startedAt = ago(3 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-brow2", cwd: "/repo", startedAt }]);
    const prompt = "Open PR aligning acme.ai FAQ with the DPA";
    const p = await dispatchPromptFile("5a5a5a5a-aaaa-4aaa-aaaa-aaaaaaaaaaaa", prompt);
    addSession(ctx.db, "5b5b5b5b-bbbb-4bbb-bbbb-bbbbbbbbbbbb", plus(startedAt, 5_000), prompt);
    const feature = createTalkFeature(fakeExec("/usr/bin/tmux", new Set(["aw-brow2"]), WORKING_BROWSER_PANE, p.startCmd));
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([{ agentId: "5b5b5b5b-bbbb-4bbb-bbbb-bbbbbbbbbbbb", tmuxName: "aw-brow2", cwd: "/repo", startedAt }]);
    expect(extras["talk.stranded"]).toEqual([]);
  });

  // Regression (PR #29 review): onTick saved a list built from its own start-of-tick snapshot, so
  // a binding a dispatch saved during the tick's awaits was overwritten, and that session could
  // never be reached by Talk, listed or closed.
  it("a binding saved while a tick is mid-flight survives that tick's save", async () => {
    const startedAt = ago(30 * 60_000);
    const { ctx } = await setup([
      { agentId: null, tmuxName: "aw-gone3", cwd: "/repo", startedAt },
      { agentId: null, tmuxName: "aw-wait3", cwd: "/repo", startedAt },
    ]);
    // An unbound session in /repo makes the tick read aw-wait3's start command, where it waits.
    addSession(ctx.db, "50505050-dddd-4ddd-dddd-dddddddddddd", plus(startedAt, ADOPT_WINDOW_MS + 60_000), "something else entirely");
    const release: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolvePromise) => {
      release.current = resolvePromise;
    });
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-wait3"]), REAL_CHROME_PANE);
    const exec: TalkExec = {
      ...base0,
      // Only the tick's read waits: the new launch's own reads (it lists its Chrome dialog at
      // once, see listStrandedNow) must not, or the launch would never return to release it.
      async startCommand(_tmux, name) {
        if (name === "aw-wait3") await gate;
        return "";
      },
    };
    const feature = createTalkFeature(exec);
    const tick = feature.onTick?.(ctx);
    await new Promise((r) => setTimeout(r, 20)); // let the tick reach the gate

    const started = await startWorldSession(ctx, "/elsewhere", "claude", { plan: false });
    if (!started.ok) throw new Error(started.error);
    release.current?.();
    await tick;

    const names = (JSON.parse(ctx.db.getMeta("talk.bindings") ?? "[]") as TalkBinding[]).map((b) => b.tmuxName);
    expect(names).toContain(started.tmuxName);
    expect(names).toContain("aw-wait3");
    expect(names).not.toContain("aw-gone3"); // the tick's own change still applies
  });

  // Regression (PR #29 review): adoption allowed 5s of slack before the binding, so a session the
  // user had started just before the dispatch could be claimed by it.
  it("never adopts a session that started before the binding", async () => {
    const startedAt = ago(30 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-older2", cwd: "/repo", startedAt }]);
    addSession(ctx.db, "ffffffff-ffff-4fff-ffff-ffffffffffff", plus(startedAt, -2_000), "real transcript");
    const feature = createTalkFeature(fakeExec("/usr/bin/tmux", new Set(["aw-older2"]), REAL_EMPTY_PROMPT_PANE));
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[] })["talk.bindings"]).toEqual([{ agentId: null, tmuxName: "aw-older2", cwd: "/repo", startedAt }]);
  });

  it("waits for a session's first user message to be indexed before adopting it", async () => {
    const startedAt = ago(60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-wait1", cwd: "/repo", startedAt }]);
    addSession(ctx.db, "abababab-abab-4bab-abab-abababababab", plus(startedAt, 1_000), "");
    const feature = createTalkFeature(fakeExec("/usr/bin/tmux", new Set(["aw-wait1"]), REAL_EMPTY_PROMPT_PANE));
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[] })["talk.bindings"][0]?.agentId).toBeNull();
  });

  // Regression (PR #29 review): computeStranded used to re-check aliveness itself (has-session)
  // even though onTick's own adoption loop had just made that exact call for every binding it
  // hands to computeStranded — doubling tmux exec calls for no reason.
  it("checks a binding's aliveness only once per tick, not once per adoption pass plus once per computeStranded", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-once1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-once1"]), REAL_EMPTY_PROMPT_PANE);
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const hasSessionCalls = exec.calls.filter((c) => c.args[0] === "has-session" && c.args[2] === "=aw-once1");
    expect(hasSessionCalls).toHaveLength(1);
  });

  // Regression (PR #29 review): a fork opened via ▶ Launch (fork.ts's worldPlanLauncher) starts
  // `claude --permission-mode plan` with no prompt file, and no transcript exists until the user
  // types — that is the user opening a session on purpose, not a failed unattended dispatch.
  it("a promptless fork (▶ Launch's plain PLAN_COMMAND) never shows up as stranded", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-fork1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-fork1"]), REAL_EMPTY_PROMPT_PANE, "claude --permission-mode plan");
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"]).toEqual([]);
  });

  it("a dead tmux session (has-session failing) drops both the binding and any stranded entry", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-dead1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(), REAL_EMPTY_PROMPT_PANE); // never marked alive
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const extras = feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[]; "talk.stranded": StrandedDispatch[] };
    expect(extras["talk.bindings"]).toEqual([]);
    expect(extras["talk.stranded"]).toEqual([]);
  });

  it("the talk.stranded key is present in the snapshot even before any tick runs", async () => {
    const { ctx } = await setup([]);
    const feature = createTalkFeature(fakeExec(null));
    expect(feature.snapshotExtras?.(ctx)).toHaveProperty("talk.stranded", []);
  });

  function strandedEmits(sent: readonly unknown[]): unknown[] {
    return sent.filter((m) => typeof m === "object" && m !== null && (m as { payload?: { kind?: string } }).payload?.kind === "stranded");
  }

  // Regression (PR #29 review): the test that claimed to cover "broadcast on change" wired an
  // unreturned, never-observed array into ctx (see setup()'s fix above), so it never actually
  // asserted anything about emits — a regression here would have gone unnoticed.
  it("emits {kind:'stranded'} once when the list changes, and not again on an unchanged repeat tick", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx, sent } = await setup([{ agentId: null, tmuxName: "aw-emit1", cwd: "/repo", startedAt }]);
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-emit1"]), REAL_EMPTY_PROMPT_PANE);
    const feature = createTalkFeature(exec);

    await feature.onTick?.(ctx); // [] -> [aw-emit1]: one emit
    expect(strandedEmits(sent)).toHaveLength(1);

    await feature.onTick?.(ctx); // identical tick: nothing client-visible changed
    expect(strandedEmits(sent)).toHaveLength(1);
  });

  // Regression (PR #29 review): lastLine is included in the change diff even though no client
  // renders it, so a spinner/status line ticking over in an otherwise-unchanged pane would
  // broadcast and force a full Inbox rebuild every 15s for no visible difference.
  it("does not emit again when only the pane's last line changes", async () => {
    const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
    const { ctx, sent } = await setup([{ agentId: null, tmuxName: "aw-lastline1", cwd: "/repo", startedAt }]);
    let pane = REAL_EMPTY_PROMPT_PANE;
    const base = fakeExec("/usr/bin/tmux", new Set(["aw-lastline1"]));
    const exec: TalkExec = { ...base, capture: async () => pane, captureAll: async () => pane };
    const feature = createTalkFeature(exec);

    await feature.onTick?.(ctx);
    expect(strandedEmits(sent)).toHaveLength(1);
    const before = (feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0];
    expect(before?.blockedOn).toBe("empty-prompt");

    // Same blockedOn ("empty-prompt": the ❯ line above it is untouched), only the trailing
    // status line differs.
    pane = REAL_EMPTY_PROMPT_PANE.replace("← for agents", "← for agents ✦");
    await feature.onTick?.(ctx);
    expect(strandedEmits(sent)).toHaveLength(1); // still just the one emit
    const after = (feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0];
    expect(after?.blockedOn).toBe("empty-prompt");
    expect(after?.lastLine).toContain("✦"); // the stored copy still refreshes, it just doesn't re-broadcast
  });

  // Regression (PR #29 review, HIGH): the screen is read from the active pane only, but Close runs
  // kill-session on the whole session, so a trust dialog in a session that also held another window
  // or pane was offered Close. Only exactly one window with one pane is closable.
  it.each([
    ["1 1", true],
    ["2 1", false],
    ["1 2", false],
    ["  ", false], // tmux's blank fields for a target that no longer exists — never a real "1 1"
    [null, false],
  ] as const)("a trust-dialog row whose session reports %s windows/panes is listed closable: %s", async (counts, closable) => {
    const startedAt = ago(30 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-split1", cwd: "/repo", startedAt }]);
    const p = await dispatchPromptFile("f0f0f0f0-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec: TalkExec = {
      ...fakeExec("/usr/bin/tmux", new Set(["aw-split1"]), REAL_TRUST_DIALOG_PANE, p.startCmd),
      async paneCounts() {
        if (counts === null) throw new Error("tmux could not say");
        return counts;
      },
    };
    const feature = createTalkFeature(exec);
    await feature.onTick?.(ctx);
    const row = (feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0];
    expect(row?.blockedOn).toBe("trust");
    expect(row?.closable).toBe(closable);
  });

  it("a screen a working agent also shows is never closable, even in a one-window, one-pane session", async () => {
    const startedAt = ago(30 * 60_000);
    const { ctx } = await setup([{ agentId: null, tmuxName: "aw-split2", cwd: "/repo", startedAt }]);
    const p = await dispatchPromptFile("f1f1f1f1-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const feature = createTalkFeature(fakeExec("/usr/bin/tmux", new Set(["aw-split2"]), REAL_EMPTY_PROMPT_PANE, p.startCmd));
    await feature.onTick?.(ctx);
    const row = (feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0];
    expect(row?.blockedOn).toBe("empty-prompt");
    expect(row?.closable).toBe(false);
  });
});

describe("POST /api/talk/stranded/:tmuxName/attach and /close", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const post = (base: string, path: string): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" } });

  let trashHome = "";
  afterEach(async () => {
    if (trashHome) {
      await rm(trashHome, { recursive: true, force: true });
      trashHome = "";
    }
  });

  // Boots a real server around `exec`'s feature instance, seeds one old-enough alive binding
  // ("aw-route1" unless `name` overrides it), then drives that SAME feature instance's onTick
  // directly (against the server's real db) so its stranded list is populated before the routes
  // below — which read that instance's private `stranded` closure — are ever hit over HTTP.
  // Scrollback saves land under a fresh temp dir (`trashHome`), never the real ~/.alef-trash.
  async function bootStranded(
    exec: TalkExec,
    startedAtMsAgo: number,
    name = "aw-route1",
    seed?: (db: WorldDb, startedAt: string) => void,
  ): Promise<{ base: string; feature: ServerFeature; ctx: FeatureContext; trashHome: string; emitted: unknown[]; projectsDir: string }> {
    trashHome = await makeTempProjectsDir();
    const feature = createTalkFeature(exec, () => Date.now(), { home: trashHome });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    const startedAt = new Date(Date.now() - startedAtMsAgo).toISOString();
    b.server.db.setMeta("talk.bindings", JSON.stringify([{ agentId: null, tmuxName: name, cwd: "/repo", startedAt }]));
    seed?.(b.server.db, startedAt);
    const emitted: unknown[] = [];
    // Matches how bootTestServer (helpers.ts) built its own config's projectsDir.
    const ctx = {
      db: b.server.db,
      config: { projectsDir: join(b.dir, "projects") },
      broadcast: () => {},
      emit: (payload: unknown) => emitted.push(payload),
    } as unknown as FeatureContext;
    await feature.onTick?.(ctx);
    return { base: b.base, feature, ctx, trashHome, emitted, projectsDir: join(b.dir, "projects") };
  }

  it("400 on a malformed tmux name for both routes", async () => {
    const { base } = await bootStranded(fakeExec("/usr/bin/tmux"), 34 * 60 * 60 * 1000);
    expect((await post(base, "/api/talk/stranded/not-a-name/attach")).status).toBe(400);
    expect((await post(base, "/api/talk/stranded/not-a-name/close")).status).toBe(400);
  });

  it("404 for a well-formed but unknown/non-stranded name", async () => {
    const { base } = await bootStranded(fakeExec("/usr/bin/tmux"), 34 * 60 * 60 * 1000);
    expect((await post(base, "/api/talk/stranded/aw-nosuch1/attach")).status).toBe(404);
    expect((await post(base, "/api/talk/stranded/aw-nosuch1/close")).status).toBe(404);
  });

  it("attach on a genuinely stranded session opens Terminal attached, never sending keys", async () => {
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_EMPTY_PROMPT_PANE);
    const { base } = await bootStranded(exec, 34 * 60 * 60 * 1000);
    const r = (await (await post(base, "/api/talk/stranded/aw-route1/attach")).json()) as TalkActionResult;
    expect(r).toEqual({ ok: true, tmuxName: "aw-route1" });
    expect(exec.terminals).toEqual(["'/usr/bin/tmux' attach -t '=aw-route1'"]);
    expect(exec.calls.some((c) => c.args[0] === "send-keys")).toBe(false);
  });

  it("close on a stranded session kills it atomically (pane-count re-check + kill in one tmux command) via argv only, and drops the binding", async () => {
    const p = await dispatchPromptFile("55555555-eeee-4eee-eeee-eeeeeeeeeeee", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base } = await bootStranded(exec, 34 * 60 * 60 * 1000);
    const r = (await (await post(base, "/api/talk/stranded/aw-route1/close")).json()) as TalkActionResult;
    expect(r).toEqual({ ok: true, tmuxName: "aw-route1" });
    const kill = exec.calls.find((c) => c.args[0] === "if-shell");
    expect(kill?.args).toEqual(killIfSinglePaneCommand("aw-route1"));
    expect(kill?.args).toEqual([
      "if-shell",
      "-F",
      "-t",
      "=aw-route1:",
      "#{&&:#{==:#{session_windows},1},#{==:#{window_panes},1}}",
      "kill-session -t =aw-route1",
    ]);
    // No separate, non-atomic kill-session call was made — the atomic command IS the kill.
    expect(exec.calls.some((c) => c.args[0] === "kill-session")).toBe(false);
    const status = (await (await fetch(`${base}/api/talk/status`)).json()) as TalkStatus;
    expect(status.bindings).toEqual([]);
  });

  // Regression (PR #29 review): unlike cleanup.ts's own closeDeadTmux, the close route used to
  // kill the session with no save at all — destroying the only copy of a pane's unread output.
  it("close saves the whole scrollback to the trash before killing, and cleans up its prompt file", async () => {
    const dispatchFileDir = dispatchDir();
    await mkdir(dispatchFileDir, { recursive: true });
    const promptFile = join(dispatchFileDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.txt");
    await writeFile(promptFile, "Open PR aligning acme.ai FAQ with the DPA", "utf8");
    const startCmd = `claude "$(cat '${promptFile}')"; rm -f '${promptFile}'`;
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, startCmd);
    const { base, trashHome } = await bootStranded(exec, 34 * 60 * 60 * 1000);

    const r = (await (await post(base, "/api/talk/stranded/aw-route1/close")).json()) as TalkActionResult;
    expect(r).toEqual({ ok: true, tmuxName: "aw-route1" });

    // The full scrollback (`capture-pane -p -S -`), not just the visible pane, saved BEFORE the
    // kill — kill-session already happened by the time we assert, so this also proves ordering
    // (a failed save never blindly followed by a kill in this test's exec, since it succeeded).
    const savedPath = join(trashRootOf(trashHome), trashDateKey(new Date()), "tmux", "aw-route1.txt");
    expect(await readFile(savedPath, "utf8")).toBe(REAL_CHROME_PANE);

    // The dispatch's own `; rm -f <file>` never runs (kill-session SIGHUPs its shell first), so
    // the route recovers and removes the prompt file itself instead of leaving it behind.
    await expect(readFile(promptFile, "utf8")).rejects.toThrow();
  });

  /** Every kill attempt `exec` recorded — the atomic if-shell+kill (killIfSinglePaneCommand) AND
   *  any bare kill-session/kill-window/kill-pane/kill-server call, so a future regression that
   *  killed outside the atomic command would still be caught here. Empty means Close never even
   *  attempted a kill (refused earlier), non-empty means it tried, whether or not tmux's own
   *  condition actually let the atomic kill through. */
  function kills(exec: { calls: Call[] }): string[] {
    return exec.calls
      .filter((c) => c.args[0] === "if-shell" || /^kill-(session|window|pane|server)$/.test(String(c.args[0])))
      .map((c) => (c.args[0] === "if-shell" ? String(c.args[3]) : c.args.join(" ")));
  }

  // Regression (review of PR #33, MEDIUM): kills() used to match only "if-shell", so a bare
  // kill-session/kill-window/kill-pane/kill-server call — one that bypassed the atomic command
  // entirely — would slip past every `expect(kills(exec)).toEqual([])` refusal assertion in this
  // file undetected. Confirmed by mutation: adding a bare kill-session call inside talk.ts's
  // refusal branches left all tests on this branch green until this test (and the fix) existed.
  it("kills() also catches a bare kill-session/kill-window/kill-pane/kill-server call, not just if-shell", async () => {
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-bare1"]));
    await exec.run("/usr/bin/tmux", ["kill-session", "-t", "=aw-bare1"]);
    expect(kills(exec)).not.toEqual([]);
  });

  // Regression (PR #29 review, HIGH): with two agentId-null bindings in one cwd, adoption was
  // refused for both, so a LIVE agent was listed as stranded and Close killed it. Now it is
  // adopted, never listed, and Close refuses it. While it works in that project, Close refuses
  // the genuinely stuck one too: it cannot prove which pane runs that session, so it never guesses.
  it("two null bindings in one cwd: the live agent is adopted, and Close kills neither while it works there", async () => {
    const stuck = await dispatchPromptFile("66666666-ffff-4fff-ffff-ffffffffffff", "Refactor the session loader module");
    const live = await dispatchPromptFile("77777777-abab-4bab-abab-abababababab", "Write the release notes for v2.4");
    const cmds: Record<string, string> = { "aw-stuck2": stuck.startCmd, "aw-live2": live.startCmd };
    const panes: Record<string, string> = { "aw-stuck2": REAL_CHROME_PANE, "aw-live2": REAL_EMPTY_PROMPT_PANE };
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-stuck2", "aw-live2"]));
    const exec: TalkExec & { calls: Call[] } = {
      ...base0,
      capture: async (_t, name) => panes[name] ?? "",
      captureAll: async (_t, name) => panes[name] ?? "",
      startCommand: async (_t, name) => cmds[name] ?? "",
    };
    const { base } = await bootStranded(exec, 34 * 60 * 60_000, "aw-stuck2", (db, stuckAt) => {
      const liveAt = ago(30 * 60_000);
      db.setMeta(
        "talk.bindings",
        JSON.stringify([
          { agentId: null, tmuxName: "aw-stuck2", cwd: "/repo", startedAt: stuckAt },
          { agentId: null, tmuxName: "aw-live2", cwd: "/repo", startedAt: liveAt },
        ]),
      );
      addSession(db, "12121212-1212-4212-9212-121212121212", plus(liveAt, 3_000), "Write the release notes for v2.4");
    });

    const refused = await post(base, "/api/talk/stranded/aw-live2/close");
    expect(refused.status).toBe(409);
    expect(kills(exec)).toEqual([]);

    const stuckRes = await post(base, "/api/talk/stranded/aw-stuck2/close");
    expect(stuckRes.status).toBe(409);
    expect(((await stuckRes.json()) as TalkActionResult).error).toContain("active since it was dispatched");
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review): the route stopped checking membership in the computed stranded
  // list and authorized off the binding alone — so a binding never listed (too young, a
  // promptless fork, or before any tick) could be killed.
  it("refuses (409) a binding that is not in the computed stranded list, and kills nothing", async () => {
    const freshTrashHome = await makeTempProjectsDir();
    try {
      const p = await dispatchPromptFile("88888888-cdcd-4dcd-8dcd-cdcdcdcdcdcd", "Open PR aligning acme.ai FAQ with the DPA");
      const exec = fakeExec("/usr/bin/tmux", new Set(["aw-fresh1"]), REAL_EMPTY_PROMPT_PANE, p.startCmd);
      const feature = createTalkFeature(exec, () => Date.now(), { home: freshTrashHome });
      const b = await bootTestServer({ configOverrides: { features: [feature] } });
      server = b.server;
      const startedAt = new Date(Date.now() - 34 * 60 * 60 * 1000).toISOString();
      b.server.db.setMeta("talk.bindings", JSON.stringify([{ agentId: null, tmuxName: "aw-fresh1", cwd: "/repo", startedAt }]));

      const res = await post(b.base, "/api/talk/stranded/aw-fresh1/close"); // no tick yet: stranded is []
      expect(res.status).toBe(409);
      expect(kills(exec)).toEqual([]);
      const status = (await (await fetch(`${b.base}/api/talk/status`)).json()) as TalkStatus;
      expect(status.bindings).toHaveLength(1);
    } finally {
      await rm(freshTrashHome, { recursive: true, force: true });
    }
  });

  it("refuses when the pane no longer classifies as it was listed (e.g. the trust dialog was answered)", async () => {
    const p = await dispatchPromptFile("99999999-efef-4fef-8fef-efefefefefef", "Open PR aligning acme.ai FAQ with the DPA");
    let pane = REAL_TRUST_DIALOG_PANE;
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = { ...base0, capture: async () => pane, captureAll: async () => pane };
    const { base, feature, ctx } = await bootStranded(exec, 34 * 60 * 60_000);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0]?.blockedOn).toBe("trust");

    pane = REAL_EMPTY_PROMPT_PANE; // answered in Terminal since the last tick: now a running claude
    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("trust → empty-prompt");
    expect(kills(exec)).toEqual([]);
  });

  it("refuses when a session carrying its prompt was indexed after the last tick", async () => {
    const p = await dispatchPromptFile("aaaaaaaa-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, ctx } = await bootStranded(exec, 34 * 60 * 60_000);
    const binding = (JSON.parse(ctx.db.getMeta("talk.bindings") ?? "[]") as TalkBinding[])[0];
    addSession(ctx.db, "bcbcbcbc-bcbc-4cbc-bcbc-bcbcbcbcbcbc", plus(binding?.startedAt ?? "", 60 * 60_000), "Open PR aligning acme.ai FAQ with the DPA");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  it("refuses when an in-window session in its cwd could be its transcript, even before its first message is indexed", async () => {
    const p = await dispatchPromptFile("bbbbbbbb-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, ctx } = await bootStranded(exec, 5 * 60_000);
    const binding = (JSON.parse(ctx.db.getMeta("talk.bindings") ?? "[]") as TalkBinding[])[0];
    addSession(ctx.db, "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", plus(binding?.startedAt ?? "", 30_000), "");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, S1): a working claude pane classifies as "empty-prompt" (the input
  // box under the spinner), so a dispatch whose user typed the task in their own words, past the
  // window, stayed listed and Close killed the live agent. Those screens are never closable now,
  // even before the agent's session is indexed (no session at all here).
  it.each([
    ["empty-prompt", REAL_EMPTY_PROMPT_PANE],
    ["menu", " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend"],
    ["unknown", "just some ordinary output\nwith nothing recognizable"],
  ])("refuses a row on a %s screen, which a working agent also shows, and saves nothing", async (blockedOn, pane) => {
    const p = await dispatchPromptFile("d1d1d1d1-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-stuck01"]), pane, p.startCmd);
    const { base, feature, ctx, trashHome } = await bootStranded(exec, 24 * 60 * 60_000, "aw-stuck01");
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0]?.blockedOn).toBe(blockedOn);

    const res = await post(base, "/api/talk/stranded/aw-stuck01/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("exit it in Terminal");
    expect(kills(exec)).toEqual([]);
    await expect(readFile(join(trashRootOf(trashHome), trashDateKey(new Date()), "tmux", "aw-stuck01.txt"), "utf8")).rejects.toThrow();
  });

  // Regression (PR #29 review, S3): past the window, a session whose first message wasn't indexed
  // yet had no title to match and was ignored, so Close killed the pane it was running in.
  it("refuses while a session in its project is active, even one started long after it with no title yet", async () => {
    const p = await dispatchPromptFile("d3d3d3d3-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, ctx } = await bootStranded(exec, 30 * 60_000);
    addSession(ctx.db, "d4d4d4d4-1212-4212-9212-121212121212", ago(20_000), "");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, S4): resuming an older conversation in the stranded pane gave a
  // session that started BEFORE the binding, which the adoption check never counted.
  it("refuses while a session that started before it (a resumed conversation) is active in its project", async () => {
    const p = await dispatchPromptFile("d5d5d5d5-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, ctx } = await bootStranded(exec, 30 * 60_000);
    addSession(ctx.db, "d6d6d6d6-1212-4212-9212-121212121212", ago(3 * 60 * 60_000), "an older conversation");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, S2): Close skipped sessions already bound to another binding, and
  // adoption can bind a session to the wrong pane, so a live agent's pane was killable.
  it("refuses while a session bound to another binding is active in its project", async () => {
    const p = await dispatchPromptFile("d7d7d7d7-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1", "aw-other5"]), REAL_CHROME_PANE, p.startCmd);
    const { base } = await bootStranded(exec, 30 * 60_000, "aw-route1", (db, startedAt) => {
      const sessionId = "d8d8d8d8-1212-4212-9212-121212121212";
      db.setMeta(
        "talk.bindings",
        JSON.stringify([
          { agentId: null, tmuxName: "aw-route1", cwd: "/repo", startedAt },
          { agentId: sessionId, tmuxName: "aw-other5", cwd: "/repo", startedAt: plus(startedAt, 60_000) },
        ]),
      );
      addSession(db, sessionId, plus(startedAt, 120_000), "Open PR aligning acme.ai FAQ with the DPA");
    });

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  it("still closes when the only sessions are in other projects or went quiet before it was dispatched", async () => {
    const p = await dispatchPromptFile("d9d9d9d9-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const { base, ctx } = await bootStranded(exec, 30 * 60_000);
    addSession(ctx.db, "dadadada-1212-4212-9212-121212121212", ago(5 * 60 * 60_000), "an old one", "/repo", ago(4 * 60 * 60_000));
    addSession(ctx.db, "dbdbdbdb-1212-4212-9212-121212121212", ago(60_000), "busy elsewhere", "/other");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(200);
    expect(kills(exec)).toEqual(["=aw-route1:"]);
  });

  // Regression (PR #29 review, HIGH, ADV1): the agent's first transcript line exists on disk but
  // the indexer (every 10s) has not made a sessions row for it yet. Close only asked the sessions
  // table, so it killed the pane. The pane here still reads "chrome", to test the disk check alone.
  it.each(["-repo", "-repo-apps-web"])("refuses while a transcript in %s was written since the dispatch, before the index has it", async (projectDir) => {
    const p = await dispatchPromptFile("e1e1e1e1-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-adv1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, projectsDir } = await bootStranded(exec, 3 * 60_000, "aw-adv1");
    await mkdir(join(projectsDir, projectDir), { recursive: true });
    const line = userLine({ cwd: "/repo", timestamp: new Date().toISOString(), text: "Open PR aligning acme.ai FAQ with the DPA" });
    await writeFile(join(projectsDir, projectDir, "e2e2e2e2-1212-4212-9212-121212121212.jsonl"), `${line}\n`);

    const res = await post(base, "/api/talk/stranded/aw-adv1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("transcript in this project has been written");
    expect(kills(exec)).toEqual([]);
  });

  it("still closes when the project's transcripts were all last written before the dispatch", async () => {
    const p = await dispatchPromptFile("e3e3e3e3-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, projectsDir } = await bootStranded(exec, 30 * 60_000);
    const old = join(projectsDir, "-repo", "e4e4e4e4-1212-4212-9212-121212121212.jsonl");
    await mkdir(join(projectsDir, "-repo"), { recursive: true });
    await writeFile(old, `${userLine({ cwd: "/repo", timestamp: ago(2 * 60 * 60_000), text: "an old one" })}\n`);
    const before = new Date(Date.now() - 60 * 60_000);
    await utimes(old, before, before);

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(200);
    expect(kills(exec)).toEqual(["=aw-route1:"]);
  });

  // Regression (PR #29 review, HIGH): after "Yes, use my browser" the agent's "Claude in
  // Chrome[...]" tool lines still read as "chrome", equal to the listed row, so Close went ahead.
  it("refuses once a Chrome row's pane shows the agent working, even with nothing indexed or on disk", async () => {
    const p = await dispatchPromptFile("e5e5e5e5-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    let pane = REAL_CHROME_PANE;
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = { ...base0, capture: async () => pane, captureAll: async () => pane };
    const { base, feature, ctx } = await bootStranded(exec, 3 * 60_000);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0]?.blockedOn).toBe("chrome");

    pane = WORKING_BROWSER_PANE;
    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("chrome → empty-prompt");
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, LOW): every refused Close saved another full scrollback copy to
  // ~/.alef-trash before checking anything.
  it("a refused Close saves no scrollback", async () => {
    const p = await dispatchPromptFile("e6e6e6e6-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, p.startCmd);
    const { base, ctx, trashHome } = await bootStranded(exec, 30 * 60_000);
    addSession(ctx.db, "e7e7e7e7-1212-4212-9212-121212121212", ago(20_000), "");

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
    await expect(readFile(join(trashRootOf(trashHome), trashDateKey(new Date()), "tmux", "aw-route1.txt"), "utf8")).rejects.toThrow();
  });

  // Regression (PR #29 review, HIGH): Close checked only the active pane's screen, then ran
  // kill-session on the whole session, ending any other window or pane in it too.
  it.each(["2 1", "1 2"])("refuses (409) once the session has other windows/panes (%s), and saves and kills nothing", async (split) => {
    const p = await dispatchPromptFile("f2f2f2f2-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    let counts = "1 1";
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = { ...base0, paneCounts: async () => counts };
    const { base, feature, ctx, trashHome } = await bootStranded(exec, 30 * 60_000);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"][0]?.closable).toBe(true);

    counts = split; // a window or pane was opened in it since the last tick
    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("session has other windows/panes");
    expect(kills(exec)).toEqual([]);
    await expect(readFile(join(trashRootOf(trashHome), trashDateKey(new Date()), "tmux", "aw-route1.txt"), "utf8")).rejects.toThrow();
  });

  // Regression (PR #29 follow-up): a separate pane-count check, then a separate kill-session call,
  // left a gap in which a window or pane opened between them was killed along with the session.
  // The pane-count re-check and the kill are now ONE atomic tmux command (if-shell -F), so even a
  // split happening between the last JS-level check and the kill attempt is caught: tmux's own
  // condition is read fresh, at the instant it runs the command, not from an earlier JS-side read.
  it("the atomic kill correctly does nothing when a pane is split while its scrollback is being saved, right before it", async () => {
    const p = await dispatchPromptFile("f3f3f3f3-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    let splitHappened = false;
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = {
      ...base0,
      async captureAll(tmuxPath, name) {
        splitHappened = true; // a window/pane opens in the exact gap the atomic command closes
        return base0.captureAll(tmuxPath, name);
      },
      async run(file, args) {
        if (args[0] === "if-shell" && splitHappened) {
          base0.calls.push({ file, args }); // the attempt is made and recorded...
          return; // ...but tmux's own fresh condition read is false, so it runs neither branch
        }
        return base0.run(file, args);
      },
    };
    const { base } = await bootStranded(exec, 30 * 60_000);

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("gained a window or pane");
    expect(kills(exec)).toEqual(["=aw-route1:"]); // the atomic command WAS attempted...
    const status = (await (await fetch(`${base}/api/talk/status`)).json()) as TalkStatus;
    expect(status.bindings).toHaveLength(1); // ...but tmux's own check said no, so it survives
  });

  // Regression guard for the paneCounts validation added alongside the atomic kill: tmux prints
  // blank fields (no error) for a `display-message` target that no longer exists, and that must
  // read as "could not tell" (this message), never as "session has other windows/panes" (a real,
  // different pane count) — the two point Attach in different, misleading directions.
  it("refuses with the 'could not read' message, not 'other windows/panes', when tmux reports blank fields", async () => {
    const p = await dispatchPromptFile("f4a4a4a4-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const exec: TalkExec & { calls: Call[] } = {
      ...fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd),
      async paneCounts() {
        return "  "; // tmux's own blank-fields shape, trimmed to ""
      },
    };
    const { base } = await bootStranded(exec, 30 * 60_000);

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    const body = (await res.json()) as TalkActionResult;
    expect(body.error).toContain("could not read its windows and panes");
    expect(body.error).not.toContain("other windows/panes");
    expect(kills(exec)).toEqual([]);
  });

  it("refuses when tmux cannot report the session's windows and panes", async () => {
    const p = await dispatchPromptFile("f4f4f4f4-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    let fail = false;
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = {
      ...base0,
      async paneCounts() {
        if (fail) throw new Error("tmux could not say");
        return "1 1";
      },
    };
    const { base } = await bootStranded(exec, 30 * 60_000);

    fail = true;
    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("could not read its windows and panes");
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, LOW): the last screen read came BEFORE the DB and disk checks, so a
  // dialog answered while those ran was killed as the stuck screen it no longer showed.
  it("re-reads the screen after the DB and disk checks, as the last step before the kill", async () => {
    const p = await dispatchPromptFile("f5f5f5f5-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    let pane = REAL_TRUST_DIALOG_PANE;
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_TRUST_DIALOG_PANE, p.startCmd);
    const exec: TalkExec & { calls: Call[] } = { ...base0, capture: async () => pane, captureAll: async () => pane };
    const { base, ctx } = await bootStranded(exec, 30 * 60_000);
    // The dialog is answered in Terminal during the pre-kill check's DB read (Close's 2nd one).
    const listSessions = ctx.db.listSessions.bind(ctx.db);
    let dbReads = 0;
    ctx.db.listSessions = () => {
      dbReads += 1;
      if (dbReads === 2) pane = REAL_EMPTY_PROMPT_PANE;
      return listSessions();
    };

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(((await res.json()) as TalkActionResult).error).toContain("trust → empty-prompt");
    expect(dbReads).toBe(2);
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review, LOW, ADV3): the retry idling at an empty prompt adopted the session
  // its older twin runs, so Talk typed into the wrong claude. Now neither adopts it: Talk is 404.
  it("Talk reaches neither twin when both carry the running session's prompt", async () => {
    const prompt = "Open PR aligning acme.ai FAQ with the DPA";
    const a = await dispatchPromptFile("e8e8e8e8-1212-4212-9212-121212121212", prompt);
    const b = await dispatchPromptFile("e9e9e9e9-1212-4212-9212-121212121212", prompt);
    const sessionId = "eaeaeaea-1212-4212-9212-121212121212";
    const cmds: Record<string, string> = { "aw-oldr3": a.startCmd, "aw-newr3": b.startCmd };
    const panes: Record<string, string> = { "aw-oldr3": WORKING_BROWSER_PANE, "aw-newr3": REAL_EMPTY_PROMPT_PANE };
    const exec: TalkExec & { calls: Call[] } = {
      ...fakeExec("/usr/bin/tmux", new Set(["aw-oldr3", "aw-newr3"])),
      capture: async (_t, name) => panes[name] ?? "",
      captureAll: async (_t, name) => panes[name] ?? "",
      startCommand: async (_t, name) => cmds[name] ?? "",
    };
    const { base, feature, ctx } = await bootStranded(exec, 40 * 60_000, "aw-oldr3", (db, older) => {
      const newer = plus(older, 20 * 60_000);
      db.setMeta(
        "talk.bindings",
        JSON.stringify([
          { agentId: null, tmuxName: "aw-oldr3", cwd: "/repo", startedAt: older },
          { agentId: null, tmuxName: "aw-newr3", cwd: "/repo", startedAt: newer },
        ]),
      );
      addSession(db, sessionId, plus(newer, 5 * 60_000), prompt);
    });
    const bindings = (feature.snapshotExtras?.(ctx) as { "talk.bindings": TalkBinding[] })["talk.bindings"];
    expect(bindings.map((x) => [x.tmuxName, x.agentId])).toEqual([
      ["aw-oldr3", null],
      ["aw-newr3", null],
    ]);

    const res = await fetch(`${base}/api/talk/${sessionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    expect(res.status).toBe(404);
    expect(exec.calls.some((c) => c.args[0] === "send-keys")).toBe(false);
  });

  it("refuses when the pane's start command does not name one of Alef's dispatch prompt files", async () => {
    const exec = fakeExec("/usr/bin/tmux", new Set(["aw-route1"]), REAL_CHROME_PANE, ""); // unreadable: still listed
    const { base, feature, ctx } = await bootStranded(exec, 34 * 60 * 60_000);
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"]).toHaveLength(1);

    const res = await post(base, "/api/talk/stranded/aw-route1/close");
    expect(res.status).toBe(409);
    expect(kills(exec)).toEqual([]);
  });

  // Regression (PR #29 review): onTick's own before/after diff would find "nothing changed" if a
  // close already applied the removal itself mid-tick, and a tick still in flight when a close
  // finishes (working off its own now-stale snapshot) could resurrect the just-closed row in
  // `stranded` for one tick. onTick and close now share one queue so they never interleave.
  it("a close that finishes while a tick is mid-flight does not resurrect the closed row", async () => {
    const release: { current: (() => void) | null } = { current: null };
    const captureGate = new Promise<void>((resolvePromise) => {
      release.current = resolvePromise;
    });
    const p = await dispatchPromptFile("cccccccc-1212-4212-9212-121212121212", "Open PR aligning acme.ai FAQ with the DPA");
    const base0 = fakeExec("/usr/bin/tmux", new Set(["aw-race1"]), REAL_CHROME_PANE, p.startCmd);
    let captureCalls = 0;
    const exec: TalkExec = {
      ...base0,
      async capture(tmuxPath, name) {
        captureCalls += 1;
        if (captureCalls === 2) await captureGate; // gate only the second call: the delayed tick's
        return base0.capture(tmuxPath, name);
      },
    };
    const { base, feature, ctx } = await bootStranded(exec, 34 * 60 * 60 * 1000, "aw-race1");
    expect((feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"]).toHaveLength(1);

    const tickPromise = feature.onTick?.(ctx); // starts; will block inside computeStranded's 2nd capture()
    await new Promise((r) => setTimeout(r, 20)); // let it reach the gate

    const closePromise = post(base, "/api/talk/stranded/aw-race1/close"); // queued behind the in-flight tick
    await new Promise((r) => setTimeout(r, 20)); // give an unserialized close a window to run first

    release.current?.();
    const [, closeRes] = await Promise.all([tickPromise, closePromise]);
    expect(closeRes.status).toBe(200);

    const finalStranded = (feature.snapshotExtras?.(ctx) as { "talk.stranded": StrandedDispatch[] })["talk.stranded"];
    expect(finalStranded).toEqual([]);
  });
});
