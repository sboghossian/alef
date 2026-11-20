// Wire types + pure math for the "usage" feature (Round 8 H1 + H5): an ESTIMATED
// API-equivalent cost in USD, and active time, per session / city / day. Everything here
// is derived from local token counts in session jsonl against a hand-maintained price
// table — never a real invoice. Always label it "est." and "API-equivalent" — never
// "spend" or "bill" (Alex isn't billed per-token locally; this is a comparison number).

// ── tokens + pricing ─────────────────────────────────────────────────────────

/** One assistant turn's (or one aggregate bucket's) token counts, split the way the API
 *  prices them: cache writes are billed differently by TTL, cache reads at a discount. */
export interface TokenBucket {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

export const ZERO_TOKENS: Readonly<TokenBucket> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
});

export function addTokens(a: TokenBucket, b: TokenBucket): TokenBucket {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function totalTokens(t: TokenBucket): number {
  return t.inputTokens + t.outputTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens;
}

/** $ per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

// Standard Claude-API cache multipliers (apply to the base input price) — cache write
// costs more because it's extra work up front, cache read costs less because it replaces
// a full-price input token. Anthropic states these as ratios, not fixed dollar amounts.
const STANDARD_CACHE_WRITE_5M = 1.25;
const STANDARD_CACHE_WRITE_1H = 2;
const STANDARD_CACHE_READ = 0.1;

function priced(input: number, output: number, cacheReadMultiplier: number = STANDARD_CACHE_READ): ModelPrice {
  return {
    input,
    output,
    cacheWrite5m: input * STANDARD_CACHE_WRITE_5M,
    cacheWrite1h: input * STANDARD_CACHE_WRITE_1H,
    cacheRead: input * cacheReadMultiplier,
  };
}

/**
 * Est. API-equivalent price table — first-party Claude API list prices, $ per 1M tokens.
 * Built 2026-09-25. Sources:
 *  - Input/output prices: the `claude-api` skill's bundled pricing reference (its own
 *    cache date: 2026-06-24).
 *  - Cache multipliers (write 1.25x/2x by TTL, read 0.1x of base input, except the two
 *    model-specific overrides below): the same skill's prompt-caching reference.
 *  - Cross-checked against ~/Documents/Code/claude-usage's PRICING dict (a local project,
 *    its own April-2026 snapshot) — its input/output numbers for the 4.6-era models match;
 *    its Haiku 4.5 row ($0.80/$4.00) is lower than the skill's current one ($1.00/$5.00),
 *    almost certainly because that dict pins a dated preview snapshot
 *    (`claude-haiku-4-5-20251001`) rather than the GA id — the skill's number is used here.
 *    ~/Documents/Code/tally has no static price table to port: it reads the Admin API's
 *    real organization bill instead of estimating from tokens, which is the "real spend"
 *    number this feature deliberately does NOT compute (see the file header).
 * Anthropic changes prices without notice — re-derive from the same skill (or
 * platform.claude.com/docs pricing) rather than trusting this table indefinitely.
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Opus 5.5: cache reads are explicitly $0.20/MTok on a $4 input price (0.05x, not the 0.1x default).
  "claude-opus-5-5": priced(4.0, 20.0, 0.05),
  "claude-opus-5": priced(5.0, 25.0),
  "claude-opus-4-8": priced(5.0, 25.0),
  "claude-opus-4-7": priced(5.0, 25.0),
  "claude-opus-4-6": priced(5.0, 25.0),
  "claude-sonnet-5": priced(2.0, 10.0),
  // Sonnet 5.5: $2 in / $10 out, cache hits $0.20 (the standard 0.1x), 5m write $2.50, 1h write $4:
  // the same as Sonnet 5. Source: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-09-29).
  "claude-sonnet-5-5": priced(2.0, 10.0),
  "claude-sonnet-4-6": priced(3.0, 15.0),
  "claude-haiku-4-5": priced(1.0, 5.0),
  // Fable 5 / 5.1: cache reads are explicitly $0.25/MTok on a $10 input price (0.025x).
  "claude-fable-5": priced(10.0, 50.0, 0.025),
  "claude-fable-5-1": priced(10.0, 50.0, 0.025),
  // Not an API model: Claude Code's placeholder on turns it writes itself (API errors, "No
  // response requested.", timeouts). They never reach the API, so $0 is exact, not a guess.
  // Checked 2026-09-28: all 33 such lines under ~/.claude/projects carry an all-zero usage block.
  "<synthetic>": priced(0, 0),
});

const DATE_SUFFIX_RE = /-\d{8}$/; // "-20250620"-style dated snapshot suffix
const BRACKET_SUFFIX_RE = /\[[^\]]*\]$/; // "[1m]"-style context-window alias suffix

/** Strips a dated-snapshot or context-alias suffix so "claude-sonnet-5[1m]" or
 *  "claude-opus-4-6-20260115" can still match the bare id in PRICE_TABLE. */
export function normalizeModelId(model: string): string {
  return model.replace(BRACKET_SUFFIX_RE, "").replace(DATE_SUFFIX_RE, "");
}

/** Null when the model has no price entry — callers must never guess a price for it. */
export function priceForModel(model: string): ModelPrice | null {
  return PRICE_TABLE[model] ?? PRICE_TABLE[normalizeModelId(model)] ?? null;
}

export interface ModelCost {
  /** Null when `model` has no PRICE_TABLE entry — never a guessed number. */
  costUsd: number | null;
  /** All of `tokens`' tokens, only when costUsd is null (otherwise 0). */
  unpricedTokens: number;
}

/** Pure est. API-equivalent cost for one model's token bucket. Never throws, never guesses. */
export function costForModel(model: string, tokens: TokenBucket): ModelCost {
  const price = priceForModel(model);
  if (!price) return { costUsd: null, unpricedTokens: totalTokens(tokens) };
  const costUsd =
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheWrite5mTokens * price.cacheWrite5m +
      tokens.cacheWrite1hTokens * price.cacheWrite1h +
      tokens.cacheReadTokens * price.cacheRead) /
    1_000_000;
  return { costUsd, unpricedTokens: 0 };
}

