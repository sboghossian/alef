// "voice" feature: mic + "Hey Alef" wake word ("Hey Jev" still works as a spoken alias),
// VAD pause detection, barge-in, and Alef talking back — all local:
//   hearing: the mic is recorded (MediaRecorder) until the VAD hears you stop, then the clip is
//            transcribed on this Mac by whisper.cpp (POST /api/voice/transcribe). Works in any
//            browser with a mic, Safari and the VS Code webview included; nothing goes to Google.
//   brain:   anything that isn't a quick local command goes to Alef (voice-brain.ts → the owner's
//            own `claude` CLI on Haiku) and the reply is spoken sentence by sentence.
//   voice:   Piper (British male, local) via the server; the browser voice is only a fallback.
// The wake word still uses the browser's SpeechRecognition where it exists (Chrome); elsewhere
// it's click-to-talk / hold Space. All decision logic (VAD hangover, wake-word matching,
// utterance routing, the yes/no confirmation) lives in the pure, unit-tested ./voice-logic.ts —
// this file is only the impure glue to the mic, MediaRecorder, WebAudio and the moon. Headless
// Chrome has no mic, so this file is verified with a debug param instead: see `?voice=` in mount().

import type { VadPreset } from "../../../shared/features/voice";
import { expandSurface, safeLocalStorage } from "../ui/kit";
import { VAD_PRESETS } from "../../../shared/features/voice";
import type { MoonVisual } from "../scene/moon";
import { speechCtor, type SpeechRecognitionLike, type SpeechResultEvent } from "../ui/dispatch";
import { log } from "../log";
import type { ClientContext, ClientFeature, HudButton } from "./registry";
import type { VoiceTranscribeResult } from "../../../shared/features/voice-brain";
import { abortAlefTurn, answerPendingConfirm, askAlef, hasPendingConfirm, type AlefTurnHooks, type SpeechOut } from "./voice-brain";
import { advanceVad, heardOverReadBack, initialVadState, isStopWord, matchWakeWord, routeUtterance, stripWakeWord, VAD_SILENCE_THRESHOLD, voiceCityKeys, type VadState } from "./voice-logic";

const WAKE_KEY = "agent-world:voice:wake-word";
const PRESET_KEY = "agent-world:voice:vad-preset";
const SPEAKER_KEY = "agent-world:voice:speaker";
const PRESET_ORDER: VadPreset[] = ["snappy", "normal", "patient"];

function loadPreset(): VadPreset {
  const raw = localStorage.getItem(PRESET_KEY);
  return raw === "snappy" || raw === "normal" || raw === "patient" ? raw : "normal";
}

function moonApi(ctx: ClientContext): MoonVisual | null {
  const obj = ctx.scene.getObjectByName("jev-moon");
  const api = (obj?.userData as { moon?: MoonVisual } | undefined)?.moon;
  return api ?? null;
}

function fillDispatchBar(prompt: string, cityDisplayName: string | null, cityIdByName: ReadonlyMap<string, string>, ctx: ClientContext): void {
  const root = document.getElementById("dispatch");
  const text = document.getElementById("dispatch-text");
  const citySelect = document.getElementById("dispatch-city");
  if (!root || !(text instanceof HTMLTextAreaElement) || !(citySelect instanceof HTMLSelectElement)) return;
  expandSurface("dispatch");
  if (cityDisplayName) {
    const id = cityIdByName.get(cityDisplayName);
    if (id && [...citySelect.options].some((o) => o.value === id)) citySelect.value = id;
  }
  text.value = prompt;
  text.dispatchEvent(new Event("input", { bubbles: true })); // dispatch.ts's own autosize listener
  text.focus();
  ctx.toast(`Ready to dispatch to ${citySelect.options[citySelect.selectedIndex]?.text ?? "…"} — press Enter to send.`);
}

// ---------- module state (one voice feature instance per page) ----------

let audioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let micAnalyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
let recordChunks: Blob[] = [];
let recordStartedMs = 0;
let transcribing = false;
let wakeRecog: SpeechRecognitionLike | null = null;
let listening = false;
let wakeWordOn = false;
let preset: VadPreset = "normal";
let vadState: VadState = initialVadState();
let ttsAvailable = false;
let ttsEngine: string | null = null;
let speaking = false;
let speakingSource: AudioBufferSourceNode | null = null;
let speakingAnalyser: AnalyserNode | null = null;
let speakingViaBrowser = false;

