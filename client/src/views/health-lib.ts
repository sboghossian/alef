// Pure logic for the 🩺 Health view: preset prompt templates for "Start an agent", the
// default-city pick, first-run welcome detection/copy, check grouping for the checklist, and
// the fps median used to build the client-only `fps` check. No DOM here — health.ts renders
// what this module computes.

import type { CheckConfidence, CheckDismissal, CompletenessCheck, CompletenessCheckId, CompletenessGroup, HostLoad } from "../../../shared/features/completeness";
import { CHECK_META, GROUP_LABELS, isOverloaded, isPinnable } from "../../../shared/features/completeness";
import type { TrustBulkResult } from "../../../shared/features/trust";
import type { GlStatus } from "../scene/webgl";

// ── "Start an agent" presets ─────────────────────────────────────────────

export type PresetId = "fix-bug" | "build-feature" | "research" | "review-changes";

export interface Preset {
  id: PresetId;
  label: string;
  template(cityName: string): string;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "fix-bug",
    label: "Fix a bug",
    template: (city) => `Find and fix a bug in ${city}. Find the root cause rather than patching the symptom, and add a test that would have caught it.`,
  },
  {
    id: "build-feature",
    label: "Build a feature",
    template: (city) => `In ${city}, build: <describe the feature>. Keep the diff minimal and match the existing code style.`,
  },
  {
    id: "research",
    label: "Research",
    template: (city) => `Research in ${city}: <describe what you want to know>. Report findings — don't change any code.`,
  },
  {
    id: "review-changes",
    label: "Review my changes",
    template: (city) => `Review the uncommitted changes in ${city} for correctness, security and style. List what you'd fix before merging.`,
  },
];

const DEFAULT_PRESET = PRESETS[0]!;

/** The editable starting text for a preset in a given city; the user can freely rewrite it
 *  before Launch. Falls back to the first preset for an unknown id rather than throwing —
 *  a stale/renamed id in the DOM should degrade, not break the card. */
export function presetTemplate(id: string, cityName: string): string {
  const preset = PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
  return preset.template(cityName || "this project");
}

export interface CityOption {
  id: string;
  name: string;
  agentCount: number;
  lastActive: string;
}

/** "Most active repo": highest agent count, ties broken by most recently active. Harness
 *  (the skills/hooks/MCP city) is never a sensible dispatch target, so it's excluded — same
 *  rule the existing dispatch bar applies. Null when there is nothing to pick. */
export function defaultStartAgentCity(islands: readonly CityOption[]): string | null {
  const candidates = islands.filter((i) => i.id !== "harness");
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.agentCount - a.agentCount || Date.parse(b.lastActive) - Date.parse(a.lastActive))[0]!.id;
}

// ── first-run "Welcome check" ─────────────────────────────────────────────

export const WELCOME_SEEN_KEY = "alef.health.seenScore";

/** True the very first time the Health chip/view would be shown (the stored flag is anything
 *  other than "1" — absent, cleared, or corrupted all count as "never seen"). */
export function isFirstRun(storedValue: string | null): boolean {
  return storedValue !== "1";
}

export function welcomeMessage(citiesCount: number, agentsCount: number, liveCount: number): string {
  const city = citiesCount === 1 ? "city" : "cities";
  const agent = agentsCount === 1 ? "agent" : "agents";
  return `Alef found ${agentsCount} ${agent} in ${citiesCount} ${city}, ${liveCount} live — here's what's set up and what's missing.`;
}

// ── checklist grouping + the ring's "N things to fix" ────────────────────

const GROUP_ORDER: readonly CompletenessGroup[] = ["see", "control", "jev", "routines", "code", "tidy"];

export interface CheckGroupRow {
  group: CompletenessGroup;
  label: string;
  checks: CompletenessCheck[];
}

/** Groups checks in the spec's fixed section order (See · Control · Jev · Routines · Code ·
 *  Tidy); a group with no checks yet (e.g. before the first tick) is omitted rather than
 *  shown empty. Checks within a group keep the order they arrived in. */
