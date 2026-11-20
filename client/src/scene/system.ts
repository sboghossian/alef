// "The system" made visible in the orbit (Round 7 T3/T4): the Tool Yard next to Harness City,
// the lifecycle ring with its nine stations, the machines as satellites, the token-saver and
// guardrail landmarks, and the memory stack around the Brain. Visual only: what lights up and
// when is decided by features/orbit-system.ts from real signals.
// Everything is instanced or merged (a handful of draw calls) and lives in one group.

import * as THREE from "three";
import { PLANET_R, cityMatrix, cityPoint, type CityLayout } from "../layout";
import type { LifecycleStage, YardBuilding } from "../features/orbit-lib";
import { LIFECYCLE } from "../features/orbit-lib";
import { BRAIN_ANGLE, PLAZA_OFFSET } from "./plaza";
import type { PickRegistry } from "./pick";
import { merge, painted, toon, windowMaterial } from "./toon";

export type LandmarkId = "rtk" | "guard" | "index" | "graph" | "vector" | "vault";
export type MachineId = "macbook" | "macmini" | "icloud" | "github";
export type SystemTarget =
  | { type: "station"; stage: LifecycleStage }
  | { type: "yard"; key: string }
  | { type: "yard-sign" }
  | { type: "landmark"; id: LandmarkId }
  | { type: "machine"; id: MachineId };

export const STAGE_COLORS: Record<LifecycleStage, number> = {
  prompt: 0xff5aa5,
  hook: 0xffa62b,
  plan: 0xffd23f,
  reason: 0xa77bff,
  tools: 0x3a86ff,
  subagents: 0x06d6a0,
  verify: 0x5ad65a,
  persist: 0xff6b6b,
  response: 0x00bbf9,
};

export const RING_R = PLANET_R * 1.42;
export const MACHINE_R = PLANET_R * 1.72;
const YARD_CAPACITY = 18;
const YARD_FROM = 3.2;
const YARD_TO = 5.85;
const LANDMARK_ANGLES: Record<LandmarkId, number> = {
  rtk: 2.92,
  guard: 6.08,
  index: BRAIN_ANGLE - 0.2,
  graph: BRAIN_ANGLE + 0.2,
  vector: BRAIN_ANGLE - 0.38,
  vault: BRAIN_ANGLE + 0.38,
};
const MACHINES: MachineId[] = ["macbook", "macmini", "icloud", "github"];
const PULSE_S = 0.9;

function pop(elapsed: number, at: number, dur = PULSE_S): number {
  const k = (elapsed - at) / dur;
  return k >= 0 && k < 1 ? Math.sin(k * Math.PI * 3) * (1 - k) : 0;
}

function glow(elapsed: number, at: number, dur = 2.2): number {
  const k = (elapsed - at) / dur;
  return k >= 0 && k < 1 ? 1 - k : 0;
}

