import * as THREE from "three";
import { mcpTint, STATIONS } from "../../../shared/stations";
import type { Island, WorldObject } from "../../../shared/types";
import { CITY_SURFACE, PLANET_R, cityMatrix, cityPoint, lotLocal, type CityLayout } from "../layout";
import { hashString } from "./noise";
import { merge, painted, toon, windowMaterial } from "./toon";
import type { Pick, PickRegistry } from "./pick";
import { registerSceneParts } from "./scene-bus";

const CROWN_COLORS = [0xff4d6d, 0xffb703, 0x3a86ff, 0x8338ec, 0x06d6a0, 0xfb5607, 0xff006e];
const PASTELS = [0xffd6e0, 0xffe8a3, 0xc8f0ff, 0xd9f99d, 0xffd0a8, 0xe4d4ff, 0xfff1c9];

interface GrowthPart {
  mesh: THREE.InstancedMesh;
  index: number;
  city: CityLayout;
  x: number;
  z: number;
  yaw: number;
  /** Scale for a given growth (0..1). */
  scaleFor(growth: number): THREE.Vector3;
  /** Base lift above the plateau for a given growth (for parts stacked on top). */
  liftFor(growth: number): number;
}

interface GrowthEntry {
  parts: GrowthPart[];
  growth: number;
  target: number;
  /** Elapsed time a comic "pop" started (activity hit), or -1. */
  bounceAt: number;
  top: THREE.Vector3;
  topFor(growth: number): number;
}

export interface CitiesVisual {
  group: THREE.Group;
  towerTop(islandId: string): THREE.Vector3 | undefined;
  objectTop(objectId: string): THREE.Vector3 | undefined;
  towerHeight(islandId: string): number;
  /** The city's crown colour (used to tint its rooms). */
  crownColor(islandId: string): number;
  setGrowthTarget(obj: WorldObject): void;
  /** Meshes by kind, for orbit filters (visibility only). */
  kindMeshes: { files: THREE.Object3D[]; harness: THREE.Object3D[]; roads: THREE.Object3D[] };
  setRoadStyle(style: { base: number; dash: number; kerb: number }): void;
  /** Links between cities: on the land, as sea lanes at water level, or hidden (floating districts). */
  setLinkMode(mode: "land" | "sea" | "none"): void;
  /** Squash-and-stretch pop on a building (activity hit). Returns false if the object has no building. */
  bounce(objectId: string, elapsed: number): boolean;
  /** 0 (day) .. 1 (night): every building's windows glow a little warmer and the roads pick up
   *  a touch of streetlight colour (game-feel item 5). Idle agents' houses live in agents.ts. */
  setNightGlow(amount: number): void;
  /** Which already-built cities are actually drawn, re-evaluated live (an agent arriving, a
   *  fossil scan finishing) with no relayout: an island left out of `ids` has its tower/crown and
   *  file-lot instances collapsed to zero scale (positions are untouched, so nothing shifts when
   *  it comes back); `towerTop`/`objectTop`/`towerHeight` keep answering for it regardless, so
   *  flying the camera there or building a house never no-ops just because it's hidden. */
  setVisibleIslands(ids: ReadonlySet<string>): void;
  update(dt: number, elapsed: number): void;
}

const BOUNCE_S = 0.75;

export function towerHeightFor(island: Island, maxAgents: number): number {
  if (island.id === "harness") return 9;
  return 3.2 + 5.5 * Math.sqrt(island.agentCount / Math.max(1, maxAgents));
}

function fileHeight(obj: WorldObject, growth: number): number {
  return 0.7 + Math.log2(1 + obj.usage) * 0.25 + growth * 1.8;
}

/** Road colours are uniforms so themes can turn roads into sea lanes / snow tracks. */
const roadUniforms = {
  uDash: { value: new THREE.Color(1.0, 0.85, 0.2) },
  uKerb: { value: new THREE.Color(0.97, 0.97, 1.0) },
};

