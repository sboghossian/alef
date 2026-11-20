// The 🗄️ Vault sections of the Mind group: fourteen ways to read Alex's Obsidian vault, ported from
// the "Alex's Brain" artifact. Everything is derived from the graph feed the vault already
// builds for itself hourly (vault-feed.ts) and aggregated here (vault-lib.ts), so the client gets
// a few KB per section instead of 32,000 notes.
//
// READ-ONLY: no route writes to the vault, and nothing here reaches the network. Logs carry counts
// only — never a note title, path or body.
//
// Cost: one parse at boot (~90 ms, ~75 MB) and then only when a shard's mtime changes; the hourly
// rebuild costs one re-read. Each section is computed on demand and memoised against the parse it
// came from (the reader hands back the same feed object until the manifest's `generated` or a
// shard's mtime/size moves) and the day, so repeated tab switches are free until the feed moves.
// A request kicks a background refresh at most once per REFRESH_MIN_MS; the tick covers the rest.

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { VaultFlowsMode, VaultGaps, VaultMeta, VaultNote, VaultNotesQuery } from "../../shared/features/vault.js";
import { respondJson } from "../http.js";
import { EMPTY_META, VaultFeedReader, type VaultFeedOptions } from "./vault-feed.js";
import {
  inboundCounts,
  vaultClimb,
  vaultEchoes,
  vaultFocus,
  vaultGaps,
  vaultGrowth,
  vaultMeetings,
  vaultNotes,
  vaultPeople,
  vaultProjects,
  vaultPulse,
  vaultSources,
  vaultTopics,
} from "./vault-lib.js";
import { vaultAtlas, vaultConstellation, vaultFlows, vaultHubs } from "./vault-maps.js";
import { SYNAPSES_REL, SynapseReader, synapsesOf, vaultFiring } from "./vault-synapses.js";
import { vaultRoot } from "../config.js";
import { buildVaultSearchIndex, vaultSearch, type VaultSearchIndex } from "./vault-search.js";
import type { FeatureContext, Route, ServerFeature } from "./registry.js";

const TICK_MS = 5 * 60_000;
/** Requests re-stat the feed at most this often (it is rebuilt hourly; the tick refreshes too). */
const REFRESH_MIN_MS = 30_000;
/** Drill lists are for reading, not for bulk export. */
const NOTES_CAP = 200;

export interface VaultFeatureOptions extends VaultFeedOptions {
  reader?: VaultFeedReader;
  synapses?: SynapseReader;
}

/** The section payloads, memoised per parse and day. Keyed by the feed's notes array, which the
 *  reader keeps while nothing changed, and the day (pulse, growth, atlas… count back from today). */
interface Memo {
  notes: readonly VaultNote[];
  day: number;
  inbound: Map<string, number>;
  sections: Map<string, unknown>;
  search: VaultSearchIndex | null;
  /** The Gaps section, shared by its route and latestVaultGaps() (the Fix queue). */
  gaps?: VaultGaps;
  /** Built on the first climb request, then reused until the feed moves. */
  index: { byPath: Map<string, VaultNote>; byId: Map<string, VaultNote> } | null;
}

let gapsGetter: (() => VaultGaps | null) | null = null;

/** The Gaps of the last parsed feed (memoised with every other section), or null until the feed
 *  was read once. The Fix queue reads its vault rows from here: no second scan of the vault. */
export function latestVaultGaps(): VaultGaps | null {
  return gapsGetter?.() ?? null;
}

function dayIndex(now: number): number {
  return Math.floor(now / 86_400_000);
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}

/** The one place a section's name maps to the function that builds it. */
const SECTIONS = ["pulse", "growth", "focus", "meetings", "projects", "topics", "people", "sources", "gaps", "hubs", "constellation"] as const;
type SectionName = (typeof SECTIONS)[number];

/** Which filters /api/vault/notes accepts. The first one present wins, so a URL with two is not ambiguous. */
const NOTE_FILTERS: readonly VaultNotesQuery["kind"][] = ["day", "tag", "project", "umbrella", "folder", "ghost", "type", "unanchored"];

