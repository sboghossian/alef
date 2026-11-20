// Orbit filters (Round 7 T2). Visual only: dim / shrink / hide, never removes data.
//   state    all | live | waiting | today | dormant  → non-matching houses wash out and shrink,
//                                                      their creatures, cars and planes hide
//   district one city in focus → everything else washes to 15% (post pass), other labels shrink,
//                                the camera frames it
//   kinds    drones, files, harness buildings, factories, planes, weather, system → show / hide
// The shell's left sidebar renders this through `orbitFilters`; every change also fires a
// window CustomEvent "alef:orbit-filters" (detail = OrbitFilterState) so board/canvas can mirror.
// Debug: ?filter=dormant, ?district=<id>, ?hide=drones,planes.

import { Mesh, MeshToonMaterial } from "three";
import type * as THREE from "three";
import { displayIslandName } from "../../../shared/display";
import type { WorldAgent } from "../../../shared/types";
import { PLANET_R } from "../layout";
import { sceneParts } from "../scene/scene-bus";
import { agentStateOf } from "./agent-state";
import {
  KIND_KEYS,
  KIND_LABELS,
  STATE_FILTERS,
  agentMatchesState,
  defaultFilterState,
  filterStateFromSearch,
  focusCapAngle,
  labelShouldDim,
  type KindKey,
  type OrbitFilterState,
  type StateFilter,
} from "./orbit-lib";
import type { ClientContext, ClientFeature } from "./registry";

export type { KindKey, OrbitFilterState, StateFilter } from "./orbit-lib";

export interface FilterOption<T extends string> {
  id: T;
  label: string;
  /** How many agents / buildings the option covers right now (for sidebar counts). */
  count?: number;
}

export interface OrbitFiltersApi {
  get(): OrbitFilterState;
  setState(state: StateFilter): void;
  /** null = all districts. Focusing flies the camera to the city. */
  setDistrict(id: string | null): void;
  setKind(kind: KindKey, visible: boolean): void;
  reset(): void;
  /** What the sidebar should offer, with live counts. */
  options(): { states: FilterOption<StateFilter>[]; districts: FilterOption<string>[]; kinds: FilterOption<KindKey>[] };
  /** The same predicate the orbit uses, so a board/canvas can mirror the state filter. */
  matchesAgent(agent: WorldAgent): boolean;
  onChange(fn: (state: OrbitFilterState) => void): () => void;
}

export const FILTER_EVENT = "alef:orbit-filters";
const STATE_LABELS: Record<StateFilter, string> = { all: "All", live: "Live", waiting: "Waiting on you", today: "Today", dormant: "Dormant" };
const FOCUS_FADE_S = 0.45;

let state: OrbitFilterState = defaultFilterState();
let ctxRef: ClientContext | null = null;
let focusAmt = 0;
const listeners = new Set<(s: OrbitFilterState) => void>();
let kindsDirty = true;
let lastKindSync = 0;

function matches(agent: WorldAgent): boolean {
  return agentMatchesState(state.state, agent, Date.now(), agentStateOf(agent.id));
}

function applyAgentFilter(): void {
  sceneParts().agents?.setFilter(state.state === "all" ? null : matches);
}

function cityName(ctx: ClientContext, id: string): string {
  if (id === "harness") return "★ Harness City";
  const isl = ctx.store.islands.get(id);
  return isl ? displayIslandName(isl) : id;
}

/** Other districts' labels shrink and fade (class-only, main.ts keeps positioning them). Delegates
 *  the actual "is this the focused one" call to orbit-lib's labelShouldDim, which compares the
 *  callout's island id (client/src/ui/labels.ts sets `dataset.islandId`) — never the rendered
 *  label text. */
function applyLabels(_ctx: ClientContext): void {
  document.querySelectorAll<HTMLElement>("#labels .callout").forEach((el) => {
    el.classList.toggle("orbit-dim", labelShouldDim(el.dataset.islandId, state.district));
  });
}

function setVisible(objs: readonly (THREE.Object3D | undefined | null)[], on: boolean): void {
  for (const o of objs) if (o && o.visible !== on) o.visible = on;
}

/** features/sky's storm cloud: an unnamed group of slate toon puffs (0x4a4460). */
function isStormCloud(o: THREE.Object3D): boolean {
  const first = o.children[0];
  if (o.type !== "Group" || o.name !== "" || !first || !(first instanceof Mesh)) return false;
  const mat = first.material;
  return mat instanceof MeshToonMaterial && mat.color.getHex() === 0x4a4460;
}

/** Kind toggles. Some owners (weather, drones) reset `.visible` themselves each frame, so this
 *  runs every frame after them (orbit features are registered last). */
