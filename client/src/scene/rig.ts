import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FRONT_DIR, PLANET_R } from "../layout";
import { NO_INK_LAYER, buildSkyTexture } from "./planet";
import { createInkPost, VIEW_LIGHT_DIR, type InkPost } from "./post";
import { registerSceneParts } from "./scene-bus";
import { probeWebGL, startGl } from "./webgl";

/** The GPU half of the rig. */
export interface RigGl {
  renderer: THREE.WebGLRenderer;
  post: InkPost;
}

export interface SceneRig {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** null: WebGL could not start, so this is the degraded 2D-only boot (scene/webgl.ts). The scene
   *  graph is still built (plain JS objects, no GPU work), so every position lookup keeps working;
   *  nothing draws it, and the scene bus gets no `rig`, so every 3D feature no-ops. */
  gl: RigGl | null;
  /** Why gl is null, in the browser's own words when it gave any; "" when gl is set. */
  glFailure: string;
  /** Pointer input binds here: the WebGL canvas, or (no WebGL) a detached element that never gets events. */
  surface: HTMLElement;
  controls: OrbitControls;
  timer: THREE.Timer;
  /** Call after controls.update(): tilts the view toward the horizon when close to the ground. */
  applyFlyoverTilt(): void;
}

export const ORBIT_DISTANCE = PLANET_R * 3.75;
export const MIN_DISTANCE = PLANET_R + 4;
export const MAX_DISTANCE = PLANET_R * 8;

/** How much the camera tilts toward the horizon at height h above sea level (0 = looks at the centre). */
export function tiltFor(h: number): number {
  return 1 - THREE.MathUtils.smoothstep(h, 6, 64);
}

/** Default orbit distance: the whole globe fits, also on portrait phones. */
export function orbitDistanceFor(camera: THREE.PerspectiveCamera): number {
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  return Math.max(ORBIT_DISTANCE, (PLANET_R * 1.1) / Math.sin(Math.min(halfV, halfH)));
}

/** Bright daylight rig: light is parented to the camera so it always comes from the upper-left of the screen. */
export function createSceneRig(container: HTMLElement): SceneRig {
  const scene = new THREE.Scene();
  scene.background = buildSkyTexture();

  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.5, 1200);
  camera.layers.enable(NO_INK_LAYER);
  camera.position.copy(FRONT_DIR).multiplyScalar(ORBIT_DISTANCE);
  scene.add(camera);

  // WebGL can be missing or refused: everything after this runs either way (see RigGl / gl above).
  const started = startGl(
    () => probeWebGL(document.createElement("canvas")),
    () => createGl(container, scene, camera),
  );
  const gl = started.ok ? started.value : null;
  const glFailure = started.ok ? "" : started.reason;
  const surface: HTMLElement = gl ? gl.renderer.domElement : document.createElement("div");
  if (gl) container.appendChild(gl.renderer.domElement);

  const controls = new OrbitControls(camera, surface);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI - 0.12;
  controls.zoomSpeed = 0.9;
  controls.target.set(0, 0, 0);

  // Key light rides with the camera: always upper-left, so no side of the planet is ever in the dark.
  const key = new THREE.DirectionalLight(0xfff4e0, 2.3);
  key.position.copy(VIEW_LIGHT_DIR).multiplyScalar(100);
  camera.add(key);
  camera.add(key.target);
  key.target.position.set(0, 0, 0);
  const hemi = new THREE.HemisphereLight(0xdff2ff, 0xb8a4ff, 1.35);
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(hemi, ambient);

  if (gl) registerSceneParts({ rig: { scene, camera, renderer: gl.renderer, post: gl.post, hemi, ambient, key } });

  // Shift the globe up on desktop so the bottom dispatch bar + status bar don't cover it.
  const applyViewOffset = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const lift = w > 520 ? Math.round(h * 0.055) : Math.round(h * 0.02);
    camera.setViewOffset(w, h, 0, lift, w, h);
  };
  applyViewOffset();

  window.addEventListener("resize", () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    applyViewOffset();
    camera.updateProjectionMatrix();
    if (!gl) return;
    gl.renderer.setSize(container.clientWidth, container.clientHeight);
    gl.post.setSize(container.clientWidth, container.clientHeight);
  });

  const timer = new THREE.Timer();
  timer.connect(document);

  const radial = new THREE.Vector3();
  const north = new THREE.Vector3();
  const look = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  function applyFlyoverTilt(): void {
    const dist = camera.position.length();
    const h = dist - PLANET_R;
    const t = tiltFor(h);
    // Slower drag close to the ground so the flyover stays controllable.
    controls.rotateSpeed = 0.25 + 0.75 * THREE.MathUtils.smoothstep(h, 4, 80);
    if (t <= 0) return;
    radial.copy(camera.position).normalize();
    north.copy(worldUp).addScaledVector(radial, -radial.dot(worldUp)).normalize();
    look
      .copy(radial)
      .multiplyScalar(PLANET_R + 1)
      .addScaledVector(north, h * 1.6 + 6)
      .multiplyScalar(t);
    camera.up.copy(worldUp);
    camera.lookAt(look);
  }

  return { scene, camera, gl, glFailure, surface, controls, timer, applyFlyoverTilt };
}

/** The renderer and its comic post chain, or a throw (the renderer is disposed first). */
function createGl(container: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RigGl {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    return { renderer, post: createInkPost(renderer, scene, camera) };
  } catch (err) {
    renderer.dispose();
    throw err;
  }
}
