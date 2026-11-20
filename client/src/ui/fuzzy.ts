/**
 * Subsequence fuzzy score: every query char must appear in order.
 * Bonuses for contiguous runs, word starts and an early first hit.
 * Returns null when the query does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const atWord = direct === 0 || /[\s\-_/.:]/.test(t[direct - 1] ?? "");
    return 1000 - direct + (atWord ? 200 : 0) + q.length * 10;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  let first = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (first < 0) first = found;
    run = found === ti ? run + 1 : 0;
    const atWord = found === 0 || /[\s\-_/.:]/.test(t[found - 1] ?? "");
    score += 10 + run * 8 + (atWord ? 12 : 0);
    ti = found + 1;
  }
  return score - first * 0.5 - (t.length - q.length) * 0.05;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Best-first matches of `query` over items (each item may expose several searchable strings). */
export function fuzzyRank<T>(query: string, items: T[], keys: (item: T) => string[], limit = 30): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    let best: number | null = null;
    for (const k of keys(item)) {
      const s = fuzzyScore(query, k);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) out.push({ item, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** 1_940_000 -> "1.94M", 12_300 -> "12.3k", 950 -> "950". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff)) return "unknown";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
