// The status bar's chart panel (Round 9 build item 4 — "ALL data graphs in the bottom
// bar"): fetches GET /api/metrics and renders one small zero-dep inline-SVG chart per
// series (area for a 30s-sampled gauge, bars for the day-bucketed tokens/est. $), with a
// 1h/24h/7d switch and a hover tooltip (value + time). Mounted inside the existing
// #alef-drawer by statusbar.ts, which also renders the tiny always-on sparkline next to
// each sb-item using `microSparkSvg` here. Pure scaling/formatting lives in
// shell/status-lib.ts (tested); this file is the DOM/SVG-building glue, not unit-tested
// itself — same split as filters-ui.ts/views.ts elsewhere in shell/.
//
// microSparkSvg is a local twin of filters-ui.ts's sparkSvg(): same 34×12 viewBox and
// line style, but colored per metric. filters-ui.ts's version isn't exported and that
// file isn't one this builder owns or was handed as a hub line (shared build's
// builder-rules: edit only your own files + the named hub lines), so this is a small,
// deliberate duplication rather than an out-of-scope edit — flagged in the build report.

import { isMetricsRange, METRICS_RANGES, type MetricPoint, type MetricSeries, type MetricsRange, type MetricsResponse } from "../../../shared/features/metrics";
import { getJson } from "../api";
import { escapeHtml } from "../ui/fuzzy";
import type { FlagStore } from "../ui/kit";
import { formatClockTime, formatMetricValue, METRIC_META, nearestPointIndex, rememberedChoice, scalePoints, type ScaledPoint } from "./status-lib";

const POLL_MS = 30_000;
const SPARK_W = 34;
const SPARK_H = 12;
const CHART_W = 136;
const CHART_H = 42;
const CHART_PAD = 4;

