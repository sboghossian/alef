// "projects" (📁 Projects view): every project we have worked on, as the union of Alef's districts
// (repos with sessions) and the top-level folders of ~/Documents/Code, one entry per real folder.
//
// GET /api/projects              -> ProjectsResponse. Stale-while-revalidate (5 min), single-flight
//                                   (createSwr), so a burst of requests shares one scan; only the
//                                   very first call waits for it. Per folder: git (async execFile,
//                                   timeout), README first line, manifests -> stack, deploy config,
//                                   category + stage with the reason each rule fired.
// GET /api/projects/:id/tree     -> one level of a folder (?path=<relative>), depth 1, capped.
//   SAFETY: the folder comes from the server's own list by id, never from the request; the relative
//   path goes through resolveInside (no traversal, no symlink escape, no secret names), and neither
//   the root nor the resolved folder may be privacy-guarded (a launchd node HANGS opening
//   ~/Desktop or ~/Downloads) or a refused root ($HOME, "/", .ssh…). Only names and sizes leave.
//
// Sessions: counts and last-active come from the world's islands; the view lists the sessions
// themselves from the world snapshot it already has. Artifacts: the artifacts feature's own list
// (latestArtifactItems), joined by district; null until that feature has read its store.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import {
  PROJECT_ID_RE,
  type FoldedFolder,
  type ProjectItem,
  type ProjectsError,
  type ProjectsResponse,
  type ProjectTreeResponse,
} from "../../shared/features/projects.js";
import { respondJson } from "../http.js";
import { isPrivacyGuarded } from "../privacy-guard.js";
import { latestArtifactItems } from "./artifacts.js";
import { usageCostByIsland } from "./usage.js";
import { createSwr, type Swr } from "./cache-lib.js";
import { isRefusedRoot } from "./code-repos.js";
import { categorize, foldCopies, stageOf, unionProjects, guessStack, type DistrictInput } from "./projects-lib.js";
import { EMPTY_FACTS, listCodeFolders, listOneLevel, mapLimit, probeFolder, taxonomyAliases, vaultProjectNotes, withTimeout, type FolderFacts } from "./projects-scan.js";
import { matchProjectNote } from "./project-match-lib.js";
import { applyScan, loadHistory, saveHistory, type HistoryState } from "./projects-history.js";
import { listPreviewsIn, loadNotes, mirrorPreviews, previewFor, readPreview, scanVaultSessions, sessionsFor } from "./projects-extra.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { isPlausibleRelPath, isSecretPath, resolveInside, safePathStatus } from "./safe-path.js";
import { vaultRoot } from "../config.js";

const TTL_MS = 5 * 60_000;
const FOLDER_TIMEOUT_MS = 12_000;
const ARTIFACT_LIST_MAX = 12;

export interface ProjectsFeatureDeps {
  home?: string;
  /** Default: ~/Documents/Code. */
  codeDir?: string;
  /** Default: <vaultRoot()>/20-Projects. */
  vaultProjectsDir?: string;
  /** Default: ~/Documents/Code/roadmap/public/previews (read-only). Copied once into
   *  <dataDir>/roadmap-previews on start, which is served first; this folder is the fallback. */
  previewsDir?: string;
  /** Default: <vaultRoot()>/10-Sessions. */
  sessionsDir?: string;
  /** Where projects-history.json and projects-notes.json live; default beside world.db (none for ":memory:"). */
  dataDir?: string | null;
  /** Tests: replace the usage store's per-district 30-day cost. */
  costs?: (ctx: FeatureContext) => Promise<Map<string, number>>;
  ttlMs?: number;
  gitTimeoutMs?: number;
  concurrency?: number;
  now?: () => number;
  /** Tests: replace the world's districts. */
  districts?: (ctx: FeatureContext) => { districts: DistrictInput[]; skipped: number };
  /** Tests: replace the artifacts feature's list. */
  artifacts?: () => ReturnType<typeof latestArtifactItems>;
}

/** Districts the world knows, as inputs: the harness, empty paths and refused roots ($HOME…) are not projects. */
export function worldDistricts(ctx: FeatureContext, home: string): { districts: DistrictInput[]; skipped: number } {
  const districts: DistrictInput[] = [];
  let skipped = 0;
  for (const i of ctx.worldViews().islands) {
    if (i.id === "harness" || !i.path || isRefusedRoot(i.path, home)) {
      skipped += 1;
      continue;
    }
    districts.push({ id: i.id, name: i.name, path: i.path, sessions: i.agentCount, lastActive: i.lastActive });
  }
  return { districts, skipped };
}

