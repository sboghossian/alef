// "sickness": minions get sick. A session (or one of its subagents) is sick when its own
// transcript shows a leaked key, a broken build or a page that tries to steer agents. The
// detectors are deterministic regexes and pairing rules (sickness-lib.ts); the transcripts are
// read by sickness-scan.ts with a per-tick byte budget (a cold backfill over every transcript,
// then only new bytes). No model calls, no network.
//
// Observe and record only: nothing here blocks, messages or modifies a session, and the only
// files it writes are its own two, beside world.db (dataDir = dirname(config.dbPath), as in
// president.ts):
//   data/sickness.jsonl       append-only, one line per case change ({c: case, o: line offset,
//                             f: transcript}) and one per "Mark treated" click that changed
//                             something ({t: {id, by: "alex", at}}), a {v: version} header
//                             first; folded by id at boot, compacted (write-tmp-then-rename) once
//                             it passes 5 MB. A compaction rewrites every treatment: none is lost.
//   data/sickness-scan.json   the scanner's byte offsets (write-tmp-then-rename), so a restart
//                             continues where it stopped. Cases are appended BEFORE offsets are
//                             saved, and a case ignores any line at or before its stored offset,
//                             so a crash between the two replays lines harmlessly.
// A different SICKNESS_BANK_VERSION on disk resets both: every transcript is rescanned and case
// ids (kind + agent + key hash / class / host) dedupe. Treatments survive it (kept by case id).
//
// The one write a person can cause: POST /api/sickness/:id/treated (the Clinic's "Mark treated").
// It records Alex's own report (📣: Alef can't see the fix), never deletes anything, is
// idempotent, answers 404 for an unknown (or withheld-kind) id and 409 for a healed case. A
// treated case is no longer sick (openSicknessCases() drops it) until evidence newer than the
// treatment shows up, which reopens it.
//
// SECRET INVARIANT: no key value reaches a case, the log, a WS payload, the API or these files
// (sickness-lib.ts findKeys() returns hashes and masked prefixes only). Log lines carry counts.
//
//   GET  /api/sickness                        → SicknessResponse
//   POST /api/sickness/:id/treated            → SicknessTreatResult
//   GET  /api/sickness/vault                  → SicknessVaultResponse (sickness-clinic.ts; read-only)
//   GET  /api/sickness/insurance              → SicknessInsuranceResponse (sickness-clinic.ts; read-only)
//   WS  { type:"feature", feature:"sickness", payload: SicknessMessage }  (≤ EMIT_CAP per pass)
//   snapshot extras "sickness.open"           → SicknessOpenEntry[]
//   openSicknessCases()                       → for wave 2's president "treat" candidates

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { automationKey, displayIslandName } from "../../shared/display.js";
import {
  isSicknessTreatment,
  SICKNESS_OPEN_CAP,
  SICKNESS_OPEN_KEY,
  type SicknessCase,
  type SicknessCounts,
  type SicknessKind,
  type SicknessMessage,
  type SicknessResponse,
  type SicknessScanProgress,
  type SicknessTreatment,
  type SicknessTreatResult,
} from "../../shared/features/sickness.js";
import { respondJson } from "../http.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import {
  CaseBook,
  countCases,
  DISABLED_KINDS,
  foldCaseLog,
  isSick,
  newestFirst,
  openEntries,
  SICKNESS_BANK_VERSION,
  treatmentLine,
  type AgentRef,
  type Place,
  type SicknessEvent,
  type StoredCase,
} from "./sickness-lib.js";
import { countInsurance, VAULT_SUBDIR, VaultKeyCounter } from "./sickness-clinic.js";
import { TranscriptScanner, type ScanStateFile } from "./sickness-scan.js";
import { vaultRoot } from "../config.js";

const LOG_FILE = "sickness.jsonl";
const SCAN_FILE = "sickness-scan.json";
const COMPACT_BYTES = 5 * 1024 * 1024;
/** Offsets are saved at most this often when no case changed (a crash re-reads ≤ 1 min). */
const STATE_SAVE_MS = 60_000;
/** At most this many changed cases per WS message (newest first); GET /api/sickness is complete. */
const EMIT_CAP = 200;

