// THE VIEW GROUPS for Alef's top bar: five destinations over the registered views, so the
// switcher reads as five words instead of fourteen icons. A presentation layer plus the five
// number keys: 1–5 open the groups in bar order (each on its remembered sub-mode); view ids,
// routes and deep links (#/room/<id>, #/canvas?session=<id>) are untouched.
// DOM-free, so the rules below are unit-tested (groups.test.ts).
//
// The grouping rule that matters: a group never mixes planet views with flat ones. Orbit,
// District, Room and Courier keep the shared 3D canvas live (usesPlanet); everything else
// paints over it. Keeping the two apart means moving between a group's sub-modes never
// triggers the planet fade in shell.ts's onSwitched.
//
// Views NOT listed in any group still appear, as their own top-level button — see
// ungroupedViewIds. Registering a view can never make it unreachable.
//
// Note: the group id "brain" is the same word as the view id "brain" on purpose. They live
// in separate namespaces (data-group vs data-view) and a group id is never a route.

export interface ViewGroup {
  /** kebab-case. Used for data-group and for remembering the sub-mode. Never a route. */
  id: string;
  emoji: string;
  name: string;
  /** Tooltip one-liner for the group button. */
  hint?: string;
  /** The number key that opens it ("1"…"5", bar order). No view may claim it (groups.test.ts). */
  key: string;
  /** View ids, in sub-switcher order. The first is the group's default sub-mode. */
  views: readonly string[];
  /** Views reached from inside another view's own nav, so they get no sub-button: view id ->
   *  the listed view whose button lights for it. Claimed by the group like `views`. */
  inside?: Readonly<Record<string, string>>;
}

// The five destinations (UX-2/UX-9, the Wave 12 IA): what needs you today, the work, the
// world, what you know, and the setup underneath. Brain is ONE destination: its flat tab bar
// (views/mind-tabs.ts) carries the Graph and the Vault's fourteen readings, so it has no
// sub-pills; Setup folds the old System and Health groups together with Capabilities (the old
// Atlas view) and Routines.
export const VIEW_GROUPS: readonly ViewGroup[] = [
  {
    id: "today",
    emoji: "⚡",
    name: "Today",
    key: "1",
    hint: "What needs you, and what is running",
    views: ["home", "board"],
  },
  {
    id: "work",
    emoji: "🛠️",
    name: "Work",
    key: "2",
    hint: "Where you build, your projects, and talking to agents",
    views: ["code", "canvas", "voice", "library"],
    // A Project page (UX-3) is opened from a project (⌘K, a Library card, Vault, a district, Home), so Library lights.
    inside: { project: "library" },
  },
  {
    id: "world",
    emoji: "🪐",
    name: "World",
    key: "3",
    hint: "The planet, its cities and its rooms",
    views: ["orbit", "district", "room", "courier"],
  },
  {
    id: "brain",
    emoji: "🧠",
    name: "Brain",
    key: "4",
    hint: "What you know: the graph and every reading of the vault",
    views: ["brain"],
    // The Vault's fourteen readings are tabs of the Brain destination, beside Graph.
    inside: { vault: "brain" },
  },
  {
    id: "setup",
    emoji: "⚙️",
    name: "Setup",
    key: "5",
    hint: "Health and the fix queue, the machine, your capabilities and routines",
    views: ["health", "system", "capabilities", "routines"],
  },
];

/** The group holding `viewId`, or null when no group claims it. */
export function groupOf(
  viewId: string,
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): ViewGroup | null {
  for (const g of groups) if (g.views.includes(viewId) || g.inside?.[viewId]) return g;
  return null;
}

/** Every grouped view id, in top-bar then sub-switcher order. */
export function groupedViewIds(
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): string[] {
  return groups.flatMap((g) => [...g.views, ...Object.keys(g.inside ?? {})]);
}

/** Registered views no group claims. The shell renders these as their own top-level buttons,
 *  so a newly registered view is visible before anyone thinks to group it. */
export function ungroupedViewIds(
  registeredIds: readonly string[],
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): string[] {
  const claimed = new Set(groupedViewIds(groups));
  return registeredIds.filter((id) => !claimed.has(id));
}

/** The sub-button that lights for `viewId`: its own, or the host view it is reached from. */
export function subButtonFor(viewId: string, group: ViewGroup | null): string {
  return group?.inside?.[viewId] ?? viewId;
}

