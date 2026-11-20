// Pure, DOM/Notification-free helpers for making "an agent is waiting on you" visible outside
// the tab: the tab title prefix, the favicon badge, and which agents just started waiting (for
// the opt-in desktop notification in waiting-notify.ts). No DOM, no Notification API, no I/O —
// safe to unit test directly.

export interface WaitingAgent {
  id: string;
  awaitingInput: boolean;
}

/** Ids of agents awaiting input right now. */
export function waitingIds(agents: readonly WaitingAgent[]): Set<string> {
  return new Set(agents.filter((a) => a.awaitingInput === true).map((a) => a.id));
}

/** How many agents are waiting right now — the tab-title prefix / favicon-badge count. */
export function countWaiting(agents: readonly WaitingAgent[]): number {
  return waitingIds(agents).size;
}

/** shell.ts is document.title's one owner: this composes its existing view-name title with the
 *  waiting count rather than anything overwriting it. No waiting agents leaves the view title
 *  untouched. */
export function titleFor(viewTitle: string, waitingCount: number): string {
  return waitingCount > 0 ? `(${waitingCount}) ${viewTitle}` : viewTitle;
}

const FAVICON_BG = "#1a1030"; // --ink
const FAVICON_DOT = "#ff4d8d"; // --pink — same red the in-app "waiting" badges use (.alef-badge)

/** A plain circle at rest; the same circle with a red dot badge while N > 0. A static inline SVG
 *  data URI, not a canvas — deterministic and trivial to swap back on the way to N = 0. */
export function faviconHref(waitingCount: number): string {
  const dot = waitingCount > 0 ? `<circle cx="25" cy="7" r="6" fill="${FAVICON_DOT}" stroke="#fff8e7" stroke-width="1.5"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="15" cy="16" r="13" fill="${FAVICON_BG}"/>${dot}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface WaitingTransition {
  /** Agent ids that just went false → true since `prev` — fire the desktop notification for these, once each. */
  fired: string[];
  /** Pass this back in as `prev` on the next call. */
  now: Set<string>;
}

/**
 * A false → true transition per agent id, deduped against `prev`: an id already in `prev` is
 * still waiting (true → true) and does not fire again. An id that drops out of `now` (true →
 * false) is no longer tracked, so the next time it starts waiting it fires again — "re-armed".
 *
 * Seed `prev` from `waitingIds()` of the FIRST snapshot (not an empty set) so agents already
 * waiting when the page loads never fire a notification on load — only genuinely new waits do.
 */
export function waitingTransition(prev: ReadonlySet<string>, agents: readonly WaitingAgent[]): WaitingTransition {
  const now = waitingIds(agents);
  const fired = [...now].filter((id) => !prev.has(id));
  return { fired, now };
}
