import { EventEmitter } from "node:events";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatActionResult, ChatOpenResult } from "../../shared/features/chat.js";
import { createChatFeature, type ChatExec } from "../features/chat.js";
import type { RunningServer } from "../index.js";
import { bootTestServer, userLine } from "./helpers.js";

const AGENT = "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";

interface FakeChild {
  proc: ChildProcess;
  stdin: string[];
  signals: string[];
  args: readonly string[];
  cwd: string;
  emitLines(lines: unknown[]): void;
  exit(code: number | null, signal?: string | null): void;
}

function fakeExec(bin: string | null = "/opt/homebrew/bin/claude"): ChatExec & { children: FakeChild[] } {
  const children: FakeChild[] = [];
  return {
    children,
    async findClaude() {
      return bin;
    },
    spawn(_bin, args, cwd) {
      const em = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const written: string[] = [];
      const signals: string[] = [];
      stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
      Object.assign(em, { stdin, stdout, stderr, exitCode: null, signalCode: null, kill: (s: string) => (signals.push(s), true) });
      const child: FakeChild = {
        proc: em as ChildProcess,
        stdin: written,
        signals,
        args,
        cwd,
        emitLines(lines) {
          stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        },
        exit(code, signal = null) {
          stdout.end();
          setTimeout(() => em.emit("close", code, signal), 5);
        },
      };
      children.push(child);
      return em as ChildProcess;
    },
  };
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("chat feature", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(exec: ChatExec, live = false): Promise<{ base: string; cwd: string }> {
    const b = await bootTestServer({ configOverrides: { features: [createChatFeature(exec)] } });
    server = b.server;
    const cwd = join(b.dir, "repo");
    await mkdir(cwd, { recursive: true });
    const proj = join(b.dir, "projects", "-repo");
    await mkdir(proj, { recursive: true });
    const file = join(proj, `${AGENT}.jsonl`);
    await writeFile(file, userLine({ cwd, timestamp: new Date().toISOString(), text: "hi" }) + "\n");
    // "live" = jsonl touched in the last 120s; a dormant agent's file is an hour old.
    if (!live) await utimes(file, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const { runIndexPass } = await import("../indexer.js");
    await runIndexPass(b.server.db, { projectsDir: join(b.dir, "projects") });
    return { base: b.base, cwd };
  }
  const post = (base: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("open → turn spawns claude in the agent's cwd with --resume, streams events, records usage", async () => {
    const exec = fakeExec();
    const { base, cwd } = await boot(exec);
    const open = (await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult;
    expect(open.ok).toBe(true);
    expect(open.liveElsewhere).toBe(false);
    const id = open.chat?.id ?? "";
    // re-opening the same agent returns the same chat
    expect(((await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult).chat?.id).toBe(id);

    const r = await post(base, `/api/chat/${id}/turn`, { text: "reply with the word ok", model: "haiku", mode: "plan" });
    expect(r.status).toBe(200);
    const child = exec.children[0];
    expect(child?.cwd).toBe(cwd);
    expect(child?.args).toContain("--resume");
    expect(child?.args).toContain(AGENT);
    expect(child?.args).not.toContain("--fork-session");
    expect(JSON.parse(child?.stdin.join("") ?? "{}")).toMatchObject({ type: "user", message: { content: [{ type: "text", text: "reply with the word ok" }] } });
    // a second turn while running is refused
    expect((await post(base, `/api/chat/${id}/turn`, { text: "again", model: "haiku", mode: "plan" })).status).toBe(409);

    child?.emitLines([
      { type: "system", subtype: "init", session_id: AGENT, model: "claude-haiku" },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 1 } },
    ]);
    await tick();
    child?.exit(0);
    await tick();
    const after = (await (await fetch(`${base}/api/chat/${id}`)).json()) as ChatOpenResult;
    expect(after.chat).toMatchObject({ running: false, turns: 1, sessionCostUsd: 0.01, usage: { inputTokens: 3, outputTokens: 1 } });
    expect(after.events?.map((e) => e.kind)).toEqual(["user", "init", "assistant-text", "result"]);
  });

  it("exit without a result surfaces an error notice (never a silent success)", async () => {
    const exec = fakeExec();
    const { base } = await boot(exec);
    const id = ((await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult).chat?.id ?? "";
    await post(base, `/api/chat/${id}/turn`, { text: "hi", model: "haiku", mode: "normal" });
    exec.children[0]?.exit(0);
    await tick();
    const after = (await (await fetch(`${base}/api/chat/${id}`)).json()) as ChatOpenResult;
    expect(after.events?.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });

  it("a live session needs the fork acknowledgement, then forks with --fork-session", async () => {
    const exec = fakeExec();
    const { base } = await boot(exec, true);
    const open = (await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult;
    expect(open.liveElsewhere).toBe(true);
    const id = open.chat?.id ?? "";
    const refused = await post(base, `/api/chat/${id}/turn`, { text: "hi", model: "haiku", mode: "normal" });
    expect(refused.status).toBe(409);
    expect(exec.children).toHaveLength(0);
    const ok = await post(base, `/api/chat/${id}/turn`, { text: "hi", model: "haiku", mode: "normal", forkAcknowledged: true });
    expect(ok.status).toBe(200);
    expect(exec.children[0]?.args).toContain("--fork-session");
    const forkId = "11111111-2222-4333-8444-555555555555";
    exec.children[0]?.emitLines([{ type: "system", subtype: "init", session_id: forkId }]);
    await tick();
    exec.children[0]?.exit(0);
    await tick();
    const after = (await (await fetch(`${base}/api/chat/${id}`)).json()) as ChatOpenResult;
    expect(after.chat).toMatchObject({ forked: true, sessionId: forkId });
  });

  it("stop signals only the turn's child: SIGINT first", async () => {
    const exec = fakeExec();
    const { base } = await boot(exec);
    const id = ((await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult).chat?.id ?? "";
    expect((await post(base, `/api/chat/${id}/stop`)).status).toBe(409);
    await post(base, `/api/chat/${id}/turn`, { text: "hi", model: "haiku", mode: "normal" });
    const s = (await (await post(base, `/api/chat/${id}/stop`)).json()) as ChatActionResult;
    expect(s.ok).toBe(true);
    expect(exec.children[0]?.signals).toEqual(["SIGINT"]);
    exec.children[0]?.exit(null, "SIGINT");
    await tick();
    const after = (await (await fetch(`${base}/api/chat/${id}`)).json()) as ChatOpenResult;
    expect(after.events?.at(-1)).toEqual({ kind: "notice", level: "info", text: "Stopped." });
  });

  it("validates requests and attachments; never spawns on a bad one", async () => {
    const exec = fakeExec();
    const { base } = await boot(exec);
    expect((await post(base, "/api/chat/open", { agentId: "nope" })).status).toBe(400);
    expect((await post(base, "/api/chat/open", { agentId: "11111111-2222-4333-8444-555555555555" })).status).toBe(404);
    expect((await post(base, "/api/chat/open", {})).status).toBe(400);
    expect((await post(base, "/api/chat/open", { islandId: "harness" })).status).toBe(400);
    expect((await post(base, "/api/chat/c-000000000000/turn", { text: "x", model: "haiku", mode: "normal" })).status).toBe(404);
    const id = ((await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult).chat?.id ?? "";
    expect((await post(base, `/api/chat/${id}/turn`, { text: "", model: "haiku", mode: "normal" })).status).toBe(400);
    expect((await post(base, `/api/chat/${id}/turn`, { text: "x", model: "gpt", mode: "normal" })).status).toBe(400);
    expect((await post(base, `/api/chat/${id}/turn`, { text: "x", model: "haiku", mode: "yolo" })).status).toBe(400);
    const badAtt = await post(base, `/api/chat/${id}/turn`, { text: "x", model: "haiku", mode: "normal", attachments: [{ name: "a.exe", mime: "application/x-msdownload", dataBase64: "TVqQAAMAAAAEAAAA" }] });
    expect(badAtt.status).toBe(400);
    expect(exec.children).toHaveLength(0);
  });

  it("no claude on PATH → 409", async () => {
    const exec = fakeExec(null);
    const { base } = await boot(exec);
    const id = ((await (await post(base, "/api/chat/open", { agentId: AGENT })).json()) as ChatOpenResult).chat?.id ?? "";
    const r = await post(base, `/api/chat/${id}/turn`, { text: "x", model: "haiku", mode: "normal" });
    expect(r.status).toBe(409);
  });
});
