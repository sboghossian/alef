// Pure helpers for the Tidy up UI (P2 cleanup): response validation, bucket copy, sizes,
// selection sums and the honest disk sentence. No DOM, so it is unit-tested.

import type {
  BucketId,
  CandidateBuckets,
  CandidatesResponse,
  CleanupSessionItem,
  RestoreResult,
  RetireItemResult,
  RetireResult,
  TrashListResponse,
  TrashManifest,
} from "../../../shared/features/cleanup";
import { RETIRE_MAX_IDS } from "../../../shared/features/cleanup";

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 days ago", "5 hours ago", "just now"; "" for an unreadable date. */
export function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return plural(Math.floor(s / 3600), "hour") + " ago";
  return plural(Math.floor(s / 86_400), "day") + " ago";
}

export interface BucketMeta {
  id: BucketId;
  emoji: string;
  /** Label after the count, e.g. "one-shot headless runs". */
  label(count: number, params: { tiny: number; dormantDays: number }): string;
  blurb: string;
  /** Session buckets retire; tmux closes; worktrees remove via Fork. */
  action: "retire" | "close" | "remove";
}

export const BUCKETS: readonly BucketMeta[] = [
  { id: "headless", emoji: "🤖", label: (n) => (n === 1 ? "one-shot headless run" : "one-shot headless runs"), blurb: "claude -p runs with ≤3 messages and no tools.", action: "retire" },
  { id: "empty", emoji: "🫙", label: (n) => (n === 1 ? "empty session" : "empty sessions"), blurb: "Opened, never used: no messages.", action: "retire" },
  { id: "tiny", emoji: "🐣", label: (n, p) => `${n === 1 ? "tiny session" : "tiny sessions"} (under ${p.tiny} messages)`, blurb: "Short sessions that never got going.", action: "retire" },
  { id: "dormant", emoji: "💤", label: (n, p) => `${n === 1 ? "dormant session" : "dormant sessions"} (idle over ${p.dormantDays} days)`, blurb: "Nobody has touched these in a long time.", action: "retire" },
  { id: "tmux", emoji: "🖥", label: (n) => (n === 1 ? "finished Alef tmux session" : "finished Alef tmux sessions"), blurb: "Claude exited; the tmux window is still open. Closing saves its scrollback as text.", action: "close" },
  { id: "worktree", emoji: "🌿", label: (n) => (n === 1 ? "stale worktree" : "stale worktrees"), blurb: "Fork worktrees nobody uses. Only clean ones can be removed; the branch stays.", action: "remove" },
];

export function isCandidatesResponse(v: unknown): v is CandidatesResponse {
  if (!isObj(v) || v.ok !== true || !isObj(v.params) || !isObj(v.buckets)) return false;
  const b = v.buckets;
  return ["empty", "headless", "tiny", "dormant", "tmux", "worktree"].every((k) => Array.isArray(b[k])) && isObj(b.totals) && typeof b.totals.bytes === "number";
}

export function isTrashList(v: unknown): v is TrashListResponse {
  return isObj(v) && v.ok === true && typeof v.root === "string" && Array.isArray(v.batches);
}

export function isRetireResult(v: unknown): v is RetireResult {
  if (!isObj(v) || typeof v.ok !== "boolean") return false;
  return v.ok ? typeof v.batchId === "string" && Array.isArray(v.results) : typeof v.error === "string";
}

export function isRestoreResult(v: unknown): v is RestoreResult {
  return isRetireResult(v);
}

export function sessionItems(b: CandidateBuckets, id: BucketId): CleanupSessionItem[] {
  return id === "empty" || id === "headless" || id === "tiny" || id === "dormant" ? b[id] : [];
}

export function bucketCount(b: CandidateBuckets, id: BucketId): { count: number; bytes: number; protectedCount: number } {
  const items: { protected?: string; bytes?: number }[] = b[id];
  let count = 0;
  let bytes = 0;
  let protectedCount = 0;
  for (const it of items) {
    if (it.protected) protectedCount += 1;
    else {
      count += 1;
      bytes += it.bytes ?? 0;
    }
  }
  return { count, bytes, protectedCount };
}

/** Selectable (unprotected) ids of a session bucket. */
export function selectableIds(items: readonly CleanupSessionItem[]): string[] {
  return items.filter((i) => !i.protected).map((i) => i.id);
}

/** Count + bytes of the selected ids that are still selectable. */
export function selectionSummary(items: readonly CleanupSessionItem[], selected: ReadonlySet<string>): { ids: string[]; bytes: number } {
  const ids: string[] = [];
  let bytes = 0;
  for (const i of items) {
    if (i.protected || !selected.has(i.id)) continue;
    ids.push(i.id);
    bytes += i.bytes;
  }
  return { ids, bytes };
}

/** The honest header: what could move out of ~/.claude/projects, and that nothing is deleted. */
export function diskSentence(totalBytes: number): string {
  if (totalBytes <= 0) return "Nothing to tidy right now. Alef never deletes: retired sessions move to ~/.alef-trash, and you can restore them in one click.";
  return `${formatBytes(totalBytes)} could leave ~/.claude/projects (Claude's /resume list and Alef's index get smaller). Alef never deletes: the files move to ~/.alef-trash, and the space comes back when you empty that folder yourself.`;
}

export function chunk<T>(xs: readonly T[], size = RETIRE_MAX_IDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function retireSummary(results: readonly RetireItemResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  const bytes = results.filter((r) => r.ok).reduce((s, r) => s + r.bytes, 0);
  if (ok === 0) return bad === 1 ? `Not retired: ${results[0]?.error ?? "refused"}` : `None retired (${bad} refused)`;
  return `Retired ${ok} · ${formatBytes(bytes)}${bad ? ` · ${bad} refused` : ""}`;
}

/** Items of a batch still in the trash (retired, or planned = partly moved). */
export function inTrash(m: TrashManifest): TrashManifest["items"] {
  return m.items.filter((i) => i.state === "retired" || i.state === "planned");
}

export function batchLabel(m: TrashManifest): string {
  const t = Date.parse(m.at);
  const when = Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : m.date;
  const items = inTrash(m);
  return `${when} · ${plural(items.length, "session")} · ${formatBytes(items.reduce((s, i) => s + i.bytes, 0))}`;
}
