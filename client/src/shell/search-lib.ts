// Pure logic for the ONE sidebar search: results grouped Go to (views, Vault sections, projects
// and vault projects, each opening its Project page) · Agents · Cities · Notes & people · Files & objects · Commands (ranking inside a
// group is the palette's), and the "recent" picks remembered in localStorage. Navigation always
// sits above the Ask Jev / Dispatch fallbacks. DOM lives in search.ts.

import type { ProjectIndexItem } from "../../../shared/features/project-page";
import type { VaultSearchHit } from "../../../shared/features/vault";
import { fuzzyScore } from "../ui/fuzzy";
import { paletteRows, type PaletteAction, type PaletteData } from "../ui/palette";

export type SearchGroupId = "recent" | "go" | "agents" | "cities" | "notes" | "objects" | "commands";

export interface SearchRow {
  action: PaletteAction;
  kind: string;
  title: string;
  meta: string;
}

export interface SearchGroup {
  id: SearchGroupId;
  label: string;
  rows: SearchRow[];
}

const LABELS: Record<SearchGroupId, string> = {
  recent: "Recent",
  go: "Go to",
  agents: "Agents",
  cities: "Cities",
  notes: "Notes & people",
  objects: "Files & objects",
  commands: "Commands",
};
const ORDER: SearchGroupId[] = ["recent", "go", "agents", "cities", "notes", "objects", "commands"];
const CAPS: Record<SearchGroupId, number> = { recent: 6, go: 6, agents: 6, cities: 4, notes: 6, objects: 5, commands: 5 };

/** A place the search can take you: a registered view, or a section inside one (#/vault/gaps). */
export interface NavEntry {
  view: string;
  param: string | null;
  title: string;
  /** Shown before the title: "view", "vault". */
  kind: string;
  meta: string;
  /** Extra words that find it (its hint, its group). */
  keywords: readonly string[];
}

/** Every place to go: each registered view (found by name, hint, id and its top-bar group), then
 *  each Mind tab that is a section of another view (Vault's Pulse, People, Gaps…). A tab that IS
 *  a view (Graph = Brain) is found as that view and also by its tab name. */
export function navEntries(
  views: readonly { id: string; name: string; hint?: string }[],
  groupName: (viewId: string) => string | null,
  tabs: readonly { name: string; tabs: readonly { id: string; label: string; hint: string }[] }[],
  tabRoute: (tabId: string) => { view: string; param: string | null },
): NavEntry[] {
  const tabNames = new Map<string, string[]>();
  const sections: NavEntry[] = [];
  const names = new Map(views.map((v) => [v.id, v.name]));
  for (const g of tabs) {
    for (const t of g.tabs) {
      const r = tabRoute(t.id);
      const host = names.get(r.view);
      if (host === undefined) continue;
      if (r.param === null) tabNames.set(r.view, [...(tabNames.get(r.view) ?? []), t.label]);
      else sections.push({ view: r.view, param: r.param, title: t.label, kind: r.view, meta: `${host} · ${t.hint}`, keywords: [t.hint, g.name] });
    }
  }
  const own: NavEntry[] = views.map((v) => ({
    view: v.id,
    param: null,
    title: v.name,
    kind: "view",
    meta: v.hint ?? "",
    keywords: [v.id, v.hint ?? "", groupName(v.id) ?? "", ...(tabNames.get(v.id) ?? [])].filter(Boolean),
  }));
  return [...own, ...sections];
}

/** How well `q` finds a place: fuzzy on its name, but only whole substrings of its keywords,
 *  so a long hint never swallows an unrelated query. Null = no match. */
function navScore(q: string, e: NavEntry): number | null {
  const title = fuzzyScore(q, e.title);
  const lq = q.toLowerCase();
  const word = e.keywords.some((k) => k.toLowerCase().indexOf(lq) >= 0) ? 500 + lq.length * 10 : null;
  if (title === null) return word;
  return word === null ? title : Math.max(title, word);
}

