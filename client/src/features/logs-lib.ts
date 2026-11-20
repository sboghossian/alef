// Pure logic for the Logs tab: merge/dedupe by seq, filtering, relative time, the copy-line
// format and the payload validators. DOM-free — client/src/features/logs.ts does the rendering.

import type { ActionLogFields, LogEntry, LogLevel, LogSource } from "../../../shared/features/logs";
import { isLogEntry, isLogsMessage, isLogsResponse } from "../../../shared/features/logs";

export { isActionLogFields, isLogEntry, isLogsMessage, isLogsResponse } from "../../../shared/features/logs";
export type { ActionLogFields, LogEntry, LogLevel, LogSource, LogsMessage, LogsResponse } from "../../../shared/features/logs";

// ---------------------------------------------------------------- merge / dedupe

/** Merges two entry lists by seq (the incoming copy wins — a coalesced repeat update replaces
 *  the old copy of the same seq), returned sorted ascending by seq. */
export function mergeBySeq(existing: readonly LogEntry[], incoming: readonly LogEntry[]): LogEntry[] {
  const bySeq = new Map<number, LogEntry>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function cursorOf(entries: readonly LogEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.seq), 0);
}

/** Only well-formed entries the client hasn't already validated pass through — a malformed
 *  push (or a stale/incompatible server) never corrupts the merged list. */
export function keepValidEntries(candidates: readonly unknown[]): LogEntry[] {
  return candidates.filter(isLogEntry);
}

// ---------------------------------------------------------------- filters

export type LevelFilter = "all" | "warn-error" | "error";
export type SourceFilter = "all" | LogSource;

export interface LogFilterState {
  level: LevelFilter;
  source: SourceFilter;
  /** null = every scope. */
  scope: string | null;
  actionsOnly: boolean;
  failuresOnly: boolean;
  query: string;
}

export function defaultFilterState(): LogFilterState {
  return { level: "all", source: "all", scope: null, actionsOnly: false, failuresOnly: false, query: "" };
}

/** An action that failed, or any warn/error line (server or feed). */
export function isFailure(e: LogEntry): boolean {
  return e.level !== "info" || (e.action !== null && !e.action.ok);
}

const QUERY_MAX = 200;

