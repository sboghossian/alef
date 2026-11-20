// Archive: fossils of the sessions only the vault remembers (server/features/archive.ts). They are
// dormant forever and can never be reactivated (Claude Code pruned the transcript), so they are
// drawn as cheap props, not agents: ONE InstancedMesh for every fossil on the planet (one draw
// call however many there are), laid out once per archive summary:
//   island place   a sunflower ring just outside that city's ring road
//   topic place    around the home folder's neighbourhood in that continent (else a field in it)
//   archived place a field of its own inside its continent, at an angle hashed from the slug
// Hover shows the title (hub tooltip, via a "system" pick); click opens the Fossil panel with the
// date, project and an obsidian:// link to the vault note. "Show: archived" in the Orbit sidebar
// hides them (default on); they also hide under the live / waiting / today filters, and from the
// far overview (camera beyond FAR), where each would be a pixel or two.
// Debug: ?archive=off starts hidden (for before/after frame-time comparisons).

import * as THREE from "three";
import { agentTitle, displayTitle } from "../../../shared/display";
import { isArchiveList, isArchiveSummary, type ArchiveList, type ArchivePlace, type ArchivedSession } from "../../../shared/features/archive";
import { CITY_H, CITY_SURFACE, PLANET_R, cityPoint, type CityLayout } from "../layout";
import { log } from "../log";
import { redactOn } from "../redact";
import { sceneParts } from "../scene/scene-bus";
import { toon } from "../scene/toon";
import { projectLocal, tangentBasis } from "../topic-layout";
import { obsidianUrl } from "../views/brain-lib";
import { fossilOffset, hash32 } from "./archive-lib";
import { archiveSummary, archiveVisible, autoDistricts, onArchiveChange, setArchiveSummary, setArchiveVisible, setAutoDistricts } from "./archive-state";
import {
  AUTO_GROUP,
  AUTO_TOPIC_PLACE,
  addLiveToLot,
  archivedFieldLocal,
  computeAutoDistricts,
  isAutoHomeSession,
  lotLabel,
  lotRunNotes,
  orderLotRows,
  planNewAutoLot,
  slotDir,
  type AutoDistricts,
} from "./auto-districts-lib";
import { orbitFilters } from "./orbit-filters";
import { subagentData } from "./subagent-data";
import type { ClientContext, ClientFeature } from "./registry";
import { topicsState } from "./topics-state";
import "./archive.css";

const PANEL_ID = "archive";
const BONE = new THREE.Color("#efe4c8");
const LIST_CAP = 60;
/** Beyond this camera distance a fossil is a pixel or two: skip the draw call entirely. */
const FAR = PLANET_R * 2.4;

let ctxRef: ClientContext | null = null;
let list: ArchiveList | null = null;
let mesh: THREE.InstancedMesh | null = null;
/** Instance index → session; label → first instance index (the hover label is the pick id). */
let bySlot: ArchivedSession[] = [];
const slotByLabel = new Map<string, number>();
let selection: { kind: "session"; id: string } | { kind: "place"; key: string } | { kind: "lot"; key: string } | null = null;
let loading = false;
let loadedFor = "";
/** Filters / "Show: archived" allow fossils; onFrame adds the camera-distance cut. */
let wanted = true;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function titleOf(s: ArchivedSession): string {
  return redactOn() ? "…" : displayTitle(s.title);
}

function labelOf(s: ArchivedSession): string {
  return `🦴 Fossil · ${s.date || "undated"} · ${titleOf(s)}`;
}

function groupName(key: string): string {
  return topicsState()?.map.groups.find((g) => g.key === key)?.name ?? key;
}

function placeLabel(p: Pick<ArchivePlace, "kind" | "ref">, ctx: ClientContext): string {
  if (p.kind === "island") return ctx.store.islands.get(p.ref)?.name ?? p.ref;
  if (p.kind === "topic") return `${groupName(p.ref)} · home-folder runs`;
  return `${p.ref} (archived district)`;
}

