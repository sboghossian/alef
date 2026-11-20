// Client side of the server's "feed" feature (server/features/feed.ts). Nothing on the client
// listened to it before (its WS pushes were logged as unhandled); this takes only what the client
// has no other source for:
//   - "tripwire" items a SERVER feature published with appendToFeed → the one live Feed
//     (ctx.feed), where the Town square's global workspace scores them like any other item.
//     Client features skip this and push theirs straight in: ctx.feed.push({ kind: "tripwire", … });
//   - "graduation" items (server/features/outcomes.ts: a session shipped or delivered; also
//     server/features/careers-lib.ts's career moves, which share this wire kind) → the same live
//     Feed. Only a real graduation (GRADUATION_TAGS) keeps kind "graduation" and gets an href to
//     the PR named in the title (graduationHref); the rest go out as "system" (never a 🎓).
//   - routine runs, with their real run time and exit status → kept here for the workspace
//     (workspace-data.ts). The Feed tab keeps its own routine lines (shell/feed-sources.ts).
//   - governance decisions: "decision" items whose tag starts with "gov:" (server/features/
//     governance-lib.ts: Jev's ranking of the president's board, Alex's clicks, council
//     verdicts, the resident's proposals, merges) → the same live Feed. Jev's own ranking
//     ("gov:jev") stays a Jev "decision"; every other source goes out as "system". A merge
//     ("gov:census") links the PR its title ends with. Never pinned: town news, nothing to answer.
// Everything else the server feed carries (activity, the store's own Jev decisions, approvals)
// already reaches the client through the store, so it is ignored here rather than shown twice.
// An unknown kind is dropped (isServerFeedItem).
//
// History: on every snapshot (page load, and each WS reconnect) it catches up from the last seq
// it saw, paging back until the workspace's 2 h window is covered (one page is only ~1 h of a busy
// fleet). A push or a response from another bootId means the server restarted and its seq
// restarted, so it refetches that boot from 0 (shared/features/feed.ts).

import { GOV_TAG_PREFIX, govTag, type FeedItem as ServerFeedItem, type FeedKind as ServerFeedKind, type FeedResponse } from "../../../shared/features/feed";
import { serverTripwireToFeed } from "../shell/feed";
import type { FeedItem } from "../shell/feed-types";
import type { ClientContext, ClientFeature } from "./registry";
import { WORKSPACE } from "./workspace-lib";

const SERVER_KINDS: readonly string[] = ["activity", "decision", "approval", "approval-resolved", "routine", "mac", "tripwire", "graduation"] satisfies readonly ServerFeedKind[];
const ROUTINE_CAP = 200;
/** The server's page cap (server/features/feed.ts). Its ring keeps every item for 2 h (and at
 *  least 1000): 12 pages cover the 2 h window up to ~50 items a minute; past that, the oldest
 *  part of the window is left to the Logs tab (the persisted town log). */
export const FEED_PAGE = 500;
const MAX_PAGES = 12;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";

export function isServerFeedItem(v: unknown): v is ServerFeedItem {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.seq === "number" &&
    typeof v.at === "string" &&
    typeof v.kind === "string" &&
    SERVER_KINDS.includes(v.kind) &&
    strOrNull(v.agentId) &&
    typeof v.title === "string" &&
    strOrNull(v.detail) &&
    strOrNull(v.tag)
  );
}

/** "owner/repo#123" at the very END of a graduation title (server/features/outcomes-lib.ts's
 *  graduationTitle always puts the PR/push/artifact it names last). Anchored on "$", not just a
 *  trailing "\b": a session named after an unrelated PR (e.g. "Fix acme-inc/acme-ai#554 review",
 *  which then ships #560) matches only the real trailing reference, never that earlier one, and a
 *  title server/heuristics.ts's sanitizeTitle truncated to 80 chars (always ending "…") correctly
 *  matches nothing rather than a truncated digit run. No match → no href: never guess. */
const PR_IN_TITLE_RE = /\b([a-z0-9._-]+\/[a-z0-9._-]+)#(\d{1,9})$/i;

