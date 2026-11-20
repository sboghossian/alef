// Real sky: OpenMeteo weather (no key) + sunrise/sunset, refreshed every 10 min, and
// local machine load (CPU/RAM/battery) refreshed every 15s. No routes — state is pushed
// through snapshotExtras (cold load) and ctx.emit (live ticks).
//
// Location: Alex is in Lisbon since 2026-08 (per this round's brief). No coordinates
// were found in yalla-brief's source (only in its already-rendered output HTML), so this
// uses the fallback the brief explicitly authorizes: Lisbon, 33.89, 35.50.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { SkyLocation, SkyMachine, SkyPayload, SkyWeather } from "../../shared/features/sky.js";
import { SKY_EXTRAS_KEY } from "../../shared/features/sky.js";
import type { ServerFeature } from "./registry.js";
import { parseBatteryPmsetOutput, parseCpuPsOutput, parseMemoryPressureOutput, weatherKindFromCode } from "./sky-lib.js";

const execFileAsync = promisify(execFile);

const LOCATION: SkyLocation = { lat: 33.89, lon: 35.5, label: "Lisbon" };
const MACHINE_TICK_MS = 15_000;
const WEATHER_REFRESH_MS = 10 * 60_000;
const OPEN_METEO_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}` +
  `&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,is_day` +
  `&daily=sunrise,sunset&timezone=auto`;

function emptyWeather(): SkyWeather {
  return {
    online: false,
    fetchedAt: null,
    temperatureC: null,
    weatherCode: null,
    kind: null,
    cloudCover: null,
    precipitationMm: null,
    windSpeedKph: null,
    isDay: null,
    sunrise: null,
    sunset: null,
  };
}

function emptyMachine(): SkyMachine {
  return { cpuPercent: null, memPercent: null, batteryPercent: null, batteryCharging: null };
}

let state: SkyPayload = { at: new Date(0).toISOString(), location: LOCATION, weather: emptyWeather(), machine: emptyMachine() };
let lastWeatherFetchAt = 0;

/** Test hook: reset module state between test files. */
export function resetSkyStateForTests(): void {
  state = { at: new Date(0).toISOString(), location: LOCATION, weather: emptyWeather(), machine: emptyMachine() };
  lastWeatherFetchAt = 0;
}

async function readCpuPercent(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "%cpu"], { timeout: 3000 });
    return parseCpuPsOutput(stdout, os.cpus().length);
  } catch {
    return null;
  }
}

async function readBattery(): Promise<{ percent: number | null; charging: boolean | null }> {
  try {
    const { stdout } = await execFileAsync("pmset", ["-g", "batt"], { timeout: 3000 });
    const { percent, charging } = parseBatteryPmsetOutput(stdout);
    return { percent, charging };
  } catch {
    return { percent: null, charging: null };
  }
}

// os.freemem() on macOS excludes cached/inactive pages, so it always reads ~99% used.
// memory_pressure reports the figure Activity Monitor uses.
async function readMemPercent(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("memory_pressure", [], { timeout: 3000 });
    return parseMemoryPressureOutput(stdout);
  } catch {
    return null;
  }
}

async function readMachine(): Promise<SkyMachine> {
  const [cpuPercent, battery, memPercent] = await Promise.all([readCpuPercent(), readBattery(), readMemPercent()]);
  return { cpuPercent, memPercent, batteryPercent: battery.percent, batteryCharging: battery.charging };
}

interface OpenMeteoFetch {
  (url: string, timeoutMs: number): Promise<unknown>;
}

const defaultFetch: OpenMeteoFetch = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`OpenMeteo HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parses an OpenMeteo /v1/forecast response into SkyWeather. Exported for tests. */
export function parseOpenMeteoResponse(body: unknown, fetchedAt: string): SkyWeather | null {
  if (!isRecord(body)) return null;
  const current = isRecord(body.current) ? body.current : null;
  const daily = isRecord(body.daily) ? body.daily : null;
  if (!current) return null;
  const weatherCode = typeof current.weather_code === "number" ? current.weather_code : null;
  const sunrise = Array.isArray(daily?.sunrise) && typeof daily.sunrise[0] === "string" ? daily.sunrise[0] : null;
  const sunset = Array.isArray(daily?.sunset) && typeof daily.sunset[0] === "string" ? daily.sunset[0] : null;
  return {
    online: true,
    fetchedAt,
    temperatureC: typeof current.temperature_2m === "number" ? current.temperature_2m : null,
    weatherCode,
    kind: weatherCode === null ? null : weatherKindFromCode(weatherCode),
    cloudCover: typeof current.cloud_cover === "number" ? current.cloud_cover : null,
    precipitationMm: typeof current.precipitation === "number" ? current.precipitation : null,
    windSpeedKph: typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : null,
    isDay: typeof current.is_day === "number" ? current.is_day === 1 : null,
    sunrise,
    sunset,
  };
}

async function refreshWeather(fetchImpl: OpenMeteoFetch): Promise<SkyWeather | null> {
  try {
    const body = await fetchImpl(OPEN_METEO_URL, 5000);
    return parseOpenMeteoResponse(body, new Date().toISOString());
  } catch {
    return null; // offline / unreachable — caller keeps the last known-good values
  }
}

export const skyFeature: ServerFeature = {
  id: "sky",
  tickIntervalMs: MACHINE_TICK_MS,
  async onTick(ctx) {
    const machine = await readMachine();
    let weather = state.weather;
    const now = Date.now();
    if (now - lastWeatherFetchAt >= WEATHER_REFRESH_MS) {
      lastWeatherFetchAt = now;
      const fresh = await refreshWeather(defaultFetch);
      if (fresh) {
        weather = fresh;
      } else {
        weather = { ...weather, online: false };
        ctx.log.warn("sky", "OpenMeteo unreachable — keeping last known weather");
      }
    }
    state = { at: new Date().toISOString(), location: LOCATION, weather, machine };
    ctx.emit(state);
  },
  snapshotExtras() {
    return { [SKY_EXTRAS_KEY]: state };
  },
};
