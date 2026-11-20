// Logs tab (right sidebar, #alef-pane-logs): the whole town's log, read-only. Server lines,
// every UI action click with its outcome, and feed events (minus "activity" — the Feed tab
// already shows that). See docs/FEATURES.md and the CONTRACT in shared/features/logs.ts.
//
// Loads GET /api/logs on mount, merges WS pushes by seq (dedupe + coalesced-repeat replace),
// and re-syncs on every onSnapshot after the first (that one coincides with mount's own load) —
// a WS reconnect. A different bootId means the server restarted: a full reload replaces the
// buffer instead of merging into it.

import type { LogEntry } from "../../../shared/features/logs";
import type { ClientContext, ClientFeature } from "./registry";
import "./logs.css";
import {
  actionSummary,
  bootChanged,
  classifyLogsClick,
  copyLine,
  copyLines,
  defaultFilterState,
  filterEntries,
  isFailure,
  isLogsMessage,
  isLogsResponse,
  keepValidEntries,
  LogsSync,
  mergeBySeq,
  relativeLabel,
  RENDER_CAP,
  scopesSeen,
  sortNewestFirst,
  visibleRows,
  type LevelFilter,
  type LogFilterState,
  type SourceFilter,
} from "./logs-lib";

const TIME_REFRESH_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 150;
const INITIAL_LIMIT = 2000;

interface LogsState {
  filters: LogFilterState;
  paused: boolean;
  pausedBuffer: LogEntry[];
  visibleLimit: number;
  loading: boolean;
  loadError: string | null;
}

function initialState(): LogsState {
  return { filters: defaultFilterState(), paused: false, pausedBuffer: [], visibleLimit: RENDER_CAP, loading: true, loadError: null };
}

let pane: HTMLElement | null = null;
let body: HTMLElement | null = null;
const state = initialState();
// Entries/bootId/cursor live here, not in `state` above — see LogsSync's own doc comment for why
// the restart race needs them tracked together as a single, DOM-free unit.
const sync = new LogsSync();
let sawFirstSnapshot = false;
let timeTimer: ReturnType<typeof setInterval> | null = null;
// Single-flight: a restart can be noticed by both onMessage and a reconnect's onSnapshot at once;
// only one GET /api/logs?limit= should ever be in flight, and both callers await the same one.
let loadPromise: Promise<void> | null = null;

function q<T extends HTMLElement>(sel: string): T | null {
  return pane?.querySelector<T>(sel) ?? null;
}

function paneHtml(): string {
  return `
  <div class="lg-toolbar">
    <select class="lg-level" aria-label="Minimum level">
      <option value="all">All levels</option>
      <option value="warn-error">Warnings and errors</option>
      <option value="error">Errors only</option>
    </select>
    <select class="lg-source" aria-label="Source">
      <option value="all">All sources</option>
      <option value="server">Server</option>
      <option value="action">Actions</option>
      <option value="feed">Feed</option>
    </select>
    <select class="lg-scope" aria-label="Feature">
      <option value="">Every feature</option>
    </select>
    <label class="lg-check"><input type="checkbox" class="lg-actions-only" /> Actions only</label>
    <label class="lg-check"><input type="checkbox" class="lg-failures-only" /> Failures only</label>
    <input type="search" class="lg-search" placeholder="Search the log…" aria-label="Search the log" />
    <button type="button" class="lg-follow on" aria-pressed="true" title="Following: new lines appear at the top. Click to pause.">▶ Following</button>
    <button type="button" class="lg-copy-all" title="Copy every visible row as plain text">Copy visible (<span class="lg-copy-count">0</span>)</button>
  </div>
  <button type="button" class="lg-resume-pill" hidden></button>
  <div class="lg-body" role="log" aria-label="Town log"></div>
  <button type="button" class="lg-older" hidden>Show older</button>`;
}

// ---------------------------------------------------------------- data

