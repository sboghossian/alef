// The webtrips feature through the live order: the hub's boot index pass (no lines collected, as
// server/index.ts runs it), then the feature's ticks (the bounded cold pass over main AND subagent
// transcripts), then incremental index passes whose raw lines reach onIndexPass (collectLines,
// exactly what the hub hands it). A call read by both paths counts once; a session is served only
// once every one of its transcripts is read to its end. Temp dirs only: never the real ~/.claude.

import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webTripsLine, type WebTripsResponse, type WebTripsSessionResponse } from "../../shared/features/webtrips.js";
import type { WorldDb } from "../db.js";
import { runIndexPass } from "../indexer.js";
import { appendJevWeb } from "../features/recall/jev-web.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { createWebTripsFeature } from "../features/webtrips.js";
import { appendToSessionFile, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const S = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003" };
const AT = "2026-09-29T08:00:00.000Z";

let n = 0;
function call(id: string, name: string, input: Record<string, unknown>, cwd = "/tmp/agent-world"): string {
  return JSON.stringify({ type: "assistant", uuid: `u${++n}`, timestamp: AT, cwd, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
}
function user(text: string, cwd = "/tmp/agent-world"): string {
  return JSON.stringify({ type: "user", uuid: `u${++n}`, timestamp: AT, cwd, message: { role: "user", content: [{ type: "text", text }] } });
}
/** The result line Claude Code writes when a call never ran (CLI 2.1.284's shape: see webtrips-lib.test.ts). */
function refused(id: string, text: string, kind: string | null = "permission-rule"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u${++n}`,
    timestamp: AT,
    message: { role: "user", content: [{ type: "tool_result", content: `<tool_use_error>${text}</tool_use_error>`, is_error: true, tool_use_id: id }] },
    toolUseResult: `Error: ${text}`,
    ...(kind ? { toolDenialKind: kind } : {}),
  });
}
function ran(id: string, text: string): string {
  return JSON.stringify({ type: "user", uuid: `u${++n}`, timestamp: AT, message: { role: "user", content: [{ type: "tool_result", content: text, tool_use_id: id }] } });
}
const lines = (...l: string[]): string => `${l.join("\n")}\n`;

interface Rig {
  projects: string;
  dir: string;
  db: WorldDb;
  ctx: FeatureContext;
  feature: ReturnType<typeof createWebTripsFeature>;
}

async function rig(budgetBytes?: number): Promise<Rig> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const projects = join(dir, "projects");
  await mkdir(projects, { recursive: true });
  const db = await makeTempDb(dir);
  const ctx = {
    featureId: "webtrips",
    db,
    config: { projectsDir: projects, dbPath: join(dir, "world.db") },
    emit: () => {},
    broadcast: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as FeatureContext;
  return { projects, dir, db, ctx, feature: createWebTripsFeature({ ...(budgetBytes !== undefined ? { budgetBytes } : {}) }) };
}

async function get<T>(r: Rig, path: string, params: Record<string, string> = {}): Promise<T> {
  const route = r.feature.routes!.find((x: Route) => x.path === path)!;
  let body = "";
  const res = { writeHead: () => res, end: (d: string) => void (body = d) };
  await route.handler({ url: path } as never, res as never, r.ctx, params);
  return JSON.parse(body) as T;
}

/** The hub's first pass at boot: offsets advance, NO lines reach any feature. */
const bootPass = (r: Rig): Promise<unknown> => runIndexPass(r.db, { projectsDir: r.projects });
/** Every later pass: the raw new lines go to onIndexPass. */
async function indexPass(r: Rig): Promise<void> {
  const stats = await runIndexPass(r.db, { projectsDir: r.projects, collectLines: true });
  await r.feature.onIndexPass!(r.ctx, stats.linesBySession);
}

async function subagentFile(r: Rig, projectDir: string, sessionId: string, agent: string, body: string): Promise<string> {
  const d = join(r.projects, projectDir, sessionId, "subagents");
  await mkdir(d, { recursive: true });
  const p = join(d, `agent-${agent}.jsonl`);
  await writeFile(p, body);
  return p;
}

describe("webtrips feature", () => {
  it("counts each house's trips (its subagents' too) once, whichever path read the line", async () => {
    const r = await rig();
    const fileA = await writeSessionFile(
      r.projects,
      "-a",
      S.a,
      lines(
        user("find the hooks docs"),
        call("toolu_A1", "WebSearch", { query: "claude code hooks" }),
        call("toolu_A2", "WebFetch", { url: "https://docs.anthropic.com/en/hooks", prompt: "p" }),
        call("toolu_A3", "Bash", { command: "curl -s localhost:5179/api/world" }), // this Mac: not a trip
      ),
    );
    await subagentFile(r, "-a", S.a, "research1", lines(call("toolu_S1", "mcp__exa__web_fetch_exa", { urls: ["https://exa.ai/docs"] }), call("toolu_S2", "mcp__obscura__browser_navigate", { url: "https://docs.anthropic.com/x" })));
    await writeSessionFile(r.projects, "-b", S.b, lines(user("refactor"), call("toolu_B1", "Read", { file_path: "/tmp/x" })));

    await bootPass(r);
    await r.feature.onTick!(r.ctx);

    const a = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(a.ready).toBe(true);
    expect(a.entry).toMatchObject({ trips: 4, subagentTrips: 2, hosts: 2, byTool: { WebSearch: 1, WebFetch: 1, exa: 1, obscura: 1 } });
    expect(a.entry?.topHosts[0]).toEqual({ host: "docs.anthropic.com", trips: 2 });
    const b = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.b });
    expect(b.entry).toMatchObject({ trips: 0, hosts: 0 });

    // New lines: the indexer hands them to onIndexPass; a replayed old line is not counted again.
    await appendToSessionFile(fileA, lines(call("toolu_A4", "mcp__firecrawl__firecrawl_scrape", { url: "https://firecrawl.dev/pricing" })));
    await indexPass(r);
    await r.feature.onIndexPass!(r.ctx, new Map([[S.a, [call("toolu_A2", "WebFetch", { url: "https://docs.anthropic.com/en/hooks", prompt: "p" })]]]));
    // A subagent line lands on the next tick (the indexer never passes subagent transcripts).
    await appendToSessionFile(join(r.projects, "-a", S.a, "subagents", "agent-research1.jsonl"), lines(call("toolu_S3", "WebSearch", { query: "q" })));
    await r.feature.onTick!(r.ctx);

    const a2 = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(a2.entry).toMatchObject({ trips: 6, subagentTrips: 3, hosts: 3 });
    const all = await get<WebTripsResponse>(r, "/api/webtrips");
    expect(all.summary).toMatchObject({
      ready: true,
      transcripts: { main: 2, mainWithTrips: 1, subagent: 1, subagentWithTrips: 1 },
      sessionsWithTrips: 1,
      trips: 6,
      byTool: { WebSearch: 2, WebFetch: 1, exa: 1, firecrawl: 1, obscura: 1 },
    });
    expect(JSON.stringify(all)).not.toContain("hooks docs"); // hosts and tool names only, never transcript text
  });

  it("a session first seen through the indexer (before any tick) is not counted twice by the cold pass", async () => {
    const r = await rig();
    await bootPass(r);
    await writeSessionFile(r.projects, "-c", S.c, lines(call("toolu_C1", "WebSearch", { query: "q" }), call("toolu_C2", "WebFetch", { url: "https://a.test/", prompt: "p" })));
    await indexPass(r); // a new file: its whole body reaches onIndexPass
    await r.feature.onTick!(r.ctx); // then the cold pass reads it from 0 too
    const c = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.c });
    expect(c.entry).toMatchObject({ trips: 2, subagentTrips: 0 });
  });

  it("fails closed while a session is half read: no entry until every transcript of it is read", async () => {
    const r = await rig(1); // one transcript per tick
    await writeSessionFile(r.projects, "-a", S.a, lines(call("toolu_A1", "WebSearch", { query: "q" })));
    await subagentFile(r, "-a", S.a, "helper01", lines(call("toolu_S1", "WebSearch", { query: "q" })));
    await bootPass(r);

    const before = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(before).toEqual({ ok: true, ready: false, entry: null });
    await r.feature.onTick!(r.ctx);
    const half = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(half).toEqual({ ok: true, ready: false, entry: null });
    expect((await get<WebTripsResponse>(r, "/api/webtrips")).summary.ready).toBe(false);
    await r.feature.onTick!(r.ctx);
    const done = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(done.ready).toBe(true);
    expect(done.entry?.trips).toBe(2);
  });

  it("drops a pruned session, and counts Jev's kept trips from data/jev-web.jsonl", async () => {
    const r = await rig();
    const fileB = await writeSessionFile(r.projects, "-b", S.b, lines(call("toolu_B1", "WebSearch", { query: "q" })));
    await bootPass(r);
    await r.feature.onTick!(r.ctx);
    expect((await get<WebTripsResponse>(r, "/api/webtrips")).summary.trips).toBe(1);
    await rm(fileB);
    await r.feature.onTick!(r.ctx);
    const s = (await get<WebTripsResponse>(r, "/api/webtrips")).summary;
    expect(s.trips).toBe(0);
    expect(s.jev).toEqual({ trips: 0, since: null, last: null });

    const log = join(r.dir, "jev-web.jsonl");
    await appendJevWeb(log, new Date("2026-09-29T10:00:00Z"), "hooks", [{ title: "Hooks", url: "https://docs.anthropic.com/hooks" }]);
    await appendJevWeb(log, new Date("2026-09-29T11:00:00Z"), "pricing", []);
    const jev = await get<{ ok: true; jev: unknown }>(r, "/api/webtrips/jev");
    expect(jev.jev).toEqual({ trips: 2, since: "2026-09-29T10:00:00.000Z", last: "2026-09-29T11:00:00.000Z" });
  });

  it("jevRead: the placeholder 0 before the first read is not a measurement; a read of a missing log is", async () => {
    const r = await rig();
    expect(r.feature.jevRead()).toBe(false);
    expect(r.feature.summary().jev.trips).toBe(0); // a placeholder until read
    await bootPass(r);
    await r.feature.onTick!(r.ctx);
    expect(r.feature.jevRead()).toBe(true); // no data/jev-web.jsonl yet: read as none kept
    expect(r.feature.summary().jev).toEqual({ trips: 0, since: null, last: null });
  });

  it("a denied call is not a web trip: a rule, the user, the classifier, a headless run, WebFetch's domain check", async () => {
    const r = await rig();
    await writeSessionFile(
      r.projects,
      "-a",
      S.a,
      lines(
        // The finding's case: a lone WebFetch whose result is a denial.
        call("toolu_A1", "WebFetch", { url: "https://denied.test/", prompt: "p" }),
        refused("toolu_A1", "Permission to use WebFetch with domain:denied.test has been denied."),
        call("toolu_A2", "WebSearch", { query: "q" }),
        refused("toolu_A2", "The user doesn't want to proceed with this tool use.", "user-rejected"),
        call("toolu_A3", "Bash", { command: "curl -s https://classifier.test/x" }),
        refused("toolu_A3", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: unknown host", "automode-blocked"),
        call("toolu_A4", "WebFetch", { url: "https://headless.test/", prompt: "p" }),
        refused("toolu_A4", "Claude requested permissions to use WebFetch, but you haven't granted it yet.", null),
        call("toolu_A5", "WebFetch", { url: "https://blocked.test/", prompt: "p" }),
        refused("toolu_A5", "Error calling tool (WebFetch): Claude Code is unable to fetch from blocked.test", null),
        // One that ran (a failed fetch still went out) and one interrupted mid-run: both trips.
        call("toolu_A6", "Bash", { command: "curl -s https://ran.test/x" }),
        ran("toolu_A6", "Exit code 6\ncurl: (6) Could not resolve host: ran.test"),
        call("toolu_A7", "WebFetch", { url: "https://cut.test/", prompt: "p" }),
        refused("toolu_A7", "[Request interrupted by user for tool use]", "interrupted"),
      ),
    );
    // A subagent whose only web call was refused did not make a web trip.
    await subagentFile(r, "-a", S.a, "helper01", lines(call("toolu_S1", "WebSearch", { query: "q" }), refused("toolu_S1", "Execution stopped by PreToolUse hook: web is off")));
    await writeSessionFile(r.projects, "-b", S.b, lines(call("toolu_B1", "WebFetch", { url: "https://denied.test/", prompt: "p" }), refused("toolu_B1", "no web from this repo")));

    await bootPass(r);
    await r.feature.onTick!(r.ctx);

    const a = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a });
    expect(a.entry).toMatchObject({ trips: 2, subagentTrips: 0, hosts: 2, byTool: { curl: 1, WebFetch: 1 } });
    expect(a.entry?.topHosts.map((h) => h.host).sort()).toEqual(["cut.test", "ran.test"]);
    const b = await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.b });
    expect(b.entry).toMatchObject({ trips: 0, hosts: 0, topHosts: [], lastAt: null });
    expect(webTripsLine(b.entry!)).toBe("No web trips");
    const all = (await get<WebTripsResponse>(r, "/api/webtrips")).summary;
    expect(all).toMatchObject({ trips: 2, sessionsWithTrips: 1, transcripts: { main: 2, mainWithTrips: 1, subagent: 1, subagentWithTrips: 0 } });
    expect(all.topHosts.map((h) => h.host)).not.toContain("denied.test");
  });

  it("a denial is honoured whichever path reads it first (cold pass vs the indexer's lines)", async () => {
    // Call counted by the cold pass, its denial arriving later through the indexer: taken back.
    const r = await rig();
    const fileA = await writeSessionFile(r.projects, "-a", S.a, lines(call("toolu_A1", "WebFetch", { url: "https://late.test/", prompt: "p" })));
    await bootPass(r);
    await r.feature.onTick!(r.ctx);
    expect((await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a })).entry?.trips).toBe(1);
    await appendToSessionFile(fileA, lines(refused("toolu_A1", "Permission to use WebFetch has been denied.")));
    await indexPass(r);
    expect((await get<WebTripsSessionResponse>(r, "/api/webtrips/session/:sessionId", { sessionId: S.a })).entry).toMatchObject({ trips: 0, hosts: 0 });

    // Denial first: the indexer hands over the denial before the cold pass reaches the call (a
    // 1-byte budget reads one transcript per tick, the newer subagent file first).
    const r2 = await rig(1);
    const fileC = await writeSessionFile(r2.projects, "-c", S.c, lines(call("toolu_C1", "WebFetch", { url: "https://early.test/", prompt: "p" })));
    const old = new Date(Date.now() - 60_000);
    await utimes(fileC, old, old);
    await subagentFile(r2, "-c", S.c, "helper02", lines(call("toolu_S2", "WebSearch", { query: "q" })));
    await bootPass(r2);
    await r2.feature.onTick!(r2.ctx); // lists both (the main's target stops before the denial), reads the subagent only
    await appendToSessionFile(fileC, lines(refused("toolu_C1", "The user doesn't want to proceed with this tool use.", "user-rejected")));
    await indexPass(r2); // the denial, before its call was read
    await r2.feature.onTick!(r2.ctx); // now the call: never counted
    const c = await get<WebTripsSessionResponse>(r2, "/api/webtrips/session/:sessionId", { sessionId: S.c });
    expect(c.ready).toBe(true);
    expect(c.entry).toMatchObject({ trips: 1, subagentTrips: 1, hosts: 0, byTool: { WebSearch: 1 } });
  });
});
