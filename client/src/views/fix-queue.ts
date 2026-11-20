// The Fix queue: Health's top section. One list of what needs fixing (GET /api/fixes, merged
// server-side from Health checks, Sickness, Vault gaps, stale Loops and abandoned sessions), each
// row with its evidence, city and age, and four actions: Draft a fix (the prompt box, via
// ui/draft-fix.ts), Snooze 7 days, Won't fix (Undo once set aside) and, on a todo.md loop, Mark
// done. A row whose fix started a session shows that session and its outcome verdict.
// Every title and evidence line is untrusted text (transcripts, todo.md, notes): escaped here.

import { SNOOZE_DAYS, type DismissalKind } from "../../../shared/features/completeness";
import type { FixActionResult, FixesResponse, FixRow } from "../../../shared/features/fixes";
import type { LoopsActionResult } from "../../../shared/features/loops";
import { onFixesSummary } from "../features/fixes";
import { outcomeChip } from "../features/outcomes";
import type { ViewContext } from "../shell/views";
import { runAction } from "../ui/action";
import { draftFix, draftFixButtonHtml } from "../ui/draft-fix";
import { escapeHtml } from "../ui/fuzzy";
import { cityDisplayName } from "../ui/world";
import { asideText, dismissRequest, FIX_QUEUE_PREVIEW, isFixesResponse, launchLine, openCount, queueCaption, rowMeta } from "./fix-queue-lib";
import "./fix-queue.css";

export interface FixQueueHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

function sevLabel(row: FixRow): string {
  return { high: "Urgent", medium: "Soon", low: "When you can" }[row.severity];
}

function rowHtml(row: FixRow, now: number, cityName: (id: string) => string): string {
  const id = escapeHtml(row.id);
  const verdict = row.launch?.outcome ? outcomeChip(row.launch.outcome) : null;
  const launch = row.launch
    ? `<p class="fq-launch">${verdict ? `<span aria-hidden="true">${verdict.emoji}</span> ` : ""}${escapeHtml(launchLine(row.launch, now))}</p>`
    : "";
  const actions = row.dismissed
    ? `<span class="fq-aside-note">${escapeHtml(asideText(row, now))}</span><button type="button" class="fq-btn" data-act="undo" data-id="${id}">Undo</button>`
    : `${draftFixButtonHtml({ id: row.id })}
       ${row.loopId ? `<button type="button" class="fq-btn" data-act="done" data-id="${id}" title="Tick this line in its tasks/todo.md">Mark done</button>` : ""}
       <button type="button" class="fq-btn" data-act="snooze" data-id="${id}" title="Hide it from the open count for ${SNOOZE_DAYS} days">Snooze ${SNOOZE_DAYS} days</button>
       <button type="button" class="fq-btn" data-act="wont-fix" data-id="${id}" title="Hide it until you undo this">Won't fix</button>`;
  return `<li class="fq-row fq-${row.severity} fq-state-${row.state}" data-id="${id}">
    <span class="fq-sev" title="${escapeHtml(sevLabel(row))}" aria-label="${escapeHtml(sevLabel(row))}"></span>
    <div class="fq-body">
      <div class="fq-title">${escapeHtml(row.title)}</div>
      <p class="fq-evidence">${escapeHtml(row.evidence)}</p>
      <p class="fq-meta">${escapeHtml(rowMeta(row, now, cityName))}</p>
      ${launch}
      <div class="fq-actions">${actions}</div>
    </div>
  </li>`;
}

