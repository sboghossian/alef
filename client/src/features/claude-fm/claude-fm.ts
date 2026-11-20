// "claude-fm" feature: plays the official "Claude FM" YouTube video as a background audio
// track. It lives ONLY in the status bar: click the chip to play / pause, the ▴ next to it opens
// a small popover (volume, mute, video, "open on YouTube"). Client-only — no server feature, nothing crosses the
// wire. The YouTube IFrame API is loaded lazily, only from the play button's own click
// handler, so there is no network request and no iframe before the user asks for one.
//
// Split like voice.ts: this file is the impure glue (DOM, three.js, the YouTube player);
// ./claude-fm-logic.ts holds the pure, unit-tested parts (persisted state, the duck-volume
// math, the `M` shortcut's typing/overlay guard); ./youtube.ts is the IFrame API wrapper.

import * as THREE from "three";
import "./claude-fm.css";
import { log } from "../../log";
import { chromeMode, onChromeChange, prefersReducedMotion, safeLocalStorage, type FlagStore } from "../../ui/kit";
import type { ClientContext, ClientFeature } from "../registry";
import { cueDucking } from "../sound";
import { jevSpeaking } from "../voice";
import { DEFAULT_FM_VOLUME, effectiveVolume, isFmToggleKey, loadFmState, popoverBottomOffset, saveFmMuted, saveFmVolume, saveFmWasPlaying, type FmState } from "./claude-fm-logic";
import { createPlayer, loadIframeApi, YT_STATE, type YtPlayer } from "./youtube";

const VIDEO_ID = "tRsQsTMvPNg";
const YT_WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const NOTE_LIFE = 2.4;
const NOTE_INTERVAL_MIN = 0.9;
const NOTE_INTERVAL_MAX = 1.6;
const NOTE_CAP = 8;

interface Note {
  el: HTMLElement;
  born: number;
  pos: THREE.Vector3;
}

// A debug/test hook only (not part of the feature's real surface): lets Playwright verify
// "no request before the first play" and "reaches PLAYING after a click" via getPlayerState(),
// the same way this app already drives screenshot states through query params elsewhere.
declare global {
  interface Window {
    __claudeFm?: { getPlayerState(): number; isPlaying(): boolean };
  }
}

let store: FlagStore | null = null;
let state: FmState = { volume: DEFAULT_FM_VOLUME, muted: false, wasPlaying: false };

let player: YtPlayer | null = null;
let playerPromise: Promise<YtPlayer | null> | null = null;
let playing = false;
let pendingPlay = false;
let offline = false;
let showingVideo = false;
let lastAppliedVolume = -1;

let cardEl: HTMLElement | null = null;
let chipBtn: HTMLButtonElement | null = null;
let popBtn: HTMLButtonElement | null = null;
let popOpen = false;
let playerInner: HTMLElement | null = null;
let playerSlot: HTMLElement | null = null;
let playBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let muteBtn: HTMLButtonElement | null = null;
let volumeInput: HTMLInputElement | null = null;
let videoToggleBtn: HTMLButtonElement | null = null;
let zenHintEl: HTMLElement | null = null;

let noteLayer: HTMLElement | null = null;
const notes: Note[] = [];
let noteTimer = 0;

function moonObject(ctx: ClientContext): THREE.Object3D | null {
  return ctx.scene.getObjectByName("jev-moon") ?? null;
}

const noteProj = new THREE.Vector3();
const noteToCam = new THREE.Vector3();
/** Same world→screen technique as ui/overlays.ts's onScreen(), duplicated locally (small,
 *  and this feature is meant to stay self-contained rather than pull in a shared helper). */
function projectWorldPoint(pos: THREE.Vector3, camera: THREE.Camera): { x: number; y: number } | null {
  noteToCam.subVectors(camera.position, pos).normalize();
  if (noteProj.copy(pos).normalize().dot(noteToCam) < -0.2) return null;
  noteProj.copy(pos).project(camera);
  if (noteProj.z > 1 || Math.abs(noteProj.x) > 1.05 || Math.abs(noteProj.y) > 1.05) return null;
  return { x: (noteProj.x * 0.5 + 0.5) * window.innerWidth, y: (-noteProj.y * 0.5 + 0.5) * window.innerHeight };
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}

function overlayOpen(): boolean {
  if (document.body.classList.contains("in-room")) return true;
  for (const id of ["palette", "board"]) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return true;
  }
  return [...document.querySelectorAll<HTMLElement>(".ui-backdrop")].some((el) => !el.hidden);
}

