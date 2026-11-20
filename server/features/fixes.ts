// The Fix queue (Health's top section): one list of what needs fixing, merged from what other
// features already computed, read through their exported getters (docs/FEATURES.md, "Reading
// another feature's state"). Nothing here scans a transcript, a todo.md or the vault itself.
// The rows and their wording are built in fixes-lib.ts; this file gathers the inputs, keeps the
// snooze / won't fix and launch records (fixes-store.ts), serves the routes and pushes the open
// count (the status bar's Health chip tooltip reads it).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXES_EXTRAS_KEY,
  fixSourceOf,
  isFixId,
  type FixActionResult,
  type FixesMessage,
  type FixesResponse,
  type FixesSummary,
  type FixRowResponse,
} from "../../shared/features/fixes.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { currentHealthChecks } from "./completeness.js";
import { buildFixQueue, openTotal, type FixQueue } from "./fixes-lib.js";
import { fixesPathFor, fixesStoreFor, isTmuxName } from "./fixes-store.js";
import { makeDismissal } from "./health-dismissals.js";
import { latestLoopsBoard } from "./loops.js";
import { latestOutcomeRecords, latestOutcomesColdDone } from "./outcomes.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { openSicknessCases, sicknessSummary } from "./sickness.js";
import { loadTalkBindings } from "./talk.js";
import { latestVaultGaps } from "./vault.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALEF_DIR = dirname(dirname(__dirname)); // server/features -> server -> repo root
const TICK_MS = 30_000;
/** A GET within this long of the last build reuses it. */
const FRESH_MS = 5_000;

export interface FixesFeatureOptions {
  now?: () => number;
  vaultDir?: string;
}

