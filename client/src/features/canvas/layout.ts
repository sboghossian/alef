// Lane layout for the canvas graph. Deterministic: same graph + same collapsed groups →
// same boxes. Sessions stack by city group (live cities first); every other lane orders its
// cards by the average height of what links to them (barycenter), so edges run mostly
// straight, then stacks them without overlap. Jev + approvals sit on a top rail, routines
// on a bottom rail (after Commandline's lane spine and Side's Flow projection).

import { AUTONOMY_LEVELS, SUBAGENT_AUTONOMY_LEVEL, type AutonomyLevel } from "../../../../shared/autonomy";
import type { CNode, Graph, Lane } from "./graph";
import { LANES } from "./graph";
import type { Rect } from "./view";

export const LANE_W = 268;
export const CARD_W = 220;
export const CARD_H = 58;
/** Skills, MCPs, files, hooks, models, routines: one label line, shorter cards. */
export const SMALL_H = 42;
export const GAP = 10;
export const GROUP_HEAD = 30;
export const RAIL_Y = 0;
export const RAIL_H = 64;
export const LANE_HEAD_Y = RAIL_Y + RAIL_H + 34;
export const LANE_TOP = LANE_HEAD_Y + 58;
const BOTTOM_GAP = 70;
const RAIL_PER_ROW = 8;
const RAIL_FIRST_LANE = 1; // the top rail starts right of the sessions lane (under the HUD)
/** A lane with more cards than this wraps into extra columns (the Files lane on a busy day). */
export const WRAP_AT = 30;
const MAX_COLS = 4;
/** Solo's lane order: the session in the middle, what it thought with on its left (skills,
 *  model, memory, the router), what it did on its right (subagents, tools, files, artifacts).
 *  Nearest the session = most telling, so the first paint (centred on it) shows those. */
const SOLO_ORDER: readonly Lane[] = ["hook", "router", "tiers", "brain", "atlas", "plan", "reason", "prompt", "subagents", "tools", "files", "artifacts"];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LaidNode = CNode & Box;

export interface LaneBand {
  id: Lane;
  title: string;
  hint: string;
  x: number;
  w: number;
  count: number;
  hidden: number;
}

export interface GroupHead extends Box {
  id: string;
  count: number;
  live: number;
  collapsed: boolean;
}

export interface AutonomyBand {
  level: AutonomyLevel;
  title: string;
  hint: string;
  x: number;
  w: number;
  count: number;
  /** Nodes left out of this band by a lane cap upstream (buildGraph's LANE_CAPS) — today only
   *  ever non-zero for level 4, the subagents lane's cap; see layoutAutonomy. */
  hidden: number;
}

export interface Layout {
  nodes: Map<string, LaidNode>;
  lanes: LaneBand[];
  groups: GroupHead[];
  /** y of the top rail and bottom rail bands (bottom = null when there are no routines). */
  rails: { top: number; bottom: number | null };
  bounds: Rect;
  /** Set only by layoutAutonomy: 5 level bands instead of the normal lanes. When present, the
   *  caller renders these headers instead of `lanes`/the rails' "Jev + approvals" label — the
   *  Autonomy layout never places a jev/approval/routine/hook/skill/mcp/file/repo/model/router/
   *  tier node, only "session" and "subagent" ones (the only two kinds shared/autonomy.ts's
   *  autonomyLevel/SUBAGENT_AUTONOMY_LEVEL ever assign a level to). */
  autonomyBands?: AutonomyBand[];
}

export function cardHeight(n: CNode): number {
  // Router + model tiers are full cards: their sub line carries the live counts.
  return n.kind === "session" || n.kind === "subagent" || n.kind === "jev" || n.kind === "approval" || n.kind === "router" || n.kind === "tier" ? CARD_H : SMALL_H;
}

function laneX(i: number): number {
  return i * LANE_W;
}

