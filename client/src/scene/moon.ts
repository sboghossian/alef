import * as THREE from "three";
import type { MoonVoiceState } from "../../../shared/features/voice";
import type { JevState } from "../../../shared/types";
import { PLANET_R } from "../layout";
import { toon } from "./toon";

const ORBIT_R = PLANET_R * 1.95;

/** Straight segments between points: sharp comic-lightning corners. */
class PolylineCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private readonly pts: THREE.Vector3[]) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const n = this.pts.length - 1;
    const f = Math.min(n - 1e-6, Math.max(0, t * n));
    const i = Math.floor(f);
    const a = this.pts[i];
    const b = this.pts[i + 1];
    if (!a || !b) return target.set(0, 0, 0);
    return target.copy(a).lerp(b, f - i);
  }
}
const BEAM_LIFE = 1.6;

interface Beam {
  mesh: THREE.Mesh;
  target: THREE.Vector3;
  born: number;
}

export interface MoonVisual {
  group: THREE.Group;
  /** The clickable body. */
  body: THREE.Mesh;
  position: THREE.Vector3;
  setStatus(status: JevState["status"]): void;
  /** Wobble and look around while an Ask-Jev request is in flight. */
  setThinking(on: boolean): void;
  /** Voice loop state (idle/listening/thinking/speaking) — a superset of setThinking,
   *  ported from aleph/orb.js's state machine. "thinking" also drives setThinking's
   *  existing eye-roll so the two never fight over the same visual. */
  setVoiceState(state: MoonVoiceState): void;
  /** 0..1 live amplitude (mic while listening, TTS playback while speaking) — the moon
   *  "breathes"/talks with the sound, matching orb.js's level-driven pulse. */
  setAmplitude(level: number): void;
  zap(targets: THREE.Vector3[], elapsed: number): void;
  update(dt: number, elapsed: number, camera: THREE.Camera): void;
}

