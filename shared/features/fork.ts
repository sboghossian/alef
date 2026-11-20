// Wire types for the "fork" feature (H4): read-only git + PR status of an agent's repo, and
// "fork into worktree" (a new branch in ~/.alef-worktrees, optionally with a plan-mode claude).

export type ChecksRollup = "success" | "failure" | "pending" | "none";

export interface ForkPr {
  number: number;
  state: string; // OPEN | CLOSED | MERGED
  title: string; // sanitized, ≤200 chars
  url: string; // https only
  checks: ChecksRollup;
  passed: number;
  failed: number;
  pending: number;
}

/** A worktree Alef created (persisted in data/fork-worktrees.json). */
export interface ForkRecord {
  id: string; // 12 hex chars
  agentId: string;
  repoRoot: string; // the main repo (git common dir's parent)
  path: string; // under ~/.alef-worktrees
  branch: string; // fork/<slug>-<short>
  base: string; // commit sha the branch started at
  createdAt: string;
  tmuxName: string | null;
}

export interface ForkRepoStatus {
  root: string;
  branch: string | null; // null = detached HEAD
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number; // changed + untracked entries
  /** null: no PR for this branch (or none could be looked up; see prNote). */
  pr: ForkPr | null;
  /** Why the PR is unknown: "gh not installed", "no remote", "gh failed: …". null when looked up fine. */
  prNote: string | null;
  /** Whether "Fork into worktree" is allowed right now, and why not. */
  forkable: { ok: true } | { ok: false; reason: string };
  forks: ForkRecord[];
  checkedAt: string;
}

/** GET /api/fork/:agentId[?repo=] */
export type ForkStatusResponse =
  | { ok: true; repos: { root: string; label: string }[]; root: string; status: ForkRepoStatus | null; pending: boolean }
  | { ok: false; error: string };

/** POST /api/fork/:agentId/fork */
export interface ForkRequest {
  repo?: string;
  base?: string;
  launch?: boolean;
}

export type ForkResult =
  | { ok: true; fork: ForkRecord; launched: boolean; launchError: string | null }
  | { ok: false; error: string };

/** POST /api/fork/remove */
export interface ForkRemoveRequest {
  id: string;
}

export type ForkRemoveResult = { ok: true; id: string } | { ok: false; error: string };

/** WS payload: one repo's status was refreshed (the panel re-renders when it shows that root). */
export interface ForkMessage {
  kind: "status";
  root: string;
  status: ForkRepoStatus;
}
