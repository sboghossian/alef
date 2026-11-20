// Automated Runs' sub-districts on the planet (see auto-districts-lib.ts): a thin ring around each
// automation's lot and a small callout over it ("/daily-recap · 41"). The archive feature computes
// the lots once the archive list is in and moves the houses and fossils into them; this feature
// only draws what that produced, and redraws when it changes (no relayout, nothing else moves).
// Before the archive list arrives there is nothing to draw: fail open.
// A lot whose automation is a trusted worker (the Tower, careers.ts) gets a 🎓 in front of its
// name; that text is repainted in place when the workers' states change (campus-data.ts).

import * as THREE from "three";
import { CITY_SURFACE, PLANET_R } from "../layout";
import { redactOn } from "../redact";
import { toon } from "../scene/toon";
import { openAutoLot } from "./archive";
import { autoDistricts, onArchiveChange } from "./archive-state";
import { onCampusChange, trustedWorkerKeys } from "./campus-data";
import { lotLabel, type AutoDistricts } from "./auto-districts-lib";
import type { ClientContext, ClientFeature } from "./registry";
import { lotCalloutName } from "./system-places-lib";
import { borderCurve } from "./topics";
import { topicsState } from "./topics-state";

/** Beyond this camera distance the lot labels would crowd the continent signs: hide them. */
const FAR = PLANET_R * 2.2;

interface LotSign {
  el: HTMLButtonElement;
  key: string;
  name: HTMLElement;
  /** The title without the trusted note. */
  title: string;
  anchor: THREE.Vector3;
  w: number;
  h: number;
}

let drawnFor: AutoDistricts | null = null;
let group: THREE.Group | null = null;
let signs: LotSign[] = [];
const projected = new THREE.Vector3();
const toCam = new THREE.Vector3();
const normal = new THREE.Vector3();

function clear(): void {
  for (const s of signs) s.el.remove();
  signs = [];
  if (!group) return;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  group.removeFromParent();
  group = null;
}

function draw(ctx: ClientContext): void {
  const d = autoDistricts();
  if (d === drawnFor) return;
  drawnFor = d;
  clear();
  const st = topicsState();
  const root = document.getElementById("labels");
  if (!d || !st) return;
  const color = st.map.groups.find((g) => g.key === "AUTO")?.color ?? "#8aa0b8";
  group = new THREE.Group();
  group.name = "auto-subdistricts";
  for (const lot of d.lots) {
    const f = lot.frame;
    const curve = borderCurve(f.dir, f.t1, f.t2, (lot.r + 0.25) / CITY_SURFACE, st.groundHeight);
    const ring = new THREE.Mesh(new THREE.TubeGeometry(curve, curve.points.length * 2, 0.1, 5, true), toon(color));
    ring.name = `auto-lot-${lot.key}`;
    group.add(ring);
    if (!root) continue;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "callout auto-lot";
    const name = document.createElement("span");
    name.className = "callout-name";
    const count = document.createElement("span");
    count.className = "callout-count";
    count.textContent = String(lot.live.length + lot.archived.length);
    el.append(name, count);
    const title = `${redactOn() ? "Automation" : lotLabel(lot)}: ${lot.live.length} live · ${lot.archived.length} archived home-folder runs. Click to list them.`;
    el.hidden = true;
    el.addEventListener("click", () => openAutoLot(lot.key));
    root.prepend(el); // under the city callouts
    signs.push({ el, key: lot.key, name, title, anchor: ctx.surfacePoint(f.dir, 2.2), w: 0, h: 0 });
  }
  paintNames();
  ctx.scene.add(group);
}

/** Each callout's name (🎓 for a trusted worker) and title; only text changes, nothing is rebuilt. */
function paintNames(): void {
  const trusted = trustedWorkerKeys();
  for (const s of signs) {
    const text = lotCalloutName(s.key, trusted, redactOn());
    if (s.name.textContent === text) continue;
    s.name.textContent = text;
    s.el.title = trusted.has(s.key) ? `🎓 A trusted worker in the Tower (its last five runs were clean). ${s.title}` : s.title;
    s.w = 0; // re-measure: the width changed
  }
}

export const autoDistrictsFeature: ClientFeature = {
  id: "auto-districts",
  mount(ctx) {
    onArchiveChange(() => draw(ctx));
    onCampusChange(paintNames);
    draw(ctx);
  },
  onFrame(_dt, ctx) {
    if (signs.length === 0) return;
    const app = document.getElementById("app");
    const w = app?.clientWidth ?? window.innerWidth;
    const h = app?.clientHeight ?? window.innerHeight;
    const near = ctx.camera.position.length() < FAR;
    const shown: { x: number; y: number; w: number; h: number }[] = [];
    for (const s of signs) {
      normal.copy(s.anchor).normalize();
      toCam.subVectors(ctx.camera.position, s.anchor).normalize();
      const facing = normal.dot(toCam);
      projected.copy(s.anchor).project(ctx.camera);
      const visible = near && facing > 0.25 && projected.z < 1 && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.95;
      const x = (projected.x * 0.5 + 0.5) * w;
      const y = (-projected.y * 0.5 + 0.5) * h;
      const cy = y - s.h / 2;
      const clash = visible && shown.some((o) => Math.abs(o.x - x) < (o.w + s.w) / 2 && Math.abs(o.y - cy) < (o.h + s.h) / 2);
      s.el.hidden = !visible || clash;
      if (s.el.hidden) continue;
      if (s.w === 0) {
        s.w = s.el.offsetWidth;
        s.h = s.el.offsetHeight;
      }
      shown.push({ x, y: y - s.h / 2, w: s.w, h: s.h });
      s.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  },
};
