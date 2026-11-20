// THE VIEW CONTRACT for Alef. A view is one full-screen way of looking at the fleet (Orbit,
// Board, Canvas, Room…). It plugs into the shell (shell.ts): the shell owns the top bar, both
// sidebars, the prompt box and the status bar; a view owns one element, `root`, the main view
// area between them. Register a view with ONE line in client/src/views/index.ts.
// Full guide: docs/VIEWS.md. This file is DOM-free except for the `root` it hands over, so the
// routing / switching / filter logic below is unit-tested (views.test.ts).

import type { ClientContext } from "../features/registry";
import { log } from "../log";
import type { FeedQuery } from "./feed";
import type { FeedItem, FeedSink } from "./feed-types";

// ---------------------------------------------------------------- shared selection

export type SelectionKind = "agent" | "city" | "object" | "subagent" | "jev" | "system";

/** What is selected, shared by every view (clicking an agent on the Board selects it on the planet). */
export interface Selection {
  kind: SelectionKind;
  id: string;
}

// ---------------------------------------------------------------- left sidebar filters

export interface FilterOption {
  value: string;
  label: string;
  /** Small number on the right (e.g. agents in that district). */
  count?: number;
  emoji?: string;
  /** Tooltip. */
  hint?: string;
  /** Colored dot before the label: "live" | "awaiting" | "today" | "asleep". */
  dot?: string;
  /** "list" rows: a tiny activity sparkline (e.g. sessions per day, oldest first). */
  spark?: number[];
  /** Secondary text under / after the label (e.g. "2 live · 5 today"). */
  meta?: string;
  /** Sort key for "list" rows sorted "by activity" (higher first). Defaults to `count`. */
  activity?: number;
  /** "list" rows: key of the FilterSpec.groups header this row sits under. */
  group?: string;
}

/** A header in a grouped "list" (e.g. a topic continent over its cities). */
export interface FilterGroup {
  key: string;
  label: string;
  /** Small text after the label, e.g. "33 sessions · 22 cities". */
  meta?: string;
  /** "#rrggbb" swatch before the label. */
  color?: string;
  /** Shown under the header when no row belongs to the group; without it an empty group is dropped. */
  empty?: string;
}

/**
 * One section in the left sidebar, under the search box.
 * - "chips":     toggle chips. `multi` = several at once (default: one or none).
 * - "segmented": exactly one option is always on (e.g. Today | All time).
 * - "list":      a tall clickable list (districts). One or none; clicking the active row clears it.
 *                `sortable` adds an Activity | A–Z switch, `pinnable` a ☆ per row (pins float to the top,
 *                remembered per view + spec id).
 * - "toggle":    one on/off switch; its value is ["on"] or [].
 * - "search":    a text box scoped to the view (e.g. "search the vault"); its value is [text] or [].
 * - "section":   view-owned content (controls, legend, a file tree…). The shell creates ONE host
 *                element per section and calls `render(host)` once; it keeps that element across
 *                refreshFilters() so the view updates it in place. The returned function (if any)
 *                runs when the view unmounts. It has no FilterState value.
 */
export interface FilterSpec {
  /** Key in FilterState. Unique within the view. */
  id: string;
  label: string;
  type: "chips" | "segmented" | "list" | "toggle" | "search" | "section";
  options?: FilterOption[];
  multi?: boolean;
  /** Initial value(s). "segmented" falls back to its first option. */
  default?: string[];
  /** Start folded (long lists). The user's fold choice is remembered. */
  collapsed?: boolean;
  /** Number shown in the section header (defaults to the option count for "list"). */
  count?: number;
  /** "search": placeholder text. */
  placeholder?: string;
  /** "list": offer Activity | A–Z ordering. */
  sortable?: boolean;
  /** "list": offer a pin (☆) per row. */
  pinnable?: boolean;
  /** "list": rows shown before "Show all N" (default: all). With `groups`, per group. */
  limit?: number;
  /** "list": group rows under these headers, in this order (rows with an unknown group go last). */
  groups?: readonly FilterGroup[];
  /** "list": one quiet line under the list. */
  note?: string;
  /** "section": fill the host once (see above). */
  render?(host: HTMLElement): void | (() => void);
}

/** filterId → selected values. Missing id = nothing selected. */
export type FilterState = Readonly<Record<string, readonly string[]>>;

// ---------------------------------------------------------------- the context a view gets

