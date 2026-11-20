// The left sidebar's view sections (under the one search): an "active filters" summary with a
// reset, then one collapsible group per FilterSpec. State logic is pure and tested (views.ts:
// initialFilterState / toggleFilter / activeFilterChips / orderListRows); this is only the DOM.
//
// Re-rendering is cheap and frequent (views call refreshFilters() when counts change), so the
// things a user is in the middle of survive it: a "section" host and a "search" input are
// created once per view and re-attached, list scroll positions and keyboard focus are restored.

import { escapeHtml } from "../ui/fuzzy";
import { safeLocalStorage } from "../ui/kit";
import { activeFilterChips, groupListRows, orderListRows, type ActiveChip, type FilterOption, type FilterSpec, type FilterState } from "./views";
import "./sidebar.css";

const FOLD_KEY = "alef.filters.folded.";
const PIN_KEY = "alef.pins.";
const SORT_KEY = "alef.sort.";

function readJson<T>(key: string, fallback: T, ok: (v: unknown) => v is T): T {
  try {
    const raw = safeLocalStorage()?.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : fallback;
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string): void {
  try {
    safeLocalStorage()?.setItem(key, value);
  } catch {
    /* not remembered */
  }
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function folded(viewId: string, spec: FilterSpec): boolean {
  try {
    const raw = safeLocalStorage()?.getItem(`${FOLD_KEY}${viewId}.${spec.id}`);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    /* default */
  }
  return spec.collapsed === true;
}

/** Pins are keyed by spec id only, so "district" pins follow you across Orbit, Board, District… */
function pins(spec: FilterSpec): string[] {
  return readJson(`${PIN_KEY}${spec.id}`, [], isStrings);
}
function sortOf(viewId: string, spec: FilterSpec): "activity" | "name" {
  try {
    return safeLocalStorage()?.getItem(`${SORT_KEY}${viewId}.${spec.id}`) === "name" ? "name" : "activity";
  } catch {
    return "activity";
  }
}

function sparkSvg(values: readonly number[]): string {
  if (values.length < 2) return "";
  const max = Math.max(1, ...values);
  const w = 34;
  const h = 12;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
  const last = values[values.length - 1] ?? 0;
  return `<svg class="alef-spark${last > 0 ? " hot" : ""}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export interface SectionHandlers {
  onToggle(spec: FilterSpec, value: string): void;
  onSearch(spec: FilterSpec, text: string): void;
  onRemoveChip(chip: ActiveChip): void;
  onReset(): void;
}

interface Kept {
  el: HTMLElement;
  cleanup?: () => void;
}

export class SidebarSections {
  private viewId = "";
  private readonly kept = new Map<string, Kept>();
  private readonly showAll = new Set<string>();

  constructor(private readonly host: HTMLElement) {}

  /** The view changed: run section cleanups and forget their hosts. */
  dispose(): void {
    for (const k of this.kept.values()) {
      try {
        k.cleanup?.();
      } catch {
        /* a view's cleanup must not break the shell */
      }
    }
    this.kept.clear();
    this.showAll.clear();
  }

  render(viewId: string, viewName: string, specs: readonly FilterSpec[], state: FilterState, h: SectionHandlers): void {
    if (viewId !== this.viewId) {
      this.dispose();
      this.viewId = viewId;
    }
    // Survive the re-render: focus, and each list's scroll.
    const focusKey = document.activeElement instanceof HTMLElement && this.host.contains(document.activeElement) ? document.activeElement.dataset.fkey : undefined;
    const scrolls = new Map<string, number>();
    for (const l of this.host.querySelectorAll<HTMLElement>("[data-scroll]")) scrolls.set(l.dataset.scroll ?? "", l.scrollTop);

    const frag = document.createDocumentFragment();
    const head = document.createElement("div");
    head.className = "alef-sec-head";
    head.innerHTML = `<h2>${escapeHtml(viewName)}</h2>`;
    const chips = activeFilterChips(specs, state);
    if (chips.length) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "alef-reset";
      reset.dataset.fkey = "reset";
      reset.textContent = "Reset";
      reset.title = "Reset every filter for this view";
      reset.addEventListener("click", h.onReset);
      head.append(reset);
    }
    frag.append(head);
    if (chips.length) {
      const bar = document.createElement("div");
      bar.className = "alef-active";
      bar.setAttribute("aria-label", "Active filters");
      for (const c of chips) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "alef-active-chip";
        b.dataset.fkey = `chip:${c.specId}:${c.value}`;
        b.title = `Remove “${c.label}”`;
        b.innerHTML = `<span>${escapeHtml(c.label)}</span><i aria-hidden="true">✕</i>`;
        b.addEventListener("click", () => h.onRemoveChip(c));
        bar.append(b);
      }
      frag.append(bar);
    }
    if (!specs.length) {
      const p = document.createElement("p");
      p.className = "alef-sec-empty";
      p.innerHTML = `<span aria-hidden="true">🌤️</span> Nothing to narrow here. Use the search above to jump anywhere.`;
      frag.append(p);
    }
    for (const spec of specs) frag.append(this.group(viewId, spec, state, h));
    this.host.replaceChildren(frag);

    for (const l of this.host.querySelectorAll<HTMLElement>("[data-scroll]")) {
      const top = scrolls.get(l.dataset.scroll ?? "");
      if (top) l.scrollTop = top;
    }
    if (focusKey) this.host.querySelector<HTMLElement>(`[data-fkey="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  private group(viewId: string, spec: FilterSpec, state: FilterState, h: SectionHandlers): HTMLElement {
    const group = document.createElement("section");
    group.className = `alef-sec alef-f-${spec.type}`;
    group.dataset.spec = spec.id;
    const isFolded = folded(viewId, spec);
    const sel = state[spec.id] ?? [];
    const title = document.createElement("button");
    title.type = "button";
    title.className = "alef-sec-title";
    title.dataset.fkey = `fold:${spec.id}`;
    title.setAttribute("aria-expanded", String(!isFolded));
    const summary =
      spec.type === "list" && sel[0]
        ? (spec.options?.find((o) => o.value === sel[0])?.label ?? "")
        : spec.type === "chips" && sel.length
          ? sel.length === 1
            ? (spec.options?.find((o) => o.value === sel[0])?.label ?? "")
            : `${sel.length} on`
          : spec.type === "toggle" && sel.includes("on")
            ? "On"
            : "";
    const count = spec.count ?? (spec.type === "list" ? spec.options?.length : undefined);
    title.innerHTML = `<span class="alef-caret" aria-hidden="true">▾</span><span class="alef-sec-label">${escapeHtml(spec.label)}</span>${
      summary ? `<span class="alef-sec-sum">${escapeHtml(summary)}</span>` : count !== undefined ? `<span class="alef-sec-count">${count}</span>` : ""
    }`;
    const body = document.createElement("div");
    body.className = "alef-sec-body";
    body.hidden = isFolded;
    title.addEventListener("click", () => {
      body.hidden = !body.hidden;
      title.setAttribute("aria-expanded", String(!body.hidden));
      write(`${FOLD_KEY}${viewId}.${spec.id}`, body.hidden ? "1" : "0");
    });
    group.append(title, body);

    if (spec.type === "section") body.append(this.sectionHost(viewId, spec));
    else if (spec.type === "search") body.append(this.searchBox(viewId, spec, sel[0] ?? "", h));
    else if (spec.type === "toggle") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "alef-switch";
      b.dataset.fkey = `t:${spec.id}`;
      b.setAttribute("role", "switch");
      const on = sel.includes("on");
      b.setAttribute("aria-checked", String(on));
      b.innerHTML = `<i aria-hidden="true"></i><span>${on ? "On" : "Off"}</span>`;
      b.addEventListener("click", () => h.onToggle(spec, "on"));
      body.append(b);
    } else if (spec.type === "list") body.append(...this.list(viewId, spec, sel, h));
    else body.append(this.chips(spec, sel, h));
    return group;
  }

  private sectionHost(viewId: string, spec: FilterSpec): HTMLElement {
    const key = `${viewId}:${spec.id}`;
    let k = this.kept.get(key);
    if (!k) {
      const el = document.createElement("div");
      el.className = "alef-sec-custom";
      k = { el };
      this.kept.set(key, k);
      try {
        const cleanup = spec.render?.(el);
        if (typeof cleanup === "function") k.cleanup = cleanup;
      } catch (err) {
        el.innerHTML = `<p class="alef-sec-empty">This section didn't load: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
    return k.el;
  }

  private searchBox(viewId: string, spec: FilterSpec, value: string, h: SectionHandlers): HTMLElement {
    const key = `${viewId}:search:${spec.id}`;
    let k = this.kept.get(key);
    if (!k) {
      const el = document.createElement("div");
      el.className = "alef-sec-search";
      el.innerHTML = `<span aria-hidden="true">🔎</span><input type="search" autocomplete="off" spellcheck="false" /><button type="button" class="alef-sec-x" aria-label="Clear" hidden>✕</button>`;
      const input = el.querySelector("input")!;
      const x = el.querySelector<HTMLButtonElement>(".alef-sec-x")!;
      input.placeholder = spec.placeholder ?? `Search ${spec.label.toLowerCase()}…`;
      input.setAttribute("aria-label", spec.label);
      input.dataset.fkey = `s:${spec.id}`;
      input.value = value;
      x.hidden = !value;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        x.hidden = !input.value;
        h.onSearch(spec, input.value);
      };
      input.addEventListener("input", () => {
        x.hidden = !input.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, 180);
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") fire();
        else if (ev.key === "Escape" && input.value) {
          ev.stopPropagation();
          input.value = "";
          fire();
        }
      });
      x.addEventListener("click", () => {
        input.value = "";
        fire();
        input.focus();
      });
      k = { el, cleanup: () => timer && clearTimeout(timer) };
      this.kept.set(key, k);
    } else {
      // The state was reset from outside (Reset, a chip): mirror it unless the user is typing.
      const input = k.el.querySelector("input");
      if (input && document.activeElement !== input && input.value.trim() !== value) {
        input.value = value;
        k.el.querySelector<HTMLElement>(".alef-sec-x")!.hidden = !value;
      }
    }
    return k.el;
  }

  private chips(spec: FilterSpec, sel: readonly string[], h: SectionHandlers): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "alef-fchips";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", spec.label);
    for (const o of spec.options ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      const on = sel.includes(o.value);
      b.className = "alef-fchip";
      b.dataset.fkey = `o:${spec.id}:${o.value}`;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (o.hint) b.title = o.hint;
      b.innerHTML = `${o.dot ? `<i class="dot ${escapeHtml(o.dot)}" aria-hidden="true"></i>` : ""}${o.emoji ? `<span class="alef-femoji" aria-hidden="true">${escapeHtml(o.emoji)}</span>` : ""}<span class="alef-flabel">${escapeHtml(o.label)}</span>${o.count !== undefined ? `<span class="alef-fcount">${o.count}</span>` : ""}`;
      b.addEventListener("click", () => h.onToggle(spec, o.value));
      wrap.append(b);
    }
    if (!spec.options?.length) wrap.append(emptyNote("Nothing to filter yet."));
    return wrap;
  }

  private list(viewId: string, spec: FilterSpec, sel: readonly string[], h: SectionHandlers): HTMLElement[] {
    const out: HTMLElement[] = [];
    const pinned = spec.pinnable ? pins(spec) : [];
    const sort = spec.sortable ? sortOf(viewId, spec) : "given";
    if (spec.sortable) {
      const bar = document.createElement("div");
      bar.className = "alef-sortbar";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Order");
      for (const [v, label] of [
        ["activity", "Activity"],
        ["name", "A–Z"],
      ] as const) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "alef-sort";
        b.dataset.fkey = `sort:${spec.id}:${v}`;
        b.classList.toggle("on", sort === v);
        b.setAttribute("aria-pressed", String(sort === v));
        b.textContent = label;
        b.addEventListener("click", () => {
          write(`${SORT_KEY}${viewId}.${spec.id}`, v);
          this.rerenderList(viewId, spec, sel, h);
        });
        bar.append(b);
      }
      out.push(bar);
    }
    if (spec.groups) {
      out.push(...this.groupedList(viewId, spec, sel, h, sort, pinned));
      return out;
    }
    const rows = orderListRows(spec.options ?? [], sort, pinned);
    const full = this.showAll.has(spec.id) || !spec.limit || rows.length <= spec.limit + 2;
    // Never hide the selected row behind "Show all".
    const shown = full ? rows : rows.filter((o, i) => i < (spec.limit ?? rows.length) || sel.includes(o.value) || pinned.includes(o.value));
    const ul = document.createElement("ul");
    ul.className = "alef-flist";
    ul.dataset.scroll = spec.id;
    ul.setAttribute("aria-label", spec.label);
    for (const o of shown) ul.append(this.row(spec, o, sel.includes(o.value), pinned.includes(o.value), h, () => this.rerenderList(viewId, spec, sel, h)));
    if (!rows.length) ul.append(emptyNote("Nothing here yet.", "li"));
    out.push(ul);
    if (!full) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "alef-more";
      more.dataset.fkey = `more:${spec.id}`;
      more.textContent = `Show all ${rows.length}`;
      more.addEventListener("click", () => {
        this.showAll.add(spec.id);
        this.rerenderList(viewId, spec, sel, h);
      });
      out.push(more);
    }
    return out;
  }

  /** A "list" with `groups`: a header per group, each group capped at `limit` rows + its own "Show all". */
  private groupedList(viewId: string, spec: FilterSpec, sel: readonly string[], h: SectionHandlers, sort: "activity" | "name" | "given", pinned: readonly string[]): HTMLElement[] {
    const ul = document.createElement("ul");
    ul.className = "alef-flist grouped";
    ul.dataset.scroll = spec.id;
    ul.setAttribute("aria-label", spec.label);
    const rerender = (): void => this.rerenderList(viewId, spec, sel, h);
    const blocks = groupListRows(spec.options ?? [], spec.groups ?? [], sort, pinned);
    for (const { group, rows } of blocks) {
      if (group) {
        const head = document.createElement("li");
        head.className = "alef-fgroup";
        head.innerHTML = `${group.color ? `<i class="alef-fgroup-swatch" style="background:${escapeHtml(group.color)}" aria-hidden="true"></i>` : ""}<span class="alef-fgroup-label">${escapeHtml(group.label)}</span>${group.meta ? `<span class="alef-fgroup-meta">${escapeHtml(group.meta)}</span>` : ""}`;
        ul.append(head);
      }
      const moreKey = `${spec.id}:${group?.key ?? ""}`;
      const full = !group || !spec.limit || this.showAll.has(moreKey) || rows.length <= spec.limit + 1;
      const shown = full ? rows : rows.filter((o, i) => i < (spec.limit ?? rows.length) || sel.includes(o.value));
      for (const o of shown) ul.append(this.row(spec, o, sel.includes(o.value), pinned.includes(o.value), h, rerender));
      if (group?.empty && rows.length === 0) ul.append(emptyNote(group.empty, "li"));
      if (!full) {
        const li = document.createElement("li");
        const more = document.createElement("button");
        more.type = "button";
        more.className = "alef-more nested";
        more.dataset.fkey = `more:${moreKey}`;
        more.textContent = `Show all ${rows.length}`;
        more.title = `Show all ${rows.length} in ${group?.label ?? "this group"}`;
        more.addEventListener("click", () => {
          this.showAll.add(moreKey);
          rerender();
        });
        li.append(more);
        ul.append(li);
      }
    }
    if (!blocks.length) ul.append(emptyNote("Nothing here yet.", "li"));
    const out: HTMLElement[] = [ul];
    if (spec.note) {
      const note = document.createElement("p");
      note.className = "alef-sec-note";
      note.textContent = spec.note;
      out.push(note);
    }
    return out;
  }

  private row(spec: FilterSpec, o: FilterOption, on: boolean, pinnedRow: boolean, h: SectionHandlers, rerender: () => void): HTMLElement {
    const li = document.createElement("li");
    li.className = "alef-frow-li";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "alef-frow";
    b.dataset.fkey = `o:${spec.id}:${o.value}`;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    if (o.hint) b.title = o.hint;
    b.innerHTML = `${o.dot ? `<i class="dot ${escapeHtml(o.dot)}" aria-hidden="true"></i>` : ""}${o.emoji ? `<span class="alef-femoji" aria-hidden="true">${escapeHtml(o.emoji)}</span>` : ""}<span class="alef-frow-text"><span class="alef-flabel">${escapeHtml(o.label)}</span>${o.meta ? `<span class="alef-fmeta">${escapeHtml(o.meta)}</span>` : ""}</span>${
      o.count !== undefined || o.spark ? `<span class="alef-frow-side">${o.count !== undefined ? `<span class="alef-fcount">${o.count}</span>` : ""}${o.spark ? sparkSvg(o.spark) : ""}</span>` : ""
    }`;
    b.addEventListener("click", () => h.onToggle(spec, o.value));
    li.append(b);
    if (spec.pinnable) {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "alef-pin";
      pin.dataset.fkey = `pin:${spec.id}:${o.value}`;
      pin.classList.toggle("on", pinnedRow);
      pin.setAttribute("aria-pressed", String(pinnedRow));
      pin.setAttribute("aria-label", pinnedRow ? `Unpin ${o.label}` : `Pin ${o.label} to the top`);
      pin.title = pinnedRow ? "Unpin" : "Pin to the top";
      pin.textContent = pinnedRow ? "★" : "☆";
      pin.addEventListener("click", () => {
        const cur = pins(spec);
        write(`${PIN_KEY}${spec.id}`, JSON.stringify(cur.includes(o.value) ? cur.filter((v) => v !== o.value) : [...cur, o.value]));
        rerender();
      });
      li.append(pin);
    }
    return li;
  }

  /** Re-draw one list group in place (sort / pin / show all never change the filter state). */
  private rerenderList(viewId: string, spec: FilterSpec, sel: readonly string[], h: SectionHandlers): void {
    const group = this.host.querySelector<HTMLElement>(`section[data-spec="${CSS.escape(spec.id)}"] .alef-sec-body`);
    if (!group) return;
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.fkey : undefined;
    const top = group.querySelector<HTMLElement>("[data-scroll]")?.scrollTop ?? 0;
    group.replaceChildren(...this.list(viewId, spec, sel, h));
    const ul = group.querySelector<HTMLElement>("[data-scroll]");
    if (ul) ul.scrollTop = top;
    if (focusKey) group.querySelector<HTMLElement>(`[data-fkey="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
}

function emptyNote(text: string, tag: "p" | "li" = "p"): HTMLElement {
  const p = document.createElement(tag);
  p.className = "alef-sec-empty";
  p.textContent = text;
  return p;
}
