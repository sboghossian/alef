import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecallFeature } from "../features/recall/index.js";
import { appendJevWeb } from "../features/recall/jev-web.js";
import type { RecallResult } from "../../shared/features/recall.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

async function fixtureRoots(): Promise<{ dir: string; memoryDir: string; vaultProjectsDir: string; brainGraphPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-world-recall-route-"));
  const memoryDir = join(dir, "memory");
  const vaultProjectsDir = join(dir, "20-Projects");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(vaultProjectsDir, { recursive: true });
  await writeFile(join(memoryDir, "jessica.md"), "# email to Jessica about the contract\nDrafted the reply to Jessica about the signed contract.");
  const projectDir = join(vaultProjectsDir, "agent-world");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "_index.md"), "# agent-world\nA living 3D world of Claude Code sessions, built in TypeScript with three.js.");
  return { dir, memoryDir, vaultProjectsDir, brainGraphPath: join(dir, "brain-graph.json") };
}

/** The index builds in the background off a fire-and-forget promise (never blocks a
 *  boot or a request); tests poll briefly instead of assuming it's instant. */
async function waitUntilReady(base: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "ping" }),
    });
    const body = (await res.json()) as RecallResult;
    if (body.ready) return;
    if (Date.now() > deadline) throw new Error("recall index never became ready");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("POST /api/recall", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("finds the matching note by title and returns a redaction-safe snippet", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    await waitUntilReady(base);

    const res = await fetch(`${base}/api/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "who worked on the Jessica email?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallResult;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("bm25"); // skipOllamaProbe:true -> never hybrid
    expect(body.hits[0]?.title).toContain("Jessica");
    expect(body.hits[0]?.path).toContain("jessica.md");
    expect(body.hits.length).toBeLessThanOrEqual(3);
  });

  it("returns an empty (not error) result before the index is ready and for no-match queries", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    await waitUntilReady(base);

    const res = await fetch(`${base}/api/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "zzz nonexistent gibberish query zzz" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallResult;
    expect(body.ok).toBe(true);
    expect(body.hits).toEqual([]);
  });

  it("serves Jev's kept web finds beside world.db as `web`, never mixed into the notes", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s, dir } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;
    await waitUntilReady(base);
    const ask = async (question: string): Promise<RecallResult> =>
      (await (await fetch(`${base}/api/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) })).json()) as RecallResult;

    expect((await ask("jessica contract")).web).toBeUndefined(); // nothing kept yet
    // A search kept AFTER boot (websearch.ts appends while the server runs).
    await appendJevWeb(join(dir, "jev-web.jsonl"), new Date("2026-09-29T10:00:00Z"), "contract signing tools", [
      { title: "Best e-signature tools for contracts", url: "https://sign.test/contracts" },
      { title: "x", url: "javascript:alert(1)" },
    ]);
    const body = await ask("jessica contract");
    expect(body.hits[0]?.title).toContain("Jessica");
    expect(body.hits.every((h) => !h.path.startsWith("https:"))).toBe(true);
    expect(body.web).toEqual([
      { title: "Best e-signature tools for contracts", url: "https://sign.test/contracts", host: "sign.test", question: "contract signing tools", at: "2026-09-29T10:00:00.000Z", score: expect.any(Number) },
    ]);
  });

  it("400s on a missing/oversized question", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const empty = await fetch(`${base}/api/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "" }) });
    expect(empty.status).toBe(400);
    const long = await fetch(`${base}/api/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(501) }),
    });
    expect(long.status).toBe(400);
  });
});

describe("POST /api/recall/open", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("403s a path outside both the corpus roots and every known agent cwd", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const res = await fetch(`${base}/api/recall/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    expect(res.status).toBe(403);
  });

  it("403s a corpus path that isn't inside any known agent cwd (the common case)", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const res = await fetch(`${base}/api/recall/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(roots.memoryDir, "jessica.md") }),
    });
    expect(res.status).toBe(403);
  });

  it("opens a corpus path that IS inside a known agent island's cwd", async () => {
    const roots = await fixtureRoots();
    const feature = createRecallFeature({ roots, cacheDir: roots.dir, skipOllamaProbe: true });
    const calls: string[] = [];
    const { base, server: s } = await bootTestServer({
      configOverrides: { features: [feature] },
      openEditorExecutor: (path) => {
        calls.push(path);
      },
    });
    server = s;
    // Make the vault project dir a known island (as if the user ran `claude` there) —
    // islands are derived from real sessions, so a session is required, not just the cwd map.
    const projectDir = join(roots.vaultProjectsDir, "agent-world");
    s.db.setIslandForCwd(projectDir, "vault-agent-world");
    s.db.upsertSession({
      id: "33333333-3333-3333-3333-333333333333",
      cwd: projectDir,
      islandId: "vault-agent-world",
      title: "vault session",
      startedAt: "2026-09-20T00:00:00.000Z",
      lastActive: "2026-09-20T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
    });

    const target = join(projectDir, "_index.md");
    const res = await fetch(`${base}/api/recall/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([target]);
  });
});
