import type { ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { computeScore, scoreTone, type CompletenessMessage, type CompletenessTestsRunResult } from "../../shared/features/completeness.js";
import {
  evalApprovalsHook,
  evalBrokenLinks,
  evalDeadTmux,
  evalDenyList,
  evalFps,
  evalIndexCoverage,
  evalGraphFeed,
  evalIndexes,
  evalJevKey,
  evalLiveVisible,
  evalResidentReflecting,
  evalRoutines,
  evalTerminalPty,
  evalTests,
  evalTidy,
  evalTmux,
  evalTrustTargets,
  evalTodoFiles,
  evalUsagePrices,
  findBrokenLinks,
  RESIDENT_SILENT_FAIL_MS,
  residentSilentWarnMs,
} from "../features/completeness-checks.js";
import { applyFix, buildTestsError, FIXABLE_CHECK_IDS, isFixableCheckId, parseVitestJson, resetTestsRunStateForTests, runTestsSingleFlight, type TestExec } from "../features/completeness-fixes.js";
import {
  brainIndexAge,
  computeCheapChecks,
  countSessionJsonlFiles,
  countTodoMdFiles,
  createCompletenessFeature,
  readApprovalsHookInstalled,
  readLastTestsRun,
  readResidentForHealth,
  REAL_GATHERERS,
  resultsPathFor,
  unpricedModelsSeen,
} from "../features/completeness.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { QUIET_REFLECT_FACTOR, REFLECT_MS } from "../features/resident-lib.js";
import { isResidentState, type ResidentState } from "../../shared/features/resident.js";
import { makeTempDb, makeTempProjectsDir } from "./helpers.js";

// ── shared scoring math ──────────────────────────────────────────────────

describe("computeScore", () => {
  it("is the passed weight over the total weight, unknown excluded", () => {
    expect(computeScore([{ weight: 3, state: "pass" }, { weight: 2, state: "fail" }])).toBe(60); // 3/5
    expect(computeScore([{ weight: 3, state: "pass" }, { weight: 2, state: "unknown" }])).toBe(100); // 3/3
    expect(computeScore([{ weight: 1, state: "warn" }])).toBe(0);
  });

  it("returns 100 when every check is unknown (nothing measurable yet, not a failure)", () => {
    expect(computeScore([{ weight: 3, state: "unknown" }, { weight: 1, state: "unknown" }])).toBe(100);
  });

  it("returns 100 for an empty list", () => {
    expect(computeScore([])).toBe(100);
  });
});

describe("scoreTone", () => {
  it("green >= 90, yellow >= 70, pink below", () => {
    expect(scoreTone(100)).toBe("good");
    expect(scoreTone(90)).toBe("good");
    expect(scoreTone(89)).toBe("warn");
    expect(scoreTone(70)).toBe("warn");
    expect(scoreTone(69)).toBe("bad");
    expect(scoreTone(0)).toBe("bad");
  });
});

// ── pure evaluators: pass / fail / missing-input for each ───────────────────

describe("evalIndexCoverage", () => {
  it("unknown with no session files at all", () => {
    expect(evalIndexCoverage({ jsonlFileCount: 0, dbSessionCount: 0 }).state).toBe("unknown");
  });
  it("passes when every file is indexed", () => {
    expect(evalIndexCoverage({ jsonlFileCount: 10, dbSessionCount: 10 }).state).toBe("pass");
  });
  it("warns when some files aren't indexed yet", () => {
    const out = evalIndexCoverage({ jsonlFileCount: 10, dbSessionCount: 7 });
    expect(out.state).toBe("warn");
    expect(out.detail).toContain("3 not yet indexed");
  });
});

describe("evalLiveVisible", () => {
  it("passes with no live processes", () => {
    expect(evalLiveVisible({ live: new Map(), visibleLiveCwds: new Set(), unstartedDispatches: 0 }).state).toBe("pass");
  });
  it("passes when every live cwd has a visible agent", () => {
    expect(evalLiveVisible({ live: new Map([["/a", 1]]), visibleLiveCwds: new Set(["/a"]), unstartedDispatches: 0 }).state).toBe("pass");
  });
  it("fails when a live process has no visible agent", () => {
    const out = evalLiveVisible({ live: new Map([["/a", 1], ["/b", 1]]), visibleLiveCwds: new Set(["/a"]), unstartedDispatches: 0 });
    expect(out.state).toBe("fail");
    expect(out.detail).toBe("1 of 2 live claude processes have no visible agent.");
    expect(out.why).toContain("/b");
  });
  it("counts processes, not folders", () => {
    expect(evalLiveVisible({ live: new Map([["/h", 2]]), visibleLiveCwds: new Set(["/h"]), unstartedDispatches: 0 }).detail).toBe("2 live claude processes, all visible.");
  });
  it("passes when the only unseen processes are Alef launches that never started, and says so", () => {
    const out = evalLiveVisible({ live: new Map([["/a", 1]]), visibleLiveCwds: new Set(["/a"]), unstartedDispatches: 2 });
    expect(out.state).toBe("pass");
    expect(out.detail).toBe("1 live claude process, all visible. 2 more are Alef launches that never started (see Inbox).");
  });
  it("a launch that never started doesn't excuse another, unseen process", () => {
    const out = evalLiveVisible({ live: new Map([["/b", 1]]), visibleLiveCwds: new Set(), unstartedDispatches: 1 });
    expect(out.state).toBe("fail");
    expect(out.why).toContain("/b");
  });
});

describe("evalApprovalsHook", () => {
  it("fails when the hook isn't configured", () => {
    expect(evalApprovalsHook({ hookInstalled: false, enabled: true }).state).toBe("fail");
  });
  it("warns when the hook is installed but the toggle is off", () => {
    expect(evalApprovalsHook({ hookInstalled: true, enabled: false }).state).toBe("warn");
  });
  it("passes when both are true", () => {
    expect(evalApprovalsHook({ hookInstalled: true, enabled: true }).state).toBe("pass");
  });
});

describe("evalJevKey", () => {
  it("fails with no key", () => {
    expect(evalJevKey({ hasKey: false, status: "disabled", lastTickAgoMs: null }).state).toBe("fail");
  });
  it("warns when the key is set but status isn't online", () => {
    expect(evalJevKey({ hasKey: true, status: "fallback", lastTickAgoMs: 1000 }).state).toBe("warn");
  });
  it("warns when it hasn't ticked recently", () => {
    expect(evalJevKey({ hasKey: true, status: "online", lastTickAgoMs: 4 * 60_000 }).state).toBe("warn");
  });
  it("passes when online and ticking", () => {
    expect(evalJevKey({ hasKey: true, status: "online", lastTickAgoMs: 5000 }).state).toBe("pass");
  });
  it("never receives the key's value, only whether one is set", () => {
    // Structural guarantee: the input type has no room for the key text at all.
    const out = evalJevKey({ hasKey: true, status: "online", lastTickAgoMs: 0 });
    expect(JSON.stringify(out)).not.toContain("sk-");
  });
});

describe("evalTrustTargets (Launch targets Claude hasn't trusted)", () => {
  it("warns with the count while any district folder is untrusted, passes at zero, unknown when unreadable or empty", () => {
    expect(evalTrustTargets({ untrusted: 3, checked: 20 })).toMatchObject({ state: "warn", detail: "3 of 20 district folders aren't trusted by Claude: a launch there waits on the trust dialog." });
    expect(evalTrustTargets({ untrusted: 0, checked: 20 })).toMatchObject({ state: "pass" });
    expect(evalTrustTargets({ untrusted: null, checked: 20 }).state).toBe("unknown");
    expect(evalTrustTargets({ untrusted: 0, checked: 0 }).state).toBe("unknown");
  });
});

describe("evalTmux / evalTerminalPty", () => {
  it("tmux: unknown/fail/pass", () => {
    expect(evalTmux({ available: null }).state).toBe("unknown");
    expect(evalTmux({ available: false }).state).toBe("fail");
    expect(evalTmux({ available: true }).state).toBe("pass");
  });
  it("terminal-pty: unknown/fail/pass", () => {
    expect(evalTerminalPty({ executable: null }).state).toBe("unknown");
    expect(evalTerminalPty({ executable: false }).state).toBe("fail");
    expect(evalTerminalPty({ executable: true }).state).toBe("pass");
  });
});

describe("evalRoutines / evalTodoFiles", () => {
  it("routines: unknown with none found, warn with a failure, pass otherwise", () => {
    expect(evalRoutines({ anyFailing: false, total: 0 }).state).toBe("unknown");
    expect(evalRoutines({ anyFailing: true, total: 3 }).state).toBe("warn");
    expect(evalRoutines({ anyFailing: false, total: 3 }).state).toBe("pass");
  });
  it("todo-files: warns with none found or a stale/missing whatsup board", () => {
    expect(evalTodoFiles({ todoFileCount: 0, whatsupAgeMs: 0 }).state).toBe("warn");
    expect(evalTodoFiles({ todoFileCount: 2, whatsupAgeMs: null }).state).toBe("warn");
    expect(evalTodoFiles({ todoFileCount: 2, whatsupAgeMs: 40 * 3600_000 }).state).toBe("warn");
    expect(evalTodoFiles({ todoFileCount: 2, whatsupAgeMs: 3600_000 }).state).toBe("pass");
  });
});

describe("evalTests", () => {
  it("unknown when never run", () => {
    expect(evalTests({ lastRun: null, nowMs: 0 }).state).toBe("unknown");
  });
  it("fails on any failing test regardless of age", () => {
    expect(evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 1, total: 10 }, nowMs: 1000 }).state).toBe("fail");
  });
  it("warns when the last clean run is stale", () => {
    expect(evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 10 }, nowMs: 30 * 3600_000 }).state).toBe("warn");
  });
  it("passes on a clean, recent run", () => {
    expect(evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 10 }, nowMs: 3600_000 }).state).toBe("pass");
  });
  it("at 04:30 + 2 min, before the new run finishes, the check still passes (last night's run is only 24h02m old)", () => {
    const out = evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 10 }, nowMs: 24 * 3600_000 + 2 * 60_000 });
    expect(out.state).toBe("pass");
    expect(out.detail).toBe("10 tests passed, run < 25h ago.");
  });
  it("at 25 h + 1 min it warns", () => {
    const out = evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 10 }, nowMs: 25 * 3600_000 + 60_000 });
    expect(out.state).toBe("warn");
    expect(out.detail).toBe("Last run 25h ago — run again to be sure.");
  });
  it("fails, never passes, on a run that produced no results (the real data/completeness-tests.json of 2026-09-28)", () => {
    const lastRun = { ok: false, ranAtMs: 1790560951156, passed: 0, failed: 0, total: 0, error: "couldn't parse vitest's json output" };
    const out = evalTests({ lastRun, nowMs: 1790560951156 + 60_000 });
    expect(out.state).toBe("fail");
    expect(out.detail).toBe("The last Health test run didn't produce results.");
    expect(out.why).toBe("couldn't parse vitest's json output");
  });
  it("warns when a run reported zero tests", () => {
    const out = evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 0 }, nowMs: 1000 });
    expect(out.state).toBe("warn");
    expect(out.detail).toBe("The last Health test run found no tests.");
  });
  it("fails when a test file failed to load, though every test it counted passed (real vitest 5.0.1 run: exit 1, success:false)", () => {
    const out = evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 2, failedSuites: 1, success: false, exitedNonZero: true }, nowMs: 1000 });
    expect(out.state).toBe("fail");
    expect(out.detail).toBe("1 test suite failed (a file that didn't load, or a failing hook).");
  });
  it("fails when vitest exited non-zero on a report that says success:true (an unhandled error)", () => {
    const out = evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 4, failedSuites: 0, success: true, exitedNonZero: true }, nowMs: 1000 });
    expect(out.state).toBe("fail");
    expect(out.detail).toBe("vitest exited non-zero though no test failed (an unhandled error, or the run was cut short).");
  });
  it("fails when vitest's own verdict is success:false", () => {
    expect(evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 3, success: false }, nowMs: 1000 }).state).toBe("fail");
  });
  it("still passes a clean, recent run that exited 0", () => {
    expect(evalTests({ lastRun: { ok: true, ranAtMs: 0, failed: 0, total: 3, failedSuites: 0, success: true, exitedNonZero: false }, nowMs: 1000 }).state).toBe("pass");
  });
});

