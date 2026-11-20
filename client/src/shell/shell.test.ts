import { describe, expect, it } from "vitest";
import { titleFor } from "../features/waiting-lib";
import { badgeCount, railTabName } from "./shell";

describe("badgeCount", () => {
  it("adds waiting and stranded counts — both need Alex's attention", () => {
    expect(badgeCount(0, 2)).toBe(2);
    expect(badgeCount(3, 0)).toBe(3);
    expect(badgeCount(1, 1)).toBe(2);
    expect(badgeCount(0, 0)).toBe(0);
  });

  it("feeds titleFor to produce the tab-title prefix — waiting 0 + stranded 2 reads '(2) Alef'", () => {
    expect(titleFor("Alef", badgeCount(0, 2))).toBe("(2) Alef");
  });
});

describe("railTabName (A11Y-8)", () => {
  it("names the count instead of running it into the label", () => {
    expect(railTabName("loops", "12")).toBe("Loops, 12 open");
    expect(railTabName("activity", "99+")).toBe("Activity, 99+ new");
  });

  it("is the bare label while the badge is hidden or zero", () => {
    expect(railTabName("loops", null)).toBe("Loops");
    expect(railTabName("loops", "0")).toBe("Loops");
    expect(railTabName("controls", "")).toBe("Controls");
  });
});
