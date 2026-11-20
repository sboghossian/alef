// Wire types for the "brain" feature: a read-only window onto the vault
// (~/Documents/Code/alex_claude). Private: served to the local UI only, never logged in full.
//
//   GET /api/brain/graph?limit=         → BrainGraphResponse (top-N nodes by drawable edges then degree, default 1500, max 5000)
//   GET /api/brain/note?path=           → BrainNoteResponse  (vault-relative, ".md" optional, ≤256KB, secrets redacted)
//   GET /api/brain/backlinks?path=      → BrainBacklinksResponse
//   GET /api/brain/search?q=&limit=     → BrainSearchResponse (BM25 over vault notes, same engine as recall)
//   GET /api/brain/legend                → BrainLegendResponse (round 11, package D: vault-wide
//     totals for the Legend's toggles — every folder/type in the WHOLE vault, not just the
//     graph's top-N slice, plus tag/link/attachment counts)
// Backlinks + search come from one background index (built lazily on first use, cached in data/).

export const BRAIN_NOTE_MAX_BYTES = 256 * 1024;

export interface BrainError {
  ok: false;
  error: string;
}

export interface BrainNode {
  id: number;
  label: string;
  path: string; // vault-relative, no ".md"
  folder: string; // top-level vault folder, e.g. "30-Knowledge" ("" for root files)
  group: string; // brain-graph kind: knowledge | resource | session | project | meta | wiki | archive | other
  degree: number;
  community: number;
}

export interface BrainGroup {
  id: string; // folder name
  count: number; // nodes in this response
}

export interface BrainGraphResponse {
  ok: true;
  nodes: BrainNode[]; // most-connected first
  edges: Array<[number, number]>; // node ids, both ends included in `nodes`
  groups: BrainGroup[];
  total: { nodes: number; edges: number }; // in the full graph file
  generatedAt: string | null; // brain-graph.json mtime
}

export interface BrainLink {
  path: string; // vault-relative, with ".md"
  title: string;
}

export interface BrainNoteResponse {
  ok: true;
  path: string; // vault-relative, with ".md"
  title: string;
  markdown: string;
  size: number;
  modifiedAt: string;
  outlinks: BrainLink[]; // resolved [[wikilinks]] in this note
  backlinks: BrainLink[] | null; // null while the index is still building
}

export interface BrainBacklinksResponse {
  ok: true;
  path: string;
  ready: boolean;
  backlinks: BrainLink[];
}

export interface BrainSearchHit {
  path: string; // vault-relative, with ".md"
  title: string;
  snippet: string;
  score: number;
}

export interface BrainSearchResponse {
  ok: true;
  ready: boolean; // false while the index builds (hits = [])
  hits: BrainSearchHit[];
  indexed: number;
}

/** One row of the Legend: a real, vault-wide count (never the graph endpoint's top-N slice). */
export interface BrainLegendRow {
  id: string;
  count: number;
}

export interface BrainLegendResponse {
  ok: true;
  generatedAt: string | null; // brain-graph.json mtime, same as BrainGraphResponse
  totalNodes: number; // every node in brain-graph.json
  totalLinks: number; // every edge in brain-graph.json
  /** Top-level vault folders (00-Inbox, 10-Sessions, 20-Projects, …), sorted by count desc. */
  folders: BrainLegendRow[];
  /** brain-graph.json's own "f" kind per node: knowledge | resource | session | project | meta |
   *  wiki | archive | other. Sorted by count desc. */
  groups: BrainLegendRow[];
  /** Real attachment files under the vault (images, PDFs, audio, video, office docs — Obsidian's
   *  own definition of an embeddable attachment, not "every non-.md file"; vault infrastructure
   *  like brain-graph.json itself doesn't count). brain-graph.json has no attachment nodes at
   *  all, so this isn't in `folders`/`groups` either. */
  attachments: number;
  /** Top tags by real occurrence count, from the same background vault index search/backlinks
   *  use. Inline #tags only (frontmatter `tags:` arrays aren't parsed) — an honest limitation,
   *  not a guess. Empty (not missing) while the index hasn't built yet; see `tagsReady`. */
  tags: BrainLegendRow[];
  tagsReady: boolean;
}
