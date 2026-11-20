// Pure, DOM-free math for the "sky" client feature: sun/moon position from real local
// time (+ sunrise/sunset when OpenMeteo has them), the fps-guard accumulator, and debug
// query-param parsing. Kept separate from sky.ts (which touches THREE/canvas/DOM) so
// it's trivially unit-testable under vitest's default "node" environment.

import type { WeatherKind } from "../../../shared/features/sky";

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export interface CelestialPos {
  visible: boolean;
  /** 0 (horizon) .. 1 (overhead). 0 when not visible. */
  elevation: number;
  /** 0 (rise side) .. 1 (set side) — a comic left-to-right sky sweep, not true azimuth. */
  azimuthT: number;
}

function hourOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** Sun's stylized sky position. Uses real sunrise/sunset when known; otherwise falls
 *  back to a flat 06:00-18:00 day window on the local clock. */
export function sunPosition(nowMs: number, sunriseMs: number | null, sunsetMs: number | null): CelestialPos {
  if (sunriseMs === null || sunsetMs === null || sunsetMs <= sunriseMs) {
    const h = hourOfDay(nowMs);
    const t = clamp01((h - 6) / 12);
    return { visible: h >= 6 && h <= 18, elevation: Math.sin(Math.PI * t), azimuthT: t };
  }
  if (nowMs < sunriseMs || nowMs > sunsetMs) {
    return { visible: false, elevation: 0, azimuthT: nowMs < sunriseMs ? 0 : 1 };
  }
  const t = (nowMs - sunriseMs) / (sunsetMs - sunriseMs);
  return { visible: true, elevation: Math.sin(Math.PI * t), azimuthT: t };
}

/** Moon's stylized sky position: the complementary night window [sunset, next sunrise). */
export function moonPosition(nowMs: number, sunriseMs: number | null, sunsetMs: number | null): CelestialPos {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (sunriseMs === null || sunsetMs === null || sunsetMs <= sunriseMs) {
    const h = hourOfDay(nowMs);
    if (h >= 6 && h <= 18) return { visible: false, elevation: 0, azimuthT: 0 };
    const t = h > 18 ? clamp01((h - 18) / 12) : clamp01((h + 6) / 12);
    return { visible: true, elevation: Math.sin(Math.PI * t), azimuthT: t };
  }
  if (nowMs >= sunriseMs && nowMs <= sunsetMs) return { visible: false, elevation: 0, azimuthT: 0 };
  let t: number;
  if (nowMs > sunsetMs) {
    const nextSunrise = sunriseMs + DAY_MS;
    t = (nowMs - sunsetMs) / (nextSunrise - sunsetMs);
  } else {
    const prevSunset = sunsetMs - DAY_MS;
    t = (nowMs - prevSunset) / (sunriseMs - prevSunset);
  }
  return { visible: true, elevation: Math.sin(Math.PI * clamp01(t)), azimuthT: clamp01(t) };
}

/** Continuous -1 (deep night) .. 0 (sunrise/sunset) .. 1 (solar noon) signal for blending
 *  the sky gradient. Unlike elevation (which is 0 at both the horizon AND at midnight),
 *  this never has a discontinuity, so a canvas gradient built from it never jumps. */
export function daylightFactor(nowMs: number, sunriseMs: number | null, sunsetMs: number | null): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (sunriseMs === null || sunsetMs === null || sunsetMs <= sunriseMs) {
    const h = hourOfDay(nowMs);
    if (h >= 6 && h <= 18) return Math.sin(Math.PI * clamp01((h - 6) / 12));
    const t = h > 18 ? clamp01((h - 18) / 12) : clamp01((h + 6) / 12);
    return -Math.sin(Math.PI * t);
  }
  if (nowMs >= sunriseMs && nowMs <= sunsetMs) {
    return Math.sin(Math.PI * ((nowMs - sunriseMs) / (sunsetMs - sunriseMs)));
  }
  let t: number;
  if (nowMs > sunsetMs) {
    const nextSunrise = sunriseMs + DAY_MS;
    t = (nowMs - sunsetMs) / (nextSunrise - sunsetMs);
  } else {
    const prevSunset = sunsetMs - DAY_MS;
    t = (nowMs - prevSunset) / (sunriseMs - prevSunset);
  }
  return -Math.sin(Math.PI * clamp01(t));
}

/** Places a celestial body on a big comic arc: left-to-right for azimuth, up for elevation. */
export function celestialWorldPos(pos: CelestialPos, radius: number): { x: number; y: number; z: number } {
  return {
    x: (pos.azimuthT * 2 - 1) * radius,
    y: Math.max(0.05, pos.elevation) * radius * 0.9 + radius * 0.08,
    z: -radius * 0.35,
  };
}

/** Seconds spent below the fps floor, reset to 0 the instant fps recovers. */
export function nextLowFpsAccum(currentSeconds: number, fps: number, dtSeconds: number, floor = 30): number {
  if (fps >= floor) return 0;
  return currentSeconds + dtSeconds;
}

const WEATHER_ICONS: Record<WeatherKind, string> = {
  clear: "☀",
  cloudy: "⛅",
  fog: "🌫",
  rain: "🌧",
  snow: "❄",
  storm: "⛈",
};

export function weatherIcon(kind: WeatherKind | null): string {
  return kind ? WEATHER_ICONS[kind] : "…";
}

export interface DebugOverrides {
  /** Minutes since local midnight, or null when ?time= is absent/malformed. */
  timeOfDayMin: number | null;
  weather: WeatherKind | null;
  cpu: number | null;
  active: boolean;
}

const WEATHER_KINDS: readonly WeatherKind[] = ["clear", "cloudy", "fog", "rain", "snow", "storm"];

/** Parses the `?time=HH:MM&weather=rain&cpu=95` debug overrides used for deterministic screenshots. */
export function parseDebugOverrides(search: string): DebugOverrides {
  const params = new URLSearchParams(search);
  const timeStr = params.get("time");
  let timeOfDayMin: number | null = null;
  if (timeStr && /^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(":").map(Number);
    if (h !== undefined && m !== undefined && h >= 0 && h < 24 && m >= 0 && m < 60) timeOfDayMin = h * 60 + m;
  }
  const weatherStr = params.get("weather");
  const weather = weatherStr && (WEATHER_KINDS as readonly string[]).includes(weatherStr) ? (weatherStr as WeatherKind) : null;
  const cpuStr = params.get("cpu");
  const cpuNum = cpuStr !== null ? Number(cpuStr) : NaN;
  const cpu = Number.isFinite(cpuNum) ? Math.min(100, Math.max(0, cpuNum)) : null;
  return { timeOfDayMin, weather, cpu, active: timeOfDayMin !== null || weather !== null || cpu !== null };
}
