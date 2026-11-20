// The careers feature through its real data sources: transcripts written to a temp projects dir,
// the real indexer filling a real temp WorldDb, the real buildWorldViews (the /api/world agent
// shape, titles as the indexer stores them), and the real outcomes feature turning those
// transcripts into the records careers reads through latestOutcomeRecords(). Only the archive list,
// the routines scan and the Feed sink are injected, and the clock.

import { readdir, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchivedSession } from "../../shared/features/archive.js";
import { CAREERS_SUMMARY_KEY, parseCareersResponse, type CareersActionResult, type CareersResponse, type CareerWorker } from "../../shared/features/careers.js";
import type { FeedItem } from "../../shared/features/feed.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { WorldDb } from "../db.js";
import { buildWorldViews } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { createCareersFeature, latestCareerTrends, type CareersFeatureOptions } from "../features/careers.js";
import { publishKey } from "../features/careers-lib.js";
import { createOutcomesFeature } from "../features/outcomes.js";
import type { FeatureContext, Route, ServerFeature } from "../features/registry.js";
import { bootTestServer, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-09-28T12:00:00.000Z");

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── real-shaped transcript lines ────────────────────────────────────────

/** A launchd `claude -p "/inbox-sweep …"` run's first prompt: the CLI's command wrapper. */
function commandPrompt(skill: string): string {
  return `<command-message>${skill}</command-message>\n<command-name>/${skill}</command-name>\n<command-args>— headless run, nobody is there to answer.</command-args>`;
}

function prompt(cwd: string, sid: string, t: string, ms: number): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: t }, uuid: `p-${ms}`, timestamp: iso(ms), cwd, sessionId: sid, entrypoint: "sdk-cli" });
}

function toolUse(cwd: string, sid: string, id: string, name: string, input: Record<string, unknown>, ms: number): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    message: { model: "claude-opus-5-5", id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null },
    uuid: `u-${id}`,
    timestamp: iso(ms),
    cwd,
    sessionId: sid,
    entrypoint: "sdk-cli",
  });
}

function toolResult(cwd: string, sid: string, id: string, text: string, ms: number): string {
  return JSON.stringify({ isSidechain: false, type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text, is_error: false }] }, uuid: `r-${id}`, timestamp: iso(ms), cwd, sessionId: sid, entrypoint: "sdk-cli" });
}

function finalText(cwd: string, sid: string, t: string, ms: number): string {
  return JSON.stringify({ isSidechain: false, type: "assistant", message: { model: "claude-opus-5-5", id: `msg_f${ms}`, type: "message", role: "assistant", content: [{ type: "text", text: t }], stop_reason: "end_turn" }, timestamp: iso(ms), cwd, sessionId: sid, entrypoint: "sdk-cli" });
}

// ── the world ───────────────────────────────────────────────────────────

interface World {
  dir: string;
  projectsDir: string;
  dataDir: string;
  db: WorldDb;
  clock: { now: number };
  n: number;
}

async function makeWorld(): Promise<World> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const projectsDir = join(dir, "projects");
  await mkdir(projectsDir, { recursive: true });
  return { dir, projectsDir, dataDir: join(dir, "data"), db: await makeTempDb(dir), clock: { now: BASE }, n: 0 };
}

function sid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/** How a run went:
 *   finished  a TodoWrite list, all completed, and a Write (outcomes: "finished", a clean run);
 *   wrote     a Write and its result, nothing else (outcomes: "unknown": it only wrote a file);
 *   empty     it only answers in text (0 tool calls);
 *   cut-off   a finished run's work, then nothing: its last line is the Write's tool result;
 *   asks      a finished run's work, then a closing question to the user. */
type RunKind = "finished" | "wrote" | "empty" | "cut-off" | "asks";

/** One automation run of `skill`, started `hoursAgo` before the clock (ending on a final text,
 *  except a cut-off one). */
