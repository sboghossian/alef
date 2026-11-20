// "atlas" (🗺️ Atlas view): every capability on this Mac as leaves of one radial map, filed under
// 8 capability departments (bundle mention, pack, keyword, then Jev: atlas-lib.ts), each on the
// manual / assisted / autonomous ladder with evidence.
// Nothing is scanned twice: skills + fired counts come from the skills feature (skillUsageState),
// schedules and launchd load state from automations (discoverDefaultAutomations: its own
// `launchctl list`, read before the first answer, so a paused job never reads as running), Tower
// workers from careers, subagent spawns from subagents, CLIs from the cli-station scanner. Only
// ~/.claude/agents/*.md (nobody lists them yet), the bundle files and the memory dir listing are
// read here; atlas-lib.ts has the rules. Leaves no rule files go to Jev (atlas-jev.ts): a build
// only reads its cache (data/atlas-jev.json) and starts at most one background batch, so Jev is
// never in a request's path and "Jev answers" stays pending until it has answered.
//
// GET  /api/atlas           -> AtlasResponse. Stale-while-revalidate: 60 s, 5 s while a source is
//                              pending. A request waits at most BUILD_TIMEOUT_MS for a build, so a
//                              stuck read (an iCloud dataless file) can't hang the route; a retry
//                              joins the build still running instead of starting another.
// POST /api/atlas/open/:id  -> opens that leaf's own file in the editor (ctx.executors.openEditor,
//                              the open-editor feature's executor).
//   SAFETY INVARIANT: the editor only ever receives a real file (stat isFile) with a single link
//   (nlink 1: no hard link to a file elsewhere) whose realpath is inside its kind's root
//   (skills: ~/.claude/{skills,skills-repo,plugins/cache} and named SKILL.md; agents:
//   ~/.claude/agents; routines: ~/Library/LaunchAgents; CLIs: the home dir, and only a script
//   (CLI_SCRIPT_RE) or an executable), with no secret-looking name (safe-path.ts), checked when
//   the scan sets canOpen and again at click time. The path comes from the server's own scan,
//   never from the request.
//
// PRIVACY: bundle text is read into memory to count mentions and never leaves it; memory files
// are counted from a directory listing and never opened.

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AtlasLeaf, AtlasOpenResult, AtlasResponse } from "../../shared/features/atlas.js";
import { respondJson } from "../http.js";
import { createAtlasJev, type AtlasJev } from "./atlas-jev.js";
import { jevKey } from "./atlas-jev-lib.js";
import { buildAtlas, countMemoryFiles, jevAsk, readBundles, scanAgents, type AtlasInput } from "./atlas-lib.js";
import { discoverDefaultAutomations, isIncompleteDiscovery } from "./automations.js";
import { createSwr, type Swr } from "./cache-lib.js";
import { latestCareerWorkers } from "./careers.js";
import { scanCliRegistry } from "./cli-station-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { resolveInside, safePathStatus } from "./safe-path.js";
import { resolveSkillMdPath } from "./skills-open-editor.js";
import { skillUsageState, type SkillUsageState } from "./skills.js";
import { latestSubagentRecords } from "./subagents/index.js";

const TTL_MS = 60_000;
const PENDING_TTL_MS = 5_000;
const BUILD_TIMEOUT_MS = 10_000;
/** A CLI entry opens only when it is a script (or has an execute bit): never a note or a data file. */
const CLI_SCRIPT_RE = /\.(sh|bash|zsh|py|ts|js|mjs|cjs|rb)$/i;

export interface AtlasSources {
  skills(ctx: FeatureContext): Promise<SkillUsageState>;
  /** `onIncomplete`: a read failed (other than "not there"), so the list may be short. */
  automations(onIncomplete?: () => void): Promise<AtlasInput["automations"]>;
  workers(): AtlasInput["workers"];
  subagents(): AtlasInput["subagents"];
}

export interface AtlasFeatureDeps {
  home?: string;
  memoryDir?: string;
  launchAgentsDir?: string;
  sources?: Partial<AtlasSources>;
  buildTimeoutMs?: number;
  /** The Jev filer; default: one per world db, its cache next to world.db, the server's TypeSafe key. */
  jev?: AtlasJev;
  /** Cache ages (tests): TTL_MS, and PENDING_TTL_MS while a source is pending. */
  ttlMs?: number;
  pendingTtlMs?: number;
}

