// ▶ Launch (Round 8 H2): starts a NEW claude session, PLAN MODE ONLY, in a loop item's
// project directory with its task text as the first prompt. Reuses talk.ts's
// `startWorldSession` (a world tmux session, "aw-<hex>", bound so Talk/Interrupt can reach
// it too) rather than writing a second launcher — the working directory goes through tmux's
// own `-c <cwd>` (startWorldSession), and the only new piece here is the command string,
// which hardcodes `--permission-mode plan` with no parameter that could ever turn it off.
//
// Safety: the prompt is never shell-interpolated (writeDispatchPromptFile + `$(cat <path>)`,
// same as /api/dispatch and fork's PLAN_COMMAND). The cwd is re-validated against the home
// directory right before spawning anything, independent of whatever the caller computed earlier.

import { stat, unlink } from "node:fs/promises";
import { LOOPS_MAX_PROMPT_CHARS } from "../../shared/features/loops.js";
import { buildPlanDispatchCommand, writeDispatchPromptFile } from "../reactivate.js";
import type { FeatureContext } from "./registry.js";
import { resolveInside } from "./safe-path.js";
import { startWorldSession } from "./talk.js";

export type LaunchValidation =
  | { ok: true; cwd: string; prompt: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Re-validates a launch's inputs right before anything is spawned: `cwd` must resolve to an
 *  existing directory inside `homeDir` (lexically and by realpath — symlink escapes included),
 *  and `prompt` must be 1..LOOPS_MAX_PROMPT_CHARS. Never trusts a cached/client-supplied path. */
export async function validateLaunch(homeDir: string, cwd: string | null, prompt: string): Promise<LaunchValidation> {
  if (!cwd) return { ok: false, status: 400, error: "this item has no project directory to launch in" };
  if (prompt.trim().length < 1) return { ok: false, status: 400, error: "task text is empty" };
  if (prompt.length > LOOPS_MAX_PROMPT_CHARS) return { ok: false, status: 400, error: `task text must be ${LOOPS_MAX_PROMPT_CHARS} characters or fewer` };

  const resolved = await resolveInside(homeDir, cwd, { allowAbsolute: true });
  if (!resolved.ok) return { ok: false, status: 403, error: "refusing a project directory outside the home directory" };

  let st;
  try {
    st = await stat(resolved.abs);
  } catch {
    return { ok: false, status: 404, error: "project directory not found" };
  }
  if (!st.isDirectory()) return { ok: false, status: 400, error: "not a directory" };

  return { ok: true, cwd: resolved.abs, prompt };
}

export interface LoopsLaunchResult {
  ok: boolean;
  error?: string;
  tmuxName?: string;
  /** It runs, but Terminal couldn't be opened on it (see talk.ts's startSession). */
  warning?: string;
  /** claude's startup dialog its pane showed right after the launch. */
  waitingOn?: "trust" | "chrome";
  /** Where it runs: always a world tmux session for this launcher. */
  mode?: "tmux";
}

export type LoopsLauncher = (cwd: string, prompt: string, ctx: FeatureContext) => Promise<LoopsLaunchResult>;

/** The shell command a launched world session runs. Exported for tests. Structurally always
 *  plan mode: there is no parameter here that could select another permission mode. The prompt
 *  file is written by `writeDispatchPromptFile` (mode 0600) and removed after `claude` reads it.
 *  The builder lives in reactivate.ts so talk's trust-relaunch rebuilds the same shape. */
export function buildLoopsLaunchCommand(promptFilePath: string): string {
  return buildPlanDispatchCommand(promptFilePath);
}

/** Default launcher: writes the prompt file, then starts it through talk's startWorldSession
 *  (bound like a dispatch — talk + interrupt reach it once its transcript appears). `cwd`/
 *  `prompt` must already be validated by `validateLaunch`. */
export const worldPlanLoopsLauncher: LoopsLauncher = async (cwd, prompt, ctx) => {
  const promptFilePath = await writeDispatchPromptFile(prompt);
  const result = await startWorldSession(ctx, cwd, buildLoopsLaunchCommand(promptFilePath), { plan: true });
  if (!result.ok) {
    // No tmux, or new-session failed: nothing will ever run the `rm -f` that removes the prompt file.
    await unlink(promptFilePath).catch(() => undefined);
    return { ok: false, error: result.error };
  }
  const { ok: _ok, ...launched } = result;
  return { ok: true, mode: "tmux", ...launched };
};
