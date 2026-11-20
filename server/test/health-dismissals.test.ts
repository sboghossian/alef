// FN-4: per-check "Snooze 7 days" / "Won't fix". Persisted next to the db, reversible, and only the
// places that PIN a check (Town square, the Health keeper's Inbox item) leave a dismissed one out.

import type { ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeDismissal, type CheckDismissalsResponse, type CompletenessCheck } from "../../shared/features/completeness.js";
import { createCompletenessFeature, type HealthHandle } from "../features/completeness.js";
import { dismissalsPathFor, dismissalStoreFor, makeDismissal, parseDismissals, resetDismissalStoresForTests, withDismissals } from "../features/health-dismissals.js";
import { createHealthKeeperFeature } from "../features/health-keeper.js";
import type { FeatureContext, Route } from "../features/registry.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-27T08:00:00.000Z");

function check(id: CompletenessCheck["id"], state: CompletenessCheck["state"], weight = 1): CompletenessCheck {
  return { id, label: id, group: "code", weight, state, detail: `${id} detail`, confidence: "measured" };
}

describe("dismissal values (pure)", () => {
  it("a snooze lasts 7 days by default; won't fix has no end; anything else is refused", () => {
    expect(makeDismissal("snooze", T0, undefined, undefined)).toEqual({ kind: "snooze", at: new Date(T0).toISOString(), until: new Date(T0 + 7 * DAY).toISOString(), reason: null });
    expect(makeDismissal("wont-fix", T0, 7, "  not on this Mac ")).toEqual({ kind: "wont-fix", at: new Date(T0).toISOString(), until: null, reason: "not on this Mac" });
    expect(makeDismissal("forever", T0, 7, null)).toBeNull();
  });

  it("an expired snooze no longer counts, and withDismissals strips it", () => {
    const snooze = makeDismissal("snooze", T0, 7, null);
    expect(activeDismissal(snooze, T0 + 6 * DAY)).toEqual(snooze);
    expect(activeDismissal(snooze, T0 + 7 * DAY)).toBeNull();
    const checks = [check("tests", "warn"), check("tmux", "fail")];
    const on = withDismissals(checks, { tests: snooze ?? undefined }, T0);
    expect(on[0]?.dismissed?.kind).toBe("snooze");
    expect(on[1]?.dismissed).toBeUndefined();
    expect(withDismissals(on, { tests: snooze ?? undefined }, T0 + 8 * DAY)[0]).not.toHaveProperty("dismissed");
  });

  it("parseDismissals drops unknown ids and malformed entries", () => {
    const good = makeDismissal("wont-fix", T0, 7, null);
    expect(parseDismissals(JSON.stringify({ tests: good, bogus: good, tmux: { kind: "nope" } }))).toEqual({ tests: good });
    expect(parseDismissals("not json")).toEqual({});
  });
});

// ── routes through the real completeness feature, then the keeper's Inbox item ───────────

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

async function call<T>(route: Route | undefined, ctx: FeatureContext, params: Record<string, string>, body?: unknown): Promise<{ status: number; body: T }> {
  if (!route) throw new Error("route not found");
  const { res, status, json } = fakeRes();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  await route.handler(req as never, res, ctx, params);
  return { status: status(), body: json<T>() };
}

