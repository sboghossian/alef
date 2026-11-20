// "memory-layers": the three memory buildings next to Harness City (episodic archive, semantic
// library, procedural workshop) that replaced the single memory library.
//   - Episodic: session transcript counts (server/features/memory-layers-lib.ts's countJsonlFiles)
//     + the hermes-loop recall index (~/.gstack/memory/sessions.db).
//   - Semantic: memory files under ~/.claude/projects/<flattened home>/memory, confidence mix
//     (same markers as ~/.claude/hooks/memory-claim-lint.py) and staleness (60 days).
//   - Procedural: installed skills (reuses skills-inventory.ts/skills-aggregate.ts, the same
//     scan the "skills" feature uses) plus "Known failure modes" entries learning-loop.py logs
//     straight into each skill's own SKILL.md.
//
// GET /api/memory-layers/snapshot -> MemoryLayersSnapshotResult

import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryLayersSnapshotResult } from "../../shared/features/memory-layers.js";
import { respondJson } from "../http.js";
import { findGitRoot } from "../repo-root.js";
import { createSwr, type Swr } from "./cache-lib.js";
import { countJsonlFiles, readRecallIndexStats, scanSemanticMemory, scanSkillPatches } from "./memory-layers-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { indexInstalledBySlug } from "./skills-aggregate.js";
import { scanInstalledSkills } from "./skills-inventory.js";

const SNAPSHOT_TTL_MS = 60_000;

export interface MemoryLayersFeatureDeps {
  home?: string;
  /** ~/.claude/projects/<flattened home>/memory ("/" -> "-", matching Claude Code's own
   *  project-directory naming, e.g. "/Users/alexboghossian" -> "-Users-alexboghossian"). */
  memoryDir?: string;
  /** hermes-loop's recall.py: DB_DIR = ~/.gstack/memory, DB_PATH = DB_DIR/sessions.db. */
  recallDbPath?: string;
  skillsDir?: string;
  pluginsCacheDir?: string;
}

interface Runtime {
  snapshot: Swr<MemoryLayersSnapshotResult>;
}

export function createMemoryLayersFeature(deps: MemoryLayersFeatureDeps = {}): ServerFeature {
  const home = deps.home ?? homedir();
  const memoryDir = deps.memoryDir ?? join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory");
  const recallDbPath = deps.recallDbPath ?? join(home, ".gstack", "memory", "sessions.db");
  const skillsDir = deps.skillsDir ?? join(home, ".claude", "skills");
  const pluginsCacheDir = deps.pluginsCacheDir ?? join(home, ".claude", "plugins", "cache");

  const runtimes = new Map<string, Runtime>();

  /** Same approach as skills.ts's repoRootsFrom: repos this Mac has indexed sessions in, not a
   *  filesystem-wide crawl — only these are checked for repo-local .claude/skills. */
  function repoRootsFrom(ctx: FeatureContext): string[] {
    const cwds = new Set(ctx.db.listSessions().map((s) => s.cwd));
    const roots = new Set<string>();
    for (const cwd of cwds) roots.add(findGitRoot(cwd) ?? cwd);
    return [...roots];
  }

  async function buildSnapshot(ctx: FeatureContext): Promise<MemoryLayersSnapshotResult> {
    const now = Date.now();
    const [jsonl, recallIndex, semantic, installed] = await Promise.all([
      countJsonlFiles(ctx.config.projectsDir),
      readRecallIndexStats(recallDbPath),
      scanSemanticMemory({ memoryDir, now }),
      scanInstalledSkills({ skillsDir, pluginsCacheDir, repoRoots: repoRootsFrom(ctx) }),
    ]);
    const bySlug = indexInstalledBySlug(installed);
    const patches = await scanSkillPatches([...bySlug.values()].map((s) => s.path));
    return {
      ok: true,
      episodic: {
        transcriptFiles: jsonl?.total ?? null,
        subagentTranscriptFiles: jsonl?.subagents ?? null,
        recallIndex,
      },
      semantic,
      procedural: {
        skillCount: bySlug.size,
        patchedSkillCount: patches.patchedSkillCount,
        patchEntryCount: patches.patchEntryCount,
      },
      scannedAt: new Date(now).toISOString(),
    };
  }

  function runtimeFor(ctx: FeatureContext): Runtime {
    const key = ctx.config.dbPath;
    let rt = runtimes.get(key);
    if (!rt) {
      rt = { snapshot: createSwr(() => buildSnapshot(ctx), { onError: (err) => ctx.log.error("memory-layers", "snapshot scan failed", String(err)) }) };
      runtimes.set(key, rt);
    }
    return rt;
  }

  return {
    id: "memory-layers",
    routes: [
      {
        method: "GET",
        path: "/api/memory-layers/snapshot",
        async handler(_req, res, ctx) {
          respondJson(res, 200, await runtimeFor(ctx).snapshot.get(SNAPSHOT_TTL_MS));
        },
      },
    ],
  };
}

export const memoryLayersFeature = createMemoryLayersFeature();
