// "term": a real terminal in the browser for tmux-bound agents.
// WS /ws/term/:agentId (the hub applies the same loopback Host/Origin guard as /ws before
// we see the upgrade). Each socket gets its own PTY running `tmux attach -t =aw-…`, so the
// browser is just one more tmux client next to Terminal.app. Closing the socket kills that
// attach process only; the tmux session (and the claude inside it) keeps running.
//
// Input is forwarded as typed: this is the user at a keyboard, deliberately. The
// prompt-safety guard (paneShowsPrompt) stays on the talk/note endpoints, which type on
// the user's behalf.
//
// Fallback: when node-pty cannot load (native build missing), a read-only-ish mirror polls
// `tmux capture-pane -e -p` and types input with `send-keys -l`. argv only, never a shell.

import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { TERM_MAX_INPUT_CHARS, type TermServerMessage } from "../../shared/features/term.js";
import { isRecord } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { boundTmuxSession, loadTalkBindings, realTalkExec, type TalkExec } from "./talk.js";

const execFileAsync = promisify(execFile);
const TERM_TMUX_NAME_RE = /^aw-[a-z0-9-]{2,32}$/;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/** The subset of node-pty's IPty we use (kept local so tests can fake it). */
export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawner = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess;

export type SessionResolution = { ok: true; tmuxPath: string; tmuxName: string } | { ok: false; error: string };

export interface TermDeps {
  exec?: TalkExec;
  /** Which tmux session serves this agent. Default: its talk binding, if that session is alive. */
  resolveSession?(ctx: FeatureContext, agentId: string): Promise<SessionResolution>;
  /** Loads the PTY spawner; null = node-pty unavailable → mirror mode. */
  loadPty?(): Promise<PtySpawner | null>;
  mirrorIntervalMs?: number;
}

async function loadNodePty(): Promise<PtySpawner | null> {
  try {
    const mod = await import("node-pty");
    // Self-check: node-pty 1.1.0's darwin prebuild ships spawn-helper without +x, so the
    // module imports fine and then every spawn fails ("posix_spawnp failed"). Probe once and
    // fall back to the mirror instead of failing each connection. (A source build fixes it.)
    await new Promise<void>((resolveProbe, rejectProbe) => {
      const probe = mod.spawn("/usr/bin/true", [], { cols: 10, rows: 5 });
      probe.onExit(() => resolveProbe());
      setTimeout(() => rejectProbe(new Error("pty probe timed out")), 3000);
    });
    return (file, args, opts) => {
      const p = mod.spawn(file, args, { name: "xterm-256color", ...opts });
      return {
        onData: (cb) => void p.onData(cb),
        onExit: (cb) => void p.onExit((e) => cb({ exitCode: e.exitCode })),
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill: (sig) => p.kill(sig),
      };
    };
  } catch {
    return null;
  }
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = typeof cols === "number" ? cols : Number(cols);
  const r = typeof rows === "number" ? rows : Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  return { cols: Math.min(500, Math.max(10, Math.round(c))), rows: Math.min(200, Math.max(5, Math.round(r))) };
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  delete env.TMUX; // attaching from inside tmux would refuse ("sessions should be nested with care")
  delete env.TMUX_PANE;
  env.TERM = "xterm-256color";
  return env;
}

function send(ws: WebSocket, msg: TermServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

type ClientMsg = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number } | null;

export function parseClientMessage(raw: string): ClientMsg {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  if (v.type === "input" && typeof v.data === "string" && v.data.length <= TERM_MAX_INPUT_CHARS) return { type: "input", data: v.data };
  if (v.type === "resize") {
    const size = clampSize(v.cols, v.rows);
    return size ? { type: "resize", ...size } : null;
  }
  return null;
}

