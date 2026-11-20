import { afterEach, describe, expect, it, vi } from "vitest";
import { askJev, dispatch, openEditor, reactivate, recall, recallOpen } from "./api";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(respond: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url));
  });
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reactivate / openEditor", () => {
  it("POSTs to the encoded agent id and returns the server result", async () => {
    const calls = mockFetch(() => json({ ok: true, agentId: "a/b" }));
    const res = await reactivate("a/b");
    expect(res).toEqual({ ok: true, agentId: "a/b" });
    expect(calls[0]?.url).toBe("/api/reactivate/a%2Fb");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("open-editor hits its own endpoint", async () => {
    const calls = mockFetch(() => json({ ok: true, agentId: "x" }));
    await openEditor("x");
    expect(calls[0]?.url).toBe("/api/open-editor/x");
  });

  it("turns a network failure into ok:false instead of throwing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const res = await reactivate("x");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("world server unreachable");
  });

  it("keeps the server's error body on a 4xx", async () => {
    mockFetch(() => json({ ok: false, agentId: "x", error: "unknown agent" }, 404));
    const res = await openEditor("x");
    expect(res).toEqual({ ok: false, agentId: "x", error: "unknown agent" });
  });

  it("reports the HTTP status when the body is not JSON", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const res = await reactivate("x");
    expect(res).toEqual({ ok: false, agentId: "x", error: "HTTP 500" });
  });
});

describe("dispatch", () => {
  it("sends the trimmed prompt and island", async () => {
    const calls = mockFetch(() => json({ ok: true, islandId: "web", cwd: "/w" }));
    const res = await dispatch({ islandId: "web", prompt: "  build it  " });
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/dispatch");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ islandId: "web", prompt: "build it" });
  });

  it("rejects empty, oversized, and harness requests without calling the server", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    expect((await dispatch({ islandId: "web", prompt: "   " })).ok).toBe(false);
    expect((await dispatch({ islandId: "web", prompt: "x".repeat(4001) })).ok).toBe(false);
    expect((await dispatch({ islandId: "harness", prompt: "hi" })).ok).toBe(false);
    expect((await dispatch({ islandId: "", prompt: "hi" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("askJev", () => {
  it("returns matches and source", async () => {
    const calls = mockFetch(() => json({ ok: true, matches: [{ agentId: "a", probability: 0.7 }], confidence: 0.7, source: "keyword" }));
    const res = await askJev({ question: "who did the email?" });
    expect(res.matches[0]?.agentId).toBe("a");
    expect(res.source).toBe("keyword");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ question: "who did the email?" });
  });

  it("validates length locally", async () => {
    const calls = mockFetch(() => json({}));
    expect((await askJev({ question: "" })).ok).toBe(false);
    expect((await askJev({ question: "q".repeat(501) })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("recall / recallOpen", () => {
  it("posts the trimmed question and returns the server's hits", async () => {
    const calls = mockFetch(() => json({ ok: true, hits: [{ path: "/x.md", title: "x", snippet: "y", score: 1 }], mode: "bm25", ready: true }));
    const res = await recall("  who worked on the moon renderer  ");
    expect(res.hits[0]?.path).toBe("/x.md");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ question: "who worked on the moon renderer" });
  });

  it("validates an empty question locally without calling the server", async () => {
    const calls = mockFetch(() => json({}));
    expect((await recall("   ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("recallOpen posts the path and reports failure without throwing on a network error", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const res = await recallOpen("/some/path.md");
    expect(res.ok).toBe(false);
  });
});
