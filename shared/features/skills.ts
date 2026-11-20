// Wire types for the "skills" feature (Round 8 H3): makes the skill system visible.
//
//   GET  /api/skills/snapshot         -> SkillsSnapshotResult (Top used / Graveyard / Candidates)
//   GET  /api/skills/session/:agentId -> SkillsSessionResult (this session's detected events)
//   POST /api/skills/open-editor      -> { path } -> SkillsOpenEditorResult (candidates are VIEW ONLY;
//                                          "Open in editor" is the one allowed action)
//
// Detection sources (server/features/skills-detect.ts), each untrusted transcript text:
//   - "invoke"    a `Skill` tool_use (input.skill) -> the CLI actually ran that skill.
//   - "slash"     a user line's `<command-name>/<name></command-name>` tag -> the user typed /<name>.
//   - "suggested" the skill-router hook's UserPromptSubmit "## Skill Router" stdout -> a slug it
//                 surfaced, not necessarily acted on.
//
// Skill names and descriptions come from SKILL.md frontmatter and session transcripts —
// both untrusted. Render them escaped (textContent, never innerHTML).

export type SkillEventKind = "invoke" | "slash" | "suggested";

export interface SkillEvent {
  sessionId: string;
  /** As detected: a bare slug ("grill-me") or a plugin-namespaced one ("grok:grok-delegation"). */
  skillName: string;
  kind: SkillEventKind;
  at: string; // ISO
}

export type SkillOrigin = "user" | "plugin" | "project";

export interface InstalledSkill {
  /** Matches SkillEvent.skillName for the same skill: dir name for user/project skills,
   *  "<plugin>:<skill>" for plugin skills. */
  slug: string;
  name: string; // frontmatter name (falls back to slug)
  description: string; // frontmatter description, "" when missing
  origin: SkillOrigin;
  pluginId: string | null; // plugin's declared name, when origin === "plugin"
  path: string; // resolved (symlink-followed) absolute path to SKILL.md
  /** SKILL.md mtime, ISO. A proxy for "age" — NOT a true install date (nothing records that). */
  updatedAt: string | null;
}

export interface SkillUsageRow {
  slug: string;
  installed: InstalledSkill | null; // null when fired but not found in the current inventory scan
  fired30d: number;
  fired90d: number;
  firedTotal: number;
  suggestedTotal: number;
  lastFiredAt: string | null; // ISO
}

export interface SkillCandidate {
  slug: string; // the staged directory name under the review queue
  name: string; // frontmatter name (falls back to slug)
  description: string;
  queuedAt: string | null; // .autoskiller-meta.json "drafted_at", else SKILL.md mtime
  evidenceCount: number | null; // .autoskiller-meta.json / frontmatter "frequency", when present
  confidence: number | null; // .autoskiller-meta.json / frontmatter "confidence", when present
  path: string; // absolute path to the candidate's SKILL.md (for "Open in editor")
}

/** One-time historical catch-up state (server/features/skills-backfill.ts). While
 *  `!done`, `graveyard` may undercount how long a skill has really been quiet — the
 *  Graveyard tab should show "still reading history (N%)" instead of the list until
 *  `done` is true. `topUsed` and per-session events are unaffected once fired at all,
 *  since every firing found is real; only the ABSENCE of firings is unreliable pre-backfill. */
export interface SkillsBackfillProgress {
  filesTotal: number;
  filesDone: number;
  percent: number; // 0-100
  done: boolean;
}

// ---------------------------------------------------------------- institute
// The "Institute" tab (tab id stays "candidates" so old deep links keep working — see
// client/src/features/skills.ts): the upskill autopilot's real state, not just its output.
// Every piece here is read-only and best-effort (server/features/institute-lib.ts); a missing
// source file reads as `null`/"never ran", never a silent 0.

export interface AutopilotStats {
  forksLaunched: number;
  forksFailed: number;
  forksOk: number;
  noDraft: number;
  permissionSkips: number;
  thresholdSkips: number;
  lastRunAt: string | null; // ISO — the last "fork launched" line
  lastSuccessAt: string | null; // ISO — the last "fork: claude exited rc=0" line
  /** ISO — the last "fork: AUTHORED <slug>" line: when a draft was actually WRITTEN. Distinct
   *  from lastSuccessAt on purpose — a clean exit (rc=0) that produced no draft (SKIPPED, "no
   *  new draft produced") still sets lastSuccessAt but must not set this. Null when no run has
   *  ever authored one. */
  lastDraftAt: string | null;
  /** The rc of the most recent "fork: claude exited rc=N" line, whatever its value — the
   *  OUTCOME of the last completed run, for telling "the pipeline is failing" apart from "the
   *  pipeline is healthy but has nothing new to propose". Null when no run has exited yet.
   *  Do not compare lastRunAt to lastSuccessAt for this: they are two different log lines from
   *  the SAME run (launch time vs. exit time) and are almost never equal, even when that run
   *  succeeded. */
  lastExitRc: number | null;
  lastFailureLine: string | null; // the most recent failure/no-draft line, verbatim (untrusted text)
}

export interface StudyPipelineStatus {
  /** e.g. "No new draft since 2026-06-08: 148 of 159 study runs failed (autopilot.log)". */
  line: string;
  /** autopilot.json's "enabled" flag; null when that file is missing, unreadable or malformed. */
  enabled: boolean | null;
  /** null when autopilot.log itself doesn't exist ("never ran", not zeroed-out stats). */
  stats: AutopilotStats | null;
  /** true when autopilot.log is larger than the read cap — stats come from its tail only. */
  logPartial: boolean;
}

