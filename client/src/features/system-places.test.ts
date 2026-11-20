// The System Quarter + campus as built by the shipped buildQuarter / paintCampus, rendered through
// three's own WebGLRenderer on a stub WebGL2 context (node has no GPU): renderer.info.render.calls
// is three's real count, with its real visibility, frustum and "instanced count 0 draws nothing"
// rules. The campus data comes through campus-data.ts from responses in the real API shapes.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CityLayout } from "../layout";
import { PickRegistry } from "../scene/pick";
import { registerSceneParts, sceneParts } from "../scene/scene-bus";
import { campusData, campusSnapshot, offerCareers, onCampusChange, refreshCampus, resetCampusDataForTest, startCampusData, trustedWorkerKeys } from "./campus-data";
import { careersFeature } from "./careers";
import { outcomesFeature } from "./outcomes";
import type { ClientContext } from "./registry";
import { openEntries, SICKNESS_OPEN_CAP, type SicknessCase } from "../../../shared/features/sickness";
import type { ClinicView } from "./sickness-lib";
import {
  buildQuarter,
  campusCaption,
  campusForLabel,
  clinicCaption,
  currentBanners,
  currentClinicLamp,
  currentClinicMarks,
  currentLamp,
  isClinicLabel,
  paintCampus,
  paintClinic,
  swayBanners,
  type Quarter,
} from "./system-places";
import { MAX_MARKS, PLACE_IDS } from "./system-places-lib";

// ---------------------------------------------------------------- a stub WebGL2 context

const GL_ENUMS: Record<string, number> = {
  VERSION: 7938,
  SHADING_LANGUAGE_VERSION: 35724,
  VENDOR: 7936,
  RENDERER: 7937,
  MAX_TEXTURE_SIZE: 3379,
  MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
  MAX_RENDERBUFFER_SIZE: 34024,
  MAX_VIEWPORT_DIMS: 3386,
  VIEWPORT: 2978,
  SCISSOR_BOX: 3088,
  LINK_STATUS: 35714,
  FRAMEBUFFER_COMPLETE: 36053,
};

/** Just enough of WebGL2 for three's WebGLRenderer to compile (every link succeeds) and draw. */
function stubGl(): { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement } {
  let next = 1;
  const handle = (): { id: number } => ({ id: next++ });
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    getParameter: (p) => {
      if (p === GL_ENUMS.VERSION) return "WebGL 2.0 (stub)";
      if (p === GL_ENUMS.SHADING_LANGUAGE_VERSION) return "WebGL GLSL ES 3.00 (stub)";
      if (p === GL_ENUMS.VENDOR || p === GL_ENUMS.RENDERER) return "stub";
      if (p === GL_ENUMS.MAX_VIEWPORT_DIMS) return new Int32Array([4096, 4096]);
      if (p === GL_ENUMS.VIEWPORT || p === GL_ENUMS.SCISSOR_BOX) return new Int32Array([0, 0, 800, 600]);
      return 4096;
    },
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "default", failIfMajorPerformanceCaveat: false }),
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getProgramParameter: (_p, q) => (q === GL_ENUMS.LINK_STATUS ? true : 0),
    getShaderParameter: () => true,
    getProgramInfoLog: () => "",
    getShaderInfoLog: () => "",
    getShaderSource: () => "",
    isContextLost: () => false,
    checkFramebufferStatus: () => GL_ENUMS.FRAMEBUFFER_COMPLETE,
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    getError: () => 0,
    createBuffer: handle,
    createProgram: handle,
    createShader: handle,
    createTexture: handle,
    createFramebuffer: handle,
    createRenderbuffer: handle,
    createVertexArray: handle,
  };
  const canvas = { width: 800, height: 600, style: {}, addEventListener() {}, removeEventListener() {} };
  const target: Record<string, unknown> = { canvas, drawingBufferWidth: 800, drawingBufferHeight: 600 };
  let auto = 20000;
  const gl = new Proxy(target, {
    get(t, k) {
      if (typeof k !== "string") return undefined;
      if (k in t) return t[k];
      if (k in fns) return fns[k];
      if (/^[A-Z0-9_]+$/.test(k)) return (GL_ENUMS[k] ??= auto++);
      return () => undefined;
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, canvas: canvas as unknown as HTMLCanvasElement };
}

// ---------------------------------------------------------------- fixtures (real API shapes)

const NOW = Date.parse("2026-09-28T09:00:00.000Z");
// Every fixture here is dated around NOW (the lamp's "N days", the 7-day shipped window), so the
// file runs on NOW's clock: on the real clock these assertions broke the day after they were written.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function worker(key: string, state: string, trustedSince: string | null): unknown {
  return {
    key,
    name: null,
    department: "Research library",
    state,
    standing: state,
    reason: "5 clean runs in a row",
    runs: [{ id: "b475e929-0dc5-4e9c-b1aa-8afdceb3dce7", at: "2026-09-28T05:10:19.561Z", dayOnly: false, archived: false, mark: "clean", why: "shipped" }],
    lifetime: { total: 20, live: 5, archived: 15, clean: 5, wrote: 0, bad: 0 },
    lastRunAt: "2026-09-28T05:10:19.561Z",
    medianGapMs: 85303400,
    lapseAfterMs: 259200000,
    trustedSince,
    retiredAt: null,
    routine: null,
  };
}

