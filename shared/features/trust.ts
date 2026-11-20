// Folder trust (launch honesty): whether Claude Code has already accepted its "Quick safety
// check… Yes, I trust this folder / No, exit" dialog for a launch's working directory. A new
// session in an untrusted folder sits on that dialog, with "No, exit" preselected, and does
// nothing until someone answers it in Terminal. Computed by server/trust.ts from ~/.claude.json.
//
//   "trusted"   hasTrustDialogAccepted === true on the cwd or an ancestor, walking up no further
//               than the git root (the nearest ancestor with a .git), as Claude Code does; outside
//               a git repo any ancestor counts; a linked worktree also takes its main checkout's
//   "untrusted" ~/.claude.json parsed and nothing in that walk has it accepted (a trusted folder
//               above the git root does not count)
//   "unknown"   ~/.claude.json is missing or unreadable

export type FolderTrust = "trusted" | "untrusted" | "unknown";

export function isFolderTrust(v: unknown): v is FolderTrust {
  return v === "trusted" || v === "untrusted" || v === "unknown";
}

// Granting trust (feature "trust", server/features/trust.ts). Only ever from an explicit click:
//
//   POST /api/trust            body TrustGrantRequest → TrustGrantResult
//        Sets projects[<realpath cwd>].hasTrustDialogAccepted = true in ~/.claude.json and nothing
//        else. cwd must be an existing directory strictly under $HOME (after realpath).
//   GET  /api/trust/targets    → TrustTargetsResponse (district folders a launch can target that
//        Claude Code hasn't trusted yet)

export interface TrustGrantRequest {
  cwd: string;
}

export interface TrustGrantResult {
  ok: boolean;
  /** The realpath'd folder the entry was written for (or already had). */
  path?: string;
  /** Nothing was written: Claude Code already trusted it. */
  alreadyTrusted?: boolean;
  /** Where today's first safety copy of ~/.claude.json went (null when today's already existed). */
  backup?: string | null;
  error?: string;
}

export interface TrustTarget {
  islandId: string;
  /** The district's folder, as a launch would use it. */
  cwd: string;
  trust: FolderTrust;
}

//   POST /api/trust/bulk       body TrustBulkRequest → TrustBulkResult
//        Health's "Trust these N folders": each path must be in the CURRENT untrusted-targets list
//        (no arbitrary paths), confirm must be true, and each one goes through the same grant as
//        POST /api/trust, one after another. Every path gets its own outcome.

export interface TrustBulkRequest {
  paths: string[];
  /** Must be true: the click that lists every folder is the consent. */
  confirm: true;
}

/** trusted: the key was written · already: Claude trusted it by the time Alef got there (nothing
 *  written) · refused: nothing written for this path, `error` says why. */
export type TrustBulkOutcome = "trusted" | "already" | "refused";

export interface TrustBulkItem {
  path: string;
  outcome: TrustBulkOutcome;
  error?: string;
  /** Where today's first safety copy of ~/.claude.json went, on the write that made it. */
  backup?: string | null;
}

export interface TrustBulkResult {
  /** true only when no path was refused. The per-path results are there either way. */
  ok: boolean;
  results: TrustBulkItem[];
  trusted: number;
  already: number;
  refused: number;
  error?: string;
}

export interface TrustTargetsResponse {
  ok: boolean;
  /** Launch targets (district folders under $HOME that exist) Claude hasn't trusted. */
  untrusted: TrustTarget[];
  /** How many launch targets were checked. */
  checked: number;
  error?: string;
}
