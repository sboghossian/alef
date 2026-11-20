// The campus's live data (agent-city piece 7): the one place the School, the Graduates' Hall and
// the AUTO lot callouts read their numbers from. No THREE, no DOM, no renderer: it runs the same
// with WebGL on, off (the 2D-only boot) or lost, so the Explain cards still work from the palette.
//
//   careers    GET /api/careers        which workers are trusted (banners, 🎓 callouts)
//   institute  GET /api/skills/snapshot the study pipeline's block (the School's lamp)
//   shipped    GET /api/outcomes       sessions shipped in the last 7 days (the Hall's plaque)
//
// Fetched on change, never per frame: once at mount, again when the careers summary moves (WS via
// careers.ts, or a snapshot extra), when the outcomes map moves (outcomes.ts), when a campus card
// opens (throttled), plus a slow backstop while the page is visible. GET /api/careers recomputes
// on every call (it scans live processes), so it is never polled fast, and when the Tower panel is
// open it re-reads the workers itself and hands the answer over (offerCareers): one push, one GET.
// A push that lands while the same source is in flight is re-run once that fetch ends.
// Every response is validated before use; a failed fetch keeps the last good data, and data that
// never arrived stays null so the cards say "no data" instead of 0.

import { parseCareersResponse, parseCareersSummary, CAREERS_SUMMARY_KEY, type CareersResponse } from "../../../shared/features/careers";
import type { InstituteSnapshot } from "../../../shared/features/skills";
import type { WorldSnapshot } from "../../../shared/types";
import { log } from "../log";
import { onOutcomes } from "./outcomes";
import type { ClientContext } from "./registry";
import { SHIPPED_WINDOW_DAYS, bannerSlots, lampState, parseInstituteBlock, parseOutcomeDates, shippedSince, type BannerSlot, type Lamp } from "./system-places-lib";

export type CampusSource = "careers" | "institute" | "shipped";

export interface CampusData {
  careers: CareersResponse | null;
  /** The Skills snapshot's institute block and its candidate queue length. */
  institute: { block: Pick<InstituteSnapshot, "study">; candidates: number } | null;
  /** Shipped sessions dated inside the last SHIPPED_WINDOW_DAYS days, as of `at`. */
  shipped: { count: number; undated: number; at: number } | null;
}

const PATHS: Record<CampusSource, string> = { careers: "/api/careers", institute: "/api/skills/snapshot", shipped: "/api/outcomes" };
const TIMEOUT_MS: Record<CampusSource, number> = { careers: 15_000, institute: 15_000, shipped: 15_000 };
/** The outcomes map is pushed on every change: its dates are re-read at most this often (trailing). */
const SHIPPED_MIN_GAP_MS = 60_000;
/** A backstop, not the trigger: careers and outcomes arrive by push; the institute block has none. */
const BACKSTOP_MS: Record<CampusSource, number> = { careers: 15 * 60_000, institute: 30 * 60_000, shipped: 30 * 60_000 };
const DAY_MS = 86_400_000;

let data: CampusData = { careers: null, institute: null, shipped: null };
let trusted: ReadonlySet<string> = new Set();
const inFlight = new Set<CampusSource>();
/** Pushes that arrived while their source was in flight: re-run when it lands. */
const again = new Set<CampusSource>();
const lastAsked = new Map<CampusSource, number>();
const listeners = new Set<() => void>();
let ctxRef: ClientContext | null = null;
let summaryJson: string | null = null;
let outcomesTimer: ReturnType<typeof setTimeout> | null = null;
let backstop: ReturnType<typeof setInterval> | null = null;
const unsubscribe: Array<() => void> = [];

export function campusData(): Readonly<CampusData> {
  return data;
}

/** What the campus shows, computed from the data on every call (never a cached copy, so a card and
 *  the 3D quarter can't disagree whichever change listener runs first). `banners` is null until
 *  /api/careers answered: no data, not zero banners. */
export function campusView(nowMs = Date.now()): { lamp: Lamp; banners: { slots: BannerSlot[]; unshown: number } | null } {
  return { lamp: lampState(data.institute?.block ?? null, nowMs), banners: data.careers ? bannerSlots(data.careers.workers) : null };
}

/** automationKeys of the workers whose state is "trusted" (empty until /api/careers loads). */
export function trustedWorkerKeys(): ReadonlySet<string> {
  return trusted;
}