function careers(trusted: number, others = 3): unknown {
  const workers = [
    ...Array.from({ length: trusted }, (_, i) => worker(`/trusted-${i}`, "trusted", new Date(NOW - (i + 1) * 86_400_000).toISOString())),
    ...Array.from({ length: others }, (_, i) => worker(`/lapsed-${i}`, "lapsed", null)),
  ];
  return {
    ok: true,
    at: "2026-09-28T07:57:31.208Z",
    inputs: { liveRuns: 275, archivedRuns: 1743, archiveLoaded: true, outcomeRecords: 212, routines: 16 },
    departments: ["Reports & Briefs", "Inbox desk", "Research library", "Institute", "Control room", "Operations"],
    summary: { trusted, probation: 0, enrolled: 0, lapsed: others, returned: 0, retired: 0, total: trusted + others },
    workers,
  };
}

const SKILLS = {
  ok: true,
  candidates: [],
  institute: {
    study: {
      line: "No new draft since 2026-05-24 (last clean exit 2026-06-08): 149 of 160 study runs failed (autopilot.log)",
      enabled: true,
      stats: {
        forksLaunched: 160,
        forksFailed: 149,
        forksOk: 10,
        noDraft: 149,
        permissionSkips: 3,
        thresholdSkips: 1808,
        lastRunAt: "2026-09-28T05:32:02.000Z",
        lastSuccessAt: "2026-06-08T05:59:05.000Z",
        lastDraftAt: "2026-05-24T14:53:50.000Z",
        lastExitRc: 1,
        lastFailureLine: "2026-09-28 08:32:37 fork: no draft / unparseable output",
      },
      logPartial: false,
    },
    darwin: [],
    failureModes: { skills: [], patchedSkillCount: 0, patchEntryCount: 0 },
  },
};

const OUTCOMES = {
  ok: true,
  outcomes: [
    { sessionId: "9e6070ff-8488-4c3b-bec6-28df361de682", outcome: "shipped", reason: "sboghossian/commandline#21 merged", evidenceAt: new Date(NOW - 3_600_000).toISOString(), lastActive: "2026-09-28T05:31:24.769Z", prs: 1, merged: 1, pushes: 0, artifacts: 0, pending: false },
    { sessionId: "a", outcome: "shipped", reason: "x#1 merged", evidenceAt: "2026-09-01T00:00:00.000Z", lastActive: "2026-09-01T00:00:00.000Z", prs: 1, merged: 1, pushes: 0, artifacts: 0, pending: false },
  ],
  counts: {},
  scan: {},
};

/** A ClientContext with only the API campus-data uses; `answers` maps a path to its JSON (or null). */
function fakeCtx(answers: Record<string, unknown>): ClientContext {
  return { api: { getJson: (path: string) => Promise.resolve(path in answers ? answers[path] : null) } } as unknown as ClientContext;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- the scene

const HARNESS: CityLayout = { id: "harness", dir: new THREE.Vector3(0, 1, 0), t1: new THREE.Vector3(1, 0, 0), t2: new THREE.Vector3(0, 0, 1), radius: 11.77, lots: 40, rank: 0 };

function sceneWith(q: Quarter): { scene: THREE.Scene; system: THREE.Group; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const system = new THREE.Group();
  system.name = "orbit-system";
  system.add(q.group);
  scene.add(system);
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 1, 1000);
  camera.position.set(0, 250, 0.01);
  camera.lookAt(0, 0, 0);
  return { scene, system, camera };
}

