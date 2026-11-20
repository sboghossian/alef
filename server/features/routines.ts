// Scheduled routines as factories: read-only inventory of
// ~/Library/LaunchAgents/com.stephane.*.plist + `launchctl list` status +
// ~/.claude/scheduled-tasks/<name>/SKILL.md descriptions. Never loads/unloads/kickstarts
// anything — only `launchctl list` (no label = a read-only status dump) and plain file reads.

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Routine, RoutinesPayload } from "../../shared/features/routines.js";
import { ROUTINES_EXTRAS_KEY } from "../../shared/features/routines.js";
import type { ServerFeature } from "./registry.js";
import { extractRoutineFields, formatSchedule, parseLaunchctlList, parsePlistXml } from "./routines-lib.js";

const execFileAsync = promisify(execFile);
const TICK_MS = 60_000;
const RECENT_MS = 5 * 60_000;

/** Where buildRoutines reads from. Tests pass a fixture folder and a canned `launchctl list`. */
export interface RoutineSources {
  launchAgentsDir: string;
  scheduledTasksDir: string;
  /** `launchctl list`'s stdout, or null when it couldn't be read. */
  launchctlList: () => Promise<string | null>;
}

export const REAL_ROUTINE_SOURCES: RoutineSources = {
  launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
  scheduledTasksDir: join(homedir(), ".claude", "scheduled-tasks"),
  launchctlList: async () => {
    try {
      return (await execFileAsync("launchctl", ["list"], { timeout: 5000 })).stdout;
    } catch {
      return null;
    }
  },
};

let state: RoutinesPayload = { at: new Date(0).toISOString(), routines: [] };

/** The last scan (every 60s), cached: careers links workers to routines through it. Read-only. */
export function latestRoutines(): RoutinesPayload {
  return state;
}

export function resetRoutinesStateForTests(): void {
  state = { at: new Date(0).toISOString(), routines: [] };
}

async function listComAlexPlists(launchAgentsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(launchAgentsDir);
    return entries.filter((f) => f.startsWith("com.stephane.") && f.endsWith(".plist"));
  } catch {
    return [];
  }
}

async function readSkillDescriptions(scheduledTasksDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const dirs = await readdir(scheduledTasksDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const content = await readFile(join(scheduledTasksDir, d.name, "SKILL.md"), "utf8");
        const m = /^description:\s*(.+)$/m.exec(content);
        if (m?.[1]) out.set(d.name, m[1].trim().replace(/^["']|["']$/g, ""));
      } catch {
        /* no SKILL.md, skip */
      }
    }
  } catch {
    /* no scheduled-tasks dir */
  }
  return out;
}

async function ranRecently(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    const st = await stat(path);
    return Date.now() - st.mtimeMs <= RECENT_MS;
  } catch {
    return false;
  }
}

/** Null when `launchctl list` couldn't be read: then no routine can be called loaded or paused. */
async function readLaunchctlStatus(sources: RoutineSources): Promise<Map<string, { pid: number | null; lastExitStatus: number | null }> | null> {
  const stdout = await sources.launchctlList();
  return stdout === null ? null : parseLaunchctlList(stdout);
}

/** Best-effort match from a plist Label ("com.stephane.artifact-ritual") to a
 *  ~/.claude/scheduled-tasks/<name> directory: try the exact short name, then any
 *  scheduled-task dir name it starts with or ends with (naming isn't 1:1 across the two inventories). */
function matchSkillDescription(shortName: string, skills: ReadonlyMap<string, string>): string | null {
  const exact = skills.get(shortName);
  if (exact) return exact;
  for (const [name, desc] of skills) {
    if (shortName.includes(name) || name.includes(shortName)) return desc;
  }
  return null;
}

export async function buildRoutines(now: Date, sources: RoutineSources = REAL_ROUTINE_SOURCES): Promise<Routine[]> {
  const [plistFiles, launchctlStatus, skills] = await Promise.all([
    listComAlexPlists(sources.launchAgentsDir),
    readLaunchctlStatus(sources),
    readSkillDescriptions(sources.scheduledTasksDir),
  ]);

  const routines: Routine[] = [];
  for (const file of plistFiles) {
    const label = basename(file, ".plist");
    let fields;
    try {
      const xml = await readFile(join(sources.launchAgentsDir, file), "utf8");
      fields = extractRoutineFields(parsePlistXml(xml));
    } catch {
      fields = extractRoutineFields(null);
    }
    const shortName = label.startsWith("com.stephane.") ? label.slice("com.stephane.".length) : label;
    const status = launchctlStatus?.get(fields.label ?? label);
    const recent =
      (await ranRecently(fields.standardOutPath)) || (await ranRecently(fields.standardErrorPath));
    const routine: Routine = {
      label,
      shortName,
      program: fields.program ?? "unknown",
      schedule: formatSchedule(fields, now),
      running: status?.pid !== null && status?.pid !== undefined,
      lastExitStatus: status?.lastExitStatus ?? null,
      ranRecently: recent,
      skillDescription: matchSkillDescription(shortName, skills),
    };
    // The plist is on disk; launchd knows the label or not (a `launchctl bootout` keeps the file).
    if (launchctlStatus !== null) routine.loaded = status !== undefined;
    routines.push(routine);
  }
  routines.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return routines;
}

export const routinesFeature: ServerFeature = {
  id: "routines",
  tickIntervalMs: TICK_MS,
  async onTick(ctx) {
    const now = new Date();
    try {
      const routines = await buildRoutines(now);
      state = { at: now.toISOString(), routines };
      ctx.emit(state);
    } catch (err) {
      ctx.log.error("routines", "scan failed", String(err));
    }
  },
  snapshotExtras() {
    return { [ROUTINES_EXTRAS_KEY]: state };
  },
};
