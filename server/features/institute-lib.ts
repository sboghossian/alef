// Pure-ish logic + read-only fs scans behind the Skills panel's "Institute" tab (tab id stays
// "candidates" — see client/src/features/skills.ts). Where skills-inventory.ts answers "what's
// installed" and skills-aggregate.ts answers "what fired", this answers the harder question:
// is the thing that's supposed to be TEACHING the fleet new skills actually working?
//
//   - The upskill autopilot's own log (~/.claude/upskill-state/autopilot.log): how many study
//     forks it has launched, how many crashed or produced nothing, and when it last succeeded
//     — parseAutopilotLog + readLogTail.
//   - Its enabled flag (~/.claude/upskill-state/autopilot.json) — readAutopilotEnabled.
//   - Each skill's own Darwin self-review rounds (~/.claude/skills-repo/<skill>/.darwin-
//     history.jsonl) — scanDarwinHistories.
//   - Skills that have already had a real failure patched into them (reuses
//     memory-layers-lib.ts's scanSkillPatches / countKnownFailureModeEntries, the same scan the
//     Brain view's "procedural workshop" building uses) — scanFailureModes.
//   - Measured change (buildImprovement): SKILL.md revisions per skill in the last 30 days and
//     "failure mode logged → a later SKILL.md commit" pairs, both from `git log` on
//     ~/.claude/skills-repo; and the resident's own skills that a later reflection or proposal
//     names. skills-repo is a SHARED tree: git runs with an explicit --git-dir, only `log`, and
//     GIT_OPTIONAL_LOCKS=0, so it never checks out, resets, commits or refreshes the index.
//
// Every scanner here is best-effort and bounded: a missing file is `null`/"never ran", not a
// silent 0 (server/features/skills.ts turns that into the status line); a missing directory is
// `[]`; a malformed line is skipped, never thrown; every read is capped; every path scanDarwin-
// Histories touches is realpath-checked to stay inside `claudeDir` before it's opened, so a
// skill directory symlinked outside ~/.claude is refused, not followed. Unit-tested in
// server/test/institute-lib.test.ts. View-only: nothing here writes, launches or calls a model.

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AutopilotStats,
  DarwinRoundSummary,
  FailureFixEntry,
  FailureFixPairs,
  FailureModesSnapshot,
  ImprovementSnapshot,
  InstalledSkill,
  InstituteSnapshot,
  ResidentSkillRow,
  ResidentSkillsTrend,
  SkillFailureModeRow,
  SkillRevisionRow,
  SkillRevisions,
  StudyPipelineStatus,
} from "../../shared/features/skills.js";
import { isRecord } from "../http.js";
import { countKnownFailureModeEntries, scanSkillPatches } from "./memory-layers-lib.js";
import { AUDIT_LOG, listInHome, readInHome } from "./resident-sandbox.js";
import { resolveInside } from "./safe-path.js";
import { indexInstalledBySlug } from "./skills-aggregate.js";
import { SKILL_DIR_RE } from "./skills-inventory.js";

// ---------------------------------------------------------------- autopilot.log

export const AUTOPILOT_LOG_TAIL_CAP_BYTES = 512 * 1024;

export interface LogTail {
  text: string;
  /** true when the file was bigger than the cap and `text` is only its last `capBytes`. */
  partial: boolean;
}

/** Reads at most the last `capBytes` of `path`. Null when the file doesn't exist or can't be
 *  read at all (permissions, gone mid-read) — the caller's job to say "never ran"/"no data",
 *  never to treat that the same as a real, empty file. */
export async function readLogTail(path: string, capBytes = AUTOPILOT_LOG_TAIL_CAP_BYTES): Promise<LogTail | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size <= capBytes) {
    try {
      return { text: await readFile(path, "utf8"), partial: false };
    } catch {
      return null;
    }
  }
  try {
    const chunks: Buffer[] = await new Promise((resolvePromise, reject) => {
      const acc: Buffer[] = [];
      const stream = createReadStream(path, { start: size - capBytes });
      stream.on("data", (c) => acc.push(c as Buffer));
      stream.on("end", () => resolvePromise(acc));
      stream.on("error", reject);
    });
    return { text: Buffer.concat(chunks).toString("utf8"), partial: true };
  } catch {
    return null;
  }
}

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/;
const FORK_LAUNCHED_RE = /^fork launched\b/;
const AUTHORED_RE = /^fork: AUTHORED\b/;
const EXIT_RE = /^fork: claude exited rc=(\d+)/;
const NO_DRAFT_RE = /no draft \/ unparseable output/;
const THRESHOLD_SKIP_RE = /^skip: turns=\d+\s*<\s*threshold=\d+/;
const SKIPPED_RE = /^SKIPPED\b/;
const PERMISSION_WORD_RE = /permission/i;

