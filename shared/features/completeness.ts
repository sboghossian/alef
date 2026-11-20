// 🩺 Health / Completeness (round 10, P3): a local score and checklist of "is my Alef
// setup whole and healthy". Shared shapes between server/features/completeness.ts
// (real sources) and client/src/views/health.ts (renders them) + client/src/features/
// completeness.ts (status chip, the one client-only check: fps).

export type CompletenessCheckId =
  | "index-coverage"
  | "live-visible"
  | "approvals-hook"
  | "jev-key"
  | "tmux"
  | "terminal-pty"
  | "routines"
  | "todo-files"
  | "tests"
  | "broken-links"
  | "deny-list"
  | "indexes"
  | "tidy"
  | "dead-tmux"
  | "usage-prices"
  | "trust-targets"
  | "resident-reflecting"
  | "graph-feed"
  | "fps";

export type CompletenessGroup = "see" | "control" | "jev" | "routines" | "code" | "tidy";

export const GROUP_LABELS: Readonly<Record<CompletenessGroup, string>> = Object.freeze({
  see: "See",
  control: "Control",
  jev: "Jev",
  routines: "Routines",
  code: "Code",
  tidy: "Tidy",
});

export type CheckState = "pass" | "warn" | "fail" | "unknown";

/** How this check's evidence was established (Alex's own claim-confidence convention):
 *  "measured" = the server ran something real (a process list, a file stat, an actual test
 *  run) and read the result — true of every check in this file, which is why the server
 *  composer sets it unconditionally. "reported" / "guess" exist for a future check that isn't
 *  a direct measurement; nothing here qualifies today. */
export type CheckConfidence = "measured" | "reported" | "guess";

/** Weight: critical 3, core 2, nice 1 (spec table). `problem`: what a failing / warning check
 *  reads as wherever it is shown (Health's rows, the Town square, the Inbox), so a failure never
 *  reads as its passing label ("Jev is offline: …", never "Jev is online - key not set"). `fps` is
 *  evaluated client-side (scene-bus frame stats aren't available on the server) but carries the
 *  same weight/group so it slots into the same list and the same score math. */
export const CHECK_META: Readonly<Record<CompletenessCheckId, { label: string; group: CompletenessGroup; weight: number; problem: string }>> = Object.freeze({
  "index-coverage": { label: "Session index coverage", group: "see", weight: 3, problem: "Sessions are missing from the index" },
  "live-visible": { label: "Live sessions are visible", group: "see", weight: 3, problem: "Live sessions aren't all visible" },
  "approvals-hook": { label: "Approvals hook installed", group: "control", weight: 3, problem: "Approvals hook isn't working" },
  "jev-key": { label: "Jev (TypeSafe)", group: "jev", weight: 2, problem: "Jev is offline" },
  tmux: { label: "tmux available", group: "control", weight: 2, problem: "tmux isn't available" },
  "terminal-pty": { label: "Terminal (node-pty) is built", group: "control", weight: 2, problem: "Terminal (node-pty) isn't built" },
  routines: { label: "Routines are healthy", group: "routines", weight: 2, problem: "A routine is failing" },
  "todo-files": { label: "Todo files found", group: "routines", weight: 1, problem: "Todo files are missing or stale" },
  tests: { label: "Tests pass", group: "code", weight: 2, problem: "Tests aren't green" },
  "broken-links": { label: "No broken doc links", group: "code", weight: 1, problem: "Doc links are broken" },
  "deny-list": { label: "Fork's deny-list loads", group: "code", weight: 2, problem: "Fork's deny-list doesn't load" },
  indexes: { label: "Brain index is warm", group: "code", weight: 1, problem: "Brain index is cold" },
  tidy: { label: "Tidy backlog is small", group: "tidy", weight: 1, problem: "Tidy backlog is large" },
  "dead-tmux": { label: "No dead tmux sessions", group: "tidy", weight: 1, problem: "Dead tmux sessions" },
  "usage-prices": { label: "Every model priced", group: "code", weight: 1, problem: "A model has no price" },
  "trust-targets": { label: "Launch targets Claude hasn't trusted", group: "control", weight: 1, problem: "Launch targets Claude hasn't trusted" },
  "resident-reflecting": { label: "The resident is reflecting", group: "routines", weight: 2, problem: "The resident has stopped reflecting" },
  "graph-feed": { label: "Vault graph feed is fresh", group: "see", weight: 2, problem: "Vault graph feed is stale" },
  fps: { label: "Frame rate on Orbit", group: "control", weight: 2, problem: "Orbit's frame rate is low" },
});

