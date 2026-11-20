// Wire types for the "fixes" feature: the Fix queue at the top of Health. One list merged from
// what other features already know (no scanning of its own):
//   health        failing / warning Health checks        (completeness.ts currentHealthChecks)
//   sickness      open Sickness cases                    (sickness.ts openSicknessCases)
//   vault-project a project slug with no 20-Projects/<slug>/_index.md (vault.ts latestVaultGaps)
//   vault-ghost   a link target ≥2 notes point at that was never written (same)
//   loop          a todo nobody touched in LOOPS_STALE_DAYS (loops.ts latestLoopsBoard)
//   abandoned     a session whose outcome verdict is "abandoned" (outcomes.ts latestOutcomeRecords)
//
//   GET  /api/fixes                    -> FixesResponse
//   GET  /api/fixes/:id                -> FixRowResponse (404 when the row isn't in the queue now)
//   POST /api/fixes/:id/dismiss        { kind: "snooze" | "wont-fix", days?, reason? } -> FixActionResult
//   POST /api/fixes/:id/undismiss      -> FixActionResult
//   POST /api/fixes/:id/launched       { tmuxName? } -> FixActionResult (a "Draft a fix" was dispatched)
//   WS   "fixes" feature message       -> FixesMessage (the open count changed)
//   WorldSnapshot.extras["fixes.summary"] -> FixesSummary
//
// A health row's snooze / won't fix is the Health check's own dismissal (data/health-dismissals.json),
// so Health's checklist and the Town square agree with the queue; every other row's lives in
// data/fixes.json. Titles and evidence come from transcripts, todo.md files and vault notes:
// untrusted text. Render it escaped, never execute it.

import { checkLine, type CheckDismissal, type CompletenessCheck } from "./completeness.js";
import type { SessionOutcome } from "./outcomes.js";

export const FIX_SOURCES = ["health", "sickness", "vault-project", "vault-ghost", "loop", "abandoned"] as const;
export type FixSource = (typeof FIX_SOURCES)[number];

export const FIX_SOURCE_LABEL: Readonly<Record<FixSource, string>> = {
  health: "Health",
  sickness: "Sickness",
  "vault-project": "Vault",
  "vault-ghost": "Vault",
  loop: "Loops",
  abandoned: "Abandoned",
};

export type FixSeverity = "high" | "medium" | "low";
export const FIX_SEVERITY_ORDER: readonly FixSeverity[] = ["high", "medium", "low"];

/** open: nobody acted yet. launched: a "Draft a fix" (or a Loops ▶ Launch) started a session.
 *  snoozed / wont-fix: set aside, still listed (muted) with Undo. */
export type FixState = "open" | "launched" | "snoozed" | "wont-fix";

/** A todo whose todo.md nobody touched in this many days is stale. */
export const LOOPS_STALE_DAYS = 14;
/** Abandoned sessions older than this are history, not something to fix. */
export const ABANDONED_WINDOW_DAYS = 14;
/** Rows listed per source; the counts still cover every row. */
export const FIX_SOURCE_CAP = 25;

/** The session a fix started, and how it ended (its outcome verdict) once there is one. */
export interface FixLaunch {
  at: string; // ISO, when it was dispatched
  /** The world tmux session ("aw-…"); null when it ran in a plain Terminal. */
  tmuxName: string | null;
  /** The Claude session id, once talk's binding adopted it. */
  sessionId: string | null;
  /** Its outcome verdict (outcomes.ts), null until the session has a record. */
  outcome: SessionOutcome | null;
  outcomeReason: string | null;
}

export interface FixRow {
  /** "<source>:<key>", stable across recomputes. */
  id: string;
  source: FixSource;
  title: string;
  evidence: string;
  /** The district a fix runs in, when one is known. */
  cityId: string | null;
  cwd: string | null;
  severity: FixSeverity;
  /** When the problem was first seen (ISO), or null when the source doesn't say. */
  since: string | null;
  state: FixState;
  dismissed: CheckDismissal | null;
  launch: FixLaunch | null;
  /** The prompt "Draft a fix" puts in the prompt box (nothing is sent until Dispatch). */
  prompt: string;
  /** loop rows from a tasks/todo.md: "Mark done" ticks that one line. */
  loopId: string | null;
}

export type FixCounts = Record<FixSource, number>;

export interface FixesResponse {
  ok: true;
  generatedAt: string;
  rows: FixRow[];
  /** Rows not set aside (open + launched), per source, before the per-source cap. */
  open: FixCounts;
  /** Sources whose owner hasn't computed once yet (shown as pending, never as 0). */
  pending: FixSource[];
}

