// Pure evaluators for every completeness check: real inputs in, a state + one-line detail
// out. No fs/process/network here — server/features/completeness.ts gathers the real
// numbers and hands them in, so every rule below is a plain function test can call with a
// fixture. Keep it that way: a check that reaches for `process.env` or `fs` directly can't
// be unit-tested without touching the real machine.

import type { CheckState } from "../../shared/features/completeness.js";
import { resumeCommand } from "../../shared/features/routines.js";
import { FEED_STALE_MS } from "../../shared/features/vault.js";

export interface CheckOutcome {
  state: CheckState;
  detail: string;
  why?: string;
}

function outcome(state: CheckState, detail: string, why?: string): CheckOutcome {
  return why === undefined ? { state, detail } : { state, detail, why };
}

const HOUR_MS = 3600_000;

// ── See ──────────────────────────────────────────────────────────────────

export function evalIndexCoverage(input: { jsonlFileCount: number; dbSessionCount: number }): CheckOutcome {
  const { jsonlFileCount, dbSessionCount } = input;
  if (jsonlFileCount === 0) return outcome("unknown", "No session files found yet.");
  const missing = jsonlFileCount - dbSessionCount;
  if (missing <= 0) return outcome("pass", `${dbSessionCount} of ${jsonlFileCount} sessions indexed.`);
  return outcome(
    "warn",
    `${dbSessionCount} of ${jsonlFileCount} sessions indexed (${missing} not yet indexed).`,
    "The indexer runs every 10s; a large backlog on disk can lag behind for a while after a cold start.",
  );
}

/** `live`: claude processes per cwd, minus Alef launches that never started (those have no
 *  transcript, so no agent can show them; the Inbox lists them as stranded instead). They are
 *  counted in `unstartedDispatches` and named in the detail, never failed on. */
export function evalLiveVisible(input: { live: ReadonlyMap<string, number>; visibleLiveCwds: ReadonlySet<string>; unstartedDispatches: number; probe?: { ok: boolean; error: string | null } }): CheckOutcome {
  // ps timing out on a loaded machine says nothing about Alef: no process list, no verdict.
  if (input.probe && !input.probe.ok) {
    return outcome("unknown", "Couldn't read the process list just now, so live claude processes can't be counted.", `${input.probe.error ?? "ps failed"}. Usually the machine is overloaded; live sessions are still detected from transcript activity.`);
  }
  const procs = (n: number): string => `${n} live claude process${n === 1 ? "" : "es"}`;
  const total = [...input.live.values()].reduce((a, n) => a + n, 0);
  const invisible = [...input.live.keys()].filter((c) => !input.visibleLiveCwds.has(c));
  const u = input.unstartedDispatches;
  const unstarted = u > 0 ? ` ${u} more ${u === 1 ? "is an Alef launch" : "are Alef launches"} that never started (see Inbox).` : "";
  if (total === 0) return outcome("pass", `No claude processes are running right now.${unstarted}`);
  if (invisible.length === 0) return outcome("pass", `${procs(total)}, all visible.${unstarted}`);
  const unseen = invisible.reduce((a, c) => a + (input.live.get(c) ?? 0), 0);
  return outcome("fail", `${unseen} of ${procs(total)} have no visible agent.${unstarted}`, invisible.slice(0, 5).join(", "));
}

/** `generatedAt`: the graph feed manifest's own build time; null = no readable manifest. */
export function evalGraphFeed(input: { generatedAt: string | null; nowMs: number }): CheckOutcome {
  if (input.generatedAt === null) return outcome("unknown", "No vault graph feed found (60-Meta/graph-feed/manifest.json).");
  const built = Date.parse(input.generatedAt);
  if (!Number.isFinite(built)) return outcome("warn", "The graph feed has no build time, so its age is unknown.");
  const ageMs = Math.max(0, input.nowMs - built);
  const age = ageMs < HOUR_MS ? `${Math.round(ageMs / 60_000)} min` : `${Math.round(ageMs / HOUR_MS)} h`;
  if (ageMs > FEED_STALE_MS) {
    return outcome("warn", `Graph feed built ${age} ago; it is rebuilt hourly.`, "Vault, Brain and ⌘K's note search show the vault as of that build until the Mac's capture runs again.");
  }
  return outcome("pass", `Graph feed built ${age} ago.`);
}

// ── Control ──────────────────────────────────────────────────────────────

export function evalApprovalsHook(input: { hookInstalled: boolean; enabled: boolean }): CheckOutcome {
  if (!input.hookInstalled) {
    return outcome(
      "fail",
      "The PermissionRequest hook isn't configured for this repo.",
      "Install (preview diff) shows the exact settings.json change and writes it, after a backup, only when you click Install (hooks/install.md has the manual steps). A hook from any worktree of this repo counts (the live ~/.alef-live or the dev checkout); another clone or a copy doesn't.",
    );
  }
  if (!input.enabled) return outcome("warn", "Hook is installed, but Approvals in the world is OFF.");
  return outcome("pass", "Hook is installed and approvals are on.");
}

