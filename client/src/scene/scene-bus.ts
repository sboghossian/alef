// Scene bus: the scene builders (rig, planet, cities, agents, plaza) register their
// handles here as they are built, so orbit features (features/orbit-*.ts) can restyle
// and filter the world without new ClientContext fields or edits to main.ts.
// One world per page load, so module scope is the right lifetime.

import type * as THREE from "three";
import type { CityLayout } from "../layout";
import type { AgentsVisual } from "./agents";
import type { CitiesVisual } from "./cities";
import type { PlanetVisual } from "./planet";
import type { PlazaVisual } from "./plaza";
import type { PickRegistry } from "./pick";
import type { InkPost } from "./post";
import type { GlStatus } from "./webgl";

export interface RigParts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  post: InkPost;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
}

export interface SceneParts {
  rig?: RigParts;
  planet?: PlanetVisual;
  /** Every city layout, as buildPlanet received it. */
  layout?: CityLayout[];
  cities?: CitiesVisual;
  agents?: AgentsVisual;
  plaza?: PlazaVisual;
  pick?: PickRegistry;
  /** Rolling render stats, refreshed every 0.5s by main.ts (fps over 1s, p95 frame ms over 10s).
   *  Never written while `webgl` is off or lost: nothing is drawn then. */
  frameStats?: { fps: number; p95ms: number };
  /** Whether the 3D view is drawing (ui/no-3d.ts). With no `rig`, WebGL never started. */
  webgl?: GlStatus;
}

const parts: SceneParts = {};
const listeners = new Set<(p: SceneParts) => void>();

export function registerSceneParts(p: Partial<SceneParts>): void {
  Object.assign(parts, p);
  for (const fn of listeners) fn(parts);
}

export function sceneParts(): Readonly<SceneParts> {
  return parts;
}

/** Called now and after every registration. */
export function onSceneParts(fn: (p: SceneParts) => void): () => void {
  listeners.add(fn);
  fn(parts);
  return () => listeners.delete(fn);
}