function landmarkGeometry(id: LandmarkId): THREE.BufferGeometry {
  switch (id) {
    case "rtk": // token saver: a funnel squeezing tokens into a coin stack
      return merge([
        painted(new THREE.CylinderGeometry(0.55, 0.62, 0.3, 14).translate(0, 0.15, 0), 0x2ec4b6),
        painted(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 14).translate(0, 0.36, 0), 0xffd23f),
        painted(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 14).translate(0, 0.5, 0), 0xffe680),
        painted(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 8).translate(0, 0.85, 0), 0x2ec4b6),
        painted(new THREE.ConeGeometry(0.6, 0.8, 14, 1, true).rotateX(Math.PI).translate(0, 1.45, 0), 0x7ae8dc),
      ]);
    case "guard": // hooks guard: a gate tower with a shield
      return merge([
        painted(new THREE.CylinderGeometry(0.42, 0.5, 1.6, 8).translate(0, 0.8, 0), 0xfff1f3),
        painted(new THREE.CylinderGeometry(0.52, 0.52, 0.18, 8).translate(0, 1.66, 0), 0xff4d6d),
        painted(new THREE.ConeGeometry(0.5, 0.55, 8).translate(0, 2.02, 0), 0xff4d6d),
        painted(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 16).rotateX(Math.PI / 2).scale(1, 1.15, 1).translate(0, 0.95, 0.5), 0xffd23f),
      ]);
    case "index": // memory index: a filing cabinet
      return merge([
        painted(new THREE.BoxGeometry(0.7, 1.1, 0.6).translate(0, 0.55, 0), 0xe4d4ff),
        ...[0.25, 0.55, 0.85].map((y) => painted(new THREE.BoxGeometry(0.5, 0.06, 0.04).translate(0, y, 0.31), 0x8338ec)),
      ]);
    case "graph": // code graph: nodes and a hub
      return merge([
        painted(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6).translate(0, 0.4, 0), 0xdfe6f5),
        painted(new THREE.IcosahedronGeometry(0.28, 1).translate(0, 1.05, 0), 0x3a86ff),
        ...[0, 1, 2, 3, 4].map((k) =>
          painted(new THREE.IcosahedronGeometry(0.12, 0).translate(Math.cos(k * 1.26) * 0.45, 1.05 + Math.sin(k * 2.1) * 0.25, Math.sin(k * 1.26) * 0.45), 0x00bbf9),
        ),
      ]);
    case "vector": // vector recall: a little dish
      return merge([
        painted(new THREE.CylinderGeometry(0.06, 0.1, 0.7, 6).translate(0, 0.35, 0), 0xdfe6f5),
        painted(new THREE.SphereGeometry(0.42, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-0.9).translate(0, 0.8, 0.05), 0xffffff),
        painted(new THREE.SphereGeometry(0.08, 8, 6).translate(0, 1.0, 0.2), 0xff5aa5),
      ]);
    case "vault": // the vault: a safe with a dial
      return merge([
        painted(new THREE.BoxGeometry(0.8, 0.85, 0.7).translate(0, 0.43, 0), 0xc8f0ff),
        painted(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 14).rotateX(Math.PI / 2).translate(0, 0.45, 0.36), 0xffb703),
      ]);
  }
}

function machineGeometry(id: MachineId): THREE.BufferGeometry {
  switch (id) {
    case "macbook":
      return merge([
        painted(new THREE.BoxGeometry(3, 0.18, 2.1).translate(0, 0, 0), 0xe3e8f2),
        painted(new THREE.BoxGeometry(3, 2, 0.12).translate(0, 1, 0).rotateX(-0.28).translate(0, 0.05, -1.02), 0xe3e8f2),
        painted(new THREE.BoxGeometry(2.7, 1.7, 0.04).translate(0, 1, 0.08).rotateX(-0.28).translate(0, 0.05, -1.02), 0x9fe8ff),
      ]);
    case "macmini":
      return merge([
        painted(new THREE.CylinderGeometry(1.35, 1.35, 0.6, 24).scale(1, 1, 1).translate(0, 0.3, 0), 0xe8ecf4),
        painted(new THREE.CylinderGeometry(1.1, 1.1, 0.04, 24).translate(0, 0.62, 0), 0xf6f8fc),
        painted(new THREE.SphereGeometry(0.08, 8, 6).translate(0.9, 0.35, 0.9), 0x5ad65a),
      ]);
    case "icloud":
      return merge([
        painted(new THREE.IcosahedronGeometry(1.0, 1).translate(0, 0.3, 0), 0xe6f3ff),
        painted(new THREE.IcosahedronGeometry(0.75, 1).translate(-1.0, 0.05, 0), 0xe6f3ff),
        painted(new THREE.IcosahedronGeometry(0.8, 1).translate(1.0, 0.1, 0.1), 0xd6ebff),
        painted(new THREE.IcosahedronGeometry(0.6, 1).translate(0.3, 0.8, -0.2), 0xf3f9ff),
      ]);
    case "github":
      return merge([
        painted(new THREE.BoxGeometry(1.8, 2.3, 0.55), 0xb69cf2),
        painted(new THREE.BoxGeometry(1.5, 2.0, 0.1).translate(0, 0, 0.3), 0xf3edff),
        painted(new THREE.OctahedronGeometry(0.45, 0).translate(0, 1.65, 0), 0xffd23f),
      ]);
  }
}

