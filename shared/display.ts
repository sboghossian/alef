// Display-only transforms for two things the raw world data is honest but ugly about:
//   - a session's title, when it's really the first line of an automation's system prompt
//     (`/upskill`, `/daily-recap`), a `<scheduled-task>`/`<command-name>` wrapper, or an eval
//     harness's "History: Task: …" replay — see displayTitle.
//   - a catch-all island's name: the home dir, "/", or the vault, which today just show their
//     folder slug ("alexboghossian", "root", "alex_claude") — see displayIslandName.
//
// Both are pure, deterministic, no model calls, no I/O — safe to call from the client (planet
// labels, panels, cards) and the server alike. Neither touches the underlying data: the raw
// title is still what's stored, indexed and matched against server/features/topics-lib.ts's
// EXTRA_RULES (which key off the literal prompt text), and an island's `id` never changes here.
// Callers render the result through their normal escaping (escapeHtml / textContent) same as
// before; this module additionally strips any leftover angle-bracket tags so a raw title that
// still carries `<...>` scaffolding never reaches a template as anything but inert text.

import type { Island, WorldAgent } from "./types";

const MAX_LEN = 80;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Removes any `<tag ...>` / `</tag>` the patterns below didn't already consume. A belt on top
 *  of the caller's own escaping (escapeHtml / textContent), never a substitute for it. */
function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
}

function cap(s: string, max = MAX_LEN): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Whitespace-collapsed, tag-stripped, but NOT length-capped — for a title that doesn't match any
 *  of the four known-ugly shapes below. "Otherwise unchanged" means unchanged in substance: a
 *  normal, already-readable title (or an already ~120-char-capped fossil one) isn't re-truncated
 *  just because it runs past 80 chars — only the four constructed forms below get that cap, as a
 *  safety net for what they build (a role/skill pair, an "Eval · …" prefix, etc). Still runs
 *  stray-tag stripping, since a title this branch sees might be an unrecognized tag shape. */
function bare(s: string): string {
  return stripTags(collapseWhitespace(s));
}

/** The constructed forms below (the four known shapes) additionally get the ~80-char cap. */
function finish(s: string): string {
  return cap(bare(s));
}

// "You are the <role> step of Alex's `/<skill>` …" — the /upskill and /daily-recap
// automations' system prompts (with or without the backticks/trailing parenthetical).
const AUTOMATION_STEP = /^You are the\s+(.+?)\s+step of Alex.s\s+`?\/([a-z0-9][a-z0-9-]*)`?\b/i;

// <scheduled-task name="X" file="...">…
const SCHEDULED_TASK = /^<scheduled-task\s+name="([^"]+)"/;

// …<command-name>/X</command-name>… (often preceded by <command-message>X</command-message>).
const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/;

// "History: Task: <rest>" — an eval harness replaying a task.
const HISTORY_TASK = /^History:\s*Task:\s*(.+)$/s;

/**
 * A raw session title (the first user prompt, verbatim) made readable, for DISPLAY ONLY:
 *   "You are the WEEKLY narrative step of Alex's /daily-recap (fires Sundays). A…"
 *     → "/daily-recap · weekly narrative"
 *   '<scheduled-task name="rss-feed-obsidian" file="...">...'
 *     → "⏰ rss-feed-obsidian"
 *   "<command-message>yalla-brief</command-message> <command-name>/yalla-brief</command-name>"
 *     → "/yalla-brief"
 *   "History: Task: Review this SaaS Master..."
 *     → "Eval · Review this SaaS Master..."
 * Anything else passes through unchanged apart from whitespace collapse and stray-tag stripping —
 * a normal or already-fine title is never re-truncated just for running past 80 chars; only the
 * four constructed forms above get that cap, as a safety net for what they build. Deterministic,
 * no model calls; the input is never mutated for storage.
 */
