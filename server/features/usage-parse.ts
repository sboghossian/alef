// Minimal, standalone jsonl-line reader for the "usage" feature. server/jsonl-events.ts's
// parseLine deliberately drops cache_read_input_tokens ("a discount on input, not new
// spend — irrelevant to the live indexer") and doesn't split cache writes by TTL, both of
// which this feature's cost math needs — so it reads the raw JSON itself rather than
// stretching that contract. Transcript content is untrusted data: parsed only, read for
// a handful of fields, never executed or interpreted as instructions.

import type { TokenBucket } from "../../shared/features/usage.js";

export interface UsageLineFacts {
  cwd: string | null;
  /** Parsed `timestamp`, or null when missing/unparseable. */
  atMs: number | null;
  isAssistant: boolean;
  /** Set only on an assistant line. */
  model: string | null;
  messageId: string | null;
  /** Set only on an assistant line that carries a usage block. */
  tokens: TokenBucket | null;
}

const EMPTY: UsageLineFacts = { cwd: null, atMs: null, isAssistant: false, model: null, messageId: null, tokens: null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Null only for a malformed (non-JSON) line — a blank line or a well-formed-but-irrelevant
 *  one (system/queue-operation/...) returns an all-null-facts record, same as jsonl-events.ts. */
export function parseUsageLine(raw: string): UsageLineFacts | null {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return { ...EMPTY };

  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  const atMs = Number.isFinite(ts) ? ts : null;
  const type = typeof obj.type === "string" ? obj.type : null;
  const message = isRecord(obj.message) ? obj.message : null;

  if (type !== "assistant" || !message) return { cwd, atMs, isAssistant: false, model: null, messageId: null, tokens: null };

  const model = typeof message.model === "string" ? message.model : null;
  const messageId = typeof message.id === "string" ? message.id : null;
  const usage = isRecord(message.usage) ? message.usage : null;
  if (!usage) return { cwd, atMs, isAssistant: true, model, messageId, tokens: null };

  // Real usage blocks split cache_creation by TTL: { ephemeral_5m_input_tokens,
  // ephemeral_1h_input_tokens }. Fall back to the flat cache_creation_input_tokens (as a
  // 5m write, the default TTL) for any older line shape that predates the split.
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const write5m = cacheCreation ? num(cacheCreation.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
  const write1h = cacheCreation ? num(cacheCreation.ephemeral_1h_input_tokens) : 0;

  const tokens: TokenBucket = {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
  return { cwd, atMs, isAssistant: true, model, messageId, tokens };
}
