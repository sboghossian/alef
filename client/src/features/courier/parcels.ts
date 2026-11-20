// Courier run parcels: one per REAL activity event (never invented). Pure game state:
// spawn / expiry / pickup / delivery + combo scoring, and the per-day score that is
// persisted in localStorage. Fixed-size slot pool so the hot path allocates nothing.

import * as THREE from "three";
import type { ActivityStage } from "../../../../shared/types";

export const PARCELS = {
  max: 25, // concurrent parcels in the world; the oldest free one makes room
  lifetimeMs: 90_000,
  fadeMs: 8_000, // last stretch of the lifetime fades out
  pickupRadius: 3.4,
  maxCarried: 5,
  deliverRadius: 6,
  comboWindowMs: 20_000,
  maxMultiplier: 5,
  pointsPerParcel: 10,
  pointsPerApproval: 25,
} as const;

export type ParcelState = "free" | "carried" | "empty";

export interface Parcel {
  slot: number;
  state: ParcelState;
  /** The activity id this parcel came from (dedupe key). */
  sourceId: string;
  agentId: string;
  stage: ActivityStage;
  summary: string;
  spawnedAt: number;
  pos: THREE.Vector3;
  /** Replayed from the server's jsonl feed rather than pushed live. */
  replay: boolean;
}

export interface SpawnInput {
  sourceId: string;
  agentId: string;
  stage: ActivityStage;
  summary: string;
  pos: THREE.Vector3;
  replay?: boolean;
}

export interface Delivery {
  count: number;
  points: number;
  multiplier: number;
  combo: number;
}

export class ParcelField {
  readonly slots: Parcel[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  combo = 0;
  lastDeliveryAt = -Infinity;

  constructor() {
    for (let i = 0; i < PARCELS.max; i++) {
      this.slots.push({ slot: i, state: "empty", sourceId: "", agentId: "", stage: "tool", summary: "", spawnedAt: 0, pos: new THREE.Vector3(), replay: false });
    }
  }

  /** Adds a parcel; false for an id already seen. At capacity the oldest FREE parcel is dropped. */
  spawn(input: SpawnInput, now: number): boolean {
    if (this.seen.has(input.sourceId)) return false;
    let slot = this.slots.find((p) => p.state === "empty");
    if (!slot) {
      let oldest: Parcel | undefined;
      for (const p of this.slots) if (p.state === "free" && (!oldest || p.spawnedAt < oldest.spawnedAt)) oldest = p;
      if (!oldest) return false; // every slot is carried: nothing to evict
      slot = oldest;
    }
    this.remember(input.sourceId);
    slot.state = "free";
    slot.sourceId = input.sourceId;
    slot.agentId = input.agentId;
    slot.stage = input.stage;
    slot.summary = input.summary;
    slot.spawnedAt = now;
    slot.pos.copy(input.pos);
    slot.replay = input.replay === true;
    return true;
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift() ?? "");
  }

  /** Free parcels older than the lifetime disappear. Carried ones are safe. Returns how many expired. */
  expire(now: number): number {
    let n = 0;
    for (const p of this.slots) {
      if (p.state === "free" && now - p.spawnedAt >= PARCELS.lifetimeMs) {
        p.state = "empty";
        n++;
      }
    }
    return n;
  }

  /** 1 = fresh, falling to 0 over the last fadeMs of its life. */
  static opacity(p: Parcel, now: number): number {
    const left = PARCELS.lifetimeMs - (now - p.spawnedAt);
    return Math.max(0, Math.min(1, left / PARCELS.fadeMs));
  }

  carried(): number {
    let n = 0;
    for (const p of this.slots) if (p.state === "carried") n++;
    return n;
  }

  free(): number {
    let n = 0;
    for (const p of this.slots) if (p.state === "free") n++;
    return n;
  }

  /** Picks up every free parcel within reach of `planePos` (up to the carry limit). Returns the ones picked. */
  pickup(planePos: THREE.Vector3, out: Parcel[] = []): Parcel[] {
    out.length = 0;
    let room = PARCELS.maxCarried - this.carried();
    const r2 = PARCELS.pickupRadius * PARCELS.pickupRadius;
    for (const p of this.slots) {
      if (room <= 0) break;
      if (p.state !== "free" || p.pos.distanceToSquared(planePos) > r2) continue;
      p.state = "carried";
      out.push(p);
      room--;
    }
    return out;
  }

  /**
   * Delivers everything carried. Consecutive deliveries within comboWindowMs build a combo;
   * the multiplier is the combo, capped. Null when nothing is carried.
   */
  deliver(now: number): Delivery | null {
    const count = this.carried();
    if (count === 0) return null;
    for (const p of this.slots) if (p.state === "carried") p.state = "empty";
    this.combo = now - this.lastDeliveryAt <= PARCELS.comboWindowMs ? this.combo + 1 : 1;
    this.lastDeliveryAt = now;
    const multiplier = Math.min(this.combo, PARCELS.maxMultiplier);
    return { count, points: count * PARCELS.pointsPerParcel * multiplier, multiplier, combo: this.combo };
  }

  /** The combo shown on the HUD: 0 once the window has lapsed. */
  liveCombo(now: number): number {
    return now - this.lastDeliveryAt <= PARCELS.comboWindowMs ? this.combo : 0;
  }
}

// ---- "agents helped today", persisted per local day ----

export interface DayScore {
  day: string; // YYYY-MM-DD, local
  points: number;
  delivered: number;
  approvals: number;
  best: number; // best combo
}

export interface ScoreStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SCORE_KEY = "agent-world.courier.score";

export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Today's score; a stored score from another day (or garbage) starts fresh. */
export function loadScore(store: ScoreStore | null, today: string): DayScore {
  const fresh: DayScore = { day: today, points: 0, delivered: 0, approvals: 0, best: 0 };
  if (!store) return fresh;
  try {
    const parsed: unknown = JSON.parse(store.getItem(SCORE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return fresh;
    const r = parsed as Record<string, unknown>;
    if (r.day !== today) return fresh;
    return { day: today, points: num(r.points), delivered: num(r.delivered), approvals: num(r.approvals), best: num(r.best) };
  } catch {
    return fresh;
  }
}

export function saveScore(store: ScoreStore | null, score: DayScore): void {
  try {
    store?.setItem(SCORE_KEY, JSON.stringify(score));
  } catch {
    /* private mode: the score just resets on reload */
  }
}

/** Agents helped today = parcels delivered + approvals decided. */
export function helped(score: DayScore): number {
  return score.delivered + score.approvals;
}