function placeOf(key: string): ArchivePlace | undefined {
  return list?.summary.places.find((p) => p.key === key);
}

// ── layout ────────────────────────────────────────────────────────────────────────────────

interface Anchor {
  dir: THREE.Vector3;
  t1: THREE.Vector3;
  t2: THREE.Vector3;
  /** Inner radius of the fossil ring (tangent units). */
  r0: number;
}

function ring(c: CityLayout): Anchor {
  return { dir: c.dir, t1: c.t1, t2: c.t2, r0: c.radius + 2.6 };
}

/** A field of its own inside a continent, at an angle hashed from the place key. */
function continentField(group: string, key: string): Anchor | null {
  const st = topicsState();
  const cont = st?.layout.continents.find((c) => c.key === group) ?? st?.layout.continents[0];
  if (!cont) return null;
  const [x, z] = archivedFieldLocal(key, cont.angle, CITY_SURFACE);
  const dir = projectLocal(cont.dir, cont.t1, cont.t2, x, z);
  const [t1, t2] = tangentBasis(dir);
  return { dir, t1, t2, r0: 0.4 };
}

function anchorFor(p: ArchivePlace, byId: ReadonlyMap<string, CityLayout>, homeId: string | null): Anchor | null {
  const continentOf = (id: string): string | undefined => topicsState()?.layout.continentOf.get(id);
  if (p.kind === "island") {
    const c = byId.get(p.ref);
    return c ? ring(c) : null;
  }
  if (p.kind === "topic" && homeId) {
    const c = byId.get(`${homeId}~${p.ref}`) ?? (continentOf(homeId) === p.ref || !topicsState() ? byId.get(homeId) : undefined);
    if (c) return ring(c);
  }
  const field = continentField(p.group, p.key);
  if (field) return field;
  const home = homeId ? byId.get(homeId) : undefined;
  return home ? ring(home) : null;
}

function disposeMesh(): void {
  if (!mesh) return;
  sceneParts().pick?.unregister(mesh);
  mesh.removeFromParent();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  mesh = null;
}

/** The AUTO continent's sub-districts for this archive list, or null (no topics / no AUTO continent). */
function computeAuto(ctx: ClientContext, l: ArchiveList): AutoDistricts | null {
  const st = topicsState();
  const continent = st?.layout.continents.find((c) => c.key === AUTO_GROUP);
  if (!st || !continent) return null;
  const catchAll = new Set(st.map.catchAll);
  // Same rule as the upsert path (isAutoHomeSession): the boot map's answer when it has one, else the
  // title's automationKey, so a rescan never drops a session that was placed by its title after boot.
  const live = [...ctx.store.agents.values()]
    .filter((a) => isAutoHomeSession(a, catchAll, (id) => st.map.sessions[id]?.group))
    .map((a) => ({ id: a.id, title: a.title }));
  const fossils = l.sessions.filter((s) => s.place === AUTO_TOPIC_PLACE).map((s) => ({ id: s.id, title: s.title }));
  const d = computeAutoDistricts({
    continent,
    continentKeys: st.layout.continents.map((c) => c.key),
    layout: st.layout.layout,
    places: l.summary.places,
    live,
    fossils,
    surface: CITY_SURFACE,
  });
  if (d.crowded.length) log.warn("archive", `automation lots overlapping a neighbour (continent full): ${d.crowded.join(", ")}`);
  return d;
}

/** Moves each live AUTO home-folder house into its automation's lot (instance matrices only).
 *  `only`, when given, limits this to those ids (a house already sitting in its lot needn't move
 *  again — see onAgentsUpserted). */
function moveLiveHouses(d: AutoDistricts, only?: ReadonlySet<string>): void {
  const agents = sceneParts().agents;
  const ground = sceneParts().planet;
  if (!agents) return;
  const at = new THREE.Vector3();
  for (const lot of d.lots) {
    for (const id of lot.live) {
      if (only && !only.has(id)) continue;
      const slot = d.slots.get(id);
      if (!slot) continue;
      cityPoint(lot.frame, slot.x, slot.z, 0, at).normalize();
      const y = ground ? Math.max(0, ground.groundHeight(at)) - CITY_H : 0;
      agents.moveHouse(id, lot.frame, slot.x, slot.z, y);
    }
  }
}

