// "alumni" (agent-city piece 6, the 🎓 Hall): a legacy card for every session Alex retires,
// plus a read-only view of the fleet's own history (shipped/delivered sessions by repo, research
// sessions with something to show). No model call anywhere.
//
// data/alumni.jsonl is append-only and the only file this feature writes. writeLegacy() is called
// from cleanup.ts's retire route (through cleanup-trash.ts's retireSessions), right after its own
// live-guard has passed for a batch and before the first rename — the same "record before the
// irreversible part" order the trash manifest itself uses. A legacy write NEVER blocks or widens
// what retire moves: on any error (EACCES, a missing dir, …) it is caught here, retire proceeds
// unaffected, and the response says per session what happened to its card (RetireItemResult.legacy
// in shared/features/cleanup.ts lists every status). Restoring a batch appends a "restored" event
// for each id that came back (cleanup.ts's restore route); the file is never rewritten, so retiring
// that session again later still gets its own new card. The card is written before every guard in
// retireSessions has run, not just the first one — a late guard refusal, a rename failure or a
// throw further down can still stop the move after the card exists. voidLegacy() is retireSessions'
// compensating call for exactly that: it appends a "voided" event for any id whose card was written
// but whose move did not complete, which currentAlumni() folds like "restored" — the Hall never
// shows a session that never actually left ~/.claude/projects, unless that void itself fails (the
// retire response then says "void failed", never "voided"). cleanup-trash.ts voids on ANY move
// failure whenever writeLegacy's own status wasn't a clean, certain "not written" (i.e. "written"
// or the ambiguous "unknown" below): a void with no matching card is harmless in currentAlumni(),
// and a card that lands late must still get its compensating event.
//
// Every read/write this feature does is guarded, never just raced: stat() first (archive.ts's
// isDataless, and a plain !isFile() check) refuses a FIFO or an evicted iCloud placeholder before
// ever calling open() on it, so a stuck legacy.jsonl NEVER pins a libuv thread-pool slot in the first
// place — a bounded race (archive.ts's withTimeout) only remains as a second line of defence for a
// regular file that hangs for some other reason. Reads copy NoteCache's own "stalled" pattern on top
// of that: one read timeout marks the path stalled and every later READ refuses it outright, without
// opening it again, until the original pending read actually settles. Appends get the same "one real
// open in flight" guarantee from their own per-path promise chain instead, which a "stalled" refusal
// would otherwise defeat: a compensating voidLegacy write must still be able to queue up behind a
// writeLegacy write that is still in flight, not be turned away because that same write just timed
// out. The only read a write ever does is the lazy seed of the generation/line count (countLines,
// which IS gated and timed) on the first append for a dbPath since boot; appendEvents stores that
// seed BEFORE the append starts, so no later append (above all a compensating void) ever reads again,
// and none can time out or meet the "stalled" gate before joining the chain. (A seed that fails is
// not stored, but then no card was appended either, so there is nothing to void. A stat() refusal or
// a mkdir failure can still stop a void before the chain; voidLegacy then reports "failed".) A write
// that DOES time out is ambiguous, not a clean failure — the fd isn't cancelled, so it can still land
// afterwards — so writeLegacy reports it as "unknown" rather than "not written". Its lines are NOT
// counted toward rotation (only a confirmed write moves the count, see appendEvents), so the
// compensating void goes to the card's own generation file, on the same per-path chain, and the
// chain guarantees a late-landing card is fully on disk before the void's write is even attempted.
// A void only goes to the next generation file once confirmed writes have already filled the card's,
// and GET folds that file after the card's. voidLegacy says whether its line is written, still queued
// or failed, and cleanup-trash.ts labels each result from that, never from the attempt alone.
//
// Inputs, all read-only and already in memory (the same three sources careers-registry composes,
// plus tripwires and topics):
//   - ctx.worldViews().agents / .islands: indexed (live + dormant) sessions and their cities;
//   - outcomes.ts latestOutcomeRecords(): each session's verdict, PRs, artifacts, learnings;
//   - archive.ts latestArchivedSessions(): a retired id's vault note, when the archive knows it;
//   - tripwires.ts recentTripwireHits(): which lessons a session repeated;
//   - topics.ts latestTopicsMap(): the RESEARCH topic group, for the Research library;
//   - the usage store (usage-store.ts), read directly: an est. API-equivalent cost per session.
//
// At ALUMNI_ROTATE_AT lines a new generation file starts (alumni.jsonl, then alumni.1.jsonl, …);
// GET reads every generation in order and folds the whole stream with currentAlumni().

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentTitle } from "../../shared/display.js";
import {
  ALUMNI_RANGES,
  DEFAULT_ALUMNI_RANGE,
  type AlumniEvent,
  type AlumniRange,
  type AlumniResponse,
  type EngineeringRepo,
  type HallSession,
  type LegacyCard,
} from "../../shared/features/alumni.js";
import type { ArchivedSession } from "../../shared/features/archive.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { TopicsMap } from "../../shared/features/topics.js";
import type { TripwireHit } from "../../shared/features/tripwires.js";
import { costForModel } from "../../shared/features/usage.js";
import type { WorldAgent } from "../../shared/types.js";
import { ccDisplayName } from "../cc-titles-lib.js";
import { respondJson } from "../http.js";
import { isDataless, latestArchivedSessions, READ_TIMEOUT_MS, TIMED_OUT, withTimeout } from "./archive.js";
import type { LegacyVoidOutcome } from "./cleanup-trash.js";
import { latestOutcomeRecords } from "./outcomes.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { latestTopicsMap } from "./topics.js";
import { recentTripwireHits } from "./tripwires.js";
import { UsageStore, usageStorePathFor } from "./usage-store.js";

