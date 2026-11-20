// Wire types for the "approvals" feature (A2): Claude Code PermissionRequest hooks
// queue here; the world answers allow / deny / passthrough (= fall back to the
// terminal prompt).
//
// HTTP (loopback only, JSON-only writes — see server/guard.ts):
//   POST /api/approvals                 hook stdin JSON → 201 { id } | 204 (world toggle OFF)
//   GET  /api/approvals/:id             long-poll ≤25s → ApprovalPollResult
//   POST /api/approvals/:id/decision    ApprovalDecisionRequest → { ok, error? }
//   GET  /api/approvals/settings        → ApprovalSettings
//   POST /api/approvals/settings        ApprovalSettings → ApprovalSettings

export type ApprovalBehavior = "allow" | "deny" | "passthrough";

export interface ApprovalPreview {
  kind: "command" | "diff" | "file" | "generic";
  /** One line: the command's description, the file path, the URL… sanitized. */
  title: string;
  /** Multi-line body (command / diff / content head), sanitized and truncated. Render as text, never HTML. */
  body: string;
}

export interface ApprovalView {
  id: string;
  agentId: string; // = the hook's session_id
  cwd: string;
  toolName: string;
  preview: ApprovalPreview;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

export type ApprovalOutcome = ApprovalBehavior | "expired";

export type ApprovalPollResult =
  | { status: "pending" }
  | { status: "decided"; behavior: ApprovalBehavior; message?: string }
  | { status: "expired" };

export interface ApprovalDecisionRequest {
  behavior: ApprovalBehavior;
  message?: string; // deny reason shown to Claude, ≤500 chars
}

export interface ApprovalSettings {
  enabled: boolean;
  /** ON: every request is allowed at once, except the hard stops in AUTO_HOLD_BASH (server). */
  autoApprove: boolean;
}

/** snapshot extras: "approvals.pending" → ApprovalView[], "approvals.enabled" → boolean. */
export type ApprovalsMessage =
  | { kind: "added"; approval: ApprovalView }
  | { kind: "resolved"; id: string; agentId: string; outcome: ApprovalOutcome }
  | { kind: "settings"; enabled: boolean; autoApprove: boolean };
