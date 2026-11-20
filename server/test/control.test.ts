import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_NOT_TMUX_ERROR, type ControlResult } from "../../shared/features/control.js";
import { createControlFeature } from "../features/control.js";
import type { TalkExec } from "../features/talk.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { bootTestServer, userLine, writeSessionFile } from "./helpers.js";

const BOUND = "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";
const PLAIN = "8d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";

function fakeExec(pane: string, live = new Set(["aw-7d3f0c2a"])): TalkExec & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async findTmux() {
      return "/opt/homebrew/bin/tmux";
    },
    async run(_file, args) {
      calls.push([...args]);
      if (args[0] === "has-session" && !live.has(String(args[2]).replace(/^=/, ""))) throw new Error("no session");
    },
    async capture() {
      return pane;
    },
    async captureAll() {
      return pane;
    },
    async startCommand() {
      return "";
    },
    async paneCounts() {
      return "1 1";
    },
    openTerminal() {
      throw new Error("never");
    },
  };
}

describe("control", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(exec: TalkExec): Promise<string> {
    const b = await bootTestServer({ configOverrides: { features: [createControlFeature(exec)] } });
    server = b.server;
    const projects = join(b.dir, "projects");
    const now = new Date().toISOString();
    await writeSessionFile(projects, "-repo", BOUND, userLine({ cwd: "/repo", timestamp: now, text: "hi" }) + "\n");
    await writeSessionFile(projects, "-repo", PLAIN, userLine({ cwd: "/repo", timestamp: now, text: "hi" }) + "\n");
    await runIndexPass(b.server.db, { projectsDir: projects });
    b.server.db.setMeta("talk.bindings", JSON.stringify([{ agentId: BOUND, tmuxName: "aw-7d3f0c2a", cwd: "/repo", startedAt: now }]));
    return b.base;
  }
  const post = async (base: string, path: string, body: unknown = {}): Promise<{ status: number; body: ControlResult }> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as ControlResult };
  };

  it("interrupt sends Escape (soft) or C-c (hard) to the bound tmux session, never kills", async () => {
    const exec = fakeExec("❯ working…");
    const base = await boot(exec);
    expect(await post(base, `/api/agents/${BOUND}/interrupt`)).toEqual({ status: 200, body: { ok: true, tmuxName: "aw-7d3f0c2a", sent: "Escape" } });
    expect((await post(base, `/api/agents/${BOUND}/interrupt?hard=1`)).body.sent).toBe("C-c");
    const keys = exec.calls.filter((c) => c[0] === "send-keys");
    expect(keys).toEqual([
      ["send-keys", "-t", "aw-7d3f0c2a", "Escape"],
      ["send-keys", "-t", "aw-7d3f0c2a", "C-c"],
    ]);
    expect(exec.calls.some((c) => c[0] === "kill-session" || c[0] === "kill-server" || c[0] === "kill-pane")).toBe(false);
  });

  it("refuses non-tmux agents with 409 'open its Terminal to stop it'", async () => {
    const exec = fakeExec("");
    const base = await boot(exec);
    expect(await post(base, `/api/agents/${PLAIN}/interrupt`)).toEqual({ status: 409, body: { ok: false, error: CONTROL_NOT_TMUX_ERROR } });
    expect(exec.calls.some((c) => c[0] === "send-keys")).toBe(false);
  });

  it("refuses a bound agent whose tmux session has ended", async () => {
    const exec = fakeExec("", new Set());
    const base = await boot(exec);
    expect((await post(base, `/api/agents/${BOUND}/interrupt`)).status).toBe(409);
  });

  it("rejects bad ids and non-JSON writes", async () => {
    const base = await boot(fakeExec(""));
    expect((await post(base, `/api/agents/nope/interrupt`)).status).toBe(400);
    const res = await fetch(`${base}/api/agents/${BOUND}/interrupt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
  });

  it("note types into the session via the talk path, with its prompt-safety", async () => {
    const exec = fakeExec("❯ \n  ? for shortcuts");
    const base = await boot(exec);
    const ok = await post(base, `/api/agents/${BOUND}/note`, { text: "also check\nthe tests" });
    expect(ok).toEqual({ status: 200, body: { ok: true, tmuxName: "aw-7d3f0c2a", sent: "note" } });
    expect(exec.calls.filter((c) => c[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "aw-7d3f0c2a", "-l", "also check the tests"],
      ["send-keys", "-t", "aw-7d3f0c2a", "Enter"],
    ]);
    expect((await post(base, `/api/agents/${PLAIN}/note`, { text: "hi" })).status).toBe(404);
    expect((await post(base, `/api/agents/${BOUND}/note`, { text: "" })).status).toBe(400);
  });

  it("note refuses while the pane shows a permission prompt", async () => {
    const exec = fakeExec("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    const base = await boot(exec);
    const r = await post(base, `/api/agents/${BOUND}/note`, { text: "go" });
    expect(r.status).toBe(409);
    expect(exec.calls.some((c) => c[0] === "send-keys")).toBe(false);
  });
});
