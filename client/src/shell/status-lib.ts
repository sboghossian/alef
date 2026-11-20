// Status bar + data drawer, the pure parts: which numbers it shows (from real store data)
// and the remembered drawer / sidebar state. DOM lives in shell/statusbar.ts.

import type { AgentActivity, WorldAgent, WorldEdge, WorldObject } from "../../../shared/types";
import type { MetricKey, MetricPoint, MetricSeries, MetricsRange } from "../../../shared/features/metrics";
import { formatTokens } from "../ui/fuzzy";
import type { FlagStore } from "../ui/kit";

export interface StatusNumbers {
  cities: number;
  agents: number;
  live: number;
  waiting: number;
  links: number;
  tokensToday: number | null;
  subagents: number;
  subagentsLive: number;
}

export interface DrawerNumbers {
  activeToday: number;
  sleeping: number;
  byKind: { files: number; skills: number; hooks: number; mcps: number };
  /** Busiest cities (awaiting, live, today). */
  topCities: { id: string; live: number; waiting: number; today: number }[];
  decisionsToday: number;
  lastLine: AgentActivity | null;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function statusNumbers(input: {
  cities: number;
  agents: readonly WorldAgent[];
  edges: readonly WorldEdge[];
  stats: { liveCount: number; awaitingCount: number; tokensToday: number | null };
  subagents: readonly { status: string }[];
}): StatusNumbers {
  return {
    cities: input.cities,
    agents: input.agents.length,
    live: input.stats.liveCount,
    waiting: input.stats.awaitingCount,
    links: input.edges.length,
    tokensToday: input.stats.tokensToday,
    subagents: input.subagents.length,
    subagentsLive: input.subagents.filter((s) => s.status === "running").length,
  };
}

export function drawerNumbers(input: {
  agents: readonly WorldAgent[];
  objects: readonly WorldObject[];
  decisionsAt: readonly string[];
  activities: readonly AgentActivity[];
  now?: number;
}): DrawerNumbers {
  const now = input.now ?? Date.now();
  const midnight = startOfDay(now);
  const byCity = new Map<string, { id: string; live: number; waiting: number; today: number }>();
  let activeToday = 0;
  let sleeping = 0;
  for (const a of input.agents) {
    const t = Date.parse(a.lastActive);
    const today = Number.isFinite(t) && t >= midnight;
    if (today) activeToday++;
    if (a.status !== "live" && !today) sleeping++;
    if (a.islandId === "harness") continue;
    const c = byCity.get(a.islandId) ?? { id: a.islandId, live: 0, waiting: 0, today: 0 };
    if (a.status === "live") c.live++;
    if (a.awaitingInput === true) c.waiting++;
    if (today) c.today++;
    byCity.set(a.islandId, c);
  }
  const byKind = { files: 0, skills: 0, hooks: 0, mcps: 0 };
  for (const o of input.objects) {
    if (o.kind === "file") byKind.files++;
    else if (o.kind === "skill") byKind.skills++;
    else if (o.kind === "hook") byKind.hooks++;
    else if (o.kind === "mcp") byKind.mcps++;
  }
  const topCities = [...byCity.values()]
    .filter((c) => c.live + c.waiting + c.today > 0)
    .sort((a, b) => b.waiting - a.waiting || b.live - a.live || b.today - a.today || (a.id < b.id ? -1 : 1))
    .slice(0, 5);
  const decisionsToday = input.decisionsAt.filter((at) => {
    const t = Date.parse(at);
    return Number.isFinite(t) && t >= midnight;
  }).length;
  const lastLine = input.activities.length ? input.activities[input.activities.length - 1]! : null;
  return { activeToday, sleeping, byKind, topCities, decisionsToday, lastLine };
}

// ---------------------------------------------------------------- remembered shell state

export const SHELL_KEY_PREFIX = "alef.shell.";

/** A remembered boolean (drawer open, sidebar expanded…). Blocked storage = the default, never throws. */
export class Remembered {
  private value: boolean;

  constructor(
    private readonly store: FlagStore | null,
    private readonly key: string,
    private readonly fallback: boolean,
  ) {
    this.value = fallback;
    try {
      const raw = store?.getItem(SHELL_KEY_PREFIX + key);
      if (raw === "1" || raw === "0") this.value = raw === "1";
    } catch {
      /* blocked storage: default */
    }
  }

  get(): boolean {
    return this.value;
  }

  set(v: boolean): void {
    this.value = v;
    try {
      this.store?.setItem(SHELL_KEY_PREFIX + this.key, v ? "1" : "0");
    } catch {
      /* private mode: not remembered */
    }
  }

