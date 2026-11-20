// Round 10 §1 — the Room screen opens a chat panel over the room stage (3D room dimmed behind).
// Turns run on the owner's own `claude` CLI, headless (server/features/chat.ts). Header: agent,
// city, model picker (+ "Jev picks" via POST /api/router/route), mode, live agent count, tokens
// and cost. Messages stream in; tool calls are station chips; approvals for this session show
// inline (Alef's existing approval queue). Composer: text, attach (button or drop), Send, Stop.
// Everything from the wire is rendered with textContent: no HTML injection anywhere.

import {
  CHAT_MODELS,
  type ChatActionResult,
  type ChatEvent,
  type ChatMode,
  type ChatModel,
  type ChatOpenResult,
  type ChatView,
  type RouterRouteResult,
} from "../../../../shared/features/chat";
import { station, stationOf } from "../../../../shared/stations";
import { log } from "../../log";
import { decideApproval, onApprovalsChange, pendingApprovals } from "../approvals";
import { h, isRecord } from "../fleet-overlay";
import type { ClientContext, ClientFeature, FeatureMessage } from "../registry";
import { attachmentProblem, formatTokens, formatUsd, isChatModel, needsForkWarning, parseChatEvent, parseChatView, segments, totalTokens } from "./chat-lib";
import "./chat.css";
import { agentTitle } from "../../../../shared/display";

const MODEL_LABEL: Record<ChatModel, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const MODE_LABEL: Record<ChatMode, string> = { normal: "Normal", plan: "Plan", acceptEdits: "Accept edits" };

interface Pending {
  name: string;
  mime: string;
  size: number;
  dataBase64: string;
}

interface PanelDom {
  layer: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  model: HTMLSelectElement;
  mode: HTMLSelectElement;
  jevNote: HTMLElement;
  live: HTMLElement;
  usage: HTMLElement;
  fork: HTMLElement;
  log: HTMLElement;
  approvals: HTMLElement;
  atts: HTMLElement;
  text: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  status: HTMLElement;
}

let ctx: ClientContext | null = null;
let dom: PanelDom | null = null;
let chat: ChatView | null = null;
let agentId: string | null = null;
let liveElsewhere = false;
let forkAck = false;
let attachments: Pending[] = [];
let liveBubble: { el: HTMLElement; text: string } | null = null;
const toolChips = new Map<string, HTMLElement>();
let unsubApprovals: (() => void) | null = null;
let storeHooked = false;

function isOpen(): boolean {
  return !!dom && dom.layer.isConnected;
}