describe("evalGraphFeed", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("passes inside 3 h, warns past it or without a build time, and is unknown with no feed", () => {
    expect(evalGraphFeed({ generatedAt: "2026-10-27T11:20:00Z", nowMs: now })).toEqual({ state: "pass", detail: "Graph feed built 40 min ago." });
    expect(evalGraphFeed({ generatedAt: "2026-10-27T09:00:00Z", nowMs: now }).state).toBe("pass");
    const stale = evalGraphFeed({ generatedAt: "2026-10-27T08:00:00Z", nowMs: now });
    expect(stale.state).toBe("warn");
    expect(stale.detail).toBe("Graph feed built 4 h ago; it is rebuilt hourly.");
    expect(evalGraphFeed({ generatedAt: "", nowMs: now }).state).toBe("warn");
    expect(evalGraphFeed({ generatedAt: null, nowMs: now }).state).toBe("unknown");
  });
});

describe("evalBrokenLinks / evalDenyList / evalIndexes / evalUsagePrices / evalTidy / evalDeadTmux / evalFps", () => {
  it("broken-links", () => {
    expect(evalBrokenLinks({ broken: [] }).state).toBe("pass");
    expect(evalBrokenLinks({ broken: [{ file: "README.md", link: "x.md" }] }).state).toBe("warn");
  });
  it("deny-list", () => {
    expect(evalDenyList({ loaded: true }).state).toBe("pass");
    expect(evalDenyList({ loaded: false, error: "boom" }).state).toBe("fail");
  });
  it("indexes", () => {
    expect(evalIndexes({ ready: false, ageMs: null }).state).toBe("warn");
    expect(evalIndexes({ ready: true, ageMs: 25 * 3600_000 }).state).toBe("warn");
    expect(evalIndexes({ ready: true, ageMs: 1000 }).state).toBe("pass");
  });
  it("usage-prices", () => {
    expect(evalUsagePrices({ unpricedModels: null }).state).toBe("unknown");
    expect(evalUsagePrices({ unpricedModels: [] }).state).toBe("pass");
    expect(evalUsagePrices({ unpricedModels: ["mystery-model"] }).state).toBe("warn");
  });
  it("tidy / dead-tmux: unknown until P2 supplies a real count", () => {
    expect(evalTidy({ totalCount: null }).state).toBe("unknown");
    expect(evalTidy({ totalCount: 5 }).state).toBe("pass");
    expect(evalTidy({ totalCount: 30 }).state).toBe("warn");
    expect(evalDeadTmux({ count: null }).state).toBe("unknown");
    expect(evalDeadTmux({ count: 0 }).state).toBe("pass");
    expect(evalDeadTmux({ count: 2 }).state).toBe("warn");
  });
  it("fps", () => {
    expect(evalFps({ medianFps: null }).state).toBe("unknown");
    expect(evalFps({ medianFps: 55 }).state).toBe("pass");
    expect(evalFps({ medianFps: 20 }).state).toBe("warn");
  });
});

