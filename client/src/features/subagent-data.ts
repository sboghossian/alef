// Client-side store of subagent records, shared by the "subagents" feature (drones, child
// panel) and the "canvas" feature (Subagents lane, spawned edges, beads). Not a feature
// itself. Filled from snapshot extras, WS messages and GET /api/subagents.

import {
  parseSubagentList,
  parseSubagentStats,
  type RunEnding,
  type SubagentActivity,
  type SubagentRecord,
  type SubagentStats,
  type SubagentsResponse,
} from "../../../shared/features/subagents";
import type { ClientApi } from "./registry";

type Fn<A extends unknown[]> = (...args: A) => void;

export class SubagentData {
  readonly records = new Map<string, SubagentRecord>();
  /** Session id → how its transcript ended, for sessions that failed or were stopped (server
   *  endings.ts). Replaced as a whole on every snapshot / "runs" message. */
  runEndings = new Map<string, RunEnding>();
  stats: SubagentStats | null = null;
  /** True once the full list (not just the last 7 days) was fetched. */
  loadedAll = false;
  private readonly changeFns = new Set<Fn<[SubagentRecord[]]>>();
  private readonly activityFns = new Set<Fn<[SubagentActivity[]]>>();
  private readonly runsFns = new Set<Fn<[]>>();
  private runsSig = "";

  upsert(list: readonly SubagentRecord[]): void {
    if (list.length === 0) return;
    for (const r of list) this.records.set(r.id, r);
    for (const fn of this.changeFns) fn([...list]);
  }

  /** Replaces the run endings; notifies only when they changed. */
  setRunEndings(list: readonly RunEnding[]): void {
    const sig = JSON.stringify(list);
    if (sig === this.runsSig) return;
    this.runsSig = sig;
    this.runEndings = new Map(list.map((e) => [e.sessionId, e] as const));
    for (const fn of this.runsFns) fn();
  }

  onRunEndings(fn: Fn<[]>): void {
    this.runsFns.add(fn);
  }

  setStats(stats: SubagentStats | null): void {
    if (stats) this.stats = stats;
  }

  activity(items: SubagentActivity[]): void {
    if (items.length === 0) return;
    for (const fn of this.activityFns) fn(items);
  }

  byParent(sessionId: string): SubagentRecord[] {
    return [...this.records.values()]
      .filter((r) => r.parentSessionId === sessionId)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
  }

  onChange(fn: Fn<[SubagentRecord[]]>): void {
    this.changeFns.add(fn);
  }

  onActivity(fn: Fn<[SubagentActivity[]]>): void {
    this.activityFns.add(fn);
  }

  /** Everything the server has (for the canvas "all time" filter). */
  async loadAll(api: ClientApi): Promise<void> {
    const res = await api.getJson<SubagentsResponse>("/api/subagents", 15_000);
    if (!res) return;
    this.setStats(parseSubagentStats(res.stats));
    this.loadedAll = true;
    this.upsert(parseSubagentList(res.subagents));
  }

  /** One session's whole family (children and grandchildren, also those outside the 7-day
   *  snapshot window). Null when the request failed: what is loaded may then be partial. */
  async loadParent(api: ClientApi, sessionId: string): Promise<SubagentRecord[] | null> {
    const res = await api.getJson<SubagentsResponse>(`/api/subagents?parent=${encodeURIComponent(sessionId)}`, 10_000);
    if (!res) return null;
    this.upsert(parseSubagentList(res.subagents));
    return this.byParent(sessionId);
  }
}

export const subagentData = new SubagentData();

/** "claude-opus-5-5[1m]" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function shortModel(model: string | null): string {
  if (!model) return "unknown model";
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (!m?.[1] || !m[2]) return model;
  const fam = m[1][0]?.toUpperCase() + m[1].slice(1).toLowerCase();
  return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
