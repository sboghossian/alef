// "home": the server side of the 🏠 Home view (Alex, 2026-09-29). Read-only over what the
// other features already measured, plus ONE model call: a 3-5 sentence summary of the "What
// happened" facts, written by Haiku through the local claude CLI exactly the way the resident
// runs it (resident.ts realReflectRunner: `claude -p --model haiku --tools "" --no-session-persistence
// --strict-mcp-config`, prompt over stdin, argv only, a timeout, a per-run budget).
//
// INVARIANTS
//   - The summary is written from the FACTS JSON only (counts, district / automation names, merged
//     PR titles): no transcript text, no note contents (home-lib.ts promptFacts).
//   - A summary whose numbers are not all in its facts is discarded (home-lib.ts validateSummary);
//     the view then shows the facts alone and says why.
//   - Cost: at most one automatic run per range per 30 min (a failed one counts), only when the
//     facts changed, only from a GET (someone has Home open), one run per range at a time, and a
//     daily cap for all ranges together (default $0.20), counted even when a run fails.
//   - Fails soft: claude missing or failing leaves the facts, with an honest note.
//   - Writes only data/home-digest.json (next to world.db): the cached summaries, the last attempt
//     per range and today's spend. Temp file + rename, one write at a time.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArchivedSession } from "../../shared/features/archive.js";
import type { CareerWorker } from "../../shared/features/careers.js";
import type { CensusMergedSummary, CensusPr } from "../../shared/features/census.js";
import {
  isDigestRange,
  type DigestFacts,
  type DigestRange,
  type DigestResponse,
  type HomeAutomationsResponse,
  type HomeDecisionsResponse,
  type HomeError,
} from "../../shared/features/home.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { PresidentBoard, PresidentLedgerEntry } from "../../shared/features/president.js";
import type { Routine } from "../../shared/features/routines.js";
import type { SicknessCase } from "../../shared/features/sickness.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { latestArchivedSessions } from "./archive.js";
import { latestCareerWorkers } from "./careers.js";
import { latestCensusMerged, latestCensusPrs } from "./census.js";
import {
  DEFAULT_CAP_USD,
  automationRows,
  autoDecision,
  buildDigestFacts,
  buildSummaryPrompt,
  capText,
  decisionRows,
  emptyDigestState,
  factsHash,
  manualDecision,
  parseDigestState,
  recordRun,
  spendToday,
  summaryNote,
  validateSummary,
  type AutoDecision,
  type DigestStateFile,
  type RunResult,
} from "./home-lib.js";
import { latestOutcomeRecords } from "./outcomes.js";
import { currentPresidentBoard, latestPresidentLedger } from "./president.js";
import { REFLECT_TIMEOUT_MS, realReflectRunner, type ReflectRunner } from "./resident.js";
import { envelopeCost, parseEnvelope } from "./resident-lib.js";
import { latestRoutines } from "./routines.js";
import { allSicknessCases, sicknessSummary } from "./sickness.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const STATE_FILE = "home-digest.json";

/** Where the facts come from; every default is the running feature's own last result. */
export interface HomeSources {
  outcomes(): readonly OutcomeRecord[];
  censusSummary(): CensusMergedSummary | null;
  censusPrs(): readonly CensusPr[];
  sicknessCases(): readonly SicknessCase[];
  /** True once the sickness scan has read every transcript to the end; null before its first tick. */
  sicknessScanDone(): boolean | null;
  archived(): readonly ArchivedSession[] | null;
  ledger(): readonly PresidentLedgerEntry[] | null;
  board(): PresidentBoard | null;
  careerWorkers(): readonly CareerWorker[] | null;
  routines(): readonly Routine[];
}

const realSources: HomeSources = {
  outcomes: latestOutcomeRecords,
  censusSummary: latestCensusMerged,
  censusPrs: latestCensusPrs,
  sicknessCases: allSicknessCases,
  sicknessScanDone: () => {
    const s = sicknessSummary();
    return s ? s.scan.finishedAt !== null : null;
  },
  archived: latestArchivedSessions,
  ledger: latestPresidentLedger,
  board: currentPresidentBoard,
  careerWorkers: latestCareerWorkers,
  routines: () => latestRoutines().routines,
};

