// Covers the second "Automated Runs" live-update leftover (docs/FEATURES.md, PR #22 follow-up):
// a plane already flying home when moveHouse relocates its house must retarget its landing to the
// new lot instead of arriving at the old city. house-home.ts's planeHome is the pure seam that
// decides *where* home now is; this exercises the actual retarget through AgentsVisual, since the
// flight itself (PlaneState, startLeg) lives in this module's closure, not in a pure function.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { WorldAgent } from "../../../shared/types";
import type { CityLayout } from "../layout";
import { tangentBasis } from "../topic-layout";
import { buildAgents } from "./agents";
import { PickRegistry } from "./pick";

function city(id: string, dir: THREE.Vector3): CityLayout {
  const d = dir.clone().normalize();
  const [t1, t2] = tangentBasis(d);
  return { id, dir: d, t1, t2, radius: 3, lots: 0, rank: 0 };
}

function agent(overrides: Partial<WorldAgent> & Pick<WorldAgent, "id" | "islandId" | "targetIslandId">): WorldAgent {
  return {
    cwd: "/x",
    title: "t",
    status: "live",
    startedAt: "2026-09-27T00:00:00Z",
    lastActive: "2026-09-27T00:00:00Z",
    messageCount: 1,
    model: null,
    role: "generalist",
    color: "#8855ff",
    tokens: 0,
    awaitingInput: false,
    ...overrides,
  };
}

describe("AgentsVisual.moveHouse", () => {
  it("retargets a plane already flying home so it lands at the new lot, not the old city", () => {
    // Home, its roaming target, and the automation lot the house moves into are mutually
    // orthogonal, so "which city is it heading toward" is unambiguous from the plane's direction.
    const home = city("home", new THREE.Vector3(0, 0, 1));
    const away = city("away", new THREE.Vector3(1, 0, 0));
    const lot = city("auto:/daily-recap", new THREE.Vector3(0, 1, 0));
    const layout = new Map([
      ["home", home],
      ["away", away],
    ]);
    const visual = buildAgents({
      agents: [agent({ id: "s1", islandId: "home", targetIslandId: "away" })],
      layout,
      fileLots: new Map(),
      pick: new PickRegistry(),
    });
    expect(visual.flyingPlanes().some((p) => p.agentId === "s1")).toBe(true);

    let elapsed = 0;
    const tick = (dt: number, n: number): void => {
      for (let i = 0; i < n; i++) {
        visual.update(dt, elapsed);
        elapsed += dt;
      }
    };
    tick(0.5, 8); // partway on the outbound leg to "away"

    // The session comes home: the plane starts flying back from wherever it is now, not from home.
    visual.upsert(agent({ id: "s1", islandId: "home", targetIslandId: "home" }));
    tick(0.5, 4); // partway on the return leg, still airborne

    // A new automation lot appears mid-flight (features/archive.ts's onAgentsUpserted): the house
    // moves, and the plane already headed home must retarget instead of landing at the old city.
    expect(visual.moveHouse("s1", lot, 0, 0, 0)).toBe(true);

    let lastPos: THREE.Vector3 | undefined;
    for (let i = 0; i < 4000 && visual.flyingPlanes().some((p) => p.agentId === "s1"); i++) {
      visual.update(0.05, elapsed);
      elapsed += 0.05;
      const p = visual.flyingPlanes().find((p) => p.agentId === "s1");
      if (p) lastPos = p.pos.clone();
    }

    expect(lastPos).toBeDefined();
    expect(lastPos!.clone().normalize().angleTo(lot.dir)).toBeLessThan(0.05); // landed at the lot
    expect(lastPos!.clone().normalize().angleTo(home.dir)).toBeGreaterThan(1); // not the old city
  });

  it("leaves an outbound plane alone: moveHouse never redirects a flight to somewhere else entirely", () => {
    const home = city("home", new THREE.Vector3(0, 0, 1));
    const away = city("away", new THREE.Vector3(1, 0, 0));
    const lot = city("auto:/daily-recap", new THREE.Vector3(0, 1, 0));
    const layout = new Map([
      ["home", home],
      ["away", away],
    ]);
    const visual = buildAgents({
      agents: [agent({ id: "s1", islandId: "home", targetIslandId: "away" })],
      layout,
      fileLots: new Map(),
      pick: new PickRegistry(),
    });

    let elapsed = 0;
    visual.update(1, elapsed); // still outbound, nowhere near "away" yet
    elapsed += 1;
    visual.moveHouse("s1", lot, 0, 0, 0);
    // The plane is still mid-flight to "away" — a house move must not touch that leg's target.
    for (let i = 0; i < 400 && visual.flyingPlanes().some((p) => p.agentId === "s1"); i++) {
      visual.update(0.05, elapsed);
      elapsed += 0.05;
    }
    // It should have arrived (and be holding) at "away", never having been diverted to the lot.
    const p = visual.flyingPlanes().find((p) => p.agentId === "s1");
    expect(p).toBeDefined();
    expect(p!.pos.clone().normalize().angleTo(away.dir)).toBeLessThan(0.3);
  });
});
