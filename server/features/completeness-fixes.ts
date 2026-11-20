// Safe fixes for the Health checklist. Most checks in the spec have no server-side fix at
// all (copy a command, open a tab, open Tidy up — all client-only); the two real
// server-mutating actions live here:
//   - `POST /api/completeness/:checkId/fix`: only ids in FIXABLE_CHECK_IDS do anything, an
//     unknown id is a 400. Today that's just "approvals-hook" (flips the SAME
//     `approvals.enabled` meta flag the real `POST /api/approvals/settings` route writes —
//     never touches ~/.claude/settings.json).
//   - `POST /api/completeness/tests/run`: single-flight `npx vitest run --reporter=json
//     --outputFile=<fresh temp file>`, 180s timeout, result cached to disk so the `tests` check
//     survives a server restart.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletenessCheckId, CompletenessFixResult, CompletenessTestsRunResult } from "../../shared/features/completeness.js";
import { isRecord } from "../http.js";
import type { FeatureContext } from "./registry.js";

// ── the generic per-check fix allowlist ─────────────────────────────────────

export const FIXABLE_CHECK_IDS: ReadonlySet<CompletenessCheckId> = new Set(["approvals-hook"]);

export function isFixableCheckId(id: string): id is CompletenessCheckId {
  return FIXABLE_CHECK_IDS.has(id as CompletenessCheckId);
}

const APPROVALS_ENABLED_META_KEY = "approvals.enabled"; // same key server/features/approvals.ts owns

/** Turns Approvals-in-the-world ON. Mirrors exactly what `POST /api/approvals/settings`
 *  does (`ctx.db.setMeta("approvals.enabled", "1")`); approvals.ts reads this key fresh on
 *  every call, so the next snapshot picks it up without a duplicate WS message. Never
 *  touches the hook's presence in ~/.claude/settings.json — that half is read-only, with a
 *  "Show install steps" link instead of a fix. */
export function applyApprovalsHookFix(ctx: FeatureContext): CompletenessFixResult {
  ctx.db.setMeta(APPROVALS_ENABLED_META_KEY, "1");
  return { ok: true, message: "Approvals in the world are now ON." };
}

export function applyFix(id: CompletenessCheckId, ctx: FeatureContext): CompletenessFixResult {
  switch (id) {
    case "approvals-hook":
      return applyApprovalsHookFix(ctx);
    default:
      return { ok: false, message: "No fix for this check.", error: "not fixable" };
  }
}

// ── tests: single-flight `npx vitest run` ───────────────────────────────────

export type TestExec = (cmd: string, args: string[], opts: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const TESTS_TIMEOUT_MS = 180_000;

interface VitestJsonSummary {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numFailedTestSuites?: number;
  success?: boolean;
}

/** Parses a vitest `--reporter=json` report: the first `{` onwards, so leading noise is
 *  tolerated. Null when there is no JSON object to read. */
export function parseVitestJson(stdout: string): { total: number; passed: number; failed: number; failedSuites: number; success: boolean } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as VitestJsonSummary;
    const total = parsed.numTotalTests ?? 0;
    const failed = parsed.numFailedTests ?? 0;
    const passed = parsed.numPassedTests ?? Math.max(0, total - failed);
    const failedSuites = parsed.numFailedTestSuites ?? 0;
    return { total, passed, failed, failedSuites, success: parsed.success ?? (failed === 0 && failedSuites === 0) };
  } catch {
    return null;
  }
}

const MAX_ERROR_CHARS = 1500;
const FAILING_NAME_RE = /^\s*(?:FAIL|✗|✖|×)\s+.+$/;

/** Best-effort synopsis for when neither the outputFile nor stdout held a parseable report:
 *  whatever looks like a failing-test line (from either stream — a crash before the JSON
 *  reporter engages can print to either) first, then the rest of stderr, capped so a
 *  maxBuffer's worth of noise never reaches the client as one message. Never throws. */
export function buildTestsError(stdout: string, stderr: string, execErr: unknown): string {
  const names = [...stdout.split("\n"), ...stderr.split("\n")].map((l) => l.trim()).filter((l) => FAILING_NAME_RE.test(l));
  const fallback = execErr === null ? "vitest wrote no json report" : String(execErr);
  const header = names.length ? names.join("\n") : fallback;
  const tail = stderr.trim();
  const body = tail && !header.includes(tail) ? `${header}\n--- stderr ---\n${tail}` : header;
  return body.length > MAX_ERROR_CHARS ? `${body.slice(0, MAX_ERROR_CHARS - 1)}…` : body;
}

/** vitest 5 no longer prints the json report to stdout: without --outputFile it writes
 *  `<root>/.vitest/json/output.json` and prints only "JSON report written to …". So the report is
 *  always read from a file this run names, in a fresh temp dir (a stale one can never be read;
 *  stdout alone is never taken as the report itself — see the dedicated test for why). When that
 *  file is missing or unparseable, stdout is still useful: it falls back into the capped error
 *  synopsis below alongside stderr, instead of being thrown away unread. */
async function runOnce(exec: TestExec, repoRoot: string, resultsPath: string, now: () => number): Promise<CompletenessTestsRunResult> {
  const ranAtMs = now();
  const dir = await mkdtemp(join(tmpdir(), "alef-vitest-"));
  const outFile = join(dir, "report.json");
  let execErr: unknown = null;
  let stdout = "";
  let stderr = "";
  try {
    const r = await exec("npx", ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`], { cwd: repoRoot, timeout: TESTS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    execErr = err; // vitest exits 1 when a test fails, after writing the report
    if (isRecord(err)) {
      if (typeof err.stdout === "string") stdout = err.stdout;
      if (typeof err.stderr === "string") stderr = err.stderr;
    }
  }
  // The report file is the only source of truth for a real result — see "json on stdout alone
  // is never taken as the result" below; stdout only ever feeds the error synopsis on failure.
  const parsed = parseVitestJson(await readFile(outFile, "utf8").catch(() => ""));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  // The exit is kept even when the report parses: after an unhandled error it is the only sign.
  const result: CompletenessTestsRunResult = parsed
    ? { ok: true, ranAtMs, ...parsed, exitedNonZero: execErr !== null }
    : { ok: false, ranAtMs, passed: 0, failed: 0, total: 0, error: buildTestsError(stdout, stderr, execErr) };
  await writeFile(resultsPath, JSON.stringify(result), "utf8").catch(() => {});
  return result;
}

let running: Promise<CompletenessTestsRunResult> | null = null;

/** A second call while one is already running gets the SAME promise — never a second
 *  `npx vitest run`. */
export function runTestsSingleFlight(exec: TestExec, repoRoot: string, resultsPath: string, now: () => number = Date.now): Promise<CompletenessTestsRunResult> {
  if (running) return running;
  const p = runOnce(exec, repoRoot, resultsPath, now).finally(() => {
    running = null;
  });
  running = p;
  return p;
}

/** Test-only: clears the single-flight lock between test cases. */
export function resetTestsRunStateForTests(): void {
  running = null;
}
