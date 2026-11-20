// "quick-prompts" feature: the ⚡ Automations button in the prompt box and its modal (+ matching search commands).
// Most chips are pure client-side (focus a panel or the dispatch bar); "What happened
// today?" hits POST /api/quick-prompts/today (a real, deterministic digest — Jev only
// CHOOSES among real agents, never generates free text). "Open loops" reads the same
// "loops.board" snapshot extra (and orderedLoopsItems selector) as the Loops right tab,
// so the two never disagree about which items are open loops.

import type { TodayDigestResult } from "../../../shared/features/quick-prompts";
import type { LoopsItem } from "../../../shared/features/loops";
import { expandSurface, modalDialog, type Dialog } from "../ui/kit";
import type { WorldSnapshot } from "../../../shared/types";
import { escapeHtml } from "../ui/fuzzy";
import { icon } from "../shell/icons";
import { automationsEscape, renderAutomations } from "./automations";
import { loopsSourceLabel, orderedLoopsItems, parseLoopsBoard } from "./loops-lib";
import { openNeedsYou } from "./inbox";
import type { ClientContext, ClientFeature } from "./registry";
import { agentTitle } from "../../../shared/display";

function agentRow(ctx: ClientContext, agentId: string, progress: string): string {
  const agent = ctx.store.agents.get(agentId);
  const title = agent ? agentTitle(agent) : agentId;
  return `<li><button type="button" class="qp-agent" data-agent="${escapeHtml(agentId)}">
      <span class="qp-title">${escapeHtml(title)}</span>
      <span class="qp-progress">${escapeHtml(progress)}</span>
    </button></li>`;
}

function wireAgentRows(el: HTMLElement, ctx: ClientContext): void {
  el.querySelectorAll<HTMLButtonElement>(".qp-agent").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.agent;
      if (id) ctx.flyTo(id);
    });
  });
}

function focusDispatchBar(): void {
  expandSurface("dispatch");
  const text = document.getElementById("dispatch-text");
  if (text instanceof HTMLTextAreaElement) text.focus();
}

/** Opens the Jev panel via the same moon.body.userData hook voice.ts uses (see
 *  main.ts, right after `ask` is built) — no new ClientContext field needed. */
function openAsk(ctx: ClientContext, query?: string): void {
  const obj = ctx.scene.getObjectByName("jev-moon");
  const fn = (obj?.userData as { openAsk?: (q?: string) => void } | undefined)?.openAsk;
  if (fn) fn(query);
  else ctx.toast("Ask Jev isn't ready yet.", "error");
}

interface Chip {
  id: string;
  label: string;
  title: string;
  run(ctx: ClientContext): void;
}

const CHIPS: Chip[] = [
  { id: "waiting", label: "Who's waiting on me?", title: "Open Needs you now on Home", run: (ctx) => openNeedsYou(ctx) },
  { id: "today", label: "What happened today?", title: "Today's activity, Jev-ranked", run: (ctx) => ctx.openPanel("quick-prompts-today") },
  { id: "open-loops", label: "Open loops", title: "Agents with incomplete todo lists", run: (ctx) => ctx.openPanel("quick-prompts-open-loops") },
  { id: "agenda", label: "My agenda", title: "Today's calendar", run: (ctx) => ctx.openPanel("agenda") },
  { id: "new-session", label: "New session…", title: "Type a task in the build bar to start a new Claude session", run: () => focusDispatchBar() },
  { id: "find", label: "Ask Jev…", title: "Ask Jev who worked on something", run: (ctx) => openAsk(ctx) },
];

let lastExtras: Record<string, unknown> | undefined;

