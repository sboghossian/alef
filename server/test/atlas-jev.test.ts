import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasResponse } from "../../shared/features/atlas.js";
import type { FetchLike } from "../director.js";
import { createAtlasFeature, type AtlasFeatureDeps } from "../features/atlas.js";
import { createAtlasJev, type AtlasJev, type AtlasJevOptions } from "../features/atlas-jev.js";
import { buildJevBody, JEV_MAX_ATTEMPTS, jevFiled, jevKey, parseJevAnswers, parseJevCache, type JevAsk } from "../features/atlas-jev-lib.js";
import { DEPARTMENTS } from "../features/atlas-lib.js";
import type { RunningServer } from "../index.js";
import { log } from "../log.js";
import { bootTestServer } from "./helpers.js";

/** Root reads and writes through chmod 000/444 (a container, CI as root): those cases can't fail there. */
const AS_ROOT = process.getuid?.() === 0;

const quiet = { info: (): void => undefined, warn: (): void => undefined };
const ask = (name: string, description = ""): JevAsk => ({ name, description });

/** A fake TypeSafe endpoint: answers each question from `pick(name)`, records every body. */
function fakeJev(pick: (a: JevAsk) => { choice: string; confidence: number } | null): { fetchImpl: FetchLike; bodies: { state: { leaves: Record<string, JevAsk> }; questions: Record<string, { criteria: Record<string, string> }> }[] } {
  const bodies: { state: { leaves: Record<string, JevAsk> }; questions: Record<string, { criteria: Record<string, string> }> }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const [q, leaf] of Object.entries(body.state.leaves)) {
      const a = pick(leaf);
      if (a) answers[q] = { choice: a.choice, confidence: a.confidence, probabilities: { [a.choice]: a.confidence } };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  return { fetchImpl, bodies };
}

async function filer(over: Partial<AtlasJevOptions> = {}): Promise<{ jev: AtlasJev; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-jev-"));
  const path = join(dir, "atlas-jev.json");
  const jev = createAtlasJev({ path, apiKey: () => "test-key", log: quiet, ...over });
  await jev.load();
  return { jev, path };
}

