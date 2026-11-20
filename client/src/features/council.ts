// "council" feature: a 4-persona Jev debate (ported from ~/Documents/Code/crucible) plus
// one headless Claude synthesis call. Opens in the ONE details panel (docs/VIEWS.md),
// from a palette command, a Settings hudButton, and a quick action in the agent details
// panel (fleet-overlay's `watchAgentPanel` extension point). See docs/FEATURES.md.

import type { CouncilHistoryResponse, CouncilPersonaResult, CouncilResult, CouncilRunResponse } from "../../../shared/features/council";
import { COUNCIL_MAX_OPTIONS, COUNCIL_MIN_OPTIONS, validateCouncilRequest } from "../../../shared/features/council";
import { escapeHtml } from "../ui/fuzzy";
import "./council.css";
import { agreementSummary, buildAgentContextSummary, pct, personaAnswered } from "./council-lib";
import { watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";

const RUN_TIMEOUT_MS = 100_000; // >= the server's 90s synth timeout, plus a margin for the Jev round
const DEBOUNCE_MS = 1500;
const AGENT_SLOT = "fx-council";

let pendingContext: string | undefined;
let lastSubmitAt = 0;
let isRunning = false;
let optionCount = 2;
let useYesNo = false;
let lastResult: CouncilResult | null = null;
let history: CouncilResult[] = [];
let historyLoaded = false;

/** Opens the panel, optionally prefilled with an agent's context (the quick action below). */
export function openCouncilPanel(ctx: ClientContext, context?: string): void {
  pendingContext = context;
  ctx.openPanel("council");
}

function optionInput(index: number, value = ""): string {
  return `<label class="council-label">Option ${index + 1}
    <input type="text" class="council-opt" data-idx="${index}" maxlength="200" placeholder="Option ${index + 1}" value="${escapeHtml(value)}" required>
  </label>`;
}

function panelShell(contextPrefill: string | undefined): string {
  return `<div class="council">
    <p class="council-note">Uses your Claude plan + 1 Jev call.</p>
    <form class="council-form">
      <label class="council-label">Decision
        <textarea class="council-decision" maxlength="1000" placeholder="What are you deciding?" required></textarea>
      </label>
      ${
        contextPrefill
          ? `<div class="council-context"><span><strong>Context:</strong> <span class="council-context-text">${escapeHtml(contextPrefill)}</span></span>
              <button type="button" class="council-context-clear" title="Clear context">×</button></div>`
          : ""
      }
      <label class="council-toggle"><input type="checkbox" class="council-yesno"> Let Jev pick from Yes/No instead of entering options</label>
      <div class="council-options">${optionInput(0)}${optionInput(1)}</div>
      <div class="council-opt-actions">
        <button type="button" class="council-add-opt">+ option</button>
        <button type="button" class="council-remove-opt">− option</button>
      </div>
      <button type="submit" class="council-run">Ask the council</button>
      <div class="council-status" role="status"></div>
    </form>
    <div class="council-result"></div>
    <div class="council-history"></div>
  </div>`;
}

function personaRow(p: CouncilPersonaResult, options: readonly string[]): string {
  if (!personaAnswered(p)) {
    return `<tr class="council-row council-row-empty"><th scope="row" title="${escapeHtml(p.lens)}">${escapeHtml(p.label)}</th>
      <td colspan="${options.length + 1}">no signal${p.error ? ` — ${escapeHtml(p.error)}` : ""}</td></tr>`;
  }
  const bars = options
    .map((opt) => {
      const share = p.distribution.find((d) => d.option === opt)?.probability ?? 0;
      const top = opt === p.topChoice;
      return `<td class="council-bar-cell"><div class="council-bar${top ? " council-bar-top" : ""}" style="--pct:${pct(share)}%"><span>${pct(share)}%</span></div></td>`;
    })
    .join("");
  return `<tr class="council-row"><th scope="row" title="${escapeHtml(p.lens)}">${escapeHtml(p.label)}</th>${bars}
    <td class="council-risk">${escapeHtml(p.risk!.level)} <span class="council-conf">(${pct(p.confidence)}% sure)</span></td></tr>`;
}

function verdictCard(v: CouncilResult["verdict"]): string {
  if (!v.ok || v.unavailable) {
    return `<div class="council-verdict council-verdict-unavailable">Synthesis unavailable${v.error ? `: ${escapeHtml(v.error)}` : "."}</div>`;
  }
  const line = (label: string, text: string | undefined, cls = ""): string => (text ? `<p class="${cls}"><strong>${label}:</strong> ${escapeHtml(text)}</p>` : "");
  return `<div class="council-verdict">
    ${line("Pick", v.pick, "council-verdict-pick")}
    ${line("Why", v.why)}
    ${line("Strongest dissent", v.dissent)}
    ${line("What would change the call", v.changeMind)}
  </div>`;
}

function renderResult(el: HTMLElement, result: CouncilResult): void {
  const target = el.querySelector<HTMLElement>(".council-result");
  if (!target) return;
  const rows = result.personas.map((p) => personaRow(p, result.options)).join("");
  target.innerHTML = `<table>
      <thead><tr><th>Persona</th>${result.options.map((o) => `<th>${escapeHtml(o)}</th>`).join("")}<th>Risk</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="council-agreement">${escapeHtml(agreementSummary(result))}${result.source === "keyword" ? " (Jev unavailable this round)" : ""}</p>
    ${verdictCard(result.verdict)}`;
}

function renderHistory(el: HTMLElement): void {
  const target = el.querySelector<HTMLElement>(".council-history");
  if (!target) return;
  if (history.length === 0) {
    target.innerHTML = "";
    return;
  }
  const items = history
    .map(
      (r) =>
        `<button type="button" class="council-history-item" data-id="${escapeHtml(r.id)}"><strong>${escapeHtml(r.decision.slice(0, 80))}</strong>${
          r.verdict.ok && r.verdict.pick ? ` → ${escapeHtml(r.verdict.pick)}` : ""
        }</button>`,
    )
    .join("");
  target.innerHTML = `<h3 class="council-history-h">Past councils</h3>${items}`;
  target.querySelectorAll<HTMLButtonElement>(".council-history-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const picked = history.find((r) => r.id === btn.dataset.id);
      if (picked) {
        lastResult = picked;
        renderResult(el, picked);
      }
    });
  });
}

