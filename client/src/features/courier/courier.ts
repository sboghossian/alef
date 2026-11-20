// F1 Courier run — "2" / the Courier run button. You fly your own comic plane while your
// real agents work. Every REAL activity event spawns a parcel over that agent's city; fly
// through parcels to pick them up (max 5) and through Harness City's ring to deliver.
// Pending REAL approvals are urgent deliveries: a red beacon over the agent's house; fly
// into it and HOLD A / D for 1s to approve / deny (a real POST, never while boosting).
// Nothing here invents events: quiet fleet = no parcels. `?courier=replay` replays today's
// real transcript events from GET /api/replay (labelled REPLAY on screen).

import * as THREE from "three";
import "./courier.css";
import type { ApprovalView } from "../../../../shared/features/approvals";
import type { ReplayEvent, ReplayResponse } from "../../../../shared/features/replay";
import type { ActivityStage, AgentActivity } from "../../../../shared/types";
import { PLANET_R } from "../../layout";
import { log } from "../../log";
import { buildPlaneModel } from "../../scene/agents";
import { toon } from "../../scene/toon";
import { collapsible, prefersReducedMotion, safeLocalStorage } from "../../ui/kit";
import { setAgendaBillboardVisible } from "../agenda";
import { decideApproval, pendingApprovals, setApprovalCardSuppressed } from "../approvals";
import { toScreen } from "../fleet-overlay";
import type { ClientContext, ClientFeature } from "../registry";
import { playCue } from "../sound";
import { createFlight, planeQuaternion, stepFlight, type FlightState } from "./flight";
import { HoldToConfirm, type HoldAction } from "./hold";
import { mountCourierHud, STAGE_COLOR, type CourierHud, type RadarDot } from "./hud";
import { PARCELS, ParcelField, helped, loadScore, localDay, saveScore, type DayScore, type Parcel } from "./parcels";
import { agentTitle } from "../../../../shared/display";

const RING_LIFT = 8; // delivery ring centre above the capital's tower top…
const RING_SIDE = 10; // …and off to one side, clear of the agenda billboard over the tower
const BEACON_LIFT = 5; // beacon core above the agent's roof
const BEACON_RADIUS = 9; // fly this close to a beacon to open its card
const NEAR_LABEL_RADIUS = 14;
const START_CLEARANCE = 0.4; // rad of planet between the start point and Harness City, at least
const RADAR_RANGE = 70; // world units (arc) from the plane to the radar rim
const MAX_BEACONS = 6;
const REPLAY_EVERY_MS = 1400;
const STAGES: readonly ActivityStage[] = ["hook", "brain", "plan", "reason", "tool"];

const FLIGHT_CODES = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

interface Beacon {
  approval: ApprovalView;
  pos: THREE.Vector3;
}

interface Scene3d {
  root: THREE.Group;
  plane: THREE.Group;
  prop: THREE.Object3D;
  stack: THREE.Mesh[];
  boxes: THREE.InstancedMesh;
  outlines: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
  ring: THREE.Group;
  beacons: THREE.Group[];
}

// ---- state (module-level, like the other features) ----
let hud: CourierHud | null = null;
let world: Scene3d | null = null;
let flight: FlightState | null = null;
let riding = false;
const field = new ParcelField();
const hold = new HoldToConfirm();
let score: DayScore = loadScore(null, localDay(new Date()));
const keys = new Set<string>();
const drag = { active: false, id: -1, x0: 0, y0: 0, x: 0, y: 0 };
let beacons: Beacon[] = [];
let lastBeaconScan = -Infinity;
let cardTarget: Beacon | null = null;
let groundAlt = 0;
let frameNo = 0;
let lastRadar = 0;
let moonBody: THREE.Object3D | null = null;
let replayMode = false;
let replayQueue: ReplayEvent[] = [];
let lastReplayAt = 0;
let reduced = false;
let deciding = false;
let fleetLive = false;
/** ?autopilot=1 (screenshots/demo): steers the same stick input toward beacon > parcel > ring. */
let autopilot = false;
const scratchDot: RadarDot = { x: 0, y: 0, color: "", size: 0 };