function updateStatusText(): void {
  if (!statusEl) return;
  statusEl.classList.toggle("fm-offline", offline);
  if (offline) {
    statusEl.textContent = "Claude FM is offline";
  } else if (playing) {
    statusEl.textContent = "";
  } else if (pendingPlay) {
    statusEl.textContent = "Loading…";
  } else {
    statusEl.textContent = player || state.wasPlaying ? "Tap play to resume" : "Tap play to listen";
  }
}

function updatePlayButton(): void {
  if (chipBtn) {
    chipBtn.innerHTML = `<span aria-hidden="true">${pendingPlay ? "…" : playing ? "⏸" : "▶"}</span><span class="fm-sb-word"> Claude FM</span>`;
    const label = offline ? "Claude FM is offline" : playing ? "Pause Claude FM (M)" : "Play Claude FM (M)";
    chipBtn.title = label;
    chipBtn.setAttribute("aria-label", label);
    chipBtn.setAttribute("aria-pressed", String(playing));
  }
  if (!playBtn) return;
  playBtn.disabled = offline;
  playBtn.textContent = playing ? "⏸" : "▶";
  const label = playing ? "Pause Claude FM" : "Play Claude FM";
  playBtn.title = `${label} (M)`;
  playBtn.setAttribute("aria-label", label);
}

function updateMuteButton(): void {
  if (!muteBtn) return;
  muteBtn.textContent = state.muted ? "🔇" : "🔊";
  muteBtn.title = state.muted ? "Unmute" : "Mute";
  muteBtn.setAttribute("aria-pressed", String(state.muted));
}

function syncZenHint(): void {
  if (!zenHintEl) return;
  const show = playing && chromeMode() === "zen";
  if (!show) {
    zenHintEl.hidden = true;
    zenHintEl.classList.remove("fm-zen-fade");
    return;
  }
  zenHintEl.hidden = false;
  zenHintEl.classList.remove("fm-zen-fade");
  void zenHintEl.offsetWidth; // restart the fade-out animation
  zenHintEl.classList.add("fm-zen-fade");
}

function updatePlayingVisuals(): void {
  cardEl?.classList.toggle("fm-playing", playing);
  chipBtn?.parentElement?.classList.toggle("fm-sb-playing", playing);
  syncZenHint();
}

function setPlaying(next: boolean): void {
  if (playing === next) return;
  playing = next;
  saveFmWasPlaying(store, next);
  updatePlayButton();
  updateStatusText();
  updatePlayingVisuals();
}

/** Applies the user's volume/mute, ducked 30% while Jev is speaking or a sound cue just
 *  fired. Polled every frame (cheap: two booleans + a comparison) because neither voice.ts
 *  nor sound.ts emits an event for these — only actually calls into the player when the
 *  target changes. */
function applyVolumeToPlayer(): void {
  if (!player) return;
  const ducking = jevSpeaking() || cueDucking();
  const vol = effectiveVolume(state, ducking);
  if (vol === lastAppliedVolume) return;
  lastAppliedVolume = vol;
  if (vol <= 0) player.mute();
  else {
    player.unMute();
    player.setVolume(vol);
  }
}

function setOffline(v: boolean): void {
  offline = v;
  if (v) pendingPlay = false;
  updateStatusText();
  updatePlayButton();
}

function onPlayerStateChange(data: number): void {
  pendingPlay = false;
  if (data === YT_STATE.PLAYING) setPlaying(true);
  else if (data === YT_STATE.PAUSED || data === YT_STATE.ENDED) setPlaying(false);
  updateStatusText();
}

/** Lazily loads the IFrame API and builds the player — only ever called from a play click,
 *  so there is no youtube.com request until then. Cached while in flight; the cache is
 *  cleared on failure so a later click retries the network instead of failing forever. */
function ensurePlayer(): Promise<YtPlayer | null> {
  if (player) return Promise.resolve(player);
  playerPromise ??= loadIframeApi()
    .then(
      () =>
        new Promise<YtPlayer | null>((resolve) => {
          if (!playerInner) {
            resolve(null);
            return;
          }
          const created = createPlayer(playerInner, VIDEO_ID, {
            onReady: (p) => {
              player = p;
              resolve(p);
            },
            onStateChange: onPlayerStateChange,
            onError: () => {
              log.warn("claude-fm", "YouTube reported a playback error");
              setOffline(true);
            },
          });
          if (!created) resolve(null);
        }),
    )
    .catch((err: unknown) => {
      log.warn("claude-fm", "Claude FM couldn't reach YouTube", err);
      setOffline(true);
      return null;
    })
    .finally(() => {
      playerPromise = null;
    });
  return playerPromise;
}

