// Adaptive render quality (P4b, round 10). Steps `renderer.setPixelRatio` from the rolling
// frame stats P0 publishes on the scene bus (`sceneParts().frameStats`, refreshed every 0.5s by
// main.ts) — this module has no onFrame hook and needs no ClientContext of its own, so it is
// safe to import from anywhere. game-feel.ts (P4a) is the one registered ClientFeature; per the
// round 9/10 contract it imports { qualityController, setQualityTier, qualityHudButton } from
// here for its effect scaling and its "Quality: Auto/High/Low" Settings row. `?perf=1` runs a
// one-shot 20s p50/p95 sampler (logged, not returned); `?perf=headless` freezes the tier so
// Playwright screenshots stay stable across runs (round 10 performance budget).

import { log } from "../../log";
import { onSceneParts, sceneParts } from "../../scene/scene-bus";
import type { HudButton } from "../registry";
import {
  INITIAL_HYSTERESIS,
  pixelRatioFor,
  resolveTier,
  stepHysteresis,
  type HysteresisState,
  type QualityMode,
  type QualityTier,
} from "./quality-lib";

const MODE_KEY = "agent-world.quality.mode";
// Read lazily: this module is imported by the feature index, which vitest loads in plain Node.
const perfParam = (): string | null => (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("perf"));
const SAMPLE_WINDOW_MS = 20_000;
const MODE_LABEL: Record<QualityMode, string> = { auto: "Auto", 0: "High", 1: "Medium", 2: "Low" };
/** The Settings row only offers these three; "Medium" (tier 1) is auto-only, per spec §P4b. */
const CYCLE: readonly QualityMode[] = ["auto", 0, 2];

function readMode(): QualityMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "0" || v === "1" || v === "2" ? (Number(v) as QualityTier) : "auto";
  } catch {
    return "auto"; // private mode / quota: just don't persist the choice
  }
}

function writeMode(m: QualityMode): void {
  try {
    localStorage.setItem(MODE_KEY, String(m));
  } catch {
    /* ignore */
  }
}

let mode: QualityMode = readMode();
let hysteresis: HysteresisState = INITIAL_HYSTERESIS;
let tier: QualityTier = resolveTier(mode, hysteresis.tier);
let rendererSeen = false;
const listeners = new Set<(t: QualityTier) => void>();

function applyTier(next: QualityTier, force = false): void {
  const changed = next !== tier;
  tier = next;
  if (!changed && !force) return;
  const renderer = sceneParts().rig?.renderer;
  if (renderer) renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio || 1));
  for (const fn of listeners) fn(tier);
}

function updateHudButtonLabel(): void {
  const el = document.getElementById("hud-f-game-feel-tier");
  if (el) el.dataset.label = `Quality: ${MODE_LABEL[mode]}`;
}

// ---------------------------------------------------------------- ?perf=1 baseline sampler

let perfSamples: { fps: number; p95ms: number }[] = [];
let perfStartedAt = 0;
let perfLogged = false;

function samplePerf(fps: number, p95ms: number): void {
  if (perfParam() !== "1" || perfLogged) return;
  const now = performance.now();
  if (perfStartedAt === 0) perfStartedAt = now;
  perfSamples.push({ fps, p95ms });
  if (now - perfStartedAt < SAMPLE_WINDOW_MS) return;
  perfLogged = true;
  const at = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  const frameMs = perfSamples.map((s) => (s.fps > 0 ? 1000 / s.fps : 0));
  const rollingP95 = perfSamples.map((s) => s.p95ms);
  log.info(
    "quality",
    `perf sampler: p50 ${at(frameMs, 0.5).toFixed(1)}ms, p95 ${at(rollingP95, 0.95).toFixed(1)}ms ` +
      `(${perfSamples.length} ticks over 20s of the 0.5s scene-bus frameStats, not raw per-frame samples)`,
  );
}

// ---------------------------------------------------------------- wiring

onSceneParts((parts) => {
  if (parts.rig?.renderer && !rendererSeen) {
    rendererSeen = true;
    applyTier(tier, true); // apply a persisted non-default mode the moment the renderer exists
  }
  const fs = parts.frameStats;
  if (!fs) return;
  samplePerf(fs.fps, fs.p95ms);
  if (mode === "auto") {
    hysteresis = stepHysteresis(hysteresis, fs.fps, performance.now(), { allowStepDown: perfParam() !== "headless" });
    applyTier(resolveTier(mode, hysteresis.tier));
  }
});

/** P4b → P3 (spec §3): the Health view's "Lower quality" fix and the round-10 Settings row both
 *  call this. `"auto"` hands control back to the hysteresis loop above. */
export function setQualityTier(t: QualityTier | "auto"): void {
  mode = t;
  writeMode(mode);
  applyTier(resolveTier(mode, hysteresis.tier));
  updateHudButtonLabel();
}

/** The one cross-file touchpoint (round 9/10 contract): game-feel.ts reads the live tier to
 *  scale its own particle counts (confetti, birds, Z sprites, station props). */
export const qualityController = {
  tier: (): QualityTier => tier,
  mode: (): QualityMode => mode,
  onChange: (fn: (t: QualityTier) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Ready-made for game-feel.ts's `hudButtons` array (it owns the Settings-pane registration).
 *  Cycles Auto → High → Low; the visible row text comes from the button's `data-label` attribute
 *  (shell.ts renders `hud-f-<featureId>-tier`), kept in sync via updateHudButtonLabel() above. */
export const qualityHudButton: HudButton = {
  id: "tier",
  label: "🎮",
  title: "Render quality: cycles Auto → High → Low",
  text: `Quality: ${MODE_LABEL[mode]}`,
  onClick: (ctx) => {
    const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length] ?? "auto";
    setQualityTier(next);
    ctx.toast(`Quality: ${MODE_LABEL[next]}`);
  },
};
