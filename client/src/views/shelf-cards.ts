// The Library's item cards (By type, Pinned, and each project's Shelf tab) and the item details panel. Titles, URLs and paths are untrusted text:
// textContent only, and an href only for http(s) (safeHref). ?redact=1 shows types and kinds only.

import { agentTitle } from "../../../shared/display";
import { SHELF_TYPE_META, type ShelfBoardItem, type ShelfPin } from "../../../shared/features/shelf-board";
import type { ViewContext } from "../shell/views";
import { ago, safeHref, shownKind, shownTitle } from "./shelf-lib";

export interface CardEnv {
  redact: boolean;
  /** Pinned ids → the shelves (sections) each sits on; one item can sit on several. */
  pinned: ReadonlyMap<string, readonly string[]>;
  sections: readonly string[];
  districtName(id: string | null): string | null;
  open(id: string): void;
  /** Pins to one more shelf. */
  pin(id: string, section: string): void;
  /** Moves the item's pin on `from` to `to` (its other shelves stay). */
  move(id: string, from: string, to: string): void;
  /** Unpins from `section`, or from every shelf when it is omitted. */
  unpin(id: string, section?: string): void;
  /** Opens the card's "⋯" menu under `anchor`. */
  menu(anchor: HTMLElement, entries: readonly MenuEntry[]): void;
}

export type MenuEntry = { heading: string } | { label: string; run(): void };

/** Drag payload: the item id, and the shelf it is dragged from (none from "Found in sessions"). */
export const DRAG_ID = "text/x-shelf-item";
export const DRAG_FROM = "text/x-shelf-from";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A pin with no live item behind it yet (seeded, or not seen in a transcript) as a card item. */
export function pinAsItem(p: ShelfPin): ShelfBoardItem {
  return { id: p.itemId, type: p.type, url: p.url, path: p.path, title: p.title, kind: p.type, firstSeen: p.pinnedAt, lastSeen: null, count: 0, sessions: [], district: null, source: "pin", typed: true, score: 0 };
}

/** The "⋯" menu of a card on shelf `shelf` (null: a card in "Found in sessions"). */
export function menuEntries(id: string, shelf: string | null, env: Pick<CardEnv, "pinned" | "sections" | "pin" | "move" | "unpin">): MenuEntry[] {
  const on = env.pinned.get(id) ?? [];
  const elsewhere = env.sections.filter((s) => !on.includes(s));
  const out: MenuEntry[] = [];
  if (shelf && elsewhere.length) out.push({ heading: "Move to…" }, ...elsewhere.map((s) => ({ label: s, run: () => env.move(id, shelf, s) })));
  if (elsewhere.length) out.push({ heading: on.length ? "Also pin to…" : "Pin to…" }, ...elsewhere.map((s) => ({ label: s, run: () => env.pin(id, s) })));
  const unpins: MenuEntry[] = [];
  if (shelf) unpins.push({ label: `Unpin from ${shelf}`, run: () => env.unpin(id, shelf) });
  if (on.length > 1 || (!shelf && on.length === 1)) unpins.push({ label: on.length > 1 ? `Unpin from all ${on.length} shelves` : `Unpin from ${on[0]}`, run: () => env.unpin(id) });
  if (unpins.length) out.push({ heading: "Unpin" }, ...unpins);
  return out;
}

/** One card. `n` numbers the redacted placeholder title; `shelf` is the shelf it sits on (null in
 *  "Found in sessions"). Every card drags (onto a shelf: pin, or move when it comes from a shelf). */
