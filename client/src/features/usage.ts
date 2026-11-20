// "usage" feature (Round 8 H1 + H5): a status-bar chip ("≈$X today · Yh") that opens a
// panel with the per-city breakdown for today and the last 7 days, plus a section in the
// agent details panel with that session's est. API-equivalent cost, tokens by type, model
// mix, and active time. Always "est." / "API-equivalent" — never "spend" or "bill".

import { USAGE_RANGES, type CityUsage, type ModelMixRow, type RangeModel, type SessionUsageResponse, type TokenBucket, type UsageDayResponse, type UsageRangeDays, type UsageRangeResponse } from "../../../shared/features/usage";
import { hourBars, mixSlices, peakHour, ringArcs } from "./usage-chart-lib";
import { formatHours, formatUsd, unpricedNote } from "./usage-format";
import { reconcileDistrictCost, SUBAGENT_COST_FOOTNOTE } from "./usage-lib";
import { h, isRecord, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import "./usage.css";

const CHIP_ID = "hud-f-usage-chip";
const PANEL_ID = "usage";
const AGENT_SLOT = "fx-usage";
const TODAY_POLL_MS = 60_000;

function isCityUsage(v: unknown): v is CityUsage {
  return isRecord(v) && typeof v.islandId === "string" && typeof v.name === "string" && typeof v.costUsd === "number" && typeof v.unpricedTokens === "number" && typeof v.activeMs === "number" && typeof v.sessions === "number";
}

function parseDayResponse(v: unknown): UsageDayResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.date !== "string" || typeof v.totalCostUsd !== "number" || typeof v.totalUnpricedTokens !== "number" || typeof v.totalActiveMs !== "number" || !Array.isArray(v.perCity)) return null;
  const perCity = v.perCity.filter(isCityUsage);
  return { ok: true, date: v.date, totalCostUsd: v.totalCostUsd, totalUnpricedTokens: v.totalUnpricedTokens, totalActiveMs: v.totalActiveMs, perCity };
}

function isRangeModel(v: unknown): v is RangeModel {
  return isRecord(v) && typeof v.model === "string" && (v.costUsd === null || typeof v.costUsd === "number") && typeof v.tokens === "number" && typeof v.unpricedTokens === "number";
}

export function parseRangeResponse(v: unknown): UsageRangeResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.days !== "number" || !(USAGE_RANGES as readonly number[]).includes(v.days)) return null;
  if (typeof v.from !== "string" || typeof v.to !== "string" || typeof v.totalCostUsd !== "number" || typeof v.totalUnpricedTokens !== "number" || typeof v.totalActiveMs !== "number") return null;
  if (!Array.isArray(v.perCity) || !Array.isArray(v.models) || !Array.isArray(v.byHour)) return null;
  const byHour = v.byHour.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0));
  return { ok: true, days: v.days as UsageRangeDays, from: v.from, to: v.to, totalCostUsd: v.totalCostUsd, totalUnpricedTokens: v.totalUnpricedTokens, totalActiveMs: v.totalActiveMs, perCity: v.perCity.filter(isCityUsage), models: v.models.filter(isRangeModel), byHour };
}

function isTokenBucket(v: unknown): v is TokenBucket {
  return isRecord(v) && typeof v.inputTokens === "number" && typeof v.outputTokens === "number" && typeof v.cacheWrite5mTokens === "number" && typeof v.cacheWrite1hTokens === "number" && typeof v.cacheReadTokens === "number";
}

function isModelMixRow(v: unknown): v is ModelMixRow {
  return isRecord(v) && typeof v.model === "string" && isTokenBucket(v.tokens) && (v.costUsd === null || typeof v.costUsd === "number") && typeof v.unpricedTokens === "number";
}

