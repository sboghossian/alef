// A3 — live todo progress: a comic checklist card floating over each agent's house
// ("3/7 · Now: <activeForm>" + progress ring), the full list in the agent panel, and
// the same list pinned beside the room when you visit an agent.

import { todoProgress, type TodoItem, type TodoList } from "../../../shared/features/todos";
import { h, isRecord, overlayLayer, place, refreshAgentPanel, roomAgentId, toScreen, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";

const MAX_CARDS = 8;
const RECENT_MS = 2 * 3600_000;
const SLOT = "fx-todos";

const lists = new Map<string, TodoList>();
const cards = new Map<string, HTMLElement>();
const requested = new Set<string>();
let roomCard: HTMLElement | null = null;

function isItem(v: unknown): v is TodoItem {
  return (
    isRecord(v) &&
    typeof v.content === "string" &&
    (v.status === "pending" || v.status === "in_progress" || v.status === "completed") &&
    (v.activeForm === null || typeof v.activeForm === "string")
  );
}

export function parseTodoList(v: unknown): TodoList | null {
  if (!isRecord(v) || typeof v.agentId !== "string" || typeof v.updatedAt !== "string" || !Array.isArray(v.items)) return null;
  return { agentId: v.agentId, updatedAt: v.updatedAt, items: v.items.filter(isItem) };
}

/** "3/7 · Now: Running tests" — or Next:/All done when nothing is in progress. */
export function todoHeadline(list: TodoList): string {
  const { done, total, current } = todoProgress(list);
  if (total === 0) return "No todos";
  if (current) return `${done}/${total} · Now: ${current.activeForm ?? current.content}`;
  if (done === total) return `${done}/${total} · All done`;
  const next = list.items.find((i) => i.status === "pending");
  return `${done}/${total} · Next: ${next?.content ?? ""}`;
}

function ring(done: number, total: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "td-ring");
  svg.setAttribute("aria-hidden", "true");
  const c = 2 * Math.PI * 14;
  const bg = document.createElementNS(ns, "circle");
  bg.setAttribute("cx", "18");
  bg.setAttribute("cy", "18");
  bg.setAttribute("r", "14");
  bg.setAttribute("class", "td-ring-bg");
  const fg = document.createElementNS(ns, "circle");
  fg.setAttribute("cx", "18");
  fg.setAttribute("cy", "18");
  fg.setAttribute("r", "14");
  fg.setAttribute("class", "td-ring-fg");
  fg.setAttribute("stroke-dasharray", `${(total ? done / total : 0) * c} ${c}`);
  svg.append(bg, fg);
  return svg;
}

function statusGlyph(s: TodoItem["status"]): string {
  return s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐";
}

function listEl(list: TodoList): HTMLElement {
  const ul = h("ul", "td-list");
  for (const item of list.items) {
    const li = h("li", `td-${item.status}`);
    li.append(h("span", "td-glyph", statusGlyph(item.status)), h("span", "td-text", item.status === "in_progress" && item.activeForm ? item.activeForm : item.content));
    ul.appendChild(li);
  }
  return ul;
}

/** The boot snapshot only covers recent sessions; ask the server once for an older agent's list. */
function fetchList(ctx: ClientContext, agentId: string): void {
  if (requested.has(agentId)) return;
  requested.add(agentId);
  void ctx.api.getJson<unknown>(`/api/todos/${encodeURIComponent(agentId)}`).then((v) => {
    const l = parseTodoList(v);
    if (l && l.items.length > 0) ingest(l, ctx);
  });
}

function renderPanel(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  const list = lists.get(agentId);
  if (!list) {
    fetchList(ctx, agentId);
    return;
  }
  if (list.items.length === 0) return;
  const { done, total } = todoProgress(list);
  const head = h("h3", "td-head");
  head.append(ring(done, total), h("span", undefined, `Todos ${done}/${total}`));
  slot.append(head, listEl(list));
}

