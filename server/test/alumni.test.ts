// "alumni" (agent-city piece 6, the 🎓 Hall): the pure folds (parseAlumniLine, currentAlumni,
// buildEngineeringBay, buildResearchLibrary, emeritiOf) on real wire shapes, then writeLegacy /
// restoreLegacy / rotation against a real filesystem and a real indexed session (a throwaway home,
// never ~/.claude), and the destructive-route wiring itself: retiring through cleanup.ts's real
// /api/cleanup/retire route writes a card before the file moves, a guard failure writes none, and
// restoring appends a "restored" event without ever rewriting a line. Also: a card written before
// every guard has actually passed (a late guard refusal, a rename failure, the trash-root throw)
// must never leave a phantom Hall card (voidLegacy); a FIFO standing in for a dataless iCloud file is
// refused outright (stat, not open — never blocks and never opens the file at all, so repeated
// attempts never leak a thread-pool slot, and the test never has to release a reader/writer to avoid
// hanging its own cleanup); and a write that times out but might still land later is voided too, not
// just one whose card was definitely written.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ArchivedSession } from "../../shared/features/archive.js";
import { emeritiOf, type AlumniEvent, type AlumniResponse, type LegacyCard } from "../../shared/features/alumni.js";
import { DEPARTMENTS, type CareersResponse, type CareerWorker } from "../../shared/features/careers.js";
import type { OutcomeRecord, SessionOutcome } from "../../shared/features/outcomes.js";
import type { TopicsMap } from "../../shared/features/topics.js";
import type { TripwireHit } from "../../shared/features/tripwires.js";
import type { RetireResult, RestoreResult } from "../../shared/features/cleanup.js";
import type { ServerMessage, WorldAgent } from "../../shared/types.js";
import type { WorldDb } from "../db.js";
import { buildWorldViews } from "../index.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { READ_TIMEOUT_MS } from "../features/archive.js";
import { alumniFileName, buildEngineeringBay, buildResearchLibrary, createAlumniFeature, currentAlumni, inRange, parseAlumniLine } from "../features/alumni.js";
import { createCleanupFeature } from "../features/cleanup.js";
import { realTrashFs, retireSessions, type LegacyVoider, type TrashDeps, type TrashFs } from "../features/cleanup-trash.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import { assistantLine, bootTestServer, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

