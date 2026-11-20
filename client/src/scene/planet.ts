import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CITY_H, PLANET_R, type CityLayout } from "../layout";
import { fbm3, noise3, rng } from "./noise";
import { merge, painted, toon } from "./toon";
import { registerSceneParts } from "./scene-bus";
import { THEMES, type TerrainMode, type TerrainPalette, type ThemeSpec } from "./theme";

/** Elevation value that maps exactly to the city plateau height. */
const CITY_E = CITY_H / 5;
/** Layer for things that must not get ink lines (atmosphere glow). */
export const NO_INK_LAYER = 1;

export interface PlanetVisual {
  group: THREE.Group;
  terrain: THREE.Mesh;
  /** Height above sea level of the ground (0 on the sea). */
  groundHeight(dir: THREE.Vector3): number;
  update(dt: number): void;
  /** Palette, terrain geometry (world / islands / space), trees, clouds and atmosphere. Never the layout. */
  applyTheme(theme: ThemeSpec): void;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function heightFromElev(e: number): number {
  if (e <= 0) return 0;
  if (e <= 0.3) return e * 5;
  return 1.5 + Math.min(1, (e - 0.3) / 0.45) * 6;
}

type Elevation = (d: THREE.Vector3) => { e: number; cityW: number };

function makeElevation(cities: CityLayout[]): Elevation {
  const cityData = cities.map((c) => ({
    dir: c.dir,
    inner: (c.radius + 2.4) / PLANET_R,
    outer: (c.radius + 8.5) / PLANET_R,
  }));
  return (d) => {
    const b = fbm3(d.x * 1.35 + 3.1, d.y * 1.35 - 1.7, d.z * 1.35 + 0.4, 5, 7);
    let e = b * 1.45 - 0.07;
    const ridge = 1 - Math.abs(noise3(d.x * 3.4, d.y * 3.4, d.z * 3.4, 11));
    e += ridge * ridge * ridge * 0.42 * smoothstep(0.08, 0.28, e);
    let w = 0;
    for (const c of cityData) {
      const ang = Math.acos(Math.min(1, Math.max(-1, d.dot(c.dir))));
      if (ang > c.outer) continue;
      w = Math.max(w, 1 - smoothstep(c.inner, c.outer, ang));
    }
    // Cities sit on flat green plateaus; the coast fades back to noise around them.
    e = e * (1 - w) + CITY_E * w;
    return { e, cityW: w };
  };
}

const TERRAIN_VERT_HEAD = `#include <common>
attribute float aElev;
attribute float aVar;
varying float vElev;
varying float vVar;`;

const TERRAIN_FRAG_HEAD = `#include <common>
varying float vElev;
varying float vVar;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uSand;
uniform vec3 uGrassA;
uniform vec3 uGrassB;
uniform vec3 uRock;
uniform vec3 uSnow;
vec3 terrainColor(float e, float v) {
  if (e < -0.32) return uDeep;
  if (e < -0.1) return mix(uDeep, uMid, smoothstep(-0.32, -0.16, e));
  if (e < -0.022) return mix(uMid, uShallow, smoothstep(-0.12, -0.05, e));
  if (e < 0.0) return uFoam;
  if (e < 0.035) return uSand;
  if (e < 0.34) return mix(uGrassA, uGrassB, smoothstep(0.0, 1.0, v)) * (1.0 - 0.1 * smoothstep(0.2, 0.34, e));
  if (e < 0.52 + v * 0.06) return uRock;
  return uSnow;
}`;

/** Terrain palette uniforms, shared by every terrain geometry; themes write `.value`. */
const terrainUniforms: Record<keyof TerrainPalette, { value: THREE.Color }> = {
  deep: { value: new THREE.Color() },
  mid: { value: new THREE.Color() },
  shallow: { value: new THREE.Color() },
  foam: { value: new THREE.Color() },
  sand: { value: new THREE.Color() },
  grassA: { value: new THREE.Color() },
  grassB: { value: new THREE.Color() },
  rock: { value: new THREE.Color() },
  snow: { value: new THREE.Color() },
};

function setTerrainPalette(p: TerrainPalette): void {
  for (const k of Object.keys(terrainUniforms) as (keyof TerrainPalette)[]) terrainUniforms[k].value.setHex(p[k]);
}

/** Unit icosphere with shared vertices; the base of every terrain geometry (built once). */
let unitSphere: THREE.BufferGeometry | null = null;
function unitTerrainSphere(): THREE.BufferGeometry {
  if (unitSphere) return unitSphere;
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 72);
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo);
  unitSphere = geo;
  return geo;
}

