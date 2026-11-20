// Pure logic for the "archive" feature: parses a vault session note's frontmatter (untrusted text,
// validated tolerantly) and places every archived session on an island, a topic continent group,
// or an archived-only district. No I/O here; server/features/archive.ts reads the files.
// Covered by server/test/archive-lib.test.ts.

import { basename } from "node:path";
import type { ArchivedSession, ArchivePlace, ArchiveSummary } from "../../shared/features/archive.js";
import { classifySession, FOLDER_RULES, isCatchAll, majorityGroup, type SessionInput, type Taxonomy } from "./topics-lib.js";

/** Frontmatter sits at the top; real notes close it within ~1 KB. Nothing past this is read. */
export const HEAD_BYTES = 16 * 1024;
const TITLE_MAX = 120;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
/** `project` slugs the vault uses for runs from a shared folder (~, /, ~/Documents/Code). */
export const CATCH_ALL_SLUGS: ReadonlySet<string> = new Set(["home", "root", "documents-code"]);

export interface ArchiveNote {
  id: string;
  date: string;
  project: string;
  title: string;
  /** File name inside the sessions folder. */
  file: string;
}

export type SkipReason = "no-frontmatter" | "not-session" | "missing-id" | "bad-id" | "not-downloaded" | "read-timeout";
export type ParseResult = { ok: true; note: ArchiveNote } | { ok: false; reason: SkipReason };

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* unescaped inner quotes (common in these notes): strip the outer pair only */
    }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  // An opening quote whose value runs over several lines and was truncated.
  return s.replace(/^["']/, "");
}

/** Top-level lower-case `key: value` pairs; wrapped lines extend the previous scalar, `- ` list items are dropped. */
export function parseFrontmatter(text: string): Map<string, string> | null {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n")) return null;
  const end = src.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = src.charAt(end + 4);
  if (after !== "\n" && after !== "") return null;
  const out = new Map<string, string>();
  let last: string | null = null;
  for (const line of src.slice(4, end).split("\n")) {
    // Keys are lower-case (type, session_id…): "Categories:" inside a wrapped summary is text.
    const m = /^([a-z_][a-z0-9_-]*):(?:\s(.*))?$/.exec(line);
    if (m) {
      last = m[1]!;
      if (!out.has(last)) out.set(last, m[2] ?? "");
      else last = null; // a repeated key: keep the first value, ignore its continuation
      continue;
    }
    if (last !== null && !/^\s*- /.test(line)) out.set(last, `${out.get(last) ?? ""}\n${line}`);
  }
  return out;
}

/** "2026-06-08-for-naar-i-also.md" → "for naar i also". */
export function titleFromFile(file: string): string {
  return basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/-\d+$/, "").replace(/-/g, " ").trim();
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** One vault note's head (≤ HEAD_BYTES) → a validated ArchiveNote, or why it was skipped. */
export function parseSessionNote(head: string, file: string): ParseResult {
  const fm = parseFrontmatter(head);
  if (!fm) return { ok: false, reason: "no-frontmatter" };
  if (clean(unquote(fm.get("type") ?? "")) !== "session") return { ok: false, reason: "not-session" };
  const rawId = clean(unquote(fm.get("session_id") ?? ""));
  if (!rawId) return { ok: false, reason: "missing-id" };
  if (!ID_RE.test(rawId)) return { ok: false, reason: "bad-id" };
  const dateRaw = clean(unquote(fm.get("date") ?? ""));
  const date = DATE_RE.exec(dateRaw)?.[1] ?? DATE_RE.exec(file)?.[1] ?? "";
  const slug = clean(unquote(fm.get("project") ?? "")).toLowerCase();
  const project = SLUG_RE.test(slug) ? slug : "home"; // missing / odd slug: treat as a home-dir run
  const summary = clean(unquote(fm.get("title") ?? fm.get("summary") ?? ""));
  const title = cap(summary || titleFromFile(file) || rawId.slice(0, 8), TITLE_MAX);
  return { ok: true, note: { id: rawId.toLowerCase(), date, project, title, file } };
}

// ── placement ──────────────────────────────────────────────────────────────────────────────

export interface IslandRef {
  id: string;
  name: string;
  path: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The existing (non catch-all) city a project slug names: by id, then folder name, then display name. */
export function islandForSlug(slug: string, islands: readonly IslandRef[], homeDir: string): string | null {
  const real = islands.filter((i) => i.id !== "harness" && !isCatchAll(i, homeDir));
  const s = slugify(slug);
  const byId = real.find((i) => i.id === slug || i.id === s);
  if (byId) return byId.id;
  const byFolder = real.filter((i) => slugify(basename(i.path)) === s).sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  if (byFolder[0]) return byFolder[0].id;
  return real.find((i) => slugify(i.name) === s)?.id ?? null;
}

/** Slug of each linked-worktree alias folder (cwd outside its repo root) → its canonical island,
 *  kept only when every worktree with that slug agrees. Subfolder aliases are left out: their
 *  names ("out", "server", "tests") are too generic to claim a vault project. */
export function worktreeAliasIslands(aliases: readonly { cwd: string; root: string; islandId: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const a of aliases) {
    if (!a.islandId || a.cwd === a.root || a.cwd.startsWith(`${a.root}/`)) continue;
    const slug = slugify(basename(a.cwd));
    if (!slug || conflicted.has(slug)) continue;
    const prev = out.get(slug);
    if (prev && prev !== a.islandId) {
      out.delete(slug);
      conflicted.add(slug);
    } else out.set(slug, a.islandId);
  }
  return out;
}

export interface BuildArchiveInput {
  /** Parsed notes; for a duplicated id the unsuffixed note wins, then the first by file name. */
  notes: readonly ArchiveNote[];
  files: number;
  skipped: number;
  liveIds: ReadonlySet<string>;
  islands: readonly IslandRef[];
  /** Worktree folder slug → the canonical repo island its sessions now live on
   *  (worktreeAliasIslands), for vault notes still named after the worktree. */
  worktreeIslands?: ReadonlyMap<string, string>;
  taxonomy: Taxonomy;
  assignments: ReadonlyMap<string, string>;
  homeDir: string;
  notesDir: string; // vault-relative folder of the notes, e.g. "10-Sessions/claude-code"
  /** The topics feature's cached Jev answers (session id → group). Empty = rules only. */
  jev?: ReadonlyMap<string, string>;
  vault: string;
  now: number;
}

export interface ArchiveIndex {
  summary: ArchiveSummary;
  sessions: ArchivedSession[];
}

export interface BuiltArchive extends ArchiveIndex {
  /** Home/root runs no rule and no cached Jev answer placed: the topics feature's Jev queue. */
  needJev: SessionInput[];
}

const NO_JEV: ReadonlyMap<string, string> = new Map();

export function archivedInput(note: Pick<ArchiveNote, "id" | "title" | "project">, catchAll: boolean): SessionInput {
  return { id: note.id, title: note.title, islandId: note.project, catchAll, headless: false };
}

/** Assignment → rules → cached Jev answer (never a live call here); null when none applies. */
export function topicGroupFor(note: Pick<ArchiveNote, "id" | "title" | "project">, taxonomy: Taxonomy, assignments: ReadonlyMap<string, string>, catchAll: boolean, jev: ReadonlyMap<string, string> = NO_JEV): string | null {
  const c = classifySession(archivedInput(note, catchAll), { taxonomy, assignments, jev });
  return c?.group ?? null;
}

export function buildArchive(input: BuildArchiveInput): BuiltArchive {
  const { taxonomy, assignments } = input;
  const order = taxonomy.groups.map((g) => g.key);
  const known = new Set(order);
  const seen = new Set<string>();
  let duplicates = 0;
  let skippedLive = 0;
  const kept: ArchiveNote[] = [];
  // The vault re-exports a session as "<name>-1.md", "<name>-18.md"…: prefer the unsuffixed note.
  const suffixed = (f: string): number => (/-\d+\.md$/.test(f) ? 1 : 0);
  const ranked = [...input.notes].sort((a, b) => suffixed(a.file) - suffixed(b.file) || a.file.localeCompare(b.file));
  for (const n of ranked) {
    if (seen.has(n.id)) {
      duplicates++;
      continue;
    }
    seen.add(n.id);
    if (input.liveIds.has(n.id)) {
      skippedLive++;
      continue;
    }
    kept.push(n);
  }

  const islandCache = new Map<string, string | null>();
  const islandOf = (slug: string): string | null => {
    if (!islandCache.has(slug)) {
      const viaWorktree = input.worktreeIslands?.get(slugify(slug));
      const worktreeIsland = viaWorktree && input.islands.some((i) => i.id === viaWorktree) ? viaWorktree : null;
      islandCache.set(slug, CATCH_ALL_SLUGS.has(slug) ? null : (islandForSlug(slug, input.islands, input.homeDir) ?? worktreeIsland));
    }
    return islandCache.get(slug) ?? null;
  };

  const sessions: ArchivedSession[] = [];
  const needJev: SessionInput[] = [];
  const places = new Map<string, ArchivePlace>();
  const archivedGroups = new Map<string, string[]>(); // slug → per-session rule groups (for its continent)
  const bump = (key: string, kind: ArchivePlace["kind"], ref: string, group: string): void => {
    const p = places.get(key) ?? { key, kind, ref, group, count: 0 };
    p.count++;
    places.set(key, p);
  };
  for (const n of kept) {
    let place: string;
    if (CATCH_ALL_SLUGS.has(n.project)) {
      const ruled = topicGroupFor(n, taxonomy, assignments, true, input.jev);
      if (!ruled) needJev.push(archivedInput(n, true));
      const g = ruled ?? taxonomy.fallback;
      place = `topic:${g}`;
      bump(place, "topic", g, g);
    } else {
      const island = islandOf(n.project);
      if (island) {
        place = `island:${island}`;
        bump(place, "island", island, "");
      } else {
        place = `archived:${n.project}`;
        bump(place, "archived", n.project, "");
        const g = topicGroupFor(n, taxonomy, assignments, false);
        if (g) archivedGroups.set(n.project, [...(archivedGroups.get(n.project) ?? []), g]);
      }
    }
    sessions.push({ id: n.id, title: n.title, date: n.date, project: n.project, place, note: `${input.notesDir}/${n.file}` });
  }
  // An archived-only district joins the continent its folder name says, else its sessions' majority.
  for (const p of places.values()) {
    if (p.kind !== "archived") continue;
    const folder = FOLDER_RULES.find((r) => r.pattern.test(p.ref) && known.has(r.group))?.group;
    p.group = folder ?? majorityGroup(archivedGroups.get(p.ref) ?? [], order) ?? taxonomy.fallback;
  }

  sessions.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const home = input.islands.find((i) => i.id !== "harness" && i.path.replace(/\/+$/, "") === input.homeDir.replace(/\/+$/, ""));
  return {
    sessions,
    needJev,
    summary: {
      generatedAt: new Date(input.now).toISOString(),
      files: input.files,
      parsed: input.notes.length,
      skipped: input.skipped,
      duplicates,
      skippedLive,
      total: sessions.length,
      homeIslandId: home?.id ?? null,
      vault: input.vault,
      places: [...places.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    },
  };
}