async function loadHistoryOnce(el: HTMLElement, ctx: ClientContext): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  const res = await ctx.api.getJson<CouncilHistoryResponse>("/api/council/history", 10_000);
  if (res?.ok) {
    history = res.history;
    renderHistory(el);
  }
}

function setStatus(el: HTMLElement, text: string, ok: boolean): void {
  const status = el.querySelector<HTMLElement>(".council-status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("council-status-ok", ok);
}

function wireOptionButtons(el: HTMLElement): void {
  const container = el.querySelector<HTMLElement>(".council-options");
  const addBtn = el.querySelector<HTMLButtonElement>(".council-add-opt");
  const removeBtn = el.querySelector<HTMLButtonElement>(".council-remove-opt");
  const syncButtons = (): void => {
    if (addBtn) addBtn.disabled = optionCount >= COUNCIL_MAX_OPTIONS;
    if (removeBtn) removeBtn.disabled = optionCount <= COUNCIL_MIN_OPTIONS;
  };
  addBtn?.addEventListener("click", () => {
    if (optionCount >= COUNCIL_MAX_OPTIONS || !container) return;
    container.insertAdjacentHTML("beforeend", optionInput(optionCount));
    optionCount += 1;
    syncButtons();
  });
  removeBtn?.addEventListener("click", () => {
    if (optionCount <= COUNCIL_MIN_OPTIONS || !container) return;
    container.lastElementChild?.remove();
    optionCount -= 1;
    syncButtons();
  });
  syncButtons();
}

function wireYesNoToggle(el: HTMLElement): void {
  const toggle = el.querySelector<HTMLInputElement>(".council-yesno");
  const optionsBox = el.querySelector<HTMLElement>(".council-options");
  const optActions = el.querySelector<HTMLElement>(".council-opt-actions");
  toggle?.addEventListener("change", () => {
    useYesNo = toggle.checked;
    if (optionsBox) optionsBox.hidden = useYesNo;
    if (optActions) optActions.hidden = useYesNo;
    // A hidden, empty `required` input blocks the whole submit ("invalid form control is not
    // focusable"): disabled inputs skip the browser's validation, and the submit ignores them.
    el.querySelectorAll<HTMLInputElement>(".council-opt").forEach((i) => (i.disabled = useYesNo));
  });
}

function wirePanel(el: HTMLElement, ctx: ClientContext, contextPrefill: string | undefined): void {
  optionCount = 2;
  useYesNo = false;
  wireOptionButtons(el);
  wireYesNoToggle(el);
  el.querySelector(".council-context-clear")?.addEventListener("click", () => {
    el.querySelector(".council-context")?.remove();
  });

  const form = el.querySelector<HTMLFormElement>(".council-form");
  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (isRunning) return;
    const now = Date.now();
    if (now - lastSubmitAt < DEBOUNCE_MS) return; // debounce: swallow a double-click/double-submit
    lastSubmitAt = now;

    const decision = el.querySelector<HTMLTextAreaElement>(".council-decision")?.value ?? "";
    const context = el.querySelector<HTMLElement>(".council-context-text")?.textContent ?? contextPrefill;
    const options = useYesNo ? [] : [...el.querySelectorAll<HTMLInputElement>(".council-opt")].map((i) => i.value);
    const parsed = validateCouncilRequest({ decision, options, context });
    if (!parsed.ok) {
      setStatus(el, parsed.error, false);
      return;
    }

    isRunning = true;
    const runBtn = el.querySelector<HTMLButtonElement>(".council-run");
    if (runBtn) runBtn.disabled = true;
    setStatus(el, "Asking the council…", true);

    const fallback = (error: string): CouncilRunResponse => ({ ok: false, error });
    void ctx.api.postJson<CouncilRunResponse>("/api/council", parsed.value, fallback, RUN_TIMEOUT_MS).then((res) => {
      isRunning = false;
      if (runBtn) runBtn.disabled = false;
      if (!res.ok || !res.result) {
        setStatus(el, res.error ?? "The council couldn't run.", false);
        return;
      }
      setStatus(el, "", true);
      lastResult = res.result;
      history = [res.result, ...history].slice(0, 20);
      renderResult(el, res.result);
      renderHistory(el);
      // The Feed line comes from the server (a gov:council item, via feed-bridge.ts), once for
      // every open page and the Logs tab: no client-only push here.
    });
  });
}