export function displayTitle(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;

  const step = raw.match(AUTOMATION_STEP);
  if (step) return finish(`/${step[2]} · ${step[1]!.toLowerCase()}`);

  const scheduled = raw.match(SCHEDULED_TASK);
  if (scheduled) return finish(`⏰ ${scheduled[1]}`);

  const command = raw.match(COMMAND_NAME);
  if (command) return finish(`/${command[1]!.replace(/^\/+/, "")}`);

  const history = raw.match(HISTORY_TASK);
  if (history) return finish(`Eval · ${history[1]}`);

  return bare(raw);
}

/**
 * True when displayTitle(raw) builds a readable automation name from one of its four shapes
 * (instead of passing the prompt through). Shares displayTitle's patterns, so the two always agree.
 * The server uses it so that Claude Code's AI title, which only paraphrases an automation's system
 * prompt ("Alex's upskill loop"), never replaces that name ("/upskill · autonomous authoring").
 */
export function isAutomationPrompt(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  return AUTOMATION_STEP.test(raw) || SCHEDULED_TASK.test(raw) || COMMAND_NAME.test(raw) || HISTORY_TASK.test(raw);
}

/**
 * The title to SHOW for a session: Claude Code's own name for it (`displayName`: the user's
 * /rename, else Claude Code's AI title) when it has one, else displayTitle(title), so automation
 * prompts keep their readable names. `title` stays the raw first prompt, which topics,
 * automationKey and autonomy classify on and search keeps as an alias.
 */
export function agentTitle(a: Pick<WorldAgent, "title" | "displayName">): string {
  const named = typeof a.displayName === "string" ? bare(a.displayName).trim() : "";
  return named || displayTitle(a.title);
}

// Any single-segment child of /Users or /home — the same structural check
// client/src/views/code.ts's isHomeCwd uses, so "home dir" is recognized without ever hardcoding
// a username.
const HOME_DIR = /^\/(Users|home)\/[^/]+$/i;

// The vault's fixed directory name (client/src/views/brain-lib.ts's VAULT_NAME and every
// server/features/*.ts default vault path end in this segment).
const VAULT_BASENAME = "alex_claude";

// The vault, structurally: a directory named VAULT_BASENAME directly under `<home>/Documents/Code`
// — never just "any directory that happens to share the name" (a `alex_claude` checked out
// somewhere unrelated, e.g. a coworker's clone of this vault, must NOT read as "Vault"). Matching
// only the basename, as an earlier version of this function did, couldn't tell the two apart.
// The `[^/]+` segment is the same structural trick HOME_DIR uses for the home directory: it matches
// *a* username without ever hardcoding *the* username, so this keeps working for anyone's home dir.
// An `ALEF_VAULT_DIR` override that points somewhere else on disk intentionally does NOT read as
// "Vault" here — display is derived from the well-known path, not from that env var.
const VAULT_PATH = new RegExp(`^/(Users|home)/[^/]+/Documents/Code/${VAULT_BASENAME}$`, "i");

/**
 * A catch-all island's path turned into a human label, for DISPLAY ONLY — the island's `id` and
 * `name` in storage never change. A real project island (path doesn't match any of the three
 * shapes below) passes through with its own `name` untouched.
 */
export function displayIslandName(island: Pick<Island, "name" | "path">): string {
  // Trim a trailing slash, but "/" itself must survive the trim to stay "/".
  const p = island.path.length > 1 ? island.path.replace(/\/+$/, "") : island.path;
  if (p === "/") return "System root";
  if (HOME_DIR.test(p)) return "Home";
  if (VAULT_PATH.test(p)) return "Vault";
  return island.name;
}

// ── automation keys (the AUTO continent's sub-districts) ─────────────────────────────────────

