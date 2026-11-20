// "Resume here, to chat" guard. Resuming runs `claude --resume <id>` in a new world tmux session.
// For an agent that is LIVE in a plain terminal (VS Code or Terminal) that is a SECOND copy of a
// running session (probe 2026-09-28: POST /api/talk/reactivate/<live id> answered 200 and started
// one). So every surface that offers Resume asks this first: the agent panel's talk slot
// (features/talk.ts), the Room screen (views/room.ts), the focus card (ui/focus.ts) and the Code
// view's terminal (ui/terminal.ts). The server-side guard belongs in server/features/talk.ts.
// Pure, so it is unit-tested (resume-guard.test.ts).

import { launchSuccessText, type LaunchResultLike } from "../ui/launch-result";

export type ResumeOffer =
  /** Already in a world tmux session: Talk can type into it, nothing to resume. */
  | "bound"
  /** Dormant and tmux is installed: Resume is safe to offer. */
  | "resume"
  /** Live in another terminal: no Resume button, explain instead. */
  | "running-elsewhere"
  /** Dormant, but tmux is missing: Resume would only fail. */
  | "no-tmux";

export interface ResumeOfferInput {
  status: "live" | "dormant";
  /** Has a world tmux binding (talk.bindings). */
  bound: boolean;
  tmuxAvailable: boolean;
}

export function resumeOffer(i: ResumeOfferInput): ResumeOffer {
  if (i.bound) return "bound";
  if (i.status === "live") return "running-elsewhere";
  return i.tmuxAvailable ? "resume" : "no-tmux";
}

export const RUNNING_ELSEWHERE_TEXT =
  "Running in another terminal (VS Code or Terminal). Alef can't type into it. To chat from here, stop it there first; resuming now would start a second copy.";

/** A resumed or reactivated session in a folder Claude hasn't trusted yet waits on that dialog. */
export const TRUST_HINT = "If Claude asks whether you trust the folder, answer there.";

/** A successful "Resume here", from the server's answer: the tmux session running `claude --resume`
 *  (or the one it attached to), and whether claude is waiting on its trust dialog there. */
export function resumeStartedText(r: LaunchResultLike): string {
  return launchSuccessText(r, "Resumed (claude --resume)", false);
}
