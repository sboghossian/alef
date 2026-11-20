// The hub on the wire: an index pass with nothing new sends no world rows, a change sends only what
// changed, a reconnect still gets a full snapshot, `?have=` skips the boot snapshot a tab already
// fetched, and big JSON answers go out gzipped.

import { appendFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage, WorldSnapshot } from "../../shared/types.js";
import type { ServerFeature } from "../features/registry.js";
import { acceptsGzip } from "../http.js";
import type { RunningServer } from "../index.js";
import { assistantLine, bootTestServer, userLine, writeSessionFile } from "./helpers.js";

const S1 = "11111111-0000-4000-8000-0000000000a1";
const S2 = "11111111-0000-4000-8000-0000000000a2";
const PASS_MS = 60;

let running: RunningServer | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await running?.close();
  running = null;
});

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function world(base: string): Promise<WorldSnapshot> {
  return (await (await fetch(`${base}/api/world`)).json()) as WorldSnapshot;
}

function listen(url: string): { got: ServerMessage[]; ws: WebSocket; open: Promise<void> } {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const got: ServerMessage[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerMessage));
  return { got, ws, open: new Promise<void>((r) => ws.on("open", () => r())) };
}

async function bootWithSessions(features: readonly ServerFeature[] = []): Promise<{ base: string; projects: string; cwd: string }> {
  const booted = await bootTestServer({ configOverrides: { features, indexIntervalMs: PASS_MS } });
  running = booted.server;
  const projects = join(booted.dir, "projects");
  const cwd = join(booted.dir, "work", "repo");
  for (const id of [S1, S2]) {
    await writeSessionFile(projects, "-work-repo", id, `${userLine({ cwd, timestamp: "2026-10-27T06:00:00.000Z", text: `task ${id}` })}\n`);
  }
  await until(async () => (await world(booted.base)).agents.length === 2);
  return { base: booted.base, projects, cwd };
}

const rowTypes = new Set(["agents", "agentsRemoved", "objects", "objectsRemoved", "edges", "stats"]);

describe("world broadcasts", () => {
  it("sends no world rows while nothing changes, then only the changed agent and the edge set", async () => {
    const { base, projects, cwd } = await bootWithSessions();
    const tab = listen(`${base.replace("http", "ws")}/ws`);
    await tab.open;
    await new Promise((r) => setTimeout(r, PASS_MS * 6));
    expect(tab.got.map((m) => m.type)).toEqual(["snapshot"]);

    const line = assistantLine({ cwd, timestamp: "2026-10-27T06:05:00.000Z", toolUses: [{ name: "Edit", input: { file_path: join(cwd, "a.ts") } }] });
    await appendFile(join(projects, "-work-repo", `${S1}.jsonl`), `${line}\n`);
    await until(() => tab.got.some((m) => m.type === "edges"));
    await new Promise((r) => setTimeout(r, PASS_MS * 4));

    const agents = tab.got.filter((m): m is Extract<ServerMessage, { type: "agents" }> => m.type === "agents");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agents.map((a) => a.id)).toEqual([S1]);
    const edges = tab.got.filter((m): m is Extract<ServerMessage, { type: "edges" }> => m.type === "edges");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edges.some((e) => e.from === S1)).toBe(true);
    tab.ws.close();
  });

  it("a reconnect (no have) still gets a full snapshot first", async () => {
    const { base } = await bootWithSessions();
    const first = listen(`${base.replace("http", "ws")}/ws`);
    await first.open;
    first.ws.close();
    const again = listen(`${base.replace("http", "ws")}/ws`);
    await until(() => again.got.length > 0);
    const msg = again.got[0];
    expect(msg?.type).toBe("snapshot");
    expect(msg?.type === "snapshot" && msg.world.agents.length).toBe(2);
    again.ws.close();
  });

  it("a second tab's snapshot doesn't make the first tab miss a change", async () => {
    const { base, projects, cwd } = await bootWithSessions();
    const a = listen(`${base.replace("http", "ws")}/ws`);
    await a.open;
    await appendFile(join(projects, "-work-repo", `${S2}.jsonl`), `${assistantLine({ cwd, timestamp: "2026-10-27T06:09:00.000Z", text: "done" })}\n`);
    // A second tab connects; whichever of its snapshot and the pass comes first, tab A must get S2.
    const b = listen(`${base.replace("http", "ws")}/ws`);
    await b.open;
    await until(() => a.got.some((m) => m.type === "agents" && m.agents.some((x) => x.id === S2)));
    a.ws.close();
    b.ws.close();
  });
});

