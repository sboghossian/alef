// A1 — talk to a live agent through tmux. Every launch Alef makes (the dispatch bar, Health's
// Launch, search's ⌘↵ Reactivate, ▶ Launch, Resume here, fork) starts `claude` inside a
// server-owned detached tmux session ("aw-<shortid>") and opens Terminal attached to it, so
// Stop, Talk, Note and the Screen can reach it (decision 1a, 2026-09-28: before this, the dispatch
// bar, Health and Reactivate opened a plain Terminal and 0 of 267 agents were controllable).
// POST /api/talk/:agentId types a line into that session (send-keys -l + Enter).
//
// This feature serves POST /api/dispatch and POST /api/reactivate/:agentId too. Only there, and
// only when tmux is missing, a launch falls back to a plain Terminal window (ctx.executors), and
// the answer says so (mode "terminal"). The /api/talk/* routes answer 409 TALK_INSTALL_HINT then.
//
// A launch never starts a second copy: a resume of a session that is already running answers 409,
// and the same launch asked twice within LAUNCH_REPEAT_WINDOW_MS gets the first one's session.
// It watches the new pane for up to LAUNCH_DIALOG_WATCH_MS and says in its own answer when claude
// is waiting on its folder-trust (or Chrome) dialog; that row joins the Inbox's stranded list at
// once, where "Trust <folder> & relaunch" grants trust (trust.ts), Closes it under Close's own
// invariant, and relaunches its prompt. Alef never answers a dialog by send-keys.
//
// Safety: tmux is only ever run through execFile with an argv array. The text typed into
// a session is passed as one literal argv entry (`send-keys -l`), never through a shell.
// The only shell strings are tmux's own session commands, built from a validated uuid or
// a server-written prompt file path, shell-quoted. Bindings persist in the `meta` table.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  LAUNCH_DIALOG_WATCH_MS,
  PLAIN_TERMINAL_NOTE,
  STRANDED_CLOSABLE,
  TALK_INSTALL_HINT,
  TALK_MAX_CHARS,
  type StrandedBlockedOn,
  type StrandedDispatch,
  type TalkActionResult,
  type TalkBinding,
  type TalkMessage,
  type TalkStatus,
} from "../../shared/features/talk.js";
import type { DispatchResult, LaunchDetails, ReactivateResult } from "../../shared/types.js";
import type { WorldDb } from "../db.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import {
  buildDispatchCommand,
  buildPlanDispatchCommand,
  dispatchDir as getDispatchDir,
  isValidUuid,
  openTerminalWithCommand,
  shQuote,
  writeDispatchPromptFile,
} from "../reactivate.js";
import { realTrashFs, saveTmuxScrollback, type TrashDeps, type TrashFs } from "./cleanup-trash.js";
import { createLaunchOnce } from "./launch-once.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { grantTrustLogged, type TrustFeatureOptions } from "./trust.js";

const execFileAsync = promisify(execFile);
const META_BINDINGS = "talk.bindings";
const TMUX_NAME_RE = /^aw-[a-z0-9]{4,16}$/;
/** A binding this old, still agentId-null, whose tmux session is still alive, is "stranded": it
 *  must be surfaced instead of silently occupying a tmux session forever. Only onTick's adoption
 *  pass (planAdoptions) can un-strand one. */
const STRANDED_AFTER_MS = 120_000;
/** TalkExec.paneCounts of a session holding one window with one pane: the only layout Close acts on. */
const SINGLE_PANE = "1 1";
const PANE_COUNTS_RE = /^\d+ \d+$/;
/** True for tmux's own "<windows> <panes>" shape (e.g. "1 1"). A `display-message` target that no
 *  longer exists does not error — tmux just leaves its format fields blank ("", or " " once
 *  trimmed of the space between them) — so that shape must read as "could not tell", never get
 *  compared as if it were some other real pane count. */
export function isValidPaneCounts(s: string): boolean {
  return PANE_COUNTS_RE.test(s);
}

/** The condition `if-shell -F` evaluates, read fresh at the instant tmux runs the command: true
 *  only when the session still has exactly one window and one pane. */
const SINGLE_PANE_IF_SHELL_CONDITION = "#{&&:#{==:#{session_windows},1},#{==:#{window_panes},1}}";

/** The ONE tmux command Close's final step runs: re-check the pane count and kill the session
 *  atomically. A separate check-then-kill left a gap in which a window or pane added via a
 *  scripted `split-window -d` was killed along with the rest of the session (PR #29 follow-up).
 *  tmux evaluates the condition and runs `kill-session` only if it is still true, in one command
 *  no other tmux client can interleave with; if it is false, tmux runs nothing and the session is
 *  left exactly as it was. Either way, tmux gives no direct signal back here — the caller confirms
 *  what happened with has-session. */
export function killIfSinglePaneCommand(name: string): readonly string[] {
  return ["if-shell", "-F", "-t", `=${name}:`, SINGLE_PANE_IF_SHELL_CONDITION, `kill-session -t =${name}`];
}
/** Without the dispatch's prompt as proof, a session is adopted only if its first activity falls
 *  within this long after the dispatch started. Unbounded, a dispatch stuck for 34h adopted an
 *  unrelated session started a day later (PR #29 review). */
export const ADOPT_WINDOW_MS = 10 * 60_000;
/** How much of a prompt file is read: enough for promptHead and for matching the prompt against a
 *  session's first user message (the indexer keeps 600 chars of that as `title`). */
const PROMPT_READ_BYTES = 1024;
const PROMPT_MATCH_CHARS = 120;
/** A prompt shorter than this is no proof: "fix" opens plenty of unrelated first messages. */
export const PROMPT_MATCH_MIN_CHARS = 24;
/** A prompt file is at most 4000 characters (the dispatch/launch bound), so 64KB is plenty. */
const PROMPT_FILE_MAX_BYTES = 64 * 1024;
const DIALOG_POLL_MS = 500;

/** What a Claude Code session exports to everything it spawns, and so what a tmux server started
 *  from inside one (the live Alef server ran under a VS Code Claude session) hands to every pane
 *  through its global environment (✅ read off the live tmux server's process env, 2026-09-28).
 *  claude 2.1.283 reads CLAUDE_CODE_CHILD_SESSION as "I am a nested child" and turns transcript
 *  saving OFF ("nested_marker": "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
 *  marker") unless a 250ms `tmux show-environment -g` probe finds the marker in tmux's global env;
 *  a session with no transcript is never adopted, so Talk and Stop never reach it. The first seven
 *  are exactly what claude itself deletes when it starts an independent session (its `Hr()`); the
 *  last four point at the parent session (its entrypoint, pid and messaging socket). Every world
 *  launch unsets them first: the claude in the pane is nobody's child. */
export const PARENT_SESSION_ENV_VARS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

/** `shellCmd` as a world tmux session runs it: the parent session's markers unset first (tmux runs
 *  it through the default shell's `-c`, where `unset` of an unset name is a no-op). The dispatch's
 *  `$(cat '<file>')` stays intact, so promptFileFromStartCommand still finds it. */
export function withoutParentSessionEnv(shellCmd: string): string {
  return `unset ${PARENT_SESSION_ENV_VARS.join(" ")}; ${shellCmd}`;
}

/** Terminal's command to attach to exactly this session (`=` = exact match, never a prefix). */
export function attachCommand(tmuxPath: string, name: string): string {
  return `${shQuote(tmuxPath)} attach -t ${shQuote(`=${name}`)}`;
}

const ALREADY_RUNNING =
  "This session is already running (in VS Code or Terminal), so resuming it would start a second copy. Switch to its window instead (if you just closed it, try again in a minute).";

