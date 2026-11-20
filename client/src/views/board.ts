// 📋 Board: every agent by what it is doing (was a modal, now a view). Columns Working ·
// Waiting on you · Today · Sleeping; the agent-state feature decorates the cards (it watches
// #board-cols, which lives in index.html and moves in and out of this view's root). A card's
// column follows its agent-state chip when the chip has an answer (permission/waiting -> Waiting
// on you, working -> Working, idle -> Today, sleeping -> Sleeping), falling back to the
// lastActive/status heuristic only when agent-state doesn't know yet.
// Filters: District, Columns, Time. Focus mode keeps only Working + Waiting.
// A stale card (failed or abandoned, or waiting on you for hours) gets "Draft a fix" (ui/draft-fix.ts).

import { agentTitle } from "../../../shared/display";
import { sessionFixPrompt } from "../../../shared/features/fixes";
import type { AgentState } from "../../../shared/features/agent-state";
import { SESSION_OUTCOMES, type KnownOutcome, type SessionOutcome } from "../../../shared/features/outcomes";
import type { DailyReport, ReplayResponse } from "../../../shared/features/replay";
import type { WorldAgent } from "../../../shared/types";
import { agentStateOf, onAgentStates } from "../features/agent-state";
import { archiveSummary } from "../features/archive-state";
import { islandIdsWithAgents, visibleIslands } from "../features/archive-lib";
import { OUTCOME_FILTER_LABEL, onOutcomes, outcomeChip, outcomeOf } from "../features/outcomes";
import { onTodosChange, todoHeadline, todoListFor } from "../features/todos";
import { modelLabel } from "../scene/creatures";
import type { AlefView, FilterState, Selection, ViewContext } from "../shell/views";
import { draftFix, draftFixButtonHtml } from "../ui/draft-fix";
import { escapeHtml, relativeTime } from "../ui/fuzzy";
import { viewHeader } from "../ui/view-header";
import { cityListOptions } from "../shell/city-list";
import { boardColumn, cityDisplayName, startOfLocalDay, type BoardColumn } from "../ui/world";
import "./board.css";

/** Column for one agent: its agent-state chip wins when known, else the lastActive/status
 *  heuristic. Exported (with an injectable `stateOf`) so tests don't need the live agent-state
 *  module's global state. */
export function columnFor(a: WorldAgent, now: number, stateOf: (id: string) => AgentState | undefined = agentStateOf): BoardColumn {
  switch (stateOf(a.id)) {
    case "permission":
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    case "idle":
      return "today";
    case "sleeping":
      return "sleeping";
    default:
      return boardColumn(a, now);
  }
}

const COLUMNS: { id: BoardColumn; title: string; empty: string }[] = [
  { id: "working", title: "Working", empty: "No agent is working right now." },
  { id: "waiting", title: "Waiting on you", empty: "Nobody is waiting on you." },
  { id: "today", title: "Today", empty: "Nothing else ran today." },
  { id: "sleeping", title: "Sleeping", empty: "No sleeping agents." },
];

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let state: FilterState = {};
let selected: string | null = null;
let subscribed = false;
let queued = false;
let historyRange: HistoryRange = "today";
/** day -> its DailyReport once /api/replay answers, or null while loading/on failure (never
 *  refetched after a failure — a missing stat line is a fine degrade, not worth hammering). */
let replayByDay = new Map<string, DailyReport | null>();
let todosSubscribed = false;

