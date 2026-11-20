import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { TermServerMessage } from "../../shared/features/term.js";
import type { TalkExec } from "../features/talk.js";
import { createTermFeature, parseClientMessage, type PtyProcess, type PtySpawner } from "../features/term.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { bootTestServer, userLine, writeSessionFile } from "./helpers.js";

const execFileAsync = promisify(execFile);
const AGENT = "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff";
const QA_SESSION = "aw-qa-pty"; // the ONLY tmux session these tests create or kill
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find((p) => existsSync(p)) ?? null;

const noTalk: TalkExec = {
  async findTmux() {
    return "/opt/homebrew/bin/tmux";
  },
  async run() {
    throw new Error("no session");
  },
  async capture() {
    return "";
  },
  async captureAll() {
    return "";
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

function fakePty(): { spawner: PtySpawner; spawned: Array<{ file: string; args: string[] }>; writes: string[]; resizes: Array<[number, number]>; killed: () => number; emit: (d: string) => void } {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let kills = 0;
  let onData: (d: string) => void = () => {};
  const spawner: PtySpawner = (file, args) => {
    spawned.push({ file, args });
    const p: PtyProcess = {
      onData: (cb) => {
        onData = cb;
      },
      onExit: () => {},
      write: (d) => void writes.push(d),
      resize: (c, r) => void resizes.push([c, r]),
      kill: () => {
        kills += 1;
      },
    };
    return p;
  };
  return { spawner, spawned, writes, resizes, killed: () => kills, emit: (d) => onData(d) };
}

function open(url: string, origin = "http://localhost:5178"): Promise<{ ws: WebSocket; messages: TermServerMessage[] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url, { headers: { origin } });
    const messages: TermServerMessage[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(String(d)) as TermServerMessage));
    ws.once("open", () => resolvePromise({ ws, messages }));
    ws.once("unexpected-response", (_req, res) => rejectPromise(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", rejectPromise);
  });
}

