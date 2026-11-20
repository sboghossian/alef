// A1 — talk to a live agent. In the agent panel: a "say something" box when the agent
// runs in a world tmux session, a "Reactivate in tmux" button when it doesn't, or the
// install hint when tmux is missing. A "Talk" panel (palette: "talk") dispatches a new
// agent inside tmux so you can keep talking to it from here.

import { TALK_MAX_CHARS, type StrandedDispatch, type TalkActionResult, type TalkBinding, type TalkStatus } from "../../../shared/features/talk";
import type { AgentStatus } from "../../../shared/types";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { launchSuccessText, type LaunchResultLike } from "../ui/launch-result";
import { RUNNING_ELSEWHERE_TEXT, resumeOffer, resumeStartedText, type ResumeOffer } from "./resume-guard";
import { agentTitle } from "../../../shared/display";

const SLOT = "fx-talk";
let status: TalkStatus | null = null;
let stranded: StrandedDispatch[] = [];

function parseBindings(v: unknown): TalkBinding[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (b): b is TalkBinding =>
      isRecord(b) && (b.agentId === null || typeof b.agentId === "string") && typeof b.tmuxName === "string" && typeof b.cwd === "string" && typeof b.startedAt === "string",
  );
}

const STRANDED_BLOCKED_ON = new Set(["trust", "chrome", "menu", "empty-prompt", "exited", "unknown"]);

export function parseStranded(v: unknown): StrandedDispatch[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (s): s is StrandedDispatch =>
      isRecord(s) &&
      typeof s.tmuxName === "string" &&
      typeof s.cwd === "string" &&
      typeof s.startedAt === "string" &&
      typeof s.blockedOn === "string" &&
      STRANDED_BLOCKED_ON.has(s.blockedOn) &&
      typeof s.closable === "boolean" &&
      (s.promptHead === null || typeof s.promptHead === "string") &&
      (s.lastLine === null || typeof s.lastLine === "string"),
  );
}

/** Bindings that made it to a real agent — the count Talk can actually type into. A dispatch/launch
 *  whose transcript never showed up (agentId still null) is not one; see strandedDispatches(). */
export function countActiveBindings(bindings: readonly TalkBinding[]): number {
  return bindings.filter((b) => b.agentId !== null).length;
}

async function refreshStatus(ctx: ClientContext): Promise<void> {
  const s = await ctx.api.getJson<unknown>("/api/talk/status");
  if (!isRecord(s) || typeof s.available !== "boolean") return;
  status = { available: s.available, hint: typeof s.hint === "string" ? s.hint : null, bindings: parseBindings(s.bindings) };
  refreshAgentPanel(SLOT, (id, el) => renderSlot(id, el, ctx));
  for (const fn of talkListeners) fn();
}

function hintEl(hint: string): HTMLElement {
  const box = h("div", "tk-hint");
  const [lead, cmd] = hint.split(" — run: ");
  box.append(h("span", undefined, lead ?? hint));
  if (cmd) box.append(h("code", undefined, cmd));
  return box;
}