/** Terrain sample for a unit direction: elevation (colour) and radius. null drops the vertex (space mode). */
type TerrainSample = (d: THREE.Vector3) => { e: number; r: number } | null;

function buildTerrainGeometry(sample: TerrainSample): THREE.BufferGeometry {
  const unit = unitTerrainSphere();
  const src = unit.getAttribute("position");
  const pos = new Float32Array(src.count * 3);
  const elev = new Float32Array(src.count);
  const variation = new Float32Array(src.count);
  const keep = new Uint8Array(src.count);
  const d = new THREE.Vector3();
  for (let i = 0; i < src.count; i++) {
    d.fromBufferAttribute(src, i).normalize();
    const s = sample(d);
    variation[i] = noise3(d.x * 9, d.y * 9, d.z * 9, 23) * 0.5 + 0.5;
    if (!s) continue;
    keep[i] = 1;
    elev[i] = s.e;
    pos.set([d.x * s.r, d.y * s.r, d.z * s.r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aElev", new THREE.BufferAttribute(elev, 1));
  geo.setAttribute("aVar", new THREE.BufferAttribute(variation, 1));
  const index = unit.getIndex();
  if (index) {
    const out: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      if (keep[a] && keep[b] && keep[c]) out.push(a, b, c);
    }
    geo.setIndex(out);
  }
  geo.computeVertexNormals();
  return geo;
}

function terrainMaterial(): THREE.MeshToonMaterial {
  const mat = toon(0xffffff);
  mat.onBeforeCompile = (shader) => {
    for (const [k, u] of Object.entries(terrainUniforms)) shader.uniforms[`u${k[0]?.toUpperCase()}${k.slice(1)}`] = u;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", TERRAIN_VERT_HEAD)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvElev = aElev;\nvVar = aVar;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", TERRAIN_FRAG_HEAD)
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = terrainColor(vElev, vVar);");
  };
  return mat;
}

/** Archipelago: only the city plateaus (and a beach) stay above a bright sea. */
function islandsSample(elevation: Elevation): TerrainSample {
  return (d) => {
    const { cityW } = elevation(d);
    const sea = -0.14 - 0.2 * (noise3(d.x * 4, d.y * 4, d.z * 4, 5) * 0.5 + 0.5);
    // Land only close to a plateau: a beach ring, then open sea.
    const k = smoothstep(0.5, 0.92, cityW);
    const ei = sea * (1 - k) + CITY_E * k;
    return { e: ei, r: PLANET_R + heightFromElev(ei) };
  };
}

/** A district's small planet in the Space theme: a ball whose top sits just under the plateau. */
export interface Planetoid {
  cityId: string;
  center: THREE.Vector3;
  radius: number;
}

export function planetoidFor(city: CityLayout): Planetoid {
  // Just big enough to carry the city, its ring road (and, for the capital, the plaza + Tool Yard).
  const radius = city.radius + (city.id === "harness" ? 4.6 : 2.4);
  return { cityId: city.id, radius, center: city.dir.clone().multiplyScalar(PLANET_R + CITY_H - 0.06 - radius) };
}

/** Space: the flat plateau, then a rocky rim that follows the city's planetoid; everything else is dropped. */
function spaceSample(elevation: Elevation, cities: CityLayout[]): TerrainSample {
  const balls = cities.map((c) => {
    const ball = planetoidFor(c);
    return { city: c, ball, inner: (ball.radius - 1.4) / PLANET_R };
  });
  return (d) => {
    let best: (typeof balls)[number] | undefined;
    let bestScore = Infinity;
    for (const b of balls) {
      const score = Math.acos(Math.min(1, Math.max(-1, d.dot(b.city.dir)))) / (b.ball.radius / PLANET_R);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return null;
    const ang = Math.acos(Math.min(1, Math.max(-1, d.dot(best.city.dir))));
    if (ang <= best.inner) {
      const { e } = elevation(d);
      return { e: Math.max(e, CITY_E), r: PLANET_R + CITY_H };
    }
    // Outer ray/ball intersection: |t d - C|^2 = rho^2.
    const dc = d.dot(best.ball.center);
    const disc = dc * dc - best.ball.center.lengthSq() + best.ball.radius * best.ball.radius;
    if (disc < 0.4) return null;
    const t = dc + Math.sqrt(disc);
    const rim = Math.min(1, (ang - best.inner) / 0.05);
    return { e: 0.4 + 0.08 * rim, r: Math.min(PLANET_R + CITY_H, t + 0.04) };
  };
}

function pineGeometry(): THREE.BufferGeometry {
  const trunk = painted(new THREE.CylinderGeometry(0.07, 0.09, 0.4, 5).translate(0, 0.2, 0), 0x8a5a35);
  const low = painted(new THREE.ConeGeometry(0.42, 0.75, 7).translate(0, 0.62, 0), 0x2f9e4f);
  const high = painted(new THREE.ConeGeometry(0.3, 0.6, 7).translate(0, 1.0, 0), 0x3dba5c);
  return merge([trunk, low, high]);
}

function roundTreeGeometry(): THREE.BufferGeometry {
  const trunk = painted(new THREE.CylinderGeometry(0.07, 0.1, 0.45, 5).translate(0, 0.22, 0), 0x8a5a35);
  const crown = painted(new THREE.IcosahedronGeometry(0.42, 1).translate(0, 0.72, 0), 0x6fd23f);
  return merge([trunk, crown]);
}

/** 0..1: pushes trees toward frosty white (Snow globe theme). */
const frostUniform = { value: 0 };

function buildTrees(elevation: Elevation): THREE.Group {
  const group = new THREE.Group();
  const rand = rng(99);
  const pines: THREE.Matrix4[] = [];
  const rounds: THREE.Matrix4[] = [];
  const d = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  for (let tries = 0; tries < 9000 && pines.length + rounds.length < 2200; tries++) {
    const y = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    d.set(Math.cos(th) * r, y, Math.sin(th) * r);
    const forest = noise3(d.x * 5, d.y * 5, d.z * 5, 41);
    if (forest < -0.05) continue;
    const { e, cityW } = elevation(d);
    if (e < 0.045 || e > 0.46 || cityW > 0.05) continue;
    const h = PLANET_R + heightFromElev(e) - 0.05;
    const s = 1.3 + rand() * 1.1;
    q.setFromUnitVectors(up, d);
    twist.setFromAxisAngle(up, rand() * Math.PI * 2);
    q.multiply(twist);
    const m = new THREE.Matrix4().compose(d.clone().multiplyScalar(h), q, new THREE.Vector3(s, s, s));
    (e > 0.22 || rand() < 0.45 ? pines : rounds).push(m);
  }
  const mat = toon(0xffffff, { vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFrost = frostUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uFrost;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.98, 1.0), uFrost);",
      );
  };
  for (const [geo, list] of [
    [pineGeometry(), pines],
    [roundTreeGeometry(), rounds],
  ] as const) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const tint = new THREE.Color();
    list.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      tint.setHSL(0, 0, 0.9 + rand() * 0.1);
      mesh.setColorAt(i, tint);
    });
    mesh.name = "trees";
    group.add(mesh);
  }
  return group;
}