export function layoutGraph(g: Graph, collapsed: ReadonlySet<string>): Layout {
  const nodes = new Map<string, LaidNode>();
  const lanes: LaneBand[] = [];
  const groups: GroupHead[] = [];
  const neighbors = new Map<string, string[]>();
  for (const e of g.edges) {
    (neighbors.get(e.to) ?? neighbors.set(e.to, []).get(e.to))?.push(e.from);
    (neighbors.get(e.from) ?? neighbors.set(e.from, []).get(e.from))?.push(e.to);
  }
  const byPlace = new Map<string, CNode[]>();
  for (const n of g.nodes) (byPlace.get(n.place) ?? byPlace.set(n.place, []).get(n.place))?.push(n);

  // Which lanes take room, how wide, and where. Lanes fed by optional endpoints (Atlas,
  // Artifacts) take none until they have a card; in solo no empty lane does.
  const colsOf = (id: Lane, n: number): number => (id === "prompt" ? 1 : Math.min(MAX_COLS, Math.max(1, Math.ceil(n / WRAP_AT))));
  const present = LANES.filter((l) => (byPlace.get(l.id)?.length ?? 0) > 0 || (!g.solo && l.id !== "atlas" && l.id !== "artifacts"));
  const leftOf = new Map<Lane, number>();
  let laneLeft = 0;
  for (const id of g.solo ? SOLO_ORDER : LANES.map((l) => l.id)) {
    if (!present.some((l) => l.id === id)) continue;
    leftOf.set(id, laneLeft);
    laneLeft += LANE_W * colsOf(id, byPlace.get(id)?.length ?? 0);
  }

  let maxBottom = LANE_TOP;
  // Placed in LANES order whatever the x order: the barycenter needs the sessions placed first.
  present.forEach((lane) => {
    const list = byPlace.get(lane.id) ?? [];
    const cols = colsOf(lane.id, list.length);
    const left = leftOf.get(lane.id) ?? 0;
    const x = left + (LANE_W - CARD_W) / 2;
    lanes.push({ id: lane.id, title: lane.title, hint: lane.hint, x: left, w: LANE_W * cols, count: list.filter((n) => n.kind !== "more").length, hidden: g.hidden[lane.id] ?? 0 });
    let y = LANE_TOP;

    if (lane.id === "prompt") {
      const byGroup = new Map<string, CNode[]>();
      for (const n of list) (byGroup.get(n.group ?? "") ?? byGroup.set(n.group ?? "", []).get(n.group ?? ""))?.push(n);
      const ordered = [...byGroup].map(([id, members]) => {
        members.sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at || (a.id < b.id ? -1 : 1));
        return { id, members, live: members.filter((m) => m.live).length, at: Math.max(...members.map((m) => m.at)) };
      });
      ordered.sort((a, b) => Number(b.live > 0) - Number(a.live > 0) || b.at - a.at || (a.id < b.id ? -1 : 1));
      for (const grp of ordered) {
        const isCollapsed = collapsed.has(grp.id);
        groups.push({ id: grp.id, x, y, w: CARD_W, h: GROUP_HEAD, count: grp.members.length, live: grp.live, collapsed: isCollapsed });
        y += GROUP_HEAD + 4;
        if (!isCollapsed) {
          for (const n of grp.members) {
            nodes.set(n.id, { ...n, x, y, w: CARD_W, h: CARD_H });
            y += CARD_H + GAP;
          }
        }
        y += 8;
      }
    } else {
      // Barycenter of already-placed neighbours (same-lane parents resolve recursively).
      const memo = new Map<string, number>();
      const inLane = new Set(list.map((n) => n.id));
      const target = (id: string, depth: number): number => {
        const cached = memo.get(id);
        if (cached !== undefined) return cached;
        let sum = 0;
        let cnt = 0;
        for (const nb of neighbors.get(id) ?? []) {
          const placed = nodes.get(nb);
          if (placed) {
            sum += placed.y + placed.h / 2;
            cnt += 1;
          } else if (inLane.has(nb) && depth < 6) {
            const t = target(nb, depth + 1);
            if (Number.isFinite(t)) {
              sum += t + 1; // just below its parent
              cnt += 1;
            }
          }
        }
        const v = cnt ? sum / cnt : Number.POSITIVE_INFINITY;
        memo.set(id, v);
        return v;
      };
      // A lane's "+N more" card always closes the lane.
      const sorted = [...list].sort((a, b) => Number(a.kind === "more") - Number(b.kind === "more") || target(a.id, 0) - target(b.id, 0) || b.weight - a.weight || (a.id < b.id ? -1 : 1));
      // Row-major across `cols` columns; a row starts no higher than its first card's target.
      for (let i = 0; i < sorted.length; i += cols) {
        const row = sorted.slice(i, i + cols);
        const first = row[0];
        if (!first) continue;
        const t = target(first.id, 0);
        const hh = Math.max(...row.map(cardHeight));
        const want = Number.isFinite(t) ? t - hh / 2 : y;
        y = Math.max(y, want);
        row.forEach((n, c) => nodes.set(n.id, { ...n, x: x + c * LANE_W, y, w: CARD_W, h: cardHeight(n) }));
        y += hh + GAP;
      }
    }
    maxBottom = Math.max(maxBottom, y);
  });

  lanes.sort((a, b) => a.x - b.x); // solo places lanes out of LANES order; bands alternate by x
  // Rails.
  const top = byPlace.get("top") ?? [];
  top.sort((a, b) => (a.kind === "jev" ? -1 : b.kind === "jev" ? 1 : a.id < b.id ? -1 : 1));
  // Solo: the rail starts over the session's lane (its approvals sit right above it).
  const railLeft = g.solo ? (leftOf.get("prompt") ?? 0) : laneX(RAIL_FIRST_LANE);
  top.forEach((n, i) => nodes.set(n.id, { ...n, x: railLeft + laneX(i) + (LANE_W - CARD_W) / 2, y: RAIL_Y, w: CARD_W, h: RAIL_H - 6 }));
  const bottom = byPlace.get("bottom") ?? [];
  const bottomY = maxBottom + BOTTOM_GAP;
  bottom.forEach((n, i) => {
    const row = Math.floor(i / RAIL_PER_ROW);
    nodes.set(n.id, { ...n, x: laneX(i % RAIL_PER_ROW) + (LANE_W - CARD_W) / 2, y: bottomY + row * (SMALL_H + GAP), w: CARD_W, h: SMALL_H });
  });
  const lastRow = bottom.length ? Math.ceil(bottom.length / RAIL_PER_ROW) : 0;
  const height = (bottom.length ? bottomY + lastRow * (SMALL_H + GAP) : maxBottom) - RAIL_Y;
  return {
    nodes,
    lanes,
    groups,
    rails: { top: RAIL_Y, bottom: bottom.length ? bottomY : null },
    bounds: { x: -20, y: RAIL_Y - 20, w: laneLeft + 40, h: height + 40 },
  };
}

