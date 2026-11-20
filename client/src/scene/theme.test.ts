import { describe, expect, it } from "vitest";
import { THEMES, THEME_STORAGE_KEY, persistTheme, resolveInitialTheme, themeById, type ThemeId, type ThemeStorage } from "./theme";

function memStorage(init: Record<string, string> = {}): ThemeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const throwing: ThemeStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
};

/** Perceived brightness (matches the pre-round-11 bright-world test's own formula). */
function lum(hex: number): number {
  return (0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)) / 255;
}

/** WCAG relative luminance (gamma-correct) and contrast ratio, for the ink-vs-ground check. */
function relLum(hex: number): number {
  const chan = (v8: number): number => {
    const v = v8 / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = chan((hex >> 16) & 255);
  const g = chan((hex >> 8) & 255);
  const b = chan(hex & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  const la = relLum(a) + 0.05;
  const lb = relLum(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** Rounds 1-10's five themes, which still carry the original bright-world guarantee. */
const BRIGHT_THEME_IDS: readonly ThemeId[] = ["world", "space", "archipelago", "snow", "blueprint"];
/** Round 11 E: three new PLANET-only themes that deliberately break that guarantee. */
const NEW_THEME_IDS: readonly ThemeId[] = ["dark", "horror", "nintendo"];

const REQUIRED_PALETTE_KEYS = ["deep", "mid", "shallow", "foam", "sand", "grassA", "grassB", "rock", "snow"] as const;
const REQUIRED_ROAD_KEYS = ["base", "dash", "kerb"] as const;
const REQUIRED_PROP_KEYS = ["sun", "planetoids", "dome", "snowfall", "deadTrees", "flicker"] as const;

describe("theme registry", () => {
  it("ships eight themes — the original five, then round 11's three planet-only ones — World first, ids unique", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "world",
      "space",
      "archipelago",
      "snow",
      "blueprint",
      "dark",
      "horror",
      "nintendo",
    ]);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
  it("never ships a dark sky or paper for the original five (the bright-world rule)", () => {
    for (const t of THEMES.filter((x) => BRIGHT_THEME_IDS.includes(x.id))) {
      expect(lum(t.wash)).toBeGreaterThan(0.55);
      expect(lum(t.hemiSky)).toBeGreaterThan(0.8);
      expect(lum(t.palette.grassA)).toBeGreaterThan(0.45);
    }
  });
  it("persists and restores through storage", () => {
    const s = memStorage();
    expect(resolveInitialTheme(s)).toBe("world");
    expect(persistTheme(s, "snow")).toBe(true);
    expect(s.data.get(THEME_STORAGE_KEY)).toBe("snow");
    expect(resolveInitialTheme(s)).toBe("snow");
  });
  it("URL ?theme= wins over storage; junk falls back", () => {
    const s = memStorage({ [THEME_STORAGE_KEY]: "snow" });
    expect(resolveInitialTheme(s, "?theme=space")).toBe("space");
    expect(resolveInitialTheme(s, "?theme=lava")).toBe("snow");
    expect(resolveInitialTheme(memStorage({ [THEME_STORAGE_KEY]: "lava" }))).toBe("world");
  });
  it("survives blocked or missing storage", () => {
    expect(resolveInitialTheme(throwing)).toBe("world");
    expect(persistTheme(throwing, "space")).toBe(false);
    expect(resolveInitialTheme(null, "?theme=blueprint")).toBe("blueprint");
    expect(persistTheme(null, "space")).toBe(false);
  });
  it("themeById falls back to World", () => {
    expect(themeById("archipelago").vehicle).toBe("boat");
    expect(themeById("blueprint").postMode).toBe(1);
  });
  it("?theme= resolves the three new round-11 ids too", () => {
    for (const id of NEW_THEME_IDS) expect(resolveInitialTheme(null, `?theme=${id}`)).toBe(id);
  });
});

describe("Round 11 planet themes (Dark, Horror, Nintendo-style)", () => {
  it("every new theme carries all required ThemeSpec fields with sane types and ranges", () => {
    for (const id of NEW_THEME_IDS) {
      const t = themeById(id);
      expect(t.id).toBe(id);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.emoji.length).toBeGreaterThan(0);
      expect(t.blurb.length).toBeGreaterThan(0);
      expect(["world", "islands", "space"]).toContain(t.terrain);
      for (const k of REQUIRED_PALETTE_KEYS) {
        expect(typeof t.palette[k]).toBe("number");
        expect(t.palette[k]).toBeGreaterThanOrEqual(0);
        expect(t.palette[k]).toBeLessThanOrEqual(0xffffff);
      }
      expect(typeof t.atmosphere).toBe("number");
      expect(typeof t.ink).toBe("number");
      expect(t.shade).toHaveLength(3);
      for (const s of t.shade) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
      expect(typeof t.hemiSky).toBe("number");
      expect(typeof t.hemiGround).toBe("number");
      expect(t.hemiIntensity).toBeGreaterThan(0);
      expect(typeof t.clouds).toBe("number");
      expect(typeof t.cloudsVisible).toBe("boolean");
      expect(typeof t.treesVisible).toBe("boolean");
      expect(t.frost).toBeGreaterThanOrEqual(0);
      expect(t.frost).toBeLessThanOrEqual(1);
      for (const k of REQUIRED_ROAD_KEYS) expect(typeof t.road[k]).toBe("number");
      expect([0, 1]).toContain(t.postMode);
      expect(typeof t.wash).toBe("number");
      expect(["car", "boat"]).toContain(t.vehicle);
      expect(["land", "sea", "none"]).toContain(t.links);
      for (const k of REQUIRED_PROP_KEYS) expect(typeof t.props[k]).toBe("boolean");
    }
  });

  it("gives each new theme its own sky, never the live weather sky", () => {
    const skies = NEW_THEME_IDS.map((id) => themeById(id).sky);
    expect(new Set(skies).size).toBe(3);
    expect(skies).not.toContain("weather");
  });

  it("stays readable, not murky: ambient light and deep water never go to literal black", () => {
    for (const id of NEW_THEME_IDS) {
      const t = themeById(id);
      expect(lum(t.hemiSky)).toBeGreaterThan(0.2);
      expect(lum(t.palette.deep)).toBeGreaterThan(0.01);
    }
  });

  it("Horror alone goes barren and flickers; Dark and Nintendo keep a calm, steady forest", () => {
    const horror = themeById("horror");
    expect(horror.props.deadTrees).toBe(true);
    expect(horror.props.flicker).toBe(true);
    expect(horror.treesVisible).toBe(false);
    for (const id of ["dark", "nintendo"] as const) {
      const t = themeById(id);
      expect(t.props.deadTrees).toBe(false);
      expect(t.props.flicker).toBe(false);
      expect(t.treesVisible).toBe(true);
    }
  });

  it("ink stays legible against the ground it's drawn over (WCAG contrast >= 3)", () => {
    for (const id of NEW_THEME_IDS) {
      const t = themeById(id);
      expect(contrast(t.ink, t.palette.grassA)).toBeGreaterThanOrEqual(3);
      expect(contrast(t.ink, t.palette.grassB)).toBeGreaterThanOrEqual(3);
    }
  });
});
