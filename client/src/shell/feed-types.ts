// The Feed's item shape. Its own file so the view contract (views.ts) and the store (feed.ts)
// can both import it without a cycle. See docs/VIEWS.md#feed.

import { icon } from "./icons";

/** One chip per kind in the Feed tab. Order = chip order. */
export const FEED_KINDS = ["approval", "awaiting", "tripwire", "decision", "graduation", "activity", "caption", "routine", "report", "system"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const FEED_KIND_LABEL: Record<FeedKind, string> = {
  approval: "Approvals",
  awaiting: "Waiting",
  tripwire: "Lessons",
  decision: "Jev",
  graduation: "Graduations",
  activity: "Activity",
  caption: "Captions",
  routine: "Routines",
  report: "Reports",
  system: "System",
};

/** Each kind's line icon (shell/icons.ts), drawn on its rows and its filter chip. */
export const FEED_KIND_ICON: Record<FeedKind, string> = {
  approval: "hand",
  awaiting: "hourglass",
  tripwire: "alert",
  decision: "moon",
  graduation: "cap",
  activity: "bolt",
  caption: "message",
  routine: "routines",
  report: "report",
  system: "info",
};

/** A Feed kind's icon as an `<svg>` string, at row size unless told otherwise. */
export function kindIcon(k: FeedKind, size = 15): string {
  return icon(FEED_KIND_ICON[k], size) ?? "";
}

/** How an actionable item ended. "gone" = it left the queue without us seeing why. */
export type FeedOutcome = "allow" | "deny" | "passthrough" | "expired" | "answered" | "gone";

export interface FeedApprovalRef {
  /** Approval id: POST /api/approvals/:id/decision. */
  id: string;
  toolName: string;
  /** ms epoch; after this the server hands it back to the terminal. */
  expiresAt: number;
}

export interface FeedItem {
  /** Dedupe key, stable per real event: "act:<activityId>", "dec:<decisionId>", "ap:<approvalId>"… */
  id: string;
  kind: FeedKind;
  /** ms epoch of the real event (not of when we saw it). */
  at: number;
  /** The one line people read. Real text only: never invented. */
  title: string;
  /** Optional second line (city, tool, preview title…). */
  detail?: string;
  /** Click → select + fly (agent wins over city). */
  agentId?: string;
  cityId?: string;
  /** Present on approval items: the Feed renders hold-to-confirm Approve / Deny. */
  approval?: FeedApprovalRef;
  /** Open items (approvals, agents waiting on you) sit pinned at the top until resolved. */
  pinned?: boolean;
  /** Set once an actionable item is decided / no longer open. Pinned items then drop into the stream. */
  outcome?: FeedOutcome;
  /** Optional link (e.g. a report's HTML). Opened in a new tab. */
  href?: string;
}

/** What views and features may do with the Feed. */
export interface FeedSink {
  /** Add (or update, same id) one or more items. Returns true when something changed. */
  push(items: FeedItem | readonly FeedItem[]): boolean;
  /** Mark an actionable item decided / closed (unpins it). */
  resolve(id: string, outcome: FeedOutcome): void;
}
