import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dedupKey, mergeLoopsItems, normalizeTaskText } from "../features/loops-merge.js";
import type { ScanItem } from "../features/loops-scan.js";
import type { WhatsupItem } from "../features/loops-whatsup.js";

describe("normalizeTaskText / dedupKey", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeTaskText("Ship the  Thing!!  (v2)")).toBe("ship the thing v2");
  });

  it("matches the same (project, text) pair regardless of case/punctuation", () => {
    expect(dedupKey("Demo", "Ship the thing.")).toBe(dedupKey("demo", "SHIP THE THING"));
  });

  it("treats a different project as a different key even for identical text", () => {
    expect(dedupKey("a", "same text")).not.toBe(dedupKey("b", "same text"));
  });
});

const whatsupItem = (over: Partial<WhatsupItem> = {}): WhatsupItem => ({
  id: "w1",
  task: "Ship the thing",
  project: "demo",
  lens: "do_today",
  score: 84,
  sourceType: "todo_md",
  sourceFile: null,
  ...over,
});

const scanItem = (over: Partial<ScanItem> = {}): ScanItem => ({
  task: "Ship the thing",
  project: "demo",
  section: "Open",
  sourceFile: "/code/demo/tasks/todo.md",
  mtimeMs: 1_700_000_000_000,
  ...over,
});

describe("mergeLoopsItems", () => {
  let codeDir = "";
  afterEach(async () => {
    if (codeDir) await rm(codeDir, { recursive: true, force: true });
    codeDir = "";
  });

  it("dedupes a whatsup item against a matching scan item, keeping whatsup's lens/score and both sources", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem()], [scanItem()], null, codeDir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "w1",
      lens: "do_today",
      score: 84,
      sources: ["whatsup", "scan"],
      openPath: "/code/demo/tasks/todo.md",
      launchCwd: "/code/demo",
    });
  });

  it("matching ignores punctuation/case differences between the two sources' task text", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem({ task: "Ship the THING!!" })], [scanItem({ task: "ship the thing" })], null, codeDir);
    expect(items).toHaveLength(1);
    expect(items[0]?.sources).toEqual(["whatsup", "scan"]);
  });

  it("resolves an unmatched whatsup item's launchCwd from a real <codeDir>/<project> directory", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    await mkdir(join(codeDir, "demo"), { recursive: true });
    const items = await mergeLoopsItems([whatsupItem({ task: "Unrelated task" })], [], null, codeDir);
    expect(items[0]?.sources).toEqual(["whatsup"]);
    expect(items[0]?.launchCwd).toBe(join(codeDir, "demo"));
  });

  it("leaves launchCwd null when the whatsup project has no real directory under codeDir", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem({ project: "acme-growth", task: "Unrelated task" })], [], null, codeDir);
    expect(items[0]?.launchCwd).toBeNull();
  });

  it("leaves openPath null for a live item whose source_file is a pseudo-ref, not a real path", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem({ sourceType: "live", sourceFile: "linear:TICK-1140", task: "Unrelated task" })], [], null, codeDir);
    expect(items[0]?.openPath).toBeNull();
  });

  it("falls back to the whatsup board's generated stamp for updatedAt when there is no scan match", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem({ task: "Unrelated task" })], [], "2026-09-25T08:50", codeDir);
    expect(items[0]?.updatedAt).toBe("2026-09-25T08:50");
  });

  it("keeps a scan-only item as unranked, sourced from scan alone, with its own generated id", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([], [scanItem({ task: "A scan-only task" })], null, codeDir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      task: "A scan-only task",
      project: "demo",
      lens: "unranked",
      score: 0,
      sources: ["scan"],
      sourceType: "todo_md",
      openPath: "/code/demo/tasks/todo.md",
      launchCwd: "/code/demo",
    });
    expect(items[0]?.id).toMatch(/^scan-[0-9a-f]{10}$/);
  });

  it("keeps both a whatsup item and an unrelated scan item from a different project separate", async () => {
    codeDir = await mkdtemp(join(tmpdir(), "aw-loops-merge-"));
    const items = await mergeLoopsItems([whatsupItem()], [scanItem({ project: "other", sourceFile: "/code/other/tasks/todo.md", task: "unrelated" })], null, codeDir);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.project === "demo")?.sources).toEqual(["whatsup"]);
    expect(items.find((i) => i.project === "other")?.sources).toEqual(["scan"]);
  });
});
