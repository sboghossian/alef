// "shelf-board": the data behind the 🗄️ Shelf view. Every link, dashable host, GitHub repo / PR /
// issue, Linear issue / doc and local folder or file our sessions mentioned (own cursors, see
// shelf-board-scan.ts), merged with the artifacts feature's items (read through its getter, never
// counted twice) and the hosts of ~/.dashable/services.yml (read-only, through the System feature's
// cached TCP probe). Pins and sections are Alex's, stored in world.db meta. Registered BEFORE the
// room shelf so /api/shelf/board|pins|sections|seed win over /api/shelf/:agentId.
// Logs carry counts only, never titles, URLs or paths.

import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { artifactFallbackTitle, type ArtifactItem } from "../../shared/features/artifacts.js";
import { shelfScore, type ShelfBoardError, type ShelfBoardItem, type ShelfBoardResponse, type ShelfPinsResponse, type ShelfPinsState, type ShelfSeedResponse } from "../../shared/features/shelf-board.js";
import { cleanSection, UNSORTED_SECTION } from "../../shared/features/shelf-seed.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { latestArtifactItems } from "./artifacts.js";
import { yieldToLoop } from "./cache-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { classifyUrl, itemIdOf } from "./shelf-board-lib.js";
import { cleanTitle, movePin, pinFor, removePin, seedPins, setSections, upsertPin } from "./shelf-board-pins.js";
import { boardScanPass, checkPaths, listBoardTargets } from "./shelf-board-scan.js";
import { pruneItems, ShelfBoardStore, type StoredItem } from "./shelf-board-store.js";
import { defaultDirs, readServices } from "./system-probe.js";

export interface ServiceHostLite {
  host: string;
  up: boolean;
}

export interface ShelfBoardOptions {
  home?: string;
  byteBudget?: number;
  tickIntervalMs?: number;
  now?: () => number;
  services?: () => Promise<readonly ServiceHostLite[]>;
  artifacts?: () => readonly ArtifactItem[] | null;
}

const PATHS_PER_TICK = 200;
const MEMO_MS = 60_000;
const SEED_BODY_MAX = 128 * 1024;

/** A larger cap than readJsonBody's 16 KB (a seed file); same JSON rules. */
function readBigJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((ok, bad) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        bad(new Error("request body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch (err) {
        bad(err);
      }
    });
    req.on("error", bad);
  });
}

/** ?redact=1: titles, URLs, paths, hosts (kind) and district ids blanked; districts become stable
 *  placeholders ("district 1"…) so the district filter still groups. */
export function redactBoard(r: ShelfBoardResponse): ShelfBoardResponse {
  const label = (type: string, i: number): string => `${type} ${i + 1}`;
  const districts = new Map<string, string>();
  const district = (id: string | null): string | null => {
    if (!id) return null;
    if (!districts.has(id)) districts.set(id, `district ${districts.size + 1}`);
    return districts.get(id) ?? null;
  };
  return {
    ...r,
    items: r.items.map((it, i) => ({ ...it, title: label(it.type, i), url: null, path: null, district: district(it.district), kind: it.type === "github" || it.type === "linear" ? it.kind.replace(/[\w-]*\d+/g, "…") : it.type })),
    pins: r.pins.map((p, i) => ({ ...p, title: label(p.type, i), url: null, path: null })),
  };
}