function btn(label: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function select<T extends string>(label: string, title: string, options: readonly T[], names: Record<T, string>, value: T): { wrap: HTMLElement; el: HTMLSelectElement } {
  const wrap = h("label", "cht-field");
  wrap.title = title;
  wrap.append(h("span", "cht-field-label", label));
  const el = h("select", "cht-select");
  for (const o of options) {
    const opt = h("option", undefined, names[o]);
    opt.value = o;
    el.append(opt);
  }
  el.value = value;
  wrap.append(el);
  return { wrap, el };
}

function close(): void {
  unsubApprovals?.();
  unsubApprovals = null;
  dom?.layer.remove();
  dom = null;
  liveBubble = null;
  toolChips.clear();
}

/** Opens (or re-opens) the chat for `id` over the Room stage. `stage` = the room's 3D stage element. */
export function openRoomChat(c: ClientContext, id: string, stage: HTMLElement): void {
  ctx = c;
  if (isOpen() && agentId === id) {
    dom?.text.focus();
    return;
  }
  close();
  agentId = id;
  chat = null;
  forkAck = false;
  liveElsewhere = false;
  attachments = [];
  dom = build(c, stage.parentElement ?? stage);
  hookStore(c);
  unsubApprovals = onApprovalsChange(() => renderApprovals());
  renderHeader();
  void openChat(c, { agentId: id });
}

async function openChat(c: ClientContext, body: { agentId?: string; islandId?: string }): Promise<void> {
  if (!dom) return;
  dom.log.replaceChildren(h("p", "cht-empty", "Opening the chat…"));
  const r = await c.api.postJson<ChatOpenResult>("/api/chat/open", body, (error) => ({ ok: false, error }));
  if (!dom) return;
  const view = r.ok ? parseChatView(r.chat) : null;
  if (!view) {
    dom.log.replaceChildren(notice("error", `Could not open the chat: ${r.error ?? "bad response"}`));
    return;
  }
  chat = view;
  liveElsewhere = r.liveElsewhere === true;
  forkAck = false;
  dom.log.replaceChildren();
  liveBubble = null;
  toolChips.clear();
  const events = Array.isArray(r.events) ? r.events : [];
  if (events.length === 0) {
    dom.log.append(
      h(
        "p",
        "cht-empty",
        view.originAgentId
          ? "Type a message: it continues this session with your own claude CLI (headless, in its folder)."
          : "A new chat in this city: your first message starts a fresh session in its folder.",
      ),
    );
  }
  for (const e of events) {
    const ev = parseChatEvent(e);
    if (ev) renderEvent(ev);
  }
  renderHeader();
  renderApprovals();
  dom.text.focus();
}

function build(c: ClientContext, host: HTMLElement): PanelDom {
  const layer = h("div", "cht-layer");
  layer.addEventListener("click", (ev) => {
    if (ev.target === layer) close();
  });
  const card = h("section", "cht-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Chat with this agent");
  card.addEventListener("keydown", (ev) => {
    // main.ts ignores keys typed in a textarea, so Esc from the composer is handled here.
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  });

  // header
  const head = h("header", "cht-head");
  const titles = h("div", "cht-titles");
  const title = h("div", "cht-title");
  const sub = h("div", "cht-sub");
  titles.append(title, sub);
  const newBtn = btn("New chat here", "rm-pill", "Start a fresh session in this agent's city (same folder)", () => {
    const a = agentId ? c.store.agents.get(agentId) : undefined;
    if (a) void openChat(c, { islandId: a.islandId });
  });
  const closeBtn = btn("Close (Esc)", "rm-pill", "Back to the room", () => close());
  head.append(titles, newBtn, closeBtn);

  const bar = h("div", "cht-bar");
  const model = select<ChatModel>("Model", "Model for the next message (applies per message)", CHAT_MODELS, MODEL_LABEL, "sonnet");
  const jevBtn = btn("Jev picks", "rm-pill cht-jev", "Ask Jev which model fits the message you typed", () => void jevPick());
  const jevNote = h("span", "cht-jev-note");
  const mode = select<ChatMode>("Mode", "Permission mode for the next message", ["normal", "plan", "acceptEdits"], MODE_LABEL, "normal");
  const live = h("span", "cht-chip");
  live.title = "Claude sessions live on this Mac right now";
  const usage = h("span", "cht-chip");
  usage.title = "Tokens: summed per turn in this chat. Cost: the session's running total as Claude reports it (includes earlier spend on a resumed session).";
  model.el.addEventListener("change", () => (jevNote.textContent = ""));
  bar.append(model.wrap, jevBtn, mode.wrap, live, usage, jevNote);

  const fork = h("div", "cht-fork");
  fork.hidden = true;

  const logEl = h("div", "cht-log");
  logEl.setAttribute("aria-live", "polite");
  const approvals = h("div", "cht-approvals");

  // composer
  const comp = h("div", "cht-compose");
  const atts = h("div", "cht-atts");
  const text = h("textarea", "cht-text");
  text.placeholder = "Message this agent… (Enter to send, Shift+Enter for a new line)";
  text.rows = 3;
  text.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void send();
    }
  });
  const file = h("input", "cht-file");
  file.type = "file";
  file.multiple = true;
  file.accept = "image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.log,.yaml,.yml,.ts,.js,.py";
  file.hidden = true;
  file.addEventListener("change", () => {
    void addFiles([...(file.files ?? [])]);
    file.value = "";
  });
  const attach = btn("Attach", "rm-pill", "Attach images or text files (or drop them here), 10 MB each", () => file.click());
  const sendBtn = btn("Send", "comic-btn small", "Send (Enter)", () => void send());
  const stop = btn("Stop", "comic-btn small secondary", "Stop this turn (interrupts only this chat's claude process)", () => void stopTurn());
  const status = h("span", "cht-status");
  const row = h("div", "cht-row");
  row.append(attach, status, stop, sendBtn);
  comp.append(atts, text, file, row);

  card.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    card.classList.add("cht-drop");
  });
  card.addEventListener("dragleave", (ev) => {
    if (ev.target === card) card.classList.remove("cht-drop");
  });
  card.addEventListener("drop", (ev) => {
    ev.preventDefault();
    card.classList.remove("cht-drop");
    void addFiles([...(ev.dataTransfer?.files ?? [])]);
  });

  card.append(head, bar, fork, logEl, approvals, comp);
  layer.append(card);
  host.append(layer);
  return { layer, title, sub, model: model.el, mode: mode.el, jevNote, live, usage, fork, log: logEl, approvals, atts, text, send: sendBtn, stop, status };
}