export interface FixRowResponse {
  ok: boolean;
  row?: FixRow;
  error?: string;
}

export interface FixActionResult {
  ok: boolean;
  error?: string;
}

export interface FixesSummary {
  generatedAt: string;
  /** Rows not set aside, across every source. */
  open: number;
  pending: FixSource[];
}

export interface FixesMessage {
  kind: "summary";
  summary: FixesSummary;
}

export const FIXES_EXTRAS_KEY = "fixes.summary";

const FIX_ID_RE = /^(health|sickness|vault-project|vault-ghost|loop|abandoned):[^\n]{1,300}$/;

export function isFixId(id: string): boolean {
  return FIX_ID_RE.test(id);
}

export function fixSourceOf(id: string): FixSource | null {
  const m = FIX_ID_RE.exec(id);
  return m ? (m[1] as FixSource) : null;
}

export function emptyFixCounts(): FixCounts {
  return { health: 0, sickness: 0, "vault-project": 0, "vault-ghost": 0, loop: 0, abandoned: 0 };
}

// ── prompts: one wording for the queue and for the direct buttons (Health, Vault, Board) ──────

const PROMPT_MAX = 3800;

function clip(s: string): string {
  return s.length > PROMPT_MAX ? `${s.slice(0, PROMPT_MAX - 1)}…` : s;
}

/** The prompt every "Draft a fix" writes: what is wrong, the evidence, where, and the ask. */
export function draftFixPrompt(p: { title: string; evidence: string; where?: string | null; ask?: string }): string {
  const lines = [`Fix this: ${p.title}`, "", `Evidence: ${p.evidence}`];
  if (p.where) lines.push(`Where: ${p.where}`);
  lines.push("", p.ask ?? "Find the root cause, fix it, verify the fix (run the relevant tests), then say in one paragraph what you changed and how you checked it.");
  return clip(lines.join("\n"));
}

export function vaultProjectFixPrompt(slug: string, vaultDir?: string | null): string {
  return draftFixPrompt({
    title: `the vault project "${slug}" has no index note`,
    evidence: `notes are filed under project "${slug}", but 20-Projects/${slug}/_index.md does not exist`,
    where: vaultDir ?? null,
    ask: `Create 20-Projects/${slug}/_index.md following the vault's CLAUDE.md conventions (YAML frontmatter with type and parent), summarising the project from its session notes, and update the matching project_*.md in working memory if there is one.`,
  });
}

export function vaultGhostFixPrompt(target: string, inbound: number, vaultDir?: string | null): string {
  return draftFixPrompt({
    title: `"${target}" is linked from ${inbound} ${inbound === 1 ? "note" : "notes"} but was never written`,
    evidence: `[[${target}]] resolves to nothing in the vault`,
    where: vaultDir ?? null,
    ask: `Read the notes that link to [[${target}]], then either write that note (in the right folder, with frontmatter) or fix the links if they meant an existing note. Say which you did.`,
  });
}

export function sessionFixPrompt(p: { title: string; sessionId: string; outcome: string; reason: string | null; cwd?: string | null }): string {
  return draftFixPrompt({
    title: `the session "${p.title}" ended ${p.outcome}`,
    evidence: `${p.reason ?? "no reason recorded"} (session ${p.sessionId})`,
    where: p.cwd ?? null,
    ask: `Pick it up: read where it stopped (\`claude --resume ${p.sessionId}\` reopens it), decide whether its work is still wanted, then finish it or say why it should be dropped.`,
  });
}

/** A failing / warning Health check: Alef's own setup, so the fix runs in Alef's repo. */
export function healthFixPrompt(c: Pick<CompletenessCheck, "id" | "label" | "state" | "detail" | "why">): string {
  return draftFixPrompt({
    title: checkLine(c),
    evidence: c.why ?? c.detail,
    where: `Alef (agent-world), its Health check "${c.id}"`,
    ask: "Find out why this check is not passing on this machine, fix the cause (not the check), then re-run the check from Health and say what changed.",
  });
}

/** A loop nobody touched in a while: do it, or say why it should go. */
export function loopFixPrompt(p: { task: string; project: string; days: number | null; cwd: string | null }): string {
  return draftFixPrompt({
    title: p.task,
    evidence: `an open todo in ${p.project}'s tasks/todo.md${p.days !== null ? `, not touched in ${p.days} days` : ""}`,
    where: p.cwd,
    ask: "Do this todo, or say why it should be dropped. When it is done, tick its line in tasks/todo.md.",
  });
}