function rms(analyser: AnalyserNode): number {
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = ((buf[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

async function ensureMic(): Promise<boolean> {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!micAnalyser) {
      const src = audioCtx.createMediaStreamSource(micStream);
      micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 512;
      src.connect(micAnalyser);
    }
    return true;
  } catch (err) {
    log.warn("voice", "microphone unavailable", err);
    return false;
  }
}

function stopSpeaking(ctx: ClientContext, keepPlan = false): void {
  speechGen++; // every queued / in-flight item of the old generation is dropped
  for (const item of speechQueue.splice(0)) item.done();
  abortAlefTurn(keepPlan); // barge-in also stops the brain mid-reply (and a plan between steps)
  if (speakingSource) {
    try {
      speakingSource.stop();
    } catch {
      /* already stopped */
    }
    speakingSource = null;
  }
  speakingAnalyser = null;
  speakingViaBrowser = false;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  const wasSpeaking = speaking;
  speaking = false;
  notifyState();
  const moon = moonApi(ctx);
  moon?.setVoiceState("idle");
  moon?.setAmplitude(0);
  if (wasSpeaking) log.info("voice", "barge-in: stopped speaking");
}

/** Plays audio bytes through an analyser (so the moon/orb mouth moves). Resolves when done. */
async function playAudioBytes(bytes: ArrayBuffer, gen: number): Promise<boolean> {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => undefined);
  const buf = await audioCtx.decodeAudioData(bytes);
  if (gen !== speechGen) return true; // barged in while decoding
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(audioCtx.destination);
  const node = audioCtx.createBufferSource();
  node.buffer = buf;
  node.connect(analyser);
  speakingAnalyser = analyser;
  speakingSource = node;
  await new Promise<void>((resolve) => {
    node.onended = () => resolve();
    node.start();
  });
  return true;
}

/** Server voice: a ready sentence (GET audioUrl, Piper) or POST /api/tts (Piper, or ElevenLabs). */
async function speakViaServer(text: string, audioUrl: string | null, gen: number): Promise<boolean> {
  try {
    const res = audioUrl
      ? await fetch(audioUrl)
      : await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("audio")) return false;
    const bytes = await res.arrayBuffer();
    if (gen !== speechGen) return true;
    return await playAudioBytes(bytes, gen);
  } catch (err) {
    log.warn("voice", "server voice playback failed, falling back to browser voice", err);
    return false;
  }
}

function speakViaBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }
    speakingViaBrowser = true;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    const voice = getSpeakingVoice();
    if (voice.startsWith("browser:")) {
      const name = voice.slice("browser:".length);
      const v = window.speechSynthesis.getVoices().find((x) => x.name === name);
      if (v) u.voice = v;
    }
    u.onend = () => {
      speakingViaBrowser = false;
      resolve();
    };
    u.onerror = () => {
      speakingViaBrowser = false;
      resolve();
    };
    window.speechSynthesis.speak(u);
  });
}

// ---------- the speech queue: sentences play one after another, in order ----------

interface SpeechItem {
  text: string;
  audioUrl: string | null;
  done: () => void;
}
const speechQueue: SpeechItem[] = [];
let speechGen = 0;
let queueGen = -1; // the generation whose loop is running (-1: none)

async function playItem(item: SpeechItem, gen: number): Promise<void> {
  const voice = getSpeakingVoice();
  const wantServer = voice === "auto" || voice === "elevenlabs" || voice === "piper";
  const played = wantServer && (item.audioUrl !== null || ttsAvailable) && (await speakViaServer(item.text, item.audioUrl, gen));
  if (!played && gen === speechGen) await speakViaBrowser(item.text);
}

async function runSpeechQueue(ctx: ClientContext): Promise<void> {
  const gen = speechGen;
  queueGen = gen;
  const moon = moonApi(ctx);
  speaking = true;
  notifyState();
  moon?.setVoiceState("speaking");
  try {
    while (gen === speechGen && speechQueue.length) {
      const item = speechQueue.shift();
      if (!item) break;
      try {
        await playItem(item, gen);
      } finally {
        item.done();
      }
    }
  } finally {
    if (queueGen === gen) queueGen = -1;
    if (gen === speechGen) {
      speakingSource = null;
      speakingAnalyser = null;
      speakingViaBrowser = false;
      speaking = false;
      notifyState();
      moon?.setVoiceState("idle");
      moon?.setAmplitude(0);
    }
  }
}

