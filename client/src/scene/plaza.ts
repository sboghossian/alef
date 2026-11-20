import * as THREE from "three";
import { registerSceneParts } from "./scene-bus";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { CITY_SURFACE, cityMatrix, cityPoint, type CityLayout } from "../layout";
import { NO_INK_LAYER } from "./planet";
import { merge, painted, toon } from "./toon";
import type { PickRegistry } from "./pick";

export interface PlazaVisual {
  group: THREE.Group;
  brainTop: THREE.Vector3;
  fountainTop: THREE.Vector3;
  /** An agent in `islandId` touched memory: ensure a dashed line exists and pulse it. */
  brainHit(islandId: string, towerTop: THREE.Vector3, elapsed: number): void;
  splash(elapsed: number): void;
  setResolution(w: number, h: number): void;
  update(dt: number, elapsed: number): void;
}

interface BrainLine {
  line: Line2;
  mat: LineMaterial;
  hitAt: number;
}

/** Harness City's civic buildings: the Brain (memory/vault library) and the village-square fountain
 *  where Jev's decisions are announced. Both sit just outside the capital's ring road. */
/** Plaza buildings sit this far outside the capital's ring (tangent units), at these angles. */
export const PLAZA_OFFSET = 1.55;
export const BRAIN_ANGLE = 0.6;
export const FOUNTAIN_ANGLE = 0.6 + Math.PI * 0.62;

