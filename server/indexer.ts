// Incremental scanner over ~/.claude/projects/*/*.jsonl. Never loads a whole
// file into memory: each file is streamed from its last stored byte offset,
// complete lines are parsed and folded into the sessions/objects/edges
// tables, and only the offset past the last COMPLETE line is persisted (a
// truncated trailing line is retried on the next pass once more bytes land).
//
// Session jsonl content is untrusted data written by past sessions — it is
// only ever read for the fields listed below, never executed or followed as
// instructions.

import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AgentActivity } from "../shared/types.js";
import { deriveActivity, type ActivityDraft } from "./activity.js";
import { foldCcTitles, type CcTitles } from "./cc-titles-lib.js";
import type { WorldDb } from "./db.js";
import { localDateKey, type LastLineState } from "./heuristics.js";
import { defaultCanonicalResolver, islandForNewCwd } from "./canonical-repo.js";
import { defaultGitRootResolver, isCatchAllCwd, placeByTouchedFiles } from "./home-placement.js";
import { indexSubagentEvidence } from "./placement-evidence.js";
import { foldEvidence, newEvidenceFold, type EvidenceFold } from "./placement-evidence-lib.js";
import {
  filePathFromToolUse,
  mcpServerFromToolUse,
  parseLine,
  skillFromToolUse,
  toolCategory,
  type ParsedLine,
} from "./jsonl-events.js";
import { findGitRoot } from "./repo-root.js";
import { log } from "./log.js";

export interface IndexerOptions {
  projectsDir: string;
  /** Derive AgentActivity records from newly-read lines. Default false — the initial
   *  cold pass over ~/.claude/projects must never flood the activity feed with history. */
  collectActivity?: boolean;
  /** Keep the raw text of every newly-read complete line, per session (for feature onIndexPass hooks). Default false. */
  collectLines?: boolean;
  /** Home directory used to detect a catch-all cwd (home-run session) for touched-file-based
   *  re-placement — see home-placement.ts. Defaults to the real home directory. */
  homeDir?: string;
}

export interface IndexStats {
  filesScanned: number;
  filesSkippedUnchanged: number;
  linesProcessed: number;
  malformedLines: number;
  sessionsTouched: number;
  sessionsSkippedNoCwd: number;
  durationMs: number;
  /** New activity derived this pass, oldest first. Always [] unless collectActivity is set. */
  activities: AgentActivity[];
  /** session id → raw new lines, oldest first. Always empty unless collectLines is set. */
  linesBySession: Map<string, string[]>;
}

const NEWLINE = 0x0a;

/** Best-effort reverse of the `-Users-you-Documents-...` project-dir encoding. */
function decodeProjectDirToCwd(dirName: string): string | null {
  if (!dirName.startsWith("-")) return null;
  const candidate = dirName.replace(/-/g, "/");
  return existsSync(candidate) ? candidate : null;
}

async function listJsonlFiles(projectsDir: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    log.warn("indexer", `projects dir unreadable: ${projectsDir}`, String(err));
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    const full = join(projectsDir, dir);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) files.push(join(full, f));
    }
  }
  return files;
}

interface FileAggregate extends CcTitles {
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  lastActive: string | null;
  model: string | null;
  cntEdit: number;
  cntResearch: number;
  cntBash: number;
  cntTextOnly: number;
  cntAssistantTotal: number;
  messageCount: number;
  fileTargets: Array<{ path: string; at: string }>;
  skillTargets: Array<{ name: string; at: string }>;
  mcpTargets: Array<{ server: string; at: string }>;
  malformed: number;
  linesProcessed: number;
  tokensDelta: number;
  dayTokensDeltas: Map<string, number>;
  /** message.id of the last assistant turn whose usage was counted — seeded from the
   *  session's persisted value so dedup survives a pass boundary landing mid-turn.
   *  One logical turn is streamed across several lines that repeat the same id and
   *  the same (cumulative) usage block; without this, tokens get double/triple counted. */
  lastUsageMessageId: string | null;
  /** null until a user/assistant line updates it; "other" line types (system,
   *  queue-operation, ...) never touch it, so a pass with only those lines keeps
   *  whatever the session's last known state was. */
  lastLineState: LastLineState | null;
  activityDrafts: ActivityDraft[];
  rawLines: string[];
  /** PRs, pushes and still-unanswered ship commands (placement-evidence-lib.ts). */
  evidence: EvidenceFold;
}