function applyKinds(ctx: ClientContext): void {
  const k = state.kinds;
  const scene = ctx.scene;
  const parts = sceneParts();
  if (parts.cities) {
    setVisible(parts.cities.kindMeshes.files, k.files);
    setVisible(parts.cities.kindMeshes.harness, k.harness);
  }
  parts.agents?.setPlanesVisible(k.planes);
  const drones = scene.getObjectByName("subagent-drones");
  if (drones) {
    const i = scene.children.indexOf(drones);
    // The drone glow is the unnamed instanced mesh added right after the drones.
    setVisible([drones, i >= 0 ? scene.children[i + 1] : null], k.drones);
  }
  setVisible([scene.getObjectByName("routines-district")], k.factories);
  if (!k.weather) {
    for (const c of ctx.camera.children) if (c.type === "Points") c.visible = false;
    for (const o of scene.children) if (isStormCloud(o)) o.visible = false;
  }
  document.body.classList.toggle("orbit-hide-weather", !k.weather);
  setVisible([scene.getObjectByName("orbit-system")], k.system);
}

function emit(): void {
  const snapshot: OrbitFilterState = { state: state.state, district: state.district, kinds: { ...state.kinds } };
  for (const fn of listeners) fn(snapshot);
  window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: snapshot }));
}

function update(next: Partial<OrbitFilterState>, fly = false): void {
  const prevDistrict = state.district;
  state = { ...state, ...next, kinds: { ...state.kinds, ...(next.kinds ?? {}) } };
  kindsDirty = true;
  applyAgentFilter();
  const ctx = ctxRef;
  if (ctx) {
    applyLabels(ctx);
    if (fly && state.district && state.district !== prevDistrict) ctx.flyTo(state.district);
  }
  emit();
}

export const orbitFilters: OrbitFiltersApi = {
  get: () => ({ state: state.state, district: state.district, kinds: { ...state.kinds } }),
  setState: (s) => update({ state: s }),
  setDistrict: (id) => update({ district: id && ctxRef?.store.islands.has(id) ? id : null }, true),
  setKind: (kind, visible) => update({ kinds: { ...state.kinds, [kind]: visible } }),
  reset: () => update(defaultFilterState()),
  options() {
    const agents = ctxRef ? [...ctxRef.store.agents.values()] : [];
    const now = Date.now();
    const states = STATE_FILTERS.map((id) => ({
      id,
      label: STATE_LABELS[id],
      count: agents.filter((a) => agentMatchesState(id, a, now, agentStateOf(a.id))).length,
    }));
    const districts = ctxRef
      ? [...ctxRef.store.islands.values()]
          .sort((a, b) => (a.id === "harness" ? -1 : b.id === "harness" ? 1 : b.agentCount - a.agentCount))
          .map((i) => ({ id: i.id, label: cityName(ctxRef!, i.id), count: i.agentCount }))
      : [];
    const kinds = KIND_KEYS.map((id) => ({ id, label: KIND_LABELS[id] }));
    return { states, districts, kinds };
  },
  matchesAgent: (a) => matches(a),
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const orbitFiltersFeature: ClientFeature = {
  id: "orbit-filters",
  mount(ctx) {
    ctxRef = ctx;
    const style = document.createElement("style");
    style.textContent = `#labels .callout.orbit-dim { opacity: 0.35; font-size: 0.72em; filter: saturate(0.4); }
body.orbit-hide-weather .sky-body { display: none; }`;
    document.head.appendChild(style);
    const initial = filterStateFromSearch(window.location.search);
    if (initial.district && !ctx.store.islands.has(initial.district)) initial.district = null;
    state = initial;
    applyAgentFilter();
    applyLabels(ctx);
    if (state.district) {
      const id = state.district;
      window.setTimeout(() => ctx.flyTo(id), 400);
    }
    // Agents change state all the time; re-run the predicate when they do.
    ctx.store.onAgents(() => {
      if (state.state !== "all") applyAgentFilter();
    });
  },
  onFrame(dt, ctx) {
    // District wash: ease in/out, drive the post pass.
    const want = state.district ? 1 : 0;
    focusAmt += (want - focusAmt) * Math.min(1, dt / FOCUS_FADE_S * 3);
    if (Math.abs(want - focusAmt) < 0.002) focusAmt = want;
    const rig = sceneParts().rig;
    const city = state.district ? sceneParts().layout?.find((c) => c.id === state.district) : undefined;
    if (rig) rig.post.setFocus(focusAmt, city?.dir, city ? focusCapAngle(city.radius, PLANET_R) : undefined);
    // Kinds: cheap, but only needed every frame when something is hidden.
    const anyHidden = KIND_KEYS.some((k) => !state.kinds[k]);
    const now = ctx.elapsed();
    if (anyHidden || kindsDirty || now - lastKindSync > 1) {
      applyKinds(ctx);
      kindsDirty = false;
      lastKindSync = now;
    }
    if (state.district && Math.floor(now) !== Math.floor(now - dt)) applyLabels(ctx);
  },
  paletteCommands: () => [
    ...STATE_FILTERS.map((s) => ({
      id: `state-${s}`,
      title: `Filter: ${STATE_LABELS[s]}`,
      kind: "filter",
      meta: s === state.state ? "current" : undefined,
      keywords: ["filter", "show", s],
      run: () => orbitFilters.setState(s),
    })),
    { id: "reset", title: "Filter: reset all", kind: "filter", keywords: ["filter", "clear", "reset"], run: () => orbitFilters.reset() },
  ],
};
