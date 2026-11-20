// The Health keeper (server/features/health-keeper.ts) on a fake clock with a stub runner: it acts
// only at 04:30 local, reruns the suite every night regardless of how fresh the last run was, posts
// one Feed line per pass and at most ONE Inbox item per local date, survives a restart, and resolves
// its item once Health reads 100. Then once with the REAL completeness feature and a stub vitest,
// to show it goes through the Run-tests button's own runner (data/completeness-tests.json).

import type { ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletenessCheck, CompletenessTestsRunResult } from "../../shared/features/completeness.js";
import { HEALTH_FIX_HINTS, isHealthKeeperState, type HealthKeeperResponse } from "../../shared/features/health-keeper.js";
import { resetTestsRunStateForTests, type TestExec } from "../features/completeness-fixes.js";
import { createCompletenessFeature, readLastTestsRun, resultsPathFor, type HealthHandle } from "../features/completeness.js";
import { feedDetail, inboxText, isDue, keeperIssues, localDateKey, nextSlotAfter, slotAtOrBefore, testsRunReason } from "../features/health-keeper-lib.js";
import { createHealthKeeperFeature, keeperStatePath, parseKeeperFile } from "../features/health-keeper.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { makeTempDb } from "./helpers.js";

const H = 3600_000;
/** Local wall-clock time (the keeper's slots are local), independent of the machine's TZ. */
const local = (d: number, h: number, m = 0): number => new Date(2026, 8, d, h, m, 0, 0).getTime(); // September

function check(id: CompletenessCheck["id"], state: CompletenessCheck["state"], weight = 1, label: string = id): CompletenessCheck {
  return { id, label, group: "code", weight, state, detail: `${id} detail`, confidence: "measured" };
}

describe("health-keeper-lib (pure)", () => {
  it("slots are local 04:30: the latest at or before now, the first strictly after", () => {
    expect(slotAtOrBefore(local(29, 4, 29))).toBe(local(28, 4, 30));
    expect(slotAtOrBefore(local(29, 4, 30))).toBe(local(29, 4, 30));
    expect(slotAtOrBefore(local(29, 23, 59))).toBe(local(29, 4, 30));
    expect(nextSlotAfter(local(29, 4, 30))).toBe(local(30, 4, 30));
    expect(nextSlotAfter(local(29, 4, 29))).toBe(local(29, 4, 30));
    expect(nextSlotAfter(local(30, 12))).toBe(new Date(2026, 9, 1, 4, 30).getTime()); // month rollover
  });

  it("due once per 04:30 after the handled slot; never due without a handled slot", () => {
    expect(isDue(null, local(29, 4, 30))).toBe(false);
    expect(isDue(local(28, 4, 30), local(29, 4, 29))).toBe(false);
    expect(isDue(local(28, 4, 30), local(29, 4, 30))).toBe(true);
    expect(isDue(local(29, 4, 30), local(29, 23))).toBe(false);
    expect(isDue(local(26, 4, 30), local(29, 9))).toBe(true); // missed nights: still one pass
  });

  it("the run reason names how long since the last one, but never decides to skip it", () => {
    expect(testsRunReason(null, local(29, 4, 30))).toBe("no Health test run recorded");
    expect(testsRunReason(local(29, 4, 30) - 21 * H, local(29, 4, 30))).toBe("last Health test run 21 h ago");
    expect(testsRunReason(local(29, 4, 30) - 19 * H, local(29, 4, 30))).toBe("last Health test run 19 h ago");
  });

  it("issues: failing before warning, heavier first, each named by what's wrong with its fix; the Inbox text names each", () => {
    const issues = keeperIssues([check("tests", "warn", 2, "Tests pass"), check("usage-prices", "warn", 1, "Every model priced"), check("tmux", "pass"), check("approvals-hook", "fail", 3, "Approvals hook installed"), check("fps", "unknown")]);
    expect(issues.map((i) => i.id)).toEqual(["approvals-hook", "tests", "usage-prices"]);
    expect(issues[1]?.fix).toBe(HEALTH_FIX_HINTS.tests);
    expect(inboxText(70, issues)).toBe(
      `Health 70%: Approvals hook isn't working — ${HEALTH_FIX_HINTS["approvals-hook"]}; Tests aren't green — ${HEALTH_FIX_HINTS.tests}; A model has no price — ${HEALTH_FIX_HINTS["usage-prices"]}`,
    );
    // ran:false can no longer be produced fresh (the keeper always reruns), but feedDetail still
    // renders it correctly for a value persisted from before that change.
    expect(feedDetail(issues, { ran: false, reason: "last Health test run 3 h ago" })).toBe(
      "tests not rerun: last Health test run 3 h ago · not passing: Approvals hook isn't working, Tests aren't green, A model has no price",
    );
    expect(localDateKey(local(29, 4, 30))).toBe("2026-09-29");
  });
});

