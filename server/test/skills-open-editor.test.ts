import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSkillMdPath } from "../features/skills-open-editor.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("resolveSkillMdPath", () => {
  it("rejects a non-string, a relative path, and one that isn't literally named SKILL.md", async () => {
    const root = await tmp("aw-open-editor-shape-");
    expect((await resolveSkillMdPath([root], undefined)).ok).toBe(false);
    expect((await resolveSkillMdPath([root], 42)).ok).toBe(false);
    expect(await resolveSkillMdPath([root], "relative/SKILL.md")).toEqual({ ok: false, status: 400, error: "absolute path required" });
    await mkdir(join(root, "x"), { recursive: true });
    await writeFile(join(root, "x", "notes.md"), "hi");
    expect(await resolveSkillMdPath([root], join(root, "x", "notes.md"))).toEqual({ ok: false, status: 400, error: "only a SKILL.md file may be opened" });
  });

  it("resolves a real SKILL.md inside an allowed root", async () => {
    const root = await tmp("aw-open-editor-ok-");
    const skillMd = join(root, "grill-me", "SKILL.md");
    await mkdir(join(root, "grill-me"), { recursive: true });
    await writeFile(skillMd, "---\nname: grill-me\n---\n");
    const res = await resolveSkillMdPath([root], skillMd);
    expect(res).toEqual({ ok: true, abs: await realpath(skillMd) });
  });

  it("checks every allowed root and takes the first match", async () => {
    const rootA = await tmp("aw-open-editor-a-");
    const rootB = await tmp("aw-open-editor-b-");
    await mkdir(join(rootB, "s"), { recursive: true });
    await writeFile(join(rootB, "s", "SKILL.md"), "x");
    const res = await resolveSkillMdPath([rootA, rootB], join(rootB, "s", "SKILL.md"));
    expect(res.ok).toBe(true);
  });

  it("rejects a SKILL.md outside every allowed root", async () => {
    const root = await tmp("aw-open-editor-outside-root-");
    const elsewhere = await tmp("aw-open-editor-elsewhere-");
    await mkdir(join(elsewhere, "s"), { recursive: true });
    await writeFile(join(elsewhere, "s", "SKILL.md"), "x");
    const res = await resolveSkillMdPath([root], join(elsewhere, "s", "SKILL.md"));
    expect(res).toEqual({ ok: false, status: 403, error: "outside-root" });
  });

  it("rejects a .. escape out of the allowed root (normalizes to a sibling directory, still outside)", async () => {
    const root = await tmp("aw-open-editor-traversal-");
    const outside = await tmp("aw-open-editor-traversal-target-");
    await writeFile(join(outside, "SKILL.md"), "x");
    const escaping = `${root}/../${outside.split("/").pop() ?? ""}/SKILL.md`;
    expect(await resolveSkillMdPath([root], escaping)).toEqual({ ok: false, status: 403, error: "outside-root" });
  });

  it("rejects a symlink that resolves outside the allowed root, even though it lexically lives inside it", async () => {
    const root = await tmp("aw-open-editor-symlink-root-");
    const secretDir = await tmp("aw-open-editor-symlink-target-");
    await writeFile(join(secretDir, "SKILL.md"), "sensitive");
    await symlink(join(secretDir, "SKILL.md"), join(root, "SKILL.md"));
    const res = await resolveSkillMdPath([root], join(root, "SKILL.md"));
    expect(res).toEqual({ ok: false, status: 403, error: "outside-root" });
  });

  it("reports not-found for a path that doesn't exist", async () => {
    const root = await tmp("aw-open-editor-missing-");
    const res = await resolveSkillMdPath([root], join(root, "nope", "SKILL.md"));
    expect(res).toEqual({ ok: false, status: 404, error: "not-found" });
  });
});
