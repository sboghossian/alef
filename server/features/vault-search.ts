// ⌘K over the vault: project slugs, people and company notes, and every note's file name, matched
// against the graph feed rows already in memory (vault-feed.ts). No disk walk and no note bodies:
// the index is one lower-cased name per row, built once per feed parse.

import type { VaultNote, VaultSearchHit, VaultSearchKind } from "../../shared/features/vault.js";

/** Below this the box is still being typed into; the client sends nothing either. */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 12;

interface Entry {
  hit: VaultSearchHit;
  /** Lower-cased name the query is matched against. */
  key: string;
  /** Inbound plus outbound links (projects: notes carrying the slug), the tie-breaker. */
  weight: number;
}

export interface VaultSearchIndex {
  /** Already in tie-break order (projects · people · notes, most linked, A–Z), so a query only
   *  has to bucket matches by quality: no per-keystroke sort over thousands of hits. */
  entries: readonly Entry[];
}

const KIND_RANK: Record<VaultSearchKind, number> = { project: 0, person: 1, company: 1, note: 2 };

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function isCompany(n: VaultNote): boolean {
  if (n.type === "company") return true;
  const dirs = n.path.split("/").slice(0, -1).map((s) => s.toLowerCase());
  return dirs.includes("companies") || dirs.includes("company");
}

export function buildVaultSearchIndex(notes: readonly VaultNote[], inbound: ReadonlyMap<string, number>): VaultSearchIndex {
  const entries: Entry[] = [];
  const projectNotes = new Map<string, number>();
  const projectIndex = new Map<string, string>();
  for (const n of notes) {
    if (n.kind === "a") continue;
    if (n.project) projectNotes.set(n.project, (projectNotes.get(n.project) ?? 0) + 1);
    const idx = /^20-Projects\/([^/]+)\/_index\.md$/.exec(n.path);
    if (idx?.[1]) {
      projectIndex.set(idx[1].toLowerCase(), n.path);
      continue; // the project row stands for it; "_index" is no name to search
    }
    const name = baseName(n.path);
    const kind: VaultSearchKind = n.mentionWeeks === null ? "note" : isCompany(n) ? "company" : "person";
    const slash = n.path.indexOf("/");
    entries.push({ hit: { kind, name, path: n.path, meta: slash < 0 ? "" : n.path.slice(0, slash) }, key: name.toLowerCase(), weight: n.links.length + (inbound.get(n.id) ?? 0) });
  }
  for (const [slug, count] of projectNotes) {
    const path = projectIndex.get(slug.toLowerCase()) ?? "";
    entries.push({ hit: { kind: "project", name: slug, path, meta: `${count} note${count === 1 ? "" : "s"}` }, key: slug.toLowerCase(), weight: count });
  }
  entries.sort((a, b) => KIND_RANK[a.hit.kind] - KIND_RANK[b.hit.kind] || b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries };
}

/** 4 exact · 3 prefix · 2 a word starts with it · 1 anywhere · null no match. */
function matchScore(key: string, q: string): number | null {
  if (key === q) return 4;
  if (key.startsWith(q)) return 3;
  const at = key.indexOf(q);
  if (at < 0) return null;
  return /[\s_\-./]/.test(key[at - 1] ?? "") ? 2 : 1;
}

/** Best first: match quality, then projects · people · notes, then the most linked, then A–Z. */
export function vaultSearch(index: VaultSearchIndex, query: string, limit = SEARCH_LIMIT): VaultSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN_CHARS) return [];
  // buckets[s] holds score-s hits in index (tie-break) order; each stops at `limit`.
  const buckets: VaultSearchHit[][] = [[], [], [], [], []];
  for (const e of index.entries) {
    const s = matchScore(e.key, q);
    if (s !== null && buckets[s]!.length < limit) buckets[s]!.push(e.hit);
  }
  return buckets.reverse().flat().slice(0, limit);
}