// ── the feature, fake clock + stub runner ─────────────────────────────────────────────────────

interface Stub {
  runTests: number;
  recompute: number;
  lastTestsAt: number | null;
  checks: CompletenessCheck[];
  throwOnRecompute: boolean;
}

function stubHealth(s: Stub): Pick<HealthHandle, "runTests" | "recompute" | "lastTestsRunAt"> {
  return {
    async runTests() {
      s.runTests++;
      return { ok: true, ranAtMs: 0, passed: 4400, failed: 0, total: 4400, failedSuites: 0, success: true, exitedNonZero: false } satisfies CompletenessTestsRunResult;
    },
    async recompute() {
      s.recompute++;
      if (s.throwOnRecompute) throw new Error("boom");
      const score = Math.round((100 * s.checks.filter((c) => c.state === "pass").reduce((a, c) => a + c.weight, 0)) / s.checks.reduce((a, c) => a + c.weight, 0));
      return { checks: s.checks, score };
    },
    async lastTestsRunAt() {
      return s.lastTestsAt;
    },
  };
}

function fakeRes(): { res: ServerResponse; json: <T>() => T } {
  let body = "";
  const res = {
    writeHead() {
      return res;
    },
    end(data: string) {
      body = data;
    },
  };
  return { res: res as unknown as ServerResponse, json: <T>() => JSON.parse(body) as T };
}

async function getRoute<T>(route: Route | undefined, ctx: FeatureContext): Promise<T> {
  if (!route) throw new Error("no route");
  const { res, json } = fakeRes();
  await route.handler({} as never, res, ctx, {});
  return json<T>();
}

