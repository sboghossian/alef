// The governance feed's emit points, each driven the way it happens for real: Jev's ranking and
// Alex's clicks on the president's board, the resident filing / withdrawing a proposal and
// Alex deciding one, and a merge the census sees. Every server-level test boots a real test
// server with the real feed feature and reads GET /api/feed back. Never a real TypeSafe call, a
// real claude, tmux, gh, ~/.alef-resident or ~/.claude: every one of those is stubbed or a temp dir.
// (The council's emit point, and the town log surviving a restart, are in council.test.ts.)

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedItem, FeedResponse } from "../../shared/features/feed.js";
import type { LoopsItem } from "../../shared/features/loops.js";
import type { PresidentBoard } from "../../shared/features/president.js";
import { RESIDENT_SNAPSHOT_KEY, type ResidentState } from "../../shared/features/resident.js";
import type { Island } from "../../shared/types.js";
import { createCensusFeature, MERGE_SEEN_META_KEY } from "../features/census.js";
import { createFeedFeature } from "../features/feed.js";
import type { FeedDraft } from "../features/governance-lib.js";
import { createPresidentFeature, type PresidentFeatureOptions } from "../features/president.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import { createResidentFeature, type ReflectRunner } from "../features/resident.js";
import type { RunningServer } from "../index.js";
import { bootTestServer, makeTempDb, makeTempProjectsDir } from "./helpers.js";

const cleanup: string[] = [];
let server: RunningServer | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

/** The real feed feature, ticking fast so appendToFeed gets its live context quickly. */
function liveFeed(): ServerFeature {
  return createFeedFeature({ tickIntervalMs: 20, sources: { decisions: () => [], approvals: () => [], routines: async () => [] } });
}

async function boot(features: ServerFeature[]): Promise<string> {
  const { base, server: s } = await bootTestServer({ configOverrides: { features } });
  server = s;
  return base;
}

async function feedOf(base: string): Promise<FeedItem[]> {
  return ((await (await fetch(`${base}/api/feed?since=0&limit=500`)).json()) as FeedResponse).items;
}