// ── findBrokenLinks (pure) ────────────────────────────────────────────────

describe("findBrokenLinks", () => {
  const exists = (p: string): boolean => p === "docs/VIEWS.md" || p === "README.md";

  it("ignores external URLs, mailto and bare anchors", () => {
    const files = [{ path: "README.md", text: "[a](https://x.com) [b](mailto:x@y.com) [c](#section)" }];
    expect(findBrokenLinks(files, (from, link) => link, exists)).toEqual([]);
  });

  it("flags a relative link that doesn't resolve", () => {
    const files = [{ path: "README.md", text: "[missing](docs/NOPE.md)" }];
    const broken = findBrokenLinks(files, (_from, link) => link, exists);
    expect(broken).toEqual([{ file: "README.md", link: "docs/NOPE.md" }]);
  });

  it("passes a relative link that resolves, and strips #fragments/?query before checking", () => {
    const files = [{ path: "README.md", text: "[ok](docs/VIEWS.md#section) [ok2](docs/VIEWS.md?x=1)" }];
    expect(findBrokenLinks(files, (_from, link) => link, exists)).toEqual([]);
  });
});

// ── real-source gatherers (all fixture-backed, no real ~/.claude) ───────────

describe("readApprovalsHookInstalled", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function withSettings(json: unknown): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-"));
    if (json !== undefined) await writeFile(join(dir, "settings.json"), typeof json === "string" ? json : JSON.stringify(json), "utf8");
    return dir;
  }

  it("false when settings.json is absent", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-"));
    expect(await readApprovalsHookInstalled(dir, "/repo/hooks/permission-request.mjs")).toBe(false);
  });

  it("false when settings.json is malformed JSON", async () => {
    const d = await withSettings("{ not json");
    expect(await readApprovalsHookInstalled(d, "/repo/hooks/permission-request.mjs")).toBe(false);
  });

  it("false when the hook points at a different repo's checkout", async () => {
    const d = await withSettings({ hooks: { PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: "node /elsewhere/agent-world/hooks/permission-request.mjs" }] }] } });
    expect(await readApprovalsHookInstalled(d, "/repo/hooks/permission-request.mjs")).toBe(false);
  });

  it("true when the hook points at this repo", async () => {
    const d = await withSettings({ hooks: { PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: "node /repo/hooks/permission-request.mjs", timeout: 70 }] }] } });
    expect(await readApprovalsHookInstalled(d, "/repo/hooks/permission-request.mjs")).toBe(true);
  });

  it("false when hooks exist but not under PermissionRequest", async () => {
    const d = await withSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/repo/hooks/permission-request.mjs" }] }] } });
    expect(await readApprovalsHookInstalled(d, "/repo/hooks/permission-request.mjs")).toBe(false);
  });
});