describe("createHealthKeeperFeature (fake clock, stub runner)", () => {
  let dir = "";
  let nowMs = 0;
  let stub: Stub;
  let feed: Array<{ id: string; title: string; detail: string | null; tag: string | null; kind: string }>;
  let emitted: unknown[];
  let score: number | null;
  let ctx: FeatureContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-keeper-"));
    nowMs = local(29, 10);
    stub = { runTests: 0, recompute: 0, lastTestsAt: local(28, 6), checks: [check("tests", "warn", 2, "Tests pass"), check("tmux", "pass", 2), check("trust-targets", "warn", 1, "Launch targets Claude hasn't trusted")], throwOnRecompute: false };
    feed = [];
    emitted = [];
    score = null;
    ctx = {
      config: { dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      emit: (p: unknown) => emitted.push(p),
    } as unknown as FeatureContext;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function keeper(): ReturnType<typeof createHealthKeeperFeature> {
    return createHealthKeeperFeature({ health: stubHealth(stub), now: () => nowMs, currentScore: () => score, appendFeed: (item) => feed.push(item) });
  }

  it("first boot: no pass at boot, not before the next 04:30; then one pass at 04:30 with a stale suite", async () => {
    const k = keeper();
    await k.onStart?.(ctx);
    expect(k.state().nextRunAt).toBe(new Date(local(30, 4, 30)).toISOString());
    const saved = parseKeeperFile(await readFile(keeperStatePath(ctx.config.dbPath), "utf8"));
    expect(saved?.lastSlotAt).toBe(new Date(local(29, 4, 30)).toISOString()); // written at boot
    await k.onTick?.(ctx);
    nowMs = local(30, 4, 29);
    await k.onTick?.(ctx);
    expect(stub).toMatchObject({ runTests: 0, recompute: 0 });
    expect(feed).toHaveLength(0);

    nowMs = local(30, 4, 30); // the suite last ran at 06:00 on the 28th: 46.5 h ago
    await k.onTick?.(ctx);
    expect(stub).toMatchObject({ runTests: 1, recompute: 1 });
    const st = k.state();
    expect(st).toMatchObject({ lastRunAt: new Date(local(30, 4, 30)).toISOString(), nextRunAt: new Date(local(31, 4, 30)).toISOString(), lastScore: 40, running: false, lastError: null });
    expect(st.lastTests).toEqual({ ran: true, reason: "last Health test run 47 h ago", ok: true, passed: 4400, failed: 0, total: 4400 });
    expect(st.lastFailing.map((i) => i.id)).toEqual(["tests", "trust-targets"]);
    expect(st.inbox).toMatchObject({ date: "2026-09-30", score: 40, resolvedAt: null });
    expect(st.inbox?.text).toBe(`Health 40%: Tests aren't green — ${HEALTH_FIX_HINTS.tests}; Launch targets Claude hasn't trusted — ${HEALTH_FIX_HINTS["trust-targets"]}`);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "decision", title: "Health: 40%", tag: "gov:health" });
    expect(isHealthKeeperState(st)).toBe(true);
    expect(emitted.some((m) => isHealthKeeperState((m as { state?: unknown }).state))).toBe(true);

    // GET /api/health-keeper serves the same state.
    const body = await getRoute<HealthKeeperResponse>(k.routes?.find((r) => r.path === "/api/health-keeper"), ctx);
    expect(body).toMatchObject({ ok: true, lastRunAt: st.lastRunAt, nextRunAt: st.nextRunAt, lastScore: 40 });
    expect(body.lastFailing.map((i) => i.id)).toEqual(["tests", "trust-targets"]);

    // Later the same morning: no second pass, no second Feed line.
    nowMs = local(30, 9);
    await k.onTick?.(ctx);
    expect(stub).toMatchObject({ runTests: 1, recompute: 1 });
    expect(feed).toHaveLength(1);
  });

  it("a daytime run followed by the nightly slot still runs the suite", async () => {
    const k = keeper();
    await k.onStart?.(ctx);
    stub.lastTestsAt = local(29, 20); // a daytime manual run, 8.5 h before the next slot
    stub.checks = [check("tests", "pass", 2), check("tmux", "pass", 2)];
    nowMs = local(30, 4, 30);
    await k.onTick?.(ctx);
    expect(stub).toMatchObject({ runTests: 1, recompute: 1 }); // reruns despite the fresh daytime run
    expect(k.state()).toMatchObject({ lastScore: 100, inbox: null, lastFailing: [] });
    expect(k.state().lastTests).toMatchObject({ ran: true, ok: true, passed: 4400, failed: 0, total: 4400 });
    expect(feed.map((f) => [f.title, f.detail])).toEqual([["Health: 100%", "tests ran: 4400 passed, 0 failing · every check passes"]]);
  });

  it("ONE Inbox item per local date: a late pass and the next 04:30 on the same date don't add a second", async () => {
    const k = keeper();
    await k.onStart?.(ctx);
    // Asleep from before the 30th's 04:30 until 00:10 on Oct 1: that slot runs late, dated Oct 1.
    nowMs = new Date(2026, 9, 1, 0, 10).getTime();
    await k.onTick?.(ctx);
    const first = k.state().inbox;
    expect(first?.date).toBe("2026-10-01");
    stub.checks = [check("tests", "warn", 2, "Tests pass"), check("tmux", "fail", 2, "tmux available")];
    nowMs = new Date(2026, 9, 1, 4, 30).getTime();
    await k.onTick?.(ctx);
    expect(stub.recompute).toBe(2);
    expect(feed).toHaveLength(2); // the Feed gets every pass
    expect(k.state().inbox).toEqual(first); // the day's item is not replaced or duplicated
    expect(k.state().lastScore).toBe(0);
    nowMs = new Date(2026, 9, 2, 4, 30).getTime();
    await k.onTick?.(ctx);
    expect(k.state().inbox).toMatchObject({ date: "2026-10-02", score: 0 }); // a new day, a new item
  });

  it("the item resolves itself once Health reads 100, and the state survives a restart", async () => {
    const k = keeper();
    await k.onStart?.(ctx);
    nowMs = local(30, 4, 30);
    await k.onTick?.(ctx);
    expect(k.state().inbox?.resolvedAt).toBeNull();
    score = 87;
    nowMs = local(30, 8);
    await k.onTick?.(ctx);
    expect(k.state().inbox?.resolvedAt).toBeNull();
    score = 100;
    nowMs = local(30, 9);
    await k.onTick?.(ctx);
    expect(k.state().inbox?.resolvedAt).toBe(new Date(local(30, 9)).toISOString());

    const again = keeper(); // a restart (deploy) later that day
    nowMs = local(30, 15);
    await again.onStart?.(ctx);
    await again.onTick?.(ctx);
    expect(stub.recompute).toBe(1); // no second pass for the same slot
    expect(again.state()).toMatchObject({ lastScore: 40, nextRunAt: new Date(local(31, 4, 30)).toISOString() });
    expect(again.state().inbox?.resolvedAt).toBe(new Date(local(30, 9)).toISOString());
  });

  it("an unreadable state file starts over from the next 04:30 (no pass at boot)", async () => {
    await writeFile(keeperStatePath(ctx.config.dbPath), "{ not json", "utf8");
    const k = keeper();
    nowMs = local(30, 12);
    await k.onStart?.(ctx);
    await k.onTick?.(ctx);
    expect(stub.recompute).toBe(0);
    expect(k.state().nextRunAt).toBe(new Date(local(31, 4, 30)).toISOString());
  });

  it("a failed pass is recorded, posts a Feed line, and is not retried every minute", async () => {
    const k = keeper();
    await k.onStart?.(ctx);
    stub.throwOnRecompute = true;
    nowMs = local(30, 4, 30);
    await k.onTick?.(ctx);
    expect(k.state()).toMatchObject({ lastError: "boom", running: false, lastRunAt: new Date(local(30, 4, 30)).toISOString() });
    expect(feed.map((f) => f.title)).toEqual(["Health: the keeper's night pass failed"]);
    nowMs = local(30, 4, 31);
    await k.onTick?.(ctx);
    expect(stub.recompute).toBe(1);
  });

  it("static guard: the keeper's code never spawns a process, writes settings or trusts a folder", async () => {
    const src = await readFile(fileURLToPath(new URL("../features/health-keeper.ts", import.meta.url)), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, ""); // its header comment names what it never does
    expect(code).not.toMatch(/child_process|execFile|spawn\(|launchctl|trust-lib|writeFolderTrust|grantFolderTrust|settings\.json|alef-live/);
  });
});

