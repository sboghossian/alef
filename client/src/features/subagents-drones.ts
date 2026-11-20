// Subagents as drones on the planet: one instanced mesh for every drone, one for the glow
// of the live ones. Running subagents zip around their parent's house; finished ones park
// on its roof (≤12 per house, the rest become a "+N" tag). Picking is screen-space
// (nearest projected drone within 16px; the hub pick registry is not exposed to features).

import * as THREE from "three";
import type { SubagentRecord } from "../../../shared/features/subagents";
import { toon } from "../scene/toon";
import { h, overlayLayer, place, toScreen } from "./fleet-overlay";
import type { ClientContext } from "./registry";

export const MAX_PARKED = 12;
const CAPACITY = 1200;
const GLOW_CAPACITY = 96;
const TAG_MAX_DIST = 22;

export interface DroneSlots {
  live: SubagentRecord[];
  parked: SubagentRecord[];
  overflow: number;
}

/** Which of one house's subagents fly, which park, and how many don't fit. Deterministic. */
export function droneSlots(children: readonly SubagentRecord[]): DroneSlots {
  const live = children.filter((c) => c.status === "running").sort((a, b) => (a.id < b.id ? -1 : 1));
  const rest = children
    .filter((c) => c.status !== "running")
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id < b.id ? -1 : 1));
  return { live, parked: rest.slice(0, MAX_PARKED), overflow: Math.max(0, rest.length - MAX_PARKED) };
}

const COLORS: Record<SubagentRecord["status"], number> = {
  running: 0xffd23f,
  done: 0x7ee0a8,
  failed: 0xff6b6b,
  stopped: 0xa7adb5,
  async_launched: 0xb9a8f0,
};

interface Placed {
  id: string;
  parentId: string;
  live: boolean;
  index: number; // within its group
  count: number;
  phase: number;
}

function hashPhase(id: string): number {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0;
  return (x % 6283) / 1000;
}

function droneGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.105, 10, 8);
  body.scale(1, 0.62, 1);
  const ring = new THREE.TorusGeometry(0.16, 0.026, 5, 14);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.05, 0);
  const merged = new THREE.BufferGeometry();
  const parts = [body.toNonIndexed(), ring.toNonIndexed()];
  const pos: number[] = [];
  const nor: number[] = [];
  for (const p of parts) {
    pos.push(...(p.getAttribute("position").array as Float32Array));
    nor.push(...(p.getAttribute("normal").array as Float32Array));
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return merged;
}

export interface Drones {
  setRecords(records: Iterable<SubagentRecord>): void;
  update(elapsed: number, ctx: ClientContext): void;
  /** Subagent id within `radiusPx` of a screen point, nearest first (visible side of the planet only). */
  pick(clientX: number, clientY: number, ctx: ClientContext, radiusPx?: number): string | null;
  setVisible(on: boolean): void;
}

