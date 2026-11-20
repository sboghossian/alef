// Wires every real event source into the Feed: activity + captions and Jev decisions from the
// store, agents that start / stop waiting on you, open approvals (approvals feature) and routine
// runs (routines feature). Reports are pushed by their features (quick-prompts, replay).
// Last, the Town square's global workspace, which scores all of the above (and more).

import { isFeedDecision } from "../../../shared/features/feed";
import type { Routine } from "../../../shared/features/routines";
import type { JevDecision } from "../../../shared/types";
import { onApprovalsChange, pendingApprovals } from "../features/approvals";
import type { ClientContext } from "../features/registry";
import { onRoutines } from "../features/routines";
import { wireWorkspace } from "../features/workspace-data";
import { cityDisplayName } from "../ui/world";
import { activityToFeed, approvalToFeed, awaitingDiff, awaitingToFeed, decisionToFeed, routineRunsToFeed, type AgentNamer, type FeedStore } from "./feed";
import { agentTitle } from "../../../shared/display";

export function wireFeedSources(ctx: ClientContext, feed: FeedStore): void {
  const store = ctx.store;
  // What already happened before this page loaded is history, not "new" (no noisy tab badge).
  feed.markSeen();
  const cityName = (id: string): string => {
    const i = store.islands.get(id);
    return i ? cityDisplayName(i) : id;
  };
  const who: AgentNamer = (id) => {
    const a = store.agents.get(id);
    return a ? { title: agentTitle(a), city: cityName(a.islandId) } : undefined;
  };

  // Activity + captions: what already happened (the store's ring) and everything new.
  const pushActivities = (list: typeof store.activities): void => {
    feed.push(list.map((a) => activityToFeed(a, who)).filter((x): x is NonNullable<typeof x> => x !== null));
  };
  pushActivities(store.activities);
  store.onActivity(pushActivities);

  // Jev's official results (not the planet's growth steps: isFeedDecision).
  const pushDecisions = (list: readonly JevDecision[]): void => {
    feed.push(list.filter(isFeedDecision).map((d) => decisionToFeed(d)));
  };
  pushDecisions(store.jev.decisions);
  store.onDecision((d) => pushDecisions([d]));
  store.onSnapshot(() => pushDecisions(store.jev.decisions));

  // Agents waiting on you: pinned while they wait.
  let waiting = new Set<string>();
  const openWaits = new Map<string, string>(); // agentId → feed item id
  const syncWaiting = (): void => {
    const d = awaitingDiff(waiting, [...store.agents.values()]);
    for (const a of d.started) {
      const item = awaitingToFeed(a, cityName(a.islandId));
      openWaits.set(a.id, item.id);
      feed.push(item);
    }
    for (const id of d.stopped) {
      const itemId = openWaits.get(id);
      if (itemId) feed.resolve(itemId, "answered");
      openWaits.delete(id);
    }
    waiting = d.now;
  };
  syncWaiting();
  store.onAgents(syncWaiting);
  store.onSnapshot(syncWaiting);

  // Approvals: open ones pinned with hold-to-confirm; gone ones closed.
  const openApprovals = new Set<string>();
  const syncApprovals = (): void => {
    const now = new Set<string>();
    for (const a of pendingApprovals()) {
      const item = approvalToFeed(a, who);
      now.add(item.id);
      if (!openApprovals.has(item.id)) feed.push(item);
    }
    for (const id of openApprovals) if (!now.has(id)) feed.resolve(id, "gone");
    openApprovals.clear();
    for (const id of now) openApprovals.add(id);
  };
  syncApprovals();
  onApprovalsChange(syncApprovals);

  // Routine runs: diff consecutive lists.
  let prevRoutines: Routine[] | null = null;
  onRoutines((list) => {
    feed.push(routineRunsToFeed(prevRoutines, list));
    prevRoutines = list.map((r) => ({ ...r }));
  });

  wireWorkspace(ctx, feed);
}