describe("countSessionJsonlFiles / countTodoMdFiles / brainIndexAge / unpricedModelsSeen", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("counts only <uuid>.jsonl files, one level under each project dir", async () => {
    dir = await makeTempProjectsDir();
    const proj = join(dir, "-Users-x-repo");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "11111111-1111-1111-1111-111111111111.jsonl"), "", "utf8");
    await writeFile(join(proj, "not-a-uuid.jsonl"), "", "utf8");
    await mkdir(join(proj, "22222222-2222-2222-2222-222222222222"), { recursive: true }); // a session's subagents dir, not a file
    expect(await countSessionJsonlFiles(dir)).toBe(1);
  });

  it("returns 0 for a missing projects dir", async () => {
    expect(await countSessionJsonlFiles(join(tmpdir(), "does-not-exist-aw"))).toBe(0);
  });

  it("counts tasks/todo.md across immediate project dirs", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-code-"));
    await mkdir(join(dir, "proj-a", "tasks"), { recursive: true });
    await writeFile(join(dir, "proj-a", "tasks", "todo.md"), "# todo", "utf8");
    await mkdir(join(dir, "proj-b"), { recursive: true }); // no tasks/todo.md
    expect(await countTodoMdFiles(dir)).toBe(1);
  });

  it("brainIndexAge: not ready when the file is missing, ready+aged when present", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-data-"));
    expect((await brainIndexAge(dir, Date.now())).ready).toBe(false);
    await writeFile(join(dir, "brain-index.json"), "{}", "utf8");
    const result = await brainIndexAge(dir, Date.now() + 5000);
    expect(result.ready).toBe(true);
    expect(result.ageMs).not.toBeNull();
  });

  it("unpricedModelsSeen: null when the usage db doesn't exist", () => {
    expect(unpricedModelsSeen(join(tmpdir(), "does-not-exist-usage.db"))).toBeNull();
  });

  it("unpricedModelsSeen: filters distinct models through the price table", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-usage-"));
    const dbPath = join(dir, "usage.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE usage_tokens (date TEXT, island_id TEXT, session_id TEXT, model TEXT)`);
    db.prepare(`INSERT INTO usage_tokens VALUES (?, ?, ?, ?)`).run("2026-09-25", "x", "s1", "claude-opus-5-5");
    db.prepare(`INSERT INTO usage_tokens VALUES (?, ?, ?, ?)`).run("2026-09-25", "x", "s2", "some-mystery-model");
    // Claude Code's own placeholder on turns it writes itself (API errors, "No response requested.")
    db.prepare(`INSERT INTO usage_tokens VALUES (?, ?, ?, ?)`).run("2026-09-24", "x", "s3", "<synthetic>");
    db.close();
    expect(unpricedModelsSeen(dbPath)).toEqual(["some-mystery-model"]); // <synthetic> is priced ($0), not reported
  });
});

describe("resultsPathFor / readLastTestsRun", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("sits beside the world db", () => {
    expect(resultsPathFor("/x/data/world.db")).toBe("/x/data/completeness-tests.json");
  });

  it("null when missing or malformed, the parsed result otherwise", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-tests-run-"));
    const p = join(dir, "completeness-tests.json");
    expect(await readLastTestsRun(p)).toBeNull();
    await writeFile(p, "not json", "utf8");
    expect(await readLastTestsRun(p)).toBeNull();
    const result: CompletenessTestsRunResult = { ok: true, ranAtMs: 123, passed: 9, failed: 1, total: 10 };
    await writeFile(p, JSON.stringify(result), "utf8");
    expect(await readLastTestsRun(p)).toEqual(result);
  });
});

// ── completeness-fixes.ts: parseVitestJson, single-flight, the allowlist ────

// Real vitest 5.0.1 `--reporter=json` reports (2026-09-28, throwaway projects), testResults trimmed
// to the failing file. Both runs exited 1 with nothing on stderr.
//  - IMPORT_FAILED: ok.test.ts (2 passing tests) + broken.test.ts importing a module that is gone.
//  - UNHANDLED_ERROR: 4 passing tests, one of which leaks `setTimeout(() => { throw … })`.
const REAL_SNAPSHOT = { added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0, didUpdate: false };
const IMPORT_FAILED_REPORT = JSON.stringify({
  numTotalTestSuites: 2, numPassedTestSuites: 1, numFailedTestSuites: 1, numPendingTestSuites: 0, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  snapshot: REAL_SNAPSHOT, startTime: 1790563104232, success: false,
  testResults: [{ assertionResults: [], startTime: 1790563104232, endTime: 1790563104232, status: "failed", message: "Cannot find module './gone.js' imported from /private/tmp/vt-a/broken.test.ts", name: "/private/tmp/vt-a/broken.test.ts" }],
});
const UNHANDLED_ERROR_REPORT = JSON.stringify({
  numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  snapshot: REAL_SNAPSHOT, startTime: 1790563104666, success: true, testResults: [],
});

describe("parseVitestJson", () => {
  it("parses a clean summary and derives passed and success from the counts when absent", () => {
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 10, numFailedTests: 2 }))).toEqual({ total: 10, passed: 8, failed: 2, failedSuites: 0, success: false });
  });
  it("skips leading noise before the first {", () => {
    expect(parseVitestJson(`warming up...\n${JSON.stringify({ numTotalTests: 1, numFailedTests: 0, numPassedTests: 1 })}`)).toEqual({ total: 1, passed: 1, failed: 0, failedSuites: 0, success: true });
  });
  it("carries failed suites and vitest's own verdict: a file that failed to import has no failed test", () => {
    expect(parseVitestJson(IMPORT_FAILED_REPORT)).toEqual({ total: 2, passed: 2, failed: 0, failedSuites: 1, success: false });
  });
  it("null on unparseable input", () => {
    expect(parseVitestJson("")).toBeNull();
    expect(parseVitestJson("nope")).toBeNull();
  });
});

