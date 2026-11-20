// The tripwires feature through the real pipeline: a transcript on disk → the real indexer
// (collectLines, exactly what the hub hands onIndexPass) → the feature → WS payload, snapshot
// extras and GET /api/tripwires. The db is a real temp WorldDb, so the district comes from the
// real island lookup, not a stub.

import { join } from "node:path";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  coverageLine,
  coverageSourcesLine,
  isTripwireHit,
  parseTripwireCoverage,
  TRIPWIRES_COVERAGE_KEY,
  TRIPWIRES_HITS_KEY,
  type TripwireHit,
  type TripwiresMessage,
  type TripwiresResponse,
} from "../../shared/features/tripwires.js";
import { TRIPWIRE_DEFS } from "../features/tripwires-defs.js";
import { buildCoverage, compileTripwires, countConductCases, countFeedbackMemories, countJournalLessons, countStandingWarnings, parseHitLines, TripwireTracker } from "../features/tripwires-lib.js";
import { PathGuard, tripwiresGeneration } from "../features/tripwires-store.js";
import { runIndexPass } from "../indexer.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { createTripwiresFeature, recentTripwireHits, type LessonSourcePaths } from "../features/tripwires.js";
import { appendToSessionFile, assistantLine, bootTestServer, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";
import type { ServerMessage } from "../../shared/types.js";
import type { WorldDb } from "../db.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function ctxFor(db: WorldDb, emitted: unknown[], projectsDir = "/nonexistent", dataDir = projectsDir): FeatureContext {
  return {
    featureId: "tripwires",
    db,
    // world.db's folder is where the hit log goes (each test's own temp dir).
    config: { projectsDir, dbPath: join(dataDir, "world.db") },
    emit: (p: unknown) => void emitted.push(p),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as FeatureContext;
}

/** Lesson sources that don't exist: these tests never read the real ~/.alef-loop or ~/.claude. */
function noLessons(dir: string): LessonSourcePaths {
  return { journal: join(dir, "no-journal.md"), memoryDir: join(dir, "no-memory"), conductCases: join(dir, "no-cases.md") };
}

async function getJson(route: Route, ctx: FeatureContext): Promise<TripwiresResponse> {
  let body = "";
  const res = { writeHead: () => res, end: (d: string) => void (body = d) };
  await route.handler({ url: "/api/tripwires" } as never, res as never, ctx, {});
  return JSON.parse(body) as TripwiresResponse;
}

describe("tripwires feature", () => {
  it("flags a live session repeating a lesson, once, with its district, on every surface", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const now = Date.now();
    const iso = (dMs: number): string => new Date(now + dMs).toISOString();
    // The real command that restarted the shared browse daemon (journal 2026-09-27, #16).
    const restart = 'B=~/.claude/skills/gstack/browse/dist/browse\n"$B" restart --help 2>&1 | head -20\necho "---"';
    const file = await writeSessionFile(
      dir,
      "-agent-world",
      sessionId,
      [userLine({ cwd, timestamp: iso(-60_000), text: "check the browse skill flags" }), assistantLine({ cwd, timestamp: iso(-30_000), toolUses: [{ name: "Bash", input: { command: restart } }] })].join("\n") + "\n",
    );
    const feature = createTripwiresFeature({ home: "/Users/alexboghossian", lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    const ctx = ctxFor(db, emitted, "/nonexistent", dir);

    const pass1 = await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir });
    await feature.onIndexPass!(ctx, pass1.linesBySession);
    expect(emitted).toHaveLength(1);
    const msg = emitted[0] as TripwiresMessage;
    expect(msg.kind).toBe("hits");
    expect(msg.hits).toHaveLength(1);
    const hit = msg.hits[0]!;
    expect(isTripwireHit(hit)).toBe(true);
    expect(hit).toMatchObject({ id: `${sessionId}:browse-restart-stop`, sessionId, subagentId: null, district: "agent-world", tripwireId: "browse-restart-stop", tool: "Bash", snippet: '"$B" restart --help 2>&1' });
    expect(hit.at).toBe(iso(-30_000));

    // Same session repeats it: deduped, nothing new is emitted.
    await appendToSessionFile(file, assistantLine({ cwd, timestamp: iso(-1_000), toolUses: [{ name: "Bash", input: { command: restart } }] }) + "\n");
    const pass2 = await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir });
    expect(pass2.linesBySession.get(sessionId)).toHaveLength(1);
    await feature.onIndexPass!(ctx, pass2.linesBySession);
    expect(emitted).toHaveLength(1);

    const extras = feature.snapshotExtras!(ctx)[TRIPWIRES_HITS_KEY];
    expect(extras).toEqual([hit]);
    const route = feature.routes!.find((r) => r.path === "/api/tripwires")!;
    const body = await getJson(route, ctx);
    expect(body.ok).toBe(true);
    expect(body.hits).toEqual([hit]);
    expect(body.rules.map((r) => r.id)).toContain("browse-restart-stop");
    expect(JSON.stringify(body.rules)).not.toContain("match"); // no regexes on the wire
    expect(recentTripwireHits()).toEqual([hit]); // what the resident reads
  });

  it("stays quiet on a session whose commands only mention a lesson", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "notes");
    const now = new Date().toISOString();
    const note = "cat >> ~/.alef-loop/journal.md <<'EOF'\n- The builder restarted the SHARED browse daemon by running `browse restart --help`.\nEOF";
    await writeSessionFile(dir, "-notes", "33333333-3333-3333-3333-333333333333", assistantLine({ cwd, timestamp: now, toolUses: [{ name: "Bash", input: { command: note } }] }) + "\n");
    const feature = createTripwiresFeature({ home: "/Users/alexboghossian", lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    const pass = await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir });
    await feature.onIndexPass!(ctxFor(db, emitted, "/nonexistent", dir), pass.linesBySession);
    expect(emitted).toEqual([]);
  });

  it("watches a live session's subagents too: the hit counts for the parent, read once from an offset", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const parent = "44444444-4444-4444-4444-444444444444";
    const now = Date.now();
    const iso = (dMs: number): string => new Date(now + dMs).toISOString();
    await writeSessionFile(dir, "-agent-world", parent, userLine({ cwd, timestamp: iso(-120_000), text: "build the lesson tripwires feature" }) + "\n");
    await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir });
    // The real subagent layout: <project>/<parentId>/subagents/agent-<id>.jsonl
    const subDir = join(dir, "-agent-world", parent, "subagents");
    await mkdir(subDir, { recursive: true });
    const subFile = join(subDir, "agent-a1b2c3d4e5f6.jsonl");
    const restart = 'B=~/.claude/skills/gstack/browse/dist/browse\n"$B" restart --help 2>&1 | head -20';
    await writeFile(
      subFile,
      [
        // The subagent's prompt comes from its parent agent: "merge" here is not Alex's go-ahead.
        userLine({ cwd, timestamp: iso(-60_000), text: "Build it, then run gh pr merge when green." }),
        assistantLine({ cwd, timestamp: iso(-30_000), toolUses: [{ name: "Bash", input: { command: restart } }] }),
      ].join("\n") + "\n",
    );
    const feature = createTripwiresFeature({ home: "/Users/alexboghossian", lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    const ctx = ctxFor(db, emitted, dir);
    await feature.onTick!(ctx);
    expect(emitted).toHaveLength(1);
    const [hit] = (emitted[0] as TripwiresMessage).hits;
    expect(hit).toMatchObject({ id: `${parent}:browse-restart-stop`, sessionId: parent, subagentId: "a1b2c3d4e5f6", district: "agent-world", tripwireId: "browse-restart-stop" });

    await feature.onTick!(ctx); // nothing new on disk: nothing re-read, nothing emitted
    expect(emitted).toHaveLength(1);

    await appendFile(subFile, assistantLine({ cwd, timestamp: iso(-1_000), toolUses: [{ name: "Bash", input: { command: "cd ~/Documents/Code/agent-world && gh pr merge 8 --merge 2>&1 | tail -2" } }] }) + "\n");
    await feature.onTick!(ctx);
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as TripwiresMessage).hits.map((h) => [h.tripwireId, h.subagentId])).toEqual([["merge-without-review", "a1b2c3d4e5f6"]]);
  });

  it("an unreadable subagent entry is skipped: the files around it are read and every hit is pushed", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const parent = "66666666-6666-6666-6666-666666666666";
    const now = Date.now();
    const iso = (dMs: number): string => new Date(now + dMs).toISOString();
    const subDir = join(dir, "-agent-world", parent, "subagents");
    await mkdir(subDir, { recursive: true });
    // Real commands: the browse restart (journal #16) and the ps count that counted itself (journal iteration 4).
    await writeFile(join(subDir, "agent-aaaa1111.jsonl"), assistantLine({ cwd, timestamp: iso(-30_000), toolUses: [{ name: "Bash", input: { command: '"$B" restart --help 2>&1 | head -20' } }] }) + "\n");
    await mkdir(join(subDir, "agent-mmmm5555.jsonl")); // EISDIR when read (a delete race or EACCES fails the same way)
    await writeFile(join(subDir, "agent-zzzz9999.jsonl"), assistantLine({ cwd, timestamp: iso(-20_000), toolUses: [{ name: "Bash", input: { command: 'rtk proxy ps aux | grep -c "native-binary/claude"' } }] }) + "\n");
    const feature = createTripwiresFeature({ home: "/Users/alexboghossian", lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    await feature.onTick!(ctxFor(db, emitted, dir));
    const pushed = emitted.flatMap((m) => (m as TripwiresMessage).hits.map((h) => h.tripwireId)).sort();
    expect(pushed).toEqual(["browse-restart-stop", "ps-grep-counts-itself"]);
    expect((feature.snapshotExtras!(ctxFor(db, [], dir))[TRIPWIRES_HITS_KEY] as unknown[]).length).toBe(2);
  });

  it("never reads a subagent transcript that is not live", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const subDir = join(dir, "-agent-world", "55555555-5555-5555-5555-555555555555", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-old0000001.jsonl"), assistantLine({ cwd: dir, timestamp: new Date().toISOString(), toolUses: [{ name: "Bash", input: { command: '"$B" restart' } }] }) + "\n");
    const later = Date.now() + 60 * 60_000; // an hour on: the file's mtime is outside the live window
    const feature = createTripwiresFeature({ home: "/Users/alexboghossian", now: () => later, lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    await feature.onTick!(ctxFor(db, emitted, dir));
    expect(emitted).toEqual([]);
  });
});

// ── Memory that lasts: the hit log (data/tripwires.jsonl) ───────────────────────────────────
// Every regression test here starts a FRESH feature instance (a new server process) from an
// EXISTING, non-empty log: an empty fixture would skip the exact fold path a restart runs.

const HOME = "/Users/alexboghossian";
// Real commands from the journal: the ps count that counted itself (iteration 4) and the browse
// restart that took down the shared daemon (#16).
const PS_COUNT = 'rtk proxy ps aux | grep -c "native-binary/claude"';
const BROWSE_RESTART = '"$B" restart --help 2>&1 | head -20';

async function logLines(dataDir: string, name = "tripwires.jsonl"): Promise<string[]> {
  return (await readFile(join(dataDir, name), "utf8")).split("\n").filter(Boolean);
}

describe("tripwires: hits survive a restart (data/tripwires.jsonl)", () => {
  it("a fresh process folds an existing log back in, never re-pushes it, and a repeat after the restart is still one hit", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const now = Date.now();
    const iso = (dMs: number): string => new Date(now + dMs).toISOString();
    const file = await writeSessionFile(dir, "-agent-world", sessionId, assistantLine({ cwd, timestamp: iso(-30_000), toolUses: [{ name: "Bash", input: { command: PS_COUNT } }] }) + "\n");

    // Process 1 finds the hit and appends it.
    const before = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const emitted1: unknown[] = [];
    const ctx1 = ctxFor(db, emitted1, dir);
    await before.onIndexPass!(ctx1, (await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir })).linesBySession);
    expect(emitted1).toHaveLength(1);
    const [hit] = (emitted1[0] as TripwiresMessage).hits;
    const body1 = await getJson(before.routes!.find((r) => r.path === "/api/tripwires")!, ctx1);
    expect(body1.persistence).toMatchObject({ file: "tripwires.jsonl", restored: 0, appended: 1, unconfirmed: 0, lastError: null });
    const lines = await logLines(dir);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(hit);

    // Process 2: a restart. The log is non-empty; nothing has been ingested yet.
    const after = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const emitted2: unknown[] = [];
    const ctx2 = ctxFor(db, emitted2, dir);
    const body2 = await getJson(after.routes!.find((r) => r.path === "/api/tripwires")!, ctx2);
    expect(body2.hits).toEqual([hit]);
    expect(body2.persistence).toMatchObject({ restored: 1, appended: 0, unconfirmed: 0, lastError: null });
    expect(after.snapshotExtras!(ctx2)[TRIPWIRES_HITS_KEY]).toEqual([hit]);
    expect(recentTripwireHits()).toEqual([hit]); // the resident, president and alumni read this
    expect(emitted2).toEqual([]); // a restored hit is history, never pushed as new

    // The same session repeats the same lesson after the restart: deduped against the log.
    await appendToSessionFile(file, assistantLine({ cwd, timestamp: iso(-1_000), toolUses: [{ name: "Bash", input: { command: PS_COUNT } }] }) + "\n");
    await after.onIndexPass!(ctx2, (await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir })).linesBySession);
    expect(emitted2).toEqual([]);
    // …and a different lesson in the same session is a new hit, appended after the first.
    await appendToSessionFile(file, assistantLine({ cwd, timestamp: iso(0), toolUses: [{ name: "Bash", input: { command: BROWSE_RESTART } }] }) + "\n");
    await after.onIndexPass!(ctx2, (await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir })).linesBySession);
    expect((emitted2 as TripwiresMessage[]).flatMap((m) => m.hits.map((h) => h.tripwireId))).toEqual(["browse-restart-stop"]);
    const body3 = await getJson(after.routes!.find((r) => r.path === "/api/tripwires")!, ctx2);
    expect(body3.hits.map((h) => h.tripwireId)).toEqual(["browse-restart-stop", "ps-grep-counts-itself"]);
    expect(body3.persistence).toMatchObject({ restored: 1, appended: 1, unconfirmed: 0 });
    expect((await logLines(dir)).map((l) => (JSON.parse(l) as TripwireHit).tripwireId)).toEqual(["ps-grep-counts-itself", "browse-restart-stop"]);
  });

  it("a live subagent re-read from offset 0 after a restart is deduped against the log", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const parent = "88888888-8888-8888-8888-888888888888";
    const subDir = join(dir, "-agent-world", parent, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-bbbb2222.jsonl"), assistantLine({ cwd, timestamp: new Date(Date.now() - 20_000).toISOString(), toolUses: [{ name: "Bash", input: { command: PS_COUNT } }] }) + "\n");
    const first = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const emitted1: unknown[] = [];
    await first.onTick!(ctxFor(db, emitted1, dir));
    expect(emitted1).toHaveLength(1);
    await getJson(first.routes!.find((r) => r.path === "/api/tripwires")!, ctxFor(db, [], dir)); // lets the append settle
    expect(await logLines(dir)).toHaveLength(1);

    const second = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const emitted2: unknown[] = [];
    await second.onTick!(ctxFor(db, emitted2, dir)); // offsets are per process: the file is read from 0 again
    expect(emitted2).toEqual([]);
    const body = await getJson(second.routes!.find((r) => r.path === "/api/tripwires")!, ctxFor(db, [], dir));
    expect(body.hits).toHaveLength(1);
    expect(await logLines(dir)).toHaveLength(1);
  });

  it("the fold keeps the first copy of an id, skips torn and invalid lines, and lists newest first", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const base: TripwireHit = { id: "s1:ps-grep-counts-itself", sessionId: "s1", subagentId: null, district: "agent-world", tripwireId: "ps-grep-counts-itself", lesson: "ps | grep -c counts itself", severity: "info", source: "journal", tool: "Bash", snippet: "ps aux | grep -c claude", at: "2026-09-28T03:00:00.000Z" };
    const b: TripwireHit = { ...base, id: "s2:browse-restart-stop", sessionId: "s2", tripwireId: "browse-restart-stop", severity: "danger", snippet: '"$B" restart', at: "2026-09-28T04:00:00.000Z" };
    const dupe: TripwireHit = { ...base, snippet: "a later copy of the same id", at: "2026-09-28T05:00:00.000Z" };
    await writeFile(
      join(dir, "tripwires.jsonl"),
      [JSON.stringify(base), '{"id":"torn-by-a-cra', JSON.stringify(b), JSON.stringify(dupe), JSON.stringify({ ...b, id: "s3:x", severity: "fatal" }), ""].join("\n"),
    );
    const feature = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const body = await getJson(feature.routes!.find((r) => r.path === "/api/tripwires")!, ctxFor(db, [], dir));
    expect(body.hits).toEqual([b, base]);
    expect(body.persistence.restored).toBe(2);
  });

  it("rotates at the size limit: a full generation is never written again, and a restart folds the newest two", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const cwd = join(dir, "agent-world");
    const rotateBytes = 200; // one hit line is ~450 bytes, so every hit fills its generation
    const feature = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir), rotateBytes });
    const ctx = ctxFor(db, [], dir);
    const route = feature.routes!.find((r) => r.path === "/api/tripwires")!;
    const sessions = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];
    let gen0 = "";
    for (const [i, sid] of sessions.entries()) {
      await writeSessionFile(dir, "-agent-world", sid, assistantLine({ cwd, timestamp: new Date(Date.now() - 10_000).toISOString(), toolUses: [{ name: "Bash", input: { command: PS_COUNT } }] }) + "\n");
      await feature.onIndexPass!(ctx, (await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir })).linesBySession);
      await getJson(route, ctx);
      if (i === 0) gen0 = await readFile(join(dir, "tripwires.jsonl"), "utf8");
    }
    const names = (await readdir(dir)).filter((n) => tripwiresGeneration(n) !== null).sort();
    expect(names).toEqual(["tripwires.1.jsonl", "tripwires.2.jsonl", "tripwires.jsonl"]);
    expect(await readFile(join(dir, "tripwires.jsonl"), "utf8")).toBe(gen0); // append-only: untouched once full
    expect((await logLines(dir, "tripwires.1.jsonl")).map((l) => (JSON.parse(l) as TripwireHit).sessionId)).toEqual([sessions[1]]);
    expect((await logLines(dir, "tripwires.2.jsonl")).map((l) => (JSON.parse(l) as TripwireHit).sessionId)).toEqual([sessions[2]]);

    const restarted = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir), rotateBytes });
    const body = await getJson(restarted.routes!.find((r) => r.path === "/api/tripwires")!, ctxFor(db, [], dir));
    expect(body.hits.map((h) => h.sessionId)).toEqual([sessions[2], sessions[1]]); // gen 0 is past the fold's two
    expect(body.persistence).toMatchObject({ file: "tripwires.2.jsonl", restored: 2 });
  });

  it("a log path that isn't a regular file is never opened, and every hit meant for it is reported unconfirmed", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    await mkdir(join(dir, "tripwires.jsonl")); // not a file: the fold and the append must both refuse it
    const cwd = join(dir, "agent-world");
    await writeSessionFile(dir, "-agent-world", "99999999-9999-4999-8999-999999999999", assistantLine({ cwd, timestamp: new Date(Date.now() - 10_000).toISOString(), toolUses: [{ name: "Bash", input: { command: PS_COUNT } }] }) + "\n");
    const feature = createTripwiresFeature({ home: HOME, lessonSources: noLessons(dir) });
    const emitted: unknown[] = [];
    const ctx = ctxFor(db, emitted, dir);
    await feature.onIndexPass!(ctx, (await runIndexPass(db, { projectsDir: dir, collectLines: true, homeDir: dir })).linesBySession);
    expect(emitted).toHaveLength(1); // the hit itself still reaches every surface
    const body = await getJson(feature.routes!.find((r) => r.path === "/api/tripwires")!, ctx);
    expect(body.hits).toHaveLength(1);
    expect(body.persistence).toMatchObject({ restored: 0, appended: 0, unconfirmed: 1 });
    expect(body.persistence.lastError).toBe("tripwires.jsonl: not a regular file");
  });
});