/** Small inline sparkline for one sb-item (34×12, matching filters-ui.ts's sparkSvg look). */
export function microSparkSvg(points: readonly MetricPoint[], color: string): string {
  if (points.length < 2) return "";
  const scaled = scalePoints(points, SPARK_W, SPARK_H, 1);
  const pts = scaled.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return `<svg class="sb-spark-svg" viewBox="0 0 ${SPARK_W} ${SPARK_H}" width="${SPARK_W}" height="${SPARK_H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function chartBody(series: MetricSeries, scaled: readonly ScaledPoint[]): string {
  if (scaled.length === 0) return "";
  const floor = CHART_H - CHART_PAD;
  if (series.kind === "bar") {
    // One equal slot per bar inside the padding (not centred on the line points, whose first and
    // last sit on the edges: with 2 day-grain points each bar hung half outside the card).
    const slot = (CHART_W - CHART_PAD * 2) / scaled.length;
    const barW = Math.max(3, Math.min(slot * 0.6, 28));
    return scaled
      .map((p, i) => `<rect class="mchart-bar" x="${(CHART_PAD + slot * (i + 0.5) - barW / 2).toFixed(1)}" y="${p.y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, floor - p.y).toFixed(1)}" rx="2" />`)
      .join("");
  }
  const first = scaled[0] as ScaledPoint;
  const last = scaled[scaled.length - 1] as ScaledPoint;
  const line = scaled.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L");
  const area = `M${first.x.toFixed(1)},${floor} L${line} L${last.x.toFixed(1)},${floor} Z`;
  return `<path class="mchart-area" d="${area}" /><polyline class="mchart-line" points="${scaled.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" />`;
}

function renderCard(series: MetricSeries, range: MetricsRange): HTMLElement {
  const meta = METRIC_META[series.key];
  const scaled = scalePoints(series.points, CHART_W, CHART_H, CHART_PAD);
  const latest = series.points[series.points.length - 1];
  const card = document.createElement("div");
  card.className = "mchart-card";
  card.style.setProperty("--mchart-color", meta.color);
  card.innerHTML = `
    <div class="mchart-head">
      <span class="mchart-ico" aria-hidden="true">${meta.icon}</span>
      <span class="mchart-label">${escapeHtml(meta.short)}</span>
      <span class="mchart-value">${latest ? escapeHtml(formatMetricValue(series.key, latest.v)) : "…"}</span>
    </div>
    <div class="mchart-svg-wrap">
      <svg class="mchart-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" width="${CHART_W}" height="${CHART_H}">
        ${chartBody(series, scaled)}
        <g class="mchart-hover" hidden><line x1="0" y1="${CHART_PAD}" x2="0" y2="${CHART_H - CHART_PAD}" /><circle r="2.6" cx="0" cy="0" /></g>
      </svg>
      <div class="mchart-tip" hidden></div>
    </div>`;
  if (scaled.length > 1) wireHover(card, series, scaled, range);
  return card;
}

function wireHover(card: HTMLElement, series: MetricSeries, scaled: readonly ScaledPoint[], range: MetricsRange): void {
  const svg = card.querySelector<SVGSVGElement>(".mchart-svg");
  const hoverG = card.querySelector<SVGGElement>(".mchart-hover");
  const hoverLine = hoverG?.querySelector("line");
  const hoverDot = hoverG?.querySelector("circle");
  const tip = card.querySelector<HTMLElement>(".mchart-tip");
  if (!svg || !hoverG || !hoverLine || !hoverDot || !tip) return;
  const move = (clientX: number): void => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((clientX - rect.left) / rect.width) * CHART_W;
    const idx = nearestPointIndex(scaled, x);
    if (idx < 0) return;
    const p = scaled[idx] as ScaledPoint;
    hoverLine.setAttribute("x1", String(p.x));
    hoverLine.setAttribute("x2", String(p.x));
    hoverDot.setAttribute("cx", String(p.x));
    hoverDot.setAttribute("cy", String(p.y));
    hoverG.removeAttribute("hidden");
    tip.hidden = false;
    tip.textContent = `${formatMetricValue(series.key, p.v)} · ${formatClockTime(p.t, range)}`;
    tip.style.left = `${Math.min(88, Math.max(0, (p.x / CHART_W) * 100))}%`;
  };
  svg.addEventListener("pointermove", (ev) => move(ev.clientX));
  svg.addEventListener("pointerleave", () => {
    hoverG.setAttribute("hidden", "");
    tip.hidden = true;
  });
}

export interface MetricsPanelApi {
  /** Refreshes immediately, then polls every 30s until stop() — call when the panel becomes visible. */
  start(): void;
  /** Stops polling without clearing what's rendered — call when the panel is hidden. */
  stop(): void;
}

/** Builds the chart-row panel once into `host` (a plain div inside #alef-drawer) and
 *  returns start/stop so the caller only pays for polling while the drawer is open. */
export function mountMetricsPanel(host: HTMLElement, flagStore: FlagStore | null): MetricsPanelApi {
  const rangeChoice = rememberedChoice(flagStore, "metricsRange", METRICS_RANGES, "1h");
  let timer: ReturnType<typeof setInterval> | null = null;

  host.className = "mchart-panel";
  host.innerHTML = `
    <div class="mchart-panel-head">
      <h3>Live metrics</h3>
      <div class="mchart-range" role="group" aria-label="Time range"></div>
    </div>
    <div class="mchart-grid"><p class="mchart-none">Loading…</p></div>`;
  const rangeBox = host.querySelector<HTMLElement>(".mchart-range");
  const grid = host.querySelector<HTMLElement>(".mchart-grid");

  function renderRangeButtons(): void {
    if (!rangeBox) return;
    rangeBox.innerHTML = METRICS_RANGES.map(
      (r) => `<button type="button" data-range="${r}" class="${r === rangeChoice.get() ? "on" : ""}" aria-pressed="${r === rangeChoice.get()}">${r}</button>`,
    ).join("");
    for (const b of rangeBox.querySelectorAll<HTMLButtonElement>("button")) {
      b.addEventListener("click", () => {
        const r = b.dataset.range;
        if (!r || !isMetricsRange(r) || r === rangeChoice.get()) return;
        rangeChoice.set(r);
        renderRangeButtons();
        void refresh();
      });
    }
  }
  renderRangeButtons();

  async function refresh(): Promise<void> {
    if (!grid) return;
    const range = rangeChoice.get();
    const res = await getJson<MetricsResponse>(`/api/metrics?range=${range}`, 10_000);
    if (rangeChoice.get() !== range) return; // the user switched range mid-flight
    if (!res || !res.ok) {
      grid.innerHTML = `<p class="mchart-none">Metrics unavailable.</p>`;
      return;
    }
    grid.replaceChildren(...res.series.map((s) => renderCard(s, range)));
  }

  return {
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
