import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchiveSummary } from "../../shared/features/archive.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import type { FetchLike } from "../director.js";
import { createArchiveFeature } from "../features/archive.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import { JEV_BATCH } from "../features/topics-lib.js";
import { TopicsJevLink } from "../features/topics-link.js";
import { ARCHIVE_JEV_GAP_MS, createTopicsFeature } from "../features/topics.js";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOME = "/Users/me";
const ISLANDS: Island[] = [{ id: "me", name: "me", path: HOME, agentCount: 0, lastActive: "" }];

let root = "";
let calls: string[][] = []; // question ids' session titles per Jev call
let answer = "WEB";

/** Stub TypeSafe: records each batch and answers every question with `answer`. No network. */
const fetchStub: FetchLike = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: { sessions: Record<string, { title: string }> } };
  const qs = Object.keys(body.questions);
  calls.push(qs.map((q) => body.state.sessions[q]!.title));
  return new Response(JSON.stringify({ answers: Object.fromEntries(qs.map((q) => [q, { choice: answer }])) }), { status: 200 });
};

function ctxFor(agents: Pick<WorldAgent, "id" | "title" | "islandId">[]): FeatureContext {
  const noop = (): void => {};
  return {
    featureId: "x",
    emit: noop,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    config: { dbPath: join(root, "data", "world.db"), projectsDir: join(root, "projects"), typesafeApiKey: undefined },
    worldViews: () => ({ agents: agents as WorldAgent[], objects: [], edges: [], islands: ISLANDS }),
    db: { listCwdAliases: () => [] },
  } as unknown as FeatureContext;
}

async function writeNotes(n: number): Promise<void> {
  const dir = join(root, "vault", "10-Sessions", "claude-code");
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    await writeFile(join(dir, `n${i}.md`), `---\ntype: session\nsession_id: ${ID(i)}\ndate: 2026-06-01\nproject: home\nsummary: mystery task ${i}\n---\n`);
  }
}

function features(apiKey: string, t: () => number, link: TopicsJevLink): { archive: ServerFeature; topics: ServerFeature } {
  const groupsDir = join(root, "groups");
  return {
    archive: createArchiveFeature({ vaultDir: join(root, "vault"), groupsDir, homeDir: HOME, now: t, link }),
    topics: createTopicsFeature({ groupsDir, dataDir: join(root, "data"), homeDir: HOME, apiKey, fetchImpl: fetchStub, now: t, link }),
  };
}

