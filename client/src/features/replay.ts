// Day replay + daily report: a HUD pill opens a panel with a date picker, a GitHub-style
// hour heatmap (click an hour to seek), play/pause + speed 1x-60x, a "REPLAY HH:MM" badge
// while playing, and a comic-newspaper "Today's report" card. Visual playback reuses the
// existing comic-burst overlay via ctx.labels — there's no ctx hook into main.ts's private
// activityQueue/car-driving pipeline, so this is the closest a feature can get to it
// without touching the hub (see docs/FEATURES.md); it never fakes an event, only replays
// real ones fetched from GET /api/replay.

import type { ReplayEvent, ReplayResponse } from "../../../shared/features/replay";
import { escapeHtml, formatTokens } from "../ui/fuzzy";
import type { ClientContext, ClientFeature } from "./registry";
import { bucketByHour, heatIntensity, localDateKey, replayLoadState, replayStatusText } from "./replay-lib";

const SPEEDS = [1, 5, 10, 30, 60];
const MAX_BURSTS_PER_FRAME = 4;

let panelEl: HTMLElement | null = null;
let badgeEl: HTMLDivElement | null = null;
let badgeText: HTMLElement | null = null;
let currentDate = localDateKey(new Date());
let currentResponse: ReplayResponse | null = null;
let loading = false;
let playing = false;
let speed = 10;
let playIndex = 0;
let playStartElapsed = 0;
let playStartEventMs = 0;

