// "artifacts": every claude.ai artifact our sessions published or worked with, as one item each,
// placed in the district of the session that published it and mirrored in the Museum island.
// A tick reads the transcripts' new bytes (artifacts-scan.ts, its own cursors), folds the events
// (artifacts-lib.ts), persists them in world.db (artifacts-store.ts), then copies changed source
// pages for the preview (artifacts-snapshot.ts). Logs carry counts only, never titles or paths.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  ARTIFACT_ID_RE,
  byArtifactAt,
  MUSEUM_ISLAND_ID,
  MUSEUM_NAME,
  type ArtifactItem,
  type ArtifactsError,
  type ArtifactsResponse,
  type ArtifactsSummary,
} from "../../shared/features/artifacts.js";
import type { Island } from "../../shared/types.js";
import { respondJson } from "../http.js";
import { isServable, toItem } from "./artifacts-lib.js";
import { listTargets, scanPass } from "./artifacts-scan.js";
import { snapshotPath, snapshotSource, type SnapshotError } from "./artifacts-snapshot.js";
import { ArtifactsStore } from "./artifacts-store.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

/** Script hosts a claude.ai artifact page may load (the Artifact tool's own allow-list). */
export const ARTIFACT_SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://code.jquery.com"];
/** CSP of a served copy. Its scripts run (charts, boards drawn by script), but `sandbox allow-scripts`
 *  without allow-same-origin puts them in an opaque origin, even on a top-level visit: no Alef
 *  cookies or storage, and every request it could make to Alef carries Origin: null or
 *  Sec-Fetch-Site: cross-site, which guard.ts refuses on every route. connect-src 'none' and
 *  form-action 'none' leave it no fetch, XHR, WebSocket, beacon or form; no allow-top-navigation
 *  or allow-popups, so it can't move Alef's window or open one. img-src keeps https: so remote
 *  pictures show; the page can already navigate itself anywhere, so a narrower img-src would close
 *  no channel, and all a script can see is the (redacted) page itself. */
export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${ARTIFACT_SCRIPT_HOSTS.join(" ")}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");
const SNAPSHOTS_PER_TICK = 12;
/** An unchanged source is stat'ed again after this long; a missing one after MISSING_RETRY_MS. */
const RECHECK_MS = 60_000;
const MISSING_RETRY_MS = 10 * 60_000;

/** The newest list this feature built (null until it has read its store): other features read it
 *  here instead of counting artifacts a second time (the projects view). */
let latestItems: ArtifactItem[] | null = null;
export const latestArtifactItems = (): readonly ArtifactItem[] | null => latestItems;

export interface ArtifactsFeatureOptions {
  home?: string;
  /** Where the page copies go (default: <dir of world.db>/artifacts). */
  snapshotDir?: (ctx: FeatureContext) => string;
  byteBudget?: number;
  tickIntervalMs?: number;
  now?: () => number;
}