export interface CompletenessCheck {
  id: CompletenessCheckId;
  label: string;
  group: CompletenessGroup;
  weight: number;
  state: CheckState;
  /** One line with the real number, e.g. "7 live claude processes, 7 visible ✓". */
  detail: string;
  /** Expandable "Why?" explanation; omitted when the detail line already says it all. */
  why?: string;
  /** Present only when a safe fix/action exists for this state. */
  fixId?: CompletenessCheckId;
  /** Button text, e.g. "Run tests", "Copy command", "Show install steps", "Open Tidy up". */
  fixLabel?: string;
  /** Set while Alex has snoozed this check or marked it won't fix (Health's per-check buttons):
   *  the check is still measured and listed (muted) in Health, but the Town square and the Inbox
   *  stop pinning it. Absent when not dismissed, or once a snooze has run out. */
  dismissed?: CheckDismissal;
  /** How the evidence in `detail`/`why` was established. Optional for older callers/tests;
   *  the Health view's Issues list treats a missing value as "measured" (every real check is). */
  confidence?: CheckConfidence;
}

export interface CompletenessResponse {
  ok: true;
  generatedAt: string; // ISO
  checks: CompletenessCheck[];
  /** Score over the checks in `checks` only (server-side; the client adds `fps` itself). */
  score: number;
  /** True when these checks are past their 60 s TTL: served as-is while a recompute runs in the
   *  background (`generatedAt` is when they were computed). */
  stale?: boolean;
}

/** The machine's load as GET /api/health reports it. A frame rate measured while other sessions
 *  saturate the CPU says nothing about Alef, so the fps check reads it before judging. */
export interface HostLoad {
  /** 1-minute load average. */
  load1: number;
  cpus: number;
}

/** Load per core at or above which the box counts as overloaded for the fps check. */
export const OVERLOADED_LOAD_PER_CPU = 1.5;

export function isOverloaded(host: HostLoad | null | undefined): boolean {
  return Boolean(host && host.cpus > 0 && host.load1 / host.cpus >= OVERLOADED_LOAD_PER_CPU);
}

/** WS "completeness" feature message: pushed on every real recompute (the 60s tick, or the
 *  first `GET`/tick after boot), not just at connect — so a check that starts failing, or
 *  turns back to pass, reaches an already-open client without a reload. `generatedAt` is the
 *  server's own clock at that recompute (`cache.at`), carried through so the reader never has
 *  to stamp its own receipt time. */
export type CompletenessMessage = { kind: "summary"; generatedAt: string; checks: readonly CompletenessCheck[]; score: number };

/** `POST /api/completeness/:checkId/fix` — only ids in the server's allowlist do anything;
 *  everything else answers 400. Most "fixes" in the spec (copy a command, open a tab, open
 *  Tidy up) are pure client-side actions and never reach this route at all. */
export interface CompletenessFixResult {
  ok: boolean;
  message: string;
  error?: string;
}

/** One line for a check: "<label>: <detail>" when it passes or isn't measured, "<problem>: <detail>"
 *  when it fails or warns. */
export function checkLine(c: Pick<CompletenessCheck, "id" | "label" | "state" | "detail">): string {
  const head = c.state === "fail" || c.state === "warn" ? (CHECK_META[c.id]?.problem ?? c.label) : c.label;
  return `${head}: ${c.detail}`;
}

// ── dismissals: "Snooze 7 days" / "Won't fix" per check ─────────────────────
// One small store keyed by check id (server: data/health-dismissals.json), reused by anything
// that pins a Health check somewhere (Town square, Inbox).
//   GET  /api/completeness/dismissals            → { ok, dismissals }
//   POST /api/completeness/:checkId/dismiss       { kind: "snooze" | "wont-fix", days?, reason? }
//   POST /api/completeness/:checkId/undismiss