  toggle(): boolean {
    this.set(!this.value);
    return this.value;
  }

  /** Back to the default and forget the choice. */
  reset(): void {
    this.set(this.fallback);
  }
}

// ---------------------------------------------------------------- metrics dock (Round 9)

/** One MetricPoint mapped onto an SVG viewport. */
export interface ScaledPoint {
  x: number;
  y: number;
  t: number;
  v: number;
}

/** Maps a series' points onto width×height, evenly spaced along x (the buckets are
 *  already evenly spaced in time, so spacing them evenly in pixels keeps the math simple
 *  and never fakes a "compressed" look while a still-filling ring buffer is short) and
 *  scaled to [padding, height - padding] on y against the series' own max (0 is always
 *  the floor: every metric here is a non-negative count/percentage/load average). */
export function scalePoints(points: readonly MetricPoint[], width: number, height: number, padding = 2): ScaledPoint[] {
  if (points.length === 0) return [];
  const max = Math.max(0, ...points.map((p) => p.v));
  const span = max > 0 ? max : 1; // an all-zero series still draws a flat line at the floor
  const usableW = Math.max(0, width - padding * 2);
  const usableH = Math.max(0, height - padding * 2);
  const step = points.length > 1 ? usableW / (points.length - 1) : 0;
  return points.map((p, i) => ({
    x: padding + i * step,
    y: padding + usableH - (p.v / span) * usableH,
    t: p.t,
    v: p.v,
  }));
}

/** Index of the scaled point nearest a given x (pointer position), for hover. -1 for an empty series. */
export function nearestPointIndex(scaled: readonly ScaledPoint[], x: number): number {
  if (scaled.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(scaled[0]!.x - x);
  for (let i = 1; i < scaled.length; i++) {
    const dist = Math.abs(scaled[i]!.x - x);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/** The last point's value, or null for an empty series (never fabricates a 0). */
export function seriesLatest(series: MetricSeries): number | null {
  const last = series.points[series.points.length - 1];
  return last ? last.v : null;
}

/** Human-readable value per metric, reusing the app's own compact token formatter
 *  (ui/fuzzy's formatTokens) instead of a second one for the tokens series. */
export function formatMetricValue(key: MetricKey, v: number): string {
  if (!Number.isFinite(v)) return "–";
  switch (key) {
    case "tokens":
      return formatTokens(v);
    case "costUsd":
      return `$${v.toFixed(v < 10 ? 2 : 1)}`;
    case "cpuLoad":
      return v.toFixed(2);
    case "memUsedPct":
      return `${Math.round(v)}%`;
    default:
      return String(Math.round(v));
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short clock time for a chart tooltip/axis; the 7d view also names the weekday, since
 *  "14:32" alone is ambiguous six days back. */
export function formatClockTime(t: number, range: MetricsRange): string {
  const d = new Date(t);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return range === "7d" ? `${WEEKDAYS[d.getDay()]} ${clock}` : clock;
}

export interface MetricMeta {
  icon: string;
  short: string;
  color: string;
}

/** Icon + label + a distinct chart color per metric, shared by the inline sparks and the
 *  chart panel so the same number always reads the same way. Colors echo the existing
 *  `.dot.live`/`.dot.awaiting` hues (style.css) where one already exists for that idea. */
export const METRIC_META: Record<MetricKey, MetricMeta> = {
  tokens: { icon: "🪙", short: "Tokens", color: "#c9960c" },
  costUsd: { icon: "💲", short: "Est. $", color: "#0b6e35" },
  liveAgents: { icon: "🟢", short: "Live", color: "#22d36b" },
  waitingAgents: { icon: "⏳", short: "Waiting", color: "#e0a800" },
  toolCalls: { icon: "🔧", short: "Tool calls", color: "#5b3fc4" },
  subagentsActive: { icon: "🛸", short: "Subagents", color: "#ff4d8d" },
  cpuLoad: { icon: "⚙️", short: "CPU", color: "#ff6b4a" },
  memUsedPct: { icon: "🧠", short: "Memory", color: "#2fa7c9" },
};

/** A remembered string choice (the open right tab). */
export function rememberedChoice<T extends string>(store: FlagStore | null, key: string, allowed: readonly T[], fallback: T): { get(): T; set(v: T): void } {
  let value = fallback;
  try {
    const raw = store?.getItem(SHELL_KEY_PREFIX + key);
    const hit = allowed.find((a) => a === raw);
    if (hit) value = hit;
  } catch {
    /* default */
  }
  return {
    get: () => value,
    set(v) {
      value = v;
      try {
        store?.setItem(SHELL_KEY_PREFIX + key, v);
      } catch {
        /* not remembered */
      }
    },
  };
}

// ── What sits in the bar, what waits in the drawer ──────────────────────────
// The bar keeps five things: live / waiting, cost today, health %, ⌘K search and "more". Every
// other readout and chip (cities, subagents, links, tokens, tool calls, CPU, memory, Jev, fps,
// help, weather, Claude FM, census, clinic…) sits in the drawer's tray, one click away, so a
// glance at the bar answers "is anything waiting, what has it cost, is Alef well" and nothing else.

export interface Readout {
  /** "bar": always on screen · "tray": the drawer's top row. */
  home: "bar" | "tray";
  title: string;
  /** Static markup: the number lands in its <b id>, the sparkline in its .sb-spark. */
  html: string;
  /** A readout you can press: "needs" opens Home at Needs you now (statusbar.ts wires it). */
  action?: "needs";
}

export const READOUTS: readonly Readout[] = [
  { home: "bar", title: "Agents running right now, out of every indexed session", html: `<i class="dot live"></i><b id="sb-live">…</b><span class="sb-word"> live</span> / <b id="sb-total">…</b><span class="sb-word"> agents</span><span class="sb-spark" data-mkey="liveAgents"></span>` },
  { home: "bar", action: "needs", title: "Agents waiting for your reply: open Needs you now on Home", html: `<i class="dot awaiting"></i><b id="sb-await">…</b><span class="sb-word"> waiting</span><span class="sb-spark" data-mkey="waitingAgents"></span>` },
  { home: "tray", title: "Cities: project folders you ran claude in", html: `🏙 <b id="sb-cities">…</b><span class="sb-word"> cities</span>` },
  { home: "tray", title: "Subagents: running now / indexed", html: `🛸 <b id="sb-subs">…</b><span class="sb-word"> subagents</span><span class="sb-spark" data-mkey="subagentsActive"></span>` },
  { home: "tray", title: "Links: who touched, used or visited what", html: `🔗 <b id="sb-links">…</b><span class="sb-word"> links</span>` },
  { home: "tray", title: "Tokens used by all sessions today", html: `🪙 <b id="sb-tokens">…</b><span class="sb-word"> tokens today</span><span class="sb-spark" data-mkey="tokens"></span>` },
  { home: "tray", title: "Tool calls in flight right now, across every live agent", html: `🔧 <b id="sb-toolcalls">…</b><span class="sb-word"> tool calls</span><span class="sb-spark" data-mkey="toolCalls"></span>` },
  { home: "tray", title: "Host CPU load (1-minute average)", html: `⚙️ <b id="sb-cpu">…</b><span class="sb-word"> cpu</span><span class="sb-spark" data-mkey="cpuLoad"></span>` },
  { home: "tray", title: "Host memory used", html: `🧠 <b id="sb-mem">…</b><span class="sb-word"> mem</span><span class="sb-spark" data-mkey="memUsedPct"></span>` },
  { home: "tray", title: "Jev, the director (the moon)", html: `<i id="sb-jev-dot" class="dot"></i><span class="sb-word">Jev </span><b id="sb-jev">…</b>` },
];

/** Feature status chips (shell.ts builds them as hud-f-<feature>-<id>) that stay in the bar: the
 *  one cost-today readout (usage) and the health score (completeness). Every other chip goes to
 *  the drawer's tray. */
export const BAR_CHIPS: readonly string[] = ["hud-f-usage-chip", "hud-f-completeness-chip"];

export function readoutsHtml(home: Readout["home"]): string {
  return READOUTS.filter((r) => r.home === home)
    .map((r) =>
      r.action
        ? `<button type="button" class="sb-item sb-btn sb-act" data-action="${r.action}" title="${r.title}">${r.html}</button>`
        : `<span class="sb-item" title="${r.title}">${r.html}</span>`,
    )
    .join("");
}

/** The drawer's chips that only show when something is wrong (HudButton.alert: low battery, the
 *  Clinic's "N sick"). Their alert words, for the ones showing now: any at all puts a dot on
 *  "more", so moving them off the bar (UX-8) never hides an alarm. */
export function trayAlerts(chips: readonly { hidden: boolean; alert: string }[]): string[] {
  return chips.filter((c) => !c.hidden).map((c) => c.alert);
}

/** "more"'s accessible name: the alerts behind it are said, not only drawn as a dot. */
export function moreLabel(alerts: readonly string[]): string {
  return alerts.length ? `More numbers (${alerts.join(", ")})` : "More numbers";
}
