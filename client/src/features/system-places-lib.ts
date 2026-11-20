// Pure logic for the Orbit's physical "system places" (round 11 C): the Jev tower, the CLI
// station, the model power plants, the hook gates and the Institute of Truth's three memory
// buildings (episodic archive, semantic library, procedural workshop) that stand next to Harness
// City, and the routes the live-traffic couriers take between them. No DOM, no THREE: system-places.ts turns
// these ids into world points and meshes. Real data only: every count comes from what the caller
// passes in (store agents, harness hook objects); nothing is guessed. Unit-tested in
// system-places-lib.test.ts.
//
// The model-family and hook-event helpers used to live in views/system-lib.ts (the System view,
// removed in round 11); they are copied here so the planet and the Canvas keep one source.

import { stationOfActivity, type StationId } from "../../../shared/stations";
import type { CareerWorker, Department } from "../../../shared/features/careers";
import { isSessionOutcome, type OutcomeSummary } from "../../../shared/features/outcomes";
import { SICKNESS_OPEN_CAP, type SicknessKind, type SicknessOpenEntry, type SicknessState } from "../../../shared/features/sickness";
import type { AutopilotStats, InstituteSnapshot, StudyPipelineStatus } from "../../../shared/features/skills";
import { INSTITUTE_OF_TRUTH } from "../../../shared/features/wake-recall";
import type { AgentActivity, WorldAgent, WorldObject } from "../../../shared/types";

// ---------------------------------------------------------------- model families (power plants)

/** Mirrors scene/creatures.ts's modelFamily() substring rules (kept local: no THREE import). */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";
/** The four that get a power plant; "other" (e.g. "<synthetic>", unknown) has none. */
export const PLANT_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
export type PlantFamily = (typeof PLANT_FAMILIES)[number];
export const FAMILY_LABELS: Record<ModelFamily, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", other: "Other" };
export const FAMILY_COLORS: Record<PlantFamily, number> = { opus: 0xff7a1a, sonnet: 0x3a86ff, haiku: 0x06d6a0, fable: 0xb15cff };

export function modelFamilyOf(model: string | null | undefined): ModelFamily {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "other";
}

export function isPlantFamily(f: ModelFamily): f is PlantFamily {
  return f !== "other";
}

export interface PlantStat {
  family: ModelFamily;
  label: string;
  live: number;
  /** Sessions whose last activity is at or after `sinceMs` (local midnight = "today"). */
  today: number;
  total: number;
}

/** Per family (the four plants, then "other"): live / active-today / all-time session counts. */
export function plantStats(agents: readonly Pick<WorldAgent, "model" | "status" | "lastActive">[], sinceMs: number): PlantStat[] {
  const fams: ModelFamily[] = [...PLANT_FAMILIES, "other"];
  const out = new Map<ModelFamily, PlantStat>(fams.map((f) => [f, { family: f, label: FAMILY_LABELS[f], live: 0, today: 0, total: 0 }]));
  for (const a of agents) {
    const s = out.get(modelFamilyOf(a.model));
    if (!s) continue;
    s.total += 1;
    if (a.status === "live") s.live += 1;
    const t = Date.parse(a.lastActive);
    if (Number.isFinite(t) && t >= sinceMs) s.today += 1;
  }
  return fams.map((f) => out.get(f) as PlantStat);
}

/** Plant core size: 1 when idle, growing with live sessions (log-ish, capped at 2.2). */
export function plantScale(live: number): number {
  if (!Number.isFinite(live) || live <= 0) return 1;
  return Math.min(2.2, 1 + Math.log2(1 + live) * 0.45);
}

// ---------------------------------------------------------------- hook gates

export const GATE_EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"] as const;
export type GateEvent = (typeof GATE_EVENTS)[number];
export const GATE_TEXT: Record<GateEvent, { short: string; plain: string }> = {
  UserPromptSubmit: { short: "Prompt gate", plain: "runs on every prompt you send, before the model sees it" },
  PreToolUse: { short: "Tool gate", plain: "runs before each tool call (it can rewrite or block it)" },
  PermissionRequest: { short: "Permission gate", plain: "runs when an agent asks permission; can route the ask to this app" },
  Stop: { short: "Stop gate", plain: "runs when an agent finishes a turn (verify, learn, tidy up)" },
};