// ── active time (billable-time's idle-gap rule) ─────────────────────────────

/** billable-time's default (`--idle-gap-min`, default 5): a gap this long or longer
 *  between two consecutive events closes the interval instead of counting toward it. */
export const IDLE_GAP_MS = 5 * 60_000;

/** ms to add to active time for one step from `prevMs` (null = no prior event yet) to
 *  `nextMs`: the gap, capped at `idleGapMs`. A non-advancing or out-of-order pair adds 0. */
export function activeMsForGap(prevMs: number | null, nextMs: number, idleGapMs: number = IDLE_GAP_MS): number {
  if (prevMs === null || nextMs <= prevMs) return 0;
  return Math.min(nextMs - prevMs, idleGapMs);
}

/** Batch form: sums the capped gaps between consecutive (ascending) event timestamps —
 *  the same rule billable-time's clusterIntervals uses, applied without materializing
 *  intervals (only the total active time is needed here, not their boundaries). */
export function activeMsFromEvents(sortedMs: readonly number[], idleGapMs: number = IDLE_GAP_MS): number {
  let total = 0;
  for (let i = 1; i < sortedMs.length; i++) total += activeMsForGap(sortedMs[i - 1] ?? null, sortedMs[i] as number, idleGapMs);
  return total;
}

// ── per-session streaming reducer (dedupe + gap, one jsonl line at a time) ──

/** Persisted per-session cursor: the indexer's own "was this turn already counted" +
 *  "when did the last event happen" state, so an incremental pass never double-counts a
 *  turn split across several lines, and a gap can be computed across pass/process boundaries. */
export interface SessionCursor {
  lastMessageId: string | null;
  lastEventMs: number | null;
}

export const INITIAL_CURSOR: Readonly<SessionCursor> = Object.freeze({ lastMessageId: null, lastEventMs: null });

/** What `reduceLine` needs from one jsonl line: `model`/`tokens` are only present on an
 *  assistant line that carries a usage block; every other line still has `atMs` (or null
 *  when the line has no timestamp) and still counts toward the active-time gap. */
export interface LineFacts {
  atMs: number | null;
  model: string | null;
  messageId: string | null;
  tokens: TokenBucket | null;
}

