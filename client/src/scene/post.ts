import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/** View-space light direction (upper-left, towards the viewer). Shared with the scene light. */
export const VIEW_LIGHT_DIR = new THREE.Vector3(-0.75, 0.95, 0.9).normalize();

const InkShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
    uLight: { value: VIEW_LIGHT_DIR.clone() },
    uInk: { value: new THREE.Color(0x1a1030) },
    uThickness: { value: 1.0 },
    uDot: { value: 7.0 },
    uShade: { value: new THREE.Vector3(0.62, 0.55, 0.85) },
    // 0 = comic ink + halftone, 1 = blueprint (paper, white lines, hatching).
    uMode: { value: 0 },
    uPaper: { value: new THREE.Color(0x3b9be8) },
    // District focus: everything outside the cap around uFocusDir washes toward uWash.
    uFocusAmt: { value: 0 },
    uFocusDir: { value: new THREE.Vector3(0, 0, 1) },
    uFocusCos: { value: 1 },
    uWash: { value: new THREE.Color(0xf1ecff) },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
  },
  vertexShader: `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform vec3 uLight;
uniform vec3 uInk;
uniform float uThickness;
uniform float uDot;
uniform vec3 uShade;
uniform float uMode;
uniform vec3 uPaper;
uniform float uFocusAmt;
uniform vec3 uFocusDir;
uniform float uFocusCos;
uniform vec3 uWash;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec2 vUv;

float viewZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(d, uNear, uFar);
}
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 col = base.rgb;
  float rawD = texture2D(tDepth, vUv).x;
  vec2 px = uThickness / uResolution;
  // Blueprint: a slight hand-drawn wobble in where the edges are sampled.
  vec2 uv = vUv;
  if (uMode > 0.5) {
    uv += vec2(sin(gl_FragCoord.y * 0.09 + gl_FragCoord.x * 0.013), cos(gl_FragCoord.x * 0.08 - gl_FragCoord.y * 0.011)) * 0.9 / uResolution;
  }

  float zc = viewZ(uv);
  float zl = viewZ(uv - vec2(px.x, 0.0));
  float zr = viewZ(uv + vec2(px.x, 0.0));
  float zd = viewZ(uv - vec2(0.0, px.y));
  float zu = viewZ(uv + vec2(0.0, px.y));
  // Second derivative: flat or tilted planes cancel out, only real breaks remain.
  float lap = abs(zl + zr - 2.0 * zc) + abs(zd + zu - 2.0 * zc);
  float zmin = min(zc, min(min(zl, zr), min(zd, zu)));
  float depthEdge = smoothstep(0.012, 0.03, lap / max(zmin, 0.001));

  vec3 nc = nrm(uv);
  float nd = 0.0;
  nd = max(nd, 1.0 - dot(nc, nrm(uv + vec2(px.x, 0.0))));
  nd = max(nd, 1.0 - dot(nc, nrm(uv - vec2(px.x, 0.0))));
  nd = max(nd, 1.0 - dot(nc, nrm(uv + vec2(0.0, px.y))));
  nd = max(nd, 1.0 - dot(nc, nrm(uv - vec2(0.0, px.y))));
  float normalEdge = rawD < 1.0 ? smoothstep(0.28, 0.5, nd) : 0.0;

  float isSky = step(0.99999, rawD);
  float ndl = dot(normalize(nc), normalize(uLight));
  float c = 0.7071;

  if (uMode < 0.5) {
    // Halftone dots on the side facing away from the light.
    if (isSky < 0.5) {
      float shade = smoothstep(0.25, -0.45, ndl);
      vec2 p = mat2(c, -c, c, c) * gl_FragCoord.xy / uDot;
      vec2 cell = fract(p) - 0.5;
      float r = 0.48 * sqrt(shade);
      float dotMask = 1.0 - smoothstep(r - 0.07, r, length(cell));
      col = mix(col, col * uShade, dotMask * step(0.02, shade));
    }
    // A little extra punch.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 1.18);
  } else if (isSky < 0.5) {
    // Blueprint paper: tone from the scene's luminance, a hint of its hue, hatching in shadow.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 paper = uPaper * (0.86 + 0.28 * l) + (col - vec3(l)) * 0.12;
    float shade = smoothstep(0.3, -0.5, ndl);
    float period = uDot * 0.85;
    vec2 p = mat2(c, -c, c, c) * gl_FragCoord.xy;
    float d1 = abs(fract(p.x / period) - 0.5) * period;
    float hatch = (1.0 - smoothstep(shade * period * 0.22, shade * period * 0.22 + 1.0, d1)) * step(0.05, shade);
    float d2 = abs(fract(p.y / period) - 0.5) * period;
    float w2 = max(0.0, shade - 0.6) * period * 0.3;
    hatch = max(hatch, (1.0 - smoothstep(w2, w2 + 1.0, d2)) * step(0.62, shade));
    col = mix(paper, vec3(1.0), hatch * 0.5);
  }

  float edge = max(depthEdge, normalEdge);
  col = mix(col, uInk, clamp(edge, 0.0, 1.0));

  if (uFocusAmt > 0.001 && isSky < 0.5) {
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, rawD * 2.0 - 1.0, 1.0);
    vp /= vp.w;
    vec3 wp = (uCamWorld * vp).xyz;
    float inside = smoothstep(uFocusCos - 0.004, uFocusCos + 0.004, dot(normalize(wp), uFocusDir));
    col = mix(col, uWash, uFocusAmt * (1.0 - inside) * 0.85);
  }
  gl_FragColor = vec4(col, base.a);
}`,
};

