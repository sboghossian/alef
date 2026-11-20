import { describe, expect, it } from "vitest";
import type { VaultNote } from "../../shared/features/vault.js";
import { areaOf, layoutStars, pullInOutliers, vaultAtlas, vaultConstellation, vaultFlows, vaultHubs } from "../features/vault-maps.js";

const DAY_MS = 86_400_000;
const T = Date.parse("2026-10-26T00:00:00Z") / DAY_MS;

let seq = 0;
function note(p: Partial<VaultNote> = {}): VaultNote {
  seq++;
  const id = p.id ?? `m${String(seq).padStart(6, "0")}`;
  return {
    id,
    path: `00-Inbox/${id}.md`,
    kind: "n",
    type: "",
    day: null,
    hour: null,
    project: "",
    umbrella: "",
    tags: [],
    links: [],
    ghosts: [],
    minutes: null,
    mentionWeeks: null,
    mentionLast: null,
    up: null,
    upRule: "",
    ...p,
  };
}

describe("areaOf", () => {
  it("splits the big four one level deeper, and names the root", () => {
    expect(areaOf("10-Sessions/claude-code/x.md")).toBe("10-Sessions/claude-code");
    expect(areaOf("10-Sessions/x.md")).toBe("10-Sessions");
    expect(areaOf("20-Projects/acme/_index.md")).toBe("20-Projects");
    expect(areaOf("Home.md")).toBe("(root)");
  });
});

describe("vaultAtlas", () => {
  const notes = [
    note({ id: "a", path: "30-Knowledge/ai/a.md", day: T - 2, links: ["b"] }),
    note({ id: "b", path: "30-Knowledge/ai/b.md", day: T - 40 }),
    note({ id: "c", path: "30-Knowledge/c.md", day: T }),
    note({ id: "d", path: "10-Sessions/d.md" }),
    note({ id: "e", path: "Home.md", links: ["a", "c"] }),
    note({ id: "f", path: "30-Knowledge/ai/f.png", kind: "a" }),
    note({ id: "z", path: "30-Knowledge/ai/z.md", day: T + 5 }),
  ];

  it("counts the root, its folders by size, and its loose notes", () => {
    const a = vaultAtlas(notes, T, []);
    expect(a.path).toEqual([]);
    expect(a.count).toBe(6); // the attachment is not a note
    expect(a.subfolders.map((s) => [s.name, s.count])).toEqual([["30-Knowledge", 4], ["10-Sessions", 1]]);
    expect(a.loose).toBe(1);
    expect(a.notes.map((n) => n.name)).toEqual(["Home"]);
  });

  it("walks into a folder, with recent counts that ignore future dates", () => {
    const a = vaultAtlas(notes, T, ["30-Knowledge"]);
    expect(a.dir).toBe("30-Knowledge/");
    expect(a.recent).toBe(2); // a (2 days ago) and c (today); z is in the future
    expect(a.last).toBe("2026-10-26");
    expect(a.subfolders[0]).toMatchObject({ name: "ai", dir: "30-Knowledge/ai/", count: 3 });
    expect(a.newest.map((n) => n.name)).toEqual(["c", "a", "b"]);
    expect(a.mostLinked[0]?.name).toBe("a"); // 1 out + 1 in
  });

  it("stops at the deepest folder that exists, so a bad path cannot escape", () => {
    expect(vaultAtlas(notes, T, ["30-Knowledge", "..", "etc"]).path).toEqual(["30-Knowledge"]);
    expect(vaultAtlas(notes, T, ["nope"]).path).toEqual([]);
  });
});

