// The Alef resident's panel (Settings row + palette "Resident") and its Inbox section. State comes
// from `extras["resident.state"]` and the "resident" WS message, both validated with
// isResidentState. The kill switch and Approve/Dismiss are POSTs that only run from a click here.
//
// The Inbox tab is owned by inbox.ts, which repaints its pane with innerHTML; rather than edit it,
// this feature keeps its own section element appended to the pane (a MutationObserver re-appends
// it after each repaint), so the resident's proposals sit below "Jev proposes".

import type { ResidentActionResult } from "../../../shared/features/resident";
import { fillDispatchBox } from "../ui/dispatch";
import { isRecord } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { residentData } from "./resident-data";
import { APPROVE_TOAST, draftPrompt, DRAFT_TOAST, renderResidentInbox, renderResidentPanel, RESIDENT_MUTATION_TIMEOUT_MS, RESIDENT_SAVING_LABEL } from "./resident-lib";
import "./resident.css";

const PANEL_ID = "resident";

let panelEl: HTMLElement | null = null;
let inboxEl: HTMLElement | null = null;

function fail(error: string): ResidentActionResult {
  return { ok: false, error };
}

function paint(): void {
  const cached = residentData.state;
  if (!cached) return;
  if (panelEl?.isConnected) panelEl.innerHTML = renderResidentPanel(cached);
  if (inboxEl) inboxEl.innerHTML = renderResidentInbox(cached);
}

/** Every state this feature receives goes through the shared store (resident-data.ts), so the
 *  Town square sees proposals made, approved or dismissed after the page loaded. */
function accept(state: unknown): void {
  if (residentData.accept(state)) paint();
}

async function post(ctx: ClientContext, path: string, body: unknown, okText: string, opts: { timeoutMs?: number; savingText?: string } = {}): Promise<void> {
  if (opts.savingText) ctx.toast(opts.savingText);
  const r = await ctx.api.postJson<ResidentActionResult>(path, body, fail, opts.timeoutMs);
  if (r.ok) {
    accept(r.state);
    ctx.toast(okText);
  } else {
    ctx.toast(r.error ?? "The resident didn't answer", "error");
  }
}

/** Approve/dismiss share the same slow path: queued behind the resident's own serial chain,
 *  next to an up-to-90s reflection — see RESIDENT_MUTATION_TIMEOUT_MS. */
function postMutation(ctx: ClientContext, path: string, okText: string): void {
  void post(ctx, path, {}, okText, { timeoutMs: RESIDENT_MUTATION_TIMEOUT_MS, savingText: RESIDENT_SAVING_LABEL });
}

/** One delegated click handler for the panel and the Inbox section. */
function onClick(ctx: ClientContext, ev: Event): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  const toggle = t?.closest<HTMLElement>("button[data-res-enabled]");
  if (toggle) {
    const on = toggle.dataset.resEnabled === "true";
    void post(ctx, "/api/resident/enabled", { enabled: on }, on ? "Resident switched on" : "Resident switched off");
    return;
  }
  const approve = t?.closest<HTMLElement>("button[data-res-approve]")?.dataset.resApprove;
  if (approve) {
    postMutation(ctx, `/api/resident/proposals/${encodeURIComponent(approve)}/approve`, APPROVE_TOAST);
    return;
  }
  const draft = t?.closest<HTMLElement>("button[data-res-draft]")?.dataset.resDraft;
  if (draft) {
    const proposal = residentData.state?.proposals.find((p) => p.id === draft);
    if (proposal) {
      fillDispatchBox({ prompt: draftPrompt(proposal) });
      ctx.toast(DRAFT_TOAST);
    }
    return;
  }
  const dismiss = t?.closest<HTMLElement>("button[data-res-dismiss]")?.dataset.resDismiss;
  if (dismiss) postMutation(ctx, `/api/resident/proposals/${encodeURIComponent(dismiss)}/dismiss`, "Dismissed");
}

async function renderPanel(el: HTMLElement, ctx: ClientContext): Promise<void> {
  panelEl = el;
  el.innerHTML = residentData.state ? renderResidentPanel(residentData.state) : `<p class="res-empty">Loading the resident…</p>`;
  if (el.dataset.resBound !== "1") {
    el.dataset.resBound = "1";
    el.addEventListener("click", (ev) => onClick(ctx, ev));
  }
  accept(await ctx.api.getJson<unknown>("/api/resident"));
}

export const residentFeature: ClientFeature = {
  id: "resident",
  mount(ctx) {
    const pane = document.getElementById("alef-pane-inbox");
    if (!pane) return;
    const section = document.createElement("div");
    section.id = "res-inbox";
    section.addEventListener("click", (ev) => onClick(ctx, ev));
    inboxEl = section;
    pane.append(section);
    new MutationObserver(() => {
      if (section.parentElement !== pane) pane.append(section);
    }).observe(pane, { childList: true });
    paint();
  },
  onSnapshot(world) {
    accept(world.extras?.["resident.state"]);
  },
  onMessage(msg) {
    const p = msg.payload;
    if (isRecord(p) && p.kind === "state") accept(p.state);
  },
  paletteCommands(ctx) {
    return [{ id: "open", title: "Resident", meta: "The agent that lives in Alef", keywords: ["alef resident", "journal", "sandbox", "kill switch"], run: () => ctx.openPanel(PANEL_ID) }];
  },
  hudButtons: [
    {
      id: "open",
      label: "🏠",
      title: "The Alef resident: its journal, goals, spend, writes and proposals (and its off switch)",
      text: "Alef resident",
      placement: "menu",
      onClick: (ctx) => ctx.openPanel(PANEL_ID),
    },
  ],
  panels: [{ id: PANEL_ID, title: "Alef resident", render: (el, ctx) => void renderPanel(el, ctx) }],
};
