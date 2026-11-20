import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

let gradient: THREE.DataTexture | null = null;

/** 3-step toon ramp. The darkest step stays bright so no side is ever dark. */
export function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const steps = [150, 208, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => {
    data.set([v, v, v, 255], i * 4);
  });
  gradient = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(color: THREE.ColorRepresentation, opts: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...opts });
}

/** Paints a geometry a single vertex colour (for merging multi-coloured props into one draw call). */
export function painted(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("mergeGeometries failed (attribute mismatch)");
  return merged;
}

export interface WindowMaterialOptions {
  wall: THREE.ColorRepresentation;
  /** Windows per face (columns, rows). */
  grid: [number, number];
  /** Tint the whole wall with instanceColor instead of the roof. */
  tintWalls?: boolean;
}

/**
 * Toon material that draws a window grid on vertical faces (from the box
 * UVs). A per-instance `aLit` attribute (0..1) switches windows between
 * lit (warm yellow) and asleep (soft slate, never black).
 */
export function windowMaterial(opts: WindowMaterialOptions): THREE.MeshToonMaterial {
  const mat = toon(opts.wall);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrid = { value: new THREE.Vector2(opts.grid[0], opts.grid[1]) };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aLit;
varying float vLit;
varying float vUpN;
varying vec2 vWinUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vLit = aLit;
vUpN = normal.y;
vWinUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec2 uGrid;
varying float vLit;
varying float vUpN;
varying vec2 vWinUv;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
if (abs(vUpN) < 0.5) {
  vec2 cell = fract(vWinUv * uGrid);
  float win = step(0.28, cell.x) * step(cell.x, 0.72) * step(0.3, cell.y) * step(cell.y, 0.75);
  float groundFloor = step(vWinUv.y * uGrid.y, 0.35);
  win *= 1.0 - groundFloor;
  vec3 lit = vec3(1.0, 0.86, 0.3);
  vec3 asleep = vec3(0.42, 0.5, 0.72);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(asleep, lit, vLit), win);
}`,
      );
  };
  return mat;
}
