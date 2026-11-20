// The one live Feed (right sidebar → Feed tab). A typed, capped, deduped store plus pure
// adapters that turn real events (activity lines, Jev decisions, approvals, routine runs,
// agents waiting on you) into FeedItems. DOM-free: rendering lives in shell/feed-ui.ts.

import type { AgentActivity, JevDecision, WorldAgent } from "../../../shared/types";
import type { ApprovalView } from "../../../shared/features/approvals";
import type { FeedItem as ServerFeedItem } from "../../../shared/features/feed";
import type { Routine } from "../../../shared/features/routines";
import { FEED_KINDS, type FeedItem, type FeedKind, type FeedOutcome, type FeedSink } from "./feed-types";
import { agentTitle } from "../../../shared/display";

export * from "./feed-types";

export const FEED_CAP = 300;

export interface FeedQuery {
  /** Only these kinds (empty / undefined = all). */
  kinds?: ReadonlySet<FeedKind>;
  agentId?: string;
  limit?: number;
}

function isOpen(i: FeedItem): boolean {
  return i.pinned === true && i.outcome === undefined;
}

export class FeedStore implements FeedSink {
  private readonly items = new Map<string, FeedItem>();
  private readonly listeners = new Set<() => void>();
  private seenAt = 0;

  constructor(private readonly cap = FEED_CAP) {}

  push(input: FeedItem | readonly FeedItem[]): boolean {
    const list: readonly FeedItem[] = Array.isArray(input) ? input : [input as FeedItem];
    let changed = false;
    for (const raw of list) {
      if (!raw.id || !raw.title || !Number.isFinite(raw.at)) continue;
      const prev = this.items.get(raw.id);
      // A decided item never re-opens because a stale copy of it arrives again.
      const next: FeedItem = prev?.outcome && !raw.outcome ? { ...raw, outcome: prev.outcome } : raw;
      if (prev && sameItem(prev, next)) continue;
      this.items.set(raw.id, next);
      changed = true;
    }
    if (changed) {
      this.trim();
      this.emit();
    }
    return changed;
  }

  resolve(id: string, outcome: FeedOutcome): void {
    const prev = this.items.get(id);
    if (!prev || prev.outcome !== undefined) return; // the first outcome wins (a decision beats a later "gone")
    this.items.set(id, { ...prev, outcome });
    this.emit();
  }

  get(id: string): FeedItem | undefined {
    return this.items.get(id);
  }

  size(): number {
    return this.items.size;
  }

  /** Open pinned items first (approvals, then waiting agents, oldest first: they expire first), then newest first. */
  list(q: FeedQuery = {}): FeedItem[] {
    const kinds = q.kinds && q.kinds.size ? q.kinds : null;
    const all = [...this.items.values()].filter((i) => (!kinds || kinds.has(i.kind)) && (!q.agentId || i.agentId === q.agentId));
    const open = all.filter(isOpen).sort((a, b) => pinRank(a) - pinRank(b) || a.at - b.at);
    const rest = all.filter((i) => !isOpen(i)).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    const out = [...open, ...rest];
    return q.limit ? out.slice(0, q.limit) : out;
  }

  /** Items per kind (all of them, for the filter chips). */
  counts(): Record<FeedKind, number> {
    const out = Object.fromEntries(FEED_KINDS.map((k) => [k, 0])) as Record<FeedKind, number>;
    for (const i of this.items.values()) out[i.kind]++;
    return out;
  }

  /** Open actionable items (the Feed tab's badge). */
  openCount(): number {
    let n = 0;
    for (const i of this.items.values()) if (isOpen(i)) n++;
    return n;
  }

  /** Items newer than the last markSeen() (a quiet dot on the tab). */
  unseen(): number {
    let n = 0;
    for (const i of this.items.values()) if (i.at > this.seenAt) n++;
    return n;
  }