export type AutonomyYMode = "recency" | "district";

function cmpNodeId(a: CNode, b: CNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sorts `list` newest-first and stacks it top-down, wrapped into `cols` columns (same row-major
 *  fill layoutGraph's non-prompt lanes use, minus the barycenter target: the Autonomy axis has no
 *  "straighten the edges" goal, just "newest on top"). Mutates `nodes`; returns the y past the
 *  last row. */
function placeByRecency(nodes: Map<string, LaidNode>, list: readonly CNode[], x: number, yStart: number, cols: number): number {
  const sorted = [...list].sort((a, b) => b.at - a.at || cmpNodeId(a, b));
  let y = yStart;
  for (let i = 0; i < sorted.length; i += cols) {
    const row = sorted.slice(i, i + cols);
    const hh = Math.max(...row.map(cardHeight));
    row.forEach((n, c) => nodes.set(n.id, { ...withAutonomyReason(n), x: x + c * LANE_W, y, w: CARD_W, h: cardHeight(n) }));
    y += hh + GAP;
  }
  return y;
}

/** Appends the classifier's own reason to the card's existing sub-line (never bluff: showing why
 *  a node landed on its level is close to free once shared/autonomy.ts computed it). */
function withAutonomyReason(n: CNode): CNode {
  return n.autonomyReason ? { ...n, sub: `${n.sub} · ${n.autonomyReason}` } : n;
}

/**
 * The Autonomy layout: 5 fixed level bands left → right (shared/autonomy.ts's AUTONOMY_LEVELS),
 * holding only "session" and "subagent" nodes (the only kinds a CNode.autonomy is ever set on —
 * see graph.ts). Everything else buildGraph produces (hooks, skills, MCPs, files, models, Jev,
 * approvals, routines, the router/tier cards) is left out of `nodes` entirely: the caller's edge
 * drawing already skips any edge whose endpoint isn't in `nodes` (CanvasView.relayout), so those
 * edges simply don't appear in this mode — nothing extra to filter.
 *
 * `yMode`:
 *   - "recency": newest activity on top, wrapped into extra columns past WRAP_AT cards (same rule
 *     layoutGraph's crowded lanes use).
 *   - "district": session nodes are grouped by city (their `group`, i.e. islandId) exactly like
 *     layoutGraph's Prompt lane — same GroupHead shape, same `collapsed` set, so a city collapsed
 *     in the normal graph view stays collapsed here too. Subagent nodes have no city of their own
 *     (their `group` is their parent session's id, not a place) and always trail, ungrouped, in
 *     recency order, after that level's city groups.
 */
export function layoutAutonomy(g: Graph, collapsed: ReadonlySet<string>, yMode: AutonomyYMode): Layout {
  const nodes = new Map<string, LaidNode>();
  const groups: GroupHead[] = [];
  const bands: AutonomyBand[] = [];

  const byLevel = new Map<AutonomyLevel, CNode[]>();
  for (const n of g.nodes) {
    if (n.autonomy === undefined) continue;
    (byLevel.get(n.autonomy) ?? byLevel.set(n.autonomy, []).get(n.autonomy))?.push(n);
  }

  let laneLeft = 0;
  let maxBottom = LANE_TOP;
  for (const meta of AUTONOMY_LEVELS) {
    const list = byLevel.get(meta.level) ?? [];
    // District mode always stacks a city's sessions in a single column (below, mirroring
    // layoutGraph's Prompt lane, which forces cols=1 for the same reason); only `trailing`
    // (ungrouped subagents/non-session cards) ever wraps into extra columns there. Basing `cols`
    // on the whole list — sessions included — made the band far wider than what was actually laid
    // out: ~190 level-1 sessions with 0 trailing cards computed 4 columns while every card still
    // rendered in column 1, leaving 3 columns empty (GRO review finding).
    const bySession = yMode === "district" ? list.filter((n) => n.kind === "session") : [];
    const trailing = yMode === "district" ? list.filter((n) => n.kind !== "session") : list;
    const colsBasis = yMode === "district" ? trailing.length : list.length;
    const cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(colsBasis / WRAP_AT)));
    const x = laneLeft + (LANE_W - CARD_W) / 2;
    // Only the subagents lane is ever capped among what this layout places (buildGraph's
    // LANE_CAPS), and every subagent is unconditionally SUBAGENT_AUTONOMY_LEVEL — so a hidden
    // count only ever belongs to that one band (GRO review finding: level 4's header showed the
    // capped count with no "+N hidden", unlike layoutGraph's lane headers).
    const hidden = meta.level === SUBAGENT_AUTONOMY_LEVEL ? (g.hidden.subagents ?? 0) : 0;
    bands.push({ level: meta.level, title: meta.title, hint: meta.hint, x: laneLeft, w: LANE_W * cols, count: list.length, hidden });
    let y = LANE_TOP;

    if (yMode === "district") {
      const byGroup = new Map<string, CNode[]>();
      for (const n of bySession) (byGroup.get(n.group ?? "") ?? byGroup.set(n.group ?? "", []).get(n.group ?? ""))?.push(n);
      const ordered = [...byGroup].map(([id, members]) => {
        members.sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at || cmpNodeId(a, b));
        return { id, members, live: members.filter((m) => m.live).length, at: Math.max(...members.map((m) => m.at)) };
      });
      ordered.sort((a, b) => Number(b.live > 0) - Number(a.live > 0) || b.at - a.at || (a.id < b.id ? -1 : 1));
      for (const grp of ordered) {
        const isCollapsed = collapsed.has(grp.id);
        groups.push({ id: grp.id, x, y, w: CARD_W, h: GROUP_HEAD, count: grp.members.length, live: grp.live, collapsed: isCollapsed });
        y += GROUP_HEAD + 4;
        if (!isCollapsed) {
          for (const n of grp.members) {
            nodes.set(n.id, { ...withAutonomyReason(n), x, y, w: CARD_W, h: cardHeight(n) });
            y += cardHeight(n) + GAP;
          }
        }
        y += 8;
      }
      y = placeByRecency(nodes, trailing, x, y, cols);
    } else {
      y = placeByRecency(nodes, trailing, x, y, cols);
    }

    laneLeft += LANE_W * cols;
    maxBottom = Math.max(maxBottom, y);
  }

  return {
    nodes,
    lanes: [],
    groups,
    rails: { top: RAIL_Y, bottom: null },
    bounds: { x: -20, y: RAIL_Y - 20, w: laneLeft + 40, h: maxBottom - RAIL_Y + 40 },
    autonomyBands: bands,
  };
}

