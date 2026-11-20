// The "neighbours" server feature: serves each session's first and last MESSAGE (a user or
// assistant line; neighbours-lib.ts) so the agent panel's crew rows (client/src/features/
// neighbours.ts) window on real conversation, not on WorldAgent.startedAt / lastActive, which the
// indexer moves on any timestamped line and sets to the file's mtime when a pass reads only
// untimestamped lines.
//
// Read-only and in memory: nothing is written to world.db, so there is no migration. On the first
// hook call it scans every already-indexed transcript once, [0, stored offset) only, reading the
// head up to its first message and the tail back to its last. After that, each index pass's new
// lines are merged in (earliest first, latest last), so lines seen by both are harmless. Until
// the scan is done GET /api/neighbours/windows answers ready: false with no rows, and the client
// then shows no crew at all; the scan's end pushes every row.

import { basename } from "node:path";
import { NEIGHBOURS_WINDOWS_PATH, type MessageWindow, type NeighboursFeatureMessage, type NeighboursWindowsResponse } from "../../shared/features/neighbours.js";
import { respondJson } from "../http.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { mergeSpan, scanSpan, spanOfLines, type Span } from "./neighbours-lib.js";

export interface NeighboursFeature extends ServerFeature {
  /** Starts the one scan if it hasn't started, and resolves when it is done (a test seam). */
  scanned(ctx: FeatureContext): Promise<void>;
  /** What GET /api/neighbours/windows answers (starts the scan if it hasn't started). */
  windows(ctx: FeatureContext): NeighboursWindowsResponse;
}

const toRows = (entries: Iterable<[string, Span]>): MessageWindow[] => [...entries].map(([id, s]) => ({ id, first: s.first, last: s.last }));

export function createNeighboursFeature(): NeighboursFeature {
  const spans = new Map<string, Span>();
  let scan: Promise<void> | null = null;
  let ready = false;

  /** Merges `span` into the session's; true when that changed it. */
  function merge(id: string, span: Span): boolean {
    const prev = spans.get(id);
    const next = mergeSpan(prev, span);
    if (prev && prev.first === next.first && prev.last === next.last) return false;
    spans.set(id, next);
    return true;
  }

  function ensureScan(ctx: FeatureContext): Promise<void> {
    scan ??= (async () => {
      const t0 = Date.now();
      const ids = new Set(ctx.db.listSessions().map((s) => s.id));
      let unreadable = 0;
      for (const off of ctx.db.listFileOffsets()) {
        const id = basename(off.path, ".jsonl");
        if (!off.path.endsWith(".jsonl") || !ids.has(id)) continue;
        try {
          const span = await scanSpan(off.path, off.byteOffset);
          if (span) merge(id, span);
        } catch {
          unreadable += 1; // deleted or unreadable: that session gets no window, so no crew
        }
      }
      ready = true;
      ctx.emit({ kind: "windows", windows: toRows(spans) } satisfies NeighboursFeatureMessage);
      ctx.log.info("neighbours", `message windows scanned in ${Date.now() - t0}ms: ${spans.size} sessions${unreadable ? `, ${unreadable} transcripts unreadable` : ""}`);
    })().catch((err: unknown) => {
      ctx.log.warn("neighbours", `message-window scan failed; retrying on the next pass: ${String(err)}`);
      scan = null;
    });
    return scan;
  }

  function current(ctx: FeatureContext): NeighboursWindowsResponse {
    void ensureScan(ctx);
    return { ready, windows: ready ? toRows(spans) : [] };
  }

  return {
    id: "neighbours",

    scanned: ensureScan,
    windows: current,

    routes: [{ method: "GET", path: NEIGHBOURS_WINDOWS_PATH, handler: (_req, res, ctx) => respondJson(res, 200, current(ctx)) }],

    onIndexPass(ctx, newLinesBySession) {
      void ensureScan(ctx);
      const changed: Array<[string, Span]> = [];
      for (const [id, lines] of newLinesBySession) {
        const span = spanOfLines(lines);
        if (span && merge(id, span)) changed.push([id, spans.get(id) ?? span]);
      }
      if (ready && changed.length) ctx.emit({ kind: "windows", windows: toRows(changed) } satisfies NeighboursFeatureMessage);
    },

    // Starts the scan within a tick of boot even when no session is writing.
    onTick(ctx) {
      void ensureScan(ctx);
    },
  };
}

export const neighboursFeature = createNeighboursFeature();
