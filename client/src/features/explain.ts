// Explain layer (round 11 C): one toggle (Orbit sidebar "Explain" section, or E on the Orbit)
// puts a plain-language tag on every kind of structure — districts, houses, cars, drones,
// stations, Harness City, the System Quarter's places, the routines factory and the moon — and
// makes a click on a structure open a small card: what it is, what it did today, live numbers.
// Clicking a System Quarter place opens its card whether Explain is on or not (like the Tool Yard).
// The three memory buildings are the Institute of Truth (the town's second brain): each one's card
// leads to the Institute's own card (instituteOfTruthCard: who really read from it at wake).
// The campus (agent-city piece 7): the School and the Graduates' Hall open their cards the same
// way, from a click or the palette (which also works with WebGL off), with buttons to the Skills
// panel's School tab, the Tower and, once alumni-legacy registers it, the Hall panel.
// The Clinic (vision wave 4) opens its card the same way, with the case counts and a button to
// the Clinic panel.
// The card is a registered panel ("explain-card"), so it docks in the one details panel.
// Text comes from explain-lib.ts (pure, tested); every number is real data read at render time.
// Labels are pooled DOM chips in the shared overlay layer, placed only while Explain is on.

import * as THREE from "three";
import type { CliStationSnapshotResult } from "../../../shared/features/cli-station";
import type { MemoryLayersSnapshotResult } from "../../../shared/features/memory-layers";
import type { Routine, RoutinesPayload } from "../../../shared/features/routines";
import { ROUTINES_EXTRAS_KEY } from "../../../shared/features/routines";
import type { StationId } from "../../../shared/stations";
import { INSTITUTE_OF_TRUTH } from "../../../shared/features/wake-recall";
import type { WorldSnapshot } from "../../../shared/types";
import { PLANET_R } from "../layout";
import { log } from "../log";
import { redactOn } from "../redact";
import { runAction, type ActionResultLike } from "../ui/action";
import { sceneParts } from "../scene/scene-bus";
import { STATE_LABELS, agentStateOf } from "./agent-state";
import { currentPresidentBoard } from "./president";
import { explainOn, onExplainChange, setExplain } from "./explain-state";
import {
  KIND_LABELS,
  buildingCard,
  carCard,
  cliStationCard,
  clinicCard,
  districtCard,
  hallCard,
  episodicCard,
  gateCard,
  harnessCard,
  houseCard,
  instituteOfTruthCard,
  jevTowerCard,
  localMidnight,
  moonCard,
  plantCard,
  proceduralCard,
  routinesCard,
  schoolCard,
  semanticCard,
  stationCard,
  subagentsCard,
  type CampusAction,
  type ExplainCard,
} from "./explain-lib";
import { h, isRecord, overlayLayer, place, toScreen } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { campusData, onCampusChange, refreshCampus } from "./campus-data";
import { clinicView, onClinicChange } from "./sickness";
import { onRoutines } from "./routines";
import { openSchoolTab } from "./skills";
import { subagentData } from "./subagent-data";
import { topicsState } from "./topics-state";
import {
  campusCaption,
  campusForLabel,
  campusName,
  campusTop,
  clinicCaption,
  clinicName,
  clinicTop,
  currentBanners,
  currentClinicLamp,
  currentClinicMarks,
  currentGates,
  currentLamp,
  currentPlants,
  currentRouterDocs,
  currentRouterHook,
  isClinicLabel,
  placeForLabel,
  placeHits,
  placeName,
  placeTop,
  quarterVisible,
  seen,
} from "./system-places";
import { CAMPUS_IDS, GATE_TEXT, isMemoryPlace, memoryPlaceCaption, PLACE_IDS, type CampusId, type GateEvent, type PlaceId } from "./system-places-lib";
import { startTour } from "./tour";
import { onWakeRecallSummary, wakeRecallSummary } from "./wake-recall";
import "./explain.css";
import { agentTitle } from "../../../shared/display";

