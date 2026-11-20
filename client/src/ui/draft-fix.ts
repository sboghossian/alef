// "Draft a fix": the one button every finding gets (the Fix queue, Health's issues, Vault Gaps, the
// Board's stale cards). It reuses the Sickness Doctor's path: the prompt goes into the ONE prompt box
// (fillDispatchBox) with its city selected, and nothing is sent until Alex presses Dispatch.
// When the prompt carries a Fix queue row id and that dispatch goes out, the row is told which tmux
// session it started (POST /api/fixes/:id/launched), so the session and its verdict show on the row.

import type { FixActionResult, FixRowResponse } from "../../../shared/features/fixes";
import type { DispatchResult } from "../../../shared/types";
import type { ClientContext } from "../features/registry";
import { log } from "../log";
import { runAction } from "./action";
import { fillDispatchBox } from "./dispatch";
import { escapeHtml } from "./fuzzy";
import "./draft-fix.css";

export const DRAFT_FIX_LABEL = "Draft a fix";
const DRAFT_FIX_TITLE = "Put a fix prompt with this evidence in the prompt box (nothing is sent until you press Dispatch)";

export interface DraftFix {
  prompt: string;
  cityId?: string | null;
  /** The Fix queue row this fixes ("<source>:<key>"), to record the session it starts. */
  fixId?: string | null;
}

/** The button as markup, for views that render HTML strings. `data` becomes data-* attributes. */
export function draftFixButtonHtml(data: Readonly<Record<string, string>>, extraClass = ""): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`)
    .join("");
  return `<button type="button" class="fx-draft${extraClass ? ` ${extraClass}` : ""}" title="${escapeHtml(DRAFT_FIX_TITLE)}"${attrs}>${DRAFT_FIX_LABEL}</button>`;
}

/** The button as an element, for views that build DOM nodes. */
export function draftFixButton(onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fx-draft";
  b.title = DRAFT_FIX_TITLE;
  b.textContent = DRAFT_FIX_LABEL;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation(); // a row's own click (select, drill) is not this
    onClick(b);
  });
  return b;
}

async function recordLaunch(ctx: Pick<ClientContext, "api">, fixId: string, res: DispatchResult): Promise<void> {
  const r = await ctx.api.postJson<FixActionResult>(`/api/fixes/${encodeURIComponent(fixId)}/launched`, res.tmuxName ? { tmuxName: res.tmuxName } : {}, (error) => ({ ok: false, error }));
  if (!r.ok) log.warn("draft-fix", `could not record the launch on its fix row: ${r.error ?? "?"}`);
}

/** Fills the prompt box with `d` and says so. */
export function draftFix(ctx: Pick<ClientContext, "api" | "toast">, d: DraftFix, button?: HTMLButtonElement | null): void {
  void runAction<{ ok: boolean; error?: string; city: string | null }>({
    label: DRAFT_FIX_LABEL,
    pending: "Writing the fix prompt…",
    run: async () => {
      const fixId = d.fixId ?? null;
      fillDispatchBox({ prompt: d.prompt, cityId: d.cityId ?? null, ...(fixId ? { onDispatched: (res: DispatchResult) => void recordLaunch(ctx, fixId, res) } : {}) });
      const box = document.getElementById("dispatch-text");
      if (!(box instanceof HTMLTextAreaElement) || box.value !== d.prompt) return { ok: false, error: "the prompt box isn't on screen (press H to bring the panels back)", city: null };
      const sel = document.getElementById("dispatch-city");
      return { ok: true, city: sel instanceof HTMLSelectElement ? (sel.selectedOptions[0]?.textContent ?? sel.value) : null };
    },
    success: (r) => `The fix prompt is in the prompt box${r.city ? ` (city: ${r.city})` : ""}. Nothing was sent: read it, then press Dispatch.`,
    toast: ctx.toast,
    button: button ?? null,
  });
}

/** "Draft a fix" for a finding the Fix queue also lists (a Vault gap): the queue's own row wins
 *  (its city, its wording, and the launch is recorded on it); `fallback` when it isn't queued. */
export async function draftFixFromQueue(ctx: Pick<ClientContext, "api" | "toast">, fixId: string, fallback: DraftFix, button?: HTMLButtonElement | null): Promise<void> {
  const r = await ctx.api.getJson<FixRowResponse>(`/api/fixes/${encodeURIComponent(fixId)}`);
  const row = r?.ok ? r.row : undefined;
  draftFix(ctx, row ? { prompt: row.prompt, cityId: row.cityId, fixId: row.id } : fallback, button);
}
