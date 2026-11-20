import { describe, expect, it } from "vitest";
import type { Island, WorldAgent } from "../../shared/types";
import type { TopicsMap } from "../../shared/features/topics";
import { CITY_SURFACE, FRONT_DIR, applyDistrictMergesToLayout } from "./layout";
import { CONTINENT_GAP, computeTopicLayout, packCircles, relaxCaps } from "./topic-layout";
import * as THREE from "three";

const KEYS = ["AUTO", "WEB", "SETUP", "GTM", "PERSONAL", "RESEARCH", "TEAM", "CONTENT", "PROD", "OTHER"];

function island(id: string, path: string, day: number): Island {
  return { id, name: id, path, agentCount: 0, lastActive: new Date(Date.UTC(2026, 8, day)).toISOString() };
}

/** A world shaped like the real one: a huge catch-all home folder, ~55 repo cities, harness. */
function realistic(): { islands: Island[]; lots: Map<string, number>; topics: TopicsMap; agents: Pick<WorldAgent, "id" | "islandId" | "lastActive">[] } {
  const islands: Island[] = [island("home", "/Users/me", 26), island("root", "/", 25), island("harness", "", 1)];
  const lots = new Map<string, number>([["home", 233], ["root", 22], ["harness", 122]]);
  const topicIslands: Record<string, string> = { home: "AUTO", root: "AUTO", harness: "SETUP" };
  for (let i = 0; i < 55; i++) {
    const id = `repo-${String(i).padStart(2, "0")}`;
    islands.push(island(id, `/Users/me/Code/${id}`, 1 + (i % 24)));
    lots.set(id, [52, 36, 30, 20, 18, 18, 15, 12, 9, 6, 6, 5, 3][i] ?? i % 3);
    topicIslands[id] = KEYS[i % KEYS.length]!;
  }
  const agents: Pick<WorldAgent, "id" | "islandId" | "lastActive">[] = [];
  const sessions: TopicsMap["sessions"] = {};
  for (let i = 0; i < 203; i++) {
    const id = `s${String(i).padStart(3, "0")}`;
    agents.push({ id, islandId: "home", lastActive: "2026-09-26T00:00:00Z" });
    sessions[id] = { group: KEYS[i % 7 === 0 ? 0 : i % KEYS.length]!, source: "assigned" };
  }
  agents.push({ id: "r1", islandId: "root", lastActive: "2026-09-26T00:00:00Z" });
  sessions.r1 = { group: "AUTO", source: "rule" };
  const groups = KEYS.map((key, i) => ({ key, name: key, hint: "", color: "#112233", sessions: 60 - i * 5, cities: 6 }));
  return { islands, lots, agents, topics: { generatedAt: "", groups, sessions, islands: topicIslands, catchAll: ["home", "root"], pendingJev: 0, jev: "online" } };
}

function capOf(t: ReturnType<typeof computeTopicLayout>, key: string) {
  const c = t.continents.find((x) => x.key === key);
  if (!c) throw new Error(`no continent ${key}`);
  return c;
}