const PANEL_ID = "explain-card";
/** Panels a campus card leads to. "alumni" is alumni-legacy's Hall: its button shows only once
 *  that panel is registered. */
const TOWER_PANEL = "careers";
const HALL_PANEL = "alumni";
/** The sickness feature's panel (sickness.ts): every case, the Doctor and Mark treated. */
const CLINIC_PANEL = "clinic";
/** A campus card re-reads its sources when opened, at most this often. */
const CAMPUS_CARD_REFRESH_MS = 30_000;
const STATION_PROPS: readonly StationId[] = ["bash", "edit", "read", "web", "mcp"];

export type ExplainTarget =
  | { type: "place"; id: PlaceId }
  | { type: "agent"; id: string; car?: boolean }
  | { type: "city"; id: string }
  | { type: "object"; id: string }
  | { type: "moon" }
  | { type: "drones" }
  | { type: "station"; station: StationId; agentId: string | null }
  | { type: "routines" }
  | { type: "institute" }
  | { type: "campus"; id: CampusId }
  | { type: "clinic" };

let ctxRef: ClientContext | null = null;
let current: ExplainTarget | null = null;
let routines: readonly Routine[] | null = null;
let memoryLayers: MemoryLayersSnapshotResult | null = null;
let memoryLayersAsked = false;
let cliStation: CliStationSnapshotResult | null = null;
let cliStationAsked = false;
/** Snapshot extras "recall.docCount" / "recall.ready" (the recall feature's index). */
let recallIndex: { docCount: number; ready: boolean } | null = null;
/** The element the card was last rendered into (a fresh one per openPanel). */
let cardEl: HTMLElement | null = null;

// ---------------------------------------------------------------- data for cards

const MEMORY_PLACE_IDS = new Set<PlaceId>(["episodic", "semantic", "procedural"]);

async function loadMemoryLayers(ctx: ClientContext): Promise<void> {
  if (memoryLayersAsked) return;
  memoryLayersAsked = true;
  const res = await ctx.api.getJson<MemoryLayersSnapshotResult>("/api/memory-layers/snapshot", 8000);
  if (res?.ok) memoryLayers = res;
  else memoryLayersAsked = false; // try again on the next memory-building card
  if (current?.type === "institute" || (current?.type === "place" && MEMORY_PLACE_IDS.has(current.id))) ctx.openPanel(PANEL_ID);
}

async function loadCliStation(ctx: ClientContext): Promise<void> {
  if (cliStationAsked) return;
  cliStationAsked = true;
  const res = await ctx.api.getJson<CliStationSnapshotResult>("/api/cli-station/snapshot", 6000);
  if (res?.ok) cliStation = res;
  else cliStationAsked = false;
  if (current?.type === "place" && current.id === "cli") ctx.openPanel(PANEL_ID);
}

