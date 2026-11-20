// Helpers shared by the fleet-control features (todos, agent-state, conflicts, approvals,
// talk). Not a feature itself: HTML overlays pinned to world points, a hook into the
// agent side panel, and "which agent's room are we in".

import * as THREE from "three";
import { PLANET_R } from "../layout";
import type { ClientContext } from "./registry";
import { agentTitle } from "../../../shared/display";

let layer: HTMLElement | null = null;

/** A fixed, pointer-events:none layer above the canvas, below the HUD. */
export function overlayLayer(): HTMLElement {
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = "fx-layer";
  document.body.appendChild(layer);
  return layer;
}

const tmp = new THREE.Vector3();
const toCam = new THREE.Vector3();

export interface ScreenPoint {
  x: number;
  y: number;
  /** In front of the camera, inside the viewport, and on the planet's camera-facing side. */
  visible: boolean;
  /** Camera distance, for sorting. */
  dist: number;
}

/** True when the segment camera→point passes through the planet's core sphere (terrain ignored). */
export function occludedByPlanet(cam: THREE.Vector3, point: THREE.Vector3, radius = PLANET_R * 0.97): boolean {
  const d = toCam.copy(point).sub(cam);
  const a = d.dot(d);
  const b = 2 * cam.dot(d);
  const c = cam.dot(cam) - radius * radius;
  const disc = b * b - 4 * a * c;
  if (a === 0 || disc < 0) return false;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  return (t1 > 0 && t1 < 1) || (t2 > 0 && t2 < 1);
}

export function toScreen(ctx: ClientContext, world: THREE.Vector3): ScreenPoint {
  const cam = ctx.camera;
  const facing = !occludedByPlanet(cam.position, world);
  toCam.copy(cam.position).sub(world);
  tmp.copy(world).project(cam);
  const inView = tmp.z < 1 && Math.abs(tmp.x) <= 1.05 && Math.abs(tmp.y) <= 1.05;
  return {
    x: (tmp.x * 0.5 + 0.5) * window.innerWidth,
    y: (-tmp.y * 0.5 + 0.5) * window.innerHeight,
    visible: facing && inView,
    dist: toCam.length(),
  };
}

export function place(el: HTMLElement, p: ScreenPoint): void {
  el.hidden = !p.visible;
  if (p.visible) el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
}

/** Calls `render(agentId, slot)` whenever the side panel shows an agent. Each feature gets its own slot. */
export function watchAgentPanel(slotClass: string, render: (agentId: string, slot: HTMLElement) => void): void {
  const content = document.getElementById("panel-content");
  if (!content) return;
  const fill = (): void => {
    const agentId = content.dataset.agentId;
    if (!agentId || content.querySelector(`.${slotClass}`)) return;
    const slot = document.createElement("section");
    slot.className = `fx-slot ${slotClass}`;
    const actions = content.querySelector(".panel-actions");
    if (actions) content.insertBefore(slot, actions);
    else content.appendChild(slot);
    render(agentId, slot);
  };
  new MutationObserver(fill).observe(content, { childList: true });
  fill();
}

/** Re-renders an existing panel slot (e.g. when its data changes while open). */
export function refreshAgentPanel(slotClass: string, render: (agentId: string, slot: HTMLElement) => void): void {
  const content = document.getElementById("panel-content");
  const slot = content?.querySelector<HTMLElement>(`.${slotClass}`);
  const agentId = content?.dataset.agentId;
  if (slot && agentId) render(agentId, slot);
}

/** The agent whose room is open, if any. The room HUD shows no id, so match its title and
 *  meta line (main.ts writes "<island> · <status> · last active <locale time>") against the store. */
export function roomAgentId(ctx: ClientContext): string | null {
  if (!document.body.classList.contains("in-room")) return null;
  const title = document.getElementById("room-title")?.textContent ?? "";
  const meta = document.getElementById("room-meta")?.textContent ?? "";
  const byTitle = [...ctx.store.agents.values()].filter((a) => agentTitle(a) === title || a.title === title);
  const exact = byTitle.find((a) => meta === `${a.islandId} · ${a.status} · last active ${new Date(a.lastActive).toLocaleString()}`);
  if (exact) return exact.id;
  byTitle.sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  return byTitle[0]?.id ?? null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** h("div", "cls", "text") — tiny DOM builder; text is always set with textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
