// "skills" (Round 8 H3): makes the skill system visible.
//   - Skills fired per session: Skill tool_use / typed "/<name>" / the skill-router hook's
//     suggestions, detected incrementally from onIndexPass (skills-detect.ts) and kept in our
//     own sqlite file (skills-store.ts) — the main schema in server/db.ts stays untouched.
//   - Inventory: read-only scan of every installed skill (skills-inventory.ts).
//   - Graveyard + Top used: installed skills joined against fired/suggested counts
//     (skills-aggregate.ts).
//   - Candidate queue: the upskill autopilot's ~/.claude/skills/_proposed/<slug>/ review
//     queue, VIEW ONLY — the one allowed action is "Open in editor" (skills-open-editor.ts).
//   - School (was "Institute"; tab id stays "candidates"): the study pipeline's own real
//     state — is it running, is it producing anything, which skills has it patched or
//     self-reviewed — so an empty candidate queue reads as "the pipeline is failing" or
//     "nothing queued", never as silence (institute-lib.ts). Plus measured change: SKILL.md
//     revisions in 30 days and failure-mode → later-commit pairs (read-only `git log` on
//     skills-repo), and the resident's own skills a later reflection names.
//
// GET  /api/skills/snapshot         -> SkillsSnapshotResult (Top used / Graveyard / School)
// GET  /api/skills/session/:agentId -> SkillsSessionResult (this session's detected events)
// POST /api/skills/open-editor      -> { path } -> SkillsOpenEditorResult

import { homedir } from "node:os";
import { join } from "node:path";
import {
  SKILLS_RECENT_KEY,
  SKILLS_RECENT_LIMIT,
  type InstalledSkill,
  type InstituteSnapshot,
  type SkillCandidate,
  type SkillUsageRow,
  type SkillsMessage,
  type SkillsOpenEditorResult,
  type SkillsSessionResult,
  type SkillsSnapshotResult,
  type SkillsError,
} from "../../shared/features/skills.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import { findGitRoot } from "../repo-root.js";
import { createSwr, type Swr } from "./cache-lib.js";
import { buildInstituteSnapshot } from "./institute-lib.js";
import { aggregateSkillUsage, indexInstalledBySlug } from "./skills-aggregate.js";
import { backfillProgress, runSkillsBackfillPass } from "./skills-backfill.js";
import { detectSkillEventsBatch } from "./skills-detect.js";
import { scanCandidates, scanInstalledSkills } from "./skills-inventory.js";
import { resolveSkillMdPath } from "./skills-open-editor.js";
import { SkillsStore, skillsStorePathFor } from "./skills-store.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const EPOCH_ISO = new Date(0).toISOString();
const DEFAULT_INVENTORY_TTL_MS = 60_000;
const META_CUTOFF_MS = "backfill_cutoff_ms";

export interface SkillsFeatureDeps {
  home?: string;
  skillsDir?: string; // ~/.claude/skills
  skillsRepoDir?: string; // ~/.claude/skills-repo (symlink targets of the above)
  pluginsCacheDir?: string; // ~/.claude/plugins/cache
  /** Directory name of the candidate queue, relative to skillsDir. Default "_proposed". */
  proposedDirName?: string;
  /** ~/.claude/upskill-state — the autopilot's own log + config (institute-lib.ts). */
  upskillStateDir?: string;
  /** ~/.alef-resident — read only, for the School's "the resident's own skills" (institute-lib.ts). */
  residentHome?: string;
  inventoryTtlMs?: number;
  recentEventsLimit?: number;
}

interface Runtime {
  store: SkillsStore;
  inventory: Swr<Awaited<ReturnType<typeof scanInstalledSkills>>>;
  candidates: Swr<Awaited<ReturnType<typeof scanCandidates>>>;
  institute: Swr<InstituteSnapshot>;
  /** Everything strictly before this (persisted, so it survives a restart) is the
   *  backfill's territory; everything at/after it is onIndexPass's — see skills-backfill.ts. */
  cutoffMs: number;
  backfillRunning: Promise<void> | null;
}

/** Installed skills that fired (invoked, or typed as /name) for the first time at/after a moment,
 *  for the president's commencement "hire". `ok: false` (with no debuts) while the history can't
 *  tell a first fire from an old one: the backfill is still reading, or the history starts after
 *  that moment. */
export interface SkillDebuts {
  ok: boolean;
  reason: string | null;
  /** The oldest event in the store: "first" means first since then. */
  historyStartAt: string | null;
  debuts: { slug: string; firstFiredAt: string; description: string }[];
  /** Every installed skill's description, by slug. */
  descriptions: ReadonlyMap<string, string>;
}

/** Installed skills (deduped by slug), their fired counts and the review queue: the same rows the
 *  snapshot route builds, for the Atlas (server/features/atlas.ts). */