/**
 * A live AUTO home-folder session that starts after boot (only the boot-time map moved houses
 * before this): the moment its upsert is in, moves its house into the same lot boot would have
 * put it in — reusing the current lots exactly as they stand, never recomputing one. Deferred a
 * microtask past the store's dispatch loop so this runs after agentsVisual.upsert has given the
 * agent its house, whichever of the two store.onAgents listeners fired first.
 */
function onAgentsUpserted(batch: readonly { id: string; islandId: string; title: string }[]): void {
  queueMicrotask(() => {
    const st = topicsState();
    let next = autoDistricts();
    if (!st || !next) return;
    const catchAll = new Set(st.map.catchAll);
    const groupOf = (id: string): string | undefined => st.map.sessions[id]?.group;
    const moved = new Set<string>();
    for (const a of batch) {
      const lotKey = planNewAutoLot(a, catchAll, groupOf, next);
      if (!lotKey) continue;
      next = addLiveToLot(next, lotKey, a.id);
      moved.add(a.id);
    }
    if (!moved.size) return;
    setAutoDistricts(next);
    moveLiveHouses(next, moved);
  });
}

function build(ctx: ClientContext): void {
  disposeMesh();
  bySlot = [];
  slotByLabel.clear();
  // Sub-districts first, even with zero fossils: live AUTO houses still get their lots, and a
  // stale result from an earlier list is always replaced (or cleared).
  const auto = list ? computeAuto(ctx, list) : null;
  if (auto) moveLiveHouses(auto);
  setAutoDistricts(auto);
  if (!list || list.sessions.length === 0) return;
  const byId = new Map((sceneParts().layout ?? []).map((c) => [c.id, c]));
  const sessionsByPlace = new Map<string, ArchivedSession[]>();
  for (const s of list.sessions) {
    const arr = sessionsByPlace.get(s.place) ?? [];
    arr.push(s);
    sessionsByPlace.set(s.place, arr);
  }
  const placed: { s: ArchivedSession; pos: THREE.Vector3; normal: THREE.Vector3; group: string }[] = [];
  let unplaced = 0;
  for (const p of list.summary.places) {
    const sessions = sessionsByPlace.get(p.key) ?? [];
    const a = anchorFor(p, byId, list.summary.homeIslandId);
    if (!a) {
      unplaced += sessions.length;
      continue;
    }
    const seed = ((hash32(p.key) % 1000) / 1000) * Math.PI * 2;
    const group = p.kind === "island" ? (topicsState()?.layout.continentOf.get(p.ref) ?? "") : p.group;
    sessions.forEach((s, i) => {
      const slot = p.key === AUTO_TOPIC_PLACE ? auto?.slots.get(s.id) : undefined;
      const lot = slot && auto?.lots.find((x) => x.key === slot.key);
      if (slot && lot) {
        const dir = slotDir(lot, slot.x, slot.z);
        placed.push({ s, pos: ctx.surfacePoint(dir, 0.08), normal: dir, group });
        return;
      }
      const [x, z] = fossilOffset(i, a.r0, seed);
      const dir = projectLocal(a.dir, a.t1, a.t2, x, z);
      placed.push({ s, pos: ctx.surfacePoint(dir, 0.08), normal: dir, group });
    });
  }
  if (unplaced) log.warn("archive", `${unplaced} fossils have no place on this planet (no matching city or continent)`);
  if (placed.length === 0) return;

  const geo = new THREE.OctahedronGeometry(0.22, 0); // 8 triangles: ~14k for the whole archive
  geo.scale(1, 0.55, 1.25);
  const m = new THREE.InstancedMesh(geo, toon("#ffffff"), placed.length);
  m.name = "archive-fossils";
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const yaw = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const color = new THREE.Color();
  const groupColor = new Map((topicsState()?.map.groups ?? []).map((g) => [g.key, new THREE.Color(g.color)]));
  placed.forEach((f, i) => {
    const h = hash32(f.s.id);
    q.setFromUnitVectors(up, f.normal);
    yaw.setFromAxisAngle(up, ((h % 360) * Math.PI) / 180);
    q.multiply(yaw);
    const k = 0.8 + ((h >>> 9) % 40) / 100;
    scale.set(k, k, k);
    m.setMatrixAt(i, mat.compose(f.pos, q, scale));
    const tint = groupColor.get(f.group);
    color.copy(BONE);
    if (tint) color.lerp(tint, 0.28);
    m.setColorAt(i, color);
    bySlot[i] = f.s;
    const label = labelOf(f.s);
    if (!slotByLabel.has(label)) slotByLabel.set(label, i);
  });
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere();
  ctx.scene.add(m);
  sceneParts().pick?.register(m, (i) => {
    const s = i === undefined ? undefined : bySlot[i];
    return s && m.visible ? { kind: "system", id: labelOf(s) } : null;
  });
  mesh = m;
  applyVisibility();
  log.info("archive", `${placed.length} fossils in one instanced mesh (1 draw call)`);
}