async function addRun(w: World, skill: string, hoursAgo: number, kind: RunKind): Promise<string> {
  w.n += 1;
  const id = sid(w.n);
  const cwd = w.dir;
  const t = w.clock.now - hoursAgo * HOUR;
  const lines = [prompt(cwd, id, commandPrompt(skill), t), ...workLines(w, id, kind, t)];
  const last = kind === "empty" ? "Nothing to do today." : kind === "asks" ? "Wrote today's brief. Should I also archive yesterday's?" : "Wrote today's brief.";
  if (kind !== "cut-off") lines.push(finalText(cwd, id, last, t + 3000));
  const path = await writeSessionFile(w.projectsDir, "-Users-me", id, lines.join("\n") + "\n");
  const end = new Date(t + 3000);
  await utimes(path, end, end);
  return id;
}

/** The tool calls (and their results) of a run of this kind, between t and t + 2s. */
function workLines(w: World, id: string, kind: RunKind, t: number): string[] {
  if (kind === "empty") return [];
  const cwd = w.dir;
  const file = join(w.dir, "out", `${w.n}.md`);
  const lines: string[] = [];
  if (kind !== "wrote") {
    lines.push(toolUse(cwd, id, `toolu_t${w.n}`, "TodoWrite", { todos: ["gather", "write"].map((x) => ({ content: x, status: "completed", activeForm: x })) }, t + 500));
    lines.push(toolResult(cwd, id, `toolu_t${w.n}`, "Todos have been modified successfully.", t + 600));
  }
  lines.push(toolUse(cwd, id, `toolu_${w.n}`, "Write", { file_path: file, content: "brief" }, t + 1000));
  lines.push(toolResult(cwd, id, `toolu_${w.n}`, `File created successfully at: ${file}`, t + 2000));
  return lines;
}

function ctxFor(w: World, emitted: unknown[] = []): FeatureContext {
  return {
    featureId: "careers",
    db: w.db,
    config: { projectsDir: w.projectsDir, dbPath: join(w.dir, "world.db") },
    emit: (p: unknown) => void emitted.push(p),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    worldViews: () => buildWorldViews(w.db, new Map(), new Date(w.clock.now)),
  } as unknown as FeatureContext;
}

/** The indexer and the real outcomes feature catch up with what is on disk. */
async function settle(w: World, outcomes: ServerFeature): Promise<void> {
  await runIndexPass(w.db, { projectsDir: w.projectsDir, homeDir: w.dir });
  await outcomes.onTick!(ctxFor(w));
}

function outcomesFor(w: World): ServerFeature {
  return createOutcomesFeature({ dataDir: w.dataDir, now: () => w.clock.now, feed: () => {}, gh: async () => ({ ok: false, code: "ENOENT" }) });
}

function careersFor(w: World, opts: CareersFeatureOptions = {}): { f: ServerFeature; feed: Array<Omit<FeedItem, "seq">> } {
  const feed: Array<Omit<FeedItem, "seq">> = [];
  const f = createCareersFeature({ dataDir: w.dataDir, now: () => w.clock.now, feed: (i) => void feed.push(i), sources: { archive: () => [], routines: () => [] }, ...opts });
  return { f, feed };
}

async function call(feature: ServerFeature, ctx: FeatureContext, method: "GET" | "POST", path: string, params: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: unknown }> {
  const route = feature.routes?.find((r: Route) => r.path === path && r.method === method);
  if (!route) throw new Error(`${method} ${path}`);
  let status = 0;
  let out = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (d: string) => void (out = d),
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  await route.handler(req as never, res as never, ctx, params);
  return { status, body: JSON.parse(out) as unknown };
}

async function workers(f: ServerFeature, ctx: FeatureContext): Promise<Map<string, CareerWorker>> {
  const r = await call(f, ctx, "GET", "/api/careers");
  expect(r.status).toBe(200);
  return new Map((r.body as CareersResponse).workers.map((w) => [w.key, w]));
}

function post(f: ServerFeature, ctx: FeatureContext, key: string, action: "retire" | "unretire" | "name", body: unknown): Promise<{ status: number; body: unknown }> {
  return call(f, ctx, "POST", `/api/careers/:key/${action}`, { key }, body);
}

