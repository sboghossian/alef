// Client store for the Town square's global workspace (workspace-lib.ts has the maths). It
// gathers every real signal source the client has, carries the slot's hysteresis state from one
// run to the next, and tells the Town square panel (views/room.ts) and the Feed tab's header
// (shell/feed-ui.ts) when the top 5 changed. Not a feature itself: shell/feed-sources.ts wires it,
// because the live Feed (FeedStore) is only reachable there. Runs at most once a second on any
// source change, and every 15 s so decay can move things in and out.

import type { FeedStore } from "../shell/feed";
import { currentHealthSummary, onHealthChange } from "./completeness";
import { serverRoutines } from "./feed-bridge";
import { currentPresidentBoard, onPresidentUpdate } from "./president";
import type { ClientContext } from "./registry";
import { residentData } from "./resident-data";
import { subagentData } from "./subagent-data";
import { onTalkChange, strandedDispatches } from "./talk";
import { villageData } from "./village-data";
import {
  EMPTY_WORKSPACE,
  agentLookup,
  gatherCandidates,
  selectWorkspace,
  type AgentLookup,
  type WorkspaceIsland,
  type WorkspaceResult,
  type WorkspaceSlot,
  type WorkspaceSources,
} from "./workspace-lib";

const DECAY_TICK_MS = 15_000;
const THROTTLE_MS = 1_000;

class WorkspaceData {
  result: WorkspaceResult = EMPTY_WORKSPACE;
  private slot: WorkspaceSlot = {};
  private sig = "";
  private readonly fns = new Set<() => void>();

  /** One scoring run. Notifies only when what the slot shows changed. */
  update(sources: WorkspaceSources, lookup: AgentLookup, now: number): void {
    const { observed, candidates } = gatherCandidates(sources, lookup, now);
    const res = selectWorkspace(candidates, this.slot, now, observed);
    this.slot = res.slot;
    this.result = res;
    const sig = JSON.stringify([res.top.map((e) => [e.key, e.text, e.reason, e.agentIds[0] ?? ""]), res.counts]);
    if (sig === this.sig) return;
    this.sig = sig;
    for (const fn of this.fns) fn();
  }

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

export const workspaceData = new WorkspaceData();

/** Every live source, read now. The resident comes from its own live store (resident-data.ts:
 *  snapshot, WS pushes and Approve / Dismiss results), not the snapshot-only village copy.
 *  `islands` defaults to none (a caller with no island list — e.g. a test — just gets stranded
 *  launches with no district, never a crash). */
export function workspaceSources(feed: Pick<FeedStore, "list">, islands: readonly WorkspaceIsland[] = []): WorkspaceSources {
  return {
    feed: feed.list(),
    messages: villageData.messages,
    subagents: [...subagentData.records.values()],
    runEndings: [...subagentData.runEndings.values()],
    resident: residentData.state,
    serverFeed: serverRoutines.items(),
    stranded: strandedDispatches(),
    islands,
    health: currentHealthSummary(),
    presidentBoard: currentPresidentBoard(),
  };
}

export function wireWorkspace(ctx: ClientContext, feed: FeedStore): void {
  const store = ctx.store;
  const lookup = agentLookup(() => store.agents);
  let timer = 0;
  const run = (): void => {
    timer = 0;
    workspaceData.update(workspaceSources(feed, [...store.islands.values()]), lookup, Date.now());
  };
  const soon = (): void => {
    if (!timer) timer = window.setTimeout(run, THROTTLE_MS);
  };
  feed.onChange(soon);
  villageData.onChange(soon);
  residentData.onChange(soon);
  subagentData.onChange(soon);
  subagentData.onRunEndings(soon);
  serverRoutines.onChange(soon);
  onTalkChange(soon);
  onPresidentUpdate(soon);
  onHealthChange(soon);
  store.onAgents(soon);
  store.onSnapshot(soon);
  window.setInterval(soon, DECAY_TICK_MS);
  run();
}
