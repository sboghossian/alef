// Pure logic for the "logs" feature: the ring buffer (eviction + coalescing), redaction,
// truncation, NDJSON round-trip and the GET /api/logs query parser + matcher. No fs, no
// timers — server/features/logs.ts wires this to fs and the server/log.ts + feed.ts taps.

import type { FeedItem } from "../../shared/features/feed.js";
import type { ActionLogFields, LogEntry, LogLevel, LogSource } from "../../shared/features/logs.js";
import { isActionLogFields, isLogEntry } from "../../shared/features/logs.js";
import type { LogLine } from "../log.js";

export const RING_CAP_DEFAULT = 2000;
export const MESSAGE_MAX = 1000;
export const DETAIL_MAX = 2000;

// ---------------------------------------------------------------- redaction

const REDACTED = "«redacted»";

// Order matters: the prefixed/keyed shapes run first (so their surrounding text — "Bearer ",
// "key=" — survives), then the generic long-run catch-alls mop up anything else opaque.
const SK_RE = /\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}\b/g; // sk-…, sk-ant-…
const GH_RE = /\b(?:ghp|gho)_[A-Za-z0-9]{20,}\b/g; // ghp_…, gho_…
const GH_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const SLACK_RE = /\bxox[bpas]-[A-Za-z0-9-]{10,}\b/g;
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
const KV_RE = /\b(key|token|secret|password)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const HEX_RE = /\b[0-9a-f]{40,}\b/gi; // hex charset has no "/": a path never matches
const BASE64_RE = /\b[A-Za-z0-9+]{40,}={0,2}\b/g; // no "/" either, for the same reason

/** Token-like secrets → "«redacted»". Keeps UUIDs (36 chars, hyphen-broken into short runs)
 *  and file paths (the catch-all runs exclude "/", so a path's segments never qualify). */
