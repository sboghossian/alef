// Wire types for the "control" feature: stop (interrupt) or nudge a running agent.
// Never kills a process: interrupt = keystrokes into the agent's world tmux session.
//
//   POST /api/agents/:agentId/interrupt[?hard=1]   {} → ControlResult
//        soft: Escape (Claude's interrupt) · hard: C-c
//        409 { ok:false, error:"open its Terminal to stop it" } when the agent is not tmux-bound
//   POST /api/agents/:agentId/note   ControlNoteRequest → ControlResult
//        same path + prompt-safety as POST /api/talk/:agentId (409 while a prompt is showing)

export const CONTROL_NOT_TMUX_ERROR = "open its Terminal to stop it";

export interface ControlNoteRequest {
  text: string; // 1..2000 (TALK_MAX_CHARS)
}

export interface ControlResult {
  ok: boolean;
  tmuxName?: string;
  sent?: "Escape" | "C-c" | "note";
  error?: string;
}