export interface GateInfo {
  event: GateEvent;
  configured: boolean;
  /** Script basenames from the harness hook objects ("<event>:<script>"), sorted, deduped. */
  scripts: string[];
}

export function hookGates(objects: Iterable<Pick<WorldObject, "kind" | "name">>): GateInfo[] {
  const byEvent = new Map<string, Set<string>>();
  for (const o of objects) {
    if (o.kind !== "hook") continue;
    const sep = o.name.indexOf(":");
    if (sep <= 0) continue;
    const script = o.name.slice(sep + 1);
    if (!script) continue;
    const set = byEvent.get(o.name.slice(0, sep)) ?? new Set<string>();
    set.add(script);
    byEvent.set(o.name.slice(0, sep), set);
  }
  return GATE_EVENTS.map((event) => {
    const scripts = [...(byEvent.get(event) ?? [])].sort((a, b) => a.localeCompare(b));
    return { event, configured: scripts.length > 0, scripts };
  });
}

/** Is the Jev router hook (hooks/jev-router.mjs) on UserPromptSubmit? The harness names a hook by
 *  its command's basename, and the installer runs it as `node …/jev-router.mjs`, so it usually
 *  shows up as "node": "installed" = a script named jev-router, "likely" = a node script on
 *  UserPromptSubmit (the router's install shape; not proof), "absent" = neither. */
export type RouterHookState = "installed" | "likely" | "absent";
export function routerHookState(gates: readonly GateInfo[]): RouterHookState {
  const ups = gates.find((g) => g.event === "UserPromptSubmit");
  if (!ups) return "absent";
  if (ups.scripts.some((s) => /jev-router/i.test(s))) return "installed";
  if (ups.scripts.some((s) => /^node(\.exe)?$/i.test(s))) return "likely";
  return "absent";
}

// ---------------------------------------------------------------- the quarter's layout

/** The memory library (round 11 C) split into three buildings, together the Institute of Truth
 *  (the town's second brain) — see explain-lib.ts's episodicCard/semanticCard/proceduralCard and
 *  instituteOfTruthCard. A memory-read courier still stops at one place (the semantic library, by
 *  default: see courierRoute below). */
export type MemoryPlaceId = "episodic" | "semantic" | "procedural";
export const MEMORY_PLACE_IDS: readonly MemoryPlaceId[] = ["episodic", "semantic", "procedural"];

/** The three memory buildings' group name. Never "Institute" alone: that word was the Skills
 *  panel's study tab, now called the School. */
export { INSTITUTE_OF_TRUTH };

/** Each building's role in the Institute of Truth, and what it keeps (plain words). */
export const INSTITUTE_ROLES: Readonly<Record<MemoryPlaceId, { role: string; keeps: string }>> = {
  episodic: { role: "archive", keeps: "what happened" },
  semantic: { role: "library", keeps: "what's true" },
  procedural: { role: "workshop", keeps: "what works" },
};

export function isMemoryPlace(id: string): id is MemoryPlaceId {
  return (MEMORY_PLACE_IDS as readonly string[]).includes(id);
}

/** The Explain tag's second line for a memory building: "Institute of Truth · what happened". */
export function memoryPlaceCaption(id: MemoryPlaceId): string {
  return `${INSTITUTE_OF_TRUTH} · ${INSTITUTE_ROLES[id].keeps}`;
}

export type PlaceId = "jev" | "cli" | MemoryPlaceId | `gate:${GateEvent}` | `plant:${PlantFamily}`;
export const PLACE_IDS: readonly PlaceId[] = [
  ...GATE_EVENTS.map((e) => `gate:${e}` as const),
  "jev",
  "cli",
  ...PLANT_FAMILIES.map((f) => `plant:${f}` as const),
  ...MEMORY_PLACE_IDS,
];

