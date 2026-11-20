// Incremental read of every transcript (sessions and their subagents) for artifact events, with
// the artifacts feature's OWN cursor per file (artifacts-store.ts), never the indexer's offsets:
// the first full read (the backfill) and the live tail are the same loop, so they cannot double
// count. Async streaming in 1 MB chunks, a yield between files and a byte budget per pass keep the
// event loop free. A line is only decoded when its bytes contain an artifact link or an Artifact
// call; one over MAX_LINE_BYTES is skipped (a huge tool result never carries a publish).

import { stat } from "node:fs/promises";
import { applyEvents, foldLine, type ArtifactEvent, type PendingPublish } from "./artifacts-lib.js";
import type { ArtifactsStore } from "./artifacts-store.js";
import { yieldToLoop } from "./cache-lib.js";
import { listSessionFiles, listSubagentFiles, streamLines } from "./subagents/scan.js";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const LINK = Buffer.from("claude.ai/");
const CALL = Buffer.from('"Artifact"');

export interface ScanTarget {
  path: string;
  /** Events are credited to this session (a subagent's parent). */
  sessionId: string;
}

export async function listTargets(projectsDir: string): Promise<ScanTarget[]> {
  const [sessions, subagents] = await Promise.all([listSessionFiles(projectsDir), listSubagentFiles(projectsDir)]);
  return [...sessions, ...subagents.map((s) => ({ path: s.path, sessionId: s.parentSessionId }))];
}

export interface ScanResult {
  /** New events were folded in (or cursors moved): the store needs a commit. */
  dirty: boolean;
  /** Every target was read to its end in this pass. */
  complete: boolean;
  events: number;
  filesRead: number;
}

/** Reads each target from its cursor to its end, until `byteBudget` bytes have been read. */
export async function scanPass(store: ArtifactsStore, targets: readonly ScanTarget[], byteBudget: number): Promise<ScanResult> {
  let budget = byteBudget;
  let dirty = false;
  let complete = true;
  let events = 0;
  let filesRead = 0;
  const listed = new Set<string>();
  for (const t of targets) {
    listed.add(t.path);
    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      continue; // gone mid-pass
    }
    const cur = store.cursors.get(t.path) ?? { o: 0 };
    if (size < cur.o) {
      // Transcripts only grow; a shorter file was replaced. Never re-read it (that would count its
      // publishes again): start from its current end.
      store.cursors.set(t.path, { o: size });
      dirty = true;
      continue;
    }
    if (size === cur.o) continue;
    if (budget <= 0) {
      complete = false;
      continue;
    }
    const pending = new Map<string, PendingPublish>(Object.entries(cur.p ?? {}));
    const found: ArtifactEvent[] = [];
    let consumed: number;
    try {
      consumed = await streamLines(t.path, cur.o, (line) => {
        if (line.length > MAX_LINE_BYTES) return;
        if (!line.includes(LINK) && !line.includes(CALL)) return;
        for (const e of foldLine(line.toString("utf8"), t.sessionId, pending)) found.push(e);
      });
    } catch {
      complete = false; // transient read error: retried next pass from the same cursor
      continue;
    }
    filesRead += 1;
    await yieldToLoop();
    if (consumed === cur.o) continue; // only a partial last line (a live session mid-write): next pass
    applyEvents(store.state, found);
    events += found.length;
    budget -= consumed - cur.o;
    store.cursors.set(t.path, pending.size ? { o: consumed, p: Object.fromEntries(pending) } : { o: consumed });
    dirty = true;
  }
  // Forget a cursor only when its file is really gone (ENOENT), never because a listing missed it:
  // a forgotten cursor means a full re-read, which would count that file's publishes twice.
  for (const p of [...store.cursors.keys()]) {
    if (listed.has(p)) continue;
    try {
      await stat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        store.cursors.delete(p);
        dirty = true;
      }
    }
  }
  return { dirty, complete, events, filesRead };
}