describe("runTestsSingleFlight", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
    resetTestsRunStateForTests();
  });

  // vitest 5.0.1's real --reporter=json report header (agent-world's own run, 2026-09-28).
  const report = (over: { numTotalTests: number; numPassedTests: number; numFailedTests: number }): string =>
    JSON.stringify({ numTotalTestSuites: 812, numPassedTestSuites: 812, numFailedTestSuites: 0, numPendingTestSuites: 0, ...over, numPendingTests: 0, numTodoTests: 0, startTime: 1790560951839, success: over.numFailedTests === 0, testResults: [] });

  /** The --outputFile=<path> the runner passed, or null. */
  function outputFileOf(args: readonly string[]): string | null {
    const a = args.find((x) => x.startsWith("--outputFile="));
    return a ? a.slice("--outputFile=".length) : null;
  }

  /** Behaves like vitest 5: the report goes to --outputFile; stdout only ever carries one
   *  "JSON report written to …" line (with no --outputFile, vitest writes .vitest/json/output.json). */
  function vitest5(body: string, exitCode = 0, onCall: (args: readonly string[]) => void = () => {}): TestExec {
    return async (_cmd, args) => {
      onCall(args);
      const out = outputFileOf(args) ?? "/repo/.vitest/json/output.json";
      if (outputFileOf(args)) await writeFile(out, body, "utf8");
      const stdout = `JSON report written to ${out}\n`;
      if (exitCode !== 0) throw Object.assign(new Error(`Command failed: npx vitest run (exit ${exitCode})`), { stdout, stderr: "" });
      return { stdout, stderr: "" };
    };
  }

  it("a second call while one is running gets the same promise (one exec call)", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const resultsPath = join(dir, "completeness-tests.json");
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = vitest5(report({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 }));
    const exec: TestExec = async (cmd, args, opts) => {
      calls++;
      await gate;
      return inner(cmd, args, opts);
    };
    const p1 = runTestsSingleFlight(exec, "/repo", resultsPath);
    const p2 = runTestsSingleFlight(exec, "/repo", resultsPath);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ ok: true, total: 3, failed: 0, passed: 3 });
  });

  it("reads vitest 5's report from the --outputFile it names, in a fresh temp dir it removes afterwards", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const resultsPath = join(dir, "completeness-tests.json");
    let argv: readonly string[] = [];
    const result = await runTestsSingleFlight(vitest5(report({ numTotalTests: 2305, numPassedTests: 2305, numFailedTests: 0 }), 0, (a) => (argv = a)), "/repo", resultsPath);
    expect(result).toMatchObject({ ok: true, total: 2305, passed: 2305, failed: 0 });
    expect(argv.slice(0, 3)).toEqual(["vitest", "run", "--reporter=json"]);
    const out = outputFileOf(argv);
    expect(out).not.toBeNull();
    expect(out?.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dirname(out ?? "/"))).toBe(false);
  });

  it("writes the result to resultsPath and allows a new run afterwards", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const resultsPath = join(dir, "completeness-tests.json");
    await runTestsSingleFlight(vitest5(report({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 })), "/repo", resultsPath);
    expect(await readLastTestsRun(resultsPath)).toMatchObject({ ok: true, total: 1 });
    let secondCalls = 0;
    await runTestsSingleFlight(vitest5(report({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1 }), 1, () => secondCalls++), "/repo", resultsPath);
    expect(secondCalls).toBe(1);
    expect(await readLastTestsRun(resultsPath)).toMatchObject({ ok: true, total: 2, failed: 1 });
  });

  it("a run with failing tests (vitest exits 1) still reads the report it wrote", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const result = await runTestsSingleFlight(vitest5(report({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 2 }), 1), "/repo", join(dir, "completeness-tests.json"));
    expect(result).toMatchObject({ ok: true, total: 5, failed: 2, passed: 3 });
  });

  it("a clean run records that vitest exited 0", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const result = await runTestsSingleFlight(vitest5(report({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 })), "/repo", join(dir, "completeness-tests.json"));
    expect(result).toMatchObject({ ok: true, total: 3, failed: 0, failedSuites: 0, success: true, exitedNonZero: false });
  });

  it("a test file that fails to import (exit 1, 0 failed tests) never reads as a pass", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const resultsPath = join(dir, "completeness-tests.json");
    const result = await runTestsSingleFlight(vitest5(IMPORT_FAILED_REPORT, 1), "/repo", resultsPath);
    expect(result).toMatchObject({ ok: true, total: 2, passed: 2, failed: 0, failedSuites: 1, success: false, exitedNonZero: true });
    const lastRun = await readLastTestsRun(resultsPath);
    expect(evalTests({ lastRun, nowMs: result.ranAtMs + 60_000 }).state).toBe("fail");
  });

  it("an unhandled error (exit 1, but the report says success:true) never reads as a pass", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const resultsPath = join(dir, "completeness-tests.json");
    const result = await runTestsSingleFlight(vitest5(UNHANDLED_ERROR_REPORT, 1), "/repo", resultsPath);
    expect(result).toMatchObject({ ok: true, total: 4, failed: 0, failedSuites: 0, success: true, exitedNonZero: true });
    const lastRun = await readLastTestsRun(resultsPath);
    expect(evalTests({ lastRun, nowMs: result.ranAtMs + 60_000 }).state).toBe("fail");
  });

  it("vitest 5 printing only 'JSON report written to …' on stdout, and no report at --outputFile, is ok:false", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const exec: TestExec = async () => ({ stdout: "JSON report written to /repo/.vitest/json/output.json\n", stderr: "" });
    const result = await runTestsSingleFlight(exec, "/repo", join(dir, "completeness-tests.json"));
    expect(result).toMatchObject({ ok: false, total: 0, error: "vitest wrote no json report" });
  });

  it("json on stdout alone is never taken as the result (the report file is the only source)", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const exec: TestExec = async () => ({ stdout: report({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 }), stderr: "" });
    const result = await runTestsSingleFlight(exec, "/repo", join(dir, "completeness-tests.json"));
    expect(result.ok).toBe(false);
  });

  it("an exec that fails before writing a report is ok:false carrying its error", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const exec: TestExec = async () => {
      throw new Error("spawn npx ENOENT");
    };
    const result = await runTestsSingleFlight(exec, "/repo", join(dir, "completeness-tests.json"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("no report at --outputFile falls back to stdout/stderr for the error text (still ok:false)", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-run-tests-"));
    const exec: TestExec = async () => {
      throw Object.assign(new Error("Command failed"), {
        stdout: "JSON report written to /repo/.vitest/json/output.json\nFAIL  server/test/mac.test.ts > screenshot saves\n",
        stderr: "Error: something crashed before the reporter finished\n",
      });
    };
    const result = await runTestsSingleFlight(exec, "/repo", join(dir, "completeness-tests.json"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("FAIL  server/test/mac.test.ts > screenshot saves");
    expect(result.error).toContain("something crashed before the reporter finished");
  });
});

describe("buildTestsError", () => {
  it("puts failing-test-looking lines from stdout/stderr first, then the stderr tail", () => {
    const stdout = "some setup noise\nFAIL  a/b.test.ts > thing one\n";
    const stderr = "✗ c/d.test.ts > thing two\nunhandled rejection: boom\n";
    const err = buildTestsError(stdout, stderr, null);
    expect(err.indexOf("FAIL  a/b.test.ts > thing one")).toBeLessThan(err.indexOf("unhandled rejection: boom"));
    expect(err).toContain("✗ c/d.test.ts > thing two");
    expect(err).toContain("unhandled rejection: boom");
  });

  it("falls back to the exec error (or a fixed message) when nothing looks like a failing test", () => {
    expect(buildTestsError("plain stdout", "", null)).toBe("vitest wrote no json report");
    expect(buildTestsError("", "", new Error("spawn npx ENOENT"))).toBe("Error: spawn npx ENOENT");
  });

  it("caps the result at 1500 chars", () => {
    const hugeStderr = "x".repeat(5000);
    const err = buildTestsError("", hugeStderr, new Error("boom"));
    expect(err.length).toBe(1500);
    expect(err.endsWith("…")).toBe(true);
  });
});

describe("the fix allowlist", () => {
  it("only approvals-hook is fixable today", () => {
    expect(FIXABLE_CHECK_IDS.has("approvals-hook")).toBe(true);
    expect(isFixableCheckId("approvals-hook")).toBe(true);
    expect(isFixableCheckId("tests")).toBe(false);
    expect(isFixableCheckId("bogus")).toBe(false);
  });

  it("applyFix on a non-fixable id returns ok:false without touching ctx", () => {
    const calls: unknown[] = [];
    const ctx = { db: { setMeta: (...args: unknown[]) => calls.push(args) } } as unknown as FeatureContext;
    const result = applyFix("jev-key", ctx); // a real CompletenessCheckId, just not in FIXABLE_CHECK_IDS
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("applyFix('approvals-hook') sets the same meta key/value the real settings route writes", () => {
    const calls: unknown[] = [];
    const ctx = { db: { setMeta: (...args: unknown[]) => calls.push(args) } } as unknown as FeatureContext;
    const result = applyFix("approvals-hook", ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["approvals.enabled", "1"]]);
  });
});

// ── route-level: unknown fix id -> 400, and computeCheapChecks never leaks a secret ─────────

function fakeRes(): { res: ServerResponse; status: () => number; json: <T>() => T } {
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    end(data: string) {
      body = data;
    },
  };
  return { res: res as unknown as ServerResponse, status: () => statusCode, json: <T>() => JSON.parse(body) as T };
}

async function call<T>(route: Route | undefined, ctx: FeatureContext, params: Record<string, string>): Promise<{ status: number; body: T }> {
  if (!route) throw new Error("route not found");
  const { res, status, json } = fakeRes();
  await route.handler({} as never, res, ctx, params);
  return { status: status(), body: json<T>() };
}

describe("POST /api/completeness/:checkId/fix", () => {
  it("400 for an id that isn't fixable", async () => {
    const feature = createCompletenessFeature();
    const route = feature.routes?.find((r) => r.path === "/api/completeness/:checkId/fix");
    const ctx = { db: { setMeta: () => {} } } as unknown as FeatureContext;
    const { status, body } = await call<{ ok: boolean }>(route, ctx, { checkId: "not-a-real-check" });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });
});

describe("computeCheapChecks: live-visible on the real 2026-09-28 process list", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("three Alef launches that never started are known (Inbox), not invisible", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-live-"));
    const db = await makeTempDb(dir);
    const HOME = "/Users/alexboghossian";
    const CODE = `${HOME}/Documents/Code`;
    // talk.bindings as GET /api/world served it; liveClaudeCwds() as ps + lsof saw it (5 claude, 4 cwds).
    db.setMeta(
      "talk.bindings",
      JSON.stringify([
        { agentId: null, tmuxName: "aw-68597ce4", cwd: `${CODE}/acme-www`, startedAt: "2026-09-26T08:33:12.168Z" },
        { agentId: null, tmuxName: "aw-5c67d47b", cwd: `${CODE}/legal-taxonomy`, startedAt: "2026-09-28T01:56:07.790Z" },
        { agentId: null, tmuxName: "aw-e10a9ec9", cwd: `${CODE}/agent-world`, startedAt: "2026-09-28T01:56:14.429Z" },
      ]),
    );
    const live = new Map([
      [HOME, 2],
      [`${CODE}/acme-www`, 1],
      [`${CODE}/legal-taxonomy`, 1],
      [`${CODE}/agent-world`, 1],
    ]);
    const ctx = {
      db,
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => live,
      worldViews: () => ({ agents: [{ cwd: HOME, status: "live" }, { cwd: HOME, status: "live" }], objects: [], edges: [], islands: [] }),
    } as unknown as FeatureContext;
    const gatherers = {
      ...REAL_GATHERERS,
      findTmux: async () => null,
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      residentHome: join(dir, "no-resident"),
      graphFeedDir: join(dir, "no-graph-feed"),
    };
    const checks = await computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, Date.now(), gatherers, async () => false);
    const check = checks.find((c) => c.id === "live-visible");
    expect(check).toMatchObject({ state: "pass", detail: "2 live claude processes, all visible. 3 more are Alef launches that never started (see Inbox)." });
    db.close();
  });
});

