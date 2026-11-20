// Pure aggregation for the "vault" feature: turns the parsed graph feed (one VaultNote per
// note) into the small per-section payloads the client draws. No I/O and no clock here; every
// function takes `today` as whole days since the epoch, so each statistic is unit-testable.
// The feed is ~32k notes and ~136k links, so everything is a single pass or a map lookup and
// the inbound-link index is built once by the caller and passed in, never rebuilt per note.
// Covered by server/test/vault-lib.test.ts.
//
// Conventions used throughout:
//   day   whole days since the epoch, UTC (what VaultNote.day already is)
//   week  Math.floor(day / 7), absolute weeks since the epoch, so weekly mention counts in the
//         feed and weekly note counts here share one axis (the bucket starts on a Thursday)
//   "last N days"  day > today - N && day <= today; "the N before" is day > today - 2N && <= today - N
// Attachments (kind "a") are dropped at the top of every function. Undated notes are left out
// of every time series; Growth and Gaps still count them.

import type {
  VaultBand,
  VaultClimb,
  VaultClimbStep,
  VaultCount,
  VaultDay,
  VaultDuplicate,
  VaultEchoes,
  VaultEntity,
  VaultFlow,
  VaultFocus,
  VaultGaps,
  VaultGem,
  VaultGrowth,
  VaultMeeting,
  VaultMeetings,
  VaultMilestone,
  VaultNote,
  VaultNoteRef,
  VaultNotesQuery,
  VaultOnThisDay,
  VaultPeople,
  VaultProject,
  VaultProjects,
  VaultPulse,
  VaultSeries,
  VaultShift,
  VaultSource,
  VaultSources,
  VaultTag,
  VaultTopics,
  VaultUmbrella,
} from "../../shared/features/vault.js";

const DAY_MS = 86_400_000;
const OTHER = "Other";

// ---- caps: nothing below may grow with the size of the vault ----
/** A stacked chart shows this many keys, then one "Other" series. */
const SERIES_TOP = 8;
/** Pulse and Sources monthly bars. */
const PULSE_MONTHS = 18;
/** Pulse day list: 53 calendar columns of 7 days, which is all the heatmap can draw. */
const PULSE_DAYS = 371;
/** Growth cumulative area. */
const GROWTH_MONTHS = 48;
/** Weekly charts (Focus, Meetings, Topics sparklines). */
const WEEKS = 26;
/** Round-number note counts Growth projects to. */
const MILESTONE_COUNT = 3;
/** Fastest-growing folders listed under Growth. */
const FASTEST_CAP = 8;
/** Focus attention-shift rows, per axis. */
const SHIFT_CAP = 12;
/** Longest meetings listed. */
const LONGEST_CAP = 10;
/** Meeting-hours-by-project bars. */
const MEETING_PROJECT_CAP = 12;
/** Project rows. */
const PROJECT_ITEM_CAP = 60;
/** Umbrella rows. */
const UMBRELLA_CAP = 24;
/** Quiet-project spotlight. */
const QUIET_PROJECT_CAP = 12;
/** A project this size counts as "big" for the quiet list. */
const BIG_PROJECT_NOTES = 20;
/** Tag-family bars. */
const TOPIC_FAMILY_CAP = 12;
/** Families that get tag rows sent. The rest only appear as a bar. */
const TOPIC_ITEM_FAMILIES = 8;
/** Tag rows per family. */
const TOPIC_PER_FAMILY = 15;
/** Rising and quiet tag lists. */
const TOPIC_SPOTLIGHT_CAP = 12;
/** Tag families that are bookkeeping rather than thinking. Left out of rising and quiet. */
const NOISE_FAMILIES: ReadonlySet<string> = new Set(["status", "session", "source", "resource", "bookmark"]);
/** People and company dots, each. */
const ENTITY_LIST_CAP = 60;
/** Reconnect and most-active-lately lists. */
const ENTITY_SPOTLIGHT_CAP = 12;
/** An entity with at least this many mentions is "known", not occasional. */
const KNOWN_ENTITY_TOTAL = 10;
/** Source rows. */
const SOURCE_CAP = 20;
/** Umbrella bars under Sources. */
const SOURCE_UMBRELLA_CAP = 12;
/** Sankey bands under this size are noise. */
const FLOW_MIN = 2;
/** Sankey bands drawn. */
const FLOW_CAP = 40;
/** Forgotten gems shown. */
const GEM_CAP = 8;
/** On-this-day notes per anniversary. */
const ON_THIS_DAY_CAP = 5;
/** Hops after the starting gem. */
const WANDER_HOPS = 6;
/** Write-next list. */
const WRITE_NEXT_CAP = 20;
/** One note pointing at a missing page is a typo or a one-off; "Write these next" wants two. */
export const WRITE_NEXT_MIN_INBOUND = 2;
/** Imported and clipped material links to whatever its source linked to: those missing pages are
 *  not Alex's to write, so they never reach "Write these next" (ghostTotal still counts them). */
const IMPORT_FOLDERS = ["40-Resources/", "Clippings/"] as const;
const IMPORT_TYPES: ReadonlySet<string> = new Set(["resource", "bookmark", "rss-article", "clipping"]);

/** True for a note that came from an import or a web clip rather than Alex's own writing. */
export function isImportedNote(n: Pick<VaultNote, "path" | "type">): boolean {
  return IMPORT_TYPES.has(n.type) || IMPORT_FOLDERS.some((f) => n.path.startsWith(f));
}
/** Duplicate groups listed. */
const DUPLICATE_CAP = 20;
/** Paths shown per duplicate group. */
const DUPLICATE_PATHS_CAP = 8;
/** Shorter normalised names are generic ("index", "readme") and would swamp the list. */
const DUPLICATE_MIN_KEY = 12;
/** Projects-missing-a-note list. */
const MISSING_PROJECT_CAP = 20;
/** Folder bars under Gaps. */
const GAP_FOLDER_CAP = 15;