/** Which agents the filters keep (pure, exported for tests). */
export function boardAgents(
  agents: readonly WorldAgent[],
  f: FilterState,
  now = Date.now(),
  stateOf: (id: string) => AgentState | undefined = agentStateOf,
  outcomeLookup: (id: string) => KnownOutcome | null = outcomeOf,
): Map<BoardColumn, WorldAgent[]> {
  const city = f.district?.[0];
  const cols = new Set(f.columns ?? []);
  const outcomes = new Set(f.outcome ?? []);
  const todayOnly = f.time?.[0] === "today";
  const midnight = startOfLocalDay(now);
  const by = new Map<BoardColumn, WorldAgent[]>(COLUMNS.map((c) => [c.id, []]));
  for (const a of agents) {
    if (city && a.islandId !== city) continue;
    const col = columnFor(a, now, stateOf);
    if (cols.size && !cols.has(col)) continue;
    if (outcomes.size && !outcomes.has(outcomeLookup(a.id) ?? "unknown")) continue;
    if (todayOnly && a.status !== "live" && !(Date.parse(a.lastActive) >= midnight)) continue;
    by.get(col)?.push(a);
  }
  for (const list of by.values()) list.sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  return by;
}

/** Agents per outcome ("no outcome evidence" included) for the sidebar's per-outcome counts —
 *  always over every agent, the same way the Columns / Districts filters count (unfiltered by the
 *  other groups), so switching one filter never changes another's numbers underfoot. */
export function outcomeCounts(agents: readonly WorldAgent[], outcomeLookup: (id: string) => KnownOutcome | null = outcomeOf): Record<SessionOutcome, number> {
  const counts = Object.fromEntries(SESSION_OUTCOMES.map((o) => [o, 0])) as Record<SessionOutcome, number>;
  for (const a of agents) counts[outcomeLookup(a.id) ?? "unknown"] += 1;
  return counts;
}

// ── History (round 11, package D): past days, from real sessions' lastActive/startedAt ─────

export type HistoryRange = "today" | "week" | "all";

/** Most days of history to render even for "All" — this is a display cap, not a data cap
 *  (nothing is deleted); a very old install would otherwise render an unbounded page. */
const HISTORY_DAY_CAP = 60;

/** Local calendar day key, e.g. "2026-09-25" — the same grouping every other day-bucketed
 *  view in Alef uses (see automations.ts's localDate / server's localDateKey). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Yesterday" for that day, else a short weekday+date ("Wed, Sep 24"). */
export function historyDayLabel(day: string, now = Date.now()): string {
  if (day === dayKey(new Date(now - 86_400_000).toISOString())) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Which past days to show for a range, most recent first — always excludes today (the 4
 *  columns above already cover it). "week" = the last 7 rolling days; "all" = every day any
 *  agent (live or not) was last active on, capped. Real lastActive timestamps only. */
export function historyDayKeys(agents: readonly WorldAgent[], range: HistoryRange, now = Date.now()): readonly string[] {
  if (range === "today") return [];
  const today = dayKey(new Date(now).toISOString());
  const cutoff = range === "week" ? now - 7 * 86_400_000 : -Infinity;
  const days = new Set<string>();
  for (const a of agents) {
    const t = Date.parse(a.lastActive);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const k = dayKey(a.lastActive);
    if (k !== today) days.add(k);
  }
  return [...days].sort().reverse().slice(0, HISTORY_DAY_CAP);
}

export interface HistoryProjectGroup {
  islandId: string;
  agents: WorldAgent[];
}

export interface HistoryDayGroup {
  day: string;
  projects: HistoryProjectGroup[];
}

/** Finished sessions (not live — a live one belongs on the board above, not in history) by day
 *  then by project, newest agent first within a project, biggest project first within a day. */
export function groupHistoryByDayAndProject(agents: readonly WorldAgent[], days: readonly string[]): HistoryDayGroup[] {
  const dayset = new Set(days);
  const byDay = new Map<string, Map<string, WorldAgent[]>>();
  for (const a of agents) {
    if (a.status === "live") continue;
    const k = dayKey(a.lastActive);
    if (!dayset.has(k)) continue;
    const byProject = byDay.get(k) ?? new Map<string, WorldAgent[]>();
    byDay.set(k, byProject);
    const list = byProject.get(a.islandId) ?? [];
    list.push(a);
    byProject.set(a.islandId, list);
  }
  const out: HistoryDayGroup[] = [];
  for (const day of days) {
    const byProject = byDay.get(day);
    if (!byProject) continue;
    const projects = [...byProject.entries()]
      .map(([islandId, list]): HistoryProjectGroup => ({ islandId, agents: [...list].sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive)) }))
      .sort((a, b) => b.agents.length - a.agents.length);
    out.push({ day, projects });
  }
  return out;
}