describe("computeCheapChecks never leaks the Jev key's value", () => {
  let dir = "";
  const prevKey = process.env.TYPESAFE_API_KEY;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prevKey;
  });

  it("the fake key text never appears anywhere in the response JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-full-"));
    process.env.TYPESAFE_API_KEY = "sk-fake-secret-should-never-leak";
    const db = await makeTempDb(dir);
    const ctx = {
      db,
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
    } as unknown as FeatureContext;
    const gatherers = {
      ...REAL_GATHERERS,
      findTmux: async () => null,
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      residentHome: join(dir, "no-resident"),
      graphFeedDir: join(dir, "no-graph-feed"),
    };
    const checks = await computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, Date.now(), gatherers, async () => false);
    expect(checks.length).toBe(18);
    expect(JSON.stringify(checks)).not.toContain("sk-fake-secret-should-never-leak");
    const jevCheck = checks.find((c) => c.id === "jev-key");
    expect(jevCheck?.state).toBe("warn"); // key is set (fake), but no "online" status meta in this fresh temp db
  });

  it("tidy/dead-tmux go through P2's real GET /api/cleanup/candidates (guarded) and never throw", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-tidy-"));
    const db = await makeTempDb(dir);
    const ctx = {
      db,
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
    } as unknown as FeatureContext;
    const gatherers = {
      ...REAL_GATHERERS,
      findTmux: async () => null,
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      residentHome: join(dir, "no-resident"),
      graphFeedDir: join(dir, "no-graph-feed"),
    };
    const checks = await computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, Date.now(), gatherers, async () => false);
    const tidy = checks.find((c) => c.id === "tidy");
    const deadTmux = checks.find((c) => c.id === "dead-tmux");
    // Real P2 module in this repo: it may answer "unknown" (its own gathering hit something
    // in this fake ctx it doesn't like) or a real pass/warn — either is fine here. What
    // matters is it never throws and never returns something outside the valid state set.
    expect(["pass", "warn", "fail", "unknown"]).toContain(tidy?.state);
    expect(["pass", "warn", "fail", "unknown"]).toContain(deadTmux?.state);
  });
});