function renderSlot(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  if (!status) return;
  slot.append(h("h3", "tk-head", "Talk"));
  if (!status.available) {
    slot.append(hintEl(status.hint ?? "Talk needs tmux"));
    return;
  }
  const binding = status.bindings.find((b) => b.agentId === agentId);
  const out = h("div", "tk-status");
  out.setAttribute("role", "status");
  if (!binding) {
    if (resumeOfferFor(agentId, ctx.store.agents.get(agentId)?.status) === "running-elsewhere") {
      slot.append(h("p", "tk-note", RUNNING_ELSEWHERE_TEXT));
      return;
    }
    slot.append(h("p", "tk-note", "Want to type to it from this panel? Resume it inside tmux first. (Plain Reactivate below opens a normal Terminal.)"));
    const btn = h("button", "comic-btn secondary wide", "Resume here, to chat");
    btn.type = "button";
    btn.title = "Opens Terminal attached to a new tmux session running claude --resume";
    btn.addEventListener("click", () => {
      // Checked again at click time: the agent may have started elsewhere since this rendered.
      if (resumeOfferFor(agentId, ctx.store.agents.get(agentId)?.status) !== "resume") return renderSlot(agentId, slot, ctx);
      out.textContent = "Starting…";
      void ctx.api
        .postJson<TalkActionResult>(`/api/talk/reactivate/${encodeURIComponent(agentId)}`, undefined, (error) => ({ ok: false, error }))
        .then((r) => {
          out.textContent = r.ok ? resumeStartedText(r) : `Failed: ${r.error ?? "unknown error"}`;
          void refreshStatus(ctx);
        });
    });
    slot.append(btn, out);
    return;
  }
  const form = h("form", "tk-form");
  const input = h("textarea", "tk-input");
  input.rows = 2;
  input.maxLength = TALK_MAX_CHARS;
  input.placeholder = `Say something to this agent (tmux ${binding.tmuxName})`;
  const send = h("button", "comic-btn small", "Send");
  send.type = "submit";
  form.append(input, send);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    void ctx.api
      .postJson<TalkActionResult>(`/api/talk/${encodeURIComponent(agentId)}`, { text }, (error) => ({ ok: false, error }))
      .then((r) => {
        send.disabled = false;
        out.textContent = r.ok ? "Sent." : `Failed: ${r.error ?? "unknown error"}`;
        if (r.ok) {
          input.value = "";
          const pos = ctx.agentPosition(agentId);
          if (pos) ctx.labels.say(text.length > 60 ? `${text.slice(0, 59)}…` : text, pos, 5);
        }
      });
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  slot.append(form, out);
}

function renderPanel(el: HTMLElement, ctx: ClientContext): void {
  el.replaceChildren();
  if (!status) {
    el.append(h("p", "tk-note", "Checking for tmux…"));
    void refreshStatus(ctx).then(() => renderPanel(el, ctx));
    return;
  }
  if (!status.available) {
    el.append(hintEl(status.hint ?? "Talk needs tmux"));
    return;
  }
  el.append(h("p", "tk-note", "Start a new agent inside tmux. Terminal opens attached, and you can keep talking to it from its panel."));
  const form = h("form", "tk-form tk-dispatch");
  const city = h("select", "tk-city");
  city.setAttribute("aria-label", "City");
  const cities = [...ctx.store.islands.values()].filter((i) => i.id !== "harness" && i.path).sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  for (const i of cities) {
    const o = h("option", undefined, i.name);
    o.value = i.id;
    city.appendChild(o);
  }
  const prompt = h("textarea", "tk-input");
  prompt.rows = 3;
  prompt.maxLength = 4000;
  prompt.placeholder = "What should the new agent do?";
  const go = h("button", "comic-btn small", "Dispatch in tmux");
  go.type = "submit";
  const out = h("div", "tk-status");
  out.setAttribute("role", "status");
  form.append(city, prompt, go);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = prompt.value.trim();
    if (!text || !city.value) return;
    go.disabled = true;
    void ctx.api
      .postJson<TalkActionResult>("/api/talk/dispatch", { islandId: city.value, prompt: text }, (error) => ({ ok: false, error }))
      .then((r) => {
        go.disabled = false;
        out.textContent = r.ok ? dispatchStartedText(r) : `Failed: ${r.error ?? "unknown error"}`;
        if (r.ok) prompt.value = "";
      });
  });
  el.append(form, out);
  const bound = status.bindings;
  if (bound.length) {
    el.append(h("h3", "tk-head", "In tmux now"));
    const ul = h("ul", "tk-list");
    for (const b of bound) {
      const li = h("li");
      const bound = b.agentId ? ctx.store.agents.get(b.agentId) : undefined;
      const title = b.agentId ? (bound ? agentTitle(bound) : b.agentId.slice(0, 8)) : "starting…";
      const btn = h("button", undefined, `${title} · ${b.tmuxName}`);
      btn.type = "button";
      if (b.agentId) {
        const id = b.agentId;
        btn.addEventListener("click", () => ctx.flyTo(id));
      } else btn.disabled = true;
      li.appendChild(btn);
      ul.appendChild(li);
    }
    el.append(ul);
  }
}