function newAggregate(seedLastUsageMessageId: string | null, seedPendingShip: Iterable<string>): FileAggregate {
  return {
    cwd: null,
    title: null,
    customTitle: null,
    aiTitle: null,
    startedAt: null,
    lastActive: null,
    model: null,
    cntEdit: 0,
    cntResearch: 0,
    cntBash: 0,
    cntTextOnly: 0,
    cntAssistantTotal: 0,
    messageCount: 0,
    fileTargets: [],
    skillTargets: [],
    mcpTargets: [],
    lastUsageMessageId: seedLastUsageMessageId,
    malformed: 0,
    linesProcessed: 0,
    tokensDelta: 0,
    dayTokensDeltas: new Map(),
    lastLineState: null,
    activityDrafts: [],
    rawLines: [],
    evidence: newEvidenceFold(seedPendingShip),
  };
}

function foldLine(agg: FileAggregate, line: ParsedLine, fallbackAt: string, cwdForResolve: string | null): void {
  if (line.cwd && !agg.cwd) agg.cwd = line.cwd;
  foldCcTitles(agg, line);
  const at = line.timestamp ?? fallbackAt;
  foldEvidence(agg.evidence, line, at, { agentEdits: false, cwd: cwdForResolve });
  if (line.timestamp) {
    if (!agg.startedAt) agg.startedAt = line.timestamp;
    agg.lastActive = line.timestamp; // lines are append-only chronological
  }

  if (line.isUserLine) {
    agg.messageCount += 1;
    if (line.isUserText && line.userText && !agg.title) {
      agg.title = line.userText.slice(0, 600); // raw; sanitizeTitle() trims to 80 at read time
    }
    agg.lastLineState = { kind: "user", toolName: null, textIsQuestion: false };
    return;
  }

  if (line.isAssistant) {
    agg.messageCount += 1;
    agg.cntAssistantTotal += 1;
    if (line.model) agg.model = line.model;
    if (line.toolUses.length === 0) agg.cntTextOnly += 1;
    for (const use of line.toolUses) {
      const cat = toolCategory(use.name);
      if (cat === "edit") agg.cntEdit += 1;
      else if (cat === "research") agg.cntResearch += 1;
      else if (cat === "bash") agg.cntBash += 1;

      const filePath = filePathFromToolUse(use);
      if (filePath) {
        const abs = isAbsolute(filePath) ? filePath : cwdForResolve ? resolve(cwdForResolve, filePath) : filePath;
        agg.fileTargets.push({ path: abs, at });
      }
      const skill = skillFromToolUse(use);
      if (skill) agg.skillTargets.push({ name: skill, at });
      const mcp = mcpServerFromToolUse(use);
      if (mcp) agg.mcpTargets.push({ server: mcp, at });
    }

    // One logical turn streams across several lines (thinking, then tool_use, ...)
    // that all repeat the same message.id and the same cumulative usage block — count
    // it only the first time this id is seen. A line with no id can't be deduped, so
    // it's counted as-is (rare in practice: every real assistant line carries an id).
    const isDuplicateTurn = line.messageId !== null && line.messageId === agg.lastUsageMessageId;
    if (line.usage && !isDuplicateTurn) {
      const total = line.usage.inputTokens + line.usage.outputTokens + line.usage.cacheCreationInputTokens;
      agg.tokensDelta += total;
      const dateKey = localDateKey(new Date(at));
      agg.dayTokensDeltas.set(dateKey, (agg.dayTokensDeltas.get(dateKey) ?? 0) + total);
    }
    if (line.messageId !== null) agg.lastUsageMessageId = line.messageId;

    if (line.toolUses.length > 0) {
      const lastTool = line.toolUses[line.toolUses.length - 1]!;
      agg.lastLineState = { kind: "assistant_tool", toolName: lastTool.name, textIsQuestion: false };
    } else {
      const text = line.assistantText?.trim() ?? "";
      agg.lastLineState = { kind: "assistant_text", toolName: null, textIsQuestion: text.endsWith("?") };
    }
  }
}

