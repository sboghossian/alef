import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STALE_DAYS,
  classifyConfidence,
  countJsonlFiles,
  countKnownFailureModeEntries,
  frontmatterField,
  isStale,
  readRecallIndexStats,
  scanSemanticMemory,
  scanSkillPatches,
} from "../features/memory-layers-lib.js";

/** Root reads and writes through chmod 000/444 (a container, CI as root): those cases can't fail there. */
const AS_ROOT = process.getuid?.() === 0;

async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe("classifyConfidence", () => {
  it("mirrors memory-claim-lint.py's classify(): verified, then hypothesis, then reported, else unmarked", () => {
    expect(classifyConfidence("✅ verified: ran `git status`")).toBe("verified");
    expect(classifyConfidence("this is Verified by hand")).toBe("verified");
    expect(classifyConfidence("🧪 hypothesis, untested")).toBe("hypothesis");
    expect(classifyConfidence("this is likely true")).toBe("hypothesis");
    expect(classifyConfidence("📣 reported by Sam")).toBe("reported");
    expect(classifyConfidence("Alex said it works")).toBe("reported");
    expect(classifyConfidence("just a plain note with no marker")).toBe("unmarked");
    // verified wins over a hypothesis marker in the same text (same precedence as the python)
    expect(classifyConfidence("🧪 hypothesis, now ✅ verified")).toBe("verified");
  });
});