export function onCampusChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function changed(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      log.warn("campus", "a listener threw", String(err));
    }
  }
}

// ---------------------------------------------------------------- fetching

function apply(source: CampusSource, raw: unknown, nowMs: number): boolean {
  if (source === "careers") {
    const c = parseCareersResponse(raw);
    if (!c) return false;
    data = { ...data, careers: c };
    trusted = new Set(c.workers.filter((w) => w.state === "trusted").map((w) => w.key));
    return true;
  }
  if (source === "institute") {
    const i = parseInstituteBlock(raw);
    if (!i) return false;
    data = { ...data, institute: i };
    return true;
  }
  const rows = parseOutcomeDates(raw);
  if (!rows) return false;
  data = { ...data, shipped: { ...shippedSince(rows, nowMs - SHIPPED_WINDOW_DAYS * DAY_MS), at: nowMs } };
  return true;
}

/** Re-reads one source unless it is in flight or was asked less than `minGapMs` ago. */
export function refreshCampus(source: CampusSource, minGapMs = 0): void {
  const ctx = ctxRef;
  if (!ctx) return;
  if (inFlight.has(source)) {
    // The answer on its way may predate this push: ask again once it lands (a throttled read,
    // minGapMs > 0, is only a freshness check and never queues).
    if (minGapMs === 0) again.add(source);
    return;
  }
  const now = Date.now();
  if (now - (lastAsked.get(source) ?? -Infinity) < minGapMs) return;
  lastAsked.set(source, now);
  inFlight.add(source);
  void ctx.api
    .getJson<unknown>(PATHS[source], TIMEOUT_MS[source])
    .then((raw) => {
      if (raw !== null && apply(source, raw, Date.now())) changed();
      else log.warn("campus", `${PATHS[source]}: no usable answer; keeping the last data`);
    })
    .finally(() => {
      inFlight.delete(source);
      if (again.delete(source)) refreshCampus(source);
    });
}

/** careers.ts: the server's careers summary moved and the Tower panel isn't re-reading it. */
export function careersMoved(): void {
  refreshCampus("careers");
}

/** careers.ts: the Tower panel's own GET /api/careers answer, so a push costs one server scan. */
export function offerCareers(raw: unknown): void {
  if (raw === null || !apply("careers", raw, Date.now())) return;
  lastAsked.set("careers", Date.now());
  changed();
}

/** A careers summary from a snapshot extra: re-read the workers when it moved. */
function onSummary(v: unknown): void {
  const s = parseCareersSummary(v);
  if (!s) return;
  const json = JSON.stringify(s);
  if (json === summaryJson) return;
  const first = summaryJson === null;
  summaryJson = json;
  if (!first) refreshCampus("careers");
}

/** Once, from system-places' mount (whether or not WebGL is drawing). */
export function startCampusData(ctx: ClientContext): void {
  if (ctxRef) return;
  ctxRef = ctx;
  for (const s of ["careers", "institute", "shipped"] as const) refreshCampus(s);
  unsubscribe.push(onOutcomes(() => {
    // The map is pushed whole on every change; its dates live in GET /api/outcomes. Coalesce, and
    // re-read at most once a minute, always after the latest push (a trailing call: none is lost).
    if (outcomesTimer) return;
    const wait = Math.max(5000, (lastAsked.get("shipped") ?? -Infinity) + SHIPPED_MIN_GAP_MS - Date.now());
    outcomesTimer = setTimeout(() => {
      outcomesTimer = null;
      refreshCampus("shipped");
    }, wait);
  }));
  backstop = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    for (const s of ["careers", "institute", "shipped"] as const) refreshCampus(s, BACKSTOP_MS[s]);
  }, 5 * 60_000);
}

/** From system-places' onSnapshot (page load and every WS reconnect). */
export function campusSnapshot(world: WorldSnapshot): void {
  onSummary(world.extras?.[CAREERS_SUMMARY_KEY]);
}

/** Tests only: back to the boot state. */
export function resetCampusDataForTest(): void {
  for (const off of unsubscribe.splice(0)) off();
  if (backstop) clearInterval(backstop);
  if (outcomesTimer) clearTimeout(outcomesTimer);
  backstop = null;
  outcomesTimer = null;
  data = { careers: null, institute: null, shipped: null };
  trusted = new Set();
  inFlight.clear();
  again.clear();
  lastAsked.clear();
  listeners.clear();
  ctxRef = null;
  summaryJson = null;
}
