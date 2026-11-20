// Read-only inventory scan: every installed skill (~/.claude/skills/*, many of them symlinks
// into ~/.claude/skills-repo — resolved to their real path; ~/.claude/plugins/cache/*/*/*/skills/*;
// and repo-local .claude/skills for repos this Mac has indexed sessions in) plus the upskill
// autopilot's candidate queue (~/.claude/skills/_proposed/<slug>/, staged by
// alex_claude/60-Meta/scripts/knowledge_learner/autoskiller/drafter.py — SKILL.md +
// .autoskiller-meta.json with confidence/frequency/drafted_at, verified against that source
// 2026-09-25). Every fs call is best-effort: a missing/unreadable entry is skipped, never thrown.
//
// Frontmatter (name + description) reuses automations-lib.ts's parser rather than re-parsing
// SKILL.md YAML a second way.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledSkill, SkillCandidate, SkillOrigin } from "../../shared/features/skills.js";
import { parseSkillFrontmatter } from "./automations-lib.js";
import { isRecord } from "../http.js";

/** Matches a real skill/candidate directory name; excludes "_proposed" (starts with "_") and
 *  dotfiles/dirs like ".trash" (starts with ".") — same convention as automations.ts's ID_RE. */
export const SKILL_DIR_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const FRONTMATTER_READ_CAP = 16 * 1024;
const META_JSON_READ_CAP = 16 * 1024;

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isoMtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function readCapped(path: string, maxBytes: number): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).slice(0, maxBytes);
  } catch {
    return null;
  }
}

async function loadInstalled(skillMdPath: string, slug: string, origin: SkillOrigin, pluginId: string | null): Promise<InstalledSkill | null> {
  const md = await readCapped(skillMdPath, FRONTMATTER_READ_CAP);
  if (md === null) return null;
  const meta = parseSkillFrontmatter(md);
  if (!meta) return null;
  const [path, updatedAt] = await Promise.all([resolvedPath(skillMdPath), isoMtime(skillMdPath)]);
  return { slug, name: meta.name, description: meta.description, origin, pluginId, path, updatedAt };
}

/** ~/.claude/skills/<name>/SKILL.md — many entries are symlinks into ~/.claude/skills-repo;
 *  `path` on the result is the resolved real file. */
export async function scanUserSkills(skillsDir: string): Promise<InstalledSkill[]> {
  const dirs = (await safeReaddir(skillsDir)).filter((d) => SKILL_DIR_RE.test(d));
  const found = await Promise.all(dirs.map((dir) => loadInstalled(join(skillsDir, dir, "SKILL.md"), dir, "user", null)));
  return found.filter((s): s is InstalledSkill => s !== null);
}

/** The plugin's declared name (its slash-command namespace), from .claude-plugin/plugin.json;
 *  falls back to the plugin's directory name when the manifest is missing or unreadable. */
async function pluginNameOf(versionDir: string, fallback: string): Promise<string> {
  const raw = await readCapped(join(versionDir, ".claude-plugin", "plugin.json"), 4 * 1024);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : fallback;
  } catch {
    return fallback;
  }
}

/** ~/.claude/plugins/cache/<repo>/<plugin>/<version>/skills/<skillId>/SKILL.md. Slugs are
 *  "<plugin-manifest-name>:<skillId>", matching how the Skill tool and slash commands invoke
 *  them (verified against local transcripts, e.g. "typesafe:typesafe-ai"). */
export async function scanPluginSkills(pluginsCacheDir: string): Promise<InstalledSkill[]> {
  const repos = await safeReaddir(pluginsCacheDir);
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const repoDir = join(pluginsCacheDir, repo);
      const plugins = await safeReaddir(repoDir);
      const perPlugin = await Promise.all(
        plugins.map(async (plugin) => {
          const pluginDir = join(repoDir, plugin);
          const versions = await safeReaddir(pluginDir);
          const perVersion = await Promise.all(
            versions.map(async (version) => {
              const versionDir = join(pluginDir, version);
              const skillsRoot = join(versionDir, "skills");
              const skillIds = (await safeReaddir(skillsRoot)).filter((d) => SKILL_DIR_RE.test(d));
              if (skillIds.length === 0) return [] as InstalledSkill[];
              const pluginName = await pluginNameOf(versionDir, plugin);
              const found = await Promise.all(
                skillIds.map((id) => loadInstalled(join(skillsRoot, id, "SKILL.md"), `${pluginName}:${id}`, "plugin", pluginName)),
              );
              return found.filter((s): s is InstalledSkill => s !== null);
            }),
          );
          return perVersion.flat();
        }),
      );
      return perPlugin.flat();
    }),
  );
  return perRepo.flat();
}

