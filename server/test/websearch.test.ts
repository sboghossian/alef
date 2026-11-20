import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSearchResult } from "../../shared/features/websearch.js";
import { jevWebLine, parseJevWeb } from "../features/recall/jev-web.js";
import { createWebSearchFeature, parseSearchOutput, plainSnippet, type SearchRunner } from "../features/websearch.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const out = (results: unknown[]): string => JSON.stringify({ query: "q", results, hidden: 0 });

describe("plainSnippet", () => {
  it("strips Firecrawl markdown down to readable text", () => {
    expect(plainSnippet("## [\u200b](https://x.test/#a) Hook events ### [Docs](https://x.test) **bold** `code`")).toBe(
      "Hook events Docs bold code",
    );
    expect(plainSnippet(undefined)).toBe("");
  });
});

describe("parseSearchOutput", () => {
  it("keeps http(s) hits, clamps rank, collapses snippet whitespace", () => {
    const r = parseSearchOutput(
      out([
        { title: "Docs", url: "https://code.claude.com/docs/en/hooks", snippet: "a\n\n  b", rank: 0.84 },
        { title: "evil", url: "javascript:alert(1)", snippet: "", rank: 0.9 },
        { title: "", url: "http://x.test/", snippet: "", rank: 7 },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.hits.map((h) => h.url)).toEqual(["https://code.claude.com/docs/en/hooks", "http://x.test/"]);
    expect(r.hits[0]!.snippet).toBe("a b");
    expect(r.hits[1]!.rank).toBe(1);
    expect(r.hits[1]!.title).toBe("http://x.test/");
    expect(r.weak).toBe(false);
  });

  it("flags weak when the best rank is under 0.5, or nothing came back", () => {
    expect(parseSearchOutput(out([{ title: "t", url: "https://a.test", snippet: "", rank: 0.3 }])).weak).toBe(true);
    expect(parseSearchOutput(out([])).weak).toBe(true);
  });

  it("keeps Jev-failed (null rank) hits and does not call them weak", () => {
    const r = parseSearchOutput(out([{ title: "t", url: "https://a.test", snippet: "", rank: null }]));
    expect(r.hits[0]!.rank).toBeNull();
    expect(r.weak).toBe(false);
  });

  it("caps at 5 hits and survives malformed rows / invalid JSON", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://a.test/${i}`, rank: 0.9 }));
    expect(parseSearchOutput(out([...many, null, 3])).hits).toHaveLength(5);
    expect(parseSearchOutput("not json").ok).toBe(false);
  });
});

describe("POST /api/websearch", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  let dataDir = "";
  async function boot(run: SearchRunner): Promise<string> {
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [createWebSearchFeature(run)] } });
    server = s;
    dataDir = dir; // world.db's folder: where data/jev-web.jsonl goes
    return base;
  }
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/websearch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("passes the trimmed question to the runner and returns parsed hits", async () => {
    const seen: string[] = [];
    const base = await boot(async (q) => {
      seen.push(q);
      return out([{ title: "Docs", url: "https://a.test", snippet: "s", rank: 0.8 }]);
    });
    const res = await post(base, { question: "  hooks  " });
    const json = (await res.json()) as WebSearchResult;
    expect(res.status).toBe(200);
    expect(seen).toEqual(["hooks"]);
    expect(json.hits[0]!.url).toBe("https://a.test");
  });

  it("rejects empty / oversized questions with 400", async () => {
    const base = await boot(async () => out([]));
    expect((await post(base, { question: "   " })).status).toBe(400);
    expect((await post(base, { question: "x".repeat(301) })).status).toBe(400);
  });

  it("reports a runner failure as ok:false, not a 500", async () => {
    const base = await boot(async () => {
      throw new Error("firecrawl failed: no credits");
    });
    const json = (await (await post(base, { question: "q" })).json()) as WebSearchResult;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("no credits");
  });

  it("keeps every search that came back in jev-web.jsonl, after the trips already kept", async () => {
    const base = await boot(async () =>
      out([
        { title: "Hooks", url: "https://docs.anthropic.com/en/hooks", snippet: "s", rank: 0.9 },
        { title: "evil", url: "javascript:alert(1)", snippet: "", rank: 0.8 },
      ]),
    );
    // Existing state: an earlier trip is already kept (the append must not rewrite it).
    const log = join(dataDir, "jev-web.jsonl");
    await writeFile(log, jevWebLine(new Date("2026-09-28T09:00:00Z"), "earlier", [{ title: "Old", url: "https://old.test/" }]));
    const json = (await (await post(base, { question: "  claude hooks  " })).json()) as WebSearchResult;
    expect(json.kept).toBe(true);
    const kept = parseJevWeb(await readFile(log, "utf8"));
    expect(kept.map((e) => e.question)).toEqual(["earlier", "claude hooks"]);
    expect(kept[1]!.hits).toEqual([{ title: "Hooks", url: "https://docs.anthropic.com/en/hooks" }]);
  });

  it("keeps nothing when the search failed or came back unreadable", async () => {
    const base = await boot(async (q) => {
      if (q === "boom") throw new Error("no credits");
      return "not json";
    });
    expect(((await (await post(base, { question: "boom" })).json()) as WebSearchResult).kept).toBeUndefined();
    expect(((await (await post(base, { question: "garbled" })).json()) as WebSearchResult).kept).toBeUndefined();
    await expect(readFile(join(dataDir, "jev-web.jsonl"), "utf8")).rejects.toThrow();
  });

  it("single-flights: a second concurrent search gets 429", async () => {
    let release: () => void = () => {};
    const base = await boot(() => new Promise((r) => (release = () => r(out([])))));
    const first = post(base, { question: "a" });
    await new Promise((r) => setTimeout(r, 50));
    expect((await post(base, { question: "b" })).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});