// Lets one specific test arm a one-shot delay on node:fs/promises's real appendFile for one exact
// path, to model a write that is genuinely slow (not stuck forever, unlike the FIFO tests above) and
// DOES land on disk once it finally settles — the shape round-2 review finding 2 is about. Every
// other appendFile call (this file's own trash log, any other path) and every other node:fs/promises
// function (mkdir, readFile, writeFile, mkdtemp, utimes, rm, …) goes straight through untouched.
// With `fail` set, that one slow write then rejects instead: it times out from its caller's point of
// view and never lands at all (the other half of "ambiguous").
const delayedAppend = vi.hoisted(() => ({ path: "", ms: 0, armed: false, fail: false }));
// Same idea for readFile: the first `skip` reads of `path` go straight through, the next one is
// slow (one-shot). Used to make any read of alumni.jsonl DURING a compensating void time out.
const delayedRead = vi.hoisted(() => ({ path: "", ms: 0, skip: 0, armed: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (path: unknown, data: unknown, opts: unknown) => {
      if (delayedAppend.armed && String(path) === delayedAppend.path) {
        delayedAppend.armed = false; // only the FIRST write to this path is slow, not every one
        const fail = delayedAppend.fail;
        await new Promise((resolve) => setTimeout(resolve, delayedAppend.ms));
        if (fail) throw new Error("EIO: i/o error, write");
      }
      return (actual.appendFile as (p: unknown, d: unknown, o: unknown) => Promise<void>)(path, data, opts);
    },
    readFile: async (path: unknown, opts: unknown) => {
      if (delayedRead.armed && String(path) === delayedRead.path) {
        if (delayedRead.skip > 0) delayedRead.skip -= 1;
        else {
          delayedRead.armed = false;
          await new Promise((resolve) => setTimeout(resolve, delayedRead.ms));
        }
      }
      return (actual.readFile as (p: unknown, o: unknown) => Promise<unknown>)(path, opts);
    },
  };
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function sid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

// ── parseAlumniLine / currentAlumni ─────────────────────────────────────────

function card(n: number, over: Partial<LegacyCard> = {}): LegacyCard & { kind: "retired" } {
  return {
    kind: "retired",
    sessionId: sid(n),
    name: `session ${n}`,
    city: "agent-world",
    startedAt: new Date(NOW - HOUR).toISOString(),
    lastActive: new Date(NOW).toISOString(),
    outcome: "shipped",
    reason: "owner/repo#12 merged",
    prs: [],
    artifacts: [],
    learnings: [],
    costUsd: 0.42,
    tripwireLessons: [],
    vaultNote: null,
    retiredAt: new Date(NOW).toISOString(),
    trashBatch: "2026-09-28/b1",
    ...over,
  };
}

describe("parseAlumniLine", () => {
  it("round-trips a retired line", () => {
    const c = card(1);
    expect(parseAlumniLine(JSON.stringify(c))).toEqual(c);
  });

  it("round-trips a restored line", () => {
    const e: AlumniEvent = { kind: "restored", sessionId: sid(1), at: new Date(NOW).toISOString() };
    expect(parseAlumniLine(JSON.stringify(e))).toEqual(e);
  });

  it("round-trips a voided line", () => {
    const e: AlumniEvent = { kind: "voided", sessionId: sid(1), at: new Date(NOW).toISOString(), trashBatch: "2026-09-28/b1" };
    expect(parseAlumniLine(JSON.stringify(e))).toEqual(e);
  });

  it("drops a voided line missing trashBatch", () => {
    expect(parseAlumniLine(JSON.stringify({ kind: "voided", sessionId: sid(1), at: new Date(NOW).toISOString() }))).toBeNull();
  });

  it("drops a blank line, invalid JSON, an unknown kind and a retired line missing a field", () => {
    expect(parseAlumniLine("")).toBeNull();
    expect(parseAlumniLine("   ")).toBeNull();
    expect(parseAlumniLine("{not json")).toBeNull();
    expect(parseAlumniLine(JSON.stringify({ kind: "graduated", sessionId: sid(1) }))).toBeNull();
    const { name: _name, ...missingName } = card(1);
    expect(parseAlumniLine(JSON.stringify(missingName))).toBeNull();
  });
});

describe("currentAlumni", () => {
  it("keeps a retired session with no later event", () => {
    expect(currentAlumni([card(1)])).toEqual([card(1)]);
  });

  it("drops a session whose last event is a restore", () => {
    expect(currentAlumni([card(1), { kind: "restored", sessionId: sid(1), at: new Date(NOW + 1000).toISOString() }])).toEqual([]);
  });

  it("drops a session whose last event is voided (its card was written but the move never completed)", () => {
    expect(currentAlumni([card(1), { kind: "voided", sessionId: sid(1), at: new Date(NOW + 1000).toISOString(), trashBatch: "2026-09-28/b1" }])).toEqual([]);
  });

  it("keeps a session retired again after a restore, with its newest card", () => {
    const first = card(1, { reason: "first retirement" });
    const restored: AlumniEvent = { kind: "restored", sessionId: sid(1), at: new Date(NOW + HOUR).toISOString() };
    const second = card(1, { reason: "second retirement", retiredAt: new Date(NOW + 2 * HOUR).toISOString() });
    expect(currentAlumni([first, restored, second])).toEqual([second]);
  });

  it("never lets one session's events affect another's", () => {
    expect(currentAlumni([card(1), card(2), { kind: "restored", sessionId: sid(1), at: new Date(NOW + 1000).toISOString() }])).toEqual([card(2)]);
  });
});

describe("inRange", () => {
  const now = NOW;
  it("'all' is always true", () => {
    expect(inRange(new Date(now - 365 * DAY).toISOString(), "all", now)).toBe(true);
  });
  it("'week' includes 6 days ago and excludes 8 days ago", () => {
    expect(inRange(new Date(now - 6 * DAY).toISOString(), "week", now)).toBe(true);
    expect(inRange(new Date(now - 8 * DAY).toISOString(), "week", now)).toBe(false);
  });
  it("'month' includes 29 days ago and excludes 31 days ago", () => {
    expect(inRange(new Date(now - 29 * DAY).toISOString(), "month", now)).toBe(true);
    expect(inRange(new Date(now - 31 * DAY).toISOString(), "month", now)).toBe(false);
  });
  it("an unparsable date is never silently dropped", () => {
    expect(inRange("not-a-date", "week", now)).toBe(true);
  });
});

// ── buildEngineeringBay / buildResearchLibrary (real WorldAgent + OutcomeRecord shapes) ─────────

function agent(n: number, title: string, islandId: string, hoursAgo = 1): WorldAgent {
  const started = NOW - hoursAgo * HOUR;
  return {
    id: sid(n),
    islandId,
    cwd: `/Users/x/code/${islandId}`,
    title,
    displayName: null,
    status: "dormant",
    startedAt: new Date(started).toISOString(),
    lastActive: new Date(started + 5 * 60_000).toISOString(),
    messageCount: 12,
    model: "claude-sonnet-5",
    role: "builder",
    color: "#0891b2",
    targetIslandId: islandId,
    tokens: 5000,
    awaitingInput: false,
  };
}

function rec(n: number, outcome: SessionOutcome, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    sessionId: sid(n),
    outcome,
    reason: `${outcome} evidence`,
    evidenceAt: null,
    lastActive: new Date(NOW).toISOString(),
    toolCalls: 6,
    writes: 1,
    learnings: [],
    artifacts: [],
    prs: [],
    pushes: [],
    todos: null,
    ending: null,
    onDisk: true,
    pending: false,
    provisionalUntil: null,
    ...over,
  };
}

function topicsMap(sessions: Record<string, { group: string }>): TopicsMap {
  return { generatedAt: new Date(NOW).toISOString(), groups: [], sessions: Object.fromEntries(Object.entries(sessions).map(([id, s]) => [id, { group: s.group, source: "rule" as const }])), islands: {}, catchAll: [], pendingJev: 0, jev: "disabled" };
}

describe("buildEngineeringBay", () => {
  const islands = new Map([
    ["acme-ai-next", "acme-ai-next"],
    ["agent-world", "agent-world"],
  ]);

  it("groups shipped/delivered indexed sessions by repo, most sessions first", () => {
    const agents = [agent(1, "fix the retry loop", "acme-ai-next"), agent(2, "add the retire route", "agent-world"), agent(3, "add the hall panel", "agent-world")];
    const outcomes = new Map([
      [sid(1), rec(1, "shipped")],
      [sid(2), rec(2, "delivered")],
      [sid(3), rec(3, "shipped")],
    ]);
    const bay = buildEngineeringBay(agents, islands, outcomes, "all", NOW);
    expect(bay.map((r) => r.repo)).toEqual(["agent-world", "acme-ai-next"]);
    expect(bay[0]?.sessions.map((s) => s.sessionId)).toEqual([sid(2), sid(3)]);
  });

  it("excludes failed/unknown outcomes and sessions with no outcome record at all", () => {
    const agents = [agent(1, "a", "agent-world"), agent(2, "b", "agent-world"), agent(3, "c", "agent-world")];
    const outcomes = new Map([
      [sid(1), rec(1, "failed")],
      [sid(2), rec(2, "unknown")],
      // sid(3): never scanned, no record at all
    ]);
    expect(buildEngineeringBay(agents, islands, outcomes, "all", NOW)).toEqual([]);
  });

  it("filters by range on the outcome's evidenceAt (falling back to lastActive)", () => {
    const agents = [agent(1, "old ship", "agent-world"), agent(2, "recent ship", "agent-world")];
    const outcomes = new Map([
      [sid(1), rec(1, "shipped", { evidenceAt: new Date(NOW - 40 * DAY).toISOString() })],
      [sid(2), rec(2, "shipped", { evidenceAt: new Date(NOW - 1 * DAY).toISOString() })],
    ]);
    const bay = buildEngineeringBay(agents, islands, outcomes, "week", NOW);
    expect(bay.flatMap((r) => r.sessions.map((s) => s.sessionId))).toEqual([sid(2)]);
  });
});

describe("buildResearchLibrary", () => {
  it("includes a RESEARCH session only when it has an artifact or a learning", () => {
    const agents = [agent(1, "is this repo worth using", "alexboghossian"), agent(2, "another research chat", "alexboghossian")];
    const outcomes = new Map([
      [sid(1), rec(1, "unknown", { artifacts: ["https://claude.ai/artifact/abc"] })],
      [sid(2), rec(2, "unknown")], // no artifacts, no learnings
    ]);
    const topics = topicsMap({ [sid(1)]: { group: "RESEARCH" }, [sid(2)]: { group: "RESEARCH" } });
    const lib = buildResearchLibrary(agents, outcomes, topics, "all", NOW);
    expect(lib.map((s) => s.sessionId)).toEqual([sid(1)]);
  });

  it("never includes a session outside the RESEARCH group", () => {
    const agents = [agent(1, "web work", "acme-ai-next")];
    const outcomes = new Map([[sid(1), rec(1, "unknown", { learnings: ["memory/x.md"] })]]);
    const topics = topicsMap({ [sid(1)]: { group: "WEB" } });
    expect(buildResearchLibrary(agents, outcomes, topics, "all", NOW)).toEqual([]);
  });

  it("returns [] while the topics map hasn't been computed yet, never throws", () => {
    expect(buildResearchLibrary([agent(1, "x", "y")], new Map(), null, "all", NOW)).toEqual([]);
  });
});

// ── emeritiOf ────────────────────────────────────────────────────────────────

function worker(key: string, state: CareerWorker["state"]): CareerWorker {
  return {
    key,
    name: null,
    department: DEPARTMENTS[0],
    state,
    standing: "trusted",
    reason: `${state} reason`,
    runs: [],
    lifetime: { total: 10, live: 10, archived: 0, clean: 10, wrote: 0, bad: 0 },
    lastRunAt: new Date(NOW).toISOString(),
    medianGapMs: HOUR,
    lapseAfterMs: 72 * HOUR,
    trustedSince: null,
    retiredAt: state === "retired" ? new Date(NOW).toISOString() : null,
    routine: null,
  };
}

function careers(workers: CareerWorker[]): CareersResponse {
  return { ok: true, at: new Date(NOW).toISOString(), inputs: { liveRuns: 10, archivedRuns: 0, archiveLoaded: true, outcomeRecords: 10, routines: 0 }, departments: DEPARTMENTS, summary: { trusted: 0, probation: 0, enrolled: 0, lapsed: 0, returned: 0, retired: 0, total: workers.length }, workers, trends: [] };
}

describe("emeritiOf", () => {
  it("hides the section (null) when careers data is unavailable", () => {
    expect(emeritiOf(null)).toBeNull();
  });
  it("is [] (not hidden) when careers loaded with nothing retired", () => {
    expect(emeritiOf(careers([worker("/daily-recap", "trusted")]))).toEqual([]);
  });
  it("lists only the retired workers", () => {
    const retired = worker("/inbox-operator", "retired");
    expect(emeritiOf(careers([worker("/daily-recap", "trusted"), retired]))).toEqual([retired]);
  });
});

// ── writeLegacy / rotation / retire+restore wiring, against a real fs + real indexed session ────

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface World {
  dir: string;
  projectsDir: string;
  dataDir: string;
  db: WorldDb;
}

async function makeWorld(): Promise<World> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const projectsDir = join(dir, "projects");
  await mkdir(projectsDir, { recursive: true });
  return { dir, projectsDir, dataDir: join(dir, "data"), db: await makeTempDb(dir) };
}