function dayStartMs(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

async function loadDate(date: string, ctx: ClientContext): Promise<void> {
  currentDate = date;
  playing = false;
  playIndex = 0;
  loading = true;
  if (panelEl) renderPanel(panelEl, ctx);
  const res = await ctx.api.getJson<ReplayResponse>(`/api/replay?date=${encodeURIComponent(date)}`);
  loading = false;
  currentResponse = res;
  if (panelEl) renderPanel(panelEl, ctx);
  const r = res?.ok ? res.report : null;
  if (r && r.events > 0) {
    // The daily report card also lands in the Feed (a "report" item, deduped per date).
    const top = r.perCity.slice().sort((a, b) => b.events - a.events)[0];
    ctx.feed.push({
      id: `report:daily:${r.date}`,
      kind: "report",
      at: Date.now(),
      title: `Daily report ${r.date}: ${r.sessions} sessions, ${r.events} events, ${formatTokens(r.tokens)} tokens`,
      detail: top ? `Busiest: ${top.name} (${top.events} events)` : undefined,
      cityId: top?.islandId,
    });
  }
}

function seekToHour(hour: number): void {
  const events = currentResponse?.events ?? [];
  const targetMs = dayStartMs(currentDate) + hour * 3600_000;
  const idx = events.findIndex((e) => Date.parse(e.at) >= targetMs);
  playIndex = idx === -1 ? events.length : idx;
  const anchor = events[playIndex] ?? events[events.length - 1];
  playStartEventMs = anchor ? Date.parse(anchor.at) : targetMs;
}

function fireEvent(e: ReplayEvent, ctx: ClientContext): void {
  const anchor = ctx.agentPosition(e.agentId) ?? ctx.cityPosition(e.islandId);
  if (!anchor) return;
  const icon = e.stage === "plan" ? "📋" : e.stage === "brain" ? "🧠" : e.stage === "hook" ? "💬" : e.stage === "reason" ? "💭" : "⚙";
  ctx.labels.burst(icon, anchor);
}

function renderHeatmap(events: readonly { at: string }[]): string {
  const buckets = bucketByHour(events);
  const max = Math.max(...buckets, 0);
  return `<div class="replay-heatmap">${buckets
    .map((count, h) => {
      const intensity = heatIntensity(count, max);
      return `<button type="button" class="replay-hour" data-hour="${h}" title="${h}:00 — ${count} events" style="--i:${intensity}"></button>`;
    })
    .join("")}</div>`;
}

function renderReport(res: ReplayResponse | null): string {
  if (!res) return "";
  const r = res.report;
  const rows = (items: { name: string; count: number }[]): string =>
    items.length ? items.map((i) => `<li>${escapeHtml(i.name)} <b>${i.count}</b></li>`).join("") : "<li>—</li>";
  return `<div class="replay-report">
    <h3>THE DAILY AGENT</h3>
    <p class="replay-report-date">${r.date}${res.truncated ? " · showing a sample of the day" : ""}</p>
    <div class="replay-report-stats">
      <span><b>${r.sessions}</b> sessions</span>
      <span><b>${r.events}</b> events</span>
      <span><b>${r.tokens}</b> tokens</span>
    </div>
    <div class="replay-report-cols">
      <div><h4>Top files</h4><ul>${rows(r.topFiles)}</ul></div>
      <div><h4>Top tools</h4><ul>${rows(r.topTools)}</ul></div>
      <div><h4>Top skills</h4><ul>${rows(r.topSkills)}</ul></div>
    </div>
    <div class="replay-report-cities"><h4>By city</h4><ul>${
      r.perCity.length ? r.perCity.map((c) => `<li>${escapeHtml(c.name)} <b>${c.events}</b> events, ${c.sessions} sessions</li>`).join("") : "<li>—</li>"
    }</ul></div>
  </div>`;
}

function renderPanel(el: HTMLElement, ctx: ClientContext): void {
  panelEl = el;
  const events = currentResponse?.events ?? [];
  const loadState = replayLoadState(loading, currentDate, currentResponse);
  el.innerHTML = `
    <div class="replay-controls">
      <input type="date" id="replay-date" value="${currentDate}" max="${localDateKey(new Date())}" />
      <button type="button" id="replay-load" class="comic-btn small">Load</button>
    </div>
    ${renderHeatmap(events)}
    <div class="replay-playback">
      <button type="button" id="replay-play" class="comic-btn small">${playing ? "⏸ Pause" : "▶ Play"}</button>
      <select id="replay-speed" aria-label="Playback speed">${SPEEDS.map((s) => `<option value="${s}" ${s === speed ? "selected" : ""}>${s}x</option>`).join("")}</select>
      <span class="replay-status">${escapeHtml(replayStatusText(loadState))}</span>
      ${loadState.kind === "error" ? `<button type="button" id="replay-retry" class="comic-btn small">Retry</button>` : ""}
    </div>
    ${renderReport(currentResponse)}
  `;
  el.querySelector<HTMLInputElement>("#replay-date")?.addEventListener("change", (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (v) void loadDate(v, ctx);
  });
  el.querySelector<HTMLButtonElement>("#replay-load")?.addEventListener("click", () => void loadDate(currentDate, ctx));
  el.querySelector<HTMLButtonElement>("#replay-retry")?.addEventListener("click", () => void loadDate(currentDate, ctx));
  el.querySelector<HTMLButtonElement>("#replay-play")?.addEventListener("click", () => {
    playing = !playing;
    if (playing) {
      playStartElapsed = ctx.elapsed();
      const anchor = events[playIndex] ?? events[0];
      playStartEventMs = anchor ? Date.parse(anchor.at) : dayStartMs(currentDate);
      if (!badgeEl) return;
      badgeEl.hidden = false;
    } else if (badgeEl) {
      badgeEl.hidden = true;
    }
    renderPanel(el, ctx);
  });
  el.querySelector<HTMLSelectElement>("#replay-speed")?.addEventListener("change", (ev) => {
    speed = Number((ev.target as HTMLSelectElement).value) || 10;
  });
  el.querySelectorAll<HTMLButtonElement>(".replay-hour").forEach((btn) => {
    btn.addEventListener("click", () => {
      seekToHour(Number(btn.dataset.hour));
      playStartElapsed = ctx.elapsed();
    });
  });
}

export const replayFeature: ClientFeature = {
  id: "replay",
  mount(ctx) {
    badgeEl = document.createElement("div");
    badgeEl.className = "replay-badge";
    badgeEl.id = "replay-badge";
    badgeEl.hidden = true;
    // Text in its own span: the collapse chevron (main.ts) is a sibling that must survive rewrites.
    badgeText = document.createElement("span");
    badgeEl.append(badgeText);
    document.body.append(badgeEl);
    void loadDate(currentDate, ctx); // pre-fetch today's report so the panel opens instantly
  },
  onFrame(_dt, ctx) {
    if (!playing || !currentResponse) return;
    const events = currentResponse.events;
    const virtualNow = playStartEventMs + (ctx.elapsed() - playStartElapsed) * 1000 * speed;
    let fired = 0;
    while (playIndex < events.length && Date.parse(events[playIndex]!.at) <= virtualNow && fired < MAX_BURSTS_PER_FRAME) {
      fireEvent(events[playIndex]!, ctx);
      playIndex += 1;
      fired += 1;
    }
    if (badgeText) badgeText.textContent = `REPLAY ${new Date(virtualNow).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (playIndex >= events.length) {
      playing = false;
      if (badgeEl) badgeEl.hidden = true;
      if (panelEl) renderPanel(panelEl, ctx);
    }
  },
  hudButtons: [{ id: "open", label: "⏪", title: "Day replay & report", text: "Replay today & daily report", onClick: (ctx) => ctx.openPanel("replay") }],
  panels: [{ id: "replay", title: "Day replay & report", render: renderPanel }],
};
