// Pure parts of the in-app terminal (ui/terminal.ts): the WS url, the client → server frames,
// how a server frame is read, and the words shown for each connection state. DOM-free so it is
// unit-tested (terminal-lib.test.ts). Wire format: shared/features/term.ts (B's PTY bridge).

import { TALK_INSTALL_HINT } from "../../../shared/features/talk";
import type { TermClientMessage } from "../../../shared/features/term";
import { RUNNING_ELSEWHERE_TEXT, type ResumeOffer } from "../features/resume-guard";

export type TermState = "connecting" | "live" | "ended" | "unavailable";

/** ws(s)://<same origin>/ws/term/<agentId>[?cols=&rows=] (through the Vite proxy in dev). */
export function termUrl(loc: { protocol: string; host: string }, agentId: string, size?: { cols: number; rows: number }): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${loc.host}/ws/term/${encodeURIComponent(agentId)}`;
  if (!size || !(size.cols >= 10) || !(size.rows >= 5)) return base;
  return `${base}?cols=${Math.min(500, Math.floor(size.cols))}&rows=${Math.min(200, Math.floor(size.rows))}`;
}

export function inputFrame(data: string): string {
  const msg: TermClientMessage = { type: "input", data };
  return JSON.stringify(msg);
}

/** Terminal size, clamped to something a pty accepts. Null when the size is not usable yet. */
export function resizeFrame(cols: number, rows: number): string | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 1) return null;
  const c = Math.min(500, Math.floor(cols));
  const r = Math.min(200, Math.floor(rows));
  const msg: TermClientMessage = { type: "resize", cols: c, rows: r };
  return JSON.stringify(msg);
}

export type ServerFrame =
  | { kind: "output"; data: string }
  /** Mirror mode: the full visible pane; clear and redraw. */
  | { kind: "screen"; data: string }
  | { kind: "state"; state: TermState; message?: string }
  | { kind: "ignore" };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reads one text frame from the bridge. JSON envelopes carry output or a state change;
 * anything that is not a JSON envelope is raw pty output (written as-is).
 */
export function parseServerFrame(raw: string): ServerFrame {
  const first = raw.charCodeAt(0);
  if (first !== 123 /* { */) return { kind: "output", data: raw };
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "output", data: raw };
  }
  if (!isObj(msg) || typeof msg.type !== "string") return { kind: "output", data: raw };
  const message = typeof msg.message === "string" ? msg.message : typeof msg.error === "string" ? msg.error : undefined;
  switch (msg.type) {
    case "output":
    case "data":
      return typeof msg.data === "string" ? { kind: "output", data: msg.data } : { kind: "ignore" };
    case "screen":
      return typeof msg.data === "string" ? { kind: "screen", data: msg.data } : { kind: "ignore" };
    case "ready":
    case "attached":
    case "open":
      return { kind: "state", state: "live", message };
    case "exit":
    case "ended":
    case "closed":
      return { kind: "state", state: "ended", message };
    case "unavailable":
    case "not-available":
    case "no-tmux":
      return { kind: "state", state: "unavailable", message };
    case "error":
      return { kind: "state", state: "unavailable", message };
    case "status":
    case "state": {
      const s = msg.state ?? msg.status;
      if (s === "live" || s === "attached" || s === "ready") return { kind: "state", state: "live", message };
      if (s === "ended" || s === "exit" || s === "closed") return { kind: "state", state: "ended", message };
      if (s === "unavailable" || s === "not-available" || s === "plain") return { kind: "state", state: "unavailable", message };
      return { kind: "ignore" };
    }
    default:
      return { kind: "ignore" };
  }
}

/** What a socket close means: never opened / policy code → not available; else ended. */
export function stateAfterClose(code: number, everOpened: boolean, current: TermState): TermState {
  if (current === "unavailable") return "unavailable";
  if (!everOpened) return "unavailable";
  // 4000-4999 are app codes; the bridge uses 44xx for "no tmux pane for this agent".
  if (code >= 4400 && code < 4500) return "unavailable";
  if (code === 1008) return "unavailable";
  return "ended";
}

export const NOT_AVAILABLE_TEXT = "This agent runs in a plain terminal. Resume it here to chat.";

/** The "not available" overlay: its text, and whether it offers "Resume here". `offer` comes from
 *  the host's resume guard at render time (undefined when the host has none); a live agent in
 *  another terminal gets no Resume, because resuming it would start a second copy. */
export function unavailableView(offer: ResumeOffer | undefined, hasResume: boolean): { text: string; resume: boolean } {
  if (offer === "running-elsewhere") return { text: RUNNING_ELSEWHERE_TEXT, resume: false };
  if (offer === "no-tmux") return { text: TALK_INSTALL_HINT, resume: false };
  return { text: NOT_AVAILABLE_TEXT, resume: hasResume };
}

export function stateLabel(state: TermState): { dot: string; text: string } {
  switch (state) {
    case "connecting":
      return { dot: "connecting", text: "Connecting…" };
    case "live":
      return { dot: "live", text: "Live" };
    case "ended":
      return { dot: "ended", text: "Session ended" };
    case "unavailable":
      return { dot: "unavailable", text: "Not available" };
  }
}

/** Light "comic" theme for xterm: cream page, ink text, readable ANSI colours on a bright background. */
export const TERM_THEME = {
  background: "#fffdf6",
  foreground: "#1a1030",
  cursor: "#ff4d8d",
  cursorAccent: "#fffdf6",
  selectionBackground: "#ffd23f80",
  black: "#1a1030",
  red: "#c4204f",
  green: "#0b6e35",
  yellow: "#8a5a00",
  blue: "#3b3fc4",
  magenta: "#9b2fa8",
  cyan: "#0a6b7c",
  white: "#6b5f86",
  brightBlack: "#6b5f86",
  brightRed: "#e0366a",
  brightGreen: "#18894a",
  brightYellow: "#a86f00",
  brightBlue: "#5b3fc4",
  brightMagenta: "#b43fc4",
  brightCyan: "#0e8298",
  brightWhite: "#3d3356",
} as const;
