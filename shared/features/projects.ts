// Wire types for the "projects" feature (📁 Projects view): every project we have worked on, as
// the union of Alef's districts (repos with sessions) and every top-level folder of
// ~/Documents/Code, one entry per real folder.
//
//   GET /api/projects              → ProjectsResponse (stale-while-revalidate, 5 min, single-flight)
//   GET /api/projects/:id/preview  → the project's screenshot (image/webp|png|jpeg), looked up by the
//                                    server from its own list; read-only from the roadmap previews folder
//   GET /api/projects/:id/tree?path=<relative subfolder>
//                                  → ProjectTreeResponse: ONE level of that folder (depth 1, capped,
//                                    secret-looking names left out, nothing outside the project root,
//                                    nothing inside a privacy-guarded folder). `id` is looked up in the
//                                    server's own list: a request never names an absolute path.

export const PROJECT_STAGES = ["idea", "building", "shipped", "dormant"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const PROJECT_CATEGORIES = ["acme", "legal", "infra", "side", "personal"] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

/** A folder over this many days without a commit or a session is dormant (unless it is live). */
export const DORMANT_DAYS = 60;
/** A commit or a session this recent makes the project "building". */
export const BUILDING_DAYS = 14;
export const TREE_MAX_ENTRIES = 200;
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

/** How a project found its vault note (server/features/project-match-lib.ts), strongest first. */
export type VaultMatchRule = "code_path" | "github" | "alias" | "name";

export interface ProjectGit {
  /** "owner/repo" when origin is a GitHub remote; null otherwise. */
  remote: string | null;
  branch: string | null;
  /** ISO of the newest commit; null when unreadable (timeout) or there is none. */
  lastCommit: string | null;
  /** Commits reachable from HEAD, capped at COMMIT_COUNT_CAP; null when unreadable. */
  commits: number | null;
}
export const COMMIT_COUNT_CAP = 10_000;

export interface ProjectArtifacts {
  count: number;
  /** Newest first, at most 12. */
  items: { id: string; title: string | null }[];
}

/** Sources of the Obsidian session notes (vault 10-Sessions/<source>/*.md), the way the old roadmap counted them. */
export const SESSION_SOURCES = ["claude-code", "claude-cowork", "claude-chat", "chatgpt"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];
export type VaultSessions = Partial<Record<SessionSource, number>>;

/** Hand-written notes about a project, from data/projects-notes.json (scripts/export-roadmap-notes.mjs). Untrusted text. */
export interface ProjectNotes {
  desc: string | null;
  longDesc: string | null;
  milestones: string[];
  nextSteps: string[];
  /** "YYYY-MM-DD" or "YYYY-MM". */
  started: string | null;
  /** http(s) only. */
  liveUrl: string | null;
  /** "YYYY-MM-DD" the note was regenerated from evidence; null for the old hand-exported notes. */
  asOf: string | null;
  /** Short labels of the evidence behind it ("README", "git log", "vault 20-Projects/x"). */
  sources: string[];
  /** True when a refresh found no new evidence for this project and kept the old text. */
  stale: boolean;
}

/** What differed between two scans of one project (deltas for counts, from/to for words). */
export interface ProjectChange {
  /** ISO of the scan that saw it. */
  at: string;
  commits?: number;
  sessions?: number;
  stage?: { from: ProjectStage; to: ProjectStage };
  branch?: { from: string | null; to: string | null };
}
/** Scans' diffs kept per project (newest first). */
export const CHANGES_KEPT = 12;
/** Scans kept in the aggregate refresh history. */
export const REFRESHES_KEPT = 30;

export interface RefreshEntry {
  at: string;
  total: number;
  stageCounts: Record<ProjectStage, number>;
  /** Projects with a commit in the last 7 days. */
  activeThisWeek: number;
}

export interface ProjectItem {
  id: string;
  name: string;
  /** Absolute path ("" never: every project has a folder). Hidden client-side under ?redact=1. */
  path: string;
  kind: "repo" | "folder";
  /** Alef district (island) id when the folder has sessions; the sessions themselves are
   *  in the world snapshot (islandId). */
  islandId: string | null;
  sessions: number;
  lastActive: string | null;
  git: ProjectGit | null;
  /** First heading or first prose line of README.md; null when none. */
  readme: string | null;
  stack: string[];
  category: ProjectCategory;
  categoryReason: string;
  /** Vault 20-Projects/<slug>/ folder name when one matches this project. */
  vaultNote: string | null;
  /** Which rule matched it (server/features/project-match-lib.ts): the note's code_path, its
   *  github, a brain_taxonomy alias, or the folder name. Null when no note matches. */
  vaultMatch?: VaultMatchRule | null;
  stage: ProjectStage;
  stageReason: string;
  /** What made it "shipped": "vercel.json", "wrangler.toml", "package.json homepage"… */
  deploy: string | null;
  /** Newest of lastCommit and lastActive (ISO), for sorting. */
  activityAt: string | null;
  /** Null until the artifacts feature has read its store. */
  artifacts: ProjectArtifacts | null;
  /** True when the folder was left unread (macOS privacy-guarded, or a refused root). */
  unread: boolean;
  /** Preview screenshot present for this project (served by GET /api/projects/:id/preview). */
  hasPreview: boolean;
  /** Notes file entry, when one matches. */
  notes: ProjectNotes | null;
  /** Obsidian session notes labelled with this project, per source; null when the vault has none. */
  vaultSessions: VaultSessions | null;
  /** Newest first; empty until a later scan sees a difference. */
  changes: ProjectChange[];
  /** Est. API-equivalent cost of this project's sessions over 30 days; null when unknown. Joined per request. */
  costUsd30d: number | null;
  /** Folders folded into this card: its linked git worktrees, and clones/backups with the same
   *  GitHub remote. Their sessions count in `sessions`, their dates in `activityAt`. */
  folded: FoldedFolder[];
}

export interface FoldedFolder {
  id: string;
  name: string;
  /** Absolute path; hidden client-side under ?redact=1. */
  path: string;
  kind: "worktree" | "clone";
  /** Why it folded here, e.g. "a git worktree of acme-ai-org". */
  reason: string;
  islandId: string | null;
  sessions: number;
  branch: string | null;
  activityAt: string | null;
}

export interface ProjectsResponse {
  ok: true;
  items: ProjectItem[];
  /** ISO of the scan these items come from. */
  scannedAt: string;
  /** Folders/districts not listed: $HOME itself, the harness, other non-project islands. */
  skipped: number;
  /** Folders folded into another card (worktrees, clones): not counted in items. */
  folded: number;
  /** Scan history (when facts last changed is per project, in `changes`). */
  history: { since: string; refreshes: RefreshEntry[] };
  /** Folders whose git facts could not be read (a timeout, or a broken repo such as a stale worktree): shown without them. */
  timedOut: number;
}

export interface ProjectTreeEntry {
  name: string;
  dir: boolean;
  /** Bytes for a file; null for a directory. */
  size: number | null;
}

export interface ProjectTreeResponse {
  ok: true;
  /** Path relative to the project root ("" = the root). */
  path: string;
  entries: ProjectTreeEntry[];
  truncated: boolean;
}

export interface ProjectsError {
  ok: false;
  error: string;
}
