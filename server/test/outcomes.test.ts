// The outcomes feature through its real data sources: transcripts written to a temp projects dir
// (the real listSessionFiles finds them), the real indexer filling a real temp WorldDb (the
// last-line state abandoned reads), the real buildWorldViews for liveness, and the real
// readTailEnding. Only gh and the Feed sink are stubbed, and the clock is injected.

import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, stat, unlink, utimes, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedItem } from "../../shared/features/feed.js";
import { OUTCOMES_EXTRAS_KEY, type OutcomeRecord, type OutcomesMap, type OutcomesMessage, type OutcomesResponse } from "../../shared/features/outcomes.js";
import type { WorldDb } from "../db.js";
import { buildWorldViews } from "../index.js";
import { runIndexPass } from "../indexer.js";
import type { GhResult } from "../features/outcomes-lib.js";
import { createOutcomesFeature, latestOutcomeRecords, latestOutcomesColdDone, type GhRunner, type OutcomesFeatureOptions } from "../features/outcomes.js";
import type { FeatureContext, Route, ServerFeature } from "../features/registry.js";
import { appendToSessionFile, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-09-28T12:00:00.000Z");

// ── real-shaped transcript lines (shapes from real transcripts, contents made up) ──

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function prompt(cwd: string, sid: string, t: string, ms: number, entrypoint = "claude-vscode"): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: t }, uuid: `p-${ms}`, timestamp: iso(ms), cwd, sessionId: sid, entrypoint });
}

function toolUse(cwd: string, sid: string, id: string, name: string, input: Record<string, unknown>, ms: number, entrypoint = "claude-vscode"): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    message: { model: "claude-opus-5-5", id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null },
    uuid: `u-${id}`,
    timestamp: iso(ms),
    cwd,
    sessionId: sid,
    entrypoint,
  });
}

function toolResult(cwd: string, sid: string, id: string, text: string, ms: number): string {
  return JSON.stringify({
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text, is_error: false }] },
    uuid: `r-${id}`,
    timestamp: iso(ms),
    toolUseResult: { stdout: text, stderr: "", interrupted: false, isImage: false },
    cwd,
    sessionId: sid,
    entrypoint: "claude-vscode",
  });
}

function finalText(cwd: string, sid: string, t: string, ms: number): string {
  return JSON.stringify({ isSidechain: false, type: "assistant", message: { model: "claude-opus-5-5", id: `msg_f${ms}`, type: "message", role: "assistant", content: [{ type: "text", text: t }], stop_reason: "end_turn" }, timestamp: iso(ms), cwd, sessionId: sid, entrypoint: "claude-vscode" });
}

function apiError(cwd: string, sid: string, ms: number): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    timestamp: iso(ms),
    message: { id: "a83bbc5a", container: null, model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", stop_sequence: "", type: "message", content: [{ type: "text", text: "API Error: The socket connection was closed unexpectedly." }] },
    error: "unknown",
    isApiErrorMessage: true,
    userType: "external",
    entrypoint: "sdk-cli",
    cwd,
    sessionId: sid,
  });
}

function interrupt(cwd: string, sid: string, ms: number): string {
  return JSON.stringify({ isSidechain: false, type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] }, timestamp: iso(ms), userType: "external", entrypoint: "claude-vscode", cwd, sessionId: sid });
}

function prLink(sid: string, repo: string, n: number, ms: number): string {
  return JSON.stringify({ type: "pr-link", sessionId: sid, prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: iso(ms) });
}

function frameLink(sid: string, url: string, ms: number): string {
  return JSON.stringify({ type: "frame-link", sessionId: sid, path: "/private/tmp/scratchpad/report.html", frameUrl: url, title: "Report", artifactCount: 1, timestamp: iso(ms) });
}

// ── the world ───────────────────────────────────────────────────────────

interface World {
  dir: string;
  projectsDir: string;
  dataDir: string;
  db: WorldDb;
  clock: { now: number };
  live: Set<string>; // cwds with a running claude
  files: Map<string, { path: string; cwd: string }>;
}

async function makeWorld(): Promise<World> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const projectsDir = join(dir, "projects");
  await mkdir(projectsDir, { recursive: true });
  return { dir, projectsDir, dataDir: join(dir, "data"), db: await makeTempDb(dir), clock: { now: BASE }, live: new Set(), files: new Map() };
}

