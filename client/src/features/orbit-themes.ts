// Orbit themes (Round 7 T1; Dark/Horror/Nintendo added Round 11 E). World, Space,
// Archipelago, Snow globe, Blueprint, Dark, Horror, Nintendo-style.
// A theme swaps materials, palette, sky and props; it never touches data or layout.
// The shell renders the picker from `orbitThemes` (list/current/set/onChange); this
// feature only applies the choice, persists it (localStorage "alef.theme") and
// crossfades the switch. Debug: ?theme=space (applied, not persisted).

import * as THREE from "three";
import { log } from "../log";
import { sceneParts } from "../scene/scene-bus";
import {
  THEMES,
  isThemeId,
  persistTheme,
  resolveInitialTheme,
  themeById,
  type ThemeId,
  type ThemeSpec,
  type ThemeStorage,
} from "../scene/theme";
import { createThemeProps, isThemeSky, skyTexture, type ThemeProps } from "../scene/theme-props";
import type { ClientFeature } from "./registry";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  emoji: string;
  blurb: string;
}

export interface OrbitThemesApi {
  list(): ThemeInfo[];
  current(): ThemeId;
  /** Applies (with a crossfade) and persists. Unknown ids are ignored. */
  set(id: ThemeId): void;
  /** Called after every change; returns an unsubscribe. */
  onChange(fn: (id: ThemeId) => void): () => void;
}

/** Also dispatched on window after every change: CustomEvent<{ id: ThemeId }>. */
export const THEME_EVENT = "alef:orbit-theme";

const CROSSFADE_MS = 650;

let current: ThemeId = "world";
let props: ThemeProps | null = null;
/** The last sky the weather feature set (restored when going back to World). */
let weatherSky: THREE.Color | THREE.Texture | null = null;
const listeners = new Set<(id: ThemeId) => void>();

function storage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function applyTheme(theme: ThemeSpec): void {
  const parts = sceneParts();
  const rig = parts.rig;
  if (!rig) return;
  parts.planet?.applyTheme(theme);
  parts.cities?.setRoadStyle(theme.road);
  parts.cities?.setLinkMode(theme.links);
  parts.agents?.setVehicle(theme.vehicle);
  rig.hemi.color.setHex(theme.hemiSky);
  rig.hemi.groundColor.setHex(theme.hemiGround);
  // Horror flickers on top of this in onFrame; every other theme just holds it steady.
  if (!theme.props.flicker) rig.hemi.intensity = theme.hemiIntensity;
  rig.post.setStyle({ ink: theme.ink, shade: theme.shade, mode: theme.postMode, wash: theme.wash });
  props ??= createThemeProps(rig.scene);
  props.apply(theme);
  syncSky(rig.scene, theme);
}

/** The weather feature rewrites scene.background on its own; themes with their own sky re-assert it. */
function syncSky(scene: THREE.Scene, theme: ThemeSpec): void {
  const bg = scene.background;
  const own = skyTexture(theme.sky);
  if (!isThemeSky(bg) && (bg instanceof THREE.Texture || bg instanceof THREE.Color)) weatherSky = bg;
  if (own) {
    if (bg !== own) scene.background = own;
  } else if (isThemeSky(bg) && weatherSky) {
    scene.background = weatherSky;
  }
}

/** Freezes the current frame on a 2D canvas over the planet, then fades it out over the new theme. */
function crossfade(then: () => void): void {
  const rig = sceneParts().rig;
  const canvas = rig?.renderer.domElement;
  const host = canvas?.parentElement;
  if (!rig || !canvas || !host || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    then();
    return;
  }
  rig.post.afterNextRender((src) => {
    const shot = document.createElement("canvas");
    shot.width = src.width;
    shot.height = src.height;
    shot.className = "orbit-theme-fade";
    shot.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:1;transition:opacity ${CROSSFADE_MS}ms ease`;
    shot.getContext("2d")?.drawImage(src, 0, 0);
    host.insertBefore(shot, src.nextSibling);
    then();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        shot.style.opacity = "0";
        window.setTimeout(() => shot.remove(), CROSSFADE_MS + 80);
      }),
    );
  });
}

function setTheme(id: ThemeId, opts: { persist: boolean; fade: boolean }): void {
  if (!isThemeId(id)) return;
  const changed = id !== current;
  current = id;
  if (opts.persist && !persistTheme(storage(), id)) log.warn("orbit-themes", "could not persist theme (storage unavailable)");
  const run = (): void => {
    const t0 = performance.now();
    applyTheme(themeById(id));
    log.info("orbit-themes", `theme ${id} applied in ${Math.round(performance.now() - t0)}ms`);
  };
  if (opts.fade && changed) crossfade(run);
  else run();
  if (!changed) return;
  for (const fn of listeners) fn(id);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { id } }));
}

export const orbitThemes: OrbitThemesApi = {
  list: () => THEMES.map(({ id, name, emoji, blurb }) => ({ id, name, emoji, blurb })),
  current: () => current,
  set: (id) => setTheme(id, { persist: true, fade: true }),
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const orbitThemesFeature: ClientFeature = {
  id: "orbit-themes",
  mount() {
    const initial = resolveInitialTheme(storage(), window.location.search);
    current = "world";
    setTheme(initial, { persist: false, fade: false });
  },
  onFrame(dt, ctx) {
    props?.update(dt, ctx.elapsed());
    const rig = sceneParts().rig;
    if (!rig) return;
    const theme = themeById(current);
    syncSky(rig.scene, theme);
    // Horror's "flickering lights": a cheap two-tone wobble on the existing hemisphere
    // light's intensity — one JS float per frame, no new uniform, no new WebGL object.
    if (theme.props.flicker) {
      const t = ctx.elapsed();
      const wobble = Math.sin(t * 9.1) * 0.5 + Math.sin(t * 23.7 + 1.3) * 0.5;
      rig.hemi.intensity = theme.hemiIntensity * (1 + 0.12 * wobble);
    }
  },
  paletteCommands: () =>
    THEMES.map((t) => ({
      id: `theme-${t.id}`,
      title: `Theme: ${t.name}`,
      kind: "theme",
      meta: t.id === current ? "current" : t.blurb,
      keywords: ["theme", "look", "style", t.id, t.name.toLowerCase()],
      run: () => orbitThemes.set(t.id),
    })),
};
