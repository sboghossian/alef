import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { AgentSnapshot, FetchLike } from "../director.js";
import { callJev, runDirectorTick } from "../director.js";
import { makeTempDb, makeTempProjectsDir } from "./helpers.js";
import type { WorldDb } from "../db.js";

const openDbs: WorldDb[] = [];
const tmpDirs: string[] = [];
const HOME = "/ws-home"; // a home dir with no island: paths under /ws/* never fall back to it

async function seededDb(): Promise<WorldDb> {
  const dir = await makeTempProjectsDir();
  tmpDirs.push(dir);
  const db = await makeTempDb(dir);
  openDbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function addSession(db: WorldDb, id: string, cwd: string, islandId: string, at: string): void {
  db.upsertSession({
    id,
    cwd,
    islandId,
    title: id,
    startedAt: at,
    lastActive: at,
    jsonlMtime: 0,
    messageCountDelta: 1,
    model: null,
    cntEditDelta: 3,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 1,
  });
}

/** Two agents on two islands. agent-a has already edited a file in island-b's folder: real cross-district work. */
function seedTwoAgents(db: WorldDb): void {
  db.setIslandForCwd("/ws/a", "island-a");
  db.setIslandForCwd("/ws/b", "island-b");
  addSession(db, "agent-a", "/ws/a", "island-a", "2026-09-20T09:00:00.000Z");
  addSession(db, "agent-b", "/ws/b", "island-b", "2026-09-20T08:00:00.000Z");
  db.upsertObjectShell({ id: "file:/ws/b/shared.ts", kind: "file", name: "shared.ts", islandId: "island-a" });
  db.upsertEdge({ from: "agent-a", to: "file:/ws/b/shared.ts", kind: "touched", at: "2026-09-20T09:00:00.000Z" });
  db.upsertEdge({ from: "agent-b", to: "file:/ws/b/shared.ts", kind: "touched", at: "2026-09-20T08:00:00.000Z" });
  // A harness skill to grow.
  db.upsertObjectShell({ id: "skill:humanizer", kind: "skill", name: "humanizer", islandId: "harness" });
}

const snap = (id: string, islandId: string, status: AgentSnapshot["status"]): AgentSnapshot => ({
  id,
  islandId,
  title: id,
  role: "builder",
  status,
  lastActive: "2026-09-20T09:00:00.000Z",
});
const dormant = [snap("agent-a", "island-a", "dormant"), snap("agent-b", "island-b", "dormant")];

const explodingFetch: FetchLike = () => {
  throw new Error("fetch must not be called when the API key is missing");
};

function visitedEdges(db: WorldDb): Array<{ from: string; to: string; weight: number }> {
  return db
    .listEdges()
    .filter((e) => e.kind === "visited")
    .map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
}

describe("director", () => {
  it("with no API key: status disabled, only the grow rule, never calls fetch, never moves a dormant agent", async () => {
    const db = await seededDb();
    seedTwoAgents(db);

    const result = await runDirectorTick(db, dormant, { apiKey: "", fetchImpl: explodingFetch, homeDir: HOME });

    expect(result.status).toBe("disabled");
    expect(result.decisions.map((d) => d.kind)).toEqual(["grow"]);
    expect(result.decisions[0]?.source).toBe("rules");
    expect(result.decisions[0]?.choice).toBe("skill:humanizer");
    expect(db.listObjectsWithUsage().find((o) => o.id === "skill:humanizer")?.growth).toBeCloseTo(0.1);

    // agent-a DID edit island-b's file, so there is a road — but it is dormant, so no plane.
    expect(visitedEdges(db)).toEqual([{ from: "agent-a", to: "island-b", weight: 1 }]);
    expect(db.getSession("agent-a")?.targetIslandId).toBe("island-a");
    expect(db.getSession("agent-b")?.targetIslandId).toBe("island-b");
  });

  it("on HTTP 500 from TypeSafe: status fallback, still applies the grow rule", async () => {
    const db = await seededDb();
    seedTwoAgents(db);

    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;

    const result = await runDirectorTick(db, dormant, { apiKey: "test-key", fetchImpl: failingFetch, homeDir: HOME });

    expect(result.status).toBe("fallback");
    expect(result.decisions.map((d) => d.kind)).toEqual(["grow"]);
    for (const d of result.decisions) expect(d.source).toBe("rules");
  });

  it("on a valid TypeSafe response: asks only the grow question and applies Jev's choice", async () => {
    const db = await seededDb();
    seedTwoAgents(db);
    const asked: string[][] = [];

    const successFetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: Record<string, unknown>;
        questions: Record<string, { criteria: Record<string, unknown> }>;
      };
      asked.push(Object.keys(body.questions), Object.keys(body.state));
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(body.questions)) {
        const choice = Object.keys(q.criteria)[0]!;
        answers[key] = { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.87 };
      }
      return { ok: true, status: 200, json: async () => ({ model: "jev-1.13.0", answers }) } as unknown as Response;
    };

    const result = await runDirectorTick(db, dormant, { apiKey: "test-key", fetchImpl: successFetch, homeDir: HOME });

    expect(result.status).toBe("online");
    expect(asked).toEqual([["grow"], ["growCandidates"]]); // no pair, no roam, no idle agents sent to Jev
    expect(result.decisions.map((d) => [d.kind, d.source, d.choice])).toEqual([["grow", "jev", "skill:humanizer"]]);
    expect(result.decisions[0]?.confidence).toBeCloseTo(0.87);
    expect(db.getSession("agent-a")?.targetIslandId).toBe("island-a");
  });

  it("flies a LIVE agent to the island whose files it just edited, then home 3 ticks after it stops", async () => {
    const db = await seededDb();
    seedTwoAgents(db);
    const live = [snap("agent-a", "island-a", "live"), snap("agent-b", "island-b", "dormant")];

    await runDirectorTick(db, live, { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")?.targetIslandId).toBe("island-a"); // an old touch is not a trip

    // agent-a edits island-b again (live), agent-b edits island-a (dormant): only agent-a travels.
    db.upsertEdge({ from: "agent-a", to: "file:/ws/b/new.ts", kind: "touched", at: "2026-09-20T10:00:00.000Z" });
    db.upsertEdge({ from: "agent-b", to: "file:/ws/a/readme.md", kind: "touched", at: "2026-09-20T10:01:00.000Z" });
    await runDirectorTick(db, live, { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")).toMatchObject({ targetIslandId: "island-b", roamTicksLeft: 3 });
    expect(db.getSession("agent-b")).toMatchObject({ targetIslandId: "island-b", roamTicksLeft: 0 });
    expect(visitedEdges(db)).toEqual([
      { from: "agent-a", to: "island-b", weight: 2 },
      { from: "agent-b", to: "island-a", weight: 1 },
    ]);

    await runDirectorTick(db, live, { apiKey: "", homeDir: HOME });
    await runDirectorTick(db, live, { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")?.targetIslandId).toBe("island-b");
    await runDirectorTick(db, live, { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")).toMatchObject({ targetIslandId: "island-a", roamTicksLeft: 0 }); // home
  });

  it("sends an agent home the tick it goes dormant, mid-trip", async () => {
    const db = await seededDb();
    seedTwoAgents(db);
    await runDirectorTick(db, [snap("agent-a", "island-a", "live")], { apiKey: "", homeDir: HOME });
    db.upsertEdge({ from: "agent-a", to: "file:/ws/b/new.ts", kind: "touched", at: "2026-09-20T10:00:00.000Z" });
    await runDirectorTick(db, [snap("agent-a", "island-a", "live")], { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")?.targetIslandId).toBe("island-b");

    await runDirectorTick(db, [snap("agent-a", "island-a", "dormant")], { apiKey: "", homeDir: HOME });
    expect(db.getSession("agent-a")).toMatchObject({ targetIslandId: "island-a", roamTicksLeft: 0 });
  });

  it("drops a visit the touched edges no longer prove (the session was re-homed onto that island)", async () => {
    const db = await seededDb();
    seedTwoAgents(db);
    await runDirectorTick(db, dormant, { apiKey: "", homeDir: HOME });
    expect(visitedEdges(db)).toEqual([{ from: "agent-a", to: "island-b", weight: 1 }]);

    db.setSessionIslandId("agent-a", "island-b");
    await runDirectorTick(db, dormant, { apiKey: "", homeDir: HOME });
    expect(visitedEdges(db)).toEqual([]);
  });
});

// callJev is the one HTTP call every Jev caller shares (ask-jev, atlas, council, president,
// quick-prompts, resident, router), so a socket it fails to release leaks once per error response
// across all of them. undici keeps the connection open until the body is read or cancelled, and
// the !res.ok path used to throw without touching it. Found 2026-10-26 while tracing a separate
// threadpool bug; the error path is the only one affected -- res.json() consumes the body itself.
describe("callJev releases the response body", () => {
  /** A Response whose body records whether anything released it. */
  function fakeResponse(status: number, body: unknown): { res: Response; cancelled: () => boolean } {
    let cancelled = false;
    const stream = {
      cancel: async () => {
        cancelled = true;
      },
    };
    return {
      res: { ok: status < 400, status, body: stream, json: async () => body } as unknown as Response,
      cancelled: () => cancelled,
    };
  }

  it("cancels the body before throwing on a non-ok status", async () => {
    const { res, cancelled } = fakeResponse(500, {});
    const fetchImpl: FetchLike = async () => res;
    await expect(callJev("k", {}, fetchImpl, 1000)).rejects.toThrow("typesafe http 500");
    expect(cancelled(), "the socket is held until something consumes the body").toBe(true);
  });

  it("leaves a successful response to json(), which consumes it itself", async () => {
    const { res, cancelled } = fakeResponse(200, { answers: {} });
    const fetchImpl: FetchLike = async () => res;
    await expect(callJev("k", {}, fetchImpl, 1000)).resolves.toEqual({ answers: {} });
    expect(cancelled(), "double-consuming a read body would throw").toBe(false);
  });

  it("still throws the http error when the body cannot be cancelled", async () => {
    const res = {
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          throw new Error("stream already disturbed");
        },
      },
      json: async () => ({}),
    } as unknown as Response;
    const fetchImpl: FetchLike = async () => res;
    await expect(callJev("k", {}, fetchImpl, 1000)).rejects.toThrow("typesafe http 503");
  });

  it("tolerates a response with no body at all (a 204, and every existing test's mock)", async () => {
    const res = { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
    const fetchImpl: FetchLike = async () => res;
    await expect(callJev("k", {}, fetchImpl, 1000)).rejects.toThrow("typesafe http 429");
  });
});