function renderPanel(el: HTMLElement, ctx: ClientContext): void {
  const contextPrefill = pendingContext;
  pendingContext = undefined;
  el.innerHTML = panelShell(contextPrefill);
  wirePanel(el, ctx, contextPrefill);
  void loadHistoryOnce(el, ctx);
  if (lastResult) renderResult(el, lastResult);
}

function renderAgentQuickAction(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  const agent = ctx.store.agents.get(agentId);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ui-btn ui-btn-menu";
  btn.textContent = "Ask the council about this agent's decision";
  btn.title = "Open a 4-persona Jev + Claude decision council, prefilled with this agent's context";
  btn.addEventListener("click", () => {
    const context = buildAgentContextSummary(agent, ctx.store.activities, agentId);
    openCouncilPanel(ctx, context);
  });
  slot.append(btn);
}

export const councilFeature: ClientFeature = {
  id: "council",
  mount(ctx) {
    watchAgentPanel(AGENT_SLOT, (agentId, slot) => renderAgentQuickAction(agentId, slot, ctx));
  },
  paletteCommands(ctx) {
    return [
      {
        id: "ask",
        title: "Ask the council…",
        meta: "4-persona Jev + one Claude verdict",
        keywords: ["decision", "council", "debate", "judge", "verdict", "crucible"],
        run: () => openCouncilPanel(ctx),
      },
    ];
  },
  hudButtons: [
    {
      id: "open",
      label: "⚖",
      title: "Ask the council: weigh a decision with 4 Jev personas and one Claude verdict",
      text: "Ask the council",
      placement: "menu",
      onClick: (ctx) => openCouncilPanel(ctx),
    },
  ],
  panels: [{ id: "council", title: "Ask the council", render: renderPanel }],
};