export function createVaultFeature(opts: VaultFeatureOptions = {}): ServerFeature {
  const reader = opts.reader ?? new VaultFeedReader(opts);
  const now = opts.now ?? Date.now;
  const synapseReader = opts.synapses ?? new SynapseReader(join(opts.vaultDir ?? vaultRoot(), SYNAPSES_REL));
  let memo: Memo | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;

  /** The parsed feed, without ever blocking a request on an evicted-file read. */
  async function feed(ctx: FeatureContext): Promise<{ notes: readonly VaultNote[]; meta: VaultMeta } | null> {
    const served = reader.current();
    if (served && now() - refreshedAt < REFRESH_MIN_MS) return served;
    refreshedAt = now();
    const pending = reader.refresh();
    if (served) {
      void pending.catch((err: unknown) => ctx.log.warn("vault", `refresh failed: ${String(err)}`));
      return served;
    }
    return await pending;
  }

  function memoFor(notes: readonly VaultNote[]): Memo {
    const day = dayIndex(now());
    if (memo && memo.notes === notes && memo.day === day) return memo;
    // A new day over the same parse keeps what doesn't depend on the date (inbound counts, the index).
    const same = memo && memo.notes === notes ? memo : null;
    memo = { notes, day, inbound: same?.inbound ?? inboundCounts(notes), sections: new Map(), search: same?.search ?? null, index: same?.index ?? null };
    return memo;
  }

  function gapsOf(m: Memo, notes: readonly VaultNote[]): VaultGaps {
    m.gaps ??= vaultGaps(notes, m.inbound);
    return m.gaps;
  }

  gapsGetter = () => {
    const f = reader.current();
    return f ? gapsOf(memoFor(f.notes), f.notes) : null;
  };

  function section(name: SectionName, notes: readonly VaultNote[], today: number, inbound: Map<string, number>): unknown {
    switch (name) {
      case "pulse":
        return { pulse: vaultPulse(notes, today) };
      case "growth":
        return { growth: vaultGrowth(notes, today) };
      case "focus":
        return { focus: vaultFocus(notes, today) };
      case "meetings":
        return { meetings: vaultMeetings(notes, today) };
      case "projects":
        return { projects: vaultProjects(notes, today) };
      case "topics":
        return { topics: vaultTopics(notes, today) };
      case "people":
        return { people: vaultPeople(notes, today) };
      case "sources":
        return { sources: vaultSources(notes, today) };
      case "gaps":
        return { gaps: vaultGaps(notes, inbound) };
      case "hubs":
        return { hubs: vaultHubs(notes) };
      case "constellation":
        return { constellation: vaultConstellation(notes) };
    }
  }

  async function serveSection(name: SectionName, res: ServerResponse, ctx: FeatureContext): Promise<void> {
    const f = await feed(ctx);
    if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
    const m = memoFor(f.notes);
    let body = m.sections.get(name);
    if (!body) {
      body = name === "gaps" ? { gaps: gapsOf(m, f.notes) } : section(name, f.notes, dayIndex(now()), m.inbound);
      m.sections.set(name, body);
    }
    respondJson(res, 200, { ok: true, meta: f.meta, ...(body as Record<string, unknown>) });
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/vault/meta",
      async handler(_req, res, ctx) {
        const f = await feed(ctx);
        respondJson(res, 200, { ok: true, meta: f?.meta ?? EMPTY_META });
      },
    },
    ...SECTIONS.map<Route>((name) => ({
      method: "GET",
      path: `/api/vault/${name}`,
      handler: (_req, res, ctx) => serveSection(name, res, ctx),
    })),
    {
      method: "GET",
      path: "/api/vault/echoes",
      async handler(req, res, ctx) {
        const f = await feed(ctx);
        if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
        // The seed is the only thing a client may vary here, so it is parsed, not trusted: a bad
        // one falls back to today, which is what the first visit of the day gets anyway.
        const raw = Number.parseInt(query(req).get("seed") ?? "", 10);
        const seed = Number.isSafeInteger(raw) && raw >= 0 ? raw : dayIndex(now());
        const m = memoFor(f.notes);
        respondJson(res, 200, { ok: true, meta: f.meta, echoes: vaultEchoes(f.notes, dayIndex(now()), seed, m.inbound) });
      },
    },
    {
      method: "GET",
      path: "/api/vault/atlas",
      async handler(req, res, ctx) {
        const f = await feed(ctx);
        if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
        // Only used to walk the in-memory folder tree, never to touch the filesystem; an unknown
        // segment just stops the walk at its parent.
        const path = (query(req).get("path") ?? "").split("/").filter((seg) => seg && seg !== "." && seg !== "..");
        const m = memoFor(f.notes);
        const key = `atlas:${path.join("/")}`;
        let atlas = m.sections.get(key);
        if (!atlas) {
          atlas = vaultAtlas(f.notes, dayIndex(now()), path, m.inbound);
          m.sections.set(key, atlas);
        }
        respondJson(res, 200, { ok: true, meta: f.meta, atlas });
      },
    },
    {
      method: "GET",
      path: "/api/vault/flows",
      async handler(req, res, ctx) {
        const f = await feed(ctx);
        if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
        const mode: VaultFlowsMode = query(req).get("mode") === "umbrellas" ? "umbrellas" : "folders";
        const m = memoFor(f.notes);
        const key = `flows:${mode}`;
        let flows = m.sections.get(key);
        if (!flows) {
          flows = vaultFlows(f.notes, mode);
          m.sections.set(key, flows);
        }
        respondJson(res, 200, { ok: true, meta: f.meta, flows });
      },
    },
    {
      method: "GET",
      path: "/api/vault/search",
      async handler(req, res, ctx) {
        const q = (query(req).get("q") ?? "").slice(0, 120);
        const f = await feed(ctx);
        // ⌘K asks on every keystroke: an unread feed is no hits, never an error toast.
        if (!f) return respondJson(res, 200, { ok: true, q, hits: [] });
        const m = memoFor(f.notes);
        m.search ??= buildVaultSearchIndex(f.notes, m.inbound);
        respondJson(res, 200, { ok: true, q, hits: vaultSearch(m.search, q) });
      },
    },
    {
      method: "GET",
      path: "/api/vault/climb",
      async handler(req, res, ctx) {
        const f = await feed(ctx);
        if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
        // Only a lookup key into the parsed feed, never a filesystem path.
        const path = (query(req).get("path") ?? "").trim();
        if (!path) return respondJson(res, 400, { ok: false, error: "path is required" });
        const m = memoFor(f.notes);
        if (!m.index) {
          const byPath = new Map<string, VaultNote>();
          const byId = new Map<string, VaultNote>();
          for (const n of f.notes) {
            byPath.set(n.path.toLowerCase(), n);
            byId.set(n.id, n);
          }
          m.index = { byPath, byId };
        }
        respondJson(res, 200, { ok: true, climb: vaultClimb(path, m.index.byPath, m.index.byId) });
      },
    },
    {
      method: "GET",
      path: "/api/vault/synapses",
      async handler(req, res, ctx) {
        // Only a lookup key into the parsed cache, never a filesystem path.
        const path = (query(req).get("path") ?? "").trim();
        if (!path) return respondJson(res, 400, { ok: false, error: "path is required" });
        const g = await synapseReader.read().catch((err: unknown) => {
          ctx.log.warn("vault", `synapses read failed: ${String(err)}`);
          return null;
        });
        respondJson(res, 200, { ok: true, ready: g !== null, synapses: g ? synapsesOf(g, path) : [] });
      },
    },
    {
      method: "GET",
      path: "/api/vault/firing",
      async handler(req, res, ctx) {
        const days = Math.min(14, Math.max(1, Math.floor(Number(query(req).get("days") ?? "2")) || 2));
        const f = await feed(ctx);
        const g = await synapseReader.read().catch((err: unknown) => {
          ctx.log.warn("vault", `synapses read failed: ${String(err)}`);
          return null;
        });
        const firing = f && g ? vaultFiring(g, f.notes, dayIndex(now()), days) : { days, seeds: 0, notes: [] };
        respondJson(res, 200, { ok: true, ready: !!(f && g), firing });
      },
    },
    {
      method: "GET",
      path: "/api/vault/notes",
      async handler(req, res, ctx) {
        const f = await feed(ctx);
        if (!f) return respondJson(res, 503, { ok: false, error: "the vault's graph feed has not been read yet" });
        const params = query(req);
        const kind = NOTE_FILTERS.find((k) => params.get(k) !== null);
        if (!kind) {
          return respondJson(res, 400, { ok: false, error: `one of ${NOTE_FILTERS.join(", ")} is required` });
        }
        const value = params.get(kind) ?? "";
        const m = memoFor(f.notes);
        const { notes, total, truncated } = vaultNotes(f.notes, { kind, value }, NOTES_CAP, m.inbound);
        respondJson(res, 200, { ok: true, query: { kind, value }, notes, total, truncated });
      },
    },
  ];

  return {
    id: "vault",
    routes,
    tickIntervalMs: TICK_MS,
    async onStart(ctx) {
      // The first client to open the tab should not pay for the parse. Failing is fine: every
      // route refreshes on demand and the view shows the feed as not ready.
      try {
        const f = await reader.refresh();
        if (f) ctx.log.info("vault", `graph feed read, ${f.notes.length} rows from ${f.meta.shards} shards`);
      } catch (err) {
        ctx.log.warn("vault", `first graph-feed read failed: ${String(err)}`);
      }
    },
    async onTick(ctx) {
      try {
        await reader.refresh();
      } catch (err) {
        ctx.log.warn("vault", `refresh failed: ${String(err)}`);
      }
    },
  };
}

export const vaultFeature = createVaultFeature();
