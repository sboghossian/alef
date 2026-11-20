// Payload for the "sky" feature: real weather (OpenMeteo) + local machine load.
// Pushed via snapshotExtras (key SKY_EXTRAS_KEY) and via ctx.emit on every tick.

export interface SkyLocation {
  lat: number;
  lon: number;
  label: string;
}

/** Coarse bucket the client uses to pick sky tint + particle kind. Derived from OpenMeteo's WMO weather_code. */
export type WeatherKind = "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm";

export interface SkyWeather {
  /** True when the last OpenMeteo fetch succeeded. False keeps whatever fields were last known good
   *  (all null if there has never been a successful fetch) — "weather offline" in the client. */
  online: boolean;
  fetchedAt: string | null;
  temperatureC: number | null;
  weatherCode: number | null;
  kind: WeatherKind | null;
  cloudCover: number | null; // 0..100
  precipitationMm: number | null;
  windSpeedKph: number | null;
  isDay: boolean | null;
  sunrise: string | null; // ISO, local to the configured location
  sunset: string | null; // ISO, local to the configured location
}

export interface SkyMachine {
  cpuPercent: number | null;
  memPercent: number | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
}

export interface SkyPayload {
  at: string; // ISO, when this payload was produced
  location: SkyLocation;
  weather: SkyWeather;
  machine: SkyMachine;
}

export const SKY_EXTRAS_KEY = "sky.state";
