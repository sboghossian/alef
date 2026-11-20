// Collectors ported from the old alex-system-map (generate.py / estate.py): launchd jobs split
// into scheduled vs always-on, and the public hostnames of the cloudflared tunnel config. Both are
// read-only and async (readdir/readFile, `launchctl list` with a deadline). Nothing is started,
// stopped or written, and tunnel credentials are never opened: config.yml only, hostnames only.
// Unit-tested in server/test/system-collectors.test.ts.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractRoutineFields, formatSchedule, parseLaunchctlList, parsePlistXml, type LaunchctlEntry, type PlistValue } from "./routines-lib.js";

const run = promisify(execFile);
const LAUNCHCTL_TIMEOUT_MS = 3_000;
/** A LaunchAgents folder is a handful of files; this bounds a pathological one. */
const MAX_PLISTS = 300;
/** Other people's agents (updaters, brew) are not part of this setup. */
const VENDOR = /^(com\.google\.|com\.apple\.|homebrew\.|org\.|us\.zoom\.|com\.microsoft\.)/;

export type LaunchdKind = "scheduled" | "always-on" | "other";
export interface LaunchdJob {
  label: string;
  kind: LaunchdKind;
  /** "every 15 min", "daily 08:00", "keep alive", "run at load"... */
  schedule: string;
  /** null when `launchctl list` could not be read. */
  loaded: boolean | null;
  running: boolean;
  lastExit: number | null;
}
export interface LaunchdInfo { jobs: LaunchdJob[]; launchctlRead: boolean }
export interface TunnelInfo { hostnames: string[] }

const isDict = (v: PlistValue | null): v is { [k: string]: PlistValue } => typeof v === "object" && v !== null && !Array.isArray(v);

/** Scheduled = a StartInterval/StartCalendarInterval and no KeepAlive; KeepAlive wins otherwise. */
export function classifyJob(plist: PlistValue | null): LaunchdKind {
  if (!isDict(plist)) return "other";
  if (plist.KeepAlive !== undefined && plist.KeepAlive !== false) return "always-on";
  return plist.StartInterval !== undefined || plist.StartCalendarInterval !== undefined ? "scheduled" : "other";
}

export function buildJob(label: string, plist: PlistValue | null, status: Map<string, LaunchctlEntry> | null, nowMs: number): LaunchdJob {
  const kind = classifyJob(plist);
  const fields = extractRoutineFields(plist);
  const st = status?.get(label);
  const schedule = kind === "always-on" ? "keep alive" : kind === "scheduled" ? formatSchedule(fields, new Date(nowMs)).text : "run at load or on demand";
  return { label, kind, schedule, loaded: status === null ? null : st !== undefined, running: st?.pid != null, lastExit: st?.lastExitStatus ?? null };
}

async function launchctlList(): Promise<string | null> {
  try {
    return (await run("launchctl", ["list"], { timeout: LAUNCHCTL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

export async function readLaunchd(home: string, nowMs: number, list: () => Promise<string | null> = launchctlList): Promise<LaunchdInfo> {
  const dir = join(home, "Library", "LaunchAgents");
  const [files, text] = await Promise.all([readdir(dir), list()]);
  const status = text === null ? null : parseLaunchctlList(text);
  const jobs = await Promise.all(
    files.filter((f) => f.endsWith(".plist")).sort().slice(0, MAX_PLISTS).map(async (f): Promise<LaunchdJob | null> => {
      const fileLabel = f.slice(0, -".plist".length);
      if (VENDOR.test(fileLabel)) return null;
      let plist: PlistValue | null = null;
      try {
        plist = parsePlistXml(await readFile(join(dir, f), "utf8")); // a binary plist throws: counted as "other"
      } catch {
        plist = null;
      }
      return buildJob(extractRoutineFields(plist).label ?? fileLabel, plist, status, nowMs);
    }),
  );
  return { jobs: jobs.filter((j): j is LaunchdJob => j !== null).sort((a, b) => a.label.localeCompare(b.label)), launchctlRead: status !== null };
}

/** `hostname:` lines of cloudflared's config.yml. Pure; credentials-file lines are never looked at. */
export function parseTunnelHostnames(yml: string): string[] {
  return [...new Set([...yml.matchAll(/^\s*-?\s*hostname:\s*["']?([\w.-]+)/gm)].map((m) => m[1] ?? "").filter(Boolean))];
}

export async function readTunnel(home: string): Promise<TunnelInfo> {
  return { hostnames: parseTunnelHostnames(await readFile(join(home, ".cloudflared", "dashable", "config.yml"), "utf8")) };
}
