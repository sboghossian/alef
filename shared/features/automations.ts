// Wire types for the "automations" feature: everything on this Mac that runs on a schedule
// or as a ritual. Read-only discovery; the only side effect is POST …/run, which needs
// { confirm: true } and only ever runs `launchctl kickstart gui/<uid>/<label>` for a
// com.stephane.* launchd job (never load/unload, never -k, never dev.dashable.*).
//
//   GET  /api/automations              → AutomationsResponse
//   POST /api/automations/:id/run      AutomationRunRequest → AutomationRunResult
//        launchd (com.stephane.*): kickstarted → { ok, mode: "kickstart" }
//        skill-only / not runnable:   { ok, mode: "dispatch", command } — send `command` from the prompt box
//        missing confirm → 400

export interface AutomationOutput {
  path: string; // absolute; open through /api/shelf/preview?path=
  kind: "html" | "markdown" | "text" | "json";
  modifiedAt: string;
  size: number;
}

export interface Automation {
  id: string; // kebab-case, e.g. "daily-recap"
  name: string;
  description: string | null;
  kind: "launchd" | "skill";
  launchdLabel: string | null;
  skill: string | null; // ~/.claude/skills/<skill>
  schedule: string | null; // "daily 08:00", "every 15 min", or the skill's stated cadence
  nextRunAt: string | null;
  lastRunAt: string | null; // newest of: launchd log mtime, latest output mtime
  lastExitStatus: number | null;
  running: boolean;
  runnable: boolean; // true = POST run kickstarts it; false = run returns a dispatch command
  dispatchCommand: string | null; // e.g. "/yalla-brief"
  latestOutput: AutomationOutput | null;
  outputDir: string | null;
  link: string | null; // e.g. the artifact URL a ritual republishes
  /** launchd jobs: the plist file read (absolute). */
  plistPath?: string;
  /** launchd jobs: `launchctl list` lists the plist's Label (false = paused: not loaded, never fires).
   *  Absent when `launchctl list` couldn't be read. */
  loaded?: boolean;
  /** Skill-only entries: what schedules it (automations-lib scheduleEvidence). */
  scheduledBy?: "launchd-plist" | "scheduled-task" | "self-described";
}

export interface AutomationsResponse {
  ok: true;
  at: string;
  automations: Automation[];
}

export interface AutomationRunRequest {
  confirm: true;
}

export type AutomationRunResult =
  | { ok: true; id: string; mode: "kickstart"; label: string }
  | { ok: true; id: string; mode: "dispatch"; command: string }
  | { ok: false; error: string };
