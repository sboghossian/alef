// Orbit themes: pure data. A theme swaps materials, palette, sky and props. It never
// touches the data or the city layout. Applied by features/orbit-themes.ts.
// Original rule (rounds 1-10): every theme stays bright and readable (no dark/murky sky).
// Round 11 (Alex, 2026-09-26) explicitly asked for three PLANET-only themes that break
// that rule on purpose — Dark, Horror, Nintendo-style — with one replacement rule: readable,
// not murky (Dark), spooky-fun, not gory (Horror). See theme.test.ts for what "readable"
// means as an assertion (a WCAG-ish ink/ground contrast floor + a never-literal-black floor
// on the ambient light), scoped to just those three so the original five keep their old,
// stricter bright-world guarantee unchanged.

export type ThemeId = "world" | "space" | "archipelago" | "snow" | "blueprint" | "dark" | "horror" | "nintendo";
/** "world" = the normal terrain; "islands" = only city plateaus above a sea; "space" = plateaus only, floating. */
export type TerrainMode = "world" | "islands" | "space";
export type SkyKind = "weather" | "nebula" | "ocean" | "snow" | "blueprint" | "night" | "blood" | "toy";

export interface TerrainPalette {
  deep: number;
  mid: number;
  shallow: number;
  foam: number;
  sand: number;
  grassA: number;
  grassB: number;
  rock: number;
  snow: number;
}

export interface ThemeSpec {
  id: ThemeId;
  name: string;
  emoji: string;
  blurb: string;
  terrain: TerrainMode;
  palette: TerrainPalette;
  /** "weather" = leave the sky feature's live weather sky alone. */
  sky: SkyKind;
  atmosphere: number;
  ink: number;
  /** Colour the halftone dots multiply by on the shadow side. */
  shade: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  /** Ambient (hemisphere light) intensity. Themes before round 11 all matched the rig's
   *  built-in 1.35 default; Dark/Horror tune it down a little, Nintendo up a little. */
  hemiIntensity: number;
  clouds: number;
  cloudsVisible: boolean;
  treesVisible: boolean;
  /** 0..1, pushes trees toward frosty white. */
  frost: number;
  road: { base: number; dash: number; kerb: number };
  /** Post-process: 0 = comic ink, 1 = blueprint (paper, white lines, hatching). */
  postMode: 0 | 1;
  /** Wash colour for "faded" things (district focus): the theme's paper. */
  wash: number;
  vehicle: "car" | "boat";
  /** Roads between districts: on the land, as sea lanes, or none (floating districts). */
  links: "land" | "sea" | "none";
  props: {
    sun: boolean;
    planetoids: boolean;
    dome: boolean;
    snowfall: boolean;
    /** Horror only: a sparse pooled instanced mesh of bare trees, scattered over real ground
     *  height (planet.groundHeight), in place of the normal green forest (treesVisible: false). */
    deadTrees: boolean;
    /** Horror only: the hemisphere light's intensity gets a small per-frame flicker instead
     *  of holding steady at hemiIntensity (features/orbit-themes.ts onFrame). */
    flicker: boolean;
  };
}

const WORLD_PALETTE: TerrainPalette = {
  deep: 0x1a6bdb,
  mid: 0x219ef2,
  shallow: 0x40e0db,
  foam: 0xedfcff,
  sand: 0xfadb85,
  grassA: 0x73d642,
  grassB: 0x3db345,
  rock: 0xa88f80,
  snow: 0xffffff,
};