function sid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/** Writes a session transcript, dated `quietMs` before the clock. */
async function addSession(w: World, n: number, lines: (cwd: string, id: string, t: number) => string[], quietMs = 2 * 24 * HOUR): Promise<string> {
  const id = sid(n);
  const cwd = join(w.dir, `repo-${n}`);
  const t = w.clock.now - quietMs;
  const path = await writeSessionFile(w.projectsDir, `-repo-${n}`, id, lines(cwd, id, t - 5 * MIN).join("\n") + "\n");
  await utimes(path, new Date(t), new Date(t));
  w.files.set(id, { path, cwd });
  return id;
}

async function touch(w: World, id: string, quietMs: number): Promise<void> {
  const f = w.files.get(id);
  if (!f) throw new Error(id);
  const t = new Date(w.clock.now - quietMs);
  await utimes(f.path, t, t);
}

async function index(w: World): Promise<void> {
  await runIndexPass(w.db, { projectsDir: w.projectsDir, homeDir: w.dir });
}

function ctxFor(w: World, emitted: unknown[]): FeatureContext {
  return {
    featureId: "outcomes",
    db: w.db,
    config: { projectsDir: w.projectsDir, dbPath: join(w.dir, "world.db") },
    emit: (p: unknown) => void emitted.push(p),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    worldViews: () => buildWorldViews(w.db, new Map([...w.live].map((c) => [c, 1])), new Date(w.clock.now)),
  } as unknown as FeatureContext;
}

function ghStub(states: Record<number, GhResult | ((n: number) => GhResult)>): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push([...args]);
    const n = Number(args[2]);
    const s = states[n];
    return typeof s === "function" ? s(n) : (s ?? { ok: false, code: "EXIT" });
  };
  return { run, calls };
}

const gh = (state: "MERGED" | "OPEN" | "CLOSED", n: number, mergedAt: string | null = null): GhResult => ({ ok: true, stdout: JSON.stringify({ mergedAt, state, url: `https://github.com/o/r/pull/${n}` }) });

async function call(feature: ServerFeature, ctx: FeatureContext, path: string, params: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const route = feature.routes?.find((r: Route) => r.path === path);
  if (!route) throw new Error(path);
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (d: string) => void (body = d),
  };
  await route.handler({ url: path } as never, res as never, ctx, params);
  return { status, body: JSON.parse(body) as unknown };
}

async function list(feature: ServerFeature, ctx: FeatureContext): Promise<OutcomesResponse> {
  return (await call(feature, ctx, "/api/outcomes")).body as OutcomesResponse;
}

async function record(feature: ServerFeature, ctx: FeatureContext, id: string): Promise<OutcomeRecord> {
  const r = await call(feature, ctx, "/api/outcomes/:agentId", { agentId: id });
  expect(r.status).toBe(200);
  return r.body as OutcomeRecord;
}

interface Fleet {
  merged: string;
  push: string;
  artifact: string;
  apiError: string;
  interrupt: string;
  ask: string;
  todo: string;
  chat: string;
  open: string;
  closed: string;
  ghError: string;
  live: string;
}

