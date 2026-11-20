// Wire types for the "logs" feature: the whole town's log, read-only, in the right sidebar's
// Logs tab. It carries every server log line, every UI action request with its outcome, and
// feed events (minus "activity" — the Feed tab already shows that, one per tool call).
//
//   GET /api/logs?since=&level=&source=&scope=&q=&limit=   → LogsResponse (the newest `limit`
//                                                              matches with seq > since, oldest first)
//   WS  { type:"feature", feature:"logs", payload: LogsMessage }   pushes new/updated entries, batched
//
// seq is monotonic per server boot; when bootId changes (a restart), drop the local log and refetch.
//
// job 2 (action-feedback) emits action lines as
//   log.info|warn|error("action", "<METHOD> <route> → <status> in <ms>ms[: <reason>]", fields)
// with exactly the ActionLogFields shape below, WITHOUT importing this file — it only has to match
// the shape (info = ok, warn = 4xx or ok:false, error = 5xx or status 0). This feature's tap on
// server/log.ts turns scope === "action" && isActionLogFields(extra) into a LogEntry with
// source "action" (action = the fields, detail = null); anything else, including a malformed
// "action" line, stays a plain "server" entry.

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "server" | "action" | "feed";

export interface ActionLogFields {
  kind: "action";
  method: string;
  /** Pathname only, no query string, <=160 chars. */
  route: string;
  /** 0: the client went away before an answer. */
  status: number;
  /** status < 400 and the JSON body didn't say ok:false. */
  ok: boolean;
  /** body.error (<=300 chars), a guard rejection, or "client closed the connection". */
  reason: string | null;
  /** Integer. */
  durationMs: number;
}

export interface LogEntry {
  seq: number;
  ts: string;
  level: LogLevel;
  source: LogSource;
  scope: string;
  message: string;
  detail: string | null;
  action: ActionLogFields | null;
  repeat: number;
}

export interface LogsResponse {
  ok: true;
  bootId: string;
  cursor: number;
  entries: LogEntry[];
}

export interface LogsMessage {
  kind: "entries";
  bootId: string;
  entries: LogEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict runtime check: exactly the ActionLogFields shape. */
export function isActionLogFields(v: unknown): v is ActionLogFields {
  return (
    isRecord(v) &&
    v.kind === "action" &&
    typeof v.method === "string" &&
    typeof v.route === "string" &&
    typeof v.status === "number" &&
    typeof v.ok === "boolean" &&
    (v.reason === null || typeof v.reason === "string") &&
    typeof v.durationMs === "number"
  );
}

const LEVELS: readonly LogLevel[] = ["info", "warn", "error"];
const SOURCES: readonly LogSource[] = ["server", "action", "feed"];

/** Strict runtime check for one LogEntry — shared by the server's NDJSON reload and the
 *  client's GET/WS payload validation. */
export function isLogEntry(v: unknown): v is LogEntry {
  return (
    isRecord(v) &&
    typeof v.seq === "number" &&
    typeof v.ts === "string" &&
    typeof v.level === "string" &&
    (LEVELS as readonly string[]).includes(v.level) &&
    typeof v.source === "string" &&
    (SOURCES as readonly string[]).includes(v.source) &&
    typeof v.scope === "string" &&
    typeof v.message === "string" &&
    (v.detail === null || typeof v.detail === "string") &&
    (v.action === null || isActionLogFields(v.action)) &&
    typeof v.repeat === "number"
  );
}

export function isLogsResponse(v: unknown): v is LogsResponse {
  return isRecord(v) && v.ok === true && typeof v.bootId === "string" && typeof v.cursor === "number" && Array.isArray(v.entries) && v.entries.every(isLogEntry);
}

export function isLogsMessage(v: unknown): v is LogsMessage {
  return isRecord(v) && v.kind === "entries" && typeof v.bootId === "string" && Array.isArray(v.entries) && v.entries.every(isLogEntry);
}