export function groupChecks(checks: readonly CompletenessCheck[]): CheckGroupRow[] {
  const rows: CheckGroupRow[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = checks.filter((c) => c.group === group);
    if (inGroup.length > 0) rows.push({ group, label: GROUP_LABELS[group], checks: inGroup });
  }
  return rows;
}

/** "3 things to fix": actionable rows only — a "warn"/"fail" is something to act on, an
 *  "unknown" is just not measured yet and isn't counted as broken, and a check snoozed or marked
 *  won't fix is set aside. The ring's caption and the Issues heading both show this one number. */
export function toFixCount(checks: readonly CompletenessCheck[]): number {
  return checks.filter(isPinnable).length;
}

export interface IssueCounts {
  /** warn/fail, not dismissed: the one "N to fix" number Health shows. */
  toFix: number;
  /** unknown: listed under Issues, never counted as broken. */
  unmeasured: number;
  /** warn/fail snoozed or marked won't fix: listed muted, not counted. */
  dismissed: number;
}

export function issueCounts(checks: readonly CompletenessCheck[]): IssueCounts {
  let toFix = 0;
  let unmeasured = 0;
  let dismissed = 0;
  for (const c of checks) {
    if (c.state === "unknown") unmeasured++;
    else if (c.state === "warn" || c.state === "fail") {
      if (c.dismissed) dismissed++;
      else toFix++;
    }
  }
  return { toFix, unmeasured, dismissed };
}

/** "5 things to fix · 2 not measured · 1 set aside": the ring's caption, the same numbers the
 *  Issues list holds. */
export function issuesCaption(n: IssueCounts): string {
  const head = n.toFix === 0 ? "Nothing to fix right now" : `${n.toFix} thing${n.toFix === 1 ? "" : "s"} to fix`;
  const tail = [n.unmeasured ? `${n.unmeasured} not measured` : "", n.dismissed ? `${n.dismissed} set aside` : ""].filter(Boolean);
  return [head, ...tail].join(" · ");
}

/** "Snoozed until Nov 3" / "Won't fix" (with its reason when one was given). */
export function dismissalText(d: CheckDismissal, locale?: string): string {
  if (d.kind === "wont-fix") return d.reason ? `Won't fix: ${d.reason}` : "Won't fix";
  const until = d.until ? new Date(d.until).toLocaleDateString(locale, { month: "short", day: "numeric" }) : "";
  return `Snoozed until ${until}`;
}

// ── Issues list (round 11, package D): every non-passing check, worst first, with why it
//    matters, a confidence badge and either the existing one-click fix or exact steps ─────────

/** Real architectural consequence of each check failing/warning — grounded in how the
 *  feature it's about actually feeds the rest of Alef (not a guess: each line follows directly
 *  from reading that feature's own code). Kept separate from `why` (which is evidence/context
 *  the check itself already reports) so the Issues list can show both without duplicating text. */