export function evalTmux(input: { available: boolean | null }): CheckOutcome {
  if (input.available === null) return outcome("unknown", "tmux status unknown.");
  return input.available ? outcome("pass", "tmux is available.") : outcome("fail", "tmux is not on PATH.", "brew install tmux");
}

export function evalTerminalPty(input: { executable: boolean | null }): CheckOutcome {
  if (input.executable === null) return outcome("unknown", "node-pty isn't installed.");
  return input.executable
    ? outcome("pass", "node-pty's spawn-helper is built and executable.")
    : outcome("fail", "node-pty's spawn-helper isn't executable — the terminal will fall back to a mirror.", "npm_config_build_from_source=true npm rebuild node-pty");
}

/** Health's "Launch targets Claude hasn't trusted": a launch into one of them sits on claude's
 *  folder-trust dialog and runs nothing until someone answers it. `untrusted` null = ~/.claude.json
 *  couldn't be read. */
export function evalTrustTargets(input: { untrusted: number | null; checked: number }): CheckOutcome {
  if (input.untrusted === null) return outcome("unknown", "Couldn't read ~/.claude.json to check folder trust.");
  if (input.checked === 0) return outcome("unknown", "No district folders to check yet.");
  if (input.untrusted === 0) return outcome("pass", `All ${input.checked} district folders are trusted by Claude.`);
  return outcome(
    "warn",
    `${input.untrusted} of ${input.checked} district folders aren't trusted by Claude: a launch there waits on the trust dialog.`,
    "Trust them below (Trust these N folders, or one at a time: each writes only that folder's trust key in ~/.claude.json), or answer the dialog in Terminal on the first launch.",
  );
}

export function evalFps(input: { medianFps: number | null }): CheckOutcome {
  if (input.medianFps === null) return outcome("unknown", "Not measured yet — open Orbit for a few seconds.");
  return input.medianFps >= 40
    ? outcome("pass", `${Math.round(input.medianFps)} fps median on Orbit.`)
    : outcome("warn", `${Math.round(input.medianFps)} fps median on Orbit (target ≥ 40).`);
}

// ── Jev ──────────────────────────────────────────────────────────────────

/** Details read after CHECK_META's problem line when not passing ("Jev is offline: TYPESAFE_API_KEY
 *  not set (looked in …)."). `keyFrom`: the source the boot-time lookup took the key from (e.g.
 *  "~/.config/brain-server/.env"), `tried`: every source it looked at with its outcome (server/jev-key.ts's describeAttempts). Both
 *  absent when boot never resolved the key (a server started as a library, tests). Names only: the
 *  key's value never reaches this function. */
export function evalJevKey(input: { hasKey: boolean; status: string; lastTickAgoMs: number | null; keyFrom?: string | null; tried?: string }): CheckOutcome {
  if (!input.hasKey) {
    return outcome("fail", `TYPESAFE_API_KEY not set${input.tried ? ` (looked in ${input.tried})` : ""}.`, "Jev falls back to deterministic rules and keyword matching without it.");
  }
  const from = input.keyFrom ? ` Key from ${input.keyFrom}.` : "";
  const why = input.tried ? `Looked in ${input.tried}.` : undefined;
  if (input.status !== "online") return outcome("warn", `status is ${input.status}, not online.${from}`, why);
  if (input.lastTickAgoMs === null || input.lastTickAgoMs > 3 * 60_000) return outcome("warn", `Jev hasn't ticked in over 3 minutes.${from}`, why);
  return outcome("pass", `Jev is online and ticking.${from}`, why);
}

// ── Routines ─────────────────────────────────────────────────────────────

/** `paused`: routines whose plist is in ~/Library/LaunchAgents but launchd doesn't have loaded
 *  (a `launchctl bootout` keeps the file). They never fire, so they can't fail: named in the
 *  detail with the command that resumes them, never counted as failing. */
export function evalRoutines(input: { anyFailing: boolean; total: number; paused?: readonly { label: string; shortName: string }[] }): CheckOutcome {
  if (input.total === 0) return outcome("unknown", "No com.stephane.* routines found.");
  const paused = input.paused ?? [];
  const count = `${input.total} routine${input.total === 1 ? "" : "s"}${paused.length ? ` (${paused.length} paused)` : ""}`;
  const first = paused[0];
  const pausedText = first
    ? ` Paused (plist kept, not loaded): ${paused.map((p) => p.shortName).join(", ")}. Resume${paused.length > 1 ? " one" : ""}: ${resumeCommand(first.label)}`
    : "";
  return input.anyFailing
    ? outcome("warn", `At least one routine's last run exited non-zero.${pausedText}`)
    : outcome("pass", `${count}, none failing.${pausedText}`);
}

