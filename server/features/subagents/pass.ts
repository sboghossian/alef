// One incremental pass over every subagent transcript (+ the parents' report lines), and
// the pure projection from folded state to wire records. Same byte-offset scheme as
// server/indexer.ts: unchanged files (size + mtime) are skipped, changed ones are read
// from their last complete-line offset.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { SubagentActivity, SubagentRecord, SubagentStats } from "../../../shared/features/subagents.js";
import { sanitizeTitle } from "../../heuristics.js";
import {
  FOLD_VERSION,
  computeParents,
  foldSubagentLine,
  interruptCause,
  newSubagentState,
  parentLineMayReport,
  parentReportsOnLine,
  parentStopOnLine,
  resolveOutcome,
  type FoldResult,
  type ParentReport,
  type ParentStop,
  type SubagentState,
} from "./fold.js";
import { listSubagentFiles, readMeta, streamLines } from "./scan.js";
import type { OffsetRow, SubagentStore } from "./store.js";

export { LIVE_WINDOW_MS } from "./fold.js";
/** Bump when parentReportsOnLine / parentStopOnLine learn something new, so every parent transcript
 *  is re-read once from byte 0 (1: every <task-id> of a notification, and its <summary>; 2: stops). */
export const PARENT_FOLD_VERSION = 2;
const PARENT_FOLD_KEY = "parentFoldVersion";
const TOP_FILES = 8;

export interface PassResult {
  filesSeen: number;
  filesRead: number;
  parentsRead: number;
  bytesRead: number;
  changed: string[]; // subagent ids whose state changed
  activities: SubagentActivity[];
  durationMs: number;
}

export async function runSubagentPass(store: SubagentStore, projectsDir: string, opts: { collectActivity: boolean }): Promise<PassResult> {
  const t0 = Date.now();
  const refs = await listSubagentFiles(projectsDir);
  const offsets = new Map<string, OffsetRow>();
  const changedStates: SubagentState[] = [];
  const spawns: Array<[string, string]> = [];
  const activities: SubagentActivity[] = [];
  let bytesRead = 0;
  let filesRead = 0;
  const parentsToCheck = new Map<string, string>(); // parentPath → parentSessionId

  for (const ref of refs) {
    let st;
    try {
      st = await stat(ref.path);
    } catch {
      continue; // deleted mid-scan
    }
    const prev = store.offset(ref.path);
    // A state folded under older rules (FOLD_VERSION) is re-read from byte 0, once.
    const stored = store.states.get(ref.agentId);
    const known = stored?.foldVersion === FOLD_VERSION ? stored : undefined;
    parentsToCheck.set(ref.parentPath, ref.parentSessionId);
    if (prev && known && prev.size === st.size && prev.mtime === st.mtimeMs) continue;

    const resume = prev && known && prev.offset <= st.size ? { offset: prev.offset, state: known } : null;
    const state: SubagentState = resume ? structuredClone(resume.state) : newSubagentState(ref.agentId, ref.parentSessionId, ref.workflowId);
    if (!state.meta) state.meta = await readMeta(ref.metaPath);
    state.mtimeMs = st.mtimeMs;
    const out: FoldResult = { spawnIds: [], activities: [] };
    const start = resume ? resume.offset : 0;
    const end = await streamLines(ref.path, start, (line) => foldSubagentLine(state, line, opts.collectActivity, out));
    bytesRead += end - start;
    filesRead += 1;
    offsets.set(ref.path, { size: st.size, mtime: st.mtimeMs, offset: end });
    changedStates.push(state);
    for (const id of out.spawnIds) spawns.push([id, state.id]);
    for (const a of out.activities) {
      activities.push({ id: randomUUID(), subagentId: state.id, parentSessionId: state.parentSessionId, ...a });
    }
  }

  // Parents: only their report and stop lines matter (Agent tool_results, task-notifications,
  // TaskStop results, user interrupts). Under a new
  // PARENT_FOLD_VERSION every parent is re-read from 0; the version is stored in the same commit
  // as the offsets, so a crash mid-pass re-reads them all again next time.
  const reports = new Map<string, ParentReport>();
  const stops: Array<[string, ParentStop]> = [];
  const reread = store.meta(PARENT_FOLD_KEY) !== String(PARENT_FOLD_VERSION);
  let parentsRead = 0;
  for (const [parentPath, parentSessionId] of parentsToCheck) {
    let st;
    try {
      st = await stat(parentPath);
    } catch {
      continue; // the parent transcript is gone; the directory still names it
    }
    const prev = reread ? undefined : store.offset(parentPath);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    const start = prev && prev.offset <= st.size ? prev.offset : 0;
    const end = await streamLines(parentPath, start, (line) => {
      if (!parentLineMayReport(line)) return;
      const stop = parentStopOnLine(line);
      if (stop) stops.push([parentSessionId, stop]);
      for (const r of parentReportsOnLine(line.toString("utf8"))) {
        const before = reports.get(r.agentId) ?? (reread ? undefined : store.reports.get(r.agentId));
        // Later lines win, but keep what an earlier line knew (model, description).
        reports.set(r.agentId, { ...r, model: r.model ?? before?.model ?? null, description: r.description ?? before?.description ?? null });
      }
    });
    bytesRead += end - start;
    parentsRead += 1;
    offsets.set(parentPath, { size: st.size, mtime: st.mtimeMs, offset: end });
  }

  store.commit({ offsets, states: changedStates, reports: reports.values(), spawns, stops, meta: reread ? [[PARENT_FOLD_KEY, String(PARENT_FOLD_VERSION)]] : [] });
  activities.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    filesSeen: refs.length,
    filesRead,
    parentsRead,
    bytesRead,
    changed: [...new Set([...changedStates.map((s) => s.id), ...reports.keys()])].filter((id) => store.states.has(id)),
    activities,
    durationMs: Date.now() - t0,
  };
}

