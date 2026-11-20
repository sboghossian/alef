// Pure core of the "outcomes" feature (shared/features/outcomes.ts has the precedence): the fold
// that turns a session transcript's lines into outcome facts, the verdict, the PR-state cache
// policy, the Feed rule and the persisted store's validation. No I/O here.
//
// Transcript text is untrusted data. It is only matched against fixed shapes (parseLine, the
// placement-evidence fold, frame-link records), never executed, followed or logged.
//
// Facts, and where each comes from:
//   PRs        placement-evidence-lib's foldEvidence: `pr-link` records and the PR URLs printed by
//              `gh pr create` / `gh pr merge` (key "owner/repo#12", so both sightings count once).
//              Claude Code writes a pr-link when a command touches a PR, not only when it opens
//              one (✅ 2026-09-28: one follows `gh pr close` on another author's PR 1s later), so a
//              PR the session's own `gh pr close` closed (gh's "Closed pull request owner/repo#12"
//              line) is dropped unless its own `gh pr create` / `gh pr merge` output also named it
//   merges     a `gh pr merge <n>`, which in a non-TTY prints no URL and gets no pr-link (✅
//              2026-09-28: 6a10cdc0 merged acme-inc/acme-ai#460 that way and had no sighting of it).
//              Its repo is the call's own `--repo` / `-R` / PR URL, else the one GitHub repo of the
//              directory it ran in (the cwd moved by its `cd`s, tripwires-lib effectiveDir), which
//              outcomes.ts asks git for (placeMergesByDir). It is a PR of the session only when the
//              merge SUCCEEDED: gh's mergedAt falls inside the call (tool_use to tool_result), its
//              result isn't an error and shows no gh failure line (✅ real race: a9268b40's call 3s
//              after 2f4b251b's printed "GraphQL: Merge already in progress", and #501's mergedAt
//              lies inside both calls). `gh pr merge $n`, no number (the current branch), `--auto`
//              (merged later) or a `cd` that can't be followed names nothing.
//   pushes     foldEvidence: git's `To https://github.com/owner/repo` line after a `git push`,
//              kept only when a ref-update line follows it (a1b2c3d..e4f5a6b, a forced
//              "+ …...…", "* [new branch]"): git prints the To line for a rejected push too, and
//              a `--dry-run` push or a branch deletion lands nothing
//   artifacts  Claude Code's own `frame-link` record ({type, frameUrl, title, path, …}), written
//              when a session publishes a claude.ai artifact (✅ 2026-09-28: 25 of 25 transcripts
//              with an Artifact publish carry one; links merely quoted or listed never count)
//   toolCalls  every tool_use block; writes = Write / Edit / MultiEdit / NotebookEdit
//   learnings  paths those writes hit that pass shelf-lib's isLearningPath
//   todos      the latest TodoWrite list, or the TaskCreate / TaskUpdate list, whichever came last
// A command's output (a ship command's, a TaskCreate's) lands on a later line, maybe in a later
// read, so its tool_use id stays pending in the persisted fold until its tool_result is read.

import { isAbsolute, resolve } from "node:path";
import type { KnownOutcome, OutcomeEnding, OutcomePr, OutcomeRecord, OutcomeSummary, PrState, SessionOutcome } from "../../shared/features/outcomes.js";
import { isSessionOutcome } from "../../shared/features/outcomes.js";
import { isAwaitingInput, sanitizeTitle, type LastLineState } from "../heuristics.js";
import { parseLine } from "../jsonl-events.js";
import { foldEvidence, githubRepoOfRemoteUrl, mayCarryEvidence, newEvidenceFold, normalizeRepo, toolResultText, type EvidenceFold } from "../placement-evidence-lib.js";
import { artifactUrlsIn, isLearningPath } from "./shelf-lib.js";
import { effectiveDir, maskShell, MAX_MATCH_CHARS, stripHeredocs } from "./tripwires-lib.js";
import type { TailEnding } from "./subagents/endings.js";
import { endingOutcome, LIVE_WINDOW_MS, PROMPT_STALL_MS, STALL_MS, USER_INTERRUPT, type LineKind } from "./subagents/fold.js";

/** 3: the fold keeps merges by number (a version-2 store's sessions restart: its folds read past
 *  them; its MERGED / CLOSED PR states carry over, see parseStore).
 *  2: it tells a closed PR and a push that landed nothing apart. */
export const OUTCOMES_VERSION = 3;
/** A transcript is read once its session has been dormant this long (its verdict waits till then). */
export const SETTLE_MS = 10 * 60_000;
/** Dormant this long while waiting on the user = abandoned. */
export const ABANDON_MS = 24 * 3_600_000;
/** A graduation reaches the Feed only when its evidence is younger than this. */
export const GRADUATION_WINDOW_MS = 24 * 3_600_000;
/** An OPEN PR is asked about again after this; MERGED and CLOSED never are. */
export const OPEN_RECHECK_MS = 6 * 3_600_000;
/** A PR gh couldn't answer for is asked about again after this. */
export const UNKNOWN_RETRY_MS = 60 * 60_000;
const MAX_LIST = 50;
const MAX_TASKS = 500;
const MAX_PENDING = 200;
const MAX_PR_KEYS = 500;

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const TASK_CREATED = /^Task #([A-Za-z0-9_-]{1,32}) created successfully/;
const TASK_ID = /^[A-Za-z0-9_-]{1,32}$/;
const PR_KEY_NUMBER = /#(\d{1,9})$/;
const CLOSE_COMMAND = /\bgh\s+pr\s+close\b/;
/** gh's own line for a close (✅ 11 of 11 in real transcripts name owner/repo#n). */
const CLOSED_PR = /Closed pull request ([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})\b/g;
/** `--dry-run` / `-n` on the same `git … push` as isShipCommand reads (no `;`, `&`, `|` between). */
const DRY_RUN_PUSH = /\bgit\b[^\n;&|]*?\bpush\b[^\n;&|]*?\s(?:--dry-run|-n)(?=\s|$)/;
const TO_REMOTE = /^\s*To\s+(\S+)\s*$/;
/** One line of git push's per-ref report, " <flag> <summary> <from> -> <to> (<reason>)", whatever its flag. */
const REF_LINE = /^\s*(?:[+*!=-]\s+)?(?:[0-9a-f]{4,64}\.\.\.?[0-9a-f]{4,64}|\[[a-z ]+\])\s/;
/** A ref the push updated: fast-forward "a1b2c3d..e4f5a6b", forced "+ a1b2c3d...e4f5a6b", or "* [new branch]"
 *  (tag, reference). Never "! [rejected]", "! [remote rejected]", "- [deleted]" or "= [up to date]". */
