import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FLIGHT, createFlight, stepFlight } from "./flight";
import { HoldToConfirm } from "./hold";
import { PARCELS, ParcelField, SCORE_KEY, helped, loadScore, localDay, saveScore, type ScoreStore } from "./parcels";

const R = 50;
const idle = { turn: 0, pitch: 0, boost: false };

function run(steps: number, dt: number, fn: (i: number) => void): void {
  for (let i = 0; i < steps; i++) fn(i);
}

describe("flight physics", () => {
  it("speed stays bounded, even boosting forever or with garbage input", () => {
    const s = createFlight(R, new THREE.Vector3(0, 0, 1));
    run(600, 1 / 60, () => stepFlight(s, { turn: 1, pitch: 1, boost: true }, 1 / 60, R));
    expect(s.speed).toBeLessThanOrEqual(FLIGHT.maxSpeed);
    expect(s.speed).toBeGreaterThanOrEqual(FLIGHT.minSpeed);
    run(60, 1 / 60, () => stepFlight(s, { turn: Number.NaN, pitch: Infinity, boost: true }, 5, R));
    expect(s.speed).toBeLessThanOrEqual(FLIGHT.maxSpeed);
    expect(Number.isFinite(s.pos.x)).toBe(true);
  });

  it("boost drains the meter, then stops boosting and recharges", () => {
    const s = createFlight(R, new THREE.Vector3(1, 0, 0));
    run(60, 1 / 60, () => stepFlight(s, { ...idle, boost: true }, 1 / 60, R));
    expect(s.boosting).toBe(true);
    expect(s.boostMeter).toBeLessThan(1);
    run(5 * 60, 1 / 60, () => stepFlight(s, { ...idle, boost: true }, 1 / 60, R));
    // Ran dry while held: no stutter-boosting until the key is let go.
    expect(s.boosting).toBe(false);
    expect(s.boostSpent).toBe(true);
    run(3 * 60, 1 / 60, () => stepFlight(s, idle, 1 / 60, R));
    expect(s.boostMeter).toBeGreaterThan(0.3);
  });

  it("auto-levels bank and pitch once the stick is released", () => {
    const s = createFlight(R, new THREE.Vector3(0, 1, 0));
    run(60, 1 / 60, () => stepFlight(s, { turn: 1, pitch: 1, boost: false }, 1 / 60, R));
    expect(s.bank).toBeGreaterThan(FLIGHT.maxBank * 0.8);
    run(4 * 60, 1 / 60, () => stepFlight(s, idle, 1 / 60, R));
    expect(Math.abs(s.bank)).toBeLessThan(0.02);
    expect(Math.abs(s.pitch)).toBeLessThan(0.02);
  });

  it("stays on its shell: altitude clamped, heading tangent, position at planet radius + altitude", () => {
    const s = createFlight(R, new THREE.Vector3(0.3, 0.2, 1));
    run(20 * 60, 1 / 60, (i) => stepFlight(s, { turn: Math.sin(i / 50), pitch: i < 600 ? -1 : 1, boost: i % 200 < 50 }, 1 / 60, R, 3));
    expect(s.altitude).toBeGreaterThanOrEqual(3 + FLIGHT.minAltitude - 1e-9);
    expect(s.altitude).toBeLessThanOrEqual(FLIGHT.maxAltitude);
    expect(s.pos.length()).toBeCloseTo(R + s.altitude, 6);
    expect(Math.abs(s.forward.dot(s.up))).toBeLessThan(1e-6);
    expect(s.forward.length()).toBeCloseTo(1, 6);
  });

  it("banking right turns right", () => {
    const s = createFlight(R, new THREE.Vector3(0, 0, 1));
    const right0 = s.right.clone();
    run(30, 1 / 60, () => stepFlight(s, { turn: 1, pitch: 0, boost: false }, 1 / 60, R));
    expect(s.forward.dot(right0)).toBeGreaterThan(0);
  });
});

