// H2 — open-loops board (right sidebar's Loops tab): merges whatsup's ranked todos.json
// with Alef's own live scan of every tasks/todo.md under ~/Documents/Code, throttled to at
// most one rescan/minute and always off the request path (routes/snapshotExtras only ever
// read the last computed board; `maybeRescan` kicks the next one in the background).
//
// Row actions: POST .../open reuses the existing open-editor executor (server/features/
// open-editor.ts); POST .../launch reuses talk.ts's startWorldSession (server/features/
// loops-launch.ts) — never a client-supplied path, always the server's own cached item
// looked up by id. Until the first scan after boot has finished, both answer 503 (not a 404
// that reads as if the item were gone), and a launch reports the folder's trust state
// (server/trust.ts), read before anything starts. POST .../done (the Fix queue's "Mark done")
// ticks the one tasks/todo.md line a scanned item came from (loops-done.ts), then rescans.
// A launch is recorded against the item's Fix queue row (fixes-store.ts), so the session it
// started, and its outcome verdict, show back on that row.

import { homedir } from "node:os";
import { LOOPS_NOT_READY_ERROR, type LoopsActionResult, type LoopsBoard, type LoopsItem, type LoopsMessage } from "../../shared/features/loops.js";
import { respondJson } from "../http.js";
import { folderTrust } from "../trust.js";
import { fixesPathFor, fixesStoreFor, isTmuxName } from "./fixes-store.js";
import { createLaunchOnce } from "./launch-once.js";
import { markTodoDone } from "./loops-done.js";
import { validateLaunch, worldPlanLoopsLauncher, type LoopsLauncher } from "./loops-launch.js";
import { mergeLoopsItems } from "./loops-merge.js";
import { DEFAULT_CODE_DIR, scanTodoFiles } from "./loops-scan.js";
import { DEFAULT_WHATSUP_TODOS_JSON, readWhatsupBoard } from "./loops-whatsup.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { resolveInside, safePathStatus } from "./safe-path.js";

const RESCAN_MS = 60_000;

const EMPTY_BOARD: LoopsBoard = { generatedAt: new Date(0).toISOString(), items: [], badge: 0, whatsupOk: false, whatsupError: null };

let latestBoard: LoopsBoard | null = null;

/** The last computed board, or null until the first scan after boot finished (the Fix queue's
 *  stale-loop rows read it; null reads as pending, never as "no loops"). */
export function latestLoopsBoard(): LoopsBoard | null {
  return latestBoard;
}

export interface LoopsFeatureOptions {
  whatsupPath?: string;
  codeDir?: string;
  homeDir?: string;
  rescanMs?: number;
  launcher?: LoopsLauncher;
  /** Clock for the repeat-launch window (tests). */
  now?: () => number;
}

