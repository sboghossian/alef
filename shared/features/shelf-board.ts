// Wire types for the Shelf view (🗄️, #/shelf): every link, artifact, dashable host, GitHub repo /
// PR / issue, Linear issue / doc and local folder or file our sessions touched, plus the shelves
// Alex pins them to (stored by Alef in world.db's meta table). Not the room shelf
// (shared/features/shelf.ts, one session's links and files): that one stays as it is.
//
//   GET    /api/shelf/board[?redact=1]  → ShelfBoardResponse (redact: titles, URLs and paths blanked)
//   POST   /api/shelf/pins               ShelfPinRequest   → ShelfPinsResponse (pin to one more shelf, or
//                                        with `from`: move that one pin to `section`)
//   DELETE /api/shelf/pins               { itemId | url, section? } → ShelfPinsResponse (one shelf, or all)
//   PUT    /api/shelf/sections           { sections, renames? } → ShelfPinsResponse
//   POST   /api/shelf/seed               ShelfSeedRow[] → ShelfSeedResponse (idempotent: (url, section) = key)
//
// A pin is keyed by (itemId, section): one item can sit on several shelves.
//
// Snapshot extra "shelf-board.summary": { ready, rev, count }.

export const SHELF_ITEM_TYPES = ["artifact", "dashable", "github", "linear", "link", "folder", "file"] as const;
export type ShelfItemType = (typeof SHELF_ITEM_TYPES)[number];

/** Where a mention came from. "user" = Alex typed or pasted it in a main session; "assistant" =
 *  an assistant's final text (or a subagent's brief); "tool" = a tool call's input; "fetch" = a URL a
 *  tool fetched (WebFetch, scrapers, curl). Fetch-only items are not listed. */
export type ShelfSource = "user" | "assistant" | "tool" | "fetch" | "artifacts" | "services" | "pin";

export interface ShelfBoardItem {
  /** Stable: derived from the normalised key (see itemKey on the server). */
  id: string;
  type: ShelfItemType;
  /** http(s) URL (normalised, tracking params dropped) for web types; null for folder/file. */
  url: string | null;
  /** Absolute local path for folder/file; null otherwise. */
  path: string | null;
  title: string;
  /** Short kind badge: "PR #12", "issue TICK-7", "doc", "repo", the host… */
  kind: string;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  /** Newest first, ≤8. */
  sessions: string[];
  /** District (island id) of the newest session that mentioned it. */
  district: string | null;
  /** The strongest source seen (user > assistant > tool > fetch). */
  source: ShelfSource;
  /** Alex typed or pasted it himself at least once. */
  typed: boolean;
  /** Artifacts only: a saved copy can be previewed in the artifacts modal. */
  hasPreview?: boolean;
  /** Dashable only: TCP up on its local port (null = unknown / not in services.yml). */
  up?: boolean | null;
  score: number;
}

export interface ShelfPin {
  itemId: string;
  section: string;
  type: ShelfItemType;
  url: string | null;
  path: string | null;
  title: string;
  pinnedAt: string;
}

export interface ShelfPinsState {
  sections: string[];
  pins: ShelfPin[];
}

export interface ShelfBoardResponse extends ShelfPinsState {
  ok: true;
  /** False until the first full read of every transcript is done. */
  ready: boolean;
  items: ShelfBoardItem[];
}

export interface ShelfPinRequest {
  itemId?: string;
  url?: string;
  section?: string;
  title?: string;
  /** Move the item's pin on this shelf to `section` (itemId only). */
  from?: string;
}

export interface ShelfPinsResponse extends ShelfPinsState {
  ok: true;
}

export interface ShelfSeedResponse extends ShelfPinsState {
  ok: true;
  added: number;
  skipped: number;
  invalid: number;
}

export interface ShelfBoardError {
  ok: false;
  error: string;
}

export const SHELF_TYPE_META: Record<ShelfItemType, { emoji: string; label: string }> = {
  artifact: { emoji: "🖼️", label: "Artifacts" },
  dashable: { emoji: "🛰️", label: "Dashable" },
  github: { emoji: "🐙", label: "GitHub" },
  linear: { emoji: "📐", label: "Linear" },
  link: { emoji: "🔗", label: "Links" },
  folder: { emoji: "📁", label: "Folders" },
  file: { emoji: "📄", label: "Files" },
};

const SOURCE_RANK: Record<ShelfSource, number> = { pin: 6, user: 5, artifacts: 4, services: 3, assistant: 3, tool: 1, fetch: 0 };
export const strongerSource = (a: ShelfSource, b: ShelfSource): ShelfSource => (SOURCE_RANK[b] > SOURCE_RANK[a] ? b : a);

const HALF_LIFE_DAYS = 14;
/** count (log) + recency (halves every 14 days) + a bonus when Alex typed it. */
export function shelfScore(i: Pick<ShelfBoardItem, "count" | "lastSeen" | "typed" | "source">, nowMs: number): number {
  const ageDays = i.lastSeen ? Math.max(0, (nowMs - Date.parse(i.lastSeen)) / 86_400_000) : 365;
  const recency = Number.isFinite(ageDays) ? 4 * 0.5 ** (ageDays / HALF_LIFE_DAYS) : 0;
  const bonus = (i.typed ? 2 : 0) + (i.source === "tool" ? -1 : 0);
  return Math.round((Math.log2(1 + i.count) + recency + bonus) * 1000) / 1000;
}

export function isShelfBoardResponse(v: unknown): v is ShelfBoardResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.ok === true && Array.isArray(o.items) && Array.isArray(o.pins) && Array.isArray(o.sections);
}

export function isShelfPinsState(v: unknown): v is ShelfPinsState & { ok: true } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.ok === true && Array.isArray(o.pins) && Array.isArray(o.sections);
}
