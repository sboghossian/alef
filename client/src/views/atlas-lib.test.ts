import { describe, expect, it, vi } from "vitest";
import { ATLAS_DEPT_IDS, ATLAS_KINDS, type AtlasDeptId, type AtlasLeaf } from "../../../shared/features/atlas";
import { BRANCH_RING, DEPT_RING, autonomyLabel, deptLabelLines, labelBox, layoutAtlas, leafRadius, matchesFilter, pickLeaf, pollChain, reasonLine, statsLine, usesLine, viaLine, type AtlasLayout } from "./atlas-lib";

function leaf(i: number, dept: AtlasDeptId, kind = ATLAS_KINDS[i % 4]!, uses = (i * 7) % 60): AtlasLeaf {
  return { id: `${kind}:n${String(i).padStart(3, "0")}`, kind, name: `n${i}`, description: i % 5 ? "" : "Builds decks", dept, reason: "unfiled", via: "unfiled", autonomy: i % 3 ? "manual" : "assisted", evidence: "", uses, uses30d: 0, lastUsedAt: null, path: null, canOpen: false };
}

/** A lopsided real-ish mix: one huge department, one tiny, one empty. */
function fixture(): AtlasLeaf[] {
  const out: AtlasLeaf[] = [];
  let i = 0;
  const sizes: Record<AtlasDeptId, number> = { "acme-website": 10, "acme-gtm": 18, infra: 150, rituals: 1, "side-projects": 0, "build-ship": 64, "research-studio": 23, "brain-vault": 2, unfiled: 42 };
  for (const d of ATLAS_DEPT_IDS) for (let k = 0; k < sizes[d]; k++) out.push(leaf(i++, d));
  return out;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

function allCircles(l: AtlasLayout): { id: string; x: number; y: number; r: number }[] {
  return [
    ...[...l.depts].map(([id, p]) => ({ id: `dept:${id}`, ...p })),
    ...[...l.branches].map(([id, p]) => ({ id: `branch:${id}`, ...p })),
    ...[...l.leaves].map(([id, p]) => ({ id, ...p })),
  ];
}

describe("atlas-lib layout", () => {
  it("is deterministic: the same data in any order gives the same positions", () => {
    const leaves = fixture();
    const a = layoutAtlas(ATLAS_DEPT_IDS, leaves);
    const b = layoutAtlas(ATLAS_DEPT_IDS, [...leaves].reverse());
    expect([...b.leaves.entries()].sort()).toEqual([...a.leaves.entries()].sort());
    expect(a.leaves.size).toBe(leaves.length);
  });

  it("no two nodes overlap (every pair of dept hubs, branches and leaves)", () => {
    const c = allCircles(layoutAtlas(ATLAS_DEPT_IDS, fixture()));
    const clashes: string[] = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (dist(c[i]!, c[j]!) < c[i]!.r + c[j]!.r) clashes.push(`${c[i]!.id} × ${c[j]!.id}`);
    expect(clashes).toEqual([]);
  });

  it("departments own disjoint wedges and every leaf sits inside its own", () => {
    const leaves = fixture();
    const l = layoutAtlas(ATLAS_DEPT_IDS, leaves);
    const wedges = ATLAS_DEPT_IDS.map((d) => l.depts.get(d)!);
    for (let i = 1; i < wedges.length; i++) expect(wedges[i]!.a0).toBeCloseTo(wedges[i - 1]!.a1, 9);
    expect(wedges[wedges.length - 1]!.a1 - wedges[0]!.a0).toBeCloseTo(Math.PI * 2, 9);
    for (const lf of leaves) {
      const p = l.leaves.get(lf.id)!;
      const w = l.depts.get(lf.dept)!;
      let a = Math.atan2(p.y, p.x);
      while (a < w.a0) a += Math.PI * 2;
      expect(a).toBeLessThan(w.a1);
    }
    expect(l.depts.get("side-projects")).toBeDefined(); // an empty department still has its hub
  });

  it("the most used leaf of a branch sits nearest the centre; size grows with uses and is capped", () => {
    const leaves = [leaf(1, "infra", "skill", 0), leaf(2, "infra", "skill", 90), ...Array.from({ length: 80 }, (_, k) => leaf(10 + k, "infra", "skill", 1))];
    const l = layoutAtlas(ATLAS_DEPT_IDS, leaves);
    const r = (id: string): number => Math.hypot(l.leaves.get(id)!.x, l.leaves.get(id)!.y);
    expect(r(leaves[1]!.id)).toBeLessThanOrEqual(r(leaves[0]!.id));
    expect(leafRadius(0)).toBe(3);
    expect(leafRadius(5)).toBeGreaterThan(leafRadius(1));
    expect(leafRadius(1e9)).toBe(7);
  });

  it("empty data: hubs only, finite bounds", () => {
    const l = layoutAtlas(ATLAS_DEPT_IDS, []);
    expect(l.leaves.size).toBe(0);
    expect(l.depts.size).toBe(9);
    expect(Number.isFinite(l.bounds.w) && l.bounds.w > 0).toBe(true);
  });
});

const NAMES: Record<AtlasDeptId, string> = {
  "acme-website": "ACME website",
  "acme-gtm": "ACME GTM",
  infra: "Infra + Claude",
  rituals: "Rituals",
  "side-projects": "Side projects + legal OSS",
  "build-ship": "Build & ship",
  "research-studio": "Research & studio",
  "brain-vault": "Brain & vault",
  unfiled: "Unfiled",
};

/** Every clash between department labels, and between a label and any circle (hub, branch, leaf). */
function labelClashes(l: AtlasLayout): string[] {
  const boxes = ATLAS_DEPT_IDS.map((d) => ({ id: d, ...labelBox(l.depts.get(d)!, deptLabelLines(NAMES[d])) }));
  const circles = [{ id: "hub", x: 0, y: 0, r: 66 }, ...allCircles(l)];
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) out.push(`label ${a.id} × label ${b.id}`);
    }
    for (const c of circles) {
      const nx = Math.min(Math.max(c.x, a.x0), a.x1);
      const ny = Math.min(Math.max(c.y, a.y0), a.y1);
      if (Math.hypot(c.x - nx, c.y - ny) < c.r) out.push(`label ${a.id} × ${c.id}`);
    }
  }
  return out;
}