function cardFor(t: ExplainTarget, ctx: ClientContext): ExplainCard | null {
  const since = localMidnight(Date.now());
  switch (t.type) {
    case "place": {
      if (t.id === "jev") return jevTowerCard(ctx.store.jev, currentRouterHook(), currentRouterDocs(), seen.prompts, currentPresidentBoard().proposals.length, since);
      if (t.id === "cli") {
        void loadCliStation(ctx);
        return cliStationCard(cliStation);
      }
      if (t.id === "episodic" || t.id === "semantic" || t.id === "procedural") {
        void loadMemoryLayers(ctx);
        const hits = placeHits(t.id);
        if (t.id === "episodic") return episodicCard(memoryLayers?.episodic ?? null, hits);
        if (t.id === "semantic") return semanticCard(memoryLayers?.semantic ?? null, hits);
        return proceduralCard(memoryLayers?.procedural ?? null, hits);
      }
      if (t.id.startsWith("gate:")) {
        const g = currentGates().find((x) => `gate:${x.event}` === t.id);
        return g ? gateCard(g, placeHits(t.id)) : null;
      }
      const st = currentPlants().find((p) => `plant:${p.family}` === t.id);
      return st ? plantCard(st, placeHits(t.id)) : null;
    }
    case "agent": {
      const a = ctx.store.agents.get(t.id);
      if (!a) return null;
      const state = a.status === "live" ? STATE_LABELS[agentStateOf(a.id) ?? "idle"] : null;
      if (t.car) return carCard(agentTitle(a), state);
      return houseCard(a, state, seen.perAgent.get(a.id) ?? 0, subagentData.byParent(a.id).length, since);
    }
    case "city": {
      if (t.id === "harness") return harnessCard(ctx.store.objects.values());
      const island = ctx.store.islands.get(t.id);
      if (!island) return null;
      const agents = [...ctx.store.agents.values()].filter((a) => a.islandId === t.id);
      return districtCard(island.name, agents, seen.perIsland.get(t.id) ?? 0, since);
    }
    case "object": {
      const o = ctx.store.objects.get(t.id);
      return o ? buildingCard(o) : null;
    }
    case "moon":
      return moonCard(ctx.store.jev, since);
    case "drones":
      return subagentsCard(subagentData.stats);
    case "station": {
      const a = t.agentId ? ctx.store.agents.get(t.agentId) : undefined;
      const calls = t.agentId ? (seen.stations.get(t.agentId)?.get(t.station) ?? 0) : 0;
      return stationCard(t.station, a ? agentTitle(a) : null, calls);
    }
    case "routines":
      return routinesCard(routines);
    case "institute":
      void loadMemoryLayers(ctx);
      return instituteOfTruthCard({ wake: wakeRecallSummary(), semantic: memoryLayers?.semantic ?? null, recall: recallIndex });
    case "campus": {
      const d = campusData();
      const hallPanel = ctx.hasPanel(HALL_PANEL);
      if (t.id === "school") {
        refreshCampus("institute", CAMPUS_CARD_REFRESH_MS);
        return schoolCard({ lamp: currentLamp(), institute: d.institute?.block ?? null, candidates: d.institute?.candidates ?? null, hallPanel });
      }
      refreshCampus("careers", CAMPUS_CARD_REFRESH_MS);
      refreshCampus("shipped", CAMPUS_CARD_REFRESH_MS);
      return hallCard({ careers: d.careers, banners: currentBanners(), shipped: d.shipped, hallPanel, redacted: redactOn() });
    }
    case "clinic": {
      const view = clinicView();
      const m = currentClinicMarks(view);
      const gl = sceneParts().webgl;
      return clinicCard({
        lamp: currentClinicLamp(view),
        counts: view.counts,
        sickSessions: view.sick?.length ?? null,
        source: view.source,
        marks: { shown: m.marks.length, unplaced: m.unplaced, unshown: m.unshown, drawn: m.drawn },
        drawing: !gl || gl.state === "on",
        today: view.today,
      });
    }
  }
}

const CAMPUS_BUTTONS: Record<CampusAction, { text: string; title: string }> = {
  school: { text: "🏫 School tab", title: "The Skills panel's School tab: the study pipeline, its candidates and Darwin rounds" },
  tower: { text: "🏛 Tower", title: "Every automation worker, its department, state and last 10 runs" },
  hall: { text: "🎓 Hall", title: "The Graduates' Hall panel" },
};

function campusButton(action: CampusAction, ctx: ClientContext): HTMLElement {
  const b = h("button", "alef-fchip xp-more", CAMPUS_BUTTONS[action].text);
  b.type = "button";
  b.title = CAMPUS_BUTTONS[action].title;
  b.addEventListener("click", () => {
    if (action === "school") openSchoolTab(ctx);
    else ctx.openPanel(action === "tower" ? TOWER_PANEL : HALL_PANEL);
  });
  return b;
}