describe("createCompletenessFeature: a real recompute reaches an already-open client, not just a boot/reconnect snapshot", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  function fakeGatherers(dir: string) {
    return {
      findTmux: async () => null,
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      residentHome: join(dir, "no-resident"),
      graphFeedDir: join(dir, "no-graph-feed"),
    };
  }

  it("onTick ctx.emit()s a 'summary' on a real recompute, stamped with the server's own clock — and stays quiet on a cache hit", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-emit-"));
    const db = await makeTempDb(dir);
    const emitted: unknown[] = [];
    let nowMs = Date.parse("2026-09-28T10:00:00.000Z");
    const ctx = {
      db,
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
      emit: (payload: unknown) => emitted.push(payload),
    } as unknown as FeatureContext;
    const feature = createCompletenessFeature({ now: () => nowMs, gatherers: fakeGatherers(dir) });

    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "summary", generatedAt: new Date(nowMs).toISOString() } satisfies Partial<CompletenessMessage>);
    const first = emitted[0] as CompletenessMessage;
    expect(first.checks.length).toBe(18); // 15 + trust-targets + resident-reflecting + graph-feed

    // A second tick a few seconds later — well inside the 60s cache TTL — serves the cache and
    // must NOT emit again: "on each real recompute", not "every tick" (that would be a live
    // update firing every 10s for no reason — its own kind of noise).
    nowMs += 5_000;
    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(1);

    // snapshotExtras (the boot GET /api/world + WS-connect path) carries the SAME server-stamped
    // generatedAt (cache.at) as the emitted message — not the reader's own clock at receipt time.
    const extras = feature.snapshotExtras?.(ctx);
    expect(extras?.["completeness.summary"]).toMatchObject({ generatedAt: new Date(nowMs - 5_000).toISOString() });

    // 60s later, the tick actually recomputes and emits a second time.
    nowMs += 60_000;
    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ generatedAt: new Date(nowMs).toISOString() });
  });
});

// ── resident-reflecting: the resident's journal must not go silent unnoticed ──────────────────

/** GET /api/resident as it answered at 2026-09-28T03:21Z, during the silent period (vision-plan.json
 *  records these values as measured: lastReflectAt, lastError, spend). The journal/proposal text is
 *  neutral; every field of the real shape is present (isResidentState checks it below). */
const SILENT_0928: ResidentState = {
  name: "Alef resident",
  enabled: true,
  bornAt: "2026-09-26T15:48:45.059Z",
  day: 2,
  lastTickAt: "2026-09-28T03:20:09.084Z",
  lastReflectAt: "2026-09-27T22:30:30Z",
  lastError: "invalid reflection, nothing written: withdraw ids must look like rp-xxxx-0",
  goals: ["Track live/waiting counts hourly"],
  skills: [],
  journalTail: ["- 02:44 · tripwires: 1 repeated lesson"],
  recentWrites: [{ at: "2026-09-28T02:54:22.853Z", path: "state.json", bytes: 4025, reason: "after reflection" }],
  proposals: [{ id: "rp-mujcab30-0", at: "2026-09-27T04:49:33.852Z", kind: "note", title: "Define 'waiting on Alex'", why: "blocks baselining", status: "dismissed" }],
  spend: { todayUsd: 0.1037, capUsd: 0.5 },
};
/** The same resident healthy again (GET /api/resident at 2026-09-28T11:51Z). */
const HEALTHY_1151: ResidentState = { ...SILENT_0928, lastTickAt: "2026-09-28T11:51:55.964Z", lastReflectAt: "2026-09-28T11:23:31.873Z", lastError: null, spend: { todayUsd: 0.2758, capUsd: 0.5 } };
const QUIET = REFLECT_MS * QUIET_REFLECT_FACTOR; // 3 h, the resident's own cadence
const at = (iso: string): number => Date.parse(iso);

