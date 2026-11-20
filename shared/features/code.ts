// Wire types for the "code" feature: a read-only view of an agent's repository.
// Repos a session can browse (`repos`): the git root of its cwd (or the cwd itself when that is
// a non-git project folder), plus the git root of every file the session touched through a tool
// call, grouped. So an agent whose cwd is $HOME still gets the repos it actually worked in.
// $HOME, "/" and secret dirs are never roots. Every endpoint takes an optional `repo=<abs root>`;
// it must be one of that session's `repos` (else 403 "repo-not-allowed"). Without it the server
// picks the default: the cwd's repo, else the touched repo with the most files, else 409.
// Every path param is relative to the chosen root and must stay inside it, including after
// symlink resolution. Secret files (.env*, *.pem, id_*, *.key, …) are refused (403).
//
//   GET /api/code/:agentId/tree?path=&repo=     → CodeTreeResponse  (recursive, ≤2000 entries)
//   GET /api/code/:agentId/file?path=&repo=     → CodeFileResponse  (text only, ≤512KB, secrets redacted)
//   GET /api/code/:agentId/touched?repo=        → CodeTouchedResponse
//   GET /api/code/:agentId/diff?path=&repo=     → CodeDiffResponse  (git diff HEAD -- path, ≤200KB)
//   GET /api/code/:agentId/status?repo=         → CodeStatusResponse
// Errors: { ok: false, error } with 400 (bad path) / 403 (outside root, secret, repo not allowed) / 404 / 409 / 413 / 415.

export const CODE_TREE_CAP = 2000;
export const CODE_FILE_MAX_BYTES = 512 * 1024;
export const CODE_DIFF_MAX_BYTES = 200 * 1024;

export interface CodeError {
  ok: false;
  error: string;
}

export interface CodeTreeEntry {
  path: string; // relative to the repo root, "/"-separated
  type: "dir" | "file" | "symlink";
  size?: number; // files only
  /** True for secret-looking files: listed, but /file refuses them. */
  blocked?: boolean;
}

/** One repo a session can browse. */
export interface CodeRepo {
  root: string; // absolute; pass back as `repo=`
  label: string; // basename, or "parent/name" when two roots share one
  files: number; // distinct files this session touched inside it (0 = only its cwd)
  git: boolean; // false only for a non-git cwd folder
}

export interface CodeTreeResponse {
  ok: true;
  root: string; // absolute repo root (the chosen repo)
  repos: CodeRepo[]; // every repo this session can browse, most touched files first
  path: string; // listed subdirectory ("" = root)
  entries: CodeTreeEntry[];
  truncated: boolean;
}

export interface CodeFileResponse {
  ok: true;
  path: string;
  size: number;
  language: string; // from the extension, e.g. "ts", "md", "" when unknown
  content: string; // redactSecrets applied
}

export interface CodeTouchedFile {
  path: string; // relative when inside the repo, else absolute
  insideRepo: boolean;
  count: number; // tool calls that referenced it
  edits: number; // Edit/Write/MultiEdit/NotebookEdit calls
  lastTool: string;
  lastAt: string | null;
}

export interface CodeTouchedResponse {
  ok: true;
  root: string;
  repos: CodeRepo[];
  files: CodeTouchedFile[]; // most recent first
}

export interface CodeDiffResponse {
  ok: true;
  path: string;
  diff: string; // unified diff vs HEAD ("" = unchanged / untracked), secrets redacted
  truncated: boolean;
  git: boolean; // false when the root is not a git repo
}

export interface CodeStatusFile {
  path: string;
  status: string; // porcelain XY, e.g. " M", "??", "A "
}

export interface CodeStatusResponse {
  ok: true;
  root: string;
  git: boolean;
  branch: string | null;
  dirty: CodeStatusFile[]; // ≤500
  truncated: boolean;
}