function renderCard(el: HTMLElement, ctx: ClientContext): void {
  cardEl = el;
  el.replaceChildren();
  el.classList.add("xp-card");
  const t = current;
  const card = t ? cardFor(t, ctx) : null;
  if (!t || !card) {
    el.append(h("p", "xp-what", explainOn() ? "Click any structure on the planet to see what it is." : "Turn on Explain (E) and click any structure on the planet."));
    return;
  }
  el.append(h("h3", "xp-title", card.title), h("p", "xp-what", card.what));
  el.append(h("div", "xp-sec", "Today"));
  if (card.today.length) {
    const ul = h("ul", "xp-today");
    for (const line of card.today) ul.append(h("li", undefined, line));
    el.append(ul);
  } else el.append(h("p", "xp-none", "Nothing seen today yet."));
  el.append(h("div", "xp-sec", "Live numbers"));
  const kv = h("div", "xp-kv");
  for (const [k, v] of card.live) kv.append(h("b", undefined, k), h("span", undefined, v));
  el.append(kv);
  if (card.buildStages?.length) {
    el.append(h("div", "xp-sec", "How the model was built"));
    const ol = h("ol", "xp-build");
    for (const s of card.buildStages) {
      const li = h("li");
      li.append(h("b", undefined, s.stage), h("span", undefined, s.text));
      ol.append(li);
    }
    el.append(ol);
  }
  if (card.source) el.append(h("p", "xp-src", `Source: ${card.source}`));
  // Each memory building belongs to the Institute of Truth: its card leads to the Institute's.
  if (t.type === "place" && isMemoryPlace(t.id)) {
    const b = h("button", "alef-fchip xp-more", `🏛️ ${INSTITUTE_OF_TRUTH}`);
    b.type = "button";
    b.title = "The three memory buildings as one: the town's second brain, and which sessions read from it when they woke";
    b.addEventListener("click", () => {
      void runAction({
        label: `Open the ${INSTITUTE_OF_TRUTH}`,
        button: b,
        toast: ctx.toast,
        run: () => {
          openExplainCard({ type: "institute" });
          return Promise.resolve({ ok: true });
        },
        success: () => null,
      });
    });
    el.append(b);
  }
  for (const action of card.actions ?? []) el.append(campusButton(action, ctx));
  // The Clinic's card leads to the Clinic panel, when the sickness feature registers it.
  if (t.type === "clinic" && ctx.hasPanel(CLINIC_PANEL)) {
    const b = h("button", "alef-fchip xp-more", "🩺 Open the Clinic");
    b.type = "button";
    b.title = "Every case by lineage and disease, with the Doctor and Mark treated";
    b.addEventListener("click", () => {
      void runAction<ActionResultLike>({
        label: "Open the Clinic",
        button: b,
        toast: ctx.toast,
        run: () => {
          if (!ctx.hasPanel(CLINIC_PANEL)) return Promise.resolve({ ok: false, error: "the Clinic panel isn't registered" });
          ctx.openPanel(CLINIC_PANEL);
          return Promise.resolve({ ok: true });
        },
        success: () => null,
      });
    });
    el.append(b);
  }
  // A way on to the full, existing panel for things that have one.
  if (t.type === "agent" || (t.type === "city" && t.id !== "harness")) {
    const b = h("button", "alef-fchip xp-more", t.type === "agent" ? "Open this session" : "Fly to this district");
    b.type = "button";
    b.addEventListener("click", () => ctx.flyTo(t.id));
    el.append(b);
  }
}

export function openExplainCard(t: ExplainTarget): void {
  current = t;
  ctxRef?.openPanel(PANEL_ID);
}

// ---------------------------------------------------------------- labels

interface Label {
  el: HTMLElement;
  kind: HTMLElement;
  name: HTMLElement;
  pos: THREE.Vector3;
  on: boolean;
}

const MAX_LABELS = 50;
const labels: Label[] = [];
let used = 0;
let lastRefresh = -10;
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();