/** Queues one sentence; resolves when it has been spoken (or dropped by a barge-in). */
function say(text: string, audioUrl: string | null, ctx: ClientContext): Promise<void> {
  const clean = text.trim();
  if (!clean) return Promise.resolve();
  return new Promise<void>((resolve) => {
    speechQueue.push({ text: clean, audioUrl, done: resolve });
    if (queueGen !== speechGen) void runSpeechQueue(ctx);
  });
}

async function speak(text: string, ctx: ClientContext): Promise<void> {
  await say(text, null, ctx);
}

function speechOut(ctx: ClientContext): SpeechOut {
  return { say: (text, audioUrl) => void say(text, audioUrl, ctx) };
}

function cityIdByDisplayName(ctx: ClientContext): Map<string, string> {
  return voiceCityKeys(ctx.store.islands.values());
}

// ---------- reuse surface for the 🎙️ Voice view (client/src/views/voice.ts) ----------
// The view owns routing while it is mounted (setUtteranceHandler) and drives the VAD from
// its own animation loop (voiceFrame), because the planet frame loop is paused off-planet.

export type VoiceUiState = "idle" | "listening" | "speaking";
let utteranceHandler: ((text: string) => void) | null = null;
let interimHandler: ((text: string) => void) | null = null;
const stateListeners = new Set<(s: VoiceUiState) => void>();
/** "auto" = the server voice (Piper, local; ElevenLabs only if configured), else the browser;
 *  "browser" = default browser voice; "browser:<name>" = that speechSynthesis voice. */
let speakingVoice: string | null = null; // read lazily: this module also loads in node tests

function notifyState(): void {
  const s: VoiceUiState = listening ? "listening" : speaking ? "speaking" : "idle";
  for (const fn of stateListeners) fn(s);
}

/** While set, every finished utterance (mic, wake word) goes here instead of the default routing
 *  (dispatch bar / Alef's brain). A pending "Shall I…?" still gets first look at it. */