const REF_UPDATED = /^\s*(?:[+*]\s+)?(?:[0-9a-f]{4,64}\.\.\.?[0-9a-f]{4,64}|\[new (?:branch|tag|reference)\])\s+\S+\s+->\s+\S/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── merges by number ────────────────────────────────────────────────────

/** A PR a `gh pr merge` call names: its repo when the call says it (`--repo`, `-R`, a PR URL),
 *  else the absolute directory gh ran in (its repo is looked up by outcomes.ts). */
export interface MergeTarget {
  number: number;
  repo: string | null;
  dir: string | null;
}

/** A `NAME=value` prefix (its value quoted or bare), as tripwires-defs.ts reads it. */
const ASSIGN = String.raw`[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()"'])*`;
/** `gh pr merge` where a command starts (tripwires-defs' AT, less `xargs`: its PR comes from stdin),
 *  run over maskShell's text so a mention inside quotes or a comment never matches. */
const MERGE_AT = new RegExp(
  String.raw`(?:^|[\n;&|(]|\$\()\s*(?:(?:then|do|else|rtk(?:\s+proxy)?|sudo|nohup|time|command|exec|env(?:\s+\w+=\S*)*)\s+|${ASSIGN}[ \t]+)*(?:[^\s;&|()]*\/)?gh\s+pr\s+merge(?=\s|$)`,
  "g",
);
/** gh's own failure lines (a non-TTY gh writes nothing on a successful merge): a merge whose
 *  output shows one didn't merge, even when a pipe hid its exit code. */
