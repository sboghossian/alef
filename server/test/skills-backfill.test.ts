import { describe, expect, it, vi } from "vitest";
import { backfillProgress, runSkillsBackfillPass } from "../features/skills-backfill.js";
import { SkillsStore } from "../features/skills-store.js";
import { assistantLine, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const CWD = "/ws/p";
const OLD_TS = "2026-01-01T00:00:00.000Z"; // well before any cutoff used below
const CUTOFF = Date.parse("2026-09-01T00:00:00.000Z");
const NEW_TS = new Date(CUTOFF).toISOString(); // exactly at the cutoff — must be skipped by backfill
const AFTER_TS = "2026-09-05T00:00:00.000Z"; // clearly after the cutoff

function skillLine(timestamp: string, skill: string): string {
  return assistantLine({ cwd: CWD, timestamp, toolUses: [{ name: "Skill", input: { skill } }] });
}

describe("runSkillsBackfillPass — backfill vs. live never double-count", () => {
  it("backfills only lines strictly before cutoffMs, leaving the line AT cutoffMs (and later) untouched", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    const body = `${skillLine(OLD_TS, "old-skill")}\n${skillLine(NEW_TS, "new-skill")}\n`;
    await writeSessionFile(dir, "-ws-p", "sess-1", body);

    await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });

    expect(store.eventsForSession("sess-1")).toEqual([{ sessionId: "sess-1", skillName: "old-skill", kind: "invoke", at: OLD_TS }]);
  });

  it("live inserting the at/after-cutoff line, plus backfill catching the before-cutoff one, never overlap or duplicate", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    const body = `${skillLine(OLD_TS, "old-skill")}\n${skillLine(AFTER_TS, "new-skill")}\n`;
    await writeSessionFile(dir, "-ws-p", "sess-2", body);

    // Simulate the live onIndexPass path having already recorded the new line (it never sees
    // the old one, since the shared indexer's byte offset for a long-lived install is already
    // past it by the time this feature exists).
    store.insertEvents([{ sessionId: "sess-2", skillName: "new-skill", kind: "invoke", at: AFTER_TS }]);

    await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });

    const events = store.eventsForSession("sess-2");
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      { sessionId: "sess-2", skillName: "old-skill", kind: "invoke", at: OLD_TS },
      { sessionId: "sess-2", skillName: "new-skill", kind: "invoke", at: AFTER_TS },
    ]);

    // Running it again (backfill_done is now set) must not re-touch anything.
    await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });
    expect(store.eventsForSession("sess-2")).toHaveLength(2);
  });

  it("is idempotent: a second pass over the same file, before backfill_done was ever set, inserts nothing new", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    await writeSessionFile(dir, "-ws-p", "sess-3", `${skillLine(OLD_TS, "grill-me")}\n`);

    const first = await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });
    expect(first.allDone).toBe(true);
    const second = await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });
    expect(second).toEqual({ filesTotal: 1, filesDone: 1, allDone: true }); // short-circuited via backfill_done
    expect(store.eventsForSession("sess-3")).toHaveLength(1);
  });

  it("subagent transcripts are backfilled too, tagged with the subagent's own agent id", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    const sessionDir = `${dir}/-ws-p/11111111-2222-3333-4444-555555555555`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(`${sessionDir}/subagents`, { recursive: true });
    await writeFile(`${sessionDir}/subagents/agent-abcd1234.jsonl`, `${skillLine(OLD_TS, "sub-skill")}\n`);

    await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });

    expect(store.eventsForSession("abcd1234")).toEqual([{ sessionId: "abcd1234", skillName: "sub-skill", kind: "invoke", at: OLD_TS }]);
  });
});

describe("runSkillsBackfillPass — a malformed line", () => {
  it("is skipped without throwing, and doesn't stop the rest of the file from being read", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    const body = `{not valid json\n${skillLine(OLD_TS, "after-the-mess")}\n`;
    await writeSessionFile(dir, "-ws-p", "sess-4", body);

    await expect(runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF })).resolves.toMatchObject({ filesTotal: 1, filesDone: 1, allDone: true });
    expect(store.eventsForSession("sess-4")).toEqual([{ sessionId: "sess-4", skillName: "after-the-mess", kind: "invoke", at: OLD_TS }]);

    // A second pass must not reprocess the malformed line either (byte offset already past it).
    await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });
    expect(store.eventsForSession("sess-4")).toHaveLength(1);
  });
});

describe("backfillProgress", () => {
  it("reports 'not started' before any pass has run", () => {
    const store = new SkillsStore(":memory:");
    expect(backfillProgress(store)).toEqual({ filesTotal: 0, filesDone: 0, percent: 0, done: false });
  });

  it("is persisted progressively (file by file), not only once at the end", async () => {
    const store = new SkillsStore(":memory:");
    const dir = await makeTempProjectsDir();
    for (let i = 0; i < 4; i++) await writeSessionFile(dir, "-ws-p", `sess-p${i}`, `${skillLine(OLD_TS, `skill-${i}`)}\n`);

    const setMetaSpy = vi.spyOn(store, "setMeta");
    const result = await runSkillsBackfillPass({ store, projectsDir: dir, cutoffMs: CUTOFF });
    expect(result).toEqual({ filesTotal: 4, filesDone: 4, allDone: true });

    const doneWrites = setMetaSpy.mock.calls.filter(([key]) => key === "backfill_files_done").map(([, value]) => value);
    // one write per file, strictly increasing — proves progress lands incrementally, not in one shot
    expect(doneWrites).toEqual(["1", "2", "3", "4"]);

    expect(backfillProgress(store)).toEqual({ filesTotal: 4, filesDone: 4, percent: 100, done: true });
  });

  it("reports a partial percentage while some files still remain (simulated via a hand-set meta snapshot)", () => {
    // runSkillsBackfillPass always finishes every file it starts in one pass (a real 750-file
    // scan is just slower, not paused) — a "mid-flight" state can only be observed the way the
    // live UI would: reading the store while a pass is still writing. That's exactly what the
    // progressive setMeta writes above are for; this checks the read side of the same contract.
    const store = new SkillsStore(":memory:");
    store.setMeta("backfill_files_total", "10");
    store.setMeta("backfill_files_done", "3");
    expect(backfillProgress(store)).toEqual({ filesTotal: 10, filesDone: 3, percent: 30, done: false });
  });
});
