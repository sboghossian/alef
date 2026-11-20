// The "autonomy" axis (round: Landscape-of-Consciousness inspired): where a session sits on a
// line from "Alex drove it live" to "nothing human touched it directly". Pure, deterministic,
// no I/O, no model calls — same contract as shared/display.ts, which this reuses for automation
// detection. Used by client/src/features/canvas's Autonomy layout mode, and by the president's
// commencement "schedule" proposals (server/features/president-lib.ts: runs started by hand).
//
// What signals actually exist, and what doesn't (read this before trusting a number this module
// produces):
//   - The raw jsonl carries `entrypoint` ("claude-vscode" | "sdk-cli" | …) and `userType`, and the
//     sessions table (server/db.ts SessionRow) additionally tracks cntAssistantTotal alongside
//     messageCount — from which a real "human-only turn count" (messageCount − cntAssistantTotal)
//     could be derived. NONE of that reaches the client: `WorldAgent` (shared/types.ts) exposes
//     only `title`, `messageCount` (user+assistant lines combined) and `cwd`. This module is a
//     client-side, title/count-only classifier — it cannot see entrypoint, userType or a pure
//     human-turn count, because the wire type never carried them. That is the single biggest
//     source of misclassification below (documented per-level), not a bug in the rules themselves.
//   - Two signals ARE real and precise, because they are already used elsewhere in this exact
//     shape: `automationKey` (shared/display.ts) recognizes every one of Alex's named
//     automations (scheduled tasks, /skill steps, the eval harness, the inbox/session-groups
//     machinery, fleet probes) straight from the title text, and a resident session would run
//     from a cwd under ~/.alef-resident.
//   - A subagent (client/src/features/canvas/graph.ts's "subagent" CNode) is never given to this
//     classifier: it is unconditionally level 4 by construction (SUBAGENT_AUTONOMY_LEVEL below) —
//     spawned by the Agent tool, it has no human turn of its own to inspect.
//   - automationKey's COMMAND_NAME/STRIPPED_COMMAND shape ("/skill" or "skill /skill") is written
//     by the CLI for ANY invocation of a slash skill, interactive or headless alike — on its own it
//     is not proof of a *scheduled* automation, so this module requires a second signal (a
//     headless-run marker, or an explicit allowlist entry) before trusting it. See
//     isSlashCommandShaped's doc comment (shared/display.ts) and KNOWN_HEADLESS_COMMAND_SKILLS below.

import { automationKey, isSlashCommandShaped } from "./display";
import type { WorldAgent } from "./types";

export type AutonomyLevel = 1 | 2 | 3 | 4 | 5;

export interface AutonomyLevelMeta {
  level: AutonomyLevel;
  /** Short column / legend title, e.g. "1 · Driven by you". */
  title: string;
  /** One line: what lands here and why. */
  hint: string;
}

/** Left → right on the axis: most Alex-driven first, most autonomous last. */
export const AUTONOMY_LEVELS: readonly AutonomyLevelMeta[] = [
  { level: 1, title: "1 · Driven by you", hint: "interactive: VS Code or a CLI chat with real back-and-forth" },
  { level: 2, title: "2 · Seeded by you", hint: "a human-started CLI run with one prompt (dispatch / tmux), left to run" },
  { level: 3, title: "3 · Scheduled", hint: "a named automation: scheduled task, launchd routine, a /skill's own step" },
  { level: 4, title: "4 · Headless", hint: "an unnamed headless run, a subagent, or a workflow agent" },
  { level: 5, title: "5 · The resident", hint: "the always-on Alef resident (~/.alef-resident)" },
];

export const AUTONOMY_LEVEL_BY_ID = new Map<AutonomyLevel, AutonomyLevelMeta>(AUTONOMY_LEVELS.map((m) => [m.level, m]));

/** Every subagent / workflow-agent record is unconditionally this level — see the module doc. */
export const SUBAGENT_AUTONOMY_LEVEL: AutonomyLevel = 4;
export const SUBAGENT_AUTONOMY_REASON = "subagent: spawned via the Agent tool, no human turn of its own";

/** The only WorldAgent fields the classifier reads. Kept narrow so tests can build fixtures with
 *  three fields instead of the whole session shape. */
export type AutonomySessionInput = Pick<WorldAgent, "title" | "messageCount" | "cwd">;

/** A session run from inside the resident's own home directory. In practice this should never
 *  match a real WorldAgent — the resident's reflections run with `--no-session-persistence` and
 *  leave no transcript for the indexer (see README "Resident" § Sandbox) — but the rule is kept
 *  as a structural, honest fallback rather than silently having no level-5 rule at all. */
const RESIDENT_CWD_RE = /(^|\/)\.alef-resident(\/|$)/;

/** What's left of the old HEADLESS_TITLE marker (server/features/topics-lib.ts) once every named
 *  automation shape is peeled off by automationKey: a generic "this was unattended" phrase with no
 *  recognizable automation name attached. Named ones (e.g. "inbox-sweep /inbox-sweep — headless
 *  run, nobody is there to answer…") are level 3 by the automationKey rule above this one; this
 *  only fires for a headless/subagent-shaped title that names nothing Alex set up on purpose. */
const UNNAMED_HEADLESS_RE = /\bheadless run\b|nobody is there to answer/i;

/** automationKey results that name Alef's own testing/bench machinery rather than something
 *  Alex scheduled to run unattended: a fleet-probe smoke test (a Side fleet node, or a
 *  one-line "Reply with exactly …" probe) and an eval-harness replay (the legal-ai-model-router
 *  bench, replaying "History: Task: …"/"## Task the user asked …"). Neither has a human turn of
 *  its own — level 4 ("headless") fits them, not level 3 ("scheduled"), which is reserved for a
 *  named automation Alex actually set up (launchd, a /skill's own step). */
