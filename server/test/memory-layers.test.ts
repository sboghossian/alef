import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryLayersSnapshotResult } from "../../shared/features/memory-layers.js";
import { createMemoryLayersFeature } from "../features/memory-layers.js";
import type { RunningServer } from "../index.js";
import { bootTestServer, writeSessionFile } from "./helpers.js";

describe("memory-layers feature — wired into a real server", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("reports real counts from the transcripts dir, memory dir, recall index and skills dir", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-mem-home-")));
    const memoryDir = join(home, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "MEMORY.md"), "the index itself, never counted");
    await writeFile(join(memoryDir, "fact.md"), "---\nmodified: 2020-01-01T00:00:00Z\n---\n✅ verified: old and stale");

    const recallDbPath = join(home, ".gstack", "memory", "sessions.db");
    await mkdir(join(home, ".gstack", "memory"), { recursive: true });
    await writeFile(recallDbPath, "x".repeat(500));

    const skillsDir = join(home, ".claude", "skills");
    await mkdir(join(skillsDir, "a-skill"), { recursive: true });
    await writeFile(
      join(skillsDir, "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: does a thing\n---\n## Known failure modes (auto-logged)\n- once broke\n",
    );

    const feature = createMemoryLayersFeature({ home, memoryDir, recallDbPath, skillsDir, pluginsCacheDir: join(home, ".claude", "plugins", "cache") });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;

    await writeSessionFile(join(boot.dir, "projects"), "-ws-p", "11111111-2222-3333-4444-555555555555", "");
    await mkdir(join(boot.dir, "projects", "-ws-p", "s2", "subagents"), { recursive: true });
    await writeFile(join(boot.dir, "projects", "-ws-p", "s2", "subagents", "sub.jsonl"), "");

    const res = (await (await fetch(`${boot.base}/api/memory-layers/snapshot`)).json()) as MemoryLayersSnapshotResult;
    expect(res.ok).toBe(true);
    expect(res.episodic.transcriptFiles).toBe(2);
    expect(res.episodic.subagentTranscriptFiles).toBe(1);
    expect(res.episodic.recallIndex).toEqual({ present: true, sizeBytes: 500, lastIndexedAt: expect.any(String) });
    expect(res.semantic.fileCount).toBe(1);
    expect(res.semantic.confidence).toEqual({ verified: 1, reported: 0, hypothesis: 0, unmarked: 0 });
    expect(res.semantic.staleCount).toBe(1);
    expect(res.procedural.skillCount).toBe(1);
    expect(res.procedural.patchedSkillCount).toBe(1);
    expect(res.procedural.patchEntryCount).toBe(1);
  });

  it("missing sources report null/empty, never invented zeros disguised as data", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-mem-empty-")));
    const feature = createMemoryLayersFeature({
      home,
      memoryDir: join(home, "no-memory-here"),
      recallDbPath: join(home, "no-recall-here", "sessions.db"),
      skillsDir: join(home, "no-skills-here"),
      pluginsCacheDir: join(home, "no-plugins-here"),
    });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;

    const res = (await (await fetch(`${boot.base}/api/memory-layers/snapshot`)).json()) as MemoryLayersSnapshotResult;
    expect(res.episodic.transcriptFiles).toBeNull(); // nothing ever wrote the temp projectsDir into existence
    expect(res.episodic.recallIndex).toEqual({ present: false, sizeBytes: null, lastIndexedAt: null });
    expect(res.semantic.fileCount).toBeNull();
    expect(res.procedural.skillCount).toBe(0);
  });
});
