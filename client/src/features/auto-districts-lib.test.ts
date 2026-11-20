import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ArchivePlace } from "../../../shared/features/archive";
import type { RunEnding, SubagentRecord } from "../../../shared/features/subagents";
import type { TopicsMap } from "../../../shared/features/topics";
import type { Island, WorldAgent } from "../../../shared/types";
import { CITY_SURFACE, lotLocal, type CityLayout } from "../layout";
import { computeTopicLayout, projectLocal, toLocal, tangentBasis } from "../topic-layout";
import { hash32 } from "./archive-lib";
import {
  AUTO_GROUP,
  AUTO_LOTS_GROUP,
  BORDER_MARGIN,
  LOT_GAP,
  LOT_LIVE_MARGIN,
  OTHER_AUTOMATIONS,
  addLiveToLot,
  archivedFieldLocal,
  autoLotRows,
  clusterAutomations,
  computeAutoDistricts,
  continentObstacles,
  isAutoHomeSession,
  lotHasRoom,
  lotRunNotes,
  lotShape,
  orderLotRows,
  placeLots,
  planNewAutoLot,
  reservedRadius,
  slotDir,
  type AutoDistricts,
  type AutoItem,
  type AutoLot,
} from "./auto-districts-lib";

const RECAP = "You are the narrative step of Alex's /daily-recap. A deterministic script…";
const UPSKILL = "You are the autonomous authoring step of Alex's `/upskill` loop.";
const rss = '<scheduled-task name="rss-feed-obsidian" file="x">';
const EVAL = "History: Task: Review this SaaS Master...";