// Preallocated scratch.
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const dummy = new THREE.Object3D();
const Y = new THREE.Vector3(0, 1, 0);
const camWant = new THREE.Vector3();
const camLook = new THREE.Vector3();
const camUp = new THREE.Vector3();
const ringPos = new THREE.Vector3();
const moonPos = new THREE.Vector3();
const picked: Parcel[] = [];
const radarDots: RadarDot[] = Array.from({ length: PARCELS.max + MAX_BEACONS + 2 }, () => ({ x: 0, y: 0, color: "#000", size: 5 }));
const stageColors = new Map<ActivityStage, THREE.Color>(STAGES.map((s) => [s, new THREE.Color(STAGE_COLOR[s])]));
const carriedColors: string[] = [];

function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

function build(ctx: ClientContext): Scene3d {
  const root = new THREE.Group();
  root.name = "courier";
  root.visible = false;

  const { group: plane, prop } = buildPlaneModel(new THREE.Color("#ff4d8d"));
  plane.scale.setScalar(1.1);
  const stack: THREE.Mesh[] = [];
  const stackGeo = new THREE.BoxGeometry(0.42, 0.26, 0.42);
  for (let i = 0; i < PARCELS.maxCarried; i++) {
    const m = new THREE.Mesh(stackGeo, toon(0xffffff));
    m.position.set(0, 0.5 + i * 0.28, -0.45);
    m.rotation.y = (i % 2) * 0.35;
    m.visible = false;
    plane.add(m);
    stack.push(m);
  }
  root.add(plane);

  const boxGeo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
  const boxes = new THREE.InstancedMesh(boxGeo, toon(0xffffff), PARCELS.max);
  const outlines = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide }), PARCELS.max);
  const halos = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1.15, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
    PARCELS.max,
  );
  for (const m of [boxes, outlines, halos]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = PARCELS.max;
  }
  const white = new THREE.Color(0xffffff);
  for (let i = 0; i < PARCELS.max; i++) {
    boxes.setColorAt(i, white);
    halos.setColorAt(i, white);
  }
  root.add(outlines, boxes, halos);

  // Harness City's landing ring: a fat yellow hoop with an ink outline, slowly turning.
  const ring = new THREE.Group();
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.55, 12, 40), toon(0xffd23f));
  const hoopLine = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.75, 12, 40), new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide }));
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(3.7, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.add(hoop, hoopLine, inner);
  root.add(ring);

  const beaconGroups: THREE.Group[] = [];
  const beamGeo = new THREE.CylinderGeometry(0.5, 1.4, 16, 16, 1, true).translate(0, 8, 0);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const coreGeo = new THREE.SphereGeometry(1.1, 16, 12);
  const pulseGeo = new THREE.TorusGeometry(BEACON_RADIUS * 0.6, 0.18, 6, 40).rotateX(Math.PI / 2);
  for (let i = 0; i < MAX_BEACONS; i++) {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = -BEACON_LIFT;
    const core = new THREE.Mesh(coreGeo, toon(0xff3b3b));
    const coreLine = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide }));
    coreLine.scale.setScalar(1.18);
    const pulse = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.6, depthWrite: false }));
    pulse.name = "pulse";
    g.add(beam, core, coreLine, pulse);
    g.visible = false;
    root.add(g);
    beaconGroups.push(g);
  }

  ctx.scene.add(root);
  return { root, plane, prop, stack, boxes, outlines, halos, ring, beacons: beaconGroups };
}

// ---- parcels from REAL events ----

function cityOf(ctx: ClientContext, agentId: string): string | undefined {
  return ctx.store.agents.get(agentId)?.islandId;
}

function parcelPosition(ctx: ClientContext, cityId: string, sourceId: string, out: THREE.Vector3): boolean {
  const top = ctx.cityPosition(cityId);
  if (!top) return false;
  const up = tmpV.copy(top).normalize();
  const hv = hash(sourceId);
  const angle = ((hv % 360) * Math.PI) / 180;
  const radius = 2.5 + ((hv >>> 9) % 30) / 10; // 2.5..5.4 around the tower
  // A tangent basis at the city.
  const t1 = tmpV2.copy(Y).addScaledVector(up, -up.y);
  if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
  t1.normalize();
  const t2 = new THREE.Vector3().crossVectors(up, t1);
  out
    .copy(top)
    .addScaledVector(up, 3.5 + ((hv >>> 17) % 5))
    .addScaledVector(t1, Math.cos(angle) * radius)
    .addScaledVector(t2, Math.sin(angle) * radius);
  return true;
}

