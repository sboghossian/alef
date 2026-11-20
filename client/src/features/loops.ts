// Loops tab (right sidebar): an open-loops board merging whatsup's ranked todos.json with
// Alef's own live scan of every tasks/todo.md. Badge = count of "Do today". `task`/`project`
// text originates in todo.md files and whatsup's vault/memory aggregation — untrusted data,
// always rendered through escapeHtml.

import { LOOPS_LENS_META, LOOPS_LENS_ORDER, type LoopsActionResult, type LoopsBoard, type LoopsItem } from "../../../shared/features/loops";
import { escapeHtml, relativeTime } from "../ui/fuzzy";
import { launchInFlight, runLaunchOnce, trustRelaunchAction } from "../ui/launch-result";
import "./loops.css";
import { filterLoopsItems, groupLoopsByLens, isRecord, launchToast, loopsSourceLabel, parseLoopsBoard, stepLaunchConfirm } from "./loops-lib";
import type { ClientContext, ClientFeature } from "./registry";

export interface LoopsPaneHandlers {
  onOpen(id: string): void;
  /** Called only after the row's confirm click has fired (see stepLaunchConfirm). The pane
   *  re-renders when it settles, so a busy button goes back to normal. */
  onLaunch(id: string, button: () => HTMLButtonElement | null): Promise<unknown> | void;
  setBadge(n: number): void;
}

export interface LoopsPane {
  render(board: LoopsBoard): void;
}

/** The in-flight key a loops launch runs under (launch-result.ts runLaunchOnce). */
export function loopsLaunchKey(id: string): string {
  return `loops:${id}`;
}

function rowHtml(item: LoopsItem, now: number, armed: boolean): string {
  const age = item.updatedAt ? relativeTime(item.updatedAt, now) : "";
  const openBtn = item.openPath ? `<button type="button" class="lp-btn" data-action="open" data-id="${escapeHtml(item.id)}">Open</button>` : "";
  const busy = launchInFlight(loopsLaunchKey(item.id));
  const launchBtn = item.launchCwd
    ? `<button type="button" class="lp-btn lp-btn-launch${armed ? " lp-confirm" : ""}" data-action="launch" data-id="${escapeHtml(item.id)}"${busy ? ' disabled aria-busy="true"' : ""}>${
        busy ? "Starting…" : armed ? "Confirm ▶?" : "▶ Launch"
      }</button>`
    : "";
  const actions = openBtn || launchBtn ? `<div class="lp-actions">${openBtn}${launchBtn}</div>` : "";
  return `<li class="lp-item" data-id="${escapeHtml(item.id)}">
    <div class="lp-row">
      <span class="lp-project">${escapeHtml(item.project)}</span>
      <span class="lp-task">${escapeHtml(item.task)}</span>
      ${age ? `<span class="lp-age">${escapeHtml(age)}</span>` : ""}
      <span class="lp-src">via ${escapeHtml(loopsSourceLabel(item.sources))}</span>
    </div>
    ${actions}
  </li>`;
}

/** Fills the shell's pre-existing Loops pane: a persistent filter box (its own DOM node
 *  survives every re-render, so typing never loses focus) above a lens-grouped item list. */