export interface PlaceSlot {
  id: PlaceId;
  /** Harness-local polar position (radians, tangent units from Harness City's centre). */
  angle: number;
  radius: number;
}

/** The System Quarter: an arc outside Harness City's plaza, Tool Yard and the routines rings
 *  (which reach ~20.5 units out), in route order so a courier's path reads left to right:
 *  gates → Jev tower → CLI station → plants → episodic → semantic → procedural.
 *  `harnessRadius` = Harness City's built-up radius. The arc widened in round 11 C (10 → 13
 *  places) to keep neighbours at least as far apart as before. */
export const QUARTER_CENTER_ANGLE = Math.PI * 0.5 + 0.35;
export const QUARTER_ARC = 2.1;
export function quarterSlots(harnessRadius: number): PlaceSlot[] {
  const base = Math.max(harnessRadius + 12, 23);
  const n = PLACE_IDS.length;
  return PLACE_IDS.map((id, i) => ({
    id,
    angle: QUARTER_CENTER_ANGLE - QUARTER_ARC / 2 + (QUARTER_ARC * i) / (n - 1),
    radius: id === "jev" ? base + 2 : base,
  }));
}

// ---------------------------------------------------------------- the campus (agent-city piece 7)
// Two more places on the quarter's arc, past one of its ends: 🏫 the School (the upskill study
// pipeline, the Skills panel's "School" tab; never "Institute" alone, see INSTITUTE_OF_TRUTH above)
// and 🎓 the Graduates' Hall (one banner per trusted automation worker). They are NOT in
// PLACE_IDS: couriers never visit them, and quarterSlots spaces its arc by PLACE_IDS.length, so
// adding them there would move every existing place (#22). Their slots are chosen once at boot
// from the frozen city layout; after that only the lamp colour, the banner count and the chips'
// text change (#16).

export type CampusId = "school" | "hall";
export const CAMPUS_IDS: readonly CampusId[] = ["school", "hall"];

export function isCampusId(v: string): v is CampusId {
  return (CAMPUS_IDS as readonly string[]).includes(v);
}

/** A neighbouring city's built-up disc in Harness-local tangent coordinates. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Other cities as discs on Harness's tangent plane: the inverse of layout.ts cityPoint (a gnomonic
 *  projection). A city's radius grows by 1/cos²θ out there, so its disc is never undersized.
 *  Cities more than ~78° away can't reach the quarter and are skipped. */
export function harnessObstacles(
  harness: { dir: Vec3Like; t1: Vec3Like; t2: Vec3Like },
  cities: Iterable<{ id: string; dir: Vec3Like; radius: number }>,
  surface: number,
): Obstacle[] {
  const out: Obstacle[] = [];
  for (const c of cities) {
    if (c.id === "harness") continue;
    const cos = dot(c.dir, harness.dir);
    if (cos < 0.2) continue;
    const k = surface / cos;
    out.push({ x: k * dot(c.dir, harness.t1), z: k * dot(c.dir, harness.t2), r: c.radius / (cos * cos) });
  }
  return out;
}

/** Footprint radius (tangent units, after the quarter's 1.15 scale) of each campus place: the
 *  School's platform corner (1.5, 1.2) and the Hall's outermost banner cloth (2.23, 2.49), both
 *  hall-local, × 1.15. */
export const CAMPUS_FOOTPRINT: Readonly<Record<CampusId, number>> = { school: 2.2, hall: 3.9 };
/** Clearance (tangent units) a campus place wants from every neighbouring city's edge. */
export const CAMPUS_MIN_CLEARANCE = 1;

export interface CampusSlot {
  id: CampusId;
  angle: number;
  radius: number;
  /** Distance from this place's footprint to the nearest city's edge (Infinity with no neighbour). */
  clearance: number;
}

function clearanceAt(x: number, z: number, footprint: number, obstacles: readonly Obstacle[]): number {
  let best = Infinity;
  for (const o of obstacles) best = Math.min(best, Math.hypot(x - o.x, z - o.z) - o.r - footprint);
  return best;
}

