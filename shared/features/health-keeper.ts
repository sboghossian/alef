// 🩺 Health keeper (server/features/health-keeper.ts): once a night at 04:30 local it runs the
// Health test suite (the same code path as Health's "Run tests" button) every night, regardless
// of how fresh the last run was — a run already in progress is joined, never duplicated — then
// recomputes every Health check, posts one Feed line "Health: N%", and, when the score is under
// 100, ONE Inbox item for that day naming each failing / warning check and its fix. It never
// edits settings, trusts a folder, logs in, restarts anything or runs launchctl.
//
//   GET /api/health-keeper   → HealthKeeperResponse
//   snapshot extras "health-keeper.state" and WS { feature: "health-keeper", payload: HealthKeeperMessage }

import type { CompletenessCheckId } from "./completeness.js";

/** Local wall-clock time of the nightly pass. */
export const HEALTH_KEEPER_AT: Readonly<{ hour: number; minute: number }> = Object.freeze({ hour: 4, minute: 30 });
export const HEALTH_KEEPER_EXTRAS_KEY = "health-keeper.state";

export interface HealthKeeperIssue {
  id: CompletenessCheckId;
  label: string;
  state: "warn" | "fail";
  detail: string;
  /** One line: what fixes it. */
  fix: string;
}

/** The day's Inbox item (one per local date). Resolved once Health reads 100 again. */
export interface HealthKeeperInboxItem {
  /** Local date of the pass, YYYY-MM-DD: the dedup key. */
  date: string;
  at: string;
  score: number;
  /** "Health N%: <check> — <its fix>; …" */
  text: string;
  issues: HealthKeeperIssue[];
  resolvedAt: string | null;
}

export interface HealthKeeperTests {
  /** Always true: the pass reruns the suite every night. Kept, with `reason`, for the state's
   *  shape and for a value persisted from before the nightly run stopped being skippable. */
  ran: boolean;
  reason: string;
  ok?: boolean;
  passed?: number;
  failed?: number;
  total?: number;
}

export interface HealthKeeperState {
  /** When the last nightly pass started (ISO), null before the first. */
  lastRunAt: string | null;
  /** The next 04:30 the keeper will act on. In the past = missed (asleep, server down): it runs on the next tick. */
  nextRunAt: string;
  lastScore: number | null;
  lastFailing: HealthKeeperIssue[];
  lastTests: HealthKeeperTests | null;
  running: boolean;
  inbox: HealthKeeperInboxItem | null;
  lastError: string | null;
}

export interface HealthKeeperResponse extends HealthKeeperState {
  ok: true;
}

export type HealthKeeperMessage = { kind: "state"; state: HealthKeeperState };

/** One line per check: what fixes it (the Inbox item repeats it next to the check's name). */
export const HEALTH_FIX_HINTS: Readonly<Record<CompletenessCheckId, string>> = Object.freeze({
  "index-coverage": "wait for the indexer (every 10 s); if the gap stays, read the server log",
  "live-visible": "check the folder Health names has a growing transcript under ~/.claude/projects",
  "approvals-hook": "Health › Install (preview diff), or Turn approvals ON when it's installed",
  "jev-key": "add TYPESAFE_API_KEY to ~/.config/brain-server/.env (or the server's env), then restart the server",
  tmux: "brew install tmux",
  "terminal-pty": "npm_config_build_from_source=true npm rebuild node-pty",
  routines: "open Routines and read the failing routine's log",
  "todo-files": "refresh whatsup's board",
  tests: "Health › Run tests (a red run: fix the failing tests)",
  "broken-links": "fix the dead links Health names",
  "deny-list": "fix the YAML Health names (~/.cloudflared/dashable/config.yml or ~/.dashable/services.yml)",
  indexes: "Health › Warm brain index",
  tidy: "Health › Tidy up",
  "dead-tmux": "Health › Tidy up",
  "usage-prices": "add the model to PRICE_TABLE in shared/features/usage.ts at its official price",
  "trust-targets": "Health › Trust these N folders",
  "resident-reflecting": "read the resident's lastError (GET /api/resident) and its lines in the server log",
  "graph-feed": "run the vault's capture pipeline on the Mac (it rebuilds 60-Meta/graph-feed), then reload Health",
  fps: "Health › Lower quality",
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";

export function isHealthKeeperIssue(v: unknown): v is HealthKeeperIssue {
  return isRecord(v) && typeof v.id === "string" && typeof v.label === "string" && (v.state === "warn" || v.state === "fail") && typeof v.detail === "string" && typeof v.fix === "string";
}

export function isHealthKeeperInboxItem(v: unknown): v is HealthKeeperInboxItem {
  return (
    isRecord(v) &&
    typeof v.date === "string" &&
    typeof v.at === "string" &&
    typeof v.score === "number" &&
    typeof v.text === "string" &&
    Array.isArray(v.issues) &&
    v.issues.every(isHealthKeeperIssue) &&
    strOrNull(v.resolvedAt)
  );
}

export function isHealthKeeperState(v: unknown): v is HealthKeeperState {
  return (
    isRecord(v) &&
    strOrNull(v.lastRunAt) &&
    typeof v.nextRunAt === "string" &&
    (v.lastScore === null || typeof v.lastScore === "number") &&
    Array.isArray(v.lastFailing) &&
    v.lastFailing.every(isHealthKeeperIssue) &&
    (v.lastTests === null || (isRecord(v.lastTests) && typeof v.lastTests.ran === "boolean" && typeof v.lastTests.reason === "string")) &&
    typeof v.running === "boolean" &&
    (v.inbox === null || isHealthKeeperInboxItem(v.inbox)) &&
    strOrNull(v.lastError)
  );
}