/** Writes one real session transcript and indexes it, so `w.db.getSession(id)` and worldViews()
 *  reflect the same shape /api/world serves — never a hand-built SessionRow. */
async function makeIndexedSession(w: World, id: string, opts: { proj: string; cwd: string; title: string }): Promise<void> {
  const at = new Date(NOW - HOUR).toISOString();
  await writeSessionFile(w.projectsDir, opts.proj, id, `${userLine({ cwd: opts.cwd, timestamp: at, text: opts.title })}\n${assistantLine({ cwd: opts.cwd, timestamp: at })}\n`);
  await runIndexPass(w.db, { projectsDir: w.projectsDir, homeDir: w.dir });
}

function ctxFor(w: World, dataDir: string, over: Partial<FeatureContext> = {}): FeatureContext {
  return {
    featureId: "alumni",
    db: w.db,
    config: { projectsDir: w.projectsDir, dbPath: join(dataDir, "world.db") },
    emit: () => {},
    broadcast: () => {},
    detectLive: () => new Map(),
    executors: {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    worldViews: () => buildWorldViews(w.db, new Map(), new Date(NOW)),
    ...over,
  } as unknown as FeatureContext;
}

describe("writeLegacy", () => {
  it("assembles a card from the real session row + islands, and injected outcomes/archive/tripwires/cost", async () => {
    const w = await makeWorld();
    const id = sid(1);
    await makeIndexedSession(w, id, { proj: "-w-agent-world", cwd: "/w/agent-world", title: "fix the retry loop" });
    const outcome: OutcomeRecord = rec(1, "shipped", { reason: "sboghossian/agent-world#61 merged", prs: [{ repo: "sboghossian/agent-world", number: 61, url: "https://github.com/sboghossian/agent-world/pull/61", state: "MERGED", mergedAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString(), firstSeenAt: new Date(NOW).toISOString() }], artifacts: ["https://claude.ai/artifact/abc"], learnings: ["memory/lesson.md"] });
    const archived: ArchivedSession = { id, title: "fix the retry loop", date: "2026-09-27", project: "agent-world", place: "island:agent-world", note: "10-Sessions/claude-code/2026-09-27-x.md" };
    const hit: TripwireHit = { id: `${id}:no-flock`, sessionId: id, subagentId: null, district: "agent-world", tripwireId: "no-flock", lesson: "macOS has no flock", severity: "warn", source: "journal 2026-09", tool: "Bash", snippet: "flock ...", at: new Date(NOW).toISOString() };
    const dataDir = join(w.dir, "data");
    const { writeLegacy } = createAlumniFeature({ dataDir, sources: { outcomes: () => [outcome], archive: () => [archived], tripwireHits: () => [hit], topics: () => null }, costUsdOf: () => 1.2345 });
    const ctx = ctxFor(w, dataDir);

    const status = await writeLegacy(ctx, [id], "2026-09-28/batch1");
    expect(status.get(id)).toBe("legacy card: written");

    const lines = (await readFile(join(dataDir, "alumni.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const e = parseAlumniLine(lines[0] ?? "");
    expect(e?.kind).toBe("retired");
    const c = e as LegacyCard & { kind: "retired" };
    expect(c.sessionId).toBe(id);
    expect(c.name).toBe("fix the retry loop");
    expect(c.city).toBe("agent-world");
    expect(c.outcome).toBe("shipped");
    expect(c.prs).toEqual(outcome.prs);
    expect(c.artifacts).toEqual(outcome.artifacts);
    expect(c.learnings).toEqual(outcome.learnings);
    expect(c.costUsd).toBe(1.2345);
    expect(c.tripwireLessons).toEqual(["no-flock"]);
    expect(c.vaultNote).toBe(archived.note);
    expect(c.trashBatch).toBe("2026-09-28/batch1");
  });

  it("still writes a card (outcome 'unknown') for a session with no outcome record, archive entry or tripwire hits", async () => {
    const w = await makeWorld();
    const id = sid(2);
    await makeIndexedSession(w, id, { proj: "-w-p", cwd: "/w/p", title: "just a chat" });
    const dataDir = join(w.dir, "data");
    const { writeLegacy } = createAlumniFeature({ dataDir, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null }, costUsdOf: () => null });
    const status = await writeLegacy(ctxFor(w, dataDir), [id], "b1");
    expect(status.get(id)).toBe("legacy card: written");
    const [line] = (await readFile(join(dataDir, "alumni.jsonl"), "utf8")).trim().split("\n");
    const c = parseAlumniLine(line ?? "") as (LegacyCard & { kind: "retired" }) | null;
    expect(c?.outcome).toBe("unknown");
    expect(c?.vaultNote).toBeNull();
    expect(c?.costUsd).toBeNull();
  });

  it("never throws when the data dir can't be written to, and reports why per id", async () => {
    const w = await makeWorld();
    const id = sid(3);
    await makeIndexedSession(w, id, { proj: "-w-p", cwd: "/w/p", title: "x" });
    // A FILE where alumni.ts expects a directory: mkdir(recursive) on it must fail (ENOTDIR/EEXIST).
    const blocked = join(w.dir, "blocked");
    await writeFile(blocked, "not a directory");
    const { writeLegacy } = createAlumniFeature({ dataDir: join(blocked, "data"), sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const status = await writeLegacy(ctxFor(w, join(w.dir, "data")), [id], "b1");
    expect(status.get(id)).toMatch(/^legacy card: not written \(/);
  });

  it("does nothing (no file created) for an empty id list", async () => {
    const w = await makeWorld();
    const dataDir = join(w.dir, "data");
    const { writeLegacy } = createAlumniFeature({ dataDir });
    const status = await writeLegacy(ctxFor(w, dataDir), [], "b1");
    expect(status.size).toBe(0);
    await expect(readFile(join(dataDir, "alumni.jsonl"), "utf8")).rejects.toThrow();
  });

  it("alumni.jsonl replaced by a FIFO (no reader/writer) is refused by stat before it is ever opened, so it never hangs at all", async () => {
    const w = await makeWorld();
    const id = sid(4);
    const dataDir = join(w.dir, "data");
    await mkdir(dataDir, { recursive: true });
    const fifoPath = join(dataDir, "alumni.jsonl");
    // A real open() of this FIFO (for either read or write) blocks forever: nothing here ever reads
    // it, so — unlike the round-1 fix — there is no reader/writer to release in a `finally`.
    execFileSync("mkfifo", [fifoPath]);
    const { writeLegacy } = createAlumniFeature({ dataDir, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });

    const startedAt = Date.now();
    const status = await writeLegacy(ctxFor(w, dataDir), [id], "b1");
    expect(status.get(id)).toBe("legacy card: not written (alumni.jsonl is not a regular local file)");
    expect(Date.now() - startedAt).toBeLessThan(500); // stat() never blocks; no timeout was ever raced
  });

  it("5 consecutive retire attempts against the same stuck FIFO, plus a GET, all refuse immediately — no thread-pool slot ever leaks", async () => {
    const w = await makeWorld();
    const dataDir = join(w.dir, "data");
    await mkdir(dataDir, { recursive: true });
    const fifoPath = join(dataDir, "alumni.jsonl");
    execFileSync("mkfifo", [fifoPath]); // never released: a real open would hang forever with no reader/writer
    const { writeLegacy, feature } = createAlumniFeature({ dataDir, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const ctx = ctxFor(w, dataDir);
    const route = feature.routes?.find((r) => r.path === "/api/alumni");
    if (!route) throw new Error("no /api/alumni route");

    const startedAt = Date.now();
    for (let i = 0; i < 5; i++) {
      const id = sid(20 + i);
      const status = await writeLegacy(ctx, [id], `b${i}`);
      expect(status.get(id)).toBe("legacy card: not written (alumni.jsonl is not a regular local file)");
    }
    let statusCode = 0;
    let body = "";
    const res = { writeHead: (s: number) => (statusCode = s), end: (s: string) => (body = s) };
    await route.handler({ url: "/api/alumni?range=all" } as never, res as never, ctx, {});
    expect(statusCode).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ ok: false });
    // Under the round-1 fix, retire #1 alone cost ~2s (a real timeout wait) and later attempts piled
    // onto the exhausted thread pool; here nothing was ever opened, so all 6 calls together are fast.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe("rotation", () => {
  it("rotates to alumni.1.jsonl once the current file reaches rotateAt lines, and GET reads both generations", async () => {
    const w = await makeWorld();
    const dataDir = join(w.dir, "data");
    const { writeLegacy, feature } = createAlumniFeature({ dataDir, rotateAt: 2, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const ctx = ctxFor(w, dataDir);
    await writeLegacy(ctx, [sid(1), sid(2)], "b1"); // fills gen 0 to exactly rotateAt
    await writeLegacy(ctx, [sid(3)], "b2"); // must roll to gen 1

    expect((await readFile(join(dataDir, alumniFileName(0)), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readFile(join(dataDir, alumniFileName(1)), "utf8")).trim().split("\n")).toHaveLength(1);

    const route = feature.routes?.find((r) => r.path === "/api/alumni");
    if (!route) throw new Error("no /api/alumni route");
    const res = { writeHead: () => {}, end: (s: string) => (body = s) };
    let body = "";
    await route.handler({ url: "/api/alumni?range=all" } as never, res as never, ctx, {});
    const parsed = JSON.parse(body) as AlumniResponse;
    expect(parsed.cards.map((c) => c.sessionId).sort()).toEqual([sid(1), sid(2), sid(3)].sort());
  });

  it("re-seeds its generation correctly on a fresh feature instance (restart-safe)", async () => {
    const w = await makeWorld();
    const dataDir = join(w.dir, "data");
    const ctx = ctxFor(w, dataDir);
    const first = createAlumniFeature({ dataDir, rotateAt: 1, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    await first.writeLegacy(ctx, [sid(1)], "b1"); // gen 0 now has 1 line = rotateAt

    // A brand-new instance (as a process restart would create) must see gen 0 is full and start gen 1.
    const second = createAlumniFeature({ dataDir, rotateAt: 1, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    await second.writeLegacy(ctx, [sid(2)], "b2");

    expect((await readFile(join(dataDir, alumniFileName(0)), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readFile(join(dataDir, alumniFileName(1)), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

// Regression (round-4 review): round 3 counted a timed-out (AmbiguousWriteError) append toward
// rotation, presuming it lands. When it never does, the generation rotates early and the void goes to
// the next file; a restart's re-seed then stops at the short generation and appends there again, so
// new events fold BEFORE older ones already in the next generation. Only a confirmed write may move
// the count, which also keeps the void in the card's own generation, on its per-path chain.
describe("rotation: a timed-out card write that never lands, at a generation boundary, then a restart", () => {
  afterEach(() => {
    delayedAppend.armed = false;
    delayedAppend.fail = false;
  });
  const noSources = { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null };

  async function hallIds(feature: ServerFeature, ctx: FeatureContext): Promise<string[]> {
    const route = feature.routes?.find((r) => r.path === "/api/alumni");
    if (!route) throw new Error("no /api/alumni route");
    let body = "";
    const res = { writeHead: () => {}, end: (s: string) => (body = s) };
    await route.handler({ url: "/api/alumni?range=all" } as never, res as never, ctx, {});
    return (JSON.parse(body) as AlumniResponse).cards.map((c) => c.sessionId).sort();
  }

  async function eventsIn(dataDir: string, gen: number): Promise<string[]> {
    const raw = await readFile(join(dataDir, alumniFileName(gen)), "utf8").catch(() => "");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; sessionId: string })
      .map((e) => `${e.kind}:${e.sessionId}`);
  }

  /** gen 0 holds 2 of rotateAt=3 lines; s3's card append then times out and later rejects (never
   *  lands), and retireSessions' compensating voidLegacy follows, as it would after a failed move. */
  async function driveToBoundary(w: World) {
    const ctx = ctxFor(w, w.dataDir);
    const first = createAlumniFeature({ dataDir: w.dataDir, rotateAt: 3, sources: noSources });
    await first.writeLegacy(ctx, [sid(1)], "b1");
    await first.writeLegacy(ctx, [sid(2)], "b2");
    Object.assign(delayedAppend, { path: join(w.dataDir, alumniFileName(0)), ms: READ_TIMEOUT_MS + 400, armed: true, fail: true });
    expect((await first.writeLegacy(ctx, [sid(3)], "b3")).get(sid(3))).toBe("legacy card: unknown (timed out writing alumni.jsonl)");
    expect(await first.voidLegacy(ctx, [sid(3)], "b3")).toEqual({ state: "written" });
    await new Promise((resolve) => setTimeout(resolve, 800)); // the card's write has rejected by now
    return { first, ctx };
  }

  it("the void stays in the card's generation, so re-retiring that session after a restart shows its card", async () => {
    const w = await makeWorld();
    const { ctx } = await driveToBoundary(w);
    const second = createAlumniFeature({ dataDir: w.dataDir, rotateAt: 3, sources: noSources }); // a restart
    expect((await second.writeLegacy(ctx, [sid(3)], "b4")).get(sid(3))).toBe("legacy card: written");

    expect(await hallIds(second.feature, ctx)).toEqual([sid(1), sid(2), sid(3)]);
    expect(await eventsIn(w.dataDir, 0)).toEqual([`retired:${sid(1)}`, `retired:${sid(2)}`, `voided:${sid(3)}`]);
    expect(await eventsIn(w.dataDir, 1)).toEqual([`retired:${sid(3)}`]);
  }, 10_000);

  it("a session carded after the boundary and restored after a restart leaves the Hall", async () => {
    const w = await makeWorld();
    const { first, ctx } = await driveToBoundary(w);
    await first.writeLegacy(ctx, [sid(4)], "b5"); // a later, successful retire in the same process
    const second = createAlumniFeature({ dataDir: w.dataDir, rotateAt: 3, sources: noSources }); // a restart
    await second.restoreLegacy(ctx, [sid(4)]);

    expect(await hallIds(second.feature, ctx)).toEqual([sid(1), sid(2)]);
    expect(await eventsIn(w.dataDir, 1)).toEqual([`retired:${sid(4)}`, `restored:${sid(4)}`]);
  }, 10_000);
});

// ── the destructive-route wiring: retire → legacy card → restore → restored event ───────────────

const noGuard = (): null => null;
const item = (id: string) => ({ id, title: "t", cwd: "/w/proj", messageCount: 2, lastActive: new Date(NOW - DAY).toISOString() });

describe("retireSessions + writeLegacy (unit-level, on the real trash fs)", () => {
  async function trashDeps(): Promise<{ home: string; deps: TrashDeps }> {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    return { home, deps: { home, projectsDir: join(home, ".claude", "projects"), fs: realTrashFs, now: () => new Date(NOW) } };
  }

  it("writes a card only for ids whose live-guard passed, never for one the guard refuses", async () => {
    const { deps } = await trashDeps();
    const ok = "aaaaaaaa-0000-4000-8000-000000000000";
    const live = "bbbbbbbb-0000-4000-8000-000000000000";
    const dir = join(deps.projectsDir, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    for (const id of [ok, live]) {
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
    }
    const calls: string[][] = [];
    const legacy = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
      calls.push([...ids]);
      return new Map(ids.map((id) => [id, "legacy card: written"]));
    };
    const guard = (id: string): string | null => (id === live ? "it is live right now" : null);
    const out = await retireSessions(deps, [item(ok), item(live)], guard, legacy);
    expect(calls).toEqual([[ok]]); // never called with the refused id
    expect(out.results.find((r) => r.id === live)).toEqual({ id: live, ok: false, error: "protected: it is live right now", bytes: expect.any(Number) });
    expect(out.results.find((r) => r.id === live)?.legacy).toBeUndefined();
  });

  it("propagates written/not-written into RetireItemResult.legacy, and never throws when the writer fails", async () => {
    const { deps } = await trashDeps();
    const id = "aaaaaaaa-1111-4000-8000-000000000000";
    const dir = join(deps.projectsDir, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
    await utimes(join(dir, `${id}.jsonl`), old, old);

    const ok = await retireSessions(deps, [item(id)], noGuard, async (ids) => new Map(ids.map((i) => [i, "legacy card: written"])));
    expect(ok.results).toEqual([{ id, ok: true, bytes: expect.any(Number), legacy: "legacy card: written" }]);

    // A second, identically-shaped session whose writer throws: retire still succeeds.
    const id2 = "aaaaaaaa-2222-4000-8000-000000000000";
    await writeFile(join(dir, `${id2}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
    await utimes(join(dir, `${id2}.jsonl`), old, old);
    const failing = await retireSessions(deps, [item(id2)], noGuard, async () => {
      throw new Error("EACCES: permission denied");
    });
    expect(failing.results[0]?.ok).toBe(true); // the retire itself is unaffected
    expect(failing.results[0]?.legacy).toMatch(/^legacy card: not written \(.*EACCES/);
  });

  // A card is written as soon as the FIRST guard passes, before the move. Every one of these three
  // exercises a later guard/step failing anyway (the move-time re-check is itself a guard) and
  // proves the card gets voided instead of being left standing for a session that never moved.
  describe("voidLegacy: a card written before a later failure is never left standing", () => {
    const writtenCard = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => new Map(ids.map((id) => [id, "legacy card: written"]));
    /** A voider that records each call and reports its void as on disk. */
    const recordVoids =
      (voided: string[][]): LegacyVoider =>
      async (ids) => {
        voided.push([...ids]);
        return { state: "written" };
      };

    it("a rename failure (EBUSY) after the card was written", async () => {
      const { deps } = await trashDeps();
      const id = "aaaaaaaa-3000-4000-8000-000000000000";
      const dir = join(deps.projectsDir, "-w-proj");
      await mkdir(dir, { recursive: true });
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      const busyFs: TrashFs = {
        ...realTrashFs,
        async rename(from, to) {
          if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
          return realTrashFs.rename(from, to);
        },
      };
      const voided: string[][] = [];
      const voidLegacy = recordVoids(voided);

      const out = await retireSessions({ ...deps, fs: busyFs }, [item(id)], noGuard, writtenCard, voidLegacy);
      expect(out.results[0]).toMatchObject({ id, ok: false, error: expect.stringMatching(/EBUSY/), legacy: "legacy card: voided (not moved)" });
      expect(voided).toEqual([[id]]);
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true); // it never left ~/.claude/projects
    });

    it("a late guard refusal (the guard passes on the first call, refuses on the second)", async () => {
      const { deps } = await trashDeps();
      const id = "aaaaaaaa-3001-4000-8000-000000000000";
      const dir = join(deps.projectsDir, "-w-proj");
      await mkdir(dir, { recursive: true });
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      let calls = 0;
      const guard = (): string | null => (++calls > 1 ? "it was active in the last 30 minutes" : null);
      const voided: string[][] = [];
      const voidLegacy = recordVoids(voided);

      const out = await retireSessions(deps, [item(id)], guard, writtenCard, voidLegacy);
      expect(calls).toBe(2); // once to plan, once more right before the move
      expect(out.results[0]).toMatchObject({ id, ok: false, error: "protected: it was active in the last 30 minutes", legacy: "legacy card: voided (not moved)" });
      expect(voided).toEqual([[id]]);
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);
    });

    it("the trash-root-inside-projects throw: every planned card in the batch is voided even though the whole call rejects", async () => {
      // projectsDir === home, so trashRootOf(home) = <home>/.alef-trash resolves INSIDE projectsDir.
      const home = await mkdtemp(join(tmpdir(), "aw-alumni-badhome-"));
      dirs.push(home);
      const dir = join(home, "-w-proj");
      await mkdir(dir, { recursive: true });
      const id = "aaaaaaaa-3002-4000-8000-000000000000";
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      const deps: TrashDeps = { home, projectsDir: home, fs: realTrashFs, now: () => new Date(NOW) };
      const voided: string[][] = [];
      const voidLegacy = recordVoids(voided);

      await expect(retireSessions(deps, [item(id)], noGuard, writtenCard, voidLegacy)).rejects.toThrow(/resolves inside/);
      expect(voided).toEqual([[id]]);
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);
    });

    // Regression (round-2 review, finding 2): an append that raced past its own timeout is NOT a
    // certain "nothing was written" — the fd isn't cancelled, so the line can still land afterwards.
    // Before this fix, `toVoid` only ever looked at ids whose status was exactly "legacy card:
    // written", so an "unknown" (timed-out) status was never voided on a move failure, and a late
    // write could leave a phantom "retired" card with no compensating "voided" event.
    it("an 'unknown' (timed-out-but-maybe-landed) write is voided too on a move failure, not just a definite 'written'", async () => {
      const { deps } = await trashDeps();
      const id = "aaaaaaaa-3003-4000-8000-000000000000";
      const dir = join(deps.projectsDir, "-w-proj");
      await mkdir(dir, { recursive: true });
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      const busyFs: TrashFs = {
        ...realTrashFs,
        async rename(from, to) {
          if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
          return realTrashFs.rename(from, to);
        },
      };
      const unknownCard = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => new Map(ids.map((i) => [i, "legacy card: unknown (timed out writing alumni.jsonl)"]));
      const voided: string[][] = [];
      const voidLegacy = recordVoids(voided);

      const out = await retireSessions({ ...deps, fs: busyFs }, [item(id)], noGuard, unknownCard, voidLegacy);
      expect(out.results[0]).toMatchObject({ id, ok: false, error: expect.stringMatching(/EBUSY/), legacy: "legacy card: voided (not moved)" });
      expect(voided).toEqual([[id]]); // NOT skipped just because the status wasn't a certain "written"
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true); // it never left ~/.claude/projects
    });

    // A definite "not written" (no ambiguity: the write never even started) must still be left alone
    // — voiding it would be a needless extra event for a card that provably never existed.
    it("a definite 'not written' is never voided", async () => {
      const { deps } = await trashDeps();
      const id = "aaaaaaaa-3004-4000-8000-000000000000";
      const dir = join(deps.projectsDir, "-w-proj");
      await mkdir(dir, { recursive: true });
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      const busyFs: TrashFs = {
        ...realTrashFs,
        async rename(from, to) {
          if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
          return realTrashFs.rename(from, to);
        },
      };
      const notWrittenCard = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => new Map(ids.map((i) => [i, "legacy card: not written (alumni.jsonl is not a regular local file)"]));
      const voided: string[][] = [];
      const voidLegacy = recordVoids(voided);

      const out = await retireSessions({ ...deps, fs: busyFs }, [item(id)], noGuard, notWrittenCard, voidLegacy);
      expect(out.results[0]).toMatchObject({ id, ok: false, legacy: "legacy card: not written (alumni.jsonl is not a regular local file)" });
      expect(voided).toEqual([]);
    });

    // Regression (round-3 review): the label used to be "voided (not moved)" unconditionally, even
    // when the void never reached disk. It must now say what the voider actually did.
    it("says 'voided' only when the void is on disk: a queued, failed, throwing or missing voider each get an honest label", async () => {
      const { deps } = await trashDeps();
      const id = "aaaaaaaa-3005-4000-8000-000000000000";
      const dir = join(deps.projectsDir, "-w-proj");
      await mkdir(dir, { recursive: true });
      const old = new Date(NOW - 3 * DAY);
      await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "hi" })}\n`);
      await utimes(join(dir, `${id}.jsonl`), old, old);
      const busyFs: TrashFs = {
        ...realTrashFs,
        async rename(from, to) {
          if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
          return realTrashFs.rename(from, to);
        },
      };
      // The rename always fails, so the transcript never moves and the same id can be retried.
      const retire = async (voidLegacy?: LegacyVoider): Promise<string | undefined> => (await retireSessions({ ...deps, fs: busyFs }, [item(id)], noGuard, writtenCard, voidLegacy)).results[0]?.legacy;

      expect(await retire(async () => ({ state: "queued", reason: "timed out writing alumni.jsonl" }))).toBe("legacy card: void queued (not moved; timed out writing alumni.jsonl)");
      expect(await retire(async () => ({ state: "failed", reason: "alumni.jsonl is not a regular local file" }))).toBe("legacy card: void failed (alumni.jsonl is not a regular local file)");
      expect(
        await retire(async () => {
          throw new Error("EACCES: permission denied");
        }),
      ).toBe("legacy card: void failed (EACCES: permission denied)");
      expect(await retire(undefined)).toBe("legacy card: void failed (no voider wired)");
      expect(await retire(async () => ({ state: "written" }))).toBe("legacy card: voided (not moved)");
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);
    });
  });
});

describe("voidLegacy (real fs)", () => {
  it("reports 'failed', never 'written', when its line cannot be appended (alumni.jsonl swapped for a FIFO after the card)", async () => {
    const w = await makeWorld();
    const id = sid(30);
    const dataDir = join(w.dir, "data");
    const { writeLegacy, voidLegacy } = createAlumniFeature({ dataDir, sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const ctx = ctxFor(w, dataDir);
    expect((await writeLegacy(ctx, [id], "b1")).get(id)).toBe("legacy card: written");
    expect(await voidLegacy(ctx, [id], "b1")).toEqual({ state: "written" });

    const alumniPath = join(dataDir, "alumni.jsonl");
    await rm(alumniPath);
    execFileSync("mkfifo", [alumniPath]); // never opened: the stat guard refuses it first
    expect(await voidLegacy(ctx, [id], "b1")).toEqual({ state: "failed", reason: "alumni.jsonl is not a regular local file" });
  });
});

describe("HTTP: retire (real /api/cleanup/retire) → legacy card → restore → restored event", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function post<T>(base: string, path: string, body: unknown): Promise<{ status: number; json: T }> {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as T };
  }

  it("a real retire click writes a legacy card before the transcript moves; restoring it appends a restored event", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const id = "aaaaaaaa-3333-4000-8000-000000000000";
    const dir = join(projects, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "retire me" })}\n${assistantLine({ cwd: "/w/proj", timestamp: old.toISOString() })}\n`);
    await utimes(join(dir, `${id}.jsonl`), old, old);

    const { feature: cleanupFeat } = createCleanupFeature({ home, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature({ sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const features: readonly ServerFeature[] = [cleanupFeat, alumniFeat];
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, features } });
    server = booted.server;
    const base = booted.base;

    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const got: ServerMessage[] = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.on("open", () => r()));

    const retired = await post<RetireResult>(base, "/api/cleanup/retire", { ids: [id] });
    expect(retired.status).toBe(200);
    expect(retired.json.ok && retired.json.results[0]).toEqual({ id, ok: true, bytes: expect.any(Number), legacy: "legacy card: written" });
    ws.close();

    const alumniAfterRetire = (await (await fetch(`${base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumniAfterRetire.cards.map((c) => c.sessionId)).toEqual([id]);
    expect(alumniAfterRetire.cards[0]?.name).toBe("retire me");

    const trash = (await (await fetch(`${base}/api/cleanup/trash`)).json()) as { batches: { batchId: string }[] };
    const restored = await post<RestoreResult>(base, "/api/cleanup/restore", { batchId: trash.batches[0]?.batchId });
    expect(restored.status).toBe(200);

    const alumniAfterRestore = (await (await fetch(`${base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumniAfterRestore.cards).toEqual([]); // restored: no longer a current alumnus
  });

  it("a protected (live-guard) session is never retired and never gets a card", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const id = "aaaaaaaa-4444-4000-8000-000000000000";
    const dir = join(projects, "-w-proj");
    await mkdir(dir, { recursive: true });
    // Fresh mtime (< 30 min old): the live-guard refuses it on recent activity alone.
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: new Date().toISOString(), text: "still working" })}\n`);

    const { feature: cleanupFeat } = createCleanupFeature({ home, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature();
    const features: readonly ServerFeature[] = [cleanupFeat, alumniFeat];
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, features } });
    server = booted.server;

    const r = await post<RetireResult>(booted.base, "/api/cleanup/retire", { ids: [id] });
    expect(r.json.ok && r.json.results[0]?.error).toMatch(/protected/);
    expect(r.json.ok && r.json.results[0]?.legacy).toBeUndefined();

    const alumni = (await (await fetch(`${booted.base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumni.cards).toEqual([]);
  });

  it("a rename failure after the card was written never leaves a phantom Hall card for a session that never left ~/.claude/projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const id = "aaaaaaaa-5555-4000-8000-000000000000";
    const dir = join(projects, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "retire me but the rename fails" })}\n`);
    await utimes(join(dir, `${id}.jsonl`), old, old);

    const busyFs: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
        return realTrashFs.rename(from, to);
      },
    };
    const { feature: cleanupFeat } = createCleanupFeature({ home, fs: busyFs, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature({ sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, features: [cleanupFeat, alumniFeat] } });
    server = booted.server;

    const retired = await post<RetireResult>(booted.base, "/api/cleanup/retire", { ids: [id] });
    expect(retired.status).toBe(200);
    expect(retired.json.ok && retired.json.results[0]).toMatchObject({ id, ok: false, legacy: "legacy card: voided (not moved)" });
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true); // never left ~/.claude/projects

    const alumni = (await (await fetch(`${booted.base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumni.cards).toEqual([]); // no phantom card
  });

  it("alumni.jsonl replaced by a FIFO never blocks the real retire route: 5 sequential retires plus a GET, no release needed", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const projDir = join(projects, "-w-proj");
    await mkdir(projDir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    const ids = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-666${i}-4000-8000-000000000000`);
    for (const id of ids) {
      await writeFile(join(projDir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "retire me" })}\n`);
      await utimes(join(projDir, `${id}.jsonl`), old, old);
    }

    // cleanup.ts's retire route calls alumni.ts's module-level writeLegacy/voidLegacy directly (not
    // through a feature instance's own closures), and those resolve their data dir from
    // dirname(ctx.config.dbPath) — so the FIFO has to replace alumni.jsonl right there. Nothing here
    // ever opens it (for either read or write), so — unlike the round-1 fix's own FIFO test — there
    // is no reader/writer to release afterwards: a real open of this file would just hang forever.
    const dataDir = join(home, "data");
    await mkdir(dataDir, { recursive: true });
    const fifoPath = join(dataDir, "alumni.jsonl");
    execFileSync("mkfifo", [fifoPath]);

    const { feature: cleanupFeat } = createCleanupFeature({ home, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature({ sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, dbPath: join(dataDir, "world.db"), features: [cleanupFeat, alumniFeat] } });
    server = booted.server;

    const startedAt = Date.now();
    for (const id of ids) {
      const retired = await post<RetireResult>(booted.base, "/api/cleanup/retire", { ids: [id] });
      expect(retired.status).toBe(200);
      expect(retired.json.ok && retired.json.results[0]).toMatchObject({ id, ok: true });
      expect(retired.json.ok && retired.json.results[0]?.legacy).toBe("legacy card: not written (alumni.jsonl is not a regular local file)");
      expect(existsSync(join(projDir, `${id}.jsonl`))).toBe(false); // the retire itself still succeeded
    }
    const alumniRes = await fetch(`${booted.base}/api/alumni?range=all`);
    expect(alumniRes.status).toBe(503); // the same stat guard refuses the GET's own read too
    // Under the round-1 fix, retire #1 alone cost ~2s (a real timeout wait) and by #4 the thread pool
    // was exhausted and other routes stopped answering; here nothing was ever opened, so all 5
    // retires plus the GET together stay well under a second.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("HTTP: a write that times out but genuinely lands later is voided too, strictly after it", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    delayedAppend.armed = false;
    delayedRead.armed = false;
  });

  async function post<T>(base: string, path: string, body: unknown): Promise<{ status: number; json: T }> {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as T };
  }

  // Regression (round-2 review, finding 2): before this fix, a timed-out append was reported as a
  // certain "not written", and retireSessions only ever voided a "written" status — so when the
  // append actually completed afterwards (the fd was never cancelled), alumni.jsonl ended up with a
  // "retired" line and no compensating "voided" one: a phantom Hall card for a session that never
  // left ~/.claude/projects. This drives the real POST /api/cleanup/retire route end to end, with a
  // real (delayed, not stubbed) fs.appendFile and a real move failure, and reads the raw file
  // afterwards to prove the eventual write really lands, and lands strictly BEFORE its void.
  it("a card write slower than the timeout, whose move then fails, is voided once it lands — never a phantom 'retired' card", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const id = "aaaaaaaa-7777-4000-8000-000000000000";
    const dir = join(projects, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "retire me but slowly" })}\n`);
    await utimes(join(dir, `${id}.jsonl`), old, old);

    const dataDir = join(home, "data");
    await mkdir(dataDir, { recursive: true });
    const alumniPath = join(dataDir, "alumni.jsonl");
    delayedAppend.path = alumniPath;
    delayedAppend.ms = READ_TIMEOUT_MS + 400; // slower than the 2s budget, but a real write that DOES complete
    delayedAppend.armed = true;

    const busyFs: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
        return realTrashFs.rename(from, to);
      },
    };
    const { feature: cleanupFeat } = createCleanupFeature({ home, fs: busyFs, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature({ sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, dbPath: join(dataDir, "world.db"), features: [cleanupFeat, alumniFeat] } });
    server = booted.server;

    // Real timers throughout (no fake-timer race here): retireSessions' own `finally` block awaits
    // voidLegacy before it returns, and voidLegacy's append is chained onto the SAME path as the
    // card's — so by the time this resolves, both the late card write and its void have actually
    // settled on disk, in that order. This real wait is the delayed append's own ~2.4s.
    const retired = await post<RetireResult>(booted.base, "/api/cleanup/retire", { ids: [id] });
    expect(retired.status).toBe(200);
    expect(retired.json.ok && retired.json.results[0]).toMatchObject({ id, ok: false, legacy: "legacy card: voided (not moved)" });
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true); // the retire itself never completed either

    const lines = (await readFile(alumniPath, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string; sessionId: string }).kind);
    expect(kinds).toEqual(["retired", "voided"]); // the late card really lands, strictly BEFORE its own void

    const alumni = (await (await fetch(`${booted.base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumni.cards).toEqual([]); // no phantom card despite the card write landing well after the guard/move failed
  }, 10_000);

  // Regression (round-3 review): the test above only passes because alumni.jsonl does not exist
  // yet, so seeding the write state never actually reads anything. Here the file already exists and
  // this dbPath has never been written to since boot (a fresh seed that MUST read it). Before the
  // fix, writeState was only stored after a SUCCESSFUL append, so the timed-out card left it unset,
  // the void re-seeded by reading alumni.jsonl again, that read timed out, and the void threw before
  // ever joining the per-path append chain — while the response still claimed "voided (not moved)"
  // and the late card landed with no void after it: a permanent phantom Hall card.
  it("with alumni.jsonl already on disk, a slow card write + a failing rename + a slow read during the void still lands the void after the card", async () => {
    const home = await mkdtemp(join(tmpdir(), "aw-alumni-home-"));
    dirs.push(home);
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    const id = "aaaaaaaa-8888-4000-8000-000000000000";
    const earlier = "aaaaaaaa-8889-4000-8000-000000000000";
    const dir = join(projects, "-w-proj");
    await mkdir(dir, { recursive: true });
    const old = new Date(NOW - 3 * DAY);
    await writeFile(join(dir, `${id}.jsonl`), `${userLine({ cwd: "/w/proj", timestamp: old.toISOString(), text: "retire me, slowly, onto an existing file" })}\n`);
    await utimes(join(dir, `${id}.jsonl`), old, old);

    const dataDir = join(home, "data");
    await mkdir(dataDir, { recursive: true });
    const alumniPath = join(dataDir, "alumni.jsonl");
    await writeFile(alumniPath, `${JSON.stringify({ kind: "restored", sessionId: earlier, at: old.toISOString() })}\n`);
    delayedAppend.path = alumniPath;
    delayedAppend.ms = READ_TIMEOUT_MS + 400; // the card's append: slower than the budget, but it DOES land
    delayedAppend.armed = true;
    delayedRead.path = alumniPath;
    delayedRead.ms = READ_TIMEOUT_MS + 400;
    delayedRead.skip = 1; // the card's own seed read goes through; any later read (a void re-seeding) is too slow
    delayedRead.armed = true;

    const busyFs: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (from.endsWith(`${id}.jsonl`)) throw new Error("EBUSY: resource busy or locked");
        return realTrashFs.rename(from, to);
      },
    };
    const { feature: cleanupFeat } = createCleanupFeature({ home, fs: busyFs, tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined }, processCommands: () => [], pendingApprovals: () => new Set(), currentSessionIds: () => new Set(), reveal: async () => undefined });
    const { feature: alumniFeat } = createAlumniFeature({ sources: { outcomes: () => [], archive: () => null, tripwireHits: () => [], topics: () => null } });
    // A dbPath no test has written through yet: the module-level writer seeds its state from disk.
    const booted = await bootTestServer({ configOverrides: { projectsDir: projects, dbPath: join(dataDir, "world.db"), features: [cleanupFeat, alumniFeat] } });
    server = booted.server;

    const retired = await post<RetireResult>(booted.base, "/api/cleanup/retire", { ids: [id] });
    delayedRead.armed = false; // never let the probe outlive the retire it is about
    expect(retired.status).toBe(200);
    expect(retired.json.ok && retired.json.results[0]).toMatchObject({ id, ok: false, error: expect.stringMatching(/EBUSY/), legacy: "legacy card: voided (not moved)" });
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);

    const events = (await readFile(alumniPath, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; sessionId: string })
      .map((e) => `${e.kind}:${e.sessionId}`);
    expect(events).toEqual([`restored:${earlier}`, `retired:${id}`, `voided:${id}`]); // the void is on disk, strictly after the late card

    const alumni = (await (await fetch(`${booted.base}/api/alumni?range=all`)).json()) as AlumniResponse;
    expect(alumni.cards).toEqual([]);
  }, 15_000);
});
