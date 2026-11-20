import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainNode } from "../../../shared/features/brain";
import { toonGradient } from "../scene/toon";
import { createGlobe, type GlobeCanvas, type GlobeEnv, type GlobeRenderer } from "./brain-globe";
import { MAX_GLOBE_LINKS, globeLayout } from "./brain-globe-lib";
import { neighbourMap } from "./brain-lib";

class FakeCanvas extends EventTarget implements GlobeCanvas {
  isConnected = true;
  style = { cursor: "" };
  remove = vi.fn(() => {
    this.isConnected = false;
  });
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
}

/** Like three's WebGLTextures: the first time a texture is drawn, hook a dispose listener on it. */
function fakeRenderer() {
  const hooked = new Set<THREE.Texture>();
  const onTextureDispose = vi.fn((): void => {});
  const done = (): void => {};
  const r = {
    setPixelRatio: vi.fn(done),
    setSize: vi.fn(done),
    setClearColor: vi.fn(done),
    render: vi.fn((scene: THREE.Object3D): void => {
      scene.traverse((o) => {
        const mats = o instanceof THREE.Mesh ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats)
          if (m instanceof THREE.MeshToonMaterial && m.gradientMap && !hooked.has(m.gradientMap)) {
            hooked.add(m.gradientMap);
            m.gradientMap.addEventListener("dispose", onTextureDispose);
          }
      });
    }),
    dispose: vi.fn(done),
    forceContextLoss: vi.fn(done),
    onTextureDispose,
  };
  return r satisfies GlobeRenderer;
}

function fakeEnv(opts: { hidden?: boolean; reduced?: boolean } = {}) {
  let isHidden = opts.hidden ?? false;
  let onVis: () => void = () => {};
  const off = vi.fn((): void => {});
  const env = {
    frames: [] as Array<(t: number) => void>,
    requested: 0,
    raf(cb: (t: number) => void): number {
      env.requested++;
      return env.frames.push(cb);
    },
    caf: vi.fn((_id: number): void => {}),
    hidden: () => isHidden,
    reducedMotion: () => opts.reduced ?? false,
    dpr: () => 3,
    onVisibility(fn: () => void) {
      onVis = fn;
      return off;
    },
    hide(h: boolean) {
      isHidden = h;
    },
    visible: () => onVis(),
    off,
  };
  return env satisfies GlobeEnv;
}

let clock = 0;
/** Run up to n requested frames (like the browser does once per vsync); returns how many ran. */
function run(env: ReturnType<typeof fakeEnv>, n = 1): number {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const cb = env.frames.pop();
    env.frames.length = 0;
    if (!cb) break;
    clock += 16.7;
    cb(clock);
    ran++;
  }
  return ran;
}

function pev(type: string, x: number, y: number, t: number, extra: Record<string, unknown> = {}): Event {
  const ev = new Event(type);
  for (const [k, v] of Object.entries({ pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: "mouse", timeStamp: t, ...extra })) Object.defineProperty(ev, k, { value: v });
  return ev;
}

function key(k: string, mods: Record<string, boolean> = {}): Event & { stopped: boolean } {
  const ev = Object.assign(new Event("keydown", { cancelable: true }), { stopped: false });
  Object.defineProperty(ev, "key", { value: k });
  for (const m of ["metaKey", "ctrlKey", "altKey"]) Object.defineProperty(ev, m, { value: mods[m] ?? false });
  const stop = ev.stopPropagation.bind(ev);
  ev.stopPropagation = () => {
    ev.stopped = true;
    stop();
  };
  return ev;
}

const nodes: BrainNode[] = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, label: `n${i}`, path: `${["A", "B", "C"][i % 3]}/n${i}`, folder: ["A", "B", "C"][i % 3] as string, group: "other", degree: 400, community: 0 }));
const edges: Array<[number, number]> = nodes.slice(1).map((n) => [1, n.id]);
// A node well away from the poles, so the pitch clamp doesn't keep it off-centre.
const target = [...globeLayout(nodes).pos].find(([, p]) => Math.abs(p.y) < 20)?.[0] as number;

function make(env = fakeEnv()) {
  const canvas = new FakeCanvas();
  const renderer = fakeRenderer();
  const onHover = vi.fn();
  const onPick = vi.fn();
  const globe = createGlobe({ canvas, renderer, env, onHover, onPick });
  globe.resize();
  globe.setGraph(nodes, edges, neighbourMap(edges));
  return { canvas, renderer, env, globe, onHover, onPick };
}

afterEach(() => vi.restoreAllMocks());

