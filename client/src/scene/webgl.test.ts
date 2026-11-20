// Backlog 0a: one WebGL failure used to take the whole shell down (main() threw at createSceneRig).
// These drive the probe, the degraded-boot decision and the lost-context handler with the browser's
// own shapes: a canvas that is an EventTarget whose getContext returns null and fires
// webglcontextcreationerror with a statusMessage (what Chromium does with no GPU), real cancelable
// webglcontextlost / webglcontextrestored events, and real three.js failing on such a canvas.
// Nothing under test is stubbed.

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { no3dCopy, probeWebGL, startGl, watchGlContext } from "./webgl";

/** The statusMessage the gstack browse daemon's headless Chromium gave for the app's webgl2 probe
 *  (observed 2026-09-28 on this branch's banner): SwiftShader present, unsafe SwiftShader off. */
const CHROMIUM_NO_GPU =
  "Could not create a WebGL context, VENDOR = 0xffff, DEVICE = 0xffff, GL_VENDOR = Google Inc. (Google), GL_RENDERER = ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver-5.0.0), GL_VERSION = 5.0.0, Sandboxed = yes, Optimus = no, AMD switchable = no, Reset notification strategy = 0x8252, ErrorMessage = BindToCurrentSequence failed: .";

/** A canvas as the browser presents one: a context object for the kinds it grants, null (plus a
 *  webglcontextcreationerror carrying statusMessage, when the browser gives one) for the rest. */
class TestCanvas extends EventTarget {
  readonly asked: string[] = [];
  width = 300;
  height = 150;
  constructor(
    private readonly grant: readonly string[],
    private readonly statusMessage?: string,
  ) {
    super();
  }
  getContext(kind: string): object | null {
    this.asked.push(kind);
    if (this.grant.includes(kind)) return { kind };
    if (this.statusMessage !== undefined) {
      const ev = new Event("webglcontextcreationerror");
      Object.defineProperty(ev, "statusMessage", { value: this.statusMessage });
      this.dispatchEvent(ev);
    }
    return null;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeWebGL", () => {
  it("passes when the browser grants WebGL 2, without asking for anything else", () => {
    const c = new TestCanvas(["webgl2", "webgl"]);
    expect(probeWebGL(c)).toEqual({ ok: true });
    expect(c.asked).toEqual(["webgl2"]);
  });

  it("no GPU (headless Chromium): fails with the browser's own reason", () => {
    const v = probeWebGL(new TestCanvas([], CHROMIUM_NO_GPU));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe(`the browser returned no WebGL context (${CHROMIUM_NO_GPU})`);
  });

  it("WebGL 1 only: fails, and says so (three.js r186 only asks for webgl2)", () => {
    const v = probeWebGL(new TestCanvas(["webgl"]));
    expect(v).toEqual({ ok: false, reason: "only WebGL 1 is available, and the 3D view needs WebGL 2" });
  });

  it("a browser that fires no creation-error event still gets an honest reason", () => {
    expect(probeWebGL(new TestCanvas([]))).toEqual({ ok: false, reason: "the browser returned no WebGL context" });
  });

  it("a getContext that throws is a failed probe, not a crash", () => {
    const c = new TestCanvas([]);
    c.getContext = (): object | null => {
      throw new Error("SecurityError: blocked");
    };
    expect(probeWebGL(c)).toEqual({ ok: false, reason: "the WebGL check threw: SecurityError: blocked" });
  });

  it("stops listening once it has answered", () => {
    const c = new TestCanvas([], CHROMIUM_NO_GPU);
    const add = vi.spyOn(c, "addEventListener");
    const remove = vi.spyOn(c, "removeEventListener");
    probeWebGL(c);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("webglcontextcreationerror", add.mock.calls[0]?.[1]);
  });
});

