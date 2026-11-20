// What changed in the world rows since the last broadcast. The hub (index.ts) used to rebroadcast
// every agent, object and edge on every index pass (~10 s), changed or not: on a machine with
// thousands of sessions that was megabytes per tab per pass with nothing happening. It now keeps
// one fingerprint per row of what every connected client was last sent, and sends only the rows
// that differ, the ids that left, and the edge set only when it changed (shared/types.ts).
//
// Fingerprints are sha1 of each row's JSON. buildWorldViews builds every row with a fixed key
// order, so equal rows always serialise the same.

import { createHash } from "node:crypto";
import type { ServerMessage, WorldAgent, WorldEdge, WorldObject, WorldSnapshot } from "../shared/types.js";

export interface WorldRows {
  agents: readonly WorldAgent[];
  objects: readonly WorldObject[];
  edges: readonly WorldEdge[];
}

/** Row id → fingerprint of what clients hold; `edges` fingerprints the whole edge set. */
export interface WorldBaseline {
  agents: ReadonlyMap<string, string>;
  objects: ReadonlyMap<string, string>;
  edges: string | null;
}

export interface WorldDelta {
  agents: WorldAgent[];
  agentsRemoved: string[];
  objects: WorldObject[];
  objectsRemoved: string[];
  /** The full edge set when it changed, else null. */
  edges: WorldEdge[] | null;
}

const fingerprint = (v: unknown): string => createHash("sha1").update(JSON.stringify(v)).digest("base64");

/** A baseline nobody holds anything of: the first diff against it sends everything. */
export function emptyBaseline(): WorldBaseline {
  return { agents: new Map(), objects: new Map(), edges: null };
}

function diffRows<T extends { id: string }>(prev: ReadonlyMap<string, string>, rows: readonly T[]): { changed: T[]; removed: string[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changed: T[] = [];
  for (const row of rows) {
    const fp = fingerprint(row);
    next.set(row.id, fp);
    if (prev.get(row.id) !== fp) changed.push(row);
  }
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  return { changed, removed, next };
}

/** The rows of `rows` that differ from `prev`, and the baseline once they are sent. */
export function diffWorld(prev: WorldBaseline, rows: WorldRows): { delta: WorldDelta; next: WorldBaseline } {
  const agents = diffRows(prev.agents, rows.agents);
  const objects = diffRows(prev.objects, rows.objects);
  const edgesFp = fingerprint(rows.edges);
  return {
    delta: {
      agents: agents.changed,
      agentsRemoved: agents.removed,
      objects: objects.changed,
      objectsRemoved: objects.removed,
      edges: edgesFp === prev.edges ? null : rows.edges.slice(),
    },
    next: { agents: agents.next, objects: objects.next, edges: edgesFp },
  };
}

/** The baseline of a client that was just sent exactly `rows` (a snapshot). */
export function baselineOf(rows: WorldRows): WorldBaseline {
  return diffWorld(emptyBaseline(), rows).next;
}

/** The WS messages that carry `delta`; none when nothing changed. */
export function deltaMessages(delta: WorldDelta): ServerMessage[] {
  const out: ServerMessage[] = [];
  if (delta.agents.length) out.push({ type: "agents", agents: delta.agents });
  if (delta.agentsRemoved.length) out.push({ type: "agentsRemoved", ids: delta.agentsRemoved });
  if (delta.objects.length) out.push({ type: "objects", objects: delta.objects });
  if (delta.objectsRemoved.length) out.push({ type: "objectsRemoved", ids: delta.objectsRemoved });
  if (delta.edges) out.push({ type: "edges", edges: delta.edges });
  return out;
}

/** Everything in a snapshot besides the rows and stats (which travel as their own messages). */
export function frameFingerprint(s: Pick<WorldSnapshot, "islands" | "jev" | "extras">): string {
  return fingerprint([s.islands, s.jev, s.extras ?? null]);
}

interface Served {
  rows: WorldRows;
  frame: string;
  at: number;
}

const LEDGER_SIZE = 4;
const LEDGER_TTL_MS = 30_000;

/** The last few snapshots GET /api/world served, by generatedAt, so the WS a tab opens right after
 *  can say `?have=<generatedAt>` and get only what changed since instead of the same megabytes again. */
export class SnapshotLedger {
  private readonly served = new Map<string, Served>();

  constructor(private readonly now: () => number = Date.now) {}

  remember(snapshot: WorldSnapshot): void {
    this.served.delete(snapshot.generatedAt);
    this.served.set(snapshot.generatedAt, { rows: { agents: snapshot.agents, objects: snapshot.objects, edges: snapshot.edges }, frame: frameFingerprint(snapshot), at: this.now() });
    while (this.served.size > LEDGER_SIZE) {
      const oldest = this.served.keys().next().value;
      if (oldest === undefined) break;
      this.served.delete(oldest);
    }
  }

  /** The delta from the snapshot served as `generatedAt` to `current`, or null when a full snapshot
   *  is needed: unknown or expired, or anything besides the rows and stats changed. One use each. */
  catchUp(generatedAt: string, current: WorldSnapshot): WorldDelta | null {
    const s = this.served.get(generatedAt);
    this.served.delete(generatedAt);
    if (!s || this.now() - s.at > LEDGER_TTL_MS) return null;
    if (s.frame !== frameFingerprint(current)) return null;
    return diffWorld(baselineOf(s.rows), current).delta;
  }
}