/**
 * The campus's two slots: the quarter's arc carried on past one of its ends, at the quarter's own
 * spacing, the School first and the Hall one and a half steps further on. Candidates are tried in
 * a fixed order (past the procedural workshop first, nearest the quarter first, then pushed out,
 * then past the hook gates) and the first whose places both clear every neighbouring city by
 * CAMPUS_MIN_CLEARANCE wins; when none does, the one with the most room. Pure and deterministic:
 * the same layout always gives the same campus, and the layout is frozen at boot.
 */
export function campusSlots(harnessRadius: number, obstacles: readonly Obstacle[]): CampusSlot[] {
  const quarter = quarterSlots(harnessRadius);
  const step = QUARTER_ARC / (PLACE_IDS.length - 1);
  const base = quarter[0]?.radius ?? 23;
  const ends: Array<{ from: number; sign: number }> = [
    { from: QUARTER_CENTER_ANGLE + QUARTER_ARC / 2, sign: 1 },
    { from: QUARTER_CENTER_ANGLE - QUARTER_ARC / 2, sign: -1 },
  ];
  let best: { slots: CampusSlot[]; score: number } | null = null;
  for (const end of ends) {
    for (const lift of [0, 4, 8]) {
      for (let k = 1.3; k <= 6.01; k += 0.5) {
        const radius = base + lift;
        const slots = CAMPUS_IDS.map((id, i) => {
          const angle = end.from + end.sign * step * (k + i * 1.5);
          const clearance = clearanceAt(Math.cos(angle) * radius, Math.sin(angle) * radius, CAMPUS_FOOTPRINT[id], obstacles);
          return { id, angle, radius, clearance };
        });
        const score = Math.min(...slots.map((s) => s.clearance));
        if (score >= CAMPUS_MIN_CLEARANCE) return slots;
        if (!best || score > best.score) best = { slots, score };
      }
    }
  }
  return best?.slots ?? [];
}

// ---------------------------------------------------------------- the Clinic (vision wave 4)
// 🏥 The Clinic: one more place on the quarter's arc, past the end the campus didn't take (or on
// past the Hall), lit while any case is sick. Like the campus it is NOT in PLACE_IDS (that would
// move every place, #22) and its slot is picked once at boot from the frozen layout (#16); after
// that only its lamp and the marks on sick houses change. The marks are extra instances of the
// quarter's orb mesh, so sickness adds no draw call.

/** Footprint radius (tangent units, after the 1.15 scale): the platform corner (1.3, 1.0) × 1.15. */
export const CLINIC_FOOTPRINT = 1.9;
/** Any quarter place's footprint radius, the widest: a memory building's platform corner (1.6, 1.3) × 1.15. */
export const QUARTER_PLACE_FOOTPRINT = 2.4;

export interface ClinicSlot {
  angle: number;
  radius: number;
  /** Distance from the Clinic's footprint to the nearest city, quarter place or campus place. */
  clearance: number;
}

/**
 * The Clinic's slot: the quarter's arc carried on past the end the campus didn't take first, then
 * past the campus's end (beyond the Hall), at the quarter's own spacing, trying the quarter's
 * radius and then pushed out. The first candidate that clears every neighbouring city, every
 * quarter place and both campus places by CAMPUS_MIN_CLEARANCE wins; else the roomiest. Pure and
 * deterministic, and the campus and the quarter are inputs, never moved.
 */
