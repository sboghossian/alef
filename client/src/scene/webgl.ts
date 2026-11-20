// WebGL can fail to start (no GPU context, a headless browser, a blocklisted driver) or be lost at
// runtime (a GPU reset, a tab evicted under memory pressure). The Alef shell (sidebars, Inbox,
// Logs, Health, launch / attach / stop) must never depend on it: these helpers decide between the
// full 3D boot and the degraded 2D-only one, and track a lost context. DOM-free on purpose: every
// function takes the browser's own shapes (a canvas as an EventTarget with getContext, the
// webglcontext* events), so tests drive them with those shapes and real three.js.

/** The part of HTMLCanvasElement the probe uses. */
export interface ProbeCanvas extends EventTarget {
  getContext(contextId: string): unknown;
}

export type GlVerdict = { ok: true } | { ok: false; reason: string };

/** What the 3D view is doing now. Published on the scene bus (`webgl`) for Health and the banner. */
export type GlStatus = { state: "on" } | { state: "off"; reason: string } | { state: "lost" };
export type GlDown = Exclude<GlStatus, { state: "on" }>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The browser's own words from a webglcontextcreationerror event, or "" when it gave none. */
function statusMessageOf(ev: Event): string {
  return "statusMessage" in ev && typeof ev.statusMessage === "string" ? ev.statusMessage.trim() : "";
}

/**
 * The cheap up-front check: can this browser hand out a WebGL 2 context at all? three.js r186 only
 * asks for "webgl2", so a WebGL 1-only browser is reported as such, never as working. The probe
 * canvas is never attached and is simply dropped (as three.js's own WebGL.isWebGL2Available does).
 */
export function probeWebGL(canvas: ProbeCanvas): GlVerdict {
  let status = "";
  const onError = (ev: Event): void => {
    status ||= statusMessageOf(ev);
  };
  canvas.addEventListener("webglcontextcreationerror", onError);
  try {
    if (canvas.getContext("webgl2")) return { ok: true };
    const reason = canvas.getContext("webgl")
      ? "only WebGL 1 is available, and the 3D view needs WebGL 2"
      : "the browser returned no WebGL context";
    return { ok: false, reason: status ? `${reason} (${status})` : reason };
  } catch (err) {
    return { ok: false, reason: `the WebGL check threw: ${errorText(err)}` };
  } finally {
    canvas.removeEventListener("webglcontextcreationerror", onError);
  }
}

export type GlStart<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The degraded-boot decision. Probe first, so a plain "no" never reaches three.js (which would
 * log its own errors), then build the real renderer inside try/catch: a probe that passes can
 * still fail on three.js's context attributes or a render target the driver refuses.
 */
export function startGl<T>(probe: () => GlVerdict, create: () => T): GlStart<T> {
  let verdict: GlVerdict;
  try {
    verdict = probe();
  } catch (err) {
    verdict = { ok: false, reason: `the WebGL check threw: ${errorText(err)}` };
  }
  if (!verdict.ok) return verdict;
  try {
    return { ok: true, value: create() };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

export interface GlContextWatch {
  /** True between webglcontextlost and webglcontextrestored. */
  isLost(): boolean;
  dispose(): void;
}

/**
 * Runtime loss. preventDefault() on webglcontextlost is what tells the browser we want the context
 * back; without it the browser never fires webglcontextrestored. three.js listens on the same
 * canvas and rebuilds its GL state on restore (WebGLRenderer.onContextRestore → initGLContext);
 * this only tracks the state for the render loop and the banner. Repeats of one kind are ignored.
 */
export function watchGlContext(canvas: EventTarget, on: { lost(): void; restored(): void }): GlContextWatch {
  let lost = false;
  const onLost = (ev: Event): void => {
    ev.preventDefault();
    if (lost) return;
    lost = true;
    on.lost();
  };
  const onRestored = (): void => {
    if (!lost) return;
    lost = false;
    on.restored();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return {
    isLost: () => lost,
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    },
  };
}

export interface No3dCopy {
  burst: string;
  title: string;
  reason: string;
  hint: string;
}

/** The banner's words. The reason is the real one: the browser's message, or "context lost". */
export function no3dCopy(status: GlDown): No3dCopy {
  if (status.state === "lost") {
    return {
      burst: "PAUSED",
      title: "3D view unavailable: the WebGL context was lost. Everything else works.",
      reason: "Reason: context lost (the browser or the GPU driver took the 3D context away).",
      hint: "The planet comes back on its own if the browser restores the context. If it stays away, reload.",
    };
  }
  return {
    burst: "2D ONLY",
    title: "3D view unavailable: WebGL could not start in this browser. Everything else works.",
    reason: `Reason: ${status.reason.replace(/[.\s]+$/, "")}.`,
    hint: "Sidebars, Inbox, Logs, Health and the other views work without it. For the planet, turn on hardware acceleration (or use a browser with a GPU), then reload.",
  };
}
