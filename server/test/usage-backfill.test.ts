import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillCursorKey, runBackfillPass } from "../features/usage-backfill.js";
import { UsageStore } from "../features/usage-store.js";
import { assistantLine } from "./helpers.js";

const SID = "22222222-2222-2222-2222-222222222222";

describe("usage backfill", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function setup(lines: string[]): { store: UsageStore; projectsDir: string } {
    dir = mkdtempSync(join(tmpdir(), "alef-usage-bf-"));
    const projectsDir = join(dir, "projects");
    mkdirSync(join(projectsDir, "-ws-a"), { recursive: true });
    writeFileSync(join(projectsDir, "-ws-a", `${SID}.jsonl`), lines.join("\n") + "\n");
    return { store: new UsageStore(":memory:"), projectsDir };
  }

  it("counts historical active time even when the live cursor is already at 'now' (regression)", async () => {
    const { store, projectsDir } = setup([
      assistantLine({ cwd: "/ws/a", timestamp: "2026-09-24T08:00:00.000Z", model: "claude-sonnet-5", messageId: "m1", usage: { inputTokens: 10, outputTokens: 0 } }),
      assistantLine({ cwd: "/ws/a", timestamp: "2026-09-24T08:02:00.000Z", model: "claude-sonnet-5", messageId: "m2", usage: { inputTokens: 10, outputTokens: 0 } }),
      assistantLine({ cwd: "/ws/b", timestamp: "2026-09-24T08:03:00.000Z", model: "claude-sonnet-5", messageId: "m3", usage: { inputTokens: 10, outputTokens: 0 } }),
    ]);
    // The live path ran first and left its cursor at the present.
    store.setCursor(SID, { lastMessageId: "live", lastEventMs: Date.parse("2026-09-25T12:00:00.000Z") });
    await runBackfillPass({
      store,
      projectsDir,
      cutoffMs: Date.parse("2026-09-25T00:00:00.000Z"),
      getIslandForCwd: (cwd) => (cwd === "/ws/a" ? "a" : "b"),
    });
    const rows = store.dayTimeRows("2026-09-24");
    // 2 min in city a, then 1 min attributed to city b (not all to the first city of the day)
    expect(rows.find((r) => r.islandId === "a")?.activeMs).toBe(120_000);
    expect(rows.find((r) => r.islandId === "b")?.activeMs).toBe(60_000);
    // the live cursor is untouched; the backfill kept its own
    expect(store.getCursor(SID)).toEqual({ lastMessageId: "live", lastEventMs: Date.parse("2026-09-25T12:00:00.000Z") });
    expect(store.getCursor(backfillCursorKey(SID)).lastMessageId).toBe("m3");
  });
});
