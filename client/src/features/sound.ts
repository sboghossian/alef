// WebAudio-synthesized cues — no audio files. Soft pop on an activity burst, chime on a
// Jev decision, ding when an agent starts awaiting input, ambient wind/rain matching the
// weather (from the "sky" feature via sky-state.ts). Muted by default; the speaker toggle
// is remembered in localStorage. All gains stay low — this is ambience, not a soundtrack.

import type { ClientFeature } from "./registry";
import { getSkyState, onSkyState } from "./sky-state";
import { ambientGains, newlyAwaiting } from "./sound-lib";

const MUTE_KEY = "agent-world.sound.muted";
const MASTER_VOLUME = 0.5; // scales every synthesized cue; the envelopes below are already quiet
const POP_THROTTLE_MS = 120;
const AMBIENT_RAMP_S = 1;

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null;
let windGain: GainNode | null = null;
let rainGain: GainNode | null = null;
let muted = true;
let awaitingIds = new Set<string>();
let lastPopAt = 0;
let muteBtn: HTMLElement | null = null;
/** Set past `now` for the rough duration of whatever `playCue` just fired — lets other
 *  features (claude-fm) duck their own audio under a cue without knowing what cues exist. */
let cueDuckUntil = 0;
const CUE_DUCK_MS = 650; // covers every CueKind below with a little headroom

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) !== "0";
  } catch {
    return true; // private mode / quota — stay muted rather than surprise-play audio
  }
}

function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Lazily creates the AudioContext + the two always-on ambient beds (one reused 2s noise
 *  buffer, lowpassed for wind and highpassed for rain — a pooled resource, not per-cue
 *  allocation). Must be called from inside a user-gesture handler the first time. */
function ensureAudio(): void {
  if (audioCtx || typeof AudioContext === "undefined") return;
  audioCtx = new AudioContext();
  master = audioCtx.createGain();
  master.gain.value = MASTER_VOLUME;
  master.connect(audioCtx.destination);

  const len = audioCtx.sampleRate * 2;
  const noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  windGain = audioCtx.createGain();
  windGain.gain.value = 0;
  const windFilter = audioCtx.createBiquadFilter();
  windFilter.type = "lowpass";
  windFilter.frequency.value = 400;
  const windSource = audioCtx.createBufferSource();
  windSource.buffer = noiseBuffer;
  windSource.loop = true;
  windSource.connect(windFilter).connect(windGain).connect(master);
  windSource.start();

  rainGain = audioCtx.createGain();
  rainGain.gain.value = 0;
  const rainFilter = audioCtx.createBiquadFilter();
  rainFilter.type = "highpass";
  rainFilter.frequency.value = 2500;
  const rainSource = audioCtx.createBufferSource();
  rainSource.buffer = noiseBuffer;
  rainSource.loop = true;
  rainSource.connect(rainFilter).connect(rainGain).connect(master);
  rainSource.start();

  syncAmbient();
}

function syncAmbient(): void {
  if (!audioCtx || !windGain || !rainGain) return;
  const payload = getSkyState();
  const gains = ambientGains(payload?.weather.kind ?? null, payload?.weather.cloudCover ?? null);
  const t = audioCtx.currentTime;
  windGain.gain.linearRampToValueAtTime(muted ? 0 : gains.wind, t + AMBIENT_RAMP_S);
  rainGain.gain.linearRampToValueAtTime(muted ? 0 : gains.rain, t + AMBIENT_RAMP_S);
}

function tone(freq: number, startAt: number, duration: number, type: OscillatorType, peak: number): void {
  if (!audioCtx || !master) return;
  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, startAt);
  g.gain.linearRampToValueAtTime(peak, startAt + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.connect(g).connect(master);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function playPop(): void {
  if (muted || !audioCtx) return;
  const now = performance.now();
  if (now - lastPopAt < POP_THROTTLE_MS) return; // a burst of activity is one pop, not a wall of them
  lastPopAt = now;
  tone(520, audioCtx.currentTime, 0.08, "sine", 0.18);
}

function playChime(): void {
  if (muted || !audioCtx) return;
  const t = audioCtx.currentTime;
  tone(660, t, 0.5, "sine", 0.16);
  tone(880, t + 0.06, 0.5, "sine", 0.12);
}

function playDing(): void {
  if (muted || !audioCtx) return;
  tone(1040, audioCtx.currentTime, 0.35, "triangle", 0.2);
}

export type CueKind = "pickup" | "deliver" | "approve" | "deny";

/** Short game cues for the "courier" feature. Silent while muted, like every other cue. */
export function playCue(kind: CueKind): void {
  if (muted || !audioCtx) return;
  cueDuckUntil = performance.now() + CUE_DUCK_MS;
  const t = audioCtx.currentTime;
  if (kind === "pickup") tone(740, t, 0.12, "triangle", 0.16);
  else if (kind === "deliver") [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.07, 0.25, "square", 0.07));
  else if (kind === "approve") [660, 990].forEach((f, i) => tone(f, t + i * 0.09, 0.3, "sine", 0.16));
  else tone(220, t, 0.35, "sawtooth", 0.08);
}

function updateMuteButton(): void {
  if (!muteBtn) return;
  muteBtn.textContent = muted ? "🔇" : "🔊";
  muteBtn.setAttribute("aria-pressed", String(!muted));
}

export const soundFeature: ClientFeature = {
  id: "sound",
  mount(ctx) {
    muted = readMuted();
    muteBtn = document.getElementById("hud-f-sound-mute");
    updateMuteButton();
    if (!muted) ensureAudio();

    ctx.store.onActivity((list) => {
      if (list.some((a) => a.targetObjectId)) playPop();
    });
    ctx.store.onDecision(() => playChime());
    ctx.store.onAgents(() => {
      const agents = [...ctx.store.agents.values()];
      if (newlyAwaiting(awaitingIds, agents).length > 0) playDing();
      awaitingIds = new Set(agents.filter((a) => a.awaitingInput).map((a) => a.id));
    });
    onSkyState(syncAmbient);
  },
  hudButtons: [
    {
      id: "mute",
      label: "🔇",
      title: "Toggle sound",
      text: "Sound",
      onClick: () => {
        muted = !muted;
        writeMuted(muted);
        ensureAudio();
        if (audioCtx?.state === "suspended") void audioCtx.resume();
        syncAmbient();
        updateMuteButton();
      },
    },
  ],
};

// ---- round 5 E: focus mode's soft chime (silent while muted, like every other cue) ----
export function playFocusChime(): void {
  playChime();
}

export function soundOn(): boolean {
  return !muted;
}

/** True for a brief moment after a game cue (courier pickup/deliver/approve/deny) fires. */
export function cueDucking(): boolean {
  return performance.now() < cueDuckUntil;
}
