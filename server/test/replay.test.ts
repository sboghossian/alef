import { afterEach, describe, expect, it } from "vitest";
import type { ReplayResponse } from "../../shared/features/replay.js";
import { createReplayFeature, replayFeature } from "../features/replay.js";
import type { RunningServer } from "../index.js";
import { assistantLine, bootTestServer, userLine, writeSessionFile } from "./helpers.js";

describe("GET /api/replay", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("400s on a malformed date", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [replayFeature] } });
    server = s;
    const res = await fetch(`${base}/api/replay?date=not-a-date`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("builds a time-ordered event feed and a report for the requested day, from raw jsonl", async () => {
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [replayFeature] } });
    server = s;
    s.db.setIslandForCwd("/ws/acme-ai-next", "acme-ai-next");

    const lines = [
      userLine({ cwd: "/ws/acme-ai-next", timestamp: "2026-09-24T08:00:00.000Z", text: "fix the header" }),
      assistantLine({
        cwd: "/ws/acme-ai-next",
        timestamp: "2026-09-24T08:00:05.000Z",
        messageId: "m1",
        toolUses: [{ name: "Edit", input: { file_path: "/ws/acme-ai-next/header.tsx" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      // Outside the requested day — must not appear in the report/events.
      assistantLine({ cwd: "/ws/acme-ai-next", timestamp: "2026-09-25T08:00:05.000Z", messageId: "m2", toolUses: [{ name: "Edit", input: { file_path: "/ws/acme-ai-next/other.tsx" } }] }),
    ].join("\n");
    const filePath = await writeSessionFile(`${dir}/projects`, "-ws-acme-ai-next", "11111111-1111-1111-1111-111111111111", lines);
    // The mtime-based file prune only looks at the requested day forward; touch it there.
    const { utimes } = await import("node:fs/promises");
    await utimes(filePath, new Date("2026-09-24T08:00:05.000Z"), new Date("2026-09-24T08:00:05.000Z"));

    const res = await fetch(`${base}/api/replay?date=2026-09-24`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayResponse;
    expect(body.ok).toBe(true);
    expect(body.date).toBe("2026-09-24");
    expect(body.truncated).toBe(false);
    expect(body.events.map((e) => e.stage)).toEqual(["hook", "tool"]);
    expect(body.events[1]!.targetObjectId).toBe("file:/ws/acme-ai-next/header.tsx");
    expect(body.events.every((e) => e.islandId === "acme-ai-next")).toBe(true);
    expect(body.report.sessions).toBe(1);
    expect(body.report.events).toBe(2);
    expect(body.report.perCity).toEqual([{ islandId: "acme-ai-next", name: "acme-ai-next", events: 2, sessions: 1 }]);
  });

  it("an empty/unknown day returns 200 with empty results, not an error", async () => {
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [replayFeature] } });
    server = s;
    const res = await fetch(`${base}/api/replay?date=2020-01-01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayResponse;
    expect(body.events).toEqual([]);
    expect(body.report.sessions).toBe(0);
  });

  it("re-parses only appended lines: a later request sees new events, old ones keep their ids", async () => {
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [createReplayFeature({ responseTtlMs: 0 })] } });
    server = s;
    const { appendFile, utimes } = await import("node:fs/promises");
    const at = new Date("2026-09-24T09:00:00.000Z");
    const first = userLine({ cwd: "/ws/a", timestamp: "2026-09-24T09:00:00.000Z", text: "first" });
    const filePath = await writeSessionFile(`${dir}/projects`, "-ws-a", "22222222-2222-2222-2222-222222222222", `${first}\n`);
    await utimes(filePath, at, at);
    const get = async (): Promise<ReplayResponse> => (await (await fetch(`${base}/api/replay?date=2026-09-24`)).json()) as ReplayResponse;
    const a = await get();
    expect(a.events.map((e) => e.summary)).toEqual(["first"]);
    // A half-written line is not consumed yet…
    await appendFile(filePath, userLine({ cwd: "/ws/a", timestamp: "2026-09-24T09:05:00.000Z", text: "second" }).slice(0, 20));
    await utimes(filePath, at, at);
    expect((await get()).events.map((e) => e.summary)).toEqual(["first"]);
    // …and is picked up whole once the writer finishes it.
    await appendFile(filePath, `${userLine({ cwd: "/ws/a", timestamp: "2026-09-24T09:05:00.000Z", text: "second" }).slice(20)}\n`);
    await utimes(filePath, at, at);
    const c = await get();
    expect(c.events.map((e) => e.summary)).toEqual(["first", "second"]);
    expect(c.events[0]!.id).toBe(a.events[0]!.id);
  });
});