describe("brain globe controller: lifecycle", () => {
  it("renders with its own renderer, pixel ratio capped at 2", () => {
    const { renderer, env, globe } = make();
    expect(renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(renderer.setSize).toHaveBeenCalledWith(800, 600, false);
    expect(run(env)).toBe(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(globe.linksDrawn()).toBe(edges.length);
  });

  it("dispose (what Brain's unmount and the 2D switch call) frees the GPU and the canvas", () => {
    const geo = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const mat = vi.spyOn(THREE.Material.prototype, "dispose");
    const { canvas, renderer, env, globe, onHover } = make();
    globe.dispose();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(canvas.remove).toHaveBeenCalledTimes(1);
    expect(env.caf).toHaveBeenCalled(); // the pending frame is cancelled
    expect(env.off).toHaveBeenCalledTimes(1); // visibilitychange listener gone
    expect(geo.mock.calls.length).toBeGreaterThanOrEqual(7); // halo, graticule, veil, rim, beads, links, highlight links
    expect(mat.mock.calls.length).toBeGreaterThanOrEqual(7);
    canvas.dispatchEvent(new Event("pointerleave")); // listeners were removed
    expect(onHover).not.toHaveBeenCalled();
    globe.dispose();
    globe.setLit(new Set([1]));
    expect(globe.face(1)).toBe(false);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses its own toon-gradient clone: the shared ramp gains no listener across open/close cycles", () => {
    const shared = toonGradient();
    const hooks: Array<ReturnType<typeof fakeRenderer>> = [];
    for (let i = 0; i < 5; i++) {
      const { renderer, env, globe } = make();
      run(env);
      hooks.push(renderer);
      globe.dispose();
      expect(renderer.onTextureDispose).toHaveBeenCalledTimes(1); // our clone was disposed
    }
    for (const r of hooks) expect(shared.hasEventListener("dispose", r.onTextureDispose)).toBe(false);
  });

  it("pauses while the tab is hidden and resumes when it shows again", () => {
    const env = fakeEnv({ hidden: true });
    const { renderer } = make(env);
    expect(env.frames).toHaveLength(0);
    env.hide(false);
    env.visible();
    expect(run(env)).toBe(1);
    env.hide(true);
    expect(run(env)).toBe(1); // this frame was already queued: it bails out…
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(env.frames).toHaveLength(0); // …and queues nothing while hidden
  });

  it("caps huge link counts, drops links to unknown notes, survives an empty graph", () => {
    const { globe } = make();
    const many: Array<[number, number]> = [];
    for (let a = 1; a <= 40; a++) for (let b = a + 1; b <= 40; b++) for (let k = 0; k < 4; k++) many.push([a, b]);
    globe.setGraph(nodes, many, neighbourMap(many));
    expect(many.length).toBeGreaterThan(MAX_GLOBE_LINKS);
    expect(globe.linksDrawn()).toBe(MAX_GLOBE_LINKS);
    globe.setGraph(nodes, [[1, 999], [2, 3]], new Map());
    expect(globe.linksDrawn()).toBe(1);
    globe.setGraph([], [], new Map());
    expect(globe.linksDrawn()).toBe(0);
    expect(globe.face(1)).toBe(false);
    expect(globe.splits()).toEqual([]);
  });
});

describe("brain globe controller: pointer", () => {
  it("face(id) then a click at the centre picks that id, also after a zoom", () => {
    const { env, canvas, globe, onPick } = make(fakeEnv({ reduced: true }));
    globe.face(target);
    run(env, 600);
    canvas.dispatchEvent(pev("pointerdown", 400, 300, 1000));
    canvas.dispatchEvent(pev("pointerup", 400, 300, 1050));
    expect(onPick).toHaveBeenLastCalledWith(target);
    globe.zoom(2.5);
    run(env, 600);
    canvas.dispatchEvent(pev("pointerdown", 400, 300, 2000));
    canvas.dispatchEvent(pev("pointerup", 400, 300, 2050));
    expect(onPick).toHaveBeenLastCalledWith(target);
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("a wobble of up to 4 px is still a click; past 4 px it is a drag and picks nothing", () => {
    const { env, canvas, globe, onPick } = make(fakeEnv({ reduced: true }));
    globe.face(target);
    run(env, 600);
    canvas.dispatchEvent(pev("pointerdown", 400, 300, 1000));
    canvas.dispatchEvent(pev("pointermove", 402, 302, 1010)); // 4 px (|dx| + |dy|)
    canvas.dispatchEvent(pev("pointerup", 402, 302, 1020));
    expect(onPick).toHaveBeenCalledTimes(1);
    const before = globe.view().yaw;
    canvas.dispatchEvent(pev("pointerdown", 400, 300, 2000));
    canvas.dispatchEvent(pev("pointermove", 410, 300, 2016));
    canvas.dispatchEvent(pev("pointerup", 410, 300, 2030));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(globe.view().yaw).toBeGreaterThan(before); // it turned instead
  });

  it("pinch: fingers apart zoom in, together zoom out", () => {
    const { canvas, globe } = make(fakeEnv({ reduced: true }));
    const d0 = globe.view().targetDist;
    const touch = (type: string, id: number, x: number): void => void canvas.dispatchEvent(pev(type, x, 300, 1, { pointerId: id, pointerType: "touch" }));
    touch("pointerdown", 1, 300);
    touch("pointerdown", 2, 500);
    touch("pointermove", 1, 250);
    touch("pointermove", 2, 550);
    const d1 = globe.view().targetDist;
    expect(d1).toBeLessThan(d0);
    touch("pointermove", 1, 350);
    touch("pointermove", 2, 450);
    expect(globe.view().targetDist).toBeGreaterThan(d1);
  });

  it("fling then hover a bead: the velocity drops, the loop sleeps, the old fling never resumes", () => {
    const env = fakeEnv(); // motion allowed: flings coast, the idle auto-turn is on
    const { canvas, globe } = make(env);
    run(env, 5);
    canvas.dispatchEvent(pev("pointerdown", 100, 100, 5000));
    canvas.dispatchEvent(pev("pointermove", 140, 100, 5008));
    canvas.dispatchEvent(pev("pointermove", 180, 100, 5016));
    canvas.dispatchEvent(pev("pointerup", 180, 100, 5020));
    run(env, 1);
    expect(Math.abs(globe.view().vyaw)).toBeGreaterThan(0.1); // flinging
    let hovered = false;
    for (let i = 0; i < 600 && !hovered; i++) {
      const a = i * 2.4;
      const r = 5 + (i % 40) * 5;
      canvas.dispatchEvent(pev("pointermove", 400 + Math.cos(a) * r, 300 + Math.sin(a) * r, 5100 + i));
      run(env, 1);
      hovered = canvas.style.cursor === "pointer";
    }
    expect(hovered).toBe(true);
    expect(run(env, 1000)).toBeLessThan(5); // asleep, not spinning a thousand frames
    expect(globe.view().vyaw).toBe(0);
    const yaw = globe.view().yaw;
    canvas.dispatchEvent(new Event("pointerleave"));
    expect(run(env, 60)).toBe(60); // awake again (auto-turn waits 2.5 s idle)…
    expect(globe.view().yaw).toBeCloseTo(yaw, 9); // …and the old fling is gone
  });

  it("reduced motion: no fling after a drag, face() snaps, and a settled globe stops requesting frames", () => {
    const env = fakeEnv({ reduced: true });
    const { canvas, globe } = make(env);
    run(env, 400);
    expect(env.frames).toHaveLength(0);
    canvas.dispatchEvent(pev("pointerdown", 100, 100, 1000));
    canvas.dispatchEvent(pev("pointermove", 160, 100, 1008));
    canvas.dispatchEvent(pev("pointerup", 160, 100, 1012));
    expect(globe.view().vyaw).toBe(0);
    const yaw = globe.view().yaw;
    run(env, 100);
    expect(globe.view().yaw).toBeCloseTo(yaw, 9);
    globe.face(target);
    const turned = globe.view().yaw;
    run(env, 1);
    expect(globe.view().yaw).toBeCloseTo(turned, 9); // already there: nothing animates
  });
});

describe("brain globe controller: keyboard (only while the canvas has focus)", () => {
  it("arrows turn, + / - zoom, Enter opens the note in the middle; handled keys stop there", () => {
    const { env, canvas, globe, onPick } = make(fakeEnv({ reduced: true }));
    globe.face(target);
    run(env, 600);
    const y0 = globe.view().yaw;
    const right = key("ArrowRight");
    canvas.dispatchEvent(right);
    expect(globe.view().yaw).toBeCloseTo(y0 + 0.2, 6);
    expect(right.defaultPrevented).toBe(true);
    expect(right.stopped).toBe(true); // the shell's global keys never see it
    canvas.dispatchEvent(key("ArrowLeft"));
    const d0 = globe.view().targetDist;
    canvas.dispatchEvent(key("+"));
    expect(globe.view().targetDist).toBeLessThan(d0);
    canvas.dispatchEvent(key("-"));
    canvas.dispatchEvent(key("-"));
    expect(globe.view().targetDist).toBeGreaterThan(d0);
    canvas.dispatchEvent(key("Enter"));
    expect(onPick).toHaveBeenLastCalledWith(target);
  });

  it("leaves Escape, letters and modified keys to the shell", () => {
    const { canvas, globe, onPick } = make();
    const v = globe.view();
    for (const ev of [key("Escape"), key("f"), key("ArrowRight", { metaKey: true }), key("+", { ctrlKey: true })]) {
      canvas.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(ev.stopped).toBe(false);
    }
    expect(globe.view()).toEqual(v);
    expect(onPick).not.toHaveBeenCalled();
  });
});
