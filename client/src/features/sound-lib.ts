// Pure, DOM/WebAudio-free helpers for the "sound" client feature: which agents just
// became awaiting-input (for the inbox "ding"), and how loud the ambient wind/rain
// layers should be for the current weather.

import type { WeatherKind } from "../../../shared/features/sky";

export interface AwaitingAgent {
  id: string;
  awaitingInput: boolean;
}

/** Agent ids that are awaiting input now but weren't in `prevIds` — the "ding" triggers. */
export function newlyAwaiting(prevIds: ReadonlySet<string>, agents: readonly AwaitingAgent[]): string[] {
  return agents.filter((a) => a.awaitingInput && !prevIds.has(a.id)).map((a) => a.id);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export interface AmbientGains {
  wind: number;
  rain: number;
}

/** Low, weather-matched ambient bed. Wind rises gently with cloud cover; rain/storm add
 *  a hiss layer. Both stay quiet — "master volume low" per the round's brief. */
export function ambientGains(kind: WeatherKind | null, cloudCoverPct: number | null): AmbientGains {
  const cloud = clamp01((cloudCoverPct ?? 0) / 100);
  const wind = 0.04 + cloud * 0.08;
  const rain = kind === "storm" ? 0.22 : kind === "rain" ? 0.15 : 0;
  return { wind, rain };
}