export interface SkillUsageState {
  installed: InstalledSkill[];
  /** Top used ∪ Graveyard (aggregateSkillUsage). */
  usage: SkillUsageRow[];
  candidates: SkillCandidate[];
  /** The backfill has read every transcript: "never fired" can be trusted. */
  historyReady: boolean;
}

export interface SkillsFeature extends ServerFeature {
  debuts(ctx: FeatureContext, sinceMs: number): Promise<SkillDebuts>;
  usage(ctx: FeatureContext): Promise<SkillUsageState>;
}

export function createSkillsFeature(deps: SkillsFeatureDeps = {}): SkillsFeature {
  const home = deps.home ?? homedir();
  const skillsDir = deps.skillsDir ?? join(home, ".claude", "skills");
  const skillsRepoDir = deps.skillsRepoDir ?? join(home, ".claude", "skills-repo");
  const pluginsCacheDir = deps.pluginsCacheDir ?? join(home, ".claude", "plugins", "cache");
  const proposedDir = join(skillsDir, deps.proposedDirName ?? "_proposed");
  const claudeDir = join(home, ".claude");
  const upskillStateDir = deps.upskillStateDir ?? join(claudeDir, "upskill-state");
  const residentHome = deps.residentHome ?? join(home, ".alef-resident");
  const inventoryTtlMs = deps.inventoryTtlMs ?? DEFAULT_INVENTORY_TTL_MS;
  const recentLimit = deps.recentEventsLimit ?? SKILLS_RECENT_LIMIT;

  const runtimes = new Map<string, Runtime>();

  /** Repos this Mac has indexed sessions in (unique cwd -> its git root, or the cwd itself).
   *  Not a filesystem-wide crawl — only these are checked for repo-local .claude/skills. */
  function repoRootsFrom(ctx: FeatureContext): string[] {
    const cwds = new Set(ctx.db.listSessions().map((s) => s.cwd));
    const roots = new Set<string>();
    for (const cwd of cwds) roots.add(findGitRoot(cwd) ?? cwd);
    return [...roots];
  }

  function runtimeFor(ctx: FeatureContext): Runtime {
    const key = ctx.config.dbPath;
    let rt = runtimes.get(key);
    if (!rt) {
      const store = new SkillsStore(skillsStorePathFor(key));
      const storedCutoff = store.getMeta(META_CUTOFF_MS);
      const cutoffMs = storedCutoff ? Number(storedCutoff) : Date.now();
      if (!storedCutoff) store.setMeta(META_CUTOFF_MS, String(cutoffMs));
      const inventory = createSwr(() => scanInstalledSkills({ skillsDir, pluginsCacheDir, repoRoots: repoRootsFrom(ctx) }), {
        onError: (err) => ctx.log.error("skills", "inventory scan failed", String(err)),
      });
      rt = {
        store,
        inventory,
        candidates: createSwr(() => scanCandidates(proposedDir), {
          onError: (err) => ctx.log.error("skills", "candidate scan failed", String(err)),
        }),
        // Same SWR/TTL shape as `candidates`; its loader reuses `inventory`'s own SWR rather
        // than re-scanning installed skills a second time.
        institute: createSwr(
          async () =>
            buildInstituteSnapshot({
              autopilotLogPath: join(upskillStateDir, "autopilot.log"),
              autopilotJsonPath: join(upskillStateDir, "autopilot.json"),
              skillsDir,
              claudeDir,
              installed: await inventory.get(inventoryTtlMs),
              skillsRepoDir,
              residentHome,
              nowMs: Date.now(),
            }),
          { onError: (err) => ctx.log.error("skills", "School (study pipeline) scan failed", String(err)) },
        ),
        cutoffMs,
        backfillRunning: null,
      };
      runtimes.set(key, rt);
    }
    return rt;
  }

  function openEditorRoots(ctx: FeatureContext): string[] {
    return [skillsDir, skillsRepoDir, pluginsCacheDir, ...repoRootsFrom(ctx).map((r) => join(r, ".claude", "skills"))];
  }

  /** Kicks one backfill pass in the background, off the request path. A no-op while one is
   *  already running (onTick calls this every 10s; runSkillsBackfillPass itself is also a
   *  cheap no-op once backfill_done is set). */
  function kickBackfill(ctx: FeatureContext, rt: Runtime): void {
    if (rt.backfillRunning) return;
    rt.backfillRunning = runSkillsBackfillPass({ store: rt.store, projectsDir: ctx.config.projectsDir, cutoffMs: rt.cutoffMs })
      .then(() => undefined)
      .catch((err: unknown) => ctx.log.error("skills", "backfill pass failed", String(err)))
      .finally(() => {
        rt.backfillRunning = null;
      });
  }

  async function debuts(ctx: FeatureContext, sinceMs: number): Promise<SkillDebuts> {
    const rt = runtimeFor(ctx);
    const bySlug = indexInstalledBySlug(await rt.inventory.get(inventoryTtlMs));
    const descriptions = new Map([...bySlug].map(([slug, s]) => [slug, s.description]));
    const historyStartAt = rt.store.firstEventAt();
    const progress = backfillProgress(rt.store);
    if (!progress.done) return { ok: false, reason: `still reading skill history (${progress.percent}%)`, historyStartAt, debuts: [], descriptions };
    if (historyStartAt === null || Date.parse(historyStartAt) >= sinceMs) return { ok: false, reason: "the skill history starts inside the window", historyStartAt, debuts: [], descriptions };
    const debutList = rt.store.firstFiresSince(new Date(sinceMs).toISOString(), ["invoke", "slash"]).flatMap((f) => {
      const skill = bySlug.get(f.skillName);
      return skill ? [{ slug: f.skillName, firstFiredAt: f.firstAt, description: skill.description }] : []; // "/clear" and other built-ins aren't installed skills
    });
    return { ok: true, reason: null, historyStartAt, debuts: debutList, descriptions };
  }

  async function usage(ctx: FeatureContext): Promise<SkillUsageState> {
    const rt = runtimeFor(ctx);
    const [installed, candidates] = await Promise.all([rt.inventory.get(inventoryTtlMs), rt.candidates.get(inventoryTtlMs)]);
    const { topUsed, graveyard } = aggregateSkillUsage(rt.store.eventsSince(EPOCH_ISO, ["invoke", "slash", "suggested"]), installed, Date.now());
    return { installed: [...indexInstalledBySlug(installed).values()], usage: [...topUsed, ...graveyard], candidates, historyReady: backfillProgress(rt.store).done };
  }

  return {
    id: "skills",
    debuts,
    usage,
    routes: [
      {
        method: "GET",
        path: "/api/skills/snapshot",
        async handler(_req, res, ctx) {
          const rt = runtimeFor(ctx);
          const [installed, candidates, institute] = await Promise.all([
            rt.inventory.get(inventoryTtlMs),
            rt.candidates.get(inventoryTtlMs),
            rt.institute.get(inventoryTtlMs),
          ]);
          const events = rt.store.eventsSince(EPOCH_ISO, ["invoke", "slash", "suggested"]);
          const { topUsed, graveyard } = aggregateSkillUsage(events, installed, Date.now());
          const scannedAt = new Date(rt.inventory.peek()?.at ?? Date.now()).toISOString();
          respondJson(res, 200, {
            ok: true,
            topUsed,
            graveyard,
            candidates,
            installedCount: indexInstalledBySlug(installed).size,
            scannedAt,
            backfillProgress: backfillProgress(rt.store),
            institute,
            historyStartAt: rt.store.firstEventAt(),
          } satisfies SkillsSnapshotResult);
        },
      },
      {
        method: "GET",
        path: "/api/skills/session/:agentId",
        async handler(_req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return respondJson(res, 400, { ok: false, error: "invalid agent id" } satisfies SkillsError);
          const rt = runtimeFor(ctx);
          respondJson(res, 200, { ok: true, agentId, events: rt.store.eventsForSession(agentId) } satisfies SkillsSessionResult);
        },
      },
      {
        method: "POST",
        path: "/api/skills/open-editor",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies SkillsOpenEditorResult);
          }
          const requestedPath = isRecord(body) ? body.path : undefined;
          const resolved = await resolveSkillMdPath(openEditorRoots(ctx), requestedPath);
          if (!resolved.ok) return respondJson(res, resolved.status, { ok: false, error: resolved.error } satisfies SkillsOpenEditorResult);
          try {
            await ctx.executors.openEditor(resolved.abs);
            respondJson(res, 200, { ok: true } satisfies SkillsOpenEditorResult);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) } satisfies SkillsOpenEditorResult);
          }
        },
      },
    ],
    onIndexPass(ctx, newLinesBySession) {
      const events = detectSkillEventsBatch(newLinesBySession);
      if (events.length === 0) return;
      const rt = runtimeFor(ctx);
      const added = rt.store.insertEvents(events);
      if (added.length > 0) ctx.emit({ kind: "events", events: added } satisfies SkillsMessage);
    },
    onTick(ctx) {
      kickBackfill(ctx, runtimeFor(ctx));
    },
    snapshotExtras(ctx) {
      return { [SKILLS_RECENT_KEY]: runtimeFor(ctx).store.recentEvents(recentLimit) };
    },
  };
}

export const skillsFeature = createSkillsFeature();

/** The registered skills feature's usage rows (see SkillUsageState). */
export function skillUsageState(ctx: FeatureContext): Promise<SkillUsageState> {
  return skillsFeature.usage(ctx);
}

/** The registered skills feature's debuts (see SkillDebuts). */
export function skillDebutsSince(ctx: FeatureContext, sinceMs: number): Promise<SkillDebuts> {
  return skillsFeature.debuts(ctx, sinceMs);
}
