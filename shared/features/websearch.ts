// Types for the "websearch" feature: Ask Jev's "From the web" section. The server runs
// Alex's jev_search.py (Firecrawl shortlist, re-ranked by Jev: does this result
// answer the question, is it a real source). User-initiated only: the question leaves
// the machine (to Firecrawl + TypeSafe), so the panel never sends it without a click.

export interface WebSearchRequest {
  question: string; // 1..300 chars
}

export interface WebSearchHit {
  title: string;
  /** Always http(s); anything else is dropped server-side. */
  url: string;
  snippet: string; // <=240 chars, whitespace-collapsed
  /** 0..1 Jev rank, or null when Jev failed and the engine order was kept. */
  rank: number | null;
}

export interface WebSearchResult {
  ok: boolean;
  hits: WebSearchHit[]; // best first, <=5
  /** True when the best result ranks under 0.5: nothing really answers it. */
  weak: boolean;
  /** Set on a search that came back: true once it is kept in data/jev-web.jsonl (Jev's trips). */
  kept?: boolean;
  error?: string;
}