export interface SystemVisualInput {
  harness: CityLayout;
  pick: PickRegistry;
  /** Hover label for a target (also the pick id the hub's tooltip shows). */
  label(target: SystemTarget): string;
}

export interface SystemVisual {
  group: THREE.Group;
  setYard(buildings: readonly YardBuilding[]): void;
  yardTop(key: string): THREE.Vector3 | undefined;
  yardSignPos(): THREE.Vector3;
  landmarkTop(id: LandmarkId): THREE.Vector3;
  stationPos(stage: LifecycleStage, out?: THREE.Vector3): THREE.Vector3;
  machinePos(id: MachineId, out?: THREE.Vector3): THREE.Vector3;
  pulseYard(key: string, elapsed: number): void;
  pulseStation(stage: LifecycleStage, elapsed: number): void;
  pulseLandmark(id: LandmarkId, elapsed: number): void;
  pulseMachine(id: MachineId, elapsed: number): void;
  /** `camDist` = camera distance from the centre: the ring and satellites hide once the camera is inside their orbit. */
  update(dt: number, elapsed: number, camDist?: number): void;
  ringVisible(): boolean;
  /** World-space axis of the ring's plane / the satellites' orbit (for framing). */
  ringAxis(): THREE.Vector3;
  machineAxis(): THREE.Vector3;
  machinesVisible(): boolean;
}