/** Streams `filePath` from `startOffset`, folding complete lines into an aggregate. Returns the new offset. */
async function streamFile(
  filePath: string,
  startOffset: number,
  fallbackAt: string,
  cwdHint: string | null,
  collectActivity: boolean,
  seedLastUsageMessageId: string | null,
  collectLines: boolean,
  seedPendingShip: Iterable<string>,
): Promise<{ agg: FileAggregate; newOffset: number }> {
  const agg = newAggregate(seedLastUsageMessageId, seedPendingShip);
  let buffer = Buffer.alloc(0);
  let base = startOffset;
  let cwdSoFar = cwdHint;

  const stream = createReadStream(filePath, { start: startOffset });
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk as Buffer)]);
    let start = 0;
    while (true) {
      const nl = buffer.indexOf(NEWLINE, start);
      if (nl === -1) break;
      const lineStr = buffer.toString("utf8", start, nl);
      const parsed = parseLine(lineStr);
      agg.linesProcessed += 1;
      if (collectLines) agg.rawLines.push(lineStr);
      if (parsed === null) {
        agg.malformed += 1;
      } else {
        const cwdForResolve = cwdSoFar ?? agg.cwd;
        foldLine(agg, parsed, fallbackAt, cwdForResolve);
        if (agg.cwd && !cwdSoFar) cwdSoFar = agg.cwd;
        if (collectActivity && cwdForResolve) {
          const at = parsed.timestamp ?? fallbackAt;
          agg.activityDrafts.push(...deriveActivity(parsed, cwdForResolve, at));
        }
      }
      start = nl + 1;
    }
    base += start;
    buffer = buffer.subarray(start);
  }

  return { agg, newOffset: base };
}

