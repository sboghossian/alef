// Incremental read of every transcript for the Shelf view, with the Shelf's OWN cursor per file
// (shelf-board-store.ts). The backfill and the live tail are the same loop, so they cannot double
// count. Async 1 MB chunks, a yield between files and a byte budget per pass keep the event loop
// free; a line is only parsed when its bytes could hold a link or a home path, and tool results are
// skipped before parsing (they are the bulk of a transcript and what tools printed, not choices).
// Paths found are lstat'ed later, a few per pass (checkPaths), never inside a guarded folder.

import { lstat, stat } from "node:fs/promises";
import { yieldToLoop } from "./cache-lib.js";
import { lineMentions } from "./shelf-board-lib.js";
import { applyMentions, type ShelfBoardStore } from "./shelf-board-store.js";
import { listSessionFiles, listSubagentFiles, streamLines } from "./subagents/scan.js";

export const MAX_LINE_BYTES = 2 * 1024 * 1024;
const HTTP = Buffer.from("http");
const TILDE = Buffer.from("~/");
const TOOL_RESULT = Buffer.from('"tool_result"');

export interface BoardTarget {
  path: string;
  sessionId: string;
  subagent: boolean;
}

export async function listBoardTargets(projectsDir: string): Promise<BoardTarget[]> {
  const [sessions, subagents] = await Promise.all([listSessionFiles(projectsDir), listSubagentFiles(projectsDir)]);
  return [...sessions.map((s) => ({ ...s, subagent: false })), ...subagents.map((s) => ({ path: s.path, sessionId: s.parentSessionId, subagent: true }))];
}

/** Worth parsing: a link, or a home path beyond the line's own `cwd` field. */
function worthParsing(line: Buffer, homeBuf: Buffer): boolean {
  if (line.length > MAX_LINE_BYTES || line.includes(TOOL_RESULT)) return false;
  if (line.includes(HTTP) || line.includes(TILDE)) return true;
  const first = line.indexOf(homeBuf);
  return first !== -1 && line.indexOf(homeBuf, first + 1) !== -1;
}

export interface BoardScanResult {
  dirty: boolean;
  complete: boolean;
  mentions: number;
}

export async function boardScanPass(store: ShelfBoardStore, targets: readonly BoardTarget[], byteBudget: number, home: string): Promise<BoardScanResult> {
  let budget = byteBudget;
  let dirty = false;
  let complete = true;
  let mentions = 0;
  const listed = new Set<string>();
  const homeBuf = Buffer.from(`${home}/`);
  for (const t of targets) {
    listed.add(t.path);
    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      continue;
    }
    const from = store.cursors.get(t.path) ?? 0;
    if (size < from) {
      store.cursors.set(t.path, size); // replaced, not grown: never re-read (it would count twice)
      dirty = true;
      continue;
    }
    if (size === from) continue;
    if (budget <= 0) {
      complete = false;
      continue;
    }
    let consumed: number;
    let n = 0;
    try {
      consumed = await streamLines(t.path, from, (line) => {
        if (!worthParsing(line, homeBuf)) return;
        const r = lineMentions(line.toString("utf8"), { subagent: t.subagent, home });
        if (!r) return;
        applyMentions(store.state, r.mentions, t.sessionId, r.at);
        n += r.mentions.length;
      });
    } catch {
      complete = false;
      continue;
    }
    await yieldToLoop();
    if (consumed === from) continue;
    mentions += n;
    budget -= consumed - from;
    store.cursors.set(t.path, consumed);
    dirty = true;
  }
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
  return { dirty, complete, mentions };
}

/** lstat's up to `limit` unchecked paths: a folder or file stays (typed), a missing one is removed.
 *  pathsIn already refused guarded folders, so nothing here can block on a consent prompt. */
export async function checkPaths(store: ShelfBoardStore, limit: number): Promise<boolean> {
  let changed = false;
  let left = limit;
  for (const it of Object.values(store.state.items)) {
    if (left <= 0) break;
    if (!it.path || it.onDisk !== null) continue;
    left -= 1;
    try {
      const st = await lstat(it.path);
      it.onDisk = true;
      it.type = st.isDirectory() ? "folder" : "file";
      it.kind = it.type;
    } catch {
      delete store.state.items[it.id];
    }
    changed = true;
  }
  return changed;
}