function mountLabels(): void {
  const layer = overlayLayer();
  for (let i = 0; i < MAX_LABELS; i++) {
    const el = h("div", "xp-label");
    const kind = h("b", "xp-kind");
    const name = h("span", "xp-name");
    el.append(kind, name);
    el.hidden = true;
    layer.append(el);
    labels.push({ el, kind, name, pos: new THREE.Vector3(), on: false });
  }
}

function setLabel(kind: string, name: string, pos: THREE.Vector3, tone: string): void {
  const l = labels[used];
  if (!l) return;
  used += 1;
  if (l.kind.textContent !== kind) l.kind.textContent = kind;
  if (l.name.textContent !== name) l.name.textContent = name;
  l.name.hidden = name === "";
  if (l.el.dataset.tone !== tone) l.el.dataset.tone = tone;
  l.pos.copy(pos);
  l.on = true;
}

/** Up to `max` instance positions of a named instanced mesh, nearest the camera first. */
function instancePositions(name: string, max: number, ctx: ClientContext): THREE.Vector3[] {
  const mesh = ctx.scene.getObjectByName(name);
  if (!(mesh instanceof THREE.InstancedMesh) || !isShown(mesh)) return [];
  const out: THREE.Vector3[] = [];
  const cam = ctx.camera.position;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, tmpM);
    if (tmpM.elements[0] === 0 && tmpM.elements[5] === 0) continue; // parked at scale 0
    out.push(new THREE.Vector3().setFromMatrixPosition(tmpM).applyMatrix4(mesh.matrixWorld));
  }
  out.sort((a, b) => a.distanceToSquared(cam) - b.distanceToSquared(cam));
  return out.slice(0, max);
}

function isShown(o: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

/** The routines factory is a ring of buildings around Harness City: its nearest building to the
 *  camera (a ring's centre would sit on Harness City itself). */
function nearestFactory(ctx: ClientContext): THREE.Vector3 | null {
  const o = ctx.scene.getObjectByName("routines-district");
  if (!o || !isShown(o)) return null;
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const child of o.children) {
    if (!(child instanceof THREE.Group)) continue; // factories are groups; smoke puffs are meshes
    const p = child.getWorldPosition(tmpV);
    const d = p.distanceToSquared(ctx.camera.position);
    if (d < bestD) {
      bestD = d;
      best = (best ?? new THREE.Vector3()).copy(p);
    }
  }
  return best;
}

function moonPos(ctx: ClientContext): THREE.Vector3 | null {
  const m = ctx.scene.getObjectByName("jev-moon");
  return m ? m.getWorldPosition(new THREE.Vector3()) : null;
}