export function graduationHref(title: string): string | undefined {
  const m = PR_IN_TITLE_RE.exec(title);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : undefined;
}

/** Which "graduation"-kind tags are true graduations. outcomes.ts tags its own items "shipped" /
 *  "delivered". server/features/careers-lib.ts's careerFeedItem (merged in #53) also emits kind
 *  "graduation" — the same wire kind — for a worker's move, tagged "career-trusted" (a real
 *  graduation: TRUST_RUNS clean runs in a row) but also "career-lapsed" and "career-probation"
 *  (bad news) and "career-returned" (neutral). Only the true ones get the 🎓 chip and join the
 *  Town square's shared "graduation" topic (workspace-lib.ts's feedCandidate); the rest go out as
 *  plain "system" info, like any other status line — never styled as a graduation. */
const GRADUATION_TAGS: ReadonlySet<string> = new Set(["shipped", "delivered", "career-trusted"]);

/** The server's "graduation" kind (a session's own graduation, or a career move that shares the
 *  wire kind) → a Feed item, demoted to "system" when its tag isn't a real graduation (see
 *  GRADUATION_TAGS). Never pinned (it is town news, not something to answer). Null on a kind
 *  mismatch or a timestamp that doesn't parse (defensive: isServerFeedItem checks shape, not date
 *  validity). */
function graduationToFeed(i: ServerFeedItem): FeedItem | null {
  if (i.kind !== "graduation") return null;
  const at = Date.parse(i.at);
  if (!Number.isFinite(at)) return null;
  const kind = i.tag !== null && GRADUATION_TAGS.has(i.tag) ? "graduation" : "system";
  return { id: i.id, kind, at, title: i.title, detail: i.detail ?? undefined, agentId: i.agentId ?? undefined, href: kind === "graduation" ? graduationHref(i.title) : undefined };
}

/** A governance decision (a "decision" item tagged "gov:<source>") → a Feed item: Jev's own
 *  ranking stays a "decision" (the Feed's Jev chip), every other source is "system". The store's
 *  own decisions (tag "grow"…) never match, so nothing is shown twice. Null otherwise, or on a
 *  timestamp that doesn't parse. */
function governanceToFeed(i: ServerFeedItem): FeedItem | null {
  if (i.kind !== "decision" || i.tag === null || !i.tag.startsWith(GOV_TAG_PREFIX)) return null;
  const at = Date.parse(i.at);
  if (!Number.isFinite(at)) return null;
  const item: FeedItem = { id: `srv:${i.id}`, kind: i.tag === govTag("jev") ? "decision" : "system", at, title: i.title, detail: i.detail ?? undefined, agentId: i.agentId ?? undefined };
  const href = i.tag === govTag("census") ? graduationHref(i.title) : undefined;
  return href ? { ...item, href } : item;
}

/** Splits a batch of server feed items into what the bridge forwards (pure, tested). */
export function bridgeItems(
  list: readonly unknown[],
  now = Date.now(),
): { tripwires: FeedItem[]; routines: ServerFeedItem[]; graduations: FeedItem[]; governance: FeedItem[] } {
  const items = list.filter(isServerFeedItem);
  return {
    tripwires: items.map((i) => serverTripwireToFeed(i, now)).filter((x): x is FeedItem => x !== null),
    routines: items.filter((i) => i.kind === "routine"),
    graduations: items.map(graduationToFeed).filter((x): x is FeedItem => x !== null),
    governance: items.map(governanceToFeed).filter((x): x is FeedItem => x !== null),
  };
}

/**
 * GET /api/feed from `since`, paging back (`before` = the oldest seq so far) until the history
 * reaches `from` (ms), the server has nothing older, or the boot changed under it. Items come back
 * validated, oldest first. Null when the server didn't answer.
 */