/** The right rail's panes, the names `openRightTab` takes. There is no Inbox pane: what needs you
 *  is Home's first section (UX-1, features/inbox.ts openNeedsYou), and a stored "inbox" choice
 *  falls back to the Feed. "help" is not a pane any more: it opens the ? overlay (UX-7). */
export type RightTab = "loops" | "feed" | "mac" | "help" | "settings" | "routines" | "logs";
export const RIGHT_TABS: readonly RightTab[] = ["loops", "feed", "mac", "help", "settings", "routines", "logs"];

/** The rail's three labelled tabs (UX-7): Activity holds the Feed and the Logs, Loops stands
 *  alone, Controls holds the Mac, Routines and Settings panes. */
export type RailTab = "activity" | "loops" | "controls";
export type RailPane = Exclude<RightTab, "help">;
export const RAIL_TABS: readonly { id: RailTab; label: string; panes: readonly RailPane[] }[] = [
  { id: "activity", label: "Activity", panes: ["feed", "logs"] },
  { id: "loops", label: "Loops", panes: ["loops"] },
  { id: "controls", label: "Controls", panes: ["mac", "routines", "settings"] },
];
export const RAIL_PANES: readonly RailPane[] = RAIL_TABS.flatMap((t) => t.panes);

/** The labelled tab a pane sits under. */
export function railTabFor(pane: RailPane): RailTab {
  return RAIL_TABS.find((t) => t.panes.includes(pane))?.id ?? "activity";
}

/** Which pane a remembered or linked choice opens: a rail tab opens its first pane, an old pane
 *  name opens itself, and anything else ("help", "inbox", junk) the Feed. */
export function railPaneFor(choice: string | null | undefined): RailPane {
  const tab = RAIL_TABS.find((t) => t.id === choice);
  if (tab) return tab.panes[0]!;
  return RAIL_PANES.find((p) => p === choice) ?? "feed";
}

/** UX-11: a view with no filters gets no left sidebar, unless the search in it is wanted (⌘K, or
 *  text still in the box). Desktop only: on a phone the sidebar is a sheet you open yourself. */
export function hidesLeftSidebar(filterCount: number, searching: boolean): boolean {
  return filterCount === 0 && !searching;
}

/** The 3D planet, for views that drive it (usesPlanet). Every call is a no-op when it can't apply. */
export interface PlanetApi {
  flyToAgent(agentId: string): void;
  flyToCity(cityId: string): void;
  /** Dive into an agent's 3D room (the room is drawn in the shared 3D canvas). */
  enterRoom(agentId: string): void;
  exitRoom(): void;
  /** Agent whose room is open, or null. */
  roomAgent(): string | null;
  /** Hand the camera to the ride feature (Courier). False when no ride can start. */
  startRide(): boolean;
  endRide(): void;
}

export interface Route {
  view: string;
  /** Route parameter, e.g. the agent id in #/room/<agentId>. */
  param: string | null;
}

/**
 * Everything a view may use. It is the features' ClientContext (store, api, toast, flyTo,
 * labels, feed, openRightTab, showView…) plus the view-only extras below.
 */
export interface ViewContext extends ClientContext {
  /** The shared selection. set() also updates the planet's side panel and every view's onSelect. */
  selection: {
    get(): Selection | null;
    set(sel: Selection | null): void;
  };
  /** The current route (#/<view>/<param>). */
  route(): Route;
  /** Focus mode: all chrome hidden, the view shows only what matters. F / Esc toggle it too. */
  focus: {
    isOn(): boolean;
    set(on: boolean): void;
  };
  planet: PlanetApi;
  /** Re-ask the active view's filters() (e.g. counts changed). Cheap; call it freely. */
  refreshFilters(): void;
  /** Overwrite the stored filter state and re-render (e.g. you refused a value). Does NOT call onFilter. */
  setFilterState(next: FilterState): void;
  /** Fold/unfold both sidebars to rails (a view maximising the viewport, e.g. Control room).
   *  setOpen persists like the user's own fold choice (a rail toggle), so read open() on mount
   *  and restore it on unmount rather than assuming it was open. No-op-ish on a phone (sidebars
   *  are bottom sheets there). */
  sidebars: {
    open(): { left: boolean; right: boolean };
    setOpen(state: { left: boolean; right: boolean }): void;
  };
  /** The ONE prompt box (#dispatch: text, city, voice, ⚡ Automations, Dispatch). `mountIn(host)`
   *  moves that same element into `host` (the Home view shows it centred) and hides the docked bar
   *  above the status bar; the returned function puts it back. Same element, same state, same
   *  Enter: there is never a second prompt box. Call the restore from unmount. */
  promptBox: {
    mountIn(host: HTMLElement): () => void;
  };
  /** The read side of the one Feed (`feed` pushes): its items in the Feed tab's order (open pinned
   *  items first, then newest first) and a change subscription (returns its unsubscribe). */
  feedStream: {
    list(q?: FeedQuery): FeedItem[];
    onChange(fn: () => void): () => void;
  };
}

