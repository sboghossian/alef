// Optional local-embedding boost for recall: only used when OLLAMA_HOST is reachable
// within 300ms at boot. No key, nothing leaves the Mac. Any failure — unreachable,
// timeout, bad response — degrades silently to the pure-BM25 result; this module
// never throws to its caller.

const PROBE_TIMEOUT_MS = 300;
const EMBED_TIMEOUT_MS = 5000;
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL?.trim() || "nomic-embed-text";

export interface OllamaProbe {
  reachable: boolean;
  host: string;
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Never holds the process open (matters for short-lived test processes and for a
  // background probe that must never delay clean shutdown).
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Probed once at boot (never per-query): a slow/unreachable Ollama must never block
 *  or slow down a recall request. */
export async function probeOllama(host: string | undefined = process.env.OLLAMA_HOST, timeoutMs = PROBE_TIMEOUT_MS): Promise<OllamaProbe> {
  if (!host) return { reachable: false, host: "" };
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${host.replace(/\/+$/, "")}/api/tags`, { signal });
    return { reachable: res.ok, host };
  } catch {
    return { reachable: false, host };
  } finally {
    clear();
  }
}

export async function embedOne(host: string, text: string, timeoutMs = EMBED_TIMEOUT_MS): Promise<number[] | null> {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${host.replace(/\/+$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: unknown };
    return Array.isArray(data.embedding) && data.embedding.every((x) => typeof x === "number") ? (data.embedding as number[]) : null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
