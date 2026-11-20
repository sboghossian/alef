import { afterEach, describe, expect, it } from "vitest";
import type { TodayDigestResult } from "../../shared/features/quick-prompts.js";
import type { WorldAgent } from "../../shared/types.js";
import type { FetchLike } from "../director.js";
import { agentsActiveToday, buildSummary, rulesRank } from "../features/quick-prompts.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function agent(overrides: Partial<WorldAgent> & Pick<WorldAgent, "id" | "islandId" | "lastActive">): WorldAgent {
  return {
    cwd: "/ws/x",
    title: "a session",
    status: "dormant",
    startedAt: overrides.lastActive,
    messageCount: 1,
    model: null,
    role: "generalist",
    color: "#000",
    targetIslandId: overrides.islandId,
    tokens: 0,
    awaitingInput: false,
    ...overrides,
  };
}

describe("agentsActiveToday", () => {
  const now = new Date("2026-09-24T15:00:00");

  it("keeps only agents active since local midnight, most recent first", () => {
    const agents = [
      agent({ id: "a", islandId: "x", lastActive: "2026-09-24T09:00:00" }),
      agent({ id: "b", islandId: "x", lastActive: "2026-09-23T23:59:00" }), // yesterday
      agent({ id: "c", islandId: "y", lastActive: "2026-09-24T14:00:00" }),
    ];
    const today = agentsActiveToday(agents, now);
    expect(today.map((a) => a.id)).toEqual(["c", "a"]);
  });
});

describe("buildSummary", () => {
  it("reports real counts, singular/plural correctly, and an honest empty state", () => {
    expect(buildSummary([])).toBe("No agent activity today yet.");
    const one = [agent({ id: "a", islandId: "x", lastActive: "2026-09-24T09:00:00" })];
    expect(buildSummary(one)).toBe("1 agent worked across 1 city today.");
    const two = [
      agent({ id: "a", islandId: "x", lastActive: "2026-09-24T09:00:00" }),
      agent({ id: "b", islandId: "y", lastActive: "2026-09-24T10:00:00" }),
    ];
    expect(buildSummary(two)).toBe("2 agents worked across 2 cities today.");
  });
});

describe("rulesRank", () => {
  it("ranks by message count, caps at 5, and includes a real reason string", () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      agent({ id: `a${i}`, islandId: "city", lastActive: "2026-09-24T09:00:00", messageCount: i }),
    );
    const ranked = rulesRank(agents);
    expect(ranked).toHaveLength(5);
    expect(ranked[0]?.agentId).toBe("a6"); // highest messageCount
    expect(ranked[0]?.reason).toBe("city · 6 messages");
  });
});

function seedAgent(server: RunningServer, id: string, title: string, islandId: string, cwd: string, lastActive: string, messages: number): void {
  server.db.setIslandForCwd(cwd, islandId);
  server.db.upsertSession({
    id,
    cwd,
    islandId,
    title,
    startedAt: lastActive,
    lastActive,
    jsonlMtime: 0,
    messageCountDelta: messages,
    model: null,
    cntEditDelta: 0,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: messages,
    cntAssistantTotalDelta: messages,
  });
}

describe("POST /api/quick-prompts/today", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("returns the honest empty state when nothing happened today", async () => {
    const { base, server: s } = await bootTestServer();
    server = s;
    const res = await fetch(`${base}/api/quick-prompts/today`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodayDigestResult;
    expect(body.ok).toBe(true);
    expect(body.agents).toEqual([]);
    expect(body.summary).toBe("No agent activity today yet.");
  });

  it("falls back to rules ranking when no TypeSafe key is configured", async () => {
    const { base, server: s } = await bootTestServer();
    server = s;
    const now = new Date().toISOString();
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "acme work", "acme-ai-next", "/ws/acme", now, 20);
    seedAgent(s, "22222222-2222-2222-2222-222222222222", "world work", "agent-world", "/ws/world", now, 3);

    const res = await fetch(`${base}/api/quick-prompts/today`, { method: "POST", headers: { "content-type": "application/json" } });
    const body = (await res.json()) as TodayDigestResult;
    expect(body.ok).toBe(true);
    expect(body.source).toBe("rules");
    expect(body.agents[0]?.agentId).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.summary).toContain("2 agents worked across 2 cities today");
  });

  it("uses Jev's ranking (by probability) when a key + successful call are available", async () => {
    const winner = "22222222-2222-2222-2222-222222222222";
    const jevFetch: FetchLike = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as { questions: { today: { criteria: Record<string, string> } } };
      const ids = Object.keys(parsed.questions.today.criteria);
      const probabilities: Record<string, number> = {};
      for (const id of ids) probabilities[id] = id === winner ? 0.9 : 0.1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { today: { choice: winner, probabilities, confidence: 0.8 } } }),
      } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: jevFetch } });
    server = s;
    const now = new Date().toISOString();
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "first", "city-a", "/ws/a", now, 1);
    seedAgent(s, "22222222-2222-2222-2222-222222222222", "second", "city-b", "/ws/b", now, 1);

    const res = await fetch(`${base}/api/quick-prompts/today`, { method: "POST", headers: { "content-type": "application/json" } });
    const body = (await res.json()) as TodayDigestResult;
    expect(body.source).toBe("jev");
    expect(body.agents[0]?.agentId).toBe(winner);
  });

  it("falls back to rules when the TypeSafe call fails", async () => {
    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    const { base, server: s } = await bootTestServer({ configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: failingFetch } });
    server = s;
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "first", "city-a", "/ws/a", new Date().toISOString(), 1);

    const res = await fetch(`${base}/api/quick-prompts/today`, { method: "POST", headers: { "content-type": "application/json" } });
    const body = (await res.json()) as TodayDigestResult;
    expect(body.ok).toBe(true);
    expect(body.source).toBe("rules");
  });
});