async function until<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("term (WS /ws/term/:agentId)", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(feature: ReturnType<typeof createTermFeature>): Promise<string> {
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    const projects = join(b.dir, "projects");
    await writeSessionFile(projects, "-repo", AGENT, userLine({ cwd: "/repo", timestamp: new Date().toISOString(), text: "hi" }) + "\n");
    await runIndexPass(b.server.db, { projectsDir: projects });
    return b.base.replace("http://", "ws://");
  }

  it("rejects a cross-site Origin and a non-loopback Host before the handshake (403)", async () => {
    const pty = fakePty();
    const base = await boot(createTermFeature({ loadPty: async () => pty.spawner, resolveSession: async () => ({ ok: true, tmuxPath: "/x/tmux", tmuxName: "aw-abcd1234" }) }));
    await expect(open(`${base}/ws/term/${AGENT}`, "https://evil.example")).rejects.toThrow("HTTP 403");
    await expect(open(`${base}/ws/term/${AGENT}`, "http://localhost.evil.example")).rejects.toThrow("HTTP 403");
    const port = new URL(base).port;
    await expect(
      new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${AGENT}`, { headers: { host: `evil.example:${port}` } });
        ws.once("open", () => resolvePromise("open"));
        ws.once("unexpected-response", (_r, res) => rejectPromise(new Error(`HTTP ${res.statusCode}`)));
        ws.once("error", rejectPromise);
      }),
    ).rejects.toThrow("HTTP 403");
    expect(pty.spawned).toHaveLength(0);
  });

  it("keeps the hub /ws working and 404s unknown WS paths", async () => {
    const base = await boot(createTermFeature({ loadPty: async () => null }));
    const { ws, messages } = await open(`${base}/ws`);
    await until(() => messages.length > 0 || undefined);
    ws.close();
    await expect(open(`${base}/ws/nope`)).rejects.toThrow("HTTP 404");
  });

  it("refuses agents without a live world tmux session (no PTY spawned)", async () => {
    const pty = fakePty();
    const base = await boot(createTermFeature({ exec: noTalk, loadPty: async () => pty.spawner }));
    const { ws, messages } = await open(`${base}/ws/term/${AGENT}`);
    const err = await until(() => messages.find((m) => m.type === "error"));
    expect(err).toMatchObject({ type: "error" });
    await until(() => ws.readyState === WebSocket.CLOSED || undefined);
    const bad = await open(`${base}/ws/term/not-a-uuid`);
    expect(await until(() => bad.messages.find((m) => m.type === "error"))).toEqual({ type: "error", error: "invalid agent id" });
    expect(pty.spawned).toHaveLength(0);
  });

  it("attaches one PTY per socket, forwards input + resize, kills only the attach client on close", async () => {
    const pty = fakePty();
    const base = await boot(
      createTermFeature({ loadPty: async () => pty.spawner, resolveSession: async () => ({ ok: true, tmuxPath: "/x/tmux", tmuxName: "aw-abcd1234" }) }),
    );
    const { ws, messages } = await open(`${base}/ws/term/${AGENT}?cols=100&rows=30`);
    ws.send(JSON.stringify({ type: "resize", cols: 90, rows: 20 })); // may arrive before the PTY is up: replayed
    const ready = await until(() => messages.find((m) => m.type === "ready"));
    expect(ready).toEqual({ type: "ready", mode: "pty", tmuxName: "aw-abcd1234", cols: 100, rows: 30 });
    expect(pty.spawned).toEqual([{ file: "/x/tmux", args: ["attach-session", "-t", "=aw-abcd1234"] }]);
    ws.send(JSON.stringify({ type: "input", data: "ls\r" }));
    ws.send("not json");
    ws.send(JSON.stringify({ type: "resize", cols: 99999, rows: -3 }));
    await until(() => pty.writes.length > 0 || undefined);
    await until(() => pty.resizes.length >= 2 || undefined);
    expect(pty.writes).toEqual(["ls\r"]);
    expect(pty.resizes).toEqual([
      [90, 20],
      [500, 5],
    ]);
    pty.emit("\u001b[32mhi\u001b[0m");
    expect(await until(() => messages.find((m) => m.type === "output"))).toEqual({ type: "output", data: "\u001b[32mhi\u001b[0m" });
    ws.close();
    await until(() => pty.killed() === 1 || undefined);
  });

  it("parseClientMessage validates shape and caps input", () => {
    expect(parseClientMessage('{"type":"input","data":"x"}')).toEqual({ type: "input", data: "x" });
    expect(parseClientMessage(JSON.stringify({ type: "input", data: "x".repeat(70_000) }))).toBeNull();
    expect(parseClientMessage('{"type":"exec","cmd":"rm"}')).toBeNull();
    expect(parseClientMessage('{"type":"resize","cols":"a","rows":2}')).toBeNull();
  });
});

describe.skipIf(TMUX === null)("term — real PTY round-trip against a dummy tmux session", () => {
  let server: RunningServer | null = null;
  const tmux = TMUX ?? "tmux";
  const tmuxRun = (args: string[]): Promise<{ stdout: string }> => execFileAsync(tmux, args, { timeout: 5000 });

  let openSocket: WebSocket | null = null;
  afterAll(async () => {
    openSocket?.terminate();
    await server?.close();
    await tmuxRun(["kill-session", "-t", `=${QA_SESSION}`]).catch(() => undefined);
  });

  it("types into `cat` through node-pty + tmux attach, then detaches without killing the session", async () => {
    await tmuxRun(["kill-session", "-t", `=${QA_SESSION}`]).catch(() => undefined);
    await tmuxRun(["new-session", "-d", "-s", QA_SESSION, "-x", "80", "-y", "24", "cat"]);
    const b = await bootTestServer({
      configOverrides: { features: [createTermFeature({ resolveSession: async () => ({ ok: true, tmuxPath: tmux, tmuxName: QA_SESSION }) })] },
    });
    server = b.server;
    const projects = join(b.dir, "projects");
    await writeSessionFile(projects, "-repo", AGENT, userLine({ cwd: "/repo", timestamp: new Date().toISOString(), text: "hi" }) + "\n");
    await runIndexPass(b.server.db, { projectsDir: projects });

    const { ws, messages } = await open(`${b.base.replace("http://", "ws://")}/ws/term/${AGENT}?cols=80&rows=24`);
    const ready = await until(() => messages.find((m) => m.type === "ready"), 8000);
    expect(ready).toMatchObject({ mode: "pty", tmuxName: QA_SESSION });
    openSocket = ws;
    const countClients = async (): Promise<number> =>
      (await tmuxRun(["list-clients", "-t", `=${QA_SESSION}`])).stdout.trim().split("\n").filter(Boolean).length;
    let attached = 0;
    for (let i = 0; i < 50 && attached === 0; i++) {
      attached = await countClients();
      if (attached === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(attached).toBe(1); // exactly one attach client: ours

    ws.send(JSON.stringify({ type: "input", data: "hello-pty-roundtrip\r" }));
    await until(() => messages.some((m) => m.type === "output" && m.data.includes("hello-pty-roundtrip")) || undefined, 8000);
    // tty echo + cat's own output: the line appears twice in the pane.
    const captured = await tmuxRun(["capture-pane", "-p", "-t", `=${QA_SESSION}:`]);
    expect(captured.stdout.split("hello-pty-roundtrip").length - 1).toBeGreaterThanOrEqual(2);

    ws.close();
    const t0 = Date.now();
    let remaining = 1;
    while (Date.now() - t0 < 5000) {
      const out = await tmuxRun(["list-clients", "-t", `=${QA_SESSION}`]);
      remaining = out.stdout.trim().split("\n").filter(Boolean).length;
      if (remaining === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(remaining).toBe(0); // the attach client is gone…
    await expect(tmuxRun(["has-session", "-t", `=${QA_SESSION}`])).resolves.toBeDefined(); // …the session is not
  }, 20_000);

  it("mirror fallback (no node-pty): streams the pane and types input with send-keys -l", async () => {
    await tmuxRun(["kill-session", "-t", `=${QA_SESSION}`]).catch(() => undefined);
    await tmuxRun(["new-session", "-d", "-s", QA_SESSION, "-x", "80", "-y", "24", "cat"]);
    await server?.close();
    const b = await bootTestServer({
      configOverrides: {
        features: [createTermFeature({ loadPty: async () => null, mirrorIntervalMs: 100, resolveSession: async () => ({ ok: true, tmuxPath: tmux, tmuxName: QA_SESSION }) })],
      },
    });
    server = b.server;
    const projects = join(b.dir, "projects");
    await writeSessionFile(projects, "-repo", AGENT, userLine({ cwd: "/repo", timestamp: new Date().toISOString(), text: "hi" }) + "\n");
    await runIndexPass(b.server.db, { projectsDir: projects });
    const { ws, messages } = await open(`${b.base.replace("http://", "ws://")}/ws/term/${AGENT}`);
    openSocket = ws;
    expect(await until(() => messages.find((m) => m.type === "ready"), 8000)).toMatchObject({ mode: "mirror" });
    ws.send(JSON.stringify({ type: "input", data: "mirror-line" }));
    await until(() => messages.some((m) => m.type === "screen" && m.data.includes("mirror-line")) || undefined, 8000);
    ws.close();
    await expect(tmuxRun(["has-session", "-t", `=${QA_SESSION}`])).resolves.toBeDefined();
  }, 20_000);
});