/** Polls /api/feed until `pick` returns something non-empty (or fails after `ms`). */
async function waitForFeed(base: string, pick: (items: FeedItem[]) => FeedItem[], ms = 4000): Promise<FeedItem[]> {
  const until = Date.now() + ms;
  for (;;) {
    const hits = pick(await feedOf(base));
    if (hits.length) return hits;
    if (Date.now() > until) throw new Error("waitForFeed: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Lets the feed tick a few more times, so an item that should NOT appear has had every chance to. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
}

async function post(base: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const byTag = (tag: string) => (items: FeedItem[]) => items.filter((i) => i.tag === tag);

// ── the president ────────────────────────────────────────────────────────────────────────────

function loopItem(id: string, task: string, launchCwd: string): LoopsItem {
  return { id, task, lens: "do_today", score: 10, launchCwd, project: "p", sources: ["whatsup"], sourceType: "todo_md", updatedAt: null, openPath: null };
}

/** Every president source stubbed (the same stubs president.test.ts uses): no real disk scan,
 *  always-live map, careers, skills, tripwires, talk or outcomes. */
function presidentOpts(over: Partial<PresidentFeatureOptions>): PresidentFeatureOptions {
  return {
    gatherLoopItems: async () => [],
    gatherHealthChecks: async () => [],
    sicknessCases: () => [],
    loadAlwaysLive: async () => ({ ok: true, rules: [] }),
    fetchImpl: async () => {
      throw new Error("network disabled in tests");
    },
    careerWorkers: () => [],
    skillDebuts: async () => ({ ok: false, reason: "tests", historyStartAt: null, debuts: [], descriptions: new Map() }),
    tripwireHits: () => [],
    talkBindings: () => [],
    sessionOutcomes: () => [],
    retireWorker: async () => ({ status: 500, body: { ok: false, error: "no careers feature in this test" } }),
    readRoutinePlist: async () => null,
    ...over,
  };
}

/** A stub TypeSafe endpoint answering the sessions question with fixed probabilities (by c-key). */
function jevAnswering(probabilities: Record<string, number>): { calls: () => number; fetchImpl: PresidentFeatureOptions["fetchImpl"] } {
  let n = 0;
  return {
    calls: () => n,
    fetchImpl: async () => {
      n++;
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      return new Response(JSON.stringify({ answers: { sessions: { choice, probabilities, confidence: 0.9 } } }), { status: 200 });
    },
  };
}

describe("governance feed: the president's board", () => {
  it("Jev's ranking goes out once per change, and each click that took effect once (a repeated launch click is not a second one)", async () => {
    const home = await tempDir("aw-gov-home-");
    const dataDir = await tempDir("aw-gov-data-");
    await mkdir(join(home, "p"), { recursive: true });
    const jev = jevAnswering({ c1: 0.6, c2: 0.3, none: 0.1 });
    const launches: string[] = [];
    const president = createPresidentFeature(
      presidentOpts({
        dataDir,
        homeDir: home,
        apiKey: "test-key",
        fetchImpl: jev.fetchImpl,
        gatherLoopItems: async () => [loopItem("a", "Fix the failing build", join(home, "p")), loopItem("b", "Tidy the docs", join(home, "p"))],
        launcher: async (cwd) => {
          launches.push(cwd);
          return { ok: true, tmuxName: "aw-gov-1" };
        },
      }),
    );
    const base = await boot([liveFeed(), president]);

    const board = (await (await fetch(`${base}/api/president/proposals`)).json()) as PresidentBoard;
    expect(board.source).toBe("jev");
    expect(board.proposals.map((p) => p.id)).toEqual(["loop-a", "loop-b"]);
    const [ranking] = await waitForFeed(base, byTag("gov:jev"));
    expect(ranking).toMatchObject({ kind: "decision", agentId: null, title: "Jev ranked 2 candidates: 2 proposed, p(none) 0.10" });
    expect(ranking!.detail).toContain('"Fix the failing build" p 0.60');

    // Jev ranks again and gives the same board: no new decision, no new item.
    await fetch(`${base}/api/president/refresh`);
    expect(jev.calls()).toBe(2);
    await settle();
    expect(byTag("gov:jev")(await feedOf(base))).toHaveLength(1);

    expect((await post(base, "/api/president/proposals/loop-b/dismiss")).status).toBe(200);
    expect((await post(base, "/api/president/proposals/loop-b/dismiss")).status).toBe(200); // a second Dismiss is not an error, and no second event
    const launch = await post(base, "/api/president/proposals/loop-a/launch");
    expect(launch.status).toBe(200);
    const again = (await (await post(base, "/api/president/proposals/loop-a/launch")).json()) as { reused?: boolean };
    expect(again.reused).toBe(true);
    expect(launches).toHaveLength(1);

    const clicks = await waitForFeed(base, (items) => (byTag("gov:click")(items).length >= 2 ? byTag("gov:click")(items) : []));
    await settle();
    expect(byTag("gov:click")(await feedOf(base))).toHaveLength(2);
    expect(clicks.map((c) => c.title)).toEqual(["Alex dismissed a session proposal from the president's board", "Alex launched a session proposal from the president's board"]);
    expect(clicks[0]!.detail).toContain("Tidy the docs");
    expect(clicks[0]!.detail).toContain("ranked by jev");
    expect(clicks[1]!.detail).toContain("tmux aw-gov-1");

    // Both left the board by click; Jev ranking the (now empty) board again is still no new decision.
    await fetch(`${base}/api/president/refresh`);
    await settle();
    expect(byTag("gov:jev")(await feedOf(base))).toHaveLength(1);
  });

  it("a restart that reloads the same board from president.json is not a new ranking", async () => {
    const dataDir = await tempDir("aw-gov-data-");
    const home = await tempDir("aw-gov-home-");
    await mkdir(join(home, "p"), { recursive: true });
    const opts = presidentOpts({ dataDir, homeDir: home, apiKey: "test-key", fetchImpl: jevAnswering({ c1: 0.7, none: 0.3 }).fetchImpl, gatherLoopItems: async () => [loopItem("a", "Ship it", join(home, "p"))] });
    const first: FeedDraft[] = [];
    const a = createPresidentFeature({ ...opts, feed: (i) => void first.push(i) });
    const ctx = presidentCtx([]);
    await a.routes!.find((r) => r.path === "/api/president/proposals")!.handler({} as IncomingMessage, fakeRes(), ctx, {});
    expect(first.map((i) => i.tag)).toEqual(["gov:jev"]);
    const second: FeedDraft[] = [];
    const b = createPresidentFeature({ ...opts, feed: (i) => void second.push(i) }); // a fresh process on the same data dir
    await b.routes!.find((r) => r.path === "/api/president/proposals")!.handler({} as IncomingMessage, fakeRes(), ctx, {});
    expect(second).toEqual([]);
  });

  it("merge-approve: one item once the merge is written, naming the districts", async () => {
    const dataDir = await tempDir("aw-gov-data-");
    const oldIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const islands: Island[] = [
      { id: "d1", name: "d1", path: "/x", agentCount: 1, lastActive: oldIso },
      { id: "d2", name: "d2", path: "/y", agentCount: 2, lastActive: oldIso },
    ];
    const items: FeedDraft[] = [];
    const f = createPresidentFeature(presidentOpts({ dataDir, feed: (i) => void items.push(i) }));
    const ctx = presidentCtx(islands);
    const board = await json<PresidentBoard>(f, "/api/president/proposals", ctx);
    const merge = board.proposals.find((p) => p.kind === "merge")!;
    expect(items).toEqual([]); // the rules ranked this board: no Jev decision to report
    const res = fakeRes();
    await f.routes!.find((r) => r.path === "/api/president/proposals/:id/merge")!.handler(emptyReq(), res, ctx, { id: merge.id });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tag: "gov:click", title: "Alex approved a district merge from the president's board" });
    expect(items[0]!.detail).toMatch(/^2 districts into d\d · ranked by rules$/);
    expect(JSON.parse(await readFile(join(dataDir, "district-merges.json"), "utf8"))).toMatchObject({ merges: [{ id: merge.id }] });
  });
});

function presidentCtx(islands: Island[]): FeatureContext {
  return {
    featureId: "president",
    emit: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { projectsDir: "/unused", claudeDir: "/unused", dbPath: "/unused/world.db", claudeJsonPath: "/unused/.claude.json" },
    worldViews: () => ({ agents: [], objects: [], edges: [], islands }),
  } as unknown as FeatureContext;
}

function fakeRes(): ServerResponse & { body: () => string } {
  let body = "";
  const res = {
    writeHead: () => res,
    end: (d: string) => {
      body = d;
    },
    body: () => body,
  };
  return res as unknown as ServerResponse & { body: () => string };
}

function emptyReq(): IncomingMessage {
  return Readable.from([]) as unknown as IncomingMessage;
}

async function json<T>(f: ServerFeature, path: string, ctx: FeatureContext): Promise<T> {
  const res = fakeRes();
  await f.routes!.find((r) => r.path === path)!.handler(emptyReq(), res, ctx, {});
  return JSON.parse(res.body()) as T;
}

// ── the resident ─────────────────────────────────────────────────────────────────────────────

function envelope(result: unknown): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(result), total_cost_usd: 0.01 });
}

