// Solo mode for the canvas: "Everything | One session". Pure helpers (route parsing, storage,
// the session ranking the picker uses) plus the small header bar. The graph itself is filtered
// by buildGraph's `solo` option (graph.ts); this file only chooses WHICH session.

import { agentTitle } from "../../../../shared/display";
import type { WorldAgent } from "../../../../shared/types";

export const SOLO_KEY = "agent-world.canvas.solo";
export const PICKER_MAX = 30;

/** `#/canvas?session=<id>` (the documented deep link) or `#/canvas/<id>` (what the shell writes). */
export function soloFromHash(hash: string): string | null {
  const m = /^#\/canvas(?:\/([^?#]+))?(?:\?([^#]*))?$/i.exec(hash.trim());
  if (!m) return null;
  let id: string | null = null;
  try {
    id = m[1] ? decodeURIComponent(m[1]) : (new URLSearchParams(m[2] ?? "").get("session") ?? null);
  } catch {
    return null;
  }
  return id && id.length <= 200 ? id : null;
}

export function readStoredSolo(): string | null {
  try {
    return localStorage.getItem(SOLO_KEY) || null;
  } catch {
    return null;
  }
}

export function writeStoredSolo(id: string | null): void {
  try {
    if (id) localStorage.setItem(SOLO_KEY, id);
    else localStorage.removeItem(SOLO_KEY);
  } catch {
    // private mode / blocked storage: the canvas works the same without the memory
  }
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Picker order: live first, then newest activity; `query` matches title, id and folder. */
export function rankSessions(agents: Iterable<WorldAgent>, query: string, limit = PICKER_MAX): WorldAgent[] {
  const q = query.trim().toLowerCase();
  const out: WorldAgent[] = [];
  for (const a of agents) if (!q || `${agentTitle(a)} ${a.id} ${a.cwd ?? ""}`.toLowerCase().includes(q)) out.push(a);
  out.sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || ms(b.lastActive) - ms(a.lastActive) || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface SoloBarHooks {
  /** null = back to Everything. */
  onChange(sessionId: string | null): void;
  agents(): Iterable<WorldAgent>;
  /** Last session solo'd or selected, offered when the user flips to "One session". */
  suggest(): string | null;
}

/** The segmented toggle + session picker that sits at the top of the canvas. */
export class SoloBar {
  readonly el: HTMLElement;
  private readonly allBtn: HTMLButtonElement;
  private readonly oneBtn: HTMLButtonElement;
  private readonly picker: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private current: string | null = null;
  private picking = false;

  constructor(private readonly hooks: SoloBarHooks) {
    this.el = el("div", "cv-solo");
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Canvas scope");
    const seg = el("div", "cv-solo-seg");
    this.allBtn = el("button", "cv-solo-btn", "Everything");
    this.oneBtn = el("button", "cv-solo-btn", "One session");
    for (const b of [this.allBtn, this.oneBtn]) b.type = "button";
    this.allBtn.title = "The whole canvas: every session and what they share";
    this.oneBtn.title = "Isolate one session: only its subagents, tools, files and artifacts";
    seg.append(this.allBtn, this.oneBtn);
    this.note = el("span", "cv-solo-note");
    this.picker = el("div", "cv-solo-picker");
    this.picker.hidden = true;
    this.input = el("input", "cv-solo-input");
    this.input.type = "search";
    this.input.placeholder = "Search sessions (live first)";
    this.input.setAttribute("aria-label", "Search sessions");
    this.list = el("div", "cv-solo-list");
    this.list.setAttribute("role", "listbox");
    this.picker.append(this.input, this.list);
    this.el.append(seg, this.note, this.picker);

    this.allBtn.addEventListener("click", () => {
      this.closePicker();
      if (this.current) this.hooks.onChange(null);
    });
    this.oneBtn.addEventListener("click", () => {
      if (this.current) return;
      const s = this.hooks.suggest();
      if (s) this.hooks.onChange(s);
      else this.openPicker();
    });
    this.note.addEventListener("click", () => this.openPicker());
    this.input.addEventListener("input", () => this.renderList());
    this.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.closePicker();
      } else if (ev.key === "Enter") {
        const first = rankSessions(this.hooks.agents(), this.input.value, 1)[0];
        if (first) this.choose(first.id);
      }
    });
    this.list.addEventListener("click", (ev) => {
      const id = (ev.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
      if (id) this.choose(id);
    });
    this.sync();
  }

  private choose(id: string): void {
    this.closePicker();
    this.hooks.onChange(id);
  }

  openPicker(): void {
    this.picking = true;
    this.picker.hidden = false;
    this.input.value = "";
    this.renderList();
    this.input.focus();
    this.sync();
  }

  isPicking(): boolean {
    return this.picking;
  }

  closePicker(): void {
    this.picking = false;
    this.picker.hidden = true;
    this.sync();
  }

  /** Shows which session is solo'd (null = Everything). `title` is its display name. */
  set(id: string | null, title: string | null): void {
    this.current = id;
    this.picking = false;
    this.picker.hidden = true;
    this.note.textContent = id ? `${title ?? id} · change` : "";
    this.note.title = id ? "Pick another session (Esc: back to everything)" : "";
    this.sync();
  }

  private sync(): void {
    const one = this.current !== null;
    this.allBtn.classList.toggle("cv-on", !one);
    this.oneBtn.classList.toggle("cv-on", one || this.picking);
    this.allBtn.setAttribute("aria-pressed", String(!one));
    this.oneBtn.setAttribute("aria-pressed", String(one));
    this.note.hidden = !one;
  }

  private renderList(): void {
    this.list.replaceChildren();
    const rows = rankSessions(this.hooks.agents(), this.input.value);
    if (rows.length === 0) this.list.append(el("div", "cv-solo-empty", "No session matches."));
    for (const a of rows) {
      const row = el("button", `cv-solo-row${a.status === "live" ? " cv-live" : ""}`);
      row.type = "button";
      row.dataset.id = a.id;
      row.setAttribute("role", "option");
      row.append(el("span", "cv-solo-dot"), el("span", "cv-solo-title", agentTitle(a)), el("span", "cv-solo-meta", a.status === "live" ? "live" : (a.lastActive || "").slice(0, 10)));
      this.list.append(row);
    }
  }
}
