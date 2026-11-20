// Payload for the "routines" feature: read-only inventory of
// ~/Library/LaunchAgents/com.stephane.*.plist jobs, their launchctl status, and any
// matching ~/.claude/scheduled-tasks/<name>/SKILL.md description.

export interface RoutineSchedule {
  kind: "calendar" | "interval" | "unknown";
  /** Human line, e.g. "daily 08:00", "weekdays 09:00", "every 15 min". */
  text: string;
  nextRunAt: string | null; // ISO, best-effort
}

export interface Routine {
  label: string; // e.g. "com.stephane.artifact-ritual"
  shortName: string; // "artifact-ritual"
  program: string; // best-effort: first ProgramArguments entry, or Program
  schedule: RoutineSchedule;
  running: boolean; // has a live PID per `launchctl list`
  lastExitStatus: number | null; // from `launchctl list`; null = unknown/never seen
  /** Heuristic: one of its StandardOut/ErrorPath log files was written in the last 5 min. */
  ranRecently: boolean;
  skillDescription: string | null;
  /** launchd knows the label (`launchctl list` lists it). false = the plist is in
   *  ~/Library/LaunchAgents but not loaded: paused (e.g. `launchctl bootout`), never fires.
   *  Absent when `launchctl list` couldn't be read. */
  loaded?: boolean;
}

/** The one-line command that loads a paused routine's plist again. */
export function resumeCommand(label: string): string {
  return `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`;
}

export interface RoutinesPayload {
  at: string;
  routines: Routine[];
}

export const ROUTINES_EXTRAS_KEY = "routines.state";
