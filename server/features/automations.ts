// "automations": everything automatable on this Mac in one list — launchd jobs
// (~/Library/LaunchAgents/com.stephane.*.plist, plus dev.dashable.yalla-brief read-only)
// merged with the skills something actually schedules (~/.claude/skills/*/SKILL.md run by a
// plist or a ~/.claude/scheduled-tasks entry, or whose description says a launchd/cron job
// fires them; see scheduleEvidence in automations-lib), each with schedule, last run/status
// and its latest output document. Discovery is cached stale-while-revalidate: requests answer
// from the last list and a background refresh (plus the 60s tick) keeps it current.
//
// Read-only except POST /api/automations/:id/run, which requires { confirm: true } and only
// ever runs `launchctl kickstart gui/<uid>/<com.stephane.label>` (never load/unload, never -k,
// never a dev.dashable.* job — that namespace is always-live infra). Anything else answers
// with a dispatch command ("/yalla-brief") for the prompt box. The executor is injectable;
// tests never run a real job.

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Automation, AutomationOutput, AutomationRunResult, AutomationsResponse } from "../../shared/features/automations.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { isKickstartableLabel, outputKind, outputSpecs, parseSkillFrontmatter, scheduleEvidence, skillRefsIn, statedCadence, type OutputSpec, type ScheduleEvidence, type SkillMeta } from "./automations-lib.js";
import { createSwr } from "./cache-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { extractRoutineFields, formatSchedule, parseLaunchctlList, parsePlistXml, type LaunchctlEntry } from "./routines-lib.js";

const execFileAsync = promisify(execFile);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const READONLY_LAUNCHD_LABELS = ["dev.dashable.yalla-brief"];
/** Lists a discovery returned after a read failed for a reason other than "not there": a job or
 *  a skill link may be missing from them (the Atlas then won't prune Jev's cache from them).
 *  Declared before any feature is created, so a discovery during module setup can't hit it early. */
const incompleteDiscoveries = new WeakSet<readonly Automation[]>();
/** com.stephane.* labels that back a live host (~/.dashable/services.yml): never kickstarted. */
const SERVICE_LABELS = new Set(["com.stephane.aleph"]);

export interface AutomationsDeps {
  launchAgentsDir?: string;
  skillsDir?: string;
  scheduledTasksDir?: string;
  home?: string;
  launchctlList?(): Promise<string>;
  /** Runs `launchctl kickstart gui/<uid>/<label>`. Tests inject a recorder. */
  kickstart?(label: string): Promise<void>;
  uid?: number;
}

async function latestOutput(spec: OutputSpec | undefined): Promise<AutomationOutput | null> {
  if (!spec) return null;
  let names: string[];
  try {
    names = await readdir(spec.dir);
  } catch {
    return null;
  }
  let best: AutomationOutput | null = null;
  let bestMtimeMs = -1;
  for (const n of names) {
    if (!spec.pattern.test(n)) continue;
    const p = join(spec.dir, n);
    try {
      const st = await stat(p);
      if (!st.isFile() || st.size === 0) continue;
      // Compare raw mtimeMs throughout: st.mtime.toISOString() truncates to whole milliseconds,
      // so re-deriving "best so far" by re-parsing that string (instead of keeping the original
      // float) loses sub-millisecond precision — on filesystems like APFS, mtimeMs is fractional,
      // and the lost fraction made the comparison non-transitive (order-dependent on readdir's
      // arbitrary iteration order) whenever two files landed in the same millisecond.
      // Same mtime (two writes in one ms): the later name wins (dated file names sort by day).
      if (!best || st.mtimeMs > bestMtimeMs || (st.mtimeMs === bestMtimeMs && p > best.path)) {
        best = { path: p, kind: outputKind(p), modifiedAt: st.mtime.toISOString(), size: st.size };
        bestMtimeMs = st.mtimeMs;
      }
    } catch {
      /* raced */
    }
  }
  return best;
}