describe("atlas-jev-lib", () => {
  it("the 0.60 threshold, judged on the number shown", () => {
    expect(jevFiled({ kind: "answer", dept: "build-ship", confidence: 0.84 })).toEqual({ dept: "build-ship", via: "jev", reason: "Jev 0.84" });
    expect(jevFiled({ kind: "answer", dept: "build-ship", confidence: 0.6 })).toMatchObject({ dept: "build-ship", reason: "Jev 0.60" });
    expect(jevFiled({ kind: "answer", dept: "build-ship", confidence: 0.596 })).toMatchObject({ dept: "build-ship", reason: "Jev 0.60" }); // never "unsure (0.60)"
    expect(jevFiled({ kind: "answer", dept: "build-ship", confidence: 0.594 })).toEqual({ dept: "unfiled", via: "unfiled", reason: "Jev unsure (0.59)" });
    expect(jevFiled({ kind: "answer", dept: "brain-vault", confidence: 0.42 })).toMatchObject({ dept: "unfiled", reason: "Jev unsure (0.42)" });
    expect(jevFiled({ kind: "answer", dept: null, confidence: 0 })).toMatchObject({ dept: "unfiled", reason: "Jev unsure (no answer)" });
    expect(jevFiled({ kind: "pending" }).reason).toBe("Jev pending");
    expect(jevFiled({ kind: "unavailable" }).reason).toBe("Jev unavailable");
  });

  it("one batched Choice call: name + description only in state, the 8 departments as criteria (never Unfiled)", () => {
    const { body, keys } = buildJevBody([ask("zeta", "does z"), ask("eta")], DEPARTMENTS);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ leaves: { l0: { name: "zeta", description: "does z" }, l1: { name: "eta", description: "" } } });
    const q = (body.questions as Record<string, { type: string; criteria: Record<string, string> }>).l0!;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual(["acme-gtm", "acme-website", "brain-vault", "build-ship", "infra", "research-studio", "rituals", "side-projects"]);
    expect([...keys]).toEqual([["l0", 0], ["l1", 1]]);
  });

  it("answers: unknown departments, 'unfiled' and malformed ones are dropped, a confidence outside [0, 1] included (review L1)", () => {
    const keys = new Map([["l0", 0], ["l1", 1], ["l2", 2], ["l3", 3], ["l4", 4], ["l5", 5], ["l6", 6]]);
    const raw = {
      answers: {
        l0: { choice: "build-ship", confidence: 0.9, probabilities: {} },
        l1: { choice: "unfiled", confidence: 0.9, probabilities: {} },
        l2: { choice: "made-up", confidence: 0.9, probabilities: {} },
        l3: { choice: "infra" },
        l4: { choice: "infra", confidence: 7, probabilities: {} },
        l5: { choice: "infra", confidence: -0.1, probabilities: {} },
        l6: { choice: "infra", confidence: 1, probabilities: {} },
      },
    };
    expect([...parseJevAnswers(raw, keys)]).toEqual([[0, { dept: "build-ship", confidence: 0.9 }], [6, { dept: "infra", confidence: 1 }]]);
    for (const bad of [null, "x", { answers: null }, { answers: [] }]) expect(parseJevAnswers(bad, keys).size).toBe(0);
  });

  it("the cache key follows name and description; a malformed cache file reads as empty", () => {
    expect(jevKey(ask("a", "x"))).toBe(jevKey(ask("a", "x")));
    expect(jevKey(ask("a", "x"))).not.toBe(jevKey(ask("a", "y")));
    for (const bad of [null, [], { version: 2 }, "{"]) expect(parseJevCache(bad).entries).toEqual({});
    const mixed = parseJevCache({ version: 1, entries: { k1: { name: "a", dept: "infra", confidence: 0.7, at: "t" }, k2: { name: "b", dept: "nope", confidence: 1, at: "t" }, k3: { name: "c", dept: null, confidence: 0, at: "t" }, k4: "x" }, attempts: { k5: 2, k6: -1 }, retryAt: 5 });
    expect(Object.keys(mixed.entries)).toEqual(["k1", "k3"]);
    expect(mixed.attempts).toEqual({ k5: 2 });
    expect(mixed.retryAt).toBe(5);
  });
});

