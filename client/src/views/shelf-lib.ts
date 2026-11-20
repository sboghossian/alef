// Pure helpers of the 🗄️ Shelf view (shelf.ts): filters, counts, shelves by section, what a click
// does, and what ?redact=1 shows (type and kind only: never titles, URLs or paths).

import { SHELF_ITEM_TYPES, SHELF_TYPE_META, type ShelfBoardItem, type ShelfItemType, type ShelfPin, type ShelfPinsState } from "../../../shared/features/shelf-board";

export interface ShelfFilter {
  query: string;
  types: readonly string[];
  districts: readonly string[];
  typedOnly: boolean;
}

export const NO_SHELF_FILTER: ShelfFilter = { query: "", types: [], districts: [], typedOnly: false };

export function searchText(i: Pick<ShelfBoardItem, "title" | "url" | "path" | "kind" | "type">, redact: boolean): string {
  return (redact ? `${i.type} ${SHELF_TYPE_META[i.type].label}` : `${i.title} ${i.url ?? ""} ${i.path ?? ""} ${i.kind} ${SHELF_TYPE_META[i.type].label}`).toLowerCase();
}

function matchesBut(i: ShelfBoardItem, f: ShelfFilter, redact: boolean, skip: "types" | "districts" | null): boolean {
  if (skip !== "types" && f.types.length && !f.types.includes(i.type)) return false;
  if (skip !== "districts" && f.districts.length && !(i.district && f.districts.includes(i.district))) return false;
  if (f.typedOnly && !i.typed) return false;
  const q = f.query.trim().toLowerCase();
  return !q || q.split(/\s+/).every((w) => searchText(i, redact).includes(w));
}

export const matchesShelfFilter = (i: ShelfBoardItem, f: ShelfFilter, redact = false): boolean => matchesBut(i, f, redact, null);

/** Count per type under every filter except the type chips (so a chip shows what clicking it adds). */
export function typeCounts(items: readonly ShelfBoardItem[], f: ShelfFilter, redact = false): Record<ShelfItemType, number> {
  const out = Object.fromEntries(SHELF_ITEM_TYPES.map((t) => [t, 0])) as Record<ShelfItemType, number>;
  for (const i of items) if (matchesBut(i, f, redact, "types")) out[i.type] += 1;
  return out;
}

/** Districts with at least one item under the other filters, most items first. */
export function districtCounts(items: readonly ShelfBoardItem[], f: ShelfFilter, redact = false): Array<{ id: string; count: number }> {
  const m = new Map<string, number>();
  for (const i of items) if (i.district && matchesBut(i, f, redact, "districts")) m.set(i.district, (m.get(i.district) ?? 0) + 1);
  return [...m].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export interface Shelf {
  section: string;
  pins: ShelfPin[];
}

/** One row per section, in the user's order (empty ones included, so they can be dropped onto). */
export function shelvesOf(state: ShelfPinsState): Shelf[] {
  const by = new Map<string, ShelfPin[]>(state.sections.map((s) => [s, []]));
  for (const p of state.pins) (by.get(p.section) ?? by.get("Unsorted"))?.push(p);
  return [...by].map(([section, pins]) => ({ section, pins }));
}

/** The label a card shows: the real title, or under ?redact=1 "Link 3" style placeholders. */
export function shownTitle(i: Pick<ShelfBoardItem, "type" | "title">, redact: boolean, n: number): string {
  return redact ? `${SHELF_TYPE_META[i.type].label.replace(/s$/, "")} ${n + 1}` : i.title;
}

export function shownKind(i: Pick<ShelfBoardItem, "type" | "kind">, redact: boolean): string {
  if (!redact) return i.kind;
  if (i.type === "github" || i.type === "linear") return i.kind.replace(/[\w-]*\d+/g, "…");
  return i.type;
}

/** Pinned item ids → the shelves each sits on, in pin order. */
export function pinnedMap(pins: readonly ShelfPin[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of pins) m.set(p.itemId, [...(m.get(p.itemId) ?? []), p.section]);
  return m;
}

/** Cards (left/right edges inside the scroller's content) not fully visible past the right edge of a
 *  row scrolled to `scrollLeft` with `width` visible: the "N more →" count. */
export function hiddenAfter(cards: ReadonlyArray<{ left: number; right: number }>, scrollLeft: number, width: number): number {
  return cards.filter((c) => c.right > scrollLeft + width + 1).length;
}

export type ShelfAction = "preview" | "projects" | "panel";

/** What a click opens: a previewable artifact → the artifacts modal; a folder or file inside a known
 *  project → the Projects drill-down; anything else → the card panel. */
export function actionFor(i: Pick<ShelfBoardItem, "type" | "hasPreview" | "path">, projectFor: (path: string) => string | null): ShelfAction {
  if (i.type === "artifact" && i.hasPreview) return "preview";
  if ((i.type === "folder" || i.type === "file") && i.path && projectFor(i.path)) return "projects";
  return "panel";
}

/** Id of the project whose folder holds `path` (the longest matching folder wins). */
export function projectForPath(path: string, projects: ReadonlyArray<{ id: string; path: string }>): string | null {
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (!p.path || (path !== p.path && !path.startsWith(`${p.path}/`))) continue;
    if (!best || p.path.length > best.len) best = { id: p.id, len: p.path.length };
  }
  return best?.id ?? null;
}

export const artifactIdOf = (url: string | null): string | null => (url ? (url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? null) : null);

/** An http(s) link safe to put in an href; anything else (javascript:, data:) is refused. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const s = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`;
  return `${Math.round(s / (86_400 * 30))}mo`;
}