function short(s: string, n = 26): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Rebuilds which structures carry a tag (1×/s): the nearest few of each kind, all places. */
function refreshLabels(ctx: ClientContext): void {
  used = 0;
  const cam = ctx.camera.position;
  // Districts: every city with a tower, nearest first (the far side is hidden by toScreen anyway).
  const cities = [...ctx.store.islands.values()]
    .map((i) => ({ i, p: ctx.cityPosition(i.id) }))
    .filter((c): c is { i: (typeof c)["i"]; p: THREE.Vector3 } => c.p !== undefined)
    .sort((a, b) => a.p.distanceToSquared(cam) - b.p.distanceToSquared(cam))
    .slice(0, 12);
  for (const c of cities) {
    if (c.i.id === "harness") setLabel(KIND_LABELS.harness, "shops = skills · arches = hooks · antennas = MCPs", tmpV.copy(c.p).setLength(c.p.length() + 3), "harness");
    else setLabel(KIND_LABELS.district, c.i.name, tmpV.copy(c.p).setLength(c.p.length() + 2.5), "district");
  }
  // Topic continents (round 11 B), when the planet is laid out by topic: the nearest few.
  const continents = [...(topicsState()?.layout.continents ?? [])]
    .sort((a, b) => b.dir.dot(cam) - a.dir.dot(cam))
    .slice(0, 6);
  for (const k of continents) setLabel(KIND_LABELS.continent, `${k.name} · ${k.sessions} sessions`, tmpV.copy(k.dir).multiplyScalar(PLANET_R + 5), "continent");
  // Houses: live sessions first, then the nearest dormant ones.
  const houses = [...ctx.store.agents.values()]
    .map((a) => ({ a, p: ctx.agentPosition(a.id) }))
    .filter((x): x is { a: (typeof x)["a"]; p: THREE.Vector3 } => x.p !== undefined)
    .sort((x, y) => (x.a.status === "live" ? 0 : 1) - (y.a.status === "live" ? 0 : 1) || x.p.distanceToSquared(cam) - y.p.distanceToSquared(cam))
    .slice(0, 7);
  for (const x of houses) setLabel("House = a session", short(agentTitle(x.a)), x.p, "house");
  for (const p of instancePositions("cars", 2, ctx)) setLabel(KIND_LABELS.car, "", p, "car");
  for (const p of instancePositions("subagent-drones", 3, ctx)) setLabel(KIND_LABELS.drone, "", p, "drone");
  for (const p of instancePositions("station-props", 2, ctx)) setLabel(KIND_LABELS.station, "", p, "station");
  if (quarterVisible()) {
    for (const id of PLACE_IDS) {
      const p = placeTop(id);
      if (!p) continue;
      const plain =
        id === "jev" ? "routes every prompt"
        : id === "cli" ? "agent-authored CLIs"
        : isMemoryPlace(id) ? memoryPlaceCaption(id)
        : id.startsWith("gate:") ? `hook: ${id.slice(5)}`
        : "a model family";
      setLabel(placeName(id), plain, p, id.startsWith("gate:") ? "gate" : id.startsWith("plant:") ? "plant" : "place");
    }
    for (const id of CAMPUS_IDS) {
      const p = campusTop(id);
      if (p) setLabel(campusName(id), campusCaption(id), p, "place");
    }
    const clinic = clinicTop();
    if (clinic) setLabel(clinicName(), clinicCaption(), clinic, "place");
  }
  const factory = nearestFactory(ctx);
  if (factory) setLabel(KIND_LABELS.routines, "", factory.setLength(factory.length() + 2), "routines");
  const moon = moonPos(ctx);
  if (moon) setLabel(KIND_LABELS.moon, "", moon.setLength(moon.length() + 7), "moon");
  for (let i = used; i < labels.length; i++) {
    const l = labels[i]!;
    l.on = false;
    l.el.hidden = true;
  }
}

function placeLabels(ctx: ClientContext): void {
  for (let i = 0; i < used; i++) {
    const l = labels[i]!;
    if (l.on) place(l.el, toScreen(ctx, l.pos));
  }
}

function hideLabels(): void {
  used = 0;
  for (const l of labels) {
    l.on = false;
    l.el.hidden = true;
  }
}

// ---------------------------------------------------------------- clicks

/** Nearest instance of a named instanced mesh within `px` of a screen point, or -1. */
function nearestInstance(name: string, x: number, y: number, px: number, ctx: ClientContext): number {
  const mesh = ctx.scene.getObjectByName(name);
  if (!(mesh instanceof THREE.InstancedMesh) || !isShown(mesh)) return -1;
  let best = -1;
  let bestD = px * px;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, tmpM);
    if (tmpM.elements[0] === 0 && tmpM.elements[5] === 0) continue;
    const s = toScreen(ctx, tmpV.setFromMatrixPosition(tmpM).applyMatrix4(mesh.matrixWorld));
    if (!s.visible) continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function near(p: THREE.Vector3 | null, x: number, y: number, px: number, ctx: ClientContext): boolean {
  if (!p) return false;
  const s = toScreen(ctx, p);
  return s.visible && (s.x - x) ** 2 + (s.y - y) ** 2 < px * px;
}

