// Zero-dependency BM25 lexical index, ported from aleph/recall.js's core (no chunking:
// our corpus is already small documents — a memory note, a vault _index.md, or a
// brain-graph node title — so one BM25 "chunk" per doc is enough).

import { createHash } from "node:crypto";

export interface RecallDoc {
  path: string;
  title: string;
  snippet: string; // already <=160 chars, already secret-redacted
}

export interface RecallChunk extends RecallDoc {
  len: number; // token count, for BM25 length normalization
  id: string; // stable content hash
}

export interface BM25Index {
  n: number;
  avgdl: number;
  chunks: RecallChunk[];
  /** term -> flat [chunkIdx, tf, chunkIdx, tf, ...] (compact, JSON-cacheable). */
  postings: Record<string, number[]>;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "of", "on", "or", "our",
  "she", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to",
  "too", "us", "was", "we", "were", "what", "when", "where", "which", "who", "will", "with",
  "you", "your",
]);

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const matches = s.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]{1,30}/g);
  if (!matches) return out;
  for (const raw of matches) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function chunkId(title: string, snippet: string): string {
  return createHash("sha1").update(`${title}\n${snippet}`).digest("hex").slice(0, 16);
}

/** Title is tokenized twice (matches aleph's weighting: a title-word match counts more). */
export function buildIndex(docs: readonly RecallDoc[]): BM25Index {
  const chunks: RecallChunk[] = [];
  const postings = new Map<string, Map<number, number>>();
  let totalLen = 0;

  for (const doc of docs) {
    const toks = tokenize(`${doc.title} ${doc.title} ${doc.snippet}`);
    if (!toks.length) continue;
    const idx = chunks.length;
    chunks.push({ ...doc, len: toks.length, id: chunkId(doc.title, doc.snippet) });
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, c] of tf) {
      let pl = postings.get(t);
      if (!pl) {
        pl = new Map();
        postings.set(t, pl);
      }
      pl.set(idx, c);
    }
  }

  const post: Record<string, number[]> = {};
  for (const [t, pl] of postings) {
    const arr: number[] = [];
    for (const [idx, c] of pl) arr.push(idx, c);
    post[t] = arr;
  }
  return { n: chunks.length, avgdl: chunks.length ? totalLen / chunks.length : 0, chunks, postings: post };
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** chunkIdx -> BM25 score for `query`'s (stopword-filtered) terms. */
export function bm25Scores(idx: BM25Index, query: string): Map<number, number> {
  const terms = [...new Set(tokenize(query))];
  const scores = new Map<number, number>();
  if (!terms.length) return scores;
  const N = idx.n;
  const avgdl = idx.avgdl || 1;
  for (const t of terms) {
    const arr = idx.postings[t];
    if (!arr) continue;
    const df = arr.length / 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < arr.length; i += 2) {
      const ci = arr[i] ?? -1;
      const tf = arr[i + 1] ?? 0;
      const chunk = idx.chunks[ci];
      if (!chunk) continue;
      const dl = chunk.len || 1;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
      const s = idf * ((tf * (BM25_K1 + 1)) / denom);
      scores.set(ci, (scores.get(ci) ?? 0) + s);
    }
  }
  return scores;
}

export interface ScoredHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

/** Ranked chunk indices (best first), deduped by path — the shape both the plain
 *  BM25 route and the semantic reranker in ollama-rerank.ts build on. */
export function rankedChunkIndices(idx: BM25Index, scores: ReadonlyMap<number, number>): number[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([ci]) => ci);
}

export function materialize(idx: BM25Index, rankedIdx: readonly number[], scores: ReadonlyMap<number, number>, k: number): ScoredHit[] {
  const out: ScoredHit[] = [];
  const seen = new Set<string>();
  for (const ci of rankedIdx) {
    const c = idx.chunks[ci];
    if (!c || seen.has(c.path)) continue;
    seen.add(c.path);
    const score = scores.get(ci) ?? 0;
    out.push({ path: c.path, title: c.title, snippet: c.snippet, score: Math.round(score * 1000) / 1000 });
    if (out.length >= k) break;
  }
  return out;
}

/** Pure BM25 search: the guaranteed fallback with no network involved. */
export function search(idx: BM25Index, query: string, k = 3): ScoredHit[] {
  if (!idx.n) return [];
  const scores = bm25Scores(idx, query);
  if (!scores.size) return [];
  return materialize(idx, rankedChunkIndices(idx, scores), scores, k);
}