describe("tripwires: a tab left open while the server restarts", () => {
  // The real hub (startServer), a data dir whose hit log is NOT empty, and a WS opened the moment
  // the server listens, before any GET: exactly what an open tab's reconnect does after a launchd
  // or post-merge restart. The snapshot replaces the client's list, so it must carry the log.
  it("the first WS snapshot already carries the folded hit log and the lesson coverage", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const hit: TripwireHit = { id: "s1:ps-grep-counts-itself", sessionId: "s1", subagentId: null, district: "agent-world", tripwireId: "ps-grep-counts-itself", lesson: "ps | grep -c counts itself", severity: "info", source: "journal", tool: "Bash", snippet: "ps aux | grep -c claude", at: "2026-09-28T03:00:00.000Z" };
    await writeFile(join(dir, "tripwires.jsonl"), `${JSON.stringify(hit)}\n`);
    await writeFile(join(dir, "journal.md"), "- Lesson: one.\n- Lesson: two.\n");
    const feature = createTripwiresFeature({ home: HOME, lessonSources: { ...noLessons(dir), journal: join(dir, "journal.md") } });
    // world.db in `dir`, so the feature's hit log is the one written above.
    const booted = await bootTestServer({ configOverrides: { dbPath: join(dir, "world.db"), features: [feature] } });
    dirs.push(booted.dir);
    const got: ServerMessage[] = [];
    const ws = new WebSocket(`${booted.base.replace("http", "ws")}/ws`);
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerMessage));
    try {
      await vi.waitFor(() => expect(got.length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
      const first = got[0];
      const extras = first?.type === "snapshot" ? first.world.extras : undefined;
      expect(first?.type).toBe("snapshot");
      expect(extras?.[TRIPWIRES_HITS_KEY]).toEqual([hit]);
      expect(parseTripwireCoverage(extras?.[TRIPWIRES_COVERAGE_KEY])).toMatchObject({ lessonsWritten: 2, guarded: 12 });
      // The GET agrees, and a restored hit is history: never pushed to the open tab as new.
      const body = (await (await fetch(`${booted.base}/api/tripwires`)).json()) as TripwiresResponse;
      expect(body.hits).toEqual([hit]);
      expect(body.persistence).toMatchObject({ restored: 1, appended: 0 });
      expect(got.filter((m) => m.type === "feature")).toEqual([]);
    } finally {
      ws.terminate(); // an open socket would hold server.close() (and hide a failed expect behind a timeout)
      await booted.server.close();
    }
  });
});

