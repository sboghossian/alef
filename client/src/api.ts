import type { RecallOpenResult, RecallResult } from "../../shared/features/recall";
import type { WebSearchResult } from "../../shared/features/websearch";
import type {
  AskJevRequest,
  AskJevResult,
  DispatchRequest,
  DispatchResult,
  ReactivateResult,
} from "../../shared/types";

/** Thin typed wrappers over the server's POST endpoints. Every call resolves (never throws). */

export async function postJson<T>(url: string, body: unknown, fallback: (error: string) => T, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && typeof data === "object") return data as T;
    return fallback(res.ok ? "empty response" : `HTTP ${res.status}`);
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timed out" : "world server unreachable";
    return fallback(msg);
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON; resolves null on any failure (never throws). */
export async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function reactivate(agentId: string): Promise<ReactivateResult> {
  return postJson<ReactivateResult>(`/api/reactivate/${encodeURIComponent(agentId)}`, undefined, (error) => ({ ok: false, agentId, error }));
}

export function openEditor(agentId: string): Promise<ReactivateResult> {
  return postJson<ReactivateResult>(`/api/open-editor/${encodeURIComponent(agentId)}`, undefined, (error) => ({ ok: false, agentId, error }));
}

export function dispatch(req: DispatchRequest): Promise<DispatchResult> {
  const prompt = req.prompt.trim();
  if (!prompt) return Promise.resolve({ ok: false, islandId: req.islandId, error: "Write a prompt first." });
  if (prompt.length > 4000) return Promise.resolve({ ok: false, islandId: req.islandId, error: "Prompt is over 4000 characters." });
  if (!req.islandId || req.islandId === "harness") return Promise.resolve({ ok: false, islandId: req.islandId, error: "Pick a city to dispatch to." });
  return postJson<DispatchResult>("/api/dispatch", { islandId: req.islandId, prompt }, (error) => ({ ok: false, islandId: req.islandId, error }));
}

export function askJev(req: AskJevRequest): Promise<AskJevResult> {
  const question = req.question.trim();
  if (!question) return Promise.resolve({ ok: false, matches: [], confidence: 0, source: "keyword", error: "Ask a question first." });
  if (question.length > 500) return Promise.resolve({ ok: false, matches: [], confidence: 0, source: "keyword", error: "Question is over 500 characters." });
  return postJson<AskJevResult>("/api/ask-jev", { question }, (error) => ({ ok: false, matches: [], confidence: 0, source: "keyword", error }), 30_000);
}

/** "From your notes" — BM25 (+ optional local-embedding) search over the private vault
 *  corpus (see shared/features/recall.ts). Same never-throws contract as the rest. */
export function recall(question: string): Promise<RecallResult> {
  const q = question.trim();
  if (!q) return Promise.resolve({ ok: false, hits: [], mode: "bm25", ready: true, error: "Ask a question first." });
  return postJson<RecallResult>("/api/recall", { question: q }, (error) => ({ ok: false, hits: [], mode: "bm25", ready: true, error }), 15_000);
}

export function recallOpen(path: string): Promise<RecallOpenResult> {
  return postJson<RecallOpenResult>("/api/recall/open", { path }, (error) => ({ ok: false, error }));
}

/** "From the web" — Firecrawl results re-ranked by Jev (see shared/features/websearch.ts).
 *  Only ever called from an explicit click: the question leaves the machine. */
export function webSearch(question: string): Promise<WebSearchResult> {
  const q = question.trim();
  if (!q) return Promise.resolve({ ok: false, hits: [], weak: false, error: "Ask a question first." });
  if (q.length > 300) return Promise.resolve({ ok: false, hits: [], weak: false, error: "Question is over 300 characters." });
  return postJson<WebSearchResult>("/api/websearch", { question: q }, (error) => ({ ok: false, hits: [], weak: false, error }), 50_000);
}
