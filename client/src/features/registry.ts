// Client feature registry. A feature is a module in client/src/features/<id>.ts that
// exports a ClientFeature; client/src/features/index.ts is the only list of enabled
// features. main.ts builds one ClientContext, hands it to ClientFeatureHost, and calls
// the host's hooks from its message handler and frame loop. The host itself never
// touches the DOM (main.ts mounts HUD buttons and panels), so it is unit-testable.
// See docs/FEATURES.md.

import type * as THREE from "three";
import type {
  AskJevRequest,
  AskJevResult,
  DispatchRequest,
  DispatchResult,
  ReactivateResult,
  ServerMessage,
  WorldSnapshot,
} from "../../../shared/types";
import { log } from "../log";
import type { FeedSink } from "../shell/feed-types";
import { describeError } from "../ui/action";
import type { ToastAction } from "../ui/toast";
import type { RightTab } from "../shell/views";
import type { WorldStore } from "../state";

export type FeatureMessage = Extract<ServerMessage, { type: "feature" }>;

export interface PaletteCommand {
  /** Unique within the feature; the host namespaces it as "<featureId>:<id>". */
  id: string;
  title: string;
  meta?: string;
  /** Badge text in the palette row (default "command"). */
  kind?: string;
  /** Extra fuzzy-match terms besides the title. */
  keywords?: string[];
  run(): void;
}

export interface HudButton {
  id: string;
  /** Plain text (rendered with textContent), e.g. an emoji or a short word. The feature may rewrite it. */
  label: string;
  title: string;
  /** Short visible name next to `label` in the More menu (default: `title`). Never icon-only. */
  text?: string;
  /** "menu" (default): a labeled row in the HUD's More menu. "status": a chip in the status bar,
   *  for glanceable readouts whose `label` is already words (weather, low battery). */
  placement?: "menu" | "status";
  /** Start hidden (the `hidden` attribute, so it is out of the accessibility tree too) until the
   *  feature has something to show, e.g. the low-battery chip. */
  hidden?: boolean;
  /** A status chip that only shows when something is wrong: its words ("battery low"). While it
   *  shows, the status bar's "more" button carries a dot and says them, since the chip itself
   *  sits in the drawer. */
  alert?: string;
  onClick(ctx: ClientContext): void;
}

export interface ClientPanel {
  id: string;
  title: string;
  /** Fill `el`; it is shown in the side panel under `title`. Called on every openPanel(id). */
  render(el: HTMLElement, ctx: ClientContext): void;
}

export interface ClientApi {
  /** GET JSON; resolves null on any network/HTTP/parse failure (never throws). */
  getJson<T>(path: string, timeoutMs?: number): Promise<T | null>;
  /** POST JSON; `fallback(error)` is returned on failure (never throws). */
  postJson<T>(path: string, body: unknown, fallback: (error: string) => T, timeoutMs?: number): Promise<T>;
  reactivate(agentId: string): Promise<ReactivateResult>;
  openEditor(agentId: string): Promise<ReactivateResult>;
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  askJev(req: AskJevRequest): Promise<AskJevResult>;
}