/** <repoRoot>/.claude/skills/<name>/SKILL.md for each given repo root (deduped). Scoped to
 *  repos this Mac has indexed sessions in, not a filesystem-wide crawl. */
export async function scanRepoLocalSkills(repoRoots: readonly string[]): Promise<InstalledSkill[]> {
  const roots = [...new Set(repoRoots)];
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      const skillsDir = join(root, ".claude", "skills");
      const dirs = (await safeReaddir(skillsDir)).filter((d) => SKILL_DIR_RE.test(d));
      const found = await Promise.all(dirs.map((dir) => loadInstalled(join(skillsDir, dir, "SKILL.md"), dir, "project", null)));
      return found.filter((s): s is InstalledSkill => s !== null);
    }),
  );
  return perRoot.flat();
}

export interface InventoryDeps {
  skillsDir: string;
  pluginsCacheDir: string;
  repoRoots: readonly string[];
}

/** The full raw inventory (user + plugin + project). Not deduped by slug — a skill installed
 *  in more than one place (rare) appears once per place; callers that want one row per slug
 *  use skills-aggregate.ts's indexInstalledBySlug (user beats plugin beats project). */
export async function scanInstalledSkills(deps: InventoryDeps): Promise<InstalledSkill[]> {
  const [user, plugin, project] = await Promise.all([
    scanUserSkills(deps.skillsDir),
    scanPluginSkills(deps.pluginsCacheDir),
    scanRepoLocalSkills(deps.repoRoots),
  ]);
  return [...user, ...plugin, ...project];
}

// ---------------------------------------------------------------- candidate queue

/** frontmatter-only numeric field (drafter.py writes "confidence:"/"frequency:" as plain YAML
 *  scalars in the SKILL.md it stages) — used only as a fallback when .autoskiller-meta.json is
 *  missing or malformed, e.g. a hand-staged candidate. */
function numericFrontmatterField(md: string, key: string): number | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm?.[1]) return null;
  const m = new RegExp(`^${key}:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, "m").exec(fm[1]);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

interface AutoskillerMeta {
  confidence: number | null;
  frequency: number | null;
  draftedAt: string | null;
}

async function readAutoskillerMeta(dir: string): Promise<AutoskillerMeta | null> {
  const raw = await readCapped(join(dir, ".autoskiller-meta.json"), META_JSON_READ_CAP);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return {
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    frequency: typeof parsed.frequency === "number" ? parsed.frequency : null,
    draftedAt: typeof parsed.drafted_at === "string" ? parsed.drafted_at : null,
  };
}

async function loadCandidate(dir: string, slug: string): Promise<SkillCandidate | null> {
  const skillMdPath = join(dir, "SKILL.md");
  const md = await readCapped(skillMdPath, FRONTMATTER_READ_CAP);
  if (md === null) return null; // no SKILL.md: not a real candidate
  const meta = parseSkillFrontmatter(md);
  const autoMeta = await readAutoskillerMeta(dir);
  const [path, mtime] = await Promise.all([resolvedPath(skillMdPath), isoMtime(skillMdPath)]);
  return {
    slug,
    name: meta?.name ?? slug,
    description: meta?.description ?? "",
    queuedAt: autoMeta?.draftedAt ?? mtime,
    evidenceCount: autoMeta?.frequency ?? numericFrontmatterField(md, "frequency"),
    confidence: autoMeta?.confidence ?? numericFrontmatterField(md, "confidence"),
    path,
  };
}

/** ~/.claude/skills/_proposed/<slug>/ — the upskill autopilot's review queue. View only:
 *  nothing here promotes, discards or edits a candidate. Sorted newest-queued first. */
export async function scanCandidates(proposedDir: string): Promise<SkillCandidate[]> {
  const dirs = (await safeReaddir(proposedDir)).filter((d) => SKILL_DIR_RE.test(d));
  const found = await Promise.all(dirs.map((dir) => loadCandidate(join(proposedDir, dir), dir)));
  return found
    .filter((c): c is SkillCandidate => c !== null)
    .sort((a, b) => {
      if (a.queuedAt === b.queuedAt) return a.slug.localeCompare(b.slug);
      if (a.queuedAt === null) return 1;
      if (b.queuedAt === null) return -1;
      return a.queuedAt < b.queuedAt ? 1 : -1;
    });
}
