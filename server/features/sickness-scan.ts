// Transcript side of the "sickness" feature: finds every transcript (main sessions and their
// subagents), reads each one from a stored byte offset with a per-tick byte budget, and hands
// complete lines to sickness-lib.ts's scanLine. Read-only on transcripts; the only file it writes
// is its own offsets file (data/sickness-scan.json, through sickness.ts), so a restart continues
// where it stopped.
//
// Main-session lines normally arrive from the indexer (onIndexPass, the same raw lines the
// tripwires get). They are applied straight away only when they provably continue this scanner's
// own cursor: the indexer's stored offset minus the lines' byte length must equal it. Otherwise
// (the backfill hasn't reached that file yet, a tick is reading it, the indexer and the backfill
// overlap) they are left to the tick, which reads them from disk, so no line is applied twice or
// missed. Subagent transcripts are read by the tick only (listSubagentFiles + an offset).
//
// Bounded: at most budgetBytes read per tick, newest transcripts first (live minions before the
// cold backfill). A line over MAX_LINE_BYTES is skipped unread, even across ticks, and counted.
// A cheap substring prefilter (in scanLine) runs before any JSON.parse.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { SicknessScanProgress } from "../../shared/features/sickness.js";
import { CHRONIC_QUIET_MS, MAX_LINE_BYTES, newFileScanState, scanLine, type AgentRef, type CallInfo, type FileScanState, type SicknessEvent } from "./sickness-lib.js";
import { listSessionFiles, listSubagentFiles } from "./subagents/scan.js";

export const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
/** Remembered calls saved per live transcript: only a call still waiting for its result matters
 *  after a restart, and results follow their calls closely (measured: 98 live transcripts × 50
 *  calls made the offsets file 1.1 MB; the last 12 keep it small). */
const PERSISTED_CALLS = 12;
const NEWLINE = 0x0a;

export interface TranscriptRef {
  path: string;
  sessionId: string;
  subagentId: string | null;
}

interface Cursor extends TranscriptRef {
  /** Offset just past the last complete line read. */
  offset: number;
  /** Size and mtime at the last stat. */
  size: number;
  mtimeMs: number;
  /** Inside a line over MAX_LINE_BYTES: drop bytes until its newline. */
  skipping: boolean;
  /** Pairing memory; dropped once the file is fully read and quiet (see persistable()). */
  state: FileScanState | null;
  /** The size at which a read reached the end of the file but its last line had no newline yet
   *  (a line still being written, or a torn write): read again only once the size changes. */
  stalledAt: number | null;
}

/** Nothing left to read until the file grows. */
function caughtUp(c: Cursor): boolean {
  return c.offset >= c.size || c.stalledAt === c.size;
}

/** One cursor in data/sickness-scan.json (short keys: ~1,200 of them). */
interface StoredCursor {
  p: string;
  s: string;
  a: string | null;
  o: number;
  z: number;
  m: number;
  k?: true;
  /** Remembered calls (already redacted) and the obscura page host, for live or half-read files. */
  c?: Array<[string, CallInfo]>;
  h?: string | null;
}

export interface ScanStateFile {
  v: number;
  finishedAt: string | null;
  linesSkipped: number;
  files: StoredCursor[];
}

export type EventSink = (ev: SicknessEvent, agent: AgentRef) => void;

export async function listTranscripts(projectsDir: string): Promise<TranscriptRef[]> {
  const [main, subs] = await Promise.all([listSessionFiles(projectsDir), listSubagentFiles(projectsDir)]);
  return [
    ...main.map((m) => ({ path: m.path, sessionId: m.sessionId, subagentId: null })),
    ...subs.map((s) => ({ path: s.path, sessionId: s.parentSessionId, subagentId: s.agentId })),
  ];
}

/** Reads [start, end) of `path`, calling onLine(line, offsetOfLine) for each complete line of at
 *  most MAX_LINE_BYTES. A longer line is dropped as it streams (never buffered whole) and counted
 *  once; when the window ends inside it, `skipping` carries over to the next window. */