function items(prefix: string, title: string, n: number): AutoItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, "0")}`, title }));
}

describe("clusterAutomations", () => {
  it("clusters live and archived sessions by automation, biggest first, Other last", () => {
    const out = clusterAutomations(
      [...items("l-recap", RECAP, 4), ...items("l-up", UPSKILL, 3), ...items("l-misc", "fix the bug", 1)],
      [...items("a-recap", RECAP, 5), ...items("a-rss", rss, 3), ...items("a-eval", EVAL, 2)],
    );
    expect(out.map((c) => [c.key, c.live.length, c.archived.length])).toEqual([
      ["/daily-recap", 4, 5],
      ["/upskill", 3, 0],
      ["⏰ rss-feed-obsidian", 0, 3],
      [OTHER_AUTOMATIONS, 1, 2], // "fix the bug" (no key) + eval-harness (2 < 3)
    ]);
  });

  it("folds a cluster under the minimum into Other, and keeps one of exactly the minimum", () => {
    const out = clusterAutomations([], [...items("a", RECAP, 3), ...items("b", EVAL, 2)]);
    expect(out.map((c) => c.key)).toEqual(["/daily-recap", OTHER_AUTOMATIONS]);
    expect(out[1]!.archived).toHaveLength(2);
  });

  it("caps the sub-districts (Other included); the smallest fold into Other", () => {
    const archived: AutoItem[] = [];
    for (let k = 0; k < 15; k++) archived.push(...items(`t${k}`, `<scheduled-task name="task-${String(k).padStart(2, "0")}">`, 3 + k));
    const out = clusterAutomations([], archived, 3, 12);
    expect(out).toHaveLength(12);
    expect(out[11]!.key).toBe(OTHER_AUTOMATIONS);
    // Kept: the 11 biggest (task-14 … task-04); folded: task-00 … task-03 (3+4+5+6 = 18 sessions).
    expect(out[0]!.key).toBe("⏰ task-14");
    expect(out[10]!.key).toBe("⏰ task-04");
    expect(out[11]!.archived).toHaveLength(18);
    // No Other when nothing needs folding.
    expect(clusterAutomations([], items("a", RECAP, 4)).map((c) => c.key)).toEqual(["/daily-recap"]);
    expect(clusterAutomations([], [])).toEqual([]);
  });

  it("is deterministic: input order never changes the output, ties sort by key", () => {
    const a = [...items("x", rss, 3), ...items("y", UPSKILL, 3), ...items("z", RECAP, 3)];
    const one = clusterAutomations([], a);
    const two = clusterAutomations([], [...a].reverse());
    expect(two).toEqual(one);
    expect(one.map((c) => c.key)).toEqual(["/daily-recap", "/upskill", "⏰ rss-feed-obsidian"]);
  });
});

describe("placeLots", () => {
  it("keeps every lot inside the border and clear of obstacles and each other", () => {
    const obstacles = [
      { x: 0, z: 0, r: 8 },
      { x: 14, z: 3, r: 5 },
    ];
    const lots = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, r: 1.2 + (i % 4) }));
    const { pos, crowded } = placeLots(30, obstacles, lots);
    expect(crowded).toEqual([]);
    const placed = [...pos.values()];
    for (const p of placed) {
      expect(Math.hypot(p.x, p.z) + p.r).toBeLessThanOrEqual(30 - BORDER_MARGIN + 1e-9);
      for (const o of obstacles) expect(Math.hypot(p.x - o.x, p.z - o.z) - p.r - o.r).toBeGreaterThanOrEqual(LOT_GAP - 1e-9);
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(Math.hypot(placed[i]!.x - placed[j]!.x, placed[i]!.z - placed[j]!.z) - placed[i]!.r - placed[j]!.r).toBeGreaterThanOrEqual(LOT_GAP - 1e-9);
  });

  it("settles for the roomiest spot when no spot has the full gap, without calling that crowded", () => {
    // extent 11: a lot of r 3 reserves 3.66 and must sit within 6.74 of the centre, which leaves
    // ~0.18 of clearance from the obstacle at best.
    const { pos, crowded } = placeLots(11, [{ x: 0, z: 0, r: 2.9 }], [{ key: "tight", r: 3 }]);
    expect(crowded).toEqual([]);
    const p = pos.get("tight")!;
    expect(p.r).toBe(3); // the real radius comes back, the reservation stays internal
    const clear = Math.hypot(p.x, p.z) - 2.9 - reservedRadius(3);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(LOT_GAP);
  });

  it("never leaves the continent when it is full: the lot is crowded instead", () => {
    const { pos, crowded } = placeLots(6, [{ x: 0, z: 0, r: 5.5 }], [{ key: "big", r: 2 }]);
    expect(crowded).toEqual(["big"]);
    const p = pos.get("big")!;
    expect(Math.hypot(p.x, p.z) + p.r).toBeLessThanOrEqual(6 - BORDER_MARGIN + 1e-9);
  });

  it("is deterministic regardless of input order", () => {
    const lots = [
      { key: "a", r: 2 },
      { key: "b", r: 2 },
      { key: "c", r: 3 },
    ];
    expect([...placeLots(20, [], lots).pos.entries()].sort()).toEqual([...placeLots(20, [], [...lots].reverse()).pos.entries()].sort());
  });
});

describe("reservedRadius", () => {
  it("steps by ×1.25 from 1.5 and always covers the real radius", () => {
    expect(reservedRadius(1)).toBe(1.5);
    expect(reservedRadius(1.5)).toBe(1.5);
    expect(reservedRadius(1.6)).toBeCloseTo(1.875, 12);
    for (const r of [0.5, 2, 3.3, 7.02, 12]) expect(reservedRadius(r)).toBeGreaterThanOrEqual(r);
  });
});

describe("archivedFieldLocal", () => {
  it("matches the archive feature's original field formula", () => {
    for (const key of ["archived:gstack", "archived:acme-www", "archived:x"]) {
      const az = (hash32(key) / 0x1_0000_0000) * Math.PI * 2;
      const d = 0.6 * 0.78 * CITY_SURFACE;
      const [x, z] = archivedFieldLocal(key, 0.6, CITY_SURFACE);
      expect(x).toBeCloseTo(Math.cos(az) * d, 12);
      expect(z).toBeCloseTo(Math.sin(az) * d, 12);
    }
  });
});

describe("toLocal", () => {
  it("inverts projectLocal", () => {
    const c = new THREE.Vector3(0.3, 0.5, 0.8).normalize();
    const [t1, t2] = tangentBasis(c);
    for (const [x, z] of [[3, 4], [-10, 2], [0.5, -7]] as const) {
      const [bx, bz] = toLocal(c, t1, t2, projectLocal(c, t1, t2, x, z));
      expect(bx).toBeCloseTo(x, 6);
      expect(bz).toBeCloseTo(z, 6);
    }
  });
});

// ── the whole thing on a realistic world ────────────────────────────────────────────────────

const KEYS = ["AUTO", "WEB", "SETUP", "GTM", "PERSONAL", "RESEARCH", "TEAM", "CONTENT", "PROD", "OTHER"];

function island(id: string, path: string, day: number): Island {
  return { id, name: id, path, agentCount: 0, lastActive: new Date(Date.UTC(2026, 8, day)).toISOString() };
}

function world() {
  const islands: Island[] = [island("home", "/Users/me", 26), island("root", "/", 25), island("harness", "", 1)];
  const lots = new Map<string, number>([["home", 90], ["root", 28], ["harness", 122]]);
  const topicIslands: Record<string, string> = { home: "AUTO", root: "AUTO", harness: "SETUP" };
  for (let i = 0; i < 40; i++) {
    const id = `repo-${String(i).padStart(2, "0")}`;
    islands.push(island(id, `/Users/me/Code/${id}`, 1 + (i % 24)));
    lots.set(id, [52, 36, 30, 20, 18, 18, 15, 12, 9, 6, 6, 5, 3][i] ?? 1 + (i % 3));
    topicIslands[id] = KEYS[i % KEYS.length]!;
  }
  const agents: (Pick<WorldAgent, "id" | "islandId" | "lastActive"> & { title: string })[] = [];
  const sessions: TopicsMap["sessions"] = {};
  const titles = [RECAP, RECAP, RECAP, UPSKILL, "inbox-sweep /inbox-sweep — headless run", "fix the thing"];
  for (let i = 0; i < 120; i++) {
    const id = `s${String(i).padStart(3, "0")}`;
    const auto = i % 3 === 0;
    agents.push({ id, islandId: i % 5 === 0 ? "root" : "home", lastActive: "2026-09-26T00:00:00Z", title: auto ? titles[(i / 3) % titles.length]! : "a normal session" });
    sessions[id] = { group: auto ? "AUTO" : KEYS[1 + (i % 9)]!, source: "rule" };
  }
  const groups = KEYS.map((key, i) => ({ key, name: key, hint: "", color: "#112233", sessions: 60 - i * 5, cities: 4 }));
  const topics: TopicsMap = { generatedAt: "", groups, sessions, islands: topicIslands, catchAll: ["home", "root"], pendingJev: 0, jev: "online" };
  const places: ArchivePlace[] = [
    { key: "topic:AUTO", kind: "topic", ref: "AUTO", group: "AUTO", count: 150 },
    { key: "island:home", kind: "island", ref: "home", group: "", count: 20 },
    { key: "archived:gstack", kind: "archived", ref: "gstack", group: "AUTO", count: 28 },
    { key: "archived:acme-www", kind: "archived", ref: "acme-www", group: "AUTO", count: 12 },
    { key: "archived:crucible", kind: "archived", ref: "crucible", group: "RESEARCH", count: 4 },
  ];
  const fossils: AutoItem[] = [
    ...items("f-recap", RECAP, 47),
    ...items("f-eval", EVAL, 60),
    ...items("f-rss", rss, 20),
    ...items("f-scan", '<scheduled-task name="acme-inbox-scan">', 13),
    ...items("f-one", '<scheduled-task name="one-off">', 1),
    ...items("f-misc", "Weekly Wiki Lint Report", 9),
  ];
  return { islands, lots, topics, agents, places, fossils };
}

/** Every layout entry as plain numbers, for a snapshot comparison. */
function snapshot(t: ReturnType<typeof computeTopicLayout>): unknown {
  return {
    layout: [...t.layout.entries()].map(([id, c]) => [id, c.dir.toArray(), c.t1.toArray(), c.t2.toArray(), c.radius, c.lots, c.rank]),
    continents: t.continents.map((c) => [c.key, c.dir.toArray(), c.angle, c.units]),
  };
}

describe("computeAutoDistricts on a realistic world", () => {
  const w = world();
  const t = computeTopicLayout(w.islands, w.lots, w.topics, w.agents);
  const before = snapshot(t);
  const auto = t.continents.find((c) => c.key === "AUTO")!;
  const live = w.agents.filter((a) => w.topics.sessions[a.id]?.group === "AUTO").map((a) => ({ id: a.id, title: a.title }));
  const input = {
    continent: auto,
    continentKeys: t.continents.map((c) => c.key),
    layout: t.layout,
    places: w.places,
    live,
    fossils: w.fossils,
    surface: CITY_SURFACE,
  };
  const d = computeAutoDistricts(input);

  it("moves nothing that was already laid out: every city, neighbourhood and continent is exactly where the layout put it", () => {
    expect(snapshot(t)).toEqual(before);
    expect(snapshot(computeTopicLayout(w.islands, w.lots, w.topics, w.agents))).toEqual(before);
  });

  it("gives every AUTO home-folder session exactly one slot, and nothing else a slot", () => {
    expect(d.slots.size).toBe(live.length + w.fossils.length);
    for (const it of [...live, ...w.fossils]) expect(d.slots.has(it.id)).toBe(true);
    expect(d.lots.map((l) => [l.key, l.live.length, l.archived.length])).toEqual([
      ["/daily-recap", 21, 47],
      ["eval-harness", 0, 60],
      ["⏰ rss-feed-obsidian", 0, 20],
      ["⏰ acme-inbox-scan", 0, 13],
      ["/upskill", 7, 0],
      ["/inbox-sweep", 6, 0],
      [OTHER_AUTOMATIONS, 6, 10], // "fix the thing" + the wiki reports + the one-off task
    ]);
  });

  it("keeps every AUTO item inside the continent's border", () => {
    expect(d.crowded).toEqual([]);
    for (const lot of d.lots) {
      for (const id of [...lot.live, ...lot.archived]) {
        const s = d.slots.get(id)!;
        expect(slotDir(lot, s.x, s.z).angleTo(auto.dir)).toBeLessThan(auto.angle);
      }
    }
  });

  it("keeps lots clear of the continent's cities, fossil fields and each other", () => {
    const obstacles = continentObstacles(input);
    for (const lot of d.lots) {
      for (const o of obstacles) expect(Math.hypot(lot.x - o.x, lot.z - o.z) - lot.r - o.r).toBeGreaterThanOrEqual(0);
      for (const other of d.lots) if (other !== lot) expect(Math.hypot(lot.x - other.x, lot.z - other.z) - lot.r - other.r).toBeGreaterThanOrEqual(0);
    }
  });

  it("lands the same key in the same place on every reload", () => {
    const again = computeAutoDistricts({ ...input, live: [...live].reverse(), fossils: [...w.fossils].reverse() });
    expect(again.lots.map((l) => [l.key, l.x, l.z, l.r])).toEqual(d.lots.map((l) => [l.key, l.x, l.z, l.r]));
    expect([...again.slots.entries()].sort()).toEqual([...d.slots.entries()].sort());
  });

  it("doesn't move any lot when one cluster's count changes", () => {
    for (const extra of [1, 3]) {
      const more = [...w.fossils, ...items("f-eval-new", EVAL, extra)];
      const again = computeAutoDistricts({ ...input, fossils: more });
      expect(again.lots.map((l) => [l.key, l.x, l.z])).toEqual(d.lots.map((l) => [l.key, l.x, l.z]));
      // The live houses and old fossils keep their slots too (new fossils go on the outside).
      for (const [id, slot] of d.slots) expect(again.slots.get(id)).toEqual(slot);
    }
    // Growing a live cluster (a new /upskill run) leaves every lot where it was as well.
    const again = computeAutoDistricts({ ...input, live: [...live, { id: "zz-new", title: UPSKILL }] });
    expect(again.lots.map((l) => [l.key, l.x, l.z])).toEqual(d.lots.map((l) => [l.key, l.x, l.z]));
  });

  it("lists one sidebar row per lot under the by-automation group, none before the archive is in", () => {
    const rows = autoLotRows(d);
    expect(rows.map((r) => r.value)).toEqual(d.lots.map((l) => `autolot:${l.key}`));
    expect(rows.every((r) => r.group === AUTO_LOTS_GROUP)).toBe(true);
    expect(rows[0]!.count).toBe(68);
    expect(autoLotRows(null)).toEqual([]);
  });
});

// ── a live AUTO session that starts after boot (features/archive.ts's onAgents handler) ────────

/** `fossilR0` defaults to "plenty of room" (50) so tests unrelated to capacity never trip it;
 *  the capacity describe block below passes a tight one on purpose. */
function fixtureLot(key: string, live: string[], x: number, fossilR0 = 50): AutoLot {
  const dir = new THREE.Vector3(0, 1, 0);
  const [t1, t2] = tangentBasis(dir);
  const frame: CityLayout = { id: `auto:${key}`, dir, t1, t2, radius: 1.5, lots: live.length, rank: 0 };
  return { key, live, archived: [], x, z: 0, r: 1.5, frame, fossilR0 };
}

function fixtureDistricts(): AutoDistricts {
  const recap = fixtureLot("/daily-recap", ["s1", "s2"], 0);
  const other = fixtureLot(OTHER_AUTOMATIONS, ["s3"], 4);
  const slots = new Map([
    ["s1", { key: recap.key, x: 0, z: 0 }],
    ["s2", { key: recap.key, x: 0.6, z: 0 }],
    ["s3", { key: other.key, x: 4, z: 0 }],
  ]);
  return { lots: [recap, other], slots, crowded: [] };
}

const AUTO_IDS = new Set(["s1", "s2", "s3", "s-new", "s-unknown"]);
const groupOf = (id: string): string | undefined => (AUTO_IDS.has(id) ? "AUTO" : "WEB");
/** The topics map main.ts reads once at boot never gains entries for sessions born afterwards
 *  (topics.ts's countNew counts them, never inserts them) — this is what that looks like. */
const unknownGroupOf = (): string | undefined => undefined;
const catchAll = new Set(["home", "root"]);

describe("isAutoHomeSession", () => {
  it("is true only for a home-folder island classified AUTO by the map", () => {
    expect(isAutoHomeSession({ id: "s-new", islandId: "home", title: RECAP }, catchAll, groupOf)).toBe(true);
    expect(isAutoHomeSession({ id: "s-new", islandId: "repo-01", title: RECAP }, catchAll, groupOf)).toBe(false); // not home-folder
    expect(isAutoHomeSession({ id: "proj", islandId: "home", title: RECAP }, catchAll, groupOf)).toBe(false); // map says WEB, wins even though the title has a key
  });

  it("falls back to the title's automationKey when the map has nothing for this id yet", () => {
    expect(isAutoHomeSession({ id: "brand-new", islandId: "home", title: RECAP }, catchAll, unknownGroupOf)).toBe(true);
    expect(isAutoHomeSession({ id: "brand-new", islandId: "home", title: "just chatting" }, catchAll, unknownGroupOf)).toBe(false);
  });
});

describe("planNewAutoLot", () => {
  it("sends a new AUTO agent with a known key to its lot", () => {
    const d = fixtureDistricts();
    expect(planNewAutoLot({ id: "s-new", islandId: "home", title: RECAP }, catchAll, groupOf, d)).toBe("/daily-recap");
  });

  it("falls into Other automations when the title carries no automation key", () => {
    const d = fixtureDistricts();
    expect(planNewAutoLot({ id: "s-unknown", islandId: "home", title: "just chatting, no automation here" }, catchAll, groupOf, d)).toBe(OTHER_AUTOMATIONS);
  });

  it("falls into Other automations when the key has no lot of its own", () => {
    const d = fixtureDistricts();
    // UPSKILL has no lot in this fixture (boot folded it, or it never existed) — Other, not null.
    expect(planNewAutoLot({ id: "s-new", islandId: "home", title: UPSKILL }, catchAll, groupOf, d)).toBe(OTHER_AUTOMATIONS);
  });

  it("leaves a non-AUTO or non-home-folder agent alone", () => {
    const d = fixtureDistricts();
    expect(planNewAutoLot({ id: "proj", islandId: "home", title: RECAP }, catchAll, groupOf, d)).toBeNull(); // not AUTO
    expect(planNewAutoLot({ id: "s-new", islandId: "repo-01", title: RECAP }, catchAll, groupOf, d)).toBeNull(); // not home-folder
  });

  it("never moves an already-placed agent twice", () => {
    const d = fixtureDistricts();
    expect(planNewAutoLot({ id: "s1", islandId: "home", title: RECAP }, catchAll, groupOf, d)).toBeNull();
    expect(planNewAutoLot({ id: "s3", islandId: "home", title: RECAP }, catchAll, groupOf, d)).toBeNull();
  });

  it("gives up (null, not Other) when boot made no Other lot either", () => {
    const recap = fixtureLot("/daily-recap", ["s1"], 0);
    const d: AutoDistricts = { lots: [recap], slots: new Map([["s1", { key: recap.key, x: 0, z: 0 }]]), crowded: [] };
    expect(planNewAutoLot({ id: "s-unknown", islandId: "home", title: "no automation here" }, catchAll, groupOf, d)).toBeNull();
  });

  it("classifies a session the topics map hasn't reached yet by title alone, and still moves it", () => {
    const d = fixtureDistricts();
    // The map (unknownGroupOf) knows NOTHING about this id — every prior test used a groupOf that
    // already recognized it, which is exactly what hid this bug: a real new session is exactly
    // this case, and it must still get to its lot.
    expect(planNewAutoLot({ id: "s-brand-new", islandId: "home", title: RECAP }, catchAll, unknownGroupOf, d)).toBe("/daily-recap");
    expect(planNewAutoLot({ id: "s-brand-new", islandId: "home", title: "just chatting, no automation here" }, catchAll, unknownGroupOf, d)).toBeNull();
  });
});

describe("addLiveToLot", () => {
  it("adds the agent at the lot's next open spot, leaving every other lot and slot untouched", () => {
    const d = fixtureDistricts();
    const next = addLiveToLot(d, "/daily-recap", "s-new");
    expect(next.lots.find((l) => l.key === "/daily-recap")!.live).toEqual(["s1", "s2", "s-new"]);
    expect(next.lots.find((l) => l.key === OTHER_AUTOMATIONS)).toBe(d.lots[1]); // untouched
    const [x, z] = lotLocal(2); // the lot already had 2 live houses (indices 0, 1)
    expect(next.slots.get("s-new")).toEqual({ key: "/daily-recap", x, z });
    // Original is untouched (pure).
    expect(d.lots.find((l) => l.key === "/daily-recap")!.live).toEqual(["s1", "s2"]);
    expect(d.slots.has("s-new")).toBe(false);
    for (const [id, slot] of d.slots) expect(next.slots.get(id)).toEqual(slot);
  });

  it("is a no-op for an unknown lot key or an already-placed agent", () => {
    const d = fixtureDistricts();
    expect(addLiveToLot(d, "no-such-lot", "s-new")).toBe(d);
    expect(addLiveToLot(d, "/daily-recap", "s1")).toBe(d);
  });
});

// ── lot capacity: live houses must never grow into the (fixed) fossil ring ─────────────────────

describe("lotHasRoom", () => {
  it("has room while the next spiral spot stays clear of the fossil ring by the margin", () => {
    const lot = fixtureLot("/daily-recap", ["s1", "s2"], 0, 3.2);
    expect(lotLocal(2)[0]).toBeDefined();
    expect(Math.hypot(...lotLocal(2))).toBeLessThanOrEqual(3.2 - LOT_LIVE_MARGIN);
    expect(lotHasRoom(lot)).toBe(true);
  });

  it("has no room once the next spot would land inside the margin kept around the fossil ring", () => {
    // The field report's lot: fossilR0 2.75, and the 4th live house (index 3) would land at r≈2.51,
    // inside the fossil ring minus the roof-radius margin.
    const lot = fixtureLot("/daily-recap", ["s1", "s2", "s3"], 0, 2.75);
    expect(Math.hypot(...lotLocal(3))).toBeGreaterThan(2.75 - LOT_LIVE_MARGIN);
    expect(lotHasRoom(lot)).toBe(false);
  });
});

describe("addLiveToLot respects capacity", () => {
  it("refuses to add past capacity, leaving the lot and every slot unchanged", () => {
    const full = fixtureLot("/daily-recap", ["s1", "s2", "s3"], 0, 2.75);
    const d: AutoDistricts = { lots: [full], slots: new Map(full.live.map((id) => [id, { key: full.key, x: 0, z: 0 }])), crowded: [] };
    expect(addLiveToLot(d, "/daily-recap", "s-new")).toBe(d);
  });
});

describe("planNewAutoLot + addLiveToLot fill a lot, then Other, then give up", () => {
  it("never proposes a slot that reaches inside the fossil ring, overflowing to Other and finally to the home city", () => {
    const alwaysAuto = (): string => AUTO_GROUP; // isolate capacity from the classification fix above
    const namedR0 = lotShape(8, 6).fossilR0; // a lot with room to spare beyond its 3 boot houses
    let d: AutoDistricts = {
      lots: [fixtureLot("/daily-recap", ["s1", "s2", "s3"], 0, namedR0), fixtureLot(OTHER_AUTOMATIONS, [], 8, namedR0)],
      slots: new Map(["s1", "s2", "s3"].map((id) => [id, { key: "/daily-recap", x: 0, z: 0 }])),
      crowded: [],
    };
    let addedToNamed = 0;
    let addedToOther = 0;
    let gaveUp = false;
    for (let i = 0; i < 60 && !gaveUp; i++) {
      const id = `new-${i}`;
      const key = planNewAutoLot({ id, islandId: "home", title: RECAP }, catchAll, alwaysAuto, d);
      if (key === null) {
        gaveUp = true;
        continue;
      }
      const lot = d.lots.find((l) => l.key === key)!;
      const [x, z] = lotLocal(lot.live.length); // the exact spot addLiveToLot is about to use
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(lot.fossilR0 - LOT_LIVE_MARGIN + 1e-9);
      const before = d;
      d = addLiveToLot(d, key, id);
      expect(d).not.toBe(before); // it actually got placed, not silently dropped
      if (key === "/daily-recap") addedToNamed++;
      else addedToOther++;
    }
    expect(addedToNamed).toBeGreaterThan(0); // some new sessions fit in their own lot first
    expect(addedToOther).toBeGreaterThan(0); // then it overflowed into Other
    expect(gaveUp).toBe(true); // and eventually both lots were full: stay in the home city
    // Confirm no slot anywhere in the final state reaches into its lot's fossil ring.
    for (const lot of d.lots) {
      for (const id of lot.live) {
        const s = d.slots.get(id)!;
        expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(lot.fossilR0 - LOT_LIVE_MARGIN + 1e-9);
      }
    }
  });
});

describe("lotRunNotes: what went wrong in a lot (the Automated Runs panel)", () => {
  const sub = (id: string, parent: string, over: Partial<SubagentRecord> = {}): SubagentRecord => ({
    id, parentSessionId: parent, parentAgentId: null, workflowId: null, description: `task ${id}`, agentType: null, model: null,
    status: "failed", reason: "cut off: a tool call never returned", startedAt: "2026-09-24T09:00:00.000Z", lastActive: "2026-09-24T09:10:00.000Z",
    tokens: 0, toolCounts: {}, files: [], depth: 1, ...over,
  });
  const end = (sessionId: string, over: Partial<RunEnding> = {}): RunEnding => ({ sessionId, status: "failed", reason: "API Error: Unable to connect to API (ConnectionRefused)", at: "2026-09-19T08:50:59.000Z", headless: true, ...over });

  it("a run's own ending first, else its failed subagents; a stop only when nothing failed; clean runs are absent", () => {
    const endings = new Map([
      ["r1", end("r1")],
      ["r3", end("r3", { status: "stopped", reason: "interrupted by the user" })],
      ["r4", end("r4", { status: "stopped", reason: "interrupted by the user" })],
    ]);
    const subs = [sub("s1", "r2"), sub("s2", "r2", { lastActive: "2026-09-24T09:20:00.000Z", reason: "API error: Request timed out" }), sub("s3", "r4"), sub("s4", "r5", { status: "done", reason: null }), sub("s5", "elsewhere")];
    const notes = lotRunNotes(["r0", "r1", "r2", "r3", "r4", "r5"], endings, subs);
    expect(Object.fromEntries(notes)).toEqual({
      r1: { status: "failed", text: "API Error: Unable to connect to API (ConnectionRefused)" },
      r2: { status: "failed", text: "2 subagents failed: API error: Request timed out" },
      r3: { status: "stopped", text: "interrupted by the user" },
      r4: { status: "failed", text: "1 subagent failed: cut off: a tool call never returned" },
    });
    expect(orderLotRows(["r0", "r1", "r2", "r3", "r4", "r5"], notes)).toEqual(["r1", "r2", "r4", "r3", "r0", "r5"]);
  });
});