export function clinicSlot(harnessRadius: number, obstacles: readonly Obstacle[], campus: readonly Pick<CampusSlot, "id" | "angle" | "radius">[]): ClinicSlot {
  const quarter = quarterSlots(harnessRadius);
  const step = QUARTER_ARC / (PLACE_IDS.length - 1);
  const base = quarter[0]?.radius ?? 23;
  const disc = (angle: number, radius: number, r: number): Obstacle => ({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, r });
  const blockers: Obstacle[] = [
    ...obstacles,
    ...quarter.map((q) => disc(q.angle, q.radius, QUARTER_PLACE_FOOTPRINT)),
    ...campus.map((c) => disc(c.angle, c.radius, CAMPUS_FOOTPRINT[c.id])),
  ];
  const plus = { from: QUARTER_CENTER_ANGLE + QUARTER_ARC / 2, sign: 1 };
  const minus = { from: QUARTER_CENTER_ANGLE - QUARTER_ARC / 2, sign: -1 };
  const campusOnPlus = campus.length > 0 && campus.every((c) => c.angle > QUARTER_CENTER_ANGLE);
  const ends = campusOnPlus ? [minus, plus] : [plus, minus];
  let best: ClinicSlot | null = null;
  for (const end of ends) {
    for (const lift of [0, 4, 8]) {
      // Up to 8 steps out: past the campus's own end that reaches beyond the Hall (1.5 steps after the School).
      for (let k = 1.3; k <= 8.01; k += 0.5) {
        const radius = base + lift;
        const angle = end.from + end.sign * step * k;
        const clearance = clearanceAt(Math.cos(angle) * radius, Math.sin(angle) * radius, CLINIC_FOOTPRINT, blockers);
        if (clearance >= CAMPUS_MIN_CLEARANCE) return { angle, radius, clearance };
        if (!best || clearance > best.clearance) best = { angle, radius, clearance };
      }
    }
  }
  return best ?? { angle: plus.from + step * 1.3, radius: base, clearance: -Infinity };
}

export type ClinicLampState = "lit" | "dark" | "unknown";

export interface ClinicLamp {
  state: ClinicLampState;
  /** Sick sessions behind the lamp; null with no data. */
  sessions: number | null;
  /** One plain line: why the lamp is what it is. */
  why: string;
}

/** Lit while any case is sick (open, chronic or exposed: every such case puts its session in
 *  `sick`), dark when none is, unknown (grey) before the snapshot or the Clinic's list answered. */
export function clinicLamp(sick: readonly unknown[] | null): ClinicLamp {
  if (!sick) return { state: "unknown", sessions: null, why: "no data: the sickness list hasn't loaded" };
  if (sick.length === 0) return { state: "dark", sessions: 0, why: "no sick case" };
  return { state: "lit", sessions: sick.length, why: `${sick.length} sick session${sick.length === 1 ? "" : "s"}` };
}

/** At most this many marks: the server's own cap on sick agents in the snapshot. */
export const MAX_MARKS = SICKNESS_OPEN_CAP;

export interface HouseMark {
  agentId: string;
  /** chronic > open > exposed (the entry's worst case). */
  worst: SicknessState;
  kinds: SicknessKind[];
}

/**
 * One mark per sick session whose house stands on the planet now (`placed`), worst first, at most
 * `max`. A mark only where a case exists: no data (null) means no marks, never a guess. `unplaced`
 * counts sick sessions with no house (retired, pruned, or not in this world); `unshown` those past
 * `max`. A session listed twice (never, from openEntries) gets one mark.
 */
export function markSelection(sick: readonly SicknessOpenEntry[] | null, placed: (agentId: string) => boolean, max = MAX_MARKS): { marks: HouseMark[]; unplaced: number; unshown: number } {
  const marks: HouseMark[] = [];
  let unplaced = 0;
  let unshown = 0;
  const done = new Set<string>();
  const cap = Math.max(0, Math.floor(max));
  for (const e of sick ?? []) {
    if (done.has(e.agentId)) continue;
    done.add(e.agentId);
    if (!placed(e.agentId)) unplaced += 1;
    else if (marks.length >= cap) unshown += 1;
    else marks.push({ agentId: e.agentId, worst: e.worst, kinds: [...e.kinds] });
  }
  return { marks, unplaced, unshown };
}

// ---------------------------------------------------------------- the Graduates' Hall's banners

export const MAX_BANNERS = 12;

export interface BannerSlot {
  /** The worker's automationKey: every banner maps to one trusted worker. */
  key: string;
  /** Its display name (careers.json), or its key. */
  label: string;
  department: Department;
  index: number;
  /** Hall-local position (before the quarter's scale): +z is the Hall's front. */
  x: number;
  z: number;
}