// ---------------------------------------------------------------- the view itself

export interface AlefView {
  /** kebab-case; also the route: #/<id>. */
  id: string;
  emoji: string;
  name: string;
  /** Tooltip one-liner for the view switcher. */
  hint?: string;
  /** Single keys that open this view ("1", "b"). Letters are matched case-insensitively. */
  keys?: string[];
  /** Keep the shared 3D canvas visible and rendering behind `root` (Orbit, District, Courier, Room).
   *  false/absent: the shell paints an opaque page and pauses the 3D frame loop. */
  usesPlanet?: boolean;
  /** With usesPlanet: the view draws over the whole canvas every frame (the Room), so the hub
   *  keeps the planet ticking (live window) but skips its full-resolution picture. */
  coversPlanet?: boolean;
  /** Fill `root` (an empty element the shell owns). Awaiting is optional; a throw shows an error card. */
  mount(root: HTMLElement, ctx: ViewContext): void | Promise<void>;
  /** Undo everything mount did outside `root` (timers, listeners, body classes). The shell empties `root`. */
  unmount(): void;
  /** Left sidebar filters for this view. Called on mount and on ctx.refreshFilters(). */
  filters?(ctx: ViewContext): FilterSpec[];
  /** The user changed a filter (also called once right after mount with the initial state). */
  onFilter?(state: FilterState): void;
  /** Shared selection changed (also called right after mount with the current one, maybe null). */
  onSelect?(target: Selection | null): void;
  /** Focus mode toggled while this view is active (the shell already hid its own chrome). */
  onFocus?(on: boolean): void;
  /** Same view, new route param (#/room/a → #/room/b). Without it the shell remounts the view. */
  onParam?(param: string | null): void;
  /** Esc pressed while this view is active and nothing above it (dialog, sidebar search) took it.
   *  Return true when you handled it; false lets the shell go back to the previous view. */
  onEscape?(): boolean;
}