export interface ReduceResult {
  next: SessionCursor;
  /** ms to add to this session's active time for this line (already gap-capped). */
  activeMsDelta: number;
  /** New tokens to add, or null when this line has none or repeats the last-counted turn. */
  tokenDelta: { model: string; tokens: TokenBucket } | null;
}

/** Pure per-line reducer. One logical assistant turn is streamed across several jsonl
 *  lines that repeat the same `message.id` and the same (cumulative) usage block
 *  (server/jsonl-events.ts's ParsedLine doc) — a repeated id contributes 0 more tokens.
 *  Dedup only ever compares against the SINGLE last-seen id, matching how the live
 *  indexer's own `lastUsageMessageId` works (server/db.ts) — it is not a set of every id
 *  ever seen. Callers must therefore feed lines to one session in chronological (file)
 *  order and never re-feed a line from before `cursor.lastMessageId`/`lastEventMs`; the
 *  server-side backfill's offset + cursor are committed together in one transaction
 *  (usage-store.ts's applyBackfillBatch) specifically so a resume always starts exactly
 *  where the last committed batch left off, never earlier. */
export function reduceLine(cursor: SessionCursor, line: LineFacts, idleGapMs: number = IDLE_GAP_MS): ReduceResult {
  if (line.atMs === null) return { next: cursor, activeMsDelta: 0, tokenDelta: null };
  const activeMsDelta = activeMsForGap(cursor.lastEventMs, line.atMs, idleGapMs);
  const lastEventMs = cursor.lastEventMs === null ? line.atMs : Math.max(cursor.lastEventMs, line.atMs);
  let tokenDelta: ReduceResult["tokenDelta"] = null;
  let lastMessageId = cursor.lastMessageId;
  if (line.model && line.tokens && line.messageId && line.messageId !== cursor.lastMessageId) {
    tokenDelta = { model: line.model, tokens: line.tokens };
    lastMessageId = line.messageId;
  }
  return { next: { lastMessageId, lastEventMs }, activeMsDelta, tokenDelta };
}

// ── wire types ───────────────────────────────────────────────────────────────

export interface ModelMixRow {
  model: string;
  tokens: TokenBucket;
  /** Null when `model` has no price entry (see costForModel). */
  costUsd: number | null;
  unpricedTokens: number;
}

export interface CityUsage {
  islandId: string;
  name: string;
  /** Sum of priced models only, in this city on this day. */
  costUsd: number;
  unpricedTokens: number;
  activeMs: number;
  sessions: number;
}

export interface UsageDayResponse {
  ok: true;
  date: string;
  totalCostUsd: number;
  totalUnpricedTokens: number;
  totalActiveMs: number;
  perCity: CityUsage[];
}

export interface UsageDayError {
  ok: false;
  error: string;
}

export interface SessionUsageResponse {
  ok: true;
  agentId: string;
  islandId: string | null;
  totalCostUsd: number;
  totalUnpricedTokens: number;
  activeMs: number;
  models: ModelMixRow[];
}

export interface SessionUsageError {
  ok: false;
  error: string;
}

/** snapshot extras key "usage.today": instant paint for the status chip before its own
 *  panel fetch lands (same role as todos' "todos.lists"). */
export interface UsageTodayExtra {
  date: string;
  costUsd: number;
  unpricedTokens: number;
  activeMs: number;
}

// ── range view (model mix, cities, activity by hour over the last N days) ────

/** The ranges the usage panel's toggle offers. */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGES)[number];
export const isUsageRangeDays = (n: number): n is UsageRangeDays => (USAGE_RANGES as readonly number[]).includes(n);

export interface RangeModel {
  model: string;
  /** Null when the model has no price entry. */
  costUsd: number | null;
  tokens: number;
  unpricedTokens: number;
}

/** GET /api/usage/range?days=7|30|90 — from Alef's own usage store, nothing re-parsed. */
export interface UsageRangeResponse {
  ok: true;
  days: UsageRangeDays;
  /** Inclusive local date keys. */
  from: string;
  to: string;
  totalCostUsd: number;
  totalUnpricedTokens: number;
  totalActiveMs: number;
  perCity: CityUsage[];
  /** Cost-sorted; one row per model. */
  models: RangeModel[];
  /** Active ms per local clock hour, always 24 entries (index = hour 0-23). */
  byHour: number[];
}
