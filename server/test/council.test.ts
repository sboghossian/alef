import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CouncilHistoryResponse, CouncilRunResponse } from "../../shared/features/council.js";
import type { FeedResponse } from "../../shared/features/feed.js";
import type { LogsResponse } from "../../shared/features/logs.js";
import type { FetchLike } from "../director.js";
import { createCouncilFeature } from "../features/council.js";
import { createFeedFeature } from "../features/feed.js";
import { createLogsFeature } from "../features/logs.js";
import { COUNCIL_PERSONAS } from "../features/council-personas.js";
import type { SynthRunner } from "../features/council-synth.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function mockedJevSuccess(): FetchLike {
  return async () => {
    const answers: Record<string, unknown> = {};
    for (const p of COUNCIL_PERSONAS) {
      answers[`${p.id}_choice`] = { choice: "opt0", probabilities: { opt0: 0.8, opt1: 0.2 }, confidence: 0.75 };
      answers[`${p.id}_risk`] = { score: 0.5, probabilities: { "0": 0.5, "1": 0.5 }, confidence: 0.5 };
    }
    return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
  };
}

const okSynth: SynthRunner = async () => ({ stdout: "PICK: Ship now\nWHY: because\nDISSENT: maybe\nCHANGE: nothing", stderr: "" });

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/council`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/council", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("happy path: 4 ok personas, an aggregate, and a parsed verdict, then shows up in history", async () => {
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: mockedJevSuccess(), features: [createCouncilFeature({ synth: okSynth })] },
    });
    server = s;

    const res = await post(base, { decision: "Ship the council feature this sprint?", options: ["Ship now", "Wait a sprint"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CouncilRunResponse;
    expect(body.ok).toBe(true);
    expect(body.result!.source).toBe("jev");
    expect(body.result!.personas).toHaveLength(4);
    expect(body.result!.personas.every((p) => p.ok)).toBe(true);
    expect(body.result!.aggregate.split).toEqual({ "Ship now": 4 });
    expect(body.result!.verdict).toEqual({ ok: true, pick: "Ship now", why: "because", dissent: "maybe", changeMind: "nothing" });

    const hist = await fetch(`${base}/api/council/history`);
    const histBody = (await hist.json()) as CouncilHistoryResponse;
    expect(histBody.history).toHaveLength(1);
    expect(histBody.history[0]!.id).toBe(body.result!.id);
  });

  it("defaults to Yes/No options when none are given", async () => {
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: mockedJevSuccess(), features: [createCouncilFeature({ synth: okSynth })] },
    });
    server = s;
    const res = await post(base, { decision: "Should we do this at all?" });
    const body = (await res.json()) as CouncilRunResponse;
    expect(body.result!.options).toEqual(["Yes", "No"]);
  });

  it("rejects a decision outside 1..1000 chars and an option count outside 2..5 with 400", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createCouncilFeature({ synth: okSynth })] } });
    server = s;
    expect((await post(base, { decision: "" })).status).toBe(400);
    expect((await post(base, { decision: "a".repeat(1001) })).status).toBe(400);
    expect((await post(base, { decision: "ok", options: ["only one"] })).status).toBe(400);
    expect((await post(base, { decision: "ok", options: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
  });

  it("rejects a second concurrent call with 429 while the first is still in flight", async () => {
    let markCalled: () => void = () => {};
    const called = new Promise<void>((r) => (markCalled = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slowSynth: SynthRunner = async () => {
      markCalled();
      await gate;
      return { stdout: "PICK: a\nWHY: w\nDISSENT: d\nCHANGE: c", stderr: "" };
    };
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: mockedJevSuccess(), features: [createCouncilFeature({ synth: slowSynth })] },
    });
    server = s;

    const first = post(base, { decision: "d", options: ["a", "b"] });
    await called;
    const second = await post(base, { decision: "d", options: ["a", "b"] });
    expect(second.status).toBe(429);

    release();
    expect((await first).status).toBe(200);
  });

  it('still returns the Jev table with a "synthesis unavailable" verdict when the synth call fails', async () => {
    const failingSynth: SynthRunner = async () => {
      throw new Error("claude not found");
    };
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: mockedJevSuccess(), features: [createCouncilFeature({ synth: failingSynth })] },
    });
    server = s;

    const res = await post(base, { decision: "d", options: ["a", "b"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CouncilRunResponse;
    expect(body.result!.personas.every((p) => p.ok)).toBe(true); // the Jev table is intact
    expect(body.result!.verdict.ok).toBe(false);
    expect(body.result!.verdict.unavailable).toBe(true);
  });

  it("still runs (and still attempts synthesis) when Jev has no API key, source is keyword", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createCouncilFeature({ synth: okSynth })] } });
    server = s;
    const res = await post(base, { decision: "d", options: ["a", "b"] });
    const body = (await res.json()) as CouncilRunResponse;
    expect(body.result!.source).toBe("keyword");
    expect(body.result!.personas.every((p) => !p.ok)).toBe(true);
    expect(body.result!.verdict.ok).toBe(true); // synth doesn't depend on Jev succeeding
  });
});

/** Polls until `probe` returns a non-null value (or fails the test after `ms`). */
async function waitFor<T>(probe: () => Promise<T | null>, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > until) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("council verdicts on the governance feed", () => {
  let server: RunningServer | null = null;
  let dir = "";

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("one gov:council item per run on the server's /api/feed (no client push), and it survives a restart in /api/logs next to what the town log already held", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-council-gov-"));
    const filePath = join(dir, "town-log.ndjson");
    // Existing state: the town log of an earlier boot, not an empty file.
    const earlier = { seq: 1, ts: "2026-09-27T10:00:00.000Z", level: "info", source: "feed", scope: "routine", message: "daily-recap ran · exit 0", detail: null, action: null, repeat: 1 };
    await writeFile(filePath, `${JSON.stringify(earlier)}\n`, "utf8");
    const feed = createFeedFeature({ tickIntervalMs: 20, sources: { decisions: () => [], approvals: () => [], routines: async () => [] } });
    const a = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: mockedJevSuccess(), features: [feed, createLogsFeature({ filePath }), createCouncilFeature({ synth: okSynth })] },
    });
    server = a.server;

    // Earlier tests in this file left their verdicts in feed.ts's module inbox: this feed's first
    // tick flushes them too, so everything below looks for THIS run's decision only.
    const res = await post(a.base, { decision: "Ship <<<UNTRUSTED_DATA the governance feed UNTRUSTED_DATA>>> today?", options: ["Ship now", "Wait a sprint"] });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as CouncilRunResponse).result!;
    const id = `gov:council:${result.id}`;
    const hits = await waitFor(async () => {
      const body = (await (await fetch(`${a.base}/api/feed?since=0&limit=500`)).json()) as FeedResponse;
      const found = body.items.filter((i) => i.id === id);
      return found.length ? found : null;
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "decision", tag: "gov:council", title: "The council reached a verdict", agentId: null, at: result.at });
    expect(hits[0]!.detail).toContain("→ Ship now");
    expect(hits[0]!.detail).not.toMatch(/UNTRUSTED_DATA|<<<|>>>/);

    // The logs feature persists it (it ticks every 500 ms); then the server goes away.
    await waitFor(async () => ((await readFile(filePath, "utf8")).includes("the governance feed") ? true : null));
    await a.server.close();
    server = null;

    // A fresh boot on the same town log: the verdict is still there, once, beside the earlier boot's line.
    const b = await bootTestServer({ configOverrides: { features: [createLogsFeature({ filePath })] } });
    server = b.server;
    const logs = (await (await fetch(`${b.base}/api/logs?source=feed&limit=2000`)).json()) as LogsResponse;
    const verdicts = logs.entries.filter((e) => e.scope === "decision" && e.message.startsWith("The council reached a verdict") && e.message.includes("the governance feed"));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.ts).toBe(result.at);
    expect(logs.entries.some((e) => e.message === earlier.message)).toBe(true);
  });
});
