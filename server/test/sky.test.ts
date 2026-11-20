import { describe, expect, it } from "vitest";
import { parseOpenMeteoResponse } from "../features/sky.js";
import { parseBatteryPmsetOutput, parseCpuPsOutput, weatherKindFromCode } from "../features/sky-lib.js";

describe("parseCpuPsOutput", () => {
  it("sums %CPU across processes and divides by core count, clamped 0..100", () => {
    const stdout = "%CPU\n 10.0\n 5.5\n 0.0\n";
    expect(parseCpuPsOutput(stdout, 2)).toBe(8); // (10+5.5+0)/2 = 7.75 -> round 8
  });

  it("clamps to 100 when the sum exceeds it (many busy cores)", () => {
    const stdout = "%CPU\n 500\n";
    expect(parseCpuPsOutput(stdout, 1)).toBe(100);
  });

  it("treats a header-only / empty table as 0%", () => {
    expect(parseCpuPsOutput("%CPU\n", 4)).toBe(0);
  });

  it("never divides by zero cores", () => {
    expect(parseCpuPsOutput("%CPU\n 50\n", 0)).toBe(50);
  });
});

describe("parseBatteryPmsetOutput", () => {
  it("reads percent and charging from AC power output", () => {
    const stdout = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t87%; charging; 0:20 remaining present: true`;
    expect(parseBatteryPmsetOutput(stdout)).toEqual({ percent: 87, charging: true });
  });

  it("reads percent and not-charging from battery power output", () => {
    const stdout = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t42%; discharging; 3:10 remaining present: true`;
    expect(parseBatteryPmsetOutput(stdout)).toEqual({ percent: 42, charging: false });
  });

  it("returns null percent when unparsable (e.g. desktop Mac with no battery)", () => {
    expect(parseBatteryPmsetOutput("")).toEqual({ percent: null, charging: false });
  });
});

describe("weatherKindFromCode", () => {
  it("maps clear sky", () => {
    expect(weatherKindFromCode(0)).toBe("clear");
  });
  it("maps partly/mostly cloudy", () => {
    expect(weatherKindFromCode(1)).toBe("cloudy");
    expect(weatherKindFromCode(3)).toBe("cloudy");
  });
  it("maps fog", () => {
    expect(weatherKindFromCode(45)).toBe("fog");
    expect(weatherKindFromCode(48)).toBe("fog");
  });
  it("maps drizzle/rain/showers", () => {
    expect(weatherKindFromCode(51)).toBe("rain");
    expect(weatherKindFromCode(63)).toBe("rain");
    expect(weatherKindFromCode(67)).toBe("rain");
    expect(weatherKindFromCode(80)).toBe("rain");
  });
  it("maps snow", () => {
    expect(weatherKindFromCode(71)).toBe("snow");
    expect(weatherKindFromCode(86)).toBe("snow");
  });
  it("maps thunderstorm + hail to storm", () => {
    expect(weatherKindFromCode(95)).toBe("storm");
    expect(weatherKindFromCode(99)).toBe("storm");
  });
  it("falls back to cloudy for an unknown code", () => {
    expect(weatherKindFromCode(9999)).toBe("cloudy");
  });
});

describe("parseOpenMeteoResponse", () => {
  it("parses a well-formed current+daily response", () => {
    const body = {
      current: { temperature_2m: 27.4, weather_code: 0, cloud_cover: 10, precipitation: 0, wind_speed_10m: 8.2, is_day: 1 },
      daily: { sunrise: ["2026-09-24T06:12"], sunset: ["2026-09-24T18:45"] },
    };
    const out = parseOpenMeteoResponse(body, "2026-09-24T12:00:00.000Z");
    expect(out).toEqual({
      online: true,
      fetchedAt: "2026-09-24T12:00:00.000Z",
      temperatureC: 27.4,
      weatherCode: 0,
      kind: "clear",
      cloudCover: 10,
      precipitationMm: 0,
      windSpeedKph: 8.2,
      isDay: true,
      sunrise: "2026-09-24T06:12",
      sunset: "2026-09-24T18:45",
    });
  });

  it("returns null when the body has no current block", () => {
    expect(parseOpenMeteoResponse({}, "x")).toBeNull();
    expect(parseOpenMeteoResponse(null, "x")).toBeNull();
    expect(parseOpenMeteoResponse("nope", "x")).toBeNull();
  });

  it("tolerates a missing daily block", () => {
    const body = { current: { temperature_2m: 15, weather_code: 61 } };
    const out = parseOpenMeteoResponse(body, "x");
    expect(out?.sunrise).toBeNull();
    expect(out?.sunset).toBeNull();
    expect(out?.kind).toBe("rain");
  });
});

describe("parseMemoryPressureOutput", () => {
  it("turns the free percentage into used %", async () => {
    const { parseMemoryPressureOutput } = await import("../features/sky-lib.js");
    expect(parseMemoryPressureOutput("The system has 25769803776 (1572864 pages)\nSystem-wide memory free percentage: 32%\n")).toBe(68);
    expect(parseMemoryPressureOutput("garbage")).toBeNull();
  });
});