// ---------------------------------------------------------------- day, week, folder helpers

/** "YYYY-MM-DD" for a whole-day epoch index. */
export function dayToIso(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM" for a whole-day epoch index. */
export function dayToMonth(day: number): string {
  return dayToIso(day).slice(0, 7);
}

/** Absolute week bucket, matching the feed's `mentionWeeks` keys. */
export function weekOf(day: number): number {
  return Math.floor(day / 7);
}

/**
 * Weekday with Monday = 0. Day 0 (1970-01-01) was a Thursday, which is 3 in a Monday-first
 * week, so `+ 3` shifts the epoch-relative remainder onto the Monday-first scale. The double
 * modulo keeps days before 1970 non-negative.
 */
export function dowOf(day: number): number {
  return ((((day % 7) + 7) % 7) + 3) % 7;
}

/** Top-level folder: everything before the first "/", or "" for a note at the vault root. */
export function folderOf(path: string): string {
  const i = path.indexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Basename without the ".md" extension. */
function nameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** Months since year 0 (year * 12 + month), so month arithmetic is plain subtraction. */
function monthIndex(day: number): number {
  const d = new Date(day * DAY_MS);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function monthLabel(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** In-bounds increment of an array slot (callers have already range-checked the index). */
function add(arr: number[], i: number, by: number): void {
  arr[i] = (arr[i] ?? 0) + by;
}

function bump(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by);
}

function topCounts(m: ReadonlyMap<string, number>, limit: number): VaultCount[] {
  return [...m]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, limit)
    .map(([key, n]) => ({ key, n }));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------- shared shaping

/** Notes that count: everything except attachments. */
function live(notes: readonly VaultNote[]): VaultNote[] {
  return notes.filter((n) => n.kind !== "a");
}

interface Dated {
  note: VaultNote;
  day: number;
}

/** Live notes that carry a date on or before today. Future-dated notes are not "activity yet". */
function dated(notes: readonly VaultNote[], today: number): Dated[] {
  const out: Dated[] = [];
  for (const note of notes) {
    if (note.kind === "a" || note.day === null || note.day > today) continue;
    out.push({ note, day: note.day });
  }
  return out;
}

/** The month indices a monthly chart covers: at most `max`, starting no earlier than the data. */
function monthWindow(items: readonly Dated[], today: number, max: number): number[] {
  if (items.length === 0) return [];
  let earliest = Infinity;
  for (const it of items) earliest = Math.min(earliest, it.day);
  const cur = monthIndex(today);
  const first = Math.max(cur - (max - 1), monthIndex(earliest));
  const out: number[] = [];
  for (let m = first; m <= cur; m++) out.push(m);
  return out;
}

/**
 * Keeps the `top` highest-ranked series and folds the rest into one "Other" series, always
 * last. `rank` is the number to order by (a total for flows, the final value for cumulative
 * series); ties break on key so output is stable.
 */
function foldSeries(series: ReadonlyMap<string, number[]>, rank: (key: string) => number, top: number): VaultSeries[] {
  const keys = [...series.keys()].sort((a, b) => rank(b) - rank(a) || cmp(a, b));
  const kept = keys.slice(0, top);
  const rest = keys.slice(top);
  const out: VaultSeries[] = kept.map((key) => ({ key, parts: series.get(key) ?? [] }));
  if (rest.length > 0) {
    const first = series.get(rest[0] ?? "") ?? [];
    const sum = new Array<number>(first.length).fill(0);
    for (const key of rest) {
      const parts = series.get(key) ?? [];
      for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (parts[i] ?? 0);
    }
    out.push({ key: OTHER, parts: sum });
  }
  return out;
}

function seriesSlot(m: Map<string, number[]>, key: string, len: number): number[] {
  let arr = m.get(key);
  if (!arr) {
    arr = new Array<number>(len).fill(0);
    m.set(key, arr);
  }
  return arr;
}

function sumOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Index of `day`'s week within the 26 weeks ending at today's week, or -1 outside it. */
function weekSlot(day: number, today: number): number {
  const i = weekOf(day) - (weekOf(today) - (WEEKS - 1));
  return i >= 0 && i < WEEKS && day <= today ? i : -1;
}

/** The 26 week-start labels, oldest first. */
function weekLabels(today: number): string[] {
  const first = weekOf(today) - (WEEKS - 1);
  const out: string[] = [];
  for (let i = 0; i < WEEKS; i++) out.push(dayToIso((first + i) * 7));
  return out;
}

// ---------------------------------------------------------------- inbound index

/**
 * For each note id, how many distinct notes link to it. Built once per feed; ~136k links is a
 * single pass, whereas asking "who links here" per note would be quadratic.
 */
export function inboundCounts(notes: readonly VaultNote[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of notes) {
    for (const target of new Set(n.links)) out.set(target, (out.get(target) ?? 0) + 1);
  }
  return out;
}

export function toRef(n: VaultNote, inbound: ReadonlyMap<string, number>): VaultNoteRef {
  return {
    id: n.id,
    path: n.path,
    name: nameOf(n.path),
    folder: folderOf(n.path),
    day: n.day === null ? null : dayToIso(n.day),
    links: n.links.length + (inbound.get(n.id) ?? 0),
  };
}

// ---------------------------------------------------------------- 1. pulse

export function vaultPulse(notes: readonly VaultNote[], today: number): VaultPulse {
  const items = dated(notes, today);
  const perDay = new Map<number, number>();
  for (const it of items) perDay.set(it.day, (perDay.get(it.day) ?? 0) + 1);

  const days: VaultDay[] = [...perDay]
    .filter(([d]) => d > today - PULSE_DAYS)
    .sort((a, b) => a[0] - b[0])
    .map(([d, n]) => ({ day: dayToIso(d), n }));

  const months = monthWindow(items, today, PULSE_MONTHS);
  const first = months[0] ?? 0;
  const byFolder = new Map<string, number[]>();
  for (const it of items) {
    const slot = monthIndex(it.day) - first;
    if (slot < 0 || slot >= months.length) continue;
    add(seriesSlot(byFolder, folderOf(it.note.path), months.length), slot, 1);
  }

  let last7 = 0;
  let prev7 = 0;
  const active30 = new Set<number>();
  for (const [d, n] of perDay) {
    if (d > today - 7) last7 += n;
    else if (d > today - 14) prev7 += n;
    if (d > today - 30) active30.add(d);
  }

  // The streak is days in a row with a note, ending today. A day not yet written to does not
  // break it: if today is empty the count runs back from yesterday.
  let streak = 0;
  for (let d = perDay.has(today) ? today : today - 1; perDay.has(d); d--) streak++;

  let longestStreak = 0;
  let run = 0;
  let prev = -Infinity;
  for (const d of [...perDay.keys()].sort((a, b) => a - b)) {
    run = d === prev + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = d;
  }

  // Busiest day of the current UTC year; on a tie the earlier day wins.
  const yearStart = Date.UTC(new Date(today * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS;
  let busiest: VaultDay | null = null;
  for (const d of [...perDay.keys()].sort((a, b) => a - b)) {
    if (d < yearStart) continue;
    const n = perDay.get(d) ?? 0;
    if (busiest === null || n > busiest.n) {
      busiest = { day: dayToIso(d), n };
    }
  }

  return {
    days,
    months: months.map(monthLabel),
    stacks: foldSeries(byFolder, (k) => sumOf(byFolder.get(k) ?? []), SERIES_TOP),
    last7,
    prev7,
    activeDays30: active30.size,
    streak,
    longestStreak,
    busiest,
  };
}

// ---------------------------------------------------------------- 2. growth

/** The next few round numbers above `total`, stepping by half a power of ten (10 at the least). */
function milestoneTargets(total: number): number[] {
  const pow10 = 10 ** Math.floor(Math.log10(Math.max(total, 1)));
  const step = Math.max(10, pow10 / 2);
  const start = Math.floor(total / step) + 1;
  const out: number[] = [];
  for (let i = 0; i < MILESTONE_COUNT; i++) out.push((start + i) * step);
  return out;
}

export function vaultGrowth(notes: readonly VaultNote[], today: number): VaultGrowth {
  const all = live(notes);
  const items = dated(all, today);
  const months = monthWindow(items, today, GROWTH_MONTHS);
  const first = months[0] ?? 0;

  // Cumulative per folder, with everything dated before the window folded into the first
  // month so each stack ends at the folder's true size. `baseline` reports how much of that
  // was already there when the window opened.
  const monthly = new Map<string, number[]>();
  const base = new Map<string, number>();
  let baseline = 0;
  for (const it of items) {
    const folder = folderOf(it.note.path);
    const slot = monthIndex(it.day) - first;
    if (slot < 0) {
      bump(base, folder);
      baseline++;
    } else if (slot < months.length) {
      add(seriesSlot(monthly, folder, months.length), slot, 1);
    }
  }
  for (const folder of base.keys()) seriesSlot(monthly, folder, months.length);
  const cumulative = new Map<string, number[]>();
  for (const [folder, counts] of monthly) {
    let run = base.get(folder) ?? 0;
    cumulative.set(folder, counts.map((c) => (run += c)));
  }
  const finalOf = (k: string): number => {
    const arr = cumulative.get(k) ?? [];
    return arr[arr.length - 1] ?? 0;
  };

  let n30 = 0;
  let d90 = 0;
  let prev90 = 0;
  const recent = new Map<string, number>();
  for (const it of items) {
    const ago = today - it.day;
    if (ago < 30) n30++;
    if (ago < 90) {
      d90++;
      bump(recent, folderOf(it.note.path));
    } else if (ago < 180) prev90++;
  }
  const perDay30 = n30 / 30;
  const total = all.length;
  const milestones: VaultMilestone[] = milestoneTargets(total).map((at) => ({
    at,
    day: perDay30 > 0 ? dayToIso(today + Math.ceil((at - total) / perDay30)) : null,
  }));

  return {
    months: months.map(monthLabel),
    stacks: foldSeries(cumulative, finalOf, SERIES_TOP),
    baseline,
    total,
    undated: all.filter((n) => n.day === null).length,
    perDay30,
    d90,
    prev90,
    milestones,
    fastest: topCounts(recent, FASTEST_CAP),
  };
}

// ---------------------------------------------------------------- 3. focus

/** Per-week counts of notes by `keyOf`, for notes that name a key. Folds to top + Other. */
function weeklyStack(items: readonly Dated[], today: number, keyOf: (n: VaultNote) => string): VaultSeries[] {
  const by = new Map<string, number[]>();
  for (const it of items) {
    const key = keyOf(it.note);
    const slot = weekSlot(it.day, today);
    if (key === "" || slot < 0) continue;
    add(seriesSlot(by, key, WEEKS), slot, 1);
  }
  return foldSeries(by, (k) => sumOf(by.get(k) ?? []), SERIES_TOP);
}

/** How each key's share of the notes that named one moved: last 28 days against the 28 before. */
function shifts(items: readonly Dated[], today: number, keyOf: (n: VaultNote) => string): VaultShift[] {
  const now = new Map<string, number>();
  const before = new Map<string, number>();
  let nowTotal = 0;
  let beforeTotal = 0;
  for (const it of items) {
    const key = keyOf(it.note);
    if (key === "") continue;
    const ago = today - it.day;
    if (ago < 28) {
      bump(now, key);
      nowTotal++;
    } else if (ago < 56) {
      bump(before, key);
      beforeTotal++;
    }
  }
  const out: VaultShift[] = [];
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    out.push({
      key,
      now: nowTotal > 0 ? (now.get(key) ?? 0) / nowTotal : 0,
      before: beforeTotal > 0 ? (before.get(key) ?? 0) / beforeTotal : 0,
    });
  }
  return out
    .sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before) || cmp(a.key, b.key))
    .slice(0, SHIFT_CAP);
}

export function vaultFocus(notes: readonly VaultNote[], today: number): VaultFocus {
  const items = dated(notes, today);
  const project = (n: VaultNote): string => n.project;
  const umbrella = (n: VaultNote): string => n.umbrella;

  const projects = new Set<string>();
  const umbrellas = new Set<string>();
  const perDayProjects = new Map<number, Set<string>>();
  const thisWeek = new Map<string, number>();
  let thisWeekTotal = 0;
  for (const it of items) {
    const slot = weekSlot(it.day, today);
    if (slot < 0) continue;
    if (it.note.project !== "") projects.add(it.note.project);
    if (it.note.umbrella !== "") umbrellas.add(it.note.umbrella);
    if (slot === WEEKS - 1 && it.note.project !== "") {
      bump(thisWeek, it.note.project);
      thisWeekTotal++;
    }
  }
  for (const it of items) {
    if (today - it.day >= 30 || it.note.project === "") continue;
    let set = perDayProjects.get(it.day);
    if (!set) {
      set = new Set();
      perDayProjects.set(it.day, set);
    }
    set.add(it.note.project);
  }
  let switches = 0;
  for (const set of perDayProjects.values()) switches += set.size;

  const lead = topCounts(thisWeek, 1)[0];
  return {
    weeks: weekLabels(today),
    byProject: weeklyStack(items, today, project),
    byUmbrella: weeklyStack(items, today, umbrella),
    touchedProjects: projects.size,
    touchedUmbrellas: umbrellas.size,
    switchesPerDay: perDayProjects.size > 0 ? switches / perDayProjects.size : 0,
    top: lead && thisWeekTotal > 0 ? { key: lead.key, share: lead.n / thisWeekTotal } : null,
    shiftProjects: shifts(items, today, project),
    shiftUmbrellas: shifts(items, today, umbrella),
  };
}

// ---------------------------------------------------------------- 4. meetings

function isMeeting(n: VaultNote): boolean {
  return n.path.toLowerCase().startsWith("10-sessions/meetings/");
}

/** Default hour span of the weekday grid; widened when meetings fall outside it. */
const GRID_HOUR_FROM = 8;
const GRID_HOUR_TO = 19;

export function vaultMeetings(notes: readonly VaultNote[], today: number): VaultMeetings {
  const meetings = dated(notes, today).filter((it) => isMeeting(it.note));
  const minutesOf = (n: VaultNote): number => n.minutes ?? 0;

  const hours = new Array<number>(WEEKS).fill(0);
  const counts = new Array<number>(WEEKS).fill(0);
  const cells: { dow: number; hour: number }[] = [];
  let sum90 = 0;
  let known90 = 0;
  const byProject = new Map<string, number>();
  const longest: VaultMeeting[] = [];
  for (const it of meetings) {
    const slot = weekSlot(it.day, today);
    if (slot >= 0) {
      add(hours, slot, minutesOf(it.note) / 60);
      add(counts, slot, 1);
    }
    const ago = today - it.day;
    const hour = it.note.hour;
    if (ago < 365 && hour !== null && hour >= 0 && hour <= 23) cells.push({ dow: dowOf(it.day), hour });
    if (ago < 90) {
      if (it.note.minutes !== null) {
        sum90 += it.note.minutes;
        known90++;
      }
      bump(byProject, it.note.project === "" ? "unfiled" : it.note.project, minutesOf(it.note) / 60);
    }
    if (ago < 30 && it.note.minutes !== null) {
      longest.push({
        path: it.note.path,
        name: nameOf(it.note.path),
        day: dayToIso(it.day),
        minutes: it.note.minutes,
        project: it.note.project,
      });
    }
  }

  let hourFrom = GRID_HOUR_FROM;
  let hourTo = GRID_HOUR_TO;
  for (const c of cells) {
    hourFrom = Math.min(hourFrom, c.hour);
    hourTo = Math.max(hourTo, c.hour);
  }
  const width = hourTo - hourFrom + 1;
  const grid = new Array<number>(7 * width).fill(0);
  for (const c of cells) add(grid, c.dow * width + (c.hour - hourFrom), 1);
  let peak: VaultMeetings["peak"] = null;
  for (let i = 0; i < grid.length; i++) {
    const n = grid[i] ?? 0;
    if (n > 0 && (peak === null || n > peak.n)) peak = { dow: Math.floor(i / width), hour: hourFrom + (i % width), n };
  }

  const last12 = hours.slice(WEEKS - 12);
  return {
    weeks: weekLabels(today),
    hours: hours.map(round1),
    counts,
    grid,
    hourFrom,
    hourTo,
    hoursThisWeek: round1(hours[WEEKS - 1] ?? 0),
    avgHours12w: round1(sumOf(last12) / 12),
    countThisWeek: counts[WEEKS - 1] ?? 0,
    avgMinutes90: known90 > 0 ? sum90 / known90 : 0,
    peak,
    longest: longest.sort((a, b) => b.minutes - a.minutes || cmp(a.path, b.path)).slice(0, LONGEST_CAP),
    byProject: [...byProject]
      .filter(([, h]) => h > 0)
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, MEETING_PROJECT_CAP)
      .map(([key, h]) => ({ key, hours: round1(h) })),
  };
}

// ---------------------------------------------------------------- 5. projects

interface ProjectAcc {
  notes: number;
  last: number | null;
  n30: number;
  prev30: number;
  umbrellas: Map<string, number>;
}

export function vaultProjects(notes: readonly VaultNote[], today: number): VaultProjects {
  const all = live(notes);
  const indexed = new Set<string>();
  for (const n of all) {
    const m = /^20-Projects\/([^/]+)\/_index\.md$/.exec(n.path);
    if (m?.[1]) indexed.add(m[1]);
  }

  const acc = new Map<string, ProjectAcc>();
  let sessionNotes = 0;
  for (const n of all) {
    if (n.project === "") continue;
    if (n.path.toLowerCase().startsWith("10-sessions/")) sessionNotes++;
    let p = acc.get(n.project);
    if (!p) {
      p = { notes: 0, last: null, n30: 0, prev30: 0, umbrellas: new Map() };
      acc.set(n.project, p);
    }
    p.notes++;
    if (n.umbrella !== "") bump(p.umbrellas, n.umbrella);
    if (n.day !== null && n.day <= today) {
      p.last = p.last === null ? n.day : Math.max(p.last, n.day);
      const ago = today - n.day;
      if (ago < 30) p.n30++;
      else if (ago < 60) p.prev30++;
    }
  }

  const projects: VaultProject[] = [];
  for (const [slug, p] of acc) {
    // Modal umbrella; a tie goes to the alphabetically first so the pick is stable.
    const top = topCounts(p.umbrellas, 1)[0];
    projects.push({
      slug,
      umbrella: top?.key ?? "unfiled",
      notes: p.notes,
      last: p.last === null ? null : dayToIso(p.last),
      n30: p.n30,
      prev30: p.prev30,
      indexPath: indexed.has(slug) ? `20-Projects/${slug}/_index.md` : null,
    });
  }
  projects.sort((a, b) => b.notes - a.notes || cmp(a.slug, b.slug));

  const umb = new Map<string, VaultUmbrella>();
  for (const p of projects) {
    const u = umb.get(p.umbrella) ?? { key: p.umbrella, projects: 0, notes: 0, n30: 0 };
    u.projects++;
    u.notes += p.notes;
    u.n30 += p.n30;
    umb.set(p.umbrella, u);
  }

  const hot = projects.filter((p) => p.n30 > 0).sort((a, b) => b.n30 - a.n30 || b.notes - a.notes || cmp(a.slug, b.slug))[0];
  return {
    items: projects.slice(0, PROJECT_ITEM_CAP),
    umbrellas: [...umb.values()].sort((a, b) => b.notes - a.notes || cmp(a.key, b.key)).slice(0, UMBRELLA_CAP),
    active30: projects.filter((p) => p.n30 > 0).length,
    sessionNotes,
    busiest: hot?.slug ?? null,
    quiet: projects.filter((p) => p.notes >= BIG_PROJECT_NOTES && p.n30 === 0).slice(0, QUIET_PROJECT_CAP),
  };
}

// ---------------------------------------------------------------- 6. topics

interface TagAcc {
  tag: string;
  family: string;
  total: number;
  weeks: number[];
  n30: number;
  p30: number;
  p90: number;
}

function familyOf(tag: string): string {
  const i = tag.indexOf("/");
  return i <= 0 ? "(plain)" : tag.slice(0, i);
}

function toTag(a: TagAcc): VaultTag {
  return {
    tag: a.tag,
    family: a.family,
    total: a.total,
    weeks: a.weeks,
    n30: a.n30,
    p30: a.p30,
    p90: a.p90,
    score: a.n30 / (a.p90 / 3 + 1),
  };
}

export function vaultTopics(notes: readonly VaultNote[], today: number): VaultTopics {
  const tags = new Map<string, TagAcc>();
  const families = new Map<string, number>();
  for (const n of live(notes)) {
    const seen = new Set<string>();
    for (const raw of n.tags) {
      const tag = raw.replace(/^#/, "");
      if (tag !== "") seen.add(tag);
    }
    const famSeen = new Set<string>();
    for (const tag of seen) {
      let a = tags.get(tag);
      if (!a) {
        a = { tag, family: familyOf(tag), total: 0, weeks: new Array<number>(WEEKS).fill(0), n30: 0, p30: 0, p90: 0 };
        tags.set(tag, a);
      }
      a.total++;
      famSeen.add(a.family);
      if (n.day === null || n.day > today) continue;
      const slot = weekSlot(n.day, today);
      if (slot >= 0) add(a.weeks, slot, 1);
      // n30 is ago 0..29, p30 the 30 before, p90 is ago 30..119 (so it never overlaps n30).
      const ago = today - n.day;
      if (ago < 30) a.n30++;
      else if (ago < 60) a.p30++;
      if (ago >= 30 && ago < 120) a.p90++;
    }
    for (const f of famSeen) bump(families, f);
  }

  const familyList = topCounts(families, TOPIC_FAMILY_CAP);
  const items: VaultTag[] = [];
  for (const fam of familyList.slice(0, TOPIC_ITEM_FAMILIES)) {
    const rows = [...tags.values()]
      .filter((a) => a.family === fam.key)
      .sort((a, b) => b.total - a.total || cmp(a.tag, b.tag))
      .slice(0, TOPIC_PER_FAMILY);
    for (const a of rows) items.push(toTag(a));
  }

  const real = [...tags.values()].filter((a) => !NOISE_FAMILIES.has(a.family)).map(toTag);
  return {
    families: familyList,
    items,
    rising: real
      .filter((t) => t.n30 >= 3)
      .sort((a, b) => b.score - a.score || b.n30 - a.n30 || cmp(a.tag, b.tag))
      .slice(0, TOPIC_SPOTLIGHT_CAP),
    quiet: real
      .filter((t) => t.p90 >= 12 && t.n30 === 0)
      .sort((a, b) => b.p90 - a.p90 || cmp(a.tag, b.tag))
      .slice(0, TOPIC_SPOTLIGHT_CAP),
  };
}

// ---------------------------------------------------------------- 7. people

/** A company note is typed "company" or sits in a companies/company folder. */
function isCompany(n: VaultNote): boolean {
  if (n.type === "company") return true;
  const dirs = n.path.split("/").slice(0, -1).map((s) => s.toLowerCase());
  return dirs.includes("companies") || dirs.includes("company");
}

function bandOf(total: number, daysSince: number | null): VaultBand {
  const within = (n: number): boolean => daysSince !== null && daysSince < n;
  if (total >= KNOWN_ENTITY_TOTAL) {
    if (within(30)) return "inner";
    if (within(120)) return "fading";
  } else if (within(365)) return "occasional";
  return "dormant";
}

function toEntity(n: VaultNote, mentions: ReadonlyMap<number, number>, today: number): VaultEntity {
  const curMonth = monthIndex(today);
  const months = new Array<number>(12).fill(0);
  let total = 0;
  let n90 = 0;
  for (const [week, count] of mentions) {
    total += count;
    // A week counts on its first day, the same label the rest of the file uses for a bucket.
    const first = week * 7;
    if (first > today) continue;
    if (first > today - 90) n90 += count;
    const slot = monthIndex(first) - (curMonth - 11);
    if (slot >= 0 && slot < 12) add(months, slot, count);
  }
  const daysSince = n.mentionLast === null ? null : Math.max(0, today - n.mentionLast);
  return {
    path: n.path,
    name: nameOf(n.path),
    total,
    last: n.mentionLast === null ? null : dayToIso(n.mentionLast),
    daysSince,
    n90,
    months,
    band: bandOf(total, daysSince),
  };
}

export function vaultPeople(notes: readonly VaultNote[], today: number): VaultPeople {
  const people: VaultEntity[] = [];
  const companies: VaultEntity[] = [];
  for (const n of live(notes)) {
    if (n.mentionWeeks === null) continue;
    (isCompany(n) ? companies : people).push(toEntity(n, n.mentionWeeks, today));
  }
  const byTotal = (a: VaultEntity, b: VaultEntity): number => b.total - a.total || cmp(a.name, b.name) || cmp(a.path, b.path);
  const everyone = [...people, ...companies];
  return {
    people: people.sort(byTotal).slice(0, ENTITY_LIST_CAP),
    companies: companies.sort(byTotal).slice(0, ENTITY_LIST_CAP),
    withNote: everyone.length,
    seen30: everyone.filter((e) => e.daysSince !== null && e.daysSince < 30).length,
    inner: everyone.filter((e) => e.band === "inner").length,
    fading: everyone.filter((e) => e.band === "fading").length,
    reconnect: everyone.filter((e) => e.band === "fading").sort(byTotal).slice(0, ENTITY_SPOTLIGHT_CAP),
    top90: everyone
      .filter((e) => e.n90 > 0)
      .sort((a, b) => b.n90 - a.n90 || byTotal(a, b))
      .slice(0, ENTITY_SPOTLIGHT_CAP),
  };
}

// ---------------------------------------------------------------- 8. sources

/** The capture tool a session note came from, or null when it is not a session note. */
function sourceOf(n: VaultNote): string | null {
  const parts = n.path.split("/");
  if ((parts[0] ?? "").toLowerCase() !== "10-sessions") return null;
  if (parts.length >= 3) return (parts[1] ?? "").toLowerCase();
  return n.type !== "" ? n.type.toLowerCase() : "other";
}

function isAiSource(key: string): boolean {
  return /claude|chatgpt|cowork|jarvis/i.test(key);
}

export function vaultSources(notes: readonly VaultNote[], today: number): VaultSources {
  const sessions: { note: VaultNote; source: string }[] = [];
  for (const n of live(notes)) {
    const source = sourceOf(n);
    if (source !== null) sessions.push({ note: n, source });
  }

  const totals = new Map<string, number>();
  const last30 = new Map<string, number>();
  const umbrellas = new Map<string, number>();
  const flows = new Map<string, number>();
  const thisMonth = new Map<string, number>();
  const curMonth = monthIndex(today);
  let claude90 = 0;
  let ai90 = 0;
  let claudePrev = 0;
  let aiPrev = 0;
  for (const { note, source } of sessions) {
    bump(totals, source);
    const umbrella = note.umbrella === "" ? "unfiled" : note.umbrella;
    bump(umbrellas, umbrella);
    if (note.day === null || note.day > today) continue;
    const ago = today - note.day;
    if (ago < 30) bump(last30, source);
    if (ago < 90) {
      bump(flows, `${source}\u0000${umbrella}`);
      if (isAiSource(source)) {
        ai90++;
        if (source.includes("claude")) claude90++;
      }
    }
    if (ago >= 365 && ago < 455 && isAiSource(source)) {
      aiPrev++;
      if (source.includes("claude")) claudePrev++;
    }
    if (monthIndex(note.day) === curMonth) bump(thisMonth, source);
  }

  const items = dated(sessions.map((s) => s.note), today);
  const months = monthWindow(items, today, PULSE_MONTHS);
  const first = months[0] ?? 0;
  const mix = new Map<string, number[]>();
  for (const { note, source } of sessions) {
    if (note.day === null || note.day > today) continue;
    const slot = monthIndex(note.day) - first;
    if (slot < 0 || slot >= months.length) continue;
    add(seriesSlot(mix, source, months.length), slot, 1);
  }

  const sourceRows: VaultSource[] = [...totals]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, SOURCE_CAP)
    .map(([key, total]) => ({ key, total, n30: last30.get(key) ?? 0, ai: isAiSource(key) }));
  const flowRows: VaultFlow[] = [...flows]
    .filter(([, n]) => n >= FLOW_MIN)
    .map(([k, n]) => {
      const [from = "", to = ""] = k.split("\u0000");
      return { from, to, n };
    })
    .sort((a, b) => b.n - a.n || cmp(a.from, b.from) || cmp(a.to, b.to))
    .slice(0, FLOW_CAP);

  return {
    sources: sourceRows,
    umbrellas: topCounts(umbrellas, SOURCE_UMBRELLA_CAP),
    flows: flowRows,
    months: months.map(monthLabel),
    mix: foldSeries(mix, (k) => sumOf(mix.get(k) ?? []), SERIES_TOP),
    captured: sessions.length,
    claudeShare90: ai90 > 0 ? claude90 / ai90 : 0,
    claudeSharePrev: aiPrev > 0 ? claudePrev / aiPrev : 0,
    topThisMonth: topCounts(thisMonth, 1)[0]?.key ?? null,
  };
}

// ---------------------------------------------------------------- 9. echoes

/** Small seeded generator (mulberry32): same seed, same walk, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Whole calendar months from `day` to `today`; a month only counts once its day-of-month is reached. */
function wholeMonthsBetween(day: number, today: number): number {
  const a = new Date(day * DAY_MS);
  const b = new Date(today * DAY_MS);
  const months = b.getUTCFullYear() * 12 + b.getUTCMonth() - (a.getUTCFullYear() * 12 + a.getUTCMonth());
  return Math.max(0, b.getUTCDate() < a.getUTCDate() ? months - 1 : months);
}

/** The day `months` calendar months before `today`, clamped to the target month's last day. */
function monthsBefore(today: number, months: number): number {
  const d = new Date(today * DAY_MS);
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() - months;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12;
  const lastDom = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastDom)) / DAY_MS;
}

