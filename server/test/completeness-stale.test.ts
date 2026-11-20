import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletenessResponse } from "../../shared/features/completeness.js";
import { evalLiveVisible } from "../features/completeness-checks.js";
import { createCompletenessFeature } from "../features/completeness.js";
import type { FeatureContext } from "../features/registry.js";
import type { LiveStatus } from "../live-cache.js";
import { makeTempDb } from "./helpers.js";

describe("evalLiveVisible when ps couldn't be read", () => {
  it("is unknown with the reason, not a pass or a fail, when the probe failed", () => {
    const out = evalLiveVisible({ live: new Map(), visibleLiveCwds: new Set(), unstartedDispatches: 0, probe: { ok: false, error: "ps aux timed out or failed" } });
    expect(out.state).toBe("unknown");
    expect(out.why).toContain("ps aux timed out");
  });
  it("still fails when the probe worked and a process positively has no agent", () => {
    const out = evalLiveVisible({ live: new Map([["/b", 1]]), visibleLiveCwds: new Set(), unstartedDispatches: 0, probe: { ok: true, error: null } });
    expect(out.state).toBe("fail");
  });
});

describe("GET /api/completeness serves stale, never recomputes inline", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  function fakeRes(): { res: ServerResponse; body: () => CompletenessResponse } {
    let data = "";
    const res = { writeHead: () => res, end: (d: string) => void (data = d) } as unknown as ServerResponse;
    return { res, body: () => JSON.parse(data) as CompletenessResponse };
  }

  it("answers from the last result with stale:true while ONE background recompute runs", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-completeness-stale-"));
    const db = await makeTempDb(dir);
    let nowMs = Date.parse("2026-10-14T03:00:00.000Z");
    let builds = 0;
    let release: (() => void) | null = null;
    let liveStatus: LiveStatus = { ok: false, at: nowMs, durationMs: 5000, lastGoodAt: null, error: "ps aux timed out or failed" };
    const ctx = {
      db,
      featureId: "completeness",
      config: { projectsDir: join(dir, "projects"), claudeDir: join(dir, "no-claude"), dbPath: join(dir, "world.db") },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      detectLive: () => new Map<string, number>(),
      liveStatus: () => liveStatus,
      worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
      emit: () => {},
    } as unknown as FeatureContext;
    const feature = createCompletenessFeature({
      now: () => nowMs,
      gatherers: {
        findTmux: async () => null,
        portCwds: async () => new Map<number, string>(),
        denySources: { home: dir, cloudflaredConfig: join(dir, "no-cf.yml"), servicesYml: join(dir, "no-services.yml"), vault: join(dir, "no-vault") },
        buildRoutines: async () => {
          builds++;
          if (builds === 2) await new Promise<void>((r) => (release = r));
          return [];
        },
        codeDir: join(dir, "no-code-dir"),
        whatsupPath: join(dir, "no-whatsup.json"),
        nodePtySpawnHelperPath: join(dir, "no-spawn-helper"),
        residentHome: join(dir, "no-resident"),
        graphFeedDir: join(dir, "no-graph-feed"),
      },
    });
    const route = feature.routes?.find((r) => r.method === "GET" && r.path === "/api/completeness");
    if (!route) throw new Error("no GET route");
    const get = async (): Promise<CompletenessResponse> => {
      const r = fakeRes();
      await route.handler({} as never, r.res, ctx, {});
      return r.body();
    };

    const first = await get(); // cold: nothing to serve, so this one computes
    expect(first.stale).toBe(false);
    expect(builds).toBe(1);
    expect(first.checks.find((c) => c.id === "live-visible")?.state).toBe("unknown");

    nowMs += 70_000; // past the 60 s TTL
    const stale = await get();
    expect(stale.stale).toBe(true);
    expect(stale.generatedAt).toBe(first.generatedAt);
    expect(builds).toBe(2); // the background recompute started (and is held)
    const again = await get();
    expect(again.stale).toBe(true);
    expect(builds).toBe(2); // single-flight: no second recompute

    liveStatus = { ok: true, at: nowMs, durationMs: 40, lastGoodAt: nowMs, error: null };
    await new Promise((r) => setTimeout(r, 0));
    (release as (() => void) | null)?.();
    await feature.recompute(ctx).catch(() => undefined); // waits the in-flight one out
    const fresh = await get();
    expect(fresh.stale).toBe(false);
    expect(fresh.checks.find((c) => c.id === "live-visible")?.state).toBe("pass");
  });
});
