// "feed": one ordered stream for the shell's Feed tab — agent activity (derived from new
// transcript lines, same derivation as the hub's activity pushes), Jev decisions, approvals
// requested/resolved, launchd routine runs, and the governance decisions other features append
// (governance-lib.ts). In-memory ring buffer with a per-boot monotonic seq: GET
// /api/feed?since=<seq>[&before=<seq>], plus { feature: "feed" } WS pushes.
//
// Retention is a TIME floor, not only a count cap: an item stays at least `minAgeMs` (2 h, the
// Town square's window) after it landed. Past `cap` items, only the ones older than that are
// dropped; `hardCap` bounds memory on a flood, and says so in the log when it has to cut into
// the 2 h.

import { randomUUID } from "node:crypto";
import type { Automation } from "../../shared/features/automations.js";
import type { ApprovalView } from "../../shared/features/approvals.js";
import { isFeedDecision, type FeedItem, type FeedMessage, type FeedResponse } from "../../shared/features/feed.js";
import type { JevDecision } from "../../shared/types.js";
import { deriveActivity } from "../activity.js";
import { sanitizeTitle } from "../heuristics.js";
import { respondJson } from "../http.js";
import { parseLine } from "../jsonl-events.js";
import { pendingApprovalViews } from "./approvals.js";
import { discoverDefaultAutomations } from "./automations.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const DEFAULT_CAP = 1000;
const DEFAULT_MIN_AGE_MS = 2 * 60 * 60_000;
const DEFAULT_HARD_CAP = 20_000;
const SEEN_CAP = 2000;
// Taken at module load, before index.ts's boot directorTick() writes anything: the line between
// decisions an earlier run left in the store and ones this process made.
const PROCESS_STARTED_AT = Date.now();

export interface FeedSources {
  decisions(ctx: FeatureContext): JevDecision[];
  approvals(): ApprovalView[];
  routines(): Promise<Automation[]>;
}

export interface FeedOptions {
  sources?: Partial<FeedSources>;
  /** Past this many items, the ones older than `minAgeMs` are dropped (default 1000). */
  cap?: number;
  /** Every item is kept at least this long after it landed, whatever `cap` says (default 2 h). */
  minAgeMs?: number;
  /** Absolute bound on the ring (default 20,000): only a flood reaches it. */
  hardCap?: number;
  /** Default 5 s; tests shorten it so a real server's first tick (which gives appendToFeed its live context) comes quickly. */
  tickIntervalMs?: number;
  routineEveryMs?: number;
  now?: () => number;
  /** Epoch ms this process started (default: module load); decisions stamped earlier are not replayed. */
  startedAt?: number;
}

type RoutineState = { running: boolean; lastRunAt: string | null; lastExitStatus: number | null };

// Items other features append (e.g. a Mac action the user clicked): flushed at once by the
// live feed, or on its next tick before it has a context.
type FeedDraft = Omit<FeedItem, "seq">;
const inbox: FeedDraft[] = [];
let flushInbox: (() => void) | null = null;
export function appendToFeed(item: FeedDraft): void {
  inbox.push(item);
  if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
  try {
    flushInbox?.();
  } catch {
    // the item is in the ring by now (only the WS emit can throw after that): a caller's own
    // decision (a click, a verdict) never fails because the feed couldn't broadcast it
  }
}

// The "logs" feature taps every item that lands in the feed (minus its own concerns — it
// decides which kinds to keep). A throwing listener never breaks the feed itself.
let feedItemListeners: ReadonlyArray<(items: readonly FeedItem[]) => void> = [];
export function onFeedItems(listener: (items: readonly FeedItem[]) => void): () => void {
  feedItemListeners = [...feedItemListeners, listener];
  return () => {
    feedItemListeners = feedItemListeners.filter((l) => l !== listener);
  };
}
function notifyFeedItems(items: readonly FeedItem[]): void {
  for (const listener of feedItemListeners) {
    try {
      listener(items);
    } catch {
      // a throwing listener never breaks the feed
    }
  }
}