export async function readWindow(
  path: string,
  start: number,
  end: number,
  skippingIn: boolean,
  onLine: (line: Buffer, offset: number) => void,
): Promise<{ consumed: number; skipping: boolean; skipped: number }> {
  let skipping = skippingIn;
  let skipped = 0;
  let consumed = start; // start of the current line
  let read = start; // file offset of the current chunk's first byte
  const pending: Buffer[] = [];
  let pendingLen = 0;
  if (end <= start) return { consumed, skipping, skipped };
  // 256 KB chunks: every line of a chunk is scanned synchronously, so a smaller chunk bounds how long
  // one scan step holds the event loop (1 MB chunks showed up as 1-3 s loop stalls on a loaded box).
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 1 << 18 });
  for await (const raw of stream) {
    const chunk = raw as Buffer;
    let s = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, s);
      if (nl === -1) break;
      if (skipping) skipping = false; // the over-cap line ends here (counted when it started)
      else if (pendingLen + (nl - s) > MAX_LINE_BYTES) skipped++;
      else {
        const line = pending.length ? Buffer.concat([...pending, chunk.subarray(s, nl)]) : chunk.subarray(s, nl);
        if (line.length) onLine(line, consumed);
      }
      pending.length = 0;
      pendingLen = 0;
      s = nl + 1;
      consumed = read + s;
    }
    if (s < chunk.length && !skipping) {
      const rest = chunk.length - s;
      if (pendingLen + rest > MAX_LINE_BYTES) {
        skipped++;
        skipping = true;
        pending.length = 0;
        pendingLen = 0;
      } else {
        pending.push(Buffer.from(chunk.subarray(s)));
        pendingLen += rest;
      }
    }
    read += chunk.length;
  }
  // Everything after `consumed` belongs to an over-cap line: step past it for good.
  if (skipping) consumed = read;
  return { consumed, skipping, skipped };
}

export interface ScannerOptions {
  home: string;
  budgetBytes?: number;
}

export interface TickResult {
  bytesRead: number;
  filesRead: number;
  /** True when the backfill reached the end of every transcript during this tick. */
  justFinished: boolean;
}

/** Owns one cursor per transcript. Not re-entrant: the hub never overlaps a feature's ticks. */
export class TranscriptScanner {
  private readonly cursors = new Map<string, Cursor>();
  private readonly mainBySession = new Map<string, string>();
  /** Files a tick is reading right now (the index-pass fast path leaves them alone). */
  private readonly reading = new Set<string>();
  private readonly budget: number;
  linesSkipped = 0;
  finishedAt: string | null = null;
  /** True when a cursor moved since the state was last saved. */
  dirty = false;

  constructor(private readonly opts: ScannerOptions) {
    this.budget = opts.budgetBytes ?? SCAN_BUDGET_BYTES;
  }

  load(file: ScanStateFile): void {
    this.finishedAt = file.finishedAt;
    this.linesSkipped = file.linesSkipped;
    for (const c of file.files) {
      const state = c.c || c.h !== undefined ? { calls: new Map(c.c ?? []), obscuraHost: c.h ?? null } : null;
      this.cursors.set(c.p, { path: c.p, sessionId: c.s, subagentId: c.a, offset: c.o, size: c.z, mtimeMs: c.m, skipping: c.k === true, state, stalledAt: null });
      if (c.a === null) this.mainBySession.set(c.s, c.p);
    }
  }

  /** Pairing memory is worth keeping for a file still being written or not yet fully read. */
  private persistable(c: Cursor, nowMs: number): boolean {
    return c.state !== null && (!caughtUp(c) || nowMs - c.mtimeMs < CHRONIC_QUIET_MS);
  }

  toJSON(version: number, nowMs: number): ScanStateFile {
    const files: StoredCursor[] = [];
    for (const c of this.cursors.values()) {
      const out: StoredCursor = { p: c.path, s: c.sessionId, a: c.subagentId, o: c.offset, z: c.size, m: c.mtimeMs };
      if (c.skipping) out.k = true;
      if (c.state && this.persistable(c, nowMs)) {
        out.c = [...c.state.calls].slice(-PERSISTED_CALLS);
        out.h = c.state.obscuraHost;
      }
      files.push(out);
    }
    return { v: version, finishedAt: this.finishedAt, linesSkipped: this.linesSkipped, files };
  }

  progress(): SicknessScanProgress {
    let filesDone = 0;
    let bytesDone = 0;
    let bytesTotal = 0;
    for (const c of this.cursors.values()) {
      if (caughtUp(c)) filesDone++;
      bytesDone += Math.min(c.offset, c.size);
      bytesTotal += c.size;
    }
    return { filesDone, filesTotal: this.cursors.size, bytesDone, bytesTotal, finishedAt: this.finishedAt, linesSkipped: this.linesSkipped };
  }

  /** For the chronic sweep: is the transcript fully read, and when was it last written? */
  fileInfo(path: string): { atEof: boolean; mtimeMs: number } | null {
    const c = this.cursors.get(path);
    return c ? { atEof: caughtUp(c), mtimeMs: c.mtimeMs } : null;
  }

  mainPath(sessionId: string): string | null {
    return this.mainBySession.get(sessionId) ?? null;
  }