const ANNIVERSARIES: readonly { label: string; months: number }[] = [
  { label: "3 months ago", months: 3 },
  { label: "6 months ago", months: 6 },
  { label: "1 year ago", months: 12 },
  { label: "2 years ago", months: 24 },
  { label: "3 years ago", months: 36 },
];
/** A note is "on this day" when it falls within this many days of the anniversary. */
const ON_THIS_DAY_WINDOW = 3;
const GEM_MIN_LINKS = 4;
const GEM_MIN_AGE_DAYS = 180;

export function vaultEchoes(
  notes: readonly VaultNote[],
  today: number,
  seed: number,
  inbound: ReadonlyMap<string, number> = inboundCounts(notes),
): VaultEchoes {
  const all = live(notes);
  const rand = mulberry32(seed);
  const linkCount = (n: VaultNote): number => n.links.length + (inbound.get(n.id) ?? 0);

  // Sorted by path first so the same seed picks the same gems whatever order the feed came in.
  const eligible = all
    .filter((n) => n.day !== null && today - n.day > GEM_MIN_AGE_DAYS && linkCount(n) >= GEM_MIN_LINKS)
    .sort((a, b) => cmp(a.path, b.path));
  const picked: VaultNote[] = [];
  for (let i = 0; i < Math.min(GEM_CAP, eligible.length); i++) {
    const j = i + Math.floor(rand() * (eligible.length - i));
    const a = eligible[i];
    const b = eligible[j];
    if (!a || !b) continue;
    eligible[i] = b;
    eligible[j] = a;
    picked.push(b);
  }
  const gems: VaultGem[] = picked.map((n) => ({
    ...toRef(n, inbound),
    quietMonths: wholeMonthsBetween(n.day ?? today, today),
  }));

  const onThisDay: VaultOnThisDay[] = [];
  for (const a of ANNIVERSARIES) {
    const target = monthsBefore(today, a.months);
    const hits = all
      .filter((n) => n.day !== null && Math.abs(n.day - target) <= ON_THIS_DAY_WINDOW)
      .sort((x, y) => Math.abs((x.day ?? 0) - target) - Math.abs((y.day ?? 0) - target) || cmp(x.path, y.path))
      .slice(0, ON_THIS_DAY_CAP);
    if (hits.length > 0) onThisDay.push({ label: a.label, notes: hits.map((n) => toRef(n, inbound)) });
  }

  // A random walk along outbound links from the first gem. Attachments and unresolved ids are
  // not stops; a node with nowhere unvisited to go ends the walk early.
  const byId = new Map<string, VaultNote>();
  for (const n of all) byId.set(n.id, n);
  const wander: VaultNoteRef[] = [];
  const start = picked[0];
  if (start) {
    const visited = new Set<string>([start.id]);
    let here = start;
    wander.push(toRef(here, inbound));
    for (let hop = 0; hop < WANDER_HOPS; hop++) {
      const options: VaultNote[] = [];
      const offered = new Set<string>();
      for (const id of here.links) {
        const next = byId.get(id);
        if (!next || visited.has(id) || offered.has(id)) continue;
        offered.add(id);
        options.push(next);
      }
      const chosen = options[Math.floor(rand() * options.length)];
      if (!chosen) break;
      visited.add(chosen.id);
      wander.push(toRef(chosen, inbound));
      here = chosen;
    }
  }

  return { gems, onThisDay, wander, seed };
}

