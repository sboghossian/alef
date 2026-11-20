import { describe, expect, it } from "vitest";
import type { VillageMessage } from "../../../shared/features/village";
import {
  bridgeControlPoints,
  clampOrbit,
  droneOffsets,
  feedItems,
  fitDistance,
  messageBridges,
  messageFeedItems,
  orbitPosition,
  ORBIT_BASE,
  ORBIT_LIMITS,
  redactMessage,
  repoBridges,
  residentSlot,
  ringRadius,
  sceneRadius,
  subagentFeedItems,
  villageSlots,
  type SubagentSpawnFact,
} from "./village-lib";

function msg(over: Partial<VillageMessage> = {}): VillageMessage {
  return {
    id: "m1",
    at: "2026-09-26T10:00:00.000Z",
    direction: "sent",
    fromSessionId: "s1",
    fromRaw: "s1",
    toSessionId: "s2",
    toRaw: "s2",
    preview: "hi there",
    ...over,
  };
}

describe("villageSlots", () => {
  it("is empty for no agents", () => {
    expect(villageSlots([])).toEqual([]);
  });
  it("places one agent at a fixed point", () => {
    const [slot] = villageSlots(["a"]);
    expect(slot?.agentId).toBe("a");
    expect(Number.isFinite(slot?.gx)).toBe(true);
  });
  it("spaces rooms evenly around the ring and faces each at the plaza", () => {
    const slots = villageSlots(["a", "b", "c", "d"]);
    expect(slots).toHaveLength(4);
    const r = ringRadius(4);
    for (const s of slots) {
      expect(Math.hypot(s.gx, s.gz)).toBeCloseTo(r, 5);
      // facing the origin: a unit vector along `facing` from (gx,gz) should point back through 0.
      const toCenter = Math.atan2(-s.gx, -s.gz);
      expect(s.facing).toBeCloseTo(toCenter, 5);
    }
  });
  it("is deterministic for the same ids in the same order", () => {
    expect(villageSlots(["a", "b", "c"])).toEqual(villageSlots(["a", "b", "c"]));
  });
});

describe("ringRadius", () => {
  it("grows with the room count and never drops below the minimum", () => {
    expect(ringRadius(1)).toBeGreaterThan(0);
    expect(ringRadius(9)).toBeGreaterThan(ringRadius(2));
  });
});

describe("residentSlot", () => {
  it("sits further out than the agents' ring, at the top", () => {
    const agents = ringRadius(4);
    const r = residentSlot(4);
    expect(Math.hypot(r.gx, r.gz)).toBeGreaterThan(agents);
    expect(r.gx).toBeCloseTo(0, 5);
    expect(r.gz).toBeLessThan(0); // "top" = -z, matching villageSlots' start point
  });
});

describe("sceneRadius", () => {
  it("grows with the room count", () => {
    expect(sceneRadius(9, false)).toBeGreaterThan(sceneRadius(1, false));
  });
  it("is at least as large as the resident's own distance from the plaza, when shown", () => {
    const withResident = sceneRadius(4, true);
    const without = sceneRadius(4, false);
    const residentDist = Math.hypot(residentSlot(4).gx, residentSlot(4).gz);
    expect(withResident).toBeGreaterThanOrEqual(residentDist);
    expect(withResident).toBeGreaterThan(without);
  });
  it("still covers just the plaza when nothing is shown", () => {
    expect(sceneRadius(0, false)).toBeGreaterThan(0);
  });
});

describe("fitDistance", () => {
  it("grows with the radius it needs to frame", () => {
    const near = fitDistance(5, (40 * Math.PI) / 180);
    const far = fitDistance(20, (40 * Math.PI) / 180);
    expect(far).toBeGreaterThan(near);
  });
  it("grows with elevation (steeper top-down needs more distance to fit the same footprint)", () => {
    const low = fitDistance(10, (25 * Math.PI) / 180);
    const high = fitDistance(10, (55 * Math.PI) / 180);
    expect(high).toBeGreaterThan(low);
  });
  it("comfortably covers the worst realistic case (9 rooms + the resident, at max elevation) within ORBIT_LIMITS.distMax", () => {
    const radius = sceneRadius(9, true);
    const d = fitDistance(radius, ORBIT_LIMITS.elevMax);
    expect(d).toBeLessThanOrEqual(ORBIT_LIMITS.distMax);
  });
  it("a single room's fit distance is comfortably above distMin (there's room to zoom in further)", () => {
    const d = fitDistance(sceneRadius(1, false), ORBIT_BASE.elevation);
    expect(d).toBeGreaterThan(ORBIT_LIMITS.distMin);
  });
});

describe("repoBridges", () => {
  it("chains agents sharing an island in the caller's order, instead of a dense clique", () => {
    const agents = [
      { id: "c", islandId: "repo-x" },
      { id: "a", islandId: "repo-x" },
      { id: "b", islandId: "repo-x" },
      { id: "z", islandId: "repo-y" },
    ];
    const bridges = repoBridges(agents);
    // Caller order preserved (not re-sorted by id): c,a,b are ring-adjacent, so the rope follows
    // the ring instead of cutting a chord across it.
    expect(bridges).toEqual([
      { a: "c", b: "a", kind: "repo" },
      { a: "a", b: "b", kind: "repo" },
    ]);
  });
  it("draws nothing for a lone agent in its own repo", () => {
    expect(repoBridges([{ id: "a", islandId: "solo" }])).toEqual([]);
  });
});

