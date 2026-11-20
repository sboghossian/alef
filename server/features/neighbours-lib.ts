// Pure half of the server "neighbours" feature: a session's first and last MESSAGE, meaning its
// first and last user or assistant transcript line. Bookkeeping lines (queue-operation,
// frame-link, attachment, system, last-prompt, cost-state…) are never messages, and a line with
// no valid timestamp is never placed in time: there is no mtime fallback.
// Transcript text is untrusted: it is only parsed (parseLine), never executed.

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { parseLine } from "../jsonl-events.js";

export interface Span {
  first: string;
  last: string;
}

const NEWLINE = 0x0a;
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Each backward read doubles, up to this, so one huge line costs O(its size) in copies. */
const TAIL_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

/** The line's time, as normalized ISO, when it is a user or assistant line with a valid timestamp; else null. */
export function messageAt(raw: string): string | null {
  const line = parseLine(raw);
  if (!line || !(line.isUserLine || line.isAssistant) || !line.timestamp) return null;
  const ms = Date.parse(line.timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function spanOf(a: string, b: string): Span {
  return a <= b ? { first: a, last: b } : { first: b, last: a };
}

/** First and last message among `lines` (file order): scans in from both ends, so trailing bookkeeping costs little. */
export function spanOfLines(lines: readonly string[]): Span | null {
  let head = -1;
  let first: string | null = null;
  for (let i = 0; i < lines.length && first === null; i++) {
    first = messageAt(lines[i] ?? "");
    head = i;
  }
  if (first === null) return null;
  let last: string | null = null;
  for (let i = lines.length - 1; i > head && last === null; i--) last = messageAt(lines[i] ?? "");
  return spanOf(first, last ?? first);
}

/** The earliest first and the latest last of both. */
export function mergeSpan(a: Span | undefined, b: Span): Span {
  if (!a) return b;
  return { first: a.first <= b.first ? a.first : b.first, last: a.last >= b.last ? a.last : b.last };
}

/** The first message in `path`'s first `end` bytes (complete lines only); stops at it. */
export async function firstMessageAt(path: string, end: number): Promise<string | null> {
  if (end <= 0) return null;
  let buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { start: 0, end: end - 1 })) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    let start = 0;
    for (let nl = buffer.indexOf(NEWLINE, start); nl !== -1; nl = buffer.indexOf(NEWLINE, start)) {
      const at = messageAt(buffer.toString("utf8", start, nl));
      if (at) return at; // leaving the loop destroys the stream
      start = nl + 1;
    }
    buffer = buffer.subarray(start);
  }
  return null;
}

/**
 * The last message in `path`'s first `end` bytes, read backwards from `end` a chunk at a time, so
 * a long transcript costs only the lines after its last message. `end` is the indexer's stored
 * offset: just past a newline. A line is only parsed once its start has been read.
 */
export async function lastMessageAt(path: string, end: number, chunkBytes = TAIL_CHUNK_BYTES): Promise<string | null> {
  if (end <= 0) return null;
  const fh = await open(path, "r");
  try {
    let pos = end; // bytes [pos, pos + pending.length) are in `pending`
    let pending = Buffer.alloc(0);
    let stop = 0; // pending[0, stop) is not yet parsed; it ends at a line's end
    let want = chunkBytes;
    while (pos > 0) {
      const size = Math.min(want, pos);
      want = Math.min(want * 2, Math.max(chunkBytes, TAIL_CHUNK_MAX_BYTES));
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await fh.read(chunk, 0, size, pos - size);
      if (bytesRead !== size) throw new Error(`${path} shrank below ${end} bytes while being read`);
      pos -= size;
      pending = Buffer.concat([chunk, pending.subarray(0, stop)]);
      stop = pending.length;
      while (stop > 0) {
        // The line ending at `stop` (its newline, when present, is pending[stop - 1]) starts after the previous newline.
        const body = pending[stop - 1] === NEWLINE ? stop - 1 : stop;
        const nl = body > 0 ? pending.lastIndexOf(NEWLINE, body - 1) : -1;
        if (nl === -1 && pos > 0) break; // its start is in an earlier chunk
        const at = messageAt(pending.toString("utf8", nl + 1, body));
        if (at) return at;
        stop = nl + 1;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** The session's message span in `path`'s first `end` bytes, or null when they hold no message. */
export async function scanSpan(path: string, end: number): Promise<Span | null> {
  const first = await firstMessageAt(path, end);
  if (first === null) return null;
  return spanOf(first, (await lastMessageAt(path, end)) ?? first);
}