export function mountLoopsPane(pane: HTMLElement, handlers: LoopsPaneHandlers): LoopsPane {
  pane.innerHTML = `<div class="lp-toolbar"><input type="search" class="lp-filter" placeholder="Filter by project or task…" aria-label="Filter loops" /></div><div class="lp-list"></div>`;
  const filterInput = pane.querySelector<HTMLInputElement>(".lp-filter");
  const listEl = pane.querySelector<HTMLElement>(".lp-list");

  let latest: LoopsBoard | null = null;
  let query = "";
  let confirming = new Map<string, number>();

  function renderList(): void {
    if (!listEl) return;
    if (!latest) {
      listEl.innerHTML = `<div class="lp-empty">Loading open loops…</div>`;
      return;
    }
    const now = Date.now();
    const groups = groupLoopsByLens(filterLoopsItems(latest.items, query));
    const sections = LOOPS_LENS_ORDER.map((lens) => {
      const items = groups.get(lens) ?? [];
      if (items.length === 0) return "";
      const meta = LOOPS_LENS_META[lens];
      const rows = items.map((item) => rowHtml(item, now, confirming.has(item.id))).join("");
      return `<div class="lp-lens" data-lens="${lens}"><h3 class="alef-pane-h">${meta.emoji} ${escapeHtml(meta.title)} <span class="alef-fcount">${items.length}</span></h3><ul class="lp-items">${rows}</ul></div>`;
    }).join("");
    const warn = latest.whatsupOk
      ? ""
      : `<p class="lp-whatsup-warn">whatsup's board could not be read${latest.whatsupError ? `: ${escapeHtml(latest.whatsupError)}` : ""} — showing Alef's own scan only.</p>`;
    listEl.innerHTML = sections ? warn + sections : warn + `<div class="lp-empty">${query ? "No loops match your filter." : "No open loops. Nice."}</div>`;
  }

  filterInput?.addEventListener("input", () => {
    query = filterInput.value;
    renderList();
  });

  pane.addEventListener("click", (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("button[data-action]") : null;
    const id = btn?.dataset.id;
    const action = btn?.dataset.action;
    if (!id || !action) return;
    if (action === "open") {
      handlers.onOpen(id);
      return;
    }
    if (action === "launch") {
      if (launchInFlight(loopsLaunchKey(id))) return;
      const step = stepLaunchConfirm(confirming, id, Date.now());
      confirming = step.pending;
      if (!step.fire) return renderList();
      const button = (): HTMLButtonElement | null => listEl?.querySelector<HTMLButtonElement>(`button[data-action="launch"][data-id="${CSS.escape(id)}"]`) ?? null;
      const settled = Promise.resolve(handlers.onLaunch(id, button));
      renderList(); // draws it busy (the launch is in flight by now)
      void settled.finally(renderList);
    }
  });

  return {
    render(board) {
      latest = board;
      handlers.setBadge(board.badge);
      renderList();
    },
  };
}

async function openItem(ctx: ClientContext, id: string): Promise<void> {
  const result = await ctx.api.postJson<LoopsActionResult>(`/api/loops/${encodeURIComponent(id)}/open`, {}, (error) => ({ ok: false, error }));
  ctx.toast(result.ok ? "Opened in VS Code." : `could not open: ${result.error ?? "unknown error"}`, result.ok ? "info" : "error");
}

async function launchItem(ctx: ClientContext, id: string, button: () => HTMLButtonElement | null): Promise<void> {
  await runLaunchOnce<LoopsActionResult>(loopsLaunchKey(id), {
    label: "Launch",
    run: () => ctx.api.postJson<LoopsActionResult>(`/api/loops/${encodeURIComponent(id)}/launch`, {}, (error) => ({ ok: false, error })),
    success: (r) => launchToast(r).text,
    successKind: (r) => launchToast(r).kind,
    failure: (r) => launchToast(r).text,
    action: (r) => trustRelaunchAction(ctx.api, ctx.toast, r),
    toast: ctx.toast,
    button,
  });
}

let pane: LoopsPane | null = null;

export const loopsFeature: ClientFeature = {
  id: "loops",
  mount(ctx) {
    const el = document.getElementById("alef-pane-loops");
    if (!el) return;
    pane = mountLoopsPane(el, {
      onOpen: (id) => void openItem(ctx, id),
      onLaunch: (id, button) => launchItem(ctx, id, button),
      setBadge: (n) => {
        const badge = document.getElementById("alef-badge-loops");
        if (!badge) return;
        badge.hidden = n === 0;
        badge.textContent = String(n);
      },
    });
  },
  onSnapshot(world) {
    const board = parseLoopsBoard(world.extras?.["loops.board"]);
    if (board) pane?.render(board);
  },
  onMessage(msg) {
    const payload = msg.payload;
    if (!isRecord(payload) || payload.kind !== "board") return;
    const board = parseLoopsBoard(payload.board);
    if (board) pane?.render(board);
  },
};