// A `<command-message>X</command-message> <command-name>/X</command-name>` wrapper after the live
// indexer stripped its tags: "inbox-sweep /inbox-sweep — headless run…".
const STRIPPED_COMMAND = /^([a-z0-9][a-z0-9-]*)\s+\/\1(?![a-z0-9-])/i;
// An eval harness replaying a task (the legal-ai-model-router bench): two prompt shapes.
const EVAL_TASK = /^(History:\s*Task:|## Task the user asked\b)/;
const IDEA_INBOX = /^You are (a triage classifier for Alex.s idea inbox|drafting a NON-EXECUTABLE proposed plan from one of Alex.s)/i;
const INBOX_TRIAGE = /^ANALYSE inbox triage run\b/i;
const SESSION_GROUPS = /^Classify each Claude Code session into exactly one group\b/;
// Side fleet nodes and the one-line smoke probes that go with them.
const FLEET_PROBE =
  /You are one node of a Side fleet|^(Reply with exactly|Reply with just|Wait quietly\. Reply|Wait\. Reply|Say OK and nothing else)\b|^Create a file (called|named) \S+\.txt (in the current directory |in this directory )?containing\b/i;

/**
 * Which automation a raw session title belongs to, or null for a title no automation wrote. Reuses
 * displayTitle's parsing, so the two always agree on a skill name:
 *   "You are the narrative step of Alex's /daily-recap…"  → "/daily-recap" (every step of it)
 *   '<scheduled-task name="rss-feed-obsidian" …'              → "⏰ rss-feed-obsidian"
 *   "<command-name>/ig-innovation</command-name>" or its tag-stripped form "ig-innovation /ig-innovation"
 *                                                              → "/ig-innovation"
 *   "History: Task: …" / "## Task the user asked …"           → "eval-harness"
 *   the idea-inbox classifier and planner prompts             → "idea-inbox"
 *   "ANALYSE inbox triage run …"                              → "inbox-triage"
 *   "Classify each Claude Code session into exactly one group" → "session-groups"
 *   Side fleet nodes and one-line smoke probes                → "fleet-probe"
 * Pure and deterministic; the key doubles as the sub-district's label.
 */
export function automationKey(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const s = collapseWhitespace(raw);
  const step = s.match(AUTOMATION_STEP);
  if (step) return `/${step[2]!.toLowerCase()}`;
  const scheduled = s.match(SCHEDULED_TASK);
  if (scheduled) return `⏰ ${collapseWhitespace(scheduled[1]!)}`;
  const command = s.match(COMMAND_NAME);
  if (command) return `/${command[1]!.trim().replace(/^\/+/, "").toLowerCase()}`;
  const stripped = s.match(STRIPPED_COMMAND);
  if (stripped) return `/${stripped[1]!.toLowerCase()}`;
  if (EVAL_TASK.test(s)) return "eval-harness";
  if (IDEA_INBOX.test(s)) return "idea-inbox";
  if (INBOX_TRIAGE.test(s)) return "inbox-triage";
  if (SESSION_GROUPS.test(s)) return "session-groups";
  if (FLEET_PROBE.test(s)) return "fleet-probe";
  return null;
}

/**
 * True when automationKey(raw), if it matches at all, matched through one of the two "slash
 * command" shapes — COMMAND_NAME's live `<command-name>…</command-name>` tag, or STRIPPED_COMMAND's
 * archived "name /name" form once the indexer has stripped the tags. Both are written by the
 * Claude Code CLI for ANY invocation of a slash skill: Alex typing `/linear for the agency
 * work with: …` in an interactive session produces exactly the same shape as a launchd script's
 * `claude -p "/inbox-sweep"`. So, unlike automationKey's other five shapes (a system-prompt wrapper
 * — `<scheduled-task>`, the /daily-recap-style "You are the … step of" preamble, an eval-harness
 * replay, the idea-inbox/inbox-triage/session-groups classifiers — none of which a human ever
 * types by hand), a COMMAND_NAME/STRIPPED_COMMAND match is NOT on its own proof that a title names
 * a *scheduled* automation. shared/autonomy.ts uses this to require a second signal (a headless-run
 * marker, or an explicit allowlist entry) before trusting the match for its level-3 rule.
 */
export function isSlashCommandShaped(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const s = collapseWhitespace(raw);
  return COMMAND_NAME.test(s) || STRIPPED_COMMAND.test(s);
}