/** What a theme may change in the post pass. */
export interface InkStyle {
  ink: number;
  shade: [number, number, number];
  mode: 0 | 1;
  wash: number;
}

export interface InkPost {
  /** Renders the default scene/camera, or another pair (e.g. an agent's room) through the same comic pass. */
  render(target?: { scene: THREE.Scene; camera: THREE.PerspectiveCamera }): void;
  setSize(w: number, h: number): void;
  setStyle(style: InkStyle): void;
  /** District focus: `amount` 0..1 washes everything outside the cap (unit `dir`, angular radius). */
  setFocus(amount: number, dir?: THREE.Vector3, angle?: number): void;
  /** Runs `fn(canvas)` once, right after the next planet frame is drawn (the buffer is still valid). */
  afterNextRender(fn: (canvas: HTMLCanvasElement) => void): void;
  /** A planet frame whose picture nobody sees (a view draws over the whole canvas): skip the
   *  planet passes and only run the afterNextRender hooks. */
  runHooksOnly(): void;
}

/**
 * Comic post chain: a normal+depth pre-pass (MeshNormalMaterial override,
 * layer 0 only), then RenderPass -> ink/halftone ShaderPass -> OutputPass.
 */
export function createInkPost(
  renderer: THREE.WebGLRenderer,
  defaultScene: THREE.Scene,
  defaultCamera: THREE.PerspectiveCamera,
): InkPost {
  const scene = defaultScene;
  const camera = defaultCamera;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const depthTex = new THREE.DepthTexture(size.x, size.y);
  depthTex.type = THREE.UnsignedIntType;
  const normalRT = new THREE.WebGLRenderTarget(size.x, size.y, { depthTexture: depthTex, depthBuffer: true });
  const normalMat = new THREE.MeshNormalMaterial();

  const colorRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, colorRT);
  composer.setPixelRatio(1);
  composer.setSize(size.x, size.y);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const ink = new ShaderPass(InkShader);
  ink.uniforms.tNormal = { value: normalRT.texture };
  ink.uniforms.tDepth = { value: depthTex };
  composer.addPass(ink);
  composer.addPass(new OutputPass());

  const setUniforms = (w: number, h: number): void => {
    const u = ink.uniforms;
    const res = u.uResolution?.value;
    if (res instanceof THREE.Vector2) res.set(w, h);
    const ratio = renderer.getPixelRatio();
    if (u.uThickness) u.uThickness.value = Math.max(1, ratio * 0.9);
    if (u.uDot) u.uDot.value = 6.5 * ratio;
  };
  setUniforms(size.x, size.y);

  const afterRender: ((canvas: HTMLCanvasElement) => void)[] = [];
  const u = ink.uniforms;
  const setColor = (key: string, hex: number): void => {
    const v = u[key]?.value;
    if (v instanceof THREE.Color) v.setHex(hex);
  };

  return {
    setStyle(style) {
      setColor("uInk", style.ink);
      setColor("uWash", style.wash);
      const shade = u.uShade?.value;
      if (shade instanceof THREE.Vector3) shade.set(...style.shade);
      if (u.uMode) u.uMode.value = style.mode;
    },
    setFocus(amount, dir, angle) {
      if (u.uFocusAmt) u.uFocusAmt.value = amount;
      const fd = u.uFocusDir?.value;
      if (dir && fd instanceof THREE.Vector3) fd.copy(dir).normalize();
      if (angle !== undefined && u.uFocusCos) u.uFocusCos.value = Math.cos(angle);
    },
    afterNextRender(fn) {
      afterRender.push(fn);
    },
    render(target) {
      const scene = target?.scene ?? defaultScene;
      const camera = target?.camera ?? defaultCamera;
      renderPass.scene = scene;
      renderPass.camera = camera;
      const bg = scene.background;
      const layersMask = camera.layers.mask;
      scene.background = null;
      scene.overrideMaterial = normalMat;
      camera.layers.set(0);
      renderer.setRenderTarget(normalRT);
      renderer.setClearColor(0x8080ff, 1);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      scene.overrideMaterial = null;
      scene.background = bg;
      camera.layers.mask = layersMask;

      if (u.uNear) u.uNear.value = camera.near;
      if (u.uFar) u.uFar.value = camera.far;
      const inv = u.uInvProj?.value;
      if (inv instanceof THREE.Matrix4) inv.copy(camera.projectionMatrixInverse);
      const world = u.uCamWorld?.value;
      if (world instanceof THREE.Matrix4) world.copy(camera.matrixWorld);
      // Rooms are not the planet: no district wash inside them.
      const focus = u.uFocusAmt?.value;
      if (target && u.uFocusAmt) u.uFocusAmt.value = 0;
      composer.render();
      if (target && u.uFocusAmt) u.uFocusAmt.value = focus;
      if (!target && afterRender.length) {
        for (const fn of afterRender.splice(0)) fn(renderer.domElement);
      }
    },
    runHooksOnly() {
      if (afterRender.length) {
        for (const fn of afterRender.splice(0)) fn(renderer.domElement);
      }
    },
    setSize(w, h) {
      const ratio = renderer.getPixelRatio();
      const pw = Math.floor(w * ratio);
      const ph = Math.floor(h * ratio);
      normalRT.setSize(pw, ph);
      composer.setSize(pw, ph);
      setUniforms(pw, ph);
    },
  };
}