/** Views and sections matching `query`, best first. */
export function navRows(query: string, entries: readonly NavEntry[], limit = CAPS.go): SearchRow[] {
  const q = query.trim();
  if (!q) return [];
  const scored: { e: NavEntry; s: number }[] = [];
  for (const e of entries) {
    const s = navScore(q, e);
    if (s !== null) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(({ e }) => ({
    action: { type: "view", view: e.view, param: e.param },
    kind: e.kind,
    title: e.title,
    meta: e.meta,
  }));
}

/** The vault slug of a project hit's index note (20-Projects/<slug>/_index.md), else null. */
export function projectSlugOf(path: string | null | undefined): string | null {
  const m = /^20-Projects\/([^/]+)\/_index\.md$/.exec(path ?? "");
  return m ? m[1]! : null;
}

/** A /api/vault/search hit as a row: a project opens its Project page (UX-3; the Projects section
 *  when the hit names no index note), anything else opens its note. */
export function vaultHitRow(h: VaultSearchHit): SearchRow {
  const slug = h.kind === "project" ? projectSlugOf(h.path) : null;
  const action: PaletteAction = slug ? { type: "view", view: "project", param: slug } : h.path ? { type: "note", path: h.path } : { type: "view", view: "vault", param: "projects" };
  return { action, kind: h.kind, title: h.name, meta: h.kind === "project" ? `vault project · ${h.meta}` : h.meta };
}

/** Every Library project as a place to go: its Project page, found by its name or its vault slug. */
export function projectNavEntries(items: readonly ProjectIndexItem[]): NavEntry[] {
  return items.map((p) => ({
    view: "project",
    param: p.key,
    title: p.name,
    kind: "project",
    meta: ["project", p.stage, p.vaultSlug ? `vault ${p.vaultSlug}` : ""].filter(Boolean).join(" · "),
    keywords: p.vaultSlug && p.vaultSlug !== p.name ? [p.vaultSlug] : [],
  }));
}

/** The vault is asked from this many characters on (the server answers nothing below it). */
export const VAULT_MIN_CHARS = 2;

/** The last vault answer, kept while a longer query is in flight but only the hits that still
 *  contain the words typed since; nothing when the box no longer extends that query. */
export function stillMatching(answeredFor: string, hits: readonly VaultSearchHit[], query: string): VaultSearchHit[] {
  const a = answeredFor.trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (!a || q.length < VAULT_MIN_CHARS || !q.startsWith(a)) return [];
  return hits.filter((h) => h.name.toLowerCase().includes(q));
}

/** What the box searches beyond the palette: places to go, the Library's projects and the
 *  vault's hits for this query. */
export interface SearchExtras {
  nav?: readonly NavEntry[];
  projects?: readonly ProjectIndexItem[];
  vault?: readonly VaultSearchHit[];
}

/** Which group a palette row kind belongs to. */
export function groupOf(row: Pick<SearchRow, "kind" | "action">): SearchGroupId {
  switch (row.action.type) {
    case "agent":
    case "reactivate":
    case "editor":
      return "agents";
    case "city":
      return "cities";
    case "object":
      return "objects";
    case "view":
      return "go";
    case "note":
      return row.kind === "project" ? "go" : "notes";
    default:
      return "commands";
  }
}

/** Grouped, capped results. Empty query: recent picks first, then the palette's suggestions. */
export function groupedResults(query: string, data: PaletteData, recent: readonly SearchRow[] = [], extras: SearchExtras = {}): SearchGroup[] {
  const q = query.trim();
  // Views, sections and projects first, then vault projects, so "vault" or "acme" lands on a
  // place before any fuzzy agent title; vault notes and people follow the palette's agents and
  // cities. A vault project a Library project already stands for is not listed twice.
  const projects = extras.projects ?? [];
  const claimed = new Set(projects.flatMap((p) => (p.vaultSlug ? [p.vaultSlug.toLowerCase()] : [])));
  const vaultRows = q ? (extras.vault ?? []).filter((h) => !claimed.has(projectSlugOf(h.path)?.toLowerCase() ?? "\0")).map(vaultHitRow) : [];
  const rows = [...navRows(q, [...(extras.nav ?? []), ...projectNavEntries(projects)]), ...vaultRows, ...paletteRows(q, data, 60)];
  const by = new Map<SearchGroupId, SearchRow[]>(ORDER.map((g) => [g, []]));
  if (!q) by.get("recent")!.push(...recent.slice(0, CAPS.recent));
  const seen = new Set((q ? [] : recent).map((r) => actionKey(r.action)));
  for (const r of rows) {
    const k = actionKey(r.action);
    if (seen.has(k)) continue;
    seen.add(k);
    const g = groupOf(r);
    const list = by.get(g)!;
    // "Ask Jev" / "Dispatch" rows always survive the cap: they are the fallbacks for any query.
    if (list.length < CAPS[g] || r.action.type === "ask" || r.action.type === "dispatch") list.push(r);
  }
  return ORDER.map((id) => ({ id, label: LABELS[id], rows: by.get(id)! })).filter((g) => g.rows.length > 0);
}

/** Flattened order for keyboard navigation. */
export function flatRows(groups: readonly SearchGroup[]): SearchRow[] {
  return groups.flatMap((g) => g.rows);
}

export function actionKey(a: PaletteAction): string {
  switch (a.type) {
    case "ask":
      return `ask:${a.query}`;
    case "dispatch":
      return `dispatch:${a.islandId}:${a.query}`;
    case "view":
      return `view:${a.view}:${a.param ?? ""}`;
    case "note":
      return `note:${a.path}`;
    default:
      return `${a.type}:${a.id}`;
  }
}

// ---------------------------------------------------------------- recents

export const RECENT_KEY = "alef.search.recent";
export const RECENT_MAX = 6;

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function isRow(x: unknown): x is SearchRow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const a = r.action as Record<string, unknown> | undefined;
  return typeof r.title === "string" && typeof r.kind === "string" && typeof r.meta === "string" && typeof a === "object" && a !== null && typeof a.type === "string";
}

export function loadRecent(store: KV | null): SearchRow[] {
  try {
    const raw = store?.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isRow).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Newest first, deduped by action, capped. Reactivate / VS Code picks are remembered as the agent. */
export function pushRecent(list: readonly SearchRow[], row: SearchRow): SearchRow[] {
  const action: PaletteAction = row.action.type === "reactivate" || row.action.type === "editor" ? { type: "agent", id: row.action.id } : row.action;
  const clean: SearchRow = { ...row, action };
  const k = actionKey(action);
  return [clean, ...list.filter((r) => actionKey(r.action) !== k)].slice(0, RECENT_MAX);
}

export function saveRecent(store: KV | null, list: readonly SearchRow[]): void {
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* not remembered */
  }
}

/** Drop recents whose agent / city / object no longer exists. */
export function liveRecent(list: readonly SearchRow[], exists: (a: PaletteAction) => boolean): SearchRow[] {
  return list.filter((r) => exists(r.action));
}