export function mountFixQueue(host: HTMLElement, ctx: ViewContext): FixQueueHandle {
  let data: FixesResponse | null = null;
  let failed = false;
  let showAll = false;
  let alive = true;

  const cityName = (id: string): string => {
    const i = ctx.store.islands.get(id);
    return i ? cityDisplayName(i) : id;
  };

  function render(): void {
    if (!alive) return;
    if (!data) {
      host.innerHTML = `<h3 class="fq-h">Fix queue</h3><p class="fq-empty">${failed ? "Couldn't read the fix queue. It retries with the checklist." : "Reading the fix queue…"}</p>`;
      return;
    }
    const now = Date.now();
    const open = data.rows.filter((r) => !r.dismissed);
    const aside = data.rows.filter((r) => r.dismissed);
    const shown = showAll ? open : open.slice(0, FIX_QUEUE_PREVIEW);
    const total = openCount(data.open);
    host.innerHTML = `
      <h3 class="fq-h">Fix queue${total ? ` <span class="fq-count">${total}</span>` : ""}</h3>
      <p class="fq-caption">${escapeHtml(queueCaption(data))}</p>
      ${open.length ? `<ul class="fq-list">${shown.map((r) => rowHtml(r, now, cityName)).join("")}</ul>` : `<p class="fq-empty">Nothing failing, sick, missing or stale right now.</p>`}
      ${open.length > shown.length ? `<button type="button" class="fq-btn fq-more" data-act="more">Show all ${open.length}</button>` : ""}
      ${total > open.length ? `<p class="fq-capped">Showing the first ${open.length} of ${total}: each source lists its 25 worst.</p>` : ""}
      ${aside.length ? `<details class="fq-aside"><summary>${aside.length} set aside</summary><ul class="fq-list">${aside.map((r) => rowHtml(r, now, cityName)).join("")}</ul></details>` : ""}`;
  }

  async function refresh(): Promise<void> {
    const r = await ctx.api.getJson<unknown>("/api/fixes");
    if (!alive) return;
    if (isFixesResponse(r)) {
      data = r;
      failed = false;
    } else failed = true;
    // A row being acted on keeps its button state: only redraw when nothing is busy.
    if (!host.querySelector("button[aria-busy='true']")) render();
  }

  const rowOf = (id: string): FixRow | undefined => data?.rows.find((r) => r.id === id);

  async function dismiss(row: FixRow, kind: DismissalKind | null, btn: HTMLButtonElement): Promise<void> {
    const req = dismissRequest(row, kind);
    await runAction<FixActionResult>({
      label: kind === "snooze" ? `Snooze ${SNOOZE_DAYS} days` : kind === "wont-fix" ? "Won't fix" : "Undo",
      run: () => ctx.api.postJson<FixActionResult>(req.url, req.body, (error) => ({ ok: false, error })),
      success: () => (kind === "snooze" ? `Snoozed for ${SNOOZE_DAYS} days.` : kind === "wont-fix" ? "Marked won't fix: set aside until you undo it." : "Back in the queue."),
      toast: ctx.toast,
      button: btn,
    });
    await refresh();
  }

  async function markDone(row: FixRow, btn: HTMLButtonElement): Promise<void> {
    if (!row.loopId) return;
    const loopId = row.loopId;
    await runAction<LoopsActionResult>({
      label: "Mark done",
      run: () => ctx.api.postJson<LoopsActionResult>(`/api/loops/${encodeURIComponent(loopId)}/done`, {}, (error) => ({ ok: false, error })),
      success: (r) => `Ticked${r.line ? ` line ${r.line} of` : ""} its tasks/todo.md.`,
      toast: ctx.toast,
      button: btn,
    });
    await refresh();
  }

  function onClick(ev: Event): void {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest<HTMLButtonElement>("button") : null;
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === "more") {
      showAll = true;
      render();
      return;
    }
    const row = btn.dataset.id ? rowOf(btn.dataset.id) : undefined;
    if (!row) return;
    if (btn.classList.contains("fx-draft")) return draftFix(ctx, { prompt: row.prompt, cityId: row.cityId, fixId: row.id }, btn);
    const act = btn.dataset.act;
    if (act === "snooze" || act === "wont-fix") void dismiss(row, act, btn);
    else if (act === "undo") void dismiss(row, null, btn);
    else if (act === "done") void markDone(row, btn);
  }

  host.classList.add("fq");
  host.setAttribute("aria-label", "Fix queue");
  host.addEventListener("click", onClick);
  const unsubscribe = onFixesSummary(() => void refresh());
  render();
  void refresh();

  return {
    refresh,
    destroy() {
      alive = false;
      unsubscribe();
      host.removeEventListener("click", onClick);
    },
  };
}