describe("evalResidentReflecting (real /api/resident shapes)", () => {
  it("the fixtures are the real wire shape", () => {
    expect(isResidentState(SILENT_0928)).toBe(true);
    expect(isResidentState(HEALTHY_1151)).toBe(true);
  });

  it("warns max(4 h, 1.5 x the quiet cadence) after the last reflection and fails after 12 h", () => {
    expect(QUIET).toBe(3 * 3_600_000);
    expect(residentSilentWarnMs(QUIET)).toBe(4.5 * 3_600_000);
    expect(residentSilentWarnMs(2 * 3_600_000)).toBe(4 * 3_600_000); // the 4 h floor
    expect(RESIDENT_SILENT_FAIL_MS).toBe(12 * 3_600_000);
  });

  it("fires on the 09-28 silent period: warn at 03:21Z (lastError + 4 h 51 min), still warn at 06:00Z, fail past 12 h", () => {
    const at0321 = evalResidentReflecting({ resident: SILENT_0928, quietCadenceMs: QUIET, nowMs: at("2026-09-28T03:21:00Z") });
    expect(at0321.state).toBe("warn");
    expect(at0321.detail).toBe("Last reflection 4 h 51 min ago. Last error: invalid reflection, nothing written: withdraw ids must look like rp-xxxx-0");
    expect(evalResidentReflecting({ resident: SILENT_0928, quietCadenceMs: QUIET, nowMs: at("2026-09-28T06:00:00Z") }).state).toBe("warn");
    const late = evalResidentReflecting({ resident: SILENT_0928, quietCadenceMs: QUIET, nowMs: at("2026-09-28T10:31:00Z") });
    expect(late.state).toBe("fail");
    expect(late.detail).toMatch(/^Last reflection 12 h 1 min ago: silent for over 12 h\. Last error: invalid reflection/);
  });

  it("with no error it passes up to the limit and warns past it", () => {
    const quiet = { ...SILENT_0928, lastError: null };
    expect(evalResidentReflecting({ resident: quiet, quietCadenceMs: QUIET, nowMs: at("2026-09-28T02:59:00Z") }).state).toBe("pass"); // 4 h 29 min
    const past = evalResidentReflecting({ resident: quiet, quietCadenceMs: QUIET, nowMs: at("2026-09-28T03:01:00Z") });
    expect(past).toMatchObject({ state: "warn", detail: "Last reflection 4 h 31 min ago, past its 4 h 30 min limit." });
    expect(evalResidentReflecting({ resident: HEALTHY_1151, quietCadenceMs: QUIET, nowMs: at("2026-09-28T11:51:55Z") })).toMatchObject({ state: "pass", detail: "Last reflection 28 min ago." });
  });

  it("any lastError warns even right after a reflection (the daily cap included)", () => {
    const capped = { ...HEALTHY_1151, lastError: "over the daily cap ($0.503 of $0.50): reflection skipped" };
    expect(evalResidentReflecting({ resident: capped, quietCadenceMs: QUIET, nowMs: at("2026-09-28T11:30:00Z") })).toMatchObject({ state: "warn", detail: "Last reflection 6 min ago. Last error: over the daily cap ($0.503 of $0.50): reflection skipped" });
  });

  it("never reflected: judged from its birth; switched off, missing or unreadable is unknown, never a pass", () => {
    const newborn = { ...HEALTHY_1151, bornAt: "2026-09-28T11:00:00Z", lastReflectAt: null };
    expect(evalResidentReflecting({ resident: newborn, quietCadenceMs: QUIET, nowMs: at("2026-09-28T12:00:00Z") }).state).toBe("unknown");
    expect(evalResidentReflecting({ resident: newborn, quietCadenceMs: QUIET, nowMs: at("2026-09-28T16:00:00Z") })).toMatchObject({ state: "warn", detail: "No reflection yet, born 5 h ago, past its 4 h 30 min limit." });
    expect(evalResidentReflecting({ resident: newborn, quietCadenceMs: QUIET, nowMs: at("2026-09-29T00:00:00Z") }).state).toBe("fail");
    expect(evalResidentReflecting({ resident: { ...SILENT_0928, enabled: false }, quietCadenceMs: QUIET, nowMs: at("2026-09-29T00:00:00Z") }).state).toBe("unknown");
    expect(evalResidentReflecting({ resident: null, quietCadenceMs: QUIET, nowMs: 0 })).toMatchObject({ state: "unknown", detail: "No resident state yet (no state.json in its home)." });
    expect(evalResidentReflecting({ resident: null, readError: "state.json isn't valid JSON", quietCadenceMs: QUIET, nowMs: 0 }).detail).toBe("Couldn't read the resident's state: state.json isn't valid JSON");
    expect(evalResidentReflecting({ resident: { ...SILENT_0928, lastReflectAt: "garbage", bornAt: "also garbage" }, quietCadenceMs: QUIET, nowMs: 0 }).state).toBe("unknown");
  });

  it("a reflection stamped in the future (clock skew) counts as just now", () => {
    expect(evalResidentReflecting({ resident: { ...HEALTHY_1151, lastReflectAt: "2026-09-28T12:10:00Z" }, quietCadenceMs: QUIET, nowMs: at("2026-09-28T12:00:00Z") })).toMatchObject({ state: "pass", detail: "Last reflection 0 min ago." });
  });
});

describe("readResidentForHealth + the wired check (state.json read-only)", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reads an existing state.json without writing anything, and says why when it can't", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-resident-health-"));
    const home = join(dir, "resident");
    expect(await readResidentForHealth(home)).toEqual({ resident: null }); // no home yet: nothing created
    expect(existsSync(home)).toBe(false);
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(home, "state.json"), "{ not json");
    expect(await readResidentForHealth(home)).toEqual({ resident: null, readError: "state.json isn't valid JSON" });
    // The persisted file carries more fields than Health reads (tripwires, waitEvents, …).
    await writeFile(join(home, "state.json"), JSON.stringify({ version: 1, ...SILENT_0928, lastReflectAttemptAt: "2026-09-28T02:54:22.853Z", tripwires: [], waitEvents: [] }));
    expect(await readResidentForHealth(home)).toEqual({ resident: { enabled: true, bornAt: SILENT_0928.bornAt, lastReflectAt: SILENT_0928.lastReflectAt, lastError: SILENT_0928.lastError } });
  });

  it("computeCheapChecks carries resident-reflecting from the state.json it finds", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-resident-wired-"));
    const home = join(dir, "resident");
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(home, "state.json"), JSON.stringify({ version: 1, ...SILENT_0928 }));
    const db = await makeTempDb(dir);
    const ctx = {
      db,
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
    } as unknown as FeatureContext;
    const gatherers = {
      ...REAL_GATHERERS,
      findTmux: async () => null,
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      residentHome: home,
    };
    const checks = await computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, at("2026-09-28T03:21:00Z"), gatherers, async () => false);
    expect(checks.find((c) => c.id === "resident-reflecting")).toMatchObject({ label: "The resident is reflecting", group: "routines", weight: 2, state: "warn", confidence: "measured" });
    db.close();
  });
});
