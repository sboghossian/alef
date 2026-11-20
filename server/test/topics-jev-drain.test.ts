// Review findings on the topics feature (2026-09-27, HIGH + LOW):
//  1. An unanswerable session (Jev skips it, or answers outside the taxonomy) had no attempt
//     counter or negative cache, so — since the batch is sorted by id — it sat at the front of
//     every batch forever (144-288 paid calls a day). Fixed by persisting an attempt count per
//     session id in data/topics.json and settling to the fallback group after JEV_MAX_ATTEMPTS.
//  2. jevRetryAt/archiveJevAt lived only in memory, so every `tsx watch` restart made an
//     immediate call and skipped the back-off. Fixed by persisting both in the same cache file.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TopicsMap } from "../../shared/features/topics.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import type { FetchLike } from "../director.js";
import type { FeatureContext } from "../features/registry.js";
import { JEV_BATCH, type SessionInput } from "../features/topics-lib.js";
import { TopicsJevLink } from "../features/topics-link.js";
import { ARCHIVE_JEV_GAP_MS, JEV_MAX_ATTEMPTS, createTopicsFeature } from "../features/topics.js";

const HOME = "/Users/me";
const ISLANDS: Island[] = [{ id: "me", name: "me", path: HOME, agentCount: 0, lastActive: "" }];
const JEV_RETRY_MS = 10 * 60_000; // mirrors topics.ts's private back-off; advanced past it below

let root = "";

function ctxFor(agents: Pick<WorldAgent, "id" | "title" | "islandId">[]): FeatureContext {
  const noop = (): void => {};
  return {
    featureId: "x",
    emit: noop,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    config: { dbPath: join(root, "data", "world.db"), projectsDir: join(root, "projects"), typesafeApiKey: undefined },
    worldViews: () => ({ agents: agents as WorldAgent[], objects: [], edges: [], islands: ISLANDS }),
  } as unknown as FeatureContext;
}

/** Answers every question with `choice` (a raw TypeSafe-shaped response, no network). */
function stubAnswering(choice: string, onCall?: () => void): FetchLike {
  return async (_url, init) => {
    onCall?.();
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const qs = Object.keys(body.questions);
    return new Response(JSON.stringify({ answers: Object.fromEntries(qs.map((q) => [q, { choice }])) }), { status: 200 });
  };
}

async function topicsMap(topics: ReturnType<typeof createTopicsFeature>, ctx: FeatureContext): Promise<TopicsMap | undefined> {
  const snap = topics.snapshotExtras?.(ctx) as Record<string, unknown> | undefined;
  return snap?.["topics.map"] as TopicsMap | undefined;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alef-topics-drain-"));
  await mkdir(join(root, "groups"), { recursive: true });
  // No fallbackGroup: parseTaxonomy synthesizes "OTHER" (matches the rest of the suite).
  await writeFile(join(root, "groups", "taxonomy.json"), JSON.stringify({ groups: [{ key: "WEB", name: "Web" }], rules: [] }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("finding 1: Jev attempt cap + negative cache", () => {
  it("a session Jev never answers is asked at most JEV_MAX_ATTEMPTS times, then settles to OTHER and is never asked again", async () => {
    let t = 1_000_000;
    let calls = 0;
    const groupsDir = join(root, "groups");
    const dataDir = join(root, "data");
    // Jev "answers", but with a group outside the taxonomy — parseJevAnswers drops it, same as a skip.
    const stuck = stubAnswering("MARS", () => calls++);
    const agents = [{ id: "stuck-1", title: "totally unclear", islandId: "me" }];
    const ctx = ctxFor(agents);
    const topics = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stuck, now: () => t, link: new TopicsJevLink() });

    for (let i = 0; i < JEV_MAX_ATTEMPTS; i++) {
      await topics.onTick?.(ctx);
      t += JEV_RETRY_MS + 1; // clear the failed-call back-off before the next attempt
    }
    expect(calls).toBe(JEV_MAX_ATTEMPTS);
    expect((await topicsMap(topics, ctx))?.sessions["stuck-1"]).toEqual({ group: "OTHER", source: "jev" });

    await topics.onTick?.(ctx); // a 4th tick: must not ask again
    expect(calls).toBe(JEV_MAX_ATTEMPTS);

    const cached = JSON.parse(await readFile(join(dataDir, "topics.json"), "utf8")) as { jev: Record<string, string>; attempts: Record<string, number> };
    expect(cached.jev["stuck-1"]).toBe("OTHER");
    expect(cached.attempts["stuck-1"]).toBeUndefined(); // cleared once settled

    // A restarted server (fresh closure, same data dir) loads the cache and never calls again.
    const restarted = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stuck, now: () => t, link: new TopicsJevLink() });
    await restarted.onTick?.(ctx);
    expect(calls).toBe(JEV_MAX_ATTEMPTS);
    expect((await topicsMap(restarted, ctx))?.sessions["stuck-1"]).toEqual({ group: "OTHER", source: "jev" });
  });

  it("the attempt count itself survives a reload mid-way, before the session has settled", async () => {
    let t = 1_000_000;
    let calls = 0;
    const groupsDir = join(root, "groups");
    const dataDir = join(root, "data");
    const stuck = stubAnswering("MARS", () => calls++);
    const agents = [{ id: "stuck-1", title: "totally unclear", islandId: "me" }];
    const ctx = ctxFor(agents);

    const first = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stuck, now: () => t, link: new TopicsJevLink() });
    await first.onTick?.(ctx); // attempt 1
    t += JEV_RETRY_MS + 1;

    const readCache = async (): Promise<{ attempts: Record<string, number>; jev: Record<string, string> }> =>
      JSON.parse(await readFile(join(dataDir, "topics.json"), "utf8")) as { attempts: Record<string, number>; jev: Record<string, string> };
    expect((await readCache()).attempts["stuck-1"]).toBe(1);

    // A fresh process picks up where the last one left off instead of starting the count over.
    const reloaded = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stuck, now: () => t, link: new TopicsJevLink() });
    await reloaded.onTick?.(ctx); // attempt 2
    t += JEV_RETRY_MS + 1;
    await reloaded.onTick?.(ctx); // attempt 3: settles

    expect(calls).toBe(3);
    expect((await readCache()).jev["stuck-1"]).toBe("OTHER");
  });
});

