// "census" feature: repo-slug resolution, the `gh pr list` tick/route wiring, single-flight
// (one gh call per 10 min, never one per request), never-report-0-on-failure, and the WS emit
// firing only when the merged count actually changes. gh, git and the subagents feature are all
// injected — no real subprocess, no real ~/.claude, ever touched.

import { describe, expect, it } from "vitest";
import type { CensusMergedSummary, CensusMessage, CensusResponse } from "../../shared/features/census.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import { createCensusFeature } from "../features/census.js";
import type { FeatureContext } from "../features/registry.js";

// census.ts keys its runtime state off ctx.config.dbPath (like every other feature in this
// codebase), so each test needs its OWN dbPath — reusing one would let one test's cached
// Runtime (module-level, by design: one server process = one dbPath) leak into the next.
let dbCounter = 0;

function fakeCtx(emitted: unknown[]): FeatureContext {
  const noop = (): void => {};
  return {
    featureId: "census",
    config: { dbPath: `test-db-${++dbCounter}` },
    emit: (p: unknown) => emitted.push(p),
    log: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as FeatureContext;
}

function fakeRes(): { res: unknown; status: () => number; body: () => string } {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
    end: (b?: string) => {
      body = b ?? "";
    },
  };
  return { res, status: () => status, body: () => body };
}

function subagent(o: { id: string; parentSessionId: string; depth: number; startedAt: string }): SubagentRecord {
  return {
    id: o.id,
    parentSessionId: o.parentSessionId,
    parentAgentId: null,
    workflowId: null,
    description: "work",
    agentType: "general-purpose",
    model: "claude-sonnet-4-6",
    status: "done",
    reason: null,
    startedAt: o.startedAt,
    lastActive: o.startedAt,
    tokens: 10,
    toolCounts: {},
    files: [],
    depth: o.depth,
  };
}

const RECORDS: SubagentRecord[] = [
  subagent({ id: "a", parentSessionId: "s1", depth: 1, startedAt: "2026-09-07T02:16:00Z" }),
  subagent({ id: "b", parentSessionId: "s2", depth: 1, startedAt: "2026-09-08T00:00:00Z" }),
];

const SHA = "abc123def4567890abc123def4567890abc1234";

function ghFixture(numbers: number[]): string {
  return JSON.stringify(
    numbers.map((n) => ({
      number: n,
      title: `upgrade #${n}`,
      mergedAt: `2026-09-2${n % 10}T10:00:00Z`,
      headRefName: `feat/x${n}`,
      headRefOid: SHA,
      body: "",
      comments: [],
    })),
  );
}

async function getCensus(feature: ReturnType<typeof createCensusFeature>, ctx: FeatureContext): Promise<CensusResponse> {
  const { res, body } = fakeRes();
  const route = feature.routes?.find((r) => r.path === "/api/census");
  await route?.handler({} as never, res as never, ctx, {});
  return JSON.parse(body()) as CensusResponse;
}