export function card(i: ShelfBoardItem, n: number, env: CardEnv, shelf: string | null): HTMLElement {
  const c = el("div", `sv-card is-${i.type}`);
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.dataset.id = i.id;
  const on = env.pinned.get(i.id) ?? [];
  const top = el("div", "sv-card-top");
  top.append(el("span", "sv-type", SHELF_TYPE_META[i.type].emoji), el("span", "sv-kind", shownKind(i, env.redact)));
  if (i.type === "dashable" && i.up !== undefined && i.up !== null) {
    const dot = el("span", `sv-dot ${i.up ? "is-up" : "is-down"}`);
    dot.title = i.up ? "Up (local port answers)" : "Down (local port closed)";
    top.append(dot);
  }
  const star = el("button", `sv-star${on.length ? " is-on" : ""}`, on.length ? "★" : "☆");
  star.type = "button";
  star.title = shelf ? `Unpin from ${shelf}` : on.length ? `Pinned to ${on.join(", ")}: click to unpin` : "Pin to Unsorted";
  star.setAttribute("aria-label", star.title);
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    if (shelf) env.unpin(i.id, shelf);
    else if (on.length) env.unpin(i.id);
    else env.pin(i.id, "Unsorted");
  });
  const more = el("button", "sv-menu-btn", "⋯");
  more.type = "button";
  more.title = "Pin, move or unpin";
  more.setAttribute("aria-label", "Pin, move or unpin");
  more.setAttribute("aria-haspopup", "menu");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    env.menu(more, menuEntries(i.id, shelf, env));
  });
  more.addEventListener("keydown", (e) => e.stopPropagation());
  top.append(star, more);
  const foot = el("div", "sv-foot");
  const district = env.districtName(i.district);
  if (district) foot.append(el("span", "sv-district", district));
  if (i.count) foot.append(el("span", "", `${i.count}×`));
  if (i.lastSeen) foot.append(el("span", "", ago(i.lastSeen, Date.now())));
  if (i.typed && i.source !== "pin") foot.append(el("span", "sv-typed", "typed"));
  if (!shelf && on.length > 1) foot.append(el("span", "sv-onshelves", `on ${on.length} shelves`));
  c.append(top, el("div", "sv-title", shownTitle(i, env.redact, n)), foot);
  c.draggable = true;
  c.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData(DRAG_ID, i.id);
    if (shelf) e.dataTransfer?.setData(DRAG_FROM, shelf);
    c.classList.add("is-dragging");
  });
  c.addEventListener("dragend", () => c.classList.remove("is-dragging"));
  c.addEventListener("click", () => env.open(i.id));
  c.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      env.open(i.id);
    }
  });
  return c;
}

function row(label: string, value: string): HTMLElement {
  const r = el("div", "sv-prow");
  r.append(el("b", "", label), el("span", "", value));
  return r;
}

export function renderPanel(panel: HTMLElement, i: ShelfBoardItem, env: CardEnv & { ctx: ViewContext; close(): void; openProjects: string | null }): void {
  const head = el("div", "sv-panel-head");
  head.append(el("span", "sv-panel-title", `${SHELF_TYPE_META[i.type].emoji} ${env.redact ? SHELF_TYPE_META[i.type].label : i.title}`));
  const x = el("button", "sv-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", env.close);
  head.append(x);
  const body = el("div", "sv-panel-body");
  const href = env.redact ? null : safeHref(i.url);
  if (href) {
    const a = el("a", "sv-open", "Open ↗");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    body.append(a, el("p", "sv-url", href));
  }
  if (i.path && !env.redact) {
    body.append(el("p", "sv-url", i.path));
    if (env.openProjects) {
      const b = el("button", "sv-btn", "Open project in Library");
      b.type = "button";
      const id = env.openProjects;
      b.addEventListener("click", () => env.ctx.showView("library", id));
      body.append(b);
    }
  }
  body.append(row("Type", `${SHELF_TYPE_META[i.type].label} · ${shownKind(i, env.redact)}`));
  if (i.count) body.append(row("Seen", `${i.count}× · first ${ago(i.firstSeen, Date.now())} ago · last ${ago(i.lastSeen, Date.now())} ago`));
  body.append(row("From", i.typed ? "you typed or pasted it" : i.source === "assistant" ? "an assistant's answer" : i.source === "pin" ? "your shelf" : i.source));
  const on = env.pinned.get(i.id) ?? [];
  const shelves = el("div", "sv-pinrow");
  for (const sec of env.sections) {
    const b = el("button", `sv-chip${on.includes(sec) ? " is-on" : ""}`, sec);
    b.type = "button";
    b.setAttribute("aria-pressed", String(on.includes(sec)));
    b.addEventListener("click", () => (on.includes(sec) ? env.unpin(i.id, sec) : env.pin(i.id, sec)));
    shelves.append(b);
  }
  body.append(el("h3", "sv-h", on.length ? `On ${on.length === 1 ? "the shelf" : `${on.length} shelves`} (click to toggle)` : "Pin to a shelf"), shelves);
  if (i.sessions.length) {
    body.append(el("h3", "sv-h", "Where it was seen"));
    for (const id of i.sessions) {
      const a = env.ctx.store.agents.get(id);
      const b = el("button", "sv-session", a && !env.redact ? agentTitle(a) : `session ${id.slice(0, 8)}`);
      b.type = "button";
      b.addEventListener("click", () => env.ctx.selection.set({ kind: "agent", id }));
      body.append(b);
    }
  }
  panel.replaceChildren(head, body);
  panel.hidden = false;
}
