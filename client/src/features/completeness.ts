// "completeness" feature (round 10, P3): the 🩺 status-bar chip, the Feed item on a real
// score drop, the fps sampler that feeds the client-only `fps` check, and the two palette
// commands that open the Health view. The checklist itself lives in views/health.ts — this
// file only keeps the chip fed and samples what only the client can measure (frame rate).

import type { CompletenessCheck } from "../../../shared/features/completeness";
import { computeScore, scoreTone } from "../../../shared/features/completeness";
import { isFirstRun, medianFps, WELCOME_SEEN_KEY } from "../views/health-lib";
import { isRecord } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { onSceneParts } from "../scene/scene-bus";
import type { HealthSummary } from "./workspace-lib";
import { icon } from "../shell/icons";
import "./completeness.css";

const CHIP_ID = "hud-f-completeness-chip";
const FPS_WINDOW_SAMPLES = 20; // ~10s at the 0.5s cadence main.ts writes frameStats on

interface ParsedSummary {
  /** The server's own clock at that recompute (`cache.at` / the "summary" message's own
   *  `generatedAt`); null only for a payload that predates this field. */
  generatedAt: string | null;
  score: number;
  checks: CompletenessCheck[];
}

function parseSummary(v: unknown): ParsedSummary | null {
  if (!isRecord(v) || typeof v.score !== "number" || !Array.isArray(v.checks)) return null;
  return { generatedAt: typeof v.generatedAt === "string" ? v.generatedAt : null, score: v.score, checks: v.checks as CompletenessCheck[] };
}

/** Local-day key so a repeated drop the same day updates one Feed item instead of spamming. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── fps sampling: a tiny cross-module accessor (same pattern as sky-state.ts), so the Health
// view can read "what has this session actually measured" without a new ClientContext API ──

let fpsSamples: number[] = [];

/** Median fps over the last ~10s while Orbit was the active view; null until enough samples
 *  have come in (e.g. right after boot, or the user has never opened Orbit this session). */
export function currentMedianFps(): number | null {
  return medianFps(fpsSamples);
}

// ── the Town square's global workspace reads the Health checklist through this tiny accessor
// (same cross-module pattern as currentMedianFps above) rather than re-parsing world.extras
// itself ──

let cachedHealth: HealthSummary | null = null;
const healthListeners = new Set<() => void>();

/** The Health checklist's current summary, for workspace-lib.ts's healthCandidates(). Null
 *  before the first snapshot/tick has parsed one. `generatedAt` is stamped here, when this
 *  session saw it — the wire shape has no timestamp of its own (see HealthSummary's doc). */
export function currentHealthSummary(): HealthSummary | null {
  return cachedHealth;
}

export function onHealthChange(fn: () => void): () => void {
  healthListeners.add(fn);
  return () => healthListeners.delete(fn);
}

let chipEl: HTMLElement | null = null;
let lastScore: number | null = null;
const CHIP_TITLE = "Alef's own health score — click for the checklist";
/** A second tooltip line other features own (the Fix queue's count, features/fixes.ts). */
let chipNote = "";

/** Sets the Health chip's tooltip note ("" removes it). */
export function setHealthChipNote(note: string): void {
  chipNote = note;
  if (!chipEl) chipEl = document.getElementById(CHIP_ID);
  if (chipEl) chipEl.title = chipNote ? `${CHIP_TITLE}\n${chipNote}` : CHIP_TITLE;
}
let pulsedThisSession = false;

function paintChip(score: number): void {
  if (!chipEl) chipEl = document.getElementById(CHIP_ID);
  if (!chipEl) return;
  chipEl.innerHTML = `${icon("health", 14) ?? ""} ${score}%`;
  chipEl.classList.remove("hc-good", "hc-warn", "hc-bad");
  chipEl.classList.add(`hc-${scoreTone(score)}`);
}

function maybePulse(): void {
  if (pulsedThisSession) return;
  pulsedThisSession = true;
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(WELCOME_SEEN_KEY);
  } catch {
    return; // private window / blocked storage: skip the pulse rather than throw
  }
  if (!isFirstRun(seen)) return;
  if (!chipEl) chipEl = document.getElementById(CHIP_ID);
  chipEl?.classList.add("hc-pulse-once");
  chipEl?.addEventListener("animationend", () => chipEl?.classList.remove("hc-pulse-once"), { once: true });
}

/** Shared by onSnapshot (boot / a WS reconnect's snapshot) and onMessage (a live "summary" push
 *  on every real recompute, round 11: server/features/completeness.ts's `ensureFresh`): paints
 *  the chip, feeds a real score-drop event, and refreshes the Town square's cached Health
 *  summary stamped with the SERVER's own clock — never this session's, so a still-failing
 *  check's age reflects when it was last actually checked, not when this tab happened to load. */
function applySummary(summary: ParsedSummary, ctx: ClientContext): void {
  paintChip(summary.score);
  maybePulse();
  if (lastScore !== null && lastScore - summary.score >= 5) {
    ctx.feed.push({
      id: `health:drop:${todayKey()}`,
      kind: "system",
      at: Date.now(),
      title: `Health score dropped to ${summary.score}%`,
      detail: `Was ${lastScore}% — open 🩺 Health to see what changed.`,
    });
  }
  lastScore = summary.score;
  cachedHealth = { generatedAt: summary.generatedAt ?? new Date().toISOString(), checks: summary.checks };
  for (const fn of healthListeners) fn();
}

export const completenessFeature: ClientFeature = {
  id: "completeness",
  mount(ctx) {
    chipEl = document.getElementById(CHIP_ID);
    onSceneParts((parts) => {
      if (!parts.frameStats || ctx.activeView() !== "orbit") return;
      fpsSamples.push(parts.frameStats.fps);
      if (fpsSamples.length > FPS_WINDOW_SAMPLES) fpsSamples = fpsSamples.slice(-FPS_WINDOW_SAMPLES);
    });
  },
  onSnapshot(world, ctx) {
    const summary = parseSummary(world.extras?.["completeness.summary"]);
    if (!summary) return;
    applySummary(summary, ctx);
  },
  onMessage(msg, ctx) {
    const payload = msg.payload;
    if (!isRecord(payload) || payload.kind !== "summary") return;
    const summary = parseSummary(payload);
    if (!summary) return;
    applySummary(summary, ctx);
  },
  paletteCommands: (ctx) => [
    { id: "check", title: "Health check", kind: "view", keywords: ["health", "score", "completeness", "setup", "doctor"], run: () => ctx.showView("health") },
    { id: "start-agent", title: "Start an agent…", kind: "action", keywords: ["dispatch", "launch", "new agent", "preset", "auto setup"], run: () => ctx.showView("health", "start") },
  ],
  hudButtons: [
    {
      id: "chip",
      label: "—%",
      title: CHIP_TITLE,
      text: "Health",
      placement: "status",
      onClick: (ctx: ClientContext) => ctx.showView("health"),
    },
  ],
};