export interface ListGroup {
  id: string;
  title: string;
  nodes: LaidNode[];
}

/**
 * Groups an already-laid-out node map for the phone list fallback (canvas.ts's renderList — no
 * canvas to pan/zoom on a phone, so it's the same nodes as a flat, scrollable list instead). Mirrors
 * whatever grouping the desktop view is actually showing:
 *   - a layoutAutonomy() layout (`bounds.autonomyBands` set) groups by autonomy band, left→right in
 *     AUTONOMY_LEVELS' own order and titles;
 *   - a layoutGraph() layout groups by lane, in the same top-rail → LANES → bottom-rail order the
 *     desktop lane headers use.
 * Before this, the list always grouped by lane even in Autonomy mode, so "Prompt · Sessions" and
 * "Subagents" were the only headers a phone ever saw — the autonomy axis was invisible there except
 * in each card's own sub-line (GRO review finding). Empty groups are dropped either way, same as
 * the desktop lanes only show a header when something occupies them.
 */
export function listGroups(layout: Layout): ListGroup[] {
  const nodes = [...layout.nodes.values()];
  const sortedIn = (list: LaidNode[]): LaidNode[] => list.sort((a, b) => a.y - b.y || a.x - b.x);
  if (layout.autonomyBands) {
    return layout.autonomyBands
      .map((band) => ({ id: String(band.level), title: band.title, nodes: sortedIn(nodes.filter((n) => n.autonomy === band.level)) }))
      .filter((grp) => grp.nodes.length > 0);
  }
  const places: Array<{ id: string; title: string }> = [{ id: "top", title: "Jev + approvals" }, ...LANES.map((l) => ({ id: l.id, title: l.title })), { id: "bottom", title: "Routines" }];
  return places.map((p) => ({ id: p.id, title: p.title, nodes: sortedIn(nodes.filter((n) => n.place === p.id)) })).filter((grp) => grp.nodes.length > 0);
}