export const talkFeature: ClientFeature = {
  id: "talk",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, el) => renderSlot(id, el, ctx));
    void refreshStatus(ctx);
  },
  onSnapshot(world, ctx) {
    const b = world.extras?.["talk.bindings"];
    const s = world.extras?.["talk.stranded"];
    let touched = false;
    if (status && Array.isArray(b)) {
      status = { ...status, bindings: parseBindings(b) };
      touched = true;
    }
    if (Array.isArray(s)) {
      stranded = parseStranded(s);
      touched = true;
    }
    if (touched) {
      refreshAgentPanel(SLOT, (id, el) => renderSlot(id, el, ctx));
      for (const fn of talkListeners) fn();
    }
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p)) return;
    if (p.kind === "bindings" && status) {
      status = { ...status, bindings: parseBindings(p.bindings) };
      refreshAgentPanel(SLOT, (id, el) => renderSlot(id, el, ctx));
      for (const fn of talkListeners) fn();
      return;
    }
    if (p.kind === "stranded") {
      stranded = parseStranded(p.stranded);
      for (const fn of talkListeners) fn();
    }
  },
  panels: [{ id: "talk", title: "Talk (tmux)", render: renderPanel }],
  paletteCommands: (ctx) => [
    { id: "open", title: "Talk: dispatch an agent in tmux", keywords: ["tmux", "talk", "speak", "send keys"], run: () => ctx.openPanel("talk") },
  ],
};

// ---- round 5 E: the focus card's talk box ----
const talkListeners = new Set<() => void>();

export interface TalkInfo {
  /** null until the first /api/talk/status answer. */
  available: boolean | null;
  hint: string | null;
  binding: TalkBinding | undefined;
}

export function talkInfo(agentId: string): TalkInfo {
  if (!status) return { available: null, hint: null, binding: undefined };
  return { available: status.available, hint: status.hint, binding: status.bindings.find((b) => b.agentId === agentId) };
}

export function onTalkChange(fn: () => void): () => void {
  talkListeners.add(fn);
  return () => talkListeners.delete(fn);
}

/** Types `text` into the agent's tmux session (same endpoint as the panel's Send). */
export function sendTalk(ctx: ClientContext, agentId: string, text: string): Promise<TalkActionResult> {
  return ctx.api.postJson<TalkActionResult>(`/api/talk/${encodeURIComponent(agentId)}`, { text }, (error) => ({ ok: false, error }));
}

/** "Dispatch in tmux" succeeded: tmux started claude and Terminal was asked to attach. It is not
 *  an agent (a house) until its transcript's first line, and the folder may still need trusting. */
export function dispatchStartedText(r: LaunchResultLike): string {
  return `${launchSuccessText(r, "Started")} It becomes a house once Claude writes its first line.`;
}

/** The resume guard (resume-guard.ts) fed with what the world knows right now. Until the first
 *  /api/talk/status answer tmux counts as available; callers show "Checking for tmux…" then. */
export function resumeOfferFor(agentId: string, agentStatus: AgentStatus | undefined): ResumeOffer {
  return resumeOffer({
    status: agentStatus === "live" ? "live" : "dormant",
    bound: status?.bindings.some((b) => b.agentId === agentId) ?? false,
    tmuxAvailable: status?.available !== false,
  });
}

/** "Resume here, to chat": claude --resume inside a new tmux session, Terminal attached. Callers
 *  offer it only when resumeOfferFor says "resume": on a live agent it would start a second copy. */
export async function resumeInTmux(ctx: ClientContext, agentId: string): Promise<TalkActionResult> {
  const r = await ctx.api.postJson<TalkActionResult>(`/api/talk/reactivate/${encodeURIComponent(agentId)}`, undefined, (error) => ({ ok: false, error }));
  void refreshStatus(ctx);
  return r;
}

/** How many tmux sessions Alef can type into right now (the status drawer shows it) — a
 *  dispatch/launch still waiting for its first transcript line (agentId null) doesn't count. */
export function talkBindingCount(): number {
  return countActiveBindings(status?.bindings ?? []);
}

/** Dispatches/launches whose tmux session is alive but never grew a transcript — see
 *  StrandedDispatch. Populated from `talk.stranded` (snapshot extras + WS message). */
export function strandedDispatches(): StrandedDispatch[] {
  return stranded;
}