async function renderTodayPanel(el: HTMLElement, ctx: ClientContext): Promise<void> {
  el.innerHTML = `<div class="qp-loading">Checking today's activity…</div>`;
  const fallback = (error: string): TodayDigestResult => ({ ok: false, summary: "", agents: [], source: "rules", error });
  const res = await ctx.api.postJson<TodayDigestResult>("/api/quick-prompts/today", {}, fallback, 15_000);
  if (!res.ok) {
    el.innerHTML = `<div class="qp-error">${escapeHtml(res.error ?? "Couldn't check today's activity.")}</div>`;
    return;
  }
  const rows = res.agents.map((a) => agentRow(ctx, a.agentId, a.reason)).join("");
  const sourceTag =
    res.agents.length === 0 ? "" : res.source === "jev" ? `<span class="source jev">Jev picked these</span>` : `<span class="source keyword">by message count</span>`;
  el.innerHTML = `<div class="qp-summary">${escapeHtml(res.summary)}</div>${sourceTag}${rows ? `<ul class="qp-list">${rows}</ul>` : ""}`;
  if (res.summary) {
    const day = new Date().toISOString().slice(0, 10);
    ctx.feed.push({ id: `report:today:${day}`, kind: "report", at: Date.now(), title: `Today so far: ${res.summary}`, detail: "What happened today?" });
  }
  wireAgentRows(el, ctx);
}

function loopRow(item: LoopsItem): string {
  return `<li><div class="qp-agent">
      <span class="qp-title">${escapeHtml(item.project)} — ${escapeHtml(item.task)}</span>
      <span class="qp-progress">via ${escapeHtml(loopsSourceLabel(item.sources))}</span>
    </div></li>`;
}

function renderOpenLoopsPanel(el: HTMLElement): void {
  const board = parseLoopsBoard(lastExtras?.["loops.board"]);
  const items = orderedLoopsItems(board);
  if (items.length === 0) {
    el.innerHTML = `<div class="qp-empty">${board ? "No open loops — everything's done." : "Loops tracking isn't available yet."}</div>`;
    return;
  }
  el.innerHTML = `<ul class="qp-list">${items.map(loopRow).join("")}</ul>`;
}

// ---- ⚡ Automations modal (one button in the prompt box replaces the chip row) ----
// This file owns the button + modal shell; the content (cards, reader, run) is features/automations.ts.

let dialog: Dialog | null = null;

function mountAutomations(ctx: ClientContext): void {
  const row = document.querySelector("#dispatch .dispatch-row");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "qp-automations";
  btn.className = "chip qp-auto-btn";
  btn.title = "Automations: quick prompts, routines and skills you can run";
  btn.innerHTML = `<span aria-hidden="true">${icon("bolt", 14) ?? ""}</span> Automations`;
  row?.insertBefore(btn, row.firstChild);

  const root = document.createElement("div");
  root.id = "automations";
  root.className = "ui-backdrop";
  root.hidden = true;
  root.innerHTML = `<div class="ui-dialog qp-auto-card" aria-labelledby="qp-auto-title">
      <header class="ui-dialog-head"><h2 id="qp-auto-title">⚡ Automations</h2><button type="button" class="ui-close" aria-label="Close automations" title="Close (Esc)">×</button></header>
      <div class="qp-auto-content"></div>
    </div>`;
  document.body.append(root);
  const card = root.querySelector<HTMLElement>(".qp-auto-card")!;
  const d = modalDialog(root, card, "Automations");
  dialog = d;
  root.querySelector(".ui-close")?.addEventListener("click", () => d.close());
  btn.addEventListener("click", () => {
    d.open();
    renderAutomations(root.querySelector<HTMLElement>(".qp-auto-content")!, ctx, { close: () => d.close() });
  });
}

export const quickPromptsFeature: ClientFeature = {
  id: "quick-prompts",
  mount(ctx) {
    mountAutomations(ctx);
  },
  onSnapshot(world: WorldSnapshot) {
    lastExtras = world.extras;
  },
  onEscape() {
    if (!dialog?.isOpen()) return false;
    if (automationsEscape()) return true; // the run confirm / reader first
    dialog.close();
    return true;
  },
  paletteCommands(ctx) {
    return [
      ...CHIPS.map((c) => ({ id: c.id, title: c.label, meta: c.title, keywords: c.title.split(/\s+/), kind: "quick", run: () => c.run(ctx) })),
      { id: "automations", title: "Automations", meta: "quick prompts, routines and skills", keywords: ["automation", "run", "routine", "prompt"], kind: "quick", run: () => document.getElementById("qp-automations")?.click() },
    ];
  },
  panels: [
    { id: "quick-prompts-today", title: "What happened today?", render: (el, ctx) => void renderTodayPanel(el, ctx) },
    { id: "quick-prompts-open-loops", title: "Open loops", render: (el) => renderOpenLoopsPanel(el) },
  ],
};
