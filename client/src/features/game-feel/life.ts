// P4a items 1, 5, 6 — the planet's ambient "life": syncing each agent's game-feel state into
// scene/agents.ts (state -> creature animation, item 1), day/night driving house/tower windows
// plus two small bird flocks (item 5), a sleeping agent's rising sparkle at night, and a house
// "pop" + dispatch car for a brand-new live session (item 6). Not a ClientFeature itself — built
// once and driven every frame by game-feel.ts, the way subagents-drones.ts is built and driven
// by the "subagents" feature.

import * as THREE from "three";
import type { AgentState } from "../../../../shared/features/agent-state";
import type { Island } from "../../../../shared/types";
import { sceneParts } from "../../scene/scene-bus";
import { toon } from "../../scene/toon";
import { agentStateOf } from "../agent-state";
import type { ClientContext } from "../registry";
import { daylightFactor, parseDebugOverrides, type DebugOverrides } from "../sky-lib";
import { getSkyState } from "../sky-state";
import { activityRate01 } from "./game-feel-lib";
import { qualityController } from "./quality";

const SYNC_EVERY_S = 1;
const NIGHT_EVERY_S = 2;
const BIRDS_PER_FLOCK = 12;
const Z_CAPACITY = 24;
const Z_LIFE_S = 2.6;
const Y = new THREE.Vector3(0, 1, 0);
const DEMO_ORDER: readonly AgentState[] = ["working", "permission", "waiting", "idle", "sleeping"];
/** `?demo=states` (P4a only): every agent gets a deterministic, cycling state instead of the
 *  real agent-state feed, for stable Playwright screenshots of every pose. */
const DEMO_STATES = typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "states";

/** Mirrors sky.ts's `effectiveNow()` so `?time=HH:MM` (used for deterministic screenshots)
 *  drives day/night here the same way it drives the sky dome. sky.ts owns the real clock and
 *  doesn't export it, so this is the small, deliberate bit of glue duplication. */
function effectiveNowMs(debug: DebugOverrides): number {
  if (debug.timeOfDayMin === null) return Date.now();
  const d = new Date();
  d.setHours(Math.floor(debug.timeOfDayMin / 60), debug.timeOfDayMin % 60, 0, 0);
  return d.getTime();
}

/** A small flattened wedge — reads as a bird silhouette from orbit distance. One geometry for
 *  both flocks (one of the round-10 perf budget's four extra draw calls). */
function birdGeometry(): THREE.BufferGeometry {
  return new THREE.ConeGeometry(0.16, 0.5, 3).rotateX(Math.PI / 2).scale(1, 1, 0.35);
}

/** The sleeping-agent "sparkle" (simplified from a literal "Z" glyph — a canvas-drawn texture
 *  would add real risk for a cosmetic flourish — to a small rising diamond mote; still ≤24
 *  instanced quads, night only, per the round-10 budget). */
function moteGeometry(): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(0.16, 0);
}

export interface Life {
  /** Call after store.onAgents / onSnapshot: the live/sleeping id lists are stale. */
  markAgentsDirty(): void;
  /** Call every game-feel frame. */
  update(elapsed: number, ctx: ClientContext): void;
}