export interface HomeFeatureOptions {
  sources?: Partial<HomeSources>;
  /** Defaults to the resident's real claude runner. */
  runner?: ReflectRunner;
  /** Where claude runs (an empty folder: no project settings to pick up). Defaults to the OS temp dir. */
  runDir?: string;
  /** Where home-digest.json lives; defaults to the world.db directory. */
  dataDir?: string;
  capUsd?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createHomeFeature(opts: HomeFeatureOptions = {}): ServerFeature {
  const src: HomeSources = { ...realSources, ...opts.sources };
  const runner = opts.runner ?? realReflectRunner;
  const now = opts.now ?? Date.now;
  const capUsd = opts.capUsd ?? DEFAULT_CAP_USD;
  const timeoutMs = opts.timeoutMs ?? REFLECT_TIMEOUT_MS;
  let state: DigestStateFile = emptyDigestState();
  let loadedFrom: string | null = null;
  const writing = new Map<DigestRange, Promise<void>>();
  let writes: Promise<unknown> = Promise.resolve();

  function statePath(ctx: FeatureContext): string {
    return join(opts.dataDir ?? dirname(ctx.config.dbPath), STATE_FILE);
  }

  async function load(ctx: FeatureContext): Promise<void> {
    const path = statePath(ctx);
    if (loadedFrom === path) return;
    loadedFrom = path;
    try {
      state = parseDigestState(JSON.parse(await readFile(path, "utf8")));
    } catch {
      state = emptyDigestState(); // missing or unreadable: start clean (spend is then only this run's)
    }
  }

  function persist(ctx: FeatureContext): Promise<void> {
    const path = statePath(ctx);
    const run = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
      await rename(tmp, path);
    });
    writes = run.catch((err: unknown) => ctx.log.warn("home", "home-digest.json write failed", String(err)));
    return writes.then(() => undefined);
  }

  function facts(ctx: FeatureContext, range: DigestRange): DigestFacts {
    const { agents, islands } = ctx.worldViews();
    const records = src.outcomes();
    const scanDone = src.sicknessScanDone();
    return buildDigestFacts(
      {
        agents,
        islands,
        outcomes: records.length > 0 ? records : null,
        census: { summary: src.censusSummary(), prs: src.censusPrs() },
        sickness: scanDone === null ? null : { cases: src.sicknessCases(), scanDone },
        archived: src.archived(),
        ledger: src.ledger(),
      },
      range,
      now(),
    );
  }

  /** One Haiku run for `range`, recorded (cost included) whatever happens. Never throws. */
  async function write(ctx: FeatureContext, range: DigestRange, f: DigestFacts, hash: string): Promise<void> {
    const prompt = buildSummaryPrompt(f);
    let result: RunResult;
    try {
      const out = await runner(prompt, { cwd: opts.runDir ?? tmpdir(), timeoutMs });
      const env = parseEnvelope(out.stdout, prompt.length);
      if (!env.ok) result = { ok: false, error: env.error, costUsd: envelopeCost(out.stdout, prompt.length) };
      else {
        const check = validateSummary(env.value.text, f);
        result = check.ok ? { ok: true, text: check.text, costUsd: env.value.costUsd } : { ok: false, error: check.reason, costUsd: env.value.costUsd };
      }
    } catch (err) {
      // claude could not be started at all (not on PATH): nothing was spent.
      ctx.log.warn("home", "claude could not start for the digest summary", String(err));
      result = { ok: false, error: "claude could not be started on this Mac (is it on the server's PATH?)", costUsd: 0 };
    }
    state = recordRun(state, range, hash, now(), result);
    if (!result.ok) ctx.log.info("home", `digest summary (${range}) not kept: ${result.error}`);
    await persist(ctx);
  }

  function startWrite(ctx: FeatureContext, range: DigestRange, f: DigestFacts, hash: string): Promise<void> {
    const run = write(ctx, range, f, hash).finally(() => writing.delete(range));
    writing.set(range, run);
    return run;
  }

  function response(range: DigestRange, f: DigestFacts, hash: string, decision: AutoDecision): DigestResponse {
    const cached = state.summaries[range];
    const t = now();
    return {
      ok: true,
      facts: f,
      summary: cached ? { text: cached.text, at: cached.at, current: cached.factsHash === hash, costUsd: cached.costUsd } : null,
      writing: writing.has(range),
      note: summaryNote(state, range, hash, decision, t, capUsd),
      spend: { todayUsd: Math.round(spendToday(state, t) * 10_000) / 10_000, capUsd },
    };
  }

  return {
    id: "home",
    async onStart(ctx) {
      await load(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/home/digest",
        async handler(req, res, ctx) {
          const range = new URL(req.url ?? "/", "http://localhost").searchParams.get("range") ?? "today";
          if (!isDigestRange(range)) {
            respondJson(res, 400, { ok: false, error: "range must be today, week or month" } satisfies HomeError);
            return;
          }
          await load(ctx);
          const f = facts(ctx, range);
          const hash = factsHash(f);
          const decision = autoDecision(state, range, hash, now(), capUsd, writing.has(range));
          if (decision.run) void startWrite(ctx, range, f, hash);
          respondJson(res, 200, response(range, f, hash, decision));
        },
      },
      {
        method: "POST",
        path: "/api/home/digest/summary",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies HomeError);
            return;
          }
          const range = isRecord(body) ? body.range : undefined;
          if (!isDigestRange(range)) {
            respondJson(res, 400, { ok: false, error: "range must be today, week or month" } satisfies HomeError);
            return;
          }
          await load(ctx);
          const inFlight = writing.get(range);
          if (inFlight) await inFlight; // one run per range: a second click waits for the first
          else {
            const decision = manualDecision(state, now(), capUsd, false);
            if (!decision.run) {
              respondJson(res, 429, { ok: false, error: capText(state, now(), capUsd) } satisfies HomeError);
              return;
            }
            const f = facts(ctx, range);
            await startWrite(ctx, range, f, factsHash(f));
          }
          const f = facts(ctx, range);
          const hash = factsHash(f);
          const attempt = state.attempts[range];
          if (attempt?.error) {
            respondJson(res, 502, { ok: false, error: attempt.error } satisfies HomeError);
            return;
          }
          respondJson(res, 200, response(range, f, hash, { run: false, why: "current" }));
        },
      },
      {
        method: "GET",
        path: "/api/home/automations",
        handler(_req, res) {
          const workers = src.careerWorkers();
          respondJson(res, 200, { ok: true, ready: workers !== null, rows: automationRows(workers, src.routines()) } satisfies HomeAutomationsResponse);
        },
      },
      {
        method: "GET",
        path: "/api/home/decisions",
        handler(_req, res) {
          const ledger = src.ledger();
          const verdicts = new Map(src.outcomes().map((r) => [r.sessionId, r.outcome]));
          respondJson(res, 200, {
            ok: true,
            ready: ledger !== null,
            rows: ledger ? decisionRows(ledger, src.board(), (id) => verdicts.get(id) ?? null) : [],
          } satisfies HomeDecisionsResponse);
        },
      },
    ],
  };
}

export const homeFeature = createHomeFeature();