function hookStore(c: ClientContext): void {
  if (storeHooked) return;
  storeHooked = true;
  c.store.onAgents(() => isOpen() && renderHeader());
  c.store.onStats(() => isOpen() && renderHeader());
}

function renderHeader(): void {
  const c = ctx;
  if (!c || !dom) return;
  const a = agentId ? c.store.agents.get(agentId) : undefined;
  const island = c.store.islands.get(chat?.islandId ?? a?.islandId ?? "");
  const who = chat && !chat.originAgentId ? chat.title || "New chat" : (a && agentTitle(a)) || "this agent";
  dom.title.textContent = `Chat · ${who}`;
  dom.sub.textContent = `${island?.name ?? chat?.islandId ?? a?.islandId ?? "?"} · ${chat?.cwd ?? a?.cwd ?? ""}${chat?.forked ? " · forked copy" : ""}`;
  const liveCount = c.store.effectiveStats().liveCount;
  dom.live.textContent = `${liveCount} live agent${liveCount === 1 ? "" : "s"}`;
  dom.usage.textContent = chat ? `${formatTokens(totalTokens(chat.usage))} tokens · ${chat.sessionCostUsd === null ? "no cost yet" : `${formatUsd(chat.sessionCostUsd)} session`}` : "0 tokens";
  const running = chat?.running === true;
  dom.send.disabled = running || !chat;
  dom.stop.disabled = !running;
  dom.status.textContent = running ? "claude is working…" : "";
  const warn = chat ? needsForkWarning({ liveElsewhere, turns: chat.turns, forked: chat.forked, acknowledged: forkAck }) : false;
  dom.fork.hidden = !warn;
  if (warn) {
    const ok = btn("Continue here as a fork", "rm-pill", "Your next message continues a copy of the session; the open terminal keeps the original", () => {
      forkAck = true;
      renderHeader();
    });
    dom.fork.replaceChildren(h("strong", undefined, "This session is open in a terminal or VS Code. "), h("span", undefined, "Continuing here creates a fork: a copy of the conversation, the original stays where it is. "), ok);
  }
}

function notice(level: "info" | "warn" | "error", text: string): HTMLElement {
  const p = h("p", `cht-notice cht-${level}`, text);
  p.setAttribute("role", level === "error" ? "alert" : "status");
  return p;
}

function fillRich(el: HTMLElement, text: string): void {
  el.replaceChildren();
  for (const s of segments(text)) {
    if (s.kind === "block") {
      const pre = h("pre", "cht-pre");
      pre.append(h("code", undefined, s.text));
      el.append(pre);
    } else if (s.kind === "code") el.append(h("code", "cht-code", s.text));
    else if (s.kind === "bold") el.append(h("strong", undefined, s.text));
    else el.append(document.createTextNode(s.text));
  }
}

function scrollDown(): void {
  if (!dom) return;
  const l = dom.log;
  l.scrollTop = l.scrollHeight;
}

