import { afterEach, describe, expect, it } from "vitest";
import type { SessionUsageError, SessionUsageResponse, UsageDayError, UsageDayResponse, UsageRangeResponse } from "../../shared/features/usage.js";
import { createUsageFeature } from "../features/usage.js";
import type { FeatureContext } from "../features/registry.js";
import type { RunningServer } from "../index.js";
import { log } from "../log.js";
import { assistantLine, bootTestServer } from "./helpers.js";

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("GET /api/usage/day", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("400s on a malformed date, same shape as replay's", async () => {
    const usageFeature = createUsageFeature();
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [usageFeature] } });
    server = s;
    const res = await fetch(`${base}/api/usage/day?date=not-a-date`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as UsageDayError).ok).toBe(false);
  });

  it("an empty/unknown day returns 200 with all-zero totals, not an error", async () => {
    const usageFeature = createUsageFeature();
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [usageFeature] } });
    server = s;
    const res = await fetch(`${base}/api/usage/day?date=2020-01-01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageDayResponse;
    expect(body).toEqual({ ok: true, date: "2020-01-01", totalCostUsd: 0, totalUnpricedTokens: 0, totalActiveMs: 0, perCity: [] });
  });

  it("reflects lines ingested through onIndexPass, priced + grouped by city, with an unpriced model counted separately", async () => {
    const usageFeature = createUsageFeature();
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [usageFeature] } });
    server = s;

    const ctx: FeatureContext = {
      db: { getIslandForCwd: () => "acme-ai-next" } as unknown as FeatureContext["db"],
      config: { projectsDir: `${dir}/projects`, dbPath: `${dir}/world.db` } as unknown as FeatureContext["config"],
      log,
      detectLive: () => new Map(),
      executors: { reactivate: () => Promise.reject(new Error("unused")), dispatch: () => Promise.reject(new Error("unused")), openEditor: () => Promise.reject(new Error("unused")) },
      broadcast: () => {},
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [{ id: "acme-ai-next", name: "ACME", path: "/ws/acme", agentCount: 1, lastActive: new Date().toISOString() }] }),
      featureId: "usage",
      emit: () => {},
    };

    const lines = [
      assistantLine({ cwd: "/ws/acme", timestamp: "2026-09-24T08:00:00.000Z", model: "claude-sonnet-5", messageId: "m1", usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
      assistantLine({ cwd: "/ws/acme", timestamp: "2026-09-24T08:05:00.000Z", model: "claude-unknown-model", messageId: "m2", usage: { inputTokens: 50, outputTokens: 0 } }),
      // Outside the requested day — must not appear.
      assistantLine({ cwd: "/ws/acme", timestamp: "2026-09-25T08:00:00.000Z", model: "claude-sonnet-5", messageId: "m3", usage: { inputTokens: 999, outputTokens: 0 } }),
    ];
    await usageFeature.onIndexPass!(ctx, new Map([["sess-1", lines]]));

    const res = await fetch(`${base}/api/usage/day?date=2026-09-24`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageDayResponse;
    expect(body.ok).toBe(true);
    expect(body.date).toBe("2026-09-24");
    expect(body.totalCostUsd).toBeCloseTo(2.0, 6); // 1M input tokens @ $2/MTok (sonnet-5)
    expect(body.totalUnpricedTokens).toBe(50); // the unknown model's tokens, never guessed at a price
    // Name resolution reads the REAL server's worldViews() (empty here, no island registered
    // there), not the fake ctx passed to onIndexPass above — falls back to the islandId itself.
    expect(body.perCity).toEqual([{ islandId: "acme-ai-next", name: "acme-ai-next", costUsd: body.totalCostUsd, unpricedTokens: 50, activeMs: expect.any(Number), sessions: 1 }]);

    // The third line (m3) landed on the next day, not this one — day 24's total above
    // already proves that boundary; day 25 gets exactly m3's own cost, nothing from m1/m2.
    const other = (await (await fetch(`${base}/api/usage/day?date=2026-09-25`)).json()) as UsageDayResponse;
    expect(other.totalCostUsd).toBeCloseTo((999 * 2.0) / 1_000_000, 9);
  });
});

describe("GET /api/usage/session/:agentId", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("400s on an invalid agent id", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createUsageFeature()] } });
    server = s;
    const res = await fetch(`${base}/api/usage/session/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as SessionUsageError).ok).toBe(false);
  });

  it("an unknown session returns 200 with all-zero totals and no models", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createUsageFeature()] } });
    server = s;
    const res = await fetch(`${base}/api/usage/session/${VALID_UUID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionUsageResponse;
    expect(body).toEqual({ ok: true, agentId: VALID_UUID, islandId: null, totalCostUsd: 0, totalUnpricedTokens: 0, activeMs: 0, models: [] });
  });
});

describe("GET /api/usage/range", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("400s on a range that is not 7, 30 or 90", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createUsageFeature()] } });
    server = s;
    for (const days of ["5", "abc", "0"]) expect((await fetch(`${base}/api/usage/range?days=${days}`)).status).toBe(400);
  });

  it("answers an empty store with zeroes and 24 hours, and defaults to 7 days", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [createUsageFeature()] } });
    server = s;
    const res = await fetch(`${base}/api/usage/range`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageRangeResponse;
    expect(body).toMatchObject({ ok: true, days: 7, models: [], perCity: [], totalCostUsd: 0 });
    expect(body.byHour).toHaveLength(24);
  });
});
