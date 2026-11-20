// P4a item 2 — tool-station props at every LIVE agent's lot: five small markers (bash, edit,
// read, web, mcp — the same five the Feed/Canvas already colour via shared/stations.ts) planted
// in a tiny ring beside the house. The one matching the agent's current tool call pops and holds
// a brighter colour for ~0.8s, then eases back — "you can see what your fleet is doing" at a
// glance, RTS-style. One shared geometry, ONE InstancedMesh (the whole feature is one of the
// round-10 perf budget's four extra draw calls), coloured per instance via instanceColor.
//
// Not a ClientFeature itself: built once by game-feel.ts (which owns the scene subscriptions)
// and driven from its onFrame/onActivity hooks, the way subagents-drones.ts is built by the
// "subagents" feature.

import * as THREE from "three";
import { STATIONS, stationOf, type StationId } from "../../../../shared/stations";
import type { AgentActivity } from "../../../../shared/types";
import { merge, painted, toon } from "../../scene/toon";
import type { ClientContext } from "../registry";

/** Only these five get a physical prop; skill/hook/mcp-as-Harness-building, subagent/plan/other
 *  are represented elsewhere (Harness City, the drone swarm, the todo card). */
const PROPS: readonly StationId[] = ["bash", "edit", "read", "web", "mcp"];
const MAX_LIVE_AGENTS = 40;
const RING_RADIUS = 0.85;
const PULSE_S = 0.8;

function propGeometry(): THREE.BufferGeometry {
  // A little signpost: a base plinth + a thin post + a small head — one silhouette, distinguished
  // by colour (the same colour language as the Feed's chips and Harness City's buildings) rather
  // than five different shapes, to stay inside the draw-call budget.
  return merge([
    painted(new THREE.CylinderGeometry(0.16, 0.19, 0.1, 8).translate(0, 0.05, 0), 0xffffff),
    painted(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 6).translate(0, 0.26, 0), 0xffffff),
    painted(new THREE.SphereGeometry(0.12, 10, 8).translate(0, 0.46, 0), 0xffffff),
  ]);
}

export interface StationProps {
  group: THREE.Group;
  /** Rebuild the live-agent list (call after store.onAgents / onSnapshot). */
  markDirty(): void;
  /** A tool call landed: pulses the matching prop if the agent is tracked. */
  onActivity(activities: readonly AgentActivity[], elapsed: number): void;
  /** Recomputes positions (only when dirty) and pulse scales — call every game-feel frame. */
  update(elapsed: number, ctx: ClientContext): void;
}

export function buildStationProps(ctx: ClientContext): StationProps {
  const capacity = MAX_LIVE_AGENTS * PROPS.length;
  const mesh = new THREE.InstancedMesh(propGeometry(), toon(0xffffff, { vertexColors: true }), capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = "station-props";
  const group = new THREE.Group();
  group.name = "station-props-group";
  group.add(mesh);
  ctx.scene.add(group);

  let dirty = true;
  let liveIds: string[] = [];
  /** agentId -> its 5 slot indices, in PROPS order. */
  let slotsOf = new Map<string, number[]>();
  const pulseUntil = new Float32Array(capacity);
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  function rebuild(ctx2: ClientContext): void {
    dirty = false;
    liveIds = [...ctx2.store.agents.values()]
      .filter((a) => a.status === "live")
      .map((a) => a.id)
      .slice(0, MAX_LIVE_AGENTS);
    const next = new Map<string, number[]>();
    let i = 0;
    for (const id of liveIds) {
      const indices: number[] = [];
      for (let k = 0; k < PROPS.length; k++) indices.push(i++);
      next.set(id, indices);
    }
    slotsOf = next;
    mesh.count = i;
    for (const id of liveIds) {
      const indices = slotsOf.get(id);
      if (!indices) continue;
      indices.forEach((idx, k) => {
        const stationId = PROPS[k];
        if (stationId) mesh.setColorAt(idx, color.set(STATIONS[stationId].color));
        pulseUntil[idx] = 0;
      });
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    group,
    markDirty() {
      dirty = true;
    },
    onActivity(activities, elapsed) {
      for (const a of activities) {
        const indices = slotsOf.get(a.agentId);
        if (!indices) continue;
        const st = stationOf(a.toolName);
        const k = PROPS.indexOf(st);
        if (k < 0) continue;
        const idx = indices[k];
        if (idx !== undefined) pulseUntil[idx] = elapsed + PULSE_S;
      }
    },
    update(elapsed, ctx2) {
      if (dirty) rebuild(ctx2);
      for (const id of liveIds) {
        const roof = ctx2.agentPosition(id);
        const indices = slotsOf.get(id);
        if (!roof || !indices) continue;
        up.copy(roof).normalize();
        t1.copy(Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : Y).cross(up).normalize();
        t2.copy(up).cross(t1).normalize();
        q.setFromUnitVectors(Y, up);
        const ground = ctx2.surfacePoint(up, 0.15);
        indices.forEach((idx, k) => {
          const angle = (k / PROPS.length) * Math.PI * 2;
          p.copy(ground).addScaledVector(t1, Math.cos(angle) * RING_RADIUS).addScaledVector(t2, Math.sin(angle) * RING_RADIUS);
          const pulseLeft = pulseUntil[idx] ?? 0;
          const active = pulseLeft > elapsed;
          const pop = active ? 1 + 0.35 * Math.sin(((pulseLeft - elapsed) / PULSE_S) * Math.PI) : 1;
          s.setScalar(0.62 * pop);
          m.compose(p, q, s);
          mesh.setMatrixAt(idx, m);
        });
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