  markSeen(now = Date.now()): void {
    this.seenAt = Math.max(this.seenAt, now);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Over the cap: drop the oldest closed items first; open ones are never dropped, and tripwires
   *  go last (they are rare, and the Town square scores them for up to 2 h, far longer than ~300
   *  activity lines take to arrive). */
  private trim(): void {
    if (this.items.size <= this.cap) return;
    const closed = [...this.items.values()].filter((i) => !isOpen(i)).sort((a, b) => Number(a.kind === "tripwire") - Number(b.kind === "tripwire") || a.at - b.at);
    for (const i of closed) {
      if (this.items.size <= this.cap) break;
      this.items.delete(i.id);
    }
  }
}

function pinRank(i: FeedItem): number {
  return i.kind === "approval" ? 0 : i.kind === "awaiting" ? 1 : 2;
}

function sameItem(a: FeedItem, b: FeedItem): boolean {
  return (
    a.kind === b.kind &&
    a.at === b.at &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.outcome === b.outcome &&
    a.pinned === b.pinned &&
    a.agentId === b.agentId &&
    a.cityId === b.cityId &&
    a.href === b.href &&
    a.approval?.id === b.approval?.id &&
    a.approval?.expiresAt === b.approval?.expiresAt
  );
}

// ---------------------------------------------------------------- adapters (pure, tested)

function ms(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

export interface AgentNamer {
  (agentId: string): { title: string; city: string } | undefined;
}

/** Plan / reason lines are what the agent is saying (captions); hook / brain / tool lines are activity. */
export function activityToFeed(a: AgentActivity, who: AgentNamer, now = Date.now()): FeedItem | null {
  if (!a.summary) return null;
  const w = who(a.agentId);
  const caption = a.stage === "reason" || a.stage === "plan";
  return {
    id: `act:${a.id}`,
    kind: caption ? "caption" : "activity",
    at: ms(a.at, now),
    title: a.summary,
    detail: [w?.title, w?.city, caption ? null : (a.toolName ?? a.stage)].filter(Boolean).join(" · ") || undefined,
    agentId: a.agentId,
  };
}

/** A Jev decision is an "official result". */
export function decisionToFeed(d: JevDecision, now = Date.now()): FeedItem {
  return {
    id: `dec:${d.id}`,
    kind: "decision",
    at: ms(d.at, now),
    title: d.summary,
    detail: `Official result · ${d.source === "jev" ? `Jev ${Math.round(d.confidence * 100)}% sure` : "by the rules"}`,
    agentId: d.subjects.find((s) => !s.includes(":")),
  };
}

/** An open permission request: pinned, with hold-to-confirm Approve / Deny in the Feed. */
export function approvalToFeed(a: ApprovalView, who: AgentNamer, now = Date.now()): FeedItem {
  const w = who(a.agentId);
  return {
    id: `ap:${a.id}`,
    kind: "approval",
    at: ms(a.createdAt, now),
    title: `${a.toolName}: ${a.preview.title}`,
    detail: w ? `${w.title} · ${w.city}` : `session ${a.agentId.slice(0, 8)}`,
    agentId: a.agentId,
    approval: { id: a.id, toolName: a.toolName, expiresAt: ms(a.expiresAt, now) },
    pinned: true,
  };
}

/** An agent waiting for your reply: pinned until it stops waiting. */
export function awaitingToFeed(agent: WorldAgent, city: string, now = Date.now()): FeedItem {
  return {
    id: `wait:${agent.id}:${agent.lastActive}`,
    kind: "awaiting",
    at: ms(agent.lastActive, now),
    title: `${agentTitle(agent)} is waiting for your reply`,
    detail: city,
    agentId: agent.id,
    cityId: agent.islandId,
    pinned: true,
  };
}

/**
 * Routine runs from two consecutive snapshots of the routines list: a job that started
 * running, or that finished (running → not running) with its exit status.
 */
export function routineRunsToFeed(prev: readonly Routine[] | null, next: readonly Routine[], now = Date.now()): FeedItem[] {
  if (!prev) return [];
  const before = new Map(prev.map((r) => [r.label, r]));
  const out: FeedItem[] = [];
  for (const r of next) {
    const p = before.get(r.label);
    if (!p) continue;
    if (!p.running && r.running) {
      out.push({ id: `rt:${r.label}:start:${now}`, kind: "routine", at: now, title: `${r.shortName} started`, detail: r.schedule.text });
    } else if (p.running && !r.running) {
      const ok = r.lastExitStatus === 0;
      out.push({
        id: `rt:${r.label}:end:${now}`,
        kind: "routine",
        at: now,
        title: `${r.shortName} ${r.lastExitStatus === null ? "finished" : ok ? "finished OK" : `failed (exit ${r.lastExitStatus})`}`,
        detail: r.schedule.text,
      });
    }
  }
  return out;
}

/**
 * A "tripwire" a SERVER feature published with appendToFeed (server/features/feed.ts), bridged
 * into the live Feed by features/feed-bridge.ts. Client features push theirs straight into
 * ctx.feed ({ kind: "tripwire", … }); either way the Town square's global workspace scores it.
 */
export function serverTripwireToFeed(i: ServerFeedItem, now = Date.now()): FeedItem | null {
  if (i.kind !== "tripwire" || !i.id || !i.title) return null;
  return { id: `srv:${i.id}`, kind: "tripwire", at: ms(i.at, now), title: i.title, detail: i.detail ?? undefined, agentId: i.agentId ?? undefined };
}

/** Which agents newly started / stopped waiting, from the agent list now. */
export function awaitingDiff(prevIds: ReadonlySet<string>, agents: readonly WorldAgent[]): { started: WorldAgent[]; stopped: string[]; now: Set<string> } {
  const nowIds = new Set(agents.filter((a) => a.awaitingInput === true).map((a) => a.id));
  return {
    started: agents.filter((a) => nowIds.has(a.id) && !prevIds.has(a.id)),
    stopped: [...prevIds].filter((id) => !nowIds.has(id)),
    now: nowIds,
  };
}