export const WHY_IT_MATTERS: Readonly<Record<CompletenessCheckId, string>> = Object.freeze({
  "index-coverage": "Anything not indexed is invisible everywhere else in Alef — Orbit, Board, Canvas and Brain's project filter all read from the SQLite index, never the raw jsonl.",
  "live-visible": "A live session Alef can't see won't show a car on Orbit, a card on Board, or an approval prompt — you'd be flying blind on real work that's happening right now.",
  "approvals-hook": "Without this, permission prompts never reach Alef's Approve/Deny beacon — you have to go back to the terminal for every one.",
  "jev-key": "Jev falls back to deterministic rules and keyword matching without a key — council votes, routing advice and the daily tick still run, just without the model's judgement.",
  tmux: "Talk and the in-world terminal spawn agents inside a real tmux session; without it on PATH, dispatch/reactivate can't attach a live terminal to what they start.",
  "terminal-pty": "The Code/Room terminal falls back to a read-only mirror instead of a real interactive PTY, so you can watch a session but not type into it.",
  routines: "A routine whose last run failed keeps failing silently on its own schedule until someone notices — the district's puff/color cue is the only other place this shows up.",
  "todo-files": "Board's Loops tab and the daily digest read tasks/todo.md and whatsup's board; if either is missing or stale, open work goes untracked between sessions.",
  tests: "An untested or red change ships to a live tool other sessions and the shared tree depend on — this repo has no CI gate beyond what you run from here.",
  "broken-links": "A broken relative link in README/docs/todo sends the next reader (human or agent) to a 404 instead of the doc that would have saved them the mistake.",
  "deny-list": "Fork refuses every worktree request while its deny-list fails to load — better to fail closed, but it means Fork is fully unavailable until this is fixed.",
  indexes: "Brain's search and backlinks answer from a cold/empty index until the background build finishes, so search results look empty or stale.",
  tidy: "A large tidy backlog is disk and clutter creeping up quietly — nothing forces you to look until you open the Tidy tab yourself.",
  "dead-tmux": "Dead tmux sessions sit there using no CPU but cluttering `tmux ls` and Tidy's own candidate list.",
  "usage-prices": "An unpriced model shows as 0 cost in the usage view, which understates real spend rather than measuring it — a $ figure this app deliberately won't invent.",
  "trust-targets": "A launch into a folder Claude hasn't trusted stops on its trust dialog with No preselected, so the prompt never runs and Alef can't answer it for you.",
  "resident-reflecting": "The resident's journal is the town's record of what happened. When its reflections stop, the heartbeat (ticks, spend) still looks alive, so nothing else notices: on 09-28 it was silent for over 7 h while every other screen looked fine.",
  "graph-feed": "Vault, Brain's graph and ⌘K's note search all read the vault's hourly graph feed; when it stops, they keep showing the vault as it was, with nothing else saying so.",
  fps: "A slow Orbit makes every other feature (drag-to-dispatch, courier, approvals) feel laggy since they all share the same render loop.",
});

/** Exact manual steps for a check that has no one-click fix (see completeness.ts's `toCheck`
 *  callers for which ids get a `fixLabel`). Grounded in the real files/paths each check reads. */
export const FIX_STEPS: Readonly<Partial<Record<CompletenessCheckId, readonly string[]>>> = Object.freeze({
  "index-coverage": ["Wait — the indexer re-scans every 10s and usually catches up on its own.", "If the gap doesn't close, check the world server's own log for indexer errors.", "Confirm ~/.claude/projects/ is mounted and readable (not a disconnected iCloud placeholder)."],
  "live-visible": ["Look at the cwd(s) named in the evidence above.", "Confirm each one has a real ~/.claude/projects/<encoded-cwd> directory with a growing jsonl file.", "Restart the Alef server if the indexer looks wedged on an otherwise-healthy session."],
  "jev-key": [
    "Add a TYPESAFE_API_KEY=<key> line to ~/.config/brain-server/.env (mode 600), or set it in the environment the Alef server runs in.",
    "Restart the server: it reads the key once at boot, and the evidence above says where it looked.",
    "Jev keeps working on rule-based fallback in the meantime — this isn't a hard outage.",
  ],
  "todo-files": ["Add a tasks/todo.md to at least one active project under ~/Documents/Code.", "Regenerate whatsup's board (however you normally refresh it) so its timestamp isn't stale."],
  "broken-links": ["Open the file(s) named in the evidence above.", "Fix or remove each dead relative link.", "This check re-runs on the next 60s tick, or reload Health to check immediately."],
  "graph-feed": ["On the Mac, check the vault's auto-capture agent ran recently (it rebuilds 60-Meta/graph-feed every 15 min).", "Run the vault's capture pipeline once by hand and reload Health.", "If Alef reads a different vault than the Mac writes, check $ALEF_VAULT_DIR."],
  "deny-list": ["Check ~/.cloudflared/dashable/config.yml and ~/.dashable/services.yml exist and are valid YAML (the evidence line carries the parser's own error).", "Fork refuses every request until this loads, so this is worth fixing promptly."],
  "usage-prices": ["Add the model id(s) named above to PRICE_TABLE in shared/features/usage.ts.", "Restart the server so the new price takes effect."],
  "trust-targets": [
    "Click Trust these N folders (one click, every folder is listed above it; it writes only each folder's trust key in ~/.claude.json), or Trust next to one folder.",
    "Or answer Claude's trust dialog in Terminal on the first launch there.",
  ],
  "resident-reflecting": [
    "Read the last error in the evidence above (GET /api/resident has the same lastError).",
    "An \"over the daily cap\" error clears by itself tomorrow; anything else is a bug in the reflection path.",
    "Check the server log (~/Library/Logs/alef/server.log) for its \"resident\" lines around the last reflection.",
  ],
});