// ---------------------------------------------------------------- 10. gaps

/** Name collapsed so "Weekly Review", "weekly-review" and "WeeklyReview" meet. */
function duplicateKey(path: string): string {
  return nameOf(path)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function vaultGaps(notes: readonly VaultNote[], inbound: ReadonlyMap<string, number> = inboundCounts(notes)): VaultGaps {
  const all = live(notes);
  const orphansByFolder = new Map<string, number>();
  const untypedByFolder = new Map<string, number>();
  const ghostNotes = new Map<string, number>();
  const wantedGhosts = new Map<string, number>();
  const names = new Map<string, string[]>();
  const indexed = new Set<string>();
  const projectSlugs = new Set<string>();
  const unanchoredByFolder = new Map<string, number>();
  let orphans = 0;
  let untyped = 0;
  let unanchored = 0;
  let climbs = false;

  for (const n of all) {
    const folder = folderOf(n.path);
    if (n.links.length === 0 && (inbound.get(n.id) ?? 0) === 0) {
      orphans++;
      bump(orphansByFolder, folder);
    }
    if (n.type === "") {
      untyped++;
      bump(untypedByFolder, folder);
    }
    if (n.up !== null) climbs = true;
    if (n.upRule === "home") {
      unanchored++;
      bump(unanchoredByFolder, folder);
    }
    for (const g of new Set(n.ghosts)) {
      bump(ghostNotes, g);
      if (!isImportedNote(n)) bump(wantedGhosts, g);
    }
    const key = duplicateKey(n.path);
    if (key.length >= DUPLICATE_MIN_KEY) {
      const list = names.get(key);
      if (list) list.push(n.path);
      else names.set(key, [n.path]);
    }
    const m = /^20-Projects\/([^/]+)\/_index\.md$/.exec(n.path);
    // macOS folders are case-insensitive: 20-Projects/Groot/ is the note for `groot`.
    if (m?.[1]) indexed.add(m[1].toLowerCase());
    if (n.project !== "") projectSlugs.add(n.project);
  }

  const duplicates: VaultDuplicate[] = [...names]
    .filter(([, paths]) => paths.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]))
    .slice(0, DUPLICATE_CAP)
    .map(([key, paths]) => ({ key, paths: [...paths].sort(cmp).slice(0, DUPLICATE_PATHS_CAP) }));

  const missing = [...projectSlugs].filter((s) => !indexed.has(s.toLowerCase())).sort(cmp);
  return {
    notes: all.length,
    linked: all.length - orphans,
    orphans,
    ghostTotal: ghostNotes.size,
    untyped,
    projectsMissingNote: missing.length,
    writeNext: topCounts(wantedGhosts, WRITE_NEXT_CAP).filter((c) => c.n >= WRITE_NEXT_MIN_INBOUND),
    orphansByFolder: topCounts(orphansByFolder, GAP_FOLDER_CAP),
    duplicates,
    missingProjects: missing.slice(0, MISSING_PROJECT_CAP),
    untypedByFolder: topCounts(untypedByFolder, GAP_FOLDER_CAP),
    unanchored: climbs ? unanchored : null,
    unanchoredByFolder: topCounts(unanchoredByFolder, GAP_FOLDER_CAP),
  };
}

