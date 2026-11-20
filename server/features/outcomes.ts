// "outcomes" (agent-city piece 2): a verdict for every session, computed by code from evidence in
// its own transcript (outcomes-lib.ts has the fold and the precedence). No model call.
//
// Every 60s (onTick; never overlaps itself):
//   1. stat every session transcript on disk (subagents/scan.ts listSessionFiles);
//   2. read the ones dormant 10+ min (not live, mtime 10+ min old) whose size changed since the
//      last read, newest first, each from its persisted byte offset with its persisted partial
//      fold (pending ship commands included). At most 64 MB per tick, counting each finished
//      transcript's tail read (endings.ts readTailEnding) as its first 256 KB window. Lines that
//      can't change the fold are never JSON-parsed (mayCarryEvidence and outcomes-lib's own check).
//      A `gh pr merge <n>` that ran in a directory gets that directory's one GitHub repo from
//      `git -C <dir> remote -v` (execFile, argv only, 3s timeout; gitRepoOfDir), once per directory
//      per tick; a directory that isn't a checkout by then, or a fork's two repos, drops it. Its PR
//      is asked about like any other, and counts only if gh's mergedAt falls inside that call;
//   3. ask `gh pr view` about at most 10 PRs that are due (never asked, OPEN for 6h+, or gh failed
//      1h+ ago; MERGED and CLOSED are final), newest first. execFile with argv, no shell, 10s
//      timeout. A missing binary, an auth failure, a timeout or any odd answer is "unknown", which
//      can never make a session shipped;
//   4. recompute every verdict (some depend on the clock: abandoned after 24h, a cut-off turn
//      after 30 min), push the map over WS when it changed, and send a graduation to the Feed on
//      a transition into shipped / delivered whose evidence is under 24h old, never while the
//      first (cold) scan of an empty store runs.
//
// The only file written is data/outcomes.json next to world.db (versioned; written to a .tmp
// then renamed). An unreadable, malformed or older-version file means starting empty, except that a
// version-2 file keeps its MERGED / CLOSED PR states (outcomes-lib parseStore). Until that cold scan
// is done, GET /api/outcomes says so (scan.coldDone false) and the client claims no "none". Records are
// keyed by session id and outlive their transcript. world.db is only read (sessions' last-line
// state), never written. Transcripts are data: read, matched, never executed.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentTitle } from "../../shared/display.js";
import type { FeedItem } from "../../shared/features/feed.js";
import { emptyCounts, OUTCOMES_EXTRAS_KEY, type OutcomeRecord, type OutcomesMap, type OutcomesMessage, type OutcomesResponse, type OutcomesScan } from "../../shared/features/outcomes.js";
import type { SessionRow } from "../db.js";
import type { LastLineState } from "../heuristics.js";
import { respondJson } from "../http.js";
import { appendToFeed } from "./feed.js";
import {
  buildRecord,
  emptyStore,
  ghPrViewArgs,
  githubRepoOfRemotes,
  graduationTitle,
  newStoredSession,
  OutcomeFoldReader,
  outcomesMapOf,
  parseStore,
  placeMergesByDir,
  prCheckDue,
  prCheckFrom,
  prsToCheck,
  SETTLE_MS,
  shouldAnnounce,
  summaryOf,
  unreadLiveRecord,
  type GhResult,
  type StoredSession,
  type StoreFile,
} from "./outcomes-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { readTailEnding } from "./subagents/endings.js";
import { listSessionFiles } from "./subagents/scan.js";

const TICK_MS = 60_000;
export const MAX_BYTES_PER_TICK = 64 * 1024 * 1024;
export const MAX_GH_PER_TICK = 10;
const GH_TIMEOUT_MS = 10_000;
/** What a tail read is counted as (readTailEnding's first window). It is only done when the rest of
 *  the tick's budget covers it, so the budget must exceed it (64 MB does; tiny test budgets must
 *  be at least a transcript's size). */
const TAIL_COST = 256 * 1024;
const CHUNK = 1 << 20;
const NEWLINE = 0x0a;