const spawnPos = new THREE.Vector3();

function spawnFromActivity(ctx: ClientContext, a: AgentActivity, now: number): void {
  const city = cityOf(ctx, a.agentId);
  if (!city || !parcelPosition(ctx, city, a.id, spawnPos)) return;
  const at = Date.parse(a.at);
  const spawnedAt = Number.isFinite(at) ? Math.min(now, at) : now;
  if (now - spawnedAt >= PARCELS.lifetimeMs) return;
  field.spawn({ sourceId: a.id, agentId: a.agentId, stage: a.stage, summary: a.summary || a.toolName || a.stage, pos: spawnPos }, spawnedAt);
}

function spawnFromReplay(ctx: ClientContext, e: ReplayEvent, now: number): void {
  const city = ctx.store.islands.has(e.islandId) ? e.islandId : cityOf(ctx, e.agentId);
  if (!city || !parcelPosition(ctx, city, `replay:${e.id}`, spawnPos)) return;
  field.spawn({ sourceId: `replay:${e.id}`, agentId: e.agentId, stage: e.stage, summary: e.summary || e.toolName || e.stage, pos: spawnPos, replay: true }, now);
}

function isReplayEvent(v: unknown): v is ReplayEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.agentId === "string" && typeof r.islandId === "string" && typeof r.summary === "string" && STAGES.includes(r.stage as ActivityStage);
}

async function loadReplay(ctx: ClientContext): Promise<void> {
  const res = await ctx.api.getJson<ReplayResponse>(`/api/replay?date=${localDay(new Date())}`, 15_000);
  const events = Array.isArray(res?.events) ? res.events.filter(isReplayEvent) : [];
  replayQueue = events.filter((e) => ctx.store.islands.has(e.islandId)).slice(-40);
  log.info("courier", `replay: ${replayQueue.length} real events from today's transcripts`);
  if (!replayQueue.length) ctx.toast("Replay: no events from today's transcripts yet.");
}

// ---- approvals as beacons ----

function scanBeacons(ctx: ClientContext): void {
  const list = pendingApprovals();
  const next: Beacon[] = [];
  for (const a of list) {
    if (next.length >= MAX_BEACONS) break;
    const roof = ctx.agentPosition(a.agentId);
    if (!roof) continue;
    const pos = roof.clone().addScaledVector(roof.clone().normalize(), BEACON_LIFT);
    next.push({ approval: a, pos });
  }
  beacons = next;
}

function whoLine(ctx: ClientContext, a: ApprovalView): string {
  const agent = ctx.store.agents.get(a.agentId);
  const cityId = agent?.islandId;
  const city = cityId ? ctx.store.islands.get(cityId)?.name ?? cityId : a.cwd.split("/").filter(Boolean).pop() ?? a.cwd;
  return agent ? `${agentTitle(agent)} · ${city}` : `session ${a.agentId.slice(0, 8)} · ${city}`;
}

async function sendDecision(ctx: ClientContext, b: Beacon, action: HoldAction): Promise<void> {
  if (deciding) return;
  deciding = true;
  const behavior = action === "allow" ? "allow" : "deny";
  log.info("courier", `in-flight decision: ${behavior} ${b.approval.toolName} (${b.approval.id})`);
  await decideApproval(ctx, b.approval.id, behavior);
  deciding = false;
  bumpScore({ approvals: 1 });
  ctx.labels.burst(action === "allow" ? "APPROVED!" : "DENIED!", b.pos);
  hud?.pop(action === "allow" ? "APPROVED!" : "DENIED!", `+${PARCELS.pointsPerApproval} · ${b.approval.toolName}`, action === "allow" ? "approve" : "deny");
  playCue(action === "allow" ? "approve" : "deny");
  lastBeaconScan = -Infinity;
}

// ---- score ----

