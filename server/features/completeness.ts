// 🩺 Health / Completeness (round 10, P3): "is my Alef setup whole and healthy" as one
// score and a checklist of real, independently-verifiable facts about this machine. Every
// check reads a real source (settings.json, a process list, a file on disk, another
// feature's already-exported helper) — nothing here is guessed or hand-entered.
//
// Cheap checks (everything except `tests`, which is on-demand/single-flight, and `fps`,
// which only the client can measure) refresh on a 60s tick and are cached; `GET
// /api/completeness` computes once on first call if the tick hasn't fired yet, then serves
// the cache. Fixes: most of the spec's "safe fix" column is a pure client-side action (copy
// a command, switch tabs) and never reaches this file — the two that do are the
// `approvals-hook` toggle and the `tests` runner (see completeness-fixes.ts).

import { loadCleanupCandidates } from "./cleanup.js";
import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import {
  APPROVALS_INSTALL_LABEL,
  CHECK_META,
  computeScore,
  type CompletenessCheck,
  type CompletenessCheckId,
  type CompletenessMessage,
  type CompletenessResponse,
  type CompletenessTestsRunResult,
  type CheckDismissalsResponse,
} from "../../shared/features/completeness.js";
import type { CandidateBuckets } from "../../shared/features/cleanup.js";
import { priceForModel } from "../../shared/features/usage.js";
import { discountUnstartedDispatches } from "../heuristics.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { currentJevKeyResolution, describeAttempts } from "../jev-key.js";
import { isValidUuid } from "../reactivate.js";
import {
  type CheckOutcome,
  evalApprovalsHook,
  evalBrokenLinks,
  evalDeadTmux,
  evalDenyList,
  evalIndexCoverage,
  evalIndexes,
  evalJevKey,
  evalLiveVisible,
  evalGraphFeed,
  evalResidentReflecting,
  evalRoutines,
  evalTerminalPty,
  evalTests,
  evalTidy,
  evalTmux,
  evalTodoFiles,
  evalTrustTargets,
  evalUsagePrices,
  findBrokenLinks,
} from "./completeness-checks.js";
import { hookScriptPaths, isSameRepoHookScript } from "./completeness-hook.js";
import { applyFix, isFixableCheckId, parseVitestJson, runTestsSingleFlight, type TestExec } from "./completeness-fixes.js";
import { applyApprovalsHookInstall, approvalsHookCommand, nodeOnPath, previewApprovalsHookInstall, type InstallDeps } from "./approvals-hook-install.js";
import { dismissalsPathFor, dismissalStoreFor, isCheckId, makeDismissal, withDismissals } from "./health-dismissals.js";
import { DEFAULT_CODE_DIR } from "./loops-scan.js";
import { DEFAULT_WHATSUP_TODOS_JSON, readWhatsupBoard } from "./loops-whatsup.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { parseManifest, vaultFeedDir } from "./vault-feed.js";
import { QUIET_REFLECT_FACTOR, REFLECT_MS } from "./resident-lib.js";
import { readInHome } from "./resident-sandbox.js";
import { buildRoutines } from "./routines.js";
import { loadTalkBindings, realTalkExec } from "./talk.js";
import { listTrustTargets } from "./trust.js";
import { usageStorePathFor } from "./usage-store.js";
import { defaultDenySources, loadDenyRules, realPortCwds, type DenySources } from "./fork-lib.js";

const execFileAsync = promisify(execFile);
const realTestExec: TestExec = (cmd, args, opts) => execFileAsync(cmd, args, opts);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(__dirname)); // server/features -> server -> repo root

const CHEAP_TICK_MS = 60_000;

// ── gatherers: real sources in, plain values out (each one owns its own try/catch) ─────────

