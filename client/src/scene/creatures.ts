import * as THREE from "three";
import { merge, painted, toon } from "./toon";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";
export const FAMILIES: ModelFamily[] = ["opus", "sonnet", "haiku", "fable", "other"];

/** "claude-opus-5-5[1m]" -> "opus"; unknown / null -> "other". */
export function modelFamily(model: string | null | undefined): ModelFamily {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "other";
}

/** Short display name: "claude-opus-5-5[1m]" -> "Opus 5.5". */
export function modelLabel(model: string | null | undefined): string {
  const fam = modelFamily(model);
  if (fam === "other") return model ? model.replace(/^claude-/, "") : "Claude";
  const ver = (model ?? "").toLowerCase().match(new RegExp(`${fam}-(\\d+)(?:-(\\d+))?`));
  const name = fam.charAt(0).toUpperCase() + fam.slice(1);
  if (!ver) return name;
  return ver[2] && ver[2].length === 1 ? `${name} ${ver[1]}.${ver[2]}` : `${name} ${ver[1]}`;
}

export const FAMILY_COLOR: Record<ModelFamily, number> = {
  opus: 0xff6a1f,
  sonnet: 0xff9340,
  haiku: 0xffbe3b,
  fable: 0x9d7bff,
  other: 0xc9bfe0,
};

/** Size per family: opus is the big one, haiku the small quick one. */
export const FAMILY_SCALE: Record<ModelFamily, number> = { opus: 1, sonnet: 0.78, haiku: 0.58, fable: 0.85, other: 0.7 };

const EYE = 0x1a1030;

function eyes(y: number, z: number, spread: number, r: number): THREE.BufferGeometry[] {
  return [-1, 1].map((s) => painted(new THREE.SphereGeometry(r, 8, 6).scale(0.8, 1.2, 0.5).translate(s * spread, y, z), EYE));
}

/** Spiky starburst (Claude-orange, AI Village style): a core with cones along icosahedron directions. */
function starburst(spikes: number, core: number, len: number, color: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [painted(new THREE.IcosahedronGeometry(core, 1), color)];
  const dirs = new THREE.IcosahedronGeometry(1, spikes > 12 ? 1 : 0).getAttribute("position");
  const seen = new Set<string>();
  const up = new THREE.Vector3(0, 1, 0);
  const d = new THREE.Vector3();
  for (let i = 0; i < dirs.count; i++) {
    d.fromBufferAttribute(dirs, i).normalize();
    const key = `${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cone = new THREE.ConeGeometry(core * 0.5, len, 6).translate(0, core + len / 2 - core * 0.25, 0);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d));
    parts.push(painted(cone, color));
  }
  parts.push(...eyes(core * 0.15, core * 0.92, core * 0.38, core * 0.2));
  return merge(parts);
}

/** Four-point star (feathered fable variant). */
function star(color: number): THREE.BufferGeometry {
  const body = new THREE.OctahedronGeometry(0.5, 0).scale(0.75, 1.5, 0.75);
  const fins = [0, 1, 2, 3].map((k) =>
    painted(
      new THREE.ConeGeometry(0.16, 0.7, 4)
        .rotateZ(-Math.PI / 2)
        .translate(0.55, 0, 0)
        .rotateY((k * Math.PI) / 2 + Math.PI / 4),
      color,
    ),
  );
  return merge([painted(body, color), ...fins, ...eyes(0.12, 0.3, 0.14, 0.08)]);
}

function blob(color: number): THREE.BufferGeometry {
  return merge([painted(new THREE.SphereGeometry(0.45, 14, 10).scale(1, 0.85, 1), color), ...eyes(0.08, 0.4, 0.16, 0.08)]);
}

/** Geometry for a family, centred on its body, ~1 unit tall at scale 1. */
export function creatureGeometry(family: ModelFamily): THREE.BufferGeometry {
  switch (family) {
    case "opus":
      return starburst(12, 0.38, 0.36, FAMILY_COLOR.opus);
    case "sonnet":
      return starburst(12, 0.36, 0.28, FAMILY_COLOR.sonnet);
    case "haiku":
      return starburst(12, 0.36, 0.18, FAMILY_COLOR.haiku);
    case "fable":
      return star(FAMILY_COLOR.fable);
    default:
      return blob(FAMILY_COLOR.other);
  }
}

export interface CreaturePlacement {
  agentId: string;
  family: ModelFamily;
  matrix: THREE.Matrix4;
}

export interface CreaturesVisual {
  group: THREE.Group;
  /** Rewrites all instance matrices; returns id lookup per family for picking. */
  set(list: CreaturePlacement[]): void;
  idAt(mesh: THREE.Object3D, instanceId: number | undefined): string | null;
}

/** One instanced mesh per model family (5 draw calls for all agents). */
export function buildCreatures(capacity: number): CreaturesVisual {
  const group = new THREE.Group();
  group.name = "creatures";
  const mat = toon(0xffffff, { vertexColors: true });
  const meshes = new Map<ModelFamily, THREE.InstancedMesh>();
  const ids = new Map<THREE.Object3D, string[]>();
  for (const f of FAMILIES) {
    const mesh = new THREE.InstancedMesh(creatureGeometry(f), mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = `creature-${f}`;
    meshes.set(f, mesh);
    ids.set(mesh, []);
    group.add(mesh);
  }
  return {
    group,
    set(list) {
      const counts = new Map<ModelFamily, number>();
      for (const c of list) {
        const mesh = meshes.get(c.family);
        if (!mesh) continue;
        const i = counts.get(c.family) ?? 0;
        if (i >= capacity) continue;
        mesh.setMatrixAt(i, c.matrix);
        const arr = ids.get(mesh);
        if (arr) arr[i] = c.agentId;
        counts.set(c.family, i + 1);
      }
      for (const [f, mesh] of meshes) {
        mesh.count = counts.get(f) ?? 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    idAt(mesh, instanceId) {
      if (instanceId === undefined) return null;
      return ids.get(mesh)?.[instanceId] ?? null;
    },
  };
}
