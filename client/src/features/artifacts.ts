// "artifacts": every claude.ai artifact our sessions published or worked with, in the world.
// Each one is a framed board hung on the tower of the district whose session published it, and
// again on the Museum island's tower (artifacts-lib.ts places them). A click on a board, the
// Museum row in Settings or the "Museum" search command opens the gallery modal (artifacts-modal.ts)
// with the artifact's preview. Off WebGL (browse, a lost context) there are no boards; the modal
// still opens from the menu. ?redact=1: boards and rows never show a title, previews never load.

import * as THREE from "three";
import { artifactAt, isArtifactsSummary, MUSEUM_ISLAND_ID, artifactMonth, type ArtifactItem, type ArtifactsResponse } from "../../../shared/features/artifacts";
import { cityMatrix, PLANET_R, type CityLayout } from "../layout";
import { log } from "../log";
import { redactOn } from "../redact";
import { onSceneParts, sceneParts } from "../scene/scene-bus";
import { toon } from "../scene/toon";
import "./artifacts.css";
import { artifactLabel, BOARD_D, BOARD_H, BOARD_W, frameColor, planBoards, type PlacedBoard } from "./artifacts-lib";
import { mountGallery, type Gallery } from "./artifacts-modal";
import type { ClientContext, ClientFeature } from "./registry";

/** Hover labels of our boards start with this (the hub shows a "system" pick's id as its tooltip). */
const LABEL_MARK = "🖼 ";
const CANVAS_COLORS = [0xfff7e0, 0xffffff, 0xfdf2ff, 0xeefcff];

let gallery: Gallery | null = null;
let items: ArtifactItem[] = [];
let rev = -1;
let loading: Promise<void> | null = null;
let boards: PlacedBoard[] = [];
let meshes: THREE.InstancedMesh[] = [];
let group: THREE.Group | null = null;
const raycaster = new THREE.Raycaster();

async function load(ctx: ClientContext): Promise<void> {
  loading ??= (async () => {
    const res = await ctx.api.getJson<ArtifactsResponse>("/api/artifacts", 15_000);
    if (res?.ok && Array.isArray(res.items)) {
      items = res.items;
      rebuild(ctx);
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function clear(): void {
  const pick = sceneParts().pick;
  for (const m of meshes) {
    pick?.unregister(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  meshes = [];
  group?.removeFromParent();
  group = null;
  boards = [];
}

/** Hangs the boards. Needs the built world (layout, towers, picking); a no-op until then. */
function rebuild(ctx: ClientContext): void {
  const parts = sceneParts();
  if (!parts.layout || !parts.cities || !parts.pick) return;
  clear();
  const layout = new Map<string, CityLayout>(parts.layout.map((c) => [c.id, c]));
  const housed = new Set([...ctx.store.agents.values()].map((a) => a.islandId));
  const cities = parts.cities;
  boards = planBoards({
    items,
    hasTower: (id) => layout.has(id) && ctx.store.islands.has(id) && (id === MUSEUM_ISLAND_ID || housed.has(id)),
    towerHeight: (id) => cities.towerHeight(id),
  });
  if (boards.length === 0) return;
  const frame = new THREE.InstancedMesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, BOARD_D), toon(0xffffff), boards.length);
  const canvas = new THREE.InstancedMesh(new THREE.PlaneGeometry(BOARD_W - 0.09, BOARD_H - 0.09).translate(0, 0, BOARD_D / 2 + 0.004), toon(0xffffff), boards.length);
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  boards.forEach((b, i) => {
    const city = layout.get(b.cityId);
    if (!city) return;
    cityMatrix(city, b.slot.x, b.slot.z, b.slot.y, b.slot.yaw, one, m);
    frame.setMatrixAt(i, m);
    canvas.setMatrixAt(i, m);
    frame.setColorAt(i, new THREE.Color(frameColor(artifactMonth(artifactAt(b.item)))));
    canvas.setColorAt(i, new THREE.Color(CANVAS_COLORS[i % CANVAS_COLORS.length] ?? 0xffffff));
  });
  frame.name = "artifact-frames";
  canvas.name = "artifact-canvases";
  const redact = redactOn();
  const resolve = (id: number | undefined): { kind: "system"; id: string } | null => {
    const b = id === undefined ? undefined : boards[id];
    if (!b) return null;
    return { kind: "system", id: `${LABEL_MARK}${b.museum ? "Museum · " : ""}${artifactLabel(b.item, redact)}` };
  };
  group = new THREE.Group();
  group.name = "artifacts";
  group.add(frame, canvas);
  ctx.scene.add(group);
  meshes = [frame, canvas];
  for (const mesh of meshes) parts.pick.register(mesh, resolve);
}

function openGallery(cityId: string, selectedId?: string): void {
  gallery?.open(items, { cityId, selectedId });
}

/** The gallery modal from another view (the Projects view's artifact rows). A district id shows that
 *  district's artifacts, MUSEUM_ISLAND_ID all of them; a no-op until the artifacts feature has mounted. */
export function openArtifactsGallery(cityId: string, selectedId?: string): void {
  openGallery(cityId, selectedId);
}

/** Our own click: the hub's pick says a board was hit; a raycast on our meshes says which one. */
function mountClicks(ctx: ClientContext): void {
  const el = sceneParts().rig?.renderer.domElement;
  if (!el) return;
  const down = { x: 0, y: 0 };
  el.addEventListener("pointerdown", (ev) => {
    down.x = ev.clientX;
    down.y = ev.clientY;
  });
  el.addEventListener("click", (ev) => {
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6 || document.body.classList.contains("in-room") || !group) return;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const p = sceneParts().pick?.pick(ndc, ctx.camera, PLANET_R + 0.4);
    if (p?.kind !== "system" || !p.id.startsWith(LABEL_MARK)) return;
    raycaster.setFromCamera(ndc, ctx.camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    const b = hit?.instanceId === undefined ? undefined : boards[hit.instanceId];
    if (b) openGallery(b.museum ? MUSEUM_ISLAND_ID : b.cityId, b.item.id);
  });
}

export const artifactsFeature: ClientFeature = {
  id: "artifacts",
  mount(ctx) {
    gallery = mountGallery(ctx);
    let wired = false;
    onSceneParts((p) => {
      if (!wired && p.rig) {
        wired = true;
        mountClicks(ctx);
      }
      if (p.layout && p.cities && p.pick && !group && items.length) rebuild(ctx);
    });
  },
  onSnapshot(world, ctx) {
    const s = world.extras?.["artifacts.summary"];
    if (!isArtifactsSummary(s) || s.rev === rev) return;
    rev = s.rev;
    void load(ctx).catch((err: unknown) => log.warn("artifacts", "list failed", err));
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (typeof p === "object" && p !== null && (p as { type?: unknown }).type === "changed") void load(ctx);
  },
  onEscape() {
    if (!gallery?.isOpen()) return false;
    gallery.close();
    return true;
  },
  hudButtons: [
    {
      id: "museum",
      label: "🖼",
      text: "Museum",
      title: "Museum: every artifact we made, with previews",
      onClick: (ctx) => void load(ctx).finally(() => openGallery(MUSEUM_ISLAND_ID)),
    },
  ],
  paletteCommands: (ctx) => [
    { id: "museum", title: `Open the Museum (${items.length} artifacts)`, keywords: ["artifacts", "gallery", "claude.ai", "preview"], run: () => void load(ctx).finally(() => openGallery(MUSEUM_ISLAND_ID)) },
  ],
};
