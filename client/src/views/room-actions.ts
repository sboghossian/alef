// The Room dock's actions (views/room.ts): Open in VS Code, Activate / Resume here, Stop and Ctrl-C.
// Each goes through runAction, so the clicked button is busy while the request runs and every
// outcome is a toast (with the reason translated), not only a line of small sidebar text. Open in
// VS Code and the no-tmux Activate share ui/agent-open.ts with the palette and the details panel.
// Activate asks the resume guard (features/resume-guard.ts) at click time: an agent live in another
// terminal is never resumed (that starts a second copy), and a resume's success says how to answer
// Claude's folder-trust question.

import type { ControlResult } from "../../../shared/features/control";
import type { TalkActionResult } from "../../../shared/features/talk";
import type { ReactivateResult } from "../../../shared/types";
import { RUNNING_ELSEWHERE_TEXT, TRUST_HINT, type ResumeOffer } from "../features/resume-guard";
import { describeError, runAction, type ElementRef } from "../ui/action";
import { openAgentIn, type OpenDeps } from "../ui/agent-open";
import { launchNeedsYou, launchSuccessText } from "../ui/launch-result";

export interface RoomActionDeps extends OpenDeps {
  /** POST /api/talk/reactivate: claude --resume inside a world tmux session. */
  resume(id: string): Promise<TalkActionResult>;
  /** POST /api/agents/:id/interrupt[?hard=1]: Esc, or Ctrl-C, into its world tmux session. */
  interrupt(id: string, hard: boolean): Promise<ControlResult>;
  /** The resume guard as the world knows it now (features/talk.ts resumeOfferFor). */
  resumeOffer(id: string): ResumeOffer;
}

export interface RoomActionUi {
  status?: ElementRef<HTMLElement>;
  button?: ElementRef<HTMLButtonElement>;
}

export function roomOpenEditor(deps: RoomActionDeps, id: string, ui: RoomActionUi): Promise<ReactivateResult | null> {
  return openAgentIn(deps, "editor", id, ui);
}

/** Resume in a world tmux session (its screen becomes a live terminal). Without tmux, falls back to
 *  a Terminal window, like the panel's Reactivate. Null when nothing was sent: the agent is running
 *  in another terminal (checked here, at click time, for a dock drawn before it went live). */
export function roomActivate(
  deps: RoomActionDeps,
  id: string,
  tmux: boolean,
  ui: RoomActionUi,
  success: (r: TalkActionResult) => string = (r) => `${launchSuccessText(r, "Resumed", false)} Click the screen for its live terminal.`,
): Promise<TalkActionResult | ReactivateResult | null> {
  if (deps.resumeOffer(id) === "running-elsewhere") {
    // An error toast, so it stays up 10 s or more: the fix is in the other terminal.
    deps.toast(RUNNING_ELSEWHERE_TEXT, "error");
    const status = typeof ui.status === "function" ? ui.status() : ui.status;
    if (status) status.textContent = RUNNING_ELSEWHERE_TEXT;
    return Promise.resolve(null);
  }
  if (!tmux) return openAgentIn(deps, "reactivate", id, ui, TRUST_HINT);
  return runAction({
    label: "Activate",
    pending: "Resuming in a world tmux session…",
    run: () => deps.resume(id),
    success,
    successKind: (r) => (launchNeedsYou(r) ? "error" : "info"),
    toast: deps.toast,
    status: ui.status,
    button: ui.button,
  });
}

export function roomInterrupt(deps: RoomActionDeps, id: string, hard: boolean, ui: RoomActionUi): Promise<ControlResult> {
  return runAction({
    label: hard ? "Ctrl-C" : "Stop",
    pending: hard ? "Sending Ctrl-C…" : "Sending Esc…",
    run: () => deps.interrupt(id, hard),
    success: (r) => `Sent ${r.sent ?? (hard ? "Ctrl-C" : "Esc")} to ${r.tmuxName ?? "its tmux session"}.`,
    failure: (r) => `Not stopped: ${describeError(r.error)}`,
    toast: deps.toast,
    status: ui.status,
    button: ui.button,
  });
}