/** Five clean daily /inbox-sweep runs, the newest 2h ago: a trusted worker. */
async function trustedSweep(w: World, outcomes: ServerFeature): Promise<void> {
  for (let i = 0; i < 5; i++) await addRun(w, "inbox-sweep", 2 + 24 * i, "finished");
  await settle(w, outcomes);
}

describe("careers feature", () => {
  it("boot is silent; a lineage first seen after boot joins silently; a settled move is announced once", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const { f, feed } = careersFor(w);
    const emitted: unknown[] = [];
    const ctx = ctxFor(w, emitted);

    await f.onTick!(ctx);
    expect(feed).toEqual([]); // boot: every state recorded, nothing announced
    const first = await workers(f, ctx);
    expect(first.get("/inbox-sweep")).toMatchObject({ state: "trusted", department: "Inbox desk", lifetime: { total: 5, clean: 5, bad: 0 } });
    expect(emitted).toEqual([{ kind: "summary", summary: { trusted: 1, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 1 } }]);

    // A lineage first seen after boot, through the real /api/world agent shape (the indexer's title).
    w.clock.now += HOUR;
    const ig = await addRun(w, "ig-innovation", 0.5, "finished");
    await settle(w, outcomes);
    const agentShape = buildWorldViews(w.db, new Map(), new Date(w.clock.now)).agents.find((a) => a.id === ig)!;
    expect(agentShape.title).toBe("ig-innovation /ig-innovation — headless run, nobody is there to answer.");
    await f.onTick!(ctx);
    expect(feed).toEqual([]);
    expect((await workers(f, ctx)).get("/ig-innovation")).toMatchObject({ state: "enrolled", department: "Research library", lifetime: { total: 1, clean: 1 } });

    // A run that did nothing: while outcomes hasn't read it, the move waits (awaiting); once read, one Feed line.
    w.clock.now += HOUR;
    await addRun(w, "inbox-sweep", 0.5, "empty");
    await runIndexPass(w.db, { projectsDir: w.projectsDir, homeDir: w.dir });
    await f.onTick!(ctx);
    expect(feed).toEqual([]);
    expect((await workers(f, ctx)).get("/inbox-sweep")!.runs[0]).toMatchObject({ mark: "unknown", why: "not scanned by outcomes yet" });

    await outcomes.onTick!(ctxFor(w));
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "graduation", title: "↩ /inbox-sweep back on probation: did nothing: 0 tool calls", tag: "career-probation" });
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1); // announced once
  });

  it("runs that only wrote a file never graduate: outcomes calls them unknown, the Tower 'wrote'", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    for (let i = 1; i <= 4; i++) await addRun(w, "yalla-brief", 2 + 24 * i, "wrote");
    await settle(w, outcomes);
    const { f, feed } = careersFor(w);
    const ctx = ctxFor(w);
    await f.onTick!(ctx); // baseline
    await addRun(w, "yalla-brief", 2, "wrote");
    await settle(w, outcomes);
    await f.onTick!(ctx);
    expect(feed).toEqual([]);
    const brief = (await workers(f, ctx)).get("/yalla-brief")!;
    expect(brief).toMatchObject({ state: "enrolled", trustedSince: null, lifetime: { total: 5, clean: 0, wrote: 5, bad: 0 } });
    expect(brief.runs.map((r) => [r.mark, r.why])).toEqual(Array(5).fill(["wrote", "wrote 1 file edit: no shipped, delivered or finished evidence"]));
    // The client's validator keeps a worker whose runs are marked "wrote" (it drops what it doesn't know).
    const body = (await call(f, ctx, "GET", "/api/careers")).body;
    expect(parseCareersResponse(body)?.workers.map((x) => x.key)).toEqual(["/yalla-brief"]);
  });

  it("a verdict outcomes can still change never graduates it: a cut-off 5th run is one probation line", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    for (let i = 1; i <= 4; i++) await addRun(w, "yalla-brief", 24 * i, "finished");
    await settle(w, outcomes);
    const { f, feed } = careersFor(w);
    const ctx = ctxFor(w);
    await f.onTick!(ctx); // baseline: enrolled, 4 of 5 clean
    // The 5th run does its work and is cut off: its last line is a tool result. 15 min later the
    // outcomes scanner has read it (dormant 10+ min) and, inside fold's 30-min stall bound, calls
    // it finished for now, and says so.
    const cut = await addRun(w, "yalla-brief", 0.25, "cut-off");
    await settle(w, outcomes);
    const rec = (await call(outcomes, ctx, "GET", "/api/outcomes/:agentId", { agentId: cut })).body as OutcomeRecord;
    expect(rec).toMatchObject({ outcome: "finished", pending: false, provisionalUntil: iso(w.clock.now - 0.25 * HOUR + 3000 + 30 * MIN) });
    await f.onTick!(ctx);
    expect(feed).toEqual([]); // not "🎓 graduated"
    const during = (await workers(f, ctx)).get("/yalla-brief")!;
    expect(during).toMatchObject({ state: "enrolled", reason: "4 of 5 clean runs in a row toward trusted" }); // the Tower chip too
    expect(during.runs[0]).toMatchObject({ id: cut, mark: "unknown", why: expect.stringMatching(/^not final yet: outcomes may still call it cut off or abandoned/) });
    // 35 min after its last line: past the bound, outcomes calls it failed for good.
    w.clock.now += 20 * MIN;
    await settle(w, outcomes);
    await f.onTick!(ctx);
    expect(feed.map((i) => i.title)).toEqual(["↩ /yalla-brief on probation: failed: cut off: no reply after a tool result"]);
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1);
  });

  it("a run that ends on a question counts only once outcomes' 24h abandon window has passed", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    for (let i = 1; i <= 4; i++) await addRun(w, "yalla-brief", 24 * i, "finished");
    await settle(w, outcomes);
    const { f, feed } = careersFor(w);
    const ctx = ctxFor(w);
    await f.onTick!(ctx);
    const asks = await addRun(w, "yalla-brief", 1, "asks");
    await settle(w, outcomes);
    await f.onTick!(ctx);
    expect(feed).toEqual([]);
    expect((await workers(f, ctx)).get("/yalla-brief")!.runs[0]).toMatchObject({ id: asks, mark: "unknown" });
    w.clock.now += 24 * HOUR;
    await settle(w, outcomes);
    await f.onTick!(ctx);
    expect(feed.map((i) => i.title)).toEqual(["↩ /yalla-brief on probation: abandoned: its last message asked you a question"]);
  });

  it("no baseline until the archive list has loaded: late fossils never read as a wave", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    let archive: ArchivedSession[] | null = null;
    const { f, feed } = careersFor(w, { sources: { archive: () => archive, routines: () => [] } });
    const ctx = ctxFor(w);
    await f.onTick!(ctx);
    const body = (await call(f, ctx, "GET", "/api/careers")).body as CareersResponse;
    expect(body.inputs.archiveLoaded).toBe(false);

    // The archive arrives with an old, long-quiet lineage: first seen, so silent (not "stopped reporting").
    archive = [1, 2, 3].map((i) => ({ id: `aaaaaaa${i}-0000-4000-8000-000000000000`, title: "History: Task: Pull every indemnification clause", date: `2026-07-2${i}`, project: "root", place: "topic:AUTO", note: `10-Sessions/claude-code/2026-07-2${i}-x.md` }));
    await f.onTick!(ctx);
    expect(feed).toEqual([]);
    expect((await workers(f, ctx)).get("eval-harness")).toMatchObject({ state: "lapsed", lifetime: { total: 3, archived: 3, clean: 0 } });
    // The settled trends (the vision ledger's "keep getting better" probe) are the ones GET serves.
    const served = ((await call(f, ctx, "GET", "/api/careers")).body as CareersResponse).trends;
    expect(served.map((t) => t.key)).toContain("eval-harness");
    expect(latestCareerTrends()).toEqual(served);

    // Time passes with no /inbox-sweep run: lapsing is news, announced once.
    w.clock.now += 80 * HOUR;
    await f.onTick!(ctx);
    expect(feed.map((i) => i.title)).toEqual([expect.stringMatching(/^💤 \/inbox-sweep stopped reporting \(last run 2026-09-28\)$/)]);
  });

  it("snapshotExtras carries the count per state", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    await addRun(w, "yalla-brief", 3, "finished");
    await settle(w, outcomes);
    const { f } = careersFor(w);
    expect(f.snapshotExtras!(ctxFor(w))).toEqual({ [CAREERS_SUMMARY_KEY]: { trusted: 1, probation: 0, enrolled: 1, lapsed: 0, returned: 0, retired: 0, total: 2 } });
  });
});