/** The reason an exec failure gives, in one short line (its last non-blank line: the stderr). */
function shortReason(err: unknown): string {
  const lines = String(err instanceof Error ? err.message : err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1] ?? "unknown error";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** (b): tmux is running claude, but Terminal couldn't be opened on it. Never a failure: a retry
 *  would start a second session next to this one. */
function terminalWarning(err: unknown, name: string): string {
  return `couldn't open Terminal (${shortReason(err)}); it's running in tmux ${name}: use Attach or the Screen`;
}

/** True once a new pane is clearly past claude's startup dialogs: its input box, its output, or a
 *  shell after claude exited. Until then a launch keeps watching (see LAUNCH_DIALOG_WATCH_MS). */
export function pastStartupDialogs(pane: string): boolean {
  if (startupDialogOnScreen(pane)) return false;
  const kind = classifyStrandedPane(pane);
  return kind === "empty-prompt" || kind === "exited" || /⏺|esc to interrupt/.test(pane);
}

export interface TalkExec {
  /** Absolute path of tmux, or null when it is not installed. */
  findTmux(): Promise<string | null>;
  run(file: string, args: readonly string[]): Promise<void>;
  /** Visible text of the session's pane (tmux capture-pane -p, exact session match). */
  capture(tmuxPath: string, name: string): Promise<string>;
  /** The pane's whole scrollback (tmux capture-pane -p -S -), for saving before a destructive
   *  close — like cleanup-tmux.ts's CleanupTmuxExec.captureAll, but scoped to talk's own sessions. */
  captureAll(tmuxPath: string, name: string): Promise<string>;
  /** The pane's original start command (tmux `#{pane_start_command}`) — how a dispatch/launch's
   *  prompt-file path is recovered for a stranded session, since the binding itself never stored it. */
  startCommand(tmuxPath: string, name: string): Promise<string>;
  /** The session's window count and its current window's pane count (tmux
   *  `#{session_windows} #{window_panes}`), e.g. "1 1". capture only ever sees the active pane, but
   *  kill-session ends every window and pane, so Close needs to know the pane is all there is. */
  paneCounts(tmuxPath: string, name: string): Promise<string>;
  openTerminal(shellCmd: string): void | Promise<void>;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const realTalkExec: TalkExec = {
  async findTmux() {
    const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
    for (const d of new Set(dirs)) {
      const p = join(d, "tmux");
      if (await isExecutable(p)) return p;
    }
    return null;
  },
  async run(file, args) {
    await execFileAsync(file, [...args], { timeout: 5000 });
  },
  async capture(tmuxPath, name) {
    const { stdout } = await execFileAsync(tmuxPath, ["capture-pane", "-p", "-t", `=${name}:`], { timeout: 5000 });
    return stdout;
  },
  async captureAll(tmuxPath, name) {
    const { stdout } = await execFileAsync(tmuxPath, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  },
  async startCommand(tmuxPath, name) {
    const { stdout } = await execFileAsync(tmuxPath, ["display-message", "-p", "-t", `=${name}:`, "#{pane_start_command}"], { timeout: 5000 });
    return stdout.trim();
  },
  async paneCounts(tmuxPath, name) {
    const { stdout } = await execFileAsync(tmuxPath, ["display-message", "-p", "-t", `=${name}:`, "#{session_windows} #{window_panes}"], { timeout: 5000 });
    return stdout.trim();
  },
  openTerminal(shellCmd) {
    return openTerminalWithCommand(shellCmd);
  },
};

/** Text as it will be typed: control chars dropped, newlines → spaces (a newline would submit early). */
export function cleanTalkText(raw: string): string {
  return raw.replace(/\r?\n/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** True when the pane shows an interactive choice (permission prompt, trust dialog, menu).
 *  Typing + Enter there would pick the highlighted option (often "Yes"), so talk must refuse. */
export function paneShowsPrompt(pane: string): boolean {
  const tail = pane.split("\n").slice(-25).join("\n");
  return /Do you want to proceed\?|Enter to confirm|Esc to cancel|❯\s*\d+\.\s/.test(tail);
}

/** claude's two startup dialogs as the installed claude.exe renders them (its strings, read
 *  2026-09-27/28, plus a live capture of the Chrome one): a rule, the title, the body, the options
 *  (no indexes, "❯" on the highlighted one), then the key-hint footer as the pane's last line. The
 *  trust dialog reads "Quick safety check: Is this a project you created or one you trust?" under
 *  an "Accessing workspace:" title, never "Do you trust the files in this folder" (0 occurrences
 *  in the binary). */
interface StartupDialog {
  blockedOn: "trust" | "chrome";
  footer: string;
  header: RegExp;
  confirm: string;
  options: readonly string[];
}
const STARTUP_DIALOGS: readonly StartupDialog[] = [
  {
    blockedOn: "trust",
    footer: "Enter to confirm · Esc to cancel",
    header: /^(Accessing workspace:|Quick safety check: Is this a project)/,
    confirm: "Yes, I trust this folder",
    options: ["Yes, I trust this folder", "No, exit", "No, continue without these permissions"],
  },
  {
    blockedOn: "chrome",
    footer: "Enter to confirm · Esc to keep browser tools off",
    header: /^Claude in Chrome extension detected$/,
    confirm: "Yes, use my browser",
    options: ["Yes, use my browser", "No, keep browser tools off"],
  },
];
const RULE_RE = /^─{3,}/;

/** The startup dialog the pane is sitting on, or null. Anchored to the bottom: the dialog's footer
 *  must be the last non-blank line, and everything from the rule above it down must be that dialog
 *  alone: its title and confirm option on lines of their own, no ⏺/⎿ transcript line, and no ❯
 *  line but one of its own options (never an input box). Matching the dialog's words anywhere in
 *  the last 25 lines let a working agent pass as one: its "Claude in Chrome[navigate]" tool lines,
 *  a prompt quoting the dialog, or this file open on screen (PR #29 review). */
export function startupDialogOnScreen(pane: string): "trust" | "chrome" | null {
  const lines = pane.split("\n").map((l) => l.trim());
  let end = lines.length - 1;
  while (end >= 0 && lines[end] === "") end--;
  const dialog = STARTUP_DIALOGS.find((d) => d.footer === lines[end]);
  if (!dialog) return null;
  let top = end - 1;
  while (top >= 0 && !RULE_RE.test(lines[top] ?? "")) top--;
  if (top < 0) return null;
  const body = lines.slice(top + 1, end);
  const option = (l: string): string => (l.startsWith("❯") ? l.slice(1).trim() : l);
  if (!body.some((l) => dialog.header.test(l)) || !body.some((l) => option(l) === dialog.confirm)) return null;
  const foreign = body.some((l) => l.startsWith("⏺") || l.startsWith("⎿") || (l.includes("❯") && !(l.startsWith("❯") && dialog.options.includes(option(l)))));
  return foreign ? null : dialog.blockedOn;
}

const CLAUDE_UI_RE = /❯|─{3,}|Do you want to proceed\?|Enter to confirm|plan mode on|shift\+tab to cycle/;
const SHELL_PROMPT_TAIL_RE = /[%$#]\s*$/;

function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function collapseWhitespace(s: string, maxLen: number): string {
  const collapsed = squashWhitespace(s);
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}

/** Why a stranded dispatch's tmux pane never reached a real transcript. Order matters: the two
 *  named dialogs are checked before the generic menu detector, which would also match them. */
export function classifyStrandedPane(pane: string): StrandedBlockedOn {
  const dialog = startupDialogOnScreen(pane);
  if (dialog) return dialog;
  if (paneShowsPrompt(pane)) return "menu";
  const tail = pane.split("\n").slice(-25).join("\n");

  const nearBottom = pane.split("\n").slice(-10);
  const promptLine = [...nearBottom].reverse().find((l) => l.includes("❯"));
  if (promptLine !== undefined) {
    const after = promptLine.slice(promptLine.indexOf("❯") + 1).trim();
    return after.length === 0 ? "empty-prompt" : "unknown";
  }

  if (!CLAUDE_UI_RE.test(tail)) {
    const lastNonBlank = [...pane.split("\n")].reverse().find((l) => l.trim().length > 0);
    if (lastNonBlank && SHELL_PROMPT_TAIL_RE.test(lastNonBlank.trim())) return "exited";
  }
  return "unknown";
}

/** The last non-blank line of a captured pane, for a human glance at the stranded row. */
export function lastNonBlankLine(pane: string): string | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim();
    if (t) return collapseWhitespace(t, 200);
  }
  return null;
}

const PROMPT_FILE_NAME_RE = /^[0-9a-f-]{36}\.txt$/;

/** Recovers a dispatch/launch's prompt-file path from its pane's original start command
 *  (`buildDispatchCommand` / `buildLoopsLaunchCommand`'s `$(cat '<path>')` shape) — the only place
 *  that path survives once the binding is stranded. Returns null unless the path's directory is
 *  exactly `dispatchDir` (no traversal, no path elsewhere) and its basename is a bare `<uuid>.txt`. */
export function promptFileFromStartCommand(startCmd: string, dispatchDir: string): string | null {
  const match = /\$\(cat '([^']*)'\)/.exec(startCmd);
  const path = match?.[1];
  if (!path || path.includes("..")) return null;
  // resolve() both sides: a raw string compare broke on a trailing slash or a relative
  // ALEF_DISPATCH_DIR (path.dirname never returns a trailing slash of its own).
  if (resolve(dirname(path)) !== resolve(dispatchDir)) return null;
  if (!PROMPT_FILE_NAME_RE.test(basename(path))) return null;
  return path;
}

/** The first PROMPT_READ_BYTES of a dispatch's prompt file, raw. Null on any read failure (file
 *  already removed, permission, etc.) — best-effort only. */
async function readPromptFile(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(PROMPT_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PROMPT_READ_BYTES, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** A dispatch's whole prompt file (trust-relaunch starts the same prompt again), or null when it is
 *  gone, unreadable or larger than any prompt Alef writes. */
async function readWholePromptFile(filePath: string): Promise<string | null> {
  try {
    if ((await stat(filePath)).size > PROMPT_FILE_MAX_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** True when a session's first user message (`title`, the indexer's first 600 chars of it)
 *  opens with this dispatch's prompt: the whitespace-collapsed title starts with the prompt's
 *  head, and that head is at least PROMPT_MATCH_MIN_CHARS long. A substring anywhere in the
 *  title, or a short prompt, let a dispatch of "fix" adopt a session opening "please fix the
 *  flaky login test" 34h later (PR #29 review). */
export function promptMatchesTitle(prompt: string, title: string): boolean {
  const head = squashWhitespace(prompt).slice(0, PROMPT_MATCH_CHARS);
  return head.length >= PROMPT_MATCH_MIN_CHARS && squashWhitespace(title).startsWith(head);
}

/** The fields of an indexed session that adoption looks at (a SessionRow subset). */
export interface AdoptableSession {
  id: string;
  cwd: string;
  startedAt: string;
  title: string;
}

/** An agentId-null binding, with its dispatch prompt when its pane's start command names a
 *  readable prompt file (null for a promptless fork, or when the file/command can't be read),
 *  and its pane as captured this tick (null when the capture failed). */
export interface WaitingBinding {
  binding: TalkBinding;
  prompt: string | null;
  pane: string | null;
}

export interface AdoptionCandidate {
  session: AdoptableSession;
  /** The session's first user message carries this dispatch's prompt. */
  matched: boolean;
  /** ms from the dispatch starting to the session's first activity (never negative). */
  delta: number;
}

/** Sessions that could be `w`'s transcript: same cwd, first user message already indexed
 *  (adoption waits a tick for it rather than guess), first activity at or after the binding
 *  started (never an older session), and either opening with the dispatch's prompt — proof, at
 *  any age, e.g. a trust dialog answered an hour later — or, without that proof, starting within
 *  ADOPT_WINDOW_MS of the dispatch. Callers pre-filter out sessions already bound to another
 *  binding. This only decides adoption; Close never relies on it (see projectActiveSince). */
export function adoptionCandidates(w: WaitingBinding, sessions: readonly AdoptableSession[]): AdoptionCandidate[] {
  const since = Date.parse(w.binding.startedAt);
  const out: AdoptionCandidate[] = [];
  for (const s of sessions) {
    if (s.cwd !== w.binding.cwd) continue;
    if (s.title.trim().length === 0) continue;
    const delta = Date.parse(s.startedAt) - since;
    if (!Number.isFinite(delta) || delta < 0) continue;
    const matched = w.prompt !== null && promptMatchesTitle(w.prompt, s.title);
    if (!matched && delta > ADOPT_WINDOW_MS) continue;
    out.push({ session: s, matched, delta });
  }
  return out;
}

/** Which session each waiting binding adopts (tmuxName → session id). Several null bindings may
 *  share a cwd: pairs whose session carries the binding's prompt win first, then the closest
 *  start time, each binding and each session used at most once — so one stuck dispatch never
 *  blocks, or steals from, a later one in the same project. A binding whose pane still shows the
 *  trust or Chrome dialog is left out: it cannot own a running session, and letting it compete
 *  let a retry still on its dialog take the session its answered twin was running (PR #29 review).
 *  A session whose prompt two still-unadopted bindings both carry is ambiguous and nobody adopts
 *  it: the closest start picked a retry idling at an empty prompt over the twin running it, and
 *  Talk typed into the wrong claude (PR #29 review). Passes repeat until nothing changes, so a
 *  rival that adopts another session stops blocking this one. */
export function planAdoptions(waiting: readonly WaitingBinding[], sessions: readonly AdoptableSession[]): Map<string, string> {
  const pairs = waiting
    .filter((w) => w.pane === null || startupDialogOnScreen(w.pane) === null)
    .flatMap((w) => adoptionCandidates(w, sessions).map((c) => ({ name: w.binding.tmuxName, ...c })));
  pairs.sort((a, b) => Number(b.matched) - Number(a.matched) || a.delta - b.delta || a.name.localeCompare(b.name));
  const out = new Map<string, string>();
  const used = new Set<string>();
  const contested = (p: (typeof pairs)[number]): boolean => pairs.some((q) => q.matched && q.session.id === p.session.id && q.name !== p.name && !out.has(q.name));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of pairs) {
      if (out.has(p.name) || used.has(p.session.id) || contested(p)) continue;
      out.set(p.name, p.session.id);
      used.add(p.session.id);
      changed = true;
    }
  }
  return out;
}

/** True when any session in `binding`'s project (its cwd or below) has been active since the
 *  binding started: bound to another binding or not, whatever its title, whenever it started (a
 *  resumed older conversation counts). Close refuses on this rather than on adoption: the
 *  adoption window, title and start-time checks each let Close kill a live agent's pane (PR #29
 *  review). A time that doesn't parse counts as active. */
export function projectActiveSince(binding: TalkBinding, sessions: readonly { cwd: string; lastActive: string }[]): boolean {
  const since = Date.parse(binding.startedAt);
  const root = binding.cwd.replace(/\/+$/, "");
  return sessions.some((s) => (s.cwd === root || s.cwd.startsWith(`${root}/`)) && !(Date.parse(s.lastActive) < since));
}

/** The name prefix of every Claude Code project directory for `cwd` or a folder below it. claude
 *  names a project dir `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, cut to 200 chars plus "-<hash>" when
 *  longer (its own sanitizer, read from the installed claude.exe 2026-09-28). A sibling such as
 *  /repo-old shares the prefix too, which only makes Close refuse more often. */
export function projectDirPrefix(cwd: string): string {
  return cwd.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** True when any transcript (`*.jsonl`) in a project directory for `cwd` or below was written at
 *  or after `sinceMs`, read straight off disk. The sessions table is only as fresh as the last
 *  index pass (every 10s, or never if passes fail), and Close killed a working agent in that gap
 *  (PR #29 review). A session in the stranded pane, new or resumed, writes its own top-level
 *  transcript as it starts, so top-level files are enough. Throws when the dir can't be read. */
export async function transcriptWrittenSince(projectsDir: string, cwd: string, sinceMs: number): Promise<boolean> {
  const prefix = projectDirPrefix(cwd);
  let dirs: string[];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => e.name);
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(projectsDir, dir));
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(join(projectsDir, dir, f))).mtimeMs;
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }
      if (!(mtimeMs < sinceMs)) return true;
    }
  }
  return false;
}

/** Types `text` into a tmux session as literal keys, then presses Enter. argv only, no shell. */
export async function sendToTmux(exec: TalkExec, tmuxPath: string, name: string, text: string): Promise<void> {
  await exec.run(tmuxPath, ["send-keys", "-t", name, "-l", text]);
  await exec.run(tmuxPath, ["send-keys", "-t", name, "Enter"]);
}

/** Identifies one binding across saves. The tmux name alone is not enough: reactivate reuses
 *  `aw-<agentId prefix>`, so a new binding can take a dead one's name. */
function bindingKey(b: TalkBinding): string {
  return `${b.tmuxName}\n${b.startedAt}`;
}

/** Talk bindings as persisted in the `meta` table (invalid entries dropped). */
export function loadTalkBindings(db: WorldDb): TalkBinding[] {
  const out: TalkBinding[] = [];
  try {
    const parsed: unknown = JSON.parse(db.getMeta(META_BINDINGS) ?? "[]");
    if (Array.isArray(parsed)) {
      for (const b of parsed) {
        if (!isRecord(b) || typeof b.tmuxName !== "string" || !TMUX_NAME_RE.test(b.tmuxName)) continue;
        if (typeof b.cwd !== "string" || typeof b.startedAt !== "string") continue;
        const agentId = typeof b.agentId === "string" && isValidUuid(b.agentId) ? b.agentId : null;
        out.push({ agentId, tmuxName: b.tmuxName, cwd: b.cwd, startedAt: b.startedAt, ...(typeof b.plan === "boolean" ? { plan: b.plan } : {}) });
      }
    }
  } catch {
    // corrupt value: start empty
  }
  return out;
}

async function sessionAlive(exec: TalkExec, tmuxPath: string, name: string): Promise<boolean> {
  try {
    await exec.run(tmuxPath, ["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** The live tmux session bound to `agentId`, or why there is none (status + error). */
export async function boundTmuxSession(
  exec: TalkExec,
  tmuxPath: string | null,
  bindings: readonly TalkBinding[],
  agentId: string,
): Promise<{ ok: true; tmuxPath: string; tmuxName: string } | { ok: false; status: number; error: string }> {
  if (!tmuxPath) return { ok: false, status: 409, error: TALK_INSTALL_HINT };
  const binding = bindings.find((x) => x.agentId === agentId);
  if (!binding) return { ok: false, status: 404, error: "this agent is not running in a world tmux session" };
  if (!(await sessionAlive(exec, tmuxPath, binding.tmuxName))) return { ok: false, status: 410, error: "its tmux session has ended" };
  return { ok: true, tmuxPath, tmuxName: binding.tmuxName };
}

/** Types already-cleaned `text` + Enter into the agent's tmux session, refusing while its pane
 *  shows an interactive prompt (Enter would pick the highlighted option). Shared by talk and
 *  the "send the agent a note" control endpoint. */
export async function deliverTalkText(
  exec: TalkExec,
  tmuxPath: string | null,
  bindings: readonly TalkBinding[],
  agentId: string,
  text: string,
): Promise<{ status: number; body: TalkActionResult }> {
  const target = await boundTmuxSession(exec, tmuxPath, bindings, agentId);
  if (!target.ok) return { status: target.status, body: { ok: false, error: target.error } };
  try {
    if (paneShowsPrompt(await exec.capture(target.tmuxPath, target.tmuxName))) {
      return { status: 409, body: { ok: false, error: "this agent is showing a prompt; answer it first (approval card or its Terminal)" } };
    }
    await sendToTmux(exec, target.tmuxPath, target.tmuxName, text);
    return { status: 200, body: { ok: true, tmuxName: target.tmuxName } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: String(err) } };
  }
}

/** A world launch that started: its tmux session, plus what may still stop it (see LaunchDetails). */
export interface WorldLaunch {
  tmuxName: string;
  warning?: string;
  waitingOn?: "trust" | "chrome";
}

/** How a launch started claude, recorded on its binding: `plan` when `shellCmd` runs it with
 *  `--permission-mode plan`. Trust-relaunch relaunches in this mode. */
export interface LaunchMode {
  plan: boolean;
}

type WorldSessionStarter = (ctx: FeatureContext, cwd: string, shellCmd: string, mode: LaunchMode) => Promise<({ ok: true } & WorldLaunch) | { ok: false; error: string }>;
let sharedStarter: WorldSessionStarter | null = null;

/** Starts `shellCmd` in a new world tmux session (bound like a dispatch, so talk and interrupt reach
 *  it once its transcript appears) and opens Terminal. For other features, e.g. fork. */
export function startWorldSession(ctx: FeatureContext, cwd: string, shellCmd: string, mode: LaunchMode): ReturnType<WorldSessionStarter> {
  if (!sharedStarter) return Promise.resolve({ ok: false, error: "the talk feature is not enabled" });
  return sharedStarter(ctx, cwd, shellCmd, mode);
}

/** Where a Close saves a stranded pane's scrollback before killing it. Overridable in tests only
 *  (`home`, so nothing ever writes into the real ~/.alef-trash); the real feature always uses
 *  the real filesystem. */
export interface TalkTrashDeps {
  home?: string;
  fs?: TrashFs;
}

/** How a launch watches its new pane (tests shorten it), and the trust grant's deps (tests fake $HOME). */
export interface TalkLaunchOptions {
  dialogWatchMs?: number;
  dialogPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  trust?: TrustFeatureOptions;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a route handler answers: status + body (`ok` mirrored for LaunchOnce). */
interface RouteOut<B extends { ok: boolean }> {
  ok: boolean;
  status: number;
  body: B;
}

function out<B extends { ok: boolean }>(status: number, body: B): RouteOut<B> {
  return { ok: body.ok, status, body };
}

/** A LaunchOnce repeat says so in its body: nothing new was started. */
function withReused<B extends { ok: boolean; reused?: boolean }>(r: RouteOut<B> & { reused?: boolean }): RouteOut<B> {
  return r.reused ? { ok: r.ok, status: r.status, body: { ...r.body, reused: true } } : { ok: r.ok, status: r.status, body: r.body };
}

type LaunchBody = { ok: boolean; error?: string; cwd?: string } & LaunchDetails;

/** The talk feature's stranded list (the rows snapshotExtras serves as "talk.stranded"), for the
 *  Town square's server-side workspace (server/features/workspace.ts). Production builds one talk
 *  feature; the last one built answers. [] until its first tick computes the list. */
let strandedOf: (() => readonly StrandedDispatch[]) | null = null;
export function currentStranded(): readonly StrandedDispatch[] {
  return strandedOf?.() ?? [];
}

export function createTalkFeature(exec: TalkExec = realTalkExec, now: () => number = Date.now, trash: TalkTrashDeps = {}, launchOpts: TalkLaunchOptions = {}): ServerFeature {
  const dialogWatchMs = launchOpts.dialogWatchMs ?? LAUNCH_DIALOG_WATCH_MS;
  const dialogPollMs = launchOpts.dialogPollMs ?? DIALOG_POLL_MS;
  const sleep = launchOpts.sleep ?? realSleep;
  const launchOnce = createLaunchOnce(now);
  let bindings: TalkBinding[] | null = null;
  let tmuxCache: { at: number; path: string | null } | null = null;
  let stranded: StrandedDispatch[] = [];
  strandedOf = () => stranded;
  /** Rows a launch listed itself (listStrandedNow), by the order they were listed: a tick that was
   *  already running keeps them instead of overwriting them with a list computed before they existed. */
  const freshlyListed = new Map<string, number>();
  let listSeq = 0;
  const trashHome = trash.home ?? homedir();
  const trashFs = trash.fs ?? realTrashFs;
  const trashDepsFor = (ctx: FeatureContext): TrashDeps => ({ home: trashHome, projectsDir: ctx.config.projectsDir, fs: trashFs, now: () => new Date(now()) });

  // onTick and the routes that mutate `bindings`/`stranded` (close) run one at a time: without
  // this, a close finishing mid-tick could race onTick's own before/after diff and resurrect the
  // just-closed row in `stranded` for one tick (PR #29 review).
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function tmux(): Promise<string | null> {
    if (tmuxCache && now() - tmuxCache.at < 30_000) return tmuxCache.path;
    const path = await exec.findTmux();
    tmuxCache = { at: now(), path };
    return path;
  }

  function load(ctx: FeatureContext): TalkBinding[] {
    if (bindings) return bindings;
    bindings = loadTalkBindings(ctx.db);
    return bindings;
  }

  function save(ctx: FeatureContext, next: TalkBinding[]): void {
    bindings = next;
    ctx.db.setMeta(META_BINDINGS, JSON.stringify(next));
    // broadcast as "talk" so a save made through another feature's ctx (startWorldSession) still reaches talk's client
    ctx.broadcast({ type: "feature", feature: "talk", payload: { kind: "bindings", bindings: next } satisfies TalkMessage });
  }

  const alive = (tmuxPath: string, name: string): Promise<boolean> => sessionAlive(exec, tmuxPath, name);

  /** True only when tmux says the session is gone: "can't find session", or "no server running"
   *  once it was the server's last session. A timeout or any other error is not proof: a launch
   *  called failed invites a retry, and a retry next to a live claude is a second copy. */
  async function sessionEnded(tmuxPath: string, name: string): Promise<boolean> {
    try {
      await exec.run(tmuxPath, ["has-session", "-t", `=${name}`]);
      return false;
    } catch (err) {
      return /can't find session|session not found|no server running|error connecting to/.test(err instanceof Error ? err.message : String(err));
    }
  }

  /** A binding's pane start command — read once per pass through `cache` (onTick's adoption pass
   *  and computeStranded both need it) — and the dispatch prompt file it names, if any. A failed
   *  read is null, never "promptless". */
  async function dispatchInfo(tmuxPath: string, name: string, cache: Map<string, string | null>): Promise<{ startCmd: string | null; file: string | null }> {
    let startCmd = cache.get(name);
    if (startCmd === undefined) {
      try {
        startCmd = await exec.startCommand(tmuxPath, name);
      } catch {
        startCmd = null; // best-effort only
      }
      cache.set(name, startCmd);
    }
    return { startCmd, file: startCmd ? promptFileFromStartCommand(startCmd, getDispatchDir()) : null };
  }

  async function dispatchPrompt(tmuxPath: string, name: string, cache: Map<string, string | null>): Promise<string | null> {
    const { file } = await dispatchInfo(tmuxPath, name, cache);
    return file ? readPromptFile(file) : null;
  }

  /** A binding's pane, captured once per tick through `cache` (the adoption pass and
   *  computeStranded both need it). Null when the capture fails. */
  async function tickPane(tmuxPath: string, name: string, cache: Map<string, string | null>): Promise<string | null> {
    let pane = cache.get(name);
    if (pane === undefined) {
      try {
        pane = await exec.capture(tmuxPath, name);
      } catch {
        pane = null;
      }
      cache.set(name, pane);
    }
    return pane;
  }

  /** The session's TalkExec.paneCounts, trimmed, or null when tmux can't say — including the blank
   *  fields tmux prints (no error) for a target that no longer exists. */
  async function paneCounts(tmuxPath: string, name: string): Promise<string | null> {
    try {
      const out = (await exec.paneCounts(tmuxPath, name)).trim();
      return isValidPaneCounts(out) ? out : null;
    } catch {
      return null;
    }
  }

  /** The stranded subset of `list` (agentId still null, old enough), each classified from this
   *  tick's pane capture. Callers only ever pass bindings onTick's adoption pass just confirmed
   *  alive this same tick, so this never re-checks aliveness itself — that would repeat the exact
   *  has-session call the caller already made. Best-effort per entry: a capture/start-command
   *  failure drops that entry from this tick's list rather than failing the whole pass. */
  async function computeStranded(tmuxPath: string, list: readonly TalkBinding[], startCmds: Map<string, string | null>, panes: Map<string, string | null>): Promise<StrandedDispatch[]> {
    const out: StrandedDispatch[] = [];
    for (const b of list) {
      if (b.agentId !== null) continue;
      // Younger than STRANDED_AFTER_MS, it is listed only while claude's trust/Chrome dialog is on
      // screen (its launch already said so): that screen is definite, the others need time to tell.
      if (now() - Date.parse(b.startedAt) < STRANDED_AFTER_MS) {
        const young = await tickPane(tmuxPath, b.tmuxName, panes);
        if (young === null || startupDialogOnScreen(young) === null) continue;
      }
      const { startCmd, file } = await dispatchInfo(tmuxPath, b.tmuxName, startCmds);
      // A non-empty start command we could read but that carries no prompt file (fork's plain
      // `claude --permission-mode plan`, no `$(cat '<file>')`) is a session the user opened on
      // purpose through ▶ Launch and is meant to sit idle until they type — not a failed
      // unattended dispatch/loop-launch, which always writes one. Surfacing it here would nag
      // every promptless fork after 2 minutes of normal, intentional idling. An empty/unreadable
      // start command (startCommand failed, or genuinely returned nothing) is NOT treated as
      // "confirmed promptless" — that would silently hide a real stuck dispatch instead.
      if (startCmd && !file) continue;
      const pane = await tickPane(tmuxPath, b.tmuxName, panes);
      if (pane === null) continue;
      const promptText = file ? await readPromptFile(file) : null;
      const promptHead = promptText === null ? null : collapseWhitespace(promptText, 120);
      const blockedOn = classifyStrandedPane(pane);
      // The pane was read from the active pane only; a session with another window or pane (or
      // whose layout can't be read) is never offered Close, since kill-session would end those too.
      const closable = STRANDED_CLOSABLE.includes(blockedOn) && (await paneCounts(tmuxPath, b.tmuxName)) === SINGLE_PANE;
      out.push({ tmuxName: b.tmuxName, cwd: b.cwd, startedAt: b.startedAt, blockedOn, closable, promptHead, lastLine: lastNonBlankLine(pane) });
    }
    return out;
  }

  /** Why `binding` must NOT be killed right now, or null once it is clear: no session in its
   *  project, bound or not, has been active since it was dispatched, no transcript in its project
   *  has been written since then either (the index can lag), and its pane, captured fresh as the
   *  very last step, still classifies exactly as the (closable) row the user clicked showed. Pane
   *  count is deliberately NOT read here: it is re-checked atomically WITH the kill itself
   *  (killIfSinglePaneCommand), which a separate read taken a moment earlier cannot be. */
  async function strandedActivityAndScreenRefusal(ctx: FeatureContext, tmuxPath: string, binding: TalkBinding, listed: StrandedDispatch): Promise<string | null> {
    if (projectActiveSince(binding, ctx.db.listSessions())) {
      return "a session in this project has been active since it was dispatched and may be running in it, so it was not closed; attach to check";
    }
    try {
      if (await transcriptWrittenSince(ctx.config.projectsDir, binding.cwd, Date.parse(binding.startedAt))) {
        return "a transcript in this project has been written since it was dispatched and may be this one's, so it was not closed; attach to check";
      }
    } catch {
      return "could not read this project's transcripts, so it was not closed";
    }
    // Last, after the DB and disk checks: a screen read before them could be stale by the kill,
    // e.g. the dialog answered in Terminal while the transcripts were being read.
    let pane: string;
    try {
      pane = await exec.capture(tmuxPath, binding.tmuxName);
    } catch {
      return "could not re-read its screen, so it was not closed";
    }
    const blockedOn = classifyStrandedPane(pane);
    if (blockedOn !== listed.blockedOn) return `its screen changed since it was listed (${listed.blockedOn} → ${blockedOn}), so it was not closed`;
    if (!STRANDED_CLOSABLE.includes(blockedOn)) return notClosableReason(blockedOn);
    return null;
  }

  /** Why `binding` must NOT even be attempted yet, or null once it is worth trying: exactly one
   *  window with one pane (kill-session ends them all, the screen check only ever sees the active
   *  one), then the activity/screen checks above. Read once, before the scrollback save, so a
   *  session with other windows/panes never gets one saved for nothing — the pane count is never
   *  read this way again; see strandedActivityAndScreenRefusal and killIfSinglePaneCommand for how
   *  the final check right before the kill is done instead. */
  async function strandedCloseRefusal(ctx: FeatureContext, tmuxPath: string, binding: TalkBinding, listed: StrandedDispatch): Promise<string | null> {
    const counts = await paneCounts(tmuxPath, binding.tmuxName);
    if (counts === null) return "could not read its windows and panes, so it was not closed";
    if (counts !== SINGLE_PANE) return "session has other windows/panes, so it was not closed; attach and exit it in Terminal instead";
    return strandedActivityAndScreenRefusal(ctx, tmuxPath, binding, listed);
  }

  function notClosableReason(blockedOn: StrandedBlockedOn): string {
    return `a working agent can also show this screen (${blockedOn}), so it was not closed; attach and exit it in Terminal instead`;
  }

  function reply(res: Parameters<typeof respondJson>[0], status: number, body: TalkActionResult): void {
    respondJson(res, status, body);
  }

  /** Watches a fresh pane for claude's trust/Chrome startup dialog for up to dialogWatchMs: the
   *  dialog it shows, or null once claude is past them (pastStartupDialogs), the pane can't be read,
   *  or time runs out; plus the last line it read, if any. Bounded by a poll count, never by the
   *  clock, so a frozen test clock can't hang it. */
  async function watchStartupDialog(tmuxPath: string, name: string): Promise<{ dialog: "trust" | "chrome" | null; lastLine: string | null }> {
    const polls = Math.max(1, Math.ceil(dialogWatchMs / dialogPollMs));
    let lastLine: string | null = null;
    for (let i = 0; i < polls; i++) {
      if (i > 0) await sleep(dialogPollMs);
      let pane: string;
      try {
        pane = await exec.capture(tmuxPath, name);
      } catch {
        return { dialog: null, lastLine };
      }
      lastLine = lastNonBlankLine(pane) ?? lastLine;
      const dialog = startupDialogOnScreen(pane);
      if (dialog) return { dialog, lastLine };
      if (pastStartupDialogs(pane)) return { dialog: null, lastLine };
    }
    return { dialog: null, lastLine };
  }

  /** Lists a just-launched binding as stranded right away, when its pane showed a startup dialog, so
   *  the Inbox (and its Trust & relaunch / Close) doesn't wait STRANDED_AFTER_MS. The next tick keeps
   *  it listed while the dialog stays on screen (computeStranded). Not through `serialized`: a launch
   *  must never wait on a tick. The row is added in one synchronous step after its binding is
   *  re-checked, and a tick already under way carries it over (freshlyListed) instead of dropping it. */
  async function listStrandedNow(ctx: FeatureContext, tmuxPath: string, binding: TalkBinding, blockedOn: "trust" | "chrome"): Promise<void> {
    const { startCmd, file } = await dispatchInfo(tmuxPath, binding.tmuxName, new Map());
    // A promptless fork is never listed (computeStranded's rule): its launch answer said it waits.
    if (startCmd && !file) return;
    const promptText = file ? await readPromptFile(file) : null;
    let lastLine: string | null = null;
    try {
      lastLine = lastNonBlankLine(await exec.capture(tmuxPath, binding.tmuxName));
    } catch {
      // best-effort only
    }
    const closable = STRANDED_CLOSABLE.includes(blockedOn) && (await paneCounts(tmuxPath, binding.tmuxName)) === SINGLE_PANE;
    const row: StrandedDispatch = {
      tmuxName: binding.tmuxName,
      cwd: binding.cwd,
      startedAt: binding.startedAt,
      blockedOn,
      closable,
      promptHead: promptText === null ? null : collapseWhitespace(promptText, 120),
      lastLine,
    };
    // Re-checked after the reads above, with nothing awaited from here to the write.
    if (!load(ctx).some((b) => bindingKey(b) === bindingKey(binding) && b.agentId === null)) return;
    freshlyListed.set(binding.tmuxName, ++listSeq);
    stranded = [...stranded.filter((x) => x.tmuxName !== binding.tmuxName), row];
    // As "talk", whichever feature's ctx launched it (fork, loops, president), like save().
    ctx.broadcast({ type: "feature", feature: "talk", payload: { kind: "stranded", stranded } satisfies TalkMessage });
  }

  /** Starts `shellCmd` in a new detached tmux session (parent-session markers unset), binds it, opens
   *  Terminal attached to it, and watches it for a startup dialog. Throws when new-session itself
   *  fails, or when the session has already ended by the end of the watch (claude exited at once,
   *  and tmux took its output with it); its binding is dropped then. Once tmux runs claude, a
   *  Terminal that won't open is a warning, never a failure (b). */
  async function startSession(ctx: FeatureContext, tmuxPath: string, cwd: string, shellCmd: string, agentId: string | null, name: string, mode: LaunchMode): Promise<WorldLaunch> {
    // Stamped BEFORE new-session, so the session's own first activity can never predate its
    // binding — adoption never takes a session older than the binding (adoptionCandidates).
    const startedAt = new Date(now()).toISOString();
    await exec.run(tmuxPath, ["new-session", "-d", "-s", name, "-c", cwd, withoutParentSessionEnv(shellCmd)]);
    // The mode is recorded here, from the caller: tmux prints #{pane_start_command} re-quoted
    // (outer "…", inner \"), so parsing it back lost plan mode on trust-relaunch (PR #55 review).
    const binding: TalkBinding = { agentId, tmuxName: name, cwd, startedAt, plan: mode.plan };
    const launched: WorldLaunch = { tmuxName: name };
    try {
      save(ctx, [...load(ctx).filter((b) => b.tmuxName !== name && (agentId === null || b.agentId !== agentId)), binding]);
    } catch (err) {
      ctx.log.error("talk", `started ${name} but couldn't record its binding`, String(err));
      launched.warning = `it's running in tmux ${name}, but Alef couldn't record it, so Talk and Stop can't reach it yet`;
    }
    try {
      await exec.openTerminal(attachCommand(tmuxPath, name));
    } catch (err) {
      launched.warning = terminalWarning(err, name);
      ctx.log.warn("talk", `started ${name}; ${launched.warning}`);
    }
    const { dialog, lastLine } = await watchStartupDialog(tmuxPath, name);
    if (dialog) {
      launched.waitingOn = dialog;
      ctx.log.info("talk", `${name} is waiting on claude's ${dialog === "trust" ? "folder-trust" : "Chrome"} dialog in ${cwd}`);
      if (agentId === null) await listStrandedNow(ctx, tmuxPath, binding, dialog);
    } else if (await sessionEnded(tmuxPath, name)) {
      // claude exited during the watch (`--resume` of a missing conversation, a folder gone, claude
      // not on tmux's PATH): its session and output are gone, so this is no launch (PR #55 review).
      try {
        const current = load(ctx);
        if (current.some((b) => bindingKey(b) === bindingKey(binding))) save(ctx, current.filter((b) => bindingKey(b) !== bindingKey(binding)));
      } catch {
        // the next tick drops a dead session's binding anyway
      }
      const error = `claude exited right after starting (its tmux session ${name} has ended), so nothing is running${lastLine ? `; its last line: ${lastLine}` : "; its output ended with it"}`;
      ctx.log.warn("talk", `${name} in ${cwd}: ${error}`);
      throw new Error(error);
    }
    return launched;
  }

  /** The agent as the snapshot sees it right now (the same liveness as /api/world). */
  function isRunning(ctx: FeatureContext, agentId: string): boolean {
    return ctx.worldViews().agents.find((a) => a.id === agentId)?.status === "live";
  }

  /** Resume (both /api/reactivate and /api/talk/reactivate): attach when it already has a live world
   *  tmux session; refuse (409) when it is running anywhere else, since `claude --resume` of a
   *  running session starts a second copy; else resume it in a new world tmux session. Without tmux,
   *  `terminalFallback` opens a plain Terminal (and says so); otherwise 409 with the install hint. */
  async function resumeLaunch(ctx: FeatureContext, agentId: string, terminalFallback: boolean): Promise<RouteOut<LaunchBody>> {
    if (!isValidUuid(agentId)) return out(400, { ok: false, error: "invalid agent id" });
    const session = ctx.db.getSession(agentId);
    if (!session) return out(404, { ok: false, error: "unknown agent id" });
    return withReused(await launchOnce.run(`resume:${agentId}`, async (): Promise<RouteOut<LaunchBody>> => {
      const tmuxPath = await tmux();
      if (tmuxPath) {
        const existing = load(ctx).find((b) => b.agentId === agentId);
        if (existing && (await alive(tmuxPath, existing.tmuxName))) {
          const body: LaunchBody = { ok: true, mode: "tmux", tmuxName: existing.tmuxName, attached: true, cwd: session.cwd };
          try {
            await exec.openTerminal(attachCommand(tmuxPath, existing.tmuxName));
          } catch (err) {
            body.warning = terminalWarning(err, existing.tmuxName);
          }
          return out(200, body);
        }
      }
      if (isRunning(ctx, agentId)) return out(409, { ok: false, error: ALREADY_RUNNING });
      if (!tmuxPath) {
        if (!terminalFallback) return out(409, { ok: false, error: TALK_INSTALL_HINT });
        try {
          await ctx.executors.reactivate(session.cwd, agentId);
          return out(200, { ok: true, mode: "terminal", warning: PLAIN_TERMINAL_NOTE, cwd: session.cwd });
        } catch (err) {
          return out(500, { ok: false, error: String(err) });
        }
      }
      const name = `aw-${agentId.slice(0, 8).toLowerCase()}`;
      try {
        const launched = await startSession(ctx, tmuxPath, session.cwd, `claude --resume ${shQuote(agentId)}`, agentId, name, { plan: false });
        return out(200, { ok: true, mode: "tmux", cwd: session.cwd, ...launched });
      } catch (err) {
        return out(500, { ok: false, error: String(err) });
      }
    }));
  }

  /** Dispatch (both /api/dispatch and /api/talk/dispatch): `prompt` in a new world tmux session in the
   *  island's cwd. The prompt only ever travels as a 0600 file (buildDispatchCommand). Without tmux,
   *  `terminalFallback` opens a plain Terminal (and says so); otherwise 409 with the install hint. */
  async function dispatchLaunch(ctx: FeatureContext, body: unknown, terminalFallback: boolean): Promise<RouteOut<LaunchBody>> {
    if (!isRecord(body) || typeof body.islandId !== "string" || typeof body.prompt !== "string") {
      return out(400, { ok: false, error: "islandId and prompt (both strings) are required" });
    }
    const { islandId, prompt } = body;
    if (prompt.length < 1 || prompt.length > 4000) return out(400, { ok: false, error: "prompt must be 1..4000 characters" });
    if (!islandId || islandId === "harness") return out(400, { ok: false, error: "cannot dispatch to the harness island" });
    const cwd = ctx.db.getIslandCwd(islandId);
    if (!cwd) return out(404, { ok: false, error: "unknown island" });
    const key = `dispatch:${cwd}\n${createHash("sha256").update(prompt).digest("hex")}`;
    return withReused(await launchOnce.run(key, async (): Promise<RouteOut<LaunchBody>> => {
      const tmuxPath = await tmux();
      let file: string | null = null;
      if (!tmuxPath) {
        if (!terminalFallback) return out(409, { ok: false, error: TALK_INSTALL_HINT });
        try {
          file = await writeDispatchPromptFile(prompt);
          await ctx.executors.dispatch(cwd, file);
          return out(200, { ok: true, mode: "terminal", warning: PLAIN_TERMINAL_NOTE, cwd });
        } catch (err) {
          // Nothing will run the command that removes the prompt file, so remove it here. Except
          // after a timeout: that osascript may still have opened the window, whose command reads it.
          const mayStillRun = isRecord(err) && (err.killed === true || err.code === "ETIMEDOUT");
          if (file && !mayStillRun) await unlink(file).catch(() => undefined);
          return out(500, { ok: false, error: String(err), cwd });
        }
      }
      try {
        file = await writeDispatchPromptFile(prompt);
        const launched = await startSession(ctx, tmuxPath, cwd, buildDispatchCommand(cwd, file), null, `aw-${randomBytes(4).toString("hex")}`, { plan: false });
        return out(200, { ok: true, mode: "tmux", cwd, ...launched });
      } catch (err) {
        // new-session failed, so nothing will ever run the `rm -f` that removes the prompt file.
        if (file) await unlink(file).catch(() => undefined);
        return out(500, { ok: false, error: String(err), cwd });
      }
    }));
  }

  /** Close's whole check-and-kill, run inside `serialized` by its route and by trust-relaunch. */
  async function closeStrandedInner(ctx: FeatureContext, tmuxPath: string, name: string): Promise<RouteOut<TalkActionResult>> {
    // Close may kill ONLY a session that is (1) an aw-* session Alef's own dispatch/launch
    // started, (2) still agentId-null, (3) in the computed stranded list on a closable
    // screen (STRANDED_CLOSABLE), and (4) re-verified immediately before the kill: no
    // session in its project active since it was dispatched, indexed or on disk, then the
    // same screen, then exactly one window with one pane — that last check made ATOMIC with
    // the kill itself (killIfSinglePaneCommand), not a separate call a scripted
    // `split-window -d` could slip a new window/pane in behind. Anything else is refused,
    // never guessed at: a live agent listed as stranded by mistake was killable here
    // (PR #29 review).
    const binding = load(ctx).find((b) => b.tmuxName === name);
    if (!binding) return out(404, { ok: false, error: "not a stranded dispatch" });
    if (binding.agentId !== null) return out(409, { ok: false, error: "this session has become an agent, so it was not closed" });
    const listed = stranded.find((s) => s.tmuxName === name);
    if (!listed) return out(409, { ok: false, error: "not in the current stranded list, so it was not closed" });
    if (!(await alive(tmuxPath, name))) {
      save(ctx, load(ctx).filter((b) => b.tmuxName !== name));
      stranded = stranded.filter((s) => s.tmuxName !== name);
      ctx.emit({ kind: "stranded", stranded } satisfies TalkMessage);
      return out(410, { ok: false, error: "its tmux session has ended" });
    }
    if (!STRANDED_CLOSABLE.includes(listed.blockedOn)) return out(409, { ok: false, error: notClosableReason(listed.blockedOn) });
    // (1): the pane must still run a dispatch/launch command naming one of our own prompt
    // files — the shape only /api/dispatch and ▶ Launch ever start.
    const { file: promptFile } = await dispatchInfo(tmuxPath, name, new Map());
    if (!promptFile) return out(409, { ok: false, error: "could not confirm this is one of Alef's dispatches, so it was not closed" });
    try {
      // Checked before anything is saved: a refused Close used to write another full
      // scrollback copy to ~/.alef-trash on every click (PR #29 review).
      const refusal = await strandedCloseRefusal(ctx, tmuxPath, binding, listed);
      if (refusal) {
        ctx.log.info("talk", `refused to close ${name}: ${refusal}`);
        return out(409, { ok: false, error: refusal });
      }
      // The whole scrollback goes to ~/.alef-trash, so a kill never destroys the pane's
      // only copy of its output; then everything but the pane count (see below) is
      // checked again right before the kill.
      const savedTo = await saveTmuxScrollback(trashDepsFor(ctx), name, await exec.captureAll(tmuxPath, name));
      const lastRefusal = await strandedActivityAndScreenRefusal(ctx, tmuxPath, binding, listed);
      if (lastRefusal) {
        ctx.log.info("talk", `refused to close ${name}: ${lastRefusal} (scrollback copy saved to ${savedTo})`);
        return out(409, { ok: false, error: lastRefusal });
      }
      // The pane-count re-check and the kill are ONE tmux command (if-shell -F): a separate
      // check here, then a separate kill-session call, is exactly the gap a scripted
      // `split-window -d` could land in and be killed along with the session. tmux itself
      // evaluates the condition and kills only if it still holds; has-session afterward
      // says which happened, since tmux gives no other signal back for this.
      await exec.run(tmuxPath, killIfSinglePaneCommand(name));
      if (await alive(tmuxPath, name)) {
        const msg = "gained a window or pane just as it was being closed, so it was not closed; attach and exit it in Terminal instead";
        ctx.log.info("talk", `refused to close ${name}: ${msg} (scrollback copy saved to ${savedTo})`);
        return out(409, { ok: false, error: msg });
      }
      ctx.log.info("talk", `closed stranded ${name} (${listed.blockedOn}); scrollback saved to ${savedTo}`);
    } catch (err) {
      return out(500, { ok: false, error: String(err) });
    }
    // The dispatch/launch's own `; rm -f <file>` never runs once kill-session SIGHUPs its
    // shell, so the prompt file is removed here instead of piling up in the dispatch dir.
    await unlink(promptFile).catch(() => undefined);
    save(ctx, load(ctx).filter((b) => b.tmuxName !== name));
    stranded = stranded.filter((s) => s.tmuxName !== name);
    // Notify now rather than waiting for the next tick's before/after diff — that diff
    // would find nothing changed (this handler already applied the removal itself).
    ctx.emit({ kind: "stranded", stranded } satisfies TalkMessage);
    return out(200, { ok: true, tmuxName: name });
  }

  /** "Trust <folder> & relaunch" on a stranded row waiting on the trust dialog: (1) grant folder
   *  trust (trust-lib's invariant), (2) Close the stuck session through closeStrandedInner, the
   *  same invariant as the Close button, (3) start the same prompt again, in the same mode (plan or
   *  not), in a new world tmux session. Stops at the first step that fails and says which; it never
   *  relaunches a prompt whose first session is still alive. The dialog is never answered by keys. */
  async function trustRelaunch(ctx: FeatureContext, tmuxPath: string, name: string): Promise<RouteOut<TalkActionResult>> {
    const pre = await serialized(async (): Promise<RouteOut<TalkActionResult> | { ok: true; cwd: string; prompt: string; plan: boolean }> => {
      const binding = load(ctx).find((b) => b.tmuxName === name);
      if (!binding) return out(404, { ok: false, error: "not a stranded dispatch" });
      const listed = stranded.find((s) => s.tmuxName === name);
      if (!listed) return out(409, { ok: false, error: "not in the current stranded list, so nothing was changed" });
      if (listed.blockedOn !== "trust") return out(409, { ok: false, error: "it isn't waiting on the folder-trust dialog, so nothing was changed" });
      const { file } = await dispatchInfo(tmuxPath, name, new Map());
      const prompt = file ? await readWholePromptFile(file) : null;
      if (prompt === null || prompt.trim().length === 0) {
        return out(409, { ok: false, error: "couldn't read its prompt, so it can't be relaunched; nothing was changed. Attach and answer the dialog in Terminal." });
      }
      const folder = basename(binding.cwd);
      const granted = await grantTrustLogged(ctx, binding.cwd, launchOpts.trust);
      if (!granted.body.ok) return out(granted.status, { ok: false, error: `couldn't trust ${folder}: ${granted.body.error ?? "unknown error"}` });
      const closed = await closeStrandedInner(ctx, tmuxPath, name);
      if (!closed.body.ok) {
        return out(closed.status, { ok: false, trusted: true, cwd: binding.cwd, error: `Trusted ${folder}, but ${name} wasn't closed, so nothing was relaunched: ${closed.body.error ?? "unknown error"}` });
      }
      // The mode recorded at launch. Without one (a binding saved before it was recorded), plan
      // mode can't be ruled out, so it relaunches in plan mode: never less restricted than before.
      return { ok: true, cwd: binding.cwd, prompt, plan: binding.plan !== false };
    });
    if (!("prompt" in pre)) return pre;
    // Outside `serialized`: a fresh session, bound and watched like any launch.
    let file: string | null = null;
    try {
      file = await writeDispatchPromptFile(pre.prompt);
      const shellCmd = pre.plan ? buildPlanDispatchCommand(file) : buildDispatchCommand(pre.cwd, file);
      const launched = await startSession(ctx, tmuxPath, pre.cwd, shellCmd, null, `aw-${randomBytes(4).toString("hex")}`, { plan: pre.plan });
      ctx.log.info("talk", `trust-relaunch: closed ${name}, relaunched as ${launched.tmuxName}${pre.plan ? " (plan mode)" : ""}`);
      return out(200, { ok: true, trusted: true, relaunchedFrom: name, mode: "tmux", cwd: pre.cwd, ...launched });
    } catch (err) {
      if (file) await unlink(file).catch(() => undefined);
      return out(500, { ok: false, trusted: true, cwd: pre.cwd, error: `Trusted the folder and closed ${name}, but the relaunch failed: ${String(err)}` });
    }
  }

  sharedStarter = async (ctx, cwd, shellCmd, mode) => {
    const tmuxPath = await tmux();
    if (!tmuxPath) return { ok: false, error: TALK_INSTALL_HINT };
    const name = `aw-${randomBytes(4).toString("hex")}`;
    try {
      return { ok: true, ...(await startSession(ctx, tmuxPath, cwd, shellCmd, null, name, mode)) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };

  return {
    id: "talk",
    tickIntervalMs: 15_000,
    routes: [
      {
        method: "GET",
        path: "/api/talk/status",
        async handler(_req, res, ctx) {
          const path = await tmux();
          respondJson(res, 200, { available: path !== null, hint: path ? null : TALK_INSTALL_HINT, bindings: load(ctx) } satisfies TalkStatus);
        },
      },
      {
        method: "POST",
        path: "/api/talk/reactivate/:agentId",
        async handler(_req, res, ctx, params) {
          const r = await resumeLaunch(ctx, params.agentId ?? "", false);
          reply(res, r.status, r.body);
        },
      },
      {
        method: "POST",
        path: "/api/reactivate/:agentId",
        async handler(_req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          const r = await resumeLaunch(ctx, agentId, true);
          respondJson(res, r.status, { ...r.body, agentId } satisfies ReactivateResult);
        },
      },
      {
        method: "POST",
        path: "/api/talk/dispatch",
        async handler(req, res, ctx) {
          let b: unknown;
          try {
            b = await readJsonBody(req);
          } catch {
            return reply(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const r = await dispatchLaunch(ctx, b, false);
          reply(res, r.status, r.body);
        },
      },
      {
        method: "POST",
        path: "/api/dispatch",
        async handler(req, res, ctx) {
          let b: unknown;
          try {
            b = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, islandId: "", error: "invalid JSON body" } satisfies DispatchResult);
          }
          const r = await dispatchLaunch(ctx, b, true);
          const islandId = isRecord(b) && typeof b.islandId === "string" ? b.islandId : "";
          respondJson(res, r.status, { ...r.body, islandId } satisfies DispatchResult);
        },
      },
      {
        method: "POST",
        path: "/api/talk/stranded/:tmuxName/attach",
        async handler(_req, res, _ctx, params) {
          const name = params.tmuxName ?? "";
          if (!TMUX_NAME_RE.test(name)) return reply(res, 400, { ok: false, error: "invalid tmux session name" });
          if (!stranded.some((s) => s.tmuxName === name)) return reply(res, 404, { ok: false, error: "not a stranded dispatch" });
          const tmuxPath = await tmux();
          if (!tmuxPath) return reply(res, 409, { ok: false, error: TALK_INSTALL_HINT });
          try {
            await exec.openTerminal(attachCommand(tmuxPath, name));
            reply(res, 200, { ok: true, tmuxName: name });
          } catch (err) {
            reply(res, 500, { ok: false, error: String(err) });
          }
        },
      },
      {
        method: "POST",
        path: "/api/talk/stranded/:tmuxName/close",
        async handler(_req, res, ctx, params) {
          const name = params.tmuxName ?? "";
          if (!TMUX_NAME_RE.test(name)) return reply(res, 400, { ok: false, error: "invalid tmux session name" });
          const tmuxPath = await tmux();
          if (!tmuxPath) return reply(res, 409, { ok: false, error: TALK_INSTALL_HINT });
          const r = await serialized(() => closeStrandedInner(ctx, tmuxPath, name));
          reply(res, r.status, r.body);
        },
      },
      {
        method: "POST",
        path: "/api/talk/stranded/:tmuxName/trust-relaunch",
        async handler(_req, res, ctx, params) {
          const name = params.tmuxName ?? "";
          if (!TMUX_NAME_RE.test(name)) return reply(res, 400, { ok: false, error: "invalid tmux session name" });
          const tmuxPath = await tmux();
          if (!tmuxPath) return reply(res, 409, { ok: false, error: TALK_INSTALL_HINT });
          const r = withReused(await launchOnce.run(`trust-relaunch:${name}`, () => trustRelaunch(ctx, tmuxPath, name)));
          reply(res, r.status, r.body);
        },
      },
      {
        method: "POST",
        path: "/api/talk/:agentId",
        async handler(req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return reply(res, 400, { ok: false, error: "invalid agent id" });
          let b: unknown;
          try {
            b = await readJsonBody(req);
          } catch {
            return reply(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const raw = isRecord(b) && typeof b.text === "string" ? b.text : "";
          const text = cleanTalkText(raw);
          if (text.trim().length < 1 || raw.length > TALK_MAX_CHARS) {
            return reply(res, 400, { ok: false, error: `text must be 1..${TALK_MAX_CHARS} characters` });
          }
          const out = await deliverTalkText(exec, await tmux(), load(ctx), agentId, text);
          if (out.status === 200) ctx.log.info("talk", `sent ${text.length} chars to ${out.body.tmuxName ?? "?"}`);
          reply(res, out.status, out.body);
        },
      },
    ],
    async onTick(ctx) {
      await serialized(async () => {
        const seqAtStart = listSeq;
        const list = load(ctx);
        if (list.length === 0) return;
        const tmuxPath = await tmux();
        if (!tmuxPath) return;
        const live: TalkBinding[] = [];
        const dead = new Set<string>();
        for (const b of list) {
          if (await alive(tmuxPath, b.tmuxName)) live.push(b);
          else dead.add(bindingKey(b));
        }
        const startCmds = new Map<string, string | null>();
        const panes = new Map<string, string | null>();
        let adopted = new Map<string, string>();
        if (live.some((b) => b.agentId === null)) {
          const taken = new Set(list.flatMap((b) => (b.agentId === null ? [] : [b.agentId])));
          const sessions = ctx.db.listSessions().filter((s) => !taken.has(s.id));
          const waiting: WaitingBinding[] = [];
          for (const b of live) {
            if (b.agentId !== null) continue;
            // Only pay for a start-command, prompt-file and pane read when its cwd has any unbound session.
            if (!sessions.some((s) => s.cwd === b.cwd)) continue;
            waiting.push({ binding: b, prompt: await dispatchPrompt(tmuxPath, b.tmuxName, startCmds), pane: await tickPane(tmuxPath, b.tmuxName, panes) });
          }
          adopted = planAdoptions(waiting, sessions);
        }
        // Applied to the bindings as they are NOW, not to `list`: a dispatch or startWorldSession
        // can save a new binding during the awaits above, and saving a list derived from the
        // snapshot dropped it for good (PR #29 review).
        const liveKeys = new Set(live.map(bindingKey));
        const current = load(ctx);
        const bound = new Set(current.flatMap((b) => (b.agentId === null ? [] : [b.agentId])));
        let changed = false;
        const next: TalkBinding[] = [];
        for (const b of current) {
          if (dead.has(bindingKey(b))) {
            changed = true;
            continue;
          }
          const agentId = b.agentId === null && liveKeys.has(bindingKey(b)) ? adopted.get(b.tmuxName) : undefined;
          if (agentId === undefined || bound.has(agentId)) {
            next.push(b);
            continue;
          }
          bound.add(agentId);
          next.push({ ...b, agentId });
          changed = true;
        }
        if (changed) save(ctx, next);
        const computed = await computeStranded(tmuxPath, next.filter((b) => liveKeys.has(bindingKey(b))), startCmds, panes);
        // Rows a launch listed while this tick ran (after it read the bindings or the panes) are
        // kept as listed; the next tick evaluates them like any other.
        const stillWaiting = new Set(load(ctx).flatMap((b) => (b.agentId === null ? [b.tmuxName] : [])));
        const carried = stranded.filter((r) => (freshlyListed.get(r.tmuxName) ?? 0) > seqAtStart && stillWaiting.has(r.tmuxName) && !computed.some((c) => c.tmuxName === r.tmuxName));
        const strandedNext = [...computed, ...carried];
        for (const [name, seq] of freshlyListed) if (seq <= seqAtStart) freshlyListed.delete(name);
        // lastLine isn't rendered by any client yet, so a spinner/ticking status alone (in an
        // "unknown" pane) shouldn't trigger a broadcast and a full Inbox rebuild every tick.
        const withoutLastLine = (arr: readonly StrandedDispatch[]): unknown => arr.map(({ lastLine: _lastLine, ...rest }) => rest);
        const clientVisibleChange = JSON.stringify(withoutLastLine(strandedNext)) !== JSON.stringify(withoutLastLine(stranded));
        stranded = strandedNext;
        if (clientVisibleChange) ctx.emit({ kind: "stranded", stranded } satisfies TalkMessage);
      });
    },
    snapshotExtras(ctx) {
      return { "talk.bindings": load(ctx), "talk.available": tmuxCache ? tmuxCache.path !== null : null, "talk.stranded": stranded };
    },
  };
}

/** The default feature's exec under a test runner: tmux reads as not installed and Terminal never
 *  opens, so no test that boots the default feature list (bootTestServer, or startServer with no
 *  `features`) can reach the real tmux server or osascript through /api/dispatch or
 *  /api/reactivate; they fall back to the config's injected executors. Tests that exercise tmux
 *  build createTalkFeature(fakeExec). Production never sets VITEST (same guard as logs.ts). */
const TEST_RUNNER_EXEC: TalkExec = {
  findTmux: async () => null,
  run: async () => {
    throw new Error("tmux is off under a test runner");
  },
  capture: async () => "",
  captureAll: async () => "",
  startCommand: async () => "",
  paneCounts: async () => "",
  openTerminal: () => {
    throw new Error("Terminal is off under a test runner");
  },
};

export const talkFeature = createTalkFeature(process.env.VITEST ? TEST_RUNNER_EXEC : realTalkExec);