const GH_FAILED = /^(?:GraphQL: |X Pull request |HTTP \d{3}: |non-200 OK status code)/m;
/** GitHub's mergedAt is whole seconds on GitHub's clock: this much either side of a call still counts. */
export const MERGE_WINDOW_SLACK_MS = 5_000;
/** Every word that can move the shell: more of them than effectiveDir followed = a dir it can't know. */
const DIR_WORD = /(?<![\w./-])(?:cd|pushd|popd)(?=[\s;&|)]|$)/g;
/** effectiveDir's own `cd` / `pushd` (tripwires-lib CD_RE). */
const DIR_CALL = /(?:^|[\n;&|(])\s*(?:cd|pushd)\s+/g;
/** gh pr merge's flags that take a value (gh 2.x): their value is never the PR. */
const VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"]);
const PR_NUMBER_ARG = /^#?(\d{1,9})$/;
const PR_URL_ARG = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\/?$/;
/** One word: a redirection with its target (never an argument), else quoted / bare pieces. */
const WORD = /\d*[<>]+&?\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+)?|(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'<>]+)+|\S/g;
const PIECE = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^"']+)/g;

/** The words of one simple command's arguments, unquoted. A word the shell would expand (a `$`,
 *  a backtick, a glob, `~`) is null; an unclosed quote ends the list with a null. */
function argWords(s: string): Array<string | null> {
  const words: Array<string | null> = [];
  for (const m of s.matchAll(WORD)) {
    const w = m[0];
    if (/^\d*[<>]/.test(w)) continue;
    if (w === '"' || w === "'") {
      words.push(null);
      break;
    }
    let out = "";
    let opaque = false;
    for (const p of w.matchAll(PIECE)) {
      if (p[2] !== undefined) out += p[2];
      else if (p[1] !== undefined) {
        if (/[$`]/.test(p[1])) opaque = true;
        out += p[1].replace(/\\(["\\$`])/g, "$1");
      } else {
        if (/[$`*?[\]{}~\\]/.test(p[3] ?? "")) opaque = true;
        out += p[3] ?? "";
      }
    }
    words.push(opaque ? null : out);
  }
  return words;
}

/** `--repo`'s value ([HOST/]OWNER/REPO or a URL) as "owner/repo"; null for another host or a non-repo. */
function repoArg(v: string): string | null {
  const url = githubRepoOfRemoteUrl(v);
  if (url) return url;
  const parts = v.replace(/^github\.com\//i, "").split("/");
  return parts.length === 2 ? normalizeRepo(parts[0] ?? "", parts[1] ?? "") : null;
}

/**
 * The PRs the `gh pr merge` calls in `command` name. Heredoc bodies, quotes and comments are not
 * calls. Per call: the first positional argument must be a PR number or a github.com PR URL (a
 * branch, `$n` or nothing names no PR here). The repo is the URL's, else `--repo` / `-R`'s, else
 * (unless the command sets GH_REPO) the directory: `cwd` moved by every `cd` / `pushd` still in
 * effect, `~` expanded against `homeDir`. A `cd` it can't follow (a variable, `-`, `popd`, inside
 * an `if`) or no `homeDir` means no directory, so no target: never a guessed repo.
 */
export function mergeTargetsIn(command: string, cwd: string | null, homeDir: string | null): MergeTarget[] {
  if (!command.includes("merge")) return [];
  const text = stripHeredocs(command).slice(0, MAX_MATCH_CHARS);
  const masked = maskShell(text);
  const out: MergeTarget[] = [];
  MERGE_AT.lastIndex = 0;
  for (let m = MERGE_AT.exec(masked); m !== null; m = MERGE_AT.exec(masked)) {
    const start = m.index + m[0].length;
    let end = start;
    while (end < masked.length && !"\n;&|)".includes(masked[end] ?? "")) end++;
    const words = argWords(text.slice(start, end));
    let selector: string | null | undefined; // the first positional word; null = one only the shell knows
    let repoFlag: string | null | undefined;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === null || w === undefined) selector ??= null;
      else if (w === "--") {
        selector ??= words[i + 1] ?? null;
        break;
      } else if (w === "-R" || w === "--repo") repoFlag = words[++i] ?? null;
      else if (w.startsWith("--repo=")) repoFlag = w.slice(7);
      else if (/^-R./.test(w)) repoFlag = w.slice(2);
      else if (VALUE_FLAGS.has(w)) i++;
      else if (!w.startsWith("-")) selector ??= w;
    }
    if (!selector) continue;
    const url = PR_URL_ARG.exec(selector);
    if (url) {
      const repo = normalizeRepo(url[1] ?? "", url[2] ?? "");
      if (repo) out.push({ number: Number(url[3]), repo, dir: null });
      continue;
    }
    const n = Number(PR_NUMBER_ARG.exec(selector)?.[1]);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (repoFlag !== undefined) {
      const repo = repoFlag === null ? null : repoArg(repoFlag);
      if (repo) out.push({ number: n, repo, dir: null });
      continue;
    }
    if (homeDir === null || text.includes("GH_REPO")) continue;
    const before = masked.slice(0, m.index); // what effectiveDir reads
    if ((before.match(DIR_WORD)?.length ?? 0) !== (before.match(DIR_CALL)?.length ?? 0)) continue;
    const dir = effectiveDir(text, masked, m.index, m[0], cwd ?? "", homeDir);
    if (dir !== null) out.push({ number: n, repo: null, dir: resolve(dir.replace(/^~(?=\/|$)/, homeDir)) });
  }
  return out;
}

/** The one GitHub repo `git remote -v` lists across all remotes, or null: none, or two (a fork
 *  with its upstream), where gh's own pick depends on its settings. */
export function githubRepoOfRemotes(remoteV: string): string | null {
  const repos = new Set<string>();
  for (const line of remoteV.split(/\r?\n/)) {
    const url = /^\S+\s+(\S+)/.exec(line)?.[1];
    const repo = url ? githubRepoOfRemoteUrl(url) : null;
    if (repo) repos.add(repo);
  }
  return repos.size === 1 ? ([...repos][0] ?? null) : null;
}

/** The GitHub repos a push's output shows a ref update for: a `To <remote>` line followed, in the
 *  per-ref lines right under it, by one that updated a ref. */
export function landedPushRepos(text: string): Set<string> {
  const out = new Set<string>();
  let repo: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const to = TO_REMOTE.exec(line);
    if (to) {
      repo = githubRepoOfRemoteUrl(to[1] ?? "");
      continue;
    }
    if (repo === null) continue;
    if (!REF_LINE.test(line)) repo = null; // the per-ref lines ended (an error, a hint, a fetch)
    else if (REF_UPDATED.test(line)) out.add(repo);
  }
  return out;
}

/** "owner/repo#n" for every PR gh's output says it closed. */
function closedPrsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CLOSED_PR)) {
    const repo = normalizeRepo(m[1] ?? "", m[2] ?? "");
    if (repo) out.push(`${repo}#${Number(m[3])}`);
  }
  return out;
}

// ── the fold ────────────────────────────────────────────────────────────

/** A session's facts so far, as persisted (plain JSON). `offset` is where the next read starts. */
export interface FoldState {
  offset: number;
  /** Inside a line longer than a whole tick's budget: bytes are discarded up to its newline. */
  skipping: boolean;
  pendingShip: string[];
  pendingTaskCreates: string[];
  /** `gh pr close` calls whose output has not been read yet. */
  pendingClose: string[];
  /** The pendingShip calls that are `git push --dry-run`: their pushes land nothing. */
  pendingDryRun: string[];
  /** "owner/repo#n" the session's own `gh pr close` closed, per gh's output (≤ 500). */
  closedPrs: string[];
  /** "owner/repo#n" its own `gh pr create` / `gh pr merge` output named (≤ 500). */
  madePrs: string[];
  /** `gh pr merge <n>` calls whose result has not been read yet: one entry per PR each names,
   *  `from` = the call's time. */
  pendingMerges: Array<{ id: string; from: string } & MergeTarget>;
  /** Merges by number that ran in `dir`, [from, to] the call: outcomes.ts asks git for the repo. */
  mergesByDir: Array<{ dir: string; number: number; from: string; to: string }>;
  /** Merges by number that ran (≤ 200): each is a PR only once gh's mergedAt falls in [from, to]. */
  ranMerges: Array<{ repo: string; number: number; from: string; to: string }>;
  /** The PRs that count: every sighting, minus closedPrs not in madePrs. */
  prs: Array<{ repo: string; number: number; at: string }>;
  /** Latest push per repo. */
  pushes: Array<{ repo: string; at: string }>;
  /** First sighting per link. */
  artifacts: Array<{ url: string; at: string }>;
  learnings: string[];
  toolCalls: number;
  writes: number;
  todoWrite: { total: number; completed: number } | null;
  tasks: Array<[string, string]>;
  lastList: "todo" | "task" | null;
}

export function newFoldState(): FoldState {
  return { offset: 0, skipping: false, pendingShip: [], pendingTaskCreates: [], pendingClose: [], pendingDryRun: [], closedPrs: [], madePrs: [], pendingMerges: [], mergesByDir: [], ranMerges: [], prs: [], pushes: [], artifacts: [], learnings: [], toolCalls: 0, writes: 0, todoWrite: null, tasks: [], lastList: null };
}

/** True when `raw` could change the fold. Everything else is skipped without a JSON parse.
 *  `havePendingOwn`: a TaskCreate, a `gh pr close` or a `gh pr merge <n>` waits for its result. */
export function mayCarryOutcome(raw: string, havePendingShip: boolean, havePendingOwn: boolean): boolean {
  return raw.includes('"tool_use"') || raw.includes('"frame-link"') || (havePendingOwn && raw.includes('"tool_result"')) || mayCarryEvidence(raw, havePendingShip);
}

/** Folds lines into a working copy of a FoldState; `finish` returns the new state. */
export class OutcomeFoldReader {
  private readonly ev: EvidenceFold;
  private readonly taskCreates: Set<string>;
  private readonly closes: Set<string>;
  private readonly dryRuns: Set<string>;
  private readonly closed: Set<string>;
  private readonly made: Set<string>;
  private readonly merges: Map<string, Array<MergeTarget & { from: string }>>;
  private readonly byDir: FoldState["mergesByDir"];
  private readonly ran: FoldState["ranMerges"];
  private readonly prs: Map<string, { repo: string; number: number; at: string }>;
  private readonly pushes: Map<string, string>;
  private readonly artifacts: Map<string, string>;
  private readonly learnings: Set<string>;
  private readonly tasks: Map<string, string>;
  private toolCalls: number;
  private writes: number;
  private todoWrite: FoldState["todoWrite"];
  private lastList: FoldState["lastList"];

  /** `homeDir` expands a `cd ~/…`; without it, a merge by number whose repo the call doesn't say is skipped. */
  constructor(
    prev: FoldState,
    private readonly homeDir: string | null = null,
  ) {
    this.ev = newEvidenceFold(prev.pendingShip);
    this.taskCreates = new Set(prev.pendingTaskCreates);
    this.closes = new Set(prev.pendingClose);
    this.dryRuns = new Set(prev.pendingDryRun);
    this.closed = new Set(prev.closedPrs);
    this.made = new Set(prev.madePrs);
    this.merges = new Map();
    for (const { id, ...t } of prev.pendingMerges) this.merges.set(id, [...(this.merges.get(id) ?? []), t]);
    this.byDir = prev.mergesByDir.map((m) => ({ ...m }));
    this.ran = prev.ranMerges.map((m) => ({ ...m }));
    this.prs = new Map(prev.prs.map((p) => [`${p.repo}#${p.number}`, { ...p }]));
    this.pushes = new Map(prev.pushes.map((p) => [p.repo, p.at]));
    this.artifacts = new Map(prev.artifacts.map((a) => [a.url, a.at]));
    this.learnings = new Set(prev.learnings);
    this.tasks = new Map(prev.tasks);
    this.toolCalls = prev.toolCalls;
    this.writes = prev.writes;
    this.todoWrite = prev.todoWrite ? { ...prev.todoWrite } : null;
    this.lastList = prev.lastList;
  }

  /** One complete transcript line (no newline). `fallbackAt` stands in for a missing timestamp. */
  line(raw: string, fallbackAt: string): void {
    if (!mayCarryOutcome(raw, this.ev.pending.size > 0, this.taskCreates.size > 0 || this.closes.size > 0 || this.merges.size > 0)) return;
    if (raw.includes('"frame-link"') && this.frameLink(raw, fallbackAt)) return;
    const line = parseLine(raw);
    if (!line) return;
    const at = line.timestamp ?? fallbackAt;
    // Read before foldEvidence consumes them: the repos each ship command's output shows a ref update for.
    const landed = new Map<string, Set<string>>();
    for (const r of line.toolResults) {
      if (this.ev.pending.has(r.toolUseId)) landed.set(r.toolUseId, this.dryRuns.delete(r.toolUseId) ? new Set() : landedPushRepos(toolResultText(r.content)));
    }
    const before = this.ev.rows.length;
    foldEvidence(this.ev, line, at, { agentEdits: false, cwd: null });
    for (const r of this.ev.rows.splice(before)) {
      if (r.kind === "push" && !landed.get(r.key.slice(0, r.key.indexOf(" ")))?.has(r.subject)) continue; // key: "<tool_use id> owner/repo"
      if (r.kind === "pr" && !line.prLink && this.made.size < MAX_PR_KEYS) this.made.add(r.key); // a ship command's own output
      this.ev.rows.push(r);
    }
    for (const use of line.toolUses) {
      this.toolCalls += 1;
      if (use.name === "Bash" && use.id && typeof use.input.command === "string") {
        if (CLOSE_COMMAND.test(use.input.command) && this.closes.size < MAX_PENDING) this.closes.add(use.id);
        if (this.ev.pending.has(use.id) && DRY_RUN_PUSH.test(use.input.command) && this.dryRuns.size < MAX_PENDING) this.dryRuns.add(use.id);
        if (this.ev.pending.has(use.id) && this.merges.size < MAX_PENDING) {
          const targets = mergeTargetsIn(use.input.command, line.cwd, this.homeDir);
          if (targets.length > 0) this.merges.set(use.id, targets.map((t) => ({ ...t, from: at })));
        }
      } else if (WRITE_TOOLS.has(use.name)) {
        this.writes += 1;
        const p = typeof use.input.file_path === "string" ? use.input.file_path : typeof use.input.notebook_path === "string" ? use.input.notebook_path : null;
        const abs = p ? (isAbsolute(p) ? resolve(p) : line.cwd ? resolve(line.cwd, p) : null) : null;
        if (abs && isLearningPath(abs) && this.learnings.size < MAX_LIST) this.learnings.add(abs);
      } else if (use.name === "TodoWrite") {
        const todos = use.input.todos;
        if (Array.isArray(todos)) {
          this.todoWrite = { total: todos.length, completed: todos.filter((t) => isRecord(t) && t.status === "completed").length };
          this.lastList = "todo";
        }
      } else if (use.name === "TaskCreate" && use.id) {
        if (this.taskCreates.size < MAX_PENDING) this.taskCreates.add(use.id);
      } else if (use.name === "TaskUpdate") {
        const id = use.input.taskId;
        const status = use.input.status;
        if (typeof id === "string" && TASK_ID.test(id) && typeof status === "string") {
          if (status === "deleted") this.tasks.delete(id);
          else if (this.tasks.has(id) || this.tasks.size < MAX_TASKS) this.tasks.set(id, status.slice(0, 20));
          this.lastList = "task";
        }
      }
    }
    for (const r of line.toolResults) {
      const merges = this.merges.get(r.toolUseId);
      if (merges) {
        this.merges.delete(r.toolUseId);
        const failed = r.isError || GH_FAILED.test(toolResultText(r.content));
        for (const t of failed ? [] : merges) {
          if (t.repo && this.ran.length < MAX_PENDING) this.ran.push({ repo: t.repo, number: t.number, from: t.from, to: at });
          else if (t.dir && this.byDir.length < MAX_PENDING) this.byDir.push({ dir: t.dir, number: t.number, from: t.from, to: at });
        }
      }
      if (this.closes.delete(r.toolUseId)) {
        for (const key of closedPrsIn(toolResultText(r.content))) if (this.closed.size < MAX_PR_KEYS) this.closed.add(key);
      }
      if (!this.taskCreates.delete(r.toolUseId)) continue;
      const id = TASK_CREATED.exec(toolResultText(r.content))?.[1];
      if (id && !this.tasks.has(id) && this.tasks.size < MAX_TASKS) this.tasks.set(id, "pending");
      if (id) this.lastList = "task";
    }
  }

  /** A `frame-link` record (Claude Code's own "published a claude.ai artifact"); false when the
   *  line merely contains the words (a grep for them, say): it is then folded as usual. */
  private frameLink(raw: string, fallbackAt: string): boolean {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isRecord(obj) || obj.type !== "frame-link") return false;
    const at = typeof obj.timestamp === "string" ? obj.timestamp : fallbackAt;
    if (typeof obj.frameUrl === "string") {
      for (const url of artifactUrlsIn(obj.frameUrl)) if (!this.artifacts.has(url) && this.artifacts.size < MAX_LIST) this.artifacts.set(url, at);
    }
    return true;
  }

  finish(offset: number, skipping: boolean): FoldState {
    const onlyClosed = (key: string): boolean => this.closed.has(key) && !this.made.has(key);
    for (const r of this.ev.rows) {
      if (r.kind === "pr") {
        const n = Number(PR_KEY_NUMBER.exec(r.key)?.[1]); // a pr-link without a number ("repo#?") can't be checked
        if (!Number.isSafeInteger(n) || n <= 0) continue;
        const key = `${r.subject}#${n}`;
        if (onlyClosed(key)) continue;
        const prev = this.prs.get(key);
        if (!prev || r.at < prev.at) this.prs.set(key, { repo: r.subject, number: n, at: r.at });
      } else if (r.kind === "push") {
        const prev = this.pushes.get(r.subject);
        if (prev === undefined || r.at > prev) this.pushes.set(r.subject, r.at);
      }
    }
    for (const key of this.prs.keys()) if (onlyClosed(key)) this.prs.delete(key); // sighted in an earlier read
    this.ev.rows.length = 0;
    const pendingShip = [...this.ev.pending].slice(-MAX_PENDING);
    return {
      offset,
      skipping,
      pendingShip,
      pendingTaskCreates: [...this.taskCreates],
      pendingClose: [...this.closes],
      pendingDryRun: [...this.dryRuns].filter((id) => pendingShip.includes(id)),
      closedPrs: [...this.closed],
      madePrs: [...this.made],
      pendingMerges: [...this.merges].flatMap(([id, ts]) => ts.map((t) => ({ id, ...t }))),
      mergesByDir: this.byDir,
      ranMerges: this.ran,
      prs: [...this.prs.values()],
      pushes: [...this.pushes].map(([repo, at]) => ({ repo, at })),
      artifacts: [...this.artifacts].map(([url, at]) => ({ url, at })),
      learnings: [...this.learnings],
      toolCalls: this.toolCalls,
      writes: this.writes,
      todoWrite: this.todoWrite,
      tasks: [...this.tasks],
      lastList: this.lastList,
    };
  }
}

/** Gives each merge by number whose directory `repos` answers its repo (into ranMerges). A
 *  directory answered null (not a checkout, no single GitHub repo) drops its merges; one not
 *  asked stays waiting. */
export function placeMergesByDir(f: FoldState, repos: ReadonlyMap<string, string | null>): FoldState {
  const ran = [...f.ranMerges];
  const waiting: FoldState["mergesByDir"] = [];
  for (const m of f.mergesByDir) {
    if (!repos.has(m.dir)) {
      waiting.push(m);
      continue;
    }
    const repo = repos.get(m.dir);
    if (repo && PR_KEY.test(`${repo}#${m.number}`) && ran.length < MAX_PENDING) ran.push({ repo, number: m.number, from: m.from, to: m.to });
  }
  return { ...f, mergesByDir: waiting, ranMerges: ran };
}

/** Every PR gh is asked about for this fold: its sightings, and the PRs its merges by number name. */
export function prsToCheck(f: FoldState): Array<{ repo: string; number: number; at: string }> {
  return [...f.prs, ...f.ranMerges.map((m) => ({ repo: m.repo, number: m.number, at: m.to }))];
}

/** True when gh's mergedAt falls inside the merge call, give or take MERGE_WINDOW_SLACK_MS. */
function mergedDuring(mergedAt: string | null, m: { from: string; to: string }): boolean {
  const t = mergedAt === null ? Number.NaN : Date.parse(mergedAt);
  return Number.isFinite(t) && t >= Date.parse(m.from) - MERGE_WINDOW_SLACK_MS && t <= Date.parse(m.to) + MERGE_WINDOW_SLACK_MS;
}

/** The todo list the session touched last, as counts. */
export function todosOf(f: FoldState): { total: number; completed: number } | null {
  if (f.lastList === "todo") return f.todoWrite;
  if (f.lastList === "task") return { total: f.tasks.length, completed: f.tasks.filter(([, s]) => s === "completed").length };
  return null;
}

// ── the verdict ─────────────────────────────────────────────────────────

/** What gh said about a PR. */
export interface PrCheck {
  state: Exclude<PrState, "unchecked">;
  mergedAt: string | null;
  url: string | null;
  checkedAt: string;
}

export interface ClassifyInput {
  live: boolean;
  /** Now minus the transcript's mtime. */
  quietMs: number;
  prs: readonly OutcomePr[];
  pushes: ReadonlyArray<{ repo: string; at: string }>;
  artifacts: ReadonlyArray<{ url: string; at: string }>;
  /** The transcript's tail (endings.ts readTailEnding); null before it was read. */
  ending: TailEnding | null;
  /** The db row's last-line state (the indexer's); null when the db has no row. */
  lastLine: LastLineState | null;
  todos: { total: number; completed: number } | null;
}

export interface Verdict {
  outcome: SessionOutcome;
  reason: string | null;
  ending: OutcomeEnding | null;
  evidenceAt: string | null;
  /** Quiet time (since the transcript's last write) up to which the clock alone can still change
   *  this verdict; null when it can't (OutcomeRecord.provisionalUntil). */
  provisionalMs: number | null;
}

/** A failed or stopped ending, the same way RunEndings reads it (endings.ts): an interrupt is the
 *  user's in an interactive session, of unknown cause (failed) in a headless one. A tail with
 *  nothing conversational is unknown, never failed. */
export function endingOf(ending: TailEnding | null, quietMs: number): OutcomeEnding | null {
  if (!ending || ending.kind === null) return null;
  const o = endingOutcome(ending.kind, quietMs, ending.error, ending.headless ? null : USER_INTERRUPT);
  return (o.status === "failed" || o.status === "stopped") && o.reason ? { status: o.status, reason: o.reason, headless: ending.headless } : null;
}

/** The quiet times at which fold.ts endingOutcome changes its answer: the only ones endingOf can. */
const ENDING_BOUNDS_MS = [LIVE_WINDOW_MS, STALL_MS, PROMPT_STALL_MS] as const;

/** Up to which quiet time this tail still reads as no failure, when a longer silence will make it
 *  one (a turn left mid-way: its stall bound); null when it never will, or already does. endingOf
 *  itself is asked at each bound, so this can't drift from it. */
function endingDueMs(ending: TailEnding | null, quietMs: number): number | null {
  if (endingOf(ending, quietMs) !== null) return null;
  return ENDING_BOUNDS_MS.find((b) => b >= quietMs && endingOf(ending, b + 1) !== null) ?? null;
}

const PR_WORD: Record<PrState, string> = {
  MERGED: "merged",
  OPEN: "open",
  CLOSED: "closed without merging",
  unknown: "(gh couldn't say)",
  unchecked: "(not checked yet)",
};

const max = (xs: readonly string[]): string | null => xs.reduce<string | null>((m, x) => (m === null || x > m ? x : m), null);

/** The one verdict (precedence in shared/features/outcomes.ts). Only a PR gh reports MERGED makes
 *  a session shipped: "unknown" and "unchecked" are delivered at most. */
export function classifyOutcome(i: ClassifyInput): Verdict {
  if (i.live) return { outcome: "active", reason: null, ending: null, evidenceAt: null, provisionalMs: null };
  const merged = i.prs.filter((p) => p.state === "MERGED");
  const lastMerged = [...merged].sort((a, b) => ((b.mergedAt ?? b.firstSeenAt) > (a.mergedAt ?? a.firstSeenAt) ? 1 : -1))[0];
  const awaiting = i.lastLine !== null && isAwaitingInput("live", i.lastLine);
  // A pending AskUserQuestion is a question to the user, not a tool call that never returned.
  const asked = awaiting && i.lastLine?.kind === "assistant_tool" && i.ending?.kind === "assistant_tool";
  const ending = asked ? null : endingOf(i.ending, i.quietMs);
  if (lastMerged) {
    return { outcome: "shipped", reason: `${lastMerged.repo}#${lastMerged.number} merged`, ending, evidenceAt: max(merged.map((p) => p.mergedAt ?? p.firstSeenAt)), provisionalMs: null };
  }
  const delivered = max([...i.prs.map((p) => p.firstSeenAt), ...i.pushes.map((p) => p.at), ...i.artifacts.map((a) => a.at)]);
  const newestPr = [...i.prs].sort((a, b) => (b.firstSeenAt > a.firstSeenAt ? 1 : -1))[0];
  if (newestPr) return { outcome: "delivered", reason: `${newestPr.repo}#${newestPr.number} ${PR_WORD[newestPr.state]}`, ending, evidenceAt: delivered, provisionalMs: null };
  const lastPush = [...i.pushes].sort((a, b) => (b.at > a.at ? 1 : -1))[0];
  if (lastPush) return { outcome: "delivered", reason: `pushed to ${lastPush.repo}${i.pushes.length > 1 ? ` (+${i.pushes.length - 1} more)` : ""}`, ending, evidenceAt: delivered, provisionalMs: null };
  if (i.artifacts.length > 0) {
    return { outcome: "delivered", reason: `published ${i.artifacts.length === 1 ? "a claude.ai artifact" : `${i.artifacts.length} claude.ai artifacts`}`, ending, evidenceAt: delivered, provisionalMs: null };
  }
  if (ending) return { outcome: ending.status, reason: ending.reason, ending, evidenceAt: null, provisionalMs: null };
  if (awaiting && i.quietMs >= ABANDON_MS) {
    const why = i.lastLine?.kind === "assistant_tool" ? `waited on you: ${i.lastLine.toolName ?? "a question"}` : "its last message asked you a question";
    return { outcome: "abandoned", reason: why, ending: null, evidenceAt: null, provisionalMs: null };
  }
  // Finished or unknown for now: the clock alone can still make it failed (a turn left mid-way,
  // once silent past its stall bound) or abandoned (a question unanswered for ABANDON_MS).
  const due = [asked ? null : endingDueMs(i.ending, i.quietMs), awaiting ? ABANDON_MS : null].filter((d): d is number => d !== null);
  const provisionalMs = due.length > 0 ? Math.min(...due) : null;
  if (i.todos && i.todos.total >= 1 && i.todos.completed === i.todos.total) {
    return { outcome: "finished", reason: `all ${i.todos.total} todo item${i.todos.total === 1 ? "" : "s"} completed`, ending: null, evidenceAt: null, provisionalMs };
  }
  return { outcome: "unknown", reason: null, ending: null, evidenceAt: null, provisionalMs };
}

// ── PR state (gh) ───────────────────────────────────────────────────────

/** Whether a PR is due for `gh pr view`: never asked, OPEN for 6h+, or unknown for 1h+.
 *  MERGED and CLOSED are final and never asked again. */
export function prCheckDue(c: PrCheck | undefined, nowMs: number): boolean {
  if (!c) return true;
  if (c.state === "MERGED" || c.state === "CLOSED") return false;
  const t = Date.parse(c.checkedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= (c.state === "OPEN" ? OPEN_RECHECK_MS : UNKNOWN_RETRY_MS);
}

const SEGMENT = /^[a-z0-9_.][a-z0-9_.-]*$/;

/** The argv for `gh pr view` (read-only; run with execFile, never a shell). Null when `repo` isn't
 *  a plain lowercased "owner/repo" or `n` isn't a PR number: then gh is never called. */
export function ghPrViewArgs(repo: string, n: number): string[] | null {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && !/^\.+$/.test(p))) return null;
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return ["pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt,url"];
}

export type GhResult = { ok: true; stdout: string } | { ok: false; code: string | null };

const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** gh's answer as a PrCheck. Anything but a well-formed MERGED / OPEN / CLOSED answer is "unknown". */
export function prCheckFrom(result: GhResult, checkedAt: string): PrCheck {
  const unknown: PrCheck = { state: "unknown", mergedAt: null, url: null, checkedAt };
  if (!result.ok) return unknown;
  let v: unknown;
  try {
    v = JSON.parse(result.stdout);
  } catch {
    return unknown;
  }
  if (!isRecord(v) || (v.state !== "MERGED" && v.state !== "OPEN" && v.state !== "CLOSED")) return unknown;
  const mergedAt = typeof v.mergedAt === "string" && Number.isFinite(Date.parse(v.mergedAt)) ? v.mergedAt : null;
  const url = typeof v.url === "string" && PULL_URL.test(v.url) ? v.url : null;
  return { state: v.state, mergedAt: v.state === "MERGED" ? mergedAt : null, url, checkedAt };
}

/** A fold's PRs with what gh said about each (newest sighting first): its sightings, plus each
 *  merge by number gh says merged during that very call (the one that failed never counts). */
export function prsWithState(f: FoldState, checks: Readonly<Record<string, PrCheck>>): OutcomePr[] {
  const seen = new Set(f.prs.map((p) => `${p.repo}#${p.number}`));
  const merged: FoldState["prs"] = [];
  for (const m of f.ranMerges) {
    const key = `${m.repo}#${m.number}`;
    const c = checks[key];
    if (seen.has(key) || c?.state !== "MERGED" || !mergedDuring(c.mergedAt, m)) continue;
    seen.add(key);
    merged.push({ repo: m.repo, number: m.number, at: m.to });
  }
  return [...f.prs, ...merged]
    .map((p) => {
      const c = checks[`${p.repo}#${p.number}`];
      return {
        repo: p.repo,
        number: p.number,
        url: c?.url ?? `https://github.com/${p.repo}/pull/${p.number}`,
        state: c?.state ?? "unchecked",
        mergedAt: c?.mergedAt ?? null,
        checkedAt: c?.checkedAt ?? null,
        firstSeenAt: p.at,
      } satisfies OutcomePr;
    })
    .sort((a, b) => (b.firstSeenAt > a.firstSeenAt ? 1 : b.firstSeenAt < a.firstSeenAt ? -1 : 0));
}

// ── the Feed ────────────────────────────────────────────────────────────

export interface AnnounceInput {
  prev: SessionOutcome | null;
  next: SessionOutcome;
  evidenceAt: string | null;
  announced: readonly SessionOutcome[];
  /** The store started empty and its first full scan hasn't finished: nothing is announced. */
  cold: boolean;
  nowMs: number;
}

/** A graduation goes to the Feed only on a transition INTO shipped or delivered, once per session
 *  and outcome, when the evidence is under 24h old, and never during the cold scan. */
export function shouldAnnounce(a: AnnounceInput): a is AnnounceInput & { next: "shipped" | "delivered" } {
  if (a.cold || (a.next !== "shipped" && a.next !== "delivered")) return false;
  if (a.prev === a.next || a.announced.includes(a.next)) return false;
  const t = a.evidenceAt ? Date.parse(a.evidenceAt) : Number.NaN;
  return Number.isFinite(t) && a.nowMs - t < GRADUATION_WINDOW_MS;
}

/** "🎓 <name> shipped owner/repo#n" / "📦 <name> delivered owner/repo#n | a push to owner/repo | a claude.ai artifact". */
export function graduationTitle(name: string, outcome: "shipped" | "delivered", prs: readonly OutcomePr[], pushes: ReadonlyArray<{ repo: string }>): string {
  const clean = sanitizeTitle(name);
  const short = clean.length > 40 ? `${clean.slice(0, 39).trimEnd()}…` : clean;
  if (outcome === "shipped") {
    const p = prs.find((x) => x.state === "MERGED");
    return sanitizeTitle(`🎓 ${short} shipped ${p ? `${p.repo}#${p.number}` : "a PR"}`);
  }
  const p = prs[0];
  const what = p ? `${p.repo}#${p.number}` : pushes[0] ? `a push to ${pushes[0].repo}` : "a claude.ai artifact";
  return sanitizeTitle(`📦 ${short} delivered ${what}`);
}

// ── the persisted store ─────────────────────────────────────────────────

export interface StoredSession {
  fold: FoldState;
  /** The transcript size the fold and its tail ending were both read to; -1 before that. */
  readSize: number;
  /** Transcript mtime (ms) when last read or seen. */
  mtimeMs: number;
  ending: TailEnding | null;
  /** The effective outcome on the last tick (transitions are measured against it). */
  last: SessionOutcome | null;
  /** Outcomes already sent to the Feed. */
  announced: SessionOutcome[];
  onDisk: boolean;
}

export interface StoreFile {
  version: typeof OUTCOMES_VERSION;
  ticks: number;
  coldDone: boolean;
  coldTicks: number | null;
  sessions: Record<string, StoredSession>;
  prs: Record<string, PrCheck>;
}

export function emptyStore(): StoreFile {
  return { version: OUTCOMES_VERSION, ticks: 0, coldDone: false, coldTicks: null, sessions: {}, prs: {} };
}

export function newStoredSession(): StoredSession {
  return { fold: newFoldState(), readSize: -1, mtimeMs: 0, ending: null, last: null, announced: [], onDisk: true };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PR_KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+#\d{1,9}$/;
const LINE_KINDS: ReadonlySet<string> = new Set<LineKind>(["assistant_text", "tool_end", "api_error", "interrupted", "text_open", "thinking", "assistant_tool", "tool_result", "prompt"]);

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isCount = (v: unknown): v is { total: number; completed: number } => isRecord(v) && isNum(v.total) && isNum(v.completed);

function isFold(v: unknown): v is FoldState {
  if (!isRecord(v)) return false;
  return (
    isNum(v.offset) &&
    v.offset >= 0 &&
    typeof v.skipping === "boolean" &&
    isStrArr(v.pendingShip) &&
    isStrArr(v.pendingTaskCreates) &&
    isStrArr(v.pendingClose) &&
    isStrArr(v.pendingDryRun) &&
    isStrArr(v.closedPrs) &&
    isStrArr(v.madePrs) &&
    Array.isArray(v.pendingMerges) &&
    v.pendingMerges.every((m) => isRecord(m) && isStr(m.id) && isStr(m.from) && isNum(m.number) && (m.repo === null || isStr(m.repo)) && (m.dir === null || isStr(m.dir))) &&
    Array.isArray(v.mergesByDir) &&
    v.mergesByDir.every((m) => isRecord(m) && isStr(m.dir) && isNum(m.number) && isStr(m.from) && isStr(m.to)) &&
    Array.isArray(v.ranMerges) &&
    v.ranMerges.every((m) => isRecord(m) && isStr(m.repo) && isNum(m.number) && isStr(m.from) && isStr(m.to) && PR_KEY.test(`${m.repo}#${m.number}`)) &&
    Array.isArray(v.prs) &&
    v.prs.every((p) => isRecord(p) && isStr(p.repo) && isNum(p.number) && isStr(p.at) && PR_KEY.test(`${p.repo}#${p.number}`)) &&
    Array.isArray(v.pushes) &&
    v.pushes.every((p) => isRecord(p) && isStr(p.repo) && isStr(p.at)) &&
    Array.isArray(v.artifacts) &&
    v.artifacts.every((a) => isRecord(a) && isStr(a.url) && isStr(a.at)) &&
    isStrArr(v.learnings) &&
    isNum(v.toolCalls) &&
    isNum(v.writes) &&
    (v.todoWrite === null || isCount(v.todoWrite)) &&
    Array.isArray(v.tasks) &&
    v.tasks.every((t) => Array.isArray(t) && t.length === 2 && isStr(t[0]) && isStr(t[1])) &&
    (v.lastList === null || v.lastList === "todo" || v.lastList === "task")
  );
}

function isTailEnding(v: unknown): v is TailEnding {
  return isRecord(v) && (v.kind === null || (isStr(v.kind) && LINE_KINDS.has(v.kind))) && (v.error === null || isStr(v.error)) && typeof v.headless === "boolean";
}

function isStoredSession(v: unknown): v is StoredSession {
  return (
    isRecord(v) &&
    isFold(v.fold) &&
    isNum(v.readSize) &&
    isNum(v.mtimeMs) &&
    (v.ending === null || isTailEnding(v.ending)) &&
    (v.last === null || isSessionOutcome(v.last)) &&
    Array.isArray(v.announced) &&
    v.announced.every(isSessionOutcome) &&
    typeof v.onDisk === "boolean"
  );
}

function isPrCheck(v: unknown): v is PrCheck {
  return (
    isRecord(v) &&
    (v.state === "MERGED" || v.state === "OPEN" || v.state === "CLOSED" || v.state === "unknown") &&
    (v.mergedAt === null || isStr(v.mergedAt)) &&
    (v.url === null || isStr(v.url)) &&
    isStr(v.checkedAt)
  );
}

/** Entries of a persisted PR map that are a valid owner/repo#n key and PR check. */
function validPrs(raw: Record<string, unknown>): Record<string, PrCheck> {
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, PrCheck] => PR_KEY.test(e[0]) && isPrCheck(e[1])));
}

/** The persisted store, or null (start empty) for anything that isn't this version's shape. A
 *  single malformed session or PR entry is dropped (that session is re-read from its start).
 *  A version-2 store restarts every session (its folds read past merges by number) and keeps only
 *  the PR states gh gave as final, MERGED and CLOSED: they are answers about the PR, not the fold,
 *  and are never asked again anyway. Its cold scan re-reads the transcripts without re-asking gh. */
export function parseStore(raw: unknown): StoreFile | null {
  if (isRecord(raw) && raw.version === 2 && isRecord(raw.prs)) {
    const final = Object.entries(validPrs(raw.prs)).filter(([, c]) => c.state === "MERGED" || c.state === "CLOSED");
    return { ...emptyStore(), prs: Object.fromEntries(final) };
  }
  if (!isRecord(raw) || raw.version !== OUTCOMES_VERSION || !isRecord(raw.sessions) || !isRecord(raw.prs)) return null;
  if (!isNum(raw.ticks) || typeof raw.coldDone !== "boolean" || !(raw.coldTicks === null || isNum(raw.coldTicks))) return null;
  const sessions = Object.fromEntries(Object.entries(raw.sessions).filter((e): e is [string, StoredSession] => SESSION_ID.test(e[0]) && isStoredSession(e[1])));
  return { version: OUTCOMES_VERSION, ticks: raw.ticks, coldDone: raw.coldDone, coldTicks: raw.coldTicks, sessions, prs: validPrs(raw.prs) };
}

// ── records ─────────────────────────────────────────────────────────────

export interface RecordContext {
  live: boolean;
  nowMs: number;
  /** The transcript's current size and mtime, or null once it was pruned. */
  file: { size: number; mtimeMs: number } | null;
  lastLine: LastLineState | null;
}

/** The full record of one session, with its verdict as of `ctx.nowMs`. */
export function buildRecord(sessionId: string, s: StoredSession, checks: Readonly<Record<string, PrCheck>>, ctx: RecordContext): OutcomeRecord {
  const prs = prsWithState(s.fold, checks);
  const mtimeMs = ctx.file?.mtimeMs ?? s.mtimeMs;
  const todos = todosOf(s.fold);
  // A transcript that grew since it was read has a newer ending (and maybe a newer todo list) than
  // the stored ones: until it is re-read, only the evidence that never goes away (PRs, pushes,
  // artifacts) and the db's own last-line state count.
  const pending = ctx.file !== null && s.readSize !== ctx.file.size;
  const v = classifyOutcome({
    live: ctx.live,
    quietMs: ctx.nowMs - mtimeMs,
    prs,
    pushes: s.fold.pushes,
    artifacts: s.fold.artifacts,
    ending: pending ? null : s.ending,
    lastLine: ctx.lastLine,
    todos: pending ? null : todos,
  });
  return {
    sessionId,
    outcome: v.outcome,
    reason: v.reason,
    evidenceAt: v.evidenceAt,
    lastActive: new Date(mtimeMs).toISOString(),
    toolCalls: s.fold.toolCalls,
    writes: s.fold.writes,
    learnings: [...s.fold.learnings],
    artifacts: s.fold.artifacts.map((a) => a.url),
    prs,
    pushes: s.fold.pushes.map((p) => p.repo),
    todos,
    ending: v.ending,
    onDisk: ctx.file !== null,
    pending,
    provisionalUntil: v.provisionalMs === null ? null : new Date(mtimeMs + v.provisionalMs).toISOString(),
  };
}

/** A live session the scan hasn't read yet: active, with nothing counted. */
export function unreadLiveRecord(sessionId: string, lastActive: string): OutcomeRecord {
  return { sessionId, outcome: "active", reason: null, evidenceAt: null, lastActive, toolCalls: 0, writes: 0, learnings: [], artifacts: [], prs: [], pushes: [], todos: null, ending: null, onDisk: true, pending: true, provisionalUntil: null };
}

export function summaryOf(r: OutcomeRecord): OutcomeSummary {
  // r.prs is already one entry per owner/repo#n (the fold keys its sightings that way).
  const mergedPrs = r.prs.filter((p) => p.state === "MERGED").map((p) => ({ repo: p.repo, number: p.number, mergedAt: p.mergedAt }));
  return {
    sessionId: r.sessionId,
    outcome: r.outcome,
    reason: r.reason,
    evidenceAt: r.evidenceAt,
    lastActive: r.lastActive,
    prs: r.prs.length,
    merged: mergedPrs.length,
    mergedPrs,
    pushes: r.pushes.length,
    artifacts: r.artifacts.length,
    pending: r.pending,
  };
}

/** Session id → outcome, for every record whose outcome isn't unknown (the snapshot extra). */
export function outcomesMapOf(records: Iterable<Pick<OutcomeRecord, "sessionId" | "outcome">>): Record<string, KnownOutcome> {
  const out: Record<string, KnownOutcome> = {};
  for (const r of records) if (r.outcome !== "unknown") out[r.sessionId] = r.outcome;
  return out;
}