export function createLoopsFeature(opts: LoopsFeatureOptions = {}): ServerFeature {
  const whatsupPath = opts.whatsupPath ?? DEFAULT_WHATSUP_TODOS_JSON;
  const codeDir = opts.codeDir ?? DEFAULT_CODE_DIR;
  const homeDir = opts.homeDir ?? homedir();
  const rescanMs = opts.rescanMs ?? RESCAN_MS;
  const launcher = opts.launcher ?? worldPlanLoopsLauncher;

  let board: LoopsBoard = EMPTY_BOARD;
  let itemsById = new Map<string, LoopsItem>();
  let lastRescanAt = 0;
  let inFlight: Promise<void> | null = null;
  /** False until the first rescan after boot has filled `itemsById`. */
  let firstScanDone = false;
  /** Why the last rescan failed, while no rescan has succeeded yet. */
  let firstScanError: string | null = null;
  /** One launch per item: a second click while it starts, or within LAUNCH_REPEAT_WINDOW_MS after it
   *  started, gets the same session back instead of a second one (launch-once.ts). */
  const launchOnce = createLaunchOnce(opts.now ?? Date.now);

  async function rescan(ctx: FeatureContext): Promise<void> {
    const [whatsup, scanned] = await Promise.all([readWhatsupBoard(whatsupPath), scanTodoFiles({ codeDir })]);
    const items = await mergeLoopsItems(whatsup.items, scanned, whatsup.generatedAt, codeDir);
    const badge = items.filter((i) => i.lens === "do_today").length;
    board = { generatedAt: new Date().toISOString(), items, badge, whatsupOk: whatsup.ok, whatsupError: whatsup.error };
    itemsById = new Map(items.map((i) => [i.id, i]));
    firstScanDone = true;
    latestBoard = board;
    ctx.emit({ kind: "board", board } satisfies LoopsMessage);
  }

  /** Kicks off at most one rescan per `rescanMs`, never overlapping. Returns the in-flight (or
   *  already-resolved) promise so `onTick` can await it deterministically in tests; `snapshotExtras`
   *  deliberately does NOT await this — it stays synchronous, off the request path. */
  function maybeRescan(ctx: FeatureContext): Promise<void> {
    if (inFlight) return inFlight;
    const now = Date.now();
    if (now - lastRescanAt < rescanMs) return Promise.resolve();
    lastRescanAt = now;
    inFlight = rescan(ctx)
      .catch((err: unknown) => {
        if (!firstScanDone) firstScanError = String(err);
        ctx.log.error("loops", "rescan failed", String(err));
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Before the first scan, answers 503 (and makes sure a scan is on its way): an empty
   *  `itemsById` then means "not read yet", not "no such item". */
  function notReady(res: Parameters<typeof respondJson>[0], ctx: FeatureContext): boolean {
    if (firstScanDone) return false;
    void maybeRescan(ctx);
    const error = firstScanError ? `Alef couldn't read your loops after a restart (${firstScanError}). It tries again every minute.` : LOOPS_NOT_READY_ERROR;
    respondJson(res, 503, { ok: false, error } satisfies LoopsActionResult);
    return true;
  }

  return {
    id: "loops",
    tickIntervalMs: rescanMs,
    onTick(ctx) {
      return maybeRescan(ctx);
    },
    routes: [
      {
        method: "POST",
        path: "/api/loops/:id/open",
        async handler(_req, res, ctx, params) {
          if (notReady(res, ctx)) return;
          const item = itemsById.get(params.id ?? "");
          if (!item) return respondJson(res, 404, { ok: false, error: "unknown item" });
          if (!item.openPath) return respondJson(res, 400, { ok: false, error: "this item has no source file to open" });
          const resolved = await resolveInside(homeDir, item.openPath, { allowAbsolute: true });
          if (!resolved.ok) return respondJson(res, safePathStatus(resolved.error), { ok: false, error: "refusing to open a path outside the home directory" });
          try {
            await ctx.executors.openEditor(resolved.abs);
            respondJson(res, 200, { ok: true });
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) });
          }
        },
      },
      {
        method: "POST",
        path: "/api/loops/:id/launch",
        async handler(_req, res, ctx, params) {
          if (notReady(res, ctx)) return;
          const item = itemsById.get(params.id ?? "");
          if (!item) return respondJson(res, 404, { ok: false, error: "unknown item" });
          // Starting a session takes ~2s; a second click inside that window used to start a second one.
          const r = await launchOnce.run(`loops:${item.id}`, async (): Promise<{ ok: boolean; status: number; body: LoopsActionResult }> => {
            const validated = await validateLaunch(homeDir, item.launchCwd, item.task);
            if (!validated.ok) return { ok: false, status: validated.status, body: { ok: false, error: validated.error } };
            // Read before the launch: the new claude rewrites ~/.claude.json as it starts.
            const trust = await folderTrust(ctx.config.claudeJsonPath, validated.cwd);
            const result = await launcher(validated.cwd, validated.prompt, ctx);
            ctx.log.info("loops", `launch ${item.id} -> ${result.tmuxName ?? result.error ?? "?"} (folder trust: ${trust})`);
            if (result.ok) {
              const launch = { at: new Date().toISOString(), tmuxName: isTmuxName(result.tmuxName) ? result.tmuxName : null, sessionId: null };
              try {
                await fixesStoreFor(fixesPathFor(ctx.config.dbPath)).recordLaunch(`loop:${item.id}`, launch);
              } catch (err) {
                ctx.log.warn("loops", `could not record the launch on its fix row: ${String(err)}`);
              }
            }
            return result.ok ? { ok: true, status: 200, body: { ...result, trust, cwd: validated.cwd } } : { ok: false, status: 500, body: result };
          });
          respondJson(res, r.status, (r.reused ? { ...r.body, reused: true } : r.body) satisfies LoopsActionResult);
        },
      },
      {
        // "Mark done": ticks the item's own line in its tasks/todo.md, nothing else, then rescans.
        method: "POST",
        path: "/api/loops/:id/done",
        async handler(_req, res, ctx, params) {
          if (notReady(res, ctx)) return;
          const item = itemsById.get(params.id ?? "");
          if (!item) return respondJson(res, 404, { ok: false, error: "unknown item" });
          if (!item.sources.includes("scan") || !item.openPath) return respondJson(res, 400, { ok: false, error: "this item isn't a tasks/todo.md line, so there is nothing to tick" });
          const resolved = await resolveInside(homeDir, item.openPath, { allowAbsolute: true });
          if (!resolved.ok) return respondJson(res, safePathStatus(resolved.error), { ok: false, error: "refusing a todo.md outside the home directory" });
          const result = await markTodoDone(resolved.abs, item.task);
          if (!result.ok) return respondJson(res, 409, { ok: false, error: result.error } satisfies LoopsActionResult);
          ctx.log.info("loops", `marked ${item.id} done (line ${result.line} of its todo.md)`);
          lastRescanAt = 0;
          await maybeRescan(ctx);
          respondJson(res, 200, { ok: true, line: result.line } satisfies LoopsActionResult);
        },
      },
    ],
    snapshotExtras(ctx) {
      void maybeRescan(ctx);
      return { "loops.board": board };
    },
  };
}

export const loopsFeature = createLoopsFeature();