function togglePlay(): void {
  if (pendingPlay) return;
  if (player) {
    if (playing) player.pauseVideo();
    else player.playVideo();
    return;
  }
  offline = false;
  pendingPlay = true;
  updateStatusText();
  updatePlayButton();
  void ensurePlayer().then((p) => {
    if (!p) {
      pendingPlay = false;
      updateStatusText();
      updatePlayButton();
      return;
    }
    applyVolumeToPlayer();
    p.playVideo();
  });
}

function spawnNote(ctx: ClientContext): void {
  if (!noteLayer || notes.length >= NOTE_CAP) return;
  const moon = moonObject(ctx);
  if (!moon) return;
  const anchor = document.createElement("span");
  anchor.className = "fm-note-anchor";
  const glyph = document.createElement("span");
  glyph.className = "fm-note";
  glyph.textContent = Math.random() < 0.5 ? "♪" : "♫";
  glyph.style.setProperty("--fm-drift", `${Math.round((Math.random() - 0.5) * 30)}px`);
  anchor.appendChild(glyph);
  noteLayer.appendChild(anchor);
  notes.push({ el: anchor, born: ctx.elapsed(), pos: moon.position.clone() });
}

function updateNotes(ctx: ClientContext): void {
  const elapsed = ctx.elapsed();
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (!n) continue;
    if (elapsed - n.born > NOTE_LIFE) {
      n.el.remove();
      notes.splice(i, 1);
      continue;
    }
    const s = projectWorldPoint(n.pos, ctx.camera);
    n.el.style.display = s ? "" : "none";
    if (s) n.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
  }
}

/** The status control: ▶ Claude FM (play / pause) + ▴ (the popover). It sits just before the
 *  status chips, which live in the drawer's tray (shell/statusbar.ts); M still plays from anywhere. */
function buildStatusControl(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "fm-sb";
  wrap.innerHTML = `<button type="button" class="sb-item sb-btn fm-sb-play" id="hud-f-claude-fm-chip"></button><button type="button" class="sb-item sb-btn fm-sb-more" aria-haspopup="dialog" aria-expanded="false" aria-controls="fm-pop" aria-label="Claude FM options" title="Claude FM: volume, video, YouTube"><span aria-hidden="true">▴</span></button>`;
  const chips = document.getElementById("sb-chips");
  if (chips?.parentElement) chips.parentElement.insertBefore(wrap, chips);
  else document.getElementById("statusbar")?.appendChild(wrap);
  return wrap;
}

/** A CSS length var (e.g. "34px") set on body.alef by shell.ts, or 0 if it's missing/unparsable. */
function shellVarPx(name: string): number {
  return Number.parseFloat(getComputedStyle(document.body).getPropertyValue(name)) || 0;
}

function placePopover(): void {
  if (!cardEl || !popBtn) return;
  const r = (popBtn.parentElement ?? popBtn).getBoundingClientRect();
  const w = cardEl.offsetWidth || 260;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  cardEl.style.left = `${Math.round(left)}px`;
  const shellClear = shellVarPx("--alef-bottom") + shellVarPx("--alef-prompt");
  cardEl.style.bottom = `${Math.round(popoverBottomOffset(shellClear, window.innerHeight - r.top))}px`;
}

function setPopover(open: boolean): void {
  popOpen = open;
  if (!cardEl) return;
  if (open) placePopover();
  cardEl.classList.toggle("fm-pop-open", open);
  cardEl.setAttribute("aria-hidden", String(!open));
  cardEl.inert = !open;
  popBtn?.setAttribute("aria-expanded", String(open));
  popBtn?.classList.toggle("on", open);
  if (open) cardEl.querySelector<HTMLElement>(".fm-play")?.focus({ preventScroll: true });
}

function buildCard(): HTMLElement {
  const card = document.createElement("div");
  card.className = "fm-card fm-pop";
  card.id = "fm-pop";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Claude FM");
  card.innerHTML = `
    <div class="fm-head">
      <span class="fm-title">📻 Claude FM</span>
      <button type="button" class="fm-video-toggle" aria-pressed="false" title="Show a small video view">▶ video</button>
      <button type="button" class="fm-close" aria-label="Close" title="Close (Esc)">✕</button>
    </div>
    <div class="fm-player-slot"><div class="fm-player-inner"></div></div>
    <div class="fm-row">
      <button type="button" class="fm-play" title="Play Claude FM (M)" aria-label="Play Claude FM">▶</button>
      <div class="fm-eq" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <span class="fm-status"></span>
    </div>
    <div class="fm-row">
      <button type="button" class="fm-mute" title="Mute" aria-label="Mute" aria-pressed="false">🔊</button>
      <input type="range" class="fm-volume" min="0" max="100" step="1" aria-label="Volume" />
      <a class="fm-yt-link" href="${YT_WATCH_URL}" target="_blank" rel="noopener noreferrer">open on YouTube</a>
    </div>`;
  document.body.appendChild(card);
  return card;
}