/** Waiting on you this long and still untouched: the card is stale. */
export const STALE_WAITING_MS = 2 * 3_600_000;

/** Why a card needs a fix, or null: it failed, it was abandoned, or it has waited on you for
 *  STALE_WAITING_MS. Pure, exported for tests. */
export function staleReason(a: Pick<WorldAgent, "lastActive">, col: BoardColumn, outcome: KnownOutcome | null, now: number): string | null {
  if (outcome === "failed" || outcome === "abandoned") return outcome;
  const idle = now - Date.parse(a.lastActive);
  if (col === "waiting" && idle >= STALE_WAITING_MS) return `waiting on you for ${relativeTime(a.lastActive, now).replace(/ ago$/, "")}`;
  return null;
}

function staleFixHtml(a: WorldAgent, col: BoardColumn, now: number): string {
  return staleReason(a, col, outcomeOf(a.id), now) ? draftFixButtonHtml({ fix: a.id }, "b-fix") : "";
}

/** " 🎓" (a leading space, so it reads as part of the title) for a card whose outcome has a chip;
 *  "" for "active"/"unknown" — no badge for most sessions, which have no outcome evidence yet. */
function outcomeChipHtml(agentId: string): string {
  const chip = outcomeChip(outcomeOf(agentId) ?? "unknown");
  return chip ? ` <span class="b-outcome" title="${escapeHtml(chip.label)}">${chip.emoji}</span>` : "";
}

function draw(): void {
  const c = ctx;
  const host = document.getElementById("board-cols");
  if (!c || !host) return;
  const by = boardAgents([...c.store.agents.values()], state);
  const now = Date.now();
  const visible = COLUMNS.filter((col) => !(state.columns?.length) || state.columns.includes(col.id));
  host.innerHTML = visible
    .map((col) => {
      const list = by.get(col.id) ?? [];
      const shown = list.slice(0, col.id === "sleeping" ? 40 : 100);
      return `<section class="b-col b-${col.id}">
        <h3>${col.title} <span>${list.length}</span></h3>
        <ul>${shown
          .map(
            (a) => `<li><button type="button" data-agent="${escapeHtml(a.id)}" class="${a.id === selected ? "b-sel" : ""}" aria-pressed="${a.id === selected}">
              <span class="b-title">${escapeHtml(agentTitle(a))}${outcomeChipHtml(a.id)}</span>
              <span class="b-meta">${escapeHtml(a.islandId)} · ${escapeHtml(modelLabel(a.model))} · ${relativeTime(a.lastActive)}</span>
            </button>${staleFixHtml(a, col.id, now)}</li>`,
          )
          .join("")}${list.length > shown.length ? `<li class="b-more">+${list.length - shown.length} more</li>` : ""}${list.length === 0 ? `<li class="b-empty">${col.empty}</li>` : ""}</ul>
      </section>`;
    })
    .join("");
}

function queueDraw(): void {
  if (queued || !ctx) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    draw();
    drawHistory();
  });
}

/** Fetches each missing day's real report (sessions/events/tokens) once, then redraws with the
 *  stat line filled in. Never re-fetches a day that already answered (even with null/failure). */
async function loadReplayReports(days: readonly string[]): Promise<void> {
  const c = ctx;
  if (!c) return;
  const missing = days.filter((d) => !replayByDay.has(d));
  if (missing.length === 0) return;
  for (const d of missing) replayByDay.set(d, null);
  await Promise.all(
    missing.map(async (d) => {
      const res = await c.api.getJson<ReplayResponse>(`/api/replay?date=${d}`, 30_000);
      replayByDay.set(d, res?.ok ? res.report : null);
    }),
  );
  if (ctx === c) drawHistory();
}