export function setUtteranceHandler(fn: ((text: string) => void) | null, onInterim: ((text: string) => void) | null = null): void {
  utteranceHandler = fn;
  interimHandler = onInterim;
}
export function onVoiceState(fn: (s: VoiceUiState) => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
export function isListening(): boolean {
  return listening;
}
export function ttsReady(): boolean {
  return ttsAvailable;
}
/** "piper" | "elevenlabs" | null, as the server reports it. */
export function ttsEngineName(): string | null {
  return ttsEngine;
}
export function vadPreset(): VadPreset {
  return preset;
}
export function setVadPreset(p: VadPreset): void {
  preset = p;
  localStorage.setItem(PRESET_KEY, p);
}
export function wakeWordEnabled(): boolean {
  return wakeWordOn;
}
export function setWakeWord(on: boolean, ctx: ClientContext): void {
  if (on === wakeWordOn) return;
  wakeWordOn = on;
  localStorage.setItem(WAKE_KEY, on ? "1" : "0");
  if (on) startWakeWord(ctx);
  else stopWakeWord();
  updateHudButtons();
}
export function getSpeakingVoice(): string {
  speakingVoice ??= safeLocalStorage()?.getItem(SPEAKER_KEY) ?? "auto";
  return speakingVoice;
}
export function setSpeakingVoice(v: string): void {
  speakingVoice = v;
  safeLocalStorage()?.setItem(SPEAKER_KEY, v);
}
/** 0..1: the mic while listening, the voice while speaking, else 0. */
export function voiceLevel(nowMs: number): number {
  if (listening && micAnalyser) return Math.min(1, rms(micAnalyser) * 3.2);
  if (speaking && speakingAnalyser) return Math.min(1, rms(speakingAnalyser) * 3.0);
  if (speaking && speakingViaBrowser) return 0.35 + Math.abs(Math.sin(nowMs / 1000 * 6)) * 0.35;
  return 0;
}
/** One tick of the VAD + barge-in, for callers whose frames aren't planet frames. */
export function voiceFrame(ctx: ClientContext, nowMs: number): void {
  if (listening && micAnalyser) {
    const step = advanceVad(vadState, nowMs, rms(micAnalyser), preset);
    vadState = step.state;
    if (step.finalize || recordingTooLong(performance.now())) finalizeListening(ctx);
  }
  if (speaking && !listening && micAnalyser && rms(micAnalyser) > VAD_SILENCE_THRESHOLD * 2.5) stopSpeaking(ctx);
}
export { fillDispatchBar, cityIdByDisplayName, speak, stopSpeaking, startListening, stopListening, isTranscribing, offerToPendingConfirm, askAlefAloud };

/** Offers an utterance to Alef's pending "Shall I…?" first. True = it was the yes/no answer.
 *  The Voice view calls this for typed text too (spoken text comes through handleUtterance). */
function offerToPendingConfirm(text: string, ctx: ClientContext): boolean {
  return answerPendingConfirm(text, ctx, speechOut(ctx));
}

/** Asks Alef (the conversational brain) and speaks the reply as it streams in. */
function askAlefAloud(text: string, ctx: ClientContext, hooks: AlefTurnHooks = {}): Promise<void> {
  return askAlef(text, ctx, speechOut(ctx), hooks);
}

function handleUtterance(raw: string, ctx: ClientContext): void {
  const text = stripWakeWord(raw) || raw.trim();
  if (!text) return;
  if (utteranceHandler) {
    utteranceHandler(text); // the Voice view offers it to a pending "Shall I…?" itself
    return;
  }
  if (offerToPendingConfirm(text, ctx)) return;
  if (isStopWord(text)) {
    stopSpeaking(ctx); // "stop" / "wa2ef": hush, and any plan stops before its next step
    return;
  }
  const cityMap = cityIdByDisplayName(ctx);
  const route = routeUtterance(text, [...cityMap.keys()]);
  if (route.kind === "dispatch") {
    fillDispatchBar(route.prompt, route.city, cityMap, ctx);
    moonApi(ctx)?.setVoiceState("idle");
    return;
  }
  // Off the Voice view there's no transcript: Alef's words are spoken and shown as one toast.
  moonApi(ctx)?.setVoiceState("thinking");
  const said: string[] = [];
  void askAlefAloud(route.question, ctx, {
    onSentence: (s) => said.push(s),
    onDone: () => {
      if (said.length) ctx.toast(`Alef: ${said.join(" ")}`);
      if (!speaking) moonApi(ctx)?.setVoiceState("idle");
    },
  });
}

function pickRecorderMime(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  for (const t of types) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on odd strings in old engines */
    }
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = typeof r.result === "string" ? r.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("could not read the recording"));
    r.readAsDataURL(blob);
  });
}

/** Local whisper.cpp on the server. Resolves "" when nothing was understood. */
async function transcribeBlob(blob: Blob, ctx: ClientContext): Promise<string> {
  const audioBase64 = await blobToBase64(blob);
  const r = await ctx.api.postJson<VoiceTranscribeResult>("/api/voice/transcribe", { audioBase64 }, (error) => ({ ok: false, error }), 60_000);
  if (!r.ok) {
    log.warn("voice", "transcription failed", r.error);
    ctx.toast(`I couldn't transcribe that: ${r.error}`, "error");
    return "";
  }
  log.info("voice", `whisper ${r.model}: ${r.ms} ms`);
  return r.text;
}

function finalizeListening(ctx: ClientContext): void {
  const heardSpeech = vadState.speechSeen;
  listening = false;
  vadState = initialVadState();
  const rec = recorder;
  recorder = null;
  const moon = moonApi(ctx);
  moon?.setAmplitude(0);
  if (!rec || rec.state === "inactive" || !heardSpeech) {
    // Nothing (audible) was said: don't send silence to whisper.
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
    }
    recordChunks = [];
    notifyState();
    moon?.setVoiceState("idle");
    return;
  }
  transcribing = true;
  notifyState();
  moon?.setVoiceState("thinking");
  rec.onstop = () => {
    const blob = new Blob(recordChunks, { type: rec.mimeType || "audio/webm" });
    recordChunks = [];
    void transcribeBlob(blob, ctx)
      .catch((err: unknown) => {
        log.warn("voice", "transcription failed", err);
        return "";
      })
      .then((text) => {
        transcribing = false;
        notifyState();
        if (text.trim()) handleUtterance(text, ctx);
        else {
          moon?.setVoiceState("idle");
          if (utteranceHandler) interimHandler?.("");
        }
      });
  };
  rec.stop();
}