const AUTOMATION_KEYS_AT_LEVEL_4 = new Set<string>(["fleet-probe", "eval-harness"]);

/**
 * automationKey(title) recognizes a COMMAND_NAME/STRIPPED_COMMAND ("/skill" or "skill /skill")
 * shape as automation, but that shape alone doesn't distinguish Alex typing `/skill …`
 * interactively from a launchd script invoking the same skill headlessly (shared/display.ts's
 * isSlashCommandShaped doc comment). Some launchd `/skill` runs also carry UNNAMED_HEADLESS_RE's
 * marker text (inbox-sweep, artifact-ritual) and don't need this list at all; these two don't
 * (✅ verified against a live GET /api/world, 2026-09-27: every "yalla-brief /yalla-brief" and
 * "ig-innovation /ig-innovation" title in the live set is this exact bare shape, repeated once per
 * scheduled run with no other text — the /yalla-brief skill fires daily 08:00 and the /ig-innovation
 * skill fires on its own launchd job, per their own skill definitions). Add a name here only once
 * it is verified this way — never guessed — since the same bare shape is also what Alex typing
 * that command interactively would produce. */
const KNOWN_HEADLESS_COMMAND_SKILLS = new Set<string>(["/yalla-brief", "/ig-innovation"]);

/** A launchd job's plain-English (no slash command) prompt that automationKey has no shape for at
 *  all — e.g. `~/.eulex-bench/bench/daily.sh`'s `claude -p "Score today's eulex-bench run in …"`.
 *  Confirmed real (see shared/autonomy.test.ts): without this, the title falls all the way through
 *  to the level-1 default, showing a scheduled headless run as "driven by you". Add a pattern here
 *  only for a launchd job confirmed to run this way — this is a stopgap for known cases, not a
 *  substitute for a real headless signal reaching WorldAgent (see the module doc above). */
const KNOWN_HEADLESS_PROMPT_RE = /^Score today.s eulex-bench run\b/i;

/** Below this many total messages (user + assistant; WorldAgent doesn't separate them — see the
 *  module doc), a non-automation session reads as "one seeded prompt, no back-and-forth" rather
 *  than a real conversation. Chosen a little above server/features/cleanup-lib.ts's
 *  HEADLESS_MAX_MESSAGES (3), which flags a `claude -p` run as an empty one-shot: this rule covers
 *  the same shape (seed, then nothing further from the human) but through an interactive CLI,
 *  which typically shows one more round (prompt, answer, maybe one clarifying "go ahead"). */
export const LOW_MESSAGE_TURNS = 6;

export interface AutonomyResult {
  level: AutonomyLevel;
  /** One short, human-readable reason — shown in the Canvas card and this module's own tests. */
  reason: string;
}

/**
 * Classifies one session onto the 5-level autonomy axis. Precedence (first match wins), each
 * documented where its constant is defined above:
 *   1. cwd under ~/.alef-resident                        → 5, the resident
 *   2. a known plain-English launchd prompt (scheduled)   → 3, scheduled (KNOWN_HEADLESS_PROMPT_RE)
 *   3. automationKey(title) is fleet-probe/eval-harness   → 4, headless test/bench machinery
 *   4. automationKey(title) recognizes it, and either
 *      it isn't the ambiguous "/skill" shape, or a
 *      headless marker / allowlist confirms it is         → 3, a named automation
 *   5. an unnamed "headless run" phrase                   → 4, headless with no automation name
 *   6. messageCount ≤ LOW_MESSAGE_TURNS                   → 2, seeded once and left alone
 *   7. otherwise                                          → 1, interactive (the default — see
 *      module doc for why this is "nearest defensible level" rather than a precise signal)
 */
export function autonomyLevel(session: AutonomySessionInput): AutonomyResult {
  if (RESIDENT_CWD_RE.test(session.cwd)) {
    return { level: 5, reason: "cwd is inside ~/.alef-resident" };
  }
  if (KNOWN_HEADLESS_PROMPT_RE.test(session.title)) {
    // launchd fires it on a schedule (com.stephane.eulex-bench: StartCalendarInterval 06:17), so it is a
    // scheduled automation (level 3) even though it runs as headless `claude -p`.
    return { level: 3, reason: "scheduled launchd routine (KNOWN_HEADLESS_PROMPT_RE: eulex-bench daily scorer)" };
  }
  const auto = automationKey(session.title);
  if (auto) {
    if (AUTOMATION_KEYS_AT_LEVEL_4.has(auto)) {
      return { level: 4, reason: `${auto}: headless test/bench machinery, not a scheduled automation` };
    }
    const ambiguous = isSlashCommandShaped(session.title);
    if (!ambiguous || UNNAMED_HEADLESS_RE.test(session.title) || KNOWN_HEADLESS_COMMAND_SKILLS.has(auto)) {
      return { level: 3, reason: `named automation: ${auto}` };
    }
    // A "/skill" shape with no headless marker and no allowlist entry: automationKey can't tell
    // this apart from Alex typing the same slash command by hand — fall through instead of
    // trusting it (see isSlashCommandShaped's doc comment).
  }
  if (UNNAMED_HEADLESS_RE.test(session.title)) {
    return { level: 4, reason: "headless-run title with no recognizable automation name" };
  }
  if (session.messageCount <= LOW_MESSAGE_TURNS) {
    return { level: 2, reason: `only ${session.messageCount} messages, no automation match → likely a single seeded prompt` };
  }
  return { level: 1, reason: `${session.messageCount} messages, no automation/headless/resident signal → default: interactive` };
}