function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Folded state → wire records, newest first. */
export function buildRecords(store: SubagentStore, nowMs: number): SubagentRecord[] {
  const parents = computeParents(store.states.values(), store.spawnOwner);
  const out: SubagentRecord[] = [];
  for (const s of store.states.values()) {
    const report = store.reports.get(s.id);
    // An interrupt is a stop only when the parent session's own stop explains it (fold.ts).
    const stoppedBy = s.lastKind === "interrupted" ? interruptCause(s.interruptedAt, store.stops.get(s.parentSessionId)) : null;
    const outcome = resolveOutcome(nowMs - s.mtimeMs, report, s.lastKind, s.lastError, stoppedBy);
    const rel = parents.get(s.id) ?? { parentAgentId: null, depth: 1 };
    const files = Object.entries(s.files)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, TOP_FILES)
      .map(([path, count]) => ({ path, count }));
    const lastActive = new Date(s.mtimeMs).toISOString();
    out.push({
      id: s.id,
      parentSessionId: s.parentSessionId,
      parentAgentId: rel.parentAgentId,
      workflowId: s.workflowId,
      description: sanitizeTitle(s.meta?.description ?? report?.description ?? s.firstPrompt ?? "subagent"),
      agentType: s.meta?.agentType ?? null,
      model: s.model ?? report?.model ?? s.meta?.model ?? null,
      status: outcome.status,
      reason: outcome.reason,
      startedAt: s.startedAt ?? lastActive,
      lastActive,
      tokens: s.tokens,
      toolCounts: { ...s.toolCounts },
      files,
      depth: rel.depth,
    });
  }
  out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id < b.id ? -1 : 1));
  return out;
}

export function statsFor(records: readonly SubagentRecord[], nowMs: number, coldPassMs: number | null): SubagentStats {
  const midnight = localMidnight(nowMs);
  return {
    total: records.length,
    today: records.filter((r) => Date.parse(r.lastActive) >= midnight).length,
    live: records.filter((r) => r.status === "running").length,
    parents: new Set(records.map((r) => r.parentSessionId)).size,
    deepest: records.reduce((m, r) => Math.max(m, r.depth), 0),
    coldPassMs,
  };
}