async function startListening(ctx: ClientContext): Promise<void> {
  if (listening || transcribing) return;
  if (typeof MediaRecorder === "undefined") {
    ctx.toast("This browser can't record audio (no MediaRecorder), so Alef can't hear you here.", "error");
    return;
  }
  const ok = await ensureMic();
  if (!ok || !micStream) {
    ctx.toast("Microphone unavailable — check your browser's mic permission.", "error");
    return;
  }
  const mime = pickRecorderMime();
  let rec: MediaRecorder;
  try {
    rec = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
  } catch (err) {
    log.warn("voice", "recorder start failed", err);
    ctx.toast("Couldn't start recording.", "error");
    return;
  }
  recordChunks = [];
  rec.ondataavailable = (ev: BlobEvent) => {
    if (ev.data.size > 0) recordChunks.push(ev.data);
  };
  recorder = rec;
  vadState = initialVadState();
  listening = true;
  recordStartedMs = performance.now();
  notifyState();
  moonApi(ctx)?.setVoiceState("listening");
  rec.start(250);
}

/** True while a finished recording is being transcribed on the server. */
function isTranscribing(): boolean {
  return transcribing;
}

/** The whisper route caps a clip at 60 s: stop recording a little before that. */
function recordingTooLong(nowMs: number): boolean {
  return listening && nowMs - recordStartedMs > 58_000;
}

function stopListening(ctx: ClientContext): void {
  if (!listening) return;
  finalizeListening(ctx);
}

function startWakeWord(ctx: ClientContext, quiet = false): void {
  const Ctor = speechCtor(window);
  if (!Ctor) {
    // Safari / the VS Code webview: no always-on local wake detection in v1 — click to talk.
    if (!quiet) ctx.toast('The "Hey Alef" wake word needs Chrome\'s speech recognition. Here, click 🎤 to talk (or hold Space in the Voice view).');
    return;
  }
  if (!wakeRecog) wakeRecog = new Ctor();
  wakeRecog.lang = "en-US";
  wakeRecog.interimResults = true;
  wakeRecog.continuous = true;
  let lastSeen = "";
  wakeRecog.onresult = (ev: SpeechResultEvent) => {
    let full = "";
    for (let i = 0; i < ev.results.length; i++) full += ev.results[i]?.[0]?.transcript ?? "";
    const chunk = full.slice(lastSeen.length);
    lastSeen = full;
    const match = matchWakeWord(chunk);
    if (!match) return;
    const overAlef = speaking;
    if (speaking) stopSpeaking(ctx);
    // Over Alef's own voice this may be his read-back coming back through the mic: a yes there
    // never answers his "Shall I…?". He hushes and the mic opens for a fresh answer instead.
    if (match.rest && !(overAlef && hasPendingConfirm() && heardOverReadBack(match.rest))) handleUtterance(match.rest, ctx);
    else void startListening(ctx);
  };
  wakeRecog.onerror = (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") log.warn("voice", "wake-word recognition error", ev.error);
  };
  wakeRecog.onend = () => {
    if (wakeWordOn) {
      setTimeout(() => {
        try {
          wakeRecog?.start();
        } catch {
          /* will retry on the next onend */
        }
      }, 300);
    }
  };
  try {
    wakeRecog.start();
  } catch (err) {
    log.warn("voice", "wake-word start failed", err);
  }
}

function stopWakeWord(): void {
  if (wakeRecog) {
    try {
      wakeRecog.stop();
    } catch {
      /* already stopped */
    }
  }
}

function updateHudButtons(): void {
  const mic = document.getElementById("hud-f-voice-mic");
  mic?.classList.toggle("active", listening);
  const wake = document.getElementById("hud-f-voice-wake");
  wake?.classList.toggle("active", wakeWordOn);
}

function togglePreset(ctx: ClientContext): void {
  const i = PRESET_ORDER.indexOf(preset);
  preset = PRESET_ORDER[(i + 1) % PRESET_ORDER.length] ?? "normal";
  localStorage.setItem(PRESET_KEY, preset);
  ctx.toast(`Voice pause sensitivity: ${preset} (${VAD_PRESETS[preset]}ms).`);
}

