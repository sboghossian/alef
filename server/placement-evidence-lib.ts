// Where a home-run session's work SHIPPED, read from its transcript and its subagents'. Pure: no
// I/O. Transcript text is untrusted data; it is only matched against fixed patterns here, never
// executed, followed or logged.
//
//   pr          a `pr-link` record, or a PR URL printed by `gh pr create` / `gh pr merge`
//               (key "owner/repo#12", so the two sources of one PR count once)
//   push        a `To https://github.com/owner/repo` line printed by `git push`
//               (key "<tool_use id> owner/repo": one per push command)
//   agent-edit  a file a subagent edited (Edit / Write / MultiEdit / NotebookEdit), attributed to
//               the parent session (key = the absolute path)
//
// A command's output lands on a later line than the command, possibly in a later indexer pass,
// so a ship command stays "pending" (by tool_use id) until its tool_result is read.

import { isAbsolute, resolve, sep } from "node:path";
import { filePathFromToolUse, toolCategory, type ParsedLine } from "./jsonl-events.js";

export type EvidenceKind = "pr" | "push" | "agent-edit";

export interface EvidenceRow {
  kind: EvidenceKind;
  /** Dedupe key: re-reading the same bytes adds nothing (see the header). */
  key: string;
  /** What the row votes for: "owner/repo" (pr, push) or an absolute file path (agent-edit). */
  subject: string;
  at: string;
}

/** `git push` (also `git -C dir push`) or `gh pr create` / `gh pr merge`, anywhere in a command. */
const SHIP_COMMAND = /\bgit\b[^\n;&|]*?\bpush\b|\bgh\s+pr\s+(?:create|merge)\b/;

export function isShipCommand(command: string): boolean {
  return SHIP_COMMAND.test(command);
}

const NAME = "[A-Za-z0-9_.-]+";
const WHOLE_NAME = new RegExp(`^${NAME}$`);

/** "owner/repo", lowercased (GitHub names are case-insensitive), without a trailing ".git".
 *  Null for anything that isn't a plain GitHub name (transcript text is untrusted). */
export function normalizeRepo(owner: string, repo: string): string | null {
  const r = repo.replace(/\.git$/i, "");
  if (!WHOLE_NAME.test(owner) || !WHOLE_NAME.test(r) || /^\.+$/.test(owner) || /^\.+$/.test(r)) return null;
  return `${owner}/${r}`.toLowerCase();
}

const REMOTE_URL = new RegExp(`^(?:https?://(?:[^@/\\s]+@)?github\\.com/|ssh://git@github\\.com/|git@github\\.com:|git://github\\.com/)(${NAME})/(${NAME})/?$`, "i");

/** The GitHub "owner/repo" a remote URL points at, or null for any other host. Credentials in
 *  the URL are dropped, never returned. */
export function githubRepoOfRemoteUrl(url: string): string | null {
  const m = REMOTE_URL.exec(url.trim());
  return m?.[1] && m[2] ? normalizeRepo(m[1], m[2]) : null;
}

const TO_LINE = new RegExp(`^\\s*To\\s+(?:https?://(?:[^@/\\s]+@)?github\\.com/|ssh://git@github\\.com/|git@github\\.com:)(${NAME})/(${NAME})/?\\s*$`, "gim");
const PULL_URL = new RegExp(`https://github\\.com/(${NAME})/(${NAME})/pull/(\\d+)\\b`, "g");
const MERGED = new RegExp(`Merged pull request (${NAME})/(${NAME})#(\\d+)`, "g");

export interface ShipOutput {
  prs: Array<{ repo: string; number: number }>;
  pushes: string[];
}

/** The repos a ship command's output names: PRs by URL or "Merged pull request o/r#n", pushes by
 *  git's "To <remote>" line. The "pull/new/<branch>" hint git push prints is not a PR. */
export function shipOutputRepos(text: string): ShipOutput {
  const prs: ShipOutput["prs"] = [];
  const pushes = new Set<string>();
  for (const re of [PULL_URL, MERGED]) {
    for (const m of text.matchAll(re)) {
      const repo = normalizeRepo(m[1] ?? "", m[2] ?? "");
      if (repo) prs.push({ repo, number: Number(m[3]) });
    }
  }
  for (const m of text.matchAll(TO_LINE)) {
    const repo = normalizeRepo(m[1] ?? "", m[2] ?? "");
    if (repo) pushes.add(repo);
  }
  return { prs, pushes: [...pushes] };
}