/** "YYYY-MM-DD HH:MM:SS" (the wrapper's own timestamp format, no timezone) -> ISO, or null if
 *  unparseable. Treated as local time, same as the shell that wrote it. */
function toIsoOrNull(dateSpace: string): string | null {
  const d = new Date(dateSpace.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parses ~/.claude/upskill-state/autopilot.log: plain text the shell wrapper (autopilot.sh)
 *  appends to, mostly one "YYYY-MM-DD HH:MM:SS <message>" line per event, but some lines are
 *  raw subprocess stdout/stderr with no timestamp at all (a bare "SKIPPED …" reason, a shell
 *  "Killed: 9"). Line-by-line and best-effort: a line matching none of the known shapes (the
 *  "Killed: 9" case, a stray shell error) contributes to no counter and never throws. */
export function parseAutopilotLog(text: string): AutopilotStats {
  const stats: AutopilotStats = {
    forksLaunched: 0,
    forksFailed: 0,
    forksOk: 0,
    noDraft: 0,
    permissionSkips: 0,
    thresholdSkips: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDraftAt: null,
    lastExitRc: null,
    lastFailureLine: null,
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = TIMESTAMP_RE.exec(line);
    const ts = m?.[1] ? toIsoOrNull(m[1]) : null;
    const rest = m?.[2] ?? line;

    if (FORK_LAUNCHED_RE.test(rest)) {
      stats.forksLaunched += 1;
      if (ts) stats.lastRunAt = ts;
      continue;
    }
    if (AUTHORED_RE.test(rest)) {
      // A draft was actually written. Kept separate from the rc=0 branch below: most rc=0 exits
      // (SKIPPED, "no new draft produced") are clean but author nothing.
      if (ts) stats.lastDraftAt = ts;
      continue;
    }
    const rc = EXIT_RE.exec(rest)?.[1];
    if (rc !== undefined) {
      stats.lastExitRc = Number(rc);
      if (rc === "0") {
        stats.forksOk += 1;
        if (ts) stats.lastSuccessAt = ts;
      } else {
        stats.forksFailed += 1;
        stats.lastFailureLine = line;
      }
      continue;
    }
    if (NO_DRAFT_RE.test(rest)) {
      stats.noDraft += 1;
      stats.lastFailureLine = line;
      continue;
    }
    if (THRESHOLD_SKIP_RE.test(rest)) {
      stats.thresholdSkips += 1;
      continue;
    }
    if (SKIPPED_RE.test(rest) && PERMISSION_WORD_RE.test(rest)) {
      stats.permissionSkips += 1;
      continue;
    }
  }

  return stats;
}

const AUTOPILOT_JSON_CAP_BYTES = 8 * 1024;

/** autopilot.json's "enabled" flag. Null when the file is missing, unreadable or malformed —
 *  never assumed true or false. */
export async function readAutopilotEnabled(path: string): Promise<boolean | null> {
  let raw: string;
  try {
    raw = (await readFile(path, "utf8")).slice(0, AUTOPILOT_JSON_CAP_BYTES);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

/** The tab's headline line, e.g. "No new draft since 2026-05-24 (last clean exit 2026-06-08):
 *  148 of 159 study runs failed (autopilot.log)". `stats` null means autopilot.log itself was
 *  unreadable/missing.
 *
 *  Built from `lastDraftAt`, NOT `lastSuccessAt`: a clean exit (rc=0) does not mean a draft was
 *  written — most of them are SKIPPED or "no new draft produced". The "(last clean exit …)"
 *  aside is dropped when it would just repeat the draft date, and when the pipeline has never
 *  had a clean exit at all this falls back to "none has ever succeeded", same as before. */
export function formatStudyStatusLine(stats: AutopilotStats | null): string {
  if (stats === null) return "autopilot.log not found — the study pipeline has never run (or Alef can't see it)";
  if (stats.forksLaunched === 0) return "No study runs recorded yet (autopilot.log)";
  const failedOfLaunched = `${stats.forksFailed} of ${stats.forksLaunched} study runs failed`;
  const draftSince = stats.lastDraftAt?.slice(0, 10) ?? null;
  const cleanExit = stats.lastSuccessAt?.slice(0, 10) ?? null;
  if (draftSince !== null) {
    const cleanExitAside = cleanExit !== null && cleanExit !== draftSince ? ` (last clean exit ${cleanExit})` : "";
    return `No new draft since ${draftSince}${cleanExitAside}: ${failedOfLaunched} (autopilot.log)`;
  }
  if (cleanExit !== null) return `No draft ever produced (last clean exit ${cleanExit}): ${failedOfLaunched} (autopilot.log)`;
  return `${failedOfLaunched} — none has ever succeeded (autopilot.log)`;
}

// ---------------------------------------------------------------- Darwin study rounds

export const DARWIN_HISTORY_FILE = ".darwin-history.jsonl";
/** Bounds how many skill directories' histories get read in one scan — a fixed, small cost
 *  regardless of how many skills are installed. */
export const DARWIN_MAX_FILES = 200;
const DARWIN_HISTORY_READ_CAP_BYTES = 256 * 1024;
export const DARWIN_SUGGESTION_CAP = 200;

interface DarwinRoundRecord {
  date: string | null;
  suggestion: string | null;
}

/** One JSONL line -> {date, suggestion}, or null when the line is empty or not a JSON object.
 *  The suggestion field's name varies per skill (yalla's is "yalla_delta_suggestion"), so this
 *  takes the first string-valued key whose name contains "suggestion", falling back to the
 *  first string in an "observations" array when there is no such key. */
function parseDarwinLine(line: string): DarwinRoundRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const date = typeof parsed.date === "string" ? parsed.date : null;
  let suggestion: string | null = null;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.length > 0 && /suggestion/i.test(key)) {
      suggestion = value;
      break;
    }
  }
  if (suggestion === null && Array.isArray(parsed.observations)) {
    const first = (parsed.observations as unknown[]).find((o): o is string => typeof o === "string" && o.length > 0);
    suggestion = first ?? null;
  }
  return { date, suggestion };
}

/** One skill's .darwin-history.jsonl -> its round summary. Null when the file is missing,
 *  unreadable, or has no parseable round in it (not a "0 rounds" row worth showing). A
 *  malformed line is skipped; reading continues. */
async function readDarwinHistory(path: string, slug: string): Promise<DarwinRoundSummary | null> {
  let raw: string;
  try {
    raw = (await readFile(path, "utf8")).slice(0, DARWIN_HISTORY_READ_CAP_BYTES);
  } catch {
    return null;
  }
  let rounds = 0;
  let lastDate: string | null = null;
  let lastSuggestion: string | null = null;
  for (const line of raw.split("\n")) {
    const record = parseDarwinLine(line);
    if (record === null) continue;
    rounds += 1;
    if (record.date !== null && (lastDate === null || record.date >= lastDate)) {
      lastDate = record.date;
      if (record.suggestion !== null) lastSuggestion = record.suggestion;
    }
  }
  if (rounds === 0) return null;
  return { slug, rounds, lastDate, lastSuggestion: lastSuggestion !== null ? lastSuggestion.slice(0, DARWIN_SUGGESTION_CAP) : null };
}

/** ~/.claude/skills-repo/<skill>/.darwin-history.jsonl for every skill under `skillsDir` (whose
 *  entries are usually symlinks into skills-repo). Each candidate directory is realpath-checked
 *  to stay inside `claudeDir` before anything under it is read — an entry whose symlink escapes
 *  ~/.claude is refused, not followed. Reads at most DARWIN_MAX_FILES skills (sorted by slug
 *  first, so which ones get read is deterministic), sorted by rounds desc in the result. */
export async function scanDarwinHistories(skillsDir: string, claudeDir: string): Promise<DarwinRoundSummary[]> {
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch {
    return [];
  }
  const slugs = names.filter((n) => SKILL_DIR_RE.test(n)).sort((a, b) => a.localeCompare(b));

  const out: DarwinRoundSummary[] = [];
  for (const slug of slugs.slice(0, DARWIN_MAX_FILES)) {
    const resolved = await resolveInside(claudeDir, join(skillsDir, slug), { allowAbsolute: true });
    if (!resolved.ok) continue; // outside ~/.claude, a secret-looking name, or gone
    const summary = await readDarwinHistory(join(resolved.abs, DARWIN_HISTORY_FILE), slug);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => b.rounds - a.rounds || a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------- failure modes

const SKILL_MD_READ_CAP_BYTES = 256 * 1024;

/** Skills whose SKILL.md carries a non-empty "## Known failure modes (auto-logged)" section
 *  (the section ~/.claude/hooks/learning-loop.py appends to after a real correction). Reuses
 *  memory-layers-lib.ts's scanSkillPatches for the aggregate totals and its
 *  countKnownFailureModeEntries for the per-skill breakdown the Institute tab lists, so the
 *  two numbers can never disagree with the Brain view's "procedural workshop" building. */
export async function scanFailureModes(installed: readonly InstalledSkill[]): Promise<FailureModesSnapshot> {
  const skills = [...indexInstalledBySlug(installed).values()];
  const [aggregate, rows] = await Promise.all([
    scanSkillPatches(skills.map((s) => s.path)),
    Promise.all(
      skills.map(async (skill): Promise<SkillFailureModeRow | null> => {
        let content: string;
        try {
          content = (await readFile(skill.path, "utf8")).slice(0, SKILL_MD_READ_CAP_BYTES);
        } catch {
          return null;
        }
        const entryCount = countKnownFailureModeEntries(content);
        return entryCount > 0 ? { slug: skill.slug, name: skill.name, entryCount } : null;
      }),
    ),
  ]);
  const flagged = rows.filter((r): r is SkillFailureModeRow => r !== null).sort((a, b) => b.entryCount - a.entryCount || a.slug.localeCompare(b.slug));
  return { skills: flagged, patchedSkillCount: aggregate.patchedSkillCount, patchEntryCount: aggregate.patchEntryCount };
}

// ---------------------------------------------------------------- measured change: git

/** Runs one read-only git command against one repo; resolves stdout, rejects on any failure. */
export type GitRunner = (args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** `git --git-dir=<repo>/.git log …` and nothing else: any other subcommand is refused before git
 *  runs. The explicit git dir means git never walks up into another repo, and no work tree is
 *  involved, so nothing here can touch the checkout (skills-repo is shared by every session). */
export function gitRunnerFor(repoDir: string): GitRunner {
  const gitDir = join(repoDir, ".git");
  return async (args) => {
    if (args[0] !== "log") throw new Error(`read-only: refused git ${args[0] ?? ""}`.trim());
    const { stdout } = await execFileAsync("git", ["--git-dir", gitDir, "-c", "color.ui=false", "-c", "log.showSignature=false", "-c", "core.quotepath=true", "-c", "core.fsmonitor=false", "-c", "diff.suppressBlankEmpty=false", ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: GIT_ENV,
    });
    return stdout;
  };
}

export const REVISION_DAYS = 30;
export const REVISION_ROWS_CAP = 25;
/** Skills whose failure-mode history gets read, and commits read per skill (newest first). */
export const PAIR_SKILLS_CAP = 12;
export const PAIR_COMMITS_CAP = 40;
export const PAIR_ENTRIES_CAP = 20;
const ENTRY_TEXT_CAP = 200;
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const COMMIT_FORMAT = "--format=%x1e%H%x1f%cI";
/** A top-level skill's SKILL.md in skills-repo: "<slug>/SKILL.md". */
const SKILL_PATH_RE = /^([^/]+)\/SKILL\.md$/;

export interface LoggedCommit {
  sha: string;
  at: string;
  files: string[];
}

/** `git log --format=%x1e%H%x1f%cI --name-only` output → commits, newest first as git printed them.
 *  A record without a sha or a parseable date is skipped. */
export function parseNameOnlyLog(out: string): LoggedCommit[] {
  const commits: LoggedCommit[] = [];
  for (const rec of out.split(RECORD_SEP)) {
    const [head, ...rest] = rec.split("\n");
    const [sha, at] = (head ?? "").split(FIELD_SEP);
    if (!sha || !at || !/^[0-9a-f]{7,64}$/.test(sha) || !Number.isFinite(Date.parse(at))) continue;
    commits.push({ sha, at: new Date(Date.parse(at)).toISOString(), files: rest.map((l) => l.trim()).filter((l) => l.length > 0) });
  }
  return commits;
}

/** The skill a changed path belongs to, or null for anything but a top-level <slug>/SKILL.md. */
export function skillOfPath(path: string): string | null {
  const slug = SKILL_PATH_RE.exec(path)?.[1];
  return slug && SKILL_DIR_RE.test(slug) ? slug : null;
}

/** Per-skill SKILL.md revision counts from a name-only log already limited to the window. */
export function revisionRows(commits: readonly LoggedCommit[]): { commits: number; skills: SkillRevisionRow[] } {
  const bySlug = new Map<string, SkillRevisionRow>();
  let touching = 0;
  for (const c of commits) {
    const slugs = new Set(c.files.map(skillOfPath).filter((s): s is string => s !== null));
    if (slugs.size > 0) touching += 1;
    for (const slug of slugs) {
      const row = bySlug.get(slug);
      if (!row) bySlug.set(slug, { slug, commits: 1, lastAt: c.at });
      else {
        row.commits += 1;
        if (c.at > row.lastAt) row.lastAt = c.at;
      }
    }
  }
  const skills = [...bySlug.values()].sort((a, b) => b.commits - a.commits || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || a.slug.localeCompare(b.slug));
  return { commits: touching, skills };
}

function gitError(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim().split("\n")[0] : "";
  const msg = stderr || (typeof e.message === "string" ? e.message.split("\n")[0] : String(err));
  return (msg ?? "git failed").slice(0, 200);
}

/** SKILL.md commits per skill in the last `days` (committer time), from skills-repo's git log. */
export async function scanSkillRevisions(git: GitRunner, nowMs: number, days = REVISION_DAYS): Promise<SkillRevisions> {
  const since = new Date(nowMs - days * 86_400_000).toISOString();
  const empty: SkillRevisions = { ok: false, error: null, days, since, commits: 0, skillCount: 0, skills: [] };
  let out: string;
  try {
    out = await git(["log", `--since=${since}`, COMMIT_FORMAT, "--name-only", "--no-renames", "--", "*/SKILL.md"]);
  } catch (err) {
    return { ...empty, error: gitError(err) };
  }
  const { commits, skills } = revisionRows(parseNameOnlyLog(out));
  return { ok: true, error: null, days, since, commits, skillCount: skills.length, skills: skills.slice(0, REVISION_ROWS_CAP) };
}

// ---------------------------------------------------------------- measured change: failure → fix

const FAILURE_SECTION_RE = /^##\s*Known failure modes.*$/im; // the same heading countKnownFailureModeEntries reads
const NEXT_SECTION_RE = /^##\s/m;
const ENTRY_RE = /^\s*-\s+/;

/** A SKILL.md split into its "## Known failure modes" entries (bullets, whitespace collapsed) and
 *  everything else (the body). Same section rules as countKnownFailureModeEntries. */
export function splitFailureModes(md: string): { entries: string[]; body: string } {
  const text = md.replace(/\r\n/g, "\n");
  const m = FAILURE_SECTION_RE.exec(text);
  const norm = (s: string): string => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  if (!m) return { entries: [], body: norm(text) };
  const after = text.slice(m.index + m[0].length);
  const next = NEXT_SECTION_RE.exec(after);
  const section = next ? after.slice(0, next.index) : after;
  const entries = section
    .split("\n")
    .filter((l) => ENTRY_RE.test(l))
    .map((l) => l.replace(ENTRY_RE, "").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  return { entries, body: norm(text.slice(0, m.index) + (next ? after.slice(next.index) : "")) };
}

export interface FileVersion {
  sha: string;
  at: string;
  /** The file after this commit; null when the commit deleted it. */
  content: string | null;
}

/**
 * `git log -p -U<huge> --format=%x1e%H%x1f%cI -- <one file>` → the file after each commit, in the
 * order git printed them. With the context that wide each diff is one hunk holding the whole file,
 * so the post-image is every " " and "+" line after the "@@". A commit with no hunk (a merge, a
 * mode change) is skipped: the file didn't change. A second hunk means the context wasn't wide
 * enough to see the whole file, so that version is skipped too (counted in `unreadable`).
 */
export function parseFileVersions(out: string): { versions: FileVersion[]; unreadable: number } {
  const versions: FileVersion[] = [];
  let unreadable = 0;
  for (const rec of out.split(RECORD_SEP)) {
    const lines = rec.split("\n");
    const [sha, at] = (lines[0] ?? "").split(FIELD_SEP);
    if (!sha || !at || !/^[0-9a-f]{7,64}$/.test(sha) || !Number.isFinite(Date.parse(at))) continue;
    let deleted = false;
    let hunks = 0;
    const post: string[] = [];
    for (const line of lines.slice(1)) {
      if (hunks === 0) {
        if (line.startsWith("deleted file mode")) deleted = true;
        if (line.startsWith("@@")) hunks = 1;
        continue;
      }
      if (line.startsWith("@@")) {
        hunks += 1;
        break;
      }
      if (line.startsWith(" ") || line.startsWith("+")) post.push(line.slice(1));
    }
    if (hunks === 0) continue;
    if (hunks > 1) {
      unreadable += 1;
      continue;
    }
    // The record ends with the blank line git prints between commits; the file's own last line
    // doesn't carry a newline marker we need (body comparison ignores trailing newlines).
    versions.push({ sha, at: new Date(Date.parse(at)).toISOString(), content: deleted ? null : post.join("\n") });
  }
  return { versions, unreadable };
}

/** One skill's pairs from its versions, oldest first: each entry is logged by the first version
 *  listing it, and followed by the first LATER version whose body (the file minus the section)
 *  differs from the version before it. */
export function pairsFromVersions(slug: string, versions: readonly FileVersion[]): { entries: FailureFixEntry[]; committed: Set<string> } {
  const logged = new Map<string, { at: string; idx: number }>();
  const revisions: { at: string; idx: number }[] = [];
  let prevBody: string | null = null;
  let latestEntries = new Set<string>();
  versions.forEach((v, idx) => {
    if (v.content === null) {
      prevBody = null;
      latestEntries = new Set();
      return;
    }
    const { entries, body } = splitFailureModes(v.content);
    for (const e of entries) if (!logged.has(e)) logged.set(e, { at: v.at, idx });
    if (prevBody !== null && body !== prevBody) revisions.push({ at: v.at, idx });
    prevBody = body;
    latestEntries = new Set(entries);
  });
  const entries: FailureFixEntry[] = [...logged].map(([text, l]) => ({
    slug,
    text: text.slice(0, ENTRY_TEXT_CAP),
    loggedAt: l.at,
    followedAt: revisions.find((r) => r.idx > l.idx)?.at ?? null,
    stillListed: latestEntries.has(text),
  }));
  return { entries, committed: new Set(logged.keys()) };
}

/** Where a failure-flagged installed skill lives: its skills-repo slug, or null when its SKILL.md
 *  (already realpath-resolved by the inventory) isn't a top-level skill of skills-repo. */
export function repoSlugOf(skillMdPath: string, realRepoDir: string): string | null {
  const rel = relative(realRepoDir, skillMdPath);
  if (rel.startsWith("..") || rel.startsWith(sep)) return null;
  return skillOfPath(rel.split(sep).join("/"));
}

export interface PairScanInput {
  git: GitRunner;
  /** skills-repo's realpath (null when it can't be resolved: every entry is then outside it). */
  realRepoDir: string | null;
  installed: readonly InstalledSkill[];
  flagged: readonly SkillFailureModeRow[];
}

/** "Failure mode logged → a later SKILL.md commit" pairs across skills-repo's whole history. */
export async function scanFailureFixPairs(input: PairScanInput): Promise<FailureFixPairs> {
  const base: FailureFixPairs = { ok: false, error: null, historySince: null, entries: [], logged: 0, followed: 0, uncommitted: 0, outsideRepo: 0, truncated: false };
  // Entries on disk now, split into skills-repo skills (read below) and everything else.
  const bySlug = indexInstalledBySlug(input.installed);
  const onDisk = new Map<string, string[]>();
  for (const row of input.flagged) {
    const skill = bySlug.get(row.slug);
    const repoSlug = skill && input.realRepoDir ? repoSlugOf(skill.path, input.realRepoDir) : null;
    if (!skill || repoSlug === null) {
      base.outsideRepo += row.entryCount;
      continue;
    }
    let content = "";
    try {
      content = (await readFile(skill.path, "utf8")).slice(0, SKILL_MD_READ_CAP_BYTES);
    } catch {
      continue;
    }
    onDisk.set(repoSlug, splitFailureModes(content).entries);
  }
  if (input.realRepoDir === null) return { ...base, error: "skills-repo not found" };
  let flaggedInHistory: string[];
  try {
    const [first, touched] = await Promise.all([
      input.git(["log", "--max-parents=0", "--format=%cI", "HEAD"]),
      input.git(["log", "-SKnown failure modes", COMMIT_FORMAT, "--name-only", "--no-renames", "--", "*/SKILL.md"]),
    ]);
    const firsts = first.split("\n").map((l) => Date.parse(l.trim())).filter(Number.isFinite);
    base.historySince = firsts.length ? new Date(Math.min(...firsts)).toISOString() : null;
    flaggedInHistory = parseNameOnlyLog(touched).flatMap((c) => c.files.map(skillOfPath).filter((s): s is string => s !== null));
  } catch (err) {
    return { ...base, error: gitError(err) };
  }
  const slugs = [...new Set([...flaggedInHistory, ...onDisk.keys()])].sort((a, b) => a.localeCompare(b));
  if (slugs.length > PAIR_SKILLS_CAP) base.truncated = true;
  const all: FailureFixEntry[] = [];
  for (const slug of slugs.slice(0, PAIR_SKILLS_CAP)) {
    let versions: FileVersion[];
    try {
      const out = await input.git(["log", "-n", String(PAIR_COMMITS_CAP + 1), "--reverse", COMMIT_FORMAT, "-p", "-U1000000", "--no-ext-diff", "--no-textconv", "--no-renames", "--", `${slug}/SKILL.md`]);
      const parsed = parseFileVersions(out);
      versions = parsed.versions;
      if (parsed.unreadable > 0 || versions.length > PAIR_COMMITS_CAP) base.truncated = true;
    } catch (err) {
      return { ...base, error: gitError(err) };
    }
    const { entries, committed } = pairsFromVersions(slug, versions);
    all.push(...entries);
    base.uncommitted += (onDisk.get(slug) ?? []).filter((e) => !committed.has(e)).length;
  }
  all.sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : a.slug.localeCompare(b.slug)));
  return { ...base, ok: true, entries: all.slice(0, PAIR_ENTRIES_CAP), logged: all.length, followed: all.filter((e) => e.followedAt !== null).length };
}

// ---------------------------------------------------------------- measured change: the resident

const RESIDENT_JOURNAL_DAYS_CAP = 60;
const RESIDENT_JOURNAL_READ_CAP = 64 * 1024;
const RESIDENT_AUDIT_READ_CAP = 4 * 1024 * 1024;
const RESIDENT_SKILL_READ_CAP = 16 * 1024;
const REFLECTION_HEAD_RE = /^## (\d{2}):(\d{2}) · reflection\s*$/;
/** Lines the server appends to a journal between reflections (tripwires, fleet events): not the
 *  resident's own words, so never a citation. */
const EVENT_LINE_RE = /^- \d{2}:\d{2} · /;

/** First write time of each skills/<slug>.md in the audit log, and the log's first line's time. */
export function skillWritesFromAudit(text: string): { writes: Map<string, string>; since: string | null } {
  const writes = new Map<string, string>();
  let since: string | null = null;
  for (const line of text.split("\n")) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec) || typeof rec.at !== "string" || !Number.isFinite(Date.parse(rec.at))) continue;
    since ??= rec.at;
    const slug = typeof rec.path === "string" ? /^skills\/([a-z0-9][a-z0-9-]{0,47})\.md$/.exec(rec.path)?.[1] : undefined;
    if (!slug) continue;
    const prev = writes.get(slug);
    if (prev === undefined || Date.parse(rec.at) < Date.parse(prev)) writes.set(slug, rec.at);
  }
  return { writes, since };
}