/** Single-flight: concurrent callers (a WS push noticing a restart, a reconnect's own reload)
 *  all await the one in-flight GET instead of firing another. */
async function fullLoad(ctx: ClientContext): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    state.loading = sync.entries.length === 0;
    render();
    const res = await ctx.api.getJson<unknown>(`/api/logs?limit=${INITIAL_LIMIT}`, 12_000);
    state.loading = false;
    if (!isLogsResponse(res)) {
      state.loadError = "no answer from the world server";
      render();
      return;
    }
    sync.applyReload(res);
    state.loadError = null;
    state.pausedBuffer = [];
    render();
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function reloadSince(ctx: ClientContext): Promise<void> {
  if (sync.bootId === null) return void fullLoad(ctx);
  const res = await ctx.api.getJson<unknown>(`/api/logs?since=${sync.cursor}`, 12_000);
  if (!isLogsResponse(res)) return; // a reconnect probe failing silently keeps the last good log
  if (bootChanged(sync.bootId, res.bootId)) return void fullLoad(ctx);
  adopt(keepValidEntries(res.entries));
}

/** New/updated entries from a WS push or a re-sync fetch: merged live, or held back while paused. */
function adopt(incoming: readonly LogEntry[]): void {
  if (incoming.length === 0) return;
  if (state.paused) {
    state.pausedBuffer = mergeBySeq(state.pausedBuffer, incoming);
  } else {
    sync.adopt(incoming);
  }
  state.loadError = null;
  render();
}

function resume(): void {
  if (state.pausedBuffer.length > 0) {
    sync.adopt(state.pausedBuffer);
    state.pausedBuffer = [];
  }
  state.paused = false;
  render();
}

// ---------------------------------------------------------------- render

function emptyText(): string {
  return "Nothing logged yet. Server lines and feed events land here — action results will too, once job 2's click-feedback emitter is wired in. Agent tool calls stay in the Feed tab.";
}

function buildRow(e: LogEntry, nowMs: number): HTMLElement {
  const row = document.createElement("div");
  row.className = `lg-row lg-lvl-${e.level}`;
  row.dataset.seq = String(e.seq);

  const time = document.createElement("span");
  time.className = "lg-time";
  time.textContent = relativeLabel(e.ts, nowMs);
  time.title = e.ts;
  row.append(time);

  const body2 = document.createElement("span");
  body2.className = "lg-line";
  if (e.action) {
    const ok = document.createElement("span");
    ok.className = `lg-ok ${e.action.ok ? "lg-ok-yes" : "lg-ok-no"}`;
    ok.textContent = e.action.ok ? "✓" : "✗";
    ok.setAttribute("aria-hidden", "true");
    body2.append(ok);
    const summary = document.createElement("span");
    summary.className = e.action.ok ? "lg-msg" : "lg-msg lg-fail";
    summary.textContent = actionSummary(e.action);
    body2.append(summary);
  } else {
    const scope = document.createElement("span");
    scope.className = "lg-scope-tag";
    scope.textContent = e.scope;
    body2.append(scope);
    const msg = document.createElement("span");
    msg.className = "lg-msg";
    msg.textContent = e.message;
    body2.append(msg);
  }
  row.append(body2);

  if (e.detail) {
    const detail = document.createElement("span");
    detail.className = "lg-detail";
    detail.textContent = e.detail;
    row.append(detail);
  }
  if (e.repeat > 1) {
    const rep = document.createElement("span");
    rep.className = "lg-repeat";
    rep.textContent = `×${e.repeat}`;
    row.append(rep);
  }
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "lg-copy-row";
  copyBtn.title = "Copy this line";
  copyBtn.textContent = "Copy";
  copyBtn.dataset.seq = String(e.seq);
  row.append(copyBtn);
  return row;
}