export async function countSessionJsonlFiles(projectsDir: string): Promise<number> {
  let count = 0;
  let projDirs: Dirent[];
  try {
    projDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(join(projectsDir, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl") && isValidUuid(f.slice(0, -".jsonl".length))) count++;
    }
  }
  return count;
}

/** True when a PermissionRequest hook in settings.json runs this repo's hook: `repoHookPath`
 *  itself, or hooks/permission-request.mjs at the top of ANY worktree of the same git repository
 *  (the live ~/.alef-live and the dev checkout are two worktrees of one repo; see
 *  completeness-hook.ts). A hook from any other path (another clone, a copy) doesn't count. */
export async function readApprovalsHookInstalled(claudeDir: string, repoHookPath: string, nowMs: number = Date.now()): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(claudeDir, "settings.json"), "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
  const list = parsed.hooks.PermissionRequest;
  if (!Array.isArray(list)) return false;
  const commands: string[] = [];
  for (const group of list) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (isRecord(h) && typeof h.command === "string") commands.push(h.command);
    }
  }
  if (commands.some((c) => c.includes(repoHookPath))) return true;
  const repoRoot = dirname(dirname(repoHookPath));
  for (const script of commands.flatMap(hookScriptPaths)) {
    if (await isSameRepoHookScript(script, repoRoot, nowMs)) return true;
  }
  return false;
}

export async function nodePtyExecutable(spawnHelperPath: string): Promise<boolean | null> {
  try {
    const st = await stat(spawnHelperPath);
    return (st.mode & 0o111) !== 0;
  } catch {
    return null;
  }
}