describe("atlas-jev filer (mocked TypeSafe)", () => {
  it("asks once, then answers from the cache: no second call, and a new filer on the same file makes none either", async () => {
    const fake = fakeJev((a) => (a.name === "zeta" ? { choice: "build-ship", confidence: 0.84 } : { choice: "brain-vault", confidence: 0.42 }));
    const { jev, path } = await filer({ fetchImpl: fake.fetchImpl });
    const asks = [ask("zeta", "z"), ask("eta", "e")];
    expect(jev.lookup(asks[0]!)).toEqual({ kind: "pending" });
    jev.request(asks);
    await jev.idle();
    expect(jev.lookup(asks[0]!)).toEqual({ kind: "answer", dept: "build-ship", confidence: 0.84 });
    expect(jevFiled(jev.lookup(asks[1]!)).reason).toBe("Jev unsure (0.42)"); // cached too: never re-asked
    jev.request(asks);
    await jev.idle();
    expect(fake.bodies).toHaveLength(1);
    expect(jev.stats).toEqual({ calls: 1, asked: 2 });

    const again = createAtlasJev({ path, apiKey: () => "test-key", fetchImpl: fake.fetchImpl, log: quiet });
    await again.load();
    again.request(asks);
    await again.idle();
    expect(again.lookup(asks[0]!)).toMatchObject({ kind: "answer", dept: "build-ship" });
    expect(fake.bodies).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("an edited description is asked again (new key)", async () => {
    const fake = fakeJev(() => ({ choice: "infra", confidence: 0.9 }));
    const { jev } = await filer({ fetchImpl: fake.fetchImpl });
    jev.request([ask("zeta", "old")]);
    await jev.idle();
    expect(jev.lookup(ask("zeta", "new"))).toEqual({ kind: "pending" });
    jev.request([ask("zeta", "new")]);
    await jev.idle();
    expect(fake.bodies).toHaveLength(2);
  });

  it("at most perBuild leaves per call, one call at a time; the rest stay pending for the next build", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fake = fakeJev(() => ({ choice: "research-studio", confidence: 0.7 }));
    const slow: FetchLike = async (u, i) => (await gate, fake.fetchImpl(u, i));
    const { jev } = await filer({ fetchImpl: slow, perBuild: 20 });
    const asks = Array.from({ length: 25 }, (_, i) => ask(`leaf-${i}`));
    jev.request(asks);
    jev.request(asks); // a second build while the first call runs: no second call
    release();
    await jev.idle();
    expect(fake.bodies).toHaveLength(1);
    expect(Object.keys(fake.bodies[0]!.questions)).toHaveLength(20);
    expect(jev.lookup(asks[19]!).kind).toBe("answer");
    expect(jev.lookup(asks[20]!)).toEqual({ kind: "pending" });
    jev.request(asks);
    await jev.idle();
    expect(fake.bodies.map((b) => Object.keys(b.questions).length)).toEqual([20, 5]);
    expect(asks.every((a) => jev.lookup(a).kind === "answer")).toBe(true);
  });

  it("throwing, non-200 or no key: 'Jev unavailable', no retry before it is due, never a throw", async () => {
    let now = 1_000;
    let calls = 0;
    const boom: FetchLike = async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    };
    const { jev } = await filer({ fetchImpl: boom, now: () => now, retryMs: 60_000 });
    expect(() => jev.request([ask("zeta")])).not.toThrow();
    await jev.idle();
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "unavailable" });
    jev.request([ask("zeta")]);
    await jev.idle();
    expect(calls).toBe(1); // backing off
    now += 60_000;
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "pending" });
    jev.request([ask("zeta")]);
    await jev.idle();
    expect(calls).toBe(2);

    const down: FetchLike = async () => new Response("no", { status: 503 });
    const d = await filer({ fetchImpl: down });
    d.jev.request([ask("zeta")]);
    await d.jev.idle();
    expect(d.jev.lookup(ask("zeta"))).toEqual({ kind: "unavailable" });

    let keyless = 0;
    const k = await filer({ apiKey: () => "", fetchImpl: async () => (keyless++, new Response("{}")) });
    expect(k.jev.lookup(ask("zeta"))).toEqual({ kind: "unavailable" });
    k.jev.request([ask("zeta")]);
    await k.jev.idle();
    expect(keyless).toBe(0);
  });

  it(`a leaf Jev never answers is settled as "no answer" after ${JEV_MAX_ATTEMPTS} attempts, then never asked again`, async () => {
    let now = 0;
    const fake = fakeJev((a) => (a.name === "odd" ? null : { choice: "infra", confidence: 0.9 }));
    const { jev } = await filer({ fetchImpl: fake.fetchImpl, now: () => now, retryMs: 10 });
    for (let i = 0; i < JEV_MAX_ATTEMPTS; i++) {
      jev.request([ask("fine"), ask("odd")].slice(i === 0 ? 0 : 1));
      await jev.idle();
      now += 100; // an all-empty answer backs off; step past it
    }
    expect(jevFiled(jev.lookup(ask("odd"))).reason).toBe("Jev unsure (no answer)");
    const before = fake.bodies.length;
    jev.request([ask("odd")]);
    await jev.idle();
    expect(fake.bodies).toHaveLength(before);
  });

  it("prune drops verdicts and attempt counts of leaves that no longer exist, and saves only when it dropped some", async () => {
    let now = 0;
    const fake = fakeJev((a) => (a.name === "odd" ? null : { choice: "infra", confidence: 0.9 }));
    const { jev, path } = await filer({ fetchImpl: fake.fetchImpl, now: () => now, retryMs: 1 });
    jev.request([ask("keep"), ask("gone"), ask("odd")]);
    await jev.idle();
    const keep = new Set([jevKey(ask("keep"))]);
    expect(jev.prune(keep)).toBe(2); // "gone"'s verdict + "odd"'s attempt count
    await jev.idle();
    const saved = parseJevCache(JSON.parse(await readFile(path, "utf8")) as unknown);
    expect(Object.values(saved.entries).map((e) => e.name)).toEqual(["keep"]);
    expect(saved.attempts).toEqual({});
    expect(jev.lookup(ask("gone"))).toEqual({ kind: "pending" }); // back: it would be asked again
    expect(jev.prune(keep)).toBe(0);
    now += 10;
  });

  it("a torn cache file is kept aside and the cache starts empty instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-torn-"));
    await writeFile(join(dir, "atlas-jev.json"), '{"version":1,"entries":{');
    const jev = createAtlasJev({ path: join(dir, "atlas-jev.json"), apiKey: () => "k", log: quiet, now: () => 42 });
    await expect(jev.load()).resolves.toBeUndefined();
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "pending" });
    expect(await readFile(join(dir, "atlas-jev.json.corrupt-42-0"), "utf8")).toBe('{"version":1,"entries":{');
  });

  it("set-aside copies never overwrite each other in one millisecond, and only the 3 newest are kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-aside-"));
    const path = join(dir, "atlas-jev.json");
    await writeFile(`${path}.corrupt-1-0`, "oldest");
    await writeFile(`${path}.v2-2-0`, "old");
    await writeFile(`${path}.unrelated-9-9`, "not ours"); // other names are never touched
    for (const body of ["torn one", "torn two"]) {
      await writeFile(path, body);
      const jev = createAtlasJev({ path, apiKey: () => "k", log: quiet, now: () => 42 }); // a fresh filer, same millisecond
      await jev.load();
    }
    await writeFile(path, "torn three");
    const same = createAtlasJev({ path, apiKey: () => "k", log: quiet, now: () => 43 });
    await same.load();
    const left = (await readdir(dir)).filter((n) => n !== "atlas-jev.json").sort();
    expect(left).toEqual(["atlas-jev.json.corrupt-42-0", "atlas-jev.json.corrupt-42-1", "atlas-jev.json.corrupt-43-0", "atlas-jev.json.unrelated-9-9"]);
    expect(await readFile(`${path}.corrupt-42-0`, "utf8")).toBe("torn one");
    expect(await readFile(`${path}.corrupt-42-1`, "utf8")).toBe("torn two");
  });

  it("another version's cache (or JSON that isn't a cache) is set aside, not silently dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-ver-"));
    const path = join(dir, "atlas-jev.json");
    const v2 = JSON.stringify({ version: 2, entries: { k: { name: "x" } } });
    await writeFile(path, v2);
    const warns: string[] = [];
    const jev = createAtlasJev({ path, apiKey: () => "k", log: { info: () => undefined, warn: (_s, m) => void warns.push(m) }, now: () => 7 });
    await jev.load();
    expect(await readFile(`${path}.v2-7-0`, "utf8")).toBe(v2);
    expect(warns).toEqual(["jev cache is version 2: kept as atlas-jev.json.v2-7-0, starting empty"]);
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "pending" }); // fresh and usable
    await writeFile(path, "[1,2]");
    const arr = createAtlasJev({ path, apiKey: () => "k", log: quiet, now: () => 8 });
    await arr.load();
    expect(await readFile(`${path}.corrupt-8-0`, "utf8")).toBe("[1,2]");
  });

  it.skipIf(AS_ROOT)("an unreadable cache (not ENOENT) leaves Jev off: nothing asked, pruned or saved until a read succeeds (review L2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-locked-"));
    const path = join(dir, "atlas-jev.json");
    const good = { version: 1, entries: { [jevKey(ask("kept"))]: { name: "kept", dept: "infra", confidence: 0.9, at: "t" } }, attempts: {}, retryAt: 0 };
    await writeFile(path, JSON.stringify(good));
    await chmod(path, 0o000);
    const fake = fakeJev(() => ({ choice: "build-ship", confidence: 0.9 }));
    const warns: string[] = [];
    const jev = createAtlasJev({ path, apiKey: () => "k", fetchImpl: fake.fetchImpl, log: { info: () => undefined, warn: (_s, m) => void warns.push(m) } });
    await jev.load();
    expect(warns.some((m) => m.includes("unreadable"))).toBe(true);
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "unavailable" });
    jev.request([ask("zeta")]);
    expect(jev.prune(new Set())).toBe(0);
    await jev.idle();
    expect(fake.bodies).toHaveLength(0);
    await chmod(path, 0o644);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(good); // untouched
    await chmod(path, 0o000);
    await jev.load();
    await jev.load(); // more builds while it stays unreadable: still one warning
    expect(warns.filter((m) => m.includes("unreadable"))).toHaveLength(1);
    await chmod(path, 0o644);
    await jev.load(); // the next build's load retries, and now it reads
    expect(jev.lookup(ask("kept"))).toMatchObject({ kind: "answer", dept: "infra" });
    expect(jev.lookup(ask("zeta"))).toEqual({ kind: "pending" });
  });

  it("saves through a temp file named with the pid (review L4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-pid-"));
    const path = join(dir, "atlas-jev.json");
    await mkdir(`${path}.${process.pid}.tmp`); // block exactly that name: the save must fail on it
    const warns: string[] = [];
    const fake = fakeJev(() => ({ choice: "infra", confidence: 0.9 }));
    const jev = createAtlasJev({ path, apiKey: () => "k", fetchImpl: fake.fetchImpl, log: { info: () => undefined, warn: (_s, m) => void warns.push(m) } });
    await jev.load();
    jev.request([ask("zeta")]);
    await jev.idle();
    expect(warns).toContain("jev cache not saved");
    await expect(readFile(path, "utf8")).rejects.toThrow(/ENOENT/);
    expect(jev.lookup(ask("zeta")).kind).toBe("answer"); // still answered in memory
  });
});