/** fail > warn > unknown (a "nothing measured yet" gap still deserves attention, just less
 *  than a confirmed problem); ties broken by weight (critical checks first). Pass is never
 *  in this list at all — see `issuesList`. */
export function severityRank(c: Pick<CompletenessCheck, "state" | "weight">): number {
  const stateRank = c.state === "fail" ? 2 : c.state === "warn" ? 1 : 0; // "unknown" and "pass" both 0; pass is filtered out first
  return stateRank * 100 + c.weight;
}

/** Every check that isn't passing, worst first; snoozed / won't-fix ones last (listed, muted). */
export function issuesList(checks: readonly CompletenessCheck[]): CompletenessCheck[] {
  const rank = (c: CompletenessCheck): number => severityRank(c) - (c.dismissed ? 1000 : 0);
  return checks.filter((c) => c.state !== "pass").sort((a, b) => rank(b) - rank(a));
}

const CONFIDENCE_BADGE: Readonly<Record<CheckConfidence, string>> = Object.freeze({
  measured: "✅ measured",
  reported: "📣 reported",
  guess: "🧪 guess",
});

/** A check with no `confidence` set (older test fixtures, mainly) reads as measured — every
 *  check this app ships today is a direct measurement (see the server's `toCheck`). */
export function confidenceBadge(c: Pick<CompletenessCheck, "confidence">): string {
  return CONFIDENCE_BADGE[c.confidence ?? "measured"];
}

// ── "Run tests" (round: broken-fixes) ─────────────────────────────────────
// A real `npx vitest run` on this repo's 2000+ tests can take well over a minute; the default
// 20s postJson timeout used to abandon it long before the server (180s timeout) gave up.

/** postJson's timeout for the tests run: comfortably under the server's 180s ceiling, generous
 *  enough that a slow-but-healthy full suite doesn't read as "couldn't run". */
export const TESTS_RUN_TIMEOUT_MS = 200_000;

export const TESTS_RUNNING_LABEL = "Running the test suite (1-3 minutes)…";

export interface TestsRunResultLike {
  ok: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  error?: string;
}

/** "Tests: N passed, M failing." when the run itself completed (whether or not everything
 *  passed), or "Tests couldn't run: <short reason>" when it didn't — e.g. the 200s client
 *  timeout tripped, or the server answered ok:false. Never blank: a missing error still reads
 *  as a (generic) reason rather than silently saying nothing. */
export function testsResultMessage(r: TestsRunResultLike): string {
  if (r.ok) {
    const failed = r.failed ?? 0;
    const passed = r.passed ?? Math.max(0, (r.total ?? 0) - failed);
    return `Tests: ${passed} passed, ${failed} failing.`;
  }
  return `Tests couldn't run: ${r.error ?? "no reason given"}`;
}

// ── fps sampling (feeds the client-only `fps` check) ─────────────────────

/** The median of a rolling fps sample window. Median, not mean, so one bad frame (a GC pause,
 *  a tab switch) doesn't swing the number the way an average would. */
