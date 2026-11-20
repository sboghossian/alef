// Wire types for the "term" feature: a real terminal onto a tmux-bound agent.
//
//   WS /ws/term/:agentId   (loopback Host/Origin guard, same as /ws)
//     The server attaches a PTY to the agent's world tmux session (`tmux attach -t aw-…`).
//     Closing the socket kills only the attach client, never the tmux session.
//   Query: ?cols=&rows= (optional initial size, clamped 10..500 x 5..200).
//
// Only agents started or reactivated through the world (talk bindings) have a session.
// Refusals arrive as one TermServerMessage { type: "error" } followed by a close.

export const TERM_MAX_INPUT_CHARS = 64 * 1024;

/** Browser → server (JSON text frames). */
export type TermClientMessage =
  | { type: "input"; data: string } // raw keystrokes, ≤ TERM_MAX_INPUT_CHARS
  | { type: "resize"; cols: number; rows: number };

/** Server → browser (JSON text frames). */
export type TermServerMessage =
  | { type: "ready"; mode: "pty" | "mirror"; tmuxName: string; cols: number; rows: number }
  | { type: "output"; data: string } // pty mode: raw terminal bytes (utf8), write straight to xterm
  | { type: "screen"; data: string } // mirror mode: full visible pane with escapes; clear + redraw
  | { type: "exit"; code: number | null }
  | { type: "error"; error: string };