const at = (x: number): THREE.Vector3 => new THREE.Vector3(x, 0, 0);
const spawnN = (f: ParcelField, n: number, now: number, prefix = "a"): void => {
  for (let i = 0; i < n; i++) f.spawn({ sourceId: `${prefix}${i}`, agentId: "ag", stage: "tool", summary: "Edit x", pos: at(i * 100) }, now + i);
};

describe("parcels", () => {
  it("spawns one parcel per activity id (dedupe) and caps concurrency, evicting the oldest free", () => {
    const f = new ParcelField();
    expect(f.spawn({ sourceId: "x", agentId: "a", stage: "tool", summary: "", pos: at(0) }, 0)).toBe(true);
    expect(f.spawn({ sourceId: "x", agentId: "a", stage: "tool", summary: "", pos: at(0) }, 1)).toBe(false);
    spawnN(f, PARCELS.max + 5, 10);
    expect(f.free()).toBe(PARCELS.max);
    const ids = f.slots.map((p) => p.sourceId);
    expect(ids).not.toContain("x");
    expect(ids).not.toContain("a0");
    expect(ids).toContain(`a${PARCELS.max + 4}`);
  });

  it("free parcels expire after 90s and fade near the end; carried ones do not expire", () => {
    const f = new ParcelField();
    f.spawn({ sourceId: "p", agentId: "a", stage: "plan", summary: "", pos: at(0) }, 0);
    f.spawn({ sourceId: "q", agentId: "a", stage: "plan", summary: "", pos: at(1000) }, 0);
    f.pickup(at(1000));
    const p = f.slots.find((s) => s.sourceId === "p");
    if (!p) throw new Error("missing parcel");
    expect(ParcelField.opacity(p, 10_000)).toBe(1);
    expect(ParcelField.opacity(p, PARCELS.lifetimeMs - PARCELS.fadeMs / 2)).toBeCloseTo(0.5);
    expect(f.expire(PARCELS.lifetimeMs - 1)).toBe(0);
    expect(f.expire(PARCELS.lifetimeMs)).toBe(1);
    expect(f.free()).toBe(0);
    expect(f.carried()).toBe(1);
  });

  it("picks up only within reach and never more than 5", () => {
    const f = new ParcelField();
    for (let i = 0; i < 8; i++) f.spawn({ sourceId: `c${i}`, agentId: "a", stage: "tool", summary: "", pos: at(i * 0.1) }, 0);
    f.spawn({ sourceId: "far", agentId: "a", stage: "tool", summary: "", pos: at(50) }, 0);
    expect(f.pickup(at(PARCELS.pickupRadius + 5)).length).toBe(0);
    expect(f.pickup(at(0)).length).toBe(PARCELS.maxCarried);
    expect(f.carried()).toBe(PARCELS.maxCarried);
    expect(f.pickup(at(0)).length).toBe(0);
  });

  it("delivery scores parcels x 10 x combo; the combo grows within 20s and resets after", () => {
    const f = new ParcelField();
    expect(f.deliver(0)).toBeNull();
    spawnN(f, 2, 0, "d");
    f.slots.forEach((p) => p.state === "free" && p.pos.set(0, 0, 0));
    f.pickup(at(0));
    expect(f.deliver(1000)).toEqual({ count: 2, points: 20, multiplier: 1, combo: 1 });
    spawnN(f, 1, 0, "e");
    f.slots.forEach((p) => p.state === "free" && p.pos.set(0, 0, 0));
    f.pickup(at(0));
    expect(f.deliver(1000 + PARCELS.comboWindowMs)).toEqual({ count: 1, points: 20, multiplier: 2, combo: 2 });
    expect(f.liveCombo(1000 + PARCELS.comboWindowMs * 2)).toBe(2);
    expect(f.liveCombo(1001 + PARCELS.comboWindowMs * 2)).toBe(0);
    spawnN(f, 1, 0, "g");
    f.slots.forEach((p) => p.state === "free" && p.pos.set(0, 0, 0));
    f.pickup(at(0));
    expect(f.deliver(2001 + PARCELS.comboWindowMs * 2)?.multiplier).toBe(1);
  });

  it("the combo multiplier caps at 5", () => {
    const f = new ParcelField();
    let last = 0;
    for (let i = 0; i < 8; i++) {
      f.spawn({ sourceId: `m${i}`, agentId: "a", stage: "tool", summary: "", pos: at(0) }, 0);
      f.pickup(at(0));
      last = f.deliver(i * 1000)?.multiplier ?? 0;
    }
    expect(last).toBe(PARCELS.maxMultiplier);
  });
});

