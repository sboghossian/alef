// Pure layout + filtering for the 🗺️ Atlas view (atlas.ts). No DOM, unit-tested in atlas-lib.test.ts.
//
// Radial layout, deterministic (a function of the data only, leaves sorted before placing):
//   the 🧠 hub at (0, 0) → one department hub per department (8 + Unfiled) on DEPT_RING, each
//   owning a wedge of the circle (a minimum so neither hubs nor their labels touch, the rest
//   ∝ √leaves) → inside that wedge one branch node per kind on BRANCH_RING, each owning a
//   sub-wedge → its leaves on arcs from LEAF_RING outward, most used nearest the centre. Wedges
//   never share an angle and every leaf keeps half a slot from its wedge's edges, so no two
//   departments (or branches) overlap. A hub's label sits under it, wrapped to LABEL_MAX_CHARS.

import { ATLAS_JEV_MIN_CONFIDENCE, ATLAS_KINDS, ATLAS_VIA, type AtlasAutonomy, type AtlasDeptId, type AtlasKind, type AtlasLeaf, type AtlasVia } from "../../../shared/features/atlas";

export const DEPT_COLORS: Readonly<Record<AtlasDeptId, string>> = {
  "acme-website": "#2e9bff",
  "acme-gtm": "#ff4f8b",
  infra: "#8b5cf6",
  rituals: "#ff9f1c",
  "side-projects": "#16b98a",
  "build-ship": "#f2462f",
  "research-studio": "#00b4c8",
  "brain-vault": "#7cbf1b",
  unfiled: "#8a8f98",
};
export const GOLD = "#f5b700";
export const KIND_META: Readonly<Record<AtlasKind, { label: string; emoji: string; verb: string }>> = {
  skill: { label: "skills", emoji: "✨", verb: "fires" },
  agent: { label: "agents", emoji: "🤖", verb: "spawns" },
  routine: { label: "routines", emoji: "⏰", verb: "runs" },
  cli: { label: "CLIs", emoji: "⌨️", verb: "runs" },
};
export const AUTONOMY_META: Readonly<Record<AtlasAutonomy, { label: string; hint: string }>> = {
  autonomous: { label: "Autonomous", hint: "something schedules it" },
  assisted: { label: "Assisted", hint: "used in sessions in the last 30 days" },
  manual: { label: "Manual", hint: "never used lately, a candidate or in the graveyard" },
};

export const HUB_R = 66;
export const DEPT_RING = 300;
export const DEPT_R = 42;
export const BRANCH_RING = 420;
export const BRANCH_R = 15;
export const LEAF_RING = 470;
/** A department label: lines of at most this many characters, each LABEL_LINE px tall, the first
 *  centred LABEL_Y below the hub's centre; LABEL_CHAR px per character bounds its width. */
export const LABEL_MAX_CHARS = 17;
export const LABEL_Y = DEPT_R + 16;
export const LABEL_LINE = 16;
export const LABEL_CHAR = 8;
export const ROW = 18;
export const SLOT = 18;
export const LEAF_MAX_R = 7;

export interface Pt {
  x: number;
  y: number;
  r: number;
}
export interface Wedge {
  a0: number;
  a1: number;
}
export interface AtlasLayout {
  depts: Map<AtlasDeptId, Pt & Wedge>;
  /** Keyed `${dept}/${kind}`. */
  branches: Map<string, Pt & Wedge & { dept: AtlasDeptId; kind: AtlasKind }>;
  leaves: Map<string, Pt & { branch: string }>;
  bounds: { x: number; y: number; w: number; h: number };
}

/** Leaf size from its uses: 3 px for none (or unknown), growing with log2, capped so slots never collide. */
export function leafRadius(uses: number | null): number {
  return Math.min(LEAF_MAX_R, 3 + Math.log2(1 + Math.max(0, uses ?? 0)) * 0.62);
}

const polar = (r: number, a: number): { x: number; y: number } => ({ x: Math.cos(a) * r, y: Math.sin(a) * r });

/** A department's label as lines: whole words, at most LABEL_MAX_CHARS each, a "+" or "&" kept
 *  with the word after it ("Side projects" / "+ legal OSS"); a longer word keeps its own line. */