/** One session of every kind the precedence table knows. */
async function seedFleet(w: World): Promise<Fleet> {
  const recent = w.clock.now - 2 * HOUR; // PR evidence well inside the 24h Feed window
  const merged = await addSession(w, 1, (c, s, t) => [
    prompt(c, s, "Ship the graduation feed", t),
    toolUse(c, s, "toolu_m1", "Bash", { command: 'gh pr create --base main --title "feat: x" --body "y"' }, t + 1000),
    toolResult(c, s, "toolu_m1", "https://github.com/o/r/pull/12\n", recent),
    prLink(s, "o/r", 12, recent),
    finalText(c, s, "Opened #12.", t + 3000),
  ]);
  const push = await addSession(w, 2, (c, s, t) => [
    prompt(c, s, "push it", t),
    toolUse(c, s, "toolu_p1", "Bash", { command: "git push -u origin feat/x" }, t + 1000),
    toolResult(c, s, "toolu_p1", "       0\nTo https://github.com/o/r2.git\n * [new branch]      feat/x -> feat/x\n", t + 2000),
    finalText(c, s, "Pushed.", t + 3000),
  ]);
  const artifact = await addSession(w, 3, (c, s, t) => [prompt(c, s, "make a report page", t), frameLink(s, "https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7", t + 1000), finalText(c, s, "Published.", t + 2000)]);
  const failedRun = await addSession(w, 4, (c, s, t) => [prompt(c, s, "/daily-recap", t, "sdk-cli"), apiError(c, s, t + 1000)]);
  const stoppedRun = await addSession(w, 5, (c, s, t) => [prompt(c, s, "refactor x", t), toolUse(c, s, "toolu_i1", "Bash", { command: "npm test" }, t + 1000), interrupt(c, s, t + 2000)]);
  const ask = await addSession(w, 6, (c, s, t) => [prompt(c, s, "plan the migration", t), toolUse(c, s, "toolu_a1", "AskUserQuestion", { questions: [{ question: "Which one?", header: "Scope", multiSelect: false, options: [{ label: "A", description: "a" }] }] }, t + 1000)]);
  const todo = await addSession(w, 7, (c, s, t) => [
    prompt(c, s, "do the three steps", t),
    toolUse(c, s, "toolu_t1", "TodoWrite", { todos: ["a", "b", "c"].map((x) => ({ content: x, status: "completed", activeForm: x })) }, t + 1000),
    toolResult(c, s, "toolu_t1", "Todos have been modified successfully.", t + 1500),
    finalText(c, s, "All three done.", t + 2000),
  ]);
  const chat = await addSession(w, 8, (c, s, t) => [prompt(c, s, "what is a monad", t), finalText(c, s, "A monoid in the category of endofunctors.", t + 1000)]);
  const open = await addSession(w, 9, (c, s, t) => [prompt(c, s, "open a PR", t), prLink(s, "o/r", 13, t + 1000), finalText(c, s, "Opened.", t + 2000)]);
  const closed = await addSession(w, 10, (c, s, t) => [prompt(c, s, "open another PR", t), prLink(s, "o/r", 14, t + 1000), finalText(c, s, "Opened.", t + 2000)]);
  const ghError = await addSession(w, 11, (c, s, t) => [prompt(c, s, "and another", t), prLink(s, "o/r", 15, t + 1000), finalText(c, s, "Opened.", t + 2000)]);
  const live = await addSession(w, 12, (c, s, t) => [prompt(c, s, "still working", t), toolUse(c, s, "toolu_l1", "Read", { file_path: "/x" }, t + 1000)], 3 * HOUR);
  w.live.add(w.files.get(live)?.cwd ?? "");
  await index(w);
  return { merged, push, artifact, apiError: failedRun, interrupt: stoppedRun, ask, todo, chat, open, closed, ghError, live };
}

const FLEET_GH = { 12: gh("MERGED", 12, "2026-09-28T10:30:00Z"), 13: gh("OPEN", 13), 14: gh("CLOSED", 14), 15: { ok: false, code: "EXIT" } as GhResult };

function feature(w: World, opts: OutcomesFeatureOptions = {}): { f: ServerFeature; feed: Array<Omit<FeedItem, "seq">> } {
  const feed: Array<Omit<FeedItem, "seq">> = [];
  return { f: createOutcomesFeature({ dataDir: w.dataDir, now: () => w.clock.now, feed: (i) => void feed.push(i), ...opts }), feed };
}

