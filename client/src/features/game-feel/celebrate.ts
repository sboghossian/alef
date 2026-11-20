// P4a item 3 — "Celebrate": a todo list finishing, a git commit landing, and a subagent
// finishing all get the same payoff — a comic burst word (ctx.labels.burst, already exists), a
// confetti pop (one pooled InstancedMesh — one of the round-10 perf budget's four extra draw
// calls) and the existing focus-mode chime. Retiring an agent gets a quieter dust puff instead,
// reusing scene/agents.ts's existing plane-contrail puff pool (zero extra draw calls).
//
// Not a ClientFeature itself — built once and driven every frame by game-feel.ts.

import * as THREE from "three";
import type { AgentActivity } from "../../../../shared/types";
import { sceneParts } from "../../scene/scene-bus";
import { prefersReducedMotion } from "../../ui/kit";
import type { ClientContext } from "../registry";
import { playFocusChime } from "../sound";
import { subagentData } from "../subagent-data";
import { onTodosChange, todoListFor } from "../todos";
import { canBurstConfetti, isGitCommitActivity, todoCompletedEdge, tryCelebrate } from "./game-feel-lib";
import { qualityController } from "./quality";

const CONFETTI_CAPACITY = 64;
const CONFETTI_PER_BURST = 22;
const CONFETTI_LIFE_S = 1.2;
const MAX_ON_SCREEN = 3;
const CELEBRATE_COOLDOWN_MS = 20_000;
const GRAVITY = -4.5;
const PALETTE = [0xff5da2, 0xffd23f, 0x59d4ff, 0x7ee08a, 0xffa64d];

interface Slot {
  bornAt: number; // elapsed seconds, -Infinity while unused
  vel: THREE.Vector3;
  pos: THREE.Vector3;
  colorIdx: number;
}

export interface Celebrate {
  /** Feed real activity rows every tick (game-feel.ts already subscribes for its own use). */
  onActivity(activities: readonly AgentActivity[]): void;
  /** Call every game-feel frame. */
  update(elapsed: number): void;
}

export function buildCelebrate(ctx: ClientContext): Celebrate {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.18, 0.05), new THREE.MeshBasicMaterial({ vertexColors: true }), CONFETTI_CAPACITY);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = "confetti";
  ctx.scene.add(mesh);

  const slots: Slot[] = Array.from({ length: CONFETTI_CAPACITY }, () => ({ bornAt: -Infinity, vel: new THREE.Vector3(), pos: new THREE.Vector3(), colorIdx: 0 }));
  let cursor = 0;
  const activeBurstExpiries: number[] = []; // ms
  const lastByAgent = new Map<string, number>();
  const allDoneByAgent = new Map<string, boolean>();
  const doneSubagents = new Set<string>();

  // Reused scratch (no per-frame allocation — round-10 perf budget).
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scratchPos = new THREE.Vector3();
  const scratchScale = new THREE.Vector3();
  const color = new THREE.Color();

  function spawnConfetti(anchor: THREE.Vector3, elapsedS: number): void {
    // Perf budget's tier table: tier 2 = no confetti at all; tier 1 = halved particle caps.
    const tier = qualityController.tier();
    if (prefersReducedMotion() || tier >= 2) return;
    const perBurst = tier === 1 ? Math.round(CONFETTI_PER_BURST / 2) : CONFETTI_PER_BURST;
    const maxOnScreen = tier === 1 ? Math.max(1, Math.round(MAX_ON_SCREEN / 2)) : MAX_ON_SCREEN;
    if (!canBurstConfetti(activeBurstExpiries, elapsedS * 1000, maxOnScreen)) return;
    activeBurstExpiries.push(elapsedS * 1000 + CONFETTI_LIFE_S * 1000);
    for (let i = 0; i < perBurst; i++) {
      const slot = slots[cursor];
      cursor = (cursor + 1) % CONFETTI_CAPACITY;
      if (!slot) continue;
      slot.bornAt = elapsedS;
      slot.pos.copy(anchor);
      slot.colorIdx = Math.floor(Math.random() * PALETTE.length);
      const az = Math.random() * Math.PI * 2;
      const speed = 1.4 + Math.random() * 1.6;
      slot.vel.set(Math.cos(az) * speed, 2.2 + Math.random() * 1.2, Math.sin(az) * speed);
    }
  }

  function celebrate(agentId: string, word: string, anchor: THREE.Vector3 | undefined, elapsedS: number): void {
    if (!anchor || !tryCelebrate(lastByAgent, agentId, elapsedS * 1000, CELEBRATE_COOLDOWN_MS)) return;
    ctx.labels.burst(word, anchor);
    spawnConfetti(anchor, elapsedS);
    playFocusChime();
  }

  function checkTodos(elapsedS: number): void {
    for (const a of ctx.store.agents.values()) {
      if (a.status !== "live") continue;
      const list = todoListFor(ctx, a.id);
      if (!list || list.items.length === 0) continue;
      const done = list.items.filter((i) => i.status === "completed").length;
      const total = list.items.length;
      const edge = todoCompletedEdge(allDoneByAgent.get(a.id), done, total);
      allDoneByAgent.set(a.id, done === total && total > 0);
      if (edge) celebrate(a.id, "DONE!", ctx.agentPosition(a.id), elapsedS);
    }
  }

  onTodosChange(() => checkTodos(ctx.elapsed()));

  subagentData.onChange((list) => {
    const elapsedS = ctx.elapsed();
    for (const r of list) {
      if (r.status === "done" && !doneSubagents.has(r.id)) {
        doneSubagents.add(r.id);
        celebrate(r.parentSessionId, "✓", ctx.agentPosition(r.parentSessionId), elapsedS);
      } else if (r.status !== "done") {
        doneSubagents.delete(r.id);
      }
    }
  });

  // Retire pack-up (P0's store.onAgentsRemoved -> agentsVisual.hide is already wired in
  // main.ts): a dust puff at the house position captured just before it hides. houseTop
  // persists after hide() (only the scale changes), so this is never racy.
  ctx.store.onAgentsRemoved((ids) => {
    for (const id of ids) {
      const pos = ctx.agentPosition(id);
      if (pos) sceneParts().agents?.puffAt(pos);
    }
  });

  return {
    onActivity(activities) {
      const elapsedS = ctx.elapsed();
      for (const a of activities) {
        if (isGitCommitActivity(a)) celebrate(a.agentId, "SHIPPED!", ctx.agentPosition(a.agentId), elapsedS);
      }
    },
    update(elapsed) {
      if (qualityController.tier() >= 2) {
        if (mesh.count !== 0) mesh.count = 0;
        return;
      }
      let n = 0;
      for (const slot of slots) {
        const age = elapsed - slot.bornAt;
        if (age < 0 || age > CONFETTI_LIFE_S || n >= CONFETTI_CAPACITY) continue;
        const t = age / CONFETTI_LIFE_S;
        scratchPos.set(slot.pos.x + slot.vel.x * age, slot.pos.y + slot.vel.y * age + 0.5 * GRAVITY * age * age, slot.pos.z + slot.vel.z * age);
        euler.set(age * 6, age * 4, 0);
        q.setFromEuler(euler);
        scratchScale.setScalar(1 - t * 0.4);
        m.compose(scratchPos, q, scratchScale);
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, color.setHex(PALETTE[slot.colorIdx] ?? 0xffffff));
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}