export function deptLabelLines(name: string): string[] {
  const words: string[] = [];
  for (const w of name.split(/\s+/).filter(Boolean)) {
    const prev = words[words.length - 1];
    if (prev === "+" || prev === "&") words[words.length - 1] = `${prev} ${w}`;
    else words.push(w);
  }
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= LABEL_MAX_CHARS) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

/** The box a department label covers, in world units (for overlap checks). */
export function labelBox(hub: { x: number; y: number }, lines: readonly string[]): { x0: number; y0: number; x1: number; y1: number } {
  const half = (Math.max(0, ...lines.map((l) => l.length)) * LABEL_CHAR) / 2;
  const top = hub.y + LABEL_Y - LABEL_LINE / 2;
  return { x0: hub.x - half, y0: top, x1: hub.x + half, y1: top + lines.length * LABEL_LINE };
}

/** Splits [a0, a1] into consecutive spans: each gets `min`, the rest shared by `weights`. */
function split(a0: number, a1: number, weights: readonly number[], min: number): Wedge[] {
  const free = Math.max(0, a1 - a0 - min * weights.length);
  const sum = weights.reduce((s, w) => s + w, 0);
  let at = a0;
  return weights.map((w) => {
    const span = min + (sum > 0 ? (free * w) / sum : free / weights.length);
    const out = { a0: at, a1: at + span };
    at += span;
    return out;
  });
}

export function layoutAtlas(deptIds: readonly AtlasDeptId[], leaves: readonly AtlasLeaf[]): AtlasLayout {
  const minBranch = 2 * Math.asin((BRANCH_R + 4) / BRANCH_RING);
  // Neighbouring hubs keep their circles apart AND their labels: two labels under hubs a chord
  // apart can't meet when the chord beats the widest label plus its two lines' height.
  const labelGap = Math.hypot(LABEL_MAX_CHARS * LABEL_CHAR + 12, 2 * LABEL_LINE) / 2;
  const minDept = Math.max(2 * Math.asin((DEPT_R + 18) / DEPT_RING), 2 * Math.asin(labelGap / DEPT_RING), ATLAS_KINDS.length * minBranch);
  const byDept = new Map(deptIds.map((d) => [d, leaves.filter((l) => l.dept === d)]));
  const out: AtlasLayout = { depts: new Map(), branches: new Map(), leaves: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  let reach = HUB_R;
  const start = -Math.PI / 2;
  const wedges = split(start, start + Math.PI * 2, deptIds.map((d) => Math.sqrt(byDept.get(d)?.length ?? 0)), minDept);
  deptIds.forEach((dept, i) => {
    const w = wedges[i]!;
    out.depts.set(dept, { ...polar(DEPT_RING, (w.a0 + w.a1) / 2), r: DEPT_R, ...w });
    reach = Math.max(reach, DEPT_RING + DEPT_R);
    const mine = byDept.get(dept) ?? [];
    const kinds = ATLAS_KINDS.filter((k) => mine.some((l) => l.kind === k));
    const subs = split(w.a0, w.a1, kinds.map((k) => mine.filter((l) => l.kind === k).length), minBranch);
    kinds.forEach((kind, j) => {
      const s = subs[j]!;
      const key = `${dept}/${kind}`;
      out.branches.set(key, { ...polar(BRANCH_RING, (s.a0 + s.a1) / 2), r: BRANCH_R, ...s, dept, kind });
      const list = mine.filter((l) => l.kind === kind).sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0) || a.id.localeCompare(b.id));
      const span = s.a1 - s.a0;
      let row = 0;
      let placed = 0;
      while (placed < list.length) {
        const r = LEAF_RING + row * ROW;
        const cap = Math.max(1, Math.floor((span * r) / SLOT));
        const n = Math.min(cap, list.length - placed);
        const step = span / cap;
        const offset = s.a0 + ((cap - n) / 2 + 0.5) * step;
        for (let k = 0; k < n; k++) {
          const leaf = list[placed + k]!;
          out.leaves.set(leaf.id, { ...polar(r, offset + k * step), r: leafRadius(leaf.uses), branch: key });
        }
        reach = Math.max(reach, r + LEAF_MAX_R);
        placed += n;
        row += 1;
      }
    });
  });
  const pad = 24; // a margin round the outermost leaves
  out.bounds = { x: -reach - pad, y: -reach - pad, w: (reach + pad) * 2, h: (reach + pad) * 2 };
  return out;
}