export interface DarwinRoundSummary {
  slug: string;
  rounds: number;
  lastDate: string | null; // the round record's own "date" field, not a file mtime
  lastSuggestion: string | null; // capped to 200 chars; untrusted, render with textContent only
}

export interface SkillFailureModeRow {
  slug: string;
  name: string;
  entryCount: number;
}

export interface FailureModesSnapshot {
  skills: SkillFailureModeRow[];
  patchedSkillCount: number;
  patchEntryCount: number;
}

// ---------------------------------------------------------------- improvement (measured change)
// Do skills keep getting better? Only what git and the resident's own files say, each count with
// its window (server/features/institute-lib.ts). Everything is read-only: `git log` on
// ~/.claude/skills-repo (a shared tree, never checked out, reset or committed), plain reads of the
// resident's home.

export interface SkillRevisionRow {
  slug: string;
  /** Commits that touched <slug>/SKILL.md in the window. A sync commit can carry several edits. */
  commits: number;
  lastAt: string; // ISO commit time of the newest one
}

export interface SkillRevisions {
  /** False when skills-repo couldn't be read with git; `error` says why and the counts are 0. */
  ok: boolean;
  error: string | null;
  days: number;
  since: string; // ISO: the window's start (scan time − days)
  /** Distinct commits that touched any <skill>/SKILL.md in the window. */
  commits: number;
  /** Skills whose SKILL.md changed in the window. */
  skillCount: number;
  /** Busiest first, capped (skillCount has the full number). */
  skills: SkillRevisionRow[];
}

export interface FailureFixEntry {
  slug: string;
  /** The entry's text, capped. Untrusted (a hook wrote it): textContent only. */
  text: string;
  /** Time of the first commit whose SKILL.md lists it. */
  loggedAt: string;
  /** Time of the first LATER commit that changed that SKILL.md outside the failure-modes section,
   *  or null. A later revision, not proof it fixed this failure. */
  followedAt: string | null;
  /** Still in the section in the newest commit read. */
  stillListed: boolean;
}

export interface FailureFixPairs {
  ok: boolean;
  error: string | null;
  /** skills-repo's first commit: the window every pair is found in. Null when unknown. */
  historySince: string | null;
  /** Entries logged in a commit (newest first, capped; `logged` has the full count). */
  entries: FailureFixEntry[];
  logged: number;
  /** Of those, followed by a later SKILL.md revision. */
  followed: number;
  /** Entries in a skills-repo SKILL.md on disk that no commit carries yet. */
  uncommitted: number;
  /** Entries in installed skills whose SKILL.md lives outside skills-repo (their history isn't read). */
  outsideRepo: number;
  /** True when a skill or commit cap cut the scan short. */
  truncated: boolean;
}

export interface ResidentSkillRow {
  slug: string;
  name: string;
  /** First write of skills/<slug>.md in its audit log (writes.jsonl); null when the log has none. */
  writtenAt: string | null;
  /** First later reflection or proposal that names it, or null. */
  citedAt: string | null;
  citedIn: "reflection" | "proposal" | null;
}

export interface ResidentSkillsTrend {
  /** False when the resident's home can't be read; `error` says why. */
  ok: boolean;
  error: string | null;
  written: number;
  cited: number;
  skills: ResidentSkillRow[];
  /** Journal days read for citations, and the first of them (the window). */
  journalDays: number;
  journalSince: string | null;
  /** Its audit log's first line: how far back "written" can see. */
  auditSince: string | null;
}

export interface ImprovementSnapshot {
  revisions: SkillRevisions;
  pairs: FailureFixPairs;
  resident: ResidentSkillsTrend;
}

export interface InstituteSnapshot {
  study: StudyPipelineStatus;
  darwin: DarwinRoundSummary[];
  failureModes: FailureModesSnapshot;
  improvement: ImprovementSnapshot;
}

export interface SkillsSnapshot {
  /** Fired at least once, sorted by fired90d desc, then firedTotal desc, then lastFiredAt desc. */
  topUsed: SkillUsageRow[];
  /** Installed, zero firings in the last 90 days, sorted oldest-first by `installed.updatedAt`.
   *  Best-effort even while backfill is running — see `backfillProgress`. */
  graveyard: SkillUsageRow[];
  candidates: SkillCandidate[];
  installedCount: number;
  scannedAt: string; // ISO — when the inventory scan behind this snapshot last ran
  backfillProgress: SkillsBackfillProgress;
  institute: InstituteSnapshot;
  /** ISO `at` of the oldest recorded skill_event (SkillsStore.firstEventAt()), or null when the
   *  store has none yet. The Graveyard's true "0 fires" window can't be longer than this. */
  historyStartAt: string | null;
}

export interface SkillsSnapshotResult extends SkillsSnapshot {
  ok: true;
}

export interface SkillsSessionResult {
  ok: true;
  agentId: string;
  events: SkillEvent[]; // oldest first
}

export interface SkillsOpenEditorRequest {
  path: string;
}

export type SkillsOpenEditorResult = { ok: true } | { ok: false; error: string };

export interface SkillsError {
  ok: false;
  error: string;
}

/** snapshot extras key "skills.recent": the last N events across every session, newest first —
 *  lets the agent panel show "Skills used" without a round trip for sessions already in view. */
export const SKILLS_RECENT_KEY = "skills.recent";
export const SKILLS_RECENT_LIMIT = 200;
export type SkillsRecentExtras = SkillEvent[];

/** WS payload: new events landed (from the latest onIndexPass). */
export interface SkillsMessage {
  kind: "events";
  events: SkillEvent[];
}
