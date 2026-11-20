import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliStationSnapshotResult } from "../../shared/features/cli-station.js";
import { createCliStationFeature } from "../features/cli-station.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

describe("cli-station feature — wired into a real server", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("lists valid registry entries and counts invalid ones", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-home-")));
    const clisDir = join(home, ".claude", "clis");
    await mkdir(join(clisDir, "recall"), { recursive: true });
    await writeFile(
      join(clisDir, "recall", "cli.json"),
      JSON.stringify({
        name: "recall",
        tool: "Claude Code session transcripts",
        purpose: "Full-text search over transcripts",
        entry: "/x/recall.py",
        language: "python3",
        created: "2026-09-23",
        author: "agent",
        tests: null,
      }),
    );
    await mkdir(join(clisDir, "broken"), { recursive: true });
    await writeFile(join(clisDir, "broken", "cli.json"), "{not json");

    const feature = createCliStationFeature({ clisDir });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;

    const res = (await (await fetch(`${boot.base}/api/cli-station/snapshot`)).json()) as CliStationSnapshotResult;
    expect(res).toMatchObject({ ok: true, registryPresent: true, invalidCount: 1 });
    expect(res.clis.map((c) => c.name)).toEqual(["recall"]);
  });

  it("no registry dir yet: registryPresent false, empty list, not an error", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-none-")));
    const feature = createCliStationFeature({ clisDir: join(home, ".claude", "clis") });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;

    const res = (await (await fetch(`${boot.base}/api/cli-station/snapshot`)).json()) as CliStationSnapshotResult;
    expect(res).toMatchObject({ ok: true, registryPresent: false, clis: [], invalidCount: 0 });
  });
});