export function buildDrones(ctx: ClientContext): Drones {
  const mesh = new THREE.InstancedMesh(droneGeometry(), toon(0xffffff), CAPACITY);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = "subagent-drones";
  const glow = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.3, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    GLOW_CAPACITY,
  );
  glow.count = 0;
  glow.frustumCulled = false;
  ctx.scene.add(mesh, glow);

  let placed: Placed[] = [];
  /** World position of each placed drone as of the last frame (for screen-space picking). */
  let positions = new Float32Array(0);
  const overflowTags = new Map<string, HTMLElement>();
  let dirty = true;
  let byParent = new Map<string, DroneSlots>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const p = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  function frame(roof: THREE.Vector3): void {
    up.copy(roof).normalize();
    t1.copy(Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : Y).cross(up).normalize();
    t2.copy(up).cross(t1).normalize();
    q.setFromUnitVectors(Y, up);
  }

  function rebuild(): void {
    dirty = false;
    placed = [];
    for (const [parentId, slots] of byParent) {
      if (!ctx.agentPosition(parentId)) continue;
      slots.live.forEach((r, i) => placed.push({ id: r.id, parentId, live: true, index: i, count: slots.live.length, phase: hashPhase(r.id) }));
      slots.parked.forEach((r, i) => placed.push({ id: r.id, parentId, live: false, index: i, count: slots.parked.length, phase: 0 }));
    }
    placed = placed.slice(0, CAPACITY);
    mesh.count = placed.length;
    positions = new Float32Array(placed.length * 3);
    const statusOf = new Map<string, SubagentRecord["status"]>();
    for (const slots of byParent.values()) for (const r of [...slots.live, ...slots.parked]) statusOf.set(r.id, r.status);
    placed.forEach((d, i) => mesh.setColorAt(i, color.setHex(COLORS[statusOf.get(d.id) ?? "done"])));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    glow.count = Math.min(GLOW_CAPACITY, placed.filter((d) => d.live).length);
    // "+N" tags for houses with more finished subagents than roof space.
    const layer = overlayLayer();
    for (const [parentId, slots] of byParent) {
      let tag = overflowTags.get(parentId);
      if (slots.overflow <= 0) {
        tag?.remove();
        overflowTags.delete(parentId);
        continue;
      }
      if (!tag) {
        tag = h("div", "sa-more");
        layer.appendChild(tag);
        overflowTags.set(parentId, tag);
      }
      tag.textContent = `+${slots.overflow} drones`;
    }
    for (const [id, tag] of overflowTags) if (!byParent.has(id)) (tag.remove(), overflowTags.delete(id));
  }

  function droneMatrix(d: Placed, elapsed: number, out: THREE.Matrix4): boolean {
    const roof = ctx.agentPosition(d.parentId);
    if (!roof) return false;
    frame(roof);
    if (d.live) {
      const a = elapsed * (2.1 + (d.index % 3) * 0.35) + d.phase + (d.index * Math.PI * 2) / Math.max(1, d.count);
      const r = 0.95 + 0.22 * Math.sin(elapsed * 1.7 + d.phase);
      const lift = 0.7 + 0.2 * Math.sin(elapsed * 3.1 + d.phase * 2);
      p.copy(roof).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).addScaledVector(up, lift);
      s.setScalar(1.15);
    } else {
      const col = d.index % 4;
      const row = Math.floor(d.index / 4);
      p.copy(roof)
        .addScaledVector(t1, (col - 1.5) * 0.27)
        .addScaledVector(t2, (row - 1) * 0.27)
        .addScaledVector(up, 0.1);
      s.setScalar(0.9);
    }
    out.compose(p, q, s);
    return true;
  }

  return {
    setRecords(records) {
      const groups = new Map<string, SubagentRecord[]>();
      for (const r of records) {
        const list = groups.get(r.parentSessionId) ?? [];
        list.push(r);
        groups.set(r.parentSessionId, list);
      }
      byParent = new Map([...groups].map(([k, v]) => [k, droneSlots(v)]));
      dirty = true;
    },
    update(elapsed) {
      if (dirty) rebuild();
      let g = 0;
      for (let i = 0; i < placed.length; i++) {
        const d = placed[i];
        if (!d) continue;
        if (!droneMatrix(d, elapsed, m)) continue;
        mesh.setMatrixAt(i, m);
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
        if (d.live && g < glow.count) {
          m.decompose(p, q, s);
          s.setScalar(1 + 0.25 * Math.sin(elapsed * 6 + d.phase));
          m.compose(p, q, s);
          glow.setMatrixAt(g++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      glow.instanceMatrix.needsUpdate = true;
      for (const [parentId, tag] of overflowTags) {
        const roof = ctx.agentPosition(parentId);
        if (!roof) continue;
        // Only up close: from orbit a dozen "+N" tags would bury the city labels.
        if (ctx.camera.position.distanceTo(roof) > TAG_MAX_DIST) {
          tag.hidden = true;
          continue;
        }
        frame(roof);
        place(tag, toScreen(ctx, p.copy(roof).addScaledVector(up, 0.9)));
      }
    },
    pick(clientX, clientY, c, radiusPx = 16) {
      if (!mesh.visible || mesh.count === 0) return null;
      let best: string | null = null;
      let bestD = radiusPx;
      for (let i = 0; i < placed.length; i++) {
        p.set(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0);
        const sp = toScreen(c, p);
        if (!sp.visible) continue;
        const d = Math.hypot(sp.x - clientX, sp.y - clientY);
        if (d < bestD) {
          bestD = d;
          best = placed[i]?.id ?? null;
        }
      }
      return best;
    },
    setVisible(on) {
      mesh.visible = on;
      glow.visible = on;
      for (const tag of overflowTags.values()) tag.style.visibility = on ? "" : "hidden";
    },
  };
}
