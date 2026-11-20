// The "⋯" menu of a Library card, positioned under its button inside the view (rows scroll, so it
// cannot live in the card). One menu at a time; a click outside or Esc closes it.

import { el, type MenuEntry } from "./shelf-cards";

export interface MenuHost {
  open(anchor: HTMLElement, entries: readonly MenuEntry[]): void;
  /** True when a menu was open (Esc handling). */
  close(): boolean;
  isOpen(): boolean;
}

export function createMenu(root: () => HTMLElement | null): MenuHost {
  let menuEl: HTMLElement | null = null;
  const onOutside = (e: Event): void => {
    if (menuEl && !menuEl.contains(e.target as Node)) close();
  };
  function close(): boolean {
    if (!menuEl) return false;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("pointerdown", onOutside, true);
    return true;
  }
  function open(anchor: HTMLElement, entries: readonly MenuEntry[]): void {
    close();
    const host = root();
    if (!host || entries.length === 0) return;
    const m = el("div", "sv-menu");
    m.setAttribute("role", "menu");
    for (const e of entries) {
      if ("heading" in e) {
        m.append(el("div", "sv-menu-h", e.heading));
        continue;
      }
      const b = el("button", "sv-menu-item", e.label);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        close();
        e.run();
      });
      m.append(b);
    }
    host.append(m);
    menuEl = m;
    const r = host.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.right - r.left - m.offsetWidth, r.width - m.offsetWidth - 8));
    const below = a.bottom - r.top + 4;
    const top = below + m.offsetHeight > r.height - 8 ? Math.max(8, a.top - r.top - m.offsetHeight - 4) : below;
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    m.querySelector("button")?.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }
  return { open, close, isOpen: () => menuEl !== null };
}
