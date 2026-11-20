// The Shelf's default sections: the headings of Alex's curated Linear doc "Artifacts"
// (linear.app/acmeai/document/artifacts-bb10a0f894be), plus "Unsorted" for anything pinned without one.
// The doc's ~60 links are NOT committed (private titles): feed them once to POST /api/shelf/seed as
// [{ section, url, title }]. The server never fetches Linear itself.

export const UNSORTED_SECTION = "Unsorted";

export const DEFAULT_SHELF_SECTIONS: readonly string[] = [
  "Product",
  "Growth",
  "Bandidos",
  "Sales",
  "Experiments",
  "Benchmarks",
  "Side projects",
  UNSORTED_SECTION,
];

/** One row of a seed import (the shape of the Linear doc export). */
export interface ShelfSeedRow {
  section: string;
  url: string;
  title: string;
}

export const SEED_MAX_ROWS = 500;
export const SECTION_MAX_CHARS = 40;
export const TITLE_MAX_CHARS = 120;

/** A section name as stored: trimmed, inner whitespace collapsed, ≤40 chars; null when empty. */
export function cleanSection(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, SECTION_MAX_CHARS);
  return s || null;
}

export function isSeedRow(v: unknown): v is ShelfSeedRow {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.section === "string" && typeof o.url === "string" && (o.title === undefined || typeof o.title === "string");
}
