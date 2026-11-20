// How every top-level session transcript on disk ended (shared/features/subagents.ts RunEnding),
// from deterministic markers only: fold.ts's lineKind on its last conversational line, then
// endingOutcome (an API error, an interrupt, or a turn cut off mid-way and silent past STALL_MS).
// No keyword reading of what the model said: "the ritual could not run" is not a marker. An
// interrupt is the user's in an interactive session (a human at the terminal); in a headless one
// (`claude -p`, the Agent SDK) nobody is there, so its cause is unknown and it counts as failed.
//
// Only the TAIL of a transcript is read, and only once it has gone quiet (no write for
// LIVE_WINDOW_MS) and changed since the last read: a transcript being written is running by
// definition. The cache lives in memory, so a boot costs one tail read per session (✅ 204 real
// transcripts, 843 MB: the tails are a few hundred KB each). Read-only.

import { open, stat } from "node:fs/promises";
import type { RunEnding } from "../../../shared/features/subagents.js";
import { LIVE_WINDOW_MS, USER_INTERRUPT, endingOutcome, lineKind, type LineKind } from "./fold.js";
import { listSessionFiles } from "./scan.js";

const FIRST_WINDOW = 256 * 1024;
/** A last line bigger than this (a giant tool result) leaves the ending unknown rather than read more. */
const MAX_WINDOW = 64 * 1024 * 1024;
const MAX_ENDINGS = 500;
const NEWLINE = 0x0a;
const ENTRYPOINT_NEEDLE = Buffer.from('"entrypoint":"');

export interface TailEnding {
  kind: LineKind | null;
  error: string | null;
  /** The ending line says `entrypoint: "sdk-cli"` (headless `claude -p` / Agent SDK). */
  headless: boolean;
}

/** `entrypoint` of one line: the last unescaped `"entrypoint":"…"` (a top-level key, written after
 *  the message; inside a JSON string the quotes would be escaped). */
function entrypointOf(line: Buffer): string | null {
  const at = line.lastIndexOf(ENTRYPOINT_NEEDLE);
  if (at === -1) return null;
  const from = at + ENTRYPOINT_NEEDLE.length;
  const end = line.indexOf(0x22, from);
  return end === -1 || end - from > 40 ? null : line.subarray(from, end).toString("utf8");
}

/** The kind of the last conversational line of `path` (first `size` bytes), read backwards in
 *  growing windows so a multi-MB last line is still read whole. A trailing partial line is ignored. */
export async function readTailEnding(path: string, size: number): Promise<TailEnding> {
  const fh = await open(path, "r");
  try {
    for (let window = FIRST_WINDOW; ; window *= 4) {
      const start = Math.max(0, size - window);
      const want = size - start;
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, start);
      const data = buf.subarray(0, bytesRead);
      let hi = data.lastIndexOf(NEWLINE); // ends the last complete line
      while (hi >= 0) {
        const prev = hi === 0 ? -1 : data.lastIndexOf(NEWLINE, hi - 1);
        if (prev === -1 && start > 0) break; // this line began before the window: read a bigger one
        const line = data.subarray(prev + 1, hi);
        const k = line.length > 0 ? lineKind(line) : null;
        if (k) return { kind: k.kind, error: k.error, headless: entrypointOf(line) === "sdk-cli" };
        hi = prev;
      }
      if (start === 0 || window >= MAX_WINDOW) return { kind: null, error: null, headless: false };
    }
  } finally {
    await fh.close();
  }
}

interface Cached {
  size: number;
  mtimeMs: number;
  ending: TailEnding;
}

/** Keeps each session's last tail read, keyed by path, and re-reads only what changed. */
export class RunEndings {
  private readonly cache = new Map<string, Cached>();

  /** Every session that did not end normally, newest first (≤ 500). */
  async refresh(projectsDir: string, nowMs: number): Promise<RunEnding[]> {
    const out: RunEnding[] = [];
    const seen = new Set<string>();
    for (const { path, sessionId } of await listSessionFiles(projectsDir)) {
      let st;
      try {
        st = await stat(path);
      } catch {
        continue; // deleted mid-scan
      }
      seen.add(path);
      const quietMs = nowMs - st.mtimeMs;
      if (quietMs <= LIVE_WINDOW_MS) continue;
      let c = this.cache.get(path);
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        try {
          c = { size: st.size, mtimeMs: st.mtimeMs, ending: await readTailEnding(path, st.size) };
        } catch {
          continue; // unreadable now; tried again next pass
        }
        this.cache.set(path, c);
      }
      if (c.ending.kind === null) continue; // nothing conversational (or a last line over MAX_WINDOW): unknown, not failed
      const o = endingOutcome(c.ending.kind, quietMs, c.ending.error, c.ending.headless ? null : USER_INTERRUPT);
      if ((o.status === "failed" || o.status === "stopped") && o.reason) {
        out.push({ sessionId, status: o.status, reason: o.reason, at: new Date(st.mtimeMs).toISOString(), headless: c.ending.headless });
      }
    }
    for (const p of this.cache.keys()) if (!seen.has(p)) this.cache.delete(p);
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.sessionId < b.sessionId ? -1 : 1));
    return out.slice(0, MAX_ENDINGS);
  }
}