let current: { book: CaseBook; disabled: ReadonlySet<SicknessKind>; progress: () => SicknessScanProgress } | null = null;

/** Sick (open / chronic / exposed) cases of the served kinds, newest first ([] before the first
 *  tick). Wave 2's president reads these as "treat" candidates. */
export function openSicknessCases(): SicknessCase[] {
  if (!current) return [];
  const { book, disabled } = current;
  return book
    .all()
    .filter((c) => !disabled.has(c.kind) && isSick(c))
    .sort(newestFirst);
}

/** Every case of the served kinds, sick or healed ([] before the first tick): the Home digest
 *  counts the ones opened and healed in its range. */
export function allSicknessCases(): SicknessCase[] {
  if (!current) return [];
  const { book, disabled } = current;
  return book.all().filter((c) => !disabled.has(c.kind));
}

/** Counts of the served kinds + the scan's progress (the vision ledger's sickness probe), or null
 *  before the feature first ran. While its log loads, the scan reads as unfinished (finishedAt is
 *  restored only after the cases are). */
export function sicknessSummary(): { counts: SicknessCounts; scan: SicknessScanProgress; disabledKinds: SicknessKind[] } | null {
  if (!current) return null;
  const { book, disabled, progress } = current;
  return { counts: countCases(book.all().filter((c) => !disabled.has(c.kind))), scan: progress(), disabledKinds: [...disabled] };
}

export interface SicknessFeatureOptions {
  dataDir?: string;
  home?: string;
  now?: () => number;
  tickIntervalMs?: number;
  budgetBytes?: number;
  disabledKinds?: ReadonlySet<SicknessKind>;
  /** The case log is compacted once it passes this many bytes (default 5 MB). */
  compactBytes?: number;
  /** The vault GET /api/sickness/vault counts (default ~/Documents/Code/alex_claude, or $ALEF_VAULT_DIR). */
  vaultDir?: string;
  /** Where GET /api/sickness/insurance counts *.bak files (default: the data dir). */
  backupsDir?: string;
  /** Home of ~/.alef-trash for GET /api/sickness/insurance (default: `home`). */
  trashHome?: string;
}

