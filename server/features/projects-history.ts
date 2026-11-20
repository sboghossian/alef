// Refresh history of the Projects feature: for each project, what changed between one scan and the
// next ("+12 commits", "stage building -> shipped", "+2 sessions"), the last CHANGES_KEPT of them,
// plus one aggregate line per scan (totals per stage, active this week). Kept in
// data/projects-history.json beside world.db (derived data: deleting the file only resets the
// baseline). The diffing is pure; the file IO is async, atomic (tmp + rename) and never throws
// into the scan.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CHANGES_KEPT, PROJECT_STAGES, REFRESHES_KEPT, type ProjectChange, type ProjectItem, type ProjectStage, type RefreshEntry } from "../../shared/features/projects.js";

export interface Facts {
  commits: number | null;
  sessions: number;
  stage: ProjectStage;
  branch: string | null;
}

export interface HistoryState {
  version: 1;
  /** ISO of the first scan this file saw: changes older than this are unknown, not absent. */
  since: string;
  refreshes: RefreshEntry[];
  projects: Record<string, { facts: Facts; changes: ProjectChange[] }>;
}

/** Two changes closer than this fold into one (a live session flickers the session count). */
const MERGE_WINDOW_MS = 30 * 60_000;
const WEEK_MS = 7 * 86_400_000;

export const factsOf = (p: ProjectItem): Facts => ({ commits: p.git?.commits ?? null, sessions: p.sessions, stage: p.stage, branch: p.git?.branch ?? null });

/** The change from `prev` to `next` at `at`; null when nothing differs. An unreadable commit count (null) on either side is "unknown", not a change. */
export function diffFacts(prev: Facts, next: Facts, at: string): ProjectChange | null {
  const c: ProjectChange = { at };
  if (prev.commits !== null && next.commits !== null && prev.commits !== next.commits) c.commits = next.commits - prev.commits;
  if (prev.sessions !== next.sessions) c.sessions = next.sessions - prev.sessions;
  if (prev.stage !== next.stage) c.stage = { from: prev.stage, to: next.stage };
  if (prev.branch !== next.branch && prev.branch !== null && next.branch !== null) c.branch = { from: prev.branch, to: next.branch };
  return Object.keys(c).length > 1 ? c : null;
}

function mergeChange(prev: ProjectChange, next: ProjectChange): ProjectChange {
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const out: ProjectChange = { at: next.at };
  const commits = sum(prev.commits, next.commits);
  const sessions = sum(prev.sessions, next.sessions);
  if (commits) out.commits = commits;
  if (sessions) out.sessions = sessions;
  const stage = prev.stage || next.stage ? { from: prev.stage?.from ?? (next.stage as { from: ProjectStage }).from, to: next.stage?.to ?? (prev.stage as { to: ProjectStage }).to } : undefined;
  if (stage && stage.from !== stage.to) out.stage = stage;
  const branch = prev.branch || next.branch ? { from: prev.branch?.from ?? (next.branch as { from: string | null }).from, to: next.branch?.to ?? (prev.branch as { to: string | null }).to } : undefined;
  if (branch && branch.from !== branch.to) out.branch = branch;
  return out;
}

export const emptyState = (at: string): HistoryState => ({ version: 1, since: at, refreshes: [], projects: {} });

/** Folds one scan into the state (returns a new one). A project seen for the first time only sets its baseline. */
export function applyScan(state: HistoryState, items: readonly ProjectItem[], atMs: number): HistoryState {
  const at = new Date(atMs).toISOString();
  const projects: HistoryState["projects"] = {};
  for (const p of items) {
    const facts = factsOf(p);
    const old = state.projects[p.id];
    let changes = old?.changes ?? [];
    const d = old ? diffFacts(old.facts, { ...facts, commits: facts.commits ?? old.facts.commits }, at) : null;
    if (d) {
      const head = changes[0];
      changes = head && atMs - Date.parse(head.at) < MERGE_WINDOW_MS ? [mergeChange(head, d), ...changes.slice(1)] : [d, ...changes];
      changes = changes.filter((c) => c.commits || c.sessions || c.stage || c.branch).slice(0, CHANGES_KEPT);
    }
    projects[p.id] = { facts: { ...facts, commits: facts.commits ?? old?.facts.commits ?? null }, changes };
  }
  const stageCounts = Object.fromEntries(PROJECT_STAGES.map((s) => [s, items.filter((p) => p.stage === s).length])) as Record<ProjectStage, number>;
  const activeThisWeek = items.filter((p) => p.git?.lastCommit && atMs - Date.parse(p.git.lastCommit) < WEEK_MS).length;
  const refreshes = [{ at, total: items.length, stageCounts, activeThisWeek }, ...state.refreshes].slice(0, REFRESHES_KEPT);
  return { version: 1, since: state.since, refreshes, projects };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads the file; anything missing or malformed gives a fresh baseline (never throws). */
export async function loadHistory(path: string | null, atMs: number): Promise<HistoryState> {
  const fresh = emptyState(new Date(atMs).toISOString());
  if (!path) return fresh;
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObj(raw) || raw.version !== 1 || typeof raw.since !== "string" || !Array.isArray(raw.refreshes) || !isObj(raw.projects)) return fresh;
    return raw as unknown as HistoryState;
  } catch {
    return fresh;
  }
}

let saveSeq = 0;

export async function saveHistory(path: string | null, state: HistoryState): Promise<boolean> {
  if (!path) return false;
  // A temp name per save: two overlapping saves (a scan per request at ttl 0) must not share one file.
  const tmp = `${path}.${process.pid}.${++saveSeq}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, path);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}