export function buildPlaza(harness: CityLayout, pick: PickRegistry): PlazaVisual {
  const group = new THREE.Group();
  group.name = "plaza";
  const r = harness.radius + PLAZA_OFFSET;
  const scale = new THREE.Vector3(1, 1, 1);

  // ---- The Brain: a round library with a pink brain dome ----
  const brainPos: [number, number] = [Math.cos(BRAIN_ANGLE) * r, Math.sin(BRAIN_ANGLE) * r];
  const brainGeo = merge([
    painted(new THREE.CylinderGeometry(1.0, 1.1, 0.25, 20).translate(0, 0.12, 0), 0xe7dcff),
    painted(new THREE.CylinderGeometry(0.85, 0.85, 1.2, 20).translate(0, 0.85, 0), 0xfff4e0),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) =>
      painted(
        new THREE.CylinderGeometry(0.07, 0.07, 1.2, 6).translate(Math.cos((k * Math.PI) / 4) * 0.92, 0.85, Math.sin((k * Math.PI) / 4) * 0.92),
        0xffffff,
      ),
    ),
    painted(new THREE.CylinderGeometry(1.0, 1.0, 0.14, 20).translate(0, 1.5, 0), 0xe7dcff),
    painted(new THREE.SphereGeometry(0.82, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.95, 1.1).translate(0, 1.56, 0), 0xff8fc4),
    painted(new THREE.TorusGeometry(0.42, 0.07, 6, 16, Math.PI).rotateY(Math.PI / 2).translate(0, 1.72, 0), 0xff5aa5),
    painted(new THREE.TorusGeometry(0.3, 0.06, 6, 14, Math.PI).rotateY(Math.PI / 2).translate(0.28, 1.66, 0), 0xff5aa5),
    painted(new THREE.TorusGeometry(0.3, 0.06, 6, 14, Math.PI).rotateY(Math.PI / 2).translate(-0.28, 1.66, 0), 0xff5aa5),
  ]);
  const brain = new THREE.Mesh(brainGeo, toon(0xffffff, { vertexColors: true }));
  brain.matrixAutoUpdate = false;
  brain.matrix.copy(cityMatrix(harness, brainPos[0], brainPos[1], 0, 0, scale));
  brain.name = "brain";
  group.add(brain);
  pick.register(brain, () => ({ kind: "city", id: "harness" }));
  const brainTop = cityPoint(harness, brainPos[0], brainPos[1], 2.6);
  const brainBase = brain.matrix.clone();

  // ---- Village square: plaza + fountain ----
  const fPos: [number, number] = [Math.cos(FOUNTAIN_ANGLE) * r, Math.sin(FOUNTAIN_ANGLE) * r];
  const fountainGeo = merge([
    painted(new THREE.CylinderGeometry(1.25, 1.25, 0.08, 28).translate(0, 0.04, 0), 0xf6dc8a),
    painted(new THREE.TorusGeometry(0.85, 0.16, 8, 28).rotateX(Math.PI / 2).translate(0, 0.28, 0), 0xe7dcff),
    painted(new THREE.CylinderGeometry(0.82, 0.82, 0.12, 28).translate(0, 0.2, 0), 0x3fd9e0),
    painted(new THREE.CylinderGeometry(0.12, 0.16, 0.9, 10).translate(0, 0.7, 0), 0xe7dcff),
    painted(new THREE.CylinderGeometry(0.42, 0.2, 0.16, 18).translate(0, 1.15, 0), 0xe7dcff),
  ]);
  const fountain = new THREE.Mesh(fountainGeo, toon(0xffffff, { vertexColors: true }));
  fountain.matrixAutoUpdate = false;
  fountain.matrix.copy(cityMatrix(harness, fPos[0], fPos[1], 0, 0, scale));
  fountain.name = "fountain";
  group.add(fountain);
  pick.register(fountain, () => ({ kind: "jev", id: "jev" }));
  const water = new THREE.Mesh(
    merge([
      painted(new THREE.ConeGeometry(0.1, 0.5, 8).translate(0, 1.45, 0), 0x7ae8ff),
      ...[0, 1, 2, 3, 4, 5].map((k) =>
        painted(
          new THREE.SphereGeometry(0.09, 8, 6).translate(Math.cos((k * Math.PI) / 3) * 0.55, 0.62, Math.sin((k * Math.PI) / 3) * 0.55),
          0x7ae8ff,
        ),
      ),
    ]),
    toon(0xffffff, { vertexColors: true }),
  );
  water.matrixAutoUpdate = false;
  const fountainBase = fountain.matrix.clone();
  water.matrix.copy(fountainBase);
  group.add(water);
  const fountainTop = cityPoint(harness, fPos[0], fPos[1], 2.2);

  // ---- dashed brain lines ----
  const lines = new Map<string, BrainLine>();
  const resolution = new THREE.Vector2(1280, 800);
  const brainGround = cityPoint(harness, brainPos[0], brainPos[1], 1.9);

  function makeLine(towerTop: THREE.Vector3): BrainLine {
    const from = brainGround.clone().normalize();
    const to = towerTop.clone().normalize();
    const ang = from.angleTo(to);
    const axis = new THREE.Vector3().crossVectors(from, to);
    if (axis.lengthSq() < 1e-9) axis.set(0, 1, 0);
    axis.normalize();
    const pts: number[] = [];
    const n = Math.max(12, Math.ceil(ang * 40));
    const p = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const lift = Math.sin(Math.PI * t) * Math.min(14, 3 + ang * CITY_SURFACE * 0.12);
      const baseR = THREE.MathUtils.lerp(brainGround.length(), towerTop.length(), t);
      p.copy(from).applyAxisAngle(axis, ang * t).multiplyScalar(baseR + lift);
      pts.push(p.x, p.y, p.z);
    }
    const geo = new LineGeometry();
    geo.setPositions(pts);
    const mat = new LineMaterial({
      color: 0xff5aa5,
      linewidth: 3.2,
      dashed: true,
      dashSize: 1.1,
      gapSize: 0.8,
      transparent: true,
      opacity: 0.85,
    });
    mat.resolution.copy(resolution);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.layers.set(NO_INK_LAYER);
    group.add(line);
    return { line, mat, hitAt: -100 };
  }

  let brainPulseAt = -100;
  let splashAt = -100;
  const tmp = new THREE.Matrix4();

  const visual: PlazaVisual = {
    group,
    brainTop,
    fountainTop,
    brainHit(islandId, towerTop, elapsed) {
      let l = lines.get(islandId);
      if (!l) {
        l = makeLine(towerTop);
        lines.set(islandId, l);
      }
      l.hitAt = elapsed;
      brainPulseAt = elapsed;
    },
    splash(elapsed) {
      splashAt = elapsed;
    },
    setResolution(w, h) {
      resolution.set(w, h);
      for (const l of lines.values()) l.mat.resolution.set(w, h);
    },
    update(_dt, elapsed) {
      for (const l of lines.values()) {
        l.mat.dashOffset = -elapsed * 2.2;
        const k = Math.max(0, 1 - (elapsed - l.hitAt) / 2.5);
        l.mat.linewidth = 3.2 + k * 4;
        l.mat.color.setHex(k > 0.02 ? 0xffd23f : 0xff5aa5);
      }
      const bk = (elapsed - brainPulseAt) / 0.8;
      const pop = bk >= 0 && bk < 1 ? Math.sin(bk * Math.PI * 3) * (1 - bk) : 0;
      brain.matrix.copy(brainBase).multiply(tmp.makeScale(1 - 0.12 * pop, 1 + 0.3 * pop, 1 - 0.12 * pop));
      // Water: gentle idle bob, big spurt on an official result.
      const sk = (elapsed - splashAt) / 2.2;
      const spurt = sk >= 0 && sk < 1 ? Math.sin(sk * Math.PI) * 1.6 : 0;
      const idle = 1 + Math.sin(elapsed * 4) * 0.08;
      water.matrix.copy(fountainBase).multiply(tmp.makeScale(1 + spurt * 0.3, idle + spurt, 1 + spurt * 0.3));
    },
  };
  registerSceneParts({ plaza: visual });
  return visual;
}
