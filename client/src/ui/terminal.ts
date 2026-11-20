// Reusable in-app terminal: xterm.js in a comic frame, wired to the agent's tmux pane through
// B's PTY bridge (WS /ws/term/:agentId, loopback + origin guarded on the server). Used by the
// Code view's bottom panel and the Room view. Pure parts live in terminal-lib.ts.
//
//   const term = createTerminal(el, agentId, { onResume: () => … });
//   term.focus(); … term.dispose();

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ResumeOffer } from "../features/resume-guard";
import { log } from "../log";
import {
  TERM_THEME,
  type TermState,
  inputFrame,
  parseServerFrame,
  resizeFrame,
  stateAfterClose,
  stateLabel,
  termUrl,
  unavailableView,
} from "./terminal-lib";
import "./terminal.css";

export interface TerminalOpts {
  /** Title in the frame's header (default "Terminal"). */
  title?: string;
  /** Font size in px (default 13; 12 is the floor). */
  fontSize?: number;
  /** Keystrokes are not sent (watch-only). Default false. */
  readOnly?: boolean;
  /** Shown as a "Resume here" button in the not-available state (e.g. start the agent in tmux). */
  onResume?: () => void | Promise<void>;
  /** The resume guard, asked on every not-available render and again on the click: anything but
   *  "resume"/"bound" hides the button (a live agent elsewhere would get a second copy). */
  resumeOffer?: () => ResumeOffer;
  /** Every connection state change. */
  onState?: (state: TermState) => void;
  /** Hide the frame header (the host draws its own). */
  bare?: boolean;
}

export interface TerminalHandle {
  dispose(): void;
  focus(): void;
  /** Reconnect (after "ended" / "not available"). */
  reconnect(): void;
  state(): TermState;
}

export function createTerminal(el: HTMLElement, agentId: string, opts: TerminalOpts = {}): TerminalHandle {
  const frame = document.createElement("div");
  frame.className = "aw-term";
  const head = document.createElement("div");
  head.className = "aw-term-head";
  const title = document.createElement("span");
  title.className = "aw-term-title";
  title.textContent = opts.title ?? "Terminal";
  const status = document.createElement("span");
  status.className = "aw-term-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const dot = document.createElement("span");
  dot.className = "aw-term-dot";
  dot.setAttribute("aria-hidden", "true");
  const statusText = document.createElement("span");
  status.append(dot, statusText);
  head.append(title, status);
  if (opts.bare) head.hidden = true;

  const screen = document.createElement("div");
  screen.className = "aw-term-screen";
  const overlay = document.createElement("div");
  overlay.className = "aw-term-overlay";
  overlay.hidden = true;
  const overlayText = document.createElement("p");
  const overlayDetail = document.createElement("small");
  overlayDetail.className = "aw-term-detail";
  const overlayBtns = document.createElement("div");
  overlayBtns.className = "aw-term-btns";
  overlay.append(overlayText, overlayDetail, overlayBtns);

  frame.append(head, screen, overlay);
  el.append(frame);

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
    fontSize: Math.max(12, opts.fontSize ?? 13),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 4000,
    allowProposedApi: false,
    disableStdin: opts.readOnly === true,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(screen);

  let ws: WebSocket | null = null;
  let state: TermState = "connecting";
  let everOpened = false;
  let disposed = false;
  let lastSize = "";

  const setState = (next: TermState, message?: string): void => {
    state = next;
    const l = stateLabel(next);
    frame.dataset.state = next;
    dot.dataset.dot = l.dot;
    statusText.textContent = l.text;
    overlayBtns.replaceChildren();
    if (next === "unavailable" || next === "ended") {
      overlay.hidden = false;
      const view = unavailableView(opts.resumeOffer?.(), opts.onResume !== undefined);
      overlayText.textContent = next === "unavailable" ? view.text : message ?? "The session ended.";
      overlayDetail.textContent = next === "unavailable" && message ? message : "";
      overlayDetail.hidden = !overlayDetail.textContent;
      if (next === "unavailable" && view.resume) {
        const resume = button("Resume here", "aw-term-primary");
        resume.addEventListener("click", () => {
          // Checked again at click time: the agent may have started elsewhere since this rendered.
          if (!unavailableView(opts.resumeOffer?.(), true).resume) return setState("unavailable", message);
          const r = opts.onResume?.();
          if (r instanceof Promise) void r.then(() => reconnect(), (err: unknown) => log.warn("terminal", "resume failed", err));
          else reconnect();
        });
        overlayBtns.append(resume);
      }
      const retry = button("Reconnect");
      retry.addEventListener("click", () => reconnect());
      overlayBtns.append(retry);
    } else {
      overlay.hidden = true;
    }
    opts.onState?.(next);
  };

  const sendSize = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const f = resizeFrame(term.cols, term.rows);
    if (f && f !== lastSize) {
      lastSize = f;
      ws.send(f);
    }
  };

  const refit = (): void => {
    if (disposed || frame.offsetParent === null) return;
    try {
      fit.fit();
    } catch (err) {
      log.warn("terminal", "fit failed", err);
    }
    sendSize();
  };

  const connect = (): void => {
    if (disposed) return;
    everOpened = false;
    lastSize = "";
    setState("connecting");
    let sock: WebSocket;
    try {
      sock = new WebSocket(termUrl(location, agentId, { cols: term.cols, rows: term.rows }));
    } catch (err) {
      log.warn("terminal", "could not open the terminal socket", err);
      setState("unavailable");
      return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.addEventListener("open", () => {
      if (ws !== sock) return;
      everOpened = true;
      // Stay "connecting" until the bridge says ready (it may still refuse with an error frame).
      refit();
      sendSize();
    });
    sock.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (ws !== sock) return;
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
        return;
      }
      if (typeof data !== "string") return;
      const f = parseServerFrame(data);
      if ((f.kind === "output" || f.kind === "screen") && state === "connecting") setState("live");
      if (f.kind === "output") term.write(f.data);
      // Mirror mode sends the whole pane; its trailing blank rows would scroll the text away.
      else if (f.kind === "screen") term.write(`\x1b[H\x1b[2J${f.data.replace(/(?:\r?\n[ \t]*)+$/, "")}`);
      else if (f.kind === "state" && f.state !== state) setState(f.state, f.message);
    });
    sock.addEventListener("close", (ev: CloseEvent) => {
      if (ws !== sock || disposed) return;
      ws = null;
      setState(stateAfterClose(ev.code, everOpened, state), ev.reason || undefined);
    });
    sock.addEventListener("error", () => {
      // "close" follows and carries the state; nothing sensitive logged here.
      log.warn("terminal", `terminal socket error for ${agentId.slice(0, 8)}`);
    });
  };

  const reconnect = (): void => {
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    term.reset();
    connect();
  };

  const inputSub = term.onData((d) => {
    if (opts.readOnly || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(inputFrame(d));
  });
  const resizeSub = term.onResize(() => sendSize());
  const ro = new ResizeObserver(() => refit());
  ro.observe(screen);

  connect();
  requestAnimationFrame(() => refit());

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      inputSub.dispose();
      resizeSub.dispose();
      if (ws) {
        const old = ws;
        ws = null;
        old.close(1000, "closed by viewer");
      }
      term.dispose();
      frame.remove();
    },
    focus(): void {
      term.focus();
    },
    reconnect,
    state: () => state,
  };
}

function button(label: string, extra = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `aw-term-btn ${extra}`.trim();
  b.textContent = label;
  return b;
}