/** Two rows of up to six banners in front of the Hall's steps. */
function bannerSpot(i: number): { x: number; z: number } {
  const row = Math.floor(i / 6);
  const col = i % 6;
  return { x: -1.75 + col * 0.7, z: 1.85 + row * 0.62 };
}

/**
 * One banner per TRUSTED worker (state "trusted": its last five runs were clean), oldest
 * graduate first, at most `max`. `unshown` counts trusted workers beyond `max`, so a card can say
 * so instead of pretending twelve is all of them. Anything else (probation, lapsed, retired,
 * returned…) never gets a banner, and no workers means no banners, never a placeholder.
 */
export function bannerSlots(
  workers: readonly Pick<CareerWorker, "key" | "name" | "state" | "department" | "trustedSince">[],
  max = MAX_BANNERS,
): { slots: BannerSlot[]; unshown: number } {
  const trusted = workers
    .filter((w) => w.state === "trusted")
    .sort((a, b) => {
      const ta = Date.parse(a.trustedSince ?? "");
      const tb = Date.parse(b.trustedSince ?? "");
      const byTime = (Number.isFinite(ta) ? ta : Infinity) - (Number.isFinite(tb) ? tb : Infinity);
      return Number.isNaN(byTime) || byTime === 0 ? a.key.localeCompare(b.key) : byTime;
    });
  const cap = Math.max(0, Math.floor(max));
  const slots = trusted.slice(0, cap).map((w, index) => ({ key: w.key, label: w.name ?? w.key, department: w.department, index, ...bannerSpot(index) }));
  return { slots, unshown: trusted.length - slots.length };
}

// ---------------------------------------------------------------- the School's lamp

/** The School is lit when the study pipeline wrote a skill draft within this many days. */
export const LAMP_FRESH_DAYS = 30;
const DAY_MS = 86_400_000;

export type LampState = "lit" | "dim" | "unknown";

export interface Lamp {
  state: LampState;
  lastDraftAt: string | null;
  /** Whole days since the last draft; null when there is none or it can't be dated. */
  days: number | null;
  /** One plain line: why the lamp is what it is. */
  why: string;
}

/**
 * From the Skills snapshot's institute block (institute-lib.ts): lit when the upskill autopilot
 * AUTHORED a draft in the last LAMP_FRESH_DAYS days, dim (the red lamp) when it hasn't or never
 * ran, unknown (grey) when the block is missing or its date is unreadable. A clean exit with no
 * draft never lights it: lastDraftAt is only set by an "AUTHORED" log line.
 */
export function lampState(institute: Pick<InstituteSnapshot, "study"> | null | undefined, nowMs: number): Lamp {
  if (!institute) return { state: "unknown", lastDraftAt: null, days: null, why: "no data: the Skills snapshot hasn't loaded" };
  const stats = institute.study.stats;
  if (!stats) return { state: "dim", lastDraftAt: null, days: null, why: "the study pipeline has never run (no autopilot.log)" };
  if (!stats.lastDraftAt) return { state: "dim", lastDraftAt: null, days: null, why: "the study pipeline has never written a draft" };
  const t = Date.parse(stats.lastDraftAt);
  if (!Number.isFinite(t)) return { state: "unknown", lastDraftAt: stats.lastDraftAt, days: null, why: "no data: the last draft's date is unreadable" };
  const days = Math.max(0, Math.floor((nowMs - t) / DAY_MS));
  const day = stats.lastDraftAt.slice(0, 10);
  if (nowMs - t <= LAMP_FRESH_DAYS * DAY_MS) return { state: "lit", lastDraftAt: stats.lastDraftAt, days, why: `last draft ${day} (${days} day${days === 1 ? "" : "s"} ago)` };
  return { state: "dim", lastDraftAt: stats.lastDraftAt, days, why: `no new draft since ${day} (${days} days)` };
}

// ---------------------------------------------------------------- the Hall's plaque

export const SHIPPED_WINDOW_DAYS = 7;

