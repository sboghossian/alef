// Scheduled routines as factories: a small ring of factory buildings near Harness City,
// one per ~/Library/LaunchAgents/com.stephane.*.plist job, colored by its last exit
// status, puffing when it ran in the last 5 minutes. The panel is the full list — the
// district is ambient flavor (agent-world has no generic "clickable custom prop" hook
// for features to add to the existing pick system, so per-building detail lives there).

import * as THREE from "three";
import type { AutomationsResponse } from "../../../shared/features/automations";
import type { Routine, RoutinesPayload } from "../../../shared/features/routines";
import { ROUTINES_EXTRAS_KEY } from "../../../shared/features/routines";
import { PLANET_R } from "../layout";
import { toon } from "../scene/toon";
import { fillDispatchBox, WORKFLOW_DRAG_MIME } from "../ui/dispatch";
import { cityForOutputDir, workflowPrompt } from "./automations-lib";
import type { ClientContext, ClientFeature } from "./registry";
import { factorySlots, formatCountdown } from "./routines-lib";

const RING_RADIUS = 15;
const RING_SPACING = 4.5;
const PUFF_LIFE = 2.4;

function statusColor(r: Routine): number {
  if (r.lastExitStatus === null) return 0xcac3da; // never run / unknown
  return r.lastExitStatus === 0 ? 0x6fd23f : 0xff6b57;
}

interface FactoryEntry {
  group: THREE.Group;
  chimneyTopLocal: THREE.Vector3;
}

function buildFactoryMesh(color: number): FactoryEntry {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), toon(color));
  body.position.y = 0.45;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 1.15), toon(0x4a4460));
  roof.position.y = 0.99;
  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.9, 8), toon(0x8a7fa0));
  chimney.position.set(0.32, 1.35, 0.28);
  group.add(body, roof, chimney);
  return { group, chimneyTopLocal: chimney.position.clone().add(new THREE.Vector3(0, 0.45, 0)) };
}

function tangentBasis(dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const ref = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(t1, dir).normalize();
  return [t1, t2];
}

interface Puff {
  mesh: THREE.Mesh;
  born: number;
}

let district: THREE.Group | null = null;
let entries: FactoryEntry[] = [];
let puffs: Puff[] = [];
let puffGeo: THREE.SphereGeometry | null = null;
let puffMat: THREE.MeshToonMaterial | null = null;
let routines: Routine[] = [];
/** Every host the list is drawn in: the right rail's Controls › Routines pane and Setup's
 *  Routines view (views/routines.ts) can both be up, and both follow live updates. */
const panelEls = new Set<HTMLElement>();
function rerender(ctx?: ClientContext): void {
  for (const el of panelEls) {
    if (el.isConnected) renderRoutinesPanel(el, ctx);
    else panelEls.delete(el);
  }
}
/** id (== a routine's shortName) -> the merged Automation record from /api/automations, which
 *  already knows the real skill command (dispatchCommand) and output dir for each routine that
 *  a launchd job runs. Round 11, package D: "Routines -> prompt". */
let automationsById = new Map<string, { dispatchCommand: string | null; description: string | null; outputDir: string | null; name: string }>();
/** shortName -> the ready-to-send prompt + city for that row, rebuilt every render so the drag
 *  handler (attached once) and the "-> prompt" button always read the current value. */
let workflowByShortName = new Map<string, { prompt: string; cityId: string | null }>();

async function refreshAutomationsCache(ctx: ClientContext): Promise<void> {
  const res = await ctx.api.getJson<AutomationsResponse>("/api/automations", 30_000);
  if (!res?.ok) return;
  automationsById = new Map(res.automations.map((a) => [a.id, a]));
  rerender(ctx);
}

function rebuildDistrict(ctx: ClientContext): void {
  if (!district) return;
  for (const e of entries) {
    district.remove(e.group);
    e.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
  entries = [];

  const harnessTop = ctx.cityPosition("harness");
  if (!harnessTop) return;
  const dir = harnessTop.clone().normalize();
  const [t1, t2] = tangentBasis(dir);
  const slots = factorySlots(routines.length);
  const spawnedPuffAgents = new Set<string>();

  routines.forEach((r, i) => {
    const slot = slots[i]!;
    const radius = RING_RADIUS + slot.ring * RING_SPACING;
    const offset = t1.clone().multiplyScalar(Math.cos(slot.angle) * radius).add(t2.clone().multiplyScalar(Math.sin(slot.angle) * radius));
    const placeDir = dir.clone().multiplyScalar(PLANET_R).add(offset).normalize();
    const entry = buildFactoryMesh(statusColor(r));
    const pos = ctx.surfacePoint(placeDir, 0);
    entry.group.position.copy(pos);
    entry.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), placeDir);
    district!.add(entry.group);
    entries.push(entry);
    entry.group.updateMatrixWorld(true);

    if (r.ranRecently && puffGeo && puffMat && !spawnedPuffAgents.has(r.label)) {
      spawnedPuffAgents.add(r.label);
      const mesh = new THREE.Mesh(puffGeo, puffMat);
      mesh.position.copy(entry.group.localToWorld(entry.chimneyTopLocal.clone()));
      mesh.scale.setScalar(0.01);
      district!.add(mesh);
      puffs.push({ mesh, born: ctx.elapsed() });
    }
  });
}

/** The ready-to-send prompt + city for one routine: the merged automation's real skill command
 *  when a launchd job maps to one, else a plain instruction from the routine's own real fields
 *  (shortName + skillDescription) — never an invented workflow. */