/** Health's "The resident is reflecting": the resident journals a reflection hourly after a fleet
 *  change, else every `quietCadenceMs` (resident-lib's REFLECT_MS x QUIET_REFLECT_FACTOR, 3 h). It
 *  warns on any lastError or after max(4 h, 1.5 x that cadence) without a reflection, and fails
 *  after 12 h. `resident` is GET /api/resident's shape (state.json carries the same fields); null
 *  when there is no state.json yet, with `readError` when it couldn't be read. */
export const RESIDENT_SILENT_WARN_FLOOR_MS = 4 * HOUR_MS;
export const RESIDENT_SILENT_FAIL_MS = 12 * HOUR_MS;

export function residentSilentWarnMs(quietCadenceMs: number): number {
  return Math.max(RESIDENT_SILENT_WARN_FLOOR_MS, 1.5 * quietCadenceMs);
}

function spanText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function evalResidentReflecting(input: {
  resident: { enabled: boolean; bornAt: string; lastReflectAt: string | null; lastError: string | null } | null;
  readError?: string;
  quietCadenceMs: number;
  nowMs: number;
}): CheckOutcome {
  const { resident, nowMs } = input;
  if (!resident) return outcome("unknown", input.readError ? `Couldn't read the resident's state: ${input.readError}` : "No resident state yet (no state.json in its home).");
  if (!resident.enabled) return outcome("unknown", "The resident is switched off (its kill switch), so no reflection is expected.");
  const warnMs = residentSilentWarnMs(input.quietCadenceMs);
  const why = `It reflects hourly after a fleet change, else every ${spanText(input.quietCadenceMs)}. This warns on any error or after ${spanText(warnMs)} without a reflection, and fails after ${spanText(RESIDENT_SILENT_FAIL_MS)}.`;
  const lastMs = resident.lastReflectAt ? Date.parse(resident.lastReflectAt) : NaN;
  const fromMs = Number.isFinite(lastMs) ? lastMs : Date.parse(resident.bornAt);
  if (!Number.isFinite(fromMs)) return outcome("unknown", "The resident's state has no valid reflection or birth time.");
  const silentMs = Math.max(0, nowMs - fromMs);
  const since = Number.isFinite(lastMs) ? `Last reflection ${spanText(silentMs)} ago` : `No reflection yet, born ${spanText(silentMs)} ago`;
  const err = resident.lastError?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "";
  const errText = err ? ` Last error: ${err}` : "";
  if (silentMs > RESIDENT_SILENT_FAIL_MS) return outcome("fail", `${since}: silent for over ${spanText(RESIDENT_SILENT_FAIL_MS)}.${errText}`, why);
  if (err) return outcome("warn", `${since}.${errText}`, why);
  if (silentMs > warnMs) return outcome("warn", `${since}, past its ${spanText(warnMs)} limit.`, why);
  if (!Number.isFinite(lastMs)) return outcome("unknown", `${since}; judged after ${spanText(warnMs)}.`, why);
  return outcome("pass", `${since}.`, why);
}

export function evalTodoFiles(input: { todoFileCount: number; whatsupAgeMs: number | null }): CheckOutcome {
  if (input.todoFileCount === 0) return outcome("warn", "No tasks/todo.md files found under ~/Documents/Code.");
  const staleOrMissing = input.whatsupAgeMs === null || input.whatsupAgeMs > 36 * HOUR_MS;
  if (staleOrMissing) return outcome("warn", `${input.todoFileCount} todo file(s) found, but whatsup's board is stale or missing.`);
  return outcome("pass", `${input.todoFileCount} todo file(s) found, whatsup board is fresh.`);
}

// ── Code ─────────────────────────────────────────────────────────────────

