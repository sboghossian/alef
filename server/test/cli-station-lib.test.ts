import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCliRegistry, validateCliEntry } from "../features/cli-station-lib.js";

async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

const GOOD = {
  name: "recall",
  tool: "Claude Code session transcripts",
  purpose: "Full-text search over transcripts",
  entry: "/Users/alexboghossian/.claude/skills/hermes-loop/recall.py",
  language: "python3",
  created: "2026-09-23",
  author: "agent",
  tests: null,
};

describe("validateCliEntry", () => {
  it("accepts a well-formed entry, tests null or a string", () => {
    expect(validateCliEntry(GOOD)).toEqual(GOOD);
    expect(validateCliEntry({ ...GOOD, tests: "/some/test.py" })).toMatchObject({ tests: "/some/test.py" });
  });

  it("rejects non-objects and missing/wrong-typed required fields", () => {
    expect(validateCliEntry(null)).toBeNull();
    expect(validateCliEntry("a string")).toBeNull();
    expect(validateCliEntry([])).toBeNull();
    expect(validateCliEntry({ ...GOOD, name: "" })).toBeNull();
    expect(validateCliEntry({ ...GOOD, name: undefined })).toBeNull();
    expect(validateCliEntry({ ...GOOD, entry: 42 })).toBeNull();
    expect(validateCliEntry({ ...GOOD, tests: 42 })).toBeNull();
  });

  it("rejects a bad author or a malformed date", () => {
    expect(validateCliEntry({ ...GOOD, author: "alex" })).toMatchObject({ author: "alex" });
    expect(validateCliEntry({ ...GOOD, author: "someone-else" })).toBeNull();
    expect(validateCliEntry({ ...GOOD, created: "09/23/2026" })).toBeNull();
    expect(validateCliEntry({ ...GOOD, created: "2026-9-23" })).toBeNull();
  });

  it("unknown extra fields don't invalidate the entry (schema is additive-tolerant here; _registry.py warns instead)", () => {
    expect(validateCliEntry({ ...GOOD, extra: "ignored" })).toMatchObject({ name: "recall" });
  });
});

describe("scanCliRegistry", () => {
  it("reads valid entries, sorted by name", async () => {
    const dir = await tmp("aw-cli-good-");
    await mkdir(join(dir, "recall"), { recursive: true });
    await writeFile(join(dir, "recall", "cli.json"), JSON.stringify(GOOD));
    await mkdir(join(dir, "jev-search"), { recursive: true });
    await writeFile(join(dir, "jev-search", "cli.json"), JSON.stringify({ ...GOOD, name: "jev-search" }));

    const scan = await scanCliRegistry(dir);
    expect(scan.registryPresent).toBe(true);
    expect(scan.clis.map((c) => c.name)).toEqual(["jev-search", "recall"]);
    expect(scan.invalidCount).toBe(0);
  });

  it("skips a directory with no cli.json (not an error, not invalid)", async () => {
    const dir = await tmp("aw-cli-nocli-");
    await mkdir(join(dir, "empty-dir"), { recursive: true });
    const scan = await scanCliRegistry(dir);
    expect(scan).toEqual({ registryPresent: true, clis: [], invalidCount: 0 });
  });

  it("counts malformed JSON and schema failures as invalid, keeps the good ones", async () => {
    const dir = await tmp("aw-cli-bad-");
    await mkdir(join(dir, "good"), { recursive: true });
    await writeFile(join(dir, "good", "cli.json"), JSON.stringify(GOOD));
    await mkdir(join(dir, "bad-json"), { recursive: true });
    await writeFile(join(dir, "bad-json", "cli.json"), "{not json");
    await mkdir(join(dir, "bad-schema"), { recursive: true });
    await writeFile(join(dir, "bad-schema", "cli.json"), JSON.stringify({ name: "x" }));

    const scan = await scanCliRegistry(dir);
    expect(scan.clis.map((c) => c.name)).toEqual(["recall"]);
    expect(scan.invalidCount).toBe(2);
  });

  it("registryPresent: false only when the clis dir itself doesn't exist", async () => {
    expect(await scanCliRegistry("/definitely/not/here/clis")).toEqual({ registryPresent: false, clis: [], invalidCount: 0 });
  });

  it("registryPresent: true with an empty dir is a real 'none yet', distinct from missing", async () => {
    const dir = await tmp("aw-cli-empty-");
    expect(await scanCliRegistry(dir)).toEqual({ registryPresent: true, clis: [], invalidCount: 0 });
  });
});