function bumpScore(d: { points?: number; delivered?: number; approvals?: number; combo?: number }): void {
  const today = localDay(new Date());
  if (score.day !== today) score = loadScore(safeLocalStorage(), today);
  score.points += d.points ?? 0;
  if (d.approvals) score.points += d.approvals * PARCELS.pointsPerApproval;
  score.delivered += d.delivered ?? 0;
  score.approvals += d.approvals ?? 0;
  score.best = Math.max(score.best, d.combo ?? 0);
  saveScore(safeLocalStorage(), score);
  hud?.setScore(score.points, helped(score));
}

// ---- input ----

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}

function boostHeld(): boolean {
  return keys.has("ShiftLeft") || keys.has("ShiftRight") || (hud?.touch.boost ?? false);
}

function holdBoosting(): boolean {
  return boostHeld() || (flight?.boosting ?? false);
}

function onKey(ev: KeyboardEvent, down: boolean): void {
  if (!riding || typing(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const code = ev.code;
  if (!FLIGHT_CODES.has(code)) return;
  ev.preventDefault();
  // Keep flight keys away from every other listener (hub shortcuts, other features).
  ev.stopImmediatePropagation();
  if (down) keys.add(code);
  else keys.delete(code);
  if (code !== "KeyA" && code !== "KeyD") return;
  const action: HoldAction = code === "KeyA" ? "allow" : "deny";
  if (!down) {
    hold.release(action);
    return;
  }
  if (!cardTarget || !hud?.card.visible()) return;
  const res = hold.press(action, performance.now(), { boosting: holdBoosting(), repeat: ev.repeat });
  if (res !== "repeat") log.info("courier", `hold ${action}: ${res}`);
}

const input = { turn: 0, pitch: 0, boost: false, slow: false };

/** Keys + mouse drag + phone stick → `input` (reused every frame). */
function steer(): void {
  const card = cardTarget !== null;
  let turn = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
  // While an approval card is up, A / D are the hold keys, not the rudder.
  if (!card) turn += (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  let pitch = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
  if (drag.active) {
    turn += (drag.x - drag.x0) / 140;
    pitch += -(drag.y - drag.y0) / 140;
  }
  if (hud?.touch.enabled) {
    turn += hud.touch.stick.x;
    pitch += hud.touch.stick.y;
  }
  // Autopilot (debug) writes its own stick into `input`; the human's input adds on top.
  if (autopilot) steerAuto();
  else {
    input.turn = 0;
    input.pitch = 0;
  }
  input.turn = Math.max(-1, Math.min(1, turn + input.turn));
  input.pitch = Math.max(-1, Math.min(1, pitch + input.pitch));
  input.boost = boostHeld();
  input.slow = card;
}

function wireInput(): void {
  window.addEventListener("keydown", (ev) => onKey(ev, true), true);
  window.addEventListener("keyup", (ev) => onKey(ev, false), true);
  window.addEventListener("blur", () => {
    keys.clear();
    hold.release("allow");
    hold.release("deny");
  });
  const canvas = document.querySelector("canvas");
  if (!canvas) return;
  canvas.addEventListener("pointerdown", (ev) => {
    if (!riding || ev.pointerType === "touch") return;
    drag.active = true;
    drag.id = ev.pointerId;
    drag.x0 = drag.x = ev.clientX;
    drag.y0 = drag.y = ev.clientY;
  });
  // Capture phase on window: runs before the hub's canvas listeners. While flying, a click on
  // the planet must not select a house / dive into a room, and hover tooltips stay quiet.
  window.addEventListener(
    "pointermove",
    (ev) => {
      if (drag.active && ev.pointerId === drag.id) {
        drag.x = ev.clientX;
        drag.y = ev.clientY;
      }
      if (riding && ev.target === canvas) ev.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener(
    "click",
    (ev) => {
      if (riding && ev.target === canvas) ev.stopImmediatePropagation();
    },
    true,
  );
  const end = (ev: PointerEvent): void => {
    if (ev.pointerId === drag.id) drag.active = false;
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function steerAuto(): void {
  input.turn = 0;
  input.pitch = 0;
  if (!flight) return;
  let target: THREE.Vector3 | null = null;
  // Circle the nearest beacon (so its card stays up); the human still does the deciding.
  if (cardTarget) target = cardTarget.pos;
  else if (beacons[0]) target = beacons[0].pos;
  else if (field.carried() < PARCELS.maxCarried) {
    let best = Infinity;
    for (const p of field.slots) {
      if (p.state !== "free") continue;
      const d = p.pos.distanceToSquared(flight.pos);
      if (d < best) {
        best = d;
        target = p.pos;
      }
    }
  }
  if (!target && field.carried() > 0) target = ringPos;
  if (!target) return;
  const az = radarPoint(target, scratchDot);
  input.turn = Math.max(-1, Math.min(1, az * 1.5));
  input.pitch = Math.max(-1, Math.min(1, (target.length() - PLANET_R - flight.altitude) / 3));
}

// ---- per-frame pieces ----

function updateParcels(now: number, t: number): void {
  if (!world) return;
  const { boxes, outlines, halos } = world;
  for (const p of field.slots) {
    const i = p.slot;
    if (p.state !== "free") {
      dummy.scale.setScalar(0);
      dummy.position.set(0, 0, 0);
      dummy.updateMatrix();
      boxes.setMatrixAt(i, dummy.matrix);
      outlines.setMatrixAt(i, dummy.matrix);
      halos.setMatrixAt(i, dummy.matrix);
      continue;
    }
    const fade = ParcelField.opacity(p, now);
    tmpV.copy(p.pos).normalize();
    dummy.position.copy(p.pos).addScaledVector(tmpV, reduced ? 0 : Math.sin(t * 2.2 + i) * 0.35);
    dummy.quaternion.setFromUnitVectors(Y, tmpV);
    tmpQ.setFromAxisAngle(Y, reduced ? 0.5 : t * 1.2 + i);
    dummy.quaternion.multiply(tmpQ);
    const s = 0.25 + 0.75 * fade;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    boxes.setMatrixAt(i, dummy.matrix);
    dummy.scale.setScalar(s * 1.14);
    dummy.updateMatrix();
    outlines.setMatrixAt(i, dummy.matrix);
    dummy.scale.setScalar(s * (1 + (reduced ? 0 : Math.sin(t * 4 + i) * 0.12)));
    dummy.updateMatrix();
    halos.setMatrixAt(i, dummy.matrix);
    const c = stageColors.get(p.stage);
    if (c) {
      boxes.setColorAt(i, c);
      halos.setColorAt(i, c);
    }
  }
  boxes.instanceMatrix.needsUpdate = true;
  outlines.instanceMatrix.needsUpdate = true;
  halos.instanceMatrix.needsUpdate = true;
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  if (halos.instanceColor) halos.instanceColor.needsUpdate = true;
}

function updateStack(): void {
  if (!world) return;
  carriedColors.length = 0;
  for (const p of field.slots) if (p.state === "carried") carriedColors.push(STAGE_COLOR[p.stage]);
  world.stack.forEach((m, i) => {
    const c = carriedColors[i];
    m.visible = c !== undefined;
    if (c && m.material instanceof THREE.MeshToonMaterial) m.material.color.set(c);
  });
  hud?.setCarried(carriedColors);
}

/** Plane-relative radar position: azimuth around the plane, arc distance to the rim. */
function radarPoint(target: THREE.Vector3, dot: RadarDot): number {
  if (!flight) return 0;
  const v = tmpV2.copy(target).normalize();
  const cos = Math.max(-1, Math.min(1, v.dot(flight.up)));
  const arc = Math.acos(cos) * (PLANET_R + flight.altitude);
  const az = Math.atan2(v.dot(flight.right), v.dot(flight.forward) - cos * flight.up.dot(flight.forward));
  const r = Math.min(1, arc / RADAR_RANGE);
  dot.x = Math.sin(az) * r;
  dot.y = Math.cos(az) * r;
  return az;
}

function updateCamera(ctx: ClientContext, dt: number, snap: boolean): void {
  if (!flight) return;
  const cam = ctx.camera;
  camWant.copy(flight.pos).addScaledVector(flight.forward, -10).addScaledVector(flight.up, 3.8);
  if (snap) cam.position.copy(camWant);
  else cam.position.lerp(camWant, 1 - Math.exp(-dt * 6));
  camLook.copy(flight.pos).addScaledVector(flight.forward, 9).addScaledVector(flight.up, 0.6);
  // The camera rolls a third of the way with the plane: the bank reads, the horizon stays calm.
  camUp.copy(flight.up).addScaledVector(flight.right, reduced ? 0 : flight.bank * 0.35).normalize();
  cam.up.copy(camUp);
  cam.lookAt(camLook);
  const fov = 55 + (flight.speed - 11) * 0.6;
  if (Math.abs(cam.fov - fov) > 0.05) {
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
    cam.updateProjectionMatrix();
  }
}

let savedFov = 0;

function frame(dt: number, ctx: ClientContext): void {
  if (!flight || !world || !hud) return;
  frameNo++;
  const now = Date.now();
  const perf = performance.now();
  const t = ctx.elapsed();

  // Approvals → beacons (4×/s is plenty).
  if (perf - lastBeaconScan > 250) {
    lastBeaconScan = perf;
    scanBeacons(ctx);
    fleetLive = false;
    for (const a of ctx.store.agents.values()) if (a.status === "live") fleetLive = true;
  }
  let nearest: Beacon | null = null;
  let nearestD = BEACON_RADIUS;
  for (const b of beacons) {
    const d = b.pos.distanceTo(flight.pos);
    if (d < nearestD) {
      nearest = b;
      nearestD = d;
    }
  }
  cardTarget = nearest;
  hold.setTarget(nearest?.approval.id ?? null, perf);
  hud.card.show(nearest?.approval ?? null, nearest ? whoLine(ctx, nearest.approval) : "");

  // Fly.
  if (frameNo % 8 === 1) groundAlt = ctx.surfacePoint(flight.up).length() - PLANET_R;
  steer();
  stepFlight(flight, input, dt, PLANET_R, groundAlt);
  world.plane.position.copy(flight.pos);
  planeQuaternion(flight, world.plane.quaternion);
  world.prop.rotation.z += dt * (20 + flight.speed * 2);
  updateCamera(ctx, dt, false);

  // Hold-to-confirm: only fires on a visible card, never while boosting.
  const boosting = holdBoosting();
  const fire = hold.update(perf, boosting);
  if (fire && cardTarget && cardTarget.approval.id === fire.targetId && hud.card.visible()) void sendDecision(ctx, cardTarget, fire.action);
  if (nearest) {
    const left = Math.max(0, Math.round((Date.parse(nearest.approval.expiresAt) - now) / 1000));
    hud.card.setHold(hold.holding(), hold.progress(perf), boosting, left);
  }

  // Replay feed (real events from today's transcripts), one at a time.
  if (replayMode && replayQueue.length && perf - lastReplayAt > REPLAY_EVERY_MS) {
    lastReplayAt = perf;
    const e = replayQueue.shift();
    if (e) spawnFromReplay(ctx, e, now);
  }

  // Parcels: expire, pick up, deliver.
  field.expire(now);
  if (field.pickup(flight.pos, picked).length) {
    playCue("pickup");
    for (const p of picked) ctx.labels.burst("GOT IT!", p.pos);
    updateStack();
  }
  const hq = ctx.cityPosition("harness");
  if (hq) {
    tmpV.copy(hq).normalize();
    tmpV2.copy(Y).addScaledVector(tmpV, -tmpV.y);
    if (tmpV2.lengthSq() < 1e-6) tmpV2.set(1, 0, 0);
    ringPos.copy(hq).addScaledVector(tmpV, RING_LIFT).addScaledVector(tmpV2.normalize(), -RING_SIDE);
    world.ring.position.copy(ringPos);
    // The torus is built in XY, so aligning Y with "up" stands the hoop upright.
    world.ring.quaternion.setFromUnitVectors(Y, tmpV);
    tmpQ.setFromAxisAngle(Y, t * 0.6);
    world.ring.quaternion.multiply(tmpQ);
    if (field.carried() > 0 && ringPos.distanceTo(flight.pos) < PARCELS.deliverRadius) {
      const d = field.deliver(now);
      if (d) {
        bumpScore({ points: d.points, delivered: d.count, combo: d.combo });
        ctx.labels.burst("DELIVERED!", ringPos);
        hud.pop("DELIVERED!", `+${d.points}${d.multiplier > 1 ? `  ×${d.multiplier} COMBO` : ""} · ${d.count} parcel${d.count === 1 ? "" : "s"}`);
        playCue("deliver");
        updateStack();
      }
    }
  }
  updateParcels(now, t);

  // Beacons.
  world.beacons.forEach((g, i) => {
    const b = beacons[i];
    g.visible = b !== undefined;
    if (!b) return;
    g.position.copy(b.pos);
    g.quaternion.setFromUnitVectors(Y, tmpV.copy(b.pos).normalize());
    const pulse = g.getObjectByName("pulse");
    if (pulse) {
      const k = reduced ? 0.6 : (t * 0.8 + i * 0.3) % 1;
      pulse.scale.setScalar(0.4 + k * 0.8);
      if (pulse instanceof THREE.Mesh && pulse.material instanceof THREE.MeshBasicMaterial) pulse.material.opacity = 0.7 * (1 - k);
    }
  });

  // HUD.
  const combo = field.liveCombo(now);
  hud.setCombo(combo, combo > 0 ? 1 - (now - field.lastDeliveryAt) / PARCELS.comboWindowMs : 0);
  hud.setBoost(flight.boostMeter, flight.boosting);
  const live = fleetLive;
  const freeCount = field.free();
  hud.setStatus(
    cardTarget
      ? ""
      : freeCount === 0 && field.carried() === 0 && beacons.length === 0 && !live && !replayQueue.length
        ? "Your fleet is quiet — parcels appear when an agent works. Free-fly: loop around Jev's moon."
        : field.carried() >= PARCELS.maxCarried
          ? "Hold full! Deliver to the yellow ring over Harness City."
          : freeCount === 0 && field.carried() === 0
            ? "Waiting for your agents' next tool call…"
            : "",
  );

  // Near label: the closest free parcel's real summary.
  let nearP: Parcel | null = null;
  let nearPD = NEAR_LABEL_RADIUS;
  for (const p of field.slots) {
    if (p.state !== "free") continue;
    const d = p.pos.distanceTo(flight.pos);
    if (d < nearPD) {
      nearP = p;
      nearPD = d;
    }
  }
  if (nearP) {
    const sp = toScreen(ctx, nearP.pos);
    const agent = ctx.store.agents.get(nearP.agentId);
    hud.near(sp.visible ? `${nearP.replay ? "REPLAY · " : ""}${nearP.stage.toUpperCase()} · ${nearP.summary}${agent ? ` — ${agentTitle(agent)}` : ""}` : null, sp.x, sp.y, STAGE_COLOR[nearP.stage]);
  } else hud.near(null, 0, 0, "");

  // Edge arrows: beacons first, then HQ when carrying, then the moon on a quiet day.
  let ai = 0;
  for (const b of beacons) {
    if (ai >= 3) break;
    const sp = toScreen(ctx, b.pos);
    if (sp.visible) continue;
    const az = radarPoint(b.pos, scratchDot);
    hud.arrow(ai++, true, az, `! ${b.approval.toolName}`, "beacon");
  }
  if (hq && field.carried() > 0 && !toScreen(ctx, ringPos).visible) hud.arrow(ai++, true, radarPoint(ringPos, scratchDot), "Deliver", "hq");
  if (!live && freeCount === 0 && moonBody) {
    moonBody.getWorldPosition(moonPos);
    if (!toScreen(ctx, moonPos).visible) hud.arrow(ai++, true, radarPoint(moonPos, scratchDot), "Jev", "moon");
  }
  for (; ai < 4; ai++) hud.arrow(ai, false, 0, "", "hq");

  // Radar, ~10×/s.
  if (perf - lastRadar > 100) {
    lastRadar = perf;
    let n = 0;
    for (const p of field.slots) {
      const dot = radarDots[n];
      if (p.state !== "free" || !dot) continue;
      radarPoint(p.pos, dot);
      dot.color = STAGE_COLOR[p.stage];
      dot.size = 6;
      n++;
    }
    for (const b of beacons) {
      const dot = radarDots[n];
      if (!dot) break;
      radarPoint(b.pos, dot);
      dot.color = "#ff3b3b";
      dot.size = 10;
      n++;
    }
    const hqDot = radarDots[n];
    if (hq && hqDot) {
      radarPoint(ringPos, hqDot);
      hqDot.color = "#ffd23f";
      hqDot.size = 11;
      n++;
    }
    hud.drawRadar(radarDots, n);
  }
}

function start(ctx: ClientContext): void {
  hud = hud ?? mountCourierHud();
  world = world ?? build(ctx);
  if (!moonBody) ctx.scene.traverse((o) => {
    if (!moonBody && typeof (o.userData as { openAsk?: unknown }).openAsk === "function") moonBody = o;
  });
  reduced = prefersReducedMotion();
  score = loadScore(safeLocalStorage(), localDay(new Date()));
  // Start above whatever you were looking at, nose toward Harness City.
  const dir = ctx.camera.position.clone().normalize();
  const hq = ctx.cityPosition("harness");
  // Starting right over the capital puts the camera inside its agenda billboard: back off a bit.
  const hqDir = hq?.clone().normalize();
  if (hqDir && dir.angleTo(hqDir) < START_CLEARANCE) {
    const axis = new THREE.Vector3().crossVectors(hqDir, dir);
    if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0).addScaledVector(hqDir, -hqDir.y);
    dir.copy(hqDir).applyAxisAngle(axis.normalize(), START_CLEARANCE);
  }
  flight = createFlight(PLANET_R, dir, 16);
  if (hq) {
    const toHq = hq.clone().normalize().addScaledVector(flight.up, -hq.clone().normalize().dot(flight.up));
    if (toHq.lengthSq() > 1e-6) {
      flight.forward.copy(toHq.normalize());
      flight.right.crossVectors(flight.forward, flight.up).normalize();
    }
  }
  // Recent real activity (still inside its 90s life) becomes parcels right away.
  const now = Date.now();
  for (const a of ctx.store.activities) spawnFromActivity(ctx, a, now);
  riding = true;
  keys.clear();
  hold.setTarget(null, performance.now());
  lastBeaconScan = -Infinity;
  world.root.visible = true;
  savedFov = ctx.camera.fov;
  updateStack();
  hud.show(true);
  hud.touch.enabled = !hud.touch.el.hidden;
  hud.setScore(score.points, helped(score));
  hud.setReplay(replayMode);
  document.body.classList.add("courier-riding");
  setApprovalCardSuppressed(true, ctx);
  setAgendaBillboardVisible(false);
  updateCamera(ctx, 0, true);
  if (replayMode && !replayQueue.length) void loadReplay(ctx);
  log.info("courier", "courier run started");
}

function stop(ctx: ClientContext): void {
  riding = false;
  keys.clear();
  drag.active = false;
  hold.setTarget(null, performance.now());
  cardTarget = null;
  if (world) world.root.visible = false;
  hud?.show(false);
  hud?.card.show(null, "");
  if (savedFov) {
    ctx.camera.fov = savedFov;
    ctx.camera.updateProjectionMatrix();
  }
  document.body.classList.remove("courier-riding");
  setApprovalCardSuppressed(false, ctx);
  setAgendaBillboardVisible(true);
  log.info("courier", `courier run ended (${score.points} pts today)`);
}

export const courierFeature: ClientFeature = {
  id: "courier",
  mount(ctx) {
    const params = new URLSearchParams(location.search);
    replayMode = params.get("courier") === "replay";
    autopilot = params.get("autopilot") === "1";
    hud = mountCourierHud();
    // "H hide all chrome" / focus / zen collapse the score HUD like any other surface. The
    // in-flight approval card is NOT collapsible, and a hidden card can never fire a decision.
    collapsible(hud.root, "courier", { pillLabel: "Courier", icon: "✈", corner: "tr" });
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    hud.touch.el.hidden = !(coarse || params.has("touch"));
    hud.card.onHoldButton((action, down) => {
      if (!riding) return;
      if (down) hold.press(action, performance.now(), { boosting: holdBoosting() });
      else hold.release(action);
    });
    wireInput();
    ctx.store.onActivity((list) => {
      if (!riding) return;
      const now = Date.now();
      for (const a of list) spawnFromActivity(ctx, a, now);
    });
  },
  ride: { start, frame, stop },
  paletteCommands: (ctx) => [
    {
      id: "start",
      title: riding ? "End courier run" : "Start a courier run",
      keywords: ["plane", "fly", "game", "parcels", "ride"],
      run: () => {
        if (riding) ctx.endRide();
        else ctx.showView("courier");
      },
    },
  ],
};