export type DismissalKind = "snooze" | "wont-fix";

export interface CheckDismissal {
  kind: DismissalKind;
  /** When it was dismissed (ISO). */
  at: string;
  /** When a snooze runs out (ISO); null for won't fix (until undone). */
  until: string | null;
  reason: string | null;
}

export type CheckDismissals = Partial<Record<CompletenessCheckId, CheckDismissal>>;

export const SNOOZE_DAYS = 7;

export interface CheckDismissalsResponse {
  ok: boolean;
  dismissals: CheckDismissals;
  error?: string;
}

/** The dismissal still in force at `nowMs`: a snooze past its `until` no longer counts. */
export function activeDismissal(d: CheckDismissal | undefined | null, nowMs: number): CheckDismissal | null {
  if (!d) return null;
  if (d.kind === "snooze" && (d.until === null || !(Date.parse(d.until) > nowMs))) return null;
  return d;
}

export function isCheckDismissal(v: unknown): v is CheckDismissal {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (r.kind === "snooze" || r.kind === "wont-fix") && typeof r.at === "string" && (r.until === null || typeof r.until === "string") && (r.reason === null || typeof r.reason === "string");
}

/** Pinned somewhere outside Health (Town square, Inbox): failing or warning, and not dismissed. */
export function isPinnable(c: Pick<CompletenessCheck, "state" | "dismissed">): boolean {
  return (c.state === "fail" || c.state === "warn") && !c.dismissed;
}

// ── approvals hook install (GET/POST /api/completeness/approvals-hook/install) ──

/** The approvals-hook check's button while the hook isn't in settings.json. */
export const APPROVALS_INSTALL_LABEL = "Install (preview diff)";

export interface ApprovalsHookDiffLine {
  kind: " " | "-" | "+";
  text: string;
}

export interface ApprovalsHookInstallPlan {
  ok: boolean;
  /** "ready": the diff below is what Install writes; "already": nothing to do; "error": refused. */
  status: "ready" | "already" | "error";
  settingsPath: string;
  diff: ApprovalsHookDiffLine[];
  message: string;
  /** The whole new file: server-side only, never sent with the preview. */
  after?: string;
}

export interface ApprovalsHookInstallResult {
  ok: boolean;
  status: "installed" | "already" | "error";
  message: string;
  backupPath: string | null;
  error?: string;
}

export interface CompletenessTestsRunResult {
  ok: boolean;
  ranAtMs: number;
  passed: number;
  failed: number;
  total: number;
  /** Suites vitest marked failed. A file that fails to import counts here and adds no failed test. */
  failedSuites?: number;
  /** vitest's own verdict from the report. */
  success?: boolean;
  /** vitest exited non-zero. An unhandled error does this on a report that still says success:true. */
  exitedNonZero?: boolean;
  error?: string;
}

/** Minimal shape used for scoring (both the server's own checks and the client's merged
 *  list, fps included, share this math). */
export interface ScoredCheck {
  weight: number;
  state: CheckState;
}

/** Score = passed weight ÷ total weight, unknown excluded, rounded to an integer 0-100.
 *  When every check is "unknown" (nothing measurable yet, e.g. right after boot) there is
 *  nothing to fail, so this returns 100 rather than a scary 0 — a deliberate choice, not a
 *  measurement; document it if you change it. */
export function computeScore(checks: readonly ScoredCheck[]): number {
  let total = 0;
  let achieved = 0;
  for (const c of checks) {
    if (c.state === "unknown") continue;
    total += c.weight;
    if (c.state === "pass") achieved += c.weight;
  }
  if (total === 0) return 100;
  return Math.round((achieved / total) * 100);
}

/** green ≥90, yellow ≥70, pink below (spec's chip thresholds). */
export function scoreTone(score: number): "good" | "warn" | "bad" {
  if (score >= 90) return "good";
  if (score >= 70) return "warn";
  return "bad";
}