describe("startGl: the degraded-boot decision", () => {
  it("a failed probe never builds the renderer (so three.js logs nothing) and passes the reason on", () => {
    const create = vi.fn(() => "renderer");
    const r = startGl(() => probeWebGL(new TestCanvas([], CHROMIUM_NO_GPU)), create);
    expect(create).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, reason: `the browser returned no WebGL context (${CHROMIUM_NO_GPU})` });
  });

  it("a probe that passes but a real three.js WebGLRenderer that can't start → degraded with three's message", () => {
    const threeErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = startGl(
      () => probeWebGL(new TestCanvas(["webgl2"])),
      // Real three.js on a canvas that refuses its context, the way a driver refuses three's attributes.
      () => new THREE.WebGLRenderer({ canvas: new TestCanvas([], CHROMIUM_NO_GPU) as unknown as HTMLCanvasElement }),
    );
    expect(r).toEqual({ ok: false, reason: "THREE.WebGLRenderer: Error creating WebGL context." });
    // three.js saw the same creation-error event the probe reads.
    expect(threeErrors.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes(CHROMIUM_NO_GPU)))).toBe(true);
  });

  it("a probe that throws is a degraded boot, not a crash", () => {
    const r = startGl(
      () => {
        throw new Error("document is gone");
      },
      () => "renderer",
    );
    expect(r).toEqual({ ok: false, reason: "the WebGL check threw: document is gone" });
  });

  it("WebGL works: the renderer comes back untouched", () => {
    const renderer = { id: "gl" };
    expect(startGl(() => probeWebGL(new TestCanvas(["webgl2"])), () => renderer)).toEqual({ ok: true, value: renderer });
  });
});

describe("watchGlContext: a lost context at runtime", () => {
  const lostEvent = (): Event => new Event("webglcontextlost", { cancelable: true });

  it("prevents the default on webglcontextlost (so the browser may restore) and pauses once", () => {
    const canvas = new EventTarget();
    const lost = vi.fn();
    const restored = vi.fn();
    const w = watchGlContext(canvas, { lost, restored });
    expect(w.isLost()).toBe(false);
    const ev = lostEvent();
    expect(canvas.dispatchEvent(ev)).toBe(false); // false = a listener called preventDefault()
    expect(ev.defaultPrevented).toBe(true);
    expect(w.isLost()).toBe(true);
    const again = lostEvent();
    canvas.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
  });

  it("resumes on webglcontextrestored, once", () => {
    const canvas = new EventTarget();
    const lost = vi.fn();
    const restored = vi.fn();
    const w = watchGlContext(canvas, { lost, restored });
    canvas.dispatchEvent(lostEvent());
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(w.isLost()).toBe(false);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(restored).toHaveBeenCalledTimes(1);
    // …and can be lost again later.
    canvas.dispatchEvent(lostEvent());
    expect(w.isLost()).toBe(true);
    expect(lost).toHaveBeenCalledTimes(2);
  });

  it("ignores a restore that no loss preceded", () => {
    const canvas = new EventTarget();
    const restored = vi.fn();
    const w = watchGlContext(canvas, { lost: vi.fn(), restored });
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(restored).not.toHaveBeenCalled();
    expect(w.isLost()).toBe(false);
  });

  it("stops listening after dispose()", () => {
    const canvas = new EventTarget();
    const lost = vi.fn();
    const w = watchGlContext(canvas, { lost, restored: vi.fn() });
    w.dispose();
    const ev = lostEvent();
    expect(canvas.dispatchEvent(ev)).toBe(true);
    expect(lost).not.toHaveBeenCalled();
    expect(w.isLost()).toBe(false);
  });
});

describe("no3dCopy: the banner says what happened, with the real reason", () => {
  it("WebGL could not start: the fixed headline plus the browser's reason, one full stop", () => {
    const c = no3dCopy({ state: "off", reason: "THREE.WebGLRenderer: Error creating WebGL context." });
    expect(c.title).toBe("3D view unavailable: WebGL could not start in this browser. Everything else works.");
    expect(c.reason).toBe("Reason: THREE.WebGLRenderer: Error creating WebGL context.");
    expect(c.burst).toBe("2D ONLY");
  });

  it("context lost: says so, and that the planet returns on its own if the browser restores it", () => {
    const c = no3dCopy({ state: "lost" });
    expect(c.title).toContain("Everything else works.");
    expect(c.reason).toContain("context lost");
    expect(c.hint).toContain("reload");
  });
});