function topicCounts(archive: ServerFeature, ctx: FeatureContext): Record<string, number> {
  const s = archive.snapshotExtras?.(ctx)["archive.summary"] as ArchiveSummary;
  return Object.fromEntries(s.places.map((p) => [p.key, p.count]));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alef-topics-jev-"));
  await mkdir(join(root, "groups"), { recursive: true });
  await writeFile(join(root, "groups", "taxonomy.json"), JSON.stringify({ groups: [{ key: "WEB", name: "Web" }, { key: "AUTO", name: "Auto" }], rules: [] }));
  calls = [];
  answer = "WEB";
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("archived home runs → topics' batched, cached Jev path", () => {
  it("drains in JEV_BATCH-sized calls, one per gap, then never asks again (cache hit, also after a restart)", async () => {
    await writeNotes(JEV_BATCH + 5);
    let t = 1_000_000;
    const link = new TopicsJevLink();
    const { archive, topics } = features("k", () => t, link);
    const ctx = ctxFor([]);

    await archive.onTick?.(ctx);
    expect(link.archived).toHaveLength(JEV_BATCH + 5);
    expect(topicCounts(archive, ctx)).toEqual({ "topic:OTHER": JEV_BATCH + 5 });

    await topics.onTick?.(ctx);
    expect(calls.map((c) => c.length)).toEqual([JEV_BATCH]); // capped at one batch

    await topics.onTick?.(ctx); // same minute: the archive gap holds the rest back
    expect(calls).toHaveLength(1);

    t += ARCHIVE_JEV_GAP_MS;
    await topics.onTick?.(ctx);
    expect(calls.map((c) => c.length)).toEqual([JEV_BATCH, 5]);

    await archive.onTick?.(ctx); // re-places from the shared cache
    expect(link.archived).toHaveLength(0);
    expect(topicCounts(archive, ctx)).toEqual({ "topic:WEB": JEV_BATCH + 5 });

    t += 10 * ARCHIVE_JEV_GAP_MS;
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(2); // everything cached: no further call

    const cached = JSON.parse(await readFile(join(root, "data", "topics.json"), "utf8")) as { jev: Record<string, string> };
    expect(Object.keys(cached.jev)).toHaveLength(JEV_BATCH + 5);

    // A restarted server loads the cache and places everything without a single call.
    const link2 = new TopicsJevLink();
    const again = features("k", () => t, link2);
    again.topics.snapshotExtras?.(ctx); // loads data/topics.json
    await again.archive.onTick?.(ctx);
    await again.topics.onTick?.(ctx);
    expect(link2.archived).toHaveLength(0);
    expect(topicCounts(again.archive, ctx)).toEqual({ "topic:WEB": JEV_BATCH + 5 });
    expect(calls).toHaveLength(2);
  });

  it("live sessions fill a batch first; archived ones only take the room left", async () => {
    await writeNotes(10);
    const t = 1_000_000;
    const link = new TopicsJevLink();
    const { archive, topics } = features("k", () => t, link);
    const live = Array.from({ length: JEV_BATCH - 3 }, (_, i) => ({ id: `live-${String(i).padStart(2, "0")}`, title: `live mystery ${i}`, islandId: "me" }));
    const ctx = ctxFor(live);
    await archive.onTick?.(ctx);
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(JEV_BATCH);
    expect(calls[0]!.filter((x) => x.startsWith("live")).length).toBe(JEV_BATCH - 3);
    expect(calls[0]!.filter((x) => x.startsWith("mystery")).length).toBe(3);
  });

  it("a Jev answer of OTHER is honest: the session stays OTHER and is never re-asked", async () => {
    await writeNotes(2);
    let t = 1_000_000;
    answer = "OTHER";
    const link = new TopicsJevLink();
    const { archive, topics } = features("k", () => t, link);
    const ctx = ctxFor([]);
    await archive.onTick?.(ctx);
    await topics.onTick?.(ctx);
    await archive.onTick?.(ctx);
    expect(topicCounts(archive, ctx)).toEqual({ "topic:OTHER": 2 });
    t += 10 * ARCHIVE_JEV_GAP_MS;
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(1);
  });

  it("no TypeSafe key: rules only, zero calls, archived home runs stay OTHER", async () => {
    await writeNotes(3);
    let t = 1_000_000;
    const link = new TopicsJevLink();
    const { archive, topics } = features("", () => t, link);
    const ctx = ctxFor([]);
    await archive.onTick?.(ctx);
    await topics.onTick?.(ctx);
    t += 10 * ARCHIVE_JEV_GAP_MS;
    await topics.onTick?.(ctx);
    await archive.onTick?.(ctx);
    expect(calls).toHaveLength(0);
    expect(topicCounts(archive, ctx)).toEqual({ "topic:OTHER": 3 });
  });

  it("a failed call backs off (JEV_RETRY) and keeps the sessions queued", async () => {
    await writeNotes(2);
    let t = 1_000_000;
    let fail = true;
    const link = new TopicsJevLink();
    const groupsDir = join(root, "groups");
    const archive = createArchiveFeature({ vaultDir: join(root, "vault"), groupsDir, homeDir: HOME, now: () => t, link });
    const flaky: FetchLike = async (u, i) => {
      if (fail) {
        calls.push([]);
        return new Response("no", { status: 503 });
      }
      return fetchStub(u, i);
    };
    const topics = createTopicsFeature({ groupsDir, dataDir: join(root, "data"), homeDir: HOME, apiKey: "k", fetchImpl: flaky, now: () => t, link });
    const ctx = ctxFor([]);
    await archive.onTick?.(ctx);
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(1);
    t += ARCHIVE_JEV_GAP_MS; // gap elapsed but the 10-minute retry back-off has not
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(1);
    fail = false;
    t += ARCHIVE_JEV_GAP_MS;
    await topics.onTick?.(ctx);
    expect(calls).toHaveLength(2);
    expect(link.archived).toHaveLength(2); // archive re-reads the cache on its next tick
    await archive.onTick?.(ctx);
    expect(link.archived).toHaveLength(0);
  });
});