export interface AtlasFilter {
  query: string;
  kinds: readonly string[];
  autonomy: readonly string[];
  dept: string | null;
}

export function matchesFilter(leaf: AtlasLeaf, f: AtlasFilter): boolean {
  const q = f.query.trim().toLowerCase();
  if (q && !leaf.name.toLowerCase().includes(q) && !leaf.description.toLowerCase().includes(q)) return false;
  if (f.kinds.length && !f.kinds.includes(leaf.kind)) return false;
  if (f.autonomy.length && (leaf.autonomy === null || !f.autonomy.includes(leaf.autonomy))) return false;
  return !f.dept || leaf.dept === f.dept;
}

/** The rung's words; null = launchd's load state wasn't readable, so unknown. */
export function autonomyLabel(a: AtlasAutonomy | null): string {
  return a ? AUTONOMY_META[a].label : "Not known yet";
}

/** The leaf nearest world point (wx, wy) within `maxDist` world units (a finger-sized target
 *  whatever the dot's size), among the ids `shown` allows; null when none is that close. */
export function pickLeaf(layout: AtlasLayout, wx: number, wy: number, maxDist: number, shown: (id: string) => boolean): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, p] of layout.leaves) {
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d <= Math.max(maxDist, p.r) && d < bestD && shown(id)) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/** One poll chain: arm() replaces the pending timer (a remount during a slow fetch must not start
 *  a second chain), stop() cancels it. The clock is injectable for tests. */
/** Defaults are arrows: a bare setTimeout called as timers.set() throws "Illegal invocation" in a browser. */
export function pollChain(timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }): { arm(fn: () => void, ms: number): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    arm(fn, ms) {
      stop();
      timer = timers.set(() => {
        timer = null;
        fn();
      }, ms);
    },
    stop,
  };
}

/** "12 skills · 3 agents · 18 routines · 3 CLIs". */
export function statsLine(leaves: readonly AtlasLeaf[]): string {
  return ATLAS_KINDS.map((k) => `${leaves.filter((l) => l.kind === k).length} ${KIND_META[k].label}`).join(" · ");
}

/** "14 fires · 3 in 30 days · last 2026-09-29", or "none recorded". */
export function usesLine(leaf: AtlasLeaf): string {
  if (leaf.uses === null) return "not read yet: its scan is still running";
  if (leaf.uses === 0) return "none recorded";
  const last = leaf.lastUsedAt ? ` · last ${leaf.lastUsedAt.slice(0, 10)}` : "";
  return `${leaf.uses} ${KIND_META[leaf.kind].verb} · ${leaf.uses30d} in 30 days${last}`;
}

export const VIA_LABEL: Readonly<Record<AtlasVia, string>> = { override: "override", mention: "mention", ritual: "ritual", yield: "Infra yield", pack: "pack", keyword: "keyword", jev: "Jev", unfiled: "unfiled" };

/** "filed by 32 mention · 3 ritual · 67 pack · 111 keyword · 12 Jev · 11 unfiled" (empty kinds left out). */
export function viaLine(leaves: readonly AtlasLeaf[]): string {
  const parts = ATLAS_VIA.map((v) => [v, leaves.filter((l) => l.via === v).length] as const).filter(([, n]) => n > 0);
  return parts.length ? `filed by ${parts.map(([v, n]) => `${n} ${VIA_LABEL[v]}`).join(" · ")}` : "nothing filed yet";
}

/** The panel's words for why a leaf sits where it does; a Jev reason says what Jev was shown. */
export function reasonLine(leaf: Pick<AtlasLeaf, "reason" | "via">): string {
  if (leaf.via === "jev" || /^Jev (unsure|\d)/.test(leaf.reason)) return `${leaf.reason} · Jev's pick from the name and description alone; under ${ATLAS_JEV_MIN_CONFIDENCE.toFixed(2)} it stays Unfiled`;
  return leaf.reason;
}
