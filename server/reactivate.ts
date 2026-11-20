// Building blocks for the three endpoints that open something outside the
// process: POST /api/reactivate/:agentId (Terminal + `claude --resume`),
// POST /api/dispatch (Terminal + `claude "<prompt>"`), and
// POST /api/open-editor/:agentId (`code <cwd>`). Every actual side effect lives
// behind an injectable executor so tests never spawn osascript, open a real
// Terminal window, or launch VS Code; index.ts wires the real ones in.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Async on purpose: a sync call froze the whole server, and a cold Terminal launch can take
// longer than 5s, which reported a failure even though the window opened.
export async function openTerminalWithCommand(shellCmd: string): Promise<void> {
  const appleScript = `tell application "Terminal" to do script "${appleScriptQuote(shellCmd)}"`;
  await execFileAsync("osascript", ["-e", appleScript], { timeout: 20000 });
}

// ── Reactivate: resume an existing session ──────────────────────────────────

/** The shell command a resumed Terminal window will run. Exported for tests. */
export function buildResumeCommand(cwd: string, agentId: string): string {
  return `cd ${shQuote(cwd)} && claude --resume ${shQuote(agentId)}`;
}

export type ReactivateExecutor = (cwd: string, agentId: string) => void | Promise<void>;

/** Opens Terminal.app and resumes the session there. */
export const openTerminalExecutor: ReactivateExecutor = (cwd, agentId) =>
  openTerminalWithCommand(buildResumeCommand(cwd, agentId));

// ── Dispatch: start a brand-new session with a prompt ───────────────────────

/** Resolved at call time (never cached in a module-level constant) so a test's `beforeAll` can
 *  point `ALEF_DISPATCH_DIR` at a scratch mkdtemp before the first dispatch/launch of that run —
 *  see server/test/dispatch-dir-setup.ts. Exported so talk.ts's stranded-dispatch detection
 *  validates a pane's prompt-file path against the same directory this process is actually using. */
export function dispatchDir(): string {
  return process.env.ALEF_DISPATCH_DIR ?? join(tmpdir(), "agent-world-dispatch");
}

/** Writes `prompt` to a mode-0600 temp file and returns its path. The prompt's
 *  content never touches a shell or AppleScript string — only this path does,
 *  and only after shell-quoting. */
export async function writeDispatchPromptFile(prompt: string): Promise<string> {
  const dir = dispatchDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${randomUUID()}.txt`);
  await writeFile(filePath, prompt, "utf8");
  await chmod(filePath, 0o600); // belt-and-braces: writeFile's mode is subject to umask
  return filePath;
}

/** The shell command a dispatched Terminal window will run. Exported for tests.
 *  `$(cat '<file>')` substitutes the file's bytes as a single argument to
 *  `claude` — the prompt is never interpolated into this string directly. */
export function buildDispatchCommand(cwd: string, promptFilePath: string): string {
  return `cd ${shQuote(cwd)} && claude "$(cat ${shQuote(promptFilePath)})"; rm -f ${shQuote(promptFilePath)}`;
}

/** A plan-mode launch's command (▶ Launch in loops/president, and their trust-relaunch): structurally
 *  always plan mode, no parameter could select another permission mode. `$(cat '<file>')` like
 *  buildDispatchCommand; tmux's own `-c <cwd>` sets the folder. Exported for tests. */
export function buildPlanDispatchCommand(promptFilePath: string): string {
  return `claude --permission-mode plan "$(cat ${shQuote(promptFilePath)})"; rm -f ${shQuote(promptFilePath)}`;
}

export type DispatchExecutor = (cwd: string, promptFilePath: string) => void | Promise<void>;

/** Opens Terminal.app and runs the dispatched prompt there. */
export const openTerminalDispatchExecutor: DispatchExecutor = (cwd, promptFilePath) =>
  openTerminalWithCommand(buildDispatchCommand(cwd, promptFilePath));

// ── Open editor: `code <cwd>` ────────────────────────────────────────────────

export type OpenEditorExecutor = (cwd: string) => void | Promise<void>;

const VSCODE_TIMEOUT_MS = 5000;
/** Where a GUI-installed VS Code puts its CLI shim, relative to the .app bundle (or a home dir). */
const VSCODE_CLI_SUFFIX = join("Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code");

export interface VsCodeExecutorDeps {
  /** PATH directories to search for a `code` executable, in order. A function (not a plain
   *  array) so a test's env change is picked up per call, same reasoning as dispatchDir(). */
  pathDirs: () => readonly string[];
  /** True if `path` exists and is executable; never throws. */
  isExecutable: (path: string) => Promise<boolean>;
  /** Runs `file` with argv only (no shell); rejects on spawn failure, non-zero exit or timeout. */
  exec: (file: string, args: readonly string[], timeoutMs: number) => Promise<void>;
  homeDir: string;
}

/** Opens VS Code on `path` (a file or a folder), trying, in order: a `code` found on PATH, the
 *  GUI app's own CLI shim under /Applications, the same shim under ~/Applications, and finally
 *  `open -a "Visual Studio Code"` (works even when the CLI shim was never installed). Every
 *  attempt is execFile with an argv array — no shell, nothing to quote. */
export function createVsCodeExecutor(deps: VsCodeExecutorDeps): OpenEditorExecutor {
  return async (path: string) => {
    for (const dir of deps.pathDirs()) {
      const candidate = join(dir, "code");
      if (await deps.isExecutable(candidate)) {
        await deps.exec(candidate, [path], VSCODE_TIMEOUT_MS);
        return;
      }
    }
    for (const candidate of [join("/Applications", VSCODE_CLI_SUFFIX), join(deps.homeDir, "Applications", VSCODE_CLI_SUFFIX)]) {
      if (await deps.isExecutable(candidate)) {
        await deps.exec(candidate, [path], VSCODE_TIMEOUT_MS);
        return;
      }
    }
    try {
      await deps.exec("open", ["-a", "Visual Studio Code", path], VSCODE_TIMEOUT_MS);
      return;
    } catch {
      // fall through to the final, honest error
    }
    throw new Error("VS Code isn't installed: no code command, and macOS couldn't open Visual Studio Code.");
  };
}

async function realIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Real deps: no test ever exercises this path — see reactivate.test.ts's injected fakes. */
export const openVsCodeExecutor: OpenEditorExecutor = createVsCodeExecutor({
  pathDirs: () => (process.env.PATH ?? "").split(delimiter).filter(Boolean),
  isExecutable: realIsExecutable,
  exec: async (file, args, timeoutMs) => {
    await execFileAsync(file, [...args], { timeout: timeoutMs });
  },
  homeDir: homedir(),
});