export function createFixesFeature(opts: FixesFeatureOptions = {}): ServerFeature {
  const now = opts.now ?? Date.now;
  const vaultDir = opts.vaultDir ?? process.env.ALEF_VAULT_DIR ?? join(homedir(), "Documents", "Code", "alex_claude");
  /** The last build, and the owners' own objects it was built from: a reused build must not hide
   *  a change they already made (Mark done rescans Loops, then the client re-reads the queue). */
  let cache: { at: number; queue: FixQueue; from: readonly unknown[] } | null = null;
  let lastSummaryKey = "";

  function build(ctx: FeatureContext): FixQueue {
    const nowMs = now();
    const health = currentHealthChecks()?.checks ?? null;
    const gaps = latestVaultGaps();
    const loops = latestLoopsBoard();
    const from = [health, gaps, loops];
    if (cache && nowMs - cache.at < FRESH_MS && cache.from.every((x, i) => x === from[i])) return cache.queue;
    const store = fixesStoreFor(fixesPathFor(ctx.config.dbPath));
    const records = latestOutcomeRecords();
    const bindings = loadTalkBindings(ctx.db);
    const queue = buildFixQueue({
      nowMs,
      health,
      sickness: sicknessSummary() ? openSicknessCases() : null,
      gaps,
      loops,
      outcomes: latestOutcomesColdDone() || records.length > 0 ? records : null,
      vaultDir,
      alefDir: ALEF_DIR,
      cityForCwd: (cwd) => ctx.db.getIslandForCwd(cwd),
      session: (id) => {
        const s = ctx.db.getSession(id);
        return s ? { title: s.title, cwd: s.cwd, islandId: s.islandId } : null;
      },
      dismissal: (id) => store.dismissal(id, nowMs),
      launch: (id) => store.launch(id),
      sessionForTmux: (name) => bindings.find((b) => b.tmuxName === name)?.agentId ?? null,
    });
    for (const b of queue.newlyBound) {
      void store.bindSession(b.id, b.sessionId).catch((err: unknown) => ctx.log.warn("fixes", `could not save a launch's session: ${String(err)}`));
    }
    cache = { at: nowMs, queue, from };
    return queue;
  }

  function summaryOf(q: FixQueue): FixesSummary {
    return { generatedAt: new Date(cache?.at ?? now()).toISOString(), open: openTotal(q.open), pending: q.pending };
  }

  /** Pushes the summary when the open count (or what is still pending) changed. */
  function emitIfChanged(ctx: FeatureContext, q: FixQueue): void {
    const s = summaryOf(q);
    const key = `${s.open}|${s.pending.join(",")}`;
    if (key === lastSummaryKey) return;
    lastSummaryKey = key;
    ctx.emit({ kind: "summary", summary: s } satisfies FixesMessage);
  }

  function rebuild(ctx: FeatureContext): FixQueue {
    cache = null;
    const q = build(ctx);
    emitIfChanged(ctx, q);
    return q;
  }

  async function bodyOf(req: Parameters<typeof readJsonBody>[0]): Promise<unknown> {
    try {
      return await readJsonBody(req);
    } catch {
      return null;
    }
  }

  return {
    id: "fixes",
    tickIntervalMs: TICK_MS,
    onTick(ctx) {
      cache = null;
      emitIfChanged(ctx, build(ctx));
    },
    snapshotExtras() {
      return cache ? { [FIXES_EXTRAS_KEY]: summaryOf(cache.queue) } : {};
    },
    routes: [
      {
        method: "GET",
        path: "/api/fixes",
        handler(_req, res, ctx) {
          const q = build(ctx);
          respondJson(res, 200, { ok: true, generatedAt: new Date(cache?.at ?? now()).toISOString(), rows: q.rows, open: q.open, pending: q.pending } satisfies FixesResponse);
        },
      },
      {
        method: "GET",
        path: "/api/fixes/:id",
        handler(_req, res, ctx, params) {
          const row = build(ctx).rows.find((r) => r.id === params.id);
          if (!row) return respondJson(res, 404, { ok: false, error: "not in the fix queue now" } satisfies FixRowResponse);
          respondJson(res, 200, { ok: true, row } satisfies FixRowResponse);
        },
      },
      {
        // { kind: "snooze" | "wont-fix", days?, reason? }. A health row is the check's own
        // dismissal: POST /api/completeness/:checkId/dismiss, so Health and the Town square agree.
        method: "POST",
        path: "/api/fixes/:id/dismiss",
        async handler(req, res, ctx, params) {
          const id = params.id ?? "";
          if (!isFixId(id)) return respondJson(res, 400, { ok: false, error: "unknown fix id" } satisfies FixActionResult);
          if (fixSourceOf(id) === "health") return respondJson(res, 400, { ok: false, error: "a Health row is snoozed through /api/completeness/:checkId/dismiss" } satisfies FixActionResult);
          const body = await bodyOf(req);
          const d = isRecord(body) ? makeDismissal(body.kind, now(), body.days, body.reason) : null;
          if (!d) return respondJson(res, 400, { ok: false, error: 'kind must be "snooze" or "wont-fix"' } satisfies FixActionResult);
          await fixesStoreFor(fixesPathFor(ctx.config.dbPath)).setDismissal(id, d);
          rebuild(ctx);
          respondJson(res, 200, { ok: true } satisfies FixActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/fixes/:id/undismiss",
        async handler(_req, res, ctx, params) {
          const id = params.id ?? "";
          if (!isFixId(id) || fixSourceOf(id) === "health") return respondJson(res, 400, { ok: false, error: "unknown fix id" } satisfies FixActionResult);
          await fixesStoreFor(fixesPathFor(ctx.config.dbPath)).clearDismissal(id);
          rebuild(ctx);
          respondJson(res, 200, { ok: true } satisfies FixActionResult);
        },
      },
      {
        // A "Draft a fix" for this row was dispatched: { tmuxName } from the dispatch's answer
        // (absent when it ran in a plain Terminal, which Alef can't follow).
        method: "POST",
        path: "/api/fixes/:id/launched",
        async handler(req, res, ctx, params) {
          const id = params.id ?? "";
          if (!isFixId(id)) return respondJson(res, 400, { ok: false, error: "unknown fix id" } satisfies FixActionResult);
          const body = await bodyOf(req);
          const tmuxName = isRecord(body) && isTmuxName(body.tmuxName) ? body.tmuxName : null;
          await fixesStoreFor(fixesPathFor(ctx.config.dbPath)).recordLaunch(id, { at: new Date(now()).toISOString(), tmuxName, sessionId: null });
          ctx.log.info("fixes", `fix launched for a ${fixSourceOf(id) ?? "?"} row${tmuxName ? ` in ${tmuxName}` : ""}`);
          rebuild(ctx);
          respondJson(res, 200, { ok: true } satisfies FixActionResult);
        },
      },
    ],
  };
}

export const fixesFeature = createFixesFeature();