/** A tool_result's text: the string itself, or its text blocks joined. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

export interface EvidenceFold {
  rows: EvidenceRow[];
  /** Ship commands (tool_use ids) whose output has not been read yet. */
  pending: Set<string>;
  /** Ship commands whose output was read by this fold. */
  resolved: Set<string>;
}

export function newEvidenceFold(seedPending: Iterable<string> = []): EvidenceFold {
  return { rows: [], pending: new Set(seedPending), resolved: new Set() };
}

export interface FoldOpts {
  /** Record edited files as agent-edit rows (subagent transcripts only: a parent's own touches
   *  are already file edges). */
  agentEdits: boolean;
  /** Resolves a relative edited path when the line carries no cwd of its own. */
  cwd: string | null;
}

/** Folds one parsed line into `acc`. `at` is the line's timestamp (or its file's mtime). */
export function foldEvidence(acc: EvidenceFold, line: ParsedLine, at: string, opts: FoldOpts): void {
  if (line.prLink) {
    const parts = line.prLink.repo.split("/");
    const r = parts.length === 2 ? normalizeRepo(parts[0] ?? "", parts[1] ?? "") : null;
    if (r) acc.rows.push({ kind: "pr", key: `${r}#${line.prLink.number ?? "?"}`, subject: r, at });
    return;
  }
  for (const use of line.toolUses) {
    if (use.name === "Bash" && use.id && typeof use.input.command === "string" && isShipCommand(use.input.command)) {
      acc.pending.add(use.id);
    } else if (opts.agentEdits && toolCategory(use.name) === "edit") {
      const raw = filePathFromToolUse(use) ?? (typeof use.input.notebook_path === "string" ? use.input.notebook_path : null);
      const base = line.cwd ?? opts.cwd;
      const abs = raw && (isAbsolute(raw) ? resolve(raw) : base ? resolve(base, raw) : null);
      if (abs) acc.rows.push({ kind: "agent-edit", key: abs, subject: abs, at });
    }
  }
  for (const r of line.toolResults) {
    if (!acc.pending.has(r.toolUseId)) continue;
    acc.pending.delete(r.toolUseId);
    acc.resolved.add(r.toolUseId);
    const out = shipOutputRepos(toolResultText(r.content));
    for (const pr of out.prs) acc.rows.push({ kind: "pr", key: `${pr.repo}#${pr.number}`, subject: pr.repo, at });
    for (const repo of out.pushes) acc.rows.push({ kind: "push", key: `${r.toolUseId} ${repo}`, subject: repo, at });
  }
}

const EDIT_OR_BASH_USE = /"name"\s*:\s*"(?:Edit|Write|MultiEdit|NotebookEdit|Bash)"/;

/** Cheap byte-level prefilter for scans that only want evidence: false means foldEvidence would
 *  get nothing from this raw line, so it needn't be JSON-parsed. */
export function mayCarryEvidence(raw: string, havePending: boolean): boolean {
  if (raw.includes('"pr-link"')) return true;
  if (havePending && raw.includes('"tool_result"')) return true;
  return raw.includes('"tool_use"') && EDIT_OR_BASH_USE.test(raw);
}

/** Ship score per "owner/repo": one per PR, one per push command. */
export function shipScores(rows: Iterable<Pick<EvidenceRow, "kind" | "subject">>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const r of rows) if (r.kind === "pr" || r.kind === "push") scores.set(r.subject, (scores.get(r.subject) ?? 0) + 1);
  return scores;
}

/** The repo a session shipped to: strictly ahead of every other repo and at least half of all
 *  its ship evidence. One PR is enough on its own. Null when there is no such repo. */
export function pickShipRepo(scores: ReadonlyMap<string, number>): string | null {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [top, runnerUp] = ranked;
  if (!top || (runnerUp && runnerUp[1] === top[1])) return null;
  const total = ranked.reduce((sum, [, n]) => sum + n, 0);
  return top[1] * 2 >= total ? top[0] : null;
}

/** When several local clones share one GitHub remote: the one not under a hidden folder
 *  (~/.cache/…), then the shortest path, then the first alphabetically. */
export function pickCloneRoot(roots: readonly string[], homeDir: string): string | null {
  const hidden = (p: string): boolean => {
    const rel = p.startsWith(homeDir + sep) ? p.slice(homeDir.length + 1) : p;
    return rel.split(sep).some((seg) => seg.startsWith("."));
  };
  const sorted = [...roots].sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.length - b.length || a.localeCompare(b));
  return sorted[0] ?? null;
}