export function createTermFeature(deps: TermDeps = {}): ServerFeature {
  const exec = deps.exec ?? realTalkExec;
  const mirrorMs = deps.mirrorIntervalMs ?? 300;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  let ptyPromise: Promise<PtySpawner | null> | null = null;
  let warnedMirror = false;

  const resolveSession =
    deps.resolveSession ??
    (async (ctx: FeatureContext, agentId: string): Promise<SessionResolution> => {
      const r = await boundTmuxSession(exec, await exec.findTmux(), loadTalkBindings(ctx.db), agentId);
      return r.ok ? r : { ok: false, error: r.error };
    });

  function attachPty(ws: WebSocket, spawn: PtySpawner, tmuxPath: string, tmuxName: string, size: { cols: number; rows: number }, ctx: FeatureContext): void {
    let pty: PtyProcess;
    try {
      pty = spawn(tmuxPath, ["attach-session", "-t", `=${tmuxName}`], { ...size, cwd: homedir(), env: childEnv() });
    } catch (err) {
      send(ws, { type: "error", error: `could not start a terminal: ${String(err)}` });
      ws.close(1011);
      return;
    }
    let exited = false;
    send(ws, { type: "ready", mode: "pty", tmuxName, ...size });
    pty.onData((data) => send(ws, { type: "output", data }));
    pty.onExit(({ exitCode }) => {
      exited = true;
      send(ws, { type: "exit", code: exitCode });
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    });
    ws.on("message", (data) => {
      const msg = parseClientMessage(rawToString(data));
      if (!msg || exited) return;
      if (msg.type === "input") pty.write(msg.data);
      else pty.resize(msg.cols, msg.rows);
    });
    ws.on("close", () => {
      // Only the attach client dies (SIGHUP detaches it); the tmux session keeps running.
      if (!exited) {
        try {
          pty.kill("SIGHUP");
        } catch {
          /* already gone */
        }
      }
      ctx.log.info("term", `detached from ${tmuxName}`);
    });
  }

  function attachMirror(ws: WebSocket, tmuxPath: string, tmuxName: string, size: { cols: number; rows: number }, ctx: FeatureContext): void {
    send(ws, { type: "ready", mode: "mirror", tmuxName, ...size });
    let last = "";
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const { stdout } = await execFileAsync(tmuxPath, ["capture-pane", "-e", "-p", "-t", `=${tmuxName}:`], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
          if (stdout !== last) {
            last = stdout;
            send(ws, { type: "screen", data: stdout });
          }
        } catch {
          send(ws, { type: "exit", code: null });
          ws.close(1000);
        } finally {
          busy = false;
        }
      })();
    }, mirrorMs);
    ws.on("message", (data) => {
      const msg = parseClientMessage(rawToString(data));
      if (!msg || msg.type !== "input") return;
      void exec.run(tmuxPath, ["send-keys", "-t", `=${tmuxName}:`, "-l", msg.data]).catch((err: unknown) => {
        ctx.log.warn("term", "mirror send-keys failed", String(err));
      });
    });
    ws.on("close", () => clearInterval(timer));
  }

  async function onConnection(ws: WebSocket, req: IncomingMessage, ctx: FeatureContext, agentId: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const size = clampSize(url.searchParams.get("cols") ?? DEFAULT_COLS, url.searchParams.get("rows") ?? DEFAULT_ROWS) ?? {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    // Messages sent before the PTY is up (typically the first resize) are replayed after attach.
    const early: RawData[] = [];
    const queue = (d: RawData): void => void early.push(d);
    ws.on("message", queue);
    if (!isValidUuid(agentId)) {
      send(ws, { type: "error", error: "invalid agent id" });
      ws.close(4400);
      return;
    }
    const target = await resolveSession(ctx, agentId);
    if (!target.ok || !TERM_TMUX_NAME_RE.test(target.tmuxName)) {
      send(ws, { type: "error", error: target.ok ? "invalid tmux session name" : target.error });
      ws.close(4404);
      return;
    }
    ptyPromise ??= (deps.loadPty ?? loadNodePty)();
    const spawn = await ptyPromise;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (spawn) {
      attachPty(ws, spawn, target.tmuxPath, target.tmuxName, size, ctx);
    } else {
      if (!warnedMirror) {
        warnedMirror = true;
        ctx.log.warn("term", "node-pty unavailable: falling back to a capture-pane mirror");
      }
      attachMirror(ws, target.tmuxPath, target.tmuxName, size, ctx);
    }
    ws.off("message", queue);
    for (const d of early) ws.emit("message", d, false);
    ctx.log.info("term", `attached to ${target.tmuxName} (${spawn ? "pty" : "mirror"})`);
  }

  return {
    id: "term",
    upgrades: [
      {
        path: "/ws/term/:agentId",
        handler(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: FeatureContext, params) {
          const agentId = params.agentId ?? "";
          wss.handleUpgrade(req, socket, head, (ws) => {
            void onConnection(ws, req, ctx, agentId).catch((err: unknown) => {
              ctx.log.error("term", "connection failed", String(err));
              send(ws, { type: "error", error: "internal error" });
              ws.close(1011);
            });
          });
        },
      },
    ],
  };
}

export const termFeature = createTermFeature();
