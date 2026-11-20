// The "home" feature on a real server with a fake claude runner (the week range throughout, so a
// run just after midnight can't move the fixtures out of range): GET starts one summary for new
// facts, a summary with a number the facts don't hold is discarded, claude missing fails soft to
// facts only, the Regenerate POST skips the throttle but not the cap, and the cache survives a
// restart (data/home-digest.json).

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CensusMergedSummary, CensusPr } from "../../shared/features/census.js";
import type { DigestResponse, HomeAutomationsResponse, HomeDecisionsResponse } from "../../shared/features/home.js";
import type { PresidentLedgerEntry } from "../../shared/features/president.js";
import { createHomeFeature, type HomeSources } from "../features/home.js";
import type { ReflectRunner } from "../features/resident.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const prs: CensusPr[] = [
  { number: 70, title: "test(system-places): run the campus tests on the fixtures' clock", mergedAt: iso(NOW - 60_000), branch: "fix/x", headSha: "189a9c4", loopMarked: false, review: { recorded: false, verdict: null, model: null }, presidentPick: null, councilId: null },
];
const summary: CensusMergedSummary = { total: 1, reviewRecorded: 0, loopMarked: 0, recent: prs, fetchedAt: iso(NOW - 60_000), repo: "sboghossian/agent-world", error: null };
const ledger: PresidentLedgerEntry[] = [{ id: "loop-a68b41d0", kind: "session", action: "launch", rankedBy: "jev", proposedAt: iso(NOW - 120_000), actedAt: iso(NOW - 60_000), outcome: "dismissed" }];

function sources(over: Partial<HomeSources> = {}): Partial<HomeSources> {
  return {
    outcomes: () => [],
    censusSummary: () => summary,
    censusPrs: () => prs,
    sicknessCases: () => [],
    sicknessScanDone: () => true,
    archived: () => [],
    ledger: () => ledger,
    board: () => null,
    careerWorkers: () => null,
    routines: () => [],
    ...over,
  };
}

/** A claude `--output-format json` envelope, the shape resident-lib parseEnvelope verifies. */
function envelope(result: string, cost = 0.004): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: cost });
}

function fakeRunner(text: string): { runner: ReflectRunner; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runner: async (prompt) => {
      prompts.push(prompt);
      return { stdout: envelope(text), stderr: "", exitedOk: true };
    },
  };
}