/** Which sub-mode a group button opens: the last one used there, else the group's first. */
export function defaultViewFor(
  group: ViewGroup,
  remembered?: string | null,
): string {
  if (remembered && group.views.includes(remembered)) return remembered;
  return group.views[0]!;
}

/** The group a pressed key opens ("1" → Today … "5" → Setup), or null. */
export function groupForKey(
  key: string,
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): ViewGroup | null {
  return groups.find((g) => g.key === key) ?? null;
}

/** Groups in top-bar order, keeping only the views actually registered, and dropping any group
 *  left empty. Lets the registry shrink (a view retired upstream) without a broken button. */
export function visibleGroups(
  registeredIds: readonly string[],
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): ViewGroup[] {
  const known = new Set(registeredIds);
  return groups
    .map((g) => ({ ...g, views: g.views.filter((id) => known.has(id)) }))
    .filter((g) => g.views.length > 0);
}

/** Human-readable problems with the grouping table, for the unit test and nothing else.
 *  Empty array = the table is sound. */
export function groupingProblems(
  registeredIds: readonly string[],
  groups: readonly ViewGroup[] = VIEW_GROUPS,
): string[] {
  const problems: string[] = [];
  const seenGroupIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  const seenViewIds = new Map<string, string>();
  const known = new Set(registeredIds);

  for (const g of groups) {
    if (seenGroupIds.has(g.id)) problems.push(`duplicate group id "${g.id}"`);
    seenGroupIds.add(g.id);
    if (seenKeys.has(g.key)) problems.push(`key "${g.key}" opens both "${seenKeys.get(g.key)}" and "${g.id}"`);
    seenKeys.set(g.key, g.id);
    if (g.views.length === 0) problems.push(`group "${g.id}" is empty`);
    for (const id of g.views) {
      const owner = seenViewIds.get(id);
      if (owner)
        problems.push(`view "${id}" is in both "${owner}" and "${g.id}"`);
      else seenViewIds.set(id, g.id);
      if (!known.has(id))
        problems.push(`group "${g.id}" lists unknown view "${id}"`);
    }
    for (const [id, host] of Object.entries(g.inside ?? {})) {
      const owner = seenViewIds.get(id);
      if (owner) problems.push(`view "${id}" is in both "${owner}" and "${g.id}"`);
      else seenViewIds.set(id, g.id);
      if (!known.has(id)) problems.push(`group "${g.id}" lists unknown view "${id}"`);
      if (!g.views.includes(host)) problems.push(`"${id}" in "${g.id}" lights "${host}", which has no button there`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- switcher scrolling

/** A child's horizontal extent in the strip's own content coordinates (0 = the strip's start,
 *  independent of how far it happens to be scrolled). */
export interface Span {
  left: number;
  right: number;
}

/** Slide `s` the minimum distance that brings `span` fully inside a window `width` wide. */
function intoView(s: number, width: number, span: Span): number {
  if (span.left < s) return span.left;
  if (span.right > s + width) return span.right - width;
  return s;
}

/** Where the switcher should be scrolled to, given what is lit.
 *
 *  Both levels want to be on screen and on a phone they do not both fit: five group pills is
 *  already most of a 233px strip, and World alone adds four sub-mode chips after them. So this
 *  settles the fight in one place, with a rule: **the group pill wins.** It is applied last, so
 *  the sub-mode chip gets as much room as is left over and the pill is never the thing pushed
 *  off the edge. Losing the pill is the worse failure -- it is the one thing telling you which
 *  of the five destinations you are in, and a half-clipped pill reads as a bug rather than as a
 *  strip that scrolls.
 *
 *  Pass null for either when it is not rendered (no active group, or a group with one view and
 *  so no sub-switcher). When everything already fits, every branch is a no-op and `s` comes
 *  back untouched -- nothing scrolls on a wide window.
 *
 *  The browser clamps an out-of-range scrollLeft itself, so an over-large result is harmless;
 *  the floor at 0 is here so the arithmetic never reads as if negative scroll were meaningful. */
export function switcherScrollLeft(
  scroll: number,
  width: number,
  sub: Span | null,
  pill: Span | null,
): number {
  let s = scroll;
  if (sub) s = intoView(s, width, sub);
  if (pill) s = intoView(s, width, pill);
  return Math.max(0, s);
}