describe("tripwires: the log's pure and guarded halves", () => {
  const tws = compileTripwires(TRIPWIRE_DEFS);
  const hit = (id: string, at: string): TripwireHit => ({ id, sessionId: id.split(":")[0]!, subagentId: null, district: null, tripwireId: id.split(":")[1]!, lesson: "l", severity: "warn", source: "s", tool: "Bash", snippet: "x", at });

  it("restore dedupes like ingest: first copy wins, ids already held are skipped, restored hits go after live ones, capped", () => {
    const tracker = new TripwireTracker(tws, { home: HOME, cap: 3 });
    const kept = tracker.restore([hit("a:t", "2026-09-28T01:00:00Z"), hit("b:t", "2026-09-28T02:00:00Z"), { ...hit("a:t", "2026-09-28T03:00:00Z"), snippet: "dupe" }]);
    expect(kept.map((h) => h.id)).toEqual(["a:t", "b:t"]);
    expect(tracker.hits().map((h) => h.id)).toEqual(["b:t", "a:t"]);
    expect(tracker.hits()[1]!.snippet).toBe("x");
    // A second restore (never happens in the feature, but must stay sane): held ids are skipped.
    expect(tracker.restore([hit("b:t", "2026-09-28T04:00:00Z"), hit("c:t", "2026-09-28T00:30:00Z"), hit("d:t", "2026-09-28T00:10:00Z")]).map((h) => h.id)).toEqual(["c:t", "d:t"]);
    expect(tracker.hits().map((h) => h.id)).toEqual(["b:t", "a:t", "d:t"]); // cap 3
  });

  it("parseHitLines skips blank, torn and invalid lines", () => {
    const good = hit("a:t", "2026-09-28T01:00:00Z");
    expect(parseHitLines(`\n${JSON.stringify(good)}\n{"id":\nnot json\n${JSON.stringify({ ...good, at: "yesterday" })}\n${JSON.stringify({ ...good, id: "b:t", extra: "x".repeat(50) })}\n`)).toEqual([good, { ...good, id: "b:t" }]);
  });

  it("tripwiresGeneration recognises only the log's own generation names", () => {
    expect(["tripwires.jsonl", "tripwires.1.jsonl", "tripwires.12.jsonl", "tripwires.0.jsonl", "tripwires.jsonl.bak", "xtripwires.jsonl", "tripwires.-1.jsonl"].map(tripwiresGeneration)).toEqual([0, 1, 12, null, null, null, null]);
  });

  it("PathGuard: a timed-out operation leaves its path refused until it settles, and never runs a second one meanwhile", async () => {
    const guard = new PathGuard(20);
    let release: () => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = () => resolve("late");
    });
    expect(await guard.run("/p", () => slow)).toEqual({ ok: false, error: "timed out after 20 ms", ambiguous: true });
    let calls = 0;
    const refused = await guard.run("/p", async () => {
      calls++;
      return "x";
    });
    expect(refused).toMatchObject({ ok: false, ambiguous: false });
    expect(calls).toBe(0);
    expect(await guard.run("/other", async () => "fine")).toEqual({ ok: true, value: "fine" }); // other paths are unaffected
    release();
    await slow;
    await new Promise((r) => setTimeout(r, 0));
    expect(await guard.run("/p", async () => "again")).toEqual({ ok: true, value: "again" });
  });
});