function calls(scene: THREE.Scene, camera: THREE.Camera): number {
  const { gl, canvas } = stubGl();
  const r = new THREE.WebGLRenderer({ context: gl, canvas });
  r.render(scene, camera);
  return r.info.render.calls;
}

async function loadCampusWith(o: { outcomes: unknown }): Promise<void> {
  resetCampusDataForTest();
  startCampusData(fakeCtx({ "/api/outcomes": o.outcomes }));
  await settle();
  paintCampus(null, NOW);
}

async function loadCampus(trusted: number): Promise<void> {
  resetCampusDataForTest();
  startCampusData(fakeCtx({ "/api/careers": careers(trusted), "/api/skills/snapshot": SKILLS, "/api/outcomes": OUTCOMES }));
  await settle();
}

describe("the campus in the System Quarter: draw calls (renderer.info through three's WebGLRenderer)", () => {
  let q: Quarter;
  beforeEach(() => {
    registerSceneParts({ layout: [HARNESS] });
    new PickRegistry(); // registers itself on the scene bus, as main.ts's does
    q = buildQuarter(HARNESS, {} as ClientContext);
  });
  afterEach(() => resetCampusDataForTest());

  it("the campus adds no mesh of its own: buildings merged into the quarter mesh, the lamp is one more orb", () => {
    expect(q.group.children.map((c) => c.name)).toEqual(["system-quarter-places", "system-quarter-orbs", "system-couriers", "campus-banners", "system-quarter-pick"]);
    expect(q.campus.slots.map((s) => s.id)).toEqual(["school", "hall"]);
    expect(q.orbs.count).toBe(15); // 13 quarter orbs + the School's lamp + the Clinic's lamp (no sick house yet)
    expect(q.proxies.count).toBe(16); // 13 + 2 campus + the Clinic's pick proxies (never drawn)
  });

  it("0 trusted workers (today): 2 calls with no courier in flight, 3 with one — the round-11 budget, unchanged", async () => {
    await loadCampus(0);
    paintCampus(q, NOW);
    const { scene, camera } = sceneWith(q);
    expect(q.campus.banners.count).toBe(0);
    expect(calls(scene, camera)).toBe(2);
    q.couriers.count = 1;
    q.couriers.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 52, 20));
    expect(calls(scene, camera)).toBe(3);
  });

  it("12 trusted workers: exactly +1 call for all 12 banners (4 at most, with a courier flying)", async () => {
    await loadCampus(12);
    paintCampus(q, NOW);
    const { scene, camera } = sceneWith(q);
    expect(q.campus.banners.count).toBe(12);
    expect(calls(scene, camera)).toBe(3);
    q.couriers.count = 1;
    q.couriers.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 52, 20));
    expect(calls(scene, camera)).toBe(4);
  });

  it("30 trusted workers still draw 12 banners (one call), and the card data says 18 have none", async () => {
    await loadCampus(30);
    paintCampus(q, NOW);
    expect(q.campus.banners.count).toBe(12);
    expect(currentBanners()).toEqual({ shown: 12, unshown: 18 });
    const { scene, camera } = sceneWith(q);
    expect(calls(scene, camera)).toBe(3);
  });

  it("'Hide on the planet → System' (the orbit-system group) hides the whole campus: 0 calls", async () => {
    await loadCampus(12);
    paintCampus(q, NOW);
    const { scene, system, camera } = sceneWith(q);
    system.visible = false;
    expect(calls(scene, camera)).toBe(0);
  });

  it("a worker losing trust takes its banner down; the places are not rebuilt (same objects, same geometry)", async () => {
    await loadCampus(3);
    paintCampus(q, NOW);
    const mesh = q.group.children[0];
    const geometry = (mesh as THREE.Mesh).geometry;
    expect(q.campus.banners.count).toBe(3);
    await loadCampus(1);
    paintCampus(q, NOW);
    expect(q.campus.banners.count).toBe(1);
    expect(q.group.children[0]).toBe(mesh);
    expect((q.group.children[0] as THREE.Mesh).geometry).toBe(geometry);
  });

  it("the School's lamp: red while the pipeline hasn't drafted in 30 days (the real 2026-05-24 block)", async () => {
    await loadCampus(0);
    paintCampus(q, NOW);
    expect(currentLamp().state).toBe("dim");
    const c = new THREE.Color();
    q.orbs.getColorAt(13, c);
    expect(c.getHex()).toBe(0xff3b3b);
    expect(campusCaption("school")).toBe("lamp dim: no new draft since 2026-05-24 (126 days)");
    expect(campusCaption("hall")).toBe("0 banners · 1 shipped in 7d");
    // A shipped row with no merge time turns the count into a floor.
    await loadCampusWith({ outcomes: { ...OUTCOMES, outcomes: [...OUTCOMES.outcomes, { ...OUTCOMES.outcomes[0], sessionId: "b", evidenceAt: null }] } });
    expect(campusCaption("hall")).toBe("banners: no data · ≥1 shipped in 7d");
  });

  it("prefers-reduced-motion: banners hang still; otherwise they sway (in place, same instances)", async () => {
    await loadCampus(4);
    paintCampus(q, NOW);
    const before = Float32Array.from(q.campus.banners.instanceMatrix.array);
    swayBanners(q, 2.5, true);
    expect(Array.from(q.campus.banners.instanceMatrix.array)).toEqual(Array.from(before));
    swayBanners(q, 2.5, false);
    expect(Array.from(q.campus.banners.instanceMatrix.array)).not.toEqual(Array.from(before));
    expect(q.campus.banners.count).toBe(4);
  });

  it("clicking the Hall picks the campus label (the Explain card's target)", async () => {
    await loadCampus(0);
    paintCampus(q, NOW);
    const hall = q.campus.top.get("hall");
    expect(hall).toBeDefined();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
    camera.position.copy(hall!).setLength(hall!.length() + 20);
    camera.lookAt(hall!.clone().setLength(hall!.length() - 3));
    camera.updateMatrixWorld();
    // The registry buildQuarter registered its proxies on (the scene bus's), with its own resolver.
    const hit = sceneParts().pick?.pick(new THREE.Vector2(0, 0), camera, 50.5);
    expect(hit).toEqual({ kind: "system", id: "Campus · Graduates' Hall" });
    expect(campusForLabel("Campus · Graduates' Hall")).toBe("hall");
    const school = q.campus.top.get("school")!;
    camera.position.copy(school).setLength(school.length() + 20);
    camera.lookAt(school.clone().setLength(school.length() - 3));
    camera.updateMatrixWorld();
    expect(sceneParts().pick?.pick(new THREE.Vector2(0, 0), camera, 50.5)).toEqual({ kind: "system", id: "Campus · School" });
  });
});