function buildCloudLayer(seed: number, count: number, radius: number): THREE.InstancedMesh {
  const rand = rng(seed);
  const puffGeo = new THREE.IcosahedronGeometry(1, 2);
  const mat = toon(0xffffff);
  const perCluster = 6;
  const mesh = new THREE.InstancedMesh(puffGeo, mat, count * perCluster);
  const up = new THREE.Vector3(0, 1, 0);
  const d = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let idx = 0;
  for (let c = 0; c < count; c++) {
    const y = (rand() * 2 - 1) * 0.92;
    const th = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    d.set(Math.cos(th) * r, y, Math.sin(th) * r);
    q.setFromUnitVectors(up, d);
    const size = 1.1 + rand() * 1.2;
    for (let p = 0; p < perCluster; p++) {
      const off = new THREE.Vector3((p - perCluster / 2) * 0.9 * size + (rand() - 0.5) * 0.6, (rand() - 0.2) * 0.6 * size, (rand() - 0.5) * 1.4 * size);
      const s = size * (0.75 + rand() * 0.6) * (1 - Math.abs(p - (perCluster - 1) / 2) * 0.13);
      const local = off.applyQuaternion(q);
      const pos = d.clone().multiplyScalar(radius).add(local);
      mesh.setMatrixAt(idx++, new THREE.Matrix4().compose(pos, q, new THREE.Vector3(s, s * 0.78, s)));
    }
  }
  mesh.name = "clouds";
  return mesh;
}

function buildAtmosphere(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0x8fe6ff) } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
void main() {
  float f = dot(vN, vV);
  float rim = smoothstep(-0.05, 0.4, -f) * (1.0 - smoothstep(0.4, 0.75, -f));
  gl_FragColor = vec4(uColor * rim * 0.9, 1.0);
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.13, 64, 48), mat);
  mesh.layers.set(NO_INK_LAYER);
  mesh.name = "atmosphere";
  return mesh;
}