export function medianFps(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The client-only `fps` check (mirrors server/features/completeness-checks.ts's evalFps —
 *  duplicated, not imported, because client code never imports from server/: see AGENTS.md
 *  and the fact that no other client file does either). Uses the shared CHECK_META so the
 *  label/group/weight stay in lockstep with the server's 15 checks. */
export function buildFpsCheck(medianFpsValue: number | null, webgl: GlStatus = { state: "on" }, host: HostLoad | null = null): CompletenessCheck {
  const meta = CHECK_META.fps;
  // 3D not drawing (ui/no-3d.ts): there is no frame rate, and opening Orbit won't produce one.
  if (webgl.state !== "on") {
    const detail =
      webgl.state === "off"
        ? `3D is off: WebGL could not start in this browser (${webgl.reason}). Nothing is drawn, so there is no frame rate to measure.`
        : "3D is paused: the WebGL context was lost. No frames are drawn until the browser restores it.";
    return { id: "fps", label: meta.label, group: meta.group, weight: meta.weight, state: "unknown", detail, confidence: "measured" };
  }
  if (medianFpsValue === null) {
    return { id: "fps", label: meta.label, group: meta.group, weight: meta.weight, state: "unknown", detail: "Not measured yet — open Orbit for a few seconds.", confidence: "measured" };
  }
  const pass = medianFpsValue >= 40;
  if (!pass && host && isOverloaded(host)) {
    // Other sessions own the CPU: a slow frame says nothing about Alef, so no verdict either way.
    const detail = `${Math.round(medianFpsValue)} fps median on Orbit, but the machine is overloaded (load ${host.load1.toFixed(1)} on ${host.cpus} cores), so this doesn't measure Alef.`;
    return { id: "fps", label: meta.label, group: meta.group, weight: meta.weight, state: "unknown", detail, confidence: "measured" };
  }
  const check: CompletenessCheck = {
    id: "fps",
    label: meta.label,
    group: meta.group,
    weight: meta.weight,
    state: pass ? "pass" : "warn",
    detail: pass ? `${Math.round(medianFpsValue)} fps median on Orbit.` : `${Math.round(medianFpsValue)} fps median on Orbit (target ≥ 40).`,
    confidence: "measured", // a real rolling median of this session's own frame times
  };
  if (!pass) check.fixLabel = "Lower quality";
  return check;
}

// ── "Trust these N folders" (POST /api/trust/bulk) ──────────────────────────

export function trustAllLabel(n: number): string {
  return `Trust ${n === 1 ? "this folder" : `these ${n} folders`}`;
}

function folderCount(n: number): string {
  return `${n} folder${n === 1 ? "" : "s"}`;
}

/** The success toast: every folder is trusted now (written, or Claude already had it). */
export function bulkTrustSuccessText(r: Pick<TrustBulkResult, "trusted" | "already">): string {
  const already = r.already ? ` (${r.already} ${r.already === 1 ? "was" : "were"} already trusted)` : "";
  return `Trusted ${folderCount(r.trusted + r.already)}${already}: launches there start without the trust dialog.`;
}

/** The failure toast. A partial failure says what WAS trusted and names what wasn't, with the
 *  server's reason; a request refused as a whole (no per-folder results) returns null so the
 *  default "<label> failed: <reason>" reads its error. */
export function bulkTrustFailureText(r: Pick<TrustBulkResult, "results" | "trusted" | "already" | "refused">): string | null {
  if (r.results.length === 0) return null;
  const refused = r.results.filter((x) => x.outcome === "refused");
  const names = refused
    .slice(0, 3)
    .map((x) => `${x.path.split("/").filter(Boolean).pop() ?? x.path} (${x.error ?? "refused"})`)
    .join("; ");
  return `Trusted ${r.trusted + r.already} of ${folderCount(r.results.length)}; not trusted: ${names}${refused.length > 3 ? `; and ${refused.length - 3} more` : ""}.`;
}