type Openable = { ok: true; abs: string } | { ok: false; status: number; error: string };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createAtlasFeature(deps: AtlasFeatureDeps = {}): ServerFeature {
  const home = deps.home ?? homedir();
  const claude = join(home, ".claude");
  const memoryDir = deps.memoryDir ?? join(claude, "projects", home.replace(/[\\/]/g, "-"), "memory");
  const agentsDir = join(claude, "agents");
  const launchAgentsDir = deps.launchAgentsDir ?? join(home, "Library", "LaunchAgents");
  const skillRoots = [join(claude, "skills"), join(claude, "skills-repo"), join(claude, "plugins", "cache")];
  const buildTimeoutMs = deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? TTL_MS;
  const pendingTtlMs = deps.pendingTtlMs ?? PENDING_TTL_MS;
  const filers = new Map<string, AtlasJev>();
  const jevFor = (ctx: FeatureContext): AtlasJev => {
    if (deps.jev) return deps.jev;
    let f = filers.get(ctx.config.dbPath);
    if (!f) {
      f = createAtlasJev({
        path: join(dirname(ctx.config.dbPath), "atlas-jev.json"),
        apiKey: () => ctx.config.typesafeApiKey ?? process.env.TYPESAFE_API_KEY ?? "",
        fetchImpl: ctx.config.typesafeFetchImpl,
        log: ctx.log,
      });
      filers.set(ctx.config.dbPath, f);
    }
    return f;
  };
  const src: AtlasSources = {
    skills: deps.sources?.skills ?? skillUsageState,
    automations:
      deps.sources?.automations ??
      (async (onIncomplete) => {
        const list = await discoverDefaultAutomations();
        if (isIncompleteDiscovery(list)) onIncomplete?.();
        return list;
      }),
    workers: deps.sources?.workers ?? latestCareerWorkers,
    subagents: deps.sources?.subagents ?? latestSubagentRecords,
  };
  /** Sources failing as of the last build, per world db: each failure is logged when it starts
   *  and once when the source reads again, not on every build. */
  const failing = new Map<string, Set<string>>();
  function reportFailures(ctx: FeatureContext, now: ReadonlyMap<string, { level: "warn" | "error"; err: unknown }>): void {
    const before = failing.get(ctx.config.dbPath) ?? new Set<string>();
    for (const [what, f] of now) {
      if (!before.has(what)) ctx.log[f.level]("atlas", `${what}: a read failed; the Jev cache isn't pruned until it reads again`, f.err === undefined ? undefined : String(f.err));
    }
    for (const what of before) if (!now.has(what)) ctx.log.info("atlas", `${what}: reads again`);
    failing.set(ctx.config.dbPath, new Set(now.keys()));
  }
  const runtimes = new Map<string, Swr<AtlasResponse>>();
  /** The build running now, per world db: kept past a request's timeout so a retry joins it. */
  const running = new Map<string, Promise<AtlasResponse>>();

  /** The safety invariant above, checked from the disk as it is now. */
  async function openable(leaf: Pick<AtlasLeaf, "kind" | "path">): Promise<Openable> {
    if (!leaf.path) return { ok: false, status: 409, error: "this one has no file of its own" };
    let abs: string;
    if (leaf.kind === "skill") {
      const r = await resolveSkillMdPath(skillRoots, leaf.path);
      if (!r.ok) return r;
      abs = r.abs;
    } else {
      const root = leaf.kind === "agent" ? agentsDir : leaf.kind === "routine" ? launchAgentsDir : home;
      const r = await resolveInside(root, leaf.path, { allowAbsolute: true });
      if (!r.ok) return { ok: false, status: safePathStatus(r.error), error: r.error };
      abs = r.abs;
    }
    let st;
    try {
      st = await stat(abs);
    } catch {
      return { ok: false, status: 404, error: "not-found" };
    }
    if (!st.isFile()) return { ok: false, status: 400, error: "not a file" };
    if (st.nlink > 1) return { ok: false, status: 403, error: "hard-linked: the same file lives somewhere else too" };
    if (leaf.kind === "cli" && !CLI_SCRIPT_RE.test(abs) && (st.mode & 0o111) === 0) return { ok: false, status: 403, error: "not a script" };
    return { ok: true, abs };
  }

  async function build(ctx: FeatureContext): Promise<AtlasResponse> {
    const nowMs = Date.now();
    const empty: SkillUsageState = { installed: [], usage: [], candidates: [], historyReady: false };
    // A failed or partial source hides leaves that still exist: this build must not prune Jev's cache.
    const failures = new Map<string, { level: "warn" | "error"; err: unknown }>();
    const fail =
      (what: string, level: "warn" | "error" = "warn") =>
      (err?: unknown): void => {
        if (!failures.has(what)) failures.set(what, { level, err });
      };
    const [bundles, memoryFiles, agents, clis, skills, automations] = await Promise.all([
      readBundles(join(memoryDir, "_L2")),
      countMemoryFiles(memoryDir),
      scanAgents(agentsDir, fail("agents")),
      scanCliRegistry(join(claude, "clis"), fail("CLI registry")),
      src.skills(ctx).catch((err: unknown) => (fail("skills source", "error")(err), empty)),
      src.automations(fail("automations")).catch((err: unknown) => (fail("automations source", "error")(err), [])),
    ]);
    reportFailures(ctx, failures);
    const failed = failures.size > 0;
    const workers = src.workers();
    const subagents = src.subagents();
    const jev = jevFor(ctx);
    await jev.load();
    const { departments, leaves, jevAsks } = buildAtlas({ nowMs, bundleTexts: bundles.texts, bundleCounts: bundles.counts, skills, historyReady: skills.historyReady, agents, automations, workers, subagents, clis: clis.clis, jev: (a) => jev.lookup(a) });
    jev.request(jevAsks);
    const canOpen = await Promise.all(leaves.map(async (l) => (await openable(l)).ok));
    const pending = [
      workers === null ? "Tower runs" : null,
      subagents === null ? "subagent runs" : null,
      automations.some((a) => a.kind === "launchd" && a.loaded === undefined) ? "launchd load state" : null,
      skills.historyReady ? null : "skill history",
      jevAsks.length ? "Jev answers" : null,
    ].filter((p): p is string => p !== null);
    // Only a complete leaf set may prune: while a source is still reading, its leaves are missing, not gone.
    if (!failed && pending.every((p) => p === "Jev answers")) jev.prune(new Set(leaves.map((l) => jevKey(jevAsk(l)))));
    const bundleTotal = [...bundles.counts.values()].reduce((a, b) => a + b, 0);
    return {
      ok: true,
      at: new Date(nowMs).toISOString(),
      hub: { memoryFiles, bundles: bundleTotal },
      departments,
      leaves: leaves.map((l, i) => ({ ...l, canOpen: canOpen[i] ?? false })),
      skillsHistoryReady: skills.historyReady,
      pending,
    };
  }

  function atlasFor(ctx: FeatureContext): Promise<AtlasResponse> {
    const key = ctx.config.dbPath;
    let swr = runtimes.get(key);
    if (!swr) {
      const load = (): Promise<AtlasResponse> => {
        let p = running.get(key);
        if (!p) {
          p = build(ctx).finally(() => running.delete(key));
          running.set(key, p);
        }
        return withTimeout(p, buildTimeoutMs, "the atlas scan"); // only the wait times out
      };
      swr = createSwr(load, { onError: (err) => ctx.log.error("atlas", "scan failed", String(err)) });
      runtimes.set(key, swr);
    }
    return swr.get(swr.peek()?.value.pending.length ? pendingTtlMs : ttlMs);
  }

  return {
    id: "atlas",
    routes: [
      {
        method: "GET",
        path: "/api/atlas",
        async handler(_req, res, ctx) {
          try {
            respondJson(res, 200, await atlasFor(ctx));
          } catch (err) {
            respondJson(res, 503, { ok: false, error: String(err instanceof Error ? err.message : err) });
          }
        },
      },
      {
        method: "POST",
        path: "/api/atlas/open/:id",
        async handler(_req, res, ctx, params) {
          const reply = (status: number, body: AtlasOpenResult): void => respondJson(res, status, body);
          // The page GETs before it can click, so the last scan answers without a rescan.
          let atlas = runtimes.get(ctx.config.dbPath)?.peek()?.value;
          if (!atlas) {
            try {
              atlas = await atlasFor(ctx);
            } catch (err) {
              return reply(503, { ok: false, error: String(err instanceof Error ? err.message : err) });
            }
          }
          const leaf = atlas.leaves.find((l) => l.id === params.id);
          if (!leaf) return reply(404, { ok: false, error: "unknown leaf" });
          const r = await openable(leaf); // again now: the scan can be a minute old
          if (!r.ok) return reply(r.status, { ok: false, error: r.error });
          try {
            await ctx.executors.openEditor(r.abs);
            reply(200, { ok: true });
          } catch (err) {
            reply(500, { ok: false, error: String(err).slice(0, 200) });
          }
        },
      },
    ],
  };
}

export const atlasFeature = createAtlasFeature();
