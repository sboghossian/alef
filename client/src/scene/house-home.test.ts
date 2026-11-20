import { describe, expect, it } from "vitest";
import { carCity, planeHome } from "./house-home";

const moved = new Map([["m", "lot:/daily-recap"]]);

describe("carCity", () => {
  it("gives a live agent whose house never moved a car on its home city's ring", () => {
    expect(carCity({ id: "a", status: "live" }, false, moved, "home")).toBe("home");
  });

  it("parks the car of a moved house, so its creature and marker stay at the lot", () => {
    expect(carCity({ id: "m", status: "live" }, false, moved, "home")).toBeNull();
  });

  it("gives no car to a dormant or flying agent, or one without a laid-out home", () => {
    expect(carCity({ id: "a", status: "dormant" }, false, moved, "home")).toBeNull();
    expect(carCity({ id: "a", status: "live" }, true, moved, "home")).toBeNull();
    expect(carCity({ id: "a", status: "live" }, false, moved, undefined)).toBeNull();
  });
});

describe("planeHome", () => {
  it("flies a moved agent from and back to its lot, everyone else from their home city", () => {
    expect(planeHome("m", moved, "home")).toBe("lot:/daily-recap");
    expect(planeHome("a", moved, "home")).toBe("home");
    expect(planeHome("a", moved, undefined)).toBeUndefined();
  });
});