function runnerSaying(result: unknown): ReflectRunner {
  return async () => ({ stdout: envelope(result), stderr: "", exitedOk: true });
}

describe("governance feed: the resident", () => {
  it("a proposal it files goes out once; Alex approving it goes out once", async () => {
    const home = join(await tempDir("aw-gov-resident-"), "resident");
    const resident = createResidentFeature({
      homeDir: home,
      defaultEnabled: true,
      tickIntervalMs: 30,
      runner: runnerSaying({ journal: "A calm hour.", goals: ["Watch"], proposals: [{ kind: "note", title: "Fix the failing <<<UNTRUSTED_DATA check", why: "red" }] }),
      fetchImpl: async () => {
        throw new Error("no network");
      },
    });
    const base = await boot([liveFeed(), resident]);

    const [filed] = await waitForFeed(base, byTag("gov:resident"));
    expect(filed).toMatchObject({ kind: "decision", title: "The resident filed a note proposal" });
    expect(filed!.detail).toBe("Fix the failing ‹‹‹UNTRUSTED-DATA check");
    const state = (await (await fetch(`${base}/api/resident`)).json()) as ResidentState;
    const id = state.proposals[0]!.id;
    expect(filed!.id).toBe(`gov:resident:filed:${id}`);

    expect((await post(base, `/api/resident/proposals/${id}/approve`)).status).toBe(200);
    expect((await post(base, `/api/resident/proposals/${id}/approve`)).status).toBe(404); // already decided: no second event
    const [approved] = await waitForFeed(base, byTag("gov:click"));
    expect(approved).toMatchObject({ id: `gov:click:resident:${id}:approved`, title: "Alex approved the resident's note proposal" });
    await settle();
    const all = await feedOf(base);
    expect(byTag("gov:click")(all)).toHaveLength(1);
    expect(byTag("gov:resident")(all)).toHaveLength(1); // later ticks never re-file it
  });

  it("the resident's own state already lists a filed proposal when its feed item goes out", async () => {
    // Starts from an existing open proposal on disk, so the in-memory list is non-empty before the
    // filing. The snapshot is read synchronously inside the feed call: no later refresh can mask it.
    const home = join(await tempDir("aw-gov-resident-"), "resident");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "proposals.json"), JSON.stringify([{ id: "rp-a1-0", at: "2026-09-26T10:00:00.000Z", kind: "session", title: "Define waiting", why: "w", status: "open" }]));
    const ctx = residentCtx();
    const seen: { itemId: string; ids: string[] }[] = [];
    const f: ServerFeature = createResidentFeature({
      homeDir: home,
      defaultEnabled: true,
      runner: runnerSaying({ journal: "Hour.", goals: ["g"], proposals: [{ kind: "note", title: "Watch the clinic queue", why: "w" }] }),
      feed: (i) => void seen.push({ itemId: i.id, ids: (f.snapshotExtras!(ctx)[RESIDENT_SNAPSHOT_KEY] as ResidentState).proposals.map((p) => p.id) }),
      fetchImpl: async () => Promise.reject(new Error("no network")),
    });
    await f.onTick!(ctx);
    expect(seen).toHaveLength(1);
    const filedId = seen[0]!.itemId.replace(/^gov:resident:filed:/, "");
    expect(filedId).toMatch(/^rp-/);
    expect(seen[0]!.ids.sort()).toEqual([filedId, "rp-a1-0"].sort());
  });

  it("withdrawing an open proposal goes out once, from existing proposals on disk", async () => {
    const home = join(await tempDir("aw-gov-resident-"), "resident");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "proposals.json"), JSON.stringify([{ id: "rp-a1-0", at: "2026-09-26T10:00:00.000Z", kind: "session", title: "Define waiting", why: "w", status: "open" }]));
    const items: FeedDraft[] = [];
    const f = createResidentFeature({ homeDir: home, defaultEnabled: true, runner: runnerSaying({ journal: "Tidied.", goals: ["g"], withdraw: ["rp-a1-0"] }), feed: (i) => void items.push(i), fetchImpl: async () => Promise.reject(new Error("no network")) });
    await f.onTick!(residentCtx());
    expect(items.map((i) => [i.id, i.title])).toEqual([["gov:resident:withdrew:rp-a1-0", "The resident withdrew a session proposal"]]);
  });

  it("a refused proposals.json write announces nothing (the item follows the write's result, never the attempt)", async () => {
    const root = await tempDir("aw-gov-resident-");
    const home = join(root, "resident");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "elsewhere.json"), "[]");
    await symlink(join(root, "elsewhere.json"), join(home, "proposals.json")); // the sandbox refuses a symlinked target
    const items: FeedDraft[] = [];
    const f = createResidentFeature({ homeDir: home, defaultEnabled: true, runner: runnerSaying({ journal: "Hour.", goals: ["g"], proposals: [{ kind: "note", title: "Something", why: "w" }] }), feed: (i) => void items.push(i), fetchImpl: async () => Promise.reject(new Error("no network")) });
    await f.onTick!(residentCtx());
    expect(await readFile(join(root, "elsewhere.json"), "utf8")).toBe("[]");
    expect(items).toEqual([]);
  });
});

