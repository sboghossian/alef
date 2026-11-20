// "careers" (agent-city piece 3): the 🏛 Tower panel. Every automation lineage is a worker, shown
// in its department with a state chip, a strip of its last 10 runs, its cadence, last run,
// lifetime runs and the launchd routine that shares its name. Every state is computed by the
// server from real runs (server/features/careers-lib.ts); this file only draws GET /api/careers.
//
// Each worker also shows its trend: the clean rate of its last 10 runs with a verdict against the
// 10 before (careers-lib.ts trendOf), every count with its window. Only an automation lineage can
// have one: a one-off session runs once, so the panel says it has no career to measure.
//
// Clicks: a run on the strip flies to that session when it is on the planet; Retire / Un-retire
// (two clicks: arm, then confirm) and Name… go through runAction and only record intent in
// data/careers.json: they change what Alef displays, nothing else runs.
// Keys, names and reasons are untrusted text (titles, API error lines): textContent only (`h`).
//
// Panel id "careers" is fixed: campus-landmarks opens the Tower by it.

import "./careers.css";
import {
  CAREER_STATES,
  DEPARTMENTS,
  formatSpan,
  parseCareersResponse,
  parseCareersSummary,
  trendLine,
  trendSummaryLine,
  type CareerRun,
  type CareerTrend,
  type CareersActionResult,
  type CareersResponse,
  type CareerState,
  type CareerWorker,
  type RunMark,
} from "../../../shared/features/careers";
import { runAction } from "../ui/action";
import { careersMoved, offerCareers } from "./campus-data";
import { relativeTime } from "../ui/fuzzy";
import { h, isRecord } from "./fleet-overlay";
import { LOOPS_CONFIRM_WINDOW_MS, stepLaunchConfirm } from "./loops-lib";
import type { ClientContext, ClientFeature, ClientPanel } from "./registry";

const PANEL_ID = "careers";

const GLYPH: Record<RunMark, string> = { clean: "✓", wrote: "✎", failed: "✗", abandoned: "✗", stopped: "⏸", empty: "∅", unknown: "?" };

const STATE_LABEL: Record<CareerState, string> = {
  trusted: "🎓 trusted",
  probation: "↩ probation",
  enrolled: "enrolled",
  lapsed: "💤 lapsed",
  returned: "↺ returned",
  retired: "retired",
};

interface Host {
  el: HTMLElement;
  ctx: ClientContext;
}

let host: Host | null = null;
let data: CareersResponse | null = null;
/** Retire / Un-retire buttons armed by a first click (key → armed at). */
let armed = new Map<string, number>();
/** The worker whose Name… editor is open, and what has been typed there (it survives a redraw). */
let naming: string | null = null;
let nameDraft = "";
/** A worker to scroll to and mark once the panel has drawn (openTowerAt: the Home view's rows). */
let focusKey: string | null = null;

/** Opens the Tower scrolled to one worker (by its automationKey), marked until the next redraw. */
export function openTowerAt(ctx: ClientContext, key: string): void {
  focusKey = key;
  ctx.openPanel(PANEL_ID);
}