/** Jev as a friendly moon: craters, big eyes, a smile. It orbits and zaps cities when it decides something. */
export function buildMoon(): MoonVisual {
  const group = new THREE.Group();
  group.name = "jev-moon";
  const face = new THREE.Group();
  group.add(face);

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(6, 4), toon(0xfff0a8));
  body.userData = { kind: "jev" };
  face.add(body);

  const craterMat = toon(0xf2d67a);
  for (const [x, y, s] of [
    [-3.4, 3.2, 1.1],
    [3.8, 2.6, 0.8],
    [-4.2, -1.6, 0.7],
    [2.4, -3.9, 0.9],
    [0.4, 4.6, 0.55],
  ] as const) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(s, 14, 10), craterMat);
    const n = new THREE.Vector3(x, y, Math.sqrt(Math.max(1, 36 - x * x - y * y))).normalize();
    c.position.copy(n.setLength(5.75));
    c.scale.set(1, 1, 0.35);
    c.lookAt(n.clone().multiplyScalar(2));
    face.add(c);
  }

  const eyeMat = toon(0x221a33);
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyes: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 12), eyeMat);
    ball.scale.set(0.8, 1.15, 0.45);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), whiteMat);
    glint.position.set(-0.22, 0.38, 0.35);
    eye.add(ball, glint);
    eye.position.set(side * 1.8, 1.0, 5.55);
    face.add(eye);
    eyes.push(eye);
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), toon(0xff8fab));
    cheek.scale.set(1, 0.6, 0.3);
    cheek.position.set(side * 3.1, -0.9, 4.9);
    face.add(cheek);
  }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.22, 8, 20, Math.PI), eyeMat);
  smile.rotation.z = Math.PI;
  smile.position.set(0, -0.5, 5.6);
  face.add(smile);

  const beams: Beam[] = [];
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
  let pulseUntil = 0;
  let orbitAngle = 0.9;
  let sleeping = false;
  let thinking = false;
  let voiceState: MoonVoiceState = "idle";
  let amplitude = 0;
  const position = group.position;
  const smileRestScaleY = smile.scale.y;

  function jaggedPath(from: THREE.Vector3, to: THREE.Vector3): PolylineCurve {
    const pts: THREE.Vector3[] = [];
    const n = 9;
    const dir = new THREE.Vector3().subVectors(to, from);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, dir).normalize();
    for (let i = 0; i <= n; i++) {
      const p = from.clone().addScaledVector(dir, i / n);
      if (i > 0 && i < n) {
        p.addScaledVector(side, (Math.random() - 0.5) * 4.5).addScaledVector(up, (Math.random() - 0.5) * 4.5);
      }
      pts.push(p);
    }
    return new PolylineCurve(pts);
  }

  function rebuildBeam(b: Beam): void {
    b.mesh.geometry.dispose();
    b.mesh.geometry = new THREE.TubeGeometry(jaggedPath(position, b.target), 90, 0.5, 5, false);
  }

  const api: MoonVisual = {
    group,
    body,
    position,
    setStatus(status) {
      sleeping = status === "disabled";
    },
    setThinking(on) {
      thinking = on;
    },
    setVoiceState(state) {
      voiceState = state;
      thinking = state === "thinking"; // reuse the existing eye-roll wobble
    },
    setAmplitude(level) {
      amplitude = Math.max(0, Math.min(1, level));
    },
    zap(targets, elapsed) {
      pulseUntil = elapsed + 1.2;
      for (const t of targets.slice(0, 4)) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), beamMat);
        mesh.frustumCulled = false;
        const b: Beam = { mesh, target: t.clone(), born: elapsed };
        rebuildBeam(b);
        group.parent?.add(mesh);
        beams.push(b);
      }
    },
    update(dt, elapsed, camera) {
      orbitAngle += dt * 0.035;
      position.set(Math.cos(orbitAngle) * ORBIT_R, Math.sin(orbitAngle * 0.7) * ORBIT_R * 0.28 + ORBIT_R * 0.32, Math.sin(orbitAngle) * ORBIT_R);
      // Always turn the friendly face toward the viewer.
      face.lookAt(camera.position);
      const pulse = elapsed < pulseUntil ? 1 + Math.sin((pulseUntil - elapsed) * 18) * 0.12 : 1 + Math.sin(elapsed * 1.6) * 0.02;
      // Voice loop: the moon "breathes" with live mic/TTS amplitude while listening/speaking.
      const voicePulse = voiceState === "listening" || voiceState === "speaking" ? amplitude * 0.16 : 0;
      face.scale.setScalar(pulse + voicePulse);
      if (thinking) {
        face.rotateZ(Math.sin(elapsed * 6) * 0.12);
        face.rotateY(Math.sin(elapsed * 2.2) * 0.25);
      }
      // Speaking: the mouth opens with the amplitude of what's being said.
      smile.scale.y = voiceState === "speaking" ? smileRestScaleY * (1 + amplitude * 1.6) : smileRestScaleY;
      const blink = sleeping && !thinking ? 0.12 : Math.sin(elapsed * 0.9) > 0.985 ? 0.15 : 1;
      eyes.forEach((e, i) => {
        e.scale.y = blink;
        // Thinking: eyes roll up and around.
        const look = thinking ? 0.35 : 0;
        e.position.x = (i === 0 ? -1.8 : 1.8) + Math.cos(elapsed * 3) * look;
        e.position.y = 1.0 + look * (0.6 + Math.sin(elapsed * 3) * 0.4);
      });

      for (let i = beams.length - 1; i >= 0; i--) {
        const b = beams[i];
        if (!b) continue;
        const age = elapsed - b.born;
        if (age > BEAM_LIFE) {
          b.mesh.parent?.remove(b.mesh);
          b.mesh.geometry.dispose();
          beams.splice(i, 1);
          continue;
        }
        if (Math.floor(age * 12) !== Math.floor((age - dt) * 12)) rebuildBeam(b);
        b.mesh.visible = age < 1.1 || Math.floor(age * 20) % 2 === 0;
      }
    },
  };
  // Discoverable by any feature that only holds `ctx.scene` (e.g. via
  // scene.getObjectByName("jev-moon")), so voice.ts can drive the moon's states
  // without a new ClientContext surface.
  group.userData.moon = api;
  return api;
}