function isScanStateFile(v: unknown): v is ScanStateFile {
  return typeof v === "object" && v !== null && typeof (v as ScanStateFile).v === "number" && Array.isArray((v as ScanStateFile).files);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

export function createSicknessFeature(opts: SicknessFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const home = opts.home ?? homedir();
  const disabled = opts.disabledKinds ?? DISABLED_KINDS;
  const compactBytes = opts.compactBytes ?? COMPACT_BYTES;
  const book = new CaseBook();
  const scanner = new TranscriptScanner({ home, budgetBytes: opts.budgetBytes });
  const vault = new VaultKeyCounter({ vaultDir: opts.vaultDir ?? vaultRoot(home), subdir: VAULT_SUBDIR, now });
  /** Case changes not yet appended to the log (id → latest). */
  const pending = new Map<string, StoredCase>();
  /** Treatment events not yet appended to the log, in click order. */
  const pendingTreatments: Array<[string, SicknessTreatment]> = [];
  /** Flushes run one at a time: a POST's flush and a tick's flush never interleave an append
   *  with a compaction's rename (which would drop the appended line). */
  let flushing: Promise<void> = Promise.resolve();
  let loading: Promise<void> | null = null;
  let rewriteLog = false; // the log is missing, garbled or from another bank version: rewrite it whole
  let logBytes = 0;
  /** Size of the log right after its last full rewrite: compaction waits until the log has at
   *  least doubled since, so a big case set never rewrites the whole log on every flush. */
  let compactedBytes = 0;
  let lastStateSave = 0;

  const dataDir = (ctx: FeatureContext): string => opts.dataDir ?? dirname(ctx.config.dbPath);

  function ensureLoaded(ctx: FeatureContext): Promise<void> {
    loading ??= (async () => {
      current = { book, disabled, progress: () => scanner.progress() };
      const dir = dataDir(ctx);
      let logText: string | null = null;
      try {
        logText = await readFile(join(dir, LOG_FILE), "utf8");
      } catch {
        logText = null;
      }
      const folded = logText === null ? null : foldCaseLog(logText);
      const sameVersion = folded?.version === SICKNESS_BANK_VERSION;
      // Treatments outlive everything, a new bank version included: the rescan rebuilds each case
      // from its transcript and put() gives it its treatment back.
      // A case line carries its treatment too: that copy covers a torn write of the event line.
      if (folded) {
        for (const s of folded.cases.values()) if (isSicknessTreatment(s.c.treatment) && !folded.treatments.has(s.c.id)) book.restoreTreatment(s.c.id, s.c.treatment);
        for (const [id, t] of folded.treatments) book.restoreTreatment(id, t);
      }
      if (folded && sameVersion) {
        for (const s of folded.cases.values()) book.restore(s);
        logBytes = Buffer.byteLength(logText ?? "");
        if (folded.garbled > 0) ctx.log.warn("sickness", `${folded.garbled} garbled line(s) in ${LOG_FILE} skipped; compacting`);
        rewriteLog = folded.garbled > 0;
      } else {
        rewriteLog = true;
      }
      if (sameVersion) {
        try {
          const raw: unknown = JSON.parse(await readFile(join(dir, SCAN_FILE), "utf8"));
          if (isScanStateFile(raw) && raw.v === SICKNESS_BANK_VERSION) scanner.load(raw);
        } catch {
          // no offsets yet (or unreadable): rescan from 0; case offsets make the replay a no-op
        }
      }
      if (folded && !sameVersion) ctx.log.info("sickness", `bank version ${folded.version ?? "?"} → ${SICKNESS_BANK_VERSION}: rescanning every transcript`);
    })();
    return loading;
  }

  /** Session → lineage (automationKey of its first prompt) and district, from the index. */
  function placeOf(ctx: FeatureContext, sessionId: string, cache?: Map<string, Place>): Place {
    const hit = cache?.get(sessionId);
    if (hit) return hit;
    const row = ctx.db.getSession(sessionId);
    let district: string | null = null;
    if (row) {
      const path = ctx.db.getIslandCwd(row.islandId) ?? "";
      district = displayIslandName({ name: (path && basename(path)) || row.islandId, path });
    }
    const place = { lineage: row ? automationKey(row.title) : null, district };
    cache?.set(sessionId, place);
    return place;
  }

  /** Fills a lineage / district the index didn't know when the case was recorded (served only). */
  function placed(ctx: FeatureContext, c: SicknessCase, cache: Map<string, Place>): SicknessCase {
    if (c.lineage !== null && c.district !== null) return c;
    const p = placeOf(ctx, c.sessionId, cache);
    return { ...c, lineage: c.lineage ?? p.lineage, district: c.district ?? p.district };
  }

  function sinkFor(ctx: FeatureContext, changed: Map<string, SicknessCase>): (ev: SicknessEvent, agent: AgentRef) => void {
    const cache = new Map<string, Place>();
    return (ev, agent) => {
      const c = book.apply(ev, agent, () => placeOf(ctx, agent.sessionId, cache));
      if (!c) return;
      changed.set(c.id, c);
      const stored = book.entry(c.id);
      if (stored) pending.set(c.id, stored);
    };
  }

  function publish(ctx: FeatureContext, changed: ReadonlyMap<string, SicknessCase>): void {
    const cache = new Map<string, Place>();
    const served = [...changed.values()].filter((c) => !disabled.has(c.kind));
    if (served.length === 0) return;
    const cases = served.sort(newestFirst).slice(0, EMIT_CAP).map((c) => placed(ctx, c, cache));
    ctx.emit({ kind: "cases", cases } satisfies SicknessMessage);
  }

  /** Appends pending case changes and treatments, then (throttled) saves offsets. Order matters:
   *  see the header. A failed write asks the next flush to rewrite the whole log from memory, so
   *  lines dropped from `pending` still reach disk. Never call it directly: use flushSerial. */
  async function flush(ctx: FeatureContext, force: boolean): Promise<void> {
    const dir = dataDir(ctx);
    const header = JSON.stringify({ v: SICKNESS_BANK_VERSION });
    const batch = [...pending.values()];
    pending.clear();
    const treated = pendingTreatments.splice(0);
    const nowMs = now();
    const saveState = scanner.dirty && (force || batch.length > 0 || nowMs - lastStateSave >= STATE_SAVE_MS);
    const stateText = saveState ? JSON.stringify(scanner.toJSON(SICKNESS_BANK_VERSION, nowMs)) : null;
    if (saveState) scanner.dirty = false;
    if (!rewriteLog && batch.length === 0 && treated.length === 0 && stateText === null) return;
    try {
      await mkdir(dir, { recursive: true });
      const logPath = join(dir, LOG_FILE);
      const rewrite = async (): Promise<void> => {
        const lines = [header, ...book.stored().map((s) => JSON.stringify(s)), ...book.treatmentEntries().map(([id, t]) => JSON.stringify(treatmentLine(id, t)))];
        const text = lines.join("\n") + "\n";
        await writeAtomic(logPath, text);
        logBytes = compactedBytes = Buffer.byteLength(text);
        rewriteLog = false;
      };
      if (rewriteLog) await rewrite();
      else if (batch.length > 0 || treated.length > 0) {
        const lines = [...batch.map((s) => JSON.stringify(s)), ...treated.map(([id, t]) => JSON.stringify(treatmentLine(id, t)))];
        const text = lines.join("\n") + "\n";
        await appendFile(logPath, text, "utf8");
        logBytes += Buffer.byteLength(text);
        if (logBytes > compactBytes && logBytes > 2 * compactedBytes) await rewrite();
      }
    } catch (err) {
      rewriteLog = true; // the book in memory is complete: the next flush writes it whole
      throw err;
    }
    if (stateText !== null) {
      try {
        await writeAtomic(join(dir, SCAN_FILE), stateText);
        lastStateSave = nowMs;
      } catch (err) {
        scanner.dirty = true; // offsets are a cache: a crash before the retry only re-reads lines, harmlessly
        ctx.log.warn("sickness", `saving scan offsets failed (retried on the next flush): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function flushSerial(ctx: FeatureContext, force: boolean): Promise<void> {
    const run = flushing.then(() => flush(ctx, force));
    flushing = run.catch(() => undefined);
    return run;
  }

  function summary(changed: ReadonlyMap<string, SicknessCase>): string {
    const by: Record<string, number> = {};
    for (const c of changed.values()) by[`${c.kind}/${c.state}`] = (by[`${c.kind}/${c.state}`] ?? 0) + 1;
    return Object.entries(by)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  }

  return {
    id: "sickness",
    tickIntervalMs: opts.tickIntervalMs ?? 10_000,
    routes: [
      {
        method: "GET",
        path: "/api/sickness",
        async handler(_req, res, ctx) {
          await ensureLoaded(ctx);
          const cache = new Map<string, Place>();
          const cases = book
            .all()
            .filter((c) => !disabled.has(c.kind))
            .map((c) => placed(ctx, c, cache))
            .sort(newestFirst);
          respondJson(res, 200, {
            ok: true,
            version: SICKNESS_BANK_VERSION,
            disabledKinds: [...disabled],
            counts: countCases(cases),
            scan: scanner.progress(),
            cases,
          } satisfies SicknessResponse);
        },
      },
      {
        // The Clinic's "Mark treated". Appends a treatment event; never deletes; idempotent.
        method: "POST",
        path: "/api/sickness/:id/treated",
        async handler(_req, res, ctx, params) {
          await ensureLoaded(ctx);
          const id = params.id ?? "";
          const stored = book.entry(id);
          if (!stored || disabled.has(stored.c.kind)) {
            respondJson(res, 404, { ok: false, error: "no such case" } satisfies SicknessTreatResult);
            return;
          }
          const cache = new Map<string, Place>();
          if (stored.c.state === "treated") {
            respondJson(res, 200, { ok: true, already: true, case: placed(ctx, stored.c, cache) } satisfies SicknessTreatResult);
            return;
          }
          if (stored.c.state === "healed") {
            respondJson(res, 409, { ok: false, error: "this case already healed: a later run passed, so there is nothing to treat" } satisfies SicknessTreatResult);
            return;
          }
          const prevTreatment = book.treatmentOf(id);
          const t: SicknessTreatment = { by: "alex", at: new Date(now()).toISOString() };
          const c = book.treat(id, t);
          if (!c || c.state !== "treated") {
            book.untreat(id, prevTreatment);
            respondJson(res, 409, { ok: false, error: "this case has evidence newer than now (a clock skew?): not marked treated" } satisfies SicknessTreatResult);
            return;
          }
          const entry = book.entry(id);
          if (entry) pending.set(id, entry);
          pendingTreatments.push([id, t]);
          try {
            await flushSerial(ctx, false);
          } catch (err) {
            // Not on disk means not treated: roll back, so what the Clinic shows is what a restart
            // shows (the next flush rewrites the whole log from memory, without this treatment).
            book.untreat(id, prevTreatment);
            ctx.log.warn("sickness", `saving a treatment failed; rolled back: ${err instanceof Error ? err.message : String(err)}`);
            respondJson(res, 500, { ok: false, error: "saving the treatment failed, so the case is unchanged" } satisfies SicknessTreatResult);
            return;
          }
          ctx.log.info("sickness", `a ${c.kind} case was marked treated (reported by Alex)`);
          const served = placed(ctx, c, cache);
          ctx.emit({ kind: "cases", cases: [served] } satisfies SicknessMessage);
          respondJson(res, 200, { ok: true, already: false, case: served } satisfies SicknessTreatResult);
        },
      },
      {
        method: "GET",
        path: "/api/sickness/vault",
        async handler(_req, res) {
          respondJson(res, 200, await vault.get());
        },
      },
      {
        method: "GET",
        path: "/api/sickness/insurance",
        async handler(_req, res, ctx) {
          respondJson(res, 200, await countInsurance({ home: opts.trashHome ?? home, projectsDir: ctx.config.projectsDir, backupsDir: opts.backupsDir ?? dataDir(ctx) }));
        },
      },
    ],
    async onIndexPass(ctx, newLinesBySession) {
      await ensureLoaded(ctx);
      const changed = new Map<string, SicknessCase>();
      const sink = sinkFor(ctx, changed);
      const nowMs = now();
      for (const [sessionId, lines] of newLinesBySession) {
        const path = scanner.mainPath(sessionId);
        const indexed = path ? (ctx.db.getFileOffset(path)?.byteOffset ?? null) : null;
        scanner.ingestIndexLines(sessionId, lines, indexed, sink, nowMs); // false → the tick reads them
      }
      publish(ctx, changed); // persisted by the next tick's flush (a crash replays them from disk)
    },
    async onTick(ctx) {
      await ensureLoaded(ctx);
      const nowMs = now();
      const changed = new Map<string, SicknessCase>();
      let justFinished = false;
      try {
        const r = await scanner.tick(ctx.config.projectsDir, sinkFor(ctx, changed), nowMs);
        justFinished = r.justFinished;
        for (const c of book.sweepChronic((p) => scanner.fileInfo(p), nowMs)) {
          changed.set(c.id, c);
          const stored = book.entry(c.id);
          if (stored) pending.set(c.id, stored);
        }
        if (changed.size > 0) {
          const p = scanner.progress();
          ctx.log.info("sickness", `${changed.size} case change(s): ${summary(changed)} · scanned ${p.filesDone}/${p.filesTotal} transcripts`);
        }
        if (justFinished) {
          const counts = countCases(book.all());
          ctx.log.info("sickness", `backfill finished: ${counts.total} case(s)`, { byKind: counts.byKind, byState: counts.byState, linesSkipped: scanner.linesSkipped });
        }
      } finally {
        await flushSerial(ctx, justFinished); // cases already recorded always reach disk and the clients
        publish(ctx, changed);
      }
    },
    snapshotExtras() {
      return { [SICKNESS_OPEN_KEY]: openEntries(book.all().filter((c) => !disabled.has(c.kind)), SICKNESS_OPEN_CAP) };
    },
  };
}

export const sicknessFeature = createSicknessFeature();