function historyRow(a: WorldAgent): string {
  const list = ctx ? todoListFor(ctx, a.id) : undefined;
  const todo = list && list.items.length > 0 ? `<span class="board-history-todo">${escapeHtml(todoHeadline(list))}</span>` : "";
  return `<li><button type="button" data-agent="${escapeHtml(a.id)}" class="${a.id === selected ? "b-sel" : ""}" aria-pressed="${a.id === selected}">
    <span class="b-title">${escapeHtml(agentTitle(a))}${outcomeChipHtml(a.id)}</span>
    <span class="b-meta">${escapeHtml(modelLabel(a.model))} · ${relativeTime(a.lastActive)}</span>
    ${todo}
  </button></li>`;
}

/** The history section: day groups behind the Today/This week/All range switch (a sidebar
 *  "history" filter). Reuses the same data-agent click/dblclick delegation as the 4 columns
 *  above, so a past item selects (and can be stepped into) exactly the same way. */
function drawHistory(): void {
  const c = ctx;
  const host = root?.querySelector<HTMLElement>(".board-history");
  if (!host || !c) return;
  if (historyRange === "today") {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const agents = [...c.store.agents.values()];
  const days = historyDayKeys(agents, historyRange);
  const groups = groupHistoryByDayAndProject(agents, days);
  const islandName = (id: string): string => {
    const i = c.store.islands.get(id);
    return i ? cityDisplayName(i) : id;
  };
  host.innerHTML =
    groups.length === 0
      ? `<p class="board-history-empty">No finished sessions in this range yet.</p>`
      : groups
          .map((g) => {
            const report = replayByDay.get(g.day);
            const stat = report ? ` · ${report.sessions} session${report.sessions === 1 ? "" : "s"} · ${report.events.toLocaleString("en-US")} events` : "";
            return `<section class="board-history-day">
              <h3 class="board-history-day-h">${escapeHtml(historyDayLabel(g.day))}<span class="board-history-stat">${escapeHtml(stat)}</span></h3>
              ${g.projects
                .map(
                  (p) => `<div class="board-history-project">
                    <h4 class="board-history-project-h">${escapeHtml(islandName(p.islandId))} <span>${p.agents.length}</span></h4>
                    <ul class="board-history-list">${p.agents.map(historyRow).join("")}</ul>
                  </div>`,
                )
                .join("")}
            </section>`;
          })
          .join("");
  void loadReplayReports(days);
}

export const boardView: AlefView = {
  id: "board",
  emoji: "📋",
  name: "Board",
  hint: "Every agent, by what it is doing",
  keys: ["6", "b"],
  mount(r, c) {
    ctx = c;
    root = r;
    const sel = c.selection.get();
    selected = sel?.kind === "agent" ? sel.id : null;
    r.innerHTML = `<div class="board-view">
      ${viewHeader("Board", "Every agent, by what it is doing · click a card for details, double-click to step into its room", undefined, { icon: "board", className: "board-view-head" })}
    </div>`;
    const cols = document.getElementById("board-cols");
    if (cols) r.querySelector(".board-view")?.append(cols);
    const history = document.createElement("div");
    history.className = "board-history";
    history.hidden = true;
    r.querySelector(".board-view")?.append(history);
    cols?.addEventListener("click", onClick);
    cols?.addEventListener("dblclick", onDbl);
    history.addEventListener("click", onClick);
    history.addEventListener("dblclick", onDbl);
    if (!subscribed) {
      subscribed = true;
      c.store.onAgents(queueDraw);
      c.store.onSnapshot(queueDraw);
      onAgentStates(queueDraw); // a chip change (e.g. working -> waiting) can move a card's column
      onOutcomes(queueDraw); // a session graduating repaints its outcome chip and the filter counts
    }
    if (!todosSubscribed) {
      todosSubscribed = true;
      onTodosChange(() => {
        if (ctx) drawHistory(); // a lazily-fetched todo list for a past session landed
      });
    }
    draw();
    drawHistory();
  },
  unmount() {
    const cols = document.getElementById("board-cols");
    cols?.removeEventListener("click", onClick);
    cols?.removeEventListener("dblclick", onDbl);
    // Park the columns back in their home so agent-state's observer keeps its target.
    if (cols) document.getElementById("board-home")?.append(cols);
    ctx = null;
    root = null;
  },
  filters(c) {
    const allAgents = [...c.store.agents.values()];
    const byCol = boardAgents(allAgents, {});
    const byOutcome = outcomeCounts(allAgents);
    return [
      {
        id: "history",
        label: "History",
        type: "segmented",
        options: [
          { value: "today", label: "Today" },
          { value: "week", label: "This week" },
          { value: "all", label: "All" },
        ],
      },
      {
        id: "time",
        label: "Time",
        type: "segmented",
        options: [
          { value: "all", label: "Everything" },
          { value: "today", label: "Live + today" },
        ],
      },
      {
        id: "columns",
        label: "Columns",
        type: "chips",
        multi: true,
        options: COLUMNS.map((col) => ({ value: col.id, label: col.title, count: byCol.get(col.id)?.length ?? 0 })),
      },
      {
        id: "outcome",
        label: "Outcome",
        type: "chips",
        multi: true,
        options: SESSION_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_FILTER_LABEL[o], emoji: outcomeChip(o)?.emoji, count: byOutcome[o] })),
      },
      {
        id: "district",
        label: "Districts",
        type: "list",
        sortable: true,
        pinnable: true,
        limit: 12,
        options: cityListOptions(
          visibleIslands([...c.store.islands.values()], islandIdsWithAgents([...c.store.agents.values()]), archiveSummary()),
          [...c.store.agents.values()],
          { skipHarness: true },
        ),
      },
    ];
  },
  onFilter(next) {
    state = next;
    historyRange = (next.history?.[0] as HistoryRange | undefined) ?? "today";
    draw();
    drawHistory();
  },
  onSelect(sel: Selection | null) {
    selected = sel?.kind === "agent" ? sel.id : null;
    if (!root) return;
    for (const b of root.querySelectorAll<HTMLElement>("button[data-agent]")) {
      const on = b.dataset.agent === selected;
      b.classList.toggle("b-sel", on);
      b.setAttribute("aria-pressed", String(on));
    }
  },
  onFocus(on) {
    root?.classList.toggle("board-focus", on);
  },
};