describe("campus data: no renderer, no WebGL (the 2D-only boot runs exactly this)", () => {
  afterEach(() => resetCampusDataForTest());

  it("paintCampus with no quarter (WebGL off: nothing built) is a clean no-op that still computes what cards show", async () => {
    await loadCampus(2);
    expect(() => paintCampus(null, NOW)).not.toThrow();
    expect(currentBanners()).toEqual({ shown: 2, unshown: 0 });
    expect(currentLamp().state).toBe("dim");
  });

  it("loads the three sources from their real shapes; trusted keys are exactly the trusted workers", async () => {
    await loadCampus(2);
    const d = campusData();
    expect(d.careers?.workers).toHaveLength(5);
    expect([...trustedWorkerKeys()].sort()).toEqual(["/trusted-0", "/trusted-1"]);
    expect(d.institute?.block.study.stats?.lastDraftAt).toBe("2026-05-24T14:53:50.000Z");
    expect(d.shipped).toMatchObject({ count: 1, undated: 0 });
  });

  it("no data means no banners and 'no data', never zeros: a failed or malformed answer stays null", async () => {
    resetCampusDataForTest();
    startCampusData(fakeCtx({ "/api/careers": { ok: false }, "/api/skills/snapshot": null }));
    await settle();
    expect(campusData()).toEqual({ careers: null, institute: null, shipped: null });
    paintCampus(null, NOW);
    expect(currentBanners()).toBeNull();
    expect(currentLamp().state).toBe("unknown");
    expect(campusCaption("hall")).toBe("banners: no data · shipped: no data");
  });

  it("a later failed fetch keeps the last good data; a throttled refresh doesn't ask again", async () => {
    let asked = 0;
    let answer: unknown = careers(1);
    resetCampusDataForTest();
    startCampusData({ api: { getJson: (p: string) => (p === "/api/careers" ? (asked++, Promise.resolve(answer)) : Promise.resolve(null)) } } as unknown as ClientContext);
    await settle();
    expect(asked).toBe(1);
    answer = null;
    refreshCampus("careers");
    await settle();
    expect(asked).toBe(2);
    expect([...trustedWorkerKeys()]).toEqual(["/trusted-0"]);
    refreshCampus("careers", 60_000);
    await settle();
    expect(asked).toBe(2);
  });

  it("re-reads the workers when the careers summary moves: a WS push (careers.ts) or a new snapshot extra", async () => {
    let asked = 0;
    resetCampusDataForTest();
    const ctx = { api: { getJson: (p: string) => (p === "/api/careers" ? (asked++, Promise.resolve(careers(1))) : Promise.resolve(null)) } } as unknown as ClientContext;
    startCampusData(ctx);
    await settle();
    expect(asked).toBe(1);
    const summary = { trusted: 1, probation: 0, enrolled: 0, lapsed: 3, returned: 0, retired: 0, total: 4 };
    careersFeature.onMessage?.({ type: "feature", feature: "careers", payload: { kind: "summary", summary } }, ctx);
    await settle();
    expect(asked).toBe(2);
    careersFeature.onMessage?.({ type: "feature", feature: "careers", payload: { kind: "summary", summary: { bogus: 1 } } }, ctx);
    await settle();
    expect(asked).toBe(2);
    const world = (s: typeof summary): Parameters<typeof campusSnapshot>[0] => ({ extras: { "careers.summary": s } }) as unknown as Parameters<typeof campusSnapshot>[0];
    campusSnapshot(world(summary)); // the first one seen is the baseline: the mount already fetched
    await settle();
    expect(asked).toBe(2);
    campusSnapshot(world({ ...summary, trusted: 2, lapsed: 2 }));
    await settle();
    expect(asked).toBe(3);
  });

  it("a card's change listener that runs before paintCampus's still reads the new numbers (no cached copy)", async () => {
    resetCampusDataForTest();
    const seen: Array<number | null> = [];
    onCampusChange(() => seen.push(currentBanners()?.shown ?? null)); // registered first, as explain could be
    startCampusData(fakeCtx({ "/api/careers": careers(3) }));
    await settle();
    expect(seen).toEqual([3]);
  });

  it("outcomes pushes re-read the merge times at most once a minute, always after the latest push", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      resetCampusDataForTest();
      startCampusData({ api: { getJson: (p: string) => (p === "/api/outcomes" ? (asked++, Promise.resolve(OUTCOMES)) : Promise.resolve(null)) } } as unknown as ClientContext);
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(1); // the mount's read
      const push = (): void => outcomesFeature.onMessage?.({ type: "feature", feature: "outcomes", payload: { kind: "map", map: {} } }, {} as ClientContext);
      push();
      push();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(asked).toBe(2); // one trailing read for both pushes
      push();
      await vi.advanceTimersByTimeAsync(5_500);
      expect(asked).toBe(2); // still inside the minute
      await vi.advanceTimersByTimeAsync(60_000);
      expect(asked).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a push that lands while its source is in flight is re-run once that fetch ends (never dropped)", async () => {
    const pending: Array<(v: unknown) => void> = [];
    resetCampusDataForTest();
    startCampusData({ api: { getJson: (p: string) => (p === "/api/careers" ? new Promise((r) => pending.push(r)) : Promise.resolve(null)) } } as unknown as ClientContext);
    expect(pending).toHaveLength(1);
    refreshCampus("careers"); // a push while the mount's read is in flight
    refreshCampus("careers", 30_000); // a card's throttled freshness check: never queues
    expect(pending).toHaveLength(1);
    pending[0]!(careers(0)); // the old answer
    await settle();
    expect(pending).toHaveLength(2); // asked again after it landed
    pending[1]!(careers(2));
    await settle();
    expect([...trustedWorkerKeys()].sort()).toEqual(["/trusted-0", "/trusted-1"]);
  });

  it("the open Tower panel's answer is handed over: a push costs one GET /api/careers, not two", async () => {
    let asked = 0;
    resetCampusDataForTest();
    startCampusData({ api: { getJson: (p: string) => (p === "/api/careers" ? (asked++, Promise.resolve(careers(0))) : Promise.resolve(null)) } } as unknown as ClientContext);
    await settle();
    expect(asked).toBe(1);
    offerCareers(careers(4)); // what careers.ts's load() fetched for the panel
    expect(trustedWorkerKeys().size).toBe(4);
    expect(asked).toBe(1);
    offerCareers({ ok: false }); // a failed panel read keeps the last good data
    offerCareers(null);
    expect(trustedWorkerKeys().size).toBe(4);
  });
});