describe("messageBridges", () => {
  it("only bridges when both ends resolve and are on stage", () => {
    const shown = new Set(["s1", "s2", "s3"]);
    const messages = [
      { fromSessionId: "s1", toSessionId: "s2" },
      { fromSessionId: "s1", toSessionId: null }, // unresolved: no bridge
      { fromSessionId: "s1", toSessionId: "s9" }, // resolved but off-stage: no bridge
      { fromSessionId: "s2", toSessionId: "s1" }, // same pair, reverse direction: de-duped
      { fromSessionId: "s1", toSessionId: "s1" }, // self: ignored
    ];
    expect(messageBridges(messages, shown)).toEqual([{ a: "s1", b: "s2", kind: "message" }]);
  });
});

describe("bridgeControlPoints", () => {
  it("sags in the middle, between the two endpoints", () => {
    const pts = bridgeControlPoints(0, 0, 10, 0);
    expect(pts).toHaveLength(3);
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
    expect(pts[1]!.y).toBeLessThan(pts[2]!.y);
    expect(pts[1]!.x).toBeCloseTo(5, 5);
  });
  it("insets both endpoints toward each other, off the room centres, symmetrically", () => {
    const pts = bridgeControlPoints(0, 0, 10, 0);
    // Pulled inward (not sitting exactly on the raw centres)...
    expect(pts[0]!.x).toBeGreaterThan(0);
    expect(pts[2]!.x).toBeLessThan(10);
    // ...but the midpoint is unaffected, since both insets are equal and toward each other.
    expect(pts[1]!.x).toBeCloseTo(5, 5);
  });
  it("clamps the inset so two very close rooms never invert past each other", () => {
    const pts = bridgeControlPoints(0, 0, 1, 0); // far closer together than the default inset
    expect(pts[0]!.x).toBeLessThan(pts[2]!.x); // start stays left of end
    expect(pts[0]!.x).toBeCloseTo(0.4, 5); // 40% of the 1-unit gap, from each side
    expect(pts[2]!.x).toBeCloseTo(0.6, 5);
  });
});

describe("droneOffsets", () => {
  it("caps at max and spreads evenly", () => {
    expect(droneOffsets(2)).toHaveLength(2);
    expect(droneOffsets(9)).toHaveLength(4);
    expect(droneOffsets(0)).toHaveLength(0);
  });
});

describe("orbit camera", () => {
  it("clamps azimuth within the span of the isometric base angle", () => {
    const s = clampOrbit({ azimuth: ORBIT_BASE.azimuth + 10, elevation: ORBIT_BASE.elevation, distance: ORBIT_BASE.distance });
    expect(s.azimuth).toBeCloseTo(ORBIT_BASE.azimuth + ORBIT_LIMITS.azimuthSpan, 5);
  });
  it("clamps elevation and distance to their own ranges", () => {
    const s = clampOrbit({ azimuth: ORBIT_BASE.azimuth, elevation: -5, distance: 1000 });
    expect(s.elevation).toBeCloseTo(ORBIT_LIMITS.elevMin, 5);
    expect(s.distance).toBeCloseTo(ORBIT_LIMITS.distMax, 5);
  });
  it("converts to a position at the expected distance from the origin", () => {
    const p = orbitPosition(ORBIT_BASE);
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(ORBIT_BASE.distance, 5);
  });
});

describe("redactMessage", () => {
  it("strips the preview and turns raw names into anonymous labels", () => {
    const r = redactMessage(msg());
    expect(r.preview).toBe("…");
    expect(r.fromRaw).toBe("agent s1"); // "agent " + first 4 chars of the (2-char) session id
    expect(r.toRaw).toBe("agent s2");
  });
  it("falls back to 'someone' when a side never resolved", () => {
    const r = redactMessage(msg({ fromSessionId: null, toSessionId: null }));
    expect(r.fromRaw).toBe("someone");
    expect(r.toRaw).toBe("someone");
  });
});

describe("messageFeedItems / subagentFeedItems / feedItems", () => {
  it("renders a message as from → to: preview", () => {
    const [item] = messageFeedItems([msg()]);
    expect(item?.text).toBe("s1 → s2: hi there");
    expect(item?.kind).toBe("message");
  });
  it("emits a spawn item, and a hand-back item only once the subagent finished", () => {
    const running: SubagentSpawnFact = { id: "sa1", description: "fix tests", status: "running", startedAt: "2026-09-26T09:00:00.000Z", lastActive: "2026-09-26T09:05:00.000Z" };
    const done: SubagentSpawnFact = { id: "sa2", description: "write docs", status: "done", startedAt: "2026-09-26T08:00:00.000Z", lastActive: "2026-09-26T08:10:00.000Z" };
    const items = subagentFeedItems([running, done]);
    expect(items.map((i) => i.kind)).toEqual(["spawn", "spawn", "handback"]);
    expect(items.find((i) => i.id === "sa2:done")?.text).toBe("handed back: write docs");
  });
  it("merges messages and subagent events, newest first, capped", () => {
    const older = msg({ id: "old", at: "2026-09-26T08:00:00.000Z" });
    const newer = msg({ id: "new", at: "2026-09-26T11:00:00.000Z" });
    const sub: SubagentSpawnFact = { id: "sa1", description: "x", status: "running", startedAt: "2026-09-26T09:00:00.000Z", lastActive: "2026-09-26T09:00:00.000Z" };
    const items = feedItems([older, newer], [sub], 2);
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("new");
  });
});