describe("finding 2: jevRetryAt / archiveJevAt survive a restart", () => {
  it("a failed call's back-off is honoured immediately after reload, not reset to zero", async () => {
    let t = 1_000_000;
    const groupsDir = join(root, "groups");
    const dataDir = join(root, "data");
    let failCalls = 0;
    const failing: FetchLike = async () => {
      failCalls++;
      return new Response("no", { status: 503 });
    };
    const agents = [{ id: "x1", title: "totally unclear", islandId: "me" }];
    const ctx = ctxFor(agents);
    const first = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: failing, now: () => t, link: new TopicsJevLink() });
    await first.onTick?.(ctx);
    expect(failCalls).toBe(1);

    // Simulate a `tsx watch` restart: a brand-new feature instance, same data dir, same clock.
    let liveCalls = 0;
    const wouldSucceed = stubAnswering("OTHER", () => liveCalls++);
    const restarted = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: wouldSucceed, now: () => t, link: new TopicsJevLink() });
    await restarted.onTick?.(ctx); // same instant as the failure: the back-off must still hold
    expect(liveCalls).toBe(0);

    t += JEV_RETRY_MS + 1;
    await restarted.onTick?.(ctx);
    expect(liveCalls).toBe(1); // now it's allowed to call
  });

  it("the archive drain gap is honoured immediately after reload, not reset to zero", async () => {
    let t = 1_000_000;
    const groupsDir = join(root, "groups");
    const dataDir = join(root, "data");
    let calls = 0;
    const stub = stubAnswering("OTHER", () => calls++);
    const archived: SessionInput[] = Array.from({ length: JEV_BATCH + 2 }, (_, i) => ({
      id: `arc-${String(i).padStart(2, "0")}`,
      title: `mystery task ${i}`,
      islandId: "me",
      catchAll: true,
      headless: false,
    }));
    const ctx = ctxFor([]);
    const link1 = new TopicsJevLink();
    link1.archived = archived;
    const first = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stub, now: () => t, link: link1 });
    await first.onTick?.(ctx);
    expect(calls).toBe(1); // JEV_BATCH of the JEV_BATCH+2 drained this round; 2 remain unanswered

    // Simulate a restart at the SAME instant: the persisted gap must still hold, not reset to 0.
    const link2 = new TopicsJevLink();
    link2.archived = archived; // the real archive feature would re-supply the same backlog
    const restarted = createTopicsFeature({ groupsDir, dataDir, homeDir: HOME, apiKey: "k", fetchImpl: stub, now: () => t, link: link2 });
    await restarted.onTick?.(ctx);
    expect(calls).toBe(1); // no immediate second call right after "restart"

    t += ARCHIVE_JEV_GAP_MS;
    await restarted.onTick?.(ctx);
    expect(calls).toBe(2); // gap elapsed: drains the rest
  });
});