describe("summary pushes (the campus re-reads the trusted workers on them)", () => {
  it("renaming a trusted worker keeps every count yet still pushes; the same state twice pushes once", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const { f } = careersFor(w);
    const emitted: unknown[] = [];
    const ctx = ctxFor(w, emitted);
    await f.onTick!(ctx);
    await f.onTick!(ctx);
    const summary = { trusted: 1, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 1 };
    expect(emitted).toEqual([{ kind: "summary", summary }]);
    expect((await post(f, ctx, "/inbox-sweep", "name", { confirm: true, name: "Carillon" })).status).toBe(200);
    expect(emitted).toEqual([
      { kind: "summary", summary },
      { kind: "summary", summary },
    ]);
    await f.onTick!(ctx);
    expect(emitted).toHaveLength(2);
  });

  it("act() (the path commencement's Retire takes, outside any route) retires and pushes the new summary", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const f = createCareersFeature({ dataDir: w.dataDir, now: () => w.clock.now, feed: () => {}, sources: { archive: () => [], routines: () => [] } });
    const emitted: unknown[] = [];
    const ctx = ctxFor(w, emitted);
    await f.onTick!(ctx);
    expect(await f.act(ctx, "retire", "/inbox-sweep", null)).toEqual({ status: 200, body: { ok: true, key: "/inbox-sweep", state: "retired", name: null } });
    expect(emitted).toEqual([
      { kind: "summary", summary: { trusted: 1, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 1 } },
      { kind: "summary", summary: { trusted: 0, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 1, total: 1 } },
    ]);
  });

  it("publishKey: a swap that keeps the counts (A loses trust as B gains it) is a different key", () => {
    const s = { trusted: 1, probation: 1, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: 2 };
    const before = publishKey(s, [
      { key: "/a", state: "trusted", name: null, department: "Inbox desk" },
      { key: "/b", state: "probation", name: null, department: "Inbox desk" },
    ]);
    const after = publishKey(s, [
      { key: "/a", state: "probation", name: null, department: "Inbox desk" },
      { key: "/b", state: "trusted", name: null, department: "Inbox desk" },
    ]);
    expect(after).not.toBe(before);
    // Order doesn't matter, and non-trusted workers' details don't either.
    expect(publishKey(s, [
      { key: "/b", state: "probation", name: "x", department: "Operations" },
      { key: "/a", state: "trusted", name: null, department: "Inbox desk" },
    ])).toBe(before);
  });
});

