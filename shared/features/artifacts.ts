// Wire types for the "artifacts" feature: every claude.ai artifact a session published or worked
// with, as one item per artifact (a republish updates the same item), and a local copy of its
// source page for an in-app preview.
//
//   GET /api/artifacts             → ArtifactsResponse (newest first)
//   GET /api/artifacts/:id/preview → the saved copy of the page (text/html), or 404 when there is none.
//       Served with ARTIFACT_PREVIEW_CSP (server/features/artifacts.ts): its scripts run in an opaque
//       origin ("sandbox allow-scripts", connect-src 'none'), only Alef may frame it; plus
//       X-Content-Type-Options: nosniff, Cache-Control: no-store. Secrets are redacted at save time.
//
// Snapshot extra "artifacts.summary": ArtifactsSummary (small; the client fetches the list when
// `rev` changes). Snapshot island MUSEUM_ISLAND_ID: the Museum district that mirrors every item.

export const MUSEUM_ISLAND_ID = "museum";
export const MUSEUM_NAME = "Museum";
/** Largest source page Alef copies for a preview. */
export const ARTIFACT_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** An artifact id: the last segment of its claude.ai link. */
export const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** What a REAL artifact id looks like: a 22-char base58 short id (/artifact/<id>) or an RFC-4122 uuid
 *  (/code/artifact/<uuid>). Anything else (a doc placeholder, a truncated id) is never an artifact. */
export const ARTIFACT_SHORT_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{22}$/;
export const ARTIFACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isRealArtifactId = (id: string): boolean => ARTIFACT_SHORT_ID_RE.test(id) || ARTIFACT_UUID_RE.test(id);

/** The label for an item with no title: readable, from the id. A uuid link is a Claude Code artifact. */
export function artifactFallbackTitle(item: Pick<ArtifactItem, "id" | "url">): string {
  return item.url.includes("/code/artifact/") ? `Code artifact · ${item.id.slice(0, 8)}` : `Artifact · ${item.id.slice(0, 8)}`;
}

/** published: a session published (or republished) it with the Artifact tool.
 *  referenced: it only appears in transcripts (a link pasted, a gallery listing): no publisher known. */
export type ArtifactOrigin = "published" | "referenced";

export interface ArtifactItem {
  id: string;
  url: string; // https://claude.ai/artifact/<id> (or /code/artifact/<id>)
  /** Latest title a publish (or, failing that, a gallery listing) gave it; null when none was seen. */
  title: string | null;
  origin: ArtifactOrigin;
  /** District of the session that published it last (its home island); null for referenced items
   *  and for a publisher the index no longer has. The Museum holds every item either way. */
  islandId: string | null;
  /** Publishing sessions (published) or sessions that mentioned it (referenced), newest first, ≤20. */
  sessions: string[];
  firstAt: string | null; // ISO
  lastAt: string | null; // ISO: latest publish (published) or latest sighting
  publishCount: number;
  hasPreview: boolean;
}

export interface ArtifactsResponse {
  ok: true;
  /** False until the first full read of every transcript is done (the list may still grow). */
  ready: boolean;
  items: ArtifactItem[];
}

export interface ArtifactsSummary {
  ready: boolean;
  count: number;
  published: number;
  withPreview: number;
  /** Changes whenever the list changes. */
  rev: number;
}

export interface ArtifactsError {
  ok: false;
  error: string;
}

/** When an item entered our work: its latest publish, or (referenced) when it was first seen. A
 *  referenced link pasted again today must not jump ahead of what we actually made today. */
export function artifactAt(item: Pick<ArtifactItem, "origin" | "lastAt" | "firstAt">): string | null {
  return item.origin === "published" ? (item.lastAt ?? item.firstAt) : (item.firstAt ?? item.lastAt);
}

/** Newest first by artifactAt, then id (stable). */
export function byArtifactAt(a: ArtifactItem, b: ArtifactItem): number {
  return (artifactAt(b) ?? "").localeCompare(artifactAt(a) ?? "") || a.id.localeCompare(b.id);
}

/** "2026-10" for an ISO date; "undated" without one. Months group the Museum. */
export function artifactMonth(iso: string | null): string {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "undated";
}

export function isArtifactsSummary(v: unknown): v is ArtifactsSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.ready === "boolean" && typeof o.count === "number" && typeof o.rev === "number";
}
