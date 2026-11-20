import type {
  AgentActivity,
  Island,
  JevDecision,
  JevState,
  WorldAgent,
  WorldEdge,
  WorldObject,
  WorldSnapshot,
  WorldStats,
} from "../../shared/types";
import { redactActivity, redactAgent, redactOn } from "./redact";

const ACTIVITY_RING = 50;

type Fn<A extends unknown[]> = (...args: A) => void;

/** Central mutable store for the world. Renderer modules subscribe to the
 * `on*` events instead of polling; net.ts / main.ts push data in. */
export class WorldStore {
  islands = new Map<string, Island>();
  agents = new Map<string, WorldAgent>();
  objects = new Map<string, WorldObject>();
  edges: WorldEdge[] = [];
  jev: JevState = { status: "disabled", lastTickAt: null, decisions: [] };
  generatedAt = "";
  /** Null until the server sends stats (older servers never do). */
  stats: WorldStats | null = null;
  /** Newest last, capped ring buffer of real activity lines. */
  activities: AgentActivity[] = [];

  private snapshotListeners = new Set<Fn<[]>>();
  private agentListeners = new Set<Fn<[WorldAgent[]]>>();
  private objectListeners = new Set<Fn<[WorldObject[]]>>();
  private edgeListeners = new Set<Fn<[WorldEdge[]]>>();
  private decisionListeners = new Set<Fn<[JevDecision, JevState["status"]]>>();
  private activityListeners = new Set<Fn<[AgentActivity[]]>>();
  private statsListeners = new Set<Fn<[WorldStats | null]>>();
  private removedListeners = new Set<Fn<[string[]]>>();
  private objectsRemovedListeners = new Set<Fn<[string[]]>>();

  loadSnapshot(world: WorldSnapshot): void {
    if (redactOn()) world = { ...world, agents: world.agents.map(redactAgent) };
    this.islands = new Map(world.islands.map((i) => [i.id, i]));
    this.agents = new Map(world.agents.map((a) => [a.id, a]));
    this.objects = new Map(world.objects.map((o) => [o.id, o]));
    this.edges = world.edges.slice();
    this.jev = world.jev;
    this.generatedAt = world.generatedAt;
    this.stats = (world as Partial<WorldSnapshot>).stats ?? null;
    for (const fn of this.snapshotListeners) fn();
    for (const fn of this.statsListeners) fn(this.stats);
  }

  upsertAgents(agents: WorldAgent[]): void {
    if (redactOn()) agents = agents.map(redactAgent);
    for (const a of agents) this.agents.set(a.id, a);
    for (const fn of this.agentListeners) fn(agents);
  }

  /** Retired agents leave the store; listeners get only the ids that were actually present. */
  removeAgents(ids: readonly string[]): void {
    const gone = ids.filter((id) => this.agents.delete(id));
    if (!gone.length) return;
    for (const fn of this.removedListeners) fn(gone);
  }

  upsertObjects(objects: WorldObject[]): void {
    for (const o of objects) this.objects.set(o.id, o);
    for (const fn of this.objectListeners) fn(objects);
  }

  /** Objects the server no longer serves leave the store; listeners get only the ids that were present. */
  removeObjects(ids: readonly string[]): void {
    const gone = ids.filter((id) => this.objects.delete(id));
    if (!gone.length) return;
    for (const fn of this.objectsRemovedListeners) fn(gone);
  }

  /** An "edges" message is the whole served set (server/index.ts sends buildWorldViews().edges when it
   * changed), so it REPLACES the store's edges; appending grew the array on every pass. Listeners
   * get the full set too. */
  setEdges(edges: WorldEdge[]): void {
    this.edges = edges.slice();
    for (const fn of this.edgeListeners) fn(this.edges);
  }

  addDecision(decision: JevDecision, jevStatus: JevState["status"]): void {
    this.jev = {
      status: jevStatus,
      lastTickAt: decision.at,
      decisions: [decision, ...this.jev.decisions].slice(0, 50),
    };
    for (const fn of this.decisionListeners) fn(decision, jevStatus);
  }

  addActivities(list: AgentActivity[]): void {
    if (redactOn()) list = list.map(redactActivity);
    const seen = new Set(this.activities.map((a) => a.id));
    const fresh = list.filter((a) => !seen.has(a.id));
    if (!fresh.length) return;
    this.activities = [...this.activities, ...fresh].slice(-ACTIVITY_RING);
    for (const fn of this.activityListeners) fn(fresh);
  }

  setStats(stats: WorldStats): void {
    this.stats = stats;
    for (const fn of this.statsListeners) fn(stats);
  }

  /** Stats from the server when present, otherwise counted from the agents we have (tokens unknown). */
  effectiveStats(): { liveCount: number; awaitingCount: number; tokensToday: number | null } {
    const agents = [...this.agents.values()];
    const liveCount = agents.filter((a) => a.status === "live").length;
    const awaitingCount = agents.filter((a) => a.awaitingInput === true).length;
    if (this.stats) return { ...this.stats };
    return { liveCount, awaitingCount, tokensToday: null };
  }

  onActivity(fn: Fn<[AgentActivity[]]>): void {
    this.activityListeners.add(fn);
  }
  onStats(fn: Fn<[WorldStats | null]>): void {
    this.statsListeners.add(fn);
  }

  onSnapshot(fn: Fn<[]>): void {
    this.snapshotListeners.add(fn);
  }
  onAgents(fn: Fn<[WorldAgent[]]>): void {
    this.agentListeners.add(fn);
  }
  onAgentsRemoved(fn: Fn<[string[]]>): void {
    this.removedListeners.add(fn);
  }
  onObjects(fn: Fn<[WorldObject[]]>): void {
    this.objectListeners.add(fn);
  }
  onObjectsRemoved(fn: Fn<[string[]]>): void {
    this.objectsRemovedListeners.add(fn);
  }
  onEdges(fn: Fn<[WorldEdge[]]>): void {
    this.edgeListeners.add(fn);
  }
  onDecision(fn: Fn<[JevDecision, JevState["status"]]>): void {
    this.decisionListeners.add(fn);
  }
}
