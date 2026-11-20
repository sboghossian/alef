// Pure logic for the Health keeper (health-keeper.ts): when the nightly slot falls, whether the
// test suite needs a run, and the words of its Inbox item and Feed line. No IO, no clock of its
// own: every function takes the time it should reason about.

import { CHECK_META, type CompletenessCheck } from "../../shared/features/completeness.js";
import { HEALTH_FIX_HINTS, HEALTH_KEEPER_AT, type HealthKeeperIssue, type HealthKeeperTests } from "../../shared/features/health-keeper.js";

type At = Readonly<{ hour: number; minute: number }>;

function atTime(ms: number, at: At, dayOffset = 0): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(at.hour, at.minute, 0, 0);
  return d.getTime();
}

/** The latest local `at` (04:30) at or before `nowMs`. */
export function slotAtOrBefore(nowMs: number, at: At = HEALTH_KEEPER_AT): number {
  const today = atTime(nowMs, at);
  return today <= nowMs ? today : atTime(nowMs, at, -1);
}

/** The first local `at` (04:30) strictly after `ms`. */
export function nextSlotAfter(ms: number, at: At = HEALTH_KEEPER_AT): number {
  const today = atTime(ms, at);
  return today > ms ? today : atTime(ms, at, 1);
}

/** True when a 04:30 has passed since the slot the keeper last handled. A keeper that never handled
 *  one (`lastSlotMs` null) is not due: its first pass is the next 04:30. */
export function isDue(lastSlotMs: number | null, nowMs: number, at: At = HEALTH_KEEPER_AT): boolean {
  return lastSlotMs !== null && slotAtOrBefore(nowMs, at) > lastSlotMs;
}

/** Local calendar date, YYYY-MM-DD: the Inbox item's once-a-day key. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hoursText(ms: number): string {
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(0, Math.round(ms / 60_000))} min` : `${Math.round(h)} h`;
}

/** The suite reruns every night no matter how fresh the last run was — only the log line (and the
 *  state's `lastTests.reason`) says how long since the last one; "never overlap" is `runTests`'
 *  own single-flight lock, not a decision made here. */
export function testsRunReason(lastTestsAtMs: number | null, nowMs: number): string {
  if (lastTestsAtMs === null) return "no Health test run recorded";
  return `last Health test run ${hoursText(nowMs - lastTestsAtMs)} ago`;
}

/** Every check that is failing or warning, worst first, with its one-line fix. Named by what is
 *  wrong (CHECK_META's `problem`, "Jev is offline"), never by its passing label. */
export function keeperIssues(checks: readonly CompletenessCheck[]): HealthKeeperIssue[] {
  return checks
    .filter((c): c is CompletenessCheck & { state: "warn" | "fail" } => c.state === "warn" || c.state === "fail")
    .sort((a, b) => (a.state === b.state ? b.weight - a.weight : a.state === "fail" ? -1 : 1))
    .map((c) => ({ id: c.id, label: CHECK_META[c.id]?.problem ?? c.label, state: c.state, detail: c.detail, fix: HEALTH_FIX_HINTS[c.id] }));
}

/** "Health 87%: Tests pass — Health › Run tests; Every model priced — add the model to …" */
export function inboxText(score: number, issues: readonly HealthKeeperIssue[]): string {
  return `Health ${score}%: ${issues.map((i) => `${i.label} — ${i.fix}`).join("; ")}`;
}

/** The Feed line's detail: what the tests did, then what isn't passing (by name). */
export function feedDetail(issues: readonly HealthKeeperIssue[], tests: HealthKeeperTests): string {
  const t = !tests.ran
    ? `tests not rerun: ${tests.reason}`
    : tests.ok
      ? `tests ran: ${tests.passed ?? 0} passed, ${tests.failed ?? 0} failing`
      : "tests ran but produced no results";
  const rest = issues.length ? `not passing: ${issues.map((i) => i.label).join(", ")}` : "every check passes";
  return `${t} · ${rest}`;
}
