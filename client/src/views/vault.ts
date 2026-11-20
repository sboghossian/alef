// 🗄️ Vault: ten ways to read Alex's Obsidian vault, ported from the "Alex's Brain"
// artifact into the Mind group. One view, fourteen sub-sections picked from the left sidebar
// (#/vault/<section>), because they share one data source and one visual language — the Brain view
// next door already owns the graph, the notes and the search, so none of that is repeated here.
//
//   Pulse          a year of days, and which folders filled them
//   Growth         how the vault got this big, and when it passes the next round number
//   Focus          what had your attention, week by week
//   Meetings       how much of the week goes to meetings, and when they land
//   Projects       every project by umbrella, newest first, with the quiet ones called out
//   Constellation  projects as a network, tied by the notes their sessions share
//   Topics         tag families, what is rising, what has gone quiet
//   Hubs           which notes hold everything together, and which hubs are siloed
//   People         who you actually see, against who you once did
//   Sources        which tool captured what, and where it landed
//   Atlas          folders as a treemap you can walk into
//   Flows          a chord of links between areas (or umbrellas)
//   Echoes         well-linked notes nothing has touched in months, and this day in earlier years
//   Gaps           orphans, notes you linked to but never wrote, duplicates, untyped
//
// Data: GET /api/vault/<section>, aggregated server-side (shared/features/vault.ts). Sections load
// lazily on first open and are kept for the session, so switching back is free. Paths, tags, names
// and project slugs are untrusted vault text: textContent only, never innerHTML.

import type {
  VaultAtlasResponse,
  VaultConstellationResponse,
  VaultEchoesResponse,
  VaultFlowsMode,
  VaultFlowsResponse,
  VaultFocusResponse,
  VaultGapsResponse,
  VaultGrowthResponse,
  VaultHubsResponse,
  VaultMeetingsResponse,
  VaultMeta,
  VaultMetaResponse,
  VaultNoteRef,
  VaultNotesQuery,
  VaultNotesResponse,
  VaultPeopleResponse,
  VaultProjectsResponse,
  VaultPulseResponse,
  VaultSourcesResponse,
  VaultTopicsResponse,
} from "../../../shared/features/vault";
import { vaultGhostFixPrompt, vaultProjectFixPrompt } from "../../../shared/features/fixes";
import { formatRoute, type AlefView, type ViewContext } from "../shell/views";
import { draftFixButton, draftFixFromQueue, type DraftFix } from "../ui/draft-fix";
import { baseName, folderColor, obsidianUrl } from "./brain-lib";
import { fetchResult } from "./code-api";
import {
  arcBand,
  area,
  band,
  bands,
  bars,
  calendar,
  chord,
  delta,
  DOW,
  grid,
  feedStamp,
  int,
  monthLabels,
  pct,
  scatter,
  share,
  since,
  spark,
  stream,
  treemap,
} from "./vault-lib";
import { lightMindTab, mindFrame, mindTabs } from "./mind-tabs";
import { viewState } from "../shell/view-state";
import "./vault.css";

const SVG = "http://www.w3.org/2000/svg";

interface SectionDef {
  id: string;
  emoji: string;
  label: string;
  hint: string;
}

/** The sidebar order, which is also the reading order: when, then what, then who, then what is missing. */
const SECTIONS: readonly SectionDef[] = [
  { id: "pulse", emoji: "📅", label: "Pulse", hint: "A year of days, and which folders filled them" },
  { id: "growth", emoji: "📈", label: "Growth", hint: "How the vault got this big, and when it passes the next round number" },
  { id: "focus", emoji: "🎯", label: "Focus", hint: "What had your attention, week by week" },
  { id: "meetings", emoji: "🗣️", label: "Meetings", hint: "How much of the week goes to meetings, and when they land" },
  { id: "projects", emoji: "📁", label: "Projects", hint: "Every project by umbrella, with the quiet ones called out" },
  { id: "constellation", emoji: "✨", label: "Constellation", hint: "Which projects are related, by the notes they share" },
  { id: "topics", emoji: "🏷️", label: "Topics", hint: "Tag families, what is rising, what has gone quiet" },
  { id: "hubs", emoji: "🪨", label: "Hubs", hint: "Which notes hold everything together" },
  { id: "people", emoji: "👥", label: "People", hint: "Who you actually see, against who you once did" },
  { id: "sources", emoji: "🔌", label: "Sources", hint: "Which tool captured what, and where it landed" },
  { id: "atlas", emoji: "🗺️", label: "Folders", hint: "Where your notes live: folders by size, click to step inside" },
  { id: "flows", emoji: "🔀", label: "Flows", hint: "How areas of the vault link to each other" },
  { id: "echoes", emoji: "🔮", label: "Echoes", hint: "Notes nothing has touched in months, and this day in earlier years" },
  { id: "gaps", emoji: "🕳️", label: "Gaps", hint: "Orphans, notes you linked to but never wrote, duplicates, untyped" },
];

const DEFAULT_SECTION = "pulse";
const isSection = (id: string): boolean => SECTIONS.some((s) => s.id === id);

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let body: HTMLElement | null = null;
let active = DEFAULT_SECTION;
let meta: VaultMeta | null = null;
/** section id -> its payload, or the error that came back. Kept across remounts. */
const loaded = new Map<string, unknown>();
const failed = new Map<string, string>();
/** Echoes is reseeded by its own button, so it carries a seed rather than being cached once. */
let echoSeed: number | null = null;
/** Atlas: the folder being looked at, and whether its loose notes are opened out. */
let atlasPath: string[] = [];
let atlasLoose = false;
/** Flows: folders or umbrellas, and the group picked (an index into its names). */
let flowsMode: VaultFlowsMode = "folders";
let flowsPick: number | null = null;
/** Atlas folders and Flows modes already fetched, by URL, so stepping back is instant. */
const variants = new Map<string, unknown>();
/** The artifact's tab bar across the top: every section one click away, sidebar open or not. */
let tabBar: HTMLElement | null = null;

// ---------------------------------------------------------------- tiny DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** A titled block. Everything a section draws goes in one of these. */
function card(title: string, hint?: string): { root: HTMLElement; body: HTMLElement } {
  const r = el("section", "vv-card");
  const head = el("header", "vv-card-head");
  head.append(el("h3", "vv-card-title", title));
  if (hint) head.append(el("p", "vv-card-hint", hint));
  const b = el("div", "vv-card-body");
  r.append(head, b);
  return { root: r, body: b };
}

/** The row of big numbers every section opens with. */
function stats(items: readonly { label: string; value: string; meta?: string; dir?: string }[]): HTMLElement {
  const r = el("div", "vv-stats");
  for (const it of items) {
    const tile = el("div", "vv-stat");
    tile.append(el("div", "vv-stat-value", it.value));
    tile.append(el("div", "vv-stat-label", it.label));
    if (it.meta) {
      const m = el("div", "vv-stat-meta", it.meta);
      if (it.dir) m.dataset.dir = it.dir;
      tile.append(m);
    }
    r.append(tile);
  }
  return r;
}

