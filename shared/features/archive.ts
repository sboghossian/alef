// Wire types for the "archive" feature: every Claude Code session the vault remembers but whose
// transcript Claude Code has since pruned. The vault (~/Documents/Code/alex_claude, read-only)
// keeps one note per session in 10-Sessions/claude-code/*.md; the server reads their frontmatter
// only, skips the ids the world already indexes live, and places each one:
//   "island"   its `project` slug names an existing city (e.g. acme-ai-next)
//   "topic"    a home-dir run (project home / root / documents-code): a topic continent group,
//              picked by the topics feature's rules, then its cached Jev answers
//   "archived" a repo the world no longer has a city for: an archived-only district per slug
// The client draws them as "fossils": dormant forever, never reactivatable (the jsonl is gone).
//
//   GET /api/archive                     -> ArchiveList (every archived session, compact)
//   WS  "archive" feature message        -> ArchiveMessage (the summary changed)
//   WorldSnapshot.extras["archive.summary"] -> ArchiveSummary

export type ArchivePlaceKind = "island" | "topic" | "archived";

export interface ArchivePlace {
  /** "island:<islandId>" | "topic:<GROUP>" | "archived:<slug>". */
  key: string;
  kind: ArchivePlaceKind;
  /** island: the island id; topic: the group key; archived: the project slug. */
  ref: string;
  /** Topic continent: set for "topic" and "archived"; "" for "island" (the client uses the city's own continent). */
  group: string;
  count: number;
}

export interface ArchivedSession {
  id: string;
  title: string;
  /** YYYY-MM-DD, or "" when the note had none. */
  date: string;
  /** Frontmatter `project` slug as written (lower-cased). */
  project: string;
  /** ArchivePlace.key. */
  place: string;
  /** Vault-relative note path, e.g. "10-Sessions/claude-code/2026-06-08-foo.md". */
  note: string;
}

export interface ArchiveSummary {
  generatedAt: string;
  /** Note files looked at (every *.md except "_…" files). */
  files: number;
  /** Notes with `type: session` and a valid session_id. */
  parsed: number;
  /** Notes skipped: not a session note, missing/invalid id, no frontmatter. */
  skipped: number;
  /** Extra notes for an id already seen (the vault re-exports some sessions as "<name>-N.md"). */
  duplicates: number;
  /** Session ids the world already indexes from a live transcript. */
  skippedLive: number;
  /** Archived sessions placed on the planet (parsed − duplicates − skippedLive). */
  total: number;
  /** The home-directory island (catch-all), which "topic" fossils count toward in the Districts list. */
  homeIslandId: string | null;
  /** Obsidian vault name for obsidian:// links. */
  vault: string;
  places: ArchivePlace[];
}

export interface ArchiveList {
  summary: ArchiveSummary;
  sessions: ArchivedSession[];
}

export type ArchiveMessage = { kind: "summary"; summary: ArchiveSummary };

const KINDS: readonly string[] = ["island", "topic", "archived"];

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isPlace(v: unknown): v is ArchivePlace {
  const o = obj(v);
  return !!o && typeof o.key === "string" && typeof o.kind === "string" && KINDS.includes(o.kind) && typeof o.ref === "string" && typeof o.group === "string" && typeof o.count === "number";
}

/** Structural check (the client trusts nothing it parses). */
export function isArchiveSummary(v: unknown): v is ArchiveSummary {
  const o = obj(v);
  if (!o) return false;
  const nums = ["files", "parsed", "skipped", "duplicates", "skippedLive", "total"];
  if (!nums.every((k) => typeof o[k] === "number")) return false;
  if (o.homeIslandId !== null && typeof o.homeIslandId !== "string") return false;
  return typeof o.generatedAt === "string" && typeof o.vault === "string" && Array.isArray(o.places) && o.places.every(isPlace);
}

function isSession(v: unknown): v is ArchivedSession {
  const o = obj(v);
  return !!o && ["id", "title", "date", "project", "place", "note"].every((k) => typeof o[k] === "string");
}

export function isArchiveList(v: unknown): v is ArchiveList {
  const o = obj(v);
  return !!o && isArchiveSummary(o.summary) && Array.isArray(o.sessions) && o.sessions.every(isSession);
}