describe("vaultFlows", () => {
  it("counts directed links between areas, inside ones separately", () => {
    const notes = [
      note({ id: "s1", path: "10-Sessions/claude-code/s1.md", links: ["k1", "k2", "s2"] }),
      note({ id: "s2", path: "10-Sessions/claude-code/s2.md" }),
      note({ id: "k1", path: "30-Knowledge/ai/k1.md", links: ["s1"] }),
      note({ id: "k2", path: "30-Knowledge/ai/k2.md", links: ["missing"] }),
    ];
    const f = vaultFlows(notes, "folders");
    const s = f.names.indexOf("10-Sessions/claude-code");
    const k = f.names.indexOf("30-Knowledge/ai");
    expect(f.matrix[s]?.[k]).toBe(2);
    expect(f.matrix[k]?.[s]).toBe(1);
    expect(f.self[s]).toBe(1);
    expect(f.cross[s]).toBe(3);
    expect(f.notes[s]).toBe(2);
  });

  it("folds the long tail into Other, and skips notes without an umbrella in umbrella mode", () => {
    const notes = Array.from({ length: 16 }, (_, i) => note({ path: `F${String(i).padStart(2, "0")}/x${i}.md`, umbrella: i < 2 ? `u${i}` : "" }));
    const f = vaultFlows(notes, "folders");
    expect(f.names).toHaveLength(14);
    expect(f.names.at(-1)).toBe("Other");
    expect(f.notes.at(-1)).toBe(3);
    expect(vaultFlows(notes, "umbrellas").names).toEqual(["u0", "u1"]);
  });
});

describe("vaultHubs", () => {
  it("plots 3+ link notes by areas reached, and finds keystones and silos", () => {
    const spokes = Array.from({ length: 6 }, (_, i) => note({ id: `sp${i}`, path: `Area${i}/sp${i}.md` }));
    const hub = note({ id: "hub", path: "30-Knowledge/ai/hub.md", links: spokes.map((s) => s.id) });
    const silo = note({ id: "silo", path: "20-Projects/silo.md" });
    const fans = Array.from({ length: 31 }, (_, i) => note({ path: `20-Projects/fan${i}.md`, links: ["silo"] }));
    const h = vaultHubs([hub, silo, ...spokes, ...fans]);
    expect(h.total).toBe(2);
    expect(h.bridges).toBe(1);
    expect(h.keystones[0]).toMatchObject({ name: "hub", links: 6, areas: 6 });
    expect(h.silos.map((x) => x.name)).toEqual(["silo"]);
    expect(h.points[0]?.name).toBe("silo"); // most links first
  });
});

describe("vaultConstellation", () => {
  function project(slug: string, umbrella: string, targets: readonly string[], count = 3): VaultNote[] {
    return Array.from({ length: count }, () => note({ project: slug, umbrella, links: targets }));
  }

  it("ties projects that link the same notes, and leaves islands out of the map", () => {
    const shared = ["t1", "t2", "t3"];
    const notes = [
      ...project("alpha", "acme", shared),
      ...project("beta", "acme", shared),
      ...project("gamma", "brain", ["t1", "t2"]),
      ...project("lonely", "personal", ["solo"], 6),
      ...project("tiny", "personal", shared, 2), // under 3 notes: not a star
    ];
    const c = vaultConstellation(notes);
    expect(c.stars.map((s) => s.slug).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(c.strongest[0]).toEqual({ a: "alpha", b: "beta", w: 3 });
    expect(c.islands).toEqual([{ slug: "lonely", notes: 6 }]);
    for (const s of c.stars) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(1);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(1);
    }
  });

  it("ignores targets so generic that 15+ projects share them", () => {
    const notes = Array.from({ length: 15 }, (_, i) => project(`p${i}`, "u", ["ai", "ai2"])).flat();
    expect(vaultConstellation(notes).ties).toEqual([]);
  });

  it("lays out the same way every time", () => {
    const ties = [{ a: 0, b: 1, w: 5 }, { a: 1, b: 2, w: 2 }];
    expect(layoutStars([5, 6, 7], ties)).toEqual(layoutStars([5, 6, 7], ties));
    const [p, q] = layoutStars([5, 5], [{ a: 0, b: 1, w: 3 }]);
    expect(Math.hypot((p?.x ?? 0) - (q?.x ?? 0), (p?.y ?? 0) - (q?.y ?? 0))).toBeGreaterThan(10); // collide keeps them apart
  });
});

describe("pullInOutliers", () => {
  it("caps a far star at 1.7x the median distance, keeping its direction", () => {
    const pos = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: 100, y: 0 }];
    const out = pullInOutliers(pos);
    const far = out[4];
    expect(far?.y).toBeCloseTo(0);
    expect(far?.x ?? 0).toBeLessThan(10);
    expect(out[0]).toEqual(pos[0]);
  });
});
