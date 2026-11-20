// A5 — conflict beams (idea from claude-cockpit src/swarm.ts): two sessions that wrote
// (Edit/Write/MultiEdit/NotebookEdit) the same file within the last 30 minutes, where at
// least one of them is live. Reads are ignored: everyone reads README.md.

import type { ConflictPair, ConflictsMessage } from "../../shared/features/conflicts.js";
import { cachedAgents, fleetTracker, WRITE_WINDOW_MS, type FleetTracker } from "./fleet-tracker.js";
import type { ServerFeature } from "./registry.js";

const MAX_PAIRS = 20;
const MAX_FILES = 10;

export function computeConflicts(
  writes: ReadonlyMap<string, ReadonlyMap<string, number>>,
  live: ReadonlySet<string>,
  nowMs: number,
  windowMs = WRITE_WINDOW_MS,
): ConflictPair[] {
  const byFile = new Map<string, { session: string; at: number }[]>();
  for (const [session, files] of writes) {
    for (const [file, at] of files) {
      if (nowMs - at > windowMs) continue;
      const arr = byFile.get(file) ?? [];
      arr.push({ session, at });
      byFile.set(file, arr);
    }
  }
  const pairs = new Map<string, ConflictPair & { atMs: number }>();
  for (const [file, list] of byFile) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        if (!x || !y || x.session === y.session) continue;
        if (!live.has(x.session) && !live.has(y.session)) continue;
        const [a, b] = x.session < y.session ? [x.session, y.session] : [y.session, x.session];
        const key = `${a}|${b}`;
        const atMs = Math.max(x.at, y.at);
        const cur = pairs.get(key) ?? { a, b, files: [], at: "", atMs: 0 };
        if (cur.files.length < MAX_FILES) cur.files.push(file);
        cur.atMs = Math.max(cur.atMs, atMs);
        cur.at = new Date(cur.atMs).toISOString();
        pairs.set(key, cur);
      }
    }
  }
  return [...pairs.values()]
    .sort((p, q) => q.atMs - p.atMs)
    .slice(0, MAX_PAIRS)
    .map(({ a, b, files, at }) => ({ a, b, files: files.sort(), at }));
}

export function createConflictsFeature(tracker: FleetTracker = fleetTracker): ServerFeature {
  let pairs: ConflictPair[] = [];
  let lastKey = "";
  return {
    id: "conflicts",
    async onIndexPass(ctx, batch) {
      await tracker.ensureColdScan(ctx.config.projectsDir);
      tracker.ingestBatch(batch);
    },
    async onTick(ctx) {
      await tracker.ensureColdScan(ctx.config.projectsDir);
      const now = Date.now();
      const live = new Set(cachedAgents(ctx).filter((a) => a.status === "live").map((a) => a.id));
      pairs = computeConflicts(tracker.recentWrites(now), live, now);
      const key = JSON.stringify(pairs.map((p) => [p.a, p.b, p.files]));
      if (key !== lastKey) {
        lastKey = key;
        ctx.emit({ kind: "pairs", pairs } satisfies ConflictsMessage);
      }
    },
    snapshotExtras() {
      return { "conflicts.pairs": pairs };
    },
  };
}

export const conflictsFeature = createConflictsFeature();