export function createShelfBoardFeature(opts: ShelfBoardOptions = {}): ServerFeature {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now;
  const byteBudget = opts.byteBudget ?? 128 * 1024 * 1024;
  const services = opts.services ?? (() => readServices(defaultDirs(home)));
  const artifacts = opts.artifacts ?? latestArtifactItems;
  let store: ShelfBoardStore | null = null;
  let writable = true;

  const storeFor = (ctx: FeatureContext): ShelfBoardStore => {
    if (!store) {
      store = new ShelfBoardStore(ctx.db);
      store.load();
      // Filters tightened since an item was stored apply on the next boot: drop what they now refuse.
      let dropped = 0;
      for (const it of Object.values(store.state.items)) {
        if (it.url && !classifyUrl(it.url)) {
          delete store.state.items[it.id];
          dropped += 1;
        }
      }
      if (dropped) ctx.log.info("shelf-board", `dropped ${dropped} stored items the current filters refuse`);
      // Same for pins (a webhook pinned before webhooks were refused): hidden now, gone at the next pins write.
      const pins = store.pins.pins.filter((p) => !p.url || classifyUrl(p.url, { lenient: true }));
      if (pins.length < store.pins.pins.length) {
        ctx.log.info("shelf-board", `hid ${store.pins.pins.length - pins.length} stored pins the current filters refuse`);
        store.pins = { sections: store.pins.sections, pins };
      }
    }
    return store;
  };

  function toItem(ctx: FeatureContext, s: StoredItem, nowMs: number): ShelfBoardItem {
    const sid = s.sessions[0];
    const district = sid ? (ctx.db.getSession(sid)?.islandId ?? null) : null;
    const { key: _k, onDisk: _d, ...rest } = s;
    return { ...rest, sessions: [...s.sessions], district, score: shelfScore(s, nowMs) };
  }

  /** The last list built, reused while nothing it was built from changed (the GET is polled). */
  let memo: { rev: number; arts: unknown; hosts: unknown; at: number; list: ShelfBoardItem[] } | null = null;

  async function items(ctx: FeatureContext): Promise<ShelfBoardItem[]> {
    let hosts: readonly ServiceHostLite[] = [];
    try {
      hosts = await services();
    } catch {
      hosts = []; // no services.yml: dashable items still come from transcripts, with up unknown
    }
    const arts = artifacts();
    const rev = storeFor(ctx).rev;
    if (memo && memo.rev === rev && memo.arts === arts && memo.hosts === hosts && now() - memo.at < MEMO_MS) return memo.list;
    const list = build(ctx, arts, hosts);
    memo = { rev, arts, hosts, at: now(), list };
    return list;
  }

  function build(ctx: FeatureContext, arts: readonly ArtifactItem[] | null, hosts: readonly ServiceHostLite[]): ShelfBoardItem[] {
    const nowMs = now();
    const out = new Map<string, ShelfBoardItem>();
    for (const s of Object.values(storeFor(ctx).state.items)) {
      if (s.source === "fetch" || (s.path && s.onDisk !== true)) continue;
      out.set(s.id, toItem(ctx, s, nowMs));
    }
    for (const a of arts ?? []) {
      const id = itemIdOf(`artifact:${a.id}`);
      const lastSeen = a.lastAt ?? a.firstAt;
      const base = { count: Math.max(1, a.publishCount), lastSeen, typed: false, source: "artifacts" as const };
      out.set(id, {
        id, type: "artifact", url: a.url, path: null, title: a.title ?? artifactFallbackTitle(a), kind: a.origin, firstSeen: a.firstAt, ...base,
        sessions: a.sessions.slice(0, 8), district: a.islandId, hasPreview: a.hasPreview, score: shelfScore(base, nowMs) + (a.origin === "published" ? 1 : 0),
      });
    }
    for (const h of hosts) {
      const host = `${h.host}.dashable.dev`;
      const id = itemIdOf(`dashable:${host}`);
      const seen = out.get(id);
      if (seen) seen.up = h.up;
      else out.set(id, { id, type: "dashable", url: `https://${host}`, path: null, title: host, kind: h.host, firstSeen: null, lastSeen: null, count: 0, sessions: [], district: null, source: "services", typed: false, up: h.up, score: 0.5 });
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  const fail = (res: ServerResponse, status: number, error: string): void => respondJson(res, status, { ok: false, error } satisfies ShelfBoardError);
  const pinsOk = (s: ShelfPinsState): ShelfPinsResponse => ({ ok: true, sections: s.sections, pins: s.pins });

  /** Persists a pins change after the one-time backup; false (and a 503) when the backup failed. */
  async function savePins(ctx: FeatureContext, res: ServerResponse, next: ShelfPinsState): Promise<boolean> {
    const s = storeFor(ctx);
    if (!(await s.ensureBackup())) {
      fail(res, 503, "could not back up world.db; pins not saved");
      return false;
    }
    s.savePins(next);
    return true;
  }

  async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    try {
      const b = await readJsonBody(req);
      if (isRecord(b)) return b;
    } catch {
      /* fall through */
    }
    fail(res, 400, "JSON object body required");
    return null;
  }

  return {
    id: "shelf-board",
    tickIntervalMs: opts.tickIntervalMs ?? 30_000,
    onStart(ctx) {
      storeFor(ctx);
    },
    async onTick(ctx) {
      const s = storeFor(ctx);
      if (!writable) return;
      if (!(await s.ensureBackup())) {
        writable = false;
        ctx.log.warn("shelf-board", "could not back up world.db before the first shelf write; not indexing this boot");
        return;
      }
      const wasDone = s.done;
      const r = await boardScanPass(s, await listBoardTargets(ctx.config.projectsDir), byteBudget, home);
      const checked = await checkPaths(s, PATHS_PER_TICK);
      await yieldToLoop();
      const pruned = pruneItems(s.state, now());
      await yieldToLoop(); // prune and commit are the two sync stretches of a pass (~50-100 ms each at the cap)
      if (!r.dirty && !checked && !pruned && (wasDone || !r.complete)) return;
      s.commit(!wasDone && r.complete);
      if (!wasDone && s.done) ctx.log.info("shelf-board", `first full read done: ${Object.keys(s.state.items).length} items`);
    },
    snapshotExtras: (ctx) => {
      const s = storeFor(ctx);
      return { "shelf-board.summary": { ready: s.done, rev: s.rev, count: Object.keys(s.state.items).length } };
    },
    routes: [
      {
        method: "GET",
        path: "/api/shelf/board",
        async handler(req, res, ctx) {
          const s = storeFor(ctx);
          const full: ShelfBoardResponse = { ok: true, ready: s.done, items: await items(ctx), sections: s.pins.sections, pins: s.pins.pins };
          const redact = new URL(req.url ?? "/", "http://localhost").searchParams.get("redact") === "1";
          respondJson(res, 200, redact ? redactBoard(full) : full);
        },
      },
      {
        method: "POST",
        path: "/api/shelf/pins",
        async handler(req, res, ctx) {
          const b = await body(req, res);
          if (!b) return;
          const section = cleanSection(b.section) ?? UNSORTED_SECTION;
          const title = cleanTitle(b.title);
          const at = new Date(now()).toISOString();
          const s = storeFor(ctx);
          const from = cleanSection(b.from);
          let pin = null;
          if (typeof b.itemId === "string") {
            const id = b.itemId;
            if (from) {
              // "Move to…": the item's pin on `from` changes shelf; its pins on other shelves stay.
              if (!s.pins.pins.some((p) => p.itemId === id && p.section === from)) return fail(res, 404, "not pinned to that shelf");
              if (await savePins(ctx, res, movePin(s.pins, id, from, section))) respondJson(res, 200, pinsOk(s.pins));
              return;
            }
            const pinned = s.pins.pins.find((p) => p.itemId === id);
            const item = pinned ? undefined : (await items(ctx)).find((i) => i.id === id);
            pin = pinned ? { ...pinned, section, title: title ?? pinned.title, pinnedAt: at } : item ? pinFor({ item }, section, title, at) : null;
            if (!pin) return fail(res, 404, "unknown item");
          } else if (typeof b.url === "string") {
            pin = pinFor({ url: b.url }, section, title, at);
            if (!pin) return fail(res, 400, "not a URL the shelf keeps (http(s), no credentials)");
          } else return fail(res, 400, "itemId or url required");
          if (await savePins(ctx, res, upsertPin(s.pins, pin))) respondJson(res, 200, pinsOk(s.pins));
        },
      },
      {
        method: "DELETE",
        path: "/api/shelf/pins",
        async handler(req, res, ctx) {
          const b = await body(req, res);
          if (!b) return;
          const pin = typeof b.url === "string" ? pinFor({ url: b.url }, UNSORTED_SECTION, null, "") : null;
          const itemId = typeof b.itemId === "string" ? b.itemId : pin?.itemId;
          if (!itemId) return fail(res, 400, "itemId or url required");
          const s = storeFor(ctx);
          const section = b.section === undefined ? undefined : (cleanSection(b.section) ?? UNSORTED_SECTION);
          if (await savePins(ctx, res, removePin(s.pins, itemId, section))) respondJson(res, 200, pinsOk(s.pins));
        },
      },
      {
        method: "PUT",
        path: "/api/shelf/sections",
        async handler(req, res, ctx) {
          const b = await body(req, res);
          if (!b) return;
          if (!Array.isArray(b.sections)) return fail(res, 400, "sections[] required");
          const s = storeFor(ctx);
          const next = setSections(s.pins, b.sections, isRecord(b.renames) ? b.renames : {});
          if (await savePins(ctx, res, next)) respondJson(res, 200, pinsOk(s.pins));
        },
      },
      {
        method: "POST",
        path: "/api/shelf/seed",
        async handler(req, res, ctx) {
          let rows: unknown;
          try {
            rows = await readBigJson(req, SEED_BODY_MAX);
          } catch {
            return fail(res, 400, "JSON array of {section,url,title} required (≤128 KB)");
          }
          const s = storeFor(ctx);
          const r = seedPins(s.pins, rows, new Date(now()).toISOString());
          if (!r) return fail(res, 400, "JSON array of {section,url,title} required (≤500 rows)");
          if (r.added && !(await savePins(ctx, res, r.state))) return;
          ctx.log.info("shelf-board", `seed import: ${r.added} added, ${r.skipped} already pinned, ${r.invalid} refused`);
          respondJson(res, 200, { ...pinsOk(s.pins), added: r.added, skipped: r.skipped, invalid: r.invalid } satisfies ShelfSeedResponse);
        },
      },
    ],
  };
}

export const shelfBoardFeature = createShelfBoardFeature();