/** Cubic bezier control points between two boxes: side-to-side when mostly horizontal,
 *  top-to-bottom otherwise (rails). */
export function edgeCurve(a: Box, b: Box): [number, number, number, number, number, number, number, number] {
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const acy = a.y + a.h / 2;
  const bcy = b.y + b.h / 2;
  if (Math.abs(bcx - acx) >= Math.abs(bcy - acy) * 0.6 && Math.abs(bcx - acx) > a.w / 2) {
    const fwd = bcx >= acx;
    const x1 = fwd ? a.x + a.w : a.x;
    const x2 = fwd ? b.x : b.x + b.w;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.45) * (fwd ? 1 : -1);
    return [x1, acy, x1 + dx, acy, x2 - dx, bcy, x2, bcy];
  }
  const down = bcy >= acy;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y : b.y + b.h;
  const dy = Math.max(30, Math.abs(y2 - y1) * 0.45) * (down ? 1 : -1);
  return [acx, y1, acx, y1 + dy, bcx, y2 - dy, bcx, y2];
}

export function bezierPoint(c: readonly number[], t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * (c[0] ?? 0) + b * (c[2] ?? 0) + d * (c[4] ?? 0) + e * (c[6] ?? 0),
    y: a * (c[1] ?? 0) + b * (c[3] ?? 0) + d * (c[5] ?? 0) + e * (c[7] ?? 0),
  };
}