describe("census feature", () => {
  it("resolves the repo slug once, fetches gh once (not once per request), and folds subagent records into generations", async () => {
    let ghCalls = 0;
    let slugCalls = 0;
    const emitted: unknown[] = [];
    const ctx = fakeCtx(emitted);
    const feature = createCensusFeature({
      resolveRepoSlug: async () => {
        slugCalls++;
        return "sboghossian/agent-world";
      },
      runGh: async (args) => {
        ghCalls++;
        expect(args[0]).toBe("pr");
        expect(args).toContain("--repo");
        expect(args).toContain("sboghossian/agent-world");
        expect(args).toContain("merged");
        return ghFixture([35, 36, 37]);
      },
      getSubagentRecords: () => RECORDS,
      now: () => Date.parse("2026-09-28T03:30:00Z"),
    });

    const first = await getCensus(feature, ctx);
    const second = await getCensus(feature, ctx);

    expect(slugCalls).toBe(1);
    expect(ghCalls).toBe(1); // INVARIANT: one gh call, never one per request
    expect(second).toEqual(first);
    expect(first.merged).toMatchObject({
      total: 3,
      reviewRecorded: 0,
      loopMarked: 0,
      fetchedAt: new Date("2026-09-28T03:30:00Z").toISOString(),
      repo: "sboghossian/agent-world",
      error: null,
    });
    expect(first.merged.recent.map((p) => p.number).sort((a, b) => a - b)).toEqual([35, 36, 37]);
    expect(first.generations).toEqual({ total: 2, since: "2026-09-07T02:16:00.000Z", byDepth: { 1: 2 }, generations: 2, parents: 2 });

    // snapshotExtras carries the same merged summary under the documented key.
    const extras = feature.snapshotExtras?.(ctx);
    expect(extras?.["census.summary"]).toEqual(first.merged);

    // One WS emit for the one real change (0 -> 3).
    expect(emitted.filter((m) => (m as CensusMessage).kind === "merged")).toHaveLength(1);
  });

  it("a failed gh call on the FIRST fetch never reports 0 as a real number: fetchedAt stays null", async () => {
    const ctx = fakeCtx([]);
    const feature = createCensusFeature({
      resolveRepoSlug: async () => "sboghossian/agent-world",
      runGh: async () => {
        throw new Error("gh: authentication required");
      },
      getSubagentRecords: () => [],
    });
    const body = await getCensus(feature, ctx);
    expect(body.merged.fetchedAt).toBeNull(); // the honest "not fetched yet" state
    expect(body.merged.total).toBe(0);
    expect(body.merged.error).toContain("authentication required");
  });

  it("a later gh failure keeps the last GOOD list and surfaces the error, without resetting to 0", async () => {
    const emitted: unknown[] = [];
    const ctx = fakeCtx(emitted);
    let call = 0;
    const feature = createCensusFeature({
      resolveRepoSlug: async () => "sboghossian/agent-world",
      runGh: async () => {
        call++;
        if (call === 1) return ghFixture([10, 11]);
        throw new Error("gh: rate limited");
      },
      getSubagentRecords: () => [],
      now: () => Date.parse("2026-09-28T00:00:00Z"),
    });

    await feature.onTick?.(ctx); // succeeds: total 2
    const afterFirst = (feature.snapshotExtras?.(ctx)["census.summary"]) as CensusMergedSummary;
    expect(afterFirst).toMatchObject({ total: 2, error: null });
    const fetchedAtAfterFirst = afterFirst.fetchedAt;

    await feature.onTick?.(ctx); // fails: must keep total 2, not reset to 0
    const afterSecond = (feature.snapshotExtras?.(ctx)["census.summary"]) as CensusMergedSummary;
    expect(afterSecond.total).toBe(2); // never a fabricated 0
    expect(afterSecond.error).toContain("rate limited");
    expect(afterSecond.fetchedAt).toBe(fetchedAtAfterFirst); // the stamp of the last GOOD fetch

    // The WS only fired once: the count never actually changed (2 -> 2 on the failed tick).
    expect(emitted.filter((m) => (m as CensusMessage).kind === "merged")).toHaveLength(1);
  });

  it("gh timing out or returning non-JSON is a failure, not a fabricated empty list", async () => {
    const ctx = fakeCtx([]);
    let call = 0;
    const feature = createCensusFeature({
      resolveRepoSlug: async () => "sboghossian/agent-world",
      runGh: async () => {
        call++;
        if (call === 1) return ghFixture([1]);
        if (call === 2) {
          const e = new Error("Command timed out") as Error & { killed?: boolean };
          e.killed = true;
          throw e;
        }
        return "not json at all";
      },
      getSubagentRecords: () => [],
    });
    await feature.onTick?.(ctx);
    expect(((feature.snapshotExtras?.(ctx)["census.summary"]) as CensusMergedSummary).total).toBe(1);

    await feature.onTick?.(ctx); // timeout
    let s = (feature.snapshotExtras?.(ctx)["census.summary"]) as CensusMergedSummary;
    expect(s.total).toBe(1);
    expect(s.error).toContain("timed out");

    await feature.onTick?.(ctx); // non-JSON stdout
    s = (feature.snapshotExtras?.(ctx)["census.summary"]) as CensusMergedSummary;
    expect(s.total).toBe(1); // still the last good list, never silently 0
    expect(s.error).toBeTruthy();
  });

  it("no GitHub remote resolved is reported as an error, never as a merged count of 0 passed off as real", async () => {
    const ctx = fakeCtx([]);
    const feature = createCensusFeature({ resolveRepoSlug: async () => null, runGh: async () => ghFixture([1]), getSubagentRecords: () => [] });
    const body = await getCensus(feature, ctx);
    expect(body.merged.fetchedAt).toBeNull();
    expect(body.merged.repo).toBeNull();
    expect(body.merged.error).toContain("no GitHub remote");
  });

  it("REGRESSION: generations is null (never a fabricated 0) before the subagents feature has published its first pass", async () => {
    // getSubagentRecords() === null is exactly what subagents/index.ts's latestSubagentRecords()
    // returns before publish() has run once (a fresh boot; the cold pass can take seconds).
    const ctx = fakeCtx([]);
    const feature = createCensusFeature({
      resolveRepoSlug: async () => "sboghossian/agent-world",
      runGh: async () => ghFixture([1]),
      getSubagentRecords: () => null,
    });
    const body = await getCensus(feature, ctx);
    expect(body.generations).toBeNull();
  });

  it("generations is a real (possibly zero) breakdown once the subagents feature has published, distinct from 'not indexed yet'", async () => {
    const ctx = fakeCtx([]);
    const feature = createCensusFeature({
      resolveRepoSlug: async () => "sboghossian/agent-world",
      runGh: async () => ghFixture([1]),
      getSubagentRecords: () => [], // published; genuinely empty subagents.db
    });
    const body = await getCensus(feature, ctx);
    expect(body.generations).toEqual({ total: 0, since: null, byDepth: {}, generations: 0, parents: 0 });
  });
});
