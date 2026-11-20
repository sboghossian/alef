// Pure, dependency-free helpers for the "routines" feature: a minimal XML plist
// parser (launchd .plist files on disk are XML, not binary), a `launchctl list`
// table parser, and schedule formatting/next-run math. No IO here — sky.ts's sibling
// routines.ts does the readFile/execFile and calls into this module.

import type { RoutineSchedule } from "../../shared/features/routines.js";

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

type Frame = { kind: "dict"; obj: Record<string, PlistValue>; pendingKey: string | null } | { kind: "array"; arr: PlistValue[] };

/** Parses a launchd-style XML plist into a plain JS value. Handles the tags launchd
 *  jobs actually use (dict, array, string, integer, real, true/false); anything else
 *  inside a <key> not covered is simply never placed, which is fine for our purposes.
 *  Throws on malformed nesting (unbalanced dict/array) — callers should catch. */
export function parsePlistXml(xml: string): PlistValue | null {
  const tokenRe =
    /<key>([\s\S]*?)<\/key>|<string>([\s\S]*?)<\/string>|<integer>(-?\d+)<\/integer>|<real>(-?[\d.]+)<\/real>|<true\s*\/>|<false\s*\/>|<dict>|<\/dict>|<array>|<\/array>/g;
  const stack: Frame[] = [];
  let root: PlistValue | null = null;

  function place(value: PlistValue): void {
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      return;
    }
    if (top.kind === "array") {
      top.arr.push(value);
      return;
    }
    if (top.pendingKey === null) return; // stray value with no key — ignore rather than throw
    top.obj[top.pendingKey] = value;
    top.pendingKey = null;
  }

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml))) {
    const [full, keyText, stringText, intText, realText] = m;
    if (keyText !== undefined) {
      const top = stack[stack.length - 1];
      if (top && top.kind === "dict") top.pendingKey = decodeXmlEntities(keyText);
    } else if (stringText !== undefined) {
      place(decodeXmlEntities(stringText));
    } else if (intText !== undefined) {
      place(parseInt(intText, 10));
    } else if (realText !== undefined) {
      place(parseFloat(realText));
    } else if (full === "<true/>" || full.startsWith("<true")) {
      place(true);
    } else if (full === "<false/>" || full.startsWith("<false")) {
      place(false);
    } else if (full === "<dict>") {
      stack.push({ kind: "dict", obj: {}, pendingKey: null });
    } else if (full === "</dict>") {
      const done = stack.pop();
      if (done && done.kind === "dict") place(done.obj);
    } else if (full === "<array>") {
      stack.push({ kind: "array", arr: [] });
    } else if (full === "</array>") {
      const done = stack.pop();
      if (done && done.kind === "array") place(done.arr);
    }
  }
  return root;
}

function isDict(v: PlistValue | null | undefined): v is Record<string, PlistValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface CalendarEntry {
  hour?: number;
  minute?: number;
  weekday?: number;
  /** launchd `Day`: day of the month, 1-31. */
  day?: number;
  /** launchd `Month`: 1-12. */
  month?: number;
}

export interface RoutinePlistFields {
  label: string | null;
  program: string | null;
  startCalendarIntervals: CalendarEntry[] | null;
  startInterval: number | null; // seconds
  standardOutPath: string | null;
  standardErrorPath: string | null;
}

function toCalendarEntry(v: PlistValue): CalendarEntry {
  if (!isDict(v)) return {};
  const hour = typeof v.Hour === "number" ? v.Hour : undefined;
  const minute = typeof v.Minute === "number" ? v.Minute : undefined;
  const weekday = typeof v.Weekday === "number" ? v.Weekday : undefined;
  const day = typeof v.Day === "number" ? v.Day : undefined;
  const month = typeof v.Month === "number" ? v.Month : undefined;
  return { hour, minute, weekday, day, month };
}