export function evalTests(input: {
  lastRun: { ok: boolean; ranAtMs: number; failed: number; total: number; failedSuites?: number; success?: boolean; exitedNonZero?: boolean; error?: string } | null;
  nowMs: number;
}): CheckOutcome {
  if (!input.lastRun) return outcome("unknown", "Tests have never been run from Health.");
  const ageMs = input.nowMs - input.lastRun.ranAtMs;
  // A run that produced no report writes {ok:false, total:0, failed:0}: never a pass.
  if (!input.lastRun.ok) return outcome("fail", "The last Health test run didn't produce results.", input.lastRun.error);
  if (input.lastRun.failed > 0) return outcome("fail", `${input.lastRun.failed} of ${input.lastRun.total} tests failing.`);
  // A file that fails to import adds no failed test, and an unhandled error leaves success:true.
  const failedSuites = input.lastRun.failedSuites ?? 0;
  if (failedSuites > 0) return outcome("fail", `${failedSuites} test suite${failedSuites === 1 ? "" : "s"} failed (a file that didn't load, or a failing hook).`);
  if (input.lastRun.success === false || input.lastRun.exitedNonZero === true) return outcome("fail", "vitest exited non-zero though no test failed (an unhandled error, or the run was cut short).");
  if (input.lastRun.total === 0) return outcome("warn", "The last Health test run found no tests.");
  // 25h, not 24h: the keeper's own nightly run takes a couple of minutes, so the check must stay
  // fresh past a full 24h-old run without flagging the brief window before the new one lands.
  if (ageMs > 25 * HOUR_MS) return outcome("warn", `Last run ${Math.round(ageMs / HOUR_MS)}h ago — run again to be sure.`);
  return outcome("pass", `${input.lastRun.total} tests passed, run < 25h ago.`);
}

export function evalBrokenLinks(input: { broken: readonly { file: string; link: string }[] }): CheckOutcome {
  if (input.broken.length === 0) return outcome("pass", "No broken relative links in README/docs/tasks.");
  return outcome(
    "warn",
    `${input.broken.length} broken link${input.broken.length === 1 ? "" : "s"} in the docs.`,
    input.broken
      .slice(0, 5)
      .map((b) => `${b.file} → ${b.link}`)
      .join("; "),
  );
}

export function evalDenyList(input: { loaded: boolean; error?: string }): CheckOutcome {
  return input.loaded
    ? outcome("pass", "Fork's deny-list loaded.")
    : outcome("fail", "Fork's deny-list failed to load — Fork refuses everything until it does.", input.error);
}

export function evalIndexes(input: { ready: boolean; ageMs: number | null }): CheckOutcome {
  if (!input.ready) return outcome("warn", "Brain index hasn't built yet.");
  if (input.ageMs === null || input.ageMs > 24 * HOUR_MS) return outcome("warn", "Brain index is more than 24h old.");
  return outcome("pass", "Brain index is ready and fresh.");
}

export function evalUsagePrices(input: { unpricedModels: readonly string[] | null }): CheckOutcome {
  if (input.unpricedModels === null) return outcome("unknown", "Usage data isn't available yet.");
  return input.unpricedModels.length === 0
    ? outcome("pass", "Every model seen has a price.")
    : outcome("warn", `${input.unpricedModels.length} model(s) unpriced: ${input.unpricedModels.join(", ")}.`);
}

// ── Tidy (P2's classifyCandidates; "unknown" when its scan fails) ───────────

export function evalTidy(input: { totalCount: number | null }): CheckOutcome {
  if (input.totalCount === null) return outcome("unknown", "Couldn't read Tidy up's candidates right now.");
  return input.totalCount < 25 ? outcome("pass", `${input.totalCount} tidy candidate(s).`) : outcome("warn", `${input.totalCount} tidy candidates — consider a cleanup pass.`);
}

export function evalDeadTmux(input: { count: number | null }): CheckOutcome {
  if (input.count === null) return outcome("unknown", "Couldn't read Tidy up's candidates right now.");
  return input.count === 0 ? outcome("pass", "No dead tmux sessions.") : outcome("warn", `${input.count} dead tmux session(s).`);
}

// ── broken-links: pure link scan over injected file contents ───────────────

const MD_LINK_RE = /\[[^\]]*]\(([^)]+)\)/g;

/** True for anything that isn't a same-repo relative file path: absolute URLs, mailto,
 *  bare in-page anchors, and Windows-style drive paths (never seen here, but cheap to rule out). */
function isExternalOrAnchor(link: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)|^#/i.test(link);
}

export interface BrokenLink {
  file: string;
  link: string;
}

/** Scans `[text](path)` links in each given file's markdown for relative links that don't
 *  resolve. `resolve(fromFile, link)` returns the path to test; `exists` says whether it's
 *  there. Both are injected so this never touches a real filesystem in a test. Query strings
 *  and fragments on an otherwise-relative link (`file.md#section`) are stripped before the
 *  existence check. */
export function findBrokenLinks(files: readonly { path: string; text: string }[], resolve: (fromFile: string, link: string) => string, exists: (resolved: string) => boolean): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of files) {
    for (const m of file.text.matchAll(MD_LINK_RE)) {
      const raw = (m[1] ?? "").trim();
      if (!raw || isExternalOrAnchor(raw)) continue;
      const clean = raw.split("#")[0]?.split("?")[0] ?? raw;
      if (!clean) continue;
      const resolved = resolve(file.path, clean);
      if (!exists(resolved)) broken.push({ file: file.path, link: raw });
    }
  }
  return broken;
}
