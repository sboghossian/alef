// Wire types for the "talk" feature (A1): sessions started inside a server-owned
// tmux session ("aw-<shortid>") can be typed into from the world.
//
//   GET  /api/talk/status                          → TalkStatus
//   POST /api/talk/reactivate/:agentId             → TalkActionResult (tmux + Terminal attached)
//   POST /api/talk/dispatch                        TalkDispatchRequest → TalkActionResult
//   POST /api/talk/:agentId                        TalkSendRequest → TalkActionResult
//   POST /api/talk/stranded/:tmuxName/attach       → TalkActionResult (Terminal attached, no send-keys)
//   POST /api/talk/stranded/:tmuxName/close        → TalkActionResult (tmux kill-session, binding dropped; STRANDED_CLOSABLE rows in a one-window, one-pane session only)
//   POST /api/talk/stranded/:tmuxName/trust-relaunch → TalkActionResult (a "trust" row: grant folder trust, Close it under
//                                                    the same invariant, then relaunch its prompt in a new world tmux session)
//   POST /api/dispatch, POST /api/reactivate/:agentId → DispatchResult / ReactivateResult (shared/types.ts): the same
//                                                    launcher, with a plain-Terminal fallback when tmux is missing

import type { LaunchDetails } from "../types.js";

export const TALK_MAX_CHARS = 2000;
/** A launch watches its new pane this long for claude's trust/Chrome startup dialog, so the launch
 *  answer itself can say it is waiting (the Inbox's stranded list takes STRANDED_AFTER_MS). */
export const LAUNCH_DIALOG_WATCH_MS = 10_000;
/** The same launch (same proposal/item, same dispatch prompt and city, same resumed agent) asked again
 *  within this long gets the first one's session back instead of a second session. */
export const LAUNCH_REPEAT_WINDOW_MS = 10_000;
/** Said whenever a launch had to fall back to a plain Terminal window. */
export const PLAIN_TERMINAL_NOTE = "tmux isn't installed, so it opened in a plain Terminal window: Stop, Talk, Note and the Screen can't reach it.";
export const TALK_INSTALL_HINT = "Talk needs tmux — run: sudo xcodebuild -license accept && brew install tmux";

export interface TalkBinding {
  agentId: string | null; // null until a dispatched session's jsonl shows up
  tmuxName: string; // "aw-<shortid>"
  cwd: string;
  startedAt: string; // ISO
  /** claude was started with `--permission-mode plan` (▶ Launch, Jev proposes, fork), recorded at
   *  launch. Absent on bindings saved before 2026-09-28's fix: trust-relaunch then can't rule plan
   *  mode out and relaunches in plan mode. Never read back from tmux's #{pane_start_command}. */
  plan?: boolean;
}

export interface TalkStatus {
  available: boolean;
  hint: string | null; // TALK_INSTALL_HINT when tmux is missing
  bindings: TalkBinding[];
}

export interface TalkDispatchRequest {
  islandId: string;
  prompt: string; // 1..4000
}

export interface TalkSendRequest {
  text: string; // 1..TALK_MAX_CHARS
}

export interface TalkActionResult extends LaunchDetails {
  ok: boolean;
  tmuxName?: string;
  error?: string;
  /** trust-relaunch: folder trust was granted (true even when the Close or the relaunch then failed). */
  trusted?: boolean;
  /** trust-relaunch: the stuck session this relaunch replaced. */
  relaunchedFrom?: string;
  /** Launches/trust-relaunch: the folder claude runs in. */
  cwd?: string;
}

/** Why a dispatched/launched session never became an agent: its tmux pane is alive, its binding's
 *  agentId is still null after STRANDED_AFTER_MS, and its pane shows one of these. */
export type StrandedBlockedOn = "trust" | "chrome" | "menu" | "empty-prompt" | "exited" | "unknown";

/** The only screens Close acts on: claude's startup folder-trust or Chrome dialog, or a shell
 *  after claude exited. A working agent also shows an empty prompt, a menu or an unrecognized
 *  screen, so those rows are never closable (PR #29 review). */
export const STRANDED_CLOSABLE: readonly StrandedBlockedOn[] = ["trust", "chrome", "exited"];

/** A dispatch/launch (▶ Launch, /api/talk/dispatch) whose tmux session is alive but never
 *  produced a transcript, so it was never adopted into a WorldAgent — and never counted as
 *  waiting, since it isn't one. Computed every tick from `talk.bindings`; not persisted itself. */
export interface StrandedDispatch {
  tmuxName: string;
  cwd: string;
  startedAt: string; // ISO — of the binding, i.e. when it was dispatched
  blockedOn: StrandedBlockedOn;
  /** Close is offered: blockedOn is in STRANDED_CLOSABLE and the tmux session is exactly one window
   *  with one pane (kill-session ends every pane, the screen was read from the active one only). */
  closable: boolean;
  /** First line of the prompt file, read back off disk. Null when the file is gone/unreadable
   *  or the pane's start command isn't a recognizable dispatch shape. */
  promptHead: string | null;
  /** Last non-blank line of the captured pane, for a human glance. Null for a blank pane. */
  lastLine: string | null;
}

/** WS payload: bindings changed, or the stranded list changed. */
export type TalkMessage = { kind: "bindings"; bindings: TalkBinding[] } | { kind: "stranded"; stranded: StrandedDispatch[] };
