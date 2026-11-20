// Courier run flight model: an arcade plane gliding over a sphere. Pure (three.js math
// only, no scene), so it is unit-tested. Every vector is preallocated; step() allocates
// nothing. Axes: `up` = surface normal at the plane, `forward` = tangent heading.

import * as THREE from "three";

export const FLIGHT = {
  cruise: 11, // world units / s
  minSpeed: 5,
  boostSpeed: 22,
  maxSpeed: 24, // hard cap, whatever happens
  accel: 2.2, // speed response (1/s)
  maxBank: 0.75, // rad
  bankResponse: 3.2,
  levelResponse: 1.6, // auto-level when the stick is centred (1/s)
  turnRate: 1.5, // yaw rad/s at full bank
  maxPitch: 0.5, // rad
  pitchResponse: 3,
  minAltitude: 2.5, // above the ground under the plane
  maxAltitude: 34, // above sea level (PLANET_R)
  boostDrain: 1 / 3, // a full meter lasts 3s
  boostRecharge: 1 / 7, // refills in 7s
  boostMinToStart: 0.15,
} as const;

export interface FlightInput {
  /** -1 (left) .. 1 (right). */
  turn: number;
  /** -1 (dive) .. 1 (climb). */
  pitch: number;
  boost: boolean;
  /** Slow to minSpeed (e.g. while deciding an approval). */
  slow?: boolean;
}

export interface FlightState {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  speed: number;
  bank: number;
  pitch: number;
  /** Height above sea level (PLANET_R). */
  altitude: number;
  /** 0..1 */
  boostMeter: number;
  boosting: boolean;
  /** Ran the meter dry: no boost until the boost key is released. */
  boostSpent: boolean;
}

export function createFlight(planetR: number, startDir: THREE.Vector3, altitude = 14): FlightState {
  const up = startDir.clone().normalize();
  // Any tangent will do as the first heading; prefer "north" so the start is predictable.
  const forward = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y);
  if (forward.lengthSq() < 1e-6) forward.set(1, 0, 0).addScaledVector(up, -up.x);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  return {
    pos: up.clone().multiplyScalar(planetR + altitude),
    forward,
    up,
    right,
    speed: FLIGHT.cruise,
    bank: 0,
    pitch: 0,
    altitude,
    boostMeter: 1,
    boosting: false,
    boostSpent: false,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const approach = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt));

const axis = new THREE.Vector3();
const q = new THREE.Quaternion();

/**
 * Advances the plane by dt. `groundAltitude` = terrain height above sea level under the
 * plane (the floor is that + minAltitude). Mutates `s` in place.
 */
export function stepFlight(s: FlightState, input: FlightInput, dt: number, planetR: number, groundAltitude = 0): void {
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.1);
  const turn = clamp(Number.isFinite(input.turn) ? input.turn : 0, -1, 1);
  const pitchIn = clamp(Number.isFinite(input.pitch) ? input.pitch : 0, -1, 1);

  // Boost: needs some meter to start, drains while held, recharges otherwise.
  if (!input.boost) s.boostSpent = false;
  const wantBoost = input.boost && !input.slow && !s.boostSpent;
  s.boosting = wantBoost && (s.boosting ? s.boostMeter > 0 : s.boostMeter >= FLIGHT.boostMinToStart);
  s.boostMeter = clamp(s.boostMeter + (s.boosting ? -FLIGHT.boostDrain : FLIGHT.boostRecharge) * dt, 0, 1);
  if (s.boosting && s.boostMeter <= 0) {
    s.boosting = false;
    s.boostSpent = true;
  }

  const targetSpeed = input.slow ? FLIGHT.minSpeed : s.boosting ? FLIGHT.boostSpeed : FLIGHT.cruise;
  s.speed = clamp(approach(s.speed, targetSpeed, FLIGHT.accel, dt), FLIGHT.minSpeed, FLIGHT.maxSpeed);

  // Bank toward the stick; with the stick centred, drift back to level (the "easy" part).
  s.bank = approach(s.bank, turn * FLIGHT.maxBank, turn === 0 ? FLIGHT.levelResponse : FLIGHT.bankResponse, dt);
  s.pitch = approach(s.pitch, pitchIn * FLIGHT.maxPitch, pitchIn === 0 ? FLIGHT.levelResponse : FLIGHT.pitchResponse, dt);

  // Yaw around the local up by the bank (banking right turns right).
  q.setFromAxisAngle(s.up, (-s.bank / FLIGHT.maxBank) * FLIGHT.turnRate * dt);
  s.forward.applyQuaternion(q);

  // Altitude from pitch, clamped to [ground + min, max]; hitting a limit levels the nose.
  const floor = Math.max(0, groundAltitude) + FLIGHT.minAltitude;
  s.altitude += Math.sin(s.pitch) * s.speed * dt;
  if (s.altitude <= floor) {
    s.altitude = floor;
    if (s.pitch < 0) s.pitch = approach(s.pitch, 0, 6, dt);
  } else if (s.altitude >= FLIGHT.maxAltitude) {
    s.altitude = FLIGHT.maxAltitude;
    if (s.pitch > 0) s.pitch = approach(s.pitch, 0, 6, dt);
  }

  // Move along the great circle: rotate position + heading around (up × forward).
  const r = planetR + s.altitude;
  const angle = (Math.cos(s.pitch) * s.speed * dt) / r;
  axis.crossVectors(s.up, s.forward).normalize();
  q.setFromAxisAngle(axis, angle);
  s.up.applyQuaternion(q).normalize();
  s.forward.applyQuaternion(q);
  // Re-orthonormalise so float drift never tilts the heading off the tangent plane.
  s.forward.addScaledVector(s.up, -s.forward.dot(s.up)).normalize();
  s.right.crossVectors(s.forward, s.up).normalize();
  s.pos.copy(s.up).multiplyScalar(r);
}

const basis = new THREE.Matrix4();
const rollQ = new THREE.Quaternion();
const pitchQ = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const left = new THREE.Vector3();

/** Orientation for a model built nose +Z, up +Y, wings along X (scene/agents.ts plane). */
export function planeQuaternion(s: FlightState, out: THREE.Quaternion): THREE.Quaternion {
  // Model X must map to the plane's left so that X × Y = Z holds (left × up = forward).
  left.copy(s.right).negate();
  basis.makeBasis(left, s.up, s.forward);
  out.setFromRotationMatrix(basis);
  rollQ.setFromAxisAngle(Z, s.bank);
  pitchQ.setFromAxisAngle(X, -s.pitch);
  return out.multiply(rollQ).multiply(pitchQ);
}
