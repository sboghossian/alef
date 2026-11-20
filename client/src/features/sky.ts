// Real sky: weather + day/night tint from the server's "sky" feature, sun/moon (DOM,
// like every other overlay in ui/*) on a real-time arc, pooled rain/snow, a comic storm
// cloud over Harness City when CPU is hot, and a battery badge. The key light stays
// exactly as rig.ts set it up (always upper-left of the camera) — only the background
// tint, particles and these decorations react to time/weather, per the house rule that
// the world never goes dark or murky.

import * as THREE from "three";
import type { SkyPayload, WeatherKind } from "../../../shared/features/sky";
import { SKY_EXTRAS_KEY } from "../../../shared/features/sky";
import { PLANET_R } from "../layout";
import { toon } from "../scene/toon";
import type { ClientFeature } from "./registry";
import {
  daylightFactor,
  nextLowFpsAccum,
  parseDebugOverrides,
  weatherIcon,
  type DebugOverrides,
} from "./sky-lib";
import { setSkyState } from "./sky-state";

const RAIN_POOL = 300;
const SNOW_POOL = 200;
const BOX_W = 34;
const BOX_H = 16;
const BOX_D = 34;
const PARTICLE_FORWARD = -32; // in front of the camera (camera looks down -Z) — far enough
// that, combined with the small point sizes below, drops read as small streaks rather
// than overlapping into one big blocky mass (a real bug in the first pass: 0.55-0.85
// world-unit points at 22 units out rendered 40-60px wide and tiled solid).
const PARTICLE_DOWN = -5;
const LOW_FPS_HALVE_SECONDS = 5;
const STORM_CPU_THRESHOLD = 80;
const BATTERY_LOW_THRESHOLD = 20;

type Vec3 = [number, number, number];
function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function rgb([r, g, b]: Vec3): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

const NIGHT: [Vec3, Vec3] = [
  [21, 16, 46],
  [46, 33, 96],
]; // deep blue-purple — never black
const TWILIGHT: [Vec3, Vec3] = [
  [86, 58, 138],
  [255, 148, 116],
];
const DAY: [Vec3, Vec3] = [
  [61, 148, 240],
  [178, 227, 255],
];
const CLOUD_GRAY: Vec3 = [150, 150, 168];

/** Builds the sky backdrop (a flat CanvasTexture, same technique as scene/planet.ts's
 *  buildSkyTexture): a two-stop gradient blended day/twilight/night, dimmed + grayed by
 *  cloud cover, with stars fading in at night. Regenerated only when the visible bucket
 *  changes (see `skyBucket`), never every frame — canvas work is not free. */
function buildSkyBackground(dayFactor: number, cloudFrac: number, kind: WeatherKind): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("2d canvas unavailable");

  const [twiTop, twiBot] = TWILIGHT;
  const top =
    dayFactor >= 0 ? lerpVec(twiTop, DAY[0], dayFactor) : lerpVec(twiTop, NIGHT[0], -dayFactor);
  const bot =
    dayFactor >= 0 ? lerpVec(twiBot, DAY[1], dayFactor) : lerpVec(twiBot, NIGHT[1], -dayFactor);
  const grayness = Math.min(0.45, cloudFrac * (kind === "fog" ? 0.7 : 0.45));
  const topFinal = lerpVec(top, CLOUD_GRAY, grayness);
  const botFinal = lerpVec(bot, CLOUD_GRAY, grayness);

  const g = c2d.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, rgb(topFinal));
  g.addColorStop(1, rgb(botFinal));
  c2d.fillStyle = g;
  c2d.fillRect(0, 0, size, size);

  // Stars fade in as it gets dark, regardless of cloud (comic sky, never fully hidden).
  const starAlpha = Math.max(0, -dayFactor - 0.05);
  if (starAlpha > 0.01) {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < 140; i++) {
      const x = rand() * size;
      const y = rand() * size * 0.75; // keep the horizon band clear
      const r = rand() < 0.12 ? 2.6 : 1.1 + rand();
      c2d.globalAlpha = starAlpha * (0.5 + rand() * 0.5);
      c2d.fillStyle = rand() < 0.2 ? "#fff4b0" : "#ffffff";
      c2d.beginPath();
      c2d.arc(x, y, r, 0, Math.PI * 2);
      c2d.fill();
    }
    c2d.globalAlpha = 1;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Coarse memo key so the (non-trivial) canvas redraw only happens when the visible
 *  result would actually change — real time moves slowly, no need to redraw every frame. */