function parseSessionResponse(v: unknown): SessionUsageResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.agentId !== "string" || typeof v.totalCostUsd !== "number" || typeof v.totalUnpricedTokens !== "number" || typeof v.activeMs !== "number" || !Array.isArray(v.models)) return null;
  return {
    ok: true,
    agentId: v.agentId,
    islandId: typeof v.islandId === "string" ? v.islandId : null,
    totalCostUsd: v.totalCostUsd,
    totalUnpricedTokens: v.totalUnpricedTokens,
    activeMs: v.activeMs,
    models: v.models.filter(isModelMixRow),
  };
}

/** "YYYY-MM-DD" for `daysAgo` days before today, in the viewer's local timezone (matches
 *  the server's localDateKey, which also uses local getFullYear/Month/Date). Exported so
 *  other features (the District view) key off exactly the same "today" this feature's own
 *  chip uses — the per-district cost/day-boundary invariant depends on that. */
export function localDateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let chipEl: HTMLElement | null = null;

function paintChip(costUsd: number, activeMs: number): void {
  if (!chipEl) chipEl = document.getElementById(CHIP_ID);
  if (chipEl) chipEl.textContent = `${formatUsd(costUsd)} today · ${formatHours(activeMs)}`;
}

async function fetchDay(ctx: ClientContext, date: string): Promise<UsageDayResponse | null> {
  return parseDayResponse(await ctx.api.getJson<unknown>(`/api/usage/day?date=${encodeURIComponent(date)}`));
}

/** The latest "today" response from this feature's own 60s poll, shared so other features
 *  (the District view's list rows and "Today here" card) don't run a second poll against
 *  the same endpoint. Null until the first poll resolves. */
let todayCache: UsageDayResponse | null = null;
const todayWatchers = new Set<() => void>();

export function usageToday(): UsageDayResponse | null {
  return todayCache;
}

/** Fires after every successful poll (including the first). Returns an unsubscribe fn. */
export function onUsageToday(cb: () => void): () => void {
  todayWatchers.add(cb);
  return () => todayWatchers.delete(cb);
}

function cityRow(c: CityUsage): HTMLElement {
  const li = h("li", "usage-city-row");
  li.append(h("span", "usage-city-name", c.name), h("span", "usage-city-cost", formatUsd(c.costUsd)), h("span", "usage-city-time", formatHours(c.activeMs)));
  if (c.unpricedTokens > 0) li.append(h("span", "usage-city-note", unpricedNote(c.unpricedTokens)));
  return li;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Model-mix doughnut + legend (weighted by est. cost). */
function mixChart(models: readonly RangeModel[], totalCostUsd: number): HTMLElement {
  const wrap = h("div", "usage-mix");
  const slices = mixSlices(models);
  if (slices.length === 0) return h("p", "usage-empty", "No model usage in this range.");
  const chart = svg("svg", { viewBox: "0 0 100 100", width: "104", height: "104", role: "img", "aria-label": "Model mix by est. cost" });
  for (const a of ringArcs(slices, 50, 50, 46)) {
    const path = svg("path", { d: a.d, fill: a.color, "fill-rule": "evenodd" });
    path.append(svg("title", {}));
    (path.firstChild as SVGTitleElement).textContent = `${a.label} · ${(a.share * 100).toFixed(1)}%`;
    chart.append(path);
  }
  const mid = svg("text", { x: "50", y: "54", "text-anchor": "middle", class: "usage-mix-total" });
  mid.textContent = formatUsd(totalCostUsd);
  chart.append(mid);
  const legend = h("ul", "usage-mix-legend");
  for (const s of slices) {
    const li = h("li", "usage-mix-row");
    const dot = h("span", "usage-dot");
    dot.style.background = s.color;
    li.append(dot, h("span", "usage-mix-name", s.label), h("span", "usage-mix-pct", `${(s.share * 100).toFixed(s.share < 0.1 ? 1 : 0)}%`));
    legend.append(li);
  }
  wrap.append(chart, legend);
  return wrap;
}

/** 24 bars of active time per local clock hour. */
function hourChart(byHour: readonly number[]): HTMLElement {
  const bars = hourBars(byHour);
  const peak = peakHour(bars);
  const wrap = h("div", "usage-hours");
  if (!peak) {
    wrap.append(h("p", "usage-empty", "No activity recorded in this range."));
    return wrap;
  }
  const W = 240;
  const H = 56;
  const slot = W / 24;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H + 12}`, width: "100%", class: "usage-hours-svg", role: "img", "aria-label": "Active time by hour of day" });
  for (const b of bars) {
    const bh = b.ms > 0 ? Math.max(2, b.frac * H) : 1;
    const r = svg("rect", { x: (b.hour * slot + 1).toFixed(1), y: (H - bh).toFixed(1), width: (slot - 2).toFixed(1), height: bh.toFixed(1), rx: "1.5", class: b.hour === peak.hour ? "usage-bar is-peak" : "usage-bar" });
    r.append(svg("title", {}));
    (r.firstChild as SVGTitleElement).textContent = `${b.label}: ${formatHours(b.ms)} active`;
    chart.append(r);
  }
  for (const hr of [0, 6, 12, 18, 23]) {
    const t = svg("text", { x: (hr * slot + slot / 2).toFixed(1), y: String(H + 10), "text-anchor": "middle", class: "usage-axis" });
    t.textContent = String(hr);
    chart.append(t);
  }
  wrap.append(chart, h("p", "usage-note", `Busiest hour: ${peak.label} (${formatHours(peak.ms)} in this range). Hours are this machine's local time.`));
  return wrap;
}