export function createArtifactsFeature(opts: ArtifactsFeatureOptions = {}): ServerFeature {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now;
  const byteBudget = opts.byteBudget ?? 256 * 1024 * 1024;
  const dirFor = opts.snapshotDir ?? ((ctx: FeatureContext) => join(dirname(ctx.config.dbPath), "artifacts"));
  let store: ArtifactsStore | null = null;
  let writable = true;
  /** When each item's source is looked at again (keyed by item id; a new source path resets it). */
  const nextCheck = new Map<string, { at: number; path: string }>();

  const storeFor = (ctx: FeatureContext): ArtifactsStore => {
    if (!store) {
      store = new ArtifactsStore(ctx.db);
      store.load();
    }
    return store;
  };

  function items(ctx: FeatureContext): ArtifactItem[] {
    const s = storeFor(ctx);
    const islandOf = (id: string): string | null => ctx.db.getSession(id)?.islandId ?? null;
    return Object.values(s.state.items)
      .filter(isServable)
      .map((i) => toItem(i, islandOf, i.snap !== null))
      .sort(byArtifactAt);
  }

  /** Copies the pages whose source changed, a few per tick. True when any item's copy changed. */
  async function snapshots(ctx: FeatureContext, s: ArtifactsStore): Promise<boolean> {
    let changed = false;
    let budget = SNAPSHOTS_PER_TICK;
    const counts: Partial<Record<SnapshotError | "saved", number>> = {};
    for (const item of Object.values(s.state.items).filter(isServable)) {
      const src = item.sourcePath;
      if (budget <= 0) break;
      if (!src) continue;
      const next = nextCheck.get(item.id);
      if (next && next.path === src && next.at > now()) continue;
      budget -= 1;
      let wait = RECHECK_MS;
      try {
        const r = await snapshotSource(src, dirFor(ctx), item.id, item.snap, { home });
        if (r.ok && (r.changed || !item.snap)) {
          item.snap = { mtimeMs: r.mtimeMs, size: r.size };
          changed = true;
          counts.saved = (counts.saved ?? 0) + 1;
        } else if (!r.ok) {
          counts[r.error] = (counts[r.error] ?? 0) + 1;
          wait = r.error === "not-found" ? MISSING_RETRY_MS : Number.POSITIVE_INFINITY; // a refusal is final for this path
        }
      } catch (err) {
        wait = MISSING_RETRY_MS;
        ctx.log.warn("artifacts", `a page copy failed: ${String(err).slice(0, 120)}`);
      }
      nextCheck.set(item.id, { at: now() + wait, path: src });
    }
    if (counts.saved || counts.secret || counts["privacy-guarded"] || counts["too-large"]) ctx.log.info("artifacts", `page copies: ${JSON.stringify(counts)}`);
    return changed;
  }

  function summary(ctx: FeatureContext): ArtifactsSummary {
    const s = storeFor(ctx);
    const all = Object.values(s.state.items).filter(isServable);
    return {
      ready: s.done,
      count: all.length,
      published: all.filter((i) => Object.keys(i.publishers).length > 0).length,
      withPreview: all.filter((i) => i.snap !== null).length,
      rev: s.rev,
    };
  }

  const fail = (res: ServerResponse, status: number, error: string): void => respondJson(res, status, { ok: false, error } satisfies ArtifactsError);

  return {
    id: "artifacts",
    tickIntervalMs: opts.tickIntervalMs ?? 30_000,
    onStart(ctx) {
      storeFor(ctx);
      latestItems = items(ctx);
    },
    async onTick(ctx) {
      const s = storeFor(ctx);
      if (!writable) return;
      if (!(await s.ensureBackup())) {
        writable = false;
        ctx.log.warn("artifacts", "could not back up world.db before the first artifacts write; not indexing artifacts this boot");
        return;
      }
      const wasDone = s.done;
      const r = await scanPass(s, await listTargets(ctx.config.projectsDir), byteBudget);
      const copied = await snapshots(ctx, s);
      if (!r.dirty && !copied && (wasDone || !r.complete)) return;
      s.commit(!wasDone && r.complete);
      latestItems = items(ctx);
      if (!wasDone && s.done) ctx.log.info("artifacts", `first full read done: ${Object.keys(s.state.items).length} artifacts`);
      ctx.emit({ type: "changed", rev: s.rev });
    },
    snapshotExtras: (ctx) => ({ "artifacts.summary": summary(ctx) }),
    snapshotIslands(ctx): Island[] {
      const all = Object.values(storeFor(ctx).state.items).filter(isServable);
      if (all.length === 0) return [];
      const last = all.reduce<string | null>((m, i) => {
        const at = i.lastPublishAt ?? i.seenAt;
        return at && (!m || at > m) ? at : m;
      }, null);
      return [{ id: MUSEUM_ISLAND_ID, name: MUSEUM_NAME, path: "", agentCount: 0, lastActive: last ?? new Date(0).toISOString() }];
    },
    routes: [
      {
        method: "GET",
        path: "/api/artifacts",
        handler(_req, res, ctx) {
          respondJson(res, 200, { ok: true, ready: storeFor(ctx).done, items: items(ctx) } satisfies ArtifactsResponse);
        },
      },
      {
        method: "GET",
        path: "/api/artifacts/:id/preview",
        async handler(req, res, ctx, params) {
          const id = params.id ?? "";
          if (!ARTIFACT_ID_RE.test(id)) return fail(res, 400, "invalid artifact id");
          const item = storeFor(ctx).state.items[id];
          if (!item?.snap || !isServable(item)) return fail(res, 404, "no saved copy of this artifact");
          let body: Buffer;
          try {
            body = await readFile(snapshotPath(dirFor(ctx), id));
          } catch {
            return fail(res, 404, "no saved copy of this artifact");
          }
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": body.length,
            "Content-Security-Policy": ARTIFACT_PREVIEW_CSP,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
        },
      },
    ],
  };
}

export const artifactsFeature = createArtifactsFeature();