export function createFeedFeature(opts: FeedOptions = {}): ServerFeature {
  const sources: FeedSources = {
    decisions: opts.sources?.decisions ?? ((ctx) => ctx.db.listDecisions(50)),
    approvals: opts.sources?.approvals ?? pendingApprovalViews,
    routines: opts.sources?.routines ?? discoverDefaultAutomations,
  };
  const cap = opts.cap ?? DEFAULT_CAP;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const hardCap = Math.max(cap, opts.hardCap ?? DEFAULT_HARD_CAP);
  const routineEveryMs = opts.routineEveryMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? PROCESS_STARTED_AT;
  const bootId = randomUUID();
  const items: FeedItem[] = [];
  /** When each item landed (epoch ms), in lockstep with `items`: retention ages by arrival, never
   *  by an item's own `at` (a routine run or a decision can carry a much older source time). */
  const landedAt: number[] = [];
  let seq = 0;
  let hardCapWarned = false;
  const seenDecisions = new Set<string>();
  let bootDecisionsSeeded = false;
  let pendingApprovals = new Map<string, ApprovalView>();
  let routineState: Map<string, RoutineState> | null = null;
  let lastRoutinePoll = 0;
  let liveCtx: FeatureContext | null = null;
  flushInbox = () => {
    if (liveCtx) push(liveCtx, inbox.splice(0));
  };

  function push(ctx: FeatureContext, drafts: Array<Omit<FeedItem, "seq">>): void {
    if (drafts.length === 0) return;
    const added = drafts.map((d) => ({ ...d, seq: ++seq }));
    const t = now();
    items.push(...added);
    for (let i = 0; i < added.length; i++) landedAt.push(t);
    evict(ctx, t);
    ctx.emit({ kind: "items", bootId, items: added } satisfies FeedMessage);
    notifyFeedItems(added);
  }

  /** Oldest first: over `cap`, drop what is older than `minAgeMs`; over `hardCap`, drop regardless. */
  function evict(ctx: FeatureContext, t: number): void {
    let drop = 0;
    while (items.length - drop > cap && t - (landedAt[drop] ?? t) > minAgeMs) drop++;
    if (items.length - drop > hardCap) {
      const over = items.length - drop - hardCap;
      if (!hardCapWarned) ctx.log.warn("feed", `ring over ${hardCap} items: dropping ${over} younger than ${Math.round(minAgeMs / 60_000)} min`);
      hardCapWarned = true;
      drop += over;
    }
    if (drop === 0) return;
    items.splice(0, drop);
    landedAt.splice(0, drop);
  }

  function trimSeen(set: Set<string>): void {
    if (set.size <= SEEN_CAP) return;
    for (const k of [...set].slice(0, set.size - SEEN_CAP)) set.delete(k);
  }

  async function pollRoutines(ctx: FeatureContext): Promise<void> {
    const list = await sources.routines();
    const next = new Map<string, RoutineState>();
    const drafts: Array<Omit<FeedItem, "seq">> = [];
    const at = new Date(now()).toISOString();
    for (const a of list) {
      if (a.kind !== "launchd") continue;
      const cur: RoutineState = { running: a.running, lastRunAt: a.lastRunAt, lastExitStatus: a.lastExitStatus };
      next.set(a.id, cur);
      const prev = routineState?.get(a.id);
      if (!routineState || !prev) continue; // first poll only seeds
      if (!prev.running && cur.running) {
        drafts.push({ id: `routine:${a.id}:start:${at}`, at, kind: "routine", agentId: null, title: sanitizeTitle(`${a.name} started`), detail: a.schedule, tag: "started" });
      } else if ((prev.running && !cur.running) || (cur.lastRunAt !== prev.lastRunAt && cur.lastRunAt !== null)) {
        const exit = cur.lastExitStatus;
        const detail = exit === null ? null : exit === 0 ? "exit 0" : `exit ${exit}`;
        drafts.push({ id: `routine:${a.id}:done:${cur.lastRunAt ?? at}`, at: cur.lastRunAt ?? at, kind: "routine", agentId: null, title: sanitizeTitle(`${a.name} ran`), detail, tag: "finished" });
      }
    }
    routineState = next;
    push(ctx, drafts);
  }

  return {
    id: "feed",
    tickIntervalMs: opts.tickIntervalMs ?? 5_000,
    routes: [
      {
        method: "GET",
        path: "/api/feed",
        handler(req, res) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const since = Number(url.searchParams.get("since") ?? 0);
          const until = Number(url.searchParams.get("before") || Number.NaN); // absent or empty: no upper bound
          const n = Number(url.searchParams.get("limit") ?? 200);
          const limit = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.round(n))) : 200;
          const after = Number.isFinite(since) ? since : 0;
          const before = Number.isFinite(until) ? until : Number.POSITIVE_INFINITY;
          const newer = items.filter((i) => i.seq > after && i.seq < before);
          respondJson(res, 200, { ok: true, bootId, cursor: seq, items: newer.slice(-limit) } satisfies FeedResponse);
        },
      },
    ],
    onIndexPass(ctx, newLinesBySession) {
      const drafts: Array<Omit<FeedItem, "seq">> = [];
      for (const [sessionId, lines] of newLinesBySession) {
        const sessionCwd = ctx.db.getSession(sessionId)?.cwd ?? "";
        lines.forEach((raw, i) => {
          const parsed = parseLine(raw);
          if (!parsed?.timestamp) return;
          const cwd = parsed.cwd ?? sessionCwd;
          deriveActivity(parsed, cwd, parsed.timestamp).forEach((d, j) => {
            drafts.push({
              id: `act:${sessionId}:${d.at}:${i}:${j}`,
              at: d.at,
              kind: "activity",
              agentId: sessionId,
              title: d.summary,
              detail: d.toolName,
              tag: d.stage,
            });
          });
        });
      }
      drafts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      push(ctx, drafts);
    },
    async onTick(ctx) {
      liveCtx = ctx;
      const drafts: Array<Omit<FeedItem, "seq">> = inbox.splice(0);
      const decisions = [...sources.decisions(ctx)].reverse();
      if (!bootDecisionsSeeded) {
        // The store already holds up to 50 decisions from before this process started. Mark them
        // seen without replaying them as new feed items — otherwise every restart re-logs the
        // same old decisions. Only those: the boot directorTick() runs ~5 s before this first tick
        // (index.ts calls it before features.startTicks()), and its decisions are news.
        // An unparseable `at` counts as old, so it can never replay on every restart.
        bootDecisionsSeeded = true;
        for (const d of decisions) if (!(Date.parse(d.at) >= startedAt)) seenDecisions.add(d.id);
      }
      for (const d of decisions) {
        if (seenDecisions.has(d.id)) continue;
        seenDecisions.add(d.id);
        if (!isFeedDecision(d)) continue;
        drafts.push({ id: `decision:${d.id}`, at: d.at, kind: "decision", agentId: d.subjects[0] ?? null, title: sanitizeTitle(d.summary), detail: d.source, tag: d.kind });
      }
      trimSeen(seenDecisions);
      const pending = new Map(sources.approvals().map((v) => [v.id, v]));
      for (const [id, v] of pending) {
        if (pendingApprovals.has(id)) continue;
        drafts.push({ id: `approval:${id}`, at: v.createdAt, kind: "approval", agentId: v.agentId, title: sanitizeTitle(`${v.toolName}: ${v.preview.title}`), detail: null, tag: v.toolName });
      }
      const at = new Date(now()).toISOString();
      for (const [id, v] of pendingApprovals) {
        if (pending.has(id)) continue;
        drafts.push({ id: `approval-resolved:${id}`, at, kind: "approval-resolved", agentId: v.agentId, title: sanitizeTitle(`${v.toolName} answered`), detail: null, tag: v.toolName });
      }
      pendingApprovals = pending;
      push(ctx, drafts);
      if (now() - lastRoutinePoll >= routineEveryMs) {
        lastRoutinePoll = now();
        try {
          await pollRoutines(ctx);
        } catch (err) {
          ctx.log.warn("feed", "routine poll failed", String(err));
        }
      }
    },
  };
}

export const feedFeature = createFeedFeature();
