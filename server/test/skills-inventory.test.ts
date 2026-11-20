import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCandidates, scanInstalledSkills, scanPluginSkills, scanRepoLocalSkills, scanUserSkills } from "../features/skills-inventory.js";

/** Resolved immediately: macOS's tmpdir() lives under /var, itself a symlink to /private/var,
 *  so an unresolved mkdtemp() result would never equal the realpath()-resolved paths this
 *  module's scanners always return. */
async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function writeSkill(dir: string, frontmatterExtra = ""): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${dir.split("/").pop()}\ndescription: does a thing\n${frontmatterExtra}---\n# body\n`);
}

describe("scanUserSkills", () => {
  it("reads name + description from frontmatter, and resolves a symlinked skill to its real path", async () => {
    const home = await tmp("aw-skills-user-");
    const repo = join(home, "skills-repo");
    const skills = join(home, "skills");
    await writeSkill(join(repo, "grill-me"));
    await mkdir(skills, { recursive: true });
    await symlink(join(repo, "grill-me"), join(skills, "grill-me"), "dir");
    await writeSkill(join(skills, "plain-one"));

    const found = await scanUserSkills(skills);
    expect(found).toHaveLength(2);
    const linked = found.find((s) => s.slug === "grill-me");
    expect(linked).toMatchObject({ name: "grill-me", description: "does a thing", origin: "user", pluginId: null });
    expect(linked?.path).toBe(join(repo, "grill-me", "SKILL.md"));
    expect(linked?.updatedAt).not.toBeNull();
    const plain = found.find((s) => s.slug === "plain-one");
    expect(plain?.path).toBe(join(skills, "plain-one", "SKILL.md"));
  });

  it("skips _proposed, dotdirs, a missing SKILL.md, and one with no parseable frontmatter", async () => {
    const skills = await tmp("aw-skills-skip-");
    await writeSkill(join(skills, "good"));
    await mkdir(join(skills, "_proposed", "candidate"), { recursive: true });
    await writeFile(join(skills, "_proposed", "candidate", "SKILL.md"), "---\nname: candidate\n---\n");
    await mkdir(join(skills, ".trash"), { recursive: true });
    await mkdir(join(skills, "empty-dir"), { recursive: true }); // no SKILL.md at all
    await mkdir(join(skills, "no-frontmatter"), { recursive: true });
    await writeFile(join(skills, "no-frontmatter", "SKILL.md"), "# just a heading, no frontmatter\n");

    const found = await scanUserSkills(skills);
    expect(found.map((s) => s.slug)).toEqual(["good"]);
  });

  it("returns [] when the skills dir doesn't exist", async () => {
    expect(await scanUserSkills("/definitely/not/here/skills")).toEqual([]);
  });
});

describe("scanPluginSkills", () => {
  it("uses the plugin manifest's declared name as the slug prefix", async () => {
    const cache = await tmp("aw-skills-plugin-");
    const versionDir = join(cache, "typesafe-ai", "typesafe", "0.5.7");
    await mkdir(join(versionDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(versionDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "typesafe" }));
    await writeSkill(join(versionDir, "skills", "typesafe-ai"));

    const found = await scanPluginSkills(cache);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ slug: "typesafe:typesafe-ai", origin: "plugin", pluginId: "typesafe" });
  });

  it("falls back to the plugin's directory name when plugin.json is missing or malformed", async () => {
    const cache = await tmp("aw-skills-plugin-fallback-");
    const versionDir = join(cache, "repo1", "grok", "0.4.0");
    await writeSkill(join(versionDir, "skills", "grok-delegation"));
    const found1 = await scanPluginSkills(cache);
    expect(found1[0]).toMatchObject({ slug: "grok:grok-delegation", pluginId: "grok" });

    const bad = await tmp("aw-skills-plugin-badjson-");
    const vd2 = join(bad, "repoX", "pluginX", "1.0.0");
    await mkdir(join(vd2, ".claude-plugin"), { recursive: true });
    await writeFile(join(vd2, ".claude-plugin", "plugin.json"), "{not json");
    await writeSkill(join(vd2, "skills", "sk"));
    const found2 = await scanPluginSkills(bad);
    expect(found2[0]).toMatchObject({ slug: "pluginX:sk", pluginId: "pluginX" });
  });

  it("returns [] for a version dir with no skills/ subfolder, and when the cache dir is absent", async () => {
    const cache = await tmp("aw-skills-plugin-empty-");
    await mkdir(join(cache, "repo1", "plugin1", "1.0.0"), { recursive: true });
    expect(await scanPluginSkills(cache)).toEqual([]);
    expect(await scanPluginSkills("/definitely/not/here/plugins")).toEqual([]);
  });
});