function renderEvent(ev: ChatEvent): void {
  if (!dom) return;
  const l = dom.log;
  l.querySelector(".cht-empty")?.remove();
  switch (ev.kind) {
    case "user": {
      liveBubble = null;
      const b = h("div", "cht-msg cht-user");
      b.append(h("div", "cht-body", ev.text));
      const meta = [MODEL_LABEL[ev.model] ?? ev.model, MODE_LABEL[ev.mode] ?? ev.mode, ...ev.attachments.map((n) => `📎 ${n}`)];
      b.append(h("div", "cht-meta", meta.join(" · ")));
      l.append(b);
      break;
    }
    case "text-delta": {
      if (!liveBubble) {
        const el = h("div", "cht-msg cht-bot");
        const body = h("div", "cht-body");
        el.append(body);
        l.append(el);
        liveBubble = { el: body, text: "" };
      }
      liveBubble.text += ev.text;
      liveBubble.el.textContent = liveBubble.text;
      break;
    }
    case "assistant-text": {
      if (liveBubble) fillRich(liveBubble.el, ev.text);
      else {
        const el = h("div", "cht-msg cht-bot");
        const body = h("div", "cht-body");
        fillRich(body, ev.text);
        el.append(body);
        l.append(el);
      }
      liveBubble = null;
      break;
    }
    case "tool": {
      liveBubble = null;
      const st = station(stationOf(ev.tool.name));
      const chip = h("div", "cht-tool");
      chip.style.setProperty("--st", st.color);
      chip.title = st.description;
      chip.append(h("span", "cht-tool-st", `${st.emoji} ${st.label}`), h("span", "cht-tool-name", ev.tool.name), h("span", "cht-tool-sum", ev.tool.summary));
      if (ev.tool.id) toolChips.set(ev.tool.id, chip);
      l.append(chip);
      break;
    }
    case "tool-result": {
      const chip = toolChips.get(ev.toolUseId);
      if (chip && ev.isError) {
        chip.classList.add("cht-tool-err");
        chip.title = ev.preview || "the tool call failed";
      }
      break;
    }
    case "denied":
      l.append(notice("warn", `${ev.toolName} was denied: ${ev.reason}`));
      break;
    case "retry":
      l.append(notice("info", `API retry #${ev.attempt} (${ev.error})`));
      break;
    case "result": {
      liveBubble = null;
      const secs = ev.durationMs !== null ? `${(ev.durationMs / 1000).toFixed(1)}s` : "";
      const tok = formatTokens(totalTokens(ev.usage));
      l.append(h("p", "cht-done", [ev.ok ? "Done" : `Ended: ${ev.subtype}`, secs, `${tok} tokens`].filter(Boolean).join(" · ")));
      break;
    }
    case "notice":
      liveBubble = null;
      l.append(notice(ev.level, ev.text));
      break;
    default:
      break;
  }
  scrollDown();
}

function renderApprovals(): void {
  const c = ctx;
  if (!c || !dom) return;
  const sid = chat?.sessionId;
  const mine = sid ? pendingApprovals().filter((a) => a.agentId === sid) : [];
  dom.approvals.replaceChildren(
    ...mine.map((a) => {
      const card = h("div", "cht-appr");
      card.append(h("div", "cht-appr-title", `Approve ${a.toolName}? ${a.preview.title}`));
      if (a.preview.body) card.append(h("pre", "cht-pre", a.preview.body));
      const row = h("div", "cht-row");
      row.append(
        btn("Allow", "comic-btn small", "Let claude run this tool call", () => void decideApproval(c, a.id, "allow")),
        btn("Deny", "comic-btn small secondary", "Refuse this tool call", () => void decideApproval(c, a.id, "deny")),
      );
      card.append(row);
      return card;
    }),
  );
}

function readBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = typeof r.result === "string" ? r.result : "";
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(f);
  });
}

async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    const problem = attachmentProblem({ name: f.name, size: f.size, type: f.type }, attachments.length);
    if (problem) {
      ctx?.toast(problem, "error");
      continue;
    }
    try {
      attachments.push({ name: f.name, mime: f.type, size: f.size, dataBase64: await readBase64(f) });
    } catch (err) {
      log.warn("chat", "could not read attachment", err);
      ctx?.toast(`Could not read ${f.name}.`, "error");
    }
  }
  renderAtts();
}

