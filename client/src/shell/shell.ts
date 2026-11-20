// The Alef shell: top bar (logo + the five destinations), left sidebar (one search + the active
// view's filters; gone while a view has none), main view area (#alef-view, the active view's
// root), right sidebar (three labelled tabs: Activity · Loops · Controls, and the ? Help overlay),
// prompt box and status bar with its data drawer.
// Views plug in through shell/views.ts (docs/VIEWS.md). main.ts builds this once, before the
// features mount, and routes keys / Esc / selection through it.

import type { ClientContext, HudButton } from "../features/registry";
import { openNeedsYou } from "../features/inbox";
import { onTalkChange, strandedDispatches } from "../features/talk";
import { countWaiting, faviconHref, titleFor } from "../features/waiting-lib";
import type { WorldStore } from "../state";
import { log } from "../log";
import { helpHtml } from "../ui/help";
import { chromeMode, modalDialog, onChromeChange, safeLocalStorage, setChromeMode } from "../ui/kit";
import type { PaletteAction, PaletteData } from "../ui/palette";
import { escapeHtml } from "../ui/fuzzy";
import type { FeedItem, FeedStore } from "./feed";
import { mountFeedUi, type FeedUi } from "./feed-ui";
import { defaultViewFor, groupForKey, groupOf, subButtonFor, switcherScrollLeft, ungroupedViewIds, visibleGroups, type Span } from "./groups";
import { promptBoxHost } from "./prompt-box";
import { SidebarSections } from "./filters-ui";
import { mountSearch, type SidebarSearch } from "./search";
import { navEntries } from "./search-lib";
import { MIND_TABS, mindTabRoute } from "../views/mind-tabs";
import { Remembered, rememberedChoice } from "./status-lib";
import { mountStatusBar, type StatusBarApi } from "./statusbar";
import { renderThemePicker } from "./theme-picker";
import {
  RAIL_PANES,
  RAIL_TABS,
  ViewHost,
  clearedFilterState,
  formatRoute,
  hidesLeftSidebar,
  initialFilterState,
  initialRoute,
  parseRoute,
  railPaneFor,
  railTabFor,
  removeChip,
  resolveLegacyRoute,
  setSearchText,
  toggleFilter,
  type AlefView,
  type FilterSpec,
  type FilterState,
  type PlanetApi,
  type RailPane,
  type RailTab,
  type RightTab,
  type Route,
  type Selection,
  type ViewContext,
  type ViewRegistry,
} from "./views";
import type { HoldAction } from "../features/courier/hold";
import { icon, viewIcon } from "./icons";
import "./chrome.css";
import "./shell.css";
import "./transitions.css";

export const PHONE_MAX = 520;

/** The panes inside the rail's three tabs (Activity: Feed · Logs, Controls: Mac · Routines ·
 *  Settings). Labels show on the sub-switch inside a tab; titles are its tooltips. */
const PANE_META: Record<RailPane, { label: string; title: string }> = {
  feed: { label: "Feed", title: "Everything happening: activity, Jev's results, approvals, routines, reports" },
  logs: { label: "Logs", title: "Everything in the town: server lines and feed events" },
  loops: { label: "Loops", title: "Open loops across every project: launch a plan-mode session per task" },
  mac: { label: "Mac", title: "Control this Mac: apps, launcher, media, Shortcuts, scripts" },
  routines: { label: "Routines", title: "Your scheduled routines" },
  settings: { label: "Settings", title: "Approvals, replay & report, sound, talk to Jev, wake word" },
};

/** The rail's three labelled tabs (UX-7): an icon AND a word each, always. */
const RAIL_META: Record<RailTab, { icon: string; title: string }> = {
  activity: { icon: "feed", title: "Activity: the Feed (everything happening, approvals first) and the Logs" },
  loops: { icon: "loops", title: "Loops: open tasks across every project, one plan-mode session each" },
  controls: { icon: "controls", title: "Controls: this Mac, your routines, and Alef's settings" },
};

/** The badge each rail tab carries: Activity the Feed's, Loops its own. */
const RAIL_BADGE: Partial<Record<RailTab, RailPane>> = { activity: "feed", loops: "loops" };

/** What a tab's badge counts, for its accessible name. */
const TAB_COUNT_WORD: Partial<Record<RailTab, string>> = { loops: "open", activity: "new" };

/** A rail tab's accessible name (A11Y-8): "Loops, 3 open", not the label and badge run
 *  together ("Loops3"). `count` is the badge's text, null while the badge is hidden. */
export function railTabName(tab: RailTab, count: string | null): string {
  const label = RAIL_TABS.find((t) => t.id === tab)?.label ?? tab;
  if (count === null || count === "" || count === "0") return label;
  return `${label}, ${count} ${TAB_COUNT_WORD[tab] ?? "new"}`;
}

export interface ShellDeps {
  registry: ViewRegistry;
  store: WorldStore;
  feed: FeedStore;
  /** The features' context (the shell adds the view-only extras on top). */
  ctx: ClientContext;
  planet: PlanetApi;
  selection: { get(): Selection | null; set(sel: Selection | null): void };
  search: { data: PaletteData; run(a: PaletteAction): void; exists(a: PaletteAction): boolean };
  /** Feature buttons: "menu" ones go to Settings, "status" ones to the status bar. */
  featureButtons: { featureId: string; button: HudButton }[];
  /** Fills the Controls › Routines pane (the routines feature's panel). */
  renderRoutines(el: HTMLElement): void;
  /** Real approval decision (approvals.ts decideApproval). */
  decide(approvalId: string, action: HoldAction): Promise<void>;
  /** A feed item was clicked. */
  pickFeed(item: FeedItem): void;
  pickAgent(id: string): void;
  pickCity(id: string): void;
  /** Count of tmux sessions Alef can talk to (drawer). */
  talkSessions(): number;
  /** Called after every view switch (the hub pauses / resumes the 3D loop, closes overlays…). */
  onViewChanged(view: AlefView, prev: AlefView | null): void;
  welcome(): void;
  /** Start (or restart) the guided tour from Help. */
  tour(): void;
}

export interface Shell {
  readonly viewCtx: ViewContext;
  readonly statusBar: StatusBarApi;
  /** Parse the URL (hash, legacy ?board=1 / ?canvas=1 / ?room=) and show the first view. */
  start(): void;
  showView(id: string, param?: string | null, opts?: { focusView?: boolean; replace?: boolean }): void;
  activeView(): string;
  current(): AlefView | null;
  /** True while a non-planet view is up (the hub skips the 3D frame). */
  pausesPlanet(): boolean;
  /** The active view paints over the planet's whole picture (see AlefView.coversPlanet). */
  coversPlanet(): boolean;
  isSwitching(): boolean;
  /** Open the rail on a pane ("help" opens the ? overlay instead). */
  openRightTab(tab: RightTab): void;
  /** Close the ? Help overlay. True when it was open. */
  closeHelp(): boolean;
  focusSearch(query?: string): void;
  /** Shared selection changed (the hub calls this from selectPick). */
  selected(sel: Selection | null): void;
  /** Generic focus mode (not the Orbit agent focus). */
  setFocus(on: boolean): void;
  genericFocus(): boolean;
  /** The view a plain key opens, if any. */
  viewForKey(key: string): string | undefined;
  /** A key the shell owns (view keys, ?, ⌘K). True = handled. */
  handleKey(ev: KeyboardEvent): boolean;
  /** Esc: phone sheets, the active view's onEscape, then back to the previous view. True = handled. */
  escape(): boolean;
  /** Go back to the previous view (or Orbit). */
  back(): void;
  refreshFilters(): void;
  frame(dt: number): void;
  settingsHost(): HTMLElement;
  statusChipsHost(): HTMLElement | null;
  setTabBadge(tab: RightTab, n: number, tone?: "hot" | "quiet"): void;
  /** Main-area insets in px (top, right, bottom, left). */
  insets(): { top: number; right: number; bottom: number; left: number };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  if (html) e.innerHTML = html;
  return e;
}

