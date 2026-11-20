// Round 11 B: topic continents on the planet. main.ts lays the cities out by continent at load
// (client/src/topic-layout.ts); this feature draws what makes a continent readable: a thick
// coloured border hugging the ground around each region, and a big comic sign ("ACME · Website
// · 42 sessions") that floats over it. Clicking a sign flies to the continent's busiest city.
// New sessions are classified by the server as they appear; the planet's geometry is built once,
// so a changed map only updates the count shown in the sidebar note ("reload to re-draw").

import * as THREE from "three";
import { isTopicsMap, type TopicsMap } from "../../../shared/features/topics";
import { CITY_SURFACE, PLANET_R } from "../layout";
import { redactOn } from "../redact";
import { archivedInGroup, onArchiveChange } from "./archive-state";
import { toon } from "../scene/toon";
import type { ClientContext, ClientFeature } from "./registry";
import { setUnplacedSessions, topicsState } from "./topics-state";
import "./topics.css";

interface Sign {
  el: HTMLButtonElement;
  anchor: THREE.Vector3;
  /** Rendered size in px, measured once when first shown (0 = not yet). */
  w: number;
  h: number;
}

const signs: Sign[] = [];
let toasted = false;
const projected = new THREE.Vector3();
const toCam = new THREE.Vector3();
const normal = new THREE.Vector3();

/** A closed ring at angular radius `angle` around `dir`, lifted just above the land. */
export function borderCurve(dir: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3, angle: number, ground: (d: THREE.Vector3) => number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  const segs = Math.max(48, Math.round(angle * 160));
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const d = dir
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(t1, Math.sin(angle) * Math.cos(a))
      .addScaledVector(t2, Math.sin(angle) * Math.sin(a))
      .normalize();
    pts.push(d.multiplyScalar(PLANET_R + Math.max(ground(d), 0.45) + 0.35));
  }
  return new THREE.CatmullRomCurve3(pts, true);
}

/** Busiest real city in a continent (by agents), for the sign's fly-to. */
function busiestCity(ctx: ClientContext, cities: readonly string[]): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const id of cities) {
    const n = ctx.store.islands.get(id)?.agentCount ?? 0;
    if (id !== "harness" && n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best ?? cities[0] ?? null;
}

function countNew(latest: TopicsMap, shown: TopicsMap): number {
  let n = 0;
  for (const [id, s] of Object.entries(latest.sessions)) if (shown.sessions[id]?.group !== s.group) n++;
  return n;
}

export const topicsFeature: ClientFeature = {
  id: "topics",
  mount(ctx) {
    const st = topicsState();
    if (!st) return;
    const group = new THREE.Group();
    group.name = "topic-continents";
    const root = document.getElementById("labels");
    for (const c of st.layout.continents) {
      const curve = borderCurve(c.dir, c.t1, c.t2, c.angle, st.groundHeight);
      const segs = curve.points.length * 3;
      const band = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.32, 6, true), toon(c.color));
      const ink = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.44, 6, true), new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide }));
      band.name = `continent-border-${c.key}`;
      group.add(ink, band);
      if (!root) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "continent-sign";
      el.style.setProperty("--continent", c.color);
      const name = document.createElement("span");
      name.className = "continent-sign-name";
      name.textContent = c.name;
      const meta = document.createElement("span");
      meta.className = "continent-sign-meta";
      const cityWord = c.cities.length === 1 ? "city" : "cities";
      // Archived (vault-only) sessions count too; they arrive after mount, so repaint on change.
      const paintMeta = (): void => {
        meta.textContent = `${c.sessions + archivedInGroup(c.key)} sessions${c.cities.length ? ` · ${c.cities.length} ${cityWord}` : ""}`;
      };
      paintMeta();
      onArchiveChange(paintMeta);
      el.append(name, meta);
      const names = c.cities.map((id) => (redactOn() ? "…" : (ctx.store.islands.get(id)?.name ?? id))).slice(0, 8);
      el.title = `${c.name}: ${c.sessions} sessions in ${c.cities.length} ${cityWord}${names.length ? ` (${names.join(", ")}${c.cities.length > 8 ? ", …" : ""})` : ""}. Click to fly there.`;
      el.hidden = true;
      el.addEventListener("click", () => {
        const target = busiestCity(ctx, c.cities);
        if (target) ctx.flyTo(target);
      });
      root.prepend(el); // before the city callouts, so those stay on top
      // Like a map title, the sign floats over the continent's northern edge (its centre is
      // usually the biggest city, whose own callout would cover it), a little above the rooftops.
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(c.dir, -c.dir.y);
      if (north.lengthSq() < 1e-6) north.copy(c.t2);
      north.normalize();
      const edge = c.dir.clone().multiplyScalar(Math.cos(c.angle * 0.8)).addScaledVector(north, Math.sin(c.angle * 0.8)).normalize();
      signs.push({ el, anchor: edge.multiplyScalar(CITY_SURFACE + 4), w: 0, h: 0 });
    }
    ctx.scene.add(group);
  },
  onSnapshot(world) {
    const st = topicsState();
    const latest = world.extras?.["topics.map"];
    if (st && isTopicsMap(latest)) setUnplacedSessions(countNew(latest, st.map));
  },
  onMessage(msg, ctx) {
    const st = topicsState();
    const p = msg.payload as { kind?: unknown; map?: unknown } | null;
    if (!st || !p || p.kind !== "map" || !isTopicsMap(p.map)) return;
    const n = countNew(p.map, st.map);
    setUnplacedSessions(n);
    if (n > 0 && !toasted) {
      toasted = true; // once per load; the sidebar note keeps the running count
      ctx.toast(`${n} session${n === 1 ? "" : "s"} newly sorted into topic continents. Reload to re-draw the planet.`);
    }
  },
  onFrame(_dt, ctx) {
    if (signs.length === 0) return;
    // Same coordinate space as the city callouts: the planet canvas container.
    const app = document.getElementById("app");
    const w = app?.clientWidth ?? window.innerWidth;
    const h = app?.clientHeight ?? window.innerHeight;
    const shown: { x: number; y: number; w: number; h: number }[] = [];
    // Biggest continents first (mount order is most sessions first); a sign that would sit on top
    // of an already placed one waits until the camera turns.
    for (const s of signs) {
      normal.copy(s.anchor).normalize();
      toCam.subVectors(ctx.camera.position, s.anchor).normalize();
      const facing = normal.dot(toCam);
      projected.copy(s.anchor).project(ctx.camera);
      const visible = facing > 0.15 && projected.z < 1 && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.95;
      const x = (projected.x * 0.5 + 0.5) * w;
      const y = (-projected.y * 0.5 + 0.5) * h;
      const cy = y - s.h / 2; // the sign hangs above its anchor: compare centres
      const clash = visible && shown.some((o) => Math.abs(o.x - x) < (o.w + s.w) / 2 && Math.abs(o.y - cy) < (o.h + s.h) / 2);
      s.el.hidden = !visible || clash;
      if (s.el.hidden) continue;
      if (s.w === 0) {
        s.w = s.el.offsetWidth; // measured once, the first time it shows
        s.h = s.el.offsetHeight;
      }
      shown.push({ x, y: y - s.h / 2, w: s.w, h: s.h }); // s.h may have just been measured
      // Fades in as the continent turns toward the camera; tilted-away ones stay quiet.
      s.el.style.opacity = String(Math.min(1, (facing - 0.15) * 3));
      s.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  },
};