function applyVisibility(): void {
  const st = orbitFilters.get().state;
  wanted = archiveVisible() && (st === "all" || st === "dormant");
  if (mesh && !wanted) mesh.visible = false;
}

async function load(ctx: ClientContext): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const raw = await ctx.api.getJson<unknown>("/api/archive", 20_000);
    if (!isArchiveList(raw)) {
      log.warn("archive", "archive list unavailable or malformed; fossils not drawn");
      return;
    }
    list = raw;
    loadedFor = raw.summary.generatedAt;
    setArchiveSummary(raw.summary);
    build(ctx);
  } finally {
    loading = false;
  }
}

// ── panel ─────────────────────────────────────────────────────────────────────────────────

function sessionRow(s: ArchivedSession): string {
  return `<li><button type="button" class="archive-row" data-archive-session="${esc(s.id)}"><span class="archive-date">${esc(s.date || "undated")}</span><span class="archive-title">${esc(titleOf(s))}</span></button></li>`;
}

function renderList(sessions: readonly ArchivedSession[], skipId?: string): string {
  const rows = sessions.filter((s) => s.id !== skipId);
  if (!rows.length) return "";
  const more = rows.length > LIST_CAP ? `<li class="archive-more">and ${rows.length - LIST_CAP} more</li>` : "";
  return `<ul class="archive-list">${rows.slice(0, LIST_CAP).map(sessionRow).join("")}${more}</ul>`;
}

