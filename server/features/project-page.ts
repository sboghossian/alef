// "project-page" (UX-3): one page per project, joining the World's city, the Library's entry and
// the vault's index note (shared/features/project-page.ts has the routes). It owns no scan: the
// Library list is the projects feature's own cached one, the sessions are the world's, verdicts
// come from latestOutcomeRecords(), open todos from the FleetTracker, spend from the usage store,
// and the only file it opens is the one index note the page shows (its head, from a slug the
// server listed itself). Home's "Pick up where you left off" cards are the same page, shorter.

import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import {
  PROJECT_KEY_RE,
  RECENT_DEFAULT,
  RECENT_MAX,
  type ProjectCardsResponse,
  type ProjectIndexResponse,
  type ProjectPage,
  type ProjectPageError,
  type ProjectPageResponse,
} from "../../shared/features/project-page.js";
import type { ProjectsResponse } from "../../shared/features/projects.js";
import type { TodoList } from "../../shared/features/todos.js";
import type { WorldAgent } from "../../shared/types.js";
import { vaultRoot } from "../config.js";
import { respondJson } from "../http.js";
import { fleetTracker } from "./fleet-tracker.js";
import { latestOutcomeRecords } from "./outcomes.js";
import { buildProjectPage, citiesOf, projectIndex, recentProjects, resolveProjectKey, type ResolvedKey } from "./project-page-lib.js";
import { projectsFeature } from "./projects.js";
import { readHead, vaultSlugs } from "./projects-scan.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { usageCostByIsland } from "./usage.js";

const NOTE_HEAD_BYTES = 64 * 1024;
/** Sessions on a Home card. */
const CARD_SESSIONS = 3;

export interface ProjectPageDeps {
  /** Default: the projects feature's cached list. */
  projects?: (ctx: FeatureContext) => Promise<ProjectsResponse>;
  /** Default: <vaultRoot()>/20-Projects. */
  vaultProjectsDir?: string;
  outcomes?: () => readonly OutcomeRecord[];
  todoList?: (sessionId: string) => TodoList | null;
  costs?: (ctx: FeatureContext) => Promise<ReadonlyMap<string, number>>;
}

/** What every page of one request is joined from: read once. */
interface Joins {
  list: ProjectsResponse;
  agents: readonly WorldAgent[];
  outcomes: ReadonlyMap<string, OutcomeRecord>;
  costs: ReadonlyMap<string, number> | null;
}

export function createProjectPageFeature(deps: ProjectPageDeps = {}): ServerFeature {
  const projects = deps.projects ?? ((ctx: FeatureContext) => projectsFeature.list(ctx));
  const vaultDir = (): string => deps.vaultProjectsDir ?? join(vaultRoot(), "20-Projects");
  const outcomes = deps.outcomes ?? latestOutcomeRecords;
  const todoList = deps.todoList ?? ((id: string) => fleetTracker.todoList(id));
  const costs = deps.costs ?? ((ctx: FeatureContext) => usageCostByIsland(ctx, 30));

  const fail = (res: ServerResponse, status: number, error: string): void => respondJson(res, status, { ok: false, error } satisfies ProjectPageError);

  /** City id → name, for the cities the world knows (never the harness). */
  function cityNames(ctx: FeatureContext): (id: string) => string | null {
    const names = new Map(ctx.worldViews().islands.filter((i) => i.id !== "harness").map((i) => [i.id, i.name]));
    return (id) => names.get(id) ?? null;
  }

  async function joins(ctx: FeatureContext): Promise<Joins> {
    const [c, list] = await Promise.all([costs(ctx).catch(() => null), projects(ctx)]);
    return {
      list,
      agents: ctx.worldViews().agents,
      outcomes: new Map(outcomes().map((r) => [r.sessionId, r])),
      costs: c,
    };
  }

  async function page(key: string, resolved: ResolvedKey, j: Joins, sessionCap?: number): Promise<ProjectPage> {
    const noteText = resolved.slug ? await readHead(join(vaultDir(), resolved.slug, "_index.md"), NOTE_HEAD_BYTES) : null;
    return buildProjectPage({ key, resolved, agents: j.agents, outcomes: j.outcomes, todoList, costs: j.costs, noteText, sessionCap });
  }

  return {
    id: "project-page",
    routes: [
      {
        method: "GET",
        path: "/api/project-page",
        async handler(_req, res, ctx) {
          try {
            const list = await projects(ctx);
            respondJson(res, 200, { ok: true, items: projectIndex(list.items) } satisfies ProjectIndexResponse);
          } catch (err) {
            ctx.log.warn("project-page", `index failed: ${String(err).slice(0, 120)}`);
            fail(res, 500, "could not read the projects");
          }
        },
      },
      {
        // Listed before /:key, which would otherwise take "recent" as a project.
        method: "GET",
        path: "/api/project-page/recent",
        async handler(req, res, ctx) {
          const raw = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("n") ?? RECENT_DEFAULT);
          const n = Number.isFinite(raw) ? Math.min(RECENT_MAX, Math.max(1, Math.floor(raw))) : RECENT_DEFAULT;
          try {
            const j = await joins(ctx);
            const names = cityNames(ctx);
            const cards = await Promise.all(recentProjects(j.list.items, j.agents, n).map((p) => page(p.id, { item: p, slug: p.vaultNote, cities: citiesOf(p, names) }, j, CARD_SESSIONS)));
            respondJson(res, 200, { ok: true, cards } satisfies ProjectCardsResponse);
          } catch (err) {
            ctx.log.warn("project-page", `recent failed: ${String(err).slice(0, 120)}`);
            fail(res, 500, "could not read the projects");
          }
        },
      },
      {
        method: "GET",
        path: "/api/project-page/:key",
        async handler(_req, res, ctx, params) {
          const key = params.key ?? "";
          if (!PROJECT_KEY_RE.test(key)) return fail(res, 400, "invalid project key");
          try {
            const j = await joins(ctx);
            const resolved = resolveProjectKey(key, j.list.items, await vaultSlugs(vaultDir()), cityNames(ctx));
            if (!resolved) return fail(res, 404, "unknown project");
            respondJson(res, 200, { ok: true, project: await page(key, resolved, j) } satisfies ProjectPageResponse);
          } catch (err) {
            ctx.log.warn("project-page", `page failed: ${String(err).slice(0, 120)}`);
            fail(res, 500, "could not read the project");
          }
        },
      },
    ],
  };
}

export const projectPageFeature = createProjectPageFeature();