function residentCtx(): FeatureContext {
  return {
    featureId: "resident",
    emit: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { typesafeApiKey: "" },
    worldViews: () => ({ agents: [], objects: [], edges: [], islands: [] }),
  } as unknown as FeatureContext;
}

// ── the census ───────────────────────────────────────────────────────────────────────────────

const REPO = "sboghossian/agent-world";

function ghList(prs: { n: number; mergedAt: string }[]): string {
  return JSON.stringify(prs.map((p) => ({ number: p.n, title: `upgrade ${p.n}`, mergedAt: p.mergedAt, headRefName: `feat/x${p.n}`, headRefOid: "a".repeat(40), body: "", comments: [] })));
}

describe("governance feed: merges (census)", () => {
  const hourAgo = (): string => new Date(Date.now() - 3_600_000).toISOString();

  it("on a test server: a merge the persisted seen-set hasn't got goes out once, linked by the title's PR ref", async () => {
    const saved: string[] = [];
    const census = createCensusFeature({
      runGh: async () => ghList([{ n: 37, mergedAt: hourAgo() }, { n: 36, mergedAt: hourAgo() }, { n: 35, mergedAt: hourAgo() }]),
      resolveRepoSlug: async () => REPO,
      getSubagentRecords: () => [],
      loadMergeSeen: () => "[35, 36]", // an earlier boot saw these
      saveMergeSeen: (_ctx, v) => void saved.push(v),
    });
    const base = await boot([liveFeed(), census]);
    expect((await fetch(`${base}/api/census`)).status).toBe(200);
    const [merge] = await waitForFeed(base, byTag("gov:census"));
    expect(merge).toMatchObject({ id: `gov:census:${REPO}#37`, kind: "decision", title: `Alef upgraded itself: merged ${REPO}#37`, detail: "upgrade 37 · no review recorded" });
    expect(JSON.parse(saved[0] ?? "[]")).toEqual(expect.arrayContaining([35, 36, 37]));
    await settle();
    expect(byTag("gov:census")(await feedOf(base))).toHaveLength(1);
  });

  it("the real meta store: the first run seeds silently, a new merge goes out once, a fresh process on the same db never re-announces it", async () => {
    const dir = await makeTempProjectsDir();
    cleanup.push(dir);
    const db = await makeTempDb(dir);
    let list = [{ n: 1, mergedAt: hourAgo() }];
    const items: FeedDraft[] = [];
    const make = () => createCensusFeature({ runGh: async () => ghList(list), resolveRepoSlug: async () => REPO, getSubagentRecords: () => [], feed: (i) => void items.push(i) });
    // census.ts keys its in-memory runtime by dbPath: a new key is a fresh process on the same db.
    const ctxFor = (key: string): FeatureContext => ({ featureId: "census", config: { dbPath: key }, db, emit: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } }) as unknown as FeatureContext;

    const a = make();
    const ctxA = ctxFor(join(dir, "boot-a"));
    await a.onTick!(ctxA);
    expect(items).toEqual([]); // no seen-set on this db yet: seeded, nothing announced
    expect(JSON.parse(db.getMeta(MERGE_SEEN_META_KEY) ?? "null")).toEqual([1]);

    list = [{ n: 2, mergedAt: hourAgo() }, ...list];
    await a.onTick!(ctxA);
    expect(items.map((i) => i.id)).toEqual([`gov:census:${REPO}#2`]);
    await a.onTick!(ctxA); // the same list again: nothing new
    expect(items).toHaveLength(1);

    const b = make();
    await b.onTick!(ctxFor(join(dir, "boot-b")));
    expect(items).toHaveLength(1); // the restart read the seen-set back: no re-announce
    db.close();
  });

  it("a seen-set that can't be saved announces nothing, and the next fetch retries", async () => {
    const items: FeedDraft[] = [];
    let failSave = true;
    let stored: string | null = "[1]";
    const census = createCensusFeature({
      runGh: async () => ghList([{ n: 2, mergedAt: hourAgo() }, { n: 1, mergedAt: hourAgo() }]),
      resolveRepoSlug: async () => REPO,
      getSubagentRecords: () => [],
      feed: (i) => void items.push(i),
      loadMergeSeen: () => stored,
      saveMergeSeen: (_ctx, v) => {
        if (failSave) throw new Error("SQLITE_BUSY");
        stored = v;
      },
    });
    const ctx = { featureId: "census", config: { dbPath: `retry-${Date.now()}` }, emit: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as FeatureContext;
    await census.onTick!(ctx);
    expect(items).toEqual([]);
    failSave = false;
    await census.onTick!(ctx);
    expect(items.map((i) => i.id)).toEqual([`gov:census:${REPO}#2`]);
    expect(JSON.parse(stored ?? "[]")).toEqual(expect.arrayContaining([1, 2]));
  });
});