describe("frontmatterField", () => {
  it("reads a scalar field from the --- block, quoted or not", () => {
    expect(frontmatterField("---\nmodified: 2026-09-17T13:13:38.671Z\n---\nbody", "modified")).toBe("2026-09-17T13:13:38.671Z");
    expect(frontmatterField('---\nmodified: "2026-01-01"\n---\n', "modified")).toBe("2026-01-01");
  });

  it("null when the frontmatter block or the key is missing", () => {
    expect(frontmatterField("---\nmetadata:\n  type: project\n  modified: 2026-07-01T00:00:00Z\n---\n", "modified")).toBe("2026-07-01T00:00:00Z");
    expect(frontmatterField("no frontmatter here", "modified")).toBeNull();
    expect(frontmatterField("---\nname: x\n---\n", "modified")).toBeNull();
    expect(frontmatterField("---\nmodified:   \n---\n", "modified")).toBeNull();
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-09-26T00:00:00Z");
  it("frontmatter `modified` wins when parseable", () => {
    expect(isStale("2026-09-01T00:00:00Z", now, now, STALE_DAYS)).toBe(false); // 25 days
    expect(isStale("2026-06-01T00:00:00Z", now, now, STALE_DAYS)).toBe(true); // ~117 days
  });
  it("falls back to mtime when `modified` is missing or unparseable", () => {
    const oldMtime = now - 90 * 24 * 60 * 60 * 1000;
    expect(isStale(null, oldMtime, now, STALE_DAYS)).toBe(true);
    expect(isStale("not a date", now, now, STALE_DAYS)).toBe(false);
  });
});

describe("countKnownFailureModeEntries", () => {
  it("counts bullets under the auto-logged heading, stopping at the next heading", () => {
    const md = [
      "# a skill",
      "body",
      "## Known failure modes (auto-logged)",
      "- **2026-09-20** — got the path wrong _(session abcd1234)_",
      "- **2026-09-24** — missed an edge case",
      "## Something else",
      "- not counted, different section",
    ].join("\n");
    expect(countKnownFailureModeEntries(md)).toBe(2);
  });

  it("0 when the heading is absent, or present with no bullets", () => {
    expect(countKnownFailureModeEntries("# a skill\nno such section\n")).toBe(0);
    expect(countKnownFailureModeEntries("## Known failure modes (auto-logged)\n\n")).toBe(0);
  });

  it("the heading at end of file (nothing after it) still counts its bullets", () => {
    expect(countKnownFailureModeEntries("# skill\n## Known failure modes (auto-logged)\n- one\n- two\n")).toBe(2);
  });
});

describe("countJsonlFiles", () => {
  it("recursively counts .jsonl, separating anything under a subagents/ dir", async () => {
    const dir = await tmp("aw-mem-jsonl-");
    await mkdir(join(dir, "proj-a"), { recursive: true });
    await writeFile(join(dir, "proj-a", "s1.jsonl"), "");
    await writeFile(join(dir, "proj-a", "s2.jsonl"), "");
    await mkdir(join(dir, "proj-a", "s1", "subagents"), { recursive: true });
    await writeFile(join(dir, "proj-a", "s1", "subagents", "sub1.jsonl"), "");
    await writeFile(join(dir, "proj-a", "s1", "subagents", "sub2.jsonl"), "");
    await writeFile(join(dir, "proj-a", "notes.txt"), "ignored");

    const counts = await countJsonlFiles(dir);
    expect(counts).toEqual({ total: 4, subagents: 2 });
  });

  it("null when the projects dir itself doesn't exist (no data, not zero)", async () => {
    expect(await countJsonlFiles("/definitely/not/here/projects")).toBeNull();
  });

  it("an empty projects dir is a real zero", async () => {
    const dir = await tmp("aw-mem-jsonl-empty-");
    expect(await countJsonlFiles(dir)).toEqual({ total: 0, subagents: 0 });
  });
});

describe("readRecallIndexStats", () => {
  it("present + size + mtime when the db file exists", async () => {
    const dir = await tmp("aw-mem-recall-");
    const dbPath = join(dir, "sessions.db");
    await writeFile(dbPath, "x".repeat(1000));
    const stats = await readRecallIndexStats(dbPath);
    expect(stats.present).toBe(true);
    expect(stats.sizeBytes).toBe(1000);
    expect(stats.lastIndexedAt).not.toBeNull();
  });

  it("absent when the db file doesn't exist", async () => {
    expect(await readRecallIndexStats("/definitely/not/here/sessions.db")).toEqual({ present: false, sizeBytes: null, lastIndexedAt: null });
  });
});

describe("scanSemanticMemory", () => {
  it("counts files, confidence mix and staleness; excludes MEMORY.md itself", async () => {
    const dir = await tmp("aw-mem-semantic-");
    const now = Date.parse("2026-09-26T00:00:00Z");
    await writeFile(join(dir, "MEMORY.md"), "✅ this must never be counted");
    await writeFile(join(dir, "a.md"), "---\nmodified: 2026-09-25T00:00:00Z\n---\n✅ verified: ran it");
    await writeFile(join(dir, "b.md"), "---\nmodified: 2026-06-01T00:00:00Z\n---\n🧪 hypothesis, untested");
    await writeFile(join(dir, "c.md"), "no frontmatter, no marker at all");
    await mkdir(join(dir, "_L2"), { recursive: true });
    await writeFile(join(dir, "_L2", "nested.md"), "✅ verified but one level down, not counted (non-recursive)");

    const stats = await scanSemanticMemory({ memoryDir: dir, now });
    expect(stats.fileCount).toBe(3); // a, b, c — not MEMORY.md, not the nested one
    expect(stats.confidence).toEqual({ verified: 1, hypothesis: 1, reported: 0, unmarked: 1 });
    expect(stats.staleCount).toBe(1); // only b.md (2026-06-01) is 60+ days before "now"
    expect(stats.staleDays).toBe(STALE_DAYS);
  });

  it("null fileCount when the memory dir doesn't exist (no data, not zero)", async () => {
    const stats = await scanSemanticMemory({ memoryDir: "/definitely/not/here/memory", now: Date.now() });
    expect(stats.fileCount).toBeNull();
    expect(stats.confidence).toEqual({ verified: 0, reported: 0, hypothesis: 0, unmarked: 0 });
  });

  it.skipIf(AS_ROOT)("an unreadable file is still counted (it exists) but contributes no confidence/stale signal", async () => {
    const dir = await tmp("aw-mem-semantic-unreadable-");
    const locked = join(dir, "locked.md");
    await writeFile(locked, "✅ verified but you can't read me");
    await chmod(locked, 0o000);
    try {
      const stats = await scanSemanticMemory({ memoryDir: dir, now: Date.now() });
      expect(stats.fileCount).toBe(1);
      expect(stats.confidence).toEqual({ verified: 0, reported: 0, hypothesis: 0, unmarked: 0 });
    } finally {
      await chmod(locked, 0o644); // restore so the tmp dir cleans up
    }
  });

  it("empty memory dir: real zero, not null", async () => {
    const dir = await tmp("aw-mem-semantic-empty-");
    const stats = await scanSemanticMemory({ memoryDir: dir, now: Date.now() });
    expect(stats.fileCount).toBe(0);
    expect(stats.staleCount).toBe(0);
  });
});

describe("scanSkillPatches", () => {
  it("counts patched skills and total entries, deduping repeated paths", async () => {
    const dir = await tmp("aw-mem-patches-");
    const patched = join(dir, "patched.md");
    const clean = join(dir, "clean.md");
    await writeFile(patched, "# skill\n## Known failure modes (auto-logged)\n- one\n- two\n- three\n");
    await writeFile(clean, "# skill\nno failures logged\n");

    const result = await scanSkillPatches([patched, patched, clean]);
    expect(result).toEqual({ patchedSkillCount: 1, patchEntryCount: 3 });
  });

  it("empty registry: zero, not an error", async () => {
    expect(await scanSkillPatches([])).toEqual({ patchedSkillCount: 0, patchEntryCount: 0 });
  });

  it("an unreadable/missing SKILL.md is skipped, not thrown", async () => {
    expect(await scanSkillPatches(["/definitely/not/here/SKILL.md"])).toEqual({ patchedSkillCount: 0, patchEntryCount: 0 });
  });
});