function renderAtts(): void {
  if (!dom) return;
  dom.atts.replaceChildren(
    ...attachments.map((a, i) => {
      const chip = h("span", "cht-att");
      chip.append(h("span", undefined, `📎 ${a.name} (${formatTokens(a.size)}B)`));
      chip.append(
        btn("Remove", "cht-att-x", `Remove ${a.name}`, () => {
          attachments.splice(i, 1);
          renderAtts();
        }),
      );
      return chip;
    }),
  );
}

async function send(): Promise<void> {
  const c = ctx;
  if (!c || !dom || !chat || chat.running) return;
  const text = dom.text.value.trim();
  if (!text && attachments.length === 0) return;
  if (needsForkWarning({ liveElsewhere, turns: chat.turns, forked: chat.forked, acknowledged: forkAck })) {
    dom.status.textContent = "Confirm the fork above first.";
    return;
  }
  const model = isChatModel(dom.model.value) ? dom.model.value : "sonnet";
  const mode = (["normal", "plan", "acceptEdits"] as const).find((m) => m === dom?.mode.value) ?? "normal";
  dom.send.disabled = true;
  dom.status.textContent = "Starting claude…";
  const body = { text, model, mode, forkAcknowledged: forkAck, attachments: attachments.map(({ name, mime, dataBase64 }) => ({ name, mime, dataBase64 })) };
  const r = await c.api.postJson<ChatActionResult>(`/api/chat/${encodeURIComponent(chat.id)}/turn`, body, (error) => ({ ok: false, error }), 120_000);
  if (!dom) return;
  if (!r.ok) {
    dom.send.disabled = false;
    dom.status.textContent = "";
    dom.log.append(notice("error", `Not sent: ${r.error ?? "unknown error"}`));
    scrollDown();
    return;
  }
  dom.text.value = "";
  attachments = [];
  renderAtts();
}

async function stopTurn(): Promise<void> {
  const c = ctx;
  if (!c || !chat) return;
  const r = await c.api.postJson<ChatActionResult>(`/api/chat/${encodeURIComponent(chat.id)}/stop`, {}, (error) => ({ ok: false, error }));
  if (!r.ok && dom) dom.status.textContent = `Stop failed: ${r.error ?? "unknown"}`;
}

async function jevPick(): Promise<void> {
  const c = ctx;
  if (!c || !dom) return;
  const prompt = dom.text.value.trim();
  if (!prompt) {
    dom.jevNote.textContent = "Type your message first, then ask Jev.";
    return;
  }
  dom.jevNote.textContent = "Jev is thinking…";
  const r = await c.api.postJson<Partial<RouterRouteResult>>("/api/router/route", { prompt, cwd: chat?.cwd }, (error) => ({ ok: false, error }));
  if (!dom) return;
  if (r.ok === true && isChatModel(r.model)) {
    dom.model.value = r.model;
    dom.jevNote.textContent = `Jev picked ${MODEL_LABEL[r.model]}: ${typeof r.why === "string" ? r.why : ""} (you can change it)`;
  } else {
    dom.jevNote.textContent = `Jev has no advice${typeof r.why === "string" && r.why ? `: ${r.why}` : ""}; pick a model yourself.`;
  }
}

export const chatFeature: ClientFeature = {
  id: "chat",
  mount(c) {
    ctx = c;
  },
  onMessage(msg: FeatureMessage) {
    const p = msg.payload;
    if (!isRecord(p) || !isOpen() || !chat) return;
    if (p.kind === "chat") {
      const v = parseChatView(p.chat);
      if (v && v.id === chat.id) {
        chat = v;
        renderHeader();
        renderApprovals();
      }
    } else if (p.kind === "event" && p.chatId === chat.id) {
      const ev = parseChatEvent(p.event);
      if (ev) renderEvent(ev);
    }
  },
  onEscape() {
    if (!isOpen()) return false;
    close();
    return true;
  },
};