describe("tripwires: lesson coverage (counts only)", () => {
  // Excerpts in the real files' own formats (journal.md, MEMORY.md, CASES.md).
  const JOURNAL = [
    "## 2026-09-28 · iteration 9",
    "- Lesson: check the content of its output, not its heartbeat.",
    "- Lesson (09-28): I chained gh pr merge … and the merge FAILED.",
    "- Shipped #27 (lesson tripwires). Lessons from today are below.",
    "- Found: a Lesson: mid-line counts too. Lesson: but one line counts once.",
  ].join("\n");
  const MEMORY = ["# Memory Index", "## ⚠ Standing warnings — act on these without a recall hit", "", "- **Always-live infra**: HARD STOP.", "- **acme.ai**: main=prod.", "  - a nested sub-bullet is not a warning", "## 📚 Scenario bundles", "- not a standing warning"].join("\n");
  const CASES = ["# Agent Conduct", "### Case 1 — Always-live infrastructure", "text", "### Case 2 — Unsourced public claim", "## Layer 2", "### Not a case"].join("\n");

  it("counts each source by its fixed rule", () => {
    expect(countJournalLessons(JOURNAL)).toBe(3);
    expect(countStandingWarnings(MEMORY)).toBe(2);
    expect(countFeedbackMemories(["feedback_a.md", "feedback_b.md", "project_c.md", "feedback_notes.txt", "MEMORY.md"])).toBe(2);
    expect(countConductCases(CASES)).toBe(2);
  });

  it("guarded = the 12 rules; each source's cite count comes from the rules' own source field", () => {
    const counts = {
      journal: { path: "~/j", ok: true as const, lessons: 3 },
      "standing-warnings": { path: "~/m", ok: true as const, lessons: 2 },
      "feedback-memories": { path: "~/f/", ok: true as const, lessons: 2 },
      "conduct-cases": { path: "~/c", ok: false as const, error: "ENOENT" },
    };
    const c = buildCoverage(counts, TRIPWIRE_DEFS, "2026-09-28T12:00:00.000Z");
    expect(TRIPWIRE_DEFS).toHaveLength(12);
    expect(c.guarded).toBe(12);
    expect(c.lessonsWritten).toBe(7); // the unreadable source adds nothing
    expect(c.sources.map((x) => [x.id, x.lessons, x.citedByRules])).toEqual([
      ["journal", 3, 4],
      ["standing-warnings", 2, 6],
      ["feedback-memories", 2, 2],
      ["conduct-cases", null, 0],
    ]);
    expect(coverageLine(c)).toBe("7 lessons written, 12 guarded");
    expect(coverageSourcesLine(c)).toBe("loop journal 3 (4 rules cite it) · standing warnings 2 (6 rules cite it) · feedback memories 2 (2 rules cite it) · conduct cases unreadable (0 rules cite it)");
    expect(parseTripwireCoverage(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseTripwireCoverage({ ...c, guarded: -1 })).toBeNull();
  });

  it("the feature counts the real files on its tick and serves the same coverage on GET and in the snapshot, rules untouched", async () => {
    const dir = await makeTempProjectsDir();
    dirs.push(dir);
    const db = await makeTempDb(dir);
    const memoryDir = join(dir, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(dir, "journal.md"), JOURNAL);
    await writeFile(join(memoryDir, "MEMORY.md"), MEMORY);
    for (const n of ["feedback_a.md", "feedback_b.md", "project_c.md"]) await writeFile(join(memoryDir, n), "x");
    await writeFile(join(dir, "CASES.md"), CASES);
    const feature = createTripwiresFeature({ home: HOME, lessonSources: { journal: join(dir, "journal.md"), memoryDir, conductCases: join(dir, "CASES.md") } });
    const ctx = ctxFor(db, [], dir);
    expect(feature.snapshotExtras!(ctx)[TRIPWIRES_COVERAGE_KEY]).toBeNull(); // not counted before the first tick
    await feature.onTick!(ctx);
    const snap = parseTripwireCoverage(feature.snapshotExtras!(ctx)[TRIPWIRES_COVERAGE_KEY]);
    expect(snap).toMatchObject({ lessonsWritten: 9, guarded: 12 });
    const body = await getJson(feature.routes!.find((r) => r.path === "/api/tripwires")!, ctx);
    expect(body.coverage).toEqual(snap);
    expect(body.rules).toHaveLength(12); // counting lessons never adds a rule
  });
});