// ---------------------------------------------------------------- climb

/** A chain is never longer than this; the vault's deepest is 6 steps. */
const CLIMB_MAX = 32;
const CLIMB_ROOT = "Home.md";

/** Follow `up` from one note to Home. `byId`/`byPath` are passed in so a caller can build them once. */
export function vaultClimb(
  path: string,
  byPath: ReadonlyMap<string, VaultNote>,
  byId: ReadonlyMap<string, VaultNote>,
): VaultClimb {
  const start = byPath.get(path.toLowerCase()) ?? byPath.get(`${path}.md`.toLowerCase());
  if (!start) return { steps: [], end: "unknown" };
  const steps: VaultClimbStep[] = [{ path: start.path, rule: "" }];
  const seen = new Set([start.id]);
  let cur = start;
  while (steps.length <= CLIMB_MAX) {
    if (cur.up === null) {
      if (cur.path === CLIMB_ROOT) return { steps, end: "root" };
      // No step up from where we started: a feed built before the climb column, or a note it skips.
      return { steps, end: steps.length === 1 ? "unknown" : "dead-end" };
    }
    const next = byId.get(cur.up);
    if (!next) return { steps, end: "dead-end" };
    steps.push({ path: next.path, rule: cur.upRule });
    if (seen.has(next.id)) return { steps, end: "loop" };
    seen.add(next.id);
    cur = next;
  }
  return { steps, end: "loop" };
}