describe("daily score", () => {
  const mem = (): ScoreStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it("persists per local day and starts fresh on a new day or bad data", () => {
    const s = mem();
    const today = localDay(new Date(2026, 8, 25, 23, 59));
    expect(today).toBe("2026-09-25");
    saveScore(s, { day: today, points: 90, delivered: 4, approvals: 1, best: 3 });
    expect(loadScore(s, today)).toEqual({ day: today, points: 90, delivered: 4, approvals: 1, best: 3 });
    expect(helped(loadScore(s, today))).toBe(5);
    expect(loadScore(s, "2026-09-26").points).toBe(0);
    s.data.set(SCORE_KEY, "{not json");
    expect(loadScore(s, today).points).toBe(0);
    s.data.set(SCORE_KEY, JSON.stringify({ day: today, points: -5, delivered: "x" }));
    expect(loadScore(s, today)).toMatchObject({ points: 0, delivered: 0 });
    expect(loadScore(null, today).points).toBe(0);
  });
});

describe("approval hold-to-confirm", () => {
  it("fires once after a full 1s hold on an armed card", () => {
    const h = new HoldToConfirm(1000, 600);
    h.setTarget("ap1", 0);
    expect(h.press("allow", 700, { boosting: false })).toBe("started");
    expect(h.update(1500, false)).toBeNull();
    expect(h.progress(1200)).toBeCloseTo(0.5);
    expect(h.update(1700, false)).toEqual({ action: "allow", targetId: "ap1" });
    expect(h.update(2500, false)).toBeNull();
    // Still latched until the key comes up: no second decision from the same press.
    expect(h.press("allow", 2600, { boosting: false })).toBe("busy");
    h.release("allow");
    expect(h.press("deny", 2700, { boosting: false })).toBe("started");
  });

  it("releasing early sends nothing", () => {
    const h = new HoldToConfirm();
    h.setTarget("ap1", 0);
    h.press("deny", 1000, { boosting: false });
    h.release("deny");
    expect(h.update(5000, false)).toBeNull();
    expect(h.progress(5000)).toBe(0);
  });

  it("is disabled while boosting, and boosting mid-hold cancels it", () => {
    const h = new HoldToConfirm();
    h.setTarget("ap1", 0);
    expect(h.press("allow", 1000, { boosting: true })).toBe("boosting");
    expect(h.update(3000, false)).toBeNull();
    expect(h.press("allow", 3000, { boosting: false })).toBe("started");
    expect(h.update(3500, true)).toBeNull();
    expect(h.update(4500, false)).toBeNull();
    // Needs a fresh press after the boost cancel.
    expect(h.press("allow", 4600, { boosting: false })).toBe("busy");
    h.release("allow");
    expect(h.press("allow", 4700, { boosting: false })).toBe("started");
  });

  it("ignores key auto-repeat, presses before the card is armed, and presses with no card", () => {
    const h = new HoldToConfirm(1000, 600);
    expect(h.press("allow", 0, { boosting: false })).toBe("no-target");
    h.setTarget("ap1", 1000);
    expect(h.press("deny", 1200, { boosting: false })).toBe("not-armed");
    expect(h.press("deny", 2000, { boosting: false, repeat: true })).toBe("repeat");
    expect(h.update(9000, false)).toBeNull();
  });

  it("a different approval (or none) cancels an in-progress hold", () => {
    const h = new HoldToConfirm();
    h.setTarget("ap1", 0);
    h.press("allow", 1000, { boosting: false });
    h.setTarget("ap2", 1500);
    expect(h.update(2500, false)).toBeNull();
    h.setTarget(null, 2600);
    expect(h.press("allow", 4000, { boosting: false })).toBe("no-target");
  });
});