export function buildSystem(input: SystemVisualInput): SystemVisual {
  const { harness, pick, label } = input;
  const group = new THREE.Group();
  group.name = "orbit-system";
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3();
  const r = harness.radius + PLAZA_OFFSET;
  const local = (angle: number, rad = r): [number, number] => [Math.cos(angle) * rad, Math.sin(angle) * rad];

  // ---------------- Tool Yard: a sandy arc of small buildings, one per built-in tool ----------------
  const yardGround = (() => {
    const pos: number[] = [];
    const idx: number[] = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = YARD_FROM - 0.12 + ((YARD_TO - YARD_FROM + 0.24) * i) / steps;
      for (const rr of [r - 0.75, r + 0.75]) {
        const [x, z] = local(a, rr);
        const p = cityPoint(harness, x, z, 0.03);
        pos.push(p.x, p.y, p.z);
      }
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, toon(0xf6dc8a, { side: THREE.DoubleSide }));
    mesh.name = "tool-yard-ground";
    return mesh;
  })();
  group.add(yardGround);

  const yardBody = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.78, 1, 0.78).translate(0, 0.5, 0),
    windowMaterial({ wall: 0xfffaf0, grid: [2, 3] }),
    YARD_CAPACITY,
  );
  const yardRoof = new THREE.InstancedMesh(
    merge([
      painted(new THREE.BoxGeometry(0.94, 0.14, 0.94).translate(0, 0.07, 0), 0xffffff),
      painted(new THREE.BoxGeometry(0.5, 0.26, 0.08).translate(0, 0.26, 0.3), 0xffffff),
    ]),
    toon(0xffffff, { vertexColors: true }),
    YARD_CAPACITY,
  );
  const yardLit = new Float32Array(YARD_CAPACITY);
  yardBody.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(yardLit, 1));
  yardBody.count = 0;
  yardRoof.count = 0;
  yardBody.name = "tool-yard";
  yardRoof.name = "tool-yard-roofs";
  group.add(yardBody, yardRoof);
  const YARD_COLORS = [0x3a86ff, 0xff4d6d, 0x06d6a0, 0xffb703, 0x8338ec, 0xfb5607, 0x00bbf9, 0xff006e];
  interface Slot {
    key: string;
    count: number;
    x: number;
    z: number;
    yaw: number;
    height: number;
    target: number;
    hitAt: number;
    litUntil: number;
    top: THREE.Vector3;
  }
  let slots: Slot[] = [];
  const slotByKey = new Map<string, Slot>();
  const yardPick = (id: number | undefined) => {
    const s = id === undefined ? undefined : slots[id];
    return s ? { kind: "system" as const, id: label({ type: "yard", key: s.key }) } : null;
  };
  pick.register(yardBody, yardPick, { dynamic: true });
  pick.register(yardRoof, yardPick, { dynamic: true });
  pick.register(yardGround, () => ({ kind: "system", id: label({ type: "yard-sign" }) }));

  function placeSlot(i: number, s: Slot, popAmt: number): void {
    const sy = 1 + 0.5 * popAmt;
    const sxz = 1 - 0.15 * popAmt;
    yardBody.setMatrixAt(i, cityMatrix(harness, s.x, s.z, 0, s.yaw, tmpS.set(sxz, s.height * sy, sxz), tmpM));
    yardRoof.setMatrixAt(i, cityMatrix(harness, s.x, s.z, s.height * sy, s.yaw, tmpS.set(sxz, 1, sxz), tmpM));
    cityPoint(harness, s.x, s.z, s.height + 0.5, s.top);
  }

  // ---------------- Landmarks: token saver, guardrail, memory stack ----------------
  const landmarkMat = toon(0xffffff, { vertexColors: true });
  const landmarks = new Map<LandmarkId, { mesh: THREE.Mesh; base: THREE.Matrix4; top: THREE.Vector3; hitAt: number }>();
  for (const id of Object.keys(LANDMARK_ANGLES) as LandmarkId[]) {
    const a = LANDMARK_ANGLES[id];
    const [x, z] = local(a);
    const mesh = new THREE.Mesh(landmarkGeometry(id), landmarkMat);
    mesh.matrixAutoUpdate = false;
    const s = id === "rtk" || id === "guard" ? 1.25 : 1;
    const base = cityMatrix(harness, x, z, 0, Math.atan2(x, z), new THREE.Vector3(s, s, s)).clone();
    mesh.matrix.copy(base);
    mesh.name = `landmark-${id}`;
    group.add(mesh);
    landmarks.set(id, { mesh, base, top: cityPoint(harness, x, z, id === "guard" ? 3.2 : 2), hitAt: -100 });
    pick.register(mesh, () => ({ kind: "system", id: label({ type: "landmark", id }) }));
  }

  // ---------------- Lifecycle ring: nine stations on a tilted orbital ring ----------------
  const ring = new THREE.Group();
  ring.name = "lifecycle-ring";
  ring.rotation.set(Math.PI / 2 - 0.42, 0.18, 0);
  const band = new THREE.Mesh(new THREE.TorusGeometry(RING_R, 0.22, 6, 160), toon(0xe9dcff));
  band.name = "lifecycle-band";
  ring.add(band);
  const stationGeo = merge([
    painted(new THREE.CylinderGeometry(1.0, 1.0, 0.35, 16).rotateX(Math.PI / 2), 0xffffff),
    painted(new THREE.OctahedronGeometry(0.8, 0).scale(1, 1, 1.3).translate(0, 0, 0.85), 0xffffff),
  ]);
  const stations = new THREE.InstancedMesh(stationGeo, toon(0xffffff, { vertexColors: true }), LIFECYCLE.length);
  stations.name = "lifecycle-stations";
  ring.add(stations);
  group.add(ring);
  const stationAngle = (i: number): number => (i / LIFECYCLE.length) * Math.PI * 2 + 0.35;
  const stationHit = new Map<LifecycleStage, number>();
  const stationColor = new THREE.Color();
  pick.register(stations, (id) => {
    const st = id === undefined ? undefined : LIFECYCLE[id];
    return st ? { kind: "system", id: label({ type: "station", stage: st.id }) } : null;
  });
  pick.register(band, () => ({ kind: "system", id: label({ type: "station", stage: "prompt" }) }));
  let spin = 0;

  // ---------------- Machines: satellites on a second, slower orbit ----------------
  const machineRoot = new THREE.Group();
  machineRoot.name = "machines";
  machineRoot.rotation.set(0.5, 0, -0.25);
  group.add(machineRoot);
  const machineMat = toon(0xffffff, { vertexColors: true });
  const machines = new Map<MachineId, { mesh: THREE.Mesh; hitAt: number; phase: number }>();
  MACHINES.forEach((id, i) => {
    const mesh = new THREE.Mesh(machineGeometry(id), machineMat);
    mesh.name = `machine-${id}`;
    mesh.scale.setScalar(2.4);
    machineRoot.add(mesh);
    machines.set(id, { mesh, hitAt: -100, phase: (i / MACHINES.length) * Math.PI * 2 + 0.6 });
    pick.register(mesh, () => ({ kind: "system", id: label({ type: "machine", id }) }));
  });
  let orbit = 0;
  const up = new THREE.Vector3();

  const visual: SystemVisual = {
    group,
    setYard(buildings) {
      const next: Slot[] = [];
      const n = Math.min(YARD_CAPACITY, buildings.length);
      buildings.slice(0, n).forEach((b, i) => {
        const a = n <= 1 ? (YARD_FROM + YARD_TO) / 2 : YARD_FROM + ((YARD_TO - YARD_FROM) * i) / (n - 1);
        const [x, z] = local(a);
        const prev = slotByKey.get(b.key);
        next.push({
          key: b.key,
          count: b.count,
          x,
          z,
          yaw: Math.atan2(x, z),
          height: prev?.height ?? 0.2,
          target: b.height,
          hitAt: prev?.hitAt ?? -100,
          litUntil: prev?.litUntil ?? -100,
          top: prev?.top ?? new THREE.Vector3(),
        });
      });
      slots = next;
      slotByKey.clear();
      slots.forEach((s, i) => {
        slotByKey.set(s.key, s);
        yardRoof.setColorAt(i, new THREE.Color(YARD_COLORS[i % YARD_COLORS.length] ?? 0x3a86ff));
        placeSlot(i, s, 0);
      });
      yardBody.count = slots.length;
      yardRoof.count = slots.length;
      yardBody.instanceMatrix.needsUpdate = true;
      yardRoof.instanceMatrix.needsUpdate = true;
      if (yardRoof.instanceColor) yardRoof.instanceColor.needsUpdate = true;
      yardBody.boundingSphere = null;
      yardRoof.boundingSphere = null;
    },
    yardTop: (key) => slotByKey.get(key)?.top,
    yardSignPos: () => cityPoint(harness, ...local((YARD_FROM + YARD_TO) / 2, r + 0.2), 3.6),
    landmarkTop: (id) => landmarks.get(id)?.top ?? cityPoint(harness, 0, 0, 2),
    stationPos(stage, out = new THREE.Vector3()) {
      const i = LIFECYCLE.findIndex((s) => s.id === stage);
      const a = stationAngle(i) + spin;
      out.set(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0);
      ring.updateMatrixWorld();
      return out.applyMatrix4(ring.matrixWorld);
    },
    machinePos(id, out = new THREE.Vector3()) {
      const m = machines.get(id);
      if (!m) return out.set(0, 0, 0);
      m.mesh.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(m.mesh.matrixWorld);
    },
    pulseYard(key, elapsed) {
      const s = slotByKey.get(key);
      if (!s) return;
      s.hitAt = elapsed;
      s.litUntil = elapsed + 12;
    },
    pulseStation(stage, elapsed) {
      stationHit.set(stage, elapsed);
    },
    pulseLandmark(id, elapsed) {
      const l = landmarks.get(id);
      if (l) l.hitAt = elapsed;
    },
    pulseMachine(id, elapsed) {
      const m = machines.get(id);
      if (m) m.hitAt = elapsed;
    },
    ringVisible: () => ring.visible,
    ringAxis: () => new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion),
    machineAxis: () => new THREE.Vector3(0, 1, 0).applyQuaternion(machineRoot.quaternion),
    machinesVisible: () => machineRoot.visible,
    update(dt, elapsed, camDist = Infinity) {
      if (!group.visible) return;
      ring.visible = camDist > RING_R + 24;
      machineRoot.visible = camDist > MACHINE_R + 22;
      // Yard: grow toward target heights, squash on a hit, windows lit for a while after a call.
      let yardDirty = false;
      slots.forEach((s, i) => {
        const growing = Math.abs(s.target - s.height) > 0.002;
        if (growing) s.height = THREE.MathUtils.damp(s.height, s.target, 3, dt);
        const p = pop(elapsed, s.hitAt);
        const lit = elapsed < s.litUntil ? 1 : 0;
        if (yardLit[i] !== lit) {
          yardLit[i] = lit;
          yardBody.geometry.getAttribute("aLit").needsUpdate = true;
        }
        if (growing || p !== 0 || elapsed - s.hitAt < PULSE_S + 0.1) {
          placeSlot(i, s, p);
          yardDirty = true;
        }
      });
      if (yardDirty) {
        yardBody.instanceMatrix.needsUpdate = true;
        yardRoof.instanceMatrix.needsUpdate = true;
      }
      // Landmarks: squash-and-stretch on a hit.
      for (const l of landmarks.values()) {
        const p = pop(elapsed, l.hitAt);
        if (p === 0 && elapsed - l.hitAt > PULSE_S + 0.1) continue;
        l.mesh.matrix.copy(l.base).multiply(tmpM.makeScale(1 - 0.15 * p, 1 + 0.45 * p, 1 - 0.15 * p));
      }
      // Ring: slow spin; stations swell and flash toward white when their stage fires.
      spin += dt * 0.025;
      LIFECYCLE.forEach((st, i) => {
        const a = stationAngle(i) + spin;
        const at = stationHit.get(st.id) ?? -100;
        const k = 2.1 + 1.2 * glow(elapsed, at, 1.4) + 0.4 * pop(elapsed, at);
        tmpM.makeRotationZ(a - Math.PI / 2);
        tmpM.scale(tmpS.set(k, k, k));
        tmpM.setPosition(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0);
        stations.setMatrixAt(i, tmpM);
        stations.setColorAt(i, stationColor.setHex(STAGE_COLORS[st.id]).lerp(new THREE.Color(0xfff6a8), glow(elapsed, at, 1.4) * 0.6));
      });
      stations.instanceMatrix.needsUpdate = true;
      if (stations.instanceColor) stations.instanceColor.needsUpdate = true;
      // Machines: orbit, face outward, bounce when they get a real signal.
      orbit += dt * 0.012;
      for (const m of machines.values()) {
        const a = m.phase + orbit;
        m.mesh.position.set(Math.cos(a) * MACHINE_R, 0, Math.sin(a) * MACHINE_R);
        up.copy(m.mesh.position).normalize();
        m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        m.mesh.rotateZ(Math.sin(elapsed * 0.4 + m.phase) * 0.15);
        const p = pop(elapsed, m.hitAt, 1.2);
        m.mesh.scale.setScalar(2.4 * (1 + 0.35 * p + 0.25 * glow(elapsed, m.hitAt, 3)));
      }
    },
  };
  // Initial placement (so positions are valid before the first frame).
  visual.update(0, 0);
  return visual;
}