describe("atlas-lib layout: 8 departments + Unfiled", () => {
  const lopsided = (sizes: Partial<Record<AtlasDeptId, number>>): AtlasLeaf[] => {
    const out: AtlasLeaf[] = [];
    let i = 0;
    for (const d of ATLAS_DEPT_IDS) for (let k = 0; k < (sizes[d] ?? 0); k++) out.push(leaf(i++, d));
    return out;
  };
  const cases: Record<string, Partial<Record<AtlasDeptId, number>>> = {
    "today's real mix": { "acme-website": 7, "acme-gtm": 20, infra: 34, rituals: 14, "side-projects": 38, "build-ship": 63, "research-studio": 23, "brain-vault": 14, unfiled: 23 },
    "one giant, the rest empty or single": { "build-ship": 236, rituals: 1, unfiled: 1 },
    "everything empty": {},
    "all equal": Object.fromEntries(ATLAS_DEPT_IDS.map((d) => [d, 26])),
  };
  for (const [name, sizes] of Object.entries(cases)) {
    it(`${name}: no circles overlap, no label touches another label or any node`, () => {
      const l = layoutAtlas(ATLAS_DEPT_IDS, lopsided(sizes));
      expect(l.depts.size).toBe(9);
      const c = allCircles(l);
      const clashes: string[] = [];
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (dist(c[i]!, c[j]!) < c[i]!.r + c[j]!.r) clashes.push(`${c[i]!.id} × ${c[j]!.id}`);
      expect(clashes).toEqual([]);
      expect(labelClashes(l)).toEqual([]);
    });
  }

  it("hubs sit on the department ring, branches on theirs, in ATLAS_DEPT_IDS order clockwise from the top", () => {
    const l = layoutAtlas(ATLAS_DEPT_IDS, fixture());
    for (const p of l.depts.values()) expect(Math.hypot(p.x, p.y)).toBeCloseTo(DEPT_RING, 6);
    for (const b of l.branches.values()) expect(Math.hypot(b.x, b.y)).toBeCloseTo(BRANCH_RING, 6);
    const starts = ATLAS_DEPT_IDS.map((d) => l.depts.get(d)!.a0);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("labels wrap at 17 characters and keep + and & with the next word", () => {
    expect(deptLabelLines("Side projects + legal OSS")).toEqual(["Side projects", "+ legal OSS"]);
    expect(deptLabelLines("Research & studio")).toEqual(["Research & studio"]);
    expect(deptLabelLines("Infra + Claude")).toEqual(["Infra + Claude"]);
    expect(deptLabelLines("")).toEqual([]);
    for (const n of Object.values(NAMES)) for (const line of deptLabelLines(n)) expect(line.length, n).toBeLessThanOrEqual(17);
  });
});

describe("atlas-lib picking (review L7: a ≥ 24 px target whatever the dot's size)", () => {
  const leaves = fixture();
  const l = layoutAtlas(ATLAS_DEPT_IDS, leaves);
  const all = (): boolean => true;
  it("picks the nearest leaf within the radius, never a far one", () => {
    const [id, p] = [...l.leaves][7]!;
    expect(pickLeaf(l, p.x + 4, p.y - 3, 12, all)).toBe(id); // 5 world px off a 3–7 px dot
    expect(pickLeaf(l, 0, 0, 12, all)).toBeNull(); // the hub, no leaf near
  });
  it("of two neighbours the nearer wins, and filtered-off leaves are skipped", () => {
    const [a, pa] = [...l.leaves][0]!;
    const [b] = [...l.leaves].filter(([, q]) => q.branch === pa.branch && q !== pa).sort(([, q1], [, q2]) => Math.hypot(q1.x - pa.x, q1.y - pa.y) - Math.hypot(q2.x - pa.x, q2.y - pa.y))[0]!;
    expect(pickLeaf(l, pa.x, pa.y, 30, all)).toBe(a);
    expect(pickLeaf(l, pa.x, pa.y, 30, (id) => id !== a)).toBe(b);
  });
});

describe("atlas-lib pollChain", () => {
  it("a remount during a slow fetch leaves one chain: the second arm replaces the first", () => {
    vi.useFakeTimers();
    try {
      const poll = pollChain({ set: setTimeout, clear: clearTimeout });
      const loads: string[] = [];
      // first mount's slow fetch lands after the remount's: both finish with sources still pending
      poll.arm(() => loads.push("from mount 1"), 10_000);
      poll.arm(() => loads.push("from mount 2"), 10_000);
      vi.advanceTimersByTime(30_000);
      expect(loads).toEqual(["from mount 2"]);
      poll.arm(() => loads.push("again"), 10_000);
      poll.stop(); // unmount
      vi.advanceTimersByTime(30_000);
      expect(loads).toEqual(["from mount 2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("atlas-lib filters and lines", () => {
  const a = leaf(0, "infra", "skill", 3);
  it("search matches name or description; chips and department narrow", () => {
    expect(matchesFilter(a, { query: "DECKS", kinds: [], autonomy: [], dept: null })).toBe(true);
    expect(matchesFilter(a, { query: "zzz", kinds: [], autonomy: [], dept: null })).toBe(false);
    expect(matchesFilter(a, { query: "", kinds: ["agent"], autonomy: [], dept: null })).toBe(false);
    expect(matchesFilter(a, { query: "", kinds: [], autonomy: ["assisted"], dept: "infra" })).toBe(true);
    expect(matchesFilter(a, { query: "", kinds: [], autonomy: [], dept: "rituals" })).toBe(false);
    const unknown = { ...a, autonomy: null };
    expect(matchesFilter(unknown, { query: "", kinds: [], autonomy: [], dept: null })).toBe(true);
    expect(matchesFilter(unknown, { query: "", kinds: [], autonomy: ["manual"], dept: null })).toBe(false);
    expect(autonomyLabel(null)).toBe("Not known yet");
  });

  it("the filed-by line counts each rule; Jev reasons say what Jev saw and the threshold", () => {
    const at = (via: AtlasLeaf["via"], reason = "x"): AtlasLeaf => ({ ...a, via, reason });
    expect(viaLine([at("mention"), at("pack"), at("pack"), at("jev"), at("unfiled")])).toBe("filed by 1 mention · 2 pack · 1 Jev · 1 unfiled");
    expect(viaLine([])).toBe("nothing filed yet");
    expect(reasonLine(at("jev", "Jev 0.84"))).toBe("Jev 0.84 · Jev's pick from the name and description alone; under 0.60 it stays Unfiled");
    expect(reasonLine(at("unfiled", "Jev unsure (0.42)"))).toMatch(/^Jev unsure \(0\.42\) · /);
    expect(reasonLine(at("unfiled", "Jev unavailable"))).toBe("Jev unavailable");
    expect(reasonLine(at("pack", "pack gstack"))).toBe("pack gstack");
  });

  it("stats and uses lines", () => {
    expect(statsLine([a, leaf(1, "infra", "agent"), leaf(2, "infra", "agent")])).toBe("1 skills · 2 agents · 0 routines · 0 CLIs");
    expect(usesLine({ ...a, uses: 0 })).toBe("none recorded");
    expect(usesLine({ ...a, uses: null })).toBe("not read yet: its scan is still running");
    expect(leafRadius(null)).toBe(3);
    expect(usesLine({ ...a, uses: 14, uses30d: 3, lastUsedAt: "2026-09-29T10:00:00Z" })).toBe("14 fires · 3 in 30 days · last 2026-09-29");
  });
});
