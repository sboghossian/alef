// Agent states leave /api/world (one row per session ever indexed) for their own GET route; the
// WS keeps pushing only the states that changed.

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { AGENT_STATES_PATH, type AgentStatesResponse } from "../../shared/features/agent-state.js";
import type { WorldAgent } from "../../shared/types.js";
import { createAgentStateFeature } from "../features/agent-state.js";
import { FleetTracker } from "../features/fleet-tracker.js";
import type { FeatureContext } from "../features/registry.js";
import { makeTempProjectsDir } from "./helpers.js";

const agent = (id: string, status: WorldAgent["status"]): WorldAgent => ({
  id,
  islandId: "i",
  cwd: "/w",
  title: "t",
  displayName: null,
  status,
  startedAt: new Date().toISOString(),
  lastActive: new Date().toISOString(),
  messageCount: 1,
  model: null,
  role: "builder",
  color: "#fff",
  targetIslandId: "i",
  tokens: 0,
  awaitingInput: false,
});

async function get(feature: ReturnType<typeof createAgentStateFeature>, ctx: FeatureContext): Promise<AgentStatesResponse> {
  const route = feature.routes?.find((r) => r.method === "GET" && r.path === AGENT_STATES_PATH);
  let body = "";
  const res = { writeHead: () => res, end: (d: Buffer) => (body = d.toString()) } as unknown as ServerResponse;
  await route?.handler({} as IncomingMessage, res, ctx, {});
  return JSON.parse(body) as AgentStatesResponse;
}

describe("GET /api/agent-state", () => {
  it("serves every agent's state, which the snapshot no longer carries", async () => {
    const projectsDir = await makeTempProjectsDir();
    const emitted: unknown[] = [];
    const ctx = {
      config: { projectsDir },
      worldViews: () => ({ agents: [agent("a", "live"), agent("b", "dormant")], objects: [], edges: [], islands: [] }),
      emit: (p: unknown) => emitted.push(p),
    } as unknown as FeatureContext;
    const feature = createAgentStateFeature(new FleetTracker(), () => new Set(), () => true);

    expect(await get(feature, ctx)).toEqual({ states: {} }); // before the first tick
    await feature.onTick?.(ctx);
    expect(await get(feature, ctx)).toEqual({ states: { a: "working", b: "sleeping" } });
    expect(emitted).toEqual([{ kind: "states", states: { a: "working", b: "sleeping" } }]);
    expect(feature.snapshotExtras).toBeUndefined();
  });
});