/** The feature plus its own list, so a reader (the project page) shares the one cached scan. */
export type ProjectsFeature = ServerFeature & {
  /** The cached scan (stale-while-revalidate) with today's joins; only the very first call waits. */
  list(ctx: FeatureContext): Promise<ProjectsResponse>;
};

export function createProjectsFeature(deps: ProjectsFeatureDeps = {}): ProjectsFeature {
  const home = deps.home ?? homedir();
  const codeDir = deps.codeDir ?? join(home, "Documents", "Code");
  const vaultDir = deps.vaultProjectsDir ?? join(vaultRoot(home), "20-Projects");
  const ttl = deps.ttlMs ?? TTL_MS;
  const now = deps.now ?? Date.now;
  const gitTimeoutMs = deps.gitTimeoutMs ?? 4_000;
  const concurrency = deps.concurrency ?? 6;
  const previewsDir = deps.previewsDir ?? join(codeDir, "roadmap", "public", "previews");
  const sessionsDir = deps.sessionsDir ?? join(vaultRoot(home), "10-Sessions");
  const dataDirOf = (ctx: FeatureContext): string | null => (deps.dataDir !== undefined ? deps.dataDir : ctx.config.dbPath === ":memory:" ? null : dirname(ctx.config.dbPath));
  let swr: Swr<ProjectsResponse> | null = null;
  let history: HistoryState | null = null;
  const previewDirs = (ctx: FeatureContext): string[] => {
    const dataDir = dataDirOf(ctx);
    return dataDir ? [join(dataDir, "roadmap-previews"), previewsDir] : [previewsDir];
  };

  async function build(ctx: FeatureContext): Promise<ProjectsResponse> {
    const { districts, skipped } = (deps.districts ?? ((c) => worldDistricts(c, home)))(ctx);
    const dataDir = dataDirOf(ctx);
    const historyPath = dataDir ? join(dataDir, "projects-history.json") : null;
    const [folders, vaultNotes, aliases, previews, vaultSessions, notes] = await Promise.all([
      listCodeFolders(codeDir),
      vaultProjectNotes(vaultDir),
      taxonomyAliases(dirname(vaultDir)),
      listPreviewsIn(previewDirs(ctx)),
      scanVaultSessions(sessionsDir).catch(() => new Map()),
      loadNotes(dataDir ? join(dataDir, "projects-notes.json") : null),
    ]);
    history ??= await loadHistory(historyPath, now());
    const union = unionProjects(districts, folders);
    const at = now();
    let timedOut = 0;
    const probed = await mapLimit(union, concurrency, async (u) => {
      const r = await withTimeout(probeFolder(u.path, u.name, { home, gitTimeoutMs }), FOLDER_TIMEOUT_MS);
      const facts: FolderFacts = r === "timeout" ? { ...EMPTY_FACTS, unread: false, timedOut: true } : r;
      if (facts.timedOut) timedOut += 1;
      const pre = stageOf({ commits: facts.git?.commits ?? null, lastCommit: facts.git?.lastCommit ?? null, lastActive: u.lastActive, deploy: facts.deploy, isGit: facts.isGit, now: at, files: facts.files });
      return { u, facts, activityAt: pre.activityAt };
    });
    // Worktrees and clones fold into one card (projects-lib foldCopies says which and why).
    const folds = foldCopies(probed.map((x) => ({ id: x.u.id, path: x.u.path, worktreeOf: x.facts.worktreeOf, stale: x.facts.worktreeStale, remote: x.facts.git?.remote ?? null, sessions: x.u.sessions, activityAt: x.activityAt })));
    const childrenOf = new Map<string, (typeof probed)[number][]>();
    for (const x of probed) {
      const f = folds.get(x.u.id);
      if (f) childrenOf.set(f.into, [...(childrenOf.get(f.into) ?? []), x]);
    }
    const newest = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : (a ?? b));
    const items = probed
      .filter((x) => !folds.has(x.u.id))
      .map(({ u, facts }): ProjectItem => {
        const kids = childrenOf.get(u.id) ?? [];
        const sessions = u.sessions + kids.reduce((n, k) => n + k.u.sessions, 0);
        const lastActive = kids.reduce((m, k) => newest(m, k.u.lastActive), u.lastActive);
        const lastCommit = kids.reduce((m, k) => newest(m, k.facts.git?.lastCommit ?? null), facts.git?.lastCommit ?? null);
        const deploy = facts.deploy ?? kids.find((k) => k.facts.deploy)?.facts.deploy ?? null;
        // DATA-7: the note's code_path, then its github, then the taxonomy's aliases, then the folder name.
        const remotes = [facts.git?.remote, ...kids.map((k) => k.facts.git?.remote)].filter((r): r is string => typeof r === "string");
        const match = matchProjectNote({ name: u.name, path: u.path, remotes, foldedPaths: kids.map((k) => k.u.path) }, vaultNotes, aliases, home);
        const vaultNote = match?.slug ?? null;
        const cat = categorize({ name: u.name, remote: facts.git?.remote ?? null, readme: facts.readme, vaultNote });
        const st = stageOf({ commits: facts.git?.commits ?? null, lastCommit, lastActive, deploy, isGit: facts.isGit, now: at, files: facts.files });
        const folded: FoldedFolder[] = kids
          .map((k) => ({ id: k.u.id, name: k.u.name, path: k.u.path, kind: k.facts.worktreeOf ? ("worktree" as const) : ("clone" as const), reason: folds.get(k.u.id)?.reason ?? "", islandId: k.u.islandId, sessions: k.u.sessions, branch: k.facts.git?.branch ?? null, activityAt: k.activityAt }))
          .sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.name.localeCompare(b.name));
        return {
          id: u.id,
          name: u.name,
          path: u.path,
          kind: facts.isGit ? "repo" : "folder",
          islandId: u.islandId,
          sessions,
          lastActive,
          git: facts.git,
          readme: facts.readme,
          stack: guessStack(facts.stack),
          category: cat.category,
          categoryReason: cat.reason,
          vaultNote,
          vaultMatch: match?.by ?? null,
          stage: st.stage,
          stageReason: st.reason,
          deploy,
          activityAt: st.activityAt,
          hasPreview: previewFor([u.name, ...folded.map((f) => f.name)], previews) !== null,
          notes: notes.get(u.name.toLowerCase()) ?? null,
          vaultSessions: sessionsFor([u.name], vaultSessions),
          changes: [],
          costUsd30d: null, // joined per request with the artifacts
          artifacts: null, // joined per request (withArtifacts): the artifacts feature's list changes faster than a 5-minute scan
          unread: facts.unread,
          folded,
        };
      });
    items.sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.name.localeCompare(b.name));
    // A scan where many git reads timed out would read as "commits unknown", never as a change (diffFacts skips nulls).
    history = applyScan(history, items, at);
    for (const p of items) p.changes = history.projects[p.id]?.changes ?? [];
    void saveHistory(historyPath, history);
    return { ok: true, items, scannedAt: new Date(at).toISOString(), skipped, folded: folds.size, timedOut, history: { since: history.since, refreshes: history.refreshes.slice(0, 10) } };
  }

  /** The cached scan with the artifacts feature's CURRENT list joined by district (cheap, in memory). */
  async function withJoins(r: ProjectsResponse, ctx: FeatureContext): Promise<ProjectsResponse> {
    const art = (deps.artifacts ?? latestArtifactItems)();
    const costs = await (deps.costs ?? ((c) => usageCostByIsland(c, 30)))(ctx).catch(() => null);
    if (!art && !costs) return r;
    return {
      ...r,
      items: r.items.map((p) => {
        const islands = new Set([p.islandId, ...p.folded.map((f) => f.islandId)].filter((x): x is string => x !== null));
        const out = { ...p };
        if (art) {
          const mine = islands.size ? art.filter((a) => a.islandId !== null && islands.has(a.islandId)) : [];
          out.artifacts = { count: mine.length, items: mine.slice(0, ARTIFACT_LIST_MAX).map((a) => ({ id: a.id, title: a.title })) };
        }
        if (costs) {
          const usd = [...islands].reduce((n, i) => n + (costs.get(i) ?? 0), 0);
          out.costUsd30d = usd > 0 ? usd : null;
        }
        return out;
      }),
    };
  }

  const list = (ctx: FeatureContext): Promise<ProjectsResponse> => {
    swr ??= createSwr(() => build(ctx), { now, onError: (err) => ctx.log.warn("projects", `refresh failed: ${String(err).slice(0, 120)}`) });
    return swr.get(ttl).then((r) => withJoins(r, ctx));
  };

  const fail = (res: ServerResponse, status: number, error: string): void => respondJson(res, status, { ok: false, error } satisfies ProjectsError);

  return {
    id: "projects",
    list,
    onStart(ctx) {
      // Once, in the background (never holds up boot): Alef's own copy of the roadmap's screenshots.
      // Under vitest only a test that names its own previews folder copies (never the real roadmap; same guard as logs.ts).
      const dataDir = dataDirOf(ctx);
      if (!dataDir || (process.env.VITEST && deps.previewsDir === undefined)) return;
      void mirrorPreviews(previewsDir, join(dataDir, "roadmap-previews")).then((n) => {
        if (n !== null) ctx.log.info("projects", `copied ${n} preview images into data/roadmap-previews`);
      });
    },
    routes: [
      {
        method: "GET",
        path: "/api/projects",
        async handler(_req, res, ctx) {
          try {
            respondJson(res, 200, await list(ctx));
          } catch (err) {
            ctx.log.warn("projects", `scan failed: ${String(err).slice(0, 120)}`);
            fail(res, 500, "could not read the projects");
          }
        },
      },
      {
        // The screenshot of one project. The file name comes from the server's own preview match for
        // this project (never from the request); readPreview refuses anything that resolves outside
        // the previews folder, a non-image type or a big file.
        method: "GET",
        path: "/api/projects/:id/preview",
        async handler(_req, res, ctx, params) {
          const id = params.id ?? "";
          if (!PROJECT_ID_RE.test(id)) return fail(res, 400, "invalid project id");
          const data = await list(ctx).catch(() => null);
          const project = data?.items.find((p) => p.id === id);
          if (!project?.hasPreview) return fail(res, 404, "no preview");
          const hit = previewFor([project.name, ...project.folded.map((f) => f.name)], await listPreviewsIn(previewDirs(ctx)));
          const img = hit ? await readPreview(hit.dir, hit.file) : null;
          if (!img) return fail(res, 404, "no preview");
          res.writeHead(200, { "Content-Type": img.type, "Content-Length": img.body.length, "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "private, max-age=3600" });
          res.end(img.body);
        },
      },
      {
        method: "GET",
        path: "/api/projects/:id/tree",
        async handler(req, res, ctx, params) {
          const id = params.id ?? "";
          if (!PROJECT_ID_RE.test(id)) return fail(res, 400, "invalid project id");
          const rel = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
          if (rel !== "" && !isPlausibleRelPath(rel)) return fail(res, 400, "bad-path");
          let data: ProjectsResponse;
          try {
            data = await list(ctx);
          } catch {
            return fail(res, 500, "could not read the projects");
          }
          // A folded worktree/clone is browsable too: its path still comes from the server's own list.
          const project = data.items.find((p) => p.id === id) ?? data.items.flatMap((p) => p.folded).find((f) => f.id === id);
          if (!project) return fail(res, 404, "unknown project");
          const root = resolve(project.path);
          if (isPrivacyGuarded(root, home) || isRefusedRoot(root, home)) return fail(res, 403, "this folder is not browsed from here");
          const safe = await resolveInside(root, rel);
          if (!safe.ok) return fail(res, safePathStatus(safe.error), safe.error);
          // Every segment counts as a directory here: ".git", ".ssh", ".aws"… are never opened, not even to list names.
          if (isSecretPath(join(safe.rel, "x"))) return fail(res, 403, "secret");
          if (isPrivacyGuarded(safe.abs, home)) return fail(res, 403, "this folder is not browsed from here");
          const listing = await listOneLevel(safe.abs).catch(() => null);
          if (listing === "timeout") return fail(res, 504, "reading the folder took too long");
          if (!listing) return fail(res, 404, "not a folder");
          respondJson(res, 200, { ok: true, path: safe.rel, entries: listing.entries, truncated: listing.truncated } satisfies ProjectTreeResponse);
        },
      },
    ],
  };
}

export const projectsFeature = createProjectsFeature();