/** A chart box. The viewBox is the chart's own coordinate space; CSS gives it its real size. */
function chart(w: number, h: number, cls: string, label: string): SVGSVGElement {
  const svg = s("svg", { class: `vv-chart ${cls}`, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", role: "img", "aria-label": label });
  return svg;
}

/** Series colours come from the stylesheet, so a palette change is one file. */
const seriesClass = (i: number): string => `vv-s${i % 9}`;

function legend(keys: readonly string[], onPick?: (key: string) => void): HTMLElement {
  const r = el("ul", "vv-legend");
  keys.forEach((key, i) => {
    const li = el("li", "vv-legend-item");
    li.append(el("i", `vv-swatch ${seriesClass(i)}`));
    // Notes at the vault root have no top-level folder; say so instead of an empty label.
    const label = key === "" ? "Vault root" : key;
    if (onPick) {
      const b = el("button", "vv-legend-label", label);
      b.type = "button";
      b.addEventListener("click", () => onPick(key));
      li.append(b);
    } else {
      li.append(el("span", "vv-legend-label", label));
    }
    r.append(li);
  });
  return r;
}

/** A horizontal bar list: the shape Topics, Projects and Gaps all want. `unit` is a word, or
 *  [singular, plural] where a count of 1 would otherwise read "1 notes". */
function barList(rows: readonly { key: string; n: number; meta?: string; onPick?: () => void; action?: HTMLElement }[], unit: string | readonly [string, string]): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const list = el("ul", "vv-bars");
  for (const row of rows) {
    const li = el("li", "vv-bar-row");
    const label = row.onPick ? el("button", "vv-bar-label", row.key) : el("span", "vv-bar-label", row.key);
    if (row.onPick && label instanceof HTMLButtonElement) {
      label.type = "button";
      label.addEventListener("click", row.onPick);
    }
    const track = el("div", "vv-bar-track");
    const fill = el("div", "vv-bar-fill");
    // Width is the one thing a bar cannot get from a stylesheet; a CSS custom property keeps it
    // out of the style attribute the chrome tests forbid.
    fill.style.setProperty("--vv-bar", `${((row.n / max) * 100).toFixed(1)}%`);
    track.append(fill);
    li.append(label, track, el("span", "vv-bar-n", `${int(row.n)} ${typeof unit === "string" ? unit : unit[row.n === 1 ? 0 : 1]}`));
    if (row.meta) li.append(el("span", "vv-bar-meta", row.meta));
    if (row.action) li.append(row.action);
    list.append(li);
  }
  return list;
}

/** Note rows. A click opens the note in Obsidian, which is where you actually edit. */
function noteRows(notes: readonly VaultNoteRef[]): HTMLElement {
  const list = el("ul", "vv-notes");
  for (const n of notes) {
    const li = el("li", "vv-note");
    const a = el("a", "vv-note-link");
    a.href = obsidianUrl(n.path);
    a.textContent = n.name;
    a.title = n.path;
    const dot = el("i", "vv-note-dot");
    dot.style.setProperty("--vv-dot", folderColor(n.folder));
    li.append(dot, a);
    li.append(el("span", "vv-note-meta", [n.folder, n.day ?? "undated", `${int(n.links)} links`].filter(Boolean).join(" · ")));
    list.append(li);
  }
  return list;
}

/** A drill-down: ask the server for the notes behind whatever was clicked. */
async function drill(host: HTMLElement, query: VaultNotesQuery, title: string): Promise<void> {
  host.replaceChildren(el("p", "vv-loading", `Reading ${title}…`));
  const url = `/api/vault/notes?${encodeURIComponent(query.kind)}=${encodeURIComponent(query.value)}`;
  const r = await fetchResult<VaultNotesResponse>(url);
  if (!r.ok) return void host.replaceChildren(el("p", "vv-error", r.error));
  const { root: box, body: b } = card(title, `${int(r.data.total)} note${r.data.total === 1 ? "" : "s"}${r.data.truncated ? `, showing the first ${r.data.notes.length}` : ""}`);
  b.append(noteRows(r.data.notes));
  host.replaceChildren(box);
}

/** Every section gets one of these for its drill-downs; a second click replaces the first. */
function drillHost(): HTMLElement {
  return el("div", "vv-drill");
}

// ---------------------------------------------------------------- the first ten sections

function renderPulse(host: HTMLElement, d: VaultPulseResponse): void {
  const p = d.pulse;
  const today = Math.floor(Date.now() / 86_400_000);
  const counts = new Map<number, number>();
  for (const day of p.days) counts.set(Math.floor(Date.parse(`${day.day}T00:00:00Z`) / 86_400_000), day.n);
  const dd = delta(p.last7, p.prev7);
  host.append(
    stats([
      { label: "notes this week", value: int(p.last7), meta: `${dd.text} on the week before`, dir: dd.dir },
      { label: "active days in 30", value: `${p.activeDays30}/30` },
      { label: "day streak", value: int(p.streak), meta: `longest ${int(p.longestStreak)}` },
      { label: "busiest day", value: p.busiest ? int(p.busiest.n) : "—", meta: p.busiest?.day },
    ]),
  );

  const cal = card("A year of days", "Each square is a day; darker is busier. Click one for its notes.");
  const CELL = 13;
  const svg = chart(53 * CELL, 7 * CELL, "vv-cal", "Notes per day over the last year");
  const dh = drillHost();
  for (const c of calendar(counts, today, 53)) {
    const rect = s("rect", { class: "vv-cal-cell", x: c.col * CELL, y: c.row * CELL, width: CELL - 2, height: CELL - 2, rx: 2, "data-heat": c.heat }, svg);
    const iso = new Date(c.key * 86_400_000).toISOString().slice(0, 10);
    s("title", {}, rect).textContent = `${iso} · ${c.n} note${c.n === 1 ? "" : "s"}`;
    if (c.n > 0) {
      rect.classList.add("vv-pick");
      rect.addEventListener("click", () => void drill(dh, { kind: "day", value: iso }, iso));
    }
  }
  cal.body.append(svg, dh);
  host.append(cal.root);

  const mon = card("Which folders filled them", "The last 18 months, stacked by top-level folder.");
  const keys = p.stacks.map((x) => x.key);
  const mw = 600;
  const mh = 180;
  const msvg = chart(mw, mh, "vv-stack", "Notes per month by folder");
  const { bars: rects, max } = bars(p.stacks, p.months.length, mw, mh, { gap: 2 });
  for (const b of rects) {
    const r = s("rect", { class: `vv-bar ${seriesClass(b.s)}`, x: b.x, y: b.y, width: b.w, height: b.h }, msvg);
    s("title", {}, r).textContent = `${p.months[b.i] ?? ""} · ${keys[b.s] ?? ""} · ${int(b.value)}`;
  }
  mon.body.append(msvg, axis(p.months, mw), legend(keys), el("p", "vv-note-line", `Tallest month: ${int(max)} notes on the axis.`));
  host.append(mon.root);
}

/** Month labels under a bar chart, thinned so they never collide. */
function axis(months: readonly string[], w: number): HTMLElement {
  const r = el("div", "vv-axis");
  const labels = monthLabels(months);
  const every = months.length > 12 ? 3 : 1;
  labels.forEach((label, i) => {
    const slot = band(i, months.length, w);
    const tick = el("span", "vv-tick", i % every === 0 ? label : "");
    tick.style.setProperty("--vv-x", `${((slot.x + slot.w / 2) / w) * 100}%`);
    r.append(tick);
  });
  return r;
}

function renderGrowth(host: HTMLElement, d: VaultGrowthResponse): void {
  const g = d.growth;
  const dd = delta(g.d90, g.prev90);
  host.append(
    stats([
      { label: "notes in all", value: int(g.total), meta: `${int(g.undated)} undated` },
      { label: "notes a day", value: g.perDay30.toFixed(1), meta: "over 30 days" },
      { label: "notes in 90 days", value: int(g.d90), meta: `${dd.text} on the 90 before`, dir: dd.dir },
      ...g.milestones.slice(0, 1).map((m) => ({ label: `reaches ${int(m.at)}`, value: m.day ?? "not at this pace" })),
    ]),
  );

  const c = card("How it got this big", "Cumulative notes per folder. The baseline holds everything older than the window.");
  const w = 600;
  const h = 220;
  const svg = chart(w, h, "vv-area", "Cumulative notes per folder by month");
  const { paths } = area(g.stacks, g.months.length, w, h);
  paths.forEach((p, i) => {
    const path = s("path", { class: `vv-area-band ${seriesClass(i)}`, d: p }, svg);
    s("title", {}, path).textContent = g.stacks[i]?.key ?? "";
  });
  c.body.append(svg, axis(g.months, w), legend(g.stacks.map((x) => x.key)));
  if (g.baseline > 0) c.body.append(el("p", "vv-note-line", `${int(g.baseline)} notes predate this window and sit under the stack.`));
  host.append(c.root);

  if (g.milestones.length > 0) {
    const m = card("Next round numbers", "Projected from the last 30 days' pace.");
    const list = el("ul", "vv-plain");
    for (const it of g.milestones) list.append(el("li", "vv-plain-row", `${int(it.at)} notes — ${it.day ?? "not at this pace"}`));
    m.body.append(list);
    host.append(m.root);
  }

  if (g.fastest.length > 0) {
    const f = card("Growing fastest", "Notes added per folder over 90 days.");
    f.body.append(barList(g.fastest.map((x) => ({ key: x.key || "(root)", n: x.n })), "notes"));
    host.append(f.root);
  }
}

function renderFocus(host: HTMLElement, d: VaultFocusResponse): void {
  const f = d.focus;
  host.append(
    stats([
      { label: "projects touched", value: int(f.touchedProjects), meta: "in 26 weeks" },
      { label: "umbrellas touched", value: int(f.touchedUmbrellas) },
      { label: "projects a day", value: f.switchesPerDay.toFixed(1), meta: "on an active day" },
      { label: "biggest share", value: f.top ? pct(f.top.share) : "—", meta: f.top?.key },
    ]),
  );

  for (const [title, hint, series] of [
    ["By project", "26 weeks, centred: the shape shows how attention was split, not how much there was.", f.byProject],
    ["By umbrella", "The same weeks, grouped by umbrella.", f.byUmbrella],
  ] as const) {
    const c = card(title, hint);
    const w = 600;
    const h = 180;
    const svg = chart(w, h, "vv-stream", `${title}: share of notes per week`);
    const { paths } = stream(series, f.weeks.length, w, h);
    paths.forEach((p, i) => {
      const path = s("path", { class: `vv-stream-band ${seriesClass(i)}`, d: p }, svg);
      s("title", {}, path).textContent = series[i]?.key ?? "";
    });
    c.body.append(svg, legend(series.map((x) => x.key)));
    host.append(c.root);
  }

  for (const [title, shifts, kind] of [
    ["What moved, by project", f.shiftProjects, "project"],
    ["What moved, by umbrella", f.shiftUmbrellas, "umbrella"],
  ] as const) {
    if (shifts.length === 0) continue;
    const c = card(title, "Share over the last 4 weeks against the 4 before them.");
    const dh = drillHost();
    c.body.append(
      barList(
        shifts.map((x) => ({
          key: x.key || "(unfiled)",
          n: Math.round(x.now * 1000),
          meta: `${pct(x.before)} → ${pct(x.now)}`,
          onPick: () => void drill(dh, { kind, value: x.key }, x.key || "(unfiled)"),
        })),
        "‰",
      ),
      dh,
    );
    host.append(c.root);
  }
}

function renderMeetings(host: HTMLElement, d: VaultMeetingsResponse): void {
  const m = d.meetings;
  host.append(
    stats([
      { label: "hours this week", value: m.hoursThisWeek.toFixed(1), meta: `${m.avgHours12w.toFixed(1)} average over 12 weeks` },
      { label: "meetings this week", value: int(m.countThisWeek) },
      { label: "average length", value: `${Math.round(m.avgMinutes90)}m`, meta: "over 90 days" },
      { label: "busiest slot", value: m.peak ? `${DOW[m.peak.dow] ?? ""} ${String(m.peak.hour).padStart(2, "0")}:00` : "—", meta: m.peak ? `${int(m.peak.n)} meetings` : undefined },
    ]),
  );

  const c = card("Hours a week", "26 weeks of meeting time.");
  const w = 600;
  const h = 160;
  const svg = chart(w, h, "vv-stack", "Meeting hours per week");
  const { bars: rects } = bars([{ parts: m.hours }], m.weeks.length, w, h, { gap: 2 });
  for (const b of rects) {
    const r = s("rect", { class: `vv-bar ${seriesClass(0)}`, x: b.x, y: b.y, width: b.w, height: b.h }, svg);
    s("title", {}, r).textContent = `week of ${m.weeks[b.i] ?? ""} · ${b.value.toFixed(1)}h · ${int(m.counts[b.i] ?? 0)} meetings`;
  }
  c.body.append(svg);
  host.append(c.root);

  const hours = Math.max(0, m.hourTo - m.hourFrom + 1);
  if (hours > 0) {
    const g = card("When they land", "Weekday against hour, over the last 12 months.");
    const CELL = 22;
    const gsvg = chart(hours * CELL, 7 * CELL, "vv-grid", "Meetings by weekday and hour");
    for (const cell of grid(m.grid, m.hourFrom, m.hourTo)) {
      const r = s("rect", { class: "vv-cal-cell", x: cell.col * CELL, y: cell.row * CELL, width: CELL - 2, height: CELL - 2, rx: 2, "data-heat": cell.heat }, gsvg);
      s("title", {}, r).textContent = `${DOW[cell.row] ?? ""} ${String(cell.key).padStart(2, "0")}:00 · ${cell.n} meeting${cell.n === 1 ? "" : "s"}`;
    }
    const rows = el("ul", "vv-grid-rows");
    for (const day of DOW) rows.append(el("li", "vv-grid-row", day));
    const wrap = el("div", "vv-grid-wrap");
    wrap.append(rows, gsvg);
    g.body.append(wrap, el("p", "vv-note-line", `Hours ${String(m.hourFrom).padStart(2, "0")}:00 to ${String(m.hourTo).padStart(2, "0")}:00, left to right.`));
    host.append(g.root);
  }

  if (m.byProject.length > 0) {
    const p = card("Where the hours went", "Meeting hours per project over 90 days.");
    p.body.append(barList(m.byProject.map((x) => ({ key: x.key || "(unfiled)", n: Math.round(x.hours) })), "h"));
    host.append(p.root);
  }

  if (m.longest.length > 0) {
    const l = card("Longest, last 30 days", "");
    const list = el("ul", "vv-notes");
    for (const it of m.longest) {
      const li = el("li", "vv-note");
      const a = el("a", "vv-note-link");
      a.href = obsidianUrl(it.path);
      a.textContent = it.name;
      a.title = it.path;
      li.append(a, el("span", "vv-note-meta", `${it.day} · ${int(it.minutes)}m${it.project ? ` · ${it.project}` : ""}`));
      list.append(li);
    }
    l.body.append(list);
    host.append(l.root);
  }
}

function renderProjects(host: HTMLElement, d: VaultProjectsResponse): void {
  const p = d.projects;
  host.append(
    stats([
      { label: "projects", value: int(p.items.length), meta: `${int(p.active30)} touched in 30 days` },
      { label: "umbrellas", value: int(p.umbrellas.length) },
      { label: "session notes filed", value: int(p.sessionNotes) },
      { label: "busiest", value: p.busiest ?? "—" },
    ]),
  );

  if (p.umbrellas.length > 0) {
    const u = card("By umbrella", `Your ${p.umbrellas.length} umbrellas, by notes.`);
    const dh = drillHost();
    u.body.append(
      barList(
        p.umbrellas.map((x) => ({
          key: x.key || "(unfiled)",
          n: x.notes,
          meta: `${int(x.projects)} projects · ${int(x.n30)} in 30d`,
          onPick: () => void drill(dh, { kind: "umbrella", value: x.key }, x.key || "(unfiled)"),
        })),
        "notes",
      ),
      dh,
    );
    host.append(u.root);
  }

  const c = card("Every project", "Newest first. The bar is its note count; the right column is the last time anything landed.");
  const dh = drillHost();
  const list = el("ul", "vv-bars");
  const max = Math.max(1, ...p.items.map((x) => x.notes));
  for (const it of p.items) {
    const li = el("li", "vv-bar-row");
    const label = el("button", "vv-bar-label", it.slug);
    label.type = "button";
    label.addEventListener("click", () => void drill(dh, { kind: "project", value: it.slug }, it.slug));
    const track = el("div", "vv-bar-track");
    const fill = el("div", "vv-bar-fill");
    fill.style.setProperty("--vv-bar", `${((it.notes / max) * 100).toFixed(1)}%`);
    // Freshness, not size, is what the eye should catch first on this list.
    fill.dataset.fresh = it.n30 > 0 ? "hot" : it.last ? "warm" : "cold";
    track.append(fill);
    li.append(label, track, el("span", "vv-bar-n", `${int(it.notes)} notes`));
    li.append(el("span", "vv-bar-meta", [it.umbrella, it.last ?? "undated", it.n30 > 0 ? `${int(it.n30)} in 30d` : ""].filter(Boolean).join(" · ")));
    // UX-3: the project's one page (its city, Library card and this note), not Obsidian.
    const a = el("a", "vv-bar-open", "page");
    a.href = formatRoute("project", it.slug);
    a.title = `${it.slug}: sessions, todos, verdicts, spend and its note, in one page`;
    li.append(a);
    list.append(li);
  }
  c.body.append(list, dh);
  host.append(c.root);

  if (p.quiet.length > 0) {
    const q = card("Gone quiet", "Big projects nothing has touched lately.");
    q.body.append(barList(p.quiet.map((x) => ({ key: x.slug, n: x.notes, meta: x.last ?? "undated" })), "notes"));
    host.append(q.root);
  }
}

function renderTopics(host: HTMLElement, d: VaultTopicsResponse): void {
  const t = d.topics;
  host.append(
    stats([
      { label: "tags", value: int(t.items.length) },
      { label: "families", value: int(t.families.length) },
      { label: "rising", value: int(t.rising.length), meta: "against the last 90 days" },
      { label: "gone quiet", value: int(t.quiet.length) },
    ]),
  );

  if (t.families.length > 0) {
    const f = card("Tag families", "Everything before the first slash.");
    f.body.append(barList(t.families.map((x) => ({ key: x.key, n: x.n })), "notes"));
    host.append(f.root);
  }

  for (const [title, hint, items] of [
    ["Rising", "Busy in the last 30 days against their own 90-day pace.", t.rising],
    ["Gone quiet", "Were busy, are not.", t.quiet],
    ["Every tag", "By total notes.", t.items],
  ] as const) {
    if (items.length === 0) continue;
    const c = card(title, hint);
    const dh = drillHost();
    const list = el("ul", "vv-tags");
    for (const tag of items) {
      const li = el("li", "vv-tag");
      const b = el("button", "vv-tag-name", `#${tag.tag}`);
      b.type = "button";
      b.addEventListener("click", () => void drill(dh, { kind: "tag", value: tag.tag }, `#${tag.tag}`));
      const svg = chart(120, 24, "vv-spark", `${tag.tag}: notes per week over 26 weeks`);
      s("path", { class: "vv-spark-line", d: spark(tag.weeks, 120, 24) }, svg);
      const dd = delta(tag.n30, tag.p30);
      const m = el("span", "vv-tag-meta", `${int(tag.total)} notes · ${int(tag.n30)} in 30d · ${dd.text}`);
      m.dataset.dir = dd.dir;
      li.append(b, svg, m);
      list.append(li);
    }
    c.body.append(list, dh);
    host.append(c.root);
  }
}

function renderPeople(host: HTMLElement, d: VaultPeopleResponse): void {
  const p = d.people;
  host.append(
    stats([
      { label: "people with a note", value: int(p.withNote) },
      { label: "seen in 30 days", value: int(p.seen30) },
      { label: "inner circle", value: int(p.inner), meta: "seen lately and often" },
      { label: "fading", value: int(p.fading), meta: "known well, quiet now" },
    ]),
  );

  const c = card("Who you actually see", "Left is recent, up is often. Both axes are log, so the long tail does not crush the rest. Dot size is the last 90 days.");
  const w = 600;
  const h = 300;
  // Margins keep edge dots whole (seen today sits on x = 0, the most mentioned on y = 0) and
  // leave room for the axis ticks.
  const m = { l: 34, r: 12, t: 12, b: 22 };
  const pw = w - m.l - m.r;
  const ph = h - m.t - m.b;
  const svg = chart(w, h, "vv-scatter", "People by days since last mention against total mentions");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet"); // round dots, unstretched tick text
  const items = p.people.map((x) => ({ key: x.path, daysSince: x.daysSince, total: x.total, n90: x.n90 }));
  const maxDays = Math.max(30, ...items.map((i) => i.daysSince ?? 0));
  const maxTotal = Math.max(1, ...items.map((i) => i.total));
  const xAt = (days: number): number => m.l + (Math.log10(days + 1) / (Math.log10(maxDays + 1) || 1)) * pw;
  const yAt = (total: number): number => m.t + ph - (Math.log10(total + 1) / (Math.log10(maxTotal + 1) || 1)) * ph;
  for (const [days, label] of [[0, "today"], [7, "1 wk"], [30, "1 mo"], [365, "1 yr"]] as const) {
    if (days > maxDays) continue;
    s("line", { class: "vv-sc-grid", x1: xAt(days), x2: xAt(days), y1: m.t, y2: m.t + ph }, svg);
    s("text", { class: "vv-sc-tick", x: xAt(days), y: h - 6, "text-anchor": "middle" }, svg).textContent = label;
  }
  for (let total = 1; total <= maxTotal; total *= 10) {
    s("line", { class: "vv-sc-grid", x1: m.l, x2: m.l + pw, y1: yAt(total), y2: yAt(total) }, svg);
    s("text", { class: "vv-sc-tick", x: m.l - 6, y: yAt(total) + 3, "text-anchor": "end" }, svg).textContent = int(total);
  }
  const dots = scatter(items, pw, ph, { maxDays }).map((d) => ({ ...d, x: d.x + m.l, y: d.y + m.t }));
  const byPath = new Map(p.people.map((x) => [x.path, x]));
  for (const dot of dots) {
    const person = byPath.get(dot.key);
    if (!person) continue;
    const circle = s("circle", { class: "vv-dot", cx: dot.x, cy: dot.y, r: dot.r, "data-band": person.band }, svg);
    s("title", {}, circle).textContent = `${person.name} · ${int(person.total)} mentions · last ${since(null, 0) === "never" && person.last === null ? "never" : person.last ?? "never"}`;
    circle.addEventListener("click", () => window.open(obsidianUrl(person.path), "_blank", "noopener"));
    circle.classList.add("vv-pick");
  }
  c.body.append(svg, el("p", "vv-note-line", "Click a dot to open that note in Obsidian."));
  host.append(c.root);

  for (const [title, hint, items] of [
    ["Worth a reconnect", "Known well once, quiet for a while.", p.reconnect],
    ["Most mentioned, last 90 days", "", p.top90],
    ["Companies", "", p.companies],
  ] as const) {
    if (items.length === 0) continue;
    const box = card(title, hint);
    const list = el("ul", "vv-notes");
    for (const it of items) {
      const li = el("li", "vv-note");
      li.dataset.band = it.band;
      const a = el("a", "vv-note-link");
      a.href = obsidianUrl(it.path);
      a.textContent = it.name;
      a.title = it.path;
      const svg = chart(90, 20, "vv-spark", `${it.name}: mentions per month`);
      s("path", { class: "vv-spark-line", d: spark(it.months, 90, 20) }, svg);
      li.append(a, svg, el("span", "vv-note-meta", `${int(it.total)} mentions · last ${it.last ?? "never"}`));
      list.append(li);
    }
    box.body.append(list);
    host.append(box.root);
  }
}

function renderSources(host: HTMLElement, d: VaultSourcesResponse): void {
  const sc = d.sources;
  const shift = delta(Math.round(sc.claudeShare90 * 100), Math.round(sc.claudeSharePrev * 100));
  host.append(
    stats([
      { label: "sessions captured", value: int(sc.captured) },
      { label: "sources", value: int(sc.sources.length) },
      { label: "Claude's share", value: pct(sc.claudeShare90), meta: `${shift.text} points on a year ago`, dir: shift.dir },
      { label: "top this month", value: sc.topThisMonth ?? "—" },
    ]),
  );

  if (sc.flows.length > 0) {
    const c = card("Tool to umbrella", "Which capture tool fed which umbrella, over 90 days.");
    const w = 420;
    const h = 260;
    const svg = chart(w, h, "vv-bands", "Flow from capture tool to umbrella");
    const { bands: out, left, right } = bands(sc.flows, w, h, { pad: 3 });
    const keys = [...new Set(out.map((b) => b.from))];
    for (const b of out) {
      const path = s("path", { class: `vv-band ${seriesClass(keys.indexOf(b.from))}`, d: b.path }, svg);
      s("title", {}, path).textContent = `${b.from} → ${b.to} · ${int(b.n)}`;
    }
    const cols = el("div", "vv-band-cols");
    for (const [col, cls] of [[left, "vv-band-left"], [right, "vv-band-right"]] as const) {
      const ul = el("ul", `vv-band-col ${cls}`);
      for (const box of col) {
        const li = el("li", "vv-band-key", box.key || "(unfiled)");
        li.style.setProperty("--vv-y", `${((box.y + box.h / 2) / h) * 100}%`);
        ul.append(li);
      }
      cols.append(ul);
    }
    const wrap = el("div", "vv-band-wrap");
    wrap.append(cols.firstElementChild ?? el("ul", "vv-band-col"), svg, cols.lastElementChild ?? el("ul", "vv-band-col"));
    c.body.append(wrap);
    host.append(c.root);
  }

  if (sc.months.length > 0 && sc.mix.length > 0) {
    const c = card("The mix, month by month", "Each month fills the height, so this reads as share rather than volume.");
    const w = 600;
    const h = 180;
    const svg = chart(w, h, "vv-stack", "Share of sessions per source per month");
    for (const b of share(sc.mix, sc.months.length, w, h, 2)) {
      const r = s("rect", { class: `vv-bar ${seriesClass(b.s)}`, x: b.x, y: b.y, width: b.w, height: b.h }, svg);
      s("title", {}, r).textContent = `${sc.months[b.i] ?? ""} · ${sc.mix[b.s]?.key ?? ""} · ${int(b.value)}`;
    }
    c.body.append(svg, axis(sc.months, w), legend(sc.mix.map((x) => x.key)));
    host.append(c.root);
  }

  const t = card("Every source", "Sessions captured per tool.");
  t.body.append(barList(sc.sources.map((x) => ({ key: `${x.ai ? "🤖 " : ""}${x.key}`, n: x.total, meta: `${int(x.n30)} in 30d` })), "sessions"));
  host.append(t.root);

  if (sc.umbrellas.length > 0) {
    const u = card("Where they landed", "");
    u.body.append(barList(sc.umbrellas.map((x) => ({ key: x.key || "(unfiled)", n: x.n })), "sessions"));
    host.append(u.root);
  }
}

function renderEchoes(host: HTMLElement, d: VaultEchoesResponse): void {
  const e = d.echoes;
  const again = el("button", "vv-again", "Shuffle");
  again.type = "button";
  again.addEventListener("click", () => {
    echoSeed = Math.floor(Math.random() * 1_000_000);
    loaded.delete("echoes");
    void load("echoes");
  });
  const head = el("div", "vv-echo-head");
  head.append(el("p", "vv-card-hint", "Nothing here is new. That is the point."), again);
  host.append(head);

  const g = card("Forgotten gems", "Well-linked notes nothing near them has moved in months.");
  if (e.gems.length === 0) {
    g.body.append(el("p", "vv-empty", "Nothing is quiet enough to count as forgotten yet."));
  } else {
    const list = el("ul", "vv-notes");
    for (const gem of e.gems) {
      const li = el("li", "vv-note");
      const a = el("a", "vv-note-link");
      a.href = obsidianUrl(gem.path);
      a.textContent = gem.name;
      a.title = gem.path;
      const dot = el("i", "vv-note-dot");
      dot.style.setProperty("--vv-dot", folderColor(gem.folder));
      li.append(dot, a, el("span", "vv-note-meta", `quiet ${gem.quietMonths} months · ${int(gem.links)} links · ${gem.folder}`));
      list.append(li);
    }
    g.body.append(list);
  }
  host.append(g.root);

  for (const bucket of e.onThisDay) {
    const c = card(`This day, ${bucket.label}`, "");
    c.body.append(noteRows(bucket.notes));
    host.append(c.root);
  }

  if (e.wander.length > 0) {
    const w = card("Wander", "A random walk along your own links, starting from a gem.");
    const trail = el("ol", "vv-trail");
    for (const n of e.wander) {
      const li = el("li", "vv-trail-step");
      const a = el("a", "vv-note-link");
      a.href = obsidianUrl(n.path);
      a.textContent = n.name;
      a.title = n.path;
      li.append(a);
      trail.append(li);
    }
    w.body.append(trail);
    host.append(w.root);
  }
}

/** "Draft a fix" on a gap: the Fix queue's own row for it (its city, and the launch recorded on it). */
function gapFixButton(fixId: string, fallback: DraftFix): HTMLButtonElement {
  return draftFixButton((btn) => {
    if (ctx) void draftFixFromQueue(ctx, fixId, { ...fallback, fixId }, btn);
  });
}

function renderGaps(host: HTMLElement, d: VaultGapsResponse): void {
  const g = d.gaps;
  host.append(
    stats([
      { label: "orphans", value: int(g.orphans), meta: `of ${int(g.notes)} notes` },
      { label: "notes you linked to but never wrote", value: int(g.ghostTotal) },
      { label: "untyped", value: int(g.untyped) },
      { label: "projects with no index note", value: int(g.projectsMissingNote) },
      ...(g.unanchored === null ? [] : [{ label: "unanchored", value: int(g.unanchored), meta: "climb straight to Home" }]),
    ]),
  );

  if (g.writeNext.length > 0) {
    const c = card("Write these next", "Link targets that resolve to nothing, by how many of your notes point at them (two or more; imports and web clips left out).");
    const dh = drillHost();
    c.body.append(
      barList(
        g.writeNext.map((x) => ({
          key: x.key,
          n: x.n,
          onPick: () => void drill(dh, { kind: "ghost", value: x.key }, `notes pointing at "${x.key}"`),
          action: gapFixButton(`vault-ghost:${x.key}`, { prompt: vaultGhostFixPrompt(x.key, x.n) }),
        })),
        ["note points here", "notes point here"],
      ),
      dh,
    );
    host.append(c.root);
  }

  if (g.orphansByFolder.length > 0) {
    const c = card("Orphans by folder", "Nothing links in, nothing links out.");
    const dh = drillHost();
    c.body.append(barList(g.orphansByFolder.map((x) => ({ key: x.key || "(root)", n: x.n, onPick: () => void drill(dh, { kind: "folder", value: x.key }, x.key || "(root)") })), ["orphan", "orphans"]), dh);
    host.append(c.root);
  }

  if (g.unanchoredByFolder.length > 0) {
    const c = card(
      "Unanchored by folder",
      "No genus, project or folder index, so the only step up is Home. Give one a broader: link, or the folder an _index.md.",
    );
    const dh = drillHost();
    c.body.append(barList(g.unanchoredByFolder.map((x) => ({ key: x.key || "(root)", n: x.n, onPick: () => void drill(dh, { kind: "unanchored", value: x.key }, `unanchored in ${x.key || "(root)"}`) })), "unanchored"), dh);
    host.append(c.root);
  }

  if (g.duplicates.length > 0) {
    const c = card("Probably the same thing twice", "Notes whose names collapse to the same string.");
    const list = el("ul", "vv-plain");
    for (const dup of g.duplicates) {
      const li = el("li", "vv-dup");
      li.append(el("span", "vv-dup-key", dup.key));
      const paths = el("ul", "vv-notes");
      for (const path of dup.paths) {
        const row = el("li", "vv-note");
        const a = el("a", "vv-note-link");
        a.href = obsidianUrl(path);
        a.textContent = baseName(path);
        a.title = path;
        row.append(a, el("span", "vv-note-meta", path));
        paths.append(row);
      }
      li.append(paths);
      list.append(li);
    }
    c.body.append(list);
    host.append(c.root);
  }

  if (g.missingProjects.length > 0) {
    const c = card("Projects with no index note", "A project slug is in use, but 20-Projects/<slug>/_index.md does not exist.");
    const list = el("ul", "vv-chips");
    for (const slug of g.missingProjects) {
      const chip = el("li", "vv-chip", slug);
      chip.append(" ", gapFixButton(`vault-project:${slug}`, { prompt: vaultProjectFixPrompt(slug) }));
      list.append(chip);
    }
    c.body.append(list);
    host.append(c.root);
  }

  if (g.untypedByFolder.length > 0) {
    const c = card("Untyped, by folder", "No frontmatter type, so they fall out of every typed view.");
    const dh = drillHost();
    c.body.append(barList(g.untypedByFolder.map((x) => ({ key: x.key || "(root)", n: x.n, onPick: () => void drill(dh, { kind: "folder", value: x.key }, x.key || "(root)") })), ["note", "notes"]), dh);
    host.append(c.root);
  }
}

// ---------------------------------------------------------------- the four maps

/** Roughly what fits: 0.58em per character is close enough for labels inside chart cells. */
function fit(text: string, width: number, px: number): string | null {
  const max = Math.floor(width / (px * 0.58));
  if (max < 3) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A row list of named things with a number, each optionally clickable or a link. */
function rowList(rows: readonly { label: string; meta: string; href?: string; title?: string; onPick?: () => void }[]): HTMLElement {
  const list = el("ul", "vv-notes");
  for (const r of rows) {
    const li = el("li", "vv-note");
    let label: HTMLElement;
    if (r.href) {
      const a = el("a", "vv-note-link", r.label);
      a.href = r.href;
      label = a;
    } else if (r.onPick) {
      const b = el("button", "vv-note-link vv-link-btn", r.label);
      b.type = "button";
      b.addEventListener("click", r.onPick);
      label = b;
    } else {
      label = el("span", "vv-note-link", r.label);
    }
    if (r.title) label.title = r.title;
    li.append(label, el("span", "vv-note-meta", r.meta));
    list.append(li);
  }
  return list;
}

/** Re-fetch a section whose URL depends on view state (Atlas folder, Flows mode); a URL seen before is instant. */
function reload(id: string): void {
  const cached = variants.get(url(id));
  if (cached) {
    loaded.set(id, cached);
    return paint();
  }
  loaded.delete(id);
  void load(id);
}

/** A two-option switch. */
function segmented<T extends string>(options: readonly (readonly [T, string])[], value: T, onPick: (v: T) => void): HTMLElement {
  const r = el("div", "vv-seg ch-seg");
  r.setAttribute("role", "group");
  for (const [v, label] of options) {
    const b = el("button", "vv-seg-btn", label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(v === value));
    b.addEventListener("click", () => v !== value && onPick(v));
    r.append(b);
  }
  return r;
}

const LOOSE_AS_CELLS = 160;

function renderAtlas(host: HTMLElement, d: VaultAtlasResponse): void {
  const a = d.atlas;
  atlasPath = [...a.path];
  host.append(
    stats([
      { label: "notes", value: int(a.count), meta: a.dir || "the whole vault" },
      { label: "new this week", value: int(a.recent) },
      { label: "last note", value: a.last ?? "—" },
      { label: "subfolders", value: int(a.subfolders.length), meta: `${int(a.loose)} notes loose here` },
    ]),
  );

  const go = (depth: number, loose = false): void => {
    atlasPath = atlasPath.slice(0, depth);
    atlasLoose = loose;
    reload("atlas");
  };
  const crumbs = el("nav", "vv-crumbs");
  crumbs.setAttribute("aria-label", "Folder path");
  ["Vault", ...a.path].forEach((name, i, all) => {
    if (i) crumbs.append(el("span", "vv-crumb-sep", "›"));
    const last = i === all.length - 1 && !atlasLoose;
    if (last) crumbs.append(el("b", "vv-crumb", name));
    else {
      const b = el("button", "vv-crumb vv-link-btn", name);
      b.type = "button";
      b.addEventListener("click", () => go(i));
      crumbs.append(b);
    }
  });
  if (atlasLoose) crumbs.append(el("span", "vv-crumb-sep", "›"), el("b", "vv-crumb", "notes in this folder"));

  type Cell = { value: number; label: string; sub: string; title: string; color: string; fresh: boolean; act: () => void; href?: string };
  const cells: Cell[] = [];
  if (!atlasLoose) {
    for (const f of a.subfolders) {
      cells.push({
        value: f.count,
        label: f.name,
        sub: `${int(f.count)} notes${f.recent ? ` · ${int(f.recent)} new` : ""}`,
        title: f.dir,
        color: folderColor(f.dir.split("/")[0] ?? ""),
        fresh: f.recent > 0,
        act: () => {
          atlasPath = [...a.path, f.name];
          atlasLoose = false;
          reload("atlas");
        },
      });
    }
  }
  if (a.loose > 0) {
    if (atlasLoose || a.subfolders.length === 0 || a.loose <= LOOSE_AS_CELLS) {
      for (const n of a.notes) {
        cells.push({ value: 1 + Math.sqrt(n.links), label: n.name, sub: `${int(n.links)} links`, title: n.path, color: folderColor(n.folder), fresh: false, act: () => undefined, href: obsidianUrl(n.path) });
      }
      const more = a.loose - a.notes.length;
      if (more > 0) cells.push({ value: Math.max(6, more * 0.4), label: `+${int(more)} more`, sub: "less linked", title: `${int(more)} less linked notes`, color: "#9aa0ab", fresh: false, act: () => undefined });
    } else {
      cells.push({ value: a.loose, label: "Notes in this folder", sub: `${int(a.loose)} notes`, title: "Open the notes sitting directly in this folder", color: folderColor(a.path[0] ?? ""), fresh: false, act: () => go(a.path.length, true) });
    }
  }

  const c = card("Folders by size", "Area is note count. Click a folder to step inside; a note opens in Obsidian. A green dot means notes landed there this week.");
  c.body.append(crumbs);
  if (cells.length === 0) c.body.append(el("p", "vv-empty", "Nothing filed here."));
  else {
    const W = 760;
    const H = 460;
    const svg = chart(W, H, "vv-treemap", `Treemap of ${a.name}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const rects = treemap(cells.map((x) => x.value), W, H, 3);
    cells.forEach((cell, i) => {
      const r = rects[i];
      if (!r || r.w < 1 || r.h < 1) return;
      const parent = cell.href ? s("a", { href: cell.href, target: "_blank", rel: "noopener" }, svg) : svg;
      const g = s("g", { class: "vv-tm-cell", transform: `translate(${r.x.toFixed(1)},${r.y.toFixed(1)})`, tabindex: 0, role: "button", "aria-label": cell.title }, parent);
      g.style.setProperty("--vv-dot", cell.color);
      s("title", {}, g).textContent = `${cell.title} · ${cell.sub}`;
      s("rect", { class: "vv-tm-rect", width: r.w.toFixed(1), height: r.h.toFixed(1), rx: 4 }, g);
      if (cell.fresh && r.w > 16 && r.h > 16) s("circle", { class: "vv-tm-fresh", cx: r.w - 8, cy: 8, r: 3.2 }, g);
      const label = r.h > 22 ? fit(cell.label, r.w - 14, 12.5) : null;
      if (label) s("text", { class: "vv-tm-label", x: 7, y: 17 }, g).textContent = label;
      const sub = r.h > 38 ? fit(cell.sub, r.w - 14, 11) : null;
      if (sub) s("text", { class: "vv-tm-sub", x: 7, y: 32 }, g).textContent = sub;
      if (!cell.href) {
        g.addEventListener("click", cell.act);
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            cell.act();
          }
        });
      }
    });
    c.body.append(svg);
  }
  host.append(c.root);

  if (a.mostLinked.length > 0) {
    const m = card("Most linked here", "Anywhere under this folder.");
    m.body.append(noteRows(a.mostLinked));
    host.append(m.root);
  }
  if (a.newest.length > 0) {
    const m = card("Newest here");
    m.body.append(noteRows(a.newest));
    host.append(m.root);
  }
}

function renderFlows(host: HTMLElement, d: VaultFlowsResponse): void {
  const f = d.flows;
  flowsMode = f.mode;
  const G = f.names.length;
  if (flowsPick !== null && flowsPick >= G) flowsPick = null;
  const totalCross = f.cross.reduce((a, b) => a + b, 0);
  const label = (name: string): string => (name.includes("/") ? (name.split("/")[1] ?? name) : name);

  const head = el("div", "vv-echo-head");
  head.append(
    el("p", "vv-card-hint", f.mode === "folders" ? "Ribbon width is the number of links between two areas. The big four folders are split one level down." : "How umbrellas link to each other, from notes filed under a project."),
    segmented<VaultFlowsMode>([["folders", "Folders"], ["umbrellas", "Umbrellas"]], f.mode, (m) => {
      flowsMode = m;
      flowsPick = null;
      reload("flows");
    }),
  );
  host.append(head);
  if (totalCross === 0) return void host.append(el("p", "vv-empty", "No links cross between these groups yet."));

  const focus = flowsPick ?? f.cross.indexOf(Math.max(...f.cross));
  const pick = (i: number): void => {
    flowsPick = flowsPick === i ? null : i;
    paint();
  };
  const S = 600;
  const R = S / 2 - 120;
  const geo = chord(f.matrix, S, R);
  const c = card("Who links to whom", "Click an area to follow its ribbons.");
  const svg = chart(S, S, `vv-chord${flowsPick !== null ? " vv-picked" : ""}`, "Links between areas of the vault");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  for (const r of geo.ribbons) {
    const owner = (f.cross[r.i] ?? 0) >= (f.cross[r.j] ?? 0) ? r.i : r.j;
    const on = flowsPick === r.i || flowsPick === r.j;
    const path = s("path", { d: r.path, class: `vv-rib ${seriesClass(owner)}${on ? " vv-on" : ""}` }, svg);
    s("title", {}, path).textContent = `${f.names[r.i]} ↔ ${f.names[r.j]}: ${int(r.n)} links`;
  }
  geo.arcs.forEach((arc, i) => {
    if (!arc) return;
    const [a0, a1] = arc;
    const band = s("path", { d: arcBand(S, a0, a1, R + 3, R + 15), class: `vv-arc ${seriesClass(i)}${flowsPick === i ? " vv-on" : ""}`, tabindex: 0, role: "button", "aria-label": `${f.names[i]}: ${int(f.cross[i] ?? 0)} cross links` }, svg);
    s("title", {}, band).textContent = `${f.names[i]} · ${int(f.notes[i] ?? 0)} notes · ${int(f.cross[i] ?? 0)} cross links`;
    band.addEventListener("click", () => pick(i));
    band.addEventListener("keydown", (e) => e.key === "Enter" && pick(i));
    if (a1 - a0 > 0.035) {
      const m = (a0 + a1) / 2;
      const lr = R + 22;
      const text = s("text", { class: `vv-arc-label${flowsPick === i ? " vv-on" : ""}`, x: (S / 2 + lr * Math.sin(m)).toFixed(1), y: (S / 2 - lr * Math.cos(m) + 4).toFixed(1), "text-anchor": Math.sin(m) >= 0 ? "start" : "end" }, svg);
      text.textContent = fit(label(f.names[i] ?? ""), 112, 11) ?? "";
      text.addEventListener("click", () => pick(i));
    }
  });
  c.body.append(svg);
  host.append(c.root);

  const partners: { key: string; n: number; j: number }[] = [];
  for (let j = 0; j < G; j++) {
    if (j === focus) continue;
    const v = (f.matrix[focus]?.[j] ?? 0) + (f.matrix[j]?.[focus] ?? 0);
    if (v) partners.push({ key: f.names[j] ?? "", n: v, j });
  }
  partners.sort((x, y) => y.n - x.n);
  const side = card(f.names[focus] ?? "", `${int(f.notes[focus] ?? 0)} notes · ${int(f.cross[focus] ?? 0)} links out of it · ${int(f.self[focus] ?? 0)} inside it`);
  side.body.append(barList(partners.slice(0, 12).map((p) => ({ key: p.key, n: p.n, onPick: () => pick(p.j) })), "links"));
  host.append(side.root);

  const bridges = geo.ribbons.slice().sort((x, y) => y.n - x.n).slice(0, 8);
  const b = card("Strongest bridges");
  b.body.append(rowList(bridges.map((r) => ({ label: `${f.names[r.i]} ↔ ${f.names[r.j]}`, meta: `${int(r.n)} links`, onPick: () => pick(r.i) }))));
  host.append(b.root);
}

/** A stable sub-pixel jitter from an id, so overlapping dots spread the same way on every paint. */
function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

function renderHubs(host: HTMLElement, d: VaultHubsResponse): void {
  const h = d.hubs;
  const top = h.keystones[0];
  host.append(
    stats([
      { label: "notes with 3+ links", value: int(h.total) },
      { label: "connect 5+ areas", value: int(h.bridges), meta: "bridges across the vault" },
      { label: "top keystone", value: top?.name ?? "—", meta: top ? `${int(top.links)} links · ${top.areas} areas` : undefined },
    ]),
  );

  const c = card("Links against reach", "Right is more links; up is more distinct areas of the vault a note reaches. Top right holds everything together. Click a dot to open it.");
  const W = 760;
  const H = 420;
  const m = { l: 34, r: 12, t: 12, b: 26 };
  const PW = W - m.l - m.r;
  const PH = H - m.t - m.b;
  const maxL = Math.max(10, ...h.points.map((p) => p.links));
  // Only the most linked notes are sent, so the axis starts where they do, not at 1 link.
  const minL = Math.max(1, Math.min(maxL / 3, ...h.points.map((p) => p.links)) * 0.9);
  const maxA = Math.max(3, ...h.points.map((p) => p.areas));
  const X = (v: number): number => m.l + (Math.log(v / minL) / Math.log(maxL / minL)) * PW;
  const Y = (a: number): number => m.t + PH - ((a - 1) / Math.max(1, maxA - 1)) * PH;
  const svg = chart(W, H, "vv-hubs", "Notes by links and areas reached");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  for (const v of [3, 10, 30, 100, 300, 1000, 3000]) {
    if (v > maxL || v < minL) continue;
    s("line", { class: "vv-sc-grid", x1: X(v), x2: X(v), y1: m.t, y2: m.t + PH }, svg);
    s("text", { class: "vv-sc-tick", x: X(v), y: H - 8, "text-anchor": "middle" }, svg).textContent = `${v} links`;
  }
  for (let a = 1; a <= maxA; a += Math.max(1, Math.ceil(maxA / 6))) {
    s("line", { class: "vv-sc-grid", x1: m.l, x2: m.l + PW, y1: Y(a), y2: Y(a) }, svg);
    s("text", { class: "vv-sc-tick", x: m.l - 6, y: Y(a) + 3.5, "text-anchor": "end" }, svg).textContent = String(a);
  }
  const keys = new Set(h.keystones.map((k) => k.id));
  // Keystones last, so they sit on top of the cloud.
  for (const p of [...h.points.filter((x) => !keys.has(x.id)), ...h.keystones]) {
    const key = keys.has(p.id);
    const x = X(p.links) + jitter(p.id) * 3;
    const y = Y(p.areas) + jitter(`${p.id}y`) * 8;
    const link = s("a", { href: obsidianUrl(p.path), target: "_blank", rel: "noopener" }, svg);
    const dot = s("circle", { class: `vv-hub${key ? " vv-key" : ""}`, cx: x.toFixed(1), cy: y.toFixed(1), r: key ? 5 : 2.6 }, link);
    dot.style.setProperty("--vv-dot", folderColor(p.folder));
    s("title", {}, dot).textContent = `${p.name} · ${int(p.links)} links · ${p.areas} areas`;
    if (key) s("text", { class: "vv-hub-label", x: (x + 7).toFixed(1), y: (y + 4).toFixed(1) }, link).textContent = fit(p.name, 110, 11) ?? "";
  }
  c.body.append(svg);
  host.append(c.root);

  const k = card("Keystones", "Most areas reached, weighted by links.");
  k.body.append(rowList(h.keystones.map((p) => ({ label: p.name, meta: `${p.areas} areas · ${int(p.links)} links`, href: obsidianUrl(p.path), title: p.path }))));
  host.append(k.root);
  const sl = card("Siloed hubs", "Heavily linked notes that only talk to their own area. Linking them out spreads their value.");
  if (h.silos.length === 0) sl.body.append(el("p", "vv-empty", "No big hub is siloed."));
  else sl.body.append(rowList(h.silos.map((p) => ({ label: p.name, meta: `${int(p.links)} links`, href: obsidianUrl(p.path), title: p.path }))));
  host.append(sl.root);
}

/** How many project names get a label on the map; the rest show on hover. */
const STAR_LABELS = 28;

function renderConstellation(host: HTMLElement, d: VaultConstellationResponse): void {
  const k = d.constellation;
  if (k.stars.length === 0) return void host.append(el("p", "vv-empty", "No two projects share notes yet."));
  const umb = new Map(k.umbrellas.map((u, i) => [u, i]));
  host.append(
    stats([
      { label: "projects on the map", value: int(k.stars.length) },
      { label: "ties drawn", value: int(k.ties.length), meta: "each project's 4 strongest" },
      { label: "strongest tie", value: k.strongest[0] ? int(k.strongest[0].w) : "—", meta: k.strongest[0] ? `${k.strongest[0].a} ↔ ${k.strongest[0].b}` : undefined },
      { label: "islands", value: int(k.islands.length), meta: "big projects that share nothing" },
    ]),
  );

  const c = card("Your projects as a network", "Two projects are tied when their sessions link to the same notes; thicker means more shared notes. Hover a project to see its ties, click it for its notes.");
  const S = 640;
  const svg = chart(S, S, "vv-constellation", "Project network");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const maxLog = Math.log(1 + Math.max(1, ...k.ties.map((t) => t.w)));
  const lines = k.ties.map((t) => {
    const a = k.stars[t.a];
    const b = k.stars[t.b];
    const line = s("line", { class: "vv-tie", x1: ((a?.x ?? 0) * S).toFixed(1), y1: ((a?.y ?? 0) * S).toFixed(1), x2: ((b?.x ?? 0) * S).toFixed(1), y2: ((b?.y ?? 0) * S).toFixed(1), "stroke-width": (0.6 + (3.4 * Math.log(1 + t.w)) / maxLog).toFixed(2) }, svg);
    s("title", {}, line).textContent = `${a?.slug} ↔ ${b?.slug}: ${int(t.w)} shared notes`;
    return { line, a: t.a, b: t.b };
  });
  const labelCut = [...k.stars].map((x) => x.notes).sort((x, y) => y - x)[Math.min(k.stars.length - 1, STAR_LABELS)] ?? 0;
  const dh = drillHost();
  const groups: SVGGElement[] = [];
  const highlight = (i: number | null): void => {
    svg.classList.toggle("vv-hover", i !== null);
    const near = new Set<number>(i === null ? [] : [i]);
    for (const l of lines) {
      const on = i !== null && (l.a === i || l.b === i);
      l.line.classList.toggle("vv-on", on);
      if (on) {
        near.add(l.a);
        near.add(l.b);
      }
    }
    groups.forEach((g, j) => g.classList.toggle("vv-on", near.has(j)));
  };
  k.stars.forEach((star, i) => {
    const g = s("g", { class: `vv-star ${seriesClass(umb.get(star.umbrella) ?? 0)}`, tabindex: 0, role: "button", "aria-label": `${star.slug}, ${star.notes} notes` }, svg);
    const r = Math.min(18, Math.max(3, star.r * S));
    s("title", {}, g).textContent = `${star.slug} · ${star.umbrella} · ${int(star.notes)} notes`;
    s("circle", { cx: (star.x * S).toFixed(1), cy: (star.y * S).toFixed(1), r: r.toFixed(1) }, g);
    if (star.notes >= labelCut) s("text", { class: "vv-star-label", x: (star.x * S).toFixed(1), y: (star.y * S + r + 11).toFixed(1), "text-anchor": "middle" }, g).textContent = fit(star.slug, 90, 10.5) ?? "";
    const open = (): void => void drill(dh, { kind: "project", value: star.slug }, star.slug);
    g.addEventListener("mouseenter", () => highlight(i));
    g.addEventListener("mouseleave", () => highlight(null));
    g.addEventListener("focus", () => highlight(i));
    g.addEventListener("blur", () => highlight(null));
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => e.key === "Enter" && open());
    groups.push(g);
  });
  c.body.append(legend(k.umbrellas), svg, dh);
  host.append(c.root);

  const t = card("Strongest ties", "Shared notes.");
  t.body.append(rowList(k.strongest.map((x) => ({ label: `${x.a} ↔ ${x.b}`, meta: int(x.w), onPick: () => void drill(dh, { kind: "project", value: x.a }, x.a) }))));
  host.append(t.root);
  const m = card("Most connected", "Shared notes across all its ties.");
  m.body.append(rowList(k.connected.map((x) => ({ label: x.slug, meta: int(x.w), onPick: () => void drill(dh, { kind: "project", value: x.slug }, x.slug) }))));
  host.append(m.root);
  if (k.islands.length > 0) {
    const isl = card("Islands", "Big projects that share nothing with the rest. Fine if intended; otherwise link them to what they draw on.");
    isl.body.append(rowList(k.islands.map((x) => ({ label: x.slug, meta: `${int(x.notes)} notes`, onPick: () => void drill(dh, { kind: "project", value: x.slug }, x.slug) }))));
    host.append(isl.root);
  }
}

// ---------------------------------------------------------------- loading + rendering

/** Each section's endpoint and the renderer for what comes back. */
const RENDER: Record<string, (host: HTMLElement, data: unknown) => void> = {
  pulse: (h, d) => renderPulse(h, d as VaultPulseResponse),
  growth: (h, d) => renderGrowth(h, d as VaultGrowthResponse),
  focus: (h, d) => renderFocus(h, d as VaultFocusResponse),
  meetings: (h, d) => renderMeetings(h, d as VaultMeetingsResponse),
  projects: (h, d) => renderProjects(h, d as VaultProjectsResponse),
  topics: (h, d) => renderTopics(h, d as VaultTopicsResponse),
  people: (h, d) => renderPeople(h, d as VaultPeopleResponse),
  sources: (h, d) => renderSources(h, d as VaultSourcesResponse),
  echoes: (h, d) => renderEchoes(h, d as VaultEchoesResponse),
  gaps: (h, d) => renderGaps(h, d as VaultGapsResponse),
  atlas: (h, d) => renderAtlas(h, d as VaultAtlasResponse),
  flows: (h, d) => renderFlows(h, d as VaultFlowsResponse),
  hubs: (h, d) => renderHubs(h, d as VaultHubsResponse),
  constellation: (h, d) => renderConstellation(h, d as VaultConstellationResponse),
};

function url(id: string): string {
  if (id === "echoes" && echoSeed !== null) return `/api/vault/echoes?seed=${echoSeed}`;
  if (id === "atlas") return `/api/vault/atlas?path=${encodeURIComponent(atlasPath.join("/"))}`;
  if (id === "flows") return `/api/vault/flows?mode=${flowsMode}`;
  return `/api/vault/${id}`;
}

/** Forget a failed section and ask the server again. */
function retry(id: string): Promise<void> {
  failed.delete(id);
  return load(id);
}

async function load(id: string): Promise<void> {
  if (loaded.has(id)) return paint();
  paint();
  // The first section pays for the server's parse of ~32,000 notes, so give it room.
  const u = url(id);
  const r = await fetchResult<{ meta: VaultMeta }>(u, undefined, 60_000);
  if (r.ok) {
    if (id === "atlas" || id === "flows") variants.set(u, r.data);
    // A slower answer for a folder or mode already left behind must not paint over the current one.
    if (u !== url(id)) return;
    loaded.set(id, r.data);
    failed.delete(id);
    meta = r.data.meta;
  } else {
    failed.set(id, r.error);
  }
  if (active === id) paint();
}

function paint(): void {
  if (!body) return;
  const def = SECTIONS.find((x) => x.id === active);
  if (tabBar) lightMindTab(tabBar, active);
  body.replaceChildren();
  const head = el("header", "vv-head");
  head.append(el("h2", "vv-title", `${def?.emoji ?? ""} ${def?.label ?? active}`));
  if (def?.hint) head.append(el("p", "vv-sub", def.hint));
  const stamp = feedStamp(meta, Date.now());
  const feed = el("p", stamp.stale ? "vv-feed vv-feed-stale" : "vv-feed", stamp.text);
  feed.title = "From <vault>/60-Meta/graph-feed, which the vault rebuilds hourly. Stale past 3 hours.";
  head.append(feed);
  body.append(head);

  // Failure and loading are centred in the column with one action (UX-11).
  const err = failed.get(active);
  if (err) {
    const section = active;
    return void body.append(viewState({ tone: "error", title: `Couldn't read ${def?.label ?? section}`, detail: err, action: { label: "Try again", run: () => void retry(section) } }));
  }
  const data = loaded.get(active);
  if (!data) return void body.append(viewState({ tone: "loading", title: "Reading the vault's graph feed…" }));
  const host = el("div", "vv-sections");
  body.append(host);
  RENDER[active]?.(host, data);
}

export const vaultView: AlefView = {
  id: "vault",
  emoji: "🗄️",
  name: "Vault",
  hint: "Fourteen ways to read the alex_claude vault: when it grew, what had your attention, who you see, how it connects, what is missing (read-only)",
  usesPlanet: false,
  mount(r, c) {
    ctx = c;
    root ??= (() => {
      // The Brain destination's frame, shared with the Brain view (VIS-8): tab strip, then body.
      tabBar = mindTabs(active, (view, param) => ctx?.showView(view, param));
      body = el("div", "vv-body");
      const box = mindFrame(tabBar, body);
      box.classList.add("vv-root");
      box.setAttribute("role", "region");
      box.setAttribute("aria-label", "Vault");
      return box;
    })();
    r.append(root);
    const param = c.route().param;
    if (param && isSection(param)) active = param;
    void load(active);
    if (!meta) {
      void fetchResult<VaultMetaResponse>("/api/vault/meta").then((res) => {
        if (res.ok) meta = res.data.meta;
        paint();
      });
    }
  },
  unmount() {
    root?.remove();
    ctx = null;
  },
  onParam(param) {
    const next = param && isSection(param) ? param : DEFAULT_SECTION;
    if (next === active) return;
    active = next;
    void load(active);
  },
};