export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; killed?: unknown };
  if (typeof e.code === "string") return e.code; // ENOENT: no gh binary
  if (e.killed === true) return "ETIMEDOUT";
  return "EXIT"; // gh ran and failed: unauthed, no such PR, offline
}

/** `gh pr view` through execFile: argv only, no shell, 10s timeout, no update check or prompt. */
export const execGh: GhRunner = (args) =>
  new Promise((done) => {
    execFile("gh", [...args], { timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" } }, (err, stdout) => {
      done(err ? { ok: false, code: errorCode(err) } : { ok: true, stdout: String(stdout) });
    });
  });

/** The one GitHub repo of the checkout holding `dir` (outcomes-lib githubRepoOfRemotes over
 *  `git -C <dir> remote -v`, as gh would see its remotes), or null. `dir` is transcript data: an
 *  absolute path passed as one argv entry, never through a shell. */
export function gitRepoOfDir(dir: string): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", ["-C", dir, "remote", "-v"], { timeout: 3_000, maxBuffer: 64 * 1024 }, (err, stdout) => done(err ? null : githubRepoOfRemotes(String(stdout))));
  });
}

export interface RangeRead {
  /** Offset just past the last complete line handed to `onLine`. */
  consumed: number;
  /** Offset just past the last byte read. */
  readTo: number;
  /** Still inside a line being skipped (see `skipping`). */
  skipping: boolean;
}

/**
 * Hands every complete line of `path` in [start, end) to `onLine`, reading 1 MB at a time. A
 * trailing partial line is left for the next read. With `skipping`, bytes up to and including the
 * first newline are discarded (the rest of a line too long to ever fit a tick's budget).
 */
export async function readLineRange(path: string, start: number, end: number, skipping: boolean, onLine: (raw: string) => void): Promise<RangeRead> {
  const fh = await open(path, "r");
  try {
    let pos = start;
    let consumed = start;
    let skip = skipping;
    const pieces: Buffer[] = []; // a partial line spanning chunks, joined once its newline shows up
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let s = 0;
      for (let nl = chunk.indexOf(NEWLINE, s); nl !== -1; nl = chunk.indexOf(NEWLINE, s)) {
        if (skip) {
          skip = false;
        } else {
          const line = pieces.length ? Buffer.concat([...pieces, chunk.subarray(s, nl)]) : chunk.subarray(s, nl);
          if (line.length) onLine(line.toString("utf8"));
        }
        pieces.length = 0;
        s = nl + 1;
        consumed = pos + s;
      }
      if (s < chunk.length && !skip) pieces.push(chunk.subarray(s));
      pos += bytesRead;
    }
    return { consumed, readTo: pos, skipping: skip };
  } finally {
    await fh.close();
  }
}

export interface OutcomesFeatureOptions {
  /** Where outcomes.json lives; defaults to the world.db directory. */
  dataDir?: string;
  now?: () => number;
  gh?: GhRunner;
  /** The GitHub repo of a directory a merge by number ran in; defaults to gitRepoOfDir. */
  repoOfDir?: (dir: string) => Promise<string | null>;
  /** Expands a `cd ~/…` before a merge by number; defaults to os.homedir(). */
  homeDir?: string;
  maxBytesPerTick?: number;
  maxGhPerTick?: number;
  settleMs?: number;
  tickIntervalMs?: number;
  /** Where graduations go; defaults to the live Feed (feed.ts appendToFeed). */
  feed?: (item: Omit<FeedItem, "seq">) => void;
}

/** The latest records of the running feature, one per session (careers-registry reads these). */
let latest: readonly OutcomeRecord[] = [];
export function latestOutcomeRecords(): readonly OutcomeRecord[] {
  return latest;
}

/** The store's scan.coldDone as of the latest records (false before the store is loaded): until
 *  it is true, a session may be unread or its PRs unasked (the vision ledger's crews probe). */
let latestColdDone = false;
export function latestOutcomesColdDone(): boolean {
  return latestColdDone;
}

interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function lastLineOf(row: SessionRow | undefined): LastLineState | null {
  return row ? { kind: row.lastLineKind, toolName: row.lastToolName, textIsQuestion: row.lastTextIsQuestion } : null;
}

export function createOutcomesFeature(opts: OutcomesFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const gh = opts.gh ?? execGh;
  const repoOfDir = opts.repoOfDir ?? gitRepoOfDir;
  const homeDir = opts.homeDir ?? homedir();
  const maxBytes = opts.maxBytesPerTick ?? MAX_BYTES_PER_TICK;
  const maxGh = opts.maxGhPerTick ?? MAX_GH_PER_TICK;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const feed = opts.feed ?? appendToFeed;

  let store: StoreFile | null = null;
  let records = new Map<string, OutcomeRecord>();
  let mapJson = "{}";
  let map: OutcomesMap = {};
  let pendingSessions = 0;
  let pendingPrChecks = 0;
  let ghStatus: OutcomesScan["gh"] = "untried";
  let lastTick: OutcomesScan["lastTick"] = null;

  const dataPath = (ctx: FeatureContext): string => join(opts.dataDir ?? dirname(ctx.config.dbPath), "outcomes.json");

  function setRecords(next: Map<string, OutcomeRecord>): void {
    records = next;
    latest = [...next.values()];
    latestColdDone = store?.coldDone ?? false;
    map = outcomesMapOf(next.values());
  }

  /** Sync on purpose: snapshotExtras is sync, and the first snapshot should carry the persisted
   *  verdicts. Until the first tick, liveness is unknown: records read as dormant. */
  function load(ctx: FeatureContext): StoreFile {
    if (store) return store;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(dataPath(ctx), "utf8")) as unknown;
    } catch {
      /* first run, or unreadable: start empty */
    }
    const st = parseStore(raw) ?? emptyStore();
    store = st;
    const rows = new Map(ctx.db.listSessions().map((r) => [r.id, r]));
    const nowMs = now();
    const next = new Map<string, OutcomeRecord>();
    for (const [id, s] of Object.entries(st.sessions)) {
      next.set(id, buildRecord(id, s, st.prs, { live: false, nowMs, file: s.onDisk ? { size: s.readSize, mtimeMs: s.mtimeMs } : null, lastLine: lastLineOf(rows.get(id)) }));
    }
    setRecords(next);
    mapJson = JSON.stringify(map);
    return st;
  }

  async function persist(ctx: FeatureContext, st: StoreFile): Promise<void> {
    const path = dataPath(ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(st), "utf8");
    await rename(`${path}.tmp`, path);
  }

  /** Reads new transcript bytes within the budget. Returns [bytes read, sessions read]. */
  async function readTranscripts(st: StoreFile, work: ReadonlyArray<[string, TranscriptFile]>): Promise<[number, number]> {
    let budget = maxBytes;
    let bytes = 0;
    let sessions = 0;
    const dirRepos = new Map<string, Promise<string | null>>();
    for (const [id, f] of work) {
      if (budget <= 0) break;
      const prev = st.sessions[id];
      // A transcript shorter than what was read was rewritten: fold it again from the start.
      const s: StoredSession = prev && f.size >= prev.fold.offset ? prev : { ...newStoredSession(), last: prev?.last ?? null, announced: prev?.announced ?? [] };
      const start = s.fold.offset;
      const reader = new OutcomeFoldReader(s.fold, homeDir);
      const fallbackAt = new Date(f.mtimeMs).toISOString();
      let r: RangeRead;
      try {
        r = await readLineRange(f.path, start, Math.min(f.size, start + budget), s.fold.skipping, (raw) => reader.line(raw, fallbackAt));
      } catch {
        continue; // deleted or unreadable mid-read: tried again next tick
      }
      budget -= r.readTo - start;
      bytes += r.readTo - start;
      let offset = r.consumed;
      let skipping = r.skipping;
      if (skipping) offset = r.readTo;
      else if (r.consumed === start && r.readTo - start >= maxBytes) {
        offset = r.readTo; // one line longer than a whole tick's budget: skipped, never parsed
        skipping = true;
      }
      s.fold = reader.finish(offset, skipping);
      if (s.fold.mergesByDir.length > 0) {
        const repos = new Map<string, string | null>();
        for (const dir of new Set(s.fold.mergesByDir.map((m) => m.dir))) {
          let repo = dirRepos.get(dir);
          if (!repo) dirRepos.set(dir, (repo = repoOfDir(dir).catch(() => null)));
          repos.set(dir, await repo);
        }
        s.fold = placeMergesByDir(s.fold, repos);
      }
      const tailCost = Math.min(f.size, TAIL_COST);
      if (r.readTo >= f.size && budget >= tailCost) {
        try {
          s.ending = await readTailEnding(f.path, f.size);
        } catch {
          s.ending = null;
        }
        budget -= tailCost;
        bytes += tailCost;
        s.readSize = f.size;
      }
      s.mtimeMs = f.mtimeMs;
      s.onDisk = true;
      st.sessions[id] = s;
      sessions += 1;
    }
    return [bytes, sessions];
  }

  /** Asks gh about the due PRs, newest first, at most `maxGh` calls. Returns the calls made and
   *  the PR states recorded (a PR that isn't a plain owner/repo#n is recorded unknown, no call). */
  async function checkPrs(st: StoreFile, nowMs: number): Promise<{ calls: number; done: number }> {
    const due = new Map<string, { repo: string; number: number; at: string }>();
    for (const s of Object.values(st.sessions)) {
      for (const p of prsToCheck(s.fold)) {
        const key = `${p.repo}#${p.number}`;
        const seen = due.get(key);
        if (prCheckDue(st.prs[key], nowMs) && (!seen || p.at > seen.at)) due.set(key, p);
      }
    }
    const queue = [...due].sort((a, b) => (b[1].at > a[1].at ? 1 : b[1].at < a[1].at ? -1 : 0));
    let calls = 0;
    let done = 0;
    let anyOk = false;
    let anyFailed = false;
    for (const [key, p] of queue) {
      if (calls >= maxGh) break;
      const args = ghPrViewArgs(p.repo, p.number);
      let result: GhResult = { ok: false, code: "EINVAL" }; // not a plain owner/repo#n: gh is never called
      if (args) {
        calls += 1;
        result = await gh(args);
      }
      const check = prCheckFrom(result, new Date(now()).toISOString());
      st.prs[key] = check;
      done += 1;
      if (args && check.state !== "unknown") anyOk = true;
      if (args && check.state === "unknown") anyFailed = true;
      if (!result.ok && (result.code === "ENOENT" || result.code === "ETIMEDOUT")) break; // no gh, or offline: stop for this tick
    }
    if (anyOk) ghStatus = "ok";
    else if (anyFailed) ghStatus = "unavailable";
    pendingPrChecks = due.size - done;
    return { calls, done };
  }

  async function tick(ctx: FeatureContext): Promise<void> {
    const st = load(ctx);
    const nowMs = now();
    const cold = !st.coldDone;
    const views = ctx.worldViews();
    const agents = new Map(views.agents.map((a) => [a.id, a]));
    const live = new Set(views.agents.filter((a) => a.status === "live").map((a) => a.id));

    const files = new Map<string, TranscriptFile>();
    for (const f of await listSessionFiles(ctx.config.projectsDir)) {
      try {
        const s = await stat(f.path);
        files.set(f.sessionId, { path: f.path, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* deleted mid-scan */
      }
    }
    let dirty = false;
    for (const [id, s] of Object.entries(st.sessions)) {
      if (s.onDisk !== files.has(id)) dirty = true;
      s.onDisk = files.has(id);
    }

    const settled = (id: string, f: TranscriptFile): boolean => !live.has(id) && nowMs - f.mtimeMs >= settleMs;
    const work = [...files].filter(([id, f]) => settled(id, f) && st.sessions[id]?.readSize !== f.size).sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
    const [bytesRead, sessionsRead] = await readTranscripts(st, work);
    const { calls: ghCalls, done: prsChecked } = await checkPrs(st, nowMs);
    if (sessionsRead > 0 || prsChecked > 0) dirty = true;
    pendingSessions = [...files].filter(([id, f]) => settled(id, f) && st.sessions[id]?.readSize !== f.size).length;

    const rows = new Map(ctx.db.listSessions().map((r) => [r.id, r]));
    const next = new Map<string, OutcomeRecord>();
    const iso = new Date(nowMs).toISOString();
    for (const [id, s] of Object.entries(st.sessions)) {
      const f = files.get(id);
      const rec = buildRecord(id, s, st.prs, { live: live.has(id), nowMs, file: f ? { size: f.size, mtimeMs: f.mtimeMs } : null, lastLine: lastLineOf(rows.get(id)) });
      next.set(id, rec);
      if (rec.outcome === s.last) continue;
      const o = rec.outcome;
      if ((o === "shipped" || o === "delivered") && shouldAnnounce({ prev: s.last, next: o, evidenceAt: rec.evidenceAt, announced: s.announced, cold, nowMs })) {
        const agent = agents.get(id);
        const pushes = [...s.fold.pushes].sort((a, b) => (b.at > a.at ? 1 : -1));
        feed({ id: `grad:${id}:${o}`, at: rec.evidenceAt ?? iso, kind: "graduation", agentId: id, title: graduationTitle(agent ? agentTitle(agent) : "A session", o, rec.prs, pushes), detail: rec.reason, tag: o });
        s.announced.push(o);
      }
      s.last = o;
      dirty = true;
    }
    for (const id of live) if (!next.has(id)) next.set(id, unreadLiveRecord(id, agents.get(id)?.lastActive ?? iso));

    const everyPr = new Set(Object.values(st.sessions).flatMap((s) => prsToCheck(s.fold).map((p) => `${p.repo}#${p.number}`)));
    st.ticks += 1;
    if (!st.coldDone && pendingSessions === 0 && [...everyPr].every((k) => st.prs[k])) {
      st.coldDone = true;
      st.coldTicks = st.ticks;
      dirty = true;
      ctx.log.info("outcomes", `cold scan done in ${st.ticks} ticks`, { sessions: next.size });
    }
    lastTick = { at: iso, bytesRead, sessionsRead, ghCalls };

    setRecords(next);
    const json = JSON.stringify(map);
    if (json !== mapJson) {
      mapJson = json;
      ctx.emit({ kind: "map", map } satisfies OutcomesMessage);
    }
    if (dirty) await persist(ctx, st);
  }

  function scanOf(st: StoreFile): OutcomesScan {
    return { ticks: st.ticks, coldDone: st.coldDone, coldTicks: st.coldTicks, pendingSessions, pendingPrChecks, lastTick, gh: ghStatus };
  }

  return {
    id: "outcomes",
    tickIntervalMs: opts.tickIntervalMs ?? TICK_MS,
    onTick: tick,
    snapshotExtras(ctx) {
      load(ctx);
      return { [OUTCOMES_EXTRAS_KEY]: map };
    },
    routes: [
      {
        method: "GET",
        path: "/api/outcomes",
        handler(_req, res, ctx) {
          const st = load(ctx);
          const list = [...records.values()].sort((a, b) => (b.lastActive > a.lastActive ? 1 : b.lastActive < a.lastActive ? -1 : 0));
          const counts = emptyCounts();
          for (const r of list) counts[r.outcome] += 1;
          respondJson(res, 200, { ok: true, outcomes: list.map(summaryOf), counts, scan: scanOf(st) } satisfies OutcomesResponse);
        },
      },
      {
        method: "GET",
        path: "/api/outcomes/:agentId",
        handler(_req, res, ctx, params) {
          load(ctx);
          const rec = records.get(params.agentId ?? "");
          if (!rec) return respondJson(res, 404, { ok: false, error: "no outcome record for this session" });
          respondJson(res, 200, rec);
        },
      },
    ],
  };
}

export const outcomesFeature: ServerFeature = createOutcomesFeature();