// ---------------------------------------------------------------- the Clinic (vision wave 4)

/** A served case (GET /api/sickness shape). */
function sickCase(id: string, sessionId: string, state: SicknessCase["state"], kind: SicknessCase["kind"] = "broken-build"): SicknessCase {
  return {
    id,
    kind,
    state,
    sessionId,
    subagentId: null,
    lineage: null,
    district: "agent-world",
    label: "npm test failing",
    source: { tool: "Bash", target: "npm test" },
    detail: { cmdClass: "npm test" },
    firstSeenAt: "2026-09-28T09:00:00.000Z",
    lastSeenAt: "2026-09-28T10:00:00.000Z",
    occurrences: 1,
    healedAt: state === "healed" ? "2026-09-28T10:00:00.000Z" : null,
    treatment: null,
  };
}

/** `n` houses spread over the whole planet (roofs at the house-top height), like the live world's. */
function houses(n: number): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    out.set(`s${i}`, new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(51.3));
  }
  return out;
}

/** The Clinic's view with the full list loaded: `sick` of the houses have an open (or chronic) case. */
function viewWith(cases: readonly SicknessCase[]): ClinicView {
  return { counts: null, sick: openEntries(cases, SICKNESS_OPEN_CAP), source: "cases", today: null };
}

describe("the Clinic in the System Quarter: draw calls, marks and the lamp (three's WebGLRenderer on a stub context)", () => {
  let q: Quarter;
  let homes: Map<string, THREE.Vector3>;
  const at = (id: string): THREE.Vector3 | undefined => homes.get(id);
  beforeEach(async () => {
    registerSceneParts({ layout: [HARNESS] });
    new PickRegistry();
    q = buildQuarter(HARNESS, {} as ClientContext);
    homes = houses(277); // the live world's 277 houses on 2026-09-28
    await loadCampus(0);
    paintCampus(q, NOW);
  });
  afterEach(() => resetCampusDataForTest());

  it("adds no mesh: the Clinic is merged into the quarter mesh, its lamp and every mark are orb instances", () => {
    expect(q.group.children.map((c) => c.name)).toEqual(["system-quarter-places", "system-quarter-orbs", "system-couriers", "campus-banners", "system-quarter-pick"]);
    expect(PLACE_IDS as readonly string[]).not.toContain("clinic");
    expect(q.clinic.lamp.index).toBe(14);
    expect(q.clinic.markBase).toBe(15);
    expect(q.orbs.instanceMatrix.count).toBe(15 + MAX_MARKS); // capacity fixed at build: nothing is rebuilt later
  });

  it("the real 2026-09-28 shape: 64 sick cases in 27 sessions give exactly 27 marks, and the draw calls stay 2 (3 with a courier)", () => {
    const cases: SicknessCase[] = [];
    for (let i = 0; i < 27; i++) cases.push(sickCase(`bb:${i}a`, `s${i * 10}`, i < 8 ? "chronic" : "open"), sickCase(`bb:${i}b`, `s${i * 10}`, "open"));
    for (let i = 0; i < 10; i++) cases.push(sickCase(`lk:${i}`, `s${i * 10}`, "open", "leaked-key")); // 27×2 + 10 = 64 sick cases
    for (let i = 0; i < 208; i++) cases.push(sickCase(`h:${i}`, `s${(i % 250) + 1}`, "healed")); // healed history marks nobody
    const view = viewWith(cases);
    const { scene, camera } = sceneWith(q);
    expect(calls(scene, camera)).toBe(2);
    paintClinic(q, view, at);
    expect(q.orbs.count - q.clinic.markBase).toBe(27);
    const sickSessions = new Set(cases.filter((c) => c.state === "open" || c.state === "chronic").map((c) => c.sessionId));
    expect(q.orbs.count - q.clinic.markBase).toBe(sickSessions.size); // MEASURE: marks = sick sessions with a house
    expect(calls(scene, camera)).toBe(2);
    q.couriers.count = 1;
    q.couriers.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 52, 20));
    expect(calls(scene, camera)).toBe(3);
  });

  it("300 sick houses (the cap) still draw in the same orb call", () => {
    const cases = [...homes.keys()].slice(0, 300).map((id, i) => sickCase(`c${i}`, id, "open"));
    paintClinic(q, viewWith(cases), at);
    expect(q.orbs.count - q.clinic.markBase).toBe(277); // every house that exists; the rest have none
    const { scene, camera } = sceneWith(q);
    expect(calls(scene, camera)).toBe(2);
  });

  it("a mark only where a case exists: each hangs over its own sick house, and a heal takes it down", () => {
    const cases = [sickCase("a", "s3", "chronic"), sickCase("b", "s40", "open"), sickCase("c", "s40", "open"), sickCase("d", "s77", "healed"), sickCase("e", "s500", "open")];
    paintClinic(q, viewWith(cases), at);
    expect(q.orbs.count - q.clinic.markBase).toBe(2); // s77 healed; s500 has no house on the planet
    expect(currentClinicMarks(viewWith(cases), at)).toMatchObject({ unplaced: 1, unshown: 0 });
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const expectOver = (i: number, id: string, color: number): void => {
      q.orbs.getMatrixAt(q.clinic.markBase + i, m);
      p.setFromMatrixPosition(m);
      const roof = homes.get(id)!;
      expect(p.distanceTo(roof.clone().setLength(roof.length() + 0.5))).toBeLessThan(1e-4);
      q.orbs.getColorAt(q.clinic.markBase + i, c);
      expect(c.getHex()).toBe(color);
    };
    expectOver(0, "s3", 0xc1121f); // chronic: dark red, worst first
    expectOver(1, "s40", 0xff3b3b); // open: red
    const healed = cases.map((x) => (x.sessionId === "s3" ? { ...x, state: "healed" as const } : x));
    paintClinic(q, viewWith(healed), at);
    expect(q.orbs.count - q.clinic.markBase).toBe(1);
    expectOver(0, "s40", 0xff3b3b);
    paintClinic(q, viewWith([]), at);
    expect(q.orbs.count).toBe(q.clinic.markBase);
  });

  it("the lamp: lit (red, larger) while any case is sick, dark with none, grey with no data", () => {
    const c = new THREE.Color();
    const scale = (): number => {
      const m = new THREE.Matrix4();
      q.orbs.getMatrixAt(q.clinic.lamp.index, m);
      return new THREE.Vector3().setFromMatrixScale(m).x;
    };
    const none: ClinicView = { counts: null, sick: null, source: null, today: null };
    paintClinic(q, none, at);
    q.orbs.getColorAt(q.clinic.lamp.index, c);
    expect(c.getHex()).toBe(0xcfc8dd);
    expect(currentClinicLamp(none).state).toBe("unknown");
    expect(clinicCaption(none)).toBe("lamp: no data");
    paintClinic(q, viewWith([sickCase("h", "s1", "healed")]), at);
    q.orbs.getColorAt(q.clinic.lamp.index, c);
    expect(c.getHex()).toBe(0x8d93a8);
    const dark = scale();
    const sick = viewWith([sickCase("o", "s1", "open")]);
    paintClinic(q, sick, at);
    q.orbs.getColorAt(q.clinic.lamp.index, c);
    expect(c.getHex()).toBe(0xff4d6d);
    expect(scale()).toBeGreaterThan(dark);
    expect(clinicCaption(sick)).toBe("lamp lit: 1 sick session");
  });

  it("never rebuilds or moves: same meshes and geometry, the quarter's own orbs untouched, houses untouched", () => {
    const mesh = q.group.children[0] as THREE.Mesh;
    const geometry = mesh.geometry;
    const orbs = q.orbs;
    const m = new THREE.Matrix4();
    const quarterOrbs = (): number[] => Array.from({ length: 13 }, (_, i) => (orbs.getMatrixAt(i, m), m.elements.slice())).flat();
    const before = quarterOrbs();
    const roofs = [...homes.values()].map((v) => v.clone());
    paintClinic(q, viewWith([sickCase("a", "s1", "open"), sickCase("b", "s2", "chronic")]), at);
    paintClinic(q, viewWith([sickCase("a", "s1", "healed")]), at);
    expect(q.group.children[0]).toBe(mesh);
    expect(mesh.geometry).toBe(geometry);
    expect(q.orbs).toBe(orbs);
    expect(quarterOrbs()).toEqual(before);
    expect([...homes.values()].every((v, i) => v.equals(roofs[i]!))).toBe(true);
  });

  it("a house that moves (an AUTO lot, #22) carries its mark on the next paint", () => {
    const view = viewWith([sickCase("a", "s5", "open")]);
    paintClinic(q, view, at);
    homes.set("s5", homes.get("s6")!.clone());
    paintClinic(q, view, at);
    const m = new THREE.Matrix4();
    q.orbs.getMatrixAt(q.clinic.markBase, m);
    const roof = homes.get("s5")!;
    expect(new THREE.Vector3().setFromMatrixPosition(m).distanceTo(roof.clone().setLength(roof.length() + 0.5))).toBeLessThan(1e-4);
  });

  it("a mark on the far side of the planet is not culled with the quarter's old bounding sphere", () => {
    const { scene, camera } = sceneWith(q);
    expect(calls(scene, camera)).toBe(2); // bounding spheres computed around the quarter alone
    // One sick house on the planet's far side from the quarter (which sits near +y).
    homes.set("far", new THREE.Vector3(0, -51.3, 0));
    paintClinic(q, viewWith([sickCase("x", "far", "open")]), at);
    // Side-on to the mark, looking along -x: the quarter (around +y) is ~45° off axis, out of view.
    const side = new THREE.PerspectiveCamera(20, 800 / 600, 1, 1000);
    side.position.set(100, -51.3, 0);
    side.lookAt(0, -51.3, 0);
    expect(calls(scene, side)).toBe(1); // the orb mesh, for the mark alone
    q.orbs.boundingSphere = null;
    q.orbs.computeBoundingSphere();
    expect(q.orbs.boundingSphere!.containsPoint(new THREE.Vector3(0, -51.8, 0))).toBe(true);
  });

  it("'Hide on the planet → System' hides the Clinic and its marks with the quarter: 0 calls", () => {
    paintClinic(q, viewWith([sickCase("a", "s1", "open")]), at);
    const { scene, system, camera } = sceneWith(q);
    system.visible = false;
    expect(calls(scene, camera)).toBe(0);
  });

  it("clicking the Clinic picks its label (the Explain card's target)", () => {
    const top = q.clinic.top;
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
    camera.position.copy(top).setLength(top.length() + 20);
    camera.lookAt(top.clone().setLength(top.length() - 3));
    camera.updateMatrixWorld();
    const hit = sceneParts().pick?.pick(new THREE.Vector2(0, 0), camera, 50.5);
    expect(hit).toEqual({ kind: "system", id: "System Quarter · Clinic" });
    expect(isClinicLabel("System Quarter · Clinic")).toBe(true);
    expect(isClinicLabel("Campus · School")).toBe(false);
  });

  it("no quarter (no Harness City, or the tests' null): paintClinic is a clean no-op and nothing counts as drawn", () => {
    expect(() => paintClinic(null, viewWith([sickCase("a", "s1", "open")]), at)).not.toThrow();
    expect(currentClinicMarks(viewWith([sickCase("a", "s1", "open")]), at).drawn).toBe(false);
  });
});