export function matchesFilters(e: LogEntry, f: LogFilterState): boolean {
  if (f.level === "error" && e.level !== "error") return false;
  if (f.level === "warn-error" && e.level === "info") return false;
  if (f.source !== "all" && e.source !== f.source) return false;
  if (f.scope !== null && e.scope !== f.scope) return false;
  if (f.actionsOnly && e.source !== "action") return false;
  if (f.failuresOnly && !isFailure(e)) return false;
  const q = f.query.trim().toLowerCase().slice(0, QUERY_MAX);
  if (q) {
    const hay = `${e.message} ${e.scope} ${e.detail ?? ""} ${e.action?.route ?? ""} ${e.action?.reason ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterEntries(entries: readonly LogEntry[], f: LogFilterState): LogEntry[] {
  return entries.filter((e) => matchesFilters(e, f));
}

/** Newest first (the pane's display order). */
export function sortNewestFirst(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}

/** Distinct scopes seen so far, A–Z — feeds the scope filter's options. */
export function scopesSeen(entries: readonly LogEntry[]): string[] {
  return [...new Set(entries.map((e) => e.scope))].sort((a, b) => a.localeCompare(b));
}

export const RENDER_CAP = 400;

export function visibleRows(sortedNewestFirst: readonly LogEntry[], limit: number = RENDER_CAP): { rows: LogEntry[]; remaining: number } {
  return { rows: sortedNewestFirst.slice(0, limit), remaining: Math.max(0, sortedNewestFirst.length - limit) };
}

// ---------------------------------------------------------------- relative time

/** "just now", "12s", "4m", "2h", "3d" — bucketed, no "ago". Invalid input reads "?". */
export function relativeLabel(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "?";
  const diffS = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (diffS < 5) return "just now";
  if (diffS < 60) return `${diffS}s`;
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---------------------------------------------------------------- copy

/** One plain-text line: "ISO LEVEL [scope] message detail". */
export function copyLine(e: LogEntry): string {
  const parts = [e.ts, e.level.toUpperCase(), `[${e.scope}]`, e.message];
  if (e.detail) parts.push(e.detail);
  return parts.join(" ");
}

export function copyLines(entries: readonly LogEntry[]): string {
  return entries.map(copyLine).join("\n");
}

// ---------------------------------------------------------------- rendering helpers

/** "GET /api/logs → 200 in 42ms" / "…: reason" when it failed. */
export function actionSummary(a: ActionLogFields): string {
  const base = `${a.method} ${a.route} → ${a.status === 0 ? "no answer" : a.status} in ${a.durationMs}ms`;
  return a.ok || !a.reason ? base : `${base}: ${a.reason}`;
}

// ---------------------------------------------------------------- boot tracking

/** A response/push from a different bootId means the server restarted: the local log (and its
 *  seq numbering) is stale and must be replaced, not merged. */
export function bootChanged(storedBootId: string | null, incomingBootId: string): boolean {
  return storedBootId !== null && storedBootId !== incomingBootId;
}

export interface LogsSyncSnapshot {
  bootId: string;
  cursor: number;
  entries: readonly LogEntry[];
}

/** Tracks entries/bootId/cursor across WS pushes and reloads. DOM-free — logs.ts wires this to
 *  the network and the pane.
 *
 *  Fixes the restart race: a push whose bootId no longer matches the loaded one is buffered by
 *  `bufferForReload`, never merged into the stale boot's `entries`, and `bootId` itself is left
 *  untouched until a reload snapshot actually lands (`applyReload`). That matters because a
 *  concurrent `reloadSince` also reads `bootId` to decide whether IT needs to reload — if a push
 *  had already advanced it, `reloadSince` would think the reload already happened and merge its
 *  own delta onto a dead boot's cursor instead of reloading. `applyReload` then merges anything
 *  buffered while its GET was in flight onto the fetched snapshot, so a push that raced the
 *  request (the reported case: two new-boot entries arriving in the same millisecond as the
 *  reload's own GET) is never dropped — the fetched snapshot wins any seq it also covers. */
export class LogsSync {
  entries: LogEntry[] = [];
  bootId: string | null = null;
  cursor = 0;
  private pendingReload: LogEntry[] = [];

  /** A WS push or a reloadSince delta for the boot currently loaded. */
  adopt(incoming: readonly LogEntry[]): void {
    if (incoming.length === 0) return;
    this.entries = mergeBySeq(this.entries, incoming);
    this.cursor = Math.max(this.cursor, cursorOf(incoming));
  }

  /** Stashes a push for a boot that hasn't loaded yet. Never touches `bootId`/`entries`. */
  bufferForReload(incoming: readonly LogEntry[]): void {
    this.pendingReload = mergeBySeq(this.pendingReload, incoming);
  }

  /** A full reload's response (GET /api/logs). */
  applyReload(snapshot: LogsSyncSnapshot): void {
    this.entries = mergeBySeq(this.pendingReload, snapshot.entries);
    this.bootId = snapshot.bootId;
    this.cursor = Math.max(snapshot.cursor, cursorOf(this.entries));
    this.pendingReload = [];
  }
}

// ---------------------------------------------------------------- click routing

export type LogsClickAction = "retry" | "copy-all" | "copy-row" | null;

/** Which action a click on the pane resolves to, from the clicked button's class list. The pane
 *  binds ONE delegated listener for this (rows, and the Retry button in the error state, are all
 *  created after mount by render() — binding a listener to them at mount time, before they
 *  exist, would never fire). */
export function classifyLogsClick(classList: { contains(cls: string): boolean }): LogsClickAction {
  if (classList.contains("lg-retry")) return "retry";
  if (classList.contains("lg-copy-all")) return "copy-all";
  if (classList.contains("lg-copy-row")) return "copy-row";
  return null;
}