const hudButtons: HudButton[] = [
  {
    id: "mic",
    label: "\u{1F3A4}", // 🎤
    title: "Talk to Jev (click to start/stop)",
    text: "Talk to Jev",
    onClick(ctx) {
      if (listening) stopListening(ctx);
      else void startListening(ctx);
      updateHudButtons();
    },
  },
  {
    id: "wake",
    label: "\u{1F442}", // 👂
    title: 'Wake word: say "Hey Alef" (off by default)',
    text: "Wake word “Hey Alef”",
    onClick(ctx) {
      wakeWordOn = !wakeWordOn;
      localStorage.setItem(WAKE_KEY, wakeWordOn ? "1" : "0");
      if (wakeWordOn) startWakeWord(ctx);
      else stopWakeWord();
      updateHudButtons();
      ctx.toast(wakeWordOn ? 'Wake word on — say "Hey Alef".' : "Wake word off.");
    },
  },
];

/** True while Jev is actually talking back (ElevenLabs or the browser voice). Read-only —
 *  lets other features (claude-fm) duck their own audio without this one knowing they exist. */
export function jevSpeaking(): boolean {
  return speaking;
}

export const voiceFeature: ClientFeature = {
  id: "voice",
  hudButtons,
  mount(ctx) {
    preset = loadPreset();
    wakeWordOn = localStorage.getItem(WAKE_KEY) === "1";
    updateHudButtons();
    if (wakeWordOn) startWakeWord(ctx, true);

    // Headless Chrome has no mic: ?voice=listening|thinking|speaking drives the moon
    // straight to that state for screenshotting (see tasks/round4-B-moon-*.png).
    const debugState = new URLSearchParams(window.location.search).get("voice");
    if (debugState === "idle" || debugState === "listening" || debugState === "thinking" || debugState === "speaking") {
      const moon = moonApi(ctx);
      moon?.setVoiceState(debugState);
      if (debugState !== "idle" && debugState !== "thinking") moon?.setAmplitude(0.65);
    }
  },
  onSnapshot(world) {
    ttsAvailable = world.extras?.["tts.available"] === true;
    const engine = world.extras?.["tts.engine"];
    ttsEngine = typeof engine === "string" ? engine : null;
  },
  onFrame(_dt, ctx) {
    const moon = moonApi(ctx);
    if (listening && micAnalyser) {
      const level = rms(micAnalyser);
      moon?.setAmplitude(Math.min(1, level * 3.2));
      const step = advanceVad(vadState, ctx.elapsed() * 1000, level, preset);
      vadState = step.state;
      if (step.finalize || recordingTooLong(performance.now())) finalizeListening(ctx);
    } else if (speaking) {
      if (speakingAnalyser) moon?.setAmplitude(Math.min(1, rms(speakingAnalyser) * 3.0));
      else if (speakingViaBrowser) moon?.setAmplitude(0.35 + Math.abs(Math.sin(ctx.elapsed() * 6)) * 0.35);
    }
    // Barge-in by speaking over Jev (only once the mic has already been granted —
    // never triggers a permission prompt on its own).
    if (speaking && !listening && micAnalyser) {
      if (rms(micAnalyser) > VAD_SILENCE_THRESHOLD * 2.5) stopSpeaking(ctx);
    }
  },
  onEscape(ctx) {
    if (speaking) {
      stopSpeaking(ctx);
      return true;
    }
    return false;
  },
  paletteCommands(ctx) {
    return [
      {
        id: "talk",
        title: listening ? "Stop talking to Jev" : "Talk to Jev",
        keywords: ["voice", "mic", "listen"],
        kind: "voice",
        run: () => {
          if (listening) stopListening(ctx);
          else void startListening(ctx);
          updateHudButtons();
        },
      },
      {
        id: "wake-toggle",
        title: wakeWordOn ? 'Turn off wake word ("Hey Alef")' : 'Turn on wake word ("Hey Alef")',
        keywords: ["wake", "hey alef", "hey jev"],
        kind: "voice",
        run: () => {
          wakeWordOn = !wakeWordOn;
          localStorage.setItem(WAKE_KEY, wakeWordOn ? "1" : "0");
          if (wakeWordOn) startWakeWord(ctx);
          else stopWakeWord();
          updateHudButtons();
        },
      },
      {
        id: "vad-preset",
        title: `Voice pause sensitivity: ${preset}`,
        keywords: ["vad", "pause", "snappy", "patient"],
        kind: "voice",
        run: () => togglePreset(ctx),
      },
    ];
  },
};
