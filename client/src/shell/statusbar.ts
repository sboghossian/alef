// Bottom status bar (UX-8): live / waiting (waiting opens Home's Needs you now), cost today + health % chips, ⌘K and "more". The
// rest of the old data dock (cities, subagents, links, tokens, tool calls, CPU, memory, Jev,
// fps, help, weather + Claude FM + census + clinic chips) is the drawer's top tray. Every numeric item that a live metrics series backs
// gets a tiny inline sparkline (own 30s poll of GET /api/metrics?range=1h, independent of
// the store refresh below, so it keeps ticking even when nothing else changes). The
// drawer is now the chart panel (dock-charts.ts): a row of small area/bar charts with a
// 1h/24h/7d switch, sitting above the original numbers-by-section drill-down, which is
// unchanged and still lives in its own scrollable block below the charts.
// Numbers come from shell/status-lib.ts (pure, tested).

import type { MetricsResponse } from "../../../shared/features/metrics";
import type { WorldStore } from "../state";
import { getJson } from "../api";
import { subagentData } from "../features/subagent-data";
import { escapeHtml, formatTokens, relativeTime } from "../ui/fuzzy";
import { safeLocalStorage } from "../ui/kit";
import { cityDisplayName } from "../ui/world";
import { microSparkSvg, mountMetricsPanel } from "./dock-charts";
import { BAR_CHIPS, formatMetricValue, METRIC_META, Remembered, drawerNumbers, moreLabel, readoutsHtml, statusNumbers, trayAlerts } from "./status-lib";
import { agentTitle } from "../../../shared/display";

const METRICS_POLL_MS = 30_000;

export interface StatusBarApi {
  frame(dt: number): void;
  refresh(): void;
  setDrawer(open: boolean): void;
}