/** Sessions whose outcome is "shipped" (a PR gh reports MERGED) with their merge time at or after
 *  `sinceMs`. A shipped session with no readable evidence time is counted as `undated`, never
 *  guessed into the window. */
export function shippedSince(outcomes: readonly Pick<OutcomeSummary, "outcome" | "evidenceAt">[], sinceMs: number): { count: number; undated: number } {
  let count = 0;
  let undated = 0;
  for (const o of outcomes) {
    if (o.outcome !== "shipped") continue;
    const t = Date.parse(o.evidenceAt ?? "");
    if (!Number.isFinite(t)) undated += 1;
    else if (t >= sinceMs) count += 1;
  }
  return { count, undated };
}

// ---------------------------------------------------------------- campus inputs, validated (trust nothing parsed)

const STATS_NUMS = ["forksLaunched", "forksFailed", "forksOk", "noDraft", "permissionSkips", "thresholdSkips"] as const;
const STATS_DATES = ["lastRunAt", "lastSuccessAt", "lastDraftAt"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function parseStats(v: unknown): AutopilotStats | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  if (!STATS_NUMS.every((k) => typeof v[k] === "number") || !STATS_DATES.every((k) => isStrOrNull(v[k]))) return undefined;
  if (!(v.lastExitRc === null || typeof v.lastExitRc === "number") || !isStrOrNull(v.lastFailureLine)) return undefined;
  return v as unknown as AutopilotStats;
}

/** The institute block of GET /api/skills/snapshot, validated; null when it isn't that shape. */
export function parseInstituteBlock(v: unknown): { block: Pick<InstituteSnapshot, "study">; candidates: number } | null {
  if (!isRecord(v) || v.ok !== true || !isRecord(v.institute) || !isRecord(v.institute.study)) return null;
  const s = v.institute.study;
  const stats = parseStats(s.stats);
  if (stats === undefined || typeof s.line !== "string" || !(s.enabled === null || typeof s.enabled === "boolean") || typeof s.logPartial !== "boolean") return null;
  const study: StudyPipelineStatus = { line: s.line, enabled: s.enabled, stats, logPartial: s.logPartial };
  return { block: { study }, candidates: Array.isArray(v.candidates) ? v.candidates.length : 0 };
}

/** outcome + evidenceAt of each row of GET /api/outcomes; null when it isn't that shape. Rows that
 *  aren't valid are dropped. */
export function parseOutcomeDates(v: unknown): Pick<OutcomeSummary, "outcome" | "evidenceAt">[] | null {
  if (!isRecord(v) || v.ok !== true || !Array.isArray(v.outcomes)) return null;
  return v.outcomes.flatMap((o) => (isRecord(o) && isSessionOutcome(o.outcome) ? [{ outcome: o.outcome, evidenceAt: typeof o.evidenceAt === "string" ? o.evidenceAt : null }] : []));
}

// ---------------------------------------------------------------- AUTO lot callouts

/** An AUTO lot's callout name: "🎓 " in front when that automation is a trusted worker. The lot
 *  key and the worker key are both shared/display.ts automationKey, so they match exactly. */
export function lotCalloutName(key: string, trusted: ReadonlySet<string>, redacted: boolean): string {
  return `${trusted.has(key) ? "🎓 " : ""}${redacted ? "…" : key}`;
}

// ---------------------------------------------------------------- courier routes

/** A waypoint the 3D layer can resolve to a world point. "house"/"city"/"station" belong to the
 *  activity's agent; places are the quarter's structures. */
export type Waypoint = PlaceId | "house" | "city" | "station";

export type RouteKind = "prompt" | "tool" | "memory" | "think" | "permission" | "stop";
export const ROUTE_COLORS: Record<RouteKind, number> = {
  prompt: 0xff5aa5,
  tool: 0x3a86ff,
  memory: 0xa77bff,
  think: 0xffd23f,
  permission: 0xff3b3b,
  stop: 0x2ecc71,
};

export interface CourierRoute {
  kind: RouteKind;
  waypoints: Waypoint[];
  station: StationId;
}