/** The resident's own reflections in one journal day file (local time, as resident-lib writes
 *  them), each with its text minus the server's event lines. */
export function reflectionSections(day: string, text: string): { atMs: number; text: string }[] {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!d) return [];
  const out: { atMs: number; text: string[] }[] = [];
  let cur: { atMs: number; text: string[] } | null = null;
  for (const line of text.split("\n")) {
    const head = REFLECTION_HEAD_RE.exec(line);
    if (head) {
      cur = { atMs: new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(head[1]), Number(head[2])).getTime(), text: [] };
      out.push(cur);
      continue;
    }
    if (line.startsWith("## ") || line.startsWith("# ")) {
      cur = null;
      continue;
    }
    if (cur && !EVENT_LINE_RE.test(line)) cur.text.push(line);
  }
  return out.map((s) => ({ atMs: s.atMs, text: s.text.join("\n") }));
}

/** Does `text` name the skill: its slug as a whole word, or its full name (≥ 4 characters)? A text
 *  match, so a very generic name can match by accident. */
export function namesSkill(text: string, slug: string, name: string): boolean {
  const t = text.toLowerCase();
  const s = slug.toLowerCase();
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (s.length >= 4 && new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`).test(t)) return true;
  const n = name.trim().toLowerCase();
  return n.length >= 4 && t.includes(n);
}

/** The resident's skills (skills/<slug>.md in its home) and whether a LATER reflection or
 *  proposal names each one. Plain reads through the sandbox's own read helpers. */
export async function scanResidentSkills(home: string): Promise<ResidentSkillsTrend> {
  const base: ResidentSkillsTrend = { ok: false, error: null, written: 0, cited: 0, skills: [], journalDays: 0, journalSince: null, auditSince: null };
  try {
    if (!(await stat(home)).isDirectory()) return { ...base, error: "the resident's home is not a directory" };
  } catch {
    return { ...base, error: "no resident home" };
  }
  try {
    const [skillFiles, journalFiles, audit, proposalsRaw] = await Promise.all([
      listInHome(home, "skills"),
      listInHome(home, "journal"),
      readInHome(home, AUDIT_LOG, RESIDENT_AUDIT_READ_CAP),
      readInHome(home, "proposals.json"),
    ]);
    const { writes, since } = skillWritesFromAudit(audit ?? "");
    const days = journalFiles.map((f) => f.replace(/\.md$/, "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-RESIDENT_JOURNAL_DAYS_CAP);
    const sections: { atMs: number; text: string; where: "reflection" | "proposal" }[] = [];
    for (const day of days) {
      const text = (await readInHome(home, `journal/${day}.md`, RESIDENT_JOURNAL_READ_CAP)) ?? "";
      for (const s of reflectionSections(day, text)) sections.push({ ...s, where: "reflection" });
    }
    let proposals: unknown = [];
    try {
      proposals = JSON.parse(proposalsRaw ?? "[]");
    } catch {
      /* unreadable proposals: no citations from them */
    }
    if (Array.isArray(proposals)) {
      for (const p of proposals) {
        if (!isRecord(p) || typeof p.at !== "string" || !Number.isFinite(Date.parse(p.at))) continue;
        sections.push({ atMs: Date.parse(p.at), text: `${typeof p.title === "string" ? p.title : ""}\n${typeof p.why === "string" ? p.why : ""}`, where: "proposal" });
      }
    }
    sections.sort((a, b) => a.atMs - b.atMs);
    const skills: ResidentSkillRow[] = [];
    for (const file of skillFiles) {
      const slug = file.replace(/\.md$/, "");
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) continue; // not a file the sandbox could have written
      const body = (await readInHome(home, `skills/${slug}.md`, RESIDENT_SKILL_READ_CAP)) ?? "";
      const name = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slug;
      const writtenAt = writes.get(slug) ?? null;
      const cite = writtenAt === null ? undefined : sections.find((s) => s.atMs > Date.parse(writtenAt) && namesSkill(s.text, slug, name));
      skills.push({ slug, name: name.slice(0, 80), writtenAt, citedAt: cite ? new Date(cite.atMs).toISOString() : null, citedIn: cite?.where ?? null });
    }
    return { ok: true, error: null, written: skills.length, cited: skills.filter((s) => s.citedAt !== null).length, skills, journalDays: days.length, journalSince: days[0] ?? null, auditSince: since };
  } catch (err) {
    return { ...base, error: String((err as Error).message ?? err).slice(0, 200) };
  }
}

export interface ImprovementDeps {
  git: GitRunner;
  skillsRepoDir: string;
  residentHome: string;
  installed: readonly InstalledSkill[];
  flagged: readonly SkillFailureModeRow[];
  nowMs: number;
}

/** The three measured-change scans (independent, none throws). */
export async function buildImprovement(deps: ImprovementDeps): Promise<ImprovementSnapshot> {
  const realRepoDir = await realpath(deps.skillsRepoDir).catch(() => null);
  const [revisions, pairs, resident] = await Promise.all([
    scanSkillRevisions(deps.git, deps.nowMs),
    scanFailureFixPairs({ git: deps.git, realRepoDir, installed: deps.installed, flagged: deps.flagged }),
    scanResidentSkills(deps.residentHome),
  ]);
  return { revisions, pairs, resident };
}

// ---------------------------------------------------------------- orchestration

export interface InstituteDeps {
  autopilotLogPath: string;
  autopilotJsonPath: string;
  skillsDir: string;
  /** ~/.claude — the containment root scanDarwinHistories refuses to let a symlink escape. */
  claudeDir: string;
  installed: readonly InstalledSkill[];
  /** ~/.claude/skills-repo: read with `git log` only (buildImprovement). */
  skillsRepoDir: string;
  /** ~/.alef-resident: read only. */
  residentHome: string;
  nowMs: number;
  /** Defaults to gitRunnerFor(skillsRepoDir). */
  git?: GitRunner;
}

/** Assembles the whole Institute tab's data in one call — the four independent scans run in
 *  parallel, then the measured-change scans (which reuse the failure-mode rows); none of them can
 *  throw (see each function's own contract). */
export async function buildInstituteSnapshot(deps: InstituteDeps): Promise<InstituteSnapshot> {
  const [tail, enabled, darwin, failureModes] = await Promise.all([
    readLogTail(deps.autopilotLogPath),
    readAutopilotEnabled(deps.autopilotJsonPath),
    scanDarwinHistories(deps.skillsDir, deps.claudeDir),
    scanFailureModes(deps.installed),
  ]);
  const stats = tail ? parseAutopilotLog(tail.text) : null;
  const study: StudyPipelineStatus = {
    line: formatStudyStatusLine(stats),
    enabled,
    stats,
    logPartial: tail?.partial ?? false,
  };
  const improvement = await buildImprovement({
    git: deps.git ?? gitRunnerFor(deps.skillsRepoDir),
    skillsRepoDir: deps.skillsRepoDir,
    residentHome: deps.residentHome,
    installed: deps.installed,
    flagged: failureModes.skills,
    nowMs: deps.nowMs,
  });
  return { study, darwin, failureModes, improvement };
}
