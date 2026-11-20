// Tiny cross-feature bridge: ClientFeature.onMessage only routes a feature's OWN "feature"
// WS messages to itself (client/src/features/registry.ts), so the "sound" feature (which
// wants weather to drive ambient audio) can't subscribe to "sky"'s pushes through the
// registry. This module is the one place both sky.ts and sound.ts import to share the
// latest payload without coupling through main.ts or a hub file.

import type { SkyPayload } from "../../../shared/features/sky";

let latest: SkyPayload | null = null;
const listeners = new Set<(payload: SkyPayload) => void>();

export function setSkyState(payload: SkyPayload): void {
  latest = payload;
  for (const fn of listeners) fn(payload);
}

export function getSkyState(): SkyPayload | null {
  return latest;
}

export function onSkyState(fn: (payload: SkyPayload) => void): void {
  listeners.add(fn);
}