async function getDigest(base: string, range = "week"): Promise<DigestResponse> {
  const res = await fetch(`${base}/api/home/digest?range=${range}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DigestResponse;
}

async function settle(base: string, range = "week"): Promise<DigestResponse> {
  for (let i = 0; i < 100; i++) {
    const d = await getDigest(base, range);
    if (!d.writing) return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the summary never finished");
}

describe("home feature routes", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(opts: Parameters<typeof createHomeFeature>[0]): Promise<string> {
    const dataDir = opts?.dataDir ?? (await mkdtemp(join(tmpdir(), "home-feature-")));
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createHomeFeature({ runDir: dataDir, ...opts, dataDir })] } });
    server = s;
    return base;
  }

  it("a GET writes one summary for new facts, then serves it (current) without running again", async () => {
    const fake = fakeRunner("This week Alef merged #70 into itself and 1 of Jev's proposals was dismissed; nothing else is known to have happened yet.");
    const base = await boot({ sources: sources(), runner: fake.runner });
    const first = await getDigest(base);
    expect(first.facts.alefUpgrades).toMatchObject({ ready: true, total: 1 });
    expect(first.writing).toBe(true);
    const done = await settle(base);
    expect(done.summary).toMatchObject({ current: true, costUsd: 0.004 });
    expect(done.summary!.text).toContain("#70");
    expect(done.note).toBeNull();
    expect(done.spend.todayUsd).toBeCloseTo(0.004);
    await getDigest(base);
    expect(fake.prompts).toHaveLength(1);
    // The prompt holds the facts only.
    expect(fake.prompts[0]).toContain("<<<FACTS");
    expect(fake.prompts[0]).not.toContain(done.facts.from);
  });

  it("discards a summary that names a number the facts don't hold, and says so; no retry within 30 min", async () => {
    const fake = fakeRunner("You had 12 sessions this week and shipped 40% of them, which is a great pace for you.");
    const base = await boot({ sources: sources(), runner: fake.runner });
    await getDigest(base);
    const done = await settle(base);
    expect(done.summary).toBeNull();
    expect(done.note).toMatch(/^No new summary: the summary named numbers that are not in the facts \(12, 40\)/);
    expect(done.spend.todayUsd).toBeCloseTo(0.004); // it still cost money
    await getDigest(base);
    expect(fake.prompts).toHaveLength(1);
  });

  it("fails soft when claude can't start: facts, an honest note, nothing spent", async () => {
    const runner: ReflectRunner = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    const base = await boot({ sources: sources(), runner });
    await getDigest(base);
    const done = await settle(base);
    expect(done.facts.sessions).toBeDefined();
    expect(done.summary).toBeNull();
    expect(done.note).toMatch(/claude could not be started/);
    expect(done.spend.todayUsd).toBe(0);
  });

  it("Regenerate runs now despite the throttle, answers the failure reason, and stops at the cap", async () => {
    let n = 0;
    const runner: ReflectRunner = async () => {
      n += 1;
      return { stdout: envelope(n === 1 ? "Alef merged #70 into itself this week, and 1 proposal was dismissed from Jev's board." : "This week: #70 merged into Alef. 1 proposal from Jev was dismissed.", 0.1), stderr: "", exitedOk: true };
    };
    const base = await boot({ sources: sources(), runner, capUsd: 0.2 });
    await getDigest(base);
    await settle(base);
    const post = (): Promise<Response> => fetch(`${base}/api/home/digest/summary`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ range: "week" }) });
    const again = await post();
    expect(again.status).toBe(200);
    const body = (await again.json()) as DigestResponse;
    expect(body.summary?.text).toMatch(/^This week: #70/);
    expect(n).toBe(2);
    const capped = await post(); // $0.20 spent: one more estimated run would pass the cap
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: string }).error).toMatch(/budget is used up/);
    expect(n).toBe(2);
    const bad = await fetch(`${base}/api/home/digest/summary`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ range: "year" }) });
    expect(bad.status).toBe(400);
  });

  it("keeps the cache and today's spend across a restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "home-feature-"));
    const fake = fakeRunner("Alef merged #70 into itself this week and 1 proposal was dismissed from Jev's board.");
    let base = await boot({ sources: sources(), runner: fake.runner, dataDir });
    await getDigest(base);
    await settle(base);
    await server?.close();
    server = null;
    const saved = JSON.parse(await readFile(join(dataDir, "home-digest.json"), "utf8")) as { summaries: Record<string, unknown> };
    expect(Object.keys(saved.summaries)).toEqual(["week"]);
    const second = fakeRunner("unused");
    base = await boot({ sources: sources(), runner: second.runner, dataDir });
    const d = await getDigest(base);
    expect(d.summary).toMatchObject({ current: true });
    expect(d.spend.todayUsd).toBeCloseTo(0.004);
    expect(second.prompts).toHaveLength(0);
  });

  it("rejects an unknown range", async () => {
    const base = await boot({ sources: sources(), runner: fakeRunner("x").runner });
    expect((await fetch(`${base}/api/home/digest?range=year`)).status).toBe(400);
  });

  it("serves the automations and the ledger rows", async () => {
    const base = await boot({ sources: sources(), runner: fakeRunner("x").runner });
    const autos = (await (await fetch(`${base}/api/home/automations`)).json()) as HomeAutomationsResponse;
    expect(autos).toEqual({ ok: true, ready: false, rows: [] });
    const dec = (await (await fetch(`${base}/api/home/decisions`)).json()) as HomeDecisionsResponse;
    expect(dec.ready).toBe(true);
    expect(dec.rows).toMatchObject([{ id: "loop-a68b41d0", status: "dismissed", verdict: null }]);
  });
});
