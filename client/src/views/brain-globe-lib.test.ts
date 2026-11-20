import { describe, expect, it } from "vitest";
import type { BrainNode } from "../../../shared/features/brain";
import {
  GLOBE_R,
  GRAPH_MODE_KEY,
  MAX_GLOBE_LINKS,
  angleBetween,
  arcPoints,
  capLinks,
  dragSpin,
  faceSpin,
  familyColors,
  folderRegions,
  frontMost,
  globeLayout,
  globeNodeSize,
  groupOf,
  halfYear,
  keySpin,
  layoutLabels,
  litIds,
  planSplits,
  dropLegacyGraphMode,
  LEGACY_GRAPH_MODE_KEY,
  readGraphMode,
  rotateYawPitch,
  settleGraphMode,
  spinAt,
  stepSpin,
  toneOf,
  writeGraphMode,
  type Vec3,
} from "./brain-globe-lib";

const node = (id: number, folder: string, degree = 1, path = `${folder}/note-${id}`): BrainNode => ({ id, label: `n${id}`, path, folder, group: "other", degree, community: 0 });

/** A skewed vault like the real one: one folder holds about half the notes, one holds a single note. */
function vault(): BrainNode[] {
  const sizes: Array<[string, number]> = [["10-Sessions", 700], ["30-Knowledge", 420], ["20-Projects", 180], ["60-Meta", 120], ["50-Wiki", 50], ["00-Inbox", 20], ["Clippings", 9], ["", 1]];
  let id = 0;
  return sizes.flatMap(([f, n]) => Array.from({ length: n }, () => node(++id, f, id % 17)));
}