async function mtimeIso(p: string | null): Promise<string | null> {
  if (!p) return null;
  try {
    return (await stat(p)).mtime.toISOString();
  } catch {
    return null;
  }
}

function newest(...isos: Array<string | null>): string | null {
  const vals = isos.filter((x): x is string => x !== null).sort();
  return vals[vals.length - 1] ?? null;
}

export function createAutomationsFeature(
  deps: AutomationsDeps = {},
): ServerFeature & { discover(now?: Date): Promise<Automation[]>; cached(maxAgeMs: number): Promise<Automation[]> } {
  const home = deps.home ?? homedir();
  const launchAgentsDir = deps.launchAgentsDir ?? join(home, "Library", "LaunchAgents");
  const skillsDir = deps.skillsDir ?? join(home, ".claude", "skills");
  const scheduledTasksDir = deps.scheduledTasksDir ?? join(home, ".claude", "scheduled-tasks");
  const specs = outputSpecs(home);
  const uid = deps.uid ?? userInfo().uid;
  const launchctlList =
    deps.launchctlList ??
    (async () => {
      const { stdout } = await execFileAsync("launchctl", ["list"], { timeout: 5000 });
      return stdout;
    });
  const kickstart =
    deps.kickstart ??
    (async (label: string) => {
      await execFileAsync("launchctl", ["kickstart", `gui/${uid}/${label}`], { timeout: 10_000 });
    });

  /** name → parsed frontmatter for every ~/.claude/skills/<name>/SKILL.md (read in parallel). */
  async function readSkills(note: (err: unknown) => void): Promise<Map<string, SkillMeta>> {
    let dirs: string[] = [];
    try {
      dirs = (await readdir(skillsDir)).filter((d) => ID_RE.test(d)).sort();
    } catch (err) {
      note(err);
      return new Map();
    }
    const metas = await Promise.all(
      dirs.map(async (dir): Promise<[string, SkillMeta] | null> => {
        try {
          const meta = parseSkillFrontmatter((await readFile(join(skillsDir, dir, "SKILL.md"), "utf8")).slice(0, 16 * 1024));
          return meta ? [dir, meta] : null;
        } catch (err) {
          note(err);
          return null;
        }
      }),
    );
    return new Map(metas.filter((m): m is [string, SkillMeta] => m !== null));
  }

  /** Skills invoked by a ~/.claude/scheduled-tasks/<task>/SKILL.md. */
  async function scheduledTaskRefs(known: ReadonlySet<string>): Promise<Set<string>> {
    let tasks: string[] = [];
    try {
      tasks = await readdir(scheduledTasksDir);
    } catch {
      return new Set();
    }
    const refs = await Promise.all(
      tasks.map(async (t) => {
        try {
          return skillRefsIn((await readFile(join(scheduledTasksDir, t, "SKILL.md"), "utf8")).slice(0, 64 * 1024), known);
        } catch {
          return [];
        }
      }),
    );
    return new Set(refs.flat());
  }

  async function discover(now = new Date()): Promise<Automation[]> {
    // A read that failed for any reason but "not there" may have hidden a job or a skill link.
    let incomplete = false;
    const note = (err: unknown): void => {
      if (!(err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EISDIR"))) incomplete = true;
    };
    const [statusText, skills, plists] = await Promise.all([
      launchctlList().catch(() => ""), // launchctl unavailable: statuses unknown
      readSkills(note),
      readdir(launchAgentsDir)
        .then((all) => all.filter((f) => f.endsWith(".plist") && (f.startsWith("com.stephane.") || READONLY_LAUNCHD_LABELS.includes(basename(f, ".plist")))))
        .catch((err: unknown) => (note(err), [] as string[])), // no LaunchAgents dir
    ]);
    const status: Map<string, LaunchctlEntry> = statusText ? parseLaunchctlList(statusText) : new Map();
    const known = new Set(skills.keys());
    const taskRefs = await scheduledTaskRefs(known);
    const byId = new Map<string, Automation>();
    /** skill name → id of the launchd automation whose plist runs it */
    const plistSkill = new Map<string, string>();

    const launchd = await Promise.all(
      plists.map(async (file) => {
        const fileLabel = basename(file, ".plist");
        let fields = extractRoutineFields(null);
        let keepAlive = false;
        let refs: string[] = [];
        let xml: string | null = null;
        try {
          xml = await readFile(join(launchAgentsDir, file), "utf8");
        } catch (err) {
          note(err); // unreadable plist: keep the name
        }
        if (xml !== null) {
          try {
            const plist = parsePlistXml(xml);
            fields = extractRoutineFields(plist);
            keepAlive = typeof plist === "object" && plist !== null && !Array.isArray(plist) && plist.KeepAlive !== undefined && plist.KeepAlive !== false;
            refs = skillRefsIn(xml, known);
          } catch {
            /* unparseable plist: keep the name */
          }
        }
        const label = fields.label ?? fileLabel;
        const id = label.replace(/^com\.stephane\./, "").replace(/^dev\.dashable\./, "");
        if (!ID_RE.test(id)) return null;
        const st = status.get(label);
        const schedule = formatSchedule(fields, now);
        const [out, outLog, errLog] = await Promise.all([latestOutput(specs[id]), mtimeIso(fields.standardOutPath), mtimeIso(fields.standardErrorPath)]);
        const logAt = newest(outLog, errLog);
        // KeepAlive jobs are services (e.g. the bridge), not runs: never offered a Run button.
        const runnable = isKickstartableLabel(label) && !keepAlive && !SERVICE_LABELS.has(label);
        const a: Automation = {
          id,
          name: id,
          description: null,
          kind: "launchd",
          launchdLabel: label,
          skill: null,
          schedule: schedule.text,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: newest(logAt, out?.modifiedAt ?? null),
          lastExitStatus: st?.lastExitStatus ?? null,
          running: st?.pid !== null && st?.pid !== undefined,
          runnable,
          dispatchCommand: null, // set below when a skill runs through this job
          latestOutput: out,
          outputDir: specs[id]?.dir ?? null,
          link: specs[id]?.link ?? null,
          plistPath: join(launchAgentsDir, file),
          ...(statusText ? { loaded: st !== undefined } : {}),
        };
        return { a, refs };
      }),
    );
    for (const l of launchd) {
      if (!l) continue;
      byId.set(l.a.id, l.a);
      for (const r of l.refs) if (!plistSkill.has(r)) plistSkill.set(r, l.a.id);
    }

    const skillOnly: Array<{ dir: string; meta: SkillMeta; by: ScheduleEvidence }> = [];
    for (const [dir, meta] of skills) {
      // Same-named launchd job first, else the job whose plist runs this skill.
      const owner = byId.get(dir) ?? (plistSkill.has(dir) ? byId.get(plistSkill.get(dir) ?? "") : undefined);
      if (owner?.kind === "launchd" && owner.skill === null) {
        owner.skill = dir;
        if (owner.id === dir) owner.name = meta.name; // a differently named job keeps its own name
        owner.description = meta.description.slice(0, 400) || null;
        owner.dispatchCommand = `/${dir}`;
        continue;
      }
      if (owner) continue;
      const by = scheduleEvidence(meta, { plist: plistSkill.has(dir), scheduledTask: taskRefs.has(dir) });
      if (by !== null) skillOnly.push({ dir, meta, by });
    }
    const outs = await Promise.all(skillOnly.map(({ dir }) => latestOutput(specs[dir])));
    skillOnly.forEach(({ dir, meta, by }, i) => {
      const out = outs[i] ?? null;
      byId.set(dir, {
        id: dir,
        name: meta.name,
        description: meta.description.slice(0, 400) || null,
        kind: "skill",
        launchdLabel: null,
        skill: dir,
        schedule: statedCadence(meta.description),
        nextRunAt: null,
        lastRunAt: out?.modifiedAt ?? null,
        lastExitStatus: null,
        running: false,
        runnable: false,
        dispatchCommand: `/${dir}`,
        latestOutput: out,
        outputDir: specs[dir]?.dir ?? null,
        link: specs[dir]?.link ?? null,
        scheduledBy: by,
      });
    });
    const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (incomplete) incompleteDiscoveries.add(list);
    return list;
  }

  let errorLog: ((err: unknown) => void) | null = null;
  const cache = createSwr(() => discover(), { onError: (err) => errorLog?.(err) });

  async function list(ctx: FeatureContext, maxAgeMs: number): Promise<Automation[]> {
    errorLog ??= (err) => ctx.log.error("automations", "discovery failed", String(err));
    try {
      return await cache.get(maxAgeMs);
    } catch (err) {
      errorLog(err);
      return cache.peek()?.value ?? [];
    }
  }

  return {
    id: "automations",
    discover,
    cached: (maxAgeMs) => cache.get(maxAgeMs),
    tickIntervalMs: 60_000,
    async onTick(ctx) {
      errorLog ??= (err) => ctx.log.error("automations", "discovery failed", String(err));
      await cache.refresh();
    },
    routes: [
      {
        method: "GET",
        path: "/api/automations",
        async handler(_req, res, ctx) {
          const automations = await list(ctx, 15_000);
          respondJson(res, 200, { ok: true, at: new Date(cache.peek()?.at ?? Date.now()).toISOString(), automations } satisfies AutomationsResponse);
        },
      },
      {
        method: "POST",
        path: "/api/automations/:id/run",
        async handler(req, res, ctx, params) {
          const id = params.id ?? "";
          if (!ID_RE.test(id)) return respondJson(res, 400, { ok: false, error: "invalid automation id" } satisfies AutomationRunResult);
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies AutomationRunResult);
          }
          if (!isRecord(body) || body.confirm !== true) {
            return respondJson(res, 400, { ok: false, error: "confirm: true is required to run an automation" } satisfies AutomationRunResult);
          }
          const a = (await list(ctx, 15_000)).find((x) => x.id === id);
          if (!a) return respondJson(res, 404, { ok: false, error: "unknown automation" } satisfies AutomationRunResult);
          if (!a.runnable || !a.launchdLabel || !isKickstartableLabel(a.launchdLabel)) {
            if (!a.dispatchCommand) return respondJson(res, 409, { ok: false, error: "this job cannot be started from here" } satisfies AutomationRunResult);
            return respondJson(res, 200, { ok: true, id, mode: "dispatch", command: a.dispatchCommand } satisfies AutomationRunResult);
          }
          if (a.running) return respondJson(res, 409, { ok: false, error: "already running" } satisfies AutomationRunResult);
          try {
            await kickstart(a.launchdLabel);
            ctx.log.info("automations", `kickstarted ${a.launchdLabel}`);
            cache.invalidate();
            respondJson(res, 200, { ok: true, id, mode: "kickstart", label: a.launchdLabel } satisfies AutomationRunResult);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: `kickstart failed: ${String(err).slice(0, 200)}` } satisfies AutomationRunResult);
          }
        },
      },
    ],
    snapshotExtras() {
      return { "automations.count": cache.peek()?.value.length ?? 0 };
    },
  };
}

const defaultAutomations = createAutomationsFeature();
export const automationsFeature: ServerFeature = defaultAutomations;

export function isIncompleteDiscovery(list: readonly Automation[]): boolean {
  return incompleteDiscoveries.has(list);
}

/** The default instance's list, at most ~20s stale (the feed polls it for routine run
 *  transitions; sharing the cache keeps it from running a second full discovery). */
export function discoverDefaultAutomations(): Promise<Automation[]> {
  return defaultAutomations.cached(20_000);
}
