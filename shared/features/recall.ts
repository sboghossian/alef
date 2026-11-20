// Types for the "recall" feature: Ask Jev's "From your notes" section, backed by a
// zero-dep BM25 (+ optional local-embedding) index over a fixed, read-only corpus:
// ~/.claude/projects/-Users-alexboghossian/memory/*.md,
// ~/Documents/Code/alex_claude/20-Projects/*/_index.md, and
// ~/Documents/Code/alex_claude/60-Meta/brain-graph.json (titles only).
// Vault/memory content is private, untrusted data: it is indexed and served locally
// only. Only short titles ever cross into a TypeSafe call (never full note bodies).
// Jev's kept web finds (data/jev-web.jsonl, server/features/recall/jev-web.ts) are a second,
// separate index: they come back as `web`, never mixed into the notes' ranking.

export interface RecallRequest {
  question: string; // 1..500 chars
}

export interface RecallHit {
  path: string; // absolute path on this machine
  title: string;
  /** <=160 chars, sanitized (secret-redacted) plain text. */
  snippet: string;
  score: number;
}

/** A page Jev found on the web for an earlier question (data/jev-web.jsonl), matched to this one.
 *  Third-party text: the client escapes it and links only an http(s) url. */
export interface RecallWebHit {
  title: string;
  url: string;
  host: string;
  /** The question Jev searched for then. */
  question: string;
  /** ISO time of that search. */
  at: string;
  score: number;
}

export interface RecallResult {
  ok: boolean;
  hits: RecallHit[]; // best first, <=3
  /** Jev's earlier web finds for this question, best first, <=3 (absent when none match). */
  web?: RecallWebHit[];
  mode: "bm25" | "hybrid";
  /** False while the background index is still building (first ~30s after boot). */
  ready: boolean;
  error?: string;
}

export interface RecallOpenRequest {
  path: string; // must be one of the corpus roots AND inside a known agent island's cwd
}
export interface RecallOpenResult {
  ok: boolean;
  error?: string;
}