function agentOf(ev: Event): string | undefined {
  const b = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-agent]") : null;
  return b?.dataset.agent;
}

function onClick(ev: Event): void {
  const fix = ev.target instanceof HTMLElement ? ev.target.closest<HTMLButtonElement>(".fx-draft") : null;
  if (fix) return draftStaleFix(fix);
  const id = agentOf(ev);
  if (id) ctx?.selection.set({ kind: "agent", id });
}

function onDbl(ev: Event): void {
  const id = agentOf(ev);
  if (id) ctx?.showView("room", id);
}

/** "Draft a fix" on a stale card: the session's own story in the prompt, its district selected. An
 *  abandoned one is also a Fix queue row (abandoned:<id>), so the fix's session is recorded there. */
function draftStaleFix(btn: HTMLButtonElement): void {
  const c = ctx;
  const a = btn.dataset.fix ? c?.store.agents.get(btn.dataset.fix) : undefined;
  if (!c || !a || btn.disabled) return;
  const outcome = outcomeOf(a.id);
  const why = staleReason(a, columnFor(a, Date.now()), outcome, Date.now()) ?? "stale";
  const prompt = sessionFixPrompt({ title: agentTitle(a), sessionId: a.id, outcome: why, reason: null, cwd: a.cwd });
  draftFix(c, { prompt, cityId: a.islandId, fixId: outcome === "abandoned" ? `abandoned:${a.id}` : null }, btn);
}