function skyBucket(dayFactor: number, cloudFrac: number, kind: WeatherKind): string {
  return `${Math.round(dayFactor * 40)}:${Math.round(cloudFrac * 10)}:${kind}`;
}

/** A soft round dot (radial alpha falloff) so rain/snow points render as drops and
 *  flakes rather than THREE.Points' default flat squares. Built once, shared by both. */
function buildParticleTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("2d canvas unavailable");
  const g = c2d.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c2d.fillStyle = g;
  c2d.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function makeParticleGeometry(count: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * BOX_W;
    pos[i * 3 + 1] = PARTICLE_DOWN + Math.random() * BOX_H;
    pos[i * 3 + 2] = PARTICLE_FORWARD + (Math.random() - 0.5) * BOX_D;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, count);
  return geo;
}

function buildStormCloud(): THREE.Group {
  const group = new THREE.Group();
  const mat = toon(0x4a4460);
  const puffs: Array<[number, number, number, number]> = [
    [0, 0, 0, 2.4],
    [2.2, 0.3, 0.4, 1.8],
    [-2.1, 0.2, -0.3, 1.9],
    [0.6, -0.4, 1.2, 1.6],
    [-0.8, 0.5, -1.1, 1.7],
  ];
  for (const [x, y, z, s] of puffs) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

// ---- module-scope state (one world per page load, mirrors status-bar.ts's pattern) ----
let debug: DebugOverrides = { timeOfDayMin: null, weather: null, cpu: null, active: false };
let reducedMotion = false;
let latest: SkyPayload | null = null;
let rain: THREE.Points | null = null;
let snow: THREE.Points | null = null;
let stormCloud: THREE.Group | null = null;
let particleScale = 1;
let lowFpsAccum = 0;
let fpsFrames = 0;
let fpsWindowStart = 0;
let nextLightningAt = 0;
let lastBucket = "";
let sunEl: HTMLDivElement | null = null;
let moonEl: HTMLDivElement | null = null;
let chipEl: HTMLElement | null = null;
let batteryEl: HTMLElement | null = null;

function effectiveNow(): number {
  if (debug.timeOfDayMin === null) return Date.now();
  const d = new Date();
  d.setHours(Math.floor(debug.timeOfDayMin / 60), debug.timeOfDayMin % 60, 0, 0);
  return d.getTime();
}

function refreshChip(): void {
  if (!chipEl) return;
  const w = latest?.weather;
  const temp = w?.temperatureC !== null && w?.temperatureC !== undefined ? `${Math.round(w.temperatureC)}°` : "--°";
  const kind = debug.weather ?? w?.kind ?? null;
  const offline = w && !w.online ? " (offline)" : "";
  const debugTag = debug.active ? " DEBUG" : "";
  chipEl.textContent = `${latest?.location.label ?? "…"} ${temp} ${weatherIcon(kind)}${offline}${debugTag}`;
}

function refreshBattery(): void {
  if (!batteryEl) return;
  const pct = latest?.machine.batteryPercent ?? null;
  const low = pct !== null && pct < BATTERY_LOW_THRESHOLD && !latest?.machine.batteryCharging;
  batteryEl.hidden = !low;
  if (low) batteryEl.textContent = `🔋${pct}%`;
}

export const skyFeature: ClientFeature = {
  id: "sky",
  mount(ctx) {
    debug = parseDebugOverrides(window.location.search);
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const particleMap = buildParticleTexture();
    const rainMat = new THREE.PointsMaterial({ map: particleMap, color: 0x9fd0ff, size: 0.16, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true });
    const snowMat = new THREE.PointsMaterial({ map: particleMap, color: 0xffffff, size: 0.24, transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true });
    rain = new THREE.Points(makeParticleGeometry(RAIN_POOL), rainMat);
    snow = new THREE.Points(makeParticleGeometry(SNOW_POOL), snowMat);
    rain.visible = false;
    snow.visible = false;
    rain.frustumCulled = false;
    snow.frustumCulled = false;
    ctx.camera.add(rain, snow);

    stormCloud = buildStormCloud();
    ctx.scene.add(stormCloud);

    sunEl = document.createElement("div");
    sunEl.className = "sky-body sky-sun";
    moonEl = document.createElement("div");
    moonEl.className = "sky-body sky-moon";
    document.body.append(sunEl, moonEl);

    chipEl = document.getElementById("hud-f-sky-chip");
    batteryEl = document.getElementById("hud-f-sky-battery");
    if (batteryEl) batteryEl.hidden = true;
    refreshChip();
  },
  onSnapshot(world) {
    const payload = world.extras?.[SKY_EXTRAS_KEY] as SkyPayload | undefined;
    if (payload) {
      latest = payload;
      setSkyState(payload);
      refreshChip();
      refreshBattery();
    }
  },
  onMessage(msg) {
    const payload = msg.payload as Partial<SkyPayload> | undefined;
    if (!payload || typeof payload !== "object" || !payload.weather || !payload.machine) return;
    latest = payload as SkyPayload;
    setSkyState(latest);
    refreshChip();
    refreshBattery();
  },
  onFrame(dt, ctx) {
    const now = effectiveNow();
    const sunriseMs = latest?.weather.sunrise ? Date.parse(latest.weather.sunrise) : null;
    const sunsetMs = latest?.weather.sunset ? Date.parse(latest.weather.sunset) : null;
    const dayFactor = daylightFactor(now, Number.isFinite(sunriseMs) ? sunriseMs : null, Number.isFinite(sunsetMs) ? sunsetMs : null);

    // Sun/moon: simple DOM overlay (like every other label in ui/*), positioned by a
    // comic left-to-right sweep over the viewport, never a true 3D skydome object.
    const dayT = Math.max(0, dayFactor); // 0..1 while the sun should show
    const nightT = Math.max(0, -dayFactor);
    // Kept to a thin top-of-viewport band (never below ~20% height) so the comic sky
    // stays clear of the HUD card and the floating city/agent name-tags, which are
    // positioned by camera-projecting world points and can land almost anywhere across
    // the width — there's no ctx hook to query their screen rects to dodge them exactly.
    if (sunEl) {
      sunEl.style.opacity = dayT > 0.02 ? "1" : "0";
      const x = (0.15 + dayT * 0.7) * 100;
      const y = (1 - dayT) * 16 + 3;
      sunEl.style.left = `${x}%`;
      sunEl.style.top = `${y}%`;
      const battery = latest?.machine.batteryPercent;
      const dim = battery !== null && battery !== undefined && battery < BATTERY_LOW_THRESHOLD && !latest?.machine.batteryCharging;
      sunEl.style.filter = dim ? "brightness(0.65)" : "";
    }
    if (moonEl) {
      moonEl.style.opacity = nightT > 0.02 ? "1" : "0";
      const x = (0.85 - nightT * 0.7) * 100;
      const y = (1 - nightT) * 16 + 3;
      moonEl.style.left = `${x}%`;
      moonEl.style.top = `${y}%`;
    }

    // Sky background: regenerate only when the visible bucket changes.
    const cloudFrac = (latest?.weather.cloudCover ?? 0) / 100;
    const kind: WeatherKind = debug.weather ?? latest?.weather.kind ?? "clear";
    const bucket = skyBucket(dayFactor, cloudFrac, kind);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const old = ctx.scene.background;
      ctx.scene.background = buildSkyBackground(dayFactor, cloudFrac, kind);
      if (old instanceof THREE.Texture) old.dispose();
    }

    // FPS guard: halve the weather-particle pool once low fps has been sustained.
    fpsFrames += 1;
    const elapsed = ctx.elapsed();
    if (fpsWindowStart === 0) fpsWindowStart = elapsed;
    if (elapsed - fpsWindowStart >= 1) {
      const fps = fpsFrames / (elapsed - fpsWindowStart);
      lowFpsAccum = nextLowFpsAccum(lowFpsAccum, fps, elapsed - fpsWindowStart);
      if (lowFpsAccum >= LOW_FPS_HALVE_SECONDS) particleScale = 0.5;
      fpsFrames = 0;
      fpsWindowStart = elapsed;
    }

    // Weather particles (pooled: positions mutated in place, never reallocated).
    const showRain = !reducedMotion && (kind === "rain" || kind === "storm");
    const showSnow = !reducedMotion && kind === "snow";
    if (rain) {
      rain.visible = showRain;
      if (showRain) animateParticles(rain, dt, 24, particleScale);
    }
    if (snow) {
      snow.visible = showSnow;
      if (showSnow) animateParticles(snow, dt, 4, particleScale, true);
    }

    // Storm cloud + lightning over Harness City when CPU is hot.
    const cpu = debug.cpu ?? latest?.machine.cpuPercent ?? 0;
    if (stormCloud) {
      const hot = cpu > STORM_CPU_THRESHOLD;
      stormCloud.visible = hot;
      if (hot) {
        const top = ctx.cityPosition("harness");
        if (top) {
          // Nudged beside the tower, not directly on top of it — the "Harness City"
          // floating name-tag anchors at the same tower-top point, and a DOM label
          // always paints over the WebGL canvas, so a cloud placed exactly there would
          // sit invisibly behind it in most camera framings.
          const dir = top.clone().normalize();
          const tangent = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
          if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
          tangent.normalize();
          const offsetDir = dir.addScaledVector(tangent, 0.4).normalize();
          stormCloud.position.copy(offsetDir.multiplyScalar(PLANET_R + 16));
          if (elapsed >= nextLightningAt) {
            nextLightningAt = elapsed + 4 + Math.random() * 4;
            ctx.labels.burst("⚡", stormCloud.position);
          }
        }
      }
    }

    refreshChip();
    refreshBattery();
  },
  hudButtons: [
    { id: "chip", label: "☀ …", title: "Weather & machine", placement: "status", onClick: (ctx) => ctx.openPanel("sky") },
    { id: "battery", label: "🔋", title: "Battery low", placement: "status", hidden: true, alert: "battery low", onClick: (ctx) => ctx.openPanel("sky") },
  ],
  panels: [
    {
      id: "sky",
      title: "Sky & machine",
      render(el) {
        const w = latest?.weather;
        const m = latest?.machine;
        const rows: string[] = [];
        if (debug.active) rows.push(`<p class="sky-debug-badge">DEBUG overrides active</p>`);
        rows.push(`<p>${latest?.location.label ?? "unknown"} — ${w?.online === false ? "weather offline (showing last known)" : "live"}</p>`);
        rows.push(
          `<ul class="sky-list">` +
            `<li>Temperature: ${w?.temperatureC ?? "—"}°C</li>` +
            `<li>Condition: ${weatherIcon(debug.weather ?? w?.kind ?? null)} ${debug.weather ?? w?.kind ?? "unknown"}</li>` +
            `<li>Cloud cover: ${w?.cloudCover ?? "—"}%</li>` +
            `<li>Wind: ${w?.windSpeedKph ?? "—"} kph</li>` +
            `<li>Sunrise: ${w?.sunrise ? new Date(w.sunrise).toLocaleTimeString() : "—"}</li>` +
            `<li>Sunset: ${w?.sunset ? new Date(w.sunset).toLocaleTimeString() : "—"}</li>` +
            `</ul>`,
        );
        rows.push(
          `<ul class="sky-list">` +
            `<li>CPU: ${debug.cpu ?? m?.cpuPercent ?? "—"}%</li>` +
            `<li>Memory: ${m?.memPercent ?? "—"}%</li>` +
            `<li>Battery: ${m?.batteryPercent ?? "—"}%${m?.batteryCharging ? " (charging)" : ""}</li>` +
            `</ul>`,
        );
        el.innerHTML = rows.join("");
      },
    },
  ],
};

/** Advances a pooled particle system's positions in place (no allocation) and wraps
 *  particles back to the top once they fall through the box, so the pool never grows. */
function animateParticles(points: THREE.Points, dt: number, fallSpeed: number, scale: number, sway = false): void {
  const geo = points.geometry;
  const attr = geo.getAttribute("position") as THREE.BufferAttribute;
  const full = attr.count;
  const active = Math.max(1, Math.round(full * scale));
  geo.setDrawRange(0, active);
  for (let i = 0; i < active; i++) {
    let y = attr.getY(i) - fallSpeed * dt;
    let x = attr.getX(i);
    if (sway) x += Math.sin((y + i) * 0.5) * 0.15;
    if (y < PARTICLE_DOWN) {
      y = PARTICLE_DOWN + BOX_H;
      x = (Math.random() - 0.5) * BOX_W;
    }
    attr.setX(i, x);
    attr.setY(i, y);
  }
  attr.needsUpdate = true;
}