describe("scanRepoLocalSkills", () => {
  it("reads <repoRoot>/.claude/skills/*/SKILL.md and dedupes repeated roots", async () => {
    const repo = await tmp("aw-skills-repo-local-");
    await writeSkill(join(repo, ".claude", "skills", "proj-skill"));
    const found = await scanRepoLocalSkills([repo, repo]);
    expect(found).toEqual(await scanRepoLocalSkills([repo]));
    expect(found[0]).toMatchObject({ slug: "proj-skill", origin: "project", pluginId: null });
  });

  it("returns [] for a repo with no .claude/skills", async () => {
    const repo = await tmp("aw-skills-repo-none-");
    expect(await scanRepoLocalSkills([repo])).toEqual([]);
  });
});

describe("scanInstalledSkills", () => {
  it("combines user + plugin + project without deduping across origins", async () => {
    const home = await tmp("aw-skills-combined-");
    const skillsDir = join(home, "skills");
    const pluginsCacheDir = join(home, "plugins", "cache");
    const repo = join(home, "repo");
    await writeSkill(join(skillsDir, "u"));
    await writeSkill(join(pluginsCacheDir, "r", "p", "1.0.0", "skills", "x"));
    await writeSkill(join(repo, ".claude", "skills", "proj"));
    const found = await scanInstalledSkills({ skillsDir, pluginsCacheDir, repoRoots: [repo] });
    expect(found.map((s) => s.slug).sort()).toEqual(["p:x", "proj", "u"]);
  });
});

describe("scanCandidates", () => {
  it("prefers .autoskiller-meta.json over frontmatter-embedded numbers when both are present", async () => {
    const proposed = await tmp("aw-skills-candidates-meta-");
    const dir = join(proposed, "some-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: some-skill\ndescription: drafted from a cluster\nconfidence: 0.10\nfrequency: 1\n---\n# body\n",
    );
    await writeFile(join(dir, ".autoskiller-meta.json"), JSON.stringify({ confidence: 0.82, frequency: 7, drafted_at: "2026-09-20T00:00:00.000Z" }));

    const found = await scanCandidates(proposed);
    expect(found).toEqual([
      { slug: "some-skill", name: "some-skill", description: "drafted from a cluster", queuedAt: "2026-09-20T00:00:00.000Z", evidenceCount: 7, confidence: 0.82, path: join(dir, "SKILL.md") },
    ]);
  });

  it("falls back to numeric frontmatter fields when .autoskiller-meta.json is missing or malformed", async () => {
    const proposed = await tmp("aw-skills-candidates-fallback-");
    const noMeta = join(proposed, "hand-authored");
    await mkdir(noMeta, { recursive: true });
    await writeFile(join(noMeta, "SKILL.md"), "---\nname: hand-authored\ndescription: written by hand\nconfidence: 0.5\nfrequency: 4\n---\n");

    const badMeta = join(proposed, "bad-meta");
    await mkdir(badMeta, { recursive: true });
    await writeFile(join(badMeta, "SKILL.md"), "---\nname: bad-meta\ndescription: has a broken sidecar\nfrequency: 3\n---\n");
    await writeFile(join(badMeta, ".autoskiller-meta.json"), "{not json");

    const found = await scanCandidates(proposed);
    const handAuthored = found.find((c) => c.slug === "hand-authored");
    expect(handAuthored).toMatchObject({ evidenceCount: 4, confidence: 0.5 });
    const bad = found.find((c) => c.slug === "bad-meta");
    expect(bad).toMatchObject({ evidenceCount: 3, confidence: null });
  });

  it("reports no evidence (never fabricates a number) when nothing records it, and skips a dir with no SKILL.md", async () => {
    const proposed = await tmp("aw-skills-candidates-none-");
    await mkdir(join(proposed, "bare"), { recursive: true });
    await writeFile(join(proposed, "bare", "SKILL.md"), "---\nname: bare\n---\n");
    await mkdir(join(proposed, "empty-dir"), { recursive: true }); // no SKILL.md: not a real candidate

    const found = await scanCandidates(proposed);
    expect(found.map((c) => c.slug)).toEqual(["bare"]);
    expect(found[0]).toMatchObject({ name: "bare", description: "", evidenceCount: null, confidence: null });
  });

  it("sorts newest-queued first", async () => {
    const proposed = await tmp("aw-skills-candidates-sort-");
    for (const [slug, draftedAt] of [
      ["older", "2026-01-01T00:00:00.000Z"],
      ["newer", "2026-09-01T00:00:00.000Z"],
    ] as const) {
      const dir = join(proposed, slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${slug}\n---\n`);
      await writeFile(join(dir, ".autoskiller-meta.json"), JSON.stringify({ drafted_at: draftedAt }));
    }
    const found = await scanCandidates(proposed);
    expect(found.map((c) => c.slug)).toEqual(["newer", "older"]);
  });

  it("returns [] when the queue directory doesn't exist", async () => {
    expect(await scanCandidates("/definitely/not/here/_proposed")).toEqual([]);
  });
});