function workflowFor(r: Routine, ctx: ClientContext): { prompt: string; cityId: string | null } {
  const a = automationsById.get(r.shortName);
  if (a) {
    return {
      prompt: workflowPrompt(a),
      cityId: cityForOutputDir(a.outputDir, [...ctx.store.islands.values()]),
    };
  }
  return { prompt: workflowPrompt({ name: r.shortName, description: r.skillDescription, dispatchCommand: null }), cityId: null };
}

function onRoutinesRowDragStart(ev: DragEvent): void {
  const row = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-routine]") : null;
  const wf = row?.dataset.routine ? workflowByShortName.get(row.dataset.routine) : undefined;
  if (!wf || !ev.dataTransfer) return;
  ev.dataTransfer.effectAllowed = "copy";
  ev.dataTransfer.setData(WORKFLOW_DRAG_MIME, JSON.stringify(wf));
  ev.dataTransfer.setData("text/plain", wf.prompt);
}

function onRoutinesPanelClick(ev: Event): void {
  const btn = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-to-prompt]") : null;
  const wf = btn?.dataset.toPrompt ? workflowByShortName.get(btn.dataset.toPrompt) : undefined;
  if (wf) fillDispatchBox(wf);
}

/** Draws the routines list into `el` and keeps it live (also the Routines view's body). */
export function renderRoutinesPanel(el: HTMLElement, ctx?: ClientContext): void {
  panelEls.add(el);
  if (routines.length === 0) {
    el.innerHTML = `<p>No <code>com.stephane.*</code> routines found in ~/Library/LaunchAgents.</p>`;
    return;
  }
  const now = Date.now();
  workflowByShortName = new Map(ctx ? routines.map((r) => [r.shortName, workflowFor(r, ctx)]) : []);
  el.innerHTML = `<ul class="routines-list">${routines
    .map((r) => {
      const dotClass = r.lastExitStatus === null ? "unknown" : r.lastExitStatus === 0 ? "ok" : "bad";
      const desc = r.skillDescription ? `<div class="routines-desc">${escapeHtml(r.skillDescription)}</div>` : "";
      const draggable = workflowByShortName.has(r.shortName);
      return `<li class="routines-row" data-routine="${escapeHtml(r.shortName)}" draggable="${draggable}" title="Drag to the prompt box, or use → prompt">
        <i class="routines-dot ${dotClass}"></i>
        <div class="routines-info">
          <div class="routines-name">${escapeHtml(r.shortName)}${r.running ? " <span class=\"routines-running\">running</span>" : ""}</div>
          <div class="routines-meta">${escapeHtml(r.schedule.text)} · ${r.loaded === false ? "paused (not loaded)" : formatCountdown(r.schedule.nextRunAt, now)}${r.lastExitStatus !== null ? ` · last exit ${r.lastExitStatus}` : ""}</div>
          ${desc}
        </div>
        ${draggable ? `<button type="button" class="routines-to-prompt" data-to-prompt="${escapeHtml(r.shortName)}" aria-label="Send ${escapeHtml(r.shortName)}'s workflow to the prompt box">→ prompt</button>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
  if (el.dataset.wfWired !== "1") {
    el.dataset.wfWired = "1";
    el.addEventListener("dragstart", onRoutinesRowDragStart);
    el.addEventListener("click", onRoutinesPanelClick);
  }
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export const routinesFeature: ClientFeature = {
  id: "routines",
  mount(ctx) {
    district = new THREE.Group();
    district.name = "routines-district";
    ctx.scene.add(district);
    puffGeo = new THREE.SphereGeometry(1, 8, 6);
    puffMat = toon(0xffffff, { transparent: true, opacity: 0.7 });
    void refreshAutomationsCache(ctx);
  },
  onSnapshot(world, ctx) {
    const payload = world.extras?.[ROUTINES_EXTRAS_KEY] as RoutinesPayload | undefined;
    if (!payload) return;
    routines = payload.routines;
    rebuildDistrict(ctx);
    rerender(ctx);
    for (const fn of routineListeners) fn(routines);
  },
  onMessage(msg, ctx) {
    const payload = msg.payload as Partial<RoutinesPayload> | undefined;
    if (!payload || !Array.isArray(payload.routines)) return;
    routines = payload.routines;
    rebuildDistrict(ctx);
    rerender(ctx);
    void refreshAutomationsCache(ctx); // a routine's next run rotated in — pick up any new/changed skill command
    for (const fn of routineListeners) fn(routines);
  },
  onFrame(dt, ctx) {
    if (puffs.length === 0) return;
    const elapsed = ctx.elapsed();
    puffs = puffs.filter((p) => {
      const age = elapsed - p.born;
      if (age > PUFF_LIFE) {
        district?.remove(p.mesh);
        return false;
      }
      const t = age / PUFF_LIFE;
      p.mesh.scale.setScalar(0.3 + t * 1.1);
      p.mesh.position.y += dt * 0.6;
      const mat = p.mesh.material as THREE.MeshToonMaterial;
      mat.opacity = 0.7 * (1 - t);
      return true;
    });
  },
  hudButtons: [{ id: "open", label: "🏭", title: "Scheduled routines", text: "Routines", onClick: (ctx) => ctx.openPanel("routines") }],
  panels: [{ id: "routines", title: "Routines", render: renderRoutinesPanel }],
};

// ---- Alef Feed: routine runs (shell/feed-sources.ts diffs consecutive lists) ----
const routineListeners = new Set<(list: Routine[]) => void>();

/** The routines known now (empty until the first snapshot, or when there are none). */
export function currentRoutines(): readonly Routine[] {
  return routines;
}

/** Called with the full routines list on every snapshot / update. */
export function onRoutines(fn: (list: Routine[]) => void): () => void {
  routineListeners.add(fn);
  return () => routineListeners.delete(fn);
}
