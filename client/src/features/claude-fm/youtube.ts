// Impure glue to the YouTube IFrame Player API. Never imported by anything that gets
// unit-tested (see claude-fm-logic.ts for the pure half). No `@types/youtube` — it's a
// runtime script the page injects, not an npm dependency, so the surface it needs is
// declared locally below.
//
// Nothing here runs until `loadIframeApi()` is called, and ./claude-fm.ts only calls it
// from the play button's own click handler: no script tag, no request, no iframe before
// the user's first press.

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getPlayerState(): number;
  destroy(): void;
}

interface YtPlayerEvent {
  target: YtPlayer;
}
interface YtStateChangeEvent extends YtPlayerEvent {
  data: number;
}
interface YtPlayerOptions {
  host?: string;
  width?: string | number;
  height?: string | number;
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (ev: YtPlayerEvent) => void;
    onStateChange?: (ev: YtStateChangeEvent) => void;
    onError?: (ev: YtPlayerEvent) => void;
  };
}
interface YtNamespace {
  Player: new (el: HTMLElement, opts: YtPlayerOptions) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";
const LOAD_TIMEOUT_MS = 8000;

let apiLoadPromise: Promise<void> | null = null;

/** Injects `iframe_api` and resolves once `window.YT.Player` exists. Rejects (and clears
 *  its cache, so a later retry hits the network again) on a script error or a timeout —
 *  the two ways "offline" shows up here. Cached per page load once it succeeds. */
export function loadIframeApi(): Promise<void> {
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => fail(), LOAD_TIMEOUT_MS);
    const ok = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      apiLoadPromise = null;
      reject(new Error("Claude FM is offline"));
    };
    // YouTube calls this global once the script has loaded and initialized; chain any
    // handler another consumer already installed instead of clobbering it.
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevReady?.();
      ok();
    };
    const script = document.createElement("script");
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => fail();
    document.head.appendChild(script);
  });
  return apiLoadPromise;
}

export interface CreatePlayerHandlers {
  onReady(player: YtPlayer): void;
  onStateChange(state: number): void;
  onError(): void;
}

/** Creates the player inside `el` (a plain div the feature owns). Assumes `loadIframeApi()`
 *  already resolved. The privacy host means no youtube.com cookie until playback starts. */
export function createPlayer(el: HTMLElement, videoId: string, handlers: CreatePlayerHandlers): YtPlayer | null {
  const ns = window.YT;
  if (!ns) return null;
  return new ns.Player(el, {
    host: "https://www.youtube-nocookie.com",
    width: "100%",
    height: "100%",
    videoId,
    playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: (ev) => handlers.onReady(ev.target),
      onStateChange: (ev) => handlers.onStateChange(ev.data),
      onError: () => handlers.onError(),
    },
  });
}