export async function fetchFeedWindow(get: (path: string) => Promise<FeedResponse | null>, since: number, from: number): Promise<FeedResponse | null> {
  const first = await get(`/api/feed?since=${since}&limit=${FEED_PAGE}`);
  if (!first || typeof first.bootId !== "string" || !Array.isArray(first.items)) return null;
  let page = first.items.filter(isServerFeedItem);
  let items = page;
  for (let n = 1; n < MAX_PAGES; n++) {
    const oldest = page[0];
    if (page.length < FEED_PAGE || !oldest || Date.parse(oldest.at) <= from || oldest.seq <= since + 1) break;
    const older = await get(`/api/feed?since=${since}&before=${oldest.seq}&limit=${FEED_PAGE}`);
    if (!older || older.bootId !== first.bootId || !Array.isArray(older.items)) break;
    page = older.items.filter((i): i is ServerFeedItem => isServerFeedItem(i) && i.seq < oldest.seq); // a server without `before` repeats the newest page
    if (!page.length) break;
    items = [...page, ...items];
  }
  return { ...first, items };
}

/** Which server boot the bridge is following, and the highest seq it has seen in it. */
export class FeedCursor {
  bootId: string | null = null;
  seq = 0;

  /** Where the next catch-up starts: 0 until a boot is known. */
  since(): number {
    return this.bootId === null ? 0 : this.seq;
  }

  /** Records what a response or push saw. False when it came from another boot: the server
   *  restarted, so the cursor now points at the start of the new boot (refetch from 0). */
  see(bootId: string, items: readonly ServerFeedItem[]): boolean {
    if (this.bootId !== null && bootId !== this.bootId) {
      this.bootId = bootId;
      this.seq = 0;
      return false;
    }
    this.bootId = bootId;
    for (const i of items) if (i.seq > this.seq) this.seq = i.seq;
    return true;
  }
}

class ServerFeedRoutines {
  private readonly byId = new Map<string, ServerFeedItem>();
  private readonly fns = new Set<() => void>();

  add(list: readonly ServerFeedItem[]): void {
    if (!list.length) return;
    for (const i of list) this.byId.set(i.id, i);
    if (this.byId.size > ROUTINE_CAP) {
      const oldest = [...this.byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      for (const i of oldest.slice(0, this.byId.size - ROUTINE_CAP)) this.byId.delete(i.id);
    }
    for (const fn of this.fns) fn();
  }

  items(): ServerFeedItem[] {
    return [...this.byId.values()];
  }

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

/** Routine runs seen on the server feed (for the global workspace). */
export const serverRoutines = new ServerFeedRoutines();

function take(list: readonly unknown[], ctx: ClientContext): void {
  const { tripwires, routines, graduations, governance } = bridgeItems(list);
  if (tripwires.length) ctx.feed.push(tripwires);
  if (graduations.length) ctx.feed.push(graduations);
  if (governance.length) ctx.feed.push(governance);
  serverRoutines.add(routines);
}

const cursor = new FeedCursor();

/** What the server emitted since the cursor (or, on a new boot, that whole boot), over 2 h back. */
async function catchUp(ctx: ClientContext): Promise<void> {
  const get = (path: string): Promise<FeedResponse | null> => ctx.api.getJson<FeedResponse>(path);
  const from = Date.now() - WORKSPACE.windowMs;
  let res = await fetchFeedWindow(get, cursor.since(), from);
  if (res && !cursor.see(res.bootId, res.items)) {
    res = await fetchFeedWindow(get, 0, from);
    if (res && !cursor.see(res.bootId, res.items)) return; // restarted again mid-fetch: the next snapshot catches up
  }
  if (res) take(res.items, ctx);
}

export const feedBridgeFeature: ClientFeature = {
  id: "feed",
  // Page load (right after mount) and every WS reconnect: what happened while this page wasn't listening.
  onSnapshot(_world, ctx) {
    void catchUp(ctx);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "items" || !Array.isArray(p.items)) return;
    if (typeof p.bootId === "string" && !cursor.see(p.bootId, p.items.filter(isServerFeedItem))) {
      void catchUp(ctx); // the server restarted: fetch the new boot from 0 (this push included)
      return;
    }
    take(p.items, ctx);
  },
};