let rangeDays: UsageRangeDays = 7;

function rangeToggle(el: HTMLElement, ctx: ClientContext): HTMLElement {
  const row = h("div", "usage-range");
  for (const d of USAGE_RANGES) {
    const b = h("button", d === rangeDays ? "usage-range-btn is-on" : "usage-range-btn", `${d} d`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(d === rangeDays));
    b.addEventListener("click", () => {
      if (d === rangeDays) return;
      rangeDays = d;
      void renderPanel(el, ctx);
    });
    row.append(b);
  }
  return row;
}

async function renderPanel(el: HTMLElement, ctx: ClientContext): Promise<void> {
  el.replaceChildren(h("p", "usage-loading", "Loading…"));
  const [today, range] = await Promise.all([fetchDay(ctx, localDateKeyDaysAgo(0)), ctx.api.getJson<unknown>(`/api/usage/range?days=${rangeDays}`).then(parseRangeResponse)]);
  if (!today && !range) {
    el.replaceChildren(h("p", "usage-empty", "No usage data yet."));
    return;
  }
  const frag = document.createDocumentFragment();
  if (today) {
    frag.append(h("h4", "usage-h", `Today · ${formatUsd(today.totalCostUsd)} · ${formatHours(today.totalActiveMs)}`));
    const todayList = h("ul", "usage-list");
    if (today.perCity.length === 0) todayList.append(h("li", "usage-empty", "Nothing yet today."));
    else for (const c of today.perCity) todayList.append(cityRow(c));
    frag.append(todayList);
    if (today.totalUnpricedTokens > 0) frag.append(h("p", "usage-note", `${unpricedNote(today.totalUnpricedTokens)} today (model not in the price table).`));
    // Reconciliation for the District view's per-district cost: every row above is either a
    // real district or falls in here — never both, never neither (usage-lib.ts).
    const { unattributedCostUsd } = reconcileDistrictCost(today.perCity, new Set(ctx.store.islands.keys()));
    if (unattributedCostUsd > 0) frag.append(h("p", "usage-note", `${formatUsd(unattributedCostUsd)} today isn't tied to a district yet (not one of the world's current cities).`));
    frag.append(h("p", "usage-note", SUBAGENT_COST_FOOTNOTE));
  }
  frag.append(rangeToggle(el, ctx));
  if (!range) frag.append(h("p", "usage-empty", "The range view couldn't be read."));
  else {
    frag.append(h("h4", "usage-h", `Last ${range.days} days · ${formatUsd(range.totalCostUsd)} · ${formatHours(range.totalActiveMs)}`));
    frag.append(h("h5", "usage-sub", "Model mix (est. cost)"), mixChart(range.models, range.totalCostUsd));
    if (range.totalUnpricedTokens > 0) frag.append(h("p", "usage-note", `${unpricedNote(range.totalUnpricedTokens)} (model not in the price table, left out of the doughnut).`));
    frag.append(h("h5", "usage-sub", "Activity by hour"), hourChart(range.byHour));
    frag.append(h("h5", "usage-sub", "By city"));
    const list = h("ul", "usage-list");
    if (range.perCity.length === 0) list.append(h("li", "usage-empty", "Nothing yet."));
    else for (const c of range.perCity) list.append(cityRow(c));
    frag.append(list);
  }
  el.replaceChildren(frag);
}