function render(el: HTMLElement, ctx: ClientContext): void {
  el.className = "archive-card";
  const summary = list?.summary ?? archiveSummary();
  if (!list || !summary) {
    el.innerHTML = `<p class="note">The archive hasn't loaded yet. It reads the vault's session notes once at boot.</p>`;
    return;
  }
  const foot = `<p class="note">Fossils are sessions only the vault remembers: Claude Code pruned their transcripts, so they stay dormant and can't be reactivated. ${summary.total} archived · ${summary.skippedLive} already live in the world · ${summary.duplicates} duplicate notes merged.</p>`;
  const sel = selection;
  const lot = sel?.kind === "lot" ? autoDistricts()?.lots.find((x) => x.key === sel.key) : undefined;
  if (lot) {
    const fossilIds = new Set(lot.archived);
    // How each run ended (API error, cut off, interrupted; or its failed subagents), failed first.
    const notes = lotRunNotes(lot.live, subagentData.runEndings, subagentData.records.values());
    const failedCount = [...notes.values()].filter((n) => n.status === "failed").length;
    const liveRows = orderLotRows(lot.live, notes).map((id) => {
      const a = ctx.store.agents.get(id);
      const title = redactOn() ? "…" : (a ? agentTitle(a) : id);
      const n = notes.get(id);
      const why = n ? `<span class="archive-run archive-run-${n.status}">${n.status === "failed" ? "❌" : "⏹"} ${esc(redactOn() ? n.status : n.text)}</span>` : "";
      return `<li><button type="button" class="archive-row${n ? " archive-row-run" : ""}" data-archive-agent="${esc(id)}"><span class="archive-date">${esc(a?.lastActive.slice(0, 10) ?? "live")}</span><span class="archive-title">${esc(title)}</span>${why}</button></li>`;
    });
    const name = redactOn() ? "…" : lotLabel(lot);
    el.innerHTML = `<p class="sub">Automated Runs · ${lot.live.length} live · ${lot.archived.length} archived${failedCount ? ` · <b class="archive-run-failed">${failedCount} failed</b>` : ""}</p><h3>${esc(name)}</h3>
      ${liveRows.length ? `<h4>Live (${liveRows.length})</h4><ul class="archive-list">${liveRows.slice(0, LIST_CAP).join("")}</ul>` : ""}
      ${lot.archived.length ? `<h4>🦴 Archived (${lot.archived.length})</h4>${renderList(list.sessions.filter((x) => fossilIds.has(x.id)))}` : ""}${foot}`;
    return;
  }
  const s = sel?.kind === "session" ? list.sessions.find((x) => x.id === sel.id) : undefined;
  const placeKey = s?.place ?? (sel?.kind === "place" ? sel.key : undefined);
  const place = placeKey ? placeOf(placeKey) : undefined;
  const here = placeKey ? list.sessions.filter((x) => x.place === placeKey) : [];
  if (s) {
    const url = obsidianUrl(s.note, summary.vault);
    el.innerHTML = `<p class="sub">🦴 Fossil · dormant forever</p><h3>${esc(titleOf(s))}</h3>
      <div class="kv"><b>Date</b><span>${esc(s.date || "undated")}</span><b>Project</b><span>${esc(s.project)}</span><b>District</b><span>${esc(place ? placeLabel(place, ctx) : s.place)}</span><b>Session</b><span class="archive-id">${esc(s.id)}</span></div>
      <p><a class="archive-open" href="${esc(url)}">Open the vault note in Obsidian</a></p>
      ${here.length > 1 ? `<h4>Other fossils here (${here.length - 1})</h4>${renderList(here, s.id)}` : ""}${foot}`;
    return;
  }
  if (place) {
    el.innerHTML = `<p class="sub">🦴 ${place.count} archived session${place.count === 1 ? "" : "s"}</p><h3>${esc(placeLabel(place, ctx))}</h3>${renderList(here)}${foot}`;
    return;
  }
  const top = list.summary.places.slice(0, 15).map((p) => `<li><button type="button" class="archive-row" data-archive-place="${esc(p.key)}"><span class="archive-date">${p.count}</span><span class="archive-title">${esc(placeLabel(p, ctx))}</span></button></li>`);
  el.innerHTML = `<p class="sub">🦴 ${summary.total} fossils on the planet</p><h3>The archive</h3><ul class="archive-list">${top.join("")}</ul>${foot}`;
}

function onPanelClick(ev: Event): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  const id = t?.closest<HTMLElement>("[data-archive-session]")?.dataset.archiveSession;
  const key = t?.closest<HTMLElement>("[data-archive-place]")?.dataset.archivePlace;
  const agent = t?.closest<HTMLElement>("[data-archive-agent]")?.dataset.archiveAgent;
  if (agent) ctxRef?.flyTo(agent);
  else if (id) openArchiveSession(id);
  else if (key) openArchivePlace(key);
}

function open(): void {
  ctxRef?.openPanel(PANEL_ID);
}

export function openArchiveSession(id: string): void {
  selection = { kind: "session", id };
  open();
}