function targetAt(x: number, y: number, ctx: ClientContext): ExplainTarget | null {
  const canvas = sceneParts().rig?.renderer.domElement;
  const pick = sceneParts().pick;
  if (!canvas || !pick) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  const p = pick.pick(ndc, ctx.camera, PLANET_R + 0.4);
  if (p?.kind === "system") {
    // Raycasts don't check visibility: with "Hide on the planet → System" on, the quarter's
    // invisible pick proxies would still open cards for places nobody can see.
    if (!quarterVisible()) return null;
    const id = placeForLabel(p.id);
    if (id) return { type: "place", id };
    const campus = campusForLabel(p.id);
    if (campus) return { type: "campus", id: campus };
    return isClinicLabel(p.id) ? { type: "clinic" } : null; // other system targets open orbit-system's own card
  }
  if (!explainOn()) return null;
  if (p?.kind === "agent") return { type: "agent", id: p.id, car: nearestInstance("cars", x, y, 16, ctx) >= 0 };
  if (p?.kind === "city") return { type: "city", id: p.id };
  if (p?.kind === "jev") return { type: "moon" };
  if (p?.kind === "object") return { type: "object", id: p.id };
  // Things the pick registry doesn't know: screen-space nearest.
  if (nearestInstance("subagent-drones", x, y, 18, ctx) >= 0) return { type: "drones" };
  const st = nearestInstance("station-props", x, y, 14, ctx);
  if (st >= 0) {
    const live = [...ctx.store.agents.values()].filter((a) => a.status === "live").slice(0, 40);
    return { type: "station", station: STATION_PROPS[st % STATION_PROPS.length] ?? "other", agentId: live[Math.floor(st / STATION_PROPS.length)]?.id ?? null };
  }
  if (near(nearestFactory(ctx), x, y, 40, ctx)) return { type: "routines" };
  if (near(moonPos(ctx), x, y, 60, ctx)) return { type: "moon" };
  return null;
}

function mountClicks(ctx: ClientContext): void {
  const canvas = sceneParts().rig?.renderer.domElement;
  if (!canvas) return;
  const down = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (ev) => {
    down.x = ev.clientX;
    down.y = ev.clientY;
  });
  canvas.addEventListener("click", (ev) => {
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
    if (ctx.activeView() !== "orbit" || document.body.classList.contains("in-room")) return;
    const t = targetAt(ev.clientX, ev.clientY, ctx);
    if (t) openExplainCard(t);
  });
}

// ---------------------------------------------------------------- toggle: E + the Orbit sidebar section

function isTyping(ev: KeyboardEvent): boolean {
  const t = ev.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function mountKey(ctx: ClientContext): void {
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "e" && ev.key !== "E") return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || isTyping(ev)) return;
    if (ctx.activeView() !== "orbit") return;
    setExplain(!explainOn());
    ctx.toast(explainOn() ? "Explain on: every structure is labelled. Click one for its card." : "Explain off");
  });
}

/** The Orbit sidebar's "Explain" section: the on/off switch and "Take the tour". */
export function renderExplainSection(host: HTMLElement): () => void {
  host.replaceChildren();
  const sw = h("button", "alef-switch xp-switch");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.title = "Label every structure on the planet in plain words (E)";
  const knob = h("i");
  knob.setAttribute("aria-hidden", "true");
  const text = h("span");
  sw.append(knob, text);
  const paint = (): void => {
    sw.setAttribute("aria-checked", String(explainOn()));
    text.textContent = explainOn() ? "Labels on (E)" : "Labels off (E)";
  };
  paint();
  sw.addEventListener("click", () => setExplain(!explainOn()));
  const tour = h("button", "alef-fchip xp-tour", "▶ Take the tour");
  tour.type = "button";
  tour.title = "A 2-minute guided tour of the system (Esc leaves)";
  tour.addEventListener("click", () => startTour());
  const hint = h("p", "xp-hint", "With labels on, click any structure for what it is, what it did today and its live numbers.");
  host.append(sw, tour, hint);
  return onExplainChange(paint);
}

