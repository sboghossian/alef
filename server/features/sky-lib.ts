// Pure, dependency-free helpers for the "sky" feature: parsing shell output and
// mapping OpenMeteo's WMO weather_code to the coarse kind the client renders.
// Kept separate from sky.ts (which does the execFile/fetch IO) so they're trivial to unit test.

import type { WeatherKind } from "../../shared/features/sky.js";

/** Sum of every process's %cpu (from `ps -A -o %cpu`, header line first) divided by core
 *  count, clamped to 0..100. Mirrors jarvis's awareness.ts getCpuUsage(). */
export function parseCpuPsOutput(stdout: string, cpuCount: number): number {
  const lines = stdout.trim().split("\n").slice(1); // drop the "%CPU" header
  const total = lines.reduce((sum, l) => sum + (parseFloat(l.trim()) || 0), 0);
  const cores = cpuCount > 0 ? cpuCount : 1;
  return Math.min(100, Math.max(0, Math.round(total / cores)));
}

export interface BatteryReading {
  percent: number | null;
  charging: boolean;
}

/** Parses `pmset -g batt` output, e.g. "Now drawing from 'AC Power' ... 87%; charging;". */
export function parseBatteryPmsetOutput(stdout: string): BatteryReading {
  const match = /(\d+)%/.exec(stdout);
  const percent = match?.[1] ? parseInt(match[1], 10) : null;
  const charging = /AC Power/.test(stdout) || /\bcharging\b/i.test(stdout);
  return { percent, charging };
}

/** WMO weather_code (https://open-meteo.com/en/docs) -> coarse bucket for sky tint + particles. */
export function weatherKindFromCode(code: number): WeatherKind {
  if (code === 0) return "clear";
  if (code === 1 || code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 67) return "rain"; // drizzle, freezing drizzle, rain, freezing rain
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return "snow";
  if (code >= 80 && code <= 82) return "rain"; // rain showers
  if (code === 95 || code === 96 || code === 99) return "storm"; // thunderstorm (+/- hail)
  return "cloudy";
}

/** Used-memory % from `memory_pressure` ("System-wide memory free percentage: 32%" → 68). */
export function parseMemoryPressureOutput(stdout: string): number | null {
  const m = /free percentage:\s*(\d+)%/i.exec(stdout);
  if (!m?.[1]) return null;
  const free = Number(m[1]);
  return free >= 0 && free <= 100 ? 100 - free : null;
}
