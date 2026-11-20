// A4 — agent state as a colored ring on the ground around each awake agent's house
// (working / permission / waiting / idle; sleeping agents get no ring), a state chip on
// every board card, and a state line in the agent panel.

import * as THREE from "three";
import { AGENT_STATES_PATH, isAgentState, type AgentState } from "../../../shared/features/agent-state";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import { lateExtra, type LateExtra } from "./late-extra";
import type { ClientContext, ClientFeature } from "./registry";

const SLOT = "fx-state";

export const STATE_COLORS: Record<AgentState, number> = {
  working: 0x2ecc71,
  permission: 0xff3b3b,
  waiting: 0xffb21e,
  idle: 0x4aa3ff,
  sleeping: 0x8c84a8,
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  permission: "needs permission",
  waiting: "waiting for you",
  idle: "idle",
  sleeping: "asleep",
};

const states = new Map<string, AgentState>();
const rings = new Map<string, THREE.Mesh>();
let group: THREE.Group | null = null;
/** Every agent's state: GET /api/agent-state on every snapshot (no longer in its extras), then pushes. */
let statesLoad: LateExtra | null = null;
const ringGeo = new THREE.RingGeometry(1.25, 1.6, 40);
const materials = new Map<AgentState, THREE.MeshBasicMaterial>();
const up = new THREE.Vector3(0, 0, 1);

function material(s: AgentState): THREE.MeshBasicMaterial {
  let m = materials.get(s);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: STATE_COLORS[s], transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    materials.set(s, m);
  }
  return m;
}

/** Builds (or moves/recolors) the ring for one agent; sleeping agents lose theirs. */
function syncRing(ctx: ClientContext, id: string): void {
  const s = states.get(id);
  const existing = rings.get(id);
  if (!s || s === "sleeping") {
    if (existing) {
      group?.remove(existing);
      rings.delete(id);
    }
    return;
  }
  const top = ctx.agentPosition(id);
  if (!top || !group) return;
  const mesh = existing ?? new THREE.Mesh(ringGeo, material(s));
  mesh.material = material(s);
  mesh.position.copy(ctx.surfacePoint(top, 0.12));
  mesh.quaternion.setFromUnitVectors(up, top.clone().normalize());
  mesh.renderOrder = 2;
  if (!existing) {
    group.add(mesh);
    rings.set(id, mesh);
  }
}

function chip(s: AgentState): HTMLElement {
  const el = h("span", `as-chip as-${s}`, STATE_LABELS[s]);
  el.title = `State: ${STATE_LABELS[s]}`;
  return el;
}

function decorateBoard(): void {
  const cols = document.getElementById("board-cols");
  if (!cols) return;
  for (const b of cols.querySelectorAll<HTMLElement>("button[data-agent]")) {
    const s = states.get(b.dataset.agent ?? "");
    const cur = b.querySelector<HTMLElement>(".as-chip");
    if (!s || s === "sleeping") {
      cur?.remove();
      continue;
    }
    if (cur?.classList.contains(`as-${s}`)) continue;
    cur?.remove();
    b.appendChild(chip(s));
  }
}

function renderPanel(agentId: string, slot: HTMLElement): void {
  const s = states.get(agentId);
  slot.replaceChildren();
  if (!s) return;
  slot.append(h("span", "as-label", "State"), chip(s));
}

function apply(ctx: ClientContext, next: Record<string, unknown>): void {
  for (const [id, s] of Object.entries(next)) {
    if (!isAgentState(s)) continue;
    states.set(id, s);
    syncRing(ctx, id);
  }
  decorateBoard();
  refreshAgentPanel(SLOT, renderPanel);
  for (const fn of stateListeners) fn();
}

export const agentStateFeature: ClientFeature = {
  id: "agent-state",
  mount(ctx) {
    group = new THREE.Group();
    group.name = "agent-state-rings";
    ctx.scene.add(group);
    watchAgentPanel(SLOT, renderPanel);
    const cols = document.getElementById("board-cols");
    if (cols) new MutationObserver(decorateBoard).observe(cols, { childList: true });
    statesLoad = lateExtra(
      () => ctx.api.getJson<unknown>(AGENT_STATES_PATH),
      (body) => {
        if (isRecord(body) && isRecord(body.states)) apply(ctx, body.states);
      },
    );
  },
  onSnapshot() {
    statesLoad?.refresh();
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "states" || !isRecord(p.states)) return;
    const changed = p.states;
    if (statesLoad) statesLoad.push("merge", () => apply(ctx, changed));
    else apply(ctx, changed);
  },
  onFrame(_dt, ctx) {
    const t = ctx.elapsed();
    for (const [id, mesh] of rings) {
      const s = states.get(id);
      const pulse = s === "permission" ? 1 + 0.18 * Math.sin(t * 8) : s === "working" ? 1 + 0.06 * Math.sin(t * 3) : 1;
      mesh.scale.setScalar(pulse);
    }
  },
};

// ---- round 5 E: focus mode reads states live ----
const stateListeners = new Set<() => void>();

export function agentStateOf(agentId: string): AgentState | undefined {
  return states.get(agentId);
}

/** Called after every state update from the server. */
export function onAgentStates(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