/** Purple comic sky: a radial gradient, a faint halftone grid and twinkly stars. */
export function buildSkyTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  const g = ctx.createRadialGradient(size * 0.5, size * 0.55, size * 0.1, size * 0.5, size * 0.5, size * 0.75);
  g.addColorStop(0, "#7a5ad8");
  g.addColorStop(1, "#44308f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let y = 0; y < size; y += 14) {
    for (let x = (y / 14) % 2 ? 7 : 0; x < size; x += 14) {
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const rand = rng(5);
  for (let i = 0; i < 160; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = rand() < 0.1 ? 3 : 1.2 + rand();
    ctx.fillStyle = rand() < 0.2 ? "#fff4b0" : "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (r > 2) {
      ctx.fillRect(x - 7, y - 0.8, 14, 1.6);
      ctx.fillRect(x - 0.8, y - 7, 1.6, 14);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildPlanet(cities: CityLayout[]): PlanetVisual {
  const group = new THREE.Group();
  const elevation = makeElevation(cities);
  const material = terrainMaterial();
  const worldGeo = buildTerrainGeometry((d) => {
    const { e } = elevation(d);
    return { e, r: PLANET_R + heightFromElev(e) };
  });
  const terrain = new THREE.Mesh(worldGeo, material);
  terrain.name = "terrain";
  group.add(terrain);
  const trees = buildTrees(elevation);
  group.add(trees);

  const cloudsLow = new THREE.Group();
  const lowLayer = buildCloudLayer(3, 22, PLANET_R + 10);
  cloudsLow.add(lowLayer);
  const cloudsHigh = new THREE.Group();
  const highLayer = buildCloudLayer(8, 16, PLANET_R + 14);
  cloudsHigh.add(highLayer);
  cloudsHigh.rotation.z = 0.4;
  const atmosphere = buildAtmosphere();
  group.add(cloudsLow, cloudsHigh, atmosphere);

  const lowAxis = new THREE.Vector3(0.2, 1, 0.1).normalize();
  const highAxis = new THREE.Vector3(-0.3, 1, 0.2).normalize();

  // Theme geometries are built on first use and kept (switching back is free).
  const geometries = new Map<TerrainMode, THREE.BufferGeometry>([["world", worldGeo]]);
  let planetoids: THREE.InstancedMesh | null = null;
  const geometryFor = (mode: TerrainMode): THREE.BufferGeometry => {
    let geo = geometries.get(mode);
    if (!geo) {
      geo = buildTerrainGeometry(mode === "islands" ? islandsSample(elevation) : spaceSample(elevation, cities));
      geometries.set(mode, geo);
    }
    return geo;
  };
  const planetoidMesh = (): THREE.InstancedMesh => {
    if (planetoids) return planetoids;
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 4), toon(0xffffff), Math.max(1, cities.length));
    const m = new THREE.Matrix4();
    const tints = [0xd9c8ff, 0xffd3e6, 0xcdeee0, 0xffe2c4, 0xd0e4ff, 0xf6d4ff];
    cities.forEach((c, i) => {
      const b = planetoidFor(c);
      mesh.setMatrixAt(i, m.makeScale(b.radius, b.radius, b.radius).setPosition(b.center));
      mesh.setColorAt(i, new THREE.Color(c.id === "harness" ? 0xffe08a : (tints[i % tints.length] ?? 0xd9c8ff)));
    });
    mesh.count = cities.length;
    mesh.name = "planetoids";
    group.add(mesh);
    planetoids = mesh;
    return mesh;
  };

  const cloudMats = [lowLayer.material, highLayer.material].filter((m): m is THREE.MeshToonMaterial => m instanceof THREE.MeshToonMaterial);
  const atmosphereColor = atmosphere.material instanceof THREE.ShaderMaterial ? atmosphere.material.uniforms.uColor : undefined;

  const visual: PlanetVisual = {
    group,
    terrain,
    groundHeight(dir) {
      return heightFromElev(elevation(dir.clone().normalize()).e);
    },
    update(dt) {
      cloudsLow.rotateOnAxis(lowAxis, dt * 0.012);
      cloudsHigh.rotateOnAxis(highAxis, -dt * 0.008);
    },
    applyTheme(theme) {
      setTerrainPalette(theme.palette);
      terrain.geometry = geometryFor(theme.terrain);
      if (theme.props.planetoids || planetoids) planetoidMesh().visible = theme.props.planetoids;
      trees.visible = theme.treesVisible;
      frostUniform.value = theme.frost;
      cloudsLow.visible = theme.cloudsVisible;
      cloudsHigh.visible = theme.cloudsVisible;
      for (const m of cloudMats) m.color.setHex(theme.clouds);
      if (atmosphereColor?.value instanceof THREE.Color) atmosphereColor.value.setHex(theme.atmosphere);
    },
  };
  setTerrainPalette(THEMES[0]!.palette);
  registerSceneParts({ planet: visual, layout: cities });
  return visual;
}