export const claudeFmFeature: ClientFeature = {
  id: "claude-fm",
  mount(ctx) {
    store = safeLocalStorage();
    state = loadFmState(store);

    const control = buildStatusControl();
    chipBtn = control.querySelector<HTMLButtonElement>(".fm-sb-play");
    popBtn = control.querySelector<HTMLButtonElement>(".fm-sb-more");
    const card = buildCard();
    cardEl = card;
    setPopover(false);
    playerSlot = card.querySelector<HTMLElement>(".fm-player-slot");
    playerInner = card.querySelector<HTMLElement>(".fm-player-inner");
    playBtn = card.querySelector<HTMLButtonElement>(".fm-play");
    statusEl = card.querySelector<HTMLElement>(".fm-status");
    muteBtn = card.querySelector<HTMLButtonElement>(".fm-mute");
    volumeInput = card.querySelector<HTMLInputElement>(".fm-volume");
    videoToggleBtn = card.querySelector<HTMLButtonElement>(".fm-video-toggle");

    if (volumeInput) volumeInput.value = String(state.volume);
    updateMuteButton();
    updatePlayButton();
    updateStatusText();

    chipBtn?.addEventListener("click", () => togglePlay());
    popBtn?.addEventListener("click", () => setPopover(!popOpen));
    card.querySelector(".fm-close")?.addEventListener("click", () => {
      setPopover(false);
      popBtn?.focus();
    });
    document.addEventListener("pointerdown", (ev) => {
      if (!popOpen || !(ev.target instanceof Node)) return;
      if (card.contains(ev.target) || control.contains(ev.target)) return;
      setPopover(false);
    });
    window.addEventListener("resize", () => {
      if (popOpen) placePopover();
    });

    playBtn?.addEventListener("click", () => togglePlay());
    muteBtn?.addEventListener("click", () => {
      state.muted = !state.muted;
      saveFmMuted(store, state.muted);
      updateMuteButton();
      applyVolumeToPlayer();
    });
    volumeInput?.addEventListener("input", () => {
      state.volume = Number(volumeInput?.value ?? DEFAULT_FM_VOLUME);
      saveFmVolume(store, state.volume);
      applyVolumeToPlayer();
    });
    videoToggleBtn?.addEventListener("click", () => {
      showingVideo = !showingVideo;
      playerSlot?.classList.toggle("fm-show-video", showingVideo);
      videoToggleBtn?.setAttribute("aria-pressed", String(showingVideo));
      if (videoToggleBtn) videoToggleBtn.textContent = showingVideo ? "■ hide" : "▶ video";
    });

    zenHintEl = document.createElement("div");
    zenHintEl.className = "fm-zen-hint";
    zenHintEl.textContent = "♪ Claude FM";
    zenHintEl.hidden = true;
    document.body.appendChild(zenHintEl);
    onChromeChange(() => syncZenHint());

    noteLayer = document.createElement("div");
    noteLayer.id = "fm-notes";
    (document.getElementById("overlays") ?? document.body).appendChild(noteLayer);

    window.addEventListener("keydown", (ev) => {
      if (!isFmToggleKey({ key: ev.key, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, isTyping: isTyping(ev.target), overlayOpen: overlayOpen() })) return;
      ev.preventDefault();
      togglePlay();
    });

    window.__claudeFm = {
      // -99 (not a real YT.PlayerState value) means "no player yet", distinct from -1 (UNSTARTED).
      getPlayerState: () => player?.getPlayerState() ?? -99,
      isPlaying: () => playing,
    };
  },
  onFrame(dt, ctx) {
    applyVolumeToPlayer();
    if (playing && !prefersReducedMotion()) {
      noteTimer -= dt;
      if (noteTimer <= 0) {
        spawnNote(ctx);
        noteTimer = NOTE_INTERVAL_MIN + Math.random() * (NOTE_INTERVAL_MAX - NOTE_INTERVAL_MIN);
      }
    }
    if (notes.length) updateNotes(ctx);
  },
  onEscape() {
    if (!popOpen) return false;
    setPopover(false);
    return true;
  },
  paletteCommands: () => [
    {
      id: "toggle",
      title: playing ? "Pause Claude FM" : "Play Claude FM",
      meta: "music for thinking and building",
      keywords: ["music", "radio", "fm", "youtube", "song"],
      kind: "music",
      run: () => togglePlay(),
    },
    {
      id: "open",
      title: "Claude FM controls (volume, video)",
      keywords: ["music", "radio", "volume", "video"],
      kind: "music",
      run: () => setPopover(true),
    },
  ],
};