describe("outcomes feature", () => {
  it("a cold scan gives every dormant session its verdict, emits 0 Feed items, and asks gh with the exact argv", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const stub = ghStub(FLEET_GH);
    const { f, feed } = feature(w, { gh: stub.run });
    const emitted: unknown[] = [];
    const ctx = ctxFor(w, emitted);
    await f.onTick!(ctx);

    const body = await list(f, ctx);
    expect(body.scan.coldDone).toBe(true);
    expect(body.scan.coldTicks).toBe(1);
    expect(body.counts).toEqual({ shipped: 1, delivered: 5, failed: 1, stopped: 1, abandoned: 1, finished: 1, active: 1, unknown: 1 });
    const by = new Map(body.outcomes.map((o) => [o.sessionId, o]));
    // evidenceAt rides along in the list (the Hall's plaque counts shipped sessions by merge time).
    expect(by.get(ids.merged)).toMatchObject({ outcome: "shipped", reason: "o/r#12 merged", prs: 1, merged: 1, evidenceAt: "2026-09-28T10:30:00Z" });
    expect(by.get(ids.chat)?.evidenceAt).toBeNull();
    expect(by.get(ids.push)).toMatchObject({ outcome: "delivered", reason: "pushed to o/r2", pushes: 1 });
    expect(by.get(ids.artifact)).toMatchObject({ outcome: "delivered", reason: "published a claude.ai artifact", artifacts: 1 });
    expect(by.get(ids.apiError)).toMatchObject({ outcome: "failed", reason: "API Error: The socket connection was closed unexpectedly." });
    expect(by.get(ids.interrupt)).toMatchObject({ outcome: "stopped", reason: "interrupted by the user" });
    expect(by.get(ids.ask)).toMatchObject({ outcome: "abandoned", reason: "waited on you: AskUserQuestion" });
    expect(by.get(ids.todo)).toMatchObject({ outcome: "finished" });
    expect(by.get(ids.chat)).toMatchObject({ outcome: "unknown", reason: null });
    expect(by.get(ids.open)).toMatchObject({ outcome: "delivered", reason: "o/r#13 open" });
    expect(by.get(ids.closed)).toMatchObject({ outcome: "delivered", reason: "o/r#14 closed without merging" });
    expect(by.get(ids.ghError)).toMatchObject({ outcome: "delivered", reason: "o/r#15 (gh couldn't say)" });
    expect(by.get(ids.live)).toMatchObject({ outcome: "active", pending: true });

    // Fresh PR evidence (2h old) and still nothing in the Feed: the cold scan never floods it.
    expect(feed).toEqual([]);
    // gh: read-only `pr view`, argv only, one call per PR.
    expect(stub.calls.map((a) => a.join(" ")).sort()).toEqual([12, 13, 14, 15].map((n) => `pr view ${n} --repo o/r --json state,mergedAt,url`));

    // The extra and the WS push hold every non-unknown outcome, and nothing else.
    const extra = f.snapshotExtras!(ctx)[OUTCOMES_EXTRAS_KEY] as OutcomesMap;
    expect(Object.keys(extra).sort()).toEqual(Object.values(ids).filter((id) => id !== ids.chat).sort());
    expect(emitted).toEqual([{ kind: "map", map: extra } satisfies OutcomesMessage]);

    const merged = await record(f, ctx, ids.merged);
    expect(merged.prs).toEqual([{ repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", state: "MERGED", mergedAt: "2026-09-28T10:30:00Z", checkedAt: iso(w.clock.now), firstSeenAt: iso(w.clock.now - 2 * HOUR) }]);
    expect(merged).toMatchObject({ toolCalls: 1, writes: 0, onDisk: true, pending: false, ending: null });
    expect((await record(f, ctx, ids.apiError)).ending).toEqual({ status: "failed", reason: "API Error: The socket connection was closed unexpectedly.", headless: true });
    expect((await call(f, ctx, "/api/outcomes/:agentId", { agentId: "nope" })).status).toBe(404);
    expect(latestOutcomeRecords().length).toBe(12);
  });

  it("a session that appears after boot (found by the real listSessionFiles) graduates once, with a fresh merge", async () => {
    const w = await makeWorld();
    await seedFleet(w);
    const stub = ghStub({ ...FLEET_GH, 20: gh("MERGED", 20, iso(BASE - 20 * MIN)) });
    const { f, feed } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(feed).toEqual([]);

    const fresh = await addSession(w, 20, (c, s, t) => [prompt(c, s, "Ship the graduation feed", t), prLink(s, "o/r", 20, t + 1000), finalText(c, s, "Merged.", t + 2000)], 15 * MIN);
    await index(w);
    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect((await record(f, ctx, fresh)).outcome).toBe("shipped");
    expect(feed).toEqual([{ id: `grad:${fresh}:shipped`, at: iso(BASE - 20 * MIN), kind: "graduation", agentId: fresh, title: "🎓 Ship the graduation feed shipped o/r#20", detail: "o/r#20 merged", tag: "shipped" }]);

    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect(feed).toHaveLength(1);
  });

  it("a stale merge (evidence over 24h old) never reaches the Feed", async () => {
    const w = await makeWorld();
    await seedFleet(w);
    const { f, feed } = feature(w, { gh: ghStub({ ...FLEET_GH, 21: gh("MERGED", 21, iso(BASE - 3 * 24 * HOUR)) }).run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    const old = await addSession(w, 21, (c, s, t) => [prompt(c, s, "old work", t), prLink(s, "o/r", 21, BASE - 3 * 24 * HOUR), finalText(c, s, "ok", t + 1)], 15 * MIN);
    await index(w);
    await f.onTick!(ctx);
    expect((await record(f, ctx, old)).outcome).toBe("shipped");
    expect(feed).toEqual([]);
  });

  it("an unchanged transcript is never re-read; growth reads only the new bytes", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const { f } = feature(w, { gh: ghStub(FLEET_GH).run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect((await list(f, ctx)).scan.lastTick).toMatchObject({ bytesRead: 0, sessionsRead: 0, ghCalls: 0 });

    const chat = w.files.get(ids.chat);
    if (!chat) throw new Error("chat");
    const before = (await stat(chat.path)).size;
    const added = [toolUse(chat.cwd, ids.chat, "toolu_g1", "Read", { file_path: "/a" }, BASE), toolUse(chat.cwd, ids.chat, "toolu_g2", "Write", { file_path: "/a/b.md", content: "x" }, BASE)].join("\n") + "\n";
    await appendToSessionFile(chat.path, added);
    await touch(w, ids.chat, 11 * MIN);
    w.clock.now += MIN;
    await f.onTick!(ctx);
    const after = (await stat(chat.path)).size;
    expect(after - before).toBe(Buffer.byteLength(added));
    expect((await list(f, ctx)).scan.lastTick).toMatchObject({ sessionsRead: 1, bytesRead: after - before + Math.min(after, 256 * 1024) });
    expect(await record(f, ctx, ids.chat)).toMatchObject({ toolCalls: 2, writes: 1, pending: false });
  });

  it("respects the per-tick byte budget, and ends with the same verdicts as an unbounded scan", async () => {
    const w = await makeWorld();
    await seedFleet(w);
    // A tick must afford a whole tail read (production: 64 MB vs 256 KB), so the test budget is the
    // biggest transcript's size: every transcript fits, the fleet doesn't.
    const sizes = await Promise.all([...w.files.values()].map(async (f) => (await stat(f.path)).size));
    const budget = Math.max(...sizes);
    expect(budget * 3).toBeLessThan(sizes.reduce((a, b) => a + b, 0));
    const { f } = feature(w, { gh: ghStub(FLEET_GH).run, maxBytesPerTick: budget });
    const ctx = ctxFor(w, []);
    let ticks = 0;
    for (; ticks < 100; ticks++) {
      await f.onTick!(ctx);
      const scan = (await list(f, ctx)).scan;
      expect(scan.lastTick?.bytesRead ?? 0).toBeLessThanOrEqual(budget);
      if (scan.coldDone) break;
      w.clock.now += MIN;
    }
    expect((await list(f, ctx)).scan.coldDone).toBe(true);
    expect(ticks).toBeGreaterThan(2);
    const bounded = (await list(f, ctx)).outcomes.map((o) => [o.sessionId, o.outcome]).sort();
    const { f: free } = feature({ ...w, dataDir: join(w.dir, "data-free") }, { gh: ghStub(FLEET_GH).run });
    await free.onTick!(ctx);
    expect(bounded).toEqual((await list(free, ctx)).outcomes.map((o) => [o.sessionId, o.outcome]).sort());
  });

  it("skips a single line longer than a whole tick's budget instead of stalling on it", async () => {
    const w = await makeWorld();
    // Sizes as in production, scaled down: the budget covers a tail read (256 KB) but not the line.
    const big = await addSession(w, 30, (c, s, t) => [prompt(c, s, "x", t), toolResult(c, s, "toolu_big", "y".repeat(400 * 1024), t + 1), prLink(s, "o/r", 31, t + 2), finalText(c, s, "ok", t + 3)]);
    await index(w);
    const budget = 300 * 1024;
    const { f } = feature(w, { gh: ghStub({ 31: gh("OPEN", 31) }).run, maxBytesPerTick: budget });
    const ctx = ctxFor(w, []);
    let ticks = 0;
    for (; ticks < 20 && !(await list(f, ctx)).scan.coldDone; ticks++) {
      await f.onTick!(ctx);
      expect((await list(f, ctx)).scan.lastTick?.bytesRead ?? 0).toBeLessThanOrEqual(budget);
    }
    expect(ticks).toBeGreaterThan(2);
    expect(ticks).toBeLessThan(20);
    expect(await record(f, ctx, big)).toMatchObject({ outcome: "delivered", reason: "o/r#31 open", pending: false });
  });

  it("asks gh at most 10 times a tick, newest PR first", async () => {
    const w = await makeWorld();
    for (let n = 1; n <= 12; n++) await addSession(w, 40 + n, (c, s, t) => [prompt(c, s, "pr", t), prLink(s, "o/r", 100 + n, t + n * 1000), finalText(c, s, "ok", t + 20_000)], 2 * 24 * HOUR - n * MIN);
    await index(w);
    const stub = ghStub(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [101 + i, gh("OPEN", 101 + i)])));
    const { f } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(stub.calls).toHaveLength(10);
    expect(stub.calls[0]?.[2]).toBe("112");
    expect((await list(f, ctx)).scan).toMatchObject({ coldDone: false, pendingPrChecks: 2 });
    expect(latestOutcomesColdDone()).toBe(false); // what the vision ledger's crews probe reads
    await f.onTick!(ctx);
    expect(stub.calls).toHaveLength(12);
    expect((await list(f, ctx)).scan.coldDone).toBe(true);
    expect(latestOutcomesColdDone()).toBe(true);
  });

  it("no gh binary (ENOENT): unknown, never shipped, and it stops calling for that tick", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const stub = ghStub({ 12: { ok: false, code: "ENOENT" }, 13: { ok: false, code: "ENOENT" }, 14: { ok: false, code: "ENOENT" }, 15: { ok: false, code: "ENOENT" } });
    const { f } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(stub.calls).toHaveLength(1);
    const body = await list(f, ctx);
    expect(body.scan.gh).toBe("unavailable");
    expect(body.counts.shipped).toBe(0);
    expect((await record(f, ctx, ids.merged)).outcome).toBe("delivered");
    for (let i = 0; i < 5; i++) {
      w.clock.now += MIN;
      await f.onTick!(ctx);
    }
    expect((await list(f, ctx)).scan.coldDone).toBe(true);
    expect((await list(f, ctx)).counts.shipped).toBe(0);
  });

  it("MERGED and CLOSED are asked once; OPEN again after 6h, gh errors after 1h", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    let openNow: GhResult = gh("OPEN", 13);
    const stub = ghStub({ ...FLEET_GH, 13: () => openNow });
    const { f, feed } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(stub.calls).toHaveLength(4);
    w.clock.now += 59 * MIN;
    await f.onTick!(ctx);
    expect(stub.calls).toHaveLength(4);
    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect(stub.calls.slice(4).map((a) => a[2])).toEqual(["15"]);
    openNow = gh("MERGED", 13, iso(w.clock.now + 4 * HOUR));
    w.clock.now += 5 * HOUR;
    await f.onTick!(ctx);
    expect(stub.calls.slice(5).map((a) => a[2]).sort()).toEqual(["13", "15"]);
    expect((await record(f, ctx, ids.open)).outcome).toBe("shipped");
    expect(feed.map((i) => i.id)).toEqual([`grad:${ids.open}:shipped`]);
  });

  it("a resumed session is active while live, then recomputed from its new bytes", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const { f, feed } = feature(w, { gh: ghStub(FLEET_GH).run });
    const emitted: unknown[] = [];
    const ctx = ctxFor(w, emitted);
    await f.onTick!(ctx);
    expect((await record(f, ctx, ids.ask)).outcome).toBe("abandoned");

    // Alex answers, it pushes and ends: new bytes, a running process.
    const ask = w.files.get(ids.ask);
    if (!ask) throw new Error("ask");
    await appendToSessionFile(
      ask.path,
      [
        toolResult(ask.cwd, ids.ask, "toolu_a1", "User answered: A", BASE),
        toolUse(ask.cwd, ids.ask, "toolu_a2", "Bash", { command: "git push" }, BASE + 1000),
        toolResult(ask.cwd, ids.ask, "toolu_a2", "To https://github.com/o/r6\n   1a2b3c4..5e6f7a8  main -> main\n", BASE + 2000),
        finalText(ask.cwd, ids.ask, "Done with A.", BASE + 3000),
      ].join("\n") + "\n",
    );
    await touch(w, ids.ask, 0);
    w.live.add(ask.cwd);
    await index(w);
    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect(await record(f, ctx, ids.ask)).toMatchObject({ outcome: "active", pending: true });
    expect((emitted.at(-1) as OutcomesMessage).map[ids.ask]).toBe("active");

    // It ends: no process, and the clock moves on (a transcript's mtime never goes back). Until it
    // has been quiet 10 min it isn't re-read, and its old ending no longer counts.
    w.live.delete(ask.cwd);
    w.clock.now += 8 * MIN;
    await f.onTick!(ctx);
    expect((await list(f, ctx)).scan.lastTick?.sessionsRead).toBe(0);
    expect(await record(f, ctx, ids.ask)).toMatchObject({ outcome: "unknown", pending: true });

    w.clock.now += 2 * MIN;
    await f.onTick!(ctx);
    expect(await record(f, ctx, ids.ask)).toMatchObject({ outcome: "delivered", reason: "pushed to o/r6", pending: false, toolCalls: 2 });
    expect((emitted.at(-1) as OutcomesMessage).map[ids.ask]).toBe("delivered");
    expect(feed.map((i) => [i.id, i.title])).toEqual([[`grad:${ids.ask}:delivered`, "📦 plan the migration delivered a push to o/r6"]]);
  });

  it("a record outlives its pruned transcript", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const { f } = feature(w, { gh: ghStub(FLEET_GH).run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    await unlink(w.files.get(ids.push)?.path ?? "");
    w.clock.now += MIN;
    await f.onTick!(ctx);
    expect(await record(f, ctx, ids.push)).toMatchObject({ outcome: "delivered", onDisk: false, pending: false });
    expect((f.snapshotExtras!(ctx)[OUTCOMES_EXTRAS_KEY] as Record<string, string>)[ids.push]).toBe("delivered");
  });

  it("persists to data/outcomes.json only; a restart resumes without re-reading or re-announcing", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const { f } = feature(w, { gh: ghStub(FLEET_GH).run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(await readdir(w.dataDir)).toEqual(["outcomes.json"]);

    const stub = ghStub(FLEET_GH);
    const { f: again, feed } = feature(w, { gh: stub.run });
    const before = again.snapshotExtras!(ctx)[OUTCOMES_EXTRAS_KEY] as Record<string, string>;
    expect(before[ids.merged]).toBe("shipped");
    await again.onTick!(ctx);
    const scan = (await list(again, ctx)).scan;
    expect(scan).toMatchObject({ coldDone: true, coldTicks: 1, lastTick: { bytesRead: 0, sessionsRead: 0, ghCalls: 0 } });
    expect(stub.calls).toEqual([]);
    expect(feed).toEqual([]);
  });

  it("a `gh pr merge <n>` with no URL counts for the session that merged it, its repo read by the real git from the checkout", async () => {
    // ✅ Real shape (6a10cdc0 merging acme-inc/acme-ai#460): non-TTY gh prints no URL, no pr-link follows.
    const w = await makeWorld();
    const origin = (n: number, ...remotes: Array<[string, string]>): void => {
      const dir = join(w.dir, `repo-${n}`);
      execFileSync("git", ["init", "-q", dir]);
      for (const [name, url] of remotes) execFileSync("git", ["-C", dir, "remote", "add", name, url]);
    };
    origin(21, ["origin", "https://github.com/O/R.git"]);
    origin(23, ["origin", "https://github.com/me/r.git"], ["upstream", "https://github.com/O/R.git"]); // a fork: gh's pick is ambiguous
    origin(24, ["origin", "https://github.com/O/R.git"]);
    const callAt = new Map<number, number>();
    const merge = (n: number) => (c: string, s: string, t: number): string[] => {
      callAt.set(n, t + 1000);
      return [
        prompt(c, s, "merge it", t),
        toolUse(c, s, `toolu_n${n}`, "Bash", { command: `gh pr merge ${n} --squash --delete-branch 2>&1 | tail -3` }, t + 1000),
        toolResult(c, s, `toolu_n${n}`, "(Bash completed with no output)", t + 9000),
        finalText(c, s, "Merged.", t + 10_000),
      ];
    };
    const merger = await addSession(w, 21, merge(21));
    const notACheckout = await addSession(w, 22, merge(22)); // its cwd was never created
    const inFork = await addSession(w, 23, merge(23));
    const tooLate = await addSession(w, 24, merge(24)); // its call failed quietly; someone merged it an hour later
    await index(w);
    const during = (n: number): string => iso((callAt.get(n) ?? 0) + 4000).replace(/\.\d{3}Z$/, "Z"); // GitHub's whole seconds
    const stub = ghStub({ 21: gh("MERGED", 21, during(21)), 22: gh("MERGED", 22, during(22)), 23: gh("MERGED", 23, during(23)), 24: gh("MERGED", 24, iso((callAt.get(24) ?? 0) + HOUR)) });
    const { f } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);
    await f.onTick!(ctx);
    expect(await record(f, ctx, merger)).toMatchObject({ outcome: "shipped", reason: "o/r#21 merged", prs: [{ repo: "o/r", number: 21, state: "MERGED" }] });
    expect((await record(f, ctx, notACheckout)).prs).toEqual([]);
    expect((await record(f, ctx, inFork)).prs).toEqual([]);
    expect((await record(f, ctx, tooLate)).prs).toEqual([]);
    expect(stub.calls.map((a) => a.join(" ")).sort()).toEqual([21, 24].map((n) => `pr view ${n} --repo o/r --json state,mergedAt,url`));
    const body = await list(f, ctx);
    expect(body.scan.coldDone).toBe(true);
    expect(body.outcomes.find((o) => o.sessionId === merger)?.mergedPrs).toEqual([{ repo: "o/r", number: 21, mergedAt: during(21) }]);
  });

  it("a version-2 cache file: gh's final answers carry over, every transcript is re-read, and the scan says it isn't done until it is", async () => {
    const w = await makeWorld();
    const ids = await seedFleet(w);
    const checkedAt = iso(w.clock.now - HOUR);
    const v2 = {
      version: 2,
      ticks: 235,
      coldDone: true,
      coldTicks: 13,
      sessions: {},
      prs: {
        "o/r#12": { state: "MERGED", mergedAt: "2026-09-28T10:30:00Z", url: "https://github.com/o/r/pull/12", checkedAt },
        "o/r#13": { state: "OPEN", mergedAt: null, url: "https://github.com/o/r/pull/13", checkedAt },
        "o/r#14": { state: "CLOSED", mergedAt: null, url: "https://github.com/o/r/pull/14", checkedAt },
        "o/r#15": { state: "unknown", mergedAt: null, url: null, checkedAt },
      },
    };
    await mkdir(w.dataDir, { recursive: true });
    await writeFile(join(w.dataDir, "outcomes.json"), JSON.stringify(v2), "utf8");
    const stub = ghStub(FLEET_GH);
    const { f, feed } = feature(w, { gh: stub.run });
    const ctx = ctxFor(w, []);

    // Before the first tick: no rows yet, and the scan says so (the client reads "not known yet").
    const before = await list(f, ctx);
    expect(before.outcomes).toEqual([]);
    expect(before.scan).toMatchObject({ ticks: 0, coldDone: false, coldTicks: null, lastTick: null });

    await f.onTick!(ctx);
    // MERGED #12 and CLOSED #14 are final: not asked again. OPEN #13 and unknown #15 are.
    expect(stub.calls.map((a) => a.join(" ")).sort()).toEqual([13, 15].map((n) => `pr view ${n} --repo o/r --json state,mergedAt,url`));
    const body = await list(f, ctx);
    expect(body.scan).toMatchObject({ coldDone: true, coldTicks: 1, lastTick: { sessionsRead: 11, ghCalls: 2 } });
    expect(body.outcomes.find((o) => o.sessionId === ids.merged)).toMatchObject({ outcome: "shipped", mergedPrs: [{ repo: "o/r", number: 12, mergedAt: "2026-09-28T10:30:00Z" }] });
    expect(body.counts).toEqual({ shipped: 1, delivered: 5, failed: 1, stopped: 1, abandoned: 1, finished: 1, active: 1, unknown: 1 });
    expect(feed).toEqual([]); // still a cold scan: nothing re-announced
    const saved = JSON.parse(await readFile(join(w.dataDir, "outcomes.json"), "utf8")) as { version: number; prs: Record<string, { checkedAt: string }> };
    expect(saved.version).toBe(3);
    expect(saved.prs["o/r#12"]?.checkedAt).toBe(checkedAt);
  });

  it("a malformed or older-version cache file means starting empty (a cold scan)", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 0, ticks: 3, coldDone: true, coldTicks: 1, sessions: {}, prs: {} }), JSON.stringify({ version: 1 })]) {
      const w = await makeWorld();
      const ids = await seedFleet(w);
      await mkdir(w.dataDir, { recursive: true });
      await writeFile(join(w.dataDir, "outcomes.json"), content, "utf8");
      const { f, feed } = feature(w, { gh: ghStub(FLEET_GH).run });
      const ctx = ctxFor(w, []);
      expect(f.snapshotExtras!(ctx)[OUTCOMES_EXTRAS_KEY]).toEqual({});
      await f.onTick!(ctx);
      const body = await list(f, ctx);
      expect(body.scan.coldTicks).toBe(1);
      expect(body.counts.shipped).toBe(1);
      expect((await record(f, ctx, ids.merged)).outcome).toBe("shipped");
      expect(feed).toEqual([]);
    }
  });
});