/** A Districts row for an archived-only district (or any place key): list it and fly near it. */
export function openArchivePlace(key: string): void {
  selection = { kind: "place", key };
  open();
  const ctx = ctxRef;
  const p = placeOf(key);
  if (!ctx || !p) return;
  if (p.kind === "island") ctx.flyTo(p.ref);
  else {
    // No city of its own: fly to the busiest city of its continent.
    const cont = topicsState()?.layout.continents.find((c) => c.key === p.group);
    const target = cont?.cities.slice().sort((a, b) => (ctx.store.islands.get(b)?.agentCount ?? 0) - (ctx.store.islands.get(a)?.agentCount ?? 0))[0];
    if (target) ctx.flyTo(target);
  }
}

/** A Districts row for one of Automated Runs' sub-districts: list its sessions, fly to its lot. */
export function openAutoLot(key: string): void {
  selection = { kind: "lot", key };
  open();
  const lot = autoDistricts()?.lots.find((x) => x.key === key);
  const ctx = ctxRef;
  if (!ctx || !lot) return;
  // No city of its own: fly to a live house in the lot, else to the continent's busiest city.
  if (lot.live[0]) ctx.flyTo(lot.live[0]);
  else {
    const cont = topicsState()?.layout.continents.find((c) => c.key === AUTO_GROUP);
    const target = cont?.cities.slice().sort((a, b) => (ctx.store.islands.get(b)?.agentCount ?? 0) - (ctx.store.islands.get(a)?.agentCount ?? 0))[0];
    if (target) ctx.flyTo(target);
  }
}

function mountPicking(ctx: ClientContext): void {
  const canvas = sceneParts().rig?.renderer.domElement;
  if (!canvas) return;
  const down = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (ev) => {
    down.x = ev.clientX;
    down.y = ev.clientY;
  });
  canvas.addEventListener("click", (ev) => {
    if (!mesh?.visible || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6 || document.body.classList.contains("in-room")) return;
    const pick = sceneParts().pick;
    if (!pick) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const p = pick.pick(ndc, ctx.camera, PLANET_R + 0.4);
    const slot = p?.kind === "system" ? slotByLabel.get(p.id) : undefined;
    const s = slot === undefined ? undefined : bySlot[slot];
    if (s) openArchiveSession(s.id);
  });
}

export const archiveFeature: ClientFeature = {
  id: "archive",
  mount(ctx) {
    ctxRef = ctx;
    if (new URLSearchParams(window.location.search).get("archive") === "off") setArchiveVisible(false);
    orbitFilters.onChange(applyVisibility);
    onArchiveChange(applyVisibility);
    mountPicking(ctx);
    ctx.store.onAgents(onAgentsUpserted);
    void load(ctx);
  },
  onFrame(_dt, ctx) {
    if (mesh) mesh.visible = wanted && ctx.camera.position.length() < FAR;
  },
  onSnapshot(world, ctx) {
    const s = world.extras?.["archive.summary"];
    if (isArchiveSummary(s) && s.generatedAt !== loadedFor) void load(ctx);
  },
  onMessage(msg, ctx) {
    const p = msg.payload as { kind?: unknown; summary?: unknown } | null;
    if (p?.kind === "summary" && isArchiveSummary(p.summary) && p.summary.generatedAt !== loadedFor) void load(ctx);
  },
  panels: [
    {
      id: PANEL_ID,
      title: "Fossil",
      render(el, ctx) {
        render(el, ctx);
        el.addEventListener("click", onPanelClick);
      },
    },
  ],
  paletteCommands: () => [
    {
      id: "open",
      title: `Archive: ${archiveSummary()?.total ?? 0} fossils (vault-only sessions)`,
      kind: "panel",
      keywords: ["archive", "fossil", "vault", "old sessions", "history", "pruned"],
      run: () => {
        selection = null;
        open();
      },
    },
    {
      id: "toggle",
      title: archiveVisible() ? "Archive: hide fossils" : "Archive: show fossils",
      kind: "filter",
      keywords: ["archive", "fossil", "show", "hide"],
      run: () => setArchiveVisible(!archiveVisible()),
    },
  ],
};