export async function runIndexPass(db: WorldDb, opts: IndexerOptions): Promise<IndexStats> {
  const startedAt = Date.now();
  const stats: IndexStats = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    linesProcessed: 0,
    malformedLines: 0,
    sessionsTouched: 0,
    sessionsSkippedNoCwd: 0,
    durationMs: 0,
    activities: [],
    linesBySession: new Map(),
  };
  const collectActivity = opts.collectActivity ?? false;
  const collectLines = opts.collectLines ?? false;
  const homeDir = opts.homeDir ?? homedir();

  const files = await listJsonlFiles(opts.projectsDir);

  for (const filePath of files) {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue; // deleted mid-scan
    }
    const existingOffset = db.getFileOffset(filePath);
    if (existingOffset && existingOffset.size === st.size && existingOffset.mtime === st.mtimeMs) {
      stats.filesSkippedUnchanged += 1;
      continue;
    }
    stats.filesScanned += 1;

    const sessionId = basename(filePath, ".jsonl");
    const existingSession = db.getSession(sessionId);
    // Defensive: if the stored offset is now past the file's size (rotated/truncated), restart from 0.
    const startOffset = existingOffset && existingOffset.byteOffset <= st.size ? existingOffset.byteOffset : 0;
    const fallbackAt = st.mtime.toISOString();

    const { agg, newOffset } = await streamFile(
      filePath,
      startOffset,
      fallbackAt,
      existingSession?.cwd ?? null,
      collectActivity,
      existingSession?.lastUsageMessageId ?? null,
      collectLines,
      existingSession ? db.pendingShipUses(sessionId) : [],
    );
    stats.linesProcessed += agg.linesProcessed;
    stats.malformedLines += agg.malformed;
    if (agg.rawLines.length > 0) stats.linesBySession.set(sessionId, agg.rawLines);

    if (agg.linesProcessed > 0) {
      const projectDir = basename(join(filePath, ".."));
      const cwd = agg.cwd ?? existingSession?.cwd ?? decodeProjectDirToCwd(projectDir);

      if (!cwd) {
        stats.sessionsSkippedNoCwd += 1;
        log.warn("indexer", `no cwd resolvable for session ${sessionId}, skipping content (offsets still saved)`);
      } else {
        // A worktree or subfolder of a repo lands on that repo's island (canonical-repo.ts). Only a
        // NEW session gets an island from its cwd: a later pass's cwd is wherever the shell `cd`'d
        // to (upsertSession never moves a session), and minting an island for it is how 72 folders
        // that no session ever ran in became districts holding that pass's files (2026-10-14).
        const islandId = existingSession ? existingSession.islandId : islandForNewCwd(db, cwd, defaultCanonicalResolver(homeDir));

        const lastLineState =
          agg.lastLineState ??
          (existingSession
            ? {
                kind: existingSession.lastLineKind,
                toolName: existingSession.lastToolName,
                textIsQuestion: existingSession.lastTextIsQuestion,
              }
            : { kind: "user" as const, toolName: null, textIsQuestion: false });

        db.upsertSession({
          id: sessionId,
          cwd,
          islandId,
          title: agg.title ?? undefined,
          // Only set when this pass read a title record, so a rename made after the session was
          // first indexed lands on the next incremental pass (bytes past the stored offset).
          customTitle: agg.customTitle ?? undefined,
          aiTitle: agg.aiTitle ?? undefined,
          startedAt: agg.startedAt ?? fallbackAt,
          lastActive: agg.lastActive ?? fallbackAt,
          jsonlMtime: st.mtimeMs,
          messageCountDelta: agg.messageCount,
          model: agg.model,
          cntEditDelta: agg.cntEdit,
          cntResearchDelta: agg.cntResearch,
          cntBashDelta: agg.cntBash,
          cntTextOnlyDelta: agg.cntTextOnly,
          cntAssistantTotalDelta: agg.cntAssistantTotal,
          tokensDelta: agg.tokensDelta,
          lastLineKind: lastLineState.kind,
          lastToolName: lastLineState.toolName,
          lastTextIsQuestion: lastLineState.textIsQuestion,
          lastUsageMessageId: agg.lastUsageMessageId,
        });
        stats.sessionsTouched += 1;

        for (const [dateKey, delta] of agg.dayTokensDeltas) db.bumpDayTokens(dateKey, delta);

        for (const draft of agg.activityDrafts) {
          stats.activities.push({
            id: randomUUID(),
            agentId: sessionId,
            at: draft.at,
            stage: draft.stage,
            toolName: draft.toolName,
            targetObjectId: draft.targetObjectId,
            summary: draft.summary,
          });
        }

        const at = agg.lastActive ?? fallbackAt;

        let repoRoot = db.getGitRoot(cwd);
        if (repoRoot === undefined) {
          repoRoot = findGitRoot(cwd);
          db.setGitRoot(cwd, repoRoot);
        }
        if (repoRoot) {
          const repoObjId = `repo:${repoRoot}`;
          db.upsertObjectShell({ id: repoObjId, kind: "repo", name: basename(repoRoot), islandId });
          db.upsertEdge({ from: sessionId, to: repoObjId, kind: "touched", at });
        }

        for (const target of agg.fileTargets) {
          const fileObjId = `file:${target.path}`;
          db.upsertObjectShell({ id: fileObjId, kind: "file", name: basename(target.path), islandId });
          db.upsertEdge({ from: sessionId, to: fileObjId, kind: "touched", at: target.at });
        }
        // A catch-all (home dir or "/") session: record where its work shipped (its PRs and
        // pushes, and what its subagents edited). When that or its touched files grew, recompute —
        // from everything it has ever gained, not just this pass's — where it belongs, and re-home it.
        // Decided on the session's own (first) cwd: a later pass's first line may carry the shell's
        // cwd after a `cd` (a worktree, say), which says nothing about where the session started.
        const sessionCwd = existingSession?.cwd ?? cwd;
        if (isCatchAllCwd(sessionCwd, homeDir)) {
          let newEvidence = db.addPlacementEvidence(sessionId, agg.evidence.rows);
          db.syncPendingShipUses(sessionId, agg.evidence.pending, agg.evidence.resolved, at);
          newEvidence += await indexSubagentEvidence(db, filePath, sessionId, sessionCwd);
          if (agg.fileTargets.length > 0 || newEvidence > 0) {
            await placeByTouchedFiles(db, sessionId, homeDir, defaultGitRootResolver, defaultCanonicalResolver(homeDir));
          }
        }
        for (const target of agg.skillTargets) {
          const skillObjId = `skill:${target.name}`;
          db.upsertObjectShell({ id: skillObjId, kind: "skill", name: target.name, islandId: "harness" });
          db.upsertEdge({ from: sessionId, to: skillObjId, kind: "uses", at: target.at });
        }
        for (const target of agg.mcpTargets) {
          const mcpObjId = `mcp:${target.server}`;
          db.upsertObjectShell({ id: mcpObjId, kind: "mcp", name: target.server, islandId: "harness" });
          db.upsertEdge({ from: sessionId, to: mcpObjId, kind: "uses", at: target.at });
        }
      }
    }

    db.setFileOffset({
      path: filePath,
      size: st.size,
      mtime: st.mtimeMs,
      byteOffset: newOffset,
      malformedCount: (existingOffset?.malformedCount ?? 0) + agg.malformed,
    });
  }

  stats.activities.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  stats.durationMs = Date.now() - startedAt;
  return stats;
}