describe("POST /api/completeness/:checkId/dismiss and /undismiss", () => {
  let dir = "";
  let ctx: FeatureContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-dismiss-"));
    resetDismissalStoresForTests();
    ctx = { config: { dbPath: join(dir, "world.db") }, log: { info: () => {}, warn: () => {}, error: () => {} }, emit: () => {} } as unknown as FeatureContext;
  });
  afterEach(async () => {
    resetDismissalStoresForTests();
    await rm(dir, { recursive: true, force: true });
  });

  const feature = createCompletenessFeature({ now: () => T0 });
  const route = (method: string, path: string): Route | undefined => feature.routes?.find((r) => r.method === method && r.path === path);

  it("snoozes, persists to data/health-dismissals.json, lists it, and undoes it", async () => {
    const snoozed = await call<CheckDismissalsResponse>(route("POST", "/api/completeness/:checkId/dismiss"), ctx, { checkId: "jev-key" }, { kind: "snooze", days: 7 });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.dismissals["jev-key"]).toMatchObject({ kind: "snooze", until: new Date(T0 + 7 * DAY).toISOString() });
    expect(JSON.parse(await readFile(dismissalsPathFor(ctx.config.dbPath), "utf8"))).toHaveProperty("jev-key");

    const listed = await call<CheckDismissalsResponse>(route("GET", "/api/completeness/dismissals"), ctx, {});
    expect(Object.keys(listed.body.dismissals)).toEqual(["jev-key"]);

    const undone = await call<CheckDismissalsResponse>(route("POST", "/api/completeness/:checkId/undismiss"), ctx, { checkId: "jev-key" });
    expect(undone.body).toEqual({ ok: true, dismissals: {} });
  });

  it("400 for an unknown check or kind", async () => {
    expect((await call(route("POST", "/api/completeness/:checkId/dismiss"), ctx, { checkId: "bogus" }, { kind: "snooze" })).status).toBe(400);
    expect((await call(route("POST", "/api/completeness/:checkId/dismiss"), ctx, { checkId: "tests" }, { kind: "later" })).status).toBe(400);
  });
});

describe("the Health keeper's Inbox item leaves dismissed checks out, reversibly", () => {
  let dir = "";
  let ctx: FeatureContext;
  const checks = [check("tests", "warn", 2), check("tmux", "pass", 2), check("trust-targets", "warn", 1)];
  const health: Pick<HealthHandle, "runTests" | "recompute" | "lastTestsRunAt"> = {
    runTests: async () => ({ ok: true, ranAtMs: 0, passed: 1, failed: 0, total: 1 }),
    recompute: async () => ({ checks, score: 40 }),
    lastTestsRunAt: async () => null,
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-dismiss-keeper-"));
    resetDismissalStoresForTests();
    ctx = { config: { dbPath: join(dir, "world.db") }, log: { info: () => {}, warn: () => {}, error: () => {} }, emit: () => {} } as unknown as FeatureContext;
  });
  afterEach(async () => {
    resetDismissalStoresForTests();
    await rm(dir, { recursive: true, force: true });
  });

  /** A keeper whose first 04:30 pass runs on the second tick. */
  async function nightPass(): Promise<ReturnType<typeof createHealthKeeperFeature>> {
    let nowMs = new Date(2026, 9, 27, 10).getTime();
    const k = createHealthKeeperFeature({ health, now: () => nowMs, currentScore: () => 40, appendFeed: () => {} });
    await k.onStart?.(ctx);
    nowMs = new Date(2026, 9, 28, 4, 30).getTime();
    await k.onTick?.(ctx);
    return k;
  }

  it("filters the item's issues, hides it once all are dismissed, and an undo brings them back", async () => {
    const k = await nightPass();
    expect(k.state().inbox?.issues.map((i) => i.id)).toEqual(["tests", "trust-targets"]);
    const store = dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath));
    const now = Date.now();
    await store.set("tests", makeDismissal("snooze", now, 7, null)!);
    expect(k.state().inbox?.issues.map((i) => i.id)).toEqual(["trust-targets"]);
    await store.set("trust-targets", makeDismissal("wont-fix", now, 7, null)!);
    expect(k.state().inbox).toBeNull();
    await store.clear("tests");
    expect(k.state().inbox?.issues.map((i) => i.id)).toEqual(["tests"]);
  });

  it("no Inbox item at all when every failing / warning check was already dismissed", async () => {
    const store = dismissalStoreFor(dismissalsPathFor(ctx.config.dbPath));
    const now = Date.now();
    await store.set("tests", makeDismissal("wont-fix", now, 7, null)!);
    await store.set("trust-targets", makeDismissal("wont-fix", now, 7, null)!);
    const k = await nightPass();
    expect(k.state().lastScore).toBe(40); // Health still measures them
    expect(k.state().inbox).toBeNull();
    await store.clear("tests");
    expect(k.state().inbox).toBeNull(); // nothing was ever filed for that night
  });
});