export async function countTodoMdFiles(codeDir: string): Promise<number> {
  let projects: Dirent[];
  try {
    projects = await readdir(codeDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    try {
      await stat(join(codeDir, p.name, "tasks", "todo.md"));
      count++;
    } catch {
      // no todo.md in this project
    }
  }
  return count;
}

export async function brainIndexAge(dataDir: string, nowMs: number): Promise<{ ready: boolean; ageMs: number | null }> {
  try {
    const st = await stat(join(dataDir, "brain-index.json"));
    return { ready: true, ageMs: nowMs - st.mtimeMs };
  } catch {
    return { ready: false, ageMs: null };
  }
}

/** Distinct models the usage store has ever recorded, without a PRICE_TABLE entry. Opens its
 *  own short-lived readonly connection to usage.db (a second reader on the same WAL file the
 *  "usage" feature already writes) rather than adding an export to usage-store.ts, a file
 *  outside this package's ownership. `null` = the store doesn't exist yet (fine — "unknown",
 *  not a failure) or couldn't be read. */
export function unpricedModelsSeen(usageDbPath: string): readonly string[] | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(usageDbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT DISTINCT model FROM usage_tokens`).all() as { model: string }[];
    return rows.map((r) => r.model).filter((m) => priceForModel(m) === null);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function readMdFile(path: string): Promise<{ path: string; text: string } | null> {
  try {
    return { path, text: await readFile(path, "utf8") };
  } catch {
    return null;
  }
}

async function gatherBroken(repoRoot: string): Promise<ReturnType<typeof findBrokenLinks>> {
  const candidates = [join(repoRoot, "README.md"), join(repoRoot, "tasks", "todo.md")];
  try {
    const docsDir = join(repoRoot, "docs");
    const names = await readdir(docsDir);
    for (const n of names) if (n.endsWith(".md")) candidates.push(join(docsDir, n));
  } catch {
    // no docs dir — README/todo.md are still checked
  }
  const files = (await Promise.all(candidates.map(readMdFile))).filter((f): f is { path: string; text: string } => f !== null);
  const relFiles = files.map((f) => ({ path: relative(repoRoot, f.path), text: f.text }));
  return findBrokenLinks(
    relFiles,
    (fromFile, link) => (link.startsWith("/") ? link.slice(1) : join(dirname(fromFile), link)),
    (resolved) => existsSync(join(repoRoot, resolved)),
  );
}

/** The fields of the resident's state.json that Health reads (GET /api/resident serves the same
 *  names). Read through the resident sandbox's own reader, which never creates its home and never
 *  follows a link out of it; nothing here writes. `resident` null = no state.json yet. */
export async function readResidentForHealth(home: string): Promise<{ resident: { enabled: boolean; bornAt: string; lastReflectAt: string | null; lastError: string | null } | null; readError?: string }> {
  let text: string | null;
  try {
    text = await readInHome(home, "state.json");
  } catch (err) {
    return { resident: null, readError: err instanceof Error ? err.message : String(err) };
  }
  if (text === null) return { resident: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { resident: null, readError: "state.json isn't valid JSON" };
  }
  if (!isRecord(raw) || typeof raw.enabled !== "boolean" || typeof raw.bornAt !== "string") return { resident: null, readError: "state.json has no enabled flag or birth time" };
  return {
    resident: {
      enabled: raw.enabled,
      bornAt: raw.bornAt,
      lastReflectAt: typeof raw.lastReflectAt === "string" ? raw.lastReflectAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    },
  };
}

export function resultsPathFor(dbPath: string): string {
  return join(dirname(dbPath), "completeness-tests.json");
}

export async function readLastTestsRun(resultsPath: string): Promise<CompletenessTestsRunResult | null> {
  try {
    const raw = await readFile(resultsPath, "utf8");
    const parsed = JSON.parse(raw) as CompletenessTestsRunResult;
    if (typeof parsed.ranAtMs === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

// ── compose one CompletenessCheck from an id + its outcome ─────────────────

/** `fixId` is set only for the two checks with a real server-side action (`approvals-hook`
 *  when the toggle — not the hook itself — is the problem, and `tests`); everything else
 *  with a `fixLabel` is a client-only action (copy a command, switch tabs, call an already-
 *  public route directly) and is looked up by check id on the client, never routed here. */
function toCheck(id: CompletenessCheckId, out: CheckOutcome, fixLabel?: string, fixId?: CompletenessCheckId): CompletenessCheck {
  const meta = CHECK_META[id];
  // Every evaluator in completeness-checks.ts is fed a real, freshly-gathered input (a process
  // list, a file stat, an actual test run, launchctl output) — see this file's header. There is
  // no "reported" (told, not checked) or "guess" case in this feature, so "measured" always holds.
  const check: CompletenessCheck = { id, label: meta.label, group: meta.group, weight: meta.weight, state: out.state, detail: out.detail, confidence: "measured" };
  if (out.why !== undefined) check.why = out.why;
  if (fixLabel !== undefined && out.state !== "pass") {
    check.fixLabel = fixLabel;
    if (fixId !== undefined) check.fixId = fixId;
  }
  return check;
}

interface CompletenessDeps {
  projectsDir: string;
  claudeDir: string;
  dbPath: string;
}

/** Everything that would otherwise reach the real machine directly (a subprocess, a fixed
 *  path outside `deps`) goes through here so tests can swap in fixtures/stubs — the same
 *  pattern fork.test.ts uses for `portCwds`. Production wiring is `REAL_GATHERERS` below. */
export interface CompletenessGatherers {
  findTmux: () => Promise<string | null>;
  portCwds: Parameters<typeof loadDenyRules>[1];
  denySources: DenySources;
  buildRoutines: (now: Date) => ReturnType<typeof buildRoutines>;
  codeDir: string;
  whatsupPath: string;
  nodePtySpawnHelperPath: string;
  /** $HOME for the trust-targets check's "strictly under home" rule. */
  homeDir: string;
  /** The resident's home (its state.json is read, never written). */
  residentHome: string;
  /** The vault's graph feed (manifest.json is read, never written). */
  graphFeedDir: string;
}

export const REAL_GATHERERS: CompletenessGatherers = {
  findTmux: () => realTalkExec.findTmux(),
  portCwds: realPortCwds,
  denySources: defaultDenySources(homedir()),
  buildRoutines: (now) => buildRoutines(now),
  codeDir: DEFAULT_CODE_DIR,
  whatsupPath: DEFAULT_WHATSUP_TODOS_JSON,
  nodePtySpawnHelperPath: join(REPO_ROOT, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  homeDir: homedir(),
  residentHome: join(homedir(), ".alef-resident"),
  graphFeedDir: vaultFeedDir(),
};

export async function computeCheapChecks(ctx: FeatureContext, deps: CompletenessDeps, nowMs: number, gatherers: CompletenessGatherers, tmuxAvailable: (nowMs: number) => Promise<boolean>): Promise<CompletenessCheck[]> {
  const guarded = async (fn: () => Promise<CompletenessCheck>, id: CompletenessCheckId): Promise<CompletenessCheck> => {
    try {
      return await fn();
    } catch (err) {
      ctx.log.warn("completeness", `check "${id}" threw`, String(err));
      const meta = CHECK_META[id];
      return { id, label: meta.label, group: meta.group, weight: meta.weight, state: "unknown", detail: "Couldn't check this right now." };
    }
  };

  const repoHookPath = join(REPO_ROOT, "hooks", "permission-request.mjs");
  const dataDir = dirname(deps.dbPath);

  const [
    indexCoverage,
    liveVisible,
    approvalsHook,
    jevKey,
    tmux,
    terminalPty,
    routines,
    todoFiles,
    tests,
    brokenLinks,
    denyList,
    indexes,
    usagePrices,
    trustTargets,
    residentReflecting,
    graphFeed,
  ] = await Promise.all([
    guarded(async () => {
      const [jsonlFileCount, dbSessionCount] = [await countSessionJsonlFiles(deps.projectsDir), ctx.db.listSessions().length];
      return toCheck("index-coverage", evalIndexCoverage({ jsonlFileCount, dbSessionCount }));
    }, "index-coverage"),

    guarded(async () => {
      // An Alef launch that never started has a claude process but no transcript, so no agent:
      // it is known (the Inbox lists it as stranded), not invisible.
      const { live, unstarted } = discountUnstartedDispatches(ctx.detectLive(), loadTalkBindings(ctx.db), ctx.db.listSessions());
      const visibleLiveCwds = new Set(ctx.worldViews().agents.filter((a) => a.status === "live").map((a) => a.cwd));
      const probe = ctx.liveStatus?.();
      return toCheck("live-visible", evalLiveVisible({ live, visibleLiveCwds, unstartedDispatches: unstarted, ...(probe ? { probe } : {}) }));
    }, "live-visible"),

    guarded(async () => {
      const hookInstalled = await readApprovalsHookInstalled(deps.claudeDir, repoHookPath, nowMs);
      const enabled = ctx.db.getMeta("approvals.enabled") !== "0";
      const out = evalApprovalsHook({ hookInstalled, enabled });
      // fail: the hook isn't in settings.json → Install (preview diff) (GET then POST
      // /api/completeness/approvals-hook/install); warn: installed but toggled off → the toggle fix.
      return toCheck("approvals-hook", out, out.state === "fail" ? APPROVALS_INSTALL_LABEL : "Turn approvals ON", "approvals-hook");
    }, "approvals-hook"),

    guarded(async () => {
      const status = ctx.db.getMeta("jev_status") ?? "disabled";
      const lastTickAt = ctx.db.getMeta("jev_last_tick_at");
      const lastTickAgoMs = lastTickAt ? nowMs - Date.parse(lastTickAt) : null;
      const resolution = currentJevKeyResolution();
      const keyFrom = resolution?.tried.find((t) => t.outcome === "found")?.label ?? null;
      return toCheck("jev-key", evalJevKey({ hasKey: Boolean(process.env.TYPESAFE_API_KEY), status, lastTickAgoMs, ...(resolution ? { keyFrom, tried: describeAttempts(resolution.tried) } : {}) }));
    }, "jev-key"),

    guarded(async () => {
      const available = await tmuxAvailable(nowMs);
      return toCheck("tmux", evalTmux({ available }), "Copy install command");
    }, "tmux"),

    guarded(async () => {
      const executable = await nodePtyExecutable(gatherers.nodePtySpawnHelperPath);
      return toCheck("terminal-pty", evalTerminalPty({ executable }), "Copy rebuild command");
    }, "terminal-pty"),

    guarded(async () => {
      const list = await gatherers.buildRoutines(new Date(nowMs));
      const paused = list.filter((r) => r.loaded === false);
      const anyFailing = list.some((r) => r.loaded !== false && r.lastExitStatus !== null && r.lastExitStatus !== 0);
      return toCheck("routines", evalRoutines({ anyFailing, total: list.length, paused }), "Open Routines");
    }, "routines"),

    guarded(async () => {
      const [todoFileCount, whatsup] = await Promise.all([countTodoMdFiles(gatherers.codeDir), readWhatsupBoard(gatherers.whatsupPath)]);
      const whatsupAgeMs = whatsup.generatedAt ? nowMs - Date.parse(whatsup.generatedAt) : null;
      return toCheck("todo-files", evalTodoFiles({ todoFileCount, whatsupAgeMs }));
    }, "todo-files"),

    guarded(async () => {
      const lastRun = await readLastTestsRun(resultsPathFor(deps.dbPath));
      return toCheck("tests", evalTests({ lastRun, nowMs }), "Run tests", "tests");
    }, "tests"),

    guarded(async () => {
      const broken = await gatherBroken(REPO_ROOT);
      return toCheck("broken-links", evalBrokenLinks({ broken }));
    }, "broken-links"),

    guarded(async () => {
      const load = await loadDenyRules(gatherers.denySources, gatherers.portCwds);
      return toCheck("deny-list", evalDenyList(load.ok ? { loaded: true } : { loaded: false, error: load.error }));
    }, "deny-list"),

    guarded(async () => {
      const { ready, ageMs } = await brainIndexAge(dataDir, nowMs);
      return toCheck("indexes", evalIndexes({ ready, ageMs }), "Warm brain index");
    }, "indexes"),

    guarded(async () => {
      const unpricedModels = unpricedModelsSeen(usageStorePathFor(deps.dbPath));
      return toCheck("usage-prices", evalUsagePrices({ unpricedModels }));
    }, "usage-prices"),

    guarded(async () => {
      const targets = await listTrustTargets(ctx, gatherers.homeDir);
      const unreadable = targets.untrusted.length > 0 && targets.untrusted.every((t) => t.trust === "unknown");
      return toCheck("trust-targets", evalTrustTargets({ untrusted: unreadable ? null : targets.untrusted.length, checked: targets.checked }));
    }, "trust-targets"),

    guarded(async () => {
      const { resident, readError } = await readResidentForHealth(gatherers.residentHome);
      const out = evalResidentReflecting({ resident, ...(readError === undefined ? {} : { readError }), quietCadenceMs: REFLECT_MS * QUIET_REFLECT_FACTOR, nowMs });
      return toCheck("resident-reflecting", out);
    }, "resident-reflecting"),

    guarded(async () => {
      const raw = await readFile(join(gatherers.graphFeedDir, "manifest.json"), "utf8").catch(() => null);
      const manifest = raw === null ? null : parseManifest(raw);
      return toCheck("graph-feed", evalGraphFeed({ generatedAt: manifest ? manifest.generated : null, nowMs }));
    }, "graph-feed"),
  ]);

  const tidyPair = await guardedTidy(ctx);

  return [indexCoverage, liveVisible, approvalsHook, jevKey, tmux, terminalPty, routines, todoFiles, tests, brokenLinks, denyList, indexes, tidyPair.tidy, tidyPair.deadTmux, usagePrices, trustTargets, residentReflecting, graphFeed];
}

/** Tidy candidates for the tidy / dead-tmux checks. The candidate scan runs ps, tmux and reads
 *  the head of every small transcript, so the health tick (every 60s) keeps its own 10-minute
 *  cache instead of riding cleanup's 60s one. Any failure degrades to "unknown". */
const TIDY_CACHE_MS = 10 * 60_000;
let tidyCache: { at: number; buckets: CandidateBuckets } | null = null;
async function fetchCleanupBuckets(ctx: FeatureContext): Promise<CandidateBuckets | null> {
  if (tidyCache && Date.now() - tidyCache.at < TIDY_CACHE_MS) return tidyCache.buckets;
  try {
    const r = await loadCleanupCandidates(ctx);
    if (!r.ok) return null;
    tidyCache = { at: Date.now(), buckets: r.buckets };
    return r.buckets;
  } catch {
    return null;
  }
}

async function guardedTidy(ctx: FeatureContext): Promise<{ tidy: CompletenessCheck; deadTmux: CompletenessCheck }> {
  const buckets = await fetchCleanupBuckets(ctx);
  return {
    tidy: toCheck("tidy", evalTidy({ totalCount: buckets ? buckets.totals.count : null }), "Open Tidy up"),
    deadTmux: toCheck("dead-tmux", evalDeadTmux({ count: buckets ? buckets.tmux.length : null }), "Open Tidy up"),
  };
}

export interface CreateCompletenessOptions {
  testExec?: TestExec;
  now?: () => number;
  gatherers?: Partial<CompletenessGatherers>;
}

/** The last real recompute's checks and their own time (what snapshotExtras serves as
 *  "completeness.summary"), for the Town square's server-side workspace. Null before the first. */
let latestSummary: { generatedAt: string; checks: readonly CompletenessCheck[] } | null = null;
export function currentHealthChecks(): { generatedAt: string; checks: readonly CompletenessCheck[] } | null {
  return latestSummary;
}

/** What the Health keeper (health-keeper.ts) drives: the Run-tests button's own runner and a
 *  forced recompute, never a copy of either. */
export interface HealthHandle {
  /** The Health "Run tests" button's code path: single-flight vitest, results recorded to
   *  data/completeness-tests.json, then the cached checks dropped. */
  runTests(ctx: FeatureContext): Promise<CompletenessTestsRunResult>;
  /** Recomputes every check now (ignoring the 60s cache) and pushes the summary like a tick. */
  recompute(ctx: FeatureContext): Promise<{ checks: CompletenessCheck[]; score: number }>;
  /** When the last recorded Health test run started (ms), or null when none is recorded. */
  lastTestsRunAt(ctx: FeatureContext): Promise<number | null>;
}

export type CompletenessFeature = ServerFeature & HealthHandle;

export function createCompletenessFeature(opts: CreateCompletenessOptions = {}): CompletenessFeature {
  const testExec = opts.testExec ?? realTestExec;
  const now = opts.now ?? Date.now;
  const gatherers: CompletenessGatherers = { ...REAL_GATHERERS, ...opts.gatherers };
  let cache: { at: number; checks: CompletenessCheck[] } | null = null;
  let tmuxCache: { at: number; available: boolean } | null = null;

  /** Caches `findTmux` for CHEAP_TICK_MS, scoped to this feature instance (not module-level —
   *  a shared module cache would leak a real detection result into an unrelated test/instance
   *  that injected its own `findTmux`). */
  async function tmuxAvailable(nowMs: number): Promise<boolean> {
    if (tmuxCache && nowMs - tmuxCache.at < CHEAP_TICK_MS) return tmuxCache.available;
    const path = await gatherers.findTmux();
    tmuxCache = { at: nowMs, available: path !== null };
    return tmuxCache.available;
  }

  /** One recompute at a time: the tick, a GET, a snapshot and the Health keeper all join it. */
  let computing: Promise<CompletenessCheck[]> | null = null;
  function recompute(ctx: FeatureContext): Promise<CompletenessCheck[]> {
    if (computing) return computing;
    computing = (async () => {
      const nowMs = now();
      const deps: CompletenessDeps = { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath };
      const measured = await computeCheapChecks(ctx, deps, nowMs, gatherers, tmuxAvailable);
      const checks = withDismissals(measured, dismissalStoreFor(dismissalsPathFor(deps.dbPath)).list(nowMs), nowMs);
      cache = { at: nowMs, checks };
      latestSummary = { generatedAt: new Date(nowMs).toISOString(), checks };
      // A real recompute, not just a cache hit: push it to every open client now, so a check that
      // starts failing (or turns back to pass) reaches the Town square without waiting on a reload
      // or a WS reconnect (the only two moments a snapshot used to reach the client at all).
      ctx.emit({ kind: "summary", generatedAt: new Date(nowMs).toISOString(), checks, score: computeScore(checks) } satisfies CompletenessMessage);
      return checks;
    })().finally(() => {
      computing = null;
    });
    return computing;
  }

  async function ensureFresh(ctx: FeatureContext): Promise<CompletenessCheck[]> {
    if (cache && now() - cache.at < CHEAP_TICK_MS) return cache.checks;
    return recompute(ctx);
  }

  /** A dismissal changed: re-apply them to the cached checks and push the summary at once (no
   *  re-measure), so the Town square unpins (or re-pins) without waiting for the next tick. */
  function redecorate(ctx: FeatureContext): void {
    if (!cache) return;
    const nowMs = now();
    const checks = withDismissals(cache.checks, dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath)).list(nowMs), nowMs);
    cache = { at: cache.at, checks };
    latestSummary = { generatedAt: new Date(cache.at).toISOString(), checks };
    ctx.emit({ kind: "summary", generatedAt: new Date(cache.at).toISOString(), checks, score: computeScore(checks) } satisfies CompletenessMessage);
  }

  function installDeps(ctx: FeatureContext): InstallDeps {
    const repoHookPath = join(REPO_ROOT, "hooks", "permission-request.mjs");
    return {
      settingsPath: join(ctx.config.claudeDir, "settings.json"),
      command: approvalsHookCommand(nodeOnPath(), repoHookPath),
      isInstalled: () => readApprovalsHookInstalled(ctx.config.claudeDir, repoHookPath, now()),
      now,
    };
  }

  /** What a reader gets without waiting: the last result (stale once past the TTL, with a
   *  background recompute started), or null before the first compute ever finished. */
  function serveStale(ctx: FeatureContext): { checks: CompletenessCheck[]; at: number; stale: boolean } | null {
    if (!cache) return null;
    const stale = now() - cache.at >= CHEAP_TICK_MS;
    if (stale) void recompute(ctx).catch((err: unknown) => ctx.log.warn("completeness", "background recompute failed", String(err)));
    return { checks: cache.checks, at: cache.at, stale };
  }

  async function runTests(ctx: FeatureContext): Promise<CompletenessTestsRunResult> {
    const result = await runTestsSingleFlight(testExec, REPO_ROOT, resultsPathFor(ctx.config.dbPath), now);
    cache = null;
    return result;
  }

  /** Another feature (the Health keeper) calling in hands over ITS context; the summary push must
   *  still go out as this feature's message, so emit is re-bound to "completeness". */
  function ownCtx(ctx: FeatureContext): FeatureContext {
    if (ctx.featureId === "completeness") return ctx;
    return { ...ctx, featureId: "completeness", emit: (payload) => ctx.broadcast({ type: "feature", feature: "completeness", payload }) };
  }

  return {
    id: "completeness",
    tickIntervalMs: CHEAP_TICK_MS,
    runTests: (ctx) => runTests(ownCtx(ctx)),
    async recompute(ctx) {
      // Forced: a compute already in flight started before the caller's change, so wait it out first.
      if (computing) await computing.catch(() => undefined);
      cache = null;
      const checks = await ensureFresh(ownCtx(ctx));
      return { checks, score: computeScore(checks) };
    },
    async lastTestsRunAt(ctx) {
      return (await readLastTestsRun(resultsPathFor(ctx.config.dbPath)))?.ranAtMs ?? null;
    },
    async onTick(ctx) {
      await ensureFresh(ctx); // the TTL check inside naturally recomputes once ≥60s have passed
    },
    routes: [
      {
        method: "GET",
        path: "/api/completeness",
        async handler(_req, res, ctx) {
          // Never recompute inline when there is something to serve: a slow box made this take > 60 s.
          const served = serveStale(ctx);
          if (served) {
            respondJson(res, 200, { ok: true, generatedAt: new Date(served.at).toISOString(), checks: served.checks, score: computeScore(served.checks), stale: served.stale } satisfies CompletenessResponse);
            return;
          }
          const checks = await recompute(ctx); // the very first compute: nothing to serve yet
          respondJson(res, 200, { ok: true, generatedAt: new Date(now()).toISOString(), checks, score: computeScore(checks), stale: false } satisfies CompletenessResponse);
        },
      },
      {
        method: "POST",
        path: "/api/completeness/:checkId/fix",
        handler(_req, res, ctx, params) {
          const id = params.checkId ?? "";
          if (!isFixableCheckId(id)) return respondJson(res, 400, { ok: false, message: "No fix for this check.", error: "unknown or non-fixable check id" });
          const result = applyFix(id, ctx);
          cache = null; // the fix likely changed a check's answer; recompute on next read
          respondJson(res, result.ok ? 200 : 500, result);
        },
      },
      {
        // Dry run: the diff Install would write to settings.json. Writes nothing.
        method: "GET",
        path: "/api/completeness/approvals-hook/install",
        async handler(_req, res, ctx) {
          try {
            const plan = await previewApprovalsHookInstall(installDeps(ctx));
            respondJson(res, 200, plan); // a refused plan (bad JSON) is still a preview: status "error" says so
          } catch (err) {
            respondJson(res, 500, { ok: false, status: "error", message: `Couldn't read settings.json: ${String(err)}`, diff: [], settingsPath: installDeps(ctx).settingsPath });
          }
        },
      },
      {
        // The write: only on Health's explicit Install click (confirm:true), backup first.
        method: "POST",
        path: "/api/completeness/approvals-hook/install",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            body = null;
          }
          if (!isRecord(body) || body.confirm !== true) return respondJson(res, 400, { ok: false, status: "error", message: "Install needs confirm:true.", backupPath: null, error: "confirm required" });
          try {
            const result = await applyApprovalsHookInstall(installDeps(ctx));
            if (result.status === "installed") ctx.log.info("completeness", `installed the approvals hook${result.backupPath ? ` (backup: ${result.backupPath})` : ""}`);
            cache = null;
            respondJson(res, result.ok ? 200 : 409, result);
          } catch (err) {
            ctx.log.error("completeness", "approvals hook install failed", String(err));
            respondJson(res, 500, { ok: false, status: "error", message: `Install failed: ${String(err)}`, backupPath: null, error: String(err) });
          }
        },
      },
      {
        method: "GET",
        path: "/api/completeness/dismissals",
        handler(_req, res, ctx) {
          respondJson(res, 200, { ok: true, dismissals: dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath)).list(now()) } satisfies CheckDismissalsResponse);
        },
      },
      {
        // { kind: "snooze" | "wont-fix", days?, reason? }
        method: "POST",
        path: "/api/completeness/:checkId/dismiss",
        async handler(req, res, ctx, params) {
          const id = params.checkId ?? "";
          if (!isCheckId(id)) return respondJson(res, 400, { ok: false, dismissals: {}, error: "unknown check id" } satisfies CheckDismissalsResponse);
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            body = null;
          }
          const d = isRecord(body) ? makeDismissal(body.kind, now(), body.days, body.reason) : null;
          if (!d) return respondJson(res, 400, { ok: false, dismissals: {}, error: 'kind must be "snooze" or "wont-fix"' } satisfies CheckDismissalsResponse);
          const store = dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath));
          await store.set(id, d);
          redecorate(ctx);
          respondJson(res, 200, { ok: true, dismissals: store.list(now()) } satisfies CheckDismissalsResponse);
        },
      },
      {
        method: "POST",
        path: "/api/completeness/:checkId/undismiss",
        async handler(_req, res, ctx, params) {
          const id = params.checkId ?? "";
          if (!isCheckId(id)) return respondJson(res, 400, { ok: false, dismissals: {}, error: "unknown check id" } satisfies CheckDismissalsResponse);
          const store = dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath));
          await store.clear(id);
          redecorate(ctx);
          respondJson(res, 200, { ok: true, dismissals: store.list(now()) } satisfies CheckDismissalsResponse);
        },
      },
      {
        method: "POST",
        path: "/api/completeness/tests/run",
        async handler(_req, res, ctx) {
          const result = await runTests(ctx);
          respondJson(res, result.ok ? 200 : 500, result);
        },
      },
    ],
    snapshotExtras(ctx) {
      if (!cache) {
        // Don't block a snapshot on a fresh compute; the next tick (≤60s) fills it in.
        void ensureFresh(ctx);
        return {};
      }
      // generatedAt is this cache's own compute time (cache.at) — the server's clock, not the
      // reader's receipt time — so a page-load stamp never masquerades as when a check last ran.
      return { "completeness.summary": { generatedAt: new Date(cache.at).toISOString(), score: computeScore(cache.checks), checks: cache.checks } };
    },
  };
}

export const completenessFeature = createCompletenessFeature();

// Re-exported for the route's json parsing being visible to tests without importing the
// fixes module directly in every test file.
export { parseVitestJson };
