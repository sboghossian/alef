// 🩺 Health keeper, client side: caches the server keeper's state (snapshot extras
// "health-keeper.state", then its WS pushes) for the Inbox's "Health" item. Read-only: the keeper
// acts on its own at 04:30 (server/features/health-keeper.ts); nothing here calls a route.
// Same module-scope cache + subscribe-and-deliver pattern as president.ts, so it doesn't matter
// whether this feature or inbox.ts mounts first.

import { HEALTH_KEEPER_EXTRAS_KEY, isHealthKeeperState, type HealthKeeperInboxItem, type HealthKeeperState } from "../../../shared/features/health-keeper";
import { isRecord } from "./fleet-overlay";
import type { ClientFeature } from "./registry";

let cached: HealthKeeperState | null = null;
const listeners: Array<() => void> = [];

export function currentHealthKeeper(): HealthKeeperState | null {
  return cached;
}

/** The keeper's open Inbox item (under 100, not resolved yet), or null. */
export function openHealthInboxItem(state: HealthKeeperState | null = cached): HealthKeeperInboxItem | null {
  const item = state?.inbox ?? null;
  return item && item.resolvedAt === null ? item : null;
}

/** Subscribes to every future update, and delivers the current cache once right away. */
export function onHealthKeeperUpdate(fn: () => void): void {
  listeners.push(fn);
  fn();
}

function take(state: unknown): void {
  if (!isHealthKeeperState(state)) return;
  cached = state;
  for (const fn of listeners) fn();
}

export const healthKeeperFeature: ClientFeature = {
  id: "health-keeper",
  onSnapshot(world) {
    take(world.extras?.[HEALTH_KEEPER_EXTRAS_KEY]);
  },
  onMessage(msg) {
    const payload = msg.payload;
    if (isRecord(payload) && payload.kind === "state") take(payload.state);
  },
};