export function mountStatusBar(
  bar: HTMLElement,
  drawer: HTMLElement,
  store: WorldStore,
  actions: { search(): void; help(): void; needs(): void; pickAgent(id: string): void; pickCity(id: string): void; talkSessions(): number },
): StatusBarApi {
  const open = new Remembered(safeLocalStorage(), "drawer", false);
  const chips = bar.querySelector<HTMLElement>("#sb-chips");
  bar.setAttribute("role", "contentinfo");
  bar.setAttribute("aria-label", "Status");
  bar.replaceChildren();
  // The bar: live / waiting, cost today + health % (the BAR_CHIPS), ⌘K, more. Everything else
  // sits in the drawer's tray (status-lib.ts READOUTS), still one click away.
  const left = document.createElement("div");
  left.className = "sb-readouts";
  left.innerHTML = readoutsHtml("bar");
  left.querySelector<HTMLElement>('[data-action="needs"]')?.addEventListener("click", actions.needs);
  const right = document.createElement("div");
  right.className = "sb-tools";
  const keep = document.createElement("span");
  keep.id = "sb-keep";
  keep.setAttribute("role", "group");
  keep.setAttribute("aria-label", "Cost and health");
  for (const id of BAR_CHIPS) {
    const chip = chips?.querySelector<HTMLElement>(`#${id}`);
    if (chip) keep.append(chip);
  }
  const cmd = document.createElement("button");
  cmd.type = "button";
  cmd.className = "sb-item sb-btn";
  cmd.id = "sb-cmd";
  cmd.title = "Search everything or run a command (⌘K)";
  cmd.innerHTML = `<kbd>⌘K</kbd><span class="sb-word"> search</span>`;
  cmd.addEventListener("click", actions.search);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "sb-item sb-btn sb-more";
  more.id = "sb-drawer-btn";
  more.setAttribute("aria-label", "More numbers");
  more.setAttribute("aria-controls", drawer.id);
  more.addEventListener("click", () => setDrawer(!open.get()));
  right.append(keep, cmd, more);
  bar.append(left, right);

  // An alert chip (low battery, "N sick") sits in the drawer now, so while one shows, "more"
  // carries a dot and says it: the alarm stays visible at a glance.
  const syncAlertDot = (): void => {
    const alerts = trayAlerts([...(chips?.querySelectorAll<HTMLElement>("[data-alert]") ?? [])].map((c) => ({ hidden: c.hidden !== false, alert: c.dataset.alert ?? "" })));
    more.classList.toggle("sb-alert", alerts.length > 0);
    more.setAttribute("aria-label", moreLabel(alerts));
  };
  if (chips) new MutationObserver(syncAlertDot).observe(chips, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  syncAlertDot();

  // The drawer's tray: the readouts and chips that left the bar.
  const tray = document.createElement("div");
  tray.className = "alef-drawer-tray";
  tray.setAttribute("role", "group");
  tray.setAttribute("aria-label", "Readouts and controls");
  tray.innerHTML = readoutsHtml("tray");
  const fps = document.createElement("span");
  fps.className = "sb-item sb-fps";
  fps.id = "sb-fps";
  fps.title = "Frames per second";
  const help = document.createElement("button");
  help.type = "button";
  help.className = "sb-item sb-btn";
  help.id = "sb-help";
  help.title = "Map legend and shortcuts (?)";
  help.innerHTML = `<kbd>?</kbd><span class="sb-word"> help</span>`;
  help.addEventListener("click", actions.help);
  tray.append(fps, help);
  if (chips) tray.append(chips);

  drawer.setAttribute("role", "region");
  drawer.setAttribute("aria-label", "More numbers");
  drawer.addEventListener("click", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null;
    const agent = t?.closest<HTMLElement>("[data-agent]")?.dataset.agent;
    const city = t?.closest<HTMLElement>("[data-city]")?.dataset.city;
    if (agent) actions.pickAgent(agent);
    else if (city) actions.pickCity(city);
  });

  // The drawer now holds two stacked blocks: the chart panel (mounted once, never
  // torn down by renderDrawer's re-render below) and the original numbers-by-section
  // drill-down (unchanged, just retargeted from `drawer` to its own child).
  drawer.replaceChildren();
  const metricsHost = document.createElement("div");
  const sections = document.createElement("div");
  sections.className = "alef-drawer-sections";
  drawer.append(tray, metricsHost, sections);
  const metricsPanel = mountMetricsPanel(metricsHost, safeLocalStorage());

  const set = (id: string, text: string): void => {
    const n = document.getElementById(id);
    if (n) n.textContent = text;
  };

  const sparkEls = new Map<string, HTMLElement>();
  for (const el of [...left.querySelectorAll<HTMLElement>(".sb-spark"), ...tray.querySelectorAll<HTMLElement>(".sb-spark")]) {
    const key = el.dataset.mkey;
    if (key) sparkEls.set(key, el);
  }
  const SPARK_TAIL = 14;

  function applyMetrics(res: MetricsResponse): void {
    for (const series of res.series) {
      const spark = sparkEls.get(series.key);
      if (spark) spark.innerHTML = microSparkSvg(series.points.slice(-SPARK_TAIL), METRIC_META[series.key].color);
      const latest = series.points[series.points.length - 1];
      if (latest === undefined) continue;
      const text = formatMetricValue(series.key, latest.v);
      if (series.key === "toolCalls") set("sb-toolcalls", text);
      else if (series.key === "cpuLoad") set("sb-cpu", text);
      else if (series.key === "memUsedPct") set("sb-mem", text);
    }
  }

  async function loadMetrics(): Promise<void> {
    const res = await getJson<MetricsResponse>("/api/metrics?range=1h", 10_000);
    if (res && res.ok) applyMetrics(res);
  }
  void loadMetrics();
  setInterval(() => void loadMetrics(), METRICS_POLL_MS);

  function refresh(): void {
    const agents = [...store.agents.values()];
    const subs = [...subagentData.records.values()];
    const n = statusNumbers({ cities: store.islands.size, agents, edges: store.edges, stats: store.effectiveStats(), subagents: subs });
    set("sb-cities", String(n.cities));
    set("sb-live", String(n.live));
    set("sb-total", String(n.agents));
    set("sb-subs", n.subagentsLive ? `${n.subagentsLive}/${n.subagents}` : String(n.subagents));
    set("sb-links", n.links >= 1000 ? formatTokens(n.links) : String(n.links));
    set("sb-tokens", n.tokensToday === null ? "n/a" : formatTokens(n.tokensToday));
    set("sb-await", String(n.waiting));
    set("sb-jev", store.jev.status);
    const dot = document.getElementById("sb-jev-dot");
    if (dot) dot.className = `dot ${store.jev.status}`;
    if (!drawer.hidden) renderDrawer();
  }

  function renderDrawer(): void {
    const d = drawerNumbers({
      agents: [...store.agents.values()],
      objects: [...store.objects.values()],
      decisionsAt: store.jev.decisions.map((x) => x.at),
      activities: store.activities,
    });
    const stats = store.effectiveStats();
    const subs = [...subagentData.records.values()];
    const cityName = (id: string): string => {
      const i = store.islands.get(id);
      return i ? cityDisplayName(i) : id;
    };
    const line = d.lastLine;
    const who = line ? store.agents.get(line.agentId) : undefined;
    sections.innerHTML = `
      <section><h3>Agents</h3><dl>
        <dt>live now</dt><dd>${stats.liveCount}</dd>
        <dt>waiting on you</dt><dd>${stats.awaitingCount}</dd>
        <dt>active today</dt><dd>${d.activeToday}</dd>
        <dt>sleeping</dt><dd>${d.sleeping}</dd>
        <dt>tmux you can talk to</dt><dd>${actions.talkSessions()}</dd>
      </dl></section>
      <section><h3>Subagents</h3><dl>
        <dt>running</dt><dd>${subs.filter((s) => s.status === "running").length}</dd>
        <dt>done</dt><dd>${subs.filter((s) => s.status === "done").length}</dd>
        <dt>failed</dt><dd>${subs.filter((s) => s.status === "failed").length}</dd>
        <dt>stopped</dt><dd>${subs.filter((s) => s.status === "stopped").length}</dd>
        <dt>indexed (7 days)</dt><dd>${subs.length}</dd>
      </dl></section>
      <section><h3>Buildings</h3><dl>
        <dt>files</dt><dd>${d.byKind.files}</dd><dt>skills</dt><dd>${d.byKind.skills}</dd>
        <dt>hooks</dt><dd>${d.byKind.hooks}</dd><dt>MCP servers</dt><dd>${d.byKind.mcps}</dd>
        <dt>links</dt><dd>${store.edges.length}</dd>
      </dl></section>
      <section><h3>Busiest districts</h3>${
        d.topCities.length
          ? `<ul class="sb-top">${d.topCities
              .map((c) => `<li><button type="button" data-city="${escapeHtml(c.id)}"><span>${escapeHtml(cityName(c.id))}</span><span class="sb-top-n">${[c.waiting ? `${c.waiting} waiting` : "", c.live ? `${c.live} live` : "", c.today ? `${c.today} today` : ""].filter(Boolean).join(" · ")}</span></button></li>`)
              .join("")}</ul>`
          : `<p class="sb-none">Nothing ran today yet.</p>`
      }</section>
      <section><h3>Jev</h3><dl><dt>status</dt><dd>${escapeHtml(store.jev.status)}</dd><dt>results today</dt><dd>${d.decisionsToday}</dd>
        <dt>last tick</dt><dd>${store.jev.lastTickAt ? escapeHtml(relativeTime(store.jev.lastTickAt)) : "never"}</dd></dl></section>
      <section class="sb-latest"><h3>Latest line</h3>${
        line
          ? `<button type="button" data-agent="${escapeHtml(line.agentId)}"><i class="stage-dot ${escapeHtml(line.stage)}"></i><span>${escapeHtml(line.summary)}</span><span class="sb-none">${escapeHtml(who ? agentTitle(who) : "")} · ${escapeHtml(relativeTime(line.at))}</span></button>`
          : `<p class="sb-none">No live activity yet.</p>`
      }</section>`;
  }

  function setDrawer(on: boolean): void {
    open.set(on);
    drawer.hidden = !on;
    more.setAttribute("aria-expanded", String(on));
    more.innerHTML = `<span aria-hidden="true">${on ? "▾" : "▴"}</span><span class="sb-word"> ${on ? "less" : "more"}</span>`;
    more.title = on ? "Hide the data drawer" : "More numbers: open the data drawer";
    if (on) {
      renderDrawer();
      metricsPanel.start();
    } else {
      metricsPanel.stop();
    }
  }

  store.onAgents(refresh);
  store.onStats(refresh);
  store.onDecision(refresh);
  store.onSnapshot(refresh);
  store.onEdges(refresh);
  store.onActivity(() => {
    if (!drawer.hidden) renderDrawer();
  });
  subagentData.onChange(refresh);
  setDrawer(open.get());
  refresh();

  let frames = 0;
  let acc = 0;
  return {
    frame(dt) {
      frames++;
      acc += dt;
      if (acc >= 1) {
        fps.textContent = `${Math.round(frames / acc)} fps`;
        frames = 0;
        acc = 0;
      }
    },
    refresh,
    setDrawer,
  };
}