export function isPhone(): boolean {
  return window.innerWidth <= PHONE_MAX;
}

/** The tab-title/favicon count: agents waiting on you, plus dispatches/launches stranded before
 *  they ever became one — both need Alex's attention, so both earn the "(N)" badge. */
export function badgeCount(waitingCount: number, strandedCount: number): number {
  return waitingCount + strandedCount;
}

export function mountShell(deps: ShellDeps): Shell {
  const storage = safeLocalStorage();
  // The left sidebar holds the active view's sections, so it starts open on any desktop width;
  // the right one (the feed) is the first to fold on narrower windows.
  const leftOpen = new Remembered(storage, "left", window.innerWidth >= 900);
  const rightOpen = new Remembered(storage, "right", window.innerWidth >= 1280);
  // The pane last open: a stored "help" or "inbox" (both gone from the rail) falls back to the Feed.
  const tabChoice = rememberedChoice<RailPane>(storage, "tab", RAIL_PANES, "feed");
  // Off puts today's flat one-button-per-view bar back, unchanged. Settings -> Alef toggles it.
  const groupsOn = new Remembered(storage, "view-groups", true);
  let phoneSheet: "left" | "right" | null = null;
  let switching = false;
  // performance.now() deadline: leaving a planet view keeps the canvas rendering (pausesPlanet()
  // stays false, alef-no-planet stays off) until the 160ms cross-fade below has actually
  // finished, so the render-loop pause never lands mid-transition (transitions.css).
  let planetGraceUntil = 0;
  const VIEW_FADE_MS = 160; // keep in sync with transitions.css's #alef-view transition
  let focusGeneric = false;
  const filterStates = new Map<string, FilterState>();
  let currentSpecs: FilterSpec[] = [];
  /** ⌘K asked for the search on a view with no filters: show the left sidebar until it empties. */
  let searchWanted = false;

  document.body.classList.add("alef");

  // ---------------------------------------------------------------- tab title + favicon
  // document.title has exactly one owner (here): titleFor() composes the waiting-count prefix
  // onto the view-name title below rather than either side overwriting the other. The favicon
  // (a red-dot badge while N > 0) rides along on the same two inputs. The desktop notification
  // toggle lives separately, opt-in, in features/waiting-notify.ts.
  let viewTitle = "Alef";
  let waitingCount = badgeCount(countWaiting([...deps.store.agents.values()]), strandedDispatches().length);
  let faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!faviconLink) {
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon";
    document.head.appendChild(faviconLink);
  }
  function applyTabChrome(): void {
    document.title = titleFor(viewTitle, waitingCount);
    if (faviconLink) faviconLink.href = faviconHref(waitingCount);
  }
  const syncWaitingChrome = (): void => {
    waitingCount = badgeCount(countWaiting([...deps.store.agents.values()]), strandedDispatches().length);
    applyTabChrome();
  };
  deps.store.onAgents(syncWaitingChrome);
  deps.store.onSnapshot(syncWaitingChrome);
  onTalkChange(syncWaitingChrome);

  // ---------------------------------------------------------------- top bar
  const top = el("header", { id: "alef-top", class: "alef-bar" });
  const homeView = deps.registry.home();
  top.innerHTML = `<a class="alef-logo" href="${escapeHtml(formatRoute(homeView.id))}" title="Alef: ${escapeHtml(homeView.name)}" aria-label="Alef, ${escapeHtml(homeView.name)}"><span class="alef-logo-mark" aria-hidden="true">א</span><span class="alef-logo-word">ALEF</span></a>`;
  const leftToggle = el("button", { type: "button", class: "alef-sheet-btn alef-sheet-left", "aria-controls": "alef-left", title: "Search and filters" }, `<span aria-hidden="true">${icon("search")}</span><span class="sr-only">Search and filters</span>`);
  const switcher = el("nav", { id: "alef-views", "aria-label": "Views" });
  const rightToggle = el("button", { type: "button", class: "alef-sheet-btn alef-sheet-right", "aria-controls": "alef-right", title: "Activity, loops and controls" }, `<span aria-hidden="true">${icon("feed")}</span><span class="alef-badge" id="alef-badge-sheet" hidden></span><span class="sr-only">Activity, loops and controls</span>`);
  top.append(leftToggle, switcher, rightToggle);
  const viewButtons = new Map<string, HTMLButtonElement>();
  for (const v of deps.registry.list()) {
    const b = el("button", { type: "button", class: "alef-view-btn", "data-view": v.id });
    const key = v.keys?.[0];
    b.title = `${v.name}${v.hint ? `: ${v.hint}` : ""}${key ? ` (${key.toUpperCase()})` : ""}`;
    b.setAttribute("aria-label", `${v.name}${key ? ` (${key.toUpperCase()})` : ""}`);
    b.innerHTML = `<span class="alef-view-emoji" aria-hidden="true">${viewIcon(v.id, escapeHtml(v.emoji))}</span><span class="alef-view-name">${escapeHtml(v.name)}</span>`;
    b.addEventListener("click", () => openView(v.id));
    viewButtons.set(v.id, b);
  }

  // ------------------------------------------------- two-level switcher (shell/groups.ts)
  // Five named destinations, then the active group's sub-modes after a hairline, so the bar
  // stays one row tall. View ids, routes and keys are untouched: this is the bar only.
  const registeredIds = deps.registry.list().map((v) => v.id);
  const groups = visibleGroups(registeredIds);
  const groupButtons = new Map<string, HTMLButtonElement>();
  const subButtons = new Map<string, HTMLButtonElement>();
  /** Last sub-mode used in each group, so its button reopens where you left off. */
  const lastSub = new Map<string, { get(): string; set(v: string): void }>();
  for (const g of groups) lastSub.set(g.id, rememberedChoice(storage, `group.${g.id}`, g.views, g.views[0]!));
  const subSep = el("span", { class: "alef-sub-sep", "aria-hidden": "true" });
  // Two slots, so the group pills hold still while the sub-modes come and go (shell.css).
  const groupSlot = el("span", { class: "alef-views-groups" });
  const subSlot = el("span", { class: "alef-views-subs ch-seg" });

  /** The view a key opens: 1–5 a group (its remembered sub-mode; again inside it, the next one),
   *  else the view that claims the key. */
  function viewIdForKey(key: string): string | undefined {
    const g = groupForKey(key, groups);
    if (!g) return deps.registry.forKey(key);
    const cur = viewHost.current()?.id;
    const here = cur ? g.views.indexOf(subButtonFor(cur, g)) : -1;
    return here >= 0 ? g.views[(here + 1) % g.views.length] : defaultViewFor(g, lastSub.get(g.id)?.get());
  }

  function openView(id: string): void {
    api.showView(id, id === "room" ? roomParam() : null, { focusView: true });
  }
  /** `glyph` is ready-to-insert HTML: one of our icons, or an already-escaped emoji fallback. */
  function pill(cls: string, data: Record<string, string>, glyph: string, name: string, title: string, aria: string): HTMLButtonElement {
    const b = el("button", { type: "button", class: cls, ...data });
    b.title = title;
    b.setAttribute("aria-label", aria);
    b.innerHTML = `<span class="alef-view-emoji" aria-hidden="true">${glyph}</span><span class="alef-view-name">${escapeHtml(name)}</span>`;
    return b;
  }
  for (const g of groups) {
    const b = pill("alef-view-btn alef-group-btn", { "data-group": g.id }, icon(g.id) ?? escapeHtml(g.emoji), g.name, `${g.name}${g.hint ? `: ${g.hint}` : ""} (${g.key})`, `${g.name} (${g.key})`);
    b.addEventListener("click", () => openView(defaultViewFor(g, lastSub.get(g.id)?.get())));
    groupButtons.set(g.id, b);
  }
  // A view no group claims keeps a button of its own up here, so registering one can never
  // make it unreachable while the groups are on.
  for (const id of ungroupedViewIds(registeredIds)) {
    const v = deps.registry.list().find((x) => x.id === id);
    if (!v) continue;
    const b = pill("alef-view-btn alef-group-btn", { "data-view": v.id }, viewIcon(v.id, escapeHtml(v.emoji)), v.name, `${v.name}${v.hint ? `: ${v.hint}` : ""}`, v.name);
    b.addEventListener("click", () => openView(v.id));
    groupButtons.set(`view:${v.id}`, b);
  }
  for (const v of deps.registry.list()) {
    const key = v.keys?.[0];
    const b = el("button", { type: "button", class: "alef-sub-btn", "data-view": v.id });
    b.title = `${v.name}${v.hint ? `: ${v.hint}` : ""}${key ? ` (${key.toUpperCase()})` : ""}`;
    b.setAttribute("aria-label", `${v.name}${key ? ` (${key.toUpperCase()})` : ""}`);
    b.textContent = v.name;
    b.addEventListener("click", () => openView(v.id));
    subButtons.set(v.id, b);
  }

  /** Paint the bar for the view about to show: grouped, or the flat bar when the flag is off. */
  function renderSwitcher(activeId: string | null): void {
    const subs: Node[] = [];
    if (groupsOn.get()) {
      groupSlot.replaceChildren(...groupButtons.values());
      const g = activeId ? groupOf(activeId, groups) : null;
      if (g && g.views.length > 1) {
        subs.push(subSep);
        for (const id of g.views) {
          const b = subButtons.get(id);
          if (b) subs.push(b);
        }
      }
    } else {
      groupSlot.replaceChildren(...viewButtons.values());
    }
    subSlot.replaceChildren(...subs);
    if (groupSlot.parentNode !== switcher) switcher.replaceChildren(groupSlot, subSlot);
    // The bar scrolls sideways on a narrow window, so keep what is lit in sight -- otherwise
    // you can land in a view whose button sits off the end of the row. On a phone the two lit
    // things do not both fit; which one gives way is switcherScrollLeft's call, not this
    // function's. All this does is measure. (It used to call scrollIntoView on the sub-mode
    // chip, which on a 375px window parked the lit group pill 31px off the left edge.)
    if (switcher.scrollWidth > switcher.clientWidth) {
      // Content coordinates: 0 is the strip's own start, whatever it is currently scrolled to.
      const origin = switcher.getBoundingClientRect().left + switcher.clientLeft - switcher.scrollLeft;
      const span = (...sels: string[]): Span | null => {
        const el = sels.reduce<HTMLElement | null>((found, sel) => found ?? switcher.querySelector<HTMLElement>(sel), null);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - origin, right: r.right - origin };
      };
      // With the flag off there are no group pills, so the lit flat view button is the thing to
      // keep: it takes the pill's place and wins the same way.
      const pillSpan = span(".alef-group-btn.on", ".alef-view-btn.on");
      switcher.scrollLeft = switcherScrollLeft(switcher.scrollLeft, switcher.clientWidth, span(".alef-sub-btn.on"), pillSpan);
    }
  }
  renderSwitcher(null);
  top.querySelector(".alef-logo")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    api.showView(homeView.id, null, { focusView: true });
  });

  // ---------------------------------------------------------------- left sidebar
  const left = el("aside", { id: "alef-left", class: "alef-side alef-side-left", "aria-label": "Search and filters" });
  const leftHead = el("div", { class: "alef-side-head" });
  const leftCollapse = el("button", { type: "button", class: "alef-collapse", "aria-controls": "alef-left" });
  leftHead.append(leftCollapse);
  const leftRail = el("div", { class: "alef-rail", role: "toolbar", "aria-label": "Search and filters (collapsed)" });
  const railSearch = el("button", { type: "button", class: "alef-rail-btn", title: "Search (⌘K)", "aria-label": "Search (⌘K)" }, `<span aria-hidden="true">${icon("search")}</span>`);
  const railFilters = el("button", { type: "button", class: "alef-rail-btn alef-rail-view", title: "This view's filters", "aria-label": "This view's filters" }, `<span aria-hidden="true" id="alef-rail-emoji">${icon("filters")}</span><span class="alef-badge quiet" id="alef-badge-filters" hidden></span>`);
  leftRail.append(railSearch, railFilters);
  const searchHost = el("div", { class: "alef-search-host" });
  const filtersHost = el("div", { class: "alef-filters", id: "alef-filters" });
  const leftBody = el("div", { class: "alef-side-body" });
  leftBody.append(searchHost, filtersHost);
  left.append(leftHead, leftRail, leftBody);

  // ---------------------------------------------------------------- right sidebar
  // Three labelled tabs (UX-7). Activity and Controls hold more than one pane: a small segmented
  // switch at the top of the tab picks one. Every pane keeps its id (#alef-pane-<pane>), so the
  // features that fill them (loops, mac, logs) and openRightTab(<pane>) are unchanged.
  const right = el("aside", { id: "alef-right", class: "alef-side alef-side-right", "aria-label": "Activity, loops and controls" });
  const tablist = el("div", { class: "alef-tabs", role: "tablist", "aria-label": "Right sidebar" });
  const rightCollapse = el("button", { type: "button", class: "alef-collapse", "aria-controls": "alef-right" });
  const helpBtn = el("button", { type: "button", class: "alef-help-btn", title: "Help: the map legend and every shortcut (?)", "aria-label": "Help (?)", "aria-haspopup": "dialog" }, `<span aria-hidden="true">?</span>`);
  helpBtn.addEventListener("click", () => openHelp());
  const rightHead = el("div", { class: "alef-side-head alef-tabs-head" });
  rightHead.append(tablist, helpBtn, rightCollapse);
  const panes = el("div", { class: "alef-panes" });
  const tabButtons = new Map<RailTab, HTMLButtonElement>();
  const railPanels = new Map<RailTab, HTMLElement>();
  const paneButtons = new Map<RailPane, HTMLButtonElement>();
  const paneEls = new Map<RailPane, HTMLElement>();
  for (const t of RAIL_TABS) {
    const m = RAIL_META[t.id];
    const badge = RAIL_BADGE[t.id];
    // The name is set here and kept in step with the badge, whoever writes it (setTabBadge below,
    // or the loops feature straight into #alef-badge-loops); the tooltip text is the
    // description, so a screen reader hears "Loops, 3 open" then what the tab is for.
    const b = el("button", { type: "button", role: "tab", id: `alef-tab-${t.id}`, class: "alef-tab", "aria-controls": `alef-rail-${t.id}`, "aria-label": railTabName(t.id, null), "aria-describedby": `alef-tab-desc-${t.id}`, title: m.title });
    b.innerHTML = `<span class="alef-tab-emoji" aria-hidden="true">${icon(m.icon) ?? ""}</span><span class="alef-tab-label">${escapeHtml(t.label)}</span>${badge ? `<span class="alef-badge" id="alef-badge-${badge}" aria-hidden="true" hidden></span>` : ""}<span class="sr-only" id="alef-tab-desc-${t.id}">${escapeHtml(m.title)}</span>`;
    const badgeEl = b.querySelector<HTMLElement>(".alef-badge");
    if (badgeEl) new MutationObserver(() => b.setAttribute("aria-label", railTabName(t.id, badgeEl.hidden ? null : (badgeEl.textContent ?? null)))).observe(badgeEl, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
    b.addEventListener("click", () => selectRail(t.id, true));
    tablist.append(b);
    tabButtons.set(t.id, b);
    const panel = el("section", { role: "tabpanel", id: `alef-rail-${t.id}`, class: `alef-rail-panel alef-rail-${t.id}`, "aria-labelledby": `alef-tab-${t.id}` });
    panel.hidden = true;
    if (t.panes.length > 1) {
      const sub = el("div", { class: "alef-subtabs ch-seg", role: "group", "aria-label": t.label });
      for (const p of t.panes) {
        const pb = el("button", { type: "button", class: "alef-subtab", "data-pane": p, title: PANE_META[p].title, "aria-pressed": "false" }, escapeHtml(PANE_META[p].label));
        pb.addEventListener("click", () => selectTab(p, true));
        sub.append(pb);
        paneButtons.set(p, pb);
      }
      panel.append(sub);
    }
    for (const p of t.panes) {
      const pane = el("section", { id: `alef-pane-${p}`, class: `alef-pane alef-pane-${p}`, "aria-label": PANE_META[p].label, tabindex: "0" });
      pane.hidden = true;
      panel.append(pane);
      paneEls.set(p, pane);
    }
    panes.append(panel);
    railPanels.set(t.id, panel);
  }
  tablist.addEventListener("keydown", (ev) => {
    const i = RAIL_TABS.findIndex((t) => t.id === railTabFor(tabChoice.get()));
    let n = -1;
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight") n = (i + 1) % RAIL_TABS.length;
    else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") n = (i - 1 + RAIL_TABS.length) % RAIL_TABS.length;
    else if (ev.key === "Home") n = 0;
    else if (ev.key === "End") n = RAIL_TABS.length - 1;
    if (n < 0) return;
    ev.preventDefault();
    const t = RAIL_TABS[n]!.id;
    selectRail(t, true);
    tabButtons.get(t)?.focus();
  });
  right.append(rightHead, panes);

  // ---------------------------------------------------------------- ? Help overlay
  // Help is not a rail tab any more (UX-7): ? (or the rail's ? button, or the status bar's) opens
  // it over everything, Esc or a click outside closes it.
  const helpRoot = el("div", { id: "alef-help", class: "ui-backdrop alef-help-backdrop" });
  helpRoot.hidden = true;
  const helpCard = el("div", { class: "ui-dialog alef-help-card", "aria-labelledby": "alef-help-title" });
  const helpHead = el("div", { class: "alef-help-head" }, `<h2 id="alef-help-title">Help</h2>`);
  const helpClose = el("button", { type: "button", class: "alef-help-close", "aria-label": "Close help (Esc)", title: "Close (Esc)" }, `<span aria-hidden="true">✕</span>`);
  helpHead.append(helpClose);
  const helpBody = el("div", { id: "alef-help-body", class: "alef-help-body" });
  helpCard.append(helpHead, helpBody);
  helpRoot.append(helpCard);
  const helpDialog = modalDialog(helpRoot, helpCard, "Help");
  helpClose.addEventListener("click", () => helpDialog.close());
  function openHelp(): void {
    renderHelp();
    helpDialog.open(helpClose);
  }

  // ---------------------------------------------------------------- main, prompt, bottom
  const main = el("main", { id: "alef-view", tabindex: "-1", "aria-label": "View" });
  // Skip links: the first two things Tab reaches, shown only while focused (shell.css).
  const skipMain = el("a", { class: "alef-skip", href: "#alef-view" }, "Skip to content");
  const skipFeed = el("a", { class: "alef-skip", href: "#alef-pane-feed" }, "Skip to feed");
  skipMain.addEventListener("click", (ev) => {
    ev.preventDefault();
    main.focus();
  });
  skipFeed.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (chromeMode() !== "normal") setChromeMode("normal");
    selectTab("feed", true);
    paneEls.get("feed")?.focus();
  });
  const prompt = el("div", { id: "alef-prompt" });
  const dispatch = document.getElementById("dispatch");
  if (dispatch) prompt.append(dispatch);
  const bottom = el("div", { id: "alef-bottom" });
  const drawer = el("div", { id: "alef-drawer", class: "alef-drawer" });
  drawer.hidden = true;
  const bar = document.getElementById("statusbar") ?? el("div", { id: "statusbar" });
  bottom.append(drawer, bar);
  const focusPill = el("button", { type: "button", id: "alef-focus-pill", class: "alef-float-pill", title: "Leave focus mode (F or Esc)" }, `${icon("focus", 16)} Focus mode · <kbd>F</kbd> or <kbd>Esc</kbd> to leave`);
  focusPill.hidden = true;
  focusPill.addEventListener("click", () => api.setFocus(false));
  const hiddenPill = el("button", { type: "button", id: "alef-hidden-pill", class: "alef-float-pill", title: "Bring the panels back (H)" }, `${icon("panels", 16)} Show panels <kbd>H</kbd>`);
  hiddenPill.hidden = true;
  hiddenPill.addEventListener("click", () => {
    setChromeMode("normal");
  });
  const scrim = el("div", { id: "alef-scrim" });
  scrim.hidden = true;
  scrim.addEventListener("click", () => setSheet(null));
  // #app (3D) stays first; the shell sits above it and below the dialogs.
  const app = document.getElementById("app");
  const after = app?.nextSibling ?? null;
  const frag = document.createDocumentFragment();
  // The bar before the view in DOM order, so Tab reaches the navigation first; every piece
  // is position: fixed with its own z-index, so the order moves nothing on screen.
  frag.append(skipMain, skipFeed, top, main, left, right, prompt, bottom, scrim, focusPill, hiddenPill, helpRoot);
  document.body.insertBefore(frag, after);

  // ---------------------------------------------------------------- sidebars: rails + phone sheets
  function applySides(): void {
    const phone = isPhone();
    document.body.classList.toggle("alef-phone", phone);
    const lOpen = phone ? phoneSheet === "left" : leftOpen.get();
    const rOpen = phone ? phoneSheet === "right" : rightOpen.get();
    left.classList.toggle("rail", !lOpen);
    right.classList.toggle("rail", !rOpen);
    left.classList.toggle("sheet-open", phone && lOpen);
    right.classList.toggle("sheet-open", phone && rOpen);
    scrim.hidden = !(phone && phoneSheet);
    leftBody.inert = !lOpen;
    panes.inert = !rOpen;
    leftCollapse.setAttribute("aria-expanded", String(lOpen));
    leftCollapse.title = lOpen ? "Collapse to a rail" : "Expand search and filters";
    leftCollapse.setAttribute("aria-label", leftCollapse.title);
    leftCollapse.innerHTML = `<span aria-hidden="true">${phone ? "✕" : lOpen ? "«" : "»"}</span>`;
    rightCollapse.setAttribute("aria-expanded", String(rOpen));
    rightCollapse.title = rOpen ? "Collapse to a rail" : "Expand the sidebar";
    rightCollapse.setAttribute("aria-label", rightCollapse.title);
    rightCollapse.innerHTML = `<span aria-hidden="true">${phone ? "✕" : rOpen ? "»" : "«"}</span>`;
    leftToggle.setAttribute("aria-expanded", String(phone && lOpen));
    rightToggle.setAttribute("aria-expanded", String(phone && rOpen));
    if (rOpen && tabChoice.get() === "feed") feedUi?.render(); // on screen now: mark it seen
    queueLayout();
  }
  function setSheet(s: "left" | "right" | null): void {
    phoneSheet = s;
    applySides();
  }
  function openLeft(): void {
    if (isPhone()) setSheet("left");
    else if (!leftOpen.get()) {
      leftOpen.set(true);
      applySides();
    }
  }
  function openRight(): void {
    if (isPhone()) setSheet("right");
    else if (!rightOpen.get()) {
      rightOpen.set(true);
      applySides();
    }
  }
  leftCollapse.addEventListener("click", () => {
    if (isPhone()) setSheet(null);
    else {
      leftOpen.toggle();
      applySides();
    }
  });
  rightCollapse.addEventListener("click", () => {
    if (isPhone()) setSheet(null);
    else {
      rightOpen.toggle();
      applySides();
    }
  });
  leftToggle.addEventListener("click", () => setSheet(phoneSheet === "left" ? null : "left"));
  rightToggle.addEventListener("click", () => setSheet(phoneSheet === "right" ? null : "right"));
  railSearch.addEventListener("click", () => api.focusSearch());
  railFilters.addEventListener("click", () => {
    openLeft();
    filtersHost.querySelector<HTMLElement>("button, input")?.focus();
  });

  let feedUi: FeedUi | null = null;

  /** The pane last open inside each labelled tab, so Activity reopens on Logs if you left it there. */
  const lastPane = new Map<RailTab, RailPane>();
  /** Open a pane: its labelled tab, and inside that tab its sub-switch. */
  function selectTab(p: RailPane, user: boolean): void {
    tabChoice.set(p);
    const rail = railTabFor(p);
    lastPane.set(rail, p);
    for (const [k, b] of tabButtons) {
      const on = k === rail;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
      const panel = railPanels.get(k);
      if (panel) panel.hidden = !on;
    }
    for (const [k, pane] of paneEls) pane.hidden = k !== p;
    for (const [k, b] of paneButtons) b.setAttribute("aria-pressed", String(k === p));
    if (p === "routines") deps.renderRoutines(paneEls.get("routines")!);
    if (p === "feed") feedUi?.render();
    if (user) openRight();
  }
  /** A labelled tab: the pane last open inside it, else its first. */
  function selectRail(t: RailTab, user: boolean): void {
    const tab = RAIL_TABS.find((x) => x.id === t);
    if (!tab) return;
    const cur = tabChoice.get();
    selectTab(tab.panes.includes(cur) ? cur : (lastPane.get(t) ?? tab.panes[0]!), user);
  }

  // ---------------------------------------------------------------- tab contents
  function renderHelp(): void {
    const pane = helpBody;
    if (!pane.dataset.built) {
      pane.dataset.built = "1";
      pane.innerHTML = `<div class="alef-help-views"><h3>Views</h3>${helpViewsHtml()}</div>${helpHtml()}`;
      pane.querySelector("#help-welcome")?.addEventListener("click", () => deps.welcome());
      pane.querySelector("#help-tour")?.addEventListener("click", () => deps.tour());
    }
    const legend = pane.querySelector<HTMLElement>("#hud-legend");
    if (legend) {
      const seen = new Map<string, string>();
      for (const a of deps.store.agents.values()) if (!seen.has(a.role)) seen.set(a.role, a.color);
      legend.innerHTML = [...seen.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([role, color]) => `<span class="legend-item"><i style="background:${escapeHtml(color)}"></i>${escapeHtml(role)}</span>`)
        .join("");
    }
  }

  /** One <li> per view: emoji, name, its number key, and the hint. The keys never change. */
  function helpViewLi(v: AlefView): string {
    const keys = v.keys?.length ? ` <kbd>${v.keys.map((k) => escapeHtml(k.toUpperCase())).join("</kbd> <kbd>")}</kbd>` : "";
    const hint = v.hint ? ` <span class="help-where">${escapeHtml(v.hint)}</span>` : "";
    return `<li><span aria-hidden="true">${viewIcon(v.id, escapeHtml(v.emoji), 16)}</span> <b>${escapeHtml(v.name)}</b>${keys}${hint}</li>`;
  }
  /** The view list, shaped like the bar: grouped under the five destinations, or one flat list. */
  function helpViewsHtml(): string {
    const all = deps.registry.list();
    const byId = new Map(all.map((v) => [v.id, v]));
    if (!groupsOn.get()) return `<ul>${all.map(helpViewLi).join("")}</ul>`;
    const blocks = visibleGroups(all.map((v) => v.id)).map((g) => {
      const items = g.views.map((id) => byId.get(id)).filter((v): v is AlefView => Boolean(v));
      return `<h4 class="help-group"><span aria-hidden="true">${icon(g.id, 16) ?? escapeHtml(g.emoji)}</span> ${escapeHtml(g.name)} <kbd>${escapeHtml(g.key)}</kbd>${g.hint ? ` <span class="help-where">${escapeHtml(g.hint)}</span>` : ""}</h4><ul>${items.map(helpViewLi).join("")}</ul>`;
    });
    const loose = ungroupedViewIds(all.map((v) => v.id))
      .map((id) => byId.get(id))
      .filter((v): v is AlefView => Boolean(v));
    if (loose.length) blocks.push(`<h4 class="help-group">Other</h4><ul>${loose.map(helpViewLi).join("")}</ul>`);
    return blocks.join("");
  }

  const settings = paneEls.get("settings")!;
  settings.innerHTML = `<h3 class="alef-pane-h">Planet theme</h3><div id="alef-settings-theme"></div>
    <h3 class="alef-pane-h">In the world</h3><div class="alef-settings" id="alef-settings" role="group" aria-label="Settings"></div>
    <h3 class="alef-pane-h">Alef</h3><div class="alef-settings" id="alef-settings-app"></div>`;
  renderThemePicker(settings.querySelector<HTMLElement>("#alef-settings-theme")!, false);
  const settingsList = settings.querySelector<HTMLElement>("#alef-settings")!;
  const appSettings = settings.querySelector<HTMLElement>("#alef-settings-app")!;
  const welcomeBtn = el("button", { type: "button", class: "ui-btn ui-btn-menu", "data-label": "Show the welcome card again" }, `<span class="ui-ico" aria-hidden="true">${icon("welcome")}</span>`);
  welcomeBtn.addEventListener("click", () => deps.welcome());
  const resetBtn = el("button", { type: "button", class: "ui-btn ui-btn-menu", "data-label": "Reset the layout (sidebars, drawer)" }, `<span class="ui-ico" aria-hidden="true">${icon("reset")}</span>`);
  resetBtn.addEventListener("click", () => {
    leftOpen.reset();
    rightOpen.reset();
    statusBar.setDrawer(false);
    applySides();
    deps.ctx.toast("Layout reset.");
  });
  const groupsBtn = el("button", { type: "button", class: "ui-btn ui-btn-menu" });
  function paintGroupsBtn(): void {
    const on = groupsOn.get();
    groupsBtn.innerHTML = `<span class="ui-ico" aria-hidden="true">${on ? "\u{1F5C2}\u{FE0F}" : "\u{1F522}"}</span>`;
    groupsBtn.dataset.label = on ? "Views grouped into five" : `Show all ${deps.registry.list().length} views`;
    groupsBtn.title = groupsBtn.dataset.label;
    groupsBtn.setAttribute("aria-pressed", String(on));
  }
  paintGroupsBtn();
  groupsBtn.addEventListener("click", () => {
    groupsOn.toggle();
    paintGroupsBtn();
    renderSwitcher(viewHost.current()?.id ?? null);
    // The Help pane lists the views the way the bar does, so let it rebuild.
    helpBody.removeAttribute("data-built");
    deps.ctx.toast(groupsOn.get() ? "Views grouped into five." : "Every view shown.");
  });
  appSettings.append(welcomeBtn, resetBtn, groupsBtn);
  const statusChips = document.getElementById("sb-chips");
  for (const { featureId, button } of deps.featureButtons) {
    if (featureId === "routines") continue; // the Routines tab replaces its button
    const b = document.createElement("button");
    b.type = "button";
    const inStatus = button.placement === "status";
    b.className = inStatus ? "sb-chip" : "ui-btn ui-btn-menu";
    b.id = `hud-f-${featureId}-${button.id}`;
    b.title = button.title;
    b.setAttribute("aria-label", button.title);
    b.textContent = button.label;
    if (button.hidden) b.hidden = true;
    if (inStatus && button.alert) b.dataset.alert = button.alert;
    if (!inStatus) b.dataset.label = button.text ?? button.title;
    b.addEventListener("click", () => button.onClick(deps.ctx));
    (inStatus ? statusChips : settingsList)?.appendChild(b);
  }

  // ---------------------------------------------------------------- search + filters
  let search: SidebarSearch | null = null;
  /** Every view and Vault section by name, for the search's "Go to" group. The registry is fixed. */
  const navList = navEntries(deps.registry.list(), (id) => groupOf(id, groups)?.name ?? null, MIND_TABS, mindTabRoute);
  search = mountSearch(
    searchHost,
    deps.search.data,
    (a) => {
      if (isPhone()) setSheet(null);
      deps.search.run(a);
    },
    (shown) => left.classList.toggle("searching", shown),
    deps.search.exists,
    () => navList,
  );
  search.input.addEventListener("blur", () => {
    if (search?.input.value) return;
    searchWanted = false;
    applyLeftEmpty();
  });

  const sections = new SidebarSections(filtersHost);
  /** The active view's specs; a throwing filters() must never leave the previous view's sections up. */
  function specsOf(v: AlefView): FilterSpec[] {
    try {
      return v.filters?.(viewCtx) ?? [];
    } catch (err) {
      log.error(`view:${v.id}`, "filters() failed", err);
      return [];
    }
  }
  function renderFiltersNow(): void {
    const v = viewHost.current();
    if (!v) return;
    currentSpecs = specsOf(v);
    const next = initialFilterState(currentSpecs, filterStates.get(v.id));
    filterStates.set(v.id, next);
    sections.render(v.id, v.name, currentSpecs, next, {
      onToggle: (spec, value) => commit(toggleFilter(filterStates.get(v.id) ?? {}, spec, value)),
      onSearch: (spec, text) => commit(setSearchText(filterStates.get(v.id) ?? {}, spec, text)),
      onRemoveChip: (chip) => commit(removeChip(currentSpecs, filterStates.get(v.id) ?? {}, chip)),
      onReset: () => commit(clearedFilterState(currentSpecs)),
    });
    const active = currentSpecs.filter((s) => (next[s.id]?.length ?? 0) > 0 && s.type !== "segmented" && s.type !== "section").length;
    const badge = document.getElementById("alef-badge-filters");
    if (badge) {
      badge.hidden = active === 0;
      badge.textContent = String(active);
    }
    const railEmoji = document.getElementById("alef-rail-emoji");
    if (railEmoji) railEmoji.innerHTML = viewIcon(v.id, escapeHtml(v.emoji));
    railFilters.title = `${v.name}: ${currentSpecs.length ? "filters and tools" : "nothing to filter"}`;
    railFilters.setAttribute("aria-label", railFilters.title);
    applyLeftEmpty();
  }
  /** A view with no filters gets no left sidebar (UX-11): the main area takes its width, and
   *  ⌘K (or the status bar's search) brings the search back until it is emptied. */
  function applyLeftEmpty(): void {
    const hide = hidesLeftSidebar(currentSpecs.length, searchWanted || (search?.isActive() ?? false));
    if (document.body.classList.contains("alef-left-empty") === hide) return;
    document.body.classList.toggle("alef-left-empty", hide);
    queueLayout();
  }
  function commit(next: FilterState): void {
    const v = viewHost.current();
    if (!v) return;
    filterStates.set(v.id, next);
    renderFiltersNow();
    viewHost.filter(next);
  }

  // ---------------------------------------------------------------- views
  let selection: Selection | null = null;
  const viewCtx: ViewContext = {
    ...deps.ctx,
    selection: {
      get: () => deps.selection.get(),
      set: (sel) => deps.selection.set(sel),
    },
    route: () => viewHost.route() ?? { view: deps.registry.home().id, param: null },
    focus: {
      isOn: () => chromeMode() === "focus",
      set: (on) => api.setFocus(on),
    },
    planet: deps.planet,
    refreshFilters: () => renderFiltersNow(),
    setFilterState: (next) => {
      const v = viewHost.current();
      if (!v) return;
      filterStates.set(v.id, next);
      renderFiltersNow();
    },
    sidebars: {
      open: () => ({ left: leftOpen.get(), right: rightOpen.get() }),
      setOpen: (state) => {
        leftOpen.set(state.left);
        rightOpen.set(state.right);
        applySides();
      },
    },
    promptBox: promptBoxHost(prompt, queueLayout),
    feedStream: {
      list: (q) => deps.feed.list(q),
      onChange: (fn) => deps.feed.onChange(fn),
    },
  };

  let focusViewAfter = false;
  const viewHost = new ViewHost({
    registry: deps.registry,
    root: () => main,
    clearRoot: (r) => {
      r.replaceChildren();
      r.className = "";
      r.removeAttribute("style");
    },
    ctx: () => viewCtx,
    filterState: (v) => {
      const specs = specsOf(v);
      const s = initialFilterState(specs, filterStates.get(v.id));
      filterStates.set(v.id, s);
      return s;
    },
    selection: () => selection,
    onSwitched: (v, prev, route) => {
      for (const [id, b] of viewButtons) {
        const on = id === v.id;
        b.classList.toggle("on", on);
        if (on) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      }
      const group = groupOf(v.id, groups);
      const lit = subButtonFor(v.id, group);
      if (group) lastSub.get(group.id)?.set(lit);
      for (const [id, b] of groupButtons) {
        const on = group ? id === group.id : id === `view:${v.id}`;
        b.classList.toggle("on", on);
        if (on) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      }
      for (const [id, b] of subButtons) {
        const on = id === lit;
        b.classList.toggle("on", on);
        if (on) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      }
      renderSwitcher(v.id);
      main.classList.add(`view-${v.id}`);
      main.setAttribute("aria-label", `${v.name} view`);
      const cls = document.body.classList;
      for (const c of [...cls]) if (c.startsWith("alef-view-")) cls.remove(c);
      cls.add(`alef-view-${v.id}`);
      if (prev?.usesPlanet === true && v.usesPlanet !== true) {
        // Leaving a planet view: keep the canvas live through the fade (pausesPlanet() below
        // honors the same deadline) instead of hiding it the instant the new view mounts.
        planetGraceUntil = performance.now() + VIEW_FADE_MS;
        window.setTimeout(() => {
          if (viewHost.current()?.usesPlanet !== true) cls.add("alef-no-planet");
        }, VIEW_FADE_MS);
      } else {
        planetGraceUntil = 0;
        cls.toggle("alef-no-planet", v.usesPlanet !== true);
      }
      viewTitle = v.id === deps.registry.home().id ? "Alef" : `${v.name} · Alef`;
      applyTabChrome();
      const hash = formatRoute(route.view, route.param);
      if (location.hash !== hash) history.pushState(null, "", `${location.pathname}${location.search}${hash}`);
      // A search typed for the old view must not keep covering the new view's sections.
      if (prev && prev.id !== v.id) {
        search?.clear();
        searchWanted = false;
      }
      renderFiltersNow();
      filtersHost.scrollTop = 0;
      leftBody.scrollTop = 0;
      if (prev && prev.id !== v.id && left.classList.contains("rail") && currentSpecs.length) {
        railFilters.classList.remove("nudge");
        void railFilters.offsetWidth;
        railFilters.classList.add("nudge");
      }
      if (focusViewAfter) main.focus({ preventScroll: true });
      focusViewAfter = false;
      deps.onViewChanged(v, prev);
      if (focusGeneric && prev) api.setFocus(false);
    },
    onParam: (v, route) => {
      const hash = formatRoute(route.view, route.param);
      if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
    },
    onMountError: (v, root, err) => {
      root.innerHTML = `<div class="alef-card alef-error"><div class="alef-burst" aria-hidden="true">OOPS!</div><h2>${escapeHtml(v.emoji)} ${escapeHtml(v.name)} didn't load</h2><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><button type="button" class="comic-btn small">Back to Orbit</button></div>`;
      root.querySelector("button")?.addEventListener("click", () => api.showView("orbit"));
    },
  });

  function roomParam(): string | null {
    const s = deps.selection.get();
    return s?.kind === "agent" ? s.id : null;
  }

  // A legacy route (e.g. #/control-room) can resolve to the route you're ALREADY on (e.g. you
  // followed a stale link while #/room/all was already showing): showView() then no-ops and
  // never reaches the hash-correcting code in onSwitched/onParam below, so the address bar is
  // fixed here instead, right where the alias is resolved.
  function fixLegacyHash(resolved: Route): void {
    const hash = formatRoute(resolved.view, resolved.param);
    if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
  }

  window.addEventListener("hashchange", () => {
    const r = parseRoute(location.hash);
    if (r) {
      const resolved = resolveLegacyRoute(r);
      if (resolved !== r) fixLegacyHash(resolved);
      api.showView(resolved.view, resolved.param);
    }
  });

  // ---------------------------------------------------------------- layout vars
  let layoutQueued = false;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  function visible(e: HTMLElement): boolean {
    return e.isConnected && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
  }
  function layout(): void {
    layoutQueued = false;
    const phone = isPhone();
    const t = visible(top) ? top.getBoundingClientRect().bottom : 0;
    const l = !phone && visible(left) ? left.getBoundingClientRect().width : 0;
    const r = !phone && visible(right) ? right.getBoundingClientRect().width : 0;
    const sb = visible(bottom) ? window.innerHeight - bottom.getBoundingClientRect().top : 0;
    // The prompt box is docked right above the status bar (and its drawer): part of the bottom inset.
    const pr = visible(prompt) ? prompt.getBoundingClientRect().height : 0;
    insets = { top: Math.round(t), right: Math.round(r), bottom: Math.round(sb + pr), left: Math.round(l) };
    const s = document.body.style;
    s.setProperty("--alef-top", `${insets.top}px`);
    s.setProperty("--alef-left", `${insets.left}px`);
    s.setProperty("--alef-right", `${insets.right}px`);
    s.setProperty("--alef-status", `${Math.round(sb)}px`);
    s.setProperty("--alef-bottom", `${insets.bottom}px`);
    s.setProperty("--alef-prompt", "0px");
  }
  function queueLayout(): void {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(layout);
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(queueLayout);
    for (const e of [top, left, right, bottom, prompt]) ro.observe(e);
  }
  window.addEventListener("resize", () => {
    if (!isPhone()) phoneSheet = null;
    applySides();
  });
  onChromeChange((mode) => {
    const focus = mode === "focus";
    if (!focus && focusGeneric) {
      focusGeneric = false;
      viewHost.focus(false);
    }
    focusPill.hidden = !(focus && focusGeneric);
    hiddenPill.hidden = mode !== "hidden";
    queueLayout();
  });

  // ---------------------------------------------------------------- status bar
  const statusBar = mountStatusBar(bar, drawer, deps.store, {
    search: () => api.focusSearch(),
    help: () => api.openRightTab("help"),
    needs: () => openNeedsYou(api),
    pickAgent: deps.pickAgent,
    pickCity: deps.pickCity,
    talkSessions: deps.talkSessions,
  });
  new MutationObserver(queueLayout).observe(drawer, { attributes: true, attributeFilter: ["hidden"] });

  const api: Shell = {
    viewCtx,
    statusBar,
    start() {
      const params = new URLSearchParams(location.search);
      const { route: first, aliased } = initialRoute(location.hash, location.search, deps.registry.home().id);
      if (aliased) fixLegacyHash(first);
      api.showView(first.view, first.param, { replace: true });
      if (params.get("tab") === "inbox") openNeedsYou(api); // the old Inbox tab's links (UX-1)
      else if (params.get("tab") === "help") openHelp();
      else if (params.get("tab")) api.openRightTab(railPaneFor(params.get("tab")));
      if (params.get("drawer") === "1") statusBar.setDrawer(true);
    },
    showView(id, param = null, opts = {}) {
      if (switching) {
        log.warn("shell", `showView(${id}) ignored: a switch is in progress`);
        return;
      }
      switching = true;
      focusViewAfter = opts.focusView === true;
      // 160ms cross-fade (transitions.css): nothing to fade FROM on the very first view, so skip
      // it on boot. ViewHost.show() swaps root.innerHTML synchronously, so both the old and new
      // content are invisible for the same instant either way — going opacity:0→1 after the swap
      // is the honest version of a "cross-fade" here (see the file header comment).
      const hadView = viewHost.current() !== null;
      try {
        if (hadView) {
          main.classList.add("alef-vt-instant", "alef-vt-hidden");
          viewHost.show(id, param);
          void main.offsetWidth; // commit the instant opacity:0 before re-enabling the transition
          main.classList.remove("alef-vt-instant");
          requestAnimationFrame(() => main.classList.remove("alef-vt-hidden"));
        } else {
          viewHost.show(id, param);
        }
      } finally {
        switching = false;
      }
      if (isPhone() && phoneSheet === "left") setSheet(null);
    },
    activeView: () => viewHost.current()?.id ?? deps.registry.home().id,
    current: () => viewHost.current(),
    pausesPlanet: () => viewHost.current()?.usesPlanet !== true && performance.now() >= planetGraceUntil,
    coversPlanet: () => viewHost.current()?.coversPlanet === true,
    isSwitching: () => switching,
    openRightTab(tab) {
      if (tab === "help") openHelp();
      else selectTab(tab, true);
    },
    closeHelp() {
      if (!helpDialog.isOpen()) return false;
      helpDialog.close();
      return true;
    },
    focusSearch(query) {
      if (chromeMode() !== "normal") setChromeMode("normal");
      searchWanted = true;
      applyLeftEmpty();
      openLeft();
      // Synchronously: focus() recalculates styles, and the next keystrokes must land in the box
      // (a typed "h" reaching the window would hide every panel).
      search?.focus(query);
    },
    selected(sel) {
      selection = sel;
      viewHost.select(sel);
    },
    setFocus(on) {
      if (on) {
        if (chromeMode() === "focus") return;
        focusGeneric = true;
        setChromeMode("focus");
        focusPill.hidden = false;
        viewHost.focus(true);
      } else if (focusGeneric) {
        focusGeneric = false;
        focusPill.hidden = true;
        if (chromeMode() === "focus") setChromeMode("normal");
        viewHost.focus(false);
      }
    },
    genericFocus: () => focusGeneric,
    viewForKey: (key) => viewIdForKey(key),
    handleKey(ev) {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        api.focusSearch();
        return true;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
      if (ev.key === "?") {
        if (!api.closeHelp()) openHelp();
        return true;
      }
      const id = viewIdForKey(ev.key);
      if (!id) return false;
      ev.preventDefault();
      if (groupForKey(ev.key, groups)) {
        if (viewHost.current()?.id !== id) api.showView(id, id === "room" ? roomParam() : null, { focusView: true });
      } else if (viewHost.current()?.id === id && id !== deps.registry.home().id) api.back();
      else api.showView(id, id === "room" ? roomParam() : null, { focusView: true });
      return true;
    },
    escape() {
      if (phoneSheet) {
        setSheet(null);
        return true;
      }
      if (viewHost.escape()) return true;
      const cur = viewHost.current();
      if (cur && cur.id !== deps.registry.home().id) {
        api.back();
        return true;
      }
      return false;
    },
    back() {
      const prev = viewHost.previousRoute();
      const home = deps.registry.home().id;
      const target = prev && prev.view !== viewHost.current()?.id ? prev : { view: home, param: null };
      api.showView(target.view, target.param, { focusView: true });
    },
    refreshFilters: () => renderFiltersNow(),
    frame(dt) {
      statusBar.frame(dt);
    },
    settingsHost: () => settingsList,
    statusChipsHost: () => document.getElementById("sb-chips"),
    setTabBadge(tab, n, tone = "hot") {
      const b = document.getElementById(`alef-badge-${tab}`);
      if (b) {
        b.hidden = n <= 0;
        b.textContent = n > 99 ? "99+" : String(n);
        b.classList.toggle("quiet", tone === "quiet");
      }
      if (tab !== "help") {
        const rail = railTabFor(tab);
        if (RAIL_BADGE[rail] === tab) tabButtons.get(rail)?.setAttribute("aria-label", railTabName(rail, b && !b.hidden ? b.textContent : null));
      }
      // Phone: one badge on the sheet button = the Feed's open approvals (what waits on you is
      // Home's Needs you now and the status bar's waiting count, not a rail tab any more).
      const feedBadge = document.getElementById("alef-badge-feed");
      const hot = feedBadge && !feedBadge.hidden && !feedBadge.classList.contains("quiet") ? Number(feedBadge.textContent?.replace("+", "")) || 0 : 0;
      const sheet = document.getElementById("alef-badge-sheet");
      if (sheet) {
        sheet.hidden = hot === 0;
        sheet.textContent = String(hot);
      }
    },
    insets: () => insets,
  };

  // After `api` exists: the feed's first render sets the tab badge through it.
  feedUi = mountFeedUi(paneEls.get("feed")!, {
    feed: deps.feed,
    onPick: (item) => deps.pickFeed(item),
    decide: deps.decide,
    visible: () => tabChoice.get() === "feed" && (isPhone() ? phoneSheet === "right" : rightOpen.get()),
    onBadge: (open, unseen) => {
      api.setTabBadge("feed", open || unseen, open ? "hot" : "quiet");
    },
  });

  selectTab(tabChoice.get(), false);
  applySides();
  layout();
  return api;
}