/** Like the real slice: sessions are dated notes, 95% in one source sub-folder; knowledge has real sub-folders. */
function dated(): BrainNode[] {
  const out: BrainNode[] = [];
  let id = 0;
  for (let i = 0; i < 600; i++) {
    const month = String(1 + (i % 12)).padStart(2, "0");
    const src = i % 20 === 0 ? "tool-b" : "tool-a";
    out.push(node(++id, "10-Sessions", 3, `10-Sessions/${src}/${2024 + (i % 3)}-${month}-0${1 + (i % 9)} chat ${i}`));
  }
  const subs: Array<[string, number]> = [["alpha", 120], ["beta", 60], ["gamma", 30], ["delta", 10], ["", 5]];
  for (const [sub, n] of subs) for (let i = 0; i < n; i++) out.push(node(++id, "30-Knowledge", 2, sub ? `30-Knowledge/${sub}/k${i}` : `30-Knowledge/k${i}`));
  for (let i = 0; i < 40; i++) out.push(node(++id, "60-Meta", 1));
  return out;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const sample = (xs: Vec3[]): Vec3[] => xs.filter((_, i) => i % Math.ceil(xs.length / 60) === 0);

/** Mean angular distance within each bucket < between buckets (and overall by a margin). */
function expectClustered(groups: Map<string, Vec3[]>, label: string): void {
  const within: number[] = [];
  const between: number[] = [];
  for (const [k, ps] of groups) {
    const mine = sample(ps);
    const others = sample([...groups].filter(([g]) => g !== k).flatMap(([, xs]) => xs));
    const w = mine.flatMap((p, i) => mine.slice(i + 1).map((q) => angleBetween(p, q)));
    const b = mine.flatMap((p) => others.map((q) => angleBetween(p, q)));
    if (w.length) expect(mean(w), `${label} ${k || "(root)"}`).toBeLessThan(mean(b));
    within.push(...w);
    between.push(...b);
  }
  expect(mean(within)).toBeLessThan(mean(between) * 0.8);
}

describe("globeLayout", () => {
  it("is deterministic: same notes, any order, same globe", () => {
    const nodes = dated();
    const a = globeLayout(nodes);
    const b = globeLayout([...nodes].reverse());
    expect(b.pos.size).toBe(nodes.length);
    for (const [id, p] of a.pos) expect(b.pos.get(id)).toEqual(p);
    expect(b.color).toEqual(a.color);
  });

  it("puts every note on the sphere of radius R", () => {
    for (const p of globeLayout([...vault(), ...dated().map((n) => ({ ...n, id: n.id + 5000 }))]).pos.values()) expect(Math.abs(Math.hypot(p.x, p.y, p.z) - GLOBE_R)).toBeLessThan(1e-9);
    for (const p of globeLayout(vault(), 7).pos.values()) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(7, 9);
  });

  it("clusters by folder: notes sit closer to their own folder than to the others", () => {
    for (const nodes of [vault(), dated()]) {
      const pos = globeLayout(nodes).pos;
      const byFolder = new Map<string, Vec3[]>();
      for (const n of nodes) byFolder.set(n.folder, [...(byFolder.get(n.folder) ?? []), pos.get(n.id) as Vec3]);
      expectClustered(byFolder, "folder");
    }
  });

  it("clusters sub-groups inside a split folder too", () => {
    const nodes = dated();
    const lay = globeLayout(nodes);
    const split = lay.splits.find((s) => s.folder === "10-Sessions");
    const byGroup = new Map<string, Vec3[]>();
    for (const n of nodes.filter((x) => x.folder === "10-Sessions")) {
      const g = groupOf(n, split) ?? "?";
      byGroup.set(g, [...(byGroup.get(g) ?? []), lay.pos.get(n.id) as Vec3]);
    }
    expect(byGroup.size).toBeGreaterThanOrEqual(3);
    expectClustered(byGroup, "sub-group");
  });

  it("gives bigger folders bigger regions", () => {
    const r = folderRegions(new Map([["big", 900], ["mid", 90], ["tiny", 1]]));
    expect((r.get("big")?.radius ?? 0) > (r.get("mid")?.radius ?? 0)).toBe(true);
    expect((r.get("mid")?.radius ?? 0) > (r.get("tiny")?.radius ?? 0)).toBe(true);
    expect(r.get("tiny")?.radius).toBeGreaterThan(0.05); // still a visible patch
  });

  it("handles an empty graph, one folder, and odd paths", () => {
    expect(globeLayout([]).pos.size).toBe(0);
    expect(globeLayout([]).splits).toEqual([]);
    expect(folderRegions(new Map([["x", 0]])).size).toBe(0);
    const one = globeLayout([node(1, ""), { ...node(2, ""), path: "" }]);
    expect(one.pos.size).toBe(2);
    for (const p of one.pos.values()) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });
});

describe("sub-groups and colours", () => {
  it("splits a dominant folder the more even way: dated sessions by half-year, knowledge by sub-folder", () => {
    const splits = planSplits(dated());
    const s = splits.get("10-Sessions");
    expect(s?.by).toBe("half-year"); // by sub-folder, one source would be 95%
    expect(s?.groups.map((g) => g.key)).toEqual(["2024 H1", "2024 H2", "2025 H1", "2025 H2", "2026 H1", "2026 H2"]);
    const k = splits.get("30-Knowledge");
    expect(k?.by).toBe("sub-folder");
    expect(k?.groups[0]).toMatchObject({ key: "alpha", count: 120 });
    expect(splits.has("60-Meta")).toBe(false); // under 20% of the notes
    for (const sp of splits.values()) {
      expect(sp.groups.length).toBeLessThanOrEqual(6);
      expect(new Set(sp.groups.map((g) => g.color)).size).toBe(sp.groups.length);
      expect(sp.groups.reduce((a, g) => a + g.count, 0)).toBe(dated().filter((n) => n.folder === sp.folder).length);
    }
  });

  it("merges the small rest into 'other' and never splits when one bucket dominates", () => {
    const many = Array.from({ length: 400 }, (_, i) => node(i + 1, "K", 1, `K/sub${i % 9}/n${i}`));
    const k = planSplits(many).get("K");
    expect(k?.groups).toHaveLength(6);
    expect(k?.groups.at(-1)?.key).toBe("other");
    expect(groupOf(many[8] as BrainNode, k)).toBe("other");
    const lopsided = Array.from({ length: 100 }, (_, i) => node(i + 1, "S", 1, `S/${i < 95 ? "main" : "side"}/n${i}`));
    expect(planSplits(lopsided).size).toBe(0);
    expect(groupOf(lopsided[0] as BrainNode, undefined)).toBeNull();
  });

  it("reads half-years and builds distinct bright colours from one family", () => {
    expect(halfYear("10-Sessions/x/2025-03-14 chat")).toBe("2025 H1");
    expect(halfYear("10-Sessions/x/2025-11-02")).toBe("2025 H2");
    expect(halfYear("10-Sessions/x/2025-13-02")).toBeNull();
    expect(halfYear("notes/plan")).toBeNull();
    const c = familyColors("#448aff", 5);
    expect(new Set(c).size).toBe(5);
    for (const hex of c) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(familyColors("#448aff", 1)).toEqual(["#448aff"]);
    expect(familyColors("#448aff", 0)).toEqual([]);
  });

  it("sizes beads: leaves small, hubs pop, monotonic", () => {
    expect(globeNodeSize(0)).toBeCloseTo(0.45, 5);
    expect(globeNodeSize(1500)).toBeGreaterThan(globeNodeSize(20) * 2);
    expect(globeNodeSize(20)).toBeGreaterThan(globeNodeSize(1));
    expect(globeNodeSize(1e9)).toBeLessThanOrEqual(3.36);
  });
});

describe("capLinks", () => {
  const edges: Array<[number, number]> = [[1, 2], [1, 3], [1, 4], [2, 3], [5, 6], [6, 7], [7, 8], [8, 9]];
  const degree = new Map([[1, 90], [2, 40], [3, 30], [4, 1], [5, 2], [6, 3], [7, 2], [8, 1], [9, 1]]);

  it("keeps every link under the cap (as a copy); the default cap is 2,500", () => {
    const out = capLinks(edges, degree, 100);
    expect(out).toEqual(edges);
    expect(out).not.toBe(edges);
    expect(capLinks([], degree, 5)).toEqual([]);
    expect(MAX_GLOBE_LINKS).toBe(2500);
    const big = Array.from({ length: 3000 }, (_, i): [number, number] => [i, i + 1]);
    expect(capLinks(big, new Map())).toHaveLength(2500);
  });

  it("over the cap: exactly max links; with max ≥ nodes - 1 every node keeps one; deterministic", () => {
    const out = capLinks(edges, degree, 7); // 8 links over 9 nodes: one must go
    expect(out).toHaveLength(7);
    const covered = new Set(out.flat());
    for (const id of degree.keys()) expect(covered.has(id), `node ${id}`).toBe(true);
    expect(out).not.toContainEqual([2, 3]); // the one link whose ends were both already covered
    expect(capLinks(edges, degree, 6)).toHaveLength(6);
    expect(capLinks(edges, degree, 6)).toEqual(capLinks([...edges], degree, 6));
    expect(capLinks(edges, degree, 2)).toHaveLength(2);
    expect(capLinks(edges, degree, 0)).toEqual([]);
  });
});

describe("arcs, facing and spin", () => {
  const a: Vec3 = { x: GLOBE_R, y: 0, z: 0 };
  const idle = { drag: false, hover: false, auto: false };
  it("arcs start and end on the nodes and hug the surface in between", () => {
    const pts = arcPoints(a, { x: 0, y: GLOBE_R, z: 0 }, GLOBE_R, 8);
    expect(pts).toHaveLength(9);
    expect(pts[0]?.x).toBeCloseTo(GLOBE_R, 6);
    expect(pts[8]?.y).toBeCloseTo(GLOBE_R, 6);
    const mid = Math.hypot((pts[4] as Vec3).x, (pts[4] as Vec3).y, (pts[4] as Vec3).z);
    expect(mid).toBeGreaterThan(GLOBE_R * 1.02);
    expect(mid).toBeLessThan(GLOBE_R * 1.06); // hugging, not a chord through the middle nor a tall loop
    for (const p of arcPoints(a, { x: -GLOBE_R, y: 0, z: 0 })) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true); // antipodes
  });

  it("turns any point to face the camera (+z), eased or snapped", () => {
    for (const p of [{ x: 1, y: 0, z: 0 }, { x: -0.3, y: 0.5, z: -0.8 }, { x: 0, y: -0.9, z: 0.1 }]) {
      let s = faceSpin(spinAt(300), p);
      for (let i = 0; i < 600 && s.face; i++) s = stepSpin(s, 1 / 60, { ...idle, auto: true });
      expect(s.face).toBeNull();
      expect(rotateYawPitch(p, s.yaw, s.pitch).z / Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(0.99);
      const snapped = faceSpin(spinAt(300), p, true); // reduced motion: there at once
      expect(snapped.face).toBeNull();
      expect(rotateYawPitch(p, snapped.yaw, snapped.pitch).z / Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(0.99);
    }
  });

  it("coasts after a drag with friction, and only auto-rotates when idle and allowed", () => {
    let s = dragSpin(spinAt(300), 40, 0, 1 / 60, 0.005);
    expect(s.vyaw).toBeGreaterThan(0);
    const y0 = s.yaw;
    s = stepSpin(s, 0.1, idle);
    expect(s.yaw).toBeGreaterThan(y0);
    for (let i = 0; i < 400; i++) s = stepSpin(s, 1 / 60, idle);
    expect(s.vyaw).toBe(0);
    const still = s.yaw;
    for (let i = 0; i < 300; i++) s = stepSpin(s, 1 / 60, idle);
    expect(s.yaw).toBeCloseTo(still, 9); // reduced motion: no auto-rotate
    for (let i = 0; i < 300; i++) s = stepSpin(s, 1 / 60, { ...idle, auto: true });
    expect(Math.abs(s.yaw - still)).toBeGreaterThan(0.1);
  });

  it("a drag holds its fling; a hover drops it, so the globe rests and the old fling never resumes", () => {
    const flung = dragSpin(spinAt(300), 60, 20, 1 / 60, 0.005);
    const dragging = stepSpin(flung, 1 / 60, { ...idle, drag: true });
    expect(dragging.vyaw).toBe(flung.vyaw); // kept for the release
    expect(dragging.yaw).toBeCloseTo(flung.yaw, 9);
    const hovered = stepSpin(flung, 1 / 60, { ...idle, hover: true, auto: true });
    expect(hovered.vyaw).toBe(0);
    expect(hovered.vpitch).toBe(0);
    expect(hovered.yaw).toBeCloseTo(flung.yaw, 9);
    const after = stepSpin(hovered, 1 / 60, idle);
    expect(after.yaw).toBeCloseTo(hovered.yaw, 9); // nothing left to coast on
  });

  it("arrow keys turn a step (presses add up), snapping under reduced motion; other keys are not ours", () => {
    const s = spinAt(300);
    const right = keySpin(s, "ArrowRight");
    expect(right?.face?.yaw).toBeCloseTo(s.yaw + 0.2, 9);
    expect(keySpin(right as NonNullable<typeof right>, "ArrowRight")?.face?.yaw).toBeCloseTo(s.yaw + 0.4, 9);
    const down = keySpin(s, "ArrowDown", true);
    expect(down?.face).toBeNull();
    expect(down?.pitch).toBeCloseTo(s.pitch + 0.2, 9);
    expect(keySpin({ ...s, pitch: 1.44 }, "ArrowDown", true)?.pitch).toBe(1.45); // clamped like a drag
    expect(keySpin(s, "Escape")).toBeNull();
    expect(keySpin(s, "f")).toBeNull();
  });

  it("finds the note facing the camera", () => {
    const pos = new Map<number, Vec3>([
      [1, { x: 0, y: 0, z: 100 }],
      [2, { x: 100, y: 0, z: 0 }],
      [3, { x: 0, y: 0, z: -100 }],
    ]);
    expect(frontMost(pos, 0, 0)).toBe(1);
    expect(frontMost(pos, -Math.PI / 2, 0)).toBe(2);
    expect(frontMost(new Map(), 0, 0)).toBeNull();
  });

  it("tones: hover focus and neighbours, else the filters", () => {
    const near = new Set([2]);
    expect(toneOf(1, 1, near, null)).toBe("focus");
    expect(toneOf(2, 1, near, null)).toBe("near");
    expect(toneOf(3, 1, near, null)).toBe("dim");
    expect(toneOf(3, null, undefined, null)).toBe("base");
    expect(toneOf(3, null, undefined, new Set([4]))).toBe("dim");
    expect(toneOf(4, null, undefined, new Set([4]))).toBe("base");
  });
});

describe("litIds: what the globe keeps lit", () => {
  // 1-2-3 linked, 4 and 5 unlinked; 5 is a memory file
  const nodes = [node(1, "A"), node(2, "A"), node(3, "B"), node(4, "A"), { ...node(5, "B"), path: "B/memory/m5" }];
  const g = { nodes, edges: [[1, 2], [2, 3]] as Array<[number, number]> };
  const none = { folders: [], memoryOnly: false, project: null };

  it("nothing filtered, nothing searched: null (all lit)", () => {
    expect(litIds(g, none, null)).toBeNull();
  });

  it("a folder filter lights every note in it, unlinked ones too", () => {
    expect([...(litIds(g, { ...none, folders: ["A"] }, null) ?? [])].sort()).toEqual([1, 2, 4]);
    expect([...(litIds(g, { ...none, memoryOnly: true }, null) ?? [])]).toEqual([5]);
  });

  it("a search lights its hits, an unlinked hit included; both together intersect", () => {
    expect([...(litIds(g, none, new Set([4])) ?? [])]).toEqual([4]);
    expect([...(litIds(g, none, new Set()) ?? [])]).toEqual([]);
    expect([...(litIds(g, { ...none, folders: ["A"] }, new Set([3, 4])) ?? [])]).toEqual([4]);
  });

  it("the project filter with no agent selected (project null) dims nothing", () => {
    expect(litIds(g, { ...none, project: null }, null)).toBeNull();
    const proj = [node(6, "20-Projects", 1, "20-Projects/demo/plan"), ...nodes];
    expect([...(litIds({ nodes: proj, edges: [[6, 1]] }, { ...none, project: "demo" }, null) ?? [])].sort()).toEqual([1, 6]);
  });
});

describe("labels", () => {
  it("never overlap; the first keeps its spot, crowded ones nudge or hide", () => {
    const box = { w: 80, h: 20 };
    const out = layoutLabels([
      { x: 100, y: 100, ...box },
      { x: 110, y: 104, ...box },
      { x: 400, y: 100, ...box },
      ...Array.from({ length: 6 }, () => ({ x: 105, y: 102, ...box })),
    ]);
    expect(out[0]).toEqual({ x: 100, y: 100, visible: true });
    expect(out[2]).toEqual({ x: 400, y: 100, visible: true });
    const vis = out.filter((o) => o.visible);
    for (let i = 0; i < vis.length; i++)
      for (let j = i + 1; j < vis.length; j++) {
        const [p, q] = [vis[i], vis[j]] as [{ x: number; y: number }, { x: number; y: number }];
        expect(Math.abs(p.x - q.x) >= 80 || Math.abs(p.y - q.y) >= 20).toBe(true);
      }
    expect(out.some((o) => !o.visible)).toBe(true);
    expect(layoutLabels([])).toEqual([]);
  });
});

describe("the remembered 2D / 3D choice", () => {
  const memory = (): Pick<Storage, "getItem" | "setItem"> => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };

  it("defaults to the globe; an explicit 2d under the v2 key is respected", () => {
    const s = memory();
    expect(readGraphMode(() => s)).toBe("3d"); // nothing stored
    expect(writeGraphMode(() => s, "2d")).toBe(true);
    expect(s.getItem(GRAPH_MODE_KEY)).toBe("2d");
    expect(readGraphMode(() => s)).toBe("2d");
    expect(writeGraphMode(() => s, "3d")).toBe(true);
    expect(readGraphMode(() => s)).toBe("3d");
    s.setItem(GRAPH_MODE_KEY, "4d");
    expect(readGraphMode(() => s)).toBe("3d");
    expect(readGraphMode(() => null)).toBe("3d");
    expect(writeGraphMode(() => null, "3d")).toBe(false);
  });

  it("migration: a 2d saved under the old key is ignored, then dropped", () => {
    const s = memory();
    s.setItem(LEGACY_GRAPH_MODE_KEY, "2d");
    expect(GRAPH_MODE_KEY).not.toBe(LEGACY_GRAPH_MODE_KEY);
    expect(readGraphMode(() => s)).toBe("3d");
    const removed: string[] = [];
    dropLegacyGraphMode(() => ({ removeItem: (k) => void removed.push(k) }));
    expect(removed).toEqual([LEGACY_GRAPH_MODE_KEY]);
    expect(() => dropLegacyGraphMode(() => null)).not.toThrow();
  });

  it("never throws when storage does: the globe is tried, then a clean fallback", () => {
    const boom = (): never => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(readGraphMode(boom)).toBe("3d");
    expect(writeGraphMode(boom, "3d")).toBe(false);
    const broken = { getItem: boom, setItem: boom, removeItem: boom };
    expect(readGraphMode(() => broken)).toBe("3d");
    expect(writeGraphMode(() => broken, "3d")).toBe(false);
    expect(() => dropLegacyGraphMode(() => broken)).not.toThrow();
    // globe fails to open on that default mount: 2d, and the failed save is swallowed
    const first = settleGraphMode(readGraphMode(() => broken), false);
    expect(first).toEqual({ mode: "2d", save: "2d" });
    expect(writeGraphMode(() => broken, first.save)).toBe(false);
  });

  it("restore / fallback: 3D is saved only once the globe opened; a failed open saves 2D", () => {
    expect(settleGraphMode("3d", true)).toEqual({ mode: "3d", save: "3d" });
    expect(settleGraphMode("3d", false)).toEqual({ mode: "2d", save: "2d" });
    expect(settleGraphMode("2d", false)).toEqual({ mode: "2d", save: "2d" });
    // a browser without WebGL: nothing stored -> default 3d is attempted (one toast) and fails ->
    // "2d" saved -> every later load stays 2D without another attempt
    const s = memory();
    let toasts = 0;
    const load = (): void => {
      const want = readGraphMode(() => s);
      if (want === "3d") toasts++; // the failed open toasts once
      writeGraphMode(() => s, settleGraphMode(want, false).save);
    };
    load();
    load();
    load();
    expect(toasts).toBe(1);
    expect(readGraphMode(() => s)).toBe("2d");
  });
});