// ---------------------------------------------------------------- routing (pure)

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** "#/room/abc" → { view: "room", param: "abc" }. Null for anything that is not a view route. */
export function parseRoute(hash: string): Route | null {
  const m = /^#\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(hash.trim());
  if (!m) return null;
  const view = m[1]!.toLowerCase();
  if (!ID_RE.test(view)) return null;
  // Deep link #/canvas?session=<id> is the same route as #/canvas/<id> (Solo one session).
  if (m[3] !== undefined && !(view === "canvas" && !m[2])) return null;
  if (view === "canvas" && m[3] !== undefined) {
    const id = new URLSearchParams(m[3]).get("session");
    return { view, param: id || null };
  }
  let param: string | null = null;
  if (m[2]) {
    try {
      param = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
  }
  return { view, param: param || null };
}

export function formatRoute(view: string, param?: string | null): string {
  return param ? `#/${view}/${encodeURIComponent(param)}` : `#/${view}`;
}

/** The route to show first on load: the hash (a retired view's alias resolved), else an old
 *  ?board=1 / ?canvas=1 / ?room=<id> / ?view=<id> link, else the home view (the first registered
 *  one: 🏠 Home). `aliased` = the hash named a retired view, so the address bar needs fixing. */
export function initialRoute(hash: string, search: string, homeId: string): { route: Route; aliased: boolean } {
  const parsed = parseRoute(hash);
  if (parsed) {
    const resolved = resolveLegacyRoute(parsed);
    return { route: resolved, aliased: resolved !== parsed };
  }
  const params = new URLSearchParams(search);
  const legacy = (view: string, param: string | null = null): { route: Route; aliased: boolean } => ({ route: { view, param }, aliased: false });
  if (params.get("board") === "1") return legacy("board");
  if (params.get("canvas") === "1") return legacy("canvas");
  const room = params.get("room");
  if (room) return legacy("room", room);
  const view = params.get("view");
  if (view) return { route: resolveLegacyRoute({ view, param: null }), aliased: false };
  return legacy(homeId);
}

/** Views retired in round 11 (the 1:1 view, the Control room view) and the two merged into 📚 Library
 *  (#/projects[/<id>] -> By project, #/shelf -> By type): a bookmarked or pasted link to one of them
 *  lands somewhere sensible instead of the registry's generic "unknown view" home fallback.
 *  ViewHost.show runs it too, so a view calling showView("projects", id) still arrives. Any other
 *  route passes through unchanged (the same object). */
export function resolveLegacyRoute(route: Route): Route {
  // Wave 12 (UX-2): the skills Atlas is Setup › Capabilities; #/atlas was always that view (the
  // Vault's Folders section is #/vault/atlas and is untouched).
  if (route.view === "atlas") return { view: "capabilities", param: route.param };
  if (route.view === "control-room") return { view: "room", param: "all" };
  if (route.view === "one-on-one") return { view: "room", param: route.param };
  if (route.view === "projects") return { view: "library", param: route.param };
  if (route.view === "shelf") return { view: "library", param: "lens:type" };
  return route;
}

// ---------------------------------------------------------------- registry (pure)

export class ViewRegistry {
  private readonly byId = new Map<string, AlefView>();
  private readonly keyMap = new Map<string, string>();

  constructor(views: readonly AlefView[]) {
    for (const v of views) {
      if (!ID_RE.test(v.id)) throw new Error(`bad view id "${v.id}" (kebab-case, starts with a letter)`);
      if (this.byId.has(v.id)) throw new Error(`duplicate view id: ${v.id}`);
      this.byId.set(v.id, v);
      for (const k of v.keys ?? []) {
        const key = k.toLowerCase();
        const owner = this.keyMap.get(key);
        if (owner) throw new Error(`view key "${k}" used by both ${owner} and ${v.id}`);
        this.keyMap.set(key, v.id);
      }
    }
    if (this.byId.size === 0) throw new Error("no views registered");
  }

  list(): AlefView[] {
    return [...this.byId.values()];
  }

  get(id: string): AlefView | undefined {
    return this.byId.get(id);
  }

  /** View id for a pressed key (case-insensitive), or undefined. */
  forKey(key: string): string | undefined {
    return this.keyMap.get(key.toLowerCase());
  }

  /** The first registered view (🏠 Home): the default route and the fallback for unknown routes. */
  home(): AlefView {
    return this.list()[0]!;
  }
}

// ---------------------------------------------------------------- filter state (pure)

export function initialFilterState(specs: readonly FilterSpec[], remembered?: FilterState): FilterState {
  const out: Record<string, readonly string[]> = {};
  for (const s of specs) {
    if (s.type === "section") continue;
    if (s.type === "search") {
      const text = (remembered?.[s.id] ?? s.default ?? [])[0]?.trim() ?? "";
      out[s.id] = text ? [text] : [];
      continue;
    }
    const valid = new Set((s.options ?? []).map((o) => o.value));
    const pick = (vals: readonly string[] | undefined): string[] =>
      (vals ?? []).filter((v) => (s.type === "toggle" ? v === "on" : valid.has(v)));
    let v = pick(remembered?.[s.id]);
    if (!remembered?.[s.id]) v = pick(s.default);
    if (s.type === "segmented" && v.length !== 1) v = s.options?.[0] ? [s.options[0].value] : [];
    if (s.type !== "chips" || !s.multi) v = v.slice(0, 1);
    out[s.id] = v;
  }
  return out;
}

/** The user clicked `value` in filter `spec`: the next state (never mutates). */
export function toggleFilter(state: FilterState, spec: FilterSpec, value: string): FilterState {
  const cur = state[spec.id] ?? [];
  let next: string[];
  if (spec.type === "segmented") next = [value];
  else if (spec.type === "toggle") next = cur.includes("on") ? [] : ["on"];
  else if (spec.type === "chips" && spec.multi) next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  else next = cur.includes(value) ? [] : [value];
  return { ...state, [spec.id]: next };
}

/** A "search" section's text changed: the next state (never mutates). */
export function setSearchText(state: FilterState, spec: FilterSpec, text: string): FilterState {
  const t = text.trim();
  return { ...state, [spec.id]: t ? [t] : [] };
}

/** True when any filter narrows something (segmented filters sit at their first option). */
export function filtersActive(specs: readonly FilterSpec[], state: FilterState): boolean {
  return activeFilterChips(specs, state).length > 0;
}

/** One chip in the "active filters" summary at the top of the sidebar. */
export interface ActiveChip {
  specId: string;
  /** The value to toggle off (for search: the text). */
  value: string;
  label: string;
}

/**
 * Every value that narrows something, as removable chips. Segmented filters count only when
 * they are off their first option, other groups only when off their `default`; toggles read
 * "<label>"; search reads "“text”".
 */
export function activeFilterChips(specs: readonly FilterSpec[], state: FilterState): ActiveChip[] {
  const out: ActiveChip[] = [];
  for (const s of specs) {
    if (s.type === "section") continue;
    const v = state[s.id] ?? [];
    if (!v.length) continue;
    if (s.type === "segmented") {
      if (v[0] === restingSegment(s)) continue;
      out.push({ specId: s.id, value: v[0]!, label: s.options?.find((o) => o.value === v[0])?.label ?? v[0]! });
    } else if (s.type === "toggle") {
      out.push({ specId: s.id, value: "on", label: s.label });
    } else if (s.type === "search") {
      out.push({ specId: s.id, value: v[0]!, label: `“${v[0]!}”` });
    } else {
      // A value the view itself defaults to (e.g. the repo it picked) is a choice, not a narrowing.
      if (s.default?.length && v.length === s.default.length && v.every((x) => s.default!.includes(x))) continue;
      for (const val of v) out.push({ specId: s.id, value: val, label: s.options?.find((o) => o.value === val)?.label ?? val });
    }
  }
  return out;
}

/** A segmented group's resting value: its default, else its first option. */
function restingSegment(s: FilterSpec): string | undefined {
  const d = s.default?.[0];
  return d !== undefined && s.options?.some((o) => o.value === d) ? d : s.options?.[0]?.value;
}

/** The state with every filter back to its resting value (segmented → its default / first option, rest → none). */
export function clearedFilterState(specs: readonly FilterSpec[]): FilterState {
  return initialFilterState(specs.map((s) => ({ ...s, default: s.type === "segmented" ? [restingSegment(s) ?? ""] : [] })));
}

/** Remove one active chip (segmented goes back to its first option). */
export function removeChip(specs: readonly FilterSpec[], state: FilterState, chip: ActiveChip): FilterState {
  const s = specs.find((x) => x.id === chip.specId);
  if (!s) return state;
  if (s.type === "segmented") {
    const r = restingSegment(s);
    return { ...state, [s.id]: r !== undefined ? [r] : [] };
  }
  return { ...state, [s.id]: (state[s.id] ?? []).filter((v) => v !== chip.value) };
}

/** "list" rows in display order: pinned first (in pin order), then by activity or A–Z. */
export function orderListRows(options: readonly FilterOption[], sort: "activity" | "name" | "given", pins: readonly string[]): FilterOption[] {
  const pinIdx = new Map(pins.map((p, i) => [p, i]));
  const act = (o: FilterOption): number => o.activity ?? o.count ?? 0;
  const rest = options.filter((o) => !pinIdx.has(o.value));
  if (sort === "name") rest.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  else if (sort === "activity") rest.sort((a, b) => act(b) - act(a));
  const pinned = options.filter((o) => pinIdx.has(o.value)).sort((a, b) => pinIdx.get(a.value)! - pinIdx.get(b.value)!);
  return [...pinned, ...rest];
}

/** Grouped "list" rows: pinned rows first (no header), then each group in `groups` order with its
 *  rows ordered like orderListRows; rows whose group is unknown/missing form a last headerless block.
 *  Empty groups are dropped unless they carry an `empty` note. */
export function groupListRows(
  options: readonly FilterOption[],
  groups: readonly FilterGroup[],
  sort: "activity" | "name" | "given",
  pins: readonly string[],
): { group: FilterGroup | null; rows: FilterOption[] }[] {
  const pinSet = new Set(pins);
  const out: { group: FilterGroup | null; rows: FilterOption[] }[] = [];
  const pinned = orderListRows(options.filter((o) => pinSet.has(o.value)), sort, pins);
  if (pinned.length) out.push({ group: null, rows: pinned });
  const rest = options.filter((o) => !pinSet.has(o.value));
  const known = new Set(groups.map((g) => g.key));
  for (const g of groups) {
    const rows = orderListRows(rest.filter((o) => o.group === g.key), sort, []);
    if (rows.length || g.empty) out.push({ group: g, rows });
  }
  const loose = orderListRows(rest.filter((o) => o.group === undefined || !known.has(o.group)), sort, []);
  if (loose.length) out.push({ group: null, rows: loose });
  return out;
}

// ---------------------------------------------------------------- the switcher (DOM-light)

export interface ViewHostDeps {
  registry: ViewRegistry;
  /** Hands out the (emptied) main view element for a mount. */
  root(): HTMLElement;
  /** Clears `root` after an unmount. */
  clearRoot(root: HTMLElement): void;
  ctx(): ViewContext;
  /** Current filter state for a view (the shell remembers it per view). */
  filterState(view: AlefView): FilterState;
  /** Called after every switch (not on a param-only change): the shell updates the top bar, URL, filters. */
  onSwitched(view: AlefView, prev: AlefView | null, route: Route): void;
  /** Called on a param-only change. */
  onParam?(view: AlefView, route: Route): void;
  /** The current selection, replayed to the new view. */
  selection(): Selection | null;
  /** A view's mount threw (or rejected): show something friendly in its root. */
  onMountError(view: AlefView, root: HTMLElement, err: unknown): void;
}

/** Owns which view is active and runs the mount / unmount / hook sequence, every hook guarded. */
export class ViewHost {
  private active: AlefView | null = null;
  private activeRoute: Route | null = null;
  private previous: Route | null = null;

  constructor(private readonly deps: ViewHostDeps) {}

  current(): AlefView | null {
    return this.active;
  }

  route(): Route | null {
    return this.activeRoute;
  }

  /** The route we came from (Esc / "back" goes there). */
  previousRoute(): Route | null {
    return this.previous;
  }

  private guard(view: AlefView, hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error(`view:${view.id}`, `${hook} failed`, err);
    }
  }

  /**
   * Switch to `id` (unknown ids fall back to the home view). Returns the route actually shown.
   * Same view + same param: nothing. Same view + new param: onParam, else a remount.
   */
  show(id: string, param: string | null = null): Route {
    const reg = this.deps.registry;
    ({ view: id, param } = resolveLegacyRoute({ view: id, param }));
    let view = reg.get(id);
    if (!view) {
      log.warn("views", `unknown view "${id}", showing ${reg.home().id}`);
      view = reg.home();
      param = null;
    }
    const route: Route = { view: view.id, param };
    const cur = this.active;
    if (cur && cur.id === view.id) {
      if ((this.activeRoute?.param ?? null) === param) return route;
      if (cur.onParam) {
        const onParam = cur.onParam;
        this.activeRoute = route;
        this.guard(cur, "onParam", () => onParam.call(cur, param));
        this.deps.onParam?.(cur, route);
        return route;
      }
    }
    if (cur) {
      this.guard(cur, "unmount", () => cur.unmount());
      this.deps.clearRoot(this.deps.root());
      if (this.activeRoute && this.activeRoute.view !== view.id) this.previous = this.activeRoute;
    }
    this.active = view;
    this.activeRoute = route;
    const root = this.deps.root();
    const ctx = this.deps.ctx();
    const next = view;
    const after = (): void => {
      if (this.active !== next) return; // switched away while an async mount was running
      const { onFilter, onSelect } = next;
      if (onFilter) this.guard(next, "onFilter", () => onFilter.call(next, this.deps.filterState(next)));
      if (onSelect) this.guard(next, "onSelect", () => onSelect.call(next, this.deps.selection()));
    };
    try {
      const res = next.mount(root, ctx);
      if (res instanceof Promise) {
        void res.then(after, (err: unknown) => {
          log.error(`view:${next.id}`, "mount failed", err);
          if (this.active === next) this.deps.onMountError(next, root, err);
        });
      } else after();
    } catch (err) {
      log.error(`view:${next.id}`, "mount failed", err);
      this.deps.onMountError(next, root, err);
    }
    this.deps.onSwitched(next, cur, route);
    return route;
  }

  filter(state: FilterState): void {
    const v = this.active;
    const onFilter = v?.onFilter;
    if (v && onFilter) this.guard(v, "onFilter", () => onFilter.call(v, state));
  }

  select(sel: Selection | null): void {
    const v = this.active;
    const onSelect = v?.onSelect;
    if (v && onSelect) this.guard(v, "onSelect", () => onSelect.call(v, sel));
  }

  focus(on: boolean): void {
    const v = this.active;
    const onFocus = v?.onFocus;
    if (v && onFocus) this.guard(v, "onFocus", () => onFocus.call(v, on));
  }

  /** True when the active view consumed Esc. */
  escape(): boolean {
    const v = this.active;
    const onEscape = v?.onEscape;
    if (!v || !onEscape) return false;
    let used = false;
    this.guard(v, "onEscape", () => {
      used = onEscape.call(v) === true;
    });
    return used;
  }
}

export type { FeedSink };
