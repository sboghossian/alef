// One-time historical catch-up for the "skills" feature — same shape as
// server/features/usage-backfill.ts (round 8 H1), reused deliberately: the shared indexer's
// own startup pass (server/index.ts's `runIndexPass` before the tick timers start) never
// forwards lines to features, so onIndexPass only ever sees lines appended AFTER this
// feature's store was first opened. Without this, the Graveyard tab would show every
// installed skill as "never fired" on day one, which is wrong, not just incomplete.
//
// This walks every session jsonl (and, cheaply, every subagent transcript — subagents can
// invoke skills too) once, applying the same per-line detector as the live path, but only to
// lines strictly OLDER than `cutoffMs` (the moment this feature's store was first opened —
// see skills.ts). Everything from `cutoffMs` on is onIndexPass's job, so the two paths never
// double-count the same line; skills-store.ts's UNIQUE constraint on the event tuple is a
// second, independent safety net on top of that split.
//
// Runs off the request path (driven by onTick), one file's turn to yield at a time, and
// persists file-count progress as it goes so a concurrent snapshot request always sees a
// reasonably fresh "still reading history (N%)" figure, not just a stale one from the last
// completed pass. Transcript content is untrusted: read and pattern-matched only, never
// executed.
//
// NOTE: subagent transcripts aren't part of the shared indexer's live scan either (only
// server/features/subagents/ reads them, on its own schedule), so their skill activity is
// backfilled here but NOT picked up by the live onIndexPass path going forward — a known,
// narrow gap (subagents rarely invoke skills directly), not a bug.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { SkillEvent } from "../../shared/features/skills.js";
import { yieldToLoop } from "./cache-lib.js";
import { detectSkillEventsFromLine } from "./skills-detect.js";
import type { SkillsStore } from "./skills-store.js";
import { listSubagentFiles } from "./subagents/scan.js";

const META_DONE = "backfill_done";
const META_FILES_TOTAL = "backfill_files_total";
const META_FILES_DONE = "backfill_files_done";

async function sessionJsonlFiles(projectsDir: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const perDir = await Promise.all(
    projectDirs.map(async (dir) => {
      const full = join(projectsDir, dir);
      try {
        return (await readdir(full)).filter((f) => f.endsWith(".jsonl")).map((f) => join(full, f));
      } catch {
        return [];
      }
    }),
  );
  return perDir.flat();
}

export interface BackfillDeps {
  store: SkillsStore;
  projectsDir: string;
  cutoffMs: number;
}

/** Reads one transcript (a top-level session OR a subagent — same file shape either way)
 *  from its own stored byte offset up to (but never past) its first line at/after cutoffMs.
 *  `sessionId` is whichever id events should be tagged with (the session's own uuid, or the
 *  subagent's agentId). Returns true when this file needs no more backfilling — either it hit
 *  the cutoff, or it reached EOF entirely before the cutoff. */
async function backfillFile(deps: BackfillDeps, path: string, sessionId: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return true; // gone mid-scan: nothing left to do here
  }
  const startOffset = deps.store.getFileOffset(path);
  if (startOffset >= size) return true; // nothing new since the last pass

  const events: SkillEvent[] = [];
  let bytesRead = 0;
  let hitCutoff = false;

  const rl = createInterface({ input: createReadStream(path, { start: startOffset, encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    bytesRead += Buffer.byteLength(rawLine, "utf8") + 1; // +1: the newline readline stripped
    const { atMs, events: lineEvents } = detectSkillEventsFromLine(sessionId, rawLine);
    if (atMs === null) continue; // malformed, or no timestamp: can't place it in time, skip
    if (atMs >= deps.cutoffMs) {
      hitCutoff = true;
      break;
    }
    events.push(...lineEvents);
  }
  rl.close();

  const reachedEnd = startOffset + bytesRead >= size;
  deps.store.applyBackfillBatch({ path, fileOffset: startOffset + bytesRead, events });
  return hitCutoff || reachedEnd;
}

export interface BackfillPassResult {
  filesTotal: number;
  filesDone: number;
  allDone: boolean;
}

/** One pass over every file not yet fully backfilled. Safe to call repeatedly (e.g. every
 *  tick, guarded by the caller so only one runs at a time — see skills.ts's kickBackfill): a
 *  file already at its cutoff line is a one-line, no-op re-check, and the whole pass is
 *  skipped once every file has reported done. */
export async function runSkillsBackfillPass(deps: BackfillDeps): Promise<BackfillPassResult> {
  if (deps.store.getMeta(META_DONE) === "1") {
    const filesTotal = Number(deps.store.getMeta(META_FILES_TOTAL) ?? "0");
    return { filesTotal, filesDone: filesTotal, allDone: true };
  }

  const [sessionFiles, subagentRefs] = await Promise.all([sessionJsonlFiles(deps.projectsDir), listSubagentFiles(deps.projectsDir)]);
  const targets: Array<{ path: string; sessionId: string }> = [
    ...sessionFiles.map((path) => ({ path, sessionId: basename(path, ".jsonl") })),
    ...subagentRefs.map((r) => ({ path: r.path, sessionId: r.agentId })),
  ];
  deps.store.setMeta(META_FILES_TOTAL, String(targets.length));

  let filesDone = 0;
  for (const t of targets) {
    try {
      if (await backfillFile(deps, t.path, t.sessionId)) filesDone += 1;
    } catch {
      // transient read error: this file isn't done, retry next pass
    }
    deps.store.setMeta(META_FILES_DONE, String(filesDone)); // progressive, so a concurrent read is never far stale
    await yieldToLoop();
  }

  const allDone = filesDone === targets.length;
  if (allDone) deps.store.setMeta(META_DONE, "1");
  return { filesTotal: targets.length, filesDone, allDone };
}

export interface BackfillProgress {
  filesTotal: number;
  filesDone: number;
  percent: number; // 0-100, rounded; 100 once done (even for a projectsDir with 0 files)
  done: boolean;
}

/** Reads the current progress without running anything — safe to call on every request. */
export function backfillProgress(store: SkillsStore): BackfillProgress {
  const done = store.getMeta(META_DONE) === "1";
  const filesTotal = Number(store.getMeta(META_FILES_TOTAL) ?? "0");
  const filesDone = done ? filesTotal : Number(store.getMeta(META_FILES_DONE) ?? "0");
  const percent = filesTotal === 0 ? (done ? 100 : 0) : Math.min(100, Math.round((filesDone / filesTotal) * 100));
  return { filesTotal, filesDone, percent, done };
}
