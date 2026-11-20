// POST /api/dispatch. The executor here stands in for "open a Terminal and run a
// shell command" — it must never see the prompt itself, only a path to a temp
// file the shell will `cat`. These tests exercise that boundary directly with a
// prompt built to break naive string interpolation (quotes, $(), backticks, and
// a `"; rm -rf` payload).

import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../index.js";
import { buildDispatchCommand, dispatchDir } from "../reactivate.js";
import { bootTestServer } from "./helpers.js";

const NASTY_PROMPT = 'hello \'$(rm -rf /)\' `echo pwned` "; rm -rf ~; echo ';

describe("POST /api/dispatch", () => {
  let server: RunningServer | null = null;
  const capturedFiles: string[] = [];

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    for (const f of capturedFiles.splice(0)) {
      await unlink(f).catch(() => {});
    }
  });

  it("never puts the prompt into the executor's command — only a temp-file path", async () => {
    const calls: Array<{ cwd: string; promptFilePath: string }> = [];
    const { base, server: s } = await bootTestServer({
      dispatchExecutor: (cwd, promptFilePath) => {
        calls.push({ cwd, promptFilePath });
      },
    });
    server = s;
    s.db.setIslandForCwd("/ws/target-project", "target-project");

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "target-project", prompt: NASTY_PROMPT }),
    });
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { ok: boolean; islandId: string; cwd?: string };
    expect(resBody.ok).toBe(true);
    expect(resBody.cwd).toBe("/ws/target-project");

    expect(calls).toHaveLength(1);
    const { cwd, promptFilePath } = calls[0]!;
    capturedFiles.push(promptFilePath);
    expect(cwd).toBe("/ws/target-project");

    // The executor received a path, not the prompt.
    expect(promptFilePath).not.toContain(NASTY_PROMPT);
    expect(promptFilePath).toMatch(/agent-world-dispatch\/[0-9a-f-]+\.txt$/);

    // The file the path points to holds the prompt verbatim...
    const fileContents = await readFile(promptFilePath, "utf8");
    expect(fileContents).toBe(NASTY_PROMPT);

    // ...at mode 0600.
    const fileStat = await stat(promptFilePath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    // And the shell command built from (cwd, path) contains the path but never the
    // raw prompt or any of its dangerous substrings.
    const shellCmd = buildDispatchCommand(cwd, promptFilePath);
    expect(shellCmd).toContain(promptFilePath);
    expect(shellCmd).not.toContain(NASTY_PROMPT);
    expect(shellCmd).not.toContain("rm -rf /");
    expect(shellCmd).not.toContain("echo pwned");
  });

  it("rejects an unknown island with 404, without calling the executor", async () => {
    const calls: unknown[] = [];
    const { base, server: s } = await bootTestServer({ dispatchExecutor: () => { calls.push(1); } });
    server = s;

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "no-such-island", prompt: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("rejects the harness island with 400, without calling the executor", async () => {
    const calls: unknown[] = [];
    const { base, server: s } = await bootTestServer({ dispatchExecutor: () => { calls.push(1); } });
    server = s;

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "harness", prompt: "hello" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty prompt with 400, without calling the executor", async () => {
    const calls: unknown[] = [];
    const { base, server: s } = await bootTestServer({ dispatchExecutor: () => { calls.push(1); } });
    server = s;
    s.db.setIslandForCwd("/ws/target-project", "target-project");

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "target-project", prompt: "" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversized (>4000 char) prompt with 400, without calling the executor", async () => {
    const calls: unknown[] = [];
    const { base, server: s } = await bootTestServer({ dispatchExecutor: () => { calls.push(1); } });
    server = s;
    s.db.setIslandForCwd("/ws/target-project", "target-project");

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "target-project", prompt: "a".repeat(4001) }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("removes the prompt file it wrote when the executor fails (nothing else ever would)", async () => {
    const seen: string[] = [];
    const { base, server: s } = await bootTestServer({
      dispatchExecutor: (_cwd, promptFilePath) => {
        seen.push(promptFilePath);
        throw new Error("osascript: Not authorized to send Apple events to Terminal. (-1743)");
      },
    });
    server = s;
    s.db.setIslandForCwd("/ws/target-project", "target-project");

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "target-project", prompt: "hello" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("-1743");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith(dispatchDir())).toBe(true);
    await expect(stat(seen[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dispatchDir())).not.toContain(basename(seen[0]!));
  });

  it("keeps the prompt file after a timed-out osascript, whose window may still read it", async () => {
    const seen: string[] = [];
    const { base, server: s } = await bootTestServer({
      dispatchExecutor: (_cwd, promptFilePath) => {
        seen.push(promptFilePath);
        throw Object.assign(new Error("Command failed: osascript"), { killed: true, signal: "SIGTERM" });
      },
    });
    server = s;
    s.db.setIslandForCwd("/ws/target-project", "target-project");

    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ islandId: "target-project", prompt: "still wanted" }),
    });
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(1);
    capturedFiles.push(seen[0]!);
    expect(await readFile(seen[0]!, "utf8")).toBe("still wanted");
  });
});