describe("retire / unretire / name routes", () => {
  it("need {confirm:true} (400), a key from the current worker list (404), and a valid body", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const { f } = careersFor(w);
    const ctx = ctxFor(w);
    expect((await post(f, ctx, "/inbox-sweep", "retire", {})).status).toBe(400);
    expect((await post(f, ctx, "/inbox-sweep", "retire", { confirm: "yes" })).status).toBe(400);
    expect((await post(f, ctx, "/inbox-sweep", "retire", "{not json")).status).toBe(400);
    expect((await post(f, ctx, "/nope", "retire", { confirm: true })).status).toBe(404);
    expect((await post(f, ctx, "__proto__", "retire", { confirm: true })).status).toBe(404);
    expect((await post(f, ctx, "/inbox-sweep", "name", { confirm: true, name: 42 })).status).toBe(400);
    expect((await post(f, ctx, "/inbox-sweep", "unretire", { confirm: true })).status).toBe(409);
    await expect(stat(join(w.dataDir, "careers.json"))).rejects.toThrow(); // nothing written by a refusal
  });

  it("retire survives a reload, a new run shows 'returned' (announced once), and only careers.json is written", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const transcriptsBefore = await snapshotDir(w.projectsDir);
    const dataBefore = await readdir(w.dataDir);
    const { f, feed } = careersFor(w);
    const ctx = ctxFor(w);
    await f.onTick!(ctx);

    const r = await post(f, ctx, "/inbox-sweep", "retire", { confirm: true });
    expect(r).toEqual({ status: 200, body: { ok: true, key: "/inbox-sweep", state: "retired", name: null } satisfies CareersActionResult });
    expect(await snapshotDir(w.projectsDir)).toEqual(transcriptsBefore); // no transcript touched
    expect((await readdir(w.dataDir)).sort()).toEqual([...dataBefore, "careers.json"].sort()); // no .tmp left, nothing else
    const saved = JSON.parse(await readFile(join(w.dataDir, "careers.json"), "utf8")) as { version: number; workers: Record<string, { retiredAt: string }> };
    expect(saved.version).toBe(1);
    expect(saved.workers["/inbox-sweep"]!.retiredAt).toBe(iso(w.clock.now));
    expect((await post(f, ctx, "/inbox-sweep", "retire", { confirm: true })).status).toBe(409);

    // Reload: a fresh feature instance reads careers.json.
    const reloaded = careersFor(w);
    expect((await workers(reloaded.f, ctx)).get("/inbox-sweep")).toMatchObject({ state: "retired", standing: "trusted" });
    await f.onTick!(ctx);
    expect(feed).toEqual([]); // retiring is not news

    // It runs again after the retirement.
    w.clock.now += 2 * HOUR;
    await addRun(w, "inbox-sweep", 0.5, "finished");
    await settle(w, outcomes);
    expect((await workers(reloaded.f, ctx)).get("/inbox-sweep")).toMatchObject({ state: "returned", standing: "trusted" });
    await f.onTick!(ctx);
    expect(feed.map((i) => i.title)).toEqual(["↺ /inbox-sweep ran again after you retired it"]);
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1);

    // Un-retire clears it: back to what its runs say, with no Feed line.
    expect((await post(f, ctx, "/inbox-sweep", "unretire", { confirm: true })).body).toMatchObject({ ok: true, state: "trusted" });
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1);
  });

  it("a malformed careers.json reads as empty, and the next write replaces it with a valid one", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    await mkdir(w.dataDir, { recursive: true });
    await writeFile(join(w.dataDir, "careers.json"), "{ this is not json", "utf8");
    const { f } = careersFor(w);
    const ctx = ctxFor(w);
    expect((await workers(f, ctx)).get("/inbox-sweep")).toMatchObject({ state: "trusted", retiredAt: null, name: null });
    const named = await post(f, ctx, "/inbox-sweep", "name", { confirm: true, name: "  Carillon\n" });
    expect(named.body).toMatchObject({ ok: true, name: "Carillon" });
    const saved = JSON.parse(await readFile(join(w.dataDir, "careers.json"), "utf8")) as { workers: Record<string, { name: string | null; retiredAt: string | null }> };
    expect(saved.workers["/inbox-sweep"]).toMatchObject({ name: "Carillon", retiredAt: null });
    // The bytes it couldn't parse were kept aside, not written over.
    const kept = (await readdir(w.dataDir)).filter((n) => n.startsWith("careers.json.malformed-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(w.dataDir, kept[0]!), "utf8")).toBe("{ this is not json");
    expect((await post(f, ctx, "/inbox-sweep", "name", { confirm: true, name: null })).body).toMatchObject({ ok: true, name: null });
  });

  it("a careers.json it can't read is never written over (500), and reads as empty", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    await mkdir(join(w.dataDir, "careers.json"), { recursive: true }); // EISDIR on read
    const { f } = careersFor(w);
    const ctx = ctxFor(w);
    expect((await workers(f, ctx)).get("/inbox-sweep")).toMatchObject({ state: "trusted", retiredAt: null });
    const r = await post(f, ctx, "/inbox-sweep", "retire", { confirm: true });
    expect(r.status).toBe(500);
    expect((r.body as CareersActionResult).error).toMatch(/^careers\.json exists but couldn't be read \(EISDIR\), so nothing was written$/);
    expect((await stat(join(w.dataDir, "careers.json"))).isDirectory()).toBe(true);
  });

  it("while careers.json can't be read, the tick records nothing (retirements would read as missing)", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const { f, feed } = careersFor(w);
    const ctx = ctxFor(w);
    await f.onTick!(ctx); // baseline: trusted
    // Retired (and ran again) in a file this instance can't read yet: a directory stands in its place.
    const other = careersFor(w);
    await mkdir(join(w.dataDir, "careers.json"), { recursive: true });
    await other.f.onTick!(ctx); // unreadable: no baseline
    await rm(join(w.dataDir, "careers.json"), { recursive: true });
    await writeFile(join(w.dataDir, "careers.json"), JSON.stringify({ version: 1, workers: { "/inbox-sweep": { retiredAt: iso(w.clock.now - 100 * HOUR), name: null, updatedAt: iso(w.clock.now - 100 * HOUR) } } }), "utf8");
    await other.f.onTick!(ctx); // readable now: first record, silent
    expect(other.feed).toEqual([]);
    expect((await workers(other.f, ctx)).get("/inbox-sweep")!.state).toBe("returned");
    expect(feed).toEqual([]);
  });

  it("entries it had to drop are kept aside before a write replaces the file", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    await mkdir(w.dataDir, { recursive: true });
    const original = JSON.stringify({ version: 1, workers: { "/upskill": { retiredAt: "2026-09-20T00:00:00.000Z", name: "Sage", updatedAt: "not a date" } } });
    await writeFile(join(w.dataDir, "careers.json"), original, "utf8");
    const { f } = careersFor(w);
    const ctx = ctxFor(w);
    expect((await post(f, ctx, "/inbox-sweep", "name", { confirm: true, name: "Carillon" })).status).toBe(200);
    const kept = (await readdir(w.dataDir)).filter((n) => n.startsWith("careers.json.malformed-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(w.dataDir, kept[0]!), "utf8")).toBe(original);
  });

  it("a double click on Retire retires once: the second gets 409", async () => {
    const w = await makeWorld();
    const outcomes = outcomesFor(w);
    await trustedSweep(w, outcomes);
    const { f } = careersFor(w);
    const ctx = ctxFor(w);
    const [a, b] = await Promise.all([post(f, ctx, "/inbox-sweep", "retire", { confirm: true }), post(f, ctx, "/inbox-sweep", "retire", { confirm: true })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("the real router takes the URI-encoded key (a key starts with '/')", async () => {
    const w = await makeWorld();
    const { f } = careersFor(w);
    const { base, server } = await bootTestServer({ configOverrides: { features: [f] } });
    try {
      const get = await fetch(`${base}/api/careers`);
      expect(get.status).toBe(200);
      const res = await fetch(`${base}/api/careers/${encodeURIComponent("/no-such-worker")}/retire`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "no worker with that key" });
    } finally {
      await server.close();
    }
  });
});

async function snapshotDir(dir: string): Promise<Array<[string, number, number]>> {
  const out: Array<[string, number, number]> = [];
  for (const d of await readdir(dir)) {
    for (const name of await readdir(join(dir, d))) {
      const s = await stat(join(dir, d, name));
      out.push([`${d}/${name}`, s.size, s.mtimeMs]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