/** What a feature may use from the hub. Everything is live (reads current state on call). */
export interface ClientContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  store: WorldStore;
  /** Seconds since the world loaded (the render clock; bubbles/bursts are timed on it). */
  elapsed(): number;
  /** Select + fly to an agent id, or fly to a city id. No-op for unknown ids. */
  flyTo(id: string): void;
  /** Dive the camera through an agent's house, then open its Room view (straight to the Room off-planet). */
  diveToRoom(agentId: string): void;
  /** Shows a registered ClientPanel (any feature's) in the side panel. */
  openPanel(panelId: string): void;
  /** True when some enabled feature registers a panel with this id. */
  hasPanel(panelId: string): boolean;
  openPalette(query?: string): void;
  /** `action`: one button on the toast (ui/toast.ts ToastAction). */
  toast(text: string, kind?: "info" | "error", action?: ToastAction): void;
  api: ClientApi;
  /** Top of a city's tower (world space), undefined for unknown cities. */
  cityPosition(cityId: string): THREE.Vector3 | undefined;
  /** Roof of an agent's house (world space), undefined when not placed. */
  agentPosition(agentId: string): THREE.Vector3 | undefined;
  /** Ground point on the planet in direction `dir`, lifted `lift` units along the normal. */
  surfacePoint(dir: THREE.Vector3, lift?: number): THREE.Vector3;
  labels: {
    /** Comic speech bubble anchored at a world point for `seconds`. */
    say(text: string, anchor: THREE.Vector3, seconds?: number): void;
    /** One-shot comic burst ("POW!") at a world point. */
    burst(text: string, anchor: THREE.Vector3): void;
  };
  /** Leave the feature's ride mode (if one is active) and restore the camera it started from. */
  endRide(): void;
  // ---- Alef shell (docs/VIEWS.md) ----
  /** The one live Feed in the right sidebar: push real events, resolve actionable ones. */
  feed: FeedSink;
  /** Open the right sidebar on a tab (expands it from its rail / phone sheet). */
  openRightTab(tab: RightTab): void;
  /** Switch the main view (#/<id>/<param>). Unknown ids fall back to Orbit. */
  showView(id: string, param?: string | null): void;
  /** Id of the view on screen now. */
  activeView(): string;
}

/** A feature that takes over the camera when the user picks "2" / the ride button.
 *  The hub disables the orbit controls, saves the view, and calls these; it restores
 *  the exact previous view itself after stop(). */
export interface RideController {
  start(ctx: ClientContext): void;
  /** Every planet frame while riding, in place of the orbit camera update. Owns ctx.camera. */
  frame(dt: number, ctx: ClientContext): void;
  stop(ctx: ClientContext): void;
}

export interface ClientFeature {
  /** Unique, kebab-case; must equal the server feature id whose WS messages it wants. */
  id: string;
  /** Once, after the world is built. Subscribe to ctx.store events here. */
  mount?(ctx: ClientContext): void;
  /** After mount with the initial world, then on every mid-session snapshot. Read your data from world.extras. */
  onSnapshot?(world: WorldSnapshot, ctx: ClientContext): void;
  /** Only `{ type: "feature", feature: <this id> }` messages. Validate msg.payload before use. */
  onMessage?(msg: FeatureMessage, ctx: ClientContext): void;
  /** Every planet frame (not while inside an agent room). Keep it cheap. */
  onFrame?(dt: number, ctx: ClientContext): void;
  /** Escape pressed: close your topmost overlay and return true to stop the default close chain. */
  onEscape?(ctx: ClientContext): boolean;
  paletteCommands?(ctx: ClientContext): PaletteCommand[];
  hudButtons?: HudButton[];
  panels?: ClientPanel[];
  /** At most one enabled feature should define this (the first one wins). */
  ride?: RideController;
}

export class ClientFeatureHost {
  private readonly frameBroken = new Set<string>();

  constructor(
    private readonly features: readonly ClientFeature[],
    private readonly ctx: ClientContext,
  ) {
    const ids = new Set<string>();
    const panels = new Set<string>();
    for (const f of features) {
      if (ids.has(f.id)) throw new Error(`duplicate client feature id: ${f.id}`);
      ids.add(f.id);
      for (const p of f.panels ?? []) {
        if (panels.has(p.id)) throw new Error(`duplicate panel id: ${p.id}`);
        panels.add(p.id);
      }
    }
  }

