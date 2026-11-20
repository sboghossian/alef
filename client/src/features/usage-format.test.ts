import { describe, expect, it } from "vitest";
import { formatHours, formatUsd, statusChipText, unpricedNote } from "./usage-format";

describe("formatUsd", () => {
  it("always carries the ≈ prefix — this is an estimate, never a bill", () => {
    expect(formatUsd(0)).toBe("≈$0.00");
    expect(formatUsd(1.2345)).toBe("≈$1.23");
    expect(formatUsd(142)).toBe("≈$142.00");
  });

  it("never shows a negative number", () => {
    expect(formatUsd(-5)).toBe("≈$0.00");
  });
});

describe("formatHours", () => {
  it("rounds to one decimal below 10h and to whole hours at/above it", () => {
    expect(formatHours(0)).toBe("0h");
    expect(formatHours(90 * 60_000)).toBe("1.5h"); // 90 min
    expect(formatHours(10 * 3_600_000)).toBe("10h");
    expect(formatHours(12.4 * 3_600_000)).toBe("12h");
  });
});

describe("statusChipText", () => {
  it("matches the spec's exact status-bar format", () => {
    expect(statusChipText(4.2, 5 * 3_600_000)).toBe("≈$4.20 today · 5h");
  });
});

describe("unpricedNote", () => {
  it("pluralizes correctly and formats large counts with separators", () => {
    expect(unpricedNote(0)).toBe("0 unpriced tokens");
    expect(unpricedNote(1)).toBe("1 unpriced token");
    expect(unpricedNote(12_000)).toBe("12,000 unpriced tokens");
  });
});