// ---------------------------------------------------------------- drill list

function matches(n: VaultNote, q: VaultNotesQuery): boolean {
  switch (q.kind) {
    case "ghost":
      return n.ghosts.includes(q.value);
    case "folder":
      return folderOf(n.path) === q.value;
    case "tag":
      return n.tags.includes(q.value);
    case "day":
      return n.day !== null && dayToIso(n.day) === q.value;
    case "type":
      return n.type === q.value;
    case "project":
      return n.project === q.value;
    case "umbrella":
      return n.umbrella === q.value;
    case "unanchored":
      return n.upRule === "home" && folderOf(n.path) === q.value;
  }
}

/** Notes matching one filter, newest-dated first (undated last, then by path), capped by the caller. */
export function vaultNotes(
  notes: readonly VaultNote[],
  query: VaultNotesQuery,
  cap: number,
  inbound: ReadonlyMap<string, number> = inboundCounts(notes),
): { notes: VaultNoteRef[]; total: number; truncated: boolean } {
  const hits = live(notes)
    .filter((n) => matches(n, query))
    .sort((a, b) => {
      if (a.day !== b.day) {
        if (a.day === null) return 1;
        if (b.day === null) return -1;
        return b.day - a.day;
      }
      return cmp(a.path, b.path);
    });
  const limit = Math.max(0, Math.floor(cap));
  return {
    notes: hits.slice(0, limit).map((n) => toRef(n, inbound)),
    total: hits.length,
    truncated: hits.length > limit,
  };
}
