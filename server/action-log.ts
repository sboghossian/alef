// One log line per user action. index.ts calls describeAction once every non-GET request has
// finished (or its client went away), so every click that reaches the server leaves a trace with
// its outcome, including the ones the request guard refuses. The town Logs tab picks these lines
// up by their shape: scope "action" and fields.kind === "action". Pure: no I/O.

import type { ResponseOutcome } from "./http.js";

export type ActionLevel = "info" | "warn" | "error";

export interface ActionLogFields {
  kind: "action";
  method: string;
  /** URL pathname, query stripped, at most ROUTE_MAX chars. */
  route: string;
  /** HTTP status; 0 when the client closed the connection before the response finished. */
  status: number;
  ok: boolean;
  /** The response's error (first line, at most REASON_MAX chars), or null. */
  reason: string | null;
  durationMs: number;
}

export interface ActionLogLine {
  level: ActionLevel;
  message: string;
  fields: ActionLogFields;
}

export const ROUTE_MAX = 160;
export const REASON_MAX = 300;
export const CLIENT_CLOSED = "client closed the connection";

/** GETs and HEADs are reads: the client polls several of them every few seconds, so they stay out. */
export function shouldLogRequest(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The pathname of a raw request URL: no query, no fragment, capped. */
export function routeOf(path: string): string {
  const cut = path.search(/[?#]/);
  return clip(cut === -1 ? path : path.slice(0, cut), ROUTE_MAX) || "/";
}

function firstLine(s: string | null | undefined): string | null {
  const line = (s ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line ? clip(line, REASON_MAX) : null;
}

export function describeAction(o: {
  method: string;
  /** The raw request URL (req.url); only its pathname is kept. */
  path: string;
  status: number;
  outcome: ResponseOutcome | undefined;
  durationMs: number;
}): ActionLogLine {
  const method = o.method.toUpperCase();
  const route = routeOf(o.path);
  const status = o.status;
  const ok = status > 0 && status < 400 && o.outcome?.ok !== false;
  const reason = status === 0 ? CLIENT_CLOSED : firstLine(o.outcome?.error);
  const durationMs = Math.max(0, Math.round(o.durationMs));
  const level: ActionLevel = status === 0 || status >= 500 ? "error" : ok ? "info" : "warn";
  return {
    level,
    message: `${method} ${route} → ${status} in ${durationMs}ms${reason ? `: ${reason}` : ""}`,
    fields: { kind: "action", method, route, status, ok, reason, durationMs },
  };
}
