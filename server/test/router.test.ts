import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../director.js";
import type { RunningServer } from "../index.js";
import { createRouterFeature } from "../features/router.js";
import type { RouterResult } from "../../shared/features/router.js";
import { bootTestServer } from "./helpers.js";

async function fixtureRoots(): Promise<{ dir: string; memoryDir: string; vaultProjectsDir: string; brainGraphPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-world-router-"));
  const memoryDir = join(dir, "memory");
  const vaultProjectsDir = join(dir, "20-Projects");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(vaultProjectsDir, { recursive: true });
  await writeFile(join(memoryDir, "renames.md"), "# Renaming conventions\nHow we rename variables and files across the codebase.");
  await writeFile(join(memoryDir, "unrelated.md"), "# Grocery list\nMilk, eggs, bread.");
  return { dir, memoryDir, vaultProjectsDir, brainGraphPath: join(dir, "brain-graph.json") };
}

/** The BM25 index builds in the background off a fire-and-forget promise; poll the world
 *  snapshot's extras (same pattern recall's own tests use) instead of assuming it's instant. */
async function waitUntilReady(base: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/world`);
    const body = (await res.json()) as { extras?: Record<string, unknown> };
    if (body.extras?.["router.ready"] === true) return;
    if (Date.now() > deadline) throw new Error("router note index never became ready");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function postRoute(base: string, prompt: string): Promise<Response> {
  return fetch(`${base}/api/router/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

describe("POST /api/router/route", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("mocked success: applies Jev's model choice and ranks notes by Jev relevance, not BM25", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots, skipCorpus: false, jevTimeoutMs: 1500 });
    const calls: unknown[] = [];
    const successFetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      calls.push(body);
      const noteKeys = Object.keys(body.questions).filter((k) => k.startsWith("note_"));
      const answers: Record<string, unknown> = {
        model: { choice: "opus", probabilities: { opus: 0.85, sonnet: 0.1, haiku: 0.05 }, confidence: 0.85 },
      };
      for (const k of noteKeys) answers[k] = { score: 0.9, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.8 };
      return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: successFetch } });
    server = s;
    await waitUntilReady(base);

    const res = await postRoute(base, "rename the helper function everywhere");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouterResult;
    expect(body.ok).toBe(true);
    expect(body.model).toBe("opus");
    expect(body.why).toContain("Jev");
    expect(body.notes.length).toBeGreaterThan(0);
    expect(body.notes[0]?.why).toContain("Jev: relevant");
    expect(typeof body.ms).toBe("number");
    expect(calls.length).toBe(1);
  });

  it("mocked success: returns a dispatch block (history, web, deliver, size, skill, questions)", async () => {
    const roots = await fixtureRoots();
    const skills = [
      { slug: "code-review", description: "Review a diff or pull request for bugs." },
      { slug: "pptx", description: "Build PowerPoint slide decks." },
    ];
    const feature = createRouterFeature({ roots, skipCorpus: false, jevTimeoutMs: 1500, skills });
    let sent: { state: Record<string, unknown>; questions: Record<string, unknown> } | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      const yes = (p: number) => ({ score: p, probabilities: { "0": 1 - p, "1": p }, confidence: 0.8 });
      const answers: Record<string, unknown> = {
        model: { choice: "sonnet", probabilities: { sonnet: 0.8 }, confidence: 0.8 },
        history: yes(0.2),
        web: yes(0.1),
        deliver: { choice: "pr", probabilities: { pr: 0.9 }, confidence: 0.9 },
        size: { choice: "standard", probabilities: { standard: 0.7 }, confidence: 0.7 },
        skill_0: yes(0.9),
        ask_0: yes(0.8),
        ask_1: yes(0.3),
      };
      return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: fetchImpl } });
    server = s;
    await waitUntilReady(base);

    const body = (await (await postRoute(base, "review the pull request diff for bugs")).json()) as RouterResult;
    expect(sent!.state.skills).toEqual([{ id: "skill_0", name: "code-review", description: "Review a diff or pull request for bugs." }]);
    expect(body.dispatch).toEqual({
      history: 0.2,
      web: 0.1,
      deliver: "pr",
      size: "standard",
      skill: { name: "code-review", p: 0.9 },
      ask: ["Who is this for: just you, or someone else (team, client, public)?"],
    });
  });

  it("leaves dispatch off when Jev answers only the model question (older shape)", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots, skipCorpus: false, jevTimeoutMs: 1500, skills: [] });
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 200, json: async () => ({ answers: { model: { choice: "haiku", probabilities: { haiku: 0.9 }, confidence: 0.9 } } }) }) as unknown as Response;
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: fetchImpl } });
    server = s;
    await waitUntilReady(base);
    const body = (await (await postRoute(base, "rename foo")).json()) as RouterResult;
    expect(body.model).toBe("haiku");
    expect(body.dispatch).toBeUndefined();
  });

  it("offers memory-vector hits to Jev beside the BM25 ones", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots, skipCorpus: false, jevTimeoutMs: 1500, skills: [], vectorSearch: async () => ["/vault/20-Projects/brain/vault-write-locks.md"] });
    let notesSent: unknown = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      notesSent = (JSON.parse(String(init?.body)) as { state: { notes?: unknown } }).state.notes;
      return { ok: true, status: 200, json: async () => ({ answers: { model: { choice: "sonnet", probabilities: {}, confidence: 0.8 } } }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: fetchImpl } });
    server = s;
    await waitUntilReady(base);
    await postRoute(base, "rename the helper function everywhere");
    expect(notesSent).toEqual(expect.arrayContaining([{ id: "note_0", title: "vault-write-locks" }]));
  });

  it("adds the graph's linked notes as a second wave of candidates", async () => {
    const roots = await fixtureRoots();
    const seed = { id: "s", path: "memory/renames.md", kind: "n" as const, links: ["l"] };
    const linked = { id: "l", path: "30-Knowledge/naming-decision.md", kind: "n" as const, links: [] };
    const graph = { byPath: new Map([[seed.path, seed]]), byId: new Map([["l", linked]]) };
    const feature = createRouterFeature({ roots, skipCorpus: false, jevTimeoutMs: 1500, skills: [], vectorSearch: async () => ["brain-graph:memory/renames.md"], graph: () => graph });
    let notesSent: Array<{ title: string }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      notesSent = (JSON.parse(String(init?.body)) as { state: { notes?: Array<{ title: string }> } }).state.notes ?? [];
      return { ok: true, status: 200, json: async () => ({ answers: { model: { choice: "sonnet", probabilities: {}, confidence: 0.8 } } }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: fetchImpl } });
    server = s;
    await waitUntilReady(base);
    await postRoute(base, "rename the helper function everywhere");
    expect(notesSent.map((n) => n.title)).toContain("naming-decision");
  });

  it("falls back to rules when there is no API key", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "" } });
    server = s;
    await waitUntilReady(base);

    const res = await postRoute(base, "rename all foo to bar");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouterResult;
    expect(body.model).toBe("haiku");
    expect(body.why).toContain("rules");
    expect(body.why).toContain("no Jev key");
    expect(body.notes[0]?.why).toContain("BM25 match");
  });

  it("falls back to rules on a TypeSafe 500", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots });
    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: failingFetch } });
    server = s;
    await waitUntilReady(base);

    const res = await postRoute(base, "design the auth architecture");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouterResult;
    expect(body.model).toBe("opus");
    expect(body.why).toContain("Jev unavailable");
  });

  it("falls back to rules when the call exceeds the timeout budget", async () => {
    const roots = await fixtureRoots();
    // A tiny timeout stands in for the contract's ">1.5s" budget so the test doesn't
    // actually wait 1.5s; the fetch never resolves before it, which is what matters.
    const feature = createRouterFeature({ roots, jevTimeoutMs: 20 });
    // A real fetch() rejects when its AbortSignal fires; callJev relies on exactly that to
    // enforce its timeout, so the stub must do the same or the abort has nothing to reject.
    const neverResolves: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: neverResolves } });
    server = s;
    await waitUntilReady(base);

    const res = await postRoute(base, "fix the button color");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouterResult;
    expect(body.model).toBe("sonnet");
    expect(body.why).toContain("Jev unavailable");
  });

  it("caches identical prompts: a second identical call makes no second Jev call", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots, cacheTtlMs: 10 * 60_000 });
    let callCount = 0;
    const successFetch: FetchLike = async () => {
      callCount += 1;
      return { ok: true, status: 200, json: async () => ({ answers: { model: { choice: "sonnet", probabilities: { sonnet: 1 }, confidence: 0.9 } } }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: successFetch } });
    server = s;
    await waitUntilReady(base);

    const first = await postRoute(base, "fix the button color");
    const second = await postRoute(base, "fix the button color");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(callCount).toBe(1);
  });

  it("rate-limits the Jev call itself: once the budget is spent, it falls back to rules without calling fetch", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots, rateLimit: { max: 1, windowMs: 60_000 } });
    let callCount = 0;
    const successFetch: FetchLike = async () => {
      callCount += 1;
      return { ok: true, status: 200, json: async () => ({ answers: { model: { choice: "sonnet", probabilities: { sonnet: 1 }, confidence: 0.9 } } }) } as unknown as Response;
    };
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "test-key", typesafeFetchImpl: successFetch } });
    server = s;
    await waitUntilReady(base);

    const first = await postRoute(base, "fix the header layout");
    const second = await postRoute(base, "fix the footer layout"); // different prompt: cache can't be why this skips Jev
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as RouterResult;
    expect(secondBody.why).toContain("rate-limited");
    expect(callCount).toBe(1);
  });

  it("400s on a missing, empty, or oversized prompt", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const missing = await fetch(`${base}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);

    const empty = await postRoute(base, "");
    expect(empty.status).toBe(400);

    const oversized = await postRoute(base, "x".repeat(4001));
    expect(oversized.status).toBe(400);
  });

  it("never leaks the TypeSafe API key into the response body", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots });
    const secretKey = "sk-typesafe-super-secret-value";
    const successFetch: FetchLike = async () =>
      ({ ok: true, status: 200, json: async () => ({ answers: { model: { choice: "sonnet", probabilities: { sonnet: 1 }, confidence: 0.9 } } }) }) as unknown as Response;
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: secretKey, typesafeFetchImpl: successFetch } });
    server = s;
    await waitUntilReady(base);

    const res = await postRoute(base, "fix the button color");
    const raw = await res.text();
    expect(raw.includes(secretKey)).toBe(false);
  });

  it("accepts an optional cwd field without using it to change the pick (v1 scope)", async () => {
    const roots = await fixtureRoots();
    const feature = createRouterFeature({ roots });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature], typesafeApiKey: "" } });
    server = s;
    await waitUntilReady(base);

    const res = await fetch(`${base}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "rename the module", cwd: "/ws/agent-world" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouterResult;
    expect(body.model).toBe("haiku");
  });
});