function dateOf(at: string, dayOnly: boolean): string {
  return dayOnly ? at : new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function cadenceText(w: CareerWorker): string {
  if (w.medianGapMs === null) return "one run so far";
  return `about every ${formatSpan(w.medianGapMs)} (median gap of its last ${Math.min(w.runs.length, 10)} runs)`;
}

function lastRunText(w: CareerWorker): string {
  if (!w.lastRunAt) return "no dated run";
  return w.lastRunAt.length === 10 ? `last run ${w.lastRunAt}` : `last run ${relativeTime(w.lastRunAt)}`;
}

function summaryLine(d: CareersResponse): string {
  const s = d.summary;
  const parts = CAREER_STATES.filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`);
  return `${s.total} worker${s.total === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

function inputsLine(d: CareersResponse): string {
  const i = d.inputs;
  const archive = i.archiveLoaded ? `${i.archivedRuns} archived` : "the archive (not loaded yet)";
  return `From ${i.liveRuns} indexed sessions and ${archive}; verdicts from ${i.outcomeRecords} outcome records. Archived runs have no transcript, so they never count. A launchd exit code never counts.`;
}

function localDay(at: string): string {
  return at.length === 10 ? at : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function trendEl(t: CareerTrend | undefined): HTMLElement {
  if (!t) return h("p", "cr-meta cr-trend", "No trend: the server sent none for this worker.");
  const dir = t.deltaPts === null ? "" : t.deltaPts > 0 ? " cr-trend-up" : t.deltaPts < 0 ? " cr-trend-down" : "";
  const el = h("p", `cr-meta cr-trend${dir}`, trendLine(t, localDay));
  el.title = "Clean = outcomes says shipped, delivered or finished. Only wrote, failed, stopped, abandoned and empty runs are not clean. Archived, live and not-yet-judged runs are in neither window.";
  return el;
}

function stripEl(w: CareerWorker, ctx: ClientContext): HTMLElement {
  const strip = h("div", "cr-strip");
  strip.setAttribute("aria-label", `last ${w.runs.length} runs, oldest first`);
  // Oldest on the left, newest on the right.
  for (const run of [...w.runs].reverse()) strip.append(runEl(run, ctx));
  return strip;
}

function runEl(run: CareerRun, ctx: ClientContext): HTMLElement {
  const onPlanet = ctx.store.agents.has(run.id);
  const tip = `${dateOf(run.at, run.dayOnly)} · ${run.mark}: ${run.why}${onPlanet ? " (click to fly there)" : run.archived ? " (a fossil: not on the planet as a house)" : ""}`;
  const el = onPlanet ? h("button", `cr-run cr-${run.mark}`, GLYPH[run.mark]) : h("span", `cr-run cr-${run.mark}`, GLYPH[run.mark]);
  el.title = tip;
  el.setAttribute("aria-label", tip);
  if (el instanceof HTMLButtonElement) {
    el.type = "button";
    el.addEventListener("click", () => ctx.flyTo(run.id));
  }
  return el;
}

function post(ctx: ClientContext, key: string, action: "retire" | "unretire" | "name", body: Record<string, unknown>): Promise<CareersActionResult> {
  return ctx.api.postJson<CareersActionResult>(`/api/careers/${encodeURIComponent(key)}/${action}`, { confirm: true, ...body }, (error) => ({ ok: false, error }));
}

function retireButton(w: CareerWorker, ctx: ClientContext, status: HTMLElement): HTMLElement {
  const retired = w.state === "retired" || w.state === "returned";
  const action = retired ? "unretire" : "retire";
  const idle = retired ? "Un-retire…" : "Retire…";
  const confirm = retired ? "Confirm un-retire?" : "Confirm retire?";
  const armedAt = armed.get(w.key);
  const armedNow = armedAt !== undefined && Date.now() - armedAt < LOOPS_CONFIRM_WINDOW_MS;
  const btn = h("button", `comic-btn small cr-act${armedNow ? " cr-armed" : ""}`, armedNow ? confirm : idle);
  /** Puts this button back to its first step when the confirm window closes (only this button:
   *  a full redraw would wipe a Name… being typed elsewhere). */
  const disarmLater = (at: number): void => {
    setTimeout(() => {
      if (armed.get(w.key) !== at || btn.getAttribute("aria-busy") === "true") return; // fired or re-armed meanwhile
      btn.textContent = idle;
      btn.classList.remove("cr-armed");
    }, Math.max(0, at + LOOPS_CONFIRM_WINDOW_MS - Date.now()) + 100);
  };
  if (armedNow) disarmLater(armedAt); // re-created armed by a redraw inside the window
  btn.type = "button";
  btn.title = retired ? "Show it as a working worker again. Only changes what Alef displays." : "Show it as retired in the Tower. Only changes what Alef displays: no launchd job, skill or transcript is touched.";
  btn.addEventListener("click", () => {
    const step = stepLaunchConfirm(armed, w.key, Date.now());
    armed = step.pending;
    if (!step.fire) {
      btn.textContent = confirm;
      btn.classList.add("cr-armed");
      const at = armed.get(w.key);
      if (at !== undefined) disarmLater(at);
      return;
    }
    void runAction<CareersActionResult>({
      label: retired ? "Un-retire" : "Retire",
      run: () => post(ctx, w.key, action, {}),
      success: () => (retired ? `${w.key} is back in the Tower as a working worker.` : `${w.key} retired in the Tower. Nothing else changed: no launchd job, skill or transcript was touched.`),
      toast: ctx.toast,
      button: btn,
      status,
    }).then((r) => {
      if (r.ok) void load();
    });
  });
  return btn;
}

function nameEditor(w: CareerWorker, ctx: ClientContext, status: HTMLElement): HTMLElement {
  const wrap = h("div", "cr-name-edit");
  const input = h("input", "cr-name-input");
  input.type = "text";
  input.maxLength = 40;
  input.value = nameDraft;
  input.addEventListener("input", () => {
    nameDraft = input.value;
  });
  input.placeholder = "A name for this worker (empty clears it)";
  input.setAttribute("aria-label", `Display name for ${w.key}`);
  const save = h("button", "comic-btn small", "Save name");
  save.type = "button";
  const cancel = h("button", "comic-btn small", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    naming = null;
    draw();
  });
  const submit = (): void => {
    const name = input.value.trim() || null;
    void runAction<CareersActionResult>({
      label: "Name",
      run: () => post(ctx, w.key, "name", { name }),
      success: (r) => (r.name ? `${w.key} is now shown as ${r.name}.` : `${w.key} has no display name now.`),
      toast: ctx.toast,
      button: save,
      status,
    }).then((r) => {
      if (!r.ok) return;
      naming = null;
      void load();
    });
  };
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });
  wrap.append(input, save, cancel);
  return wrap;
}

function workerEl(w: CareerWorker, trend: CareerTrend | undefined, ctx: ClientContext): HTMLElement {
  const li = h("li", `cr-worker cr-is-${w.state}`);
  li.dataset.key = w.key;
  const top = h("div", "cr-top");
  const name = h("span", "cr-name", w.name ?? w.key);
  if (w.name) name.title = w.key;
  top.append(name);
  if (w.name) top.append(h("span", "cr-key", w.key));
  const chip = h("span", `cr-chip cr-chip-${w.state}`, STATE_LABEL[w.state]);
  chip.title = w.state === w.standing ? w.reason : `${w.state} (its runs alone say: ${w.standing})`;
  top.append(chip);
  li.append(top, h("p", "cr-reason", w.reason));
  if (w.trustedSince) li.append(h("p", "cr-meta", `trusted since ${w.trustedSince.length === 10 ? w.trustedSince : new Date(w.trustedSince).toLocaleDateString()}`));
  li.append(w.runs.length ? stripEl(w, ctx) : h("p", "cr-meta", "no dated runs to show"), trendEl(trend));
  const life = w.lifetime;
  li.append(
    h(
      "p",
      "cr-meta",
      `${cadenceText(w)} · ${lastRunText(w)} · ${life.total} runs lifetime (${life.live} indexed, ${life.archived} archived) · ${life.clean} clean · ${life.wrote} only wrote · ${life.bad} bad`,
    ),
  );
  if (w.routine) {
    const r = w.routine;
    const exit = r.lastExitStatus === null ? "no exit status yet" : `last exit ${r.lastExitStatus}`;
    const line = h("p", "cr-meta cr-routine", `⏰ ${r.label} · ${r.schedule} · ${r.running ? "running now · " : ""}${exit} (exit 0 is not proof it did anything)`);
    line.title = "The launchd routine with this worker's exact name. Shown, never used as proof: a headless run can exit 0 having done nothing.";
    li.append(line);
  }
  const status = h("p", "cr-status");
  status.setAttribute("role", "status");
  const actions = h("div", "cr-actions");
  actions.append(retireButton(w, ctx, status));
  if (naming === w.key) {
    li.append(actions, nameEditor(w, ctx, status), status);
  } else {
    const nameBtn = h("button", "comic-btn small cr-act", "Name…");
    nameBtn.type = "button";
    nameBtn.title = "Give this worker a display name (stored in Alef only).";
    nameBtn.addEventListener("click", () => {
      naming = w.key;
      nameDraft = w.name ?? "";
      draw();
    });
    actions.append(nameBtn);
    li.append(actions, status);
  }
  return li;
}

function draw(): void {
  const hst = host;
  if (!hst) return;
  if (!data) return;
  const d = data;
  const wrap = h("div", "cr-panel");
  wrap.append(
    h("p", "cr-summary", summaryLine(d)),
    h("p", "cr-sub", inputsLine(d)),
    h("p", "cr-sub cr-trend-head", trendSummaryLine(d.trends)),
    h("p", "cr-sub", "Only automations have careers: a lineage that runs again and again under the same name. A one-off session runs once, so it has no runs to compare and no career."),
  );
  const trends = new Map(d.trends.map((t) => [t.key, t]));
  if (d.workers.length === 0) {
    wrap.append(h("p", "cr-none", "No automation lineage found in the indexed or archived sessions."));
  }
  for (const dept of DEPARTMENTS) {
    const workers = d.workers.filter((w) => w.department === dept).sort((a, b) => Number(a.state === "retired") - Number(b.state === "retired"));
    if (workers.length === 0) continue;
    const section = h("section", "cr-dept");
    section.append(h("h3", "cr-dept-h", `${dept} (${workers.length})`));
    const ul = h("ul", "cr-workers");
    for (const w of workers) ul.append(workerEl(w, trends.get(w.key), hst.ctx));
    section.append(ul);
    wrap.append(section);
  }
  hst.el.replaceChildren(wrap);
  if (focusKey !== null) {
    const key = focusKey;
    focusKey = null;
    const li = [...wrap.querySelectorAll<HTMLElement>(".cr-worker")].find((el) => el.dataset.key === key);
    if (li) {
      li.classList.add("cr-focus");
      li.scrollIntoView({ block: "center" });
    }
  }
}

async function load(): Promise<void> {
  const hst = host;
  if (!hst) return;
  const raw = await hst.ctx.api.getJson<unknown>("/api/careers", 15_000);
  offerCareers(raw); // the campus's banners and 🎓 callouts read the same answer: no second scan
  if (host !== hst) return; // reopened while this was in flight
  const parsed = parseCareersResponse(raw);
  if (!parsed) {
    if (!data) hst.el.replaceChildren(h("p", "cr-sub", "Couldn't load the Tower from the world server."));
    return;
  }
  data = parsed;
  draw();
}

function renderPanel(el: HTMLElement, ctx: ClientContext): void {
  host = { el, ctx };
  data = null;
  armed = new Map();
  naming = null;
  el.replaceChildren(h("p", "cr-sub", "Loading the Tower…"));
  void load();
}

const towerPanel: ClientPanel = { id: PANEL_ID, title: "🏛 Tower", render: renderPanel };

export const careersFeature: ClientFeature = {
  id: "careers",
  onMessage(msg) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "summary" || !parseCareersSummary(p.summary)) return;
    // The server's states moved: refresh the panel when it is on screen (never while naming); its
    // answer is offered to the campus. Otherwise the campus re-reads the workers itself.
    if (host?.el.isConnected && naming === null) void load();
    else careersMoved();
  },
  paletteCommands: (ctx) => [
    { id: "open", title: "Tower…", kind: "panel", keywords: ["tower", "workers", "careers", "graduation", "department", "automations", "retire"], run: () => ctx.openPanel(PANEL_ID) },
  ],
  hudButtons: [{ id: "open", label: "🏛", title: "Tower: automation workers and their careers", text: "Tower", placement: "menu", onClick: (ctx) => ctx.openPanel(PANEL_ID) }],
  panels: [towerPanel],
};