function syncScopeOptions(): void {
  const sel = q<HTMLSelectElement>(".lg-scope");
  if (!sel) return;
  const current = sel.value;
  const scopes = scopesSeen(sync.entries);
  sel.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Every feature";
  sel.append(all);
  for (const s of scopes) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.append(opt);
  }
  if (scopes.includes(current) || current === "") sel.value = current;
  else {
    sel.value = "";
    state.filters = { ...state.filters, scope: null };
  }
}

function render(): void {
  if (!pane || pane.hidden || !body) return;
  syncScopeOptions();

  const follow = q<HTMLButtonElement>(".lg-follow");
  if (follow) {
    follow.classList.toggle("on", !state.paused);
    follow.setAttribute("aria-pressed", String(!state.paused));
    follow.textContent = state.paused ? "⏸ Paused" : "▶ Following";
    follow.title = state.paused ? "Paused: click to follow again." : "Following: new lines appear at the top. Click to pause.";
  }
  const pill = q<HTMLButtonElement>(".lg-resume-pill");
  if (pill) {
    const n = state.pausedBuffer.length;
    pill.hidden = !state.paused || n === 0;
    pill.textContent = `${n} new · Resume`;
  }

  if (state.loading && sync.entries.length === 0) {
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "lg-empty";
    p.textContent = "Loading the log…";
    body.append(p);
    const older = q<HTMLButtonElement>(".lg-older");
    if (older) older.hidden = true;
    const count = q<HTMLElement>(".lg-copy-count");
    if (count) count.textContent = "0";
    return;
  }

  if (state.loadError && sync.entries.length === 0) {
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "lg-empty lg-error";
    p.textContent = `Could not load the log: ${state.loadError}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "lg-retry";
    retry.textContent = "Retry";
    body.append(p, retry);
    const older = q<HTMLButtonElement>(".lg-older");
    if (older) older.hidden = true;
    return;
  }

  const filtered = filterEntries(sync.entries, state.filters);
  const sorted = sortNewestFirst(filtered);
  const { rows, remaining } = visibleRows(sorted, state.visibleLimit);

  const count = q<HTMLElement>(".lg-copy-count");
  if (count) count.textContent = String(rows.length);

  body.replaceChildren();
  if (state.loadError) {
    const warn = document.createElement("p");
    warn.className = "lg-refresh-warn";
    warn.textContent = `Could not refresh just now: ${state.loadError}`;
    body.append(warn);
  }
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "lg-empty";
    p.textContent = sync.entries.length === 0 ? emptyText() : "No log lines match these filters.";
    body.append(p);
  } else {
    const now = Date.now();
    for (const e of rows) body.append(buildRow(e, now));
  }
  const older = q<HTMLButtonElement>(".lg-older");
  if (older) older.hidden = remaining <= 0;
}

// ---------------------------------------------------------------- wiring

function readFilters(): void {
  const level = (q<HTMLSelectElement>(".lg-level")?.value ?? "all") as LevelFilter;
  const source = (q<HTMLSelectElement>(".lg-source")?.value ?? "all") as SourceFilter;
  const scope = q<HTMLSelectElement>(".lg-scope")?.value || null;
  const actionsOnly = q<HTMLInputElement>(".lg-actions-only")?.checked ?? false;
  const failuresOnly = q<HTMLInputElement>(".lg-failures-only")?.checked ?? false;
  const query = q<HTMLInputElement>(".lg-search")?.value ?? "";
  state.filters = { level, source, scope, actionsOnly, failuresOnly, query };
  state.visibleLimit = RENDER_CAP;
  render();
}

function copyText(ctx: ClientContext, text: string): void {
  navigator.clipboard.writeText(text).catch(() => ctx.toast("Could not copy to the clipboard.", "error"));
}

function wire(ctx: ClientContext, el: HTMLElement): void {
  el.querySelector(".lg-level")?.addEventListener("change", readFilters);
  el.querySelector(".lg-source")?.addEventListener("change", readFilters);
  el.querySelector(".lg-scope")?.addEventListener("change", readFilters);
  el.querySelector(".lg-actions-only")?.addEventListener("change", readFilters);
  el.querySelector(".lg-failures-only")?.addEventListener("change", readFilters);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  el.querySelector(".lg-search")?.addEventListener("input", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(readFilters, SEARCH_DEBOUNCE_MS);
  });

  el.querySelector(".lg-follow")?.addEventListener("click", () => {
    if (state.paused) resume();
    else {
      state.paused = true;
      render();
    }
  });
  el.querySelector(".lg-resume-pill")?.addEventListener("click", resume);
  el.querySelector(".lg-older")?.addEventListener("click", () => {
    state.visibleLimit += RENDER_CAP;
    render();
  });
  // One delegated listener for every button the pane can show, including ones render() creates
  // later (rows, and the Retry button in the error state) — binding to them at mount time, before
  // they exist, would never fire (that was the Retry button's actual bug).
  el.addEventListener("click", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null;
    const btn = t?.closest<HTMLButtonElement>("button");
    if (!btn) return;
    const action = classifyLogsClick(btn.classList);
    if (action === "retry") {
      void fullLoad(ctx);
      return;
    }
    if (action === "copy-all") {
      const filtered = filterEntries(sync.entries, state.filters);
      const { rows } = visibleRows(sortNewestFirst(filtered), state.visibleLimit);
      copyText(ctx, copyLines(rows));
      return;
    }
    if (action === "copy-row") {
      const seq = Number(btn.dataset.seq);
      const entry = sync.entries.find((e) => e.seq === seq);
      if (entry) copyText(ctx, copyLine(entry));
    }
  });
}

export const logsFeature: ClientFeature = {
  id: "logs",
  mount(ctx) {
    const el = document.getElementById("alef-pane-logs");
    if (!el) return;
    pane = el;
    el.innerHTML = paneHtml();
    body = el.querySelector(".lg-body");
    wire(ctx, el);
    void fullLoad(ctx);
    const onVisibility = (): void => {
      if (!el.hidden) {
        render();
        timeTimer ??= setInterval(() => {
          if (!pane || pane.hidden) return;
          const now = Date.now();
          pane.querySelectorAll<HTMLElement>(".lg-row").forEach((row) => {
            const seq = Number(row.dataset.seq);
            const entry = sync.entries.find((e) => e.seq === seq);
            const time = row.querySelector<HTMLElement>(".lg-time");
            if (entry && time) time.textContent = relativeLabel(entry.ts, now);
          });
        }, TIME_REFRESH_MS);
      } else if (timeTimer) {
        clearInterval(timeTimer);
        timeTimer = null;
      }
    };
    new MutationObserver(onVisibility).observe(el, { attributes: true, attributeFilter: ["hidden"] });
    onVisibility();
  },
  onSnapshot(_world, ctx) {
    // The very first call coincides with mount() in the same host.mount() pass; mount's own
    // fullLoad already covers it. Every later call is a genuine WS reconnect.
    if (!sawFirstSnapshot) {
      sawFirstSnapshot = true;
      return;
    }
    void reloadSince(ctx);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isLogsMessage(p)) return;
    const entries = keepValidEntries(p.entries);
    if (bootChanged(sync.bootId, p.bootId)) {
      // A restart: seq numbering from the loaded boot is stale. Buffer the push (never merge it
      // into the stale boot's entries) and trigger the single-flight full reload directly —
      // critically, WITHOUT updating sync.bootId here. If this push had advanced it, a concurrent
      // reconnect's own reloadSince would see the boot as "already handled" and merge its delta
      // onto a dead cursor instead of reloading (the reported corruption).
      sync.bufferForReload(entries);
      void fullLoad(ctx);
      return;
    }
    adopt(entries);
  },
  paletteCommands(ctx) {
    return [{ id: "open", title: "Logs", meta: "The whole town's log: server lines, feed events, and (once wired) action results", keywords: ["log", "logs", "console", "debug"], run: () => ctx.openRightTab("logs") }];
  },
};