  private guard(f: ClientFeature, hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error(`feature:${f.id}`, `${hook} failed`, err);
    }
  }

  /** mount() then onSnapshot(initial world), per feature. */
  mount(world: WorldSnapshot): void {
    for (const f of this.features) {
      const { mount, onSnapshot } = f;
      if (mount) this.guard(f, "mount", () => mount.call(f, this.ctx));
      if (onSnapshot) this.guard(f, "onSnapshot", () => onSnapshot.call(f, world, this.ctx));
    }
  }

  snapshot(world: WorldSnapshot): void {
    for (const f of this.features) {
      const { onSnapshot } = f;
      if (onSnapshot) this.guard(f, "onSnapshot", () => onSnapshot.call(f, world, this.ctx));
    }
  }

  /** Routes a feature message to its owner. Returns false for non-feature messages. */
  message(msg: ServerMessage): boolean {
    if (msg.type !== "feature") return false;
    const owner = this.features.find((f) => f.id === msg.feature);
    const onMessage = owner?.onMessage;
    if (owner && onMessage) this.guard(owner, "onMessage", () => onMessage.call(owner, msg, this.ctx));
    else log.warn("features", `no client feature handles "${msg.feature}" messages`);
    return true;
  }

  /** A throwing onFrame is logged once and then skipped, so one bug can't flood the console at 60fps. */
  frame(dt: number): void {
    for (const f of this.features) {
      const { onFrame } = f;
      if (!onFrame || this.frameBroken.has(f.id)) continue;
      try {
        onFrame.call(f, dt, this.ctx);
      } catch (err) {
        this.frameBroken.add(f.id);
        log.error(`feature:${f.id}`, "onFrame failed; disabled until reload", err);
      }
    }
  }

  /** True when some feature consumed the Escape key. */
  escape(): boolean {
    for (const f of this.features) {
      const { onEscape } = f;
      if (!onEscape) continue;
      let consumed = false;
      this.guard(f, "onEscape", () => {
        consumed = onEscape.call(f, this.ctx);
      });
      if (consumed) return true;
    }
    return false;
  }

  /** All features' commands, ids namespaced "<featureId>:<id>". */
  paletteCommands(): PaletteCommand[] {
    const out: PaletteCommand[] = [];
    for (const f of this.features) {
      const { paletteCommands } = f;
      if (!paletteCommands) continue;
      this.guard(f, "paletteCommands", () => {
        for (const c of paletteCommands.call(f, this.ctx)) out.push({ ...c, id: `${f.id}:${c.id}` });
      });
    }
    return out;
  }

  /** A throwing (or rejecting) command is logged and toasted, never an uncaught error with no UI. */
  runCommand(namespacedId: string): boolean {
    const cmd = this.paletteCommands().find((c) => c.id === namespacedId);
    if (!cmd) return false;
    const fail = (err: unknown): void => {
      log.error(`command:${cmd.id}`, "run failed", err);
      this.ctx.toast(`${cmd.title} failed: ${describeError(err)}`, "error");
    };
    try {
      const out: unknown = cmd.run();
      if (out instanceof Promise) out.catch(fail);
    } catch (err) {
      fail(err);
    }
    return true;
  }

  hudButtons(): { featureId: string; button: HudButton }[] {
    return this.features.flatMap((f) => (f.hudButtons ?? []).map((button) => ({ featureId: f.id, button })));
  }

  /** True when some feature provides a ride mode (the hub then routes "2" to it). */
  hasRide(): boolean {
    return this.features.some((f) => f.ride);
  }

  /** Runs one ride hook of the first feature that has a ride. False when it threw (the hub should end the ride). */
  ride(hook: "start" | "frame" | "stop", dt = 0): boolean {
    const f = this.features.find((x) => x.ride);
    const r = f?.ride;
    if (!f || !r) return false;
    try {
      if (hook === "frame") r.frame(dt, this.ctx);
      else r[hook](this.ctx);
      return true;
    } catch (err) {
      log.error(`feature:${f.id}`, `ride.${hook} failed`, err);
      return false;
    }
  }

  panel(panelId: string): ClientPanel | undefined {
    for (const f of this.features) {
      const p = f.panels?.find((x) => x.id === panelId);
      if (p) return p;
    }
    return undefined;
  }
}