// ---------------------------------------------------------------- feature

export const explainFeature: ClientFeature = {
  id: "explain",
  mount(ctx) {
    ctxRef = ctx;
    mountLabels();
    mountClicks(ctx);
    mountKey(ctx);
    onExplainChange((on) => {
      document.body.classList.toggle("alef-explain", on);
      if (on) lastRefresh = -10;
      else hideLabels();
    });
    document.body.classList.toggle("alef-explain", explainOn());
    onRoutines((list) => (routines = list));
    onWakeRecallSummary(() => {
      if (current?.type === "institute" && cardEl?.isConnected) renderCard(cardEl, ctx);
    });
    onCampusChange(() => {
      if (current?.type === "campus" && cardEl?.isConnected) renderCard(cardEl, ctx);
    });
    onClinicChange(() => {
      if (current?.type === "clinic" && cardEl?.isConnected) renderCard(cardEl, ctx);
    });
    log.info("explain", `explain layer ready (${explainOn() ? "on" : "off"})`);
  },
  onSnapshot(world: WorldSnapshot) {
    const docs = world.extras?.["recall.docCount"];
    const ready = world.extras?.["recall.ready"];
    if (typeof docs === "number" && Number.isFinite(docs) && typeof ready === "boolean") recallIndex = { docCount: docs, ready };
    const r = world.extras?.[ROUTINES_EXTRAS_KEY];
    if (!routines && isRecord(r) && Array.isArray((r as unknown as RoutinesPayload).routines)) routines = (r as unknown as RoutinesPayload).routines;
  },
  onFrame(_dt, ctx) {
    if (!explainOn() || ctx.activeView() !== "orbit") {
      if (used > 0) hideLabels();
      return;
    }
    const elapsed = ctx.elapsed();
    if (elapsed - lastRefresh > 1) {
      lastRefresh = elapsed;
      refreshLabels(ctx);
    }
    placeLabels(ctx);
  },
  panels: [{ id: PANEL_ID, title: "What is this?", render: (el, ctx) => renderCard(el, ctx) }],
  paletteCommands: (ctx) => [
    {
      id: "toggle",
      title: explainOn() ? "Explain: hide the labels" : "Explain: label every structure",
      kind: "command",
      keywords: ["explain", "labels", "what is", "legend", "help"],
      run: () => {
        if (ctx.activeView() !== "orbit") ctx.showView("orbit");
        setExplain(!explainOn());
      },
    },
    {
      id: "institute-of-truth",
      title: `${INSTITUTE_OF_TRUTH}: the second brain`,
      kind: "place",
      keywords: ["institute", "truth", "second brain", "memory", "vault", "recall", "wake"],
      run: () => openExplainCard({ type: "institute" }),
    },
    ...CAMPUS_IDS.map((id) => ({
      id: `campus-${id}`,
      title: `Campus: ${campusName(id).replace(/^\S+\s/, "")}`,
      kind: "place",
      keywords: ["campus", "graduation", id === "school" ? "school study upskill lamp" : "hall graduates banners trusted shipped"],
      run: () => openExplainCard({ type: "campus", id }),
    })),
    {
      id: "place-clinic",
      title: "System Quarter: Clinic",
      kind: "place",
      keywords: ["clinic", "sick", "sickness", "hospital", "marks", "system"],
      run: () => openExplainCard({ type: "clinic" }),
    },
    ...PLACE_IDS.map((id) => ({
      id: `place-${id}`,
      title: `${isMemoryPlace(id) ? INSTITUTE_OF_TRUTH : "System Quarter"}: ${placeName(id).replace(/^\S+\s/, "")}`,
      kind: "place",
      keywords: ["system", id.startsWith("gate:") ? GATE_TEXT[id.slice(5) as GateEvent].short : "", id],
      run: () => openExplainCard({ type: "place", id }),
    })),
  ],
};
