// tmux side of "cleanup" (P2): list Alef's `aw-*` sessions and close one whose claude has
// exited, after saving its whole scrollback as text in the trash. argv-only execFile, never a
// shell; the exec is injectable (like talk's TalkExec) so tests never touch a real tmux.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALEF_TMUX_RE } from "../../shared/features/cleanup.js";
import { classifyTmux, parseTmuxList, type TmuxRow } from "./cleanup-lib.js";

const execFileAsync = promisify(execFile);
const LIST_FORMAT = "#{session_name} #{pane_dead} #{pane_pid} #{pane_current_command}";

export interface CleanupTmuxExec {
  findTmux(): Promise<string | null>;
  /** stdout of `tmux list-sessions -F LIST_FORMAT`; "" when the server is not running. */
  list(tmuxPath: string): Promise<string>;
  /** The whole scrollback of the session's pane (`capture-pane -p -S -`). */
  captureAll(tmuxPath: string, name: string): Promise<string>;
  kill(tmuxPath: string, name: string): Promise<void>;
}

export function realCleanupTmuxExec(findTmux: () => Promise<string | null>): CleanupTmuxExec {
  return {
    findTmux,
    async list(tmuxPath) {
      try {
        const { stdout } = await execFileAsync(tmuxPath, ["list-sessions", "-F", LIST_FORMAT], { timeout: 5000 });
        return stdout;
      } catch {
        return ""; // "no server running" exits non-zero
      }
    },
    async captureAll(tmuxPath, name) {
      const { stdout } = await execFileAsync(tmuxPath, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    },
    async kill(tmuxPath, name) {
      await execFileAsync(tmuxPath, ["kill-session", "-t", `=${name}`], { timeout: 5000 });
    },
  };
}

export async function listTmuxRows(exec: CleanupTmuxExec): Promise<TmuxRow[]> {
  const tmux = await exec.findTmux();
  if (!tmux) return [];
  return parseTmuxList(await exec.list(tmux));
}

/**
 * Closes one Alef tmux session, re-checking at action time that it is still an `aw-*` session
 * whose claude has exited (no claude below its pane pid, per `claudeAncestors`) and that no live
 * agent is bound to it. The scrollback is saved via `save` before the kill; a failed save means
 * no kill.
 */
export async function closeDeadTmux(
  exec: CleanupTmuxExec,
  name: string,
  boundToLive: ReadonlySet<string>,
  claudeAncestors: ReadonlySet<number> | null,
  save: (text: string) => Promise<string>,
): Promise<{ status: number; error?: string; savedTo?: string }> {
  if (!ALEF_TMUX_RE.test(name)) return { status: 400, error: "only Alef's aw-* tmux sessions can be closed" };
  const tmux = await exec.findTmux();
  if (!tmux) return { status: 409, error: "tmux is not installed" };
  const row = parseTmuxList(await exec.list(tmux)).find((r) => r.name === name);
  if (!row) return { status: 404, error: "no such tmux session" };
  const item = classifyTmux(row, boundToLive, claudeAncestors);
  if (!item) return { status: 409, error: "claude is still running in it" };
  if (item.protected) return { status: 409, error: item.protected };
  const savedTo = await save(await exec.captureAll(tmux, name));
  await exec.kill(tmux, name);
  return { status: 200, savedTo };
}