export interface RouteContext {
  /** The agent's model (picks its power plant). */
  model: string | null;
  /** Gates that actually have scripts configured; an unconfigured gate is skipped, not drawn. */
  configured: ReadonlySet<GateEvent>;
}

function gate(event: GateEvent, rc: RouteContext): Waypoint[] {
  return rc.configured.has(event) ? [`gate:${event}`] : [];
}

function plant(rc: RouteContext): Waypoint[] {
  const f = modelFamilyOf(rc.model);
  return isPlantFamily(f) ? [`plant:${f}`] : [];
}

/**
 * The path one live activity line takes (the full path is a new prompt; later lines of the same
 * turn start at the model's plant, since the prompt has already been through the gate and Jev):
 *   stage "hook" (a new prompt): house → prompt gate → Jev tower → model plant → city → station
 *   a tool call:                 model plant → tool gate → city → station
 *   stage "brain" (memory read): model plant → semantic library → city → station
 *   reason / plan:               model plant → city → station
 */
export function courierRoute(a: Pick<AgentActivity, "stage" | "toolName">, rc: RouteContext): CourierRoute {
  const station = stationOfActivity(a);
  if (a.stage === "hook") return { kind: "prompt", station, waypoints: ["house", ...gate("UserPromptSubmit", rc), "jev", ...plant(rc), "city", "station"] };
  if (a.stage === "brain") return { kind: "memory", station, waypoints: [...plant(rc), "semantic", "city", "station"] };
  if (a.stage === "tool") return { kind: "tool", station, waypoints: [...plant(rc), ...gate("PreToolUse", rc), "city", "station"] };
  return { kind: "think", station, waypoints: [...plant(rc), "city", "station"] };
}

/** A permission request: the agent's station → the permission gate (which parks it for you). */
export function permissionRoute(rc: RouteContext): CourierRoute {
  return { kind: "permission", station: "hook", waypoints: ["station", "city", ...gate("PermissionRequest", rc)] };
}

/** A turn ended (working → waiting/idle): the agent's city → the Stop gate. */
export function stopRoute(rc: RouteContext): CourierRoute {
  return { kind: "stop", station: "hook", waypoints: ["house", "city", ...gate("Stop", rc)] };
}

/** Consecutive duplicates removed (e.g. house and city resolve to the same spot) and at least two
 *  points kept; null when there is nothing to travel. */
export function compactRoute<T>(points: readonly T[], same: (a: T, b: T) => boolean): T[] | null {
  const out: T[] = [];
  for (const p of points) if (out.length === 0 || !same(out[out.length - 1] as T, p)) out.push(p);
  return out.length >= 2 ? out : null;
}

/** Seconds for one leg by the angle it spans on the planet (short hops quick, long arcs capped). */
export function legSeconds(angleRad: number): number {
  if (!Number.isFinite(angleRad) || angleRad <= 0) return 0.3;
  return Math.min(1.4, 0.3 + angleRad * 1.6);
}

/** Concurrent couriers allowed by quality tier (0 high, 1 medium, 2 low); 0 with reduced motion
 *  (then nothing travels: the endpoints just pulse). */
export function courierCap(tier: 0 | 1 | 2, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return tier === 0 ? 48 : tier === 1 ? 24 : 10;
}

/** Fixed-size slot allocator for the pooled courier instances (no allocation after construction). */
export class SlotPool {
  private readonly busy: Uint8Array;
  private used = 0;
  constructor(readonly size: number) {
    this.busy = new Uint8Array(size);
  }
  /** First free slot below `limit` (the current tier's cap), or -1. */
  acquire(limit = this.size): number {
    const n = Math.min(limit, this.size);
    for (let i = 0; i < n; i++) {
      if (this.busy[i] === 0) {
        this.busy[i] = 1;
        this.used += 1;
        return i;
      }
    }
    return -1;
  }
  release(i: number): void {
    if (i < 0 || i >= this.size || this.busy[i] === 0) return;
    this.busy[i] = 0;
    this.used -= 1;
  }
  isBusy(i: number): boolean {
    return this.busy[i] === 1;
  }
  get active(): number {
    return this.used;
  }
}
