// The orchestration graph behind the canvas view: real sessions, subagents, skills, MCPs,
// hooks, memory files, models, files and repos, plus Jev / approvals / routines rails.
// Pure (no DOM): the same inputs always give the same nodes and edges.
//
// Lanes, left → right: Prompt/Sessions → Hook → Jev router → Model tier → Brain → Plan/Skill →
// Reason → Tools & MCPs → Atlas department → Subagents → Files/Repos → Artifacts. (Router + Model tier came over from the removed
// System view in round 11: the router hook's install state, and live/in-view/all counts per tier.) Edge kinds: spawned (session → subagent), uses (→ skill, MCP,
// model), touched (→ file / repo / memory), decided (Jev → agents), awaits (approval → agent).

import { autonomyLevel, SUBAGENT_AUTONOMY_LEVEL, SUBAGENT_AUTONOMY_REASON, type AutonomyLevel } from "../../../../shared/autonomy";
import type { SubagentRecord } from "../../../../shared/features/subagents";
import { subagentNodeId } from "../../../../shared/features/subagents";
import type { Island, JevDecision, WorldAgent, WorldEdge, WorldObject } from "../../../../shared/types";
import { shortModel } from "../subagent-data";
import { FAMILY_LABELS, PLANT_FAMILIES, hookGates, isPlantFamily, modelFamilyOf, routerHookState, type ModelFamily } from "../system-places-lib";
import { agentTitle } from "../../../../shared/display";
import type { ArtifactItem } from "../../../../shared/features/artifacts";
import type { AtlasDept, AtlasLeaf } from "../../../../shared/features/atlas";
import type { RouteCardSummary } from "../../../../shared/features/router";

export type Lane = "prompt" | "hook" | "router" | "tiers" | "brain" | "plan" | "reason" | "tools" | "subagents" | "files" | "atlas" | "artifacts";
export type Place = Lane | "top" | "bottom";

export const LANES: ReadonlyArray<{ id: Lane; title: string; hint: string }> = [
  { id: "prompt", title: "Prompt · Sessions", hint: "every Claude Code session, grouped by city" },
  { id: "hook", title: "Hook", hint: "hooks that fire on each prompt" },
  { id: "router", title: "Jev router", hint: "advises a model tier for each prompt" },
  { id: "tiers", title: "Model tier", hint: "sessions per model family: live · in view · all" },
  { id: "brain", title: "Brain", hint: "memory and vault files it read" },
  { id: "plan", title: "Plan · Skill", hint: "skills it invoked" },
  { id: "reason", title: "Reason", hint: "the model doing the thinking" },
  { id: "tools", title: "Tools & MCPs", hint: "MCP servers it called" },
  { id: "atlas", title: "Atlas · Departments", hint: "the capability departments its skills belong to" },
  { id: "subagents", title: "Subagents", hint: "spawned with the Agent tool" },
  { id: "files", title: "Files · Repos", hint: "what it read and wrote (persist)" },
  { id: "artifacts", title: "Artifacts", hint: "pages it published with the Artifact tool" },
];

export type NodeKind = "session" | "hook" | "router" | "tier" | "brain" | "skill" | "model" | "mcp" | "subagent" | "file" | "repo" | "jev" | "approval" | "routine" | "dept" | "artifact" | "more";
export type CEdgeKind = "spawned" | "uses" | "touched" | "decided" | "awaits";
export const EDGE_KINDS: readonly CEdgeKind[] = ["spawned", "uses", "touched", "decided", "awaits"];

export interface CNode {
  id: string;
  kind: NodeKind;
  place: Place;
  label: string;
  sub: string;
  /** Sessions: their city id. Subagents: their parent session. */
  group: string | null;
  live: boolean;
  status: string | null;
  at: number; // ms, latest activity (0 = unknown)
  weight: number;
  /** Where this node sits on the Autonomy axis (client/src/features/canvas/layout.ts's
   *  layoutAutonomy), set only for "session" (shared/autonomy.ts's autonomyLevel) and "subagent"
   *  (always SUBAGENT_AUTONOMY_LEVEL) nodes — undefined for everything else, which the Autonomy
   *  layout mode leaves out entirely. */
  autonomy?: AutonomyLevel;
  autonomyReason?: string;
}

