// PR #56 review: with WebGL off (or its context lost) the Inbox row did nothing on Orbit, District
// and Courier. diveToRoom saw a planet view and a house (the scene graph is built even in 2D-only
// mode), started a swoop and parked the Room, and only a DRAWING frame of the render loop ever
// lands a parked Room. A context lost mid-swoop parked it until a restore, which then pulled the
// user into the Room seconds or minutes later. These drive the exact route decision and landing
// object main.ts uses, with the real view definitions and the real lost-context watcher.

import { describe, expect, it } from "vitest";
import { boardView } from "../views/board";
import { courierView } from "../views/courier";
import { districtView } from "../views/district";
import { orbitView } from "../views/orbit";
import { roomView } from "../views/room";
import { createDiveLanding, diveDue, diveRoute } from "./dive";
import { watchGlContext } from "./webgl";

const planetViews = [orbitView, districtView, courierView];
const drawn = { hasHouse: true, reducedMotion: false, drawing: true };

describe("diveRoute", () => {
  it("swoops on a drawing planet view with a house (unchanged when WebGL works)", () => {
    for (const view of planetViews) expect(diveRoute({ ...drawn, view }), view.id).toBe("swoop");
  });

  it("opens the Room directly on every planet view when 3D is not drawing, although the house exists", () => {
    for (const view of planetViews) expect(diveRoute({ ...drawn, view, drawing: false }), view.id).toBe("direct");
  });

  it("follows the real lost-context watcher: direct while lost, swoop again once restored", () => {
    const canvas = new EventTarget();
    const watch = watchGlContext(canvas, { lost: () => {}, restored: () => {} });
    const route = (): string => diveRoute({ ...drawn, view: orbitView, drawing: !watch.isLost() });
    expect(route()).toBe("swoop");
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(route()).toBe("direct");
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(route()).toBe("swoop");
    watch.dispose();
  });

  it("keeps the other direct cases: a non-planet view, the Room covering the planet, reduced motion, no house, no shell", () => {
    expect(diveRoute({ ...drawn, view: boardView })).toBe("direct");
    expect(roomView.usesPlanet && roomView.coversPlanet).toBe(true);
    expect(diveRoute({ ...drawn, view: roomView })).toBe("direct");
    expect(diveRoute({ ...drawn, view: orbitView, reducedMotion: true })).toBe("direct");
    expect(diveRoute({ ...drawn, view: orbitView, hasHouse: false })).toBe("direct");
    expect(diveRoute({ ...drawn, view: null })).toBe("direct");
  });
});

describe("diveDue", () => {
  it("lands at the swoop's landing time while drawing", () => {
    expect(diveDue(1.15, 1.0, true)).toBe(false);
    expect(diveDue(1.15, 1.15, true)).toBe(true);
  });

  it("is due at once when 3D stops drawing mid-swoop", () => {
    expect(diveDue(1.15, 0.2, false)).toBe(true);
  });
});

describe("createDiveLanding across a lost and restored context (the render loop's calls)", () => {
  it("opens the parked Room on the first frame after the loss, and nothing on restore", () => {
    const landing = createDiveLanding();
    landing.park("agent-1", 1.15);
    expect(landing.take(0.1, true)).toBeNull(); // swooping
    // webglcontextlost at ~0.15 s: the next frames are not drawing.
    expect(landing.take(0.2, false)).toBe("agent-1");
    expect(landing.take(0.3, false)).toBeNull();
    // The browser restores the context 30 s later: no stale dive pulls the user back in.
    expect(landing.take(30, true)).toBeNull();
  });

  it("opens once, at landing, when the context stays up", () => {
    const landing = createDiveLanding();
    landing.park("agent-1", 1.15);
    expect(landing.take(1.0, true)).toBeNull();
    expect(landing.take(1.2, true)).toBe("agent-1");
    expect(landing.take(1.3, true)).toBeNull();
  });

  it("a second click re-parks for the newer agent only", () => {
    const landing = createDiveLanding();
    landing.park("agent-1", 1.15);
    landing.park("agent-2", 1.5);
    expect(landing.take(1.2, true)).toBeNull();
    expect(landing.take(1.5, true)).toBe("agent-2");
    expect(landing.take(2, true)).toBeNull();
  });
});