export function redactLogText(text: string): string {
  return text
    .replace(SK_RE, REDACTED)
    .replace(GH_RE, REDACTED)
    .replace(GH_PAT_RE, REDACTED)
    .replace(SLACK_RE, REDACTED)
    .replace(AWS_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KV_RE, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(HEX_RE, REDACTED)
    .replace(BASE64_RE, REDACTED);
}

/** Caps `text` at `max` chars, appending "…(+N chars)" (N = chars dropped) when it overflows. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------- taps (pure transforms)

export interface LogEntryDraft {
  level: LogLevel;
  source: LogSource;
  scope: string;
  message: string;
  detail: string | null;
  action: ActionLogFields | null;
}

/** An action's `reason` is the only free-text field on it — job 2's own describeAction can set
 *  it from a response body's error message, which isn't guaranteed secret-free. method/route/
 *  status/durationMs come from job 2 itself, never from response content, so they pass through. */
function redactAction(a: ActionLogFields): ActionLogFields {
  return a.reason === null ? a : { ...a, reason: truncate(redactLogText(a.reason), MESSAGE_MAX) };
}

/** server/log.ts → a plain "server" entry, or an "action" entry for a well-formed action line
 *  (scope "action" + a strict ActionLogFields extra, redacted). A malformed "action" line stays a
 *  plain server entry, with its extra (safely stringified) as detail. */
export function draftFromLogLine(line: LogLine): LogEntryDraft {
  const action = line.scope === "action" && isActionLogFields(line.extra) ? redactAction(line.extra) : null;
  const message = truncate(redactLogText(line.message), MESSAGE_MAX);
  const detail = action ? null : line.extra !== undefined ? truncate(redactLogText(safeJson(line.extra)), DETAIL_MAX) : null;
  return { level: line.level, source: action ? "action" : "server", scope: line.scope, message, detail, action };
}

/** feed.ts → a "feed" entry, or null for "activity" (one per tool call — it would flood the
 *  ring, and the Feed tab already shows it). */
export function draftFromFeedItem(item: FeedItem): LogEntryDraft | null {
  if (item.kind === "activity") return null;
  const message = truncate(redactLogText(item.detail ? `${item.title} · ${item.detail}` : item.title), MESSAGE_MAX);
  const detail = item.agentId ? item.agentId.slice(0, 8) : null;
  return { level: "info", source: "feed", scope: item.kind, message, detail, action: null };
}

// ---------------------------------------------------------------- ring buffer

export interface LogRingOptions {
  cap?: number;
  now?: () => number;
}

/** In-memory ring buffer.
 *  - Eviction (once over cap): drop the oldest plain server/info line first — the noisy,
 *    repeatable stuff (e.g. "[indexer] incremental pass") — so actions/warnings/errors outlive it.
 *    Only once none of those are left does it drop the oldest entry overall.
 *  - Coalescing: a new *info* entry whose (source, scope, message) equals the newest entry's
 *    bumps that entry's repeat + ts instead of appending a duplicate. */
export class LogRing {
  private readonly cap: number;
  private readonly now: () => number;
  private seq = 0;
  private entries: LogEntry[] = [];

  constructor(opts: LogRingOptions = {}) {
    this.cap = opts.cap ?? RING_CAP_DEFAULT;
    this.now = opts.now ?? Date.now;
  }

  list(): readonly LogEntry[] {
    return this.entries;
  }

  cursor(): number {
    return this.seq;
  }

  /** Replaces the buffer wholesale (a persisted reload): renumbers seq 1..N in the given order. */
  seed(entries: readonly LogEntry[]): void {
    this.entries = entries.map((e, i) => ({ ...e, seq: i + 1 }));
    this.seq = this.entries.length;
  }

  push(draft: LogEntryDraft, ts: string = new Date(this.now()).toISOString()): LogEntry {
    const newest = this.entries[this.entries.length - 1];
    if (draft.level === "info" && newest && newest.source === draft.source && newest.scope === draft.scope && newest.message === draft.message) {
      newest.repeat += 1;
      newest.ts = ts;
      return newest;
    }
    const entry: LogEntry = { seq: ++this.seq, ts, level: draft.level, source: draft.source, scope: draft.scope, message: draft.message, detail: draft.detail, action: draft.action, repeat: 1 };
    this.entries.push(entry);
    this.evict();
    return entry;
  }

  private evict(): void {
    while (this.entries.length > this.cap) {
      const idx = this.entries.findIndex((e) => e.source === "server" && e.level === "info");
      this.entries.splice(idx >= 0 ? idx : 0, 1);
    }
  }
}

// ---------------------------------------------------------------- query (GET /api/logs)

const LEVELS: readonly LogLevel[] = ["info", "warn", "error"];
const SOURCES: readonly LogSource[] = ["server", "action", "feed"];
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const Q_MAX = 200;
export const LIMIT_DEFAULT = 500;
export const LIMIT_MAX = 2000;

export interface LogQuery {
  since: number;
  level: LogLevel | null;
  source: readonly LogSource[] | null;
  scope: string | null;
  q: string | null;
  limit: number;
}

export type LogQueryResult = { ok: true; query: LogQuery } | { ok: false; error: string };

function isLogLevel(v: string): v is LogLevel {
  return (LEVELS as readonly string[]).includes(v);
}
function isLogSource(v: string): v is LogSource {
  return (SOURCES as readonly string[]).includes(v);
}

/** Parses GET /api/logs's query params. Every failure names the param and why — the 400 is
 *  never a silent default. */
export function parseLogsQuery(params: URLSearchParams): LogQueryResult {
  const sinceRaw = params.get("since");
  let since = 0;
  if (sinceRaw !== null) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: `since must be a non-negative integer, got "${sinceRaw}"` };
    since = n;
  }
  const levelRaw = params.get("level");
  let level: LogLevel | null = null;
  if (levelRaw !== null) {
    if (!isLogLevel(levelRaw)) return { ok: false, error: `level must be one of info, warn, error, got "${levelRaw}"` };
    level = levelRaw;
  }
  const sourceRaw = params.get("source");
  let source: LogSource[] | null = null;
  if (sourceRaw !== null) {
    const parts = sourceRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return { ok: false, error: `source must be a comma list of server, action, feed, got "${sourceRaw}"` };
    for (const p of parts) if (!isLogSource(p)) return { ok: false, error: `source must be a comma list of server, action, feed, got "${p}"` };
    source = parts.filter(isLogSource);
  }
  const scope = params.get("scope");
  const qRaw = params.get("q");
  const q = qRaw !== null ? qRaw.slice(0, Q_MAX) : null;
  const limitRaw = params.get("limit");
  let limit = LIMIT_DEFAULT;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) return { ok: false, error: `limit must be an integer between 1 and ${LIMIT_MAX}, got "${limitRaw}"` };
    limit = n;
  }
  return { ok: true, query: { since, level, source, scope, q, limit } };
}

function matches(e: LogEntry, q: LogQuery): boolean {
  if (e.seq <= q.since) return false;
  if (q.level && LEVEL_RANK[e.level] < LEVEL_RANK[q.level]) return false;
  if (q.source && !q.source.includes(e.source)) return false;
  if (q.scope !== null && e.scope !== q.scope) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const hay = `${e.message} ${e.scope} ${e.detail ?? ""} ${e.action?.route ?? ""} ${e.action?.reason ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** The newest `query.limit` matches with seq > since, returned oldest first. */
export function queryEntries(entries: readonly LogEntry[], query: LogQuery): LogEntry[] {
  const hits = entries.filter((e) => matches(e, query));
  return hits.slice(-query.limit);
}

// ---------------------------------------------------------------- NDJSON

export function serializeNdjson(entries: readonly LogEntry[]): string {
  return entries.length ? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n` : "";
}

/** Parses NDJSON, skipping corrupt or malformed lines. A coalesced entry gets appended again at
 *  every persist tick its repeat count changes, so the same seq can appear on several lines —
 *  keeps only the last one (the final repeat count and ts), not one row per bump. */
export function parseNdjson(text: string): LogEntry[] {
  const bySeq = new Map<number, LogEntry>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (isLogEntry(obj)) bySeq.set(obj.seq, obj);
    } catch {
      // corrupt line: skip
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
