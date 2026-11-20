// A5 — conflict beams: a red dashed arc between the houses of two agents that wrote
// the same file in the last 30 minutes (one of them live). A "⚠ same file" chip sits on
// the arc; hovering it lists the file(s).

import * as THREE from "three";
import type { ConflictPair } from "../../../shared/features/conflicts";
import { h, isRecord, overlayLayer, place, toScreen } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { agentTitle } from "../../../shared/display";

interface Beam {
  pair: ConflictPair;
  line: THREE.Group;
  mid: THREE.Vector3;
  chip: HTMLElement;
}

const DASHES = 14;

let group: THREE.Group | null = null;
let beams: Beam[] = [];
let pending: ConflictPair[] = [];
// WebGL lines are 1px, so each dash is a short tube: thick enough to read from orbit.
const material = new THREE.MeshBasicMaterial({ color: 0xff2d2d, transparent: true, opacity: 0.95 });

/** A dashed tube along `curve`: DASHES tubes covering 60% of each step. */
function dashedTube(curve: THREE.Curve<THREE.Vector3>, radius: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < DASHES; i++) {
    const t0 = i / DASHES;
    const t1 = t0 + 0.6 / DASHES;
    const pts = [0, 0.5, 1].map((k) => curve.getPoint(t0 + (t1 - t0) * k));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 4, radius, 6), material));
  }
  return g;
}

export function parsePairs(v: unknown): ConflictPair[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (p): p is ConflictPair =>
      isRecord(p) && typeof p.a === "string" && typeof p.b === "string" && typeof p.at === "string" && Array.isArray(p.files) && p.files.every((f) => typeof f === "string"),
  );
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function chipFor(pair: ConflictPair, ctx: ClientContext): HTMLElement {
  const chip = h("div", "cf-chip");
  const btn = h("button", "cf-btn", "⚠ same file");
  btn.type = "button";
  const names = (id: string): string => {
    const a = ctx.store.agents.get(id);
    return a ? agentTitle(a) : id.slice(0, 8);
  };
  btn.setAttribute("aria-label", `Conflict: ${names(pair.a)} and ${names(pair.b)} both edited ${pair.files.length} file(s)`);
  const pop = h("div", "cf-pop");
  pop.append(h("b", undefined, `${pair.files.length} file${pair.files.length === 1 ? "" : "s"} edited by both:`));
  const ul = h("ul");
  for (const f of pair.files) {
    const li = h("li", undefined, shortPath(f));
    li.title = f;
    ul.appendChild(li);
  }
  // Both names are their own button (round 9: the old "both sides" listing was plain text and
  // every click — chip or listing — flew to `a`, never whichever side you actually wanted).
  const flyBtn = (id: string): HTMLElement => {
    const nb = h("button", "cf-who-btn", names(id));
    nb.type = "button";
    nb.title = `Fly to ${names(id)}`;
    nb.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ctx.flyTo(id);
    });
    return nb;
  };
  const who = h("div", "cf-who");
  who.append(flyBtn(pair.a), h("span", "cf-who-sep", "⇄"), flyBtn(pair.b));
  pop.append(ul, who);
  btn.addEventListener("click", () => ctx.flyTo(pair.a));
  chip.append(btn, pop);
  overlayLayer().appendChild(chip);
  return chip;
}

function clear(): void {
  for (const b of beams) {
    group?.remove(b.line);
    b.line.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    b.chip.remove();
  }
  beams = [];
}

/** Builds beams for pairs whose houses are placed; returns false if some are still missing. */
function build(ctx: ClientContext): boolean {
  clear();
  let complete = true;
  for (const pair of pending) {
    const a = ctx.agentPosition(pair.a);
    const b = ctx.agentPosition(pair.b);
    if (!a || !b || !group) {
      complete = false;
      continue;
    }
    const radius = Math.max(a.length(), b.length());
    const lift = Math.max(3, a.distanceTo(b) * 0.35);
    const control = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(radius + lift);
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), control, b.clone());
    const line = dashedTube(curve, 0.22);
    group.add(line);
    beams.push({ pair, line, mid: curve.getPoint(0.5), chip: chipFor(pair, ctx) });
  }
  return complete;
}

let needsBuild = false;
let lastTry = -Infinity;

let pendingKey = "";

function setPairs(pairs: ConflictPair[]): void {
  const key = JSON.stringify(pairs.map((p) => [p.a, p.b, p.files]));
  if (key === pendingKey) return; // snapshots repeat the same set; don't rebuild beams + chips
  pendingKey = key;
  pending = pairs;
  needsBuild = true;
  lastTry = -Infinity;
}

export const conflictsFeature: ClientFeature = {
  id: "conflicts",
  mount(ctx) {
    group = new THREE.Group();
    group.name = "conflict-beams";
    ctx.scene.add(group);
  },
  onSnapshot(world) {
    setPairs(parsePairs(world.extras?.["conflicts.pairs"]));
  },
  onMessage(msg) {
    const p = msg.payload;
    if (isRecord(p) && p.kind === "pairs") setPairs(parsePairs(p.pairs));
  },
  onFrame(_dt, ctx) {
    const t = ctx.elapsed();
    // A house that is not placed yet (or never will be) is retried every 2s, not every frame.
    if (needsBuild && t - lastTry > 2) {
      lastTry = t;
      needsBuild = !build(ctx);
    }
    material.opacity = 0.65 + 0.3 * Math.sin(t * 4);
    for (const b of beams) place(b.chip, toScreen(ctx, b.mid));
  },
};
