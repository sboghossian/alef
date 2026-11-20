// The resident's sandbox must refuse every escape, on disk, not just by string shape: "../",
// absolute paths, NUL, off-allowlist names, a symlinked directory pointing outside, a symlinked
// target file, and a symlinked home. Every accepted write lands in writes.jsonl.

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelShape, listInHome, readInHome, writeInHome } from "../features/resident-sandbox.js";

let root: string;
let home: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "resident-sandbox-"));
  home = join(root, "home");
  outside = join(root, "outside");
  await mkdir(outside);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function auditLines(): Promise<string[]> {
  try {
    return (await readFile(join(home, "writes.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("checkRelShape", () => {
  it.each([
    ["", "empty"],
    ["../x.md", "parent"],
    ["journal/../../etc/passwd", "nested parent"],
    ["/etc/passwd", "absolute"],
    ["~/x.md", "tilde"],
    ["journal/2026-09-26.md\0", "NUL"],
    ["journal\\2026-09-26.md", "backslash"],
    ["skills/.hidden.md", "hidden"],
    ["journal//2026-09-26.md", "empty segment"],
    ["notes.txt", "off allowlist"],
    ["writes.jsonl", "audit log is sandbox-only"],
    ["skills/Bad_Name.md", "non-slug skill"],
  ])("refuses %j (%s)", (rel) => {
    expect(checkRelShape(rel)).not.toBeNull();
  });

  it.each(["state.json", "goals.md", "proposals.json", "journal/2026-09-26.md", "skills/read-the-fleet.md"])("accepts %j", (rel) => {
    expect(checkRelShape(rel)).toBeNull();
  });
});

describe("writeInHome", () => {
  it("creates the home, writes, and appends one audit line per write", async () => {
    const r = await writeInHome(home, "journal/2026-09-26.md", "- hello\n", "test", "append");
    expect(r.ok).toBe(true);
    await writeInHome(home, "journal/2026-09-26.md", "- again\n", "test", "append");
    expect(await readFile(join(home, "journal/2026-09-26.md"), "utf8")).toBe("- hello\n- again\n");
    const lines = await auditLines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: "journal/2026-09-26.md", bytes: 8, reason: "test" });
  });

  it("replace swaps the file atomically and leaves no temp file", async () => {
    await writeInHome(home, "goals.md", "one", "t");
    await writeInHome(home, "goals.md", "two", "t");
    expect(await readFile(join(home, "goals.md"), "utf8")).toBe("two");
    expect((await readdir(home)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it.each(["../escape.md", "/tmp/escape.md", "journal/../../escape.md", "a\0b"])("refuses %j and writes nothing", async (rel) => {
    const r = await writeInHome(home, rel, "x", "t");
    expect(r.ok).toBe(false);
    expect(await auditLines()).toEqual([]);
    expect(await readdir(root)).not.toContain("escape.md");
  });

  it("refuses a symlinked directory that points outside the home", async () => {
    await mkdir(home);
    await symlink(outside, join(home, "journal"));
    const r = await writeInHome(home, "journal/2026-09-26.md", "pwned", "t", "append");
    expect(r).toMatchObject({ ok: false });
    expect(await readdir(outside)).toEqual([]);
    expect(await auditLines()).toEqual([]);
  });

  it("refuses a symlinked target file (append and replace)", async () => {
    await mkdir(home);
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "original");
    await symlink(victim, join(home, "goals.md"));
    expect((await writeInHome(home, "goals.md", "pwned", "t", "append")).ok).toBe(false);
    expect((await writeInHome(home, "goals.md", "pwned", "t", "replace")).ok).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("original");
    expect((await lstat(join(home, "goals.md"))).isSymbolicLink()).toBe(true);
  });

  it("refuses when the home itself is a symlink", async () => {
    await symlink(outside, home);
    expect((await writeInHome(home, "goals.md", "x", "t")).ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a symlinked audit log (the write fails rather than writing through it)", async () => {
    await mkdir(home);
    const victim = join(outside, "log.txt");
    await writeFile(victim, "");
    await symlink(victim, join(home, "writes.jsonl"));
    expect((await writeInHome(home, "goals.md", "x", "t")).ok).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("");
  });

  it("refuses oversized content", async () => {
    expect((await writeInHome(home, "goals.md", "x".repeat(70 * 1024), "t")).ok).toBe(false);
  });
});

describe("readInHome / listInHome", () => {
  it("returns null / [] when the home does not exist, without creating it", async () => {
    expect(await readInHome(home, "state.json")).toBeNull();
    expect(await listInHome(home, "skills")).toEqual([]);
    await expect(lstat(home)).rejects.toThrow();
  });

  it("refuses to read through a symlinked file", async () => {
    await mkdir(home);
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "outside text");
    await symlink(secret, join(home, "goals.md"));
    await expect(readInHome(home, "goals.md")).rejects.toThrow();
  });

  it("refuses to list a symlinked directory", async () => {
    await mkdir(home);
    await writeFile(join(outside, "x.md"), "x");
    await symlink(outside, join(home, "skills"));
    await expect(listInHome(home, "skills")).rejects.toThrow();
  });

  it("reads only the tail when asked for fewer bytes", async () => {
    await writeInHome(home, "goals.md", "abcdef", "t");
    expect(await readInHome(home, "goals.md", 3)).toBe("def");
  });
});