describe("computeTopicLayout", () => {
  const w = realistic();
  const t = computeTopicLayout(w.islands, w.lots, w.topics, w.agents);

  it("lays out one continent per used group, biggest facing the camera", () => {
    expect(t.continents.map((c) => c.key)).toEqual(KEYS);
    expect(t.continents[0]!.dir.dot(FRONT_DIR)).toBeCloseTo(1, 6);
  });

  it("lays out every island, plus a neighbourhood per extra topic of a catch-all island", () => {
    for (const i of w.islands) expect(t.layout.has(i.id)).toBe(true);
    expect(t.layout.has("home~WEB")).toBe(true);
    expect(t.layout.has("home~AUTO")).toBe(false); // AUTO is home's own continent
    expect(t.homeKey({ id: "s001", islandId: "home" })).toBe("home~WEB");
    expect(t.homeKey({ id: "s000", islandId: "home" })).toBe("home"); // majority topic stays home
    expect(t.homeKey({ id: "brand-new", islandId: "home" })).toBe("home");
    expect(t.homeKey({ id: "x", islandId: "repo-01" })).toBe("repo-01");
  });

  it("puts every island inside its continent region", () => {
    for (const [id, city] of t.layout) {
      const cap = capOf(t, t.continentOf.get(id)!);
      const edge = cap.dir.angleTo(city.dir) + city.radius / CITY_SURFACE;
      expect(edge).toBeLessThanOrEqual(cap.angle + 1e-9);
    }
    expect(t.continentOf.get("repo-01")).toBe("WEB");
    expect(t.continentOf.get("home~GTM")).toBe("GTM");
  });

  it("never overlaps two continents", () => {
    const cs = t.continents;
    for (let a = 0; a < cs.length; a++) {
      for (let b = a + 1; b < cs.length; b++) {
        expect(cs[a]!.dir.angleTo(cs[b]!.dir)).toBeGreaterThanOrEqual(cs[a]!.angle + cs[b]!.angle + CONTINENT_GAP * 0.99);
      }
    }
  });

  it("never overlaps two neighbourhoods", () => {
    const cities = [...t.layout.values()];
    for (let a = 0; a < cities.length; a++) {
      for (let b = a + 1; b < cities.length; b++) {
        const ca = cities[a]!;
        const cb = cities[b]!;
        expect(ca.dir.angleTo(cb.dir) * CITY_SURFACE).toBeGreaterThan(ca.radius + cb.radius);
      }
    }
  });

  it("is deterministic: same input in any order gives the same positions", () => {
    const again = computeTopicLayout([...w.islands].reverse(), w.lots, w.topics, [...w.agents].reverse());
    for (const [id, c] of t.layout) {
      const d = again.layout.get(id);
      expect(d?.dir.distanceTo(c.dir)).toBeLessThan(1e-12);
      expect(d?.radius).toBe(c.radius);
    }
  });

  it("keeps rank 0 = most recently active island", () => {
    expect(t.layout.get("home")?.rank).toBe(0);
  });

  it("keeps district merges working (aliases onto the target's layout)", () => {
    const copy = new Map(t.layout);
    applyDistrictMergesToLayout(copy, [{ districts: ["repo-03", "repo-13"], into: "repo-03" }]);
    expect(copy.get("repo-13")).toBe(copy.get("repo-03"));
  });

  it("handles an unknown island group and an empty world", () => {
    const topics: TopicsMap = { ...w.topics, islands: { ...w.topics.islands, "repo-02": "MARS" } };
    const odd = computeTopicLayout(w.islands, w.lots, topics, w.agents);
    expect(odd.continentOf.get("repo-02")).toBe("MARS");
    expect(odd.continents.some((c) => c.key === "MARS")).toBe(true);
    const empty = computeTopicLayout([], new Map(), { ...w.topics, groups: [], islands: {}, sessions: {}, catchAll: [] }, []);
    expect(empty.layout.size).toBe(0);
    expect(empty.continents).toEqual([]);
  });
});

describe("packCircles / relaxCaps", () => {
  it("packs an empty list and a single unit at the centre", () => {
    expect(packCircles([]).extent).toBe(0);
    expect(packCircles([{ id: "a", lots: 1, radius: 3 }]).pos.get("a")).toEqual([0, 0]);
  });
  it("separates two identical caps seeded on top of each other", () => {
    const dirs = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.001, 1).normalize()];
    relaxCaps(dirs, [0.3, 0.3]);
    expect(dirs[0]!.z).toBeCloseTo(1, 9); // the first cap is pinned
    expect(dirs[0]!.angleTo(dirs[1]!)).toBeGreaterThanOrEqual(0.6 + CONTINENT_GAP - 1e-6);
  });
});