/** Lines kept in one alumni file before a new generation starts. */
export const ALUMNI_ROTATE_AT = 20_000;
const RESEARCH_GROUP = "RESEARCH";

export interface AlumniSources {
  outcomes(): readonly OutcomeRecord[];
  /** Null until the archive has built its list once (careers.ts's own CareersSources does the same). */
  archive(): readonly ArchivedSession[] | null;
  tripwireHits(): readonly TripwireHit[];
  /** Null until the topics feature has computed a map once. */
  topics(): TopicsMap | null;
}

export interface AlumniFeatureOptions {
  /** Where alumni.jsonl (and its rotations) live; defaults to the world.db directory. */
  dataDir?: string;
  now?: () => number;
  /** Lines per generation file; defaults to ALUMNI_ROTATE_AT. Small in tests, to exercise rotation. */
  rotateAt?: number;
  sources?: Partial<AlumniSources>;
  /** Est. API-equivalent USD for a session; overridable so tests never need a real usage db. */
  costUsdOf?: (ctx: FeatureContext, sessionId: string) => number | null;
}

export function alumniFileName(gen: number): string {
  return gen === 0 ? "alumni.jsonl" : `alumni.${gen}.jsonl`;
}

/** Thrown only when appendEvents' own fs.appendFile raced past the timeout budget without settling.
 *  Unlike every other appendEvents failure (a refused non-regular file, a stalled path, a mkdir
 *  failure, …), the write itself is NOT cancelled and may still land on disk afterwards — so the
 *  caller must treat the outcome as unknown, not as "nothing was written". */
export class AmbiguousWriteError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Defensive parse of one alumni.jsonl line (server's own file, but never trusted blindly — a
 *  hand-edited or truncated line is skipped, never thrown on, same idiom as cleanup-lib's
 *  parseManifest). */