export interface CEdge {
  id: string;
  from: string;
  to: string;
  kind: CEdgeKind;
  weight: number;
}

export interface ApprovalLite {
  id: string;
  agentId: string;
  toolName: string;
  title: string;
}

export interface RoutineLite {
  label: string;
  shortName: string;
  running: boolean;
  lastExitStatus: number | null;
}

export interface GraphInput {
  agents: readonly WorldAgent[];
  objects: ReadonlyMap<string, WorldObject>;
  edges: readonly WorldEdge[];
  islands: ReadonlyMap<string, Island>;
  subagents: readonly SubagentRecord[];
  decisions: readonly JevDecision[];
  jevStatus: string;
  /** What the router has actually decided (extras["router.cards"]), or null when the hook
   *  has never written its log. Without it the router lane can only show install state. */
  routeCards?: RouteCardSummary | null;
  approvals: readonly ApprovalLite[];
  routines: readonly RoutineLite[];
  /** GET /api/artifacts items; absent / empty hides the Artifacts lane. */
  artifacts?: readonly ArtifactItem[];
  /** GET /api/atlas departments + leaves; absent hides the Atlas lane. */
  atlas?: { departments: readonly AtlasDept[]; leaves: readonly AtlasLeaf[] };
}

export interface GraphFilter {
  scope: "today" | "all";
  /** Only sessions of this city. */
  city: string | null;
  /** Only this session and everything it touched / spawned. */
  tree: string | null;
  /** Solo: ONLY this session's footprint. Stronger than tree: ignores `keep` and the time scope,
   *  and leaves out everything that has no link to it (hooks, routines). */
  solo?: string | null;
  /** Solo only: lanes the user opened past SOLO_CAP (clicked their "+N more" card). */
  expand?: ReadonlySet<Lane>;
  /** Always shown, even outside the scope (the shared selection). */
  keep: string | null;
  nowMs: number;
}

export interface Graph {
  nodes: CNode[];
  edges: CEdge[];
  /** Nodes left out of a lane by its cap. */
  hidden: Partial<Record<Lane, number>>;
  /** Set in solo: layoutGraph then centres the lanes on this session (layout.ts). */
  solo?: string | null;
}

export const LANE_CAPS: Record<Lane, number> = {
  prompt: 600,
  hook: 24,
  router: 1,
  tiers: 5,
  brain: 30,
  plan: 40,
  reason: 12,
  tools: 30,
  subagents: 400,
  files: 90,
  atlas: 9,
  artifacts: 40,
};

/** Solo shows at most this many cards per lane (plus a "+N more" card that opens the lane), so
 *  one busy session still reads at first paint instead of zooming out to coloured blocks. */
export const SOLO_CAP = 10;

const MEMORY_RE = /\/\.claude\/projects\/[^/]+\/memory\/|\/Documents\/Code\/alex_claude\//;

export function isMemoryPath(path: string): boolean {
  return MEMORY_RE.test(path);
}

