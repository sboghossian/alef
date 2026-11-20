// GET helper for the Code + Brain views. Unlike ctx.api.getJson it keeps the server's error
// text on a 4xx (a refused secret file must show B's refusal message, not "failed").

export type Fetched<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

interface ErrorBody {
  ok: false;
  error: string;
}

function isErrorBody(v: unknown): v is ErrorBody {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false && typeof (v as { error?: unknown }).error === "string";
}

/** Friendlier words for the server's short error codes. */
export function explainError(status: number, error: string): string {
  const e = error.trim();
  if (e === "secret" || /secret/i.test(e)) return "🔒 This file looks like a secret (keys, tokens, .env…). It is never shown here.";
  if (e === "outside-root") return "🔒 That path is outside this agent's repo.";
  if (e === "not-found" || status === 404) return "This file no longer exists.";
  if (e === "bad-path") return "That path is not valid.";
  if (status === 413) return "This file is too big to show here (over 512 KB).";
  if (status === 415) return "This is a binary file, not text.";
  return e || `The server answered ${status}.`;
}

export async function fetchResult<T>(url: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Fetched<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok && body !== null && !isErrorBody(body)) return { ok: true, data: body as T };
    return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : res.ok ? "empty response" : `HTTP ${res.status}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? (signal?.aborted ? "cancelled" : "timed out") : "world server unreachable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