function roadMaterial(): THREE.MeshToonMaterial {
  const mat = toon(0x585d78);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDash = roadUniforms.uDash;
    shader.uniforms.uKerb = roadUniforms.uKerb;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vRoadUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoadUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vRoadUv;\nuniform vec3 uDash;\nuniform vec3 uKerb;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float dash = step(0.5, fract(vRoadUv.x * 0.9));
float centre = 1.0 - step(0.07, abs(vRoadUv.y - 0.5));
float kerb = step(0.44, abs(vRoadUv.y - 0.5));
diffuseColor.rgb = mix(diffuseColor.rgb, uDash, centre * dash);
diffuseColor.rgb = mix(diffuseColor.rgb, uKerb, kerb);`,
      );
  };
  return mat;
}

/** Appends a ribbon (strip of quads) following `centres`, `width` wide, facing radially out. */
function pushRibbon(
  centres: THREE.Vector3[],
  width: number,
  out: { pos: number[]; nrm: number[]; uv: number[]; idx: number[] },
): void {
  const base = out.pos.length / 3;
  let dist = 0;
  const side = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < centres.length; i++) {
    const c = centres[i];
    if (!c) continue;
    const next = centres[Math.min(i + 1, centres.length - 1)] ?? c;
    const prev = centres[Math.max(i - 1, 0)] ?? c;
    tangent.subVectors(next, prev).normalize();
    up.copy(c).normalize();
    side.crossVectors(tangent, up).normalize().multiplyScalar(width / 2);
    if (i > 0) dist += c.distanceTo(prev);
    for (const s of [-1, 1]) {
      out.pos.push(c.x + side.x * s, c.y + side.y * s, c.z + side.z * s);
      out.nrm.push(up.x, up.y, up.z);
      out.uv.push(dist, s < 0 ? 0 : 1);
    }
    if (i > 0) {
      const a = base + (i - 1) * 2;
      out.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

export interface CitiesInput {
  islands: Island[];
  objects: WorldObject[];
  layout: Map<string, CityLayout>;
  /** Island pairs that share `visited` edges get a great-circle road. */
  roadPairs: [string, string][];
  groundHeight(dir: THREE.Vector3): number;
  /** Islands with at least one live agent light up their windows. */
  liveIslands: Set<string>;
  pick: PickRegistry;
}

export function buildCities(input: CitiesInput): CitiesVisual {
  const { islands, objects, layout, pick } = input;
  const group = new THREE.Group();
  group.name = "cities";
  const maxAgents = Math.max(1, ...islands.map((i) => i.agentCount));
  const tmpM = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Vector3(0, 0, 0);
  /** 0 (day) .. 1 (night), set by game-feel/life.ts. Blends non-live tower/file windows toward
   *  "lit"; shop/hook/mcp windows stay usage-based (unrelated to day/night). */
  let nightGlow = 0;

  // ---- landmark towers (one per city) ----
  const towerMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.85, 1.05, 1, 8).translate(0, 0.5, 0),
    windowMaterial({ wall: 0xfff6e6, grid: [8, 9] }),
    Math.max(1, islands.length),
  );
  const crownMesh = new THREE.InstancedMesh(
    merge([
      painted(new THREE.ConeGeometry(1.25, 1.9, 8).translate(0, 0.95, 0), 0xffffff),
      painted(new THREE.SphereGeometry(0.28, 10, 8).translate(0, 2.05, 0), 0xffffff),
    ]),
    toon(0xffffff, { vertexColors: true }),
    Math.max(1, islands.length),
  );
  const towerLit = new Float32Array(Math.max(1, islands.length));
  const towerHeights = new Map<string, number>();
  const towerTops = new Map<string, THREE.Vector3>();
  const towerIds: string[] = [];
  /** Enough to rebuild an island's tower+crown matrices on demand (setVisibleIslands): the
   *  instance index and the params `cityMatrix` needs, so "shown" always means "exactly as
   *  built", never a guess. */
  interface TowerEntry {
    index: number;
    city: CityLayout;
    w: number;
    h: number;
  }
  const towerEntries = new Map<string, TowerEntry>();
  islands.forEach((island, i) => {
    const city = layout.get(island.id);
    if (!city) return;
    const h = towerHeightFor(island, maxAgents);
    const w = island.id === "harness" ? 1.5 : 1;
    towerHeights.set(island.id, h);
    towerMesh.setMatrixAt(i, cityMatrix(city, 0, 0, 0, 0, new THREE.Vector3(w, h, w), tmpM));
    crownMesh.setMatrixAt(i, cityMatrix(city, 0, 0, h, 0, new THREE.Vector3(w, w, w), tmpM));
    const crown = island.id === "harness" ? 0xffc300 : (CROWN_COLORS[hashString(island.id) % CROWN_COLORS.length] ?? 0xff4d6d);
    crownMesh.setColorAt(i, new THREE.Color(crown));
    towerLit[i] = input.liveIslands.has(island.id) ? 1 : 0;
    towerTops.set(island.id, cityPoint(city, 0, 0, h + 2.2 * w));
    towerIds[i] = island.id;
    towerEntries.set(island.id, { index: i, city, w, h });
  });
  towerMesh.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(towerLit, 1));
  towerMesh.name = "towers";
  crownMesh.name = "crowns";
  group.add(towerMesh, crownMesh);
  const towerPick = (id: number | undefined): Pick | null => {
    const islandId = id === undefined ? undefined : towerIds[id];
    return islandId ? { kind: "city", id: islandId } : null;
  };
  pick.register(towerMesh, towerPick);
  pick.register(crownMesh, towerPick);

  // ---- per-city lots: files first, then (in agents.ts) houses ----
  const growthEntries = new Map<string, GrowthEntry>();
  const objectTops = new Map<string, THREE.Vector3>();

  const files = objects.filter((o) => o.kind === "file");
  const fileMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.62, 1, 0.62).translate(0, 0.5, 0),
    windowMaterial({ wall: 0xffffff, grid: [2, 4] }),
    Math.max(1, files.length),
  );
  const fileLit = new Float32Array(Math.max(1, files.length));
  const fileIds: string[] = [];
  const fileIslandOf: string[] = [];
  const filesByIsland = new Map<string, WorldObject[]>();
  for (const f of files) {
    const list = filesByIsland.get(f.islandId) ?? [];
    list.push(f);
    filesByIsland.set(f.islandId, list);
  }
  let fi = 0;
  for (const [islandId, list] of filesByIsland) {
    const city = layout.get(islandId);
    if (!city) continue;
    list.sort((a, b) => b.usage - a.usage);
    list.forEach((obj, lot) => {
      const [x, z] = lotLocal(lot);
      const yaw = Math.atan2(x, z);
      const idx = fi++;
      fileIds[idx] = obj.id;
      fileIslandOf[idx] = islandId;
      fileMesh.setColorAt(idx, new THREE.Color(PASTELS[hashString(obj.id) % PASTELS.length] ?? 0xffffff));
      fileLit[idx] = input.liveIslands.has(islandId) ? 1 : 0;
      const part: GrowthPart = {
        mesh: fileMesh,
        index: idx,
        city,
        x,
        z,
        yaw,
        scaleFor: (g) => new THREE.Vector3(1, fileHeight(obj, g), 1),
        liftFor: () => 0,
      };
      registerGrowth(obj, [part], (g) => fileHeight(obj, g) + 0.3);
    });
  }
  fileMesh.count = fi;
  fileMesh.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(fileLit, 1));
  fileMesh.name = "files";
  group.add(fileMesh);
  pick.register(fileMesh, (id) => {
    const oid = id === undefined ? undefined : fileIds[id];
    return oid ? { kind: "object", id: oid } : null;
  });

  // ---- Harness City: skills = shop fronts, hooks = arches, MCPs = antennas ----
  const harnessCity = layout.get("harness");
  const harnessObjs = objects
    .filter((o) => o.kind === "skill" || o.kind === "hook" || o.kind === "mcp")
    .sort((a, b) => b.growth - a.growth || b.usage - a.usage);
  const skills = harnessObjs.filter((o) => o.kind === "skill");
  const hooks = harnessObjs.filter((o) => o.kind === "hook");
  const mcps = harnessObjs.filter((o) => o.kind === "mcp");
  const shopMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.72, 1, 0.72).translate(0, 0.5, 0),
    windowMaterial({ wall: 0xfff3dc, grid: [2, 3] }),
    Math.max(1, skills.length),
  );
  const awningMesh = new THREE.InstancedMesh(
    merge([
      painted(new THREE.BoxGeometry(0.84, 0.08, 0.84).translate(0, 0.04, 0), 0xffffff),
      painted(new THREE.BoxGeometry(0.8, 0.22, 0.12).rotateX(-0.5).translate(0, -0.12, 0.43), 0xffffff),
    ]),
    toon(0xffffff, { vertexColors: true }),
    Math.max(1, skills.length),
  );
  const archMesh = new THREE.InstancedMesh(
    merge([
      painted(new THREE.TorusGeometry(0.42, 0.1, 8, 16, Math.PI), 0xffffff),
      painted(new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(-0.42, 0, 0), 0xffffff),
      painted(new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0.42, 0, 0), 0xffffff),
    ]),
    toon(0xffffff, { vertexColors: true }),
    Math.max(1, hooks.length),
  );
  const antennaMesh = new THREE.InstancedMesh(
    merge([
      painted(new THREE.CylinderGeometry(0.05, 0.12, 1, 6).translate(0, 0.5, 0), 0xdfe6f5),
      painted(new THREE.SphereGeometry(0.34, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-1.1).translate(0, 0.78, 0.05), 0xffffff),
      painted(new THREE.SphereGeometry(0.09, 8, 6).translate(0, 1.05, 0), 0xff3355),
    ]),
    toon(0xffffff, { vertexColors: true }),
    Math.max(1, mcps.length),
  );
  const shopIds: string[] = [];
  const archIds: string[] = [];
  const antennaIds: string[] = [];
  const shopLit = new Float32Array(Math.max(1, skills.length));
  if (harnessCity) {
    let si = 0;
    let hi = 0;
    let ai = 0;
    harnessObjs.forEach((obj, lot) => {
      const [x, z] = lotLocal(lot);
      const yaw = Math.atan2(x, z);
      // Station colours (shared/stations.ts), same everywhere as the Feed's chips and the
      // Canvas's nodes: every skill shop's awning is the Skill colour (its "band"); every hook's
      // arch (already shaped like a colour band across the path) is the flat Hook colour; every
      // MCP antenna gets a stable tint of its own server, via mcpTint.
      if (obj.kind === "skill") {
        const idx = si++;
        shopIds[idx] = obj.id;
        shopLit[idx] = obj.usage > 0 ? 1 : 0;
        awningMesh.setColorAt(idx, new THREE.Color(STATIONS.skill.color));
        const shopH = (g: number): number => 0.7 + g * 2.2 + Math.min(0.6, obj.usage * 0.02);
        registerGrowth(
          obj,
          [
            { mesh: shopMesh, index: idx, city: harnessCity, x, z, yaw, scaleFor: (g) => new THREE.Vector3(1, shopH(g), 1), liftFor: () => 0 },
            { mesh: awningMesh, index: idx, city: harnessCity, x, z, yaw, scaleFor: () => one, liftFor: shopH },
          ],
          (g) => shopH(g) + 0.4,
        );
      } else if (obj.kind === "hook") {
        const idx = hi++;
        archIds[idx] = obj.id;
        archMesh.setColorAt(idx, new THREE.Color(STATIONS.hook.color));
        const s = (g: number): number => 0.9 + g * 1.3;
        registerGrowth(
          obj,
          [{ mesh: archMesh, index: idx, city: harnessCity, x, z, yaw, scaleFor: (g) => new THREE.Vector3(s(g), s(g), s(g)), liftFor: () => 0.05 }],
          (g) => s(g) * 0.55 + 0.3,
        );
      } else {
        const idx = ai++;
        antennaIds[idx] = obj.id;
        antennaMesh.setColorAt(idx, new THREE.Color(0xffffff).lerp(new THREE.Color(mcpTint(obj.name)), 0.25));
        const h = (g: number): number => 1.4 + g * 3;
        registerGrowth(
          obj,
          [{ mesh: antennaMesh, index: idx, city: harnessCity, x, z, yaw, scaleFor: (g) => new THREE.Vector3(1.4, h(g), 1.4), liftFor: () => 0 }],
          (g) => h(g) * 1.1 + 0.3,
        );
      }
    });
    shopMesh.count = si;
    awningMesh.count = si;
    archMesh.count = hi;
    antennaMesh.count = ai;
  } else {
    shopMesh.count = awningMesh.count = archMesh.count = antennaMesh.count = 0;
  }
  shopMesh.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(shopLit, 1));
  group.add(shopMesh, awningMesh, archMesh, antennaMesh);
  const idPick = (ids: string[]) => (id: number | undefined): Pick | null => {
    const oid = id === undefined ? undefined : ids[id];
    return oid ? { kind: "object", id: oid } : null;
  };
  pick.register(shopMesh, idPick(shopIds));
  pick.register(awningMesh, idPick(shopIds));
  pick.register(archMesh, idPick(archIds));
  pick.register(antennaMesh, idPick(antennaIds));

  function registerGrowth(obj: WorldObject, parts: GrowthPart[], topFor: (g: number) => number): void {
    const first = parts[0];
    if (!first) return;
    const entry: GrowthEntry = {
      parts,
      growth: obj.growth,
      target: obj.growth,
      bounceAt: -1,
      top: cityPoint(first.city, first.x, first.z, topFor(obj.growth)),
      topFor,
    };
    growthEntries.set(obj.id, entry);
    objectTops.set(obj.id, entry.top);
    applyGrowth(entry);
  }

  function applyGrowth(entry: GrowthEntry, pop = 0): void {
    const sy = 1 + 0.55 * pop;
    const sxz = 1 - 0.18 * pop;
    for (const p of entry.parts) {
      const sc = p.scaleFor(entry.growth).clone().multiply(new THREE.Vector3(sxz, sy, sxz));
      p.mesh.setMatrixAt(p.index, cityMatrix(p.city, p.x, p.z, p.liftFor(entry.growth) * sy, p.yaw, sc, tmpM));
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.boundingSphere = null;
    }
    const first = entry.parts[0];
    if (first) cityPoint(first.city, first.x, first.z, entry.topFor(entry.growth), entry.top);
  }

  // ---- roads: a ring road per city + great-circle roads between cities that shared visits ----
  const road = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], idx: [] as number[] };
  for (const city of layout.values()) {
    const ring: THREE.Vector3[] = [];
    const rr = city.radius + 0.1;
    const segs = Math.max(40, Math.round(rr * 10));
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ring.push(cityPoint(city, Math.cos(a) * rr, Math.sin(a) * rr, 0.06));
    }
    pushRibbon(ring, 0.95, road);
  }
  // Links between cities: one on the land (world), one at sea level (archipelago sea lanes).
  const linkLand = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], idx: [] as number[] };
  const linkSea = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], idx: [] as number[] };
  const seen = new Set<string>();
  for (const [a, b] of input.roadPairs) {
    const key = [a, b].sort().join("|");
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    const ca = layout.get(a);
    const cb = layout.get(b);
    if (!ca || !cb) continue;
    const angle = ca.dir.angleTo(cb.dir);
    const start = (ca.radius + 0.1) / CITY_SURFACE;
    const end = angle - (cb.radius + 0.1) / CITY_SURFACE;
    if (end <= start) continue;
    const axis = new THREE.Vector3().crossVectors(ca.dir, cb.dir).normalize();
    const steps = Math.max(8, Math.ceil(((end - start) * PLANET_R) / 0.6));
    const land: THREE.Vector3[] = [];
    const sea: THREE.Vector3[] = [];
    const d = new THREE.Vector3();
    const span = (end - start) * PLANET_R;
    for (let i = 0; i <= steps; i++) {
      const t = start + ((end - start) * i) / steps;
      d.copy(ca.dir).applyAxisAngle(axis, t);
      const h = Math.max(input.groundHeight(d), 0.45) + 0.12;
      land.push(d.clone().multiplyScalar(PLANET_R + h));
      // Sea lane: leaves the plateau over ~3 units, then rides just above the water.
      const edge = Math.min((i / steps) * span, (1 - i / steps) * span);
      sea.push(d.clone().multiplyScalar(PLANET_R + 0.1 + 0.9 * Math.max(0, 1 - edge / 3)));
    }
    pushRibbon(land, 0.8, linkLand);
    pushRibbon(sea, 0.8, linkSea);
  }
  const ribbonMesh = (r: typeof road, name: string, mat: THREE.Material): THREE.Mesh => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(r.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(r.nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(r.uv, 2));
    geo.setIndex(r.idx);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    return mesh;
  };
  const roadMat = roadMaterial();
  const roads = ribbonMesh(road, "roads", roadMat);
  const links = ribbonMesh(linkLand, "road-links", roadMat);
  const seaLinks = ribbonMesh(linkSea, "sea-lanes", roadMat);
  seaLinks.visible = false;
  group.add(roads, links, seaLinks);

  for (const m of [towerMesh, crownMesh, fileMesh, shopMesh, awningMesh, archMesh, antennaMesh]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // ---- district visibility: which built cities are actually drawn (setVisibleIslands) ----
  // Construction above puts every city at full scale, so this starts as "everything shown" and
  // only touches an island's instances the moment its wanted state actually flips.
  let shownIslands = new Set(islands.map((i) => i.id));
  /** Growth entries on hidden islands: update() keeps their growth moving but never draws them. */
  const hiddenEntries = new Set<GrowthEntry>();

  const visual: CitiesVisual = {
    group,
    kindMeshes: { files: [fileMesh], harness: [shopMesh, awningMesh, archMesh, antennaMesh], roads: [roads, links, seaLinks] },
    setLinkMode(mode) {
      links.visible = mode === "land";
      seaLinks.visible = mode === "sea";
    },
    setRoadStyle(style) {
      roadMat.color.setHex(style.base);
      roadUniforms.uDash.value.setHex(style.dash);
      roadUniforms.uKerb.value.setHex(style.kerb);
    },
    towerTop: (id) => towerTops.get(id),
    objectTop: (id) => objectTops.get(id),
    towerHeight: (id) => towerHeights.get(id) ?? 4,
    crownColor: (id) => (id === "harness" ? 0xffc300 : (CROWN_COLORS[hashString(id) % CROWN_COLORS.length] ?? 0xff4d6d)),
    setGrowthTarget(obj) {
      const entry = growthEntries.get(obj.id);
      if (entry) entry.target = obj.growth;
    },
    bounce(objectId, elapsed) {
      const entry = growthEntries.get(objectId);
      if (!entry) return false;
      entry.bounceAt = elapsed;
      return true;
    },
    setNightGlow(amount) {
      const clamped = Math.max(0, Math.min(1, amount));
      if (Math.abs(clamped - nightGlow) < 0.02) return; // skip a repaint for a barely-changed value
      nightGlow = clamped;
      islands.forEach((island, i) => {
        towerLit[i] = input.liveIslands.has(island.id) ? 1 : nightGlow * 0.5;
      });
      const towerAttr = towerMesh.geometry.getAttribute("aLit");
      if (towerAttr) towerAttr.needsUpdate = true;
      for (let idx = 0; idx < fi; idx++) {
        const islandId = fileIslandOf[idx];
        fileLit[idx] = islandId && input.liveIslands.has(islandId) ? 1 : nightGlow * 0.5;
      }
      const fileAttr = fileMesh.geometry.getAttribute("aLit");
      if (fileAttr) fileAttr.needsUpdate = true;
    },
    setVisibleIslands(ids) {
      let towersChanged = false;
      let filesChanged = false;
      for (const [islandId, entry] of towerEntries) {
        const want = ids.has(islandId);
        if (want === shownIslands.has(islandId)) continue;
        towersChanged = true;
        towerMesh.setMatrixAt(entry.index, cityMatrix(entry.city, 0, 0, 0, 0, want ? new THREE.Vector3(entry.w, entry.h, entry.w) : zero, tmpM));
        crownMesh.setMatrixAt(entry.index, cityMatrix(entry.city, 0, 0, entry.h, 0, want ? new THREE.Vector3(entry.w, entry.w, entry.w) : zero, tmpM));
      }
      for (const [islandId, list] of filesByIsland) {
        const want = ids.has(islandId);
        if (want === shownIslands.has(islandId)) continue;
        for (const obj of list) {
          const entry = growthEntries.get(obj.id);
          if (!entry) continue;
          filesChanged = true;
          if (want) hiddenEntries.delete(entry);
          else hiddenEntries.add(entry);
          if (want) applyGrowth(entry);
          else for (const p of entry.parts) p.mesh.setMatrixAt(p.index, cityMatrix(p.city, p.x, p.z, 0, p.yaw, zero, tmpM));
        }
      }
      if (towersChanged) {
        towerMesh.instanceMatrix.needsUpdate = true;
        crownMesh.instanceMatrix.needsUpdate = true;
      }
      if (filesChanged) fileMesh.instanceMatrix.needsUpdate = true;
      shownIslands = new Set(ids);
    },
    update(dt, elapsed) {
      for (const entry of growthEntries.values()) {
        const bouncing = entry.bounceAt >= 0;
        const growing = Math.abs(entry.target - entry.growth) >= 0.001;
        if (!bouncing && !growing) continue;
        if (growing) {
          entry.growth = THREE.MathUtils.damp(entry.growth, entry.target, 3, dt);
          if (Math.abs(entry.target - entry.growth) < 0.001) entry.growth = entry.target;
        }
        let pop = 0;
        if (bouncing) {
          const k = (elapsed - entry.bounceAt) / BOUNCE_S;
          if (k >= 1) entry.bounceAt = -1;
          else pop = Math.sin(k * Math.PI * 3) * (1 - k);
        }
        if (hiddenEntries.has(entry)) continue; // a hidden island's files stay zero-scale; shown again via setVisibleIslands
        applyGrowth(entry, pop);
      }
    },
  };
  registerSceneParts({ cities: visual });
  return visual;
}
