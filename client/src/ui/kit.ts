// Shared UI primitives for the comic HUD: labeled buttons, dialogs with a focus trap,
// reduced-motion detection and the one-time welcome flag. Styling lives in style.css
// under ".ui-btn" / ".ui-menu" / ".ui-dialog" and the tokens at the top of that file.

export interface UiButtonOpts {
  /** Visible text. Always present: no icon-only buttons in the HUD. */
  label: string;
  /** Optional decorative glyph or inline SVG markup rendered before the label (aria-hidden). */
  icon?: string;
  /** Longer tooltip; falls back to the label. */
  title?: string;
  /** Short keyboard hint shown as <kbd>, e.g. "B". */
  kbd?: string;
  variant?: "tool" | "menu";
  id?: string;
}

/** A `.ui-btn` with a visible label, an aria-label and a tooltip. */
export function uiButton(opts: UiButtonOpts): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ui-btn ui-btn-${opts.variant ?? "tool"}`;
  if (opts.id) b.id = opts.id;
  if (opts.icon) {
    const i = document.createElement("span");
    i.className = "ui-ico";
    i.setAttribute("aria-hidden", "true");
    if (opts.icon.startsWith("<svg")) i.innerHTML = opts.icon;
    else i.textContent = opts.icon;
    b.append(i);
  }
  const t = document.createElement("span");
  t.className = "ui-label";
  t.textContent = opts.label;
  b.append(t);
  if (opts.kbd) {
    const k = document.createElement("kbd");
    k.textContent = opts.kbd;
    k.setAttribute("aria-hidden", "true");
    b.append(k);
  }
  b.title = opts.title ?? opts.label;
  return b;
}

/** User asked the OS for less motion. Safe outside a browser (false). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Index to focus after Tab / Shift+Tab from `current` in a list of `count` focusables (wraps). */
export function wrapFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export interface Dialog {
  open(focus?: HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Wires `root` (the backdrop; toggled via `hidden`) as a modal dialog around `card`:
 * role=dialog + aria-modal, Tab stays inside, focus returns to whatever had it before
 * `open()`, and a click on the backdrop closes it. Esc is left to the caller's chain.
 */
export function modalDialog(root: HTMLElement, card: HTMLElement, label: string, onClose?: () => void): Dialog {
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  if (!card.hasAttribute("aria-labelledby")) card.setAttribute("aria-label", label);
  let restore: HTMLElement | null = null;

  card.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const list = focusables(card);
    if (!list.length) return;
    ev.preventDefault();
    const cur = list.indexOf(document.activeElement as HTMLElement);
    list[wrapFocusIndex(list.length, cur, ev.shiftKey)]?.focus();
  });
  root.addEventListener("click", (ev) => {
    if (ev.target === root) api.close();
  });

  const api: Dialog = {
    open(focus) {
      if (root.hidden) restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false;
      (focus ?? focusables(card)[0] ?? card).focus();
    },
    close() {
      if (root.hidden) return;
      root.hidden = true;
      onClose?.();
      if (restore && document.contains(restore)) restore.focus();
      restore = null;
    },
    isOpen: () => !root.hidden,
  };
  return api;
}

/** Minimal storage surface so the welcome flag is testable without a DOM. */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WELCOME_KEY = "agent-world.welcomed";

/** True on the very first visit. A throwing/absent storage counts as "already seen" (never nag). */
export function shouldShowWelcome(store: FlagStore | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(WELCOME_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markWelcomed(store: FlagStore | null): void {
  try {
    store?.setItem(WELCOME_KEY, "1");
  } catch {
    /* private mode: the card just shows again next time */
  }
}

export function safeLocalStorage(): FlagStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- collapsible chrome (round 5 E1)
//
// Every chrome surface (HUD card, districts, ticker, dispatch bar, side panel…) collapses to a
// labeled pill in its corner through ONE helper, `collapsible()`. The per-surface choice is
// remembered in localStorage (`agent-world.collapsed.<id>`). On top of those remembered
// choices sits a chrome *mode*: "hidden" (H), "focus" (F) and "zen" (Z) force every surface
// shut without overwriting what was remembered, so leaving the mode restores it exactly.

export type ChromeMode = "normal" | "hidden" | "focus" | "zen";

export const COLLAPSE_KEY_PREFIX = "agent-world.collapsed.";

/** Pure collapse bookkeeping, no DOM: testable with an in-memory FlagStore. */
export class ChromeState {
  private readonly remembered = new Map<string, boolean>();
  private readonly persisted = new Set<string>();
  /** Surfaces the user opened while a mode forces everything shut (dropped when the mode changes). */
  private readonly exceptions = new Set<string>();
  private current: ChromeMode = "normal";

  constructor(private readonly store: FlagStore | null) {}

  get mode(): ChromeMode {
    return this.current;
  }

  /** Reads the remembered choice (falls back to `defaultCollapsed`, which is never written back). */
  register(id: string, defaultCollapsed = false, persist = true): void {
    let v = defaultCollapsed;
    if (persist) {
      this.persisted.add(id);
      try {
        const raw = this.store?.getItem(COLLAPSE_KEY_PREFIX + id);
        if (raw === "1" || raw === "0") v = raw === "1";
      } catch {
        /* blocked storage: use the default */
      }
    }
    this.remembered.set(id, v);
  }

  has(id: string): boolean {
    return this.remembered.has(id);
  }

  /** What the user chose for this surface, ignoring any mode. */
  rememberedCollapsed(id: string): boolean {
    return this.remembered.get(id) ?? false;
  }

  isCollapsed(id: string): boolean {
    if (this.current === "normal") return this.rememberedCollapsed(id);
    return !this.exceptions.has(id);
  }

  /** A user click on a chevron / pill. In normal mode it is remembered; under a mode it is a one-off. */
  setCollapsed(id: string, collapsed: boolean): void {
    if (this.current !== "normal") {
      if (collapsed) this.exceptions.delete(id);
      else this.exceptions.add(id);
      return;
    }
    this.remembered.set(id, collapsed);
    if (!this.persisted.has(id)) return;
    try {
      this.store?.setItem(COLLAPSE_KEY_PREFIX + id, collapsed ? "1" : "0");
    } catch {
      /* private mode: it just won't be remembered */
    }
  }

  toggle(id: string): void {
    this.setCollapsed(id, !this.isCollapsed(id));
  }

  setMode(mode: ChromeMode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.exceptions.clear();
  }

  /** H: normal ⇄ hidden. No-op (false) while focus or zen own the chrome. */
  toggleHideAll(): boolean {
    if (this.current === "normal") this.setMode("hidden");
    else if (this.current === "hidden") this.setMode("normal");
    else return false;
    return true;
  }
}

export type Corner = "tl" | "tc" | "tr" | "bl" | "bc" | "br";

export interface CollapsibleOpts {
  /** Visible word(s) on the pill, e.g. "Districts". */
  pillLabel: string;
  /** Decorative glyph before the label (aria-hidden). */
  icon?: string;
  /** Which corner dock the pill sits in (default: worked out from where the surface is). */
  corner?: Corner;
  /** Where the chevron goes (default: floated in the surface's top-right corner). */
  header?: HTMLElement | null;
  /** Used when nothing is remembered yet. */
  defaultCollapsed?: boolean;
}

export interface CollapsibleHandle {
  readonly id: string;
  readonly pill: HTMLButtonElement;
  readonly chevron: HTMLButtonElement;
  setLabel(text: string): void;
  expand(): void;
  collapse(): void;
  isCollapsed(): boolean;
}

interface Surface {
  el: HTMLElement;
  handle: CollapsibleHandle;
  corner: Corner;
  apply(animate: boolean): void;
}

let chromeState: ChromeState | null = null;
const surfaces = new Map<string, Surface>();
const listeners = new Set<(mode: ChromeMode) => void>();
const docks = new Map<Corner, HTMLElement>();
let resizeObs: ResizeObserver | null = null;
let layoutQueued = false;
const PHONE_MAX = 520;

export function chrome(): ChromeState {
  chromeState ??= new ChromeState(safeLocalStorage());
  return chromeState;
}

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function isPhone(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= PHONE_MAX;
}

/** On phones every bottom pill shares one centered row, so nothing collides at 390px. */
function dockCorner(c: Corner): Corner {
  if (!isPhone()) return c;
  if (c === "bl" || c === "br") return "bc";
  if (c === "tc") return "tr";
  return c;
}

function dock(c: Corner): HTMLElement {
  const existing = docks.get(c);
  if (existing) return existing;
  const d = document.createElement("div");
  d.className = `aw-dock aw-dock-${c}`;
  d.setAttribute("role", "group");
  d.setAttribute("aria-label", "Collapsed panels");
  // Top-left pills live in the HUD column (under the tools card, above the districts list).
  const hud = c === "tl" ? document.getElementById("hud") : null;
  const anchor = hud?.querySelector("#hud-card") ?? hud?.querySelector("#title");
  if (hud && anchor) anchor.after(d);
  else document.body.appendChild(d);
  docks.set(c, d);
  return d;
}

function guessCorner(el: HTMLElement): Corner {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const col = cx < window.innerWidth / 3 ? "l" : cx > (window.innerWidth * 2) / 3 ? "r" : "c";
  return `${cy < window.innerHeight / 2 ? "t" : "b"}${col}` as Corner;
}

function visibleOnItsOwn(el: HTMLElement): boolean {
  return el.isConnected && !el.hidden;
}

/** Bottom docks sit just above whatever is still open in their corner (or the status bar). */
function layoutDocks(): void {
  layoutQueued = false;
  const sb = surfaces.get("statusbar");
  const sbOpen = sb ? visibleOnItsOwn(sb.el) && !sb.handle.isCollapsed() : !!document.getElementById("statusbar");
  // The Alef shell publishes its bottom inset (status bar); without it, the old status bar height.
  const shellBottom = parseFloat(getComputedStyle(document.body).getPropertyValue("--alef-bottom"));
  const base = Number.isFinite(shellBottom) && shellBottom > 0 ? Math.round(shellBottom) + 8 : sbOpen ? 38 : 8;
  for (const c of ["bl", "bc", "br"] as const) {
    const d = docks.get(c);
    if (!d) continue;
    // Only what is open *under* the dock pushes it up (a compass off to the side does not).
    const dr = d.getBoundingClientRect();
    let top = Infinity;
    for (const s of surfaces.values()) {
      if (s.el.id === "statusbar" || dockCorner(s.corner) !== c || s.handle.isCollapsed() || !visibleOnItsOwn(s.el)) continue;
      const r = s.el.getBoundingClientRect();
      const under = dr.width === 0 || (r.right > dr.left - 8 && r.left < dr.right + 8);
      if (under && r.height > 0 && r.top > window.innerHeight / 2) top = Math.min(top, r.top);
    }
    const bottom = Number.isFinite(top) ? Math.max(base, Math.round(window.innerHeight - top + 8)) : base;
    d.style.bottom = `${bottom}px`;
  }
  // Move pills when the phone breakpoint is crossed.
  for (const s of surfaces.values()) {
    const d = dock(dockCorner(s.corner));
    if (s.handle.pill.parentElement !== d) d.appendChild(s.handle.pill);
  }
}

function queueLayout(): void {
  if (layoutQueued || typeof requestAnimationFrame !== "function") return;
  layoutQueued = true;
  requestAnimationFrame(layoutDocks);
}

function syncBodyClasses(mode: ChromeMode): void {
  const b = document.body.classList;
  b.toggle("aw-chrome-hidden", mode === "hidden");
  b.toggle("aw-focus", mode === "focus");
  b.toggle("aw-zen", mode === "zen");
}

/**
 * Makes `el` collapsible to a labeled pill. Adds a 32px chevron (aria-expanded, keyboard
 * reachable) to `opts.header` or the surface's top-right; the pill goes in its corner's dock.
 * Collapsed surfaces get `inert` so Tab skips them. 150ms pop in/out, instant under reduced motion.
 */
export function collapsible(el: HTMLElement, id: string, opts: CollapsibleOpts): CollapsibleHandle {
  const existing = surfaces.get(id);
  if (existing && (existing.el === el || existing.el.isConnected)) return existing.handle;
  if (existing) {
    // A remounted view built a fresh element under the same id: drop the detached one's pill.
    existing.handle.pill.remove();
    surfaces.delete(id);
  }
  const state = chrome();
  if (!state.has(id)) state.register(id, opts.defaultCollapsed ?? false);
  let label = opts.pillLabel;

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = `aw-chev${opts.header ? "" : " aw-chev-float"}`;
  chevron.innerHTML = CHEVRON_SVG;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "aw-pill";
  pill.dataset.surface = id;
  const pillIcon = document.createElement("span");
  pillIcon.className = "aw-pill-ico";
  pillIcon.setAttribute("aria-hidden", "true");
  pillIcon.textContent = opts.icon ?? "";
  const pillText = document.createElement("span");
  pillText.className = "aw-pill-label";
  const pillCaret = document.createElement("span");
  pillCaret.className = "aw-pill-caret";
  pillCaret.innerHTML = CHEVRON_SVG;
  if (opts.icon) pill.append(pillIcon);
  pill.append(pillText, pillCaret);
  pill.hidden = true;
  const syncLabels = (): void => {
    pillText.textContent = label;
    pill.title = `Show ${label}`;
    pill.setAttribute("aria-label", `Show ${label}`);
    chevron.title = `Collapse ${label} (H hides everything)`;
    chevron.setAttribute("aria-label", `Collapse ${label}`);
  };
  syncLabels();
  if (opts.header) opts.header.appendChild(chevron);
  else el.appendChild(chevron);
  el.classList.add("aw-surface");

  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown: boolean | null = null;
  const apply = (animate: boolean): void => {
    const collapsed = state.isCollapsed(id);
    chevron.setAttribute("aria-expanded", String(!collapsed));
    pill.setAttribute("aria-expanded", String(!collapsed));
    pill.hidden = !collapsed || !visibleOnItsOwn(el);
    if (shown === !collapsed) return;
    shown = !collapsed;
    if (timer) clearTimeout(timer);
    timer = null;
    el.classList.remove("aw-anim-in", "aw-anim-out");
    const quick = !animate || prefersReducedMotion();
    if (collapsed) {
      el.inert = true;
      if (quick) el.classList.add("aw-collapsed");
      else {
        el.classList.add("aw-anim-out");
        timer = setTimeout(() => {
          el.classList.remove("aw-anim-out");
          el.classList.add("aw-collapsed");
          queueLayout();
        }, 150);
      }
    } else {
      el.inert = false;
      el.classList.remove("aw-collapsed");
      if (!quick) el.classList.add("aw-anim-in");
    }
    queueLayout();
  };

  const handle: CollapsibleHandle = {
    id,
    pill,
    chevron,
    setLabel(text) {
      label = text;
      syncLabels();
    },
    expand() {
      state.setCollapsed(id, false);
      apply(true);
    },
    collapse() {
      state.setCollapsed(id, true);
      apply(true);
    },
    isCollapsed: () => state.isCollapsed(id),
  };
  chevron.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const hadFocus = document.activeElement === chevron;
    handle.collapse();
    if (hadFocus && !pill.hidden) pill.focus();
  });
  pill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handle.expand();
    chevron.focus({ preventScroll: true });
  });
  el.addEventListener("animationend", () => el.classList.remove("aw-anim-in"));

  const corner = opts.corner ?? guessCorner(el);
  surfaces.set(id, { el, handle, corner, apply });
  dock(dockCorner(corner)).appendChild(pill);
  // The surface's own code toggles `hidden` (empty ticker, closed panel…): the pill follows it.
  new MutationObserver(() => {
    pill.hidden = !state.isCollapsed(id) || !visibleOnItsOwn(el);
    queueLayout();
  }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
  if (typeof ResizeObserver === "function") {
    resizeObs ??= new ResizeObserver(() => queueLayout());
    resizeObs.observe(el);
  }
  if (surfaces.size === 1) window.addEventListener("resize", queueLayout);
  apply(false);
  return handle;
}

export function isSurfaceCollapsed(id: string): boolean {
  return chrome().isCollapsed(id);
}

/** Opens a surface (e.g. the dispatch bar before prefilling it). Under a mode it is a one-off. */
export function expandSurface(id: string): void {
  const s = surfaces.get(id);
  if (s) s.handle.expand();
  else chrome().setCollapsed(id, false);
}

export function chromeMode(): ChromeMode {
  return chrome().mode;
}

export function onChromeChange(fn: (mode: ChromeMode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyAll(): void {
  const mode = chrome().mode;
  syncBodyClasses(mode);
  for (const s of surfaces.values()) s.apply(true);
  for (const fn of listeners) fn(mode);
}

export function setChromeMode(mode: ChromeMode): void {
  if (chrome().mode === mode) return;
  chrome().setMode(mode);
  applyAll();
}

/** H. Returns false when focus / zen own the chrome. */
export function toggleHideAllChrome(): boolean {
  if (!chrome().toggleHideAll()) return false;
  applyAll();
  return true;
}
