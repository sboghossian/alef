// Round 5 E2: the single focus card. Shows ONLY the focused agent: title + city + state ring,
// its live activity, its todo list, its pending permission request (Approve / Deny), a talk
// box (or how to get one), and Reactivate / Open in VS Code. Everything is real data read
// live from the store and the fleet features; nothing is invented to fill a gap.

import { agentTitle } from "../../../shared/display";
import type { AgentActivity } from "../../../shared/types";
import { STATE_COLORS, STATE_LABELS, agentStateOf, onAgentStates } from "../features/agent-state";
import { decideApproval, onApprovalsChange, pendingApprovals } from "../features/approvals";
import { h } from "../features/fleet-overlay";
import type { ClientContext } from "../features/registry";
import { RUNNING_ELSEWHERE_TEXT, resumeStartedText } from "../features/resume-guard";
import { launchSuccessText } from "./launch-result";
import { onTalkChange, resumeInTmux, resumeOfferFor, sendTalk, talkInfo } from "../features/talk";
import { onTodosChange, todoListElement, todoListFor } from "../features/todos";
import { todoProgress } from "../../../shared/features/todos";
import { TALK_MAX_CHARS } from "../../../shared/features/talk";

const MAX_LINES = 8;

export interface FocusCard {
  show(agentId: string): void;
  hide(): void;
  isOpen(): boolean;
  el: HTMLElement;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export function mountFocusCard(ctx: ClientContext, opts: { cityName(id: string): string; onExit(): void }): FocusCard {
  const el = h("aside", "focus-card");
  el.id = "focus-card";
  el.hidden = true;
  el.setAttribute("role", "region");
  document.body.appendChild(el);

  const head = h("header", "fc-head");
  const ring = h("span", "fc-ring");
  ring.setAttribute("aria-hidden", "true");
  const titles = h("div", "fc-titles");
  const title = h("h2", "fc-title");
  const sub = h("div", "fc-sub");
  titles.append(title, sub);
  const exit = h("button", "ui-close fc-exit", "×");
  exit.type = "button";
  exit.setAttribute("aria-label", "Leave focus mode (F or Esc)");
  exit.title = "Leave focus (F or Esc)";
  exit.addEventListener("click", () => opts.onExit());
  head.append(ring, titles, exit);

  const approvalSec = h("section", "fc-sec fc-approval");
  const activitySec = h("section", "fc-sec fc-activity");
  const actHead = h("h3", undefined, "Live activity");
  const actList = h("ul", "fc-lines");
  actList.setAttribute("aria-live", "polite");
  activitySec.append(actHead, actList);
  const todoSec = h("section", "fc-sec fc-todos");
  const talkSec = h("section", "fc-sec fc-talk");
  const actions = h("div", "fc-actions");
  const reactivateBtn = h("button", "comic-btn", "Reactivate");
  reactivateBtn.type = "button";
  const editorBtn = h("button", "comic-btn secondary", "Open in VS Code");
  editorBtn.type = "button";
  actions.append(reactivateBtn, editorBtn);
  const status = h("div", "fc-status");
  status.setAttribute("role", "status");
  const hint = h("div", "fc-hint");
  hint.innerHTML = "<kbd>F</kbd> or <kbd>Esc</kbd> to leave · click another house to focus it";
  el.append(head, approvalSec, activitySec, todoSec, talkSec, actions, status, hint);

  let current: string | null = null;
  let talkKey = "";

  reactivateBtn.addEventListener("click", () => {
    if (!current) return;
    const id = current;
    status.textContent = "Reactivating…";
    void ctx.api.reactivate(id).then((r) => {
      status.textContent = r.ok ? launchSuccessText(r, "Resumed", false) : `Failed: ${r.error ?? "unknown error"}`;
    });
  });
  editorBtn.addEventListener("click", () => {
    if (!current) return;
    status.textContent = "Opening VS Code…";
    void ctx.api.openEditor(current).then((r) => {
      status.textContent = r.ok ? "Opened in VS Code." : `Failed: ${r.error ?? "unknown error"}`;
    });
  });

  function renderHead(id: string): void {
    const agent = ctx.store.agents.get(id);
    const st = agentStateOf(id) ?? (agent?.status === "live" ? undefined : "sleeping");
    title.textContent = agent ? agentTitle(agent) : id;
    el.setAttribute("aria-label", `Focus: ${agent ? agentTitle(agent) : id}`);
    sub.replaceChildren(h("span", "fc-city", agent ? opts.cityName(agent.islandId) : ""));
    if (st) {
      const chip = h("span", `as-chip as-${st}`, STATE_LABELS[st]);
      sub.append(chip);
    } else if (agent) sub.append(h("span", "fc-live", agent.status === "live" ? "live" : "asleep"));
    ring.style.setProperty("--ring", st ? hex(STATE_COLORS[st]) : "#8c84a8");
    ring.classList.toggle("fc-ring-pulse", st === "working" || st === "permission");
    const live = agent?.status === "live";
    reactivateBtn.disabled = live;
    reactivateBtn.title = live ? "Already live" : "Resume this session in a new Terminal window";
  }

  function renderApproval(id: string): void {
    const list = pendingApprovals().filter((a) => a.agentId === id);
    approvalSec.replaceChildren();
    approvalSec.hidden = list.length === 0;
    const a = list[0];
    if (!a) return;
    const top = h("h3", "fc-ap-head", list.length > 1 ? `Needs your OK (${list.length})` : "Needs your OK");
    const tool = h("div", "ap-tool");
    tool.append(h("span", "ap-toolname", a.toolName), h("span", "ap-title", a.preview.title));
    const body = h("pre", `ap-body ap-${a.preview.kind}`);
    body.textContent = a.preview.body || "(no details)";
    const row = h("div", "fc-ap-actions");
    const yes = h("button", "comic-btn ap-approve", "Approve");
    yes.type = "button";
    const no = h("button", "comic-btn ap-deny", "Deny");
    no.type = "button";
    yes.addEventListener("click", () => {
      yes.disabled = no.disabled = true;
      void decideApproval(ctx, a.id, "allow");
    });
    no.addEventListener("click", () => {
      yes.disabled = no.disabled = true;
      void decideApproval(ctx, a.id, "deny");
    });
    row.append(yes, no);
    approvalSec.append(top, tool, body, row);
  }

  function lineEl(a: AgentActivity): HTMLElement {
    const li = h("li");
    const dot = h("i", `stage-dot ${a.stage}`);
    dot.title = a.stage;
    li.append(dot, h("span", "fc-line", a.summary), h("time", "fc-ago", ago(a.at)));
    return li;
  }

  function renderActivity(id: string): void {
    const lines = ctx.store.activities.filter((a) => a.agentId === id).slice(-MAX_LINES).reverse();
    actList.replaceChildren(...lines.map(lineEl));
    if (!lines.length) {
      const agent = ctx.store.agents.get(id);
      actList.append(h("li", "fc-empty", agent?.status === "live" ? "Nothing yet. A line shows up here the moment this agent uses a tool." : "Asleep. Nothing new since the world started."));
    }
  }

  function renderTodos(id: string): void {
    const list = todoListFor(ctx, id);
    todoSec.replaceChildren();
    todoSec.hidden = !list || list.items.length === 0;
    if (!list || list.items.length === 0) return;
    const { done, total } = todoProgress(list);
    todoSec.append(h("h3", undefined, `Todos ${done}/${total}`), todoListElement(list));
  }

  function renderTalk(id: string, force = false): void {
    const info = talkInfo(id);
    const offer = resumeOfferFor(id, ctx.store.agents.get(id)?.status);
    const key = `${info.available}|${info.binding?.tmuxName ?? ""}|${offer}`;
    if (!force && key === talkKey) return;
    talkKey = key;
    talkSec.replaceChildren(h("h3", undefined, "Talk"));
    const out = h("div", "tk-status");
    out.setAttribute("role", "status");
    if (info.available === null) {
      talkSec.append(h("p", "tk-note", "Checking for tmux…"));
      return;
    }
    if (!info.available) {
      talkSec.append(h("p", "tk-note", info.hint ?? "Talking to an agent needs tmux."));
      return;
    }
    if (!info.binding) {
      if (offer === "running-elsewhere") {
        talkSec.append(h("p", "tk-note", RUNNING_ELSEWHERE_TEXT));
        return;
      }
      talkSec.append(h("p", "tk-note", "This agent runs in a plain terminal, so the world can't type into it. Resume here to chat: it restarts inside tmux and Terminal opens attached."));
      const btn = h("button", "comic-btn secondary wide", "Resume here, to chat");
      btn.type = "button";
      btn.addEventListener("click", () => {
        // Checked again at click time: the agent may have started elsewhere since this rendered.
        if (resumeOfferFor(id, ctx.store.agents.get(id)?.status) !== "resume") return renderTalk(id, true);
        out.textContent = "Starting…";
        btn.disabled = true;
        void resumeInTmux(ctx, id).then((r) => {
          btn.disabled = false;
          out.textContent = r.ok ? resumeStartedText(r) : `Failed: ${r.error ?? "unknown error"}`;
        });
      });
      talkSec.append(btn, out);
      return;
    }
    const form = h("form", "tk-form");
    const input = h("textarea", "tk-input");
    input.rows = 2;
    input.maxLength = TALK_MAX_CHARS;
    input.placeholder = "Say something to this agent";
    input.setAttribute("aria-label", "Message to this agent");
    const send = h("button", "comic-btn small", "Send");
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      void sendTalk(ctx, id, text).then((r) => {
        send.disabled = false;
        out.textContent = r.ok ? "Sent." : `Failed: ${r.error ?? "unknown error"}`;
        if (r.ok) input.value = "";
      });
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        form.requestSubmit();
      }
    });
    talkSec.append(form, out);
  }

  const refresh = (part?: "head" | "approval" | "activity" | "todos" | "talk"): void => {
    const id = current;
    if (!id) return;
    if (!part || part === "head") renderHead(id);
    if (!part || part === "approval") renderApproval(id);
    if (!part || part === "activity") renderActivity(id);
    if (!part || part === "todos") renderTodos(id);
    if (!part || part === "talk") renderTalk(id);
  };
  ctx.store.onActivity((fresh) => {
    if (current && fresh.some((a) => a.agentId === current)) refresh("activity");
  });
  ctx.store.onAgents(() => {
    refresh("head");
    refresh("talk"); // live ↔ dormant flips the Resume offer; renderTalk skips an unchanged key
  });
  onAgentStates(() => refresh("head"));
  onApprovalsChange(() => refresh("approval"));
  onTodosChange(() => refresh("todos"));
  onTalkChange(() => refresh("talk"));
  // Relative times ("12s") tick while the card is open.
  window.setInterval(() => {
    if (current) refresh("activity");
  }, 5000);

  return {
    el,
    show(agentId) {
      if (current !== agentId) status.textContent = "";
      current = agentId;
      el.hidden = false;
      renderTalk(agentId, true);
      refresh();
    },
    hide() {
      current = null;
      el.hidden = true;
    },
    isOpen: () => current !== null,
  };
}