describe("atlas route with Jev: never fails because of Jev", () => {
  const BUNDLE_SECRET = "the orange heron sleeps under bridge nine";
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function home(): Promise<string> {
    const h = await mkdtemp(join(tmpdir(), "atlas-jev-home-"));
    const memory = join(h, ".claude", "projects", h.replace(/[\\/]/g, "-"), "memory", "_L2");
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, "infra-claude-system.md"), `${BUNDLE_SECRET}: /mystery-tool is fine`);
    return h;
  }
  const sources: AtlasFeatureDeps["sources"] = {
    skills: async () => ({
      installed: ["mystery-tool", "zeta-thing"].map((slug) => ({ slug, name: slug, description: `${slug} does things`, origin: "user" as const, pluginId: null, path: `/s/${slug}/SKILL.md`, updatedAt: null })),
      usage: [],
      candidates: [],
      historyReady: true,
    }),
    automations: async () => [],
    workers: () => [],
    subagents: () => [],
  };
  const get = async (base: string): Promise<{ status: number; body: AtlasResponse }> => {
    const res = await fetch(`${base}/api/atlas`);
    return { status: res.status, body: (await res.json()) as AtlasResponse };
  };
  /** GETs until `ok` holds (stale-while-revalidate answers one build behind). */
  async function until(base: string, ok: (b: AtlasResponse) => boolean): Promise<AtlasResponse> {
    let last: AtlasResponse | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await get(base);
      expect(r.status).toBe(200);
      last = r.body;
      if (ok(r.body)) return r.body;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`atlas never reached the expected state; last: pending ${JSON.stringify(last?.pending)}, leaves ${JSON.stringify(last?.leaves.map((l) => `${l.name}: ${l.reason}`))}`);
  }
  /** The answer of a build that STARTED after `since` (ms), and then of one more after that one.
   *  A GET answers from the last finished build and rebuilds in the background (ttlMs 0), so a
   *  plain GET after a change can still be the old build, and jev.idle() doesn't wait for builds. */
  async function builtAfter(base: string, since: number): Promise<AtlasResponse> {
    const first = await until(base, (b) => Date.parse(b.at) > since);
    return until(base, (b) => Date.parse(b.at) > Date.parse(first.at));
  }
  const reason = (b: AtlasResponse, name: string): string | undefined => b.leaves.find((l) => l.name === name)?.reason;

  it("Jev answers: pending first ('Jev answers' listed), then filed with its confidence; Jev never sees bundle text", async () => {
    const fake = fakeJev(() => ({ choice: "build-ship", confidence: 0.84 }));
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-data-"));
    const jev = createAtlasJev({ path: join(dir, "atlas-jev.json"), apiKey: () => "test-key", fetchImpl: fake.fetchImpl, log: quiet });
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home: await home(), sources, jev, pendingTtlMs: 0 })] } });
    server = boot.server;
    const first = await get(boot.base);
    expect(first.status).toBe(200);
    expect(reason(first.body, "zeta-thing")).toBe("Jev pending");
    expect(first.body.pending).toContain("Jev answers");
    expect(first.body.leaves.find((l) => l.name === "mystery-tool")).toMatchObject({ dept: "infra", via: "mention" }); // never asked
    await jev.idle();
    const after = await until(boot.base, (b) => reason(b, "zeta-thing") === "Jev 0.84");
    expect(after.leaves.find((l) => l.name === "zeta-thing")).toMatchObject({ dept: "build-ship", via: "jev" });
    expect(after.pending).not.toContain("Jev answers");
    expect(fake.bodies).toHaveLength(1);
    expect(Object.values(fake.bodies[0]!.state.leaves)).toEqual([{ name: "zeta-thing", description: "zeta-thing does things" }]);
    expect(JSON.stringify(fake.bodies)).not.toContain("heron");
  });

  it("Jev throwing: 200 throughout, the leaf reads 'Jev unavailable' and polling stops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-data-"));
    const jev = createAtlasJev({ path: join(dir, "atlas-jev.json"), apiKey: () => "test-key", fetchImpl: async () => Promise.reject(new Error("socket hang up")), log: quiet });
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home: await home(), sources, jev, pendingTtlMs: 0 })] } });
    server = boot.server;
    expect((await get(boot.base)).status).toBe(200);
    await jev.idle();
    const b = await until(boot.base, (x) => reason(x, "zeta-thing") === "Jev unavailable");
    expect(b.pending).toEqual([]);
    expect(b.leaves.find((l) => l.name === "zeta-thing")?.dept).toBe("unfiled");
  });

  it("a complete build prunes verdicts of leaves that are gone; a build with a source pending or failed does not", async () => {
    const fake = fakeJev(() => ({ choice: "build-ship", confidence: 0.84 }));
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-data-"));
    const path = join(dir, "atlas-jev.json");
    const jev = createAtlasJev({ path, apiKey: () => "test-key", fetchImpl: fake.fetchImpl, log: quiet });
    const all = ["zeta-thing", "eta-thing"];
    let slugs = all;
    let workers: ReturnType<NonNullable<NonNullable<AtlasFeatureDeps["sources"]>["workers"]>> = [];
    let skillsFail = false;
    const skillList = async (): Promise<Awaited<ReturnType<NonNullable<NonNullable<AtlasFeatureDeps["sources"]>["skills"]>>>> => {
      if (skillsFail) throw new Error("skills scan broke");
      return { installed: slugs.map((slug) => ({ slug, name: slug, description: "", origin: "user" as const, pluginId: null, path: `/s/${slug}/SKILL.md`, updatedAt: null })), usage: [], candidates: [], historyReady: true };
    };
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home: await home(), sources: { ...sources, skills: skillList, workers: () => workers }, jev, ttlMs: 0, pendingTtlMs: 0 })] } });
    server = boot.server;
    await get(boot.base);
    await jev.idle();
    await until(boot.base, (b) => reason(b, "eta-thing") === "Jev 0.84");
    const names = async (): Promise<string[]> => Object.values(parseJevCache(JSON.parse(await readFile(path, "utf8")) as unknown).entries).map((e) => e.name).sort();
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    // Each step changes one thing, in an order where any build that reads some sources before
    // the change and some after still has a pending or failed source (a build reads skills first,
    // the Tower after): a mixed build must never be a complete one. Then only builds that started
    // after the change are asserted on.
    const step = async (change: () => void): Promise<AtlasResponse> => {
      change();
      const b = await builtAfter(boot.base, Date.now());
      await jev.idle();
      return b;
    };
    let b = await step(() => {
      slugs = ["zeta-thing"];
      workers = null; // Tower still reading: the leaf set is incomplete, so nothing is pruned
    });
    expect(b.pending).toContain("Tower runs");
    expect(b.leaves.map((l) => l.name)).toEqual(["zeta-thing"]);
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    b = await step(() => {
      skillsFail = true; // skills fail first, while the Tower is still pending…
    });
    b = await step(() => {
      workers = []; // …then the Tower is back: only the failed skills scan remains
    });
    expect(b.pending).not.toContain("Tower runs");
    expect(b.leaves).toEqual([]); // (a failed skills scan also reads as "skill history" pending)
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    b = await step(() => {
      skillsFail = false; // complete again, eta-thing is gone for real
    });
    expect(b.pending).toEqual([]);
    expect(await names()).toEqual(["zeta-thing"]);
    expect(fake.bodies).toHaveLength(1);
  });

  it.skipIf(AS_ROOT)("a source that reports a failed read (automations, agents, CLI folder, one cli.json) never prunes; clean reads do (review L5)", async () => {
    const fake = fakeJev(() => ({ choice: "build-ship", confidence: 0.84 }));
    const dir = await mkdtemp(join(tmpdir(), "atlas-jev-data-"));
    const path = join(dir, "atlas-jev.json");
    const jev = createAtlasJev({ path, apiKey: () => "test-key", fetchImpl: fake.fetchImpl, log: quiet });
    let slugs = ["zeta-thing", "eta-thing"];
    let partial = false;
    /** Held while a step changes several things: every build that starts meanwhile has a failed source. */
    let hold = false;
    const h = await home();
    const agents = join(h, ".claude", "agents");
    const clis = join(h, ".claude", "clis");
    const cliJson = join(clis, "fleet-tool", "cli.json");
    await mkdir(agents, { recursive: true });
    await mkdir(join(clis, "fleet-tool"), { recursive: true });
    // a CLI the keyword table files (fleet → Infra): it never needs Jev, so it adds no cache entry
    await writeFile(cliJson, JSON.stringify({ name: "fleet-tool", tool: "t", purpose: "p", entry: "/x.sh", language: "sh", created: "2026-09-30", author: "agent", tests: null }));
    const feature = createAtlasFeature({
      home: h,
      sources: {
        ...sources,
        skills: async () => ({ installed: slugs.map((slug) => ({ slug, name: slug, description: "", origin: "user" as const, pluginId: null, path: `/s/${slug}/SKILL.md`, updatedAt: null })), usage: [], candidates: [], historyReady: true }),
        automations: async (onIncomplete) => ((partial || hold) && onIncomplete?.(), []),
      },
      jev,
      ttlMs: 0,
      pendingTtlMs: 0,
    });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;
    await get(boot.base);
    await jev.idle();
    await until(boot.base, (b) => reason(b, "eta-thing") === "Jev 0.84");
    await builtAfter(boot.base, Date.now());
    await jev.idle();
    const names = async (): Promise<string[]> => Object.values(parseJevCache(JSON.parse(await readFile(path, "utf8")) as unknown).entries).map((e) => e.name).sort();
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);
    /** Makes the change under the hold (a build that starts halfway through can't be a complete
     *  one), then returns once a build that started after it has finished and saved. */
    const after = async (change: () => Promise<void> | void): Promise<AtlasResponse> => {
      hold = true;
      await change();
      hold = false;
      const b = await builtAfter(boot.base, Date.now());
      await jev.idle();
      return b;
    };

    // eta-thing is gone from here on, but each build below has a source that failed to read
    let b = await after(() => {
      slugs = ["zeta-thing"];
      partial = true; // automations says its read was partial
    });
    expect(b.leaves.map((l) => l.name)).not.toContain("eta-thing"); // this build saw the change…
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]); // …and didn't prune

    b = await after(() => {
      partial = false;
      return chmod(agents, 0o000); // agents folder unreadable
    });
    expect(b.leaves.map((l) => l.name)).not.toContain("eta-thing");
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    b = await after(async () => {
      await chmod(agents, 0o755);
      await chmod(clis, 0o000); // the CLI folder unreadable
    });
    expect(b.leaves.map((l) => l.name)).not.toContain("fleet-tool");
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    b = await after(async () => {
      await chmod(clis, 0o755);
      await chmod(cliJson, 0o000); // one cli.json unreadable
    });
    expect(b.leaves.map((l) => l.name)).not.toContain("fleet-tool");
    expect(await names()).toEqual(["eta-thing", "zeta-thing"]);

    b = await after(() => chmod(cliJson, 0o644)); // everything reads again: now it prunes
    expect(b.leaves.map((l) => l.name).sort()).toEqual(["fleet-tool", "zeta-thing"]);
    expect(await names()).toEqual(["zeta-thing"]);
    expect(fake.bodies).toHaveLength(1); // fleet-tool never went to Jev
  });

  it("a failing source is logged when it starts failing and when it reads again, not on every build", async () => {
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    try {
      let partial = true;
      const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home: await home(), sources: { ...sources, automations: async (onIncomplete) => (partial && onIncomplete?.(), []) }, ttlMs: 0, pendingTtlMs: 0 })] } });
      server = boot.server;
      let t = Date.now();
      await get(boot.base);
      await builtAfter(boot.base, t);
      await builtAfter(boot.base, Date.now()); // several builds, all failing
      const failing = (): number => warn.mock.calls.filter((c) => String(c[1]).startsWith("automations: a read failed")).length;
      expect(failing()).toBe(1);
      partial = false;
      t = Date.now();
      await builtAfter(boot.base, t);
      await builtAfter(boot.base, Date.now());
      expect(info.mock.calls.filter((c) => c[1] === "automations: reads again")).toHaveLength(1);
      expect(failing()).toBe(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("no key (the server default in tests): 'Jev unavailable' from the first answer, no call", async () => {
    let calls = 0;
    const boot = await bootTestServer({ configOverrides: { typesafeFetchImpl: async () => (calls++, new Response("{}")), features: [createAtlasFeature({ home: await home(), sources })] } });
    server = boot.server;
    const r = await get(boot.base);
    expect(r.status).toBe(200);
    expect(reason(r.body, "zeta-thing")).toBe("Jev unavailable");
    expect(r.body.pending).toEqual([]);
    expect(calls).toBe(0);
  });
});