function tokenLine(label: string, n: number): HTMLElement | null {
  if (n <= 0) return null;
  const li = h("li", "usage-token-row");
  li.append(h("span", undefined, label), h("span", "usage-token-count", n.toLocaleString()));
  return li;
}

function renderAgentSection(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren(h("p", "usage-loading", "Loading…"));
  void ctx.api.getJson<unknown>(`/api/usage/session/${encodeURIComponent(agentId)}`).then((raw) => {
    const usage = parseSessionResponse(raw);
    if (!usage || (usage.models.length === 0 && usage.activeMs === 0)) {
      slot.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    frag.append(h("h3", "usage-head", `Usage (est.) · ${formatUsd(usage.totalCostUsd)} · ${formatHours(usage.activeMs)} active`));
    for (const m of usage.models) {
      const row = h("div", "usage-model-row");
      row.append(h("span", "usage-model-name", m.model), h("span", "usage-model-cost", m.costUsd === null ? "unpriced" : formatUsd(m.costUsd)));
      const tokens = h("ul", "usage-token-list");
      for (const line of [tokenLine("in", m.tokens.inputTokens), tokenLine("out", m.tokens.outputTokens), tokenLine("cache write (5m)", m.tokens.cacheWrite5mTokens), tokenLine("cache write (1h)", m.tokens.cacheWrite1hTokens), tokenLine("cache read", m.tokens.cacheReadTokens)]) {
        if (line) tokens.append(line);
      }
      row.append(tokens);
      frag.append(row);
    }
    if (usage.totalUnpricedTokens > 0) frag.append(h("p", "usage-note", unpricedNote(usage.totalUnpricedTokens)));
    slot.replaceChildren(frag);
  });
}

export const usageFeature: ClientFeature = {
  id: "usage",
  mount(ctx) {
    chipEl = document.getElementById(CHIP_ID);
    watchAgentPanel(AGENT_SLOT, (id, slot) => renderAgentSection(id, slot, ctx));
    const poll = (): void => {
      void fetchDay(ctx, localDateKeyDaysAgo(0)).then((day) => {
        if (!day) return;
        paintChip(day.totalCostUsd, day.totalActiveMs);
        todayCache = day;
        for (const cb of todayWatchers) cb();
      });
    };
    poll();
    setInterval(poll, TODAY_POLL_MS);
  },
  onSnapshot(world) {
    const extra = world.extras?.["usage.today"];
    if (isRecord(extra) && typeof extra.costUsd === "number" && typeof extra.activeMs === "number") paintChip(extra.costUsd, extra.activeMs);
  },
  hudButtons: [
    {
      id: "chip",
      label: "≈$0.00 today · 0h",
      title: "Est. API-equivalent cost and active time today (click for the breakdown)",
      placement: "status",
      onClick: (ctx) => ctx.openPanel(PANEL_ID),
    },
  ],
  panels: [
    {
      id: PANEL_ID,
      title: "Usage (est.)",
      render(el, ctx) {
        void renderPanel(el, ctx);
      },
    },
  ],
};