function cardFor(agentId: string, list: TodoList): HTMLElement {
  let el = cards.get(agentId);
  if (!el) {
    el = h("div", "td-card");
    el.dataset.agent = agentId;
    overlayLayer().appendChild(el);
    cards.set(agentId, el);
  }
  const key = `${list.updatedAt}|${list.items.length}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    const { done, total } = todoProgress(list);
    el.replaceChildren(ring(done, total), h("span", "td-line", todoHeadline(list)));
    el.classList.toggle("td-alldone", done === total);
  }
  return el;
}

function dropCard(agentId: string): void {
  cards.get(agentId)?.remove();
  cards.delete(agentId);
}

function renderRoom(ctx: ClientContext): void {
  const id = roomAgentId(ctx);
  const list = id ? lists.get(id) : undefined;
  if (id && !list) fetchList(ctx, id);
  if (!list || list.items.length === 0) {
    if (roomCard) roomCard.hidden = true;
    return;
  }
  if (!roomCard) {
    roomCard = h("aside", "td-room");
    roomCard.setAttribute("aria-label", "Agent todo list");
    document.body.appendChild(roomCard);
  }
  const { done, total } = todoProgress(list);
  const head = h("h4", "td-head");
  head.append(ring(done, total), h("span", undefined, `Todos ${done}/${total}`));
  roomCard.replaceChildren(head, listEl(list));
  roomCard.hidden = false;
}

function ingest(list: TodoList, ctx: ClientContext): void {
  if (list.items.length === 0) lists.delete(list.agentId);
  else lists.set(list.agentId, list);
  refreshAgentPanel(SLOT, (id, el) => renderPanel(id, el, ctx));
  renderRoom(ctx);
  for (const fn of todoListeners) fn();
}

export const todosFeature: ClientFeature = {
  id: "todos",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
    new MutationObserver(() => renderRoom(ctx)).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  },
  onSnapshot(world, ctx) {
    const raw = world.extras?.["todos.lists"];
    if (!isRecord(raw)) return;
    for (const v of Object.values(raw)) {
      const l = parseTodoList(v);
      if (l) ingest(l, ctx);
    }
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "update" || !Array.isArray(p.lists)) return;
    for (const v of p.lists) {
      const l = parseTodoList(v);
      if (l) ingest(l, ctx);
    }
  },
  onFrame(_dt, ctx) {
    const now = Date.now();
    const shownInPanel = document.getElementById("panel")?.hidden === false ? document.getElementById("panel-content")?.dataset.agentId : undefined;
    const candidates: { id: string; list: TodoList; score: number }[] = [];
    for (const [id, list] of lists) {
      const agent = ctx.store.agents.get(id);
      if (!agent || list.items.length === 0) continue;
      const recent = now - Date.parse(list.updatedAt) < RECENT_MS;
      if (agent.status !== "live" && !recent && id !== shownInPanel) continue;
      candidates.push({ id, list, score: (id === shownInPanel ? 4 : 0) + (agent.status === "live" ? 2 : 0) + (recent ? 1 : 0) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const keep = new Set<string>();
    for (const c of candidates.slice(0, MAX_CARDS)) {
      const pos = ctx.agentPosition(c.id);
      if (!pos) continue;
      keep.add(c.id);
      const el = cardFor(c.id, c.list);
      el.classList.toggle("td-dormant", ctx.store.agents.get(c.id)?.status !== "live");
      place(el, toScreen(ctx, pos));
    }
    for (const id of [...cards.keys()]) if (!keep.has(id)) dropCard(id);
  },
};

// ---- round 5 E: the focus card shows the focused agent's list ----
const todoListeners = new Set<() => void>();

/** The agent's latest todo list (asks the server once when it isn't loaded yet). */
export function todoListFor(ctx: ClientContext, agentId: string): TodoList | undefined {
  const l = lists.get(agentId);
  if (!l) fetchList(ctx, agentId);
  return l;
}

export function todoListElement(list: TodoList): HTMLElement {
  return listEl(list);
}

export function onTodosChange(fn: () => void): () => void {
  todoListeners.add(fn);
  return () => todoListeners.delete(fn);
}
