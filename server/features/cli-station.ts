// "cli-station": a small Harness-adjacent building listing agent-authored CLIs from the
// ~/.claude/clis/<name>/cli.json registry (contract: cli-station-lib.ts). View only — nothing
// here writes an entry; that's the /cli-forge skill's job, run by a different agent.
//
// GET /api/cli-station/snapshot -> CliStationSnapshotResult

import { homedir } from "node:os";
import { join } from "node:path";
import type { CliStationSnapshotResult } from "../../shared/features/cli-station.js";
import { respondJson } from "../http.js";
import { createSwr, type Swr } from "./cache-lib.js";
import { scanCliRegistry } from "./cli-station-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const SNAPSHOT_TTL_MS = 30_000;

export interface CliStationFeatureDeps {
  clisDir?: string;
}

export function createCliStationFeature(deps: CliStationFeatureDeps = {}): ServerFeature {
  const clisDir = deps.clisDir ?? join(homedir(), ".claude", "clis");
  const runtimes = new Map<string, Swr<CliStationSnapshotResult>>();

  function swrFor(ctx: FeatureContext): Swr<CliStationSnapshotResult> {
    const key = ctx.config.dbPath;
    let swr = runtimes.get(key);
    if (!swr) {
      swr = createSwr(
        async () => {
          const scan = await scanCliRegistry(clisDir);
          return { ok: true, ...scan, scannedAt: new Date().toISOString() } satisfies CliStationSnapshotResult;
        },
        { onError: (err) => ctx.log.error("cli-station", "registry scan failed", String(err)) },
      );
      runtimes.set(key, swr);
    }
    return swr;
  }

  return {
    id: "cli-station",
    routes: [
      {
        method: "GET",
        path: "/api/cli-station/snapshot",
        async handler(_req, res, ctx) {
          respondJson(res, 200, await swrFor(ctx).get(SNAPSHOT_TTL_MS));
        },
      },
    ],
  };
}

export const cliStationFeature = createCliStationFeature();
