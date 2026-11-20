import * as THREE from "three";
import { displayIslandName } from "../../../shared/display";
import type { Island, WorldAgent } from "../../../shared/types";
import { escapeHtml, formatTokens, relativeTime } from "./fuzzy";

// ---------------------------------------------------------------- per-city stats (pure, tested)

export interface CityStats {
  agents: number;
  live: number;
  awaiting: number;
  activeToday: number;
  tokens: number;
  lastActive: number;
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function cityStats(agents: WorldAgent[], now = Date.now()): Map<string, CityStats> {
  const midnight = startOfLocalDay(now);
  const out = new Map<string, CityStats>();
  for (const a of agents) {
    const s = out.get(a.islandId) ?? { agents: 0, live: 0, awaiting: 0, activeToday: 0, tokens: 0, lastActive: 0 };
    const t = Date.parse(a.lastActive);
    s.agents++;
    if (a.status === "live") s.live++;
    if (a.awaitingInput === true) s.awaiting++;
    if (Number.isFinite(t) && t >= midnight) s.activeToday++;
    if (typeof a.tokens === "number" && Number.isFinite(a.tokens)) s.tokens += a.tokens;
    if (Number.isFinite(t)) s.lastActive = Math.max(s.lastActive, t);
    out.set(a.islandId, s);
  }
  return out;
}

/** Busiest first: awaiting you, then live, then active today, then recency. */
export function activityScore(s: CityStats | undefined): number {
  if (!s) return 0;
  return s.awaiting * 1e15 + s.live * 1e14 + s.activeToday * 1e13 + s.lastActive;
}

export type BoardColumn = "working" | "waiting" | "today" | "sleeping";

export function boardColumn(a: WorldAgent, now = Date.now()): BoardColumn {
  if (a.awaitingInput === true) return "waiting";
  if (a.status === "live") return "working";
  const t = Date.parse(a.lastActive);
  if (Number.isFinite(t) && t >= startOfLocalDay(now)) return "today";
  return "sleeping";
}

export const cityDisplayName = (i: Island): string => (i.id === "harness" ? "Harness City" : displayIslandName(i));

// ---------------------------------------------------------------- now exploring

export interface Exploring {
  show(island: Island, stats: CityStats | undefined, topFiles: string[], extra?: [string, number][]): void;
  hide(): void;
}

export function mountExploring(): Exploring {
  const el = document.getElementById("exploring");
  if (!el) throw new Error("#exploring missing from index.html");
  let timer = 0;
  const hide = (): void => {
    el.hidden = true;
  };
  return {
    show(island, s, files, extra = []) {
      window.clearTimeout(timer);
      const isHarness = island.id === "harness";
      el.innerHTML = `
        <button type="button" class="x" aria-label="Close">×</button>
        <div class="ex-kicker">Now exploring</div>
        <div class="ex-name">${escapeHtml(cityDisplayName(island))}</div>
        ${isHarness ? `<div class="ex-path">skills, hooks, MCPs, the Brain and the village square</div>` : `<div class="ex-path">${escapeHtml(island.path)}</div>`}
        <div class="ex-stats">
          ${extra.map(([k, v]) => `<span><b>${v}</b> ${escapeHtml(k)}</span>`).join("")}
          ${isHarness ? "" : `<span><b>${island.agentCount}</b> agents</span>`}
          ${isHarness ? "" : `<span><b>${s?.live ?? 0}</b> live</span>
          <span><b>${s?.awaiting ?? 0}</b> waiting on you</span>
          <span><b>${s?.activeToday ?? 0}</b> today</span>`}
          ${s && s.tokens > 0 ? `<span><b>${formatTokens(s.tokens)}</b> tokens</span>` : ""}
        </div>
        ${isHarness ? "" : `<div class="ex-last">last active ${relativeTime(island.lastActive)}</div>`}
        ${files.length ? `<div class="ex-files">${files.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</div>` : ""}
      `;
      el.querySelector(".x")?.addEventListener("click", hide);
      el.hidden = false;
      timer = window.setTimeout(hide, 20000);
    },
    hide,
  };
}

// ---------------------------------------------------------------- compass minimap

export interface Compass {
  update(camera: THREE.Camera, cities: { dir: THREE.Vector3; kind: "capital" | "live" | "awaiting" | "city" }[]): void;
}

export function mountCompass(): Compass {
  const canvas = document.getElementById("compass");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#compass canvas missing");
  const ctx = canvas.getContext("2d");
  const size = 112;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const view = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const north = new THREE.Vector3(0, 1, 0);
  let frame = 0;
  const COLORS = { capital: "#ffd23f", live: "#22d36b", awaiting: "#ff4d8d", city: "#ffffff" } as const;

  return {
    update(camera, cities) {
      if (!ctx || frame++ % 4 !== 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = size / 2;
      const R = c - 8;
      ctx.clearRect(0, 0, size, size);
      // Azimuthal map centred on what the camera looks at.
      view.copy(camera.position).normalize();
      up.copy(north).addScaledVector(view, -view.dot(north));
      if (up.lengthSq() < 1e-6) up.set(0, 0, -1);
      up.normalize();
      right.crossVectors(up, view).normalize();
      ctx.fillStyle = "#2aa7e8";
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(c, c, R / 2, 0, Math.PI * 2);
      ctx.fill();
      for (const city of cities) {
        const d = city.dir;
        const ang = Math.acos(THREE.MathUtils.clamp(d.dot(view), -1, 1));
        const bx = d.dot(right);
        const by = d.dot(up);
        const len = Math.hypot(bx, by) || 1;
        const rr = (ang / Math.PI) * R;
        const x = c + (bx / len) * rr;
        const y = c - (by / len) * rr;
        ctx.fillStyle = COLORS[city.kind];
        ctx.strokeStyle = "#1a1030";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, city.kind === "capital" ? 4.5 : city.kind === "city" ? 2.6 : 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // Heading: where the north pole is from here.
      const nAng = Math.acos(THREE.MathUtils.clamp(north.dot(view), -1, 1));
      const nx = north.dot(right);
      const ny = north.dot(up);
      const nl = Math.hypot(nx, ny) || 1;
      const nr = Math.min(R - 2, (nAng / Math.PI) * R);
      ctx.fillStyle = "#ff4d8d";
      ctx.font = "900 11px 'Arial Black', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", c + (nx / nl) * nr, c - (ny / nl) * nr);
      // You-are-here crosshair + ring.
      ctx.strokeStyle = "#1a1030";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c - 6, c);
      ctx.lineTo(c + 6, c);
      ctx.moveTo(c, c - 6);
      ctx.lineTo(c, c + 6);
      ctx.stroke();
    },
  };
}

// ---------------------------------------------------------------- city stat card (hover / pinned)

export function cityCardHtml(island: Island, s: CityStats | undefined, extra: [string, number][] = []): string {
  if (extra.length) {
    return `<div class="cc-name">${escapeHtml(cityDisplayName(island))}</div>
      <div class="cc-grid">${extra.map(([k, v]) => `<span><b>${v}</b>${escapeHtml(k)}</span>`).join("")}</div>`;
  }
  return `<div class="cc-name">${escapeHtml(cityDisplayName(island))}</div>
    <div class="cc-grid">
      <span><b>${s?.agents ?? island.agentCount}</b>agents</span>
      <span><b>${s?.live ?? 0}</b>live</span>
      <span class="${s?.awaiting ? "hot" : ""}"><b>${s?.awaiting ?? 0}</b>waiting</span>
      <span><b>${s?.activeToday ?? 0}</b>today</span>
      <span><b>${s && s.tokens > 0 ? formatTokens(s.tokens) : "0"}</b>tokens</span>
    </div>`;
}