export function parseAlumniLine(raw: string): AlumniEvent | null {
  const line = raw.trim();
  if (!line) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.sessionId !== "string") return null;
  if (v.kind === "restored") return typeof v.at === "string" ? (v as AlumniEvent) : null;
  if (v.kind === "voided") return typeof v.at === "string" && typeof v.trashBatch === "string" ? (v as AlumniEvent) : null;
  if (v.kind !== "retired") return null;
  const ok =
    typeof v.name === "string" &&
    typeof v.city === "string" &&
    typeof v.startedAt === "string" &&
    typeof v.lastActive === "string" &&
    typeof v.outcome === "string" &&
    (v.reason === null || typeof v.reason === "string") &&
    Array.isArray(v.prs) &&
    isStringArray(v.artifacts) &&
    isStringArray(v.learnings) &&
    (v.costUsd === null || typeof v.costUsd === "number") &&
    isStringArray(v.tripwireLessons) &&
    (v.vaultNote === null || typeof v.vaultNote === "string") &&
    typeof v.retiredAt === "string" &&
    typeof v.trashBatch === "string";
  return ok ? (v as AlumniEvent) : null;
}

/** Folds the whole event stream (oldest to newest) to the sessions CURRENTLY retired: one whose
 *  last event is "restored" is not an alumnus any more; one retired again after a restore is,
 *  with its newest card. A "voided" last event (retireSessions' move failed after the card was
 *  already written) is excluded the same way "restored" is — the session was never actually moved. */
export function currentAlumni(events: readonly AlumniEvent[]): LegacyCard[] {
  const last = new Map<string, AlumniEvent>();
  for (const e of events) last.set(e.sessionId, e);
  const out: LegacyCard[] = [];
  for (const e of last.values()) if (e.kind === "retired") out.push(e);
  return out;
}

export function inRange(iso: string, range: AlumniRange, nowMs: number): boolean {
  if (range === "all") return true;
  const days = range === "week" ? 7 : 30;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || t >= nowMs - days * 86_400_000;
}

function toHallSession(a: Pick<WorldAgent, "id" | "title" | "displayName" | "lastActive">, rec: OutcomeRecord): HallSession {
  return {
    sessionId: a.id,
    name: agentTitle(a),
    outcome: rec.outcome,
    reason: rec.reason,
    lastActive: rec.lastActive || a.lastActive,
    prs: rec.prs,
    artifacts: rec.artifacts,
    learnings: rec.learnings,
  };
}

export function buildEngineeringBay(agents: readonly WorldAgent[], islandNames: ReadonlyMap<string, string>, outcomesById: ReadonlyMap<string, OutcomeRecord>, range: AlumniRange, nowMs: number): EngineeringRepo[] {
  const byRepo = new Map<string, HallSession[]>();
  for (const a of agents) {
    const rec = outcomesById.get(a.id);
    if (!rec || (rec.outcome !== "shipped" && rec.outcome !== "delivered")) continue;
    if (!inRange(rec.evidenceAt ?? rec.lastActive, range, nowMs)) continue;
    const repo = islandNames.get(a.islandId) ?? a.islandId;
    const list = byRepo.get(repo) ?? [];
    list.push(toHallSession(a, rec));
    byRepo.set(repo, list);
  }
  return [...byRepo.entries()]
    .map(([repo, sessions]) => ({ repo, sessions: sessions.sort((x, y) => y.lastActive.localeCompare(x.lastActive)) }))
    .sort((x, y) => y.sessions.length - x.sessions.length || x.repo.localeCompare(y.repo));
}

export function buildResearchLibrary(agents: readonly WorldAgent[], outcomesById: ReadonlyMap<string, OutcomeRecord>, topics: TopicsMap | null, range: AlumniRange, nowMs: number): HallSession[] {
  if (!topics) return [];
  const out: HallSession[] = [];
  for (const a of agents) {
    if (topics.sessions[a.id]?.group !== RESEARCH_GROUP) continue;
    const rec = outcomesById.get(a.id);
    if (!rec || (rec.artifacts.length === 0 && rec.learnings.length === 0)) continue;
    if (!inRange(rec.lastActive, range, nowMs)) continue;
    out.push(toHallSession(a, rec));
  }
  return out.sort((x, y) => y.lastActive.localeCompare(x.lastActive));
}