/** Pulls the handful of fields agent-world cares about out of a parsed plist dict. */
export function extractRoutineFields(plist: PlistValue | null): RoutinePlistFields {
  const dict = isDict(plist) ? plist : {};
  const label = typeof dict.Label === "string" ? dict.Label : null;
  const args = Array.isArray(dict.ProgramArguments) ? dict.ProgramArguments : null;
  const firstArg = args && typeof args[0] === "string" ? (args[0] as string) : null;
  const program = firstArg ?? (typeof dict.Program === "string" ? dict.Program : null);

  let startCalendarIntervals: CalendarEntry[] | null = null;
  const sci = dict.StartCalendarInterval;
  if (Array.isArray(sci)) startCalendarIntervals = sci.map(toCalendarEntry);
  else if (isDict(sci)) startCalendarIntervals = [toCalendarEntry(sci)];

  const startInterval = typeof dict.StartInterval === "number" ? dict.StartInterval : null;
  const standardOutPath = typeof dict.StandardOutPath === "string" ? dict.StandardOutPath : null;
  const standardErrorPath = typeof dict.StandardErrorPath === "string" ? dict.StandardErrorPath : null;

  return { label, program, startCalendarIntervals, startInterval, standardOutPath, standardErrorPath };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtHM(entry: CalendarEntry): string {
  const h = String(entry.hour ?? 0).padStart(2, "0");
  const m = String(entry.minute ?? 0).padStart(2, "0");
  return `${h}:${m}`;
}

function fmtInterval(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `every ${seconds / 60} min`;
  return `every ${seconds}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** launchd semantics (like cron): a missing field is a wildcard; when both Day and Weekday
 *  are set, either one matching is enough. */
function dayMatches(entry: CalendarEntry, d: Date): boolean {
  if (entry.month !== undefined && d.getMonth() + 1 !== entry.month) return false;
  const dayOk = entry.day === undefined || d.getDate() === entry.day;
  const dowOk = entry.weekday === undefined || d.getDay() === entry.weekday % 7; // 0 and 7 are Sunday
  if (entry.day !== undefined && entry.weekday !== undefined) return d.getDate() === entry.day || d.getDay() === entry.weekday % 7;
  return dayOk && dowOk;
}

/** Earliest firing strictly after `now`, searched day by day (up to ~4 years, for Feb 29). */
function nextCalendarOccurrence(entry: CalendarEntry, now: Date): Date | null {
  const hours = entry.hour !== undefined ? [entry.hour] : Array.from({ length: 24 }, (_, i) => i);
  const minutes = entry.minute !== undefined ? [entry.minute] : Array.from({ length: 60 }, (_, i) => i);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 1500; i++) {
    if (dayMatches(entry, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day);
          t.setHours(h, m, 0, 0);
          if (t.getTime() > now.getTime()) return t;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/** One entry as text: "daily 08:00", "Monday 09:00", "monthly on the 1st 19:00", "hourly at :15". */
function entryText(e: CalendarEntry): string {
  const time = e.hour === undefined ? (e.minute === undefined ? "every minute" : `hourly at :${String(e.minute).padStart(2, "0")}`) : fmtHM(e);
  if (e.day !== undefined) {
    const where = e.month !== undefined ? `every ${MONTHS[e.month - 1] ?? "?"} ${e.day}` : `monthly on the ${ordinal(e.day)}`;
    return `${where}${e.weekday !== undefined ? ` or ${WEEKDAYS[e.weekday % 7]}` : ""} ${time}`;
  }
  if (e.weekday !== undefined) return `${WEEKDAYS[e.weekday % 7]} ${time}`;
  return e.hour === undefined ? time : `daily ${time}`;
}

/** Human schedule text + best-effort next run time. Pure function of the plist fields + `now`. */
export function formatSchedule(fields: RoutinePlistFields, now: Date): RoutineSchedule {
  if (fields.startInterval !== null) {
    const next = new Date(now.getTime() + fields.startInterval * 1000);
    return { kind: "interval", text: fmtInterval(fields.startInterval), nextRunAt: next.toISOString() };
  }
  const entries = fields.startCalendarIntervals;
  if (entries && entries.length > 0) {
    const next = entries
      .map((e) => nextCalendarOccurrence(e, now))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const nextRunAt = next ? next.toISOString() : null;
    if (entries.length === 1) return { kind: "calendar", text: entryText(entries[0]!), nextRunAt };
    const simpleWeekly = entries.every((e) => e.day === undefined && e.month === undefined && e.hour !== undefined);
    const times = new Set(entries.map(fmtHM));
    if (simpleWeekly && times.size === 1) {
      const time = [...times][0]!;
      const days = entries
        .map((e) => e.weekday)
        .filter((d): d is number => d !== undefined)
        .map((d) => d % 7)
        .sort((a, b) => a - b);
      const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d, i) => days[i] === d);
      const text = isWeekdays ? `weekdays ${time}` : `${days.map((d) => WEEKDAYS[d]!.slice(0, 3)).join("/")} ${time}`;
      return { kind: "calendar", text, nextRunAt };
    }
    const allDaily = entries.every((e) => e.day === undefined && e.month === undefined && e.weekday === undefined);
    return { kind: "calendar", text: allDaily ? `${entries.length}x daily` : entries.map(entryText).join(" · "), nextRunAt };
  }
  return { kind: "unknown", text: "manual / unknown", nextRunAt: null };
}

export interface LaunchctlEntry {
  pid: number | null;
  lastExitStatus: number | null;
}

/** Parses `launchctl list` output: a header line then tab-separated "PID\tStatus\tLabel" rows. */
export function parseLaunchctlList(text: string): Map<string, LaunchctlEntry> {
  const map = new Map<string, LaunchctlEntry>();
  const lines = text.split("\n").slice(1);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [pidStr, statusStr, label] = parts;
    if (!label || !label.trim()) continue;
    const pid = pidStr === "-" || pidStr === undefined ? null : parseInt(pidStr, 10);
    const lastExitStatus = statusStr === undefined || statusStr === "-" ? null : parseInt(statusStr, 10);
    map.set(label.trim(), {
      pid: pid !== null && Number.isNaN(pid) ? null : pid,
      lastExitStatus: lastExitStatus !== null && Number.isNaN(lastExitStatus) ? null : lastExitStatus,
    });
  }
  return map;
}
