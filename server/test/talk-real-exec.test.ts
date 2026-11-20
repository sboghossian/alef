// realTalkExec's tmux argv, with node:child_process's execFile mocked: nothing here runs tmux or
// spawns any process.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { realTalkExec } from "../features/talk.js";

interface ExecCall {
  file: string;
  args: readonly string[];
}

const mocked = vi.hoisted(() => ({ calls: [] as ExecCall[], stdout: "" }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // promisify(execFile) resolves with the callback's value: the { stdout, stderr } the real one gives.
  execFile: (file: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    mocked.calls.push({ file, args });
    cb(null, { stdout: mocked.stdout, stderr: "" });
  },
}));

describe("realTalkExec argv", () => {
  beforeEach(() => {
    mocked.calls.length = 0;
  });

  // Regression (PR #29 review, LOW): capture targeted the bare name, which tmux may also resolve as
  // a prefix of another session's name, unlike startCommand, captureAll and kill's exact match.
  it("capture targets the exact session", async () => {
    mocked.stdout = "pane text";
    expect(await realTalkExec.capture("/usr/bin/tmux", "aw-abcd1234")).toBe("pane text");
    expect(mocked.calls).toEqual([{ file: "/usr/bin/tmux", args: ["capture-pane", "-p", "-t", "=aw-abcd1234:"] }]);
  });

  it("paneCounts asks for the exact session's window count and its window's pane count, trimmed", async () => {
    mocked.stdout = "1 1\n";
    expect(await realTalkExec.paneCounts("/usr/bin/tmux", "aw-abcd1234")).toBe("1 1");
    expect(mocked.calls).toEqual([{ file: "/usr/bin/tmux", args: ["display-message", "-p", "-t", "=aw-abcd1234:", "#{session_windows} #{window_panes}"] }]);
  });
});