const usageStores = new Map<string, UsageStore>();
function usageStoreFor(dbPath: string): UsageStore {
  let s = usageStores.get(dbPath);
  if (!s) {
    s = new UsageStore(usageStorePathFor(dbPath));
    usageStores.set(dbPath, s);
  }
  return s;
}

/** Est. API-equivalent USD summed over every model a session used; null when the usage store has
 *  no rows for it at all (never a guessed 0). Never throws: an unreadable/missing store reads as null. */
function defaultCostUsdOf(ctx: FeatureContext, sessionId: string): number | null {
  try {
    const mix = usageStoreFor(ctx.config.dbPath).sessionModelMix(sessionId);
    if (mix.size === 0) return null;
    let total = 0;
    for (const [model, tokens] of mix) total += costForModel(model, tokens).costUsd ?? 0;
    return total;
  } catch {
    return null;
  }
}

export function createAlumniFeature(opts: AlumniFeatureOptions = {}): {
  feature: ServerFeature;
  /** Called by cleanup.ts's retire route once its live-guard has passed for `ids`, before the
   *  first file is moved. Never throws; every id gets "legacy card: written",
   *  "legacy card: unknown (<reason>)" (timed out, may still land) or "legacy card: not written (<reason>)". */
  writeLegacy(ctx: FeatureContext, ids: readonly string[], trashBatch: string): Promise<ReadonlyMap<string, string>>;
  /** Called by cleanup.ts's restore route for every id it actually restored. Never throws. */
  restoreLegacy(ctx: FeatureContext, ids: readonly string[]): Promise<void>;
  /** Called by cleanup-trash.ts's retireSessions for ids whose card was (or may still be) written
   *  but whose move did not complete. Never throws; reports whether the void is on disk. */
  voidLegacy(ctx: FeatureContext, ids: readonly string[], trashBatch: string): Promise<LegacyVoidOutcome>;
} {
  const now = opts.now ?? Date.now;
  const rotateAt = Math.max(1, opts.rotateAt ?? ALUMNI_ROTATE_AT);
  const sources: AlumniSources = {
    outcomes: opts.sources?.outcomes ?? latestOutcomeRecords,
    archive: opts.sources?.archive ?? latestArchivedSessions,
    tripwireHits: opts.sources?.tripwireHits ?? recentTripwireHits,
    topics: opts.sources?.topics ?? latestTopicsMap,
  };
  const costUsdOf = opts.costUsdOf ?? defaultCostUsdOf;

  const dataPath = (ctx: FeatureContext, gen: number): string => join(opts.dataDir ?? dirname(ctx.config.dbPath), alumniFileName(gen));

  /** Paths whose most recent READ timed out and has not settled yet: refused outright (never
   *  reopened for reading) until that pending read actually resolves or rejects — NoteCache's "one
   *  fd at most" pattern (archive.ts), so a stuck file leaks at most one thread-pool slot total, not
   *  one per attempt. Appends themselves are deliberately NOT gated on this (see appendToPath): they
   *  already get the equivalent guarantee from their own promise chain, which a "stalled" refusal
   *  would instead BREAK — a compensating voidLegacy write must still be able to queue up behind a
   *  writeLegacy write that is still in flight, not be refused because that same write just timed
   *  out. The one gated read on the write side is the first-append seed, and appendEvents stores
   *  its result before appending, so a void never reaches this gate. */
  const stalled = new Set<string>();

  function markStalled(path: string, pending: Promise<unknown>): void {
    stalled.add(path);
    pending.then(
      () => stalled.delete(path),
      () => stalled.delete(path),
    );
  }

  /** Never blocks: stat() (unlike open()) returns immediately even for a FIFO with no reader/writer
   *  or an evicted iCloud placeholder. Returns false when there is no file yet (ENOENT or any other
   *  stat failure — read as "nothing written yet", same as before this guard existed) and throws when
   *  the path exists but is unsafe to open at all (not a regular file, or dataless). Shared by reads
   *  and writes; the "stalled" read-only gate above is checked separately by each read call site. */
  async function guardPath(path: string): Promise<boolean> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch {
      return false;
    }
    if (!st.isFile() || isDataless(st)) throw new Error(`${basename(path)} is not a regular local file`);
    return true;
  }

  /** A missing file is 0 lines. Never opens a FIFO/dataless/stalled path; a read that still hangs on
   *  an otherwise-ordinary file races the same ~2s budget archive.ts's own note reads use, and marks
   *  the path stalled instead of leaving it open forever. */
  async function countLines(path: string): Promise<number> {
    if (stalled.has(path)) throw new Error(`${basename(path)} stalled`);
    if (!(await guardPath(path))) return 0;
    const pending = readFile(path, "utf8");
    const raced = await withTimeout(pending.catch(() => null), READ_TIMEOUT_MS);
    if (raced === TIMED_OUT) {
      markStalled(path, pending);
      throw new Error(`timed out reading ${basename(path)}`);
    }
    return raced === null ? 0 : raced.split("\n").filter((l) => l.trim().length > 0).length;
  }

  /** gen/line-count new writes should go to, per data dir. Lazily seeded by counting existing
   *  generations on first use: restart-safe, no separate counter file to drift from the real one. */
  const writeState = new Map<string, { gen: number; lines: number }>();

  async function seedWriteState(ctx: FeatureContext): Promise<{ gen: number; lines: number }> {
    let gen = 0;
    let lines = await countLines(dataPath(ctx, gen));
    while (lines >= rotateAt) {
      gen += 1;
      lines = await countLines(dataPath(ctx, gen));
    }
    return { gen, lines };
  }

  /** One promise chain per path: a call's real fs.appendFile is never even started before the
   *  previous call's real write to that path has actually settled (not just raced against its own
   *  timeout). Without this, a writeLegacy append that times out from its caller's point of view but
   *  is still in flight could land in the file AFTER a later voidLegacy call meant to compensate for
   *  it, undoing the void the moment it finally lands. This chaining is also what makes it safe for
   *  the append itself to never consult the read-only "stalled" gate above: at most one real open-
   *  for-write is ever in flight per path regardless of how many logical appends pile up, so a second
   *  append is naturally queued behind the first rather than needing to be refused outright. */
  const appendChains = new Map<string, Promise<void>>();

  async function appendToPath(path: string, text: string): Promise<void> {
    const prevTail = appendChains.get(path) ?? Promise.resolve();
    const real: Promise<void> = prevTail.then(
      () => appendFile(path, text, { encoding: "utf8", mode: 0o600 }),
      () => appendFile(path, text, { encoding: "utf8", mode: 0o600 }),
    );
    appendChains.set(
      path,
      real.then(
        () => undefined,
        () => undefined,
      ),
    );
    const wrote = await withTimeout(real, READ_TIMEOUT_MS);
    if (wrote === TIMED_OUT) throw new AmbiguousWriteError(`timed out writing ${basename(path)}`);
  }

  async function appendEvents(ctx: FeatureContext, events: readonly AlumniEvent[]): Promise<void> {
    const key = ctx.config.dbPath;
    // Stored the moment it is seeded, BEFORE any append starts: the seed is the only read a write
    // ever does, and a later append to this dbPath (voidLegacy's compensating one above all) must
    // never repeat it — a second read could time out or hit the "stalled" gate and throw before
    // that append ever joined the per-path chain behind the card it exists to void.
    const seeded = writeState.get(key) ?? (await seedWriteState(ctx));
    writeState.set(key, seeded);
    const state = seeded.lines >= rotateAt ? { gen: seeded.gen + 1, lines: 0 } : seeded;
    const path = dataPath(ctx, state.gen);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Never opens a FIFO/dataless path for writing either (a FIFO blocks on open for write exactly
    // as it does for read). `false` just means "no file yet", which appendFile creates fine.
    await guardPath(path);
    const text = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await appendToPath(path, text);
    // Only a confirmed write moves the count. A timed-out one (AmbiguousWriteError, thrown above) is
    // never counted: if it lands after all, this generation just runs past rotateAt, and a restart
    // re-seeds from the real lines. Counting it and then having it NOT land would rotate early, and a
    // restart's re-seed would append to that short generation again, folding new events BEFORE older
    // ones already in the next file. Not counting it also keeps the compensating void in the card's
    // own generation, on the same per-path chain.
    writeState.set(key, { gen: state.gen, lines: state.lines + events.length });
  }

  /** Reads every generation in order. `ok: false` (a refused non-regular file, a stalled path, or a
   *  read that timed out) stops at that generation instead of hanging GET /api/alumni — the route
   *  answers 503 rather than folding a partial or stale event stream into cards. */
  async function readAllEvents(ctx: FeatureContext): Promise<{ events: AlumniEvent[]; ok: boolean }> {
    const events: AlumniEvent[] = [];
    for (let gen = 0; ; gen++) {
      const path = dataPath(ctx, gen);
      if (stalled.has(path)) {
        ctx.log.warn("alumni", `couldn't read ${alumniFileName(gen)}`, `${basename(path)} stalled`);
        return { events, ok: false };
      }
      let safe: boolean;
      try {
        safe = await guardPath(path);
      } catch (err) {
        ctx.log.warn("alumni", `couldn't read ${alumniFileName(gen)}`, err instanceof Error ? err.message : String(err));
        return { events, ok: false };
      }
      if (!safe) break; // no more generations
      const pending = readFile(path, "utf8");
      const raced = await withTimeout(pending, READ_TIMEOUT_MS);
      if (raced === TIMED_OUT) {
        markStalled(path, pending);
        ctx.log.warn("alumni", `couldn't read ${alumniFileName(gen)}`, `timed out reading ${basename(path)}`);
        return { events, ok: false };
      }
      for (const raw of raced.split("\n")) {
        const e = parseAlumniLine(raw);
        if (e) events.push(e);
      }
    }
    return { events, ok: true };
  }

  function buildCard(ctx: FeatureContext, islandNames: ReadonlyMap<string, string>, outcomesById: ReadonlyMap<string, OutcomeRecord>, archiveById: ReadonlyMap<string, ArchivedSession> | null, id: string, retiredAt: string, trashBatch: string): LegacyCard {
    const row = ctx.db.getSession(id);
    const rec = outcomesById.get(id) ?? null;
    const name = row ? agentTitle({ title: row.title, displayName: ccDisplayName(row, row.title) }) : id;
    const tripwireLessons = [...new Set(sources.tripwireHits().filter((h) => h.sessionId === id).map((h) => h.tripwireId))];
    return {
      sessionId: id,
      name,
      city: row ? (islandNames.get(row.islandId) ?? "") : "",
      startedAt: row?.startedAt ?? retiredAt,
      lastActive: row?.lastActive ?? retiredAt,
      outcome: rec?.outcome ?? "unknown",
      reason: rec?.reason ?? null,
      prs: rec?.prs ?? [],
      artifacts: rec?.artifacts ?? [],
      learnings: rec?.learnings ?? [],
      costUsd: costUsdOf(ctx, id),
      tripwireLessons,
      vaultNote: archiveById?.get(id)?.note ?? null,
      retiredAt,
      trashBatch,
    };
  }

  async function writeLegacy(ctx: FeatureContext, ids: readonly string[], trashBatch: string): Promise<ReadonlyMap<string, string>> {
    const status = new Map<string, string>();
    if (ids.length === 0) return status;
    const retiredAt = new Date(now()).toISOString();
    const islandNames = new Map(ctx.worldViews().islands.map((i) => [i.id, i.name]));
    const outcomesById = new Map(sources.outcomes().map((r) => [r.sessionId, r]));
    const archiveList = sources.archive();
    const archiveById = archiveList ? new Map(archiveList.map((s) => [s.id, s])) : null;
    const cards = ids.map((id) => buildCard(ctx, islandNames, outcomesById, archiveById, id, retiredAt, trashBatch));
    try {
      await appendEvents(
        ctx,
        cards.map((c): AlumniEvent => ({ kind: "retired", ...c })),
      );
      for (const id of ids) status.set(id, "legacy card: written");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // An AmbiguousWriteError means the append raced past its timeout without being cancelled: it
      // may still land on disk later, so this is NOT the same as a clean "nothing was written" —
      // cleanup-trash.ts's retireSessions must void it too if the move then fails, same as "written".
      const label = err instanceof AmbiguousWriteError ? "unknown" : "not written";
      for (const id of ids) status.set(id, `legacy card: ${label} (${reason})`);
      ctx.log.warn("alumni", `legacy card write failed for ${ids.length} session(s)`, reason);
    }
    return status;
  }

  async function restoreLegacy(ctx: FeatureContext, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const at = new Date(now()).toISOString();
    try {
      await appendEvents(
        ctx,
        ids.map((id): AlumniEvent => ({ kind: "restored", sessionId: id, at })),
      );
    } catch (err) {
      ctx.log.warn("alumni", "restored-event write failed", err instanceof Error ? err.message : String(err));
    }
  }

  /** Called by cleanup-trash.ts's retireSessions for ids whose card writeLegacy wrote (or may still
   *  write) but whose move then did NOT complete (a late guard refusal, a rename failure, or a throw
   *  elsewhere in that batch) — so a card is never left standing for a session that never actually
   *  left ~/.claude/projects. Same "never blocks the retire" contract as writeLegacy: never throws,
   *  and says what actually happened ("written" / "queued" behind a still-pending write / "failed",
   *  nothing appended) so the retire response never claims a void that is not on disk. */
  async function voidLegacy(ctx: FeatureContext, ids: readonly string[], trashBatch: string): Promise<LegacyVoidOutcome> {
    if (ids.length === 0) return { state: "written" };
    const at = new Date(now()).toISOString();
    try {
      await appendEvents(
        ctx,
        ids.map((id): AlumniEvent => ({ kind: "voided", sessionId: id, at, trashBatch })),
      );
      return { state: "written" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log.warn("alumni", "voided-event write failed", reason);
      return { state: err instanceof AmbiguousWriteError ? "queued" : "failed", reason };
    }
  }

  const feature: ServerFeature = {
    id: "alumni",
    routes: [
      {
        method: "GET",
        path: "/api/alumni",
        async handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const raw = url.searchParams.get("range");
          const range: AlumniRange = (ALUMNI_RANGES as readonly string[]).includes(raw ?? "") ? (raw as AlumniRange) : DEFAULT_ALUMNI_RANGE;
          const nowMs = now();
          const { events, ok } = await readAllEvents(ctx);
          if (!ok) return respondJson(res, 503, { ok: false, error: "alumni.jsonl unavailable" });
          const cards = currentAlumni(events)
            .filter((c) => inRange(c.retiredAt, range, nowMs))
            .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
          const { agents, islands } = ctx.worldViews();
          const islandNames = new Map(islands.map((i) => [i.id, i.name]));
          const outcomesById = new Map(sources.outcomes().map((r) => [r.sessionId, r]));
          const engineeringBay = buildEngineeringBay(agents, islandNames, outcomesById, range, nowMs);
          const researchLibrary = buildResearchLibrary(agents, outcomesById, sources.topics(), range, nowMs);
          respondJson(res, 200, { ok: true, generatedAt: new Date(nowMs).toISOString(), range, cards, engineeringBay, researchLibrary } satisfies AlumniResponse);
        },
      },
    ],
  };
  return { feature, writeLegacy, restoreLegacy, voidLegacy };
}

const defaultAlumni = createAlumniFeature();
export const alumniFeature = defaultAlumni.feature;
/** Re-exported so cleanup.ts's retire/restore routes can call them directly (loadCleanupCandidates
 *  in cleanup.ts is the same cross-feature pattern). */
export const writeLegacy = defaultAlumni.writeLegacy;
export const restoreLegacy = defaultAlumni.restoreLegacy;
export const voidLegacy = defaultAlumni.voidLegacy;