export function buildLife(ctx: ClientContext): Life {
  const debug = parseDebugOverrides(location.search);

  const birdMesh = new THREE.InstancedMesh(birdGeometry(), toon(0xfff3d6), BIRDS_PER_FLOCK * 2);
  birdMesh.count = 0;
  birdMesh.frustumCulled = false;
  birdMesh.name = "birds";
  ctx.scene.add(birdMesh);

  const moteMesh = new THREE.InstancedMesh(
    moteGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xdcebff, transparent: true, opacity: 0.8, depthWrite: false }),
    Z_CAPACITY,
  );
  moteMesh.count = 0;
  moteMesh.frustumCulled = false;
  moteMesh.name = "sleep-motes";
  ctx.scene.add(moteMesh);

  let nightGlow = 0;
  let lastNightAt = -Infinity;
  let lastSyncAt = -Infinity;
  let agentsDirty = true;
  let sleepingIds: string[] = [];
  // Arrivals (item 6): seeded from whatever is already live at boot, so the first snapshot
  // never reads as 7 simultaneous "arrivals".
  let seenLive = new Set<string>([...ctx.store.agents.values()].filter((a) => a.status === "live").map((a) => a.id));

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const pos = new THREE.Vector3();

  ctx.store.onAgents((agents) => {
    for (const a of agents) {
      if (a.status === "live" && !seenLive.has(a.id)) {
        sceneParts().agents?.popHouse(a.id);
        sceneParts().agents?.spawnDispatchCar(a.islandId, ctx.elapsed());
      }
    }
    seenLive = new Set([...ctx.store.agents.values()].filter((a) => a.status === "live").map((a) => a.id));
    agentsDirty = true;
  });
  ctx.store.onAgentsRemoved(() => {
    agentsDirty = true;
  });

  function refreshAgentLists(): void {
    agentsDirty = false;
    sleepingIds = [...ctx.store.agents.values()]
      .filter((a) => a.status !== "live")
      .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))
      .slice(0, Z_CAPACITY)
      .map((a) => a.id);
  }

  function syncAnim(nowMs: number): void {
    const agentsVisual = sceneParts().agents;
    if (!agentsVisual) return;
    const demoIndex = DEMO_STATES ? new Map([...ctx.store.agents.keys()].sort().map((id, i) => [id, i])) : null;
    for (const a of ctx.store.agents.values()) {
      let state: AgentState;
      if (demoIndex) {
        const i = demoIndex.get(a.id) ?? 0;
        state = DEMO_ORDER[i % DEMO_ORDER.length] ?? "idle";
      } else {
        state = agentStateOf(a.id) ?? (a.status === "live" ? "working" : "sleeping");
      }
      const rate = state === "working" ? activityRate01(ctx.store.activities, a.id, nowMs) : 0;
      agentsVisual.setAnim(a.id, state, rate);
    }
  }

  function syncNight(): void {
    const sky = getSkyState();
    const sunrise = sky?.weather.sunrise ? Date.parse(sky.weather.sunrise) : NaN;
    const sunset = sky?.weather.sunset ? Date.parse(sky.weather.sunset) : NaN;
    const day = daylightFactor(effectiveNowMs(debug), Number.isFinite(sunrise) ? sunrise : null, Number.isFinite(sunset) ? sunset : null);
    nightGlow = Math.max(0, Math.min(1, -day));
    sceneParts().agents?.setNightGlow(nightGlow);
    sceneParts().cities?.setNightGlow(nightGlow);
  }

  const X_AXIS = new THREE.Vector3(1, 0, 0);
  function tangentFrame(dir: THREE.Vector3): void {
    up.copy(dir).normalize();
    t1.copy(Math.abs(up.y) > 0.9 ? X_AXIS : Y).cross(up).normalize();
    t2.copy(up).cross(t1).normalize();
  }

  const moteDir = new THREE.Vector3();
  let flockSource: ReadonlyMap<string, Island> | null = null;
  let flockCities: Island[] = [];
  function updateBirds(elapsed: number): void {
    // Perf budget's tier table: tier 2 = no birds at all; tier 1 = "fewer bird flocks" (one
    // instead of two); tier 0 = both.
    const tier = qualityController.tier();
    const flockCount = nightGlow >= 0.4 || tier >= 2 ? 0 : tier === 1 ? 1 : 2;
    if (flockCount === 0) {
      if (birdMesh.count !== 0) birdMesh.count = 0;
      return;
    }
    // Busiest cities, recomputed only when the island map is replaced (not every frame).
    if (flockSource !== ctx.store.islands) {
      flockSource = ctx.store.islands;
      flockCities = [...ctx.store.islands.values()].filter((i) => i.id !== "harness").sort((a, b) => b.agentCount - a.agentCount);
    }
    const islands = flockCities.slice(0, flockCount);
    let n = 0;
    islands.forEach((island, flockIdx) => {
      const top = ctx.cityPosition(island.id);
      if (!top) return;
      tangentFrame(top);
      q.setFromUnitVectors(Y, up);
      for (let i = 0; i < BIRDS_PER_FLOCK && n < birdMesh.instanceMatrix.count; i++) {
        const phase = (i / BIRDS_PER_FLOCK) * Math.PI * 2;
        const a = elapsed * 0.5 + phase + flockIdx * 1.7;
        const r = 6 + Math.sin(phase * 3) * 1.2;
        pos
          .copy(top)
          .addScaledVector(t1, Math.cos(a) * r)
          .addScaledVector(t2, Math.sin(a) * r)
          .addScaledVector(up, 3 + Math.sin(elapsed * 2 + phase) * 0.4);
        const flap = 0.7 + 0.3 * Math.sin(elapsed * 9 + phase * 4);
        s.set(1, flap, 1);
        m.compose(pos, q, s);
        birdMesh.setMatrixAt(n, m);
        n++;
      }
    });
    birdMesh.count = n;
    birdMesh.instanceMatrix.needsUpdate = true;
  }

  function updateMotes(elapsed: number): void {
    if (nightGlow <= 0.25) {
      if (moteMesh.count !== 0) moteMesh.count = 0;
      return;
    }
    // Perf budget's tier table: unlike confetti/birds, Z sprites stay at every tier, just
    // capped lower (tier 2: <=8, tier 1: half, tier 0: the full Z_CAPACITY).
    const tier = qualityController.tier();
    const cap = tier === 2 ? 8 : tier === 1 ? Math.round(Z_CAPACITY / 2) : Z_CAPACITY;
    let n = 0;
    for (const id of sleepingIds) {
      if (n >= cap) break;
      const roof = ctx.agentPosition(id);
      if (!roof) continue;
      // A 2.6s rise-and-fade loop, offset per agent so a row of sleeping houses doesn't blink
      // in lockstep.
      const t = ((elapsed + (id.charCodeAt(0) % 10) * 0.31) % Z_LIFE_S) / Z_LIFE_S;
      // moteDir is its own scratch vector: aliasing it with pos scaled the mote to 1.4-2.5x the
      // roof's distance from the planet centre (far off the globe) and fed a non-unit vector here.
      moteDir.copy(roof).normalize();
      pos.copy(roof).addScaledVector(moteDir, 0.4 + t * 1.1);
      q.setFromUnitVectors(Y, moteDir);
      const grow = Math.min(1, t / 0.25) * (1 - t * 0.3);
      s.setScalar(0.5 * grow);
      m.compose(pos, q, s);
      moteMesh.setMatrixAt(n, m);
      n++;
    }
    moteMesh.count = n;
    moteMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    markAgentsDirty() {
      agentsDirty = true;
    },
    update(elapsed) {
      if (agentsDirty) refreshAgentLists();
      const nowMs = Date.now();
      if (elapsed - lastSyncAt >= SYNC_EVERY_S) {
        lastSyncAt = elapsed;
        syncAnim(nowMs);
      }
      if (elapsed - lastNightAt >= NIGHT_EVERY_S) {
        lastNightAt = elapsed;
        syncNight();
      }
      updateBirds(elapsed);
      updateMotes(elapsed);
    },
  };
}