describe("?have= skips the boot snapshot a tab already fetched", () => {
  it("answers with stats (and any changed rows) instead of the snapshot", async () => {
    const { base } = await bootWithSessions();
    const w = await world(base);
    const tab = listen(`${base.replace("http", "ws")}/ws?have=${encodeURIComponent(w.generatedAt)}`);
    await until(() => tab.got.length > 0);
    await new Promise((r) => setTimeout(r, PASS_MS * 3));
    expect(tab.got.map((m) => m.type)).toEqual(["stats"]);
    tab.ws.close();
  });

  it("sends the rows that changed between the GET and the WS", async () => {
    const { base } = await bootWithSessions();
    const w = await world(base);
    // A change that moves an agent row but no island (its lastActive stays): tokens.
    const db = running?.db;
    const s = db?.getSession(S2);
    if (!db || !s) throw new Error("no session");
    const zero = { messageCountDelta: 0, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 0, cntAssistantTotalDelta: 0 };
    db.upsertSession({ id: s.id, cwd: s.cwd, islandId: s.islandId, startedAt: s.startedAt, lastActive: s.lastActive, jsonlMtime: s.jsonlMtime, model: s.model, ...zero, tokensDelta: 500 });
    const tab = listen(`${base.replace("http", "ws")}/ws?have=${encodeURIComponent(w.generatedAt)}`);
    await until(() => tab.got.some((m) => m.type === "stats"));
    expect(tab.got.some((m) => m.type === "snapshot")).toBe(false);
    const agents = tab.got.filter((m): m is Extract<ServerMessage, { type: "agents" }> => m.type === "agents").flatMap((m) => m.agents);
    expect(agents.map((a) => [a.id, a.tokens])).toEqual([[S2, 500]]);
  });

  it("falls back to the full snapshot when an island moved since the GET", async () => {
    const { base, projects, cwd } = await bootWithSessions();
    const w = await world(base);
    await appendFile(join(projects, "-work-repo", `${S2}.jsonl`), `${assistantLine({ cwd, timestamp: "2026-10-27T06:09:00.000Z", text: "done" })}\n`);
    await until(async () => (await world(base)).islands.some((i) => i.lastActive === "2026-10-27T06:09:00.000Z"));
    const tab = listen(`${base.replace("http", "ws")}/ws?have=${encodeURIComponent(w.generatedAt)}`);
    await until(() => tab.got.length > 0);
    expect(tab.got[0]?.type).toBe("snapshot");
  });

  it("an unknown have gets the full snapshot", async () => {
    const { base } = await bootWithSessions();
    const tab = listen(`${base.replace("http", "ws")}/ws?have=1999-01-01T00:00:00.000Z`);
    await until(() => tab.got.length > 0);
    expect(tab.got[0]?.type).toBe("snapshot");
    tab.ws.close();
  });
});

describe("gzip", () => {
  function rawGet(base: string, path: string, encoding: string | null): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    const u = new URL(path, base);
    return new Promise((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, headers: encoding ? { "accept-encoding": encoding } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  const bulky: ServerFeature = { id: "bulky", snapshotExtras: () => ({ "bulky.blob": "x".repeat(40_000) }) };

  it("gzips a /api/world of 32 KB or more for a client that accepts it, and only then", async () => {
    const { base } = await bootWithSessions([bulky]);
    const zipped = await rawGet(base, "/api/world", "gzip, deflate, br");
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers.vary).toBe("Accept-Encoding");
    expect(Number(zipped.headers["content-length"])).toBe(zipped.body.length);
    const parsed = JSON.parse(gunzipSync(zipped.body).toString()) as WorldSnapshot;
    expect(parsed.agents).toHaveLength(2);
    expect(zipped.body.length).toBeLessThan(10_000);

    const plain = await rawGet(base, "/api/world", null);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect((JSON.parse(plain.body.toString()) as WorldSnapshot).agents).toHaveLength(2);
  });

  it("leaves a small answer alone", async () => {
    const { base } = await bootWithSessions();
    const res = await rawGet(base, "/api/world", "gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("reads Accept-Encoding with q-values", () => {
    const res = (h: string | undefined): Parameters<typeof acceptsGzip>[0] => ({ req: { headers: { "accept-encoding": h } } }) as unknown as Parameters<typeof acceptsGzip>[0];
    expect(acceptsGzip(res("gzip"))).toBe(true);
    expect(acceptsGzip(res("br, gzip;q=0.5"))).toBe(true);
    expect(acceptsGzip(res("*"))).toBe(true);
    expect(acceptsGzip(res("gzip;q=0"))).toBe(false);
    expect(acceptsGzip(res("br, deflate"))).toBe(false);
    expect(acceptsGzip(res(undefined))).toBe(false);
  });
});