const BASE: Omit<ThemeSpec, "id" | "name" | "emoji" | "blurb"> = {
  terrain: "world",
  palette: WORLD_PALETTE,
  sky: "weather",
  atmosphere: 0x8fe6ff,
  ink: 0x1a1030,
  shade: [0.62, 0.55, 0.85],
  hemiSky: 0xdff2ff,
  hemiGround: 0xb8a4ff,
  hemiIntensity: 1.35,
  clouds: 0xffffff,
  cloudsVisible: true,
  treesVisible: true,
  frost: 0,
  road: { base: 0x585d78, dash: 0xffd933, kerb: 0xf7f7ff },
  postMode: 0,
  wash: 0xf1ecff,
  vehicle: "car",
  links: "land",
  props: { sun: false, planetoids: false, dome: false, snowfall: false, deadTrees: false, flicker: false },
};

export const THEMES: readonly ThemeSpec[] = [
  { ...BASE, id: "world", name: "World", emoji: "🌍", blurb: "The planet: districts as cities on one comic globe." },
  {
    ...BASE,
    id: "space",
    name: "Space",
    emoji: "🪐",
    blurb: "Districts as small planets around a sun, in a pastel nebula.",
    terrain: "space",
    palette: { ...WORLD_PALETTE, sand: 0xffd9a8, foam: 0xfff0f6, grassA: 0x9be27a, grassB: 0x6fcf87, rock: 0xd9c8ff },
    sky: "nebula",
    atmosphere: 0xffc6f0,
    ink: 0x2a1850,
    shade: [0.72, 0.6, 0.92],
    hemiSky: 0xfff0ff,
    hemiGround: 0xc9b8ff,
    cloudsVisible: false,
    treesVisible: false,
    road: { base: 0x8f7cf0, dash: 0xfff27a, kerb: 0xffe3fb },
    wash: 0xfbeaff,
    links: "none",
    props: { sun: true, planetoids: true, dome: false, snowfall: false, deadTrees: false, flicker: false },
  },
  {
    ...BASE,
    id: "archipelago",
    name: "Archipelago",
    emoji: "🏝️",
    blurb: "Districts as islands on a bright sea; boats sail the water routes.",
    terrain: "islands",
    palette: { ...WORLD_PALETTE, deep: 0x1f8fe0, mid: 0x2bb5f0, shallow: 0x5ae8dc },
    sky: "ocean",
    atmosphere: 0xa6f0ff,
    treesVisible: false,
    road: { base: 0x8ad8f5, dash: 0xffffff, kerb: 0xe9fdff },
    wash: 0xe8f8ff,
    vehicle: "boat",
    links: "sea",
  },
  {
    ...BASE,
    id: "snow",
    name: "Snow globe",
    emoji: "❄️",
    blurb: "A snowy planet under a glass dome, with snowfall.",
    palette: {
      deep: 0x5aa6e8,
      mid: 0x7cc4f2,
      shallow: 0xa8e6f5,
      foam: 0xffffff,
      sand: 0xf2f6ff,
      grassA: 0xf4f8ff,
      grassB: 0xe2ecfb,
      rock: 0xc9d3e6,
      snow: 0xffffff,
    },
    sky: "snow",
    atmosphere: 0xd8f4ff,
    shade: [0.7, 0.76, 0.95],
    hemiSky: 0xeef8ff,
    hemiGround: 0xcfd8ff,
    frost: 0.75,
    road: { base: 0xa9b6d3, dash: 0xffffff, kerb: 0xffffff },
    wash: 0xf4f8ff,
    props: { sun: false, planetoids: false, dome: true, snowfall: true, deadTrees: false, flicker: false },
  },
  {
    ...BASE,
    id: "blueprint",
    name: "Blueprint",
    emoji: "📐",
    blurb: "Cyan paper, white ink lines, sketchy hatch shading.",
    sky: "blueprint",
    atmosphere: 0xdff6ff,
    ink: 0xffffff,
    postMode: 1,
    wash: 0x7cc0f2,
  },
  {
    ...BASE,
    id: "dark",
    name: "Dark",
    emoji: "🌙",
    blurb: "The planet's night side: deep blues, a rising moon, glowing roads.",
    palette: {
      deep: 0x0a1e3d,
      mid: 0x123863,
      shallow: 0x1f5c8f,
      foam: 0x66a9d6,
      sand: 0x3a4a6b,
      grassA: 0x1c3350,
      grassB: 0x28425f,
      rock: 0x384860,
      snow: 0xbcd4ee,
    },
    sky: "night",
    atmosphere: 0x3a6fb0,
    ink: 0xdff2ff,
    shade: [0.5, 0.6, 0.85],
    hemiSky: 0x6f97c9,
    hemiGround: 0x16233a,
    hemiIntensity: 1.2,
    clouds: 0x2f4f7a,
    road: { base: 0x1a2438, dash: 0xffe066, kerb: 0x8fd8ff },
    wash: 0x1c2c48,
    props: { sun: false, planetoids: false, dome: false, snowfall: false, deadTrees: false, flicker: false },
  },
  {
    ...BASE,
    id: "horror",
    name: "Horror",
    emoji: "🎃",
    blurb: "Fog, a blood moon, a sickly glow — spooky-fun, not gory.",
    palette: {
      deep: 0x1a0f14,
      mid: 0x3a1420,
      shallow: 0x5c2a2a,
      foam: 0x8a9a4a,
      sand: 0x4a3a28,
      grassA: 0x3a4a2e,
      grassB: 0x2a3a20,
      rock: 0x554a4a,
      snow: 0xc9c9b0,
    },
    sky: "blood",
    atmosphere: 0x6a3030,
    ink: 0xd8e0c8,
    shade: [0.4, 0.25, 0.3],
    hemiSky: 0x6a3a3a,
    hemiGround: 0x2a3a24,
    hemiIntensity: 1.0,
    clouds: 0x4a2a2a,
    treesVisible: false,
    road: { base: 0x1a1418, dash: 0x8a1a1a, kerb: 0x4a4a3a },
    wash: 0x2a1a20,
    props: { sun: false, planetoids: false, dome: false, snowfall: false, deadTrees: true, flicker: true },
  },
  {
    ...BASE,
    id: "nintendo",
    name: "Nintendo-style",
    emoji: "🍄",
    blurb: "Mario-Kart toy look: candy colours, checker roads, a cheerful sky.",
    palette: {
      deep: 0x1560e8,
      mid: 0x2e86ff,
      shallow: 0x5fd0ff,
      foam: 0xffffff,
      sand: 0xffe27a,
      grassA: 0x3ddc3d,
      grassB: 0x2bbf2b,
      rock: 0xd97a3a,
      snow: 0xffffff,
    },
    sky: "toy",
    atmosphere: 0xfff066,
    shade: [0.75, 0.6, 0.5],
    hemiSky: 0xfff6d0,
    hemiGround: 0xffd0e8,
    hemiIntensity: 1.5,
    road: { base: 0x2a2a2a, dash: 0xffffff, kerb: 0xff3b3b },
    wash: 0xfff0f6,
    props: { sun: false, planetoids: false, dome: false, snowfall: false, deadTrees: false, flicker: false },
  },
];

export const DEFAULT_THEME: ThemeId = "world";
export const THEME_STORAGE_KEY = "alef.theme";

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEMES.some((t) => t.id === v);
}

export function themeById(id: ThemeId): ThemeSpec {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** Minimal storage surface (window.localStorage in the app, a Map in tests). */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** URL `?theme=` wins (debug/screenshots, not persisted), then storage, then World. Never throws. */
export function resolveInitialTheme(storage: ThemeStorage | null, search = ""): ThemeId {
  const fromUrl = new URLSearchParams(search).get("theme");
  if (isThemeId(fromUrl)) return fromUrl;
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    if (isThemeId(saved)) return saved;
  } catch {
    // storage blocked (private mode): fall through
  }
  return DEFAULT_THEME;
}

/** False when storage is unavailable; the theme still applies for this page. */
export function persistTheme(storage: ThemeStorage | null, id: ThemeId): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}