// ── through the REAL completeness feature: the Run-tests path records data/completeness-tests.json ──

describe("keeper + real completeness feature (stub vitest only)", () => {
  let dir = "";
  afterEach(async () => {
    resetTestsRunStateForTests();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("at 04:30 it runs vitest the Run-tests way, the result lands in completeness-tests.json, and the tests check reads it", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-keeper-real-"));
    const db = await makeTempDb(dir);
    let nowMs = local(29, 10);
    const calls: string[][] = [];
    const testExec: TestExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const out = args.find((a) => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
      if (out) await writeFile(out, JSON.stringify({ numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numFailedTestSuites: 0, success: true }), "utf8");
      return { stdout: "", stderr: "" };
    };
    const gatherers = {
      findTmux: async () => "/opt/homebrew/bin/tmux",
      portCwds: async () => new Map<number, string>(),
      denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
      buildRoutines: async () => [],
      codeDir: join(dir, "no-code-dir"),
      whatsupPath: join(dir, "no-whatsup.json"),
      nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
      homeDir: dir,
      residentHome: join(dir, "no-resident"),
      graphFeedDir: join(dir, "no-graph-feed"),
    };
    const health = createCompletenessFeature({ testExec, now: () => nowMs, gatherers });
    const broadcasts: Array<{ feature?: string; payload?: unknown }> = [];
    const keeperEmits: unknown[] = [];
    const feedItems: string[] = [];
    const ctx = {
      db,
      featureId: "health-keeper",
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db"), claudeJsonPath: join(dir, "no-claude.json") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
      emit: (p: unknown) => keeperEmits.push(p),
      broadcast: (m: { feature?: string; payload?: unknown }) => broadcasts.push(m),
    } as unknown as FeatureContext;
    const k = createHealthKeeperFeature({ health, now: () => nowMs, currentScore: () => null, appendFeed: (i) => feedItems.push(i.title) });
    await k.onStart?.(ctx);
    expect(await readLastTestsRun(resultsPathFor(ctx.config.dbPath))).toBeNull();

    nowMs = local(30, 4, 30);
    await k.onTick?.(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(["npx", "vitest", "run", "--reporter=json"]); // the Run-tests button's exact command
    expect(calls[0]?.[4]).toMatch(/^--outputFile=/);
    const recorded = await readLastTestsRun(resultsPathFor(ctx.config.dbPath));
    expect(recorded).toMatchObject({ ok: true, ranAtMs: local(30, 4, 30), total: 12, failed: 0 });
    expect(k.state().lastTests).toMatchObject({ ran: true, ok: true, total: 12 });
    expect(k.state().lastFailing.find((i) => i.id === "tests")).toBeUndefined(); // the fresh run passes the tests check
    // The recompute's summary still goes out as the completeness feature's own message.
    expect(broadcasts.some((b) => b.feature === "completeness" && (b.payload as { kind?: string })?.kind === "summary")).toBe(true);
    expect(keeperEmits.every((p) => (p as { kind?: string }).kind === "state")).toBe(true);
    expect(feedItems).toEqual([`Health: ${k.state().lastScore}%`]);
    db.close();
  });
});
