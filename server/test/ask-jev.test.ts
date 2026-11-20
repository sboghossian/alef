import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../director.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

function seedAgent(server: RunningServer, id: string, title: string, islandId: string, cwd: string): void {
  server.db.setIslandForCwd(cwd, islandId);
  server.db.upsertSession({
    id,
    cwd,
    islandId,
    title,
    startedAt: "2026-09-20T00:00:00.000Z",
    lastActive: "2026-09-20T00:00:00.000Z",
    jsonlMtime: 0,
    messageCountDelta: 1,
    model: null,
    cntEditDelta: 1,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 1,
  });
}

interface FakeQuestionBody {
  questions: { ask: { criteria: Record<string, string | null> } };
}

describe("POST /api/ask-jev", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("mocked success: returns Jev's top choice as the best match", async () => {
    const successFetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as FakeQuestionBody;
      const keys = Object.keys(body.questions.ask.criteria).filter((k) => k !== "none");
      const choice = keys[0]!;
      const probabilities: Record<string, number> = { none: 0.01 };
      for (const k of keys) probabilities[k] = k === choice ? 0.9 : 0.02;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: "jev-1.0", answers: { ask: { choice, probabilities, confidence: 0.87 } } }),
      } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: successFetch },
    });
    server = s;
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "email to Jessica about the contract", "acme-ai-next", "/ws/acme-ai-next");
    seedAgent(s, "22222222-2222-2222-2222-222222222222", "refactor the renderer", "agent-world", "/ws/agent-world");

    const res = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "who worked on the Jessica email?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matches: Array<{ agentId: string; probability: number }>; confidence: number; source: string };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("jev");
    expect(body.confidence).toBeCloseTo(0.87);
    expect(body.matches[0]?.agentId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it('returns matches: [] when "none" is Jev\'s top choice', async () => {
    const noneFetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { ask: { choice: "none", probabilities: { none: 0.95 }, confidence: 0.6 } } }),
      }) as unknown as Response;
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: noneFetch },
    });
    server = s;
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "unrelated session", "acme-ai-next", "/ws/acme-ai-next");

    const res = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "who worked on the Jessica email?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: unknown[]; source: string };
    expect(body.matches).toEqual([]);
    expect(body.source).toBe("jev");
  });

  it("falls back to keyword ranking on a TypeSafe 500", async () => {
    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: failingFetch },
    });
    server = s;
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "email to Jessica about the contract", "acme-ai-next", "/ws/acme-ai-next");

    const res = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Jessica email" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; confidence: number; matches: Array<{ agentId: string; probability: number }> };
    expect(body.source).toBe("keyword");
    expect(body.confidence).toBe(0);
    expect(body.matches[0]?.agentId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects an out-of-range question length with 400", async () => {
    const { base, server: s } = await bootTestServer();
    server = s;

    const empty = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "" }),
    });
    expect(empty.status).toBe(400);

    const oversized = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "a".repeat(501) }),
    });
    expect(oversized.status).toBe(400);
  });

  it("rejects a second concurrent call with 429 while the first is still in flight", async () => {
    // Deterministic: the fake TypeSafe call stays open until the second request has been answered.
    let markCalled: () => void = () => {};
    const called = new Promise<void>((r) => (markCalled = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slowFetch: FetchLike = async () => {
      markCalled();
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { ask: { choice: "none", probabilities: { none: 1 }, confidence: 0.5 } } }),
      } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({
      configOverrides: { typesafeApiKey: "test-key", typesafeFetchImpl: slowFetch },
    });
    server = s;
    seedAgent(s, "11111111-1111-1111-1111-111111111111", "some session", "acme-ai-next", "/ws/acme-ai-next");

    const first = fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "some session" }),
    });
    await called; // the first request is in flight (it has reached TypeSafe)
    const second = await fetch(`${base}/api/ask-jev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "some session" }),
    });
    expect(second.status).toBe(429);

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  });
});