  private scanInto(c: Cursor, sink: EventSink, fallbackAt: string): (line: Buffer | string, offset: number) => void {
    const state = (c.state ??= newFileScanState());
    const agent: AgentRef = { sessionId: c.sessionId, subagentId: c.subagentId, file: c.path };
    const opts = { home: this.opts.home, fallbackAt };
    return (line, offset) => {
      for (const ev of scanLine(state, line, offset, opts)) sink(ev, agent);
    };
  }

  /** The index-pass fast path: applies a main session's new lines when they start exactly at this
   *  scanner's cursor (`indexerOffset` = the indexer's stored offset, i.e. the end of `lines`).
   *  Returns false (and changes nothing) otherwise; the tick then reads them from disk. */
  ingestIndexLines(sessionId: string, lines: readonly string[], indexerOffset: number | null, sink: EventSink, nowMs: number): boolean {
    const path = this.mainBySession.get(sessionId);
    const c = path ? this.cursors.get(path) : undefined;
    if (!c || indexerOffset === null || c.skipping || this.reading.has(c.path)) return false;
    let total = 0;
    for (const l of lines) total += Buffer.byteLength(l, "utf8") + 1;
    if (c.offset !== indexerOffset - total) return false;
    const onLine = this.scanInto(c, sink, new Date(nowMs).toISOString());
    let off = c.offset;
    for (const l of lines) {
      const len = Buffer.byteLength(l, "utf8");
      if (len > MAX_LINE_BYTES) this.linesSkipped++;
      else if (len > 0) onLine(l, off);
      off += len + 1;
    }
    c.offset = off;
    if (c.size < off) c.size = off;
    c.mtimeMs = Math.max(c.mtimeMs, nowMs);
    this.dirty = true;
    return true;
  }

  /** Lists and stats every transcript, then reads new bytes (newest files first) until the budget
   *  is spent. Events go to `sink` as lines are read. */
  async tick(projectsDir: string, sink: EventSink, nowMs: number): Promise<TickResult> {
    const refs = await listTranscripts(projectsDir);
    const seen = new Set<string>();
    for (const ref of refs) {
      seen.add(ref.path);
      let st;
      try {
        st = await stat(ref.path);
      } catch {
        continue; // deleted mid-scan
      }
      let c = this.cursors.get(ref.path);
      if (!c) {
        c = { ...ref, offset: 0, size: st.size, mtimeMs: st.mtimeMs, skipping: false, state: null, stalledAt: null };
        this.cursors.set(ref.path, c);
        if (ref.subagentId === null) this.mainBySession.set(ref.sessionId, ref.path);
        this.dirty = true;
      }
      if (st.size < c.offset) {
        // Truncated or replaced: start over (case updates dedupe by line offset, so a replay is a no-op).
        c.offset = 0;
        c.skipping = false;
        c.state = null;
        this.dirty = true;
      }
      if (c.size !== st.size || c.mtimeMs !== st.mtimeMs) this.dirty = true;
      c.size = st.size;
      c.mtimeMs = st.mtimeMs;
    }
    for (const [path, c] of this.cursors) {
      if (seen.has(path)) continue;
      this.cursors.delete(path); // the transcript is gone; its cases stay
      if (c.subagentId === null && this.mainBySession.get(c.sessionId) === path) this.mainBySession.delete(c.sessionId);
      this.dirty = true;
    }

    const todo = [...this.cursors.values()].filter((c) => !caughtUp(c)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let remaining = this.budget;
    let bytesRead = 0;
    let filesRead = 0;
    for (const c of todo) {
      const want = c.size - c.offset;
      // Never open a window too small to hold one whole line unless it finishes the file.
      if (want > remaining && remaining <= MAX_LINE_BYTES) continue;
      const take = Math.min(want, remaining);
      const onLine = this.scanInto(c, sink, new Date(c.mtimeMs).toISOString());
      this.reading.add(c.path);
      try {
        const r = await readWindow(c.path, c.offset, c.offset + take, c.skipping, onLine);
        this.linesSkipped += r.skipped;
        c.offset = r.consumed;
        c.skipping = r.skipping;
        c.stalledAt = take === want && c.offset < c.size ? c.size : null;
      } catch {
        // unreadable mid-scan: leave the cursor, try again next tick
      } finally {
        this.reading.delete(c.path);
      }
      remaining -= take;
      bytesRead += take;
      filesRead++;
      this.dirty = true;
      if (remaining <= 0) break;
    }

    // Free pairing memory of fully read, quiet transcripts.
    for (const c of this.cursors.values()) if (c.state && !this.persistable(c, nowMs)) c.state = null;

    let justFinished = false;
    if (this.finishedAt === null && this.cursors.size > 0 && [...this.cursors.values()].every(caughtUp)) {
      this.finishedAt = new Date(nowMs).toISOString();
      justFinished = true;
      this.dirty = true;
    }
    return { bytesRead, filesRead, justFinished };
  }
}
