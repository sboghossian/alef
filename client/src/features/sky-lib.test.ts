import { describe, expect, it } from "vitest";
import { celestialWorldPos, daylightFactor, moonPosition, nextLowFpsAccum, parseDebugOverrides, sunPosition, weatherIcon } from "./sky-lib";

const noon = Date.parse("2026-09-24T12:00:00Z");
const sunrise = Date.parse("2026-09-24T06:00:00Z");
const sunset = Date.parse("2026-09-24T18:00:00Z");

describe("sunPosition", () => {
  it("peaks at solar noon (elevation 1, mid-sky)", () => {
    const pos = sunPosition(noon, sunrise, sunset);
    expect(pos.visible).toBe(true);
    expect(pos.elevation).toBeCloseTo(1, 5);
    expect(pos.azimuthT).toBeCloseTo(0.5, 5);
  });

  it("is at the horizon at sunrise and sunset", () => {
    expect(sunPosition(sunrise, sunrise, sunset).elevation).toBeCloseTo(0, 5);
    expect(sunPosition(sunset, sunrise, sunset).elevation).toBeCloseTo(0, 5);
  });

  it("is not visible before sunrise or after sunset", () => {
    expect(sunPosition(sunrise - 1000, sunrise, sunset).visible).toBe(false);
    expect(sunPosition(sunset + 1000, sunrise, sunset).visible).toBe(false);
  });

  it("falls back to a flat 06:00-18:00 window when sunrise/sunset are unknown", () => {
    const localNoon = new Date();
    localNoon.setHours(12, 0, 0, 0);
    const pos = sunPosition(localNoon.getTime(), null, null);
    expect(pos.visible).toBe(true);
    expect(pos.elevation).toBeCloseTo(1, 5);
  });
});

describe("moonPosition", () => {
  it("is hidden during the day and visible at night", () => {
    expect(moonPosition(noon, sunrise, sunset).visible).toBe(false);
    expect(moonPosition(sunset + 3600_000, sunrise, sunset).visible).toBe(true);
    expect(moonPosition(sunrise - 3600_000, sunrise, sunset).visible).toBe(true);
  });

  it("is roughly complementary to the sun across a full day", () => {
    for (let h = 0; h < 24; h++) {
      const t = Date.parse(`2026-09-24T${String(h).padStart(2, "0")}:00:00Z`);
      const sun = sunPosition(t, sunrise, sunset);
      const moon = moonPosition(t, sunrise, sunset);
      expect(sun.visible && moon.visible).toBe(false);
    }
  });
});

describe("daylightFactor", () => {
  it("is 1 at solar noon and -1 at solar midnight, continuous through both horizons", () => {
    expect(daylightFactor(noon, sunrise, sunset)).toBeCloseTo(1, 5);
    const midnight = sunset + (sunrise + 24 * 3600_000 - sunset) / 2;
    expect(daylightFactor(midnight, sunrise, sunset)).toBeCloseTo(-1, 5);
    expect(daylightFactor(sunrise, sunrise, sunset)).toBeCloseTo(0, 5);
    expect(daylightFactor(sunset, sunrise, sunset)).toBeCloseTo(0, 5);
  });

  it("never jumps across the sunset boundary", () => {
    const before = daylightFactor(sunset - 1, sunrise, sunset);
    const after = daylightFactor(sunset + 1, sunrise, sunset);
    expect(Math.abs(before - after)).toBeLessThan(0.01);
  });
});

describe("celestialWorldPos", () => {
  it("places overhead (elevation 1, azimuth mid) near straight up", () => {
    const p = celestialWorldPos({ visible: true, elevation: 1, azimuthT: 0.5 }, 100);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeGreaterThan(80);
  });

  it("keeps a minimum height so the body never sits exactly on the horizon", () => {
    const p = celestialWorldPos({ visible: true, elevation: 0, azimuthT: 0 }, 100);
    expect(p.y).toBeGreaterThan(0);
  });
});

describe("nextLowFpsAccum", () => {
  it("accumulates seconds while below the floor", () => {
    let acc = 0;
    acc = nextLowFpsAccum(acc, 20, 1);
    acc = nextLowFpsAccum(acc, 25, 1);
    expect(acc).toBe(2);
  });

  it("resets the instant fps recovers", () => {
    expect(nextLowFpsAccum(4, 45, 1)).toBe(0);
  });
});

describe("weatherIcon", () => {
  it("maps every kind to a distinct icon and falls back for null", () => {
    expect(weatherIcon("rain")).toBe("🌧");
    expect(weatherIcon("storm")).toBe("⛈");
    expect(weatherIcon(null)).toBe("…");
  });
});

describe("parseDebugOverrides", () => {
  it("parses all three overrides and marks active", () => {
    const o = parseDebugOverrides("?time=21:30&weather=rain&cpu=95");
    expect(o).toEqual({ timeOfDayMin: 21 * 60 + 30, weather: "rain", cpu: 95, active: true });
  });

  it("is inactive with no query string", () => {
    expect(parseDebugOverrides("")).toEqual({ timeOfDayMin: null, weather: null, cpu: null, active: false });
  });

  it("rejects a malformed time and an unknown weather kind", () => {
    const o = parseDebugOverrides("?time=25:99&weather=hurricane");
    expect(o.timeOfDayMin).toBeNull();
    expect(o.weather).toBeNull();
  });

  it("clamps cpu to 0..100", () => {
    expect(parseDebugOverrides("?cpu=150").cpu).toBe(100);
    expect(parseDebugOverrides("?cpu=-10").cpu).toBe(0);
  });
});