export function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function modelNodeId(model: string | null): string | null {
  return model ? `model:${shortModel(model)}` : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Object id → canvas lane/kind for a target of a `uses`/`touched` edge. */
function objectPlace(id: string, obj: WorldObject | undefined): { kind: NodeKind; place: Lane } | null {
  const kind = obj?.kind ?? (id.split(":")[0] as WorldObject["kind"] | undefined);
  if (kind === "skill") return { kind: "skill", place: "plan" };
  if (kind === "mcp") return { kind: "mcp", place: "tools" };
  if (kind === "hook") return { kind: "hook", place: "hook" };
  if (kind === "repo") return { kind: "repo", place: "files" };
  if (kind === "file") return isMemoryPath(id.slice(5)) ? { kind: "brain", place: "brain" } : { kind: "file", place: "files" };
  return null;
}

function objectLabel(id: string, obj: WorldObject | undefined): string {
  if (obj) return obj.name;
  const rest = id.slice(id.indexOf(":") + 1);
  return id.startsWith("file:") || id.startsWith("repo:") ? basename(rest) : rest;
}

export function buildGraph(input: GraphInput, filter: GraphFilter): Graph {
  const midnight = localMidnight(filter.nowMs);
  const solo = filter.solo ?? null;
  const only = solo ?? filter.tree; // one session's footprint (tree keeps the shared selection too)
  const capOf = (lane: Lane): number => (solo && !filter.expand?.has(lane) ? Math.min(SOLO_CAP, LANE_CAPS[lane]) : LANE_CAPS[lane]);
  const nodes = new Map<string, CNode>();
  const edges = new Map<string, CEdge>();
  const addEdge = (from: string, to: string, kind: CEdgeKind, weight = 1): void => {
    const id = `${kind}|${from}|${to}`;
    const e = edges.get(id);
    if (e) e.weight += weight;
    else edges.set(id, { id, from, to, kind, weight });
  };

  // ---- sessions (Prompt lane) ----
  const inScope = (a: WorldAgent): boolean => {
    if (solo) return a.id === solo;
    if (a.id === filter.keep) return true;
    if (filter.tree) return a.id === filter.tree;
    if (filter.city && a.islandId !== filter.city) return false;
    return filter.scope === "all" || a.status === "live" || ms(a.lastActive) >= midnight;
  };
  const sessions = input.agents.filter(inScope);
  for (const a of sessions) {
    const auto = autonomyLevel(a);
    nodes.set(a.id, {
      id: a.id,
      kind: "session",
      place: "prompt",
      label: agentTitle(a),
      sub: `${shortModel(a.model)} · ${a.messageCount} msgs`,
      group: a.islandId,
      live: a.status === "live",
      status: a.awaitingInput ? "awaiting" : a.status,
      at: ms(a.lastActive),
      weight: a.tokens,
      autonomy: auto.level,
      autonomyReason: auto.reason,
    });
  }
  const sessionIds = new Set(sessions.map((s) => s.id));

  // ---- subagents ----
  const subs = input.subagents.filter((s) => {
    if (!sessionIds.has(s.parentSessionId)) return false;
    if (only || filter.scope === "all" || s.parentSessionId === filter.keep) return true;
    return s.status === "running" || ms(s.lastActive) >= midnight;
  });
  subs.sort((a, b) => cmp(b.lastActive, a.lastActive) || cmp(a.id, b.id));
  const hidden: Partial<Record<Lane, number>> = {};
  // Solo keeps the files / MCPs / models of the subagents past its cap: their links hang off the
  // lane's "+N more" card instead (subNode), so the footprint stays whole.
  const linkedSubs = subs.slice(0, LANE_CAPS.subagents);
  const keptSubs = linkedSubs.slice(0, capOf("subagents"));
  if (subs.length > keptSubs.length) hidden.subagents = subs.length - keptSubs.length;
  if (solo && linkedSubs.length > keptSubs.length) nodes.set("more:subagents", moreNode("subagents", linkedSubs.length - keptSubs.length, true));
  for (const s of keptSubs) {
    const id = subagentNodeId(s.id);
    nodes.set(id, {
      id,
      kind: "subagent",
      place: "subagents",
      label: s.description,
      sub: `${shortModel(s.model)}${s.agentType ? ` · ${s.agentType}` : ""}`,
      group: s.parentSessionId,
      live: s.status === "running",
      status: s.status,
      at: ms(s.lastActive),
      weight: s.tokens,
      autonomy: SUBAGENT_AUTONOMY_LEVEL,
      autonomyReason: SUBAGENT_AUTONOMY_REASON,
    });
  }
  const keptSubIds = new Set(keptSubs.map((s) => s.id));
  const subNode = (id: string): string => (keptSubIds.has(id) ? subagentNodeId(id) : "more:subagents");
  const shownSubs = solo ? linkedSubs : keptSubs;
  for (const s of shownSubs) {
    const from = s.parentAgentId && keptSubIds.has(s.parentAgentId) ? subagentNodeId(s.parentAgentId) : s.parentSessionId;
    if (from !== subNode(s.id)) addEdge(from, subNode(s.id), "spawned");
  }

  // ---- candidate targets: world edges from visible sessions, subagent files/MCPs, models ----
  interface Cand {
    kind: NodeKind;
    place: Lane;
    label: string;
    weight: number;
    at: number;
    links: Array<{ from: string; kind: CEdgeKind; weight: number }>;
  }
  const cands = new Map<string, Cand>();
  const cand = (id: string, kind: NodeKind, place: Lane, label: string): Cand => {
    let c = cands.get(id);
    if (!c) {
      c = { kind, place, label, weight: 0, at: 0, links: [] };
      cands.set(id, c);
    }
    return c;
  };
  for (const e of input.edges) {
    if (!sessionIds.has(e.from) || e.kind === "visited") continue;
    const obj = input.objects.get(e.to);
    const pl = objectPlace(e.to, obj);
    if (!pl) continue;
    const c = cand(e.to, pl.kind, pl.place, objectLabel(e.to, obj));
    c.weight += e.weight;
    c.at = Math.max(c.at, ms(e.at));
    c.links.push({ from: e.from, kind: e.kind === "uses" ? "uses" : "touched", weight: e.weight });
  }
  for (const s of shownSubs) {
    const from = subNode(s.id);
    for (const f of s.files) {
      const id = `file:${f.path}`;
      const brain = isMemoryPath(f.path);
      const c = cand(id, brain ? "brain" : "file", brain ? "brain" : "files", objectLabel(id, input.objects.get(id)));
      c.weight += f.count;
      c.at = Math.max(c.at, ms(s.lastActive));
      c.links.push({ from, kind: "touched", weight: f.count });
    }
    for (const [tool, n] of Object.entries(s.toolCounts)) {
      if (!tool.startsWith("mcp__")) continue;
      const server = tool.slice(5).split("__")[0];
      if (!server) continue;
      const id = `mcp:${server}`;
      const c = cand(id, "mcp", "tools", objectLabel(id, input.objects.get(id)));
      c.weight += n;
      c.links.push({ from, kind: "uses", weight: n });
    }
    const mid = modelNodeId(s.model);
    if (mid) {
      const c = cand(mid, "model", "reason", shortModel(s.model));
      c.weight += 1;
      c.links.push({ from, kind: "uses", weight: 1 });
    }
  }
  for (const a of sessions) {
    const mid = modelNodeId(a.model);
    if (!mid) continue;
    const c = cand(mid, "model", "reason", shortModel(a.model));
    c.weight += 1;
    c.at = Math.max(c.at, ms(a.lastActive));
    c.links.push({ from: a.id, kind: "uses", weight: 1 });
  }
  // Hooks fire for every prompt; show them all (no per-session edge exists in the data),
  // except in a one-session tree, where unconnected cards are noise.
  if (!only) for (const o of input.objects.values()) if (o.kind === "hook") cand(o.id, "hook", "hook", o.name).weight += o.usage;

  // Keep the heaviest candidates per lane (cap), deterministic tie-break on id.
  const byLane = new Map<Lane, Array<[string, Cand]>>();
  for (const entry of cands) {
    const list = byLane.get(entry[1].place) ?? [];
    list.push(entry);
    byLane.set(entry[1].place, list);
  }
  for (const [lane, list] of byLane) {
    list.sort((a, b) => b[1].weight - a[1].weight || cmp(a[0], b[0]));
    const cap = capOf(lane);
    if (list.length > cap) hidden[lane] = (hidden[lane] ?? 0) + list.length - cap;
    for (const [id, c] of list.slice(0, cap)) {
      nodes.set(id, {
        id,
        kind: c.kind,
        place: c.place,
        label: c.label,
        sub: c.kind === "hook" ? id.split(":")[1] ?? "hook" : `${c.links.length} link${c.links.length === 1 ? "" : "s"}`,
        group: null,
        live: false,
        status: null,
        at: c.at,
        weight: c.weight,
      });
      for (const l of c.links) if (nodes.has(l.from)) addEdge(l.from, id, l.kind, l.weight);
    }
  }

  // ---- Atlas departments + published artifacts (added after the Artifacts / Atlas views) ----
  // A department is shown when one of the visible skill cards is a leaf of it (dept → skill).
  if (input.atlas) {
    const deptOf = new Map(input.atlas.leaves.filter((l) => l.kind === "skill").map((l) => [l.id, l.dept] as const));
    const deptInfo = new Map(input.atlas.departments.map((d) => [d.id as string, d] as const));
    const used = new Map<string, number>();
    for (const n of [...nodes.values()]) {
      const d = n.kind === "skill" ? deptOf.get(n.id) : undefined;
      if (d && d !== "unfiled") used.set(d, (used.get(d) ?? 0) + 1);
    }
    for (const [d, n] of [...used].sort((a, b) => cmp(a[0], b[0]))) {
      const info = deptInfo.get(d);
      const id = `dept:${d}`;
      nodes.set(id, { id, kind: "dept", place: "atlas", label: info ? `${info.emoji} ${info.name}` : d, sub: `${n} skill${n === 1 ? "" : "s"} in view`, group: null, live: false, status: null, at: 0, weight: n });
    }
    for (const n of [...nodes.values()]) {
      const d = n.kind === "skill" ? deptOf.get(n.id) : undefined;
      if (d && nodes.has(`dept:${d}`)) addEdge(`dept:${d}`, n.id, "uses", 1);
    }
  }
  const arts = (input.artifacts ?? []).filter((a) => a.sessions.some((s) => sessionIds.has(s)));
  arts.sort((a, b) => cmp(b.lastAt ?? "", a.lastAt ?? "") || cmp(a.id, b.id));
  if (arts.length > capOf("artifacts")) hidden.artifacts = arts.length - capOf("artifacts");
  for (const a of arts.slice(0, capOf("artifacts"))) {
    const id = `artifact:${a.id}`;
    nodes.set(id, { id, kind: "artifact", place: "artifacts", label: a.title ?? a.id, sub: `${a.origin}${a.publishCount > 1 ? ` · ${a.publishCount} publishes` : ""}`, group: null, live: false, status: a.origin, at: ms(a.lastAt ?? ""), weight: a.publishCount });
    for (const s of a.sessions) if (sessionIds.has(s)) addEdge(s, id, "touched", 1);
  }

  // ---- Jev router + model tiers (from the removed System view) ----
  // The harness names a hook by its command's basename, so the router usually shows up as a
  // "node" script on UserPromptSubmit; routerHookState says how sure that is. No hook → router
  // edge on purpose: the lane layout would pull the router down to that hook's row (hooks sort
  // alphabetically), so the card names the hook instead and sits at the top of its lane.
  const router = routerHookState(hookGates(input.objects.values()));
  const routerSub = router === "installed" ? "hook installed" : router === "likely" ? "hook likely installed (UserPromptSubmit · node)" : "hook not seen";
  // The lane used to say only whether the hook looked installed, which read as "nothing is
  // happening here" while every prompt on the Mac was in fact being routed. The decisions
  // themselves are the point, so they lead.
  const cards = input.routeCards ?? null;
  const cardsSub = cards ? `${cards.total} decisions · ${cards.today} today` : "no decisions logged";
  nodes.set("router:jev", {
    id: "router:jev",
    kind: "router",
    place: "router",
    label: "Jev router",
    sub: `${cardsSub} · ${routerSub} · Jev ${input.jevStatus}`,
    group: null,
    live: router !== "absent" && input.jevStatus === "online",
    status: router,
    at: cards?.lastAt ? ms(cards.lastAt) : 0,
    weight: cards ? Math.max(1, cards.total) : 1,
  });
  const fams: ModelFamily[] = [...PLANT_FAMILIES, "other"];
  const tierCount = new Map<ModelFamily, { live: number; view: number; all: number }>(fams.map((f) => [f, { live: 0, view: 0, all: 0 }]));
  for (const a of input.agents) {
    const t = tierCount.get(modelFamilyOf(a.model));
    if (!t) continue;
    t.all += 1;
    if (a.status === "live") t.live += 1;
    if (sessionIds.has(a.id)) t.view += 1;
  }
  for (const f of fams) {
    const t = tierCount.get(f);
    if (!t) continue;
    // A tier the router keeps advising while nothing actually runs on it is the single most
    // useful thing this lane can show, so decisions alone are enough to keep the node — it
    // no longer needs a session to exist.
    const decided = cards && isPlantFamily(f) ? cards.byTier[f] : 0;
    if (decided === 0 && (only ? t.view === 0 : t.all === 0)) continue;
    const id = `tier:${f}`;
    const sessions = `${t.live} live · ${t.view} in view · ${t.all} all`;
    nodes.set(id, {
      id,
      kind: "tier",
      place: "tiers",
      label: FAMILY_LABELS[f],
      sub: cards ? `${decided} advised · ${sessions}` : sessions,
      group: null,
      live: t.live > 0,
      status: null,
      at: 0,
      weight: Math.max(t.all, decided),
    });
    // "decided", not "uses": the edge is what the router ADVISED, which is a different fact
    // from how many sessions happen to be on that tier (the node's own numbers). A hook
    // cannot switch the model, so the gap between the two is real and worth seeing.
    if (decided > 0) addEdge("router:jev", id, "decided", decided);
    else if (!cards && t.view > 0) addEdge("router:jev", id, "uses", t.view);
  }
  for (const n of nodes.values()) {
    if (n.kind !== "model") continue;
    const tier = `tier:${modelFamilyOf(n.label)}`;
    if (nodes.has(tier)) addEdge(tier, n.id, "uses", n.weight);
  }

  // ---- top rail: Jev + pending approvals ----
  const decided = new Map<string, number>();
  for (const d of input.decisions) for (const s of d.subjects) if (sessionIds.has(s)) decided.set(s, (decided.get(s) ?? 0) + 1);
  nodes.set("jev", {
    id: "jev",
    kind: "jev",
    place: "top",
    label: "Jev",
    sub: `${input.jevStatus} · ${input.decisions.length} decisions`,
    group: null,
    live: input.jevStatus === "online",
    status: input.jevStatus,
    at: input.decisions[0] ? ms(input.decisions[0].at) : 0,
    weight: input.decisions.length,
  });
  for (const [agentId, n] of [...decided].sort((a, b) => cmp(a[0], b[0]))) addEdge("jev", agentId, "decided", n);
  for (const ap of input.approvals) {
    if (!sessionIds.has(ap.agentId)) continue;
    const id = `approval:${ap.id}`;
    nodes.set(id, { id, kind: "approval", place: "top", label: `${ap.toolName}: ${ap.title}`, sub: "waiting for you", group: null, live: true, status: "pending", at: filter.nowMs, weight: 1 });
    addEdge(id, ap.agentId, "awaits");
  }

  // ---- bottom rail: routines ----
  for (const r of solo ? [] : [...input.routines].sort((a, b) => cmp(a.shortName, b.shortName))) {
    const id = `routine:${r.label}`;
    const status = r.running ? "running" : r.lastExitStatus === null ? "unknown" : r.lastExitStatus === 0 ? "ok" : `exit ${r.lastExitStatus}`;
    nodes.set(id, { id, kind: "routine", place: "bottom", label: r.shortName, sub: status, group: null, live: r.running, status, at: 0, weight: 0 });
  }

  // "+N more" stand-ins so a capped lane says so on the canvas itself, not only in its header.
  for (const [lane, n] of Object.entries(hidden) as Array<[Lane, number]>) {
    if (n > 0 && lane !== "prompt") nodes.set(`more:${lane}`, moreNode(lane, n, solo !== null));
  }

  const edgeList = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  edgeList.sort((a, b) => cmp(a.id, b.id));
  return { nodes: [...nodes.values()], edges: edgeList, hidden, solo };
}

function moreNode(lane: Lane, n: number, opens: boolean): CNode {
  return { id: `more:${lane}`, kind: "more", place: lane, label: `+${n} more`, sub: opens ? "click to show them" : "hidden by the lane cap", group: null, live: false, status: null, at: 0, weight: 0 };
}

/** The node an activity lights up, by stage (see ActivityStage): its target object when that
 *  is on the canvas, else the stage's lane (hook → a prompt hook, reason → the model). */
export function activityTarget(
  g: { has(id: string): boolean },
  stage: string,
  targetObjectId: string | null,
  model: string | null,
  hookIds: readonly string[],
): string | null {
  if (targetObjectId && g.has(targetObjectId)) return targetObjectId;
  if (stage === "reason") {
    const m = modelNodeId(model);
    return m && g.has(m) ? m : null;
  }
  if (stage === "hook") {
    const id = hookIds.find((id) => /UserPromptSubmit/i.test(id)) ?? hookIds[0] ?? null;
    // Same rule as the targetObjectId/reason branches above: only point at a hook that is actually
    // laid out. The Autonomy layout mode never places hook nodes at all (layoutAutonomy only lays
    // out "session"/"subagent" kinds), so without this check a hook-stage activity there silently
    // dropped both the bead AND the source card's pulse (bead() bails before pulsing when its
    // target isn't found) — see the GRO review finding on this line.
    return id && g.has(id) ? id : null;
  }
  return null;
}
