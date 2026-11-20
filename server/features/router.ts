// POST /api/router/route — the Jev router (round 10 §2). Called by a UserPromptSubmit hook
// (hooks/jev-router.mjs, OUTSIDE this app — it fires for every Claude Code prompt on this
// Mac, not just Alef's own sessions) and, later, by Alef's own chat panel. A hook can only
// return `additionalContext`; it cannot switch the model or rewrite the prompt (verified
// from the raw Claude Code docs, 2026-09-26) — so this endpoint gives ADVICE, never a
// command: a model-tier recommendation plus a short list of memory/vault notes worth
// reading. One batched TypeSafe (Jev) call does both the model choice and a relevance
// score per candidate note; a rules fallback covers no key / an error / a slow call (see
// router-lib.ts's TIMEOUT_MS default — the round10 contract's ">1.5s" budget).
//
// Candidate notes reuse the recall feature's own building blocks (server/features/recall/
// bm25.ts + corpus.ts) over the same fixed, private, read-only corpus (memory dir + vault
// project indexes + brain-graph titles) — never editing recall's files, just importing its
// exported pure pieces, the same way council-jev.ts reuses director.ts. Only note TITLES
// ever reach Jev; snippets/bodies never leave this process (same rule recall.ts documents).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../director.js";
import { callJev } from "../director.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { log } from "../log.js";
import { ROUTER_CARDS_KEY, type RouteCardSummary, type RouterResult } from "../../shared/features/router.js";
import { createTtlCache } from "./cache-lib.js";
import { bm25Scores, buildIndex, materialize, rankedChunkIndices, type BM25Index } from "./recall/bm25.js";
import { defaultCorpusRoots, walkCorpus, type CorpusRoots } from "./recall/corpus.js";
import { scanUserSkills } from "./skills-inventory.js";
import { VaultFeedReader } from "./vault-feed.js";
import { vaultRoot } from "../config.js";
import type { ServerFeature } from "./registry.js";
import {
  MAX_JEV_CANDIDATES,
  MAX_PROMPT_CHARS,
  QUESTION_BANK,
  buildRouterJevBody,
  classifyModelRules,
  clampWhy,
  createRateLimiter,
  parseRouterJevAnswers,
  graphWave,
  mergeCandidates,
  vaultRelative,
  pickDispatch,
  pickNotes,
  pickTools,
  skillCandidates,
  summarizeRouteCards,
  titleFromPath,
  toolCandidates,
  type GraphIndex,
  type NoteCandidate,
  type SkillCandidate,
} from "./router-lib.js";

const DEFAULT_JEV_TIMEOUT_MS = 1500; // round10-plan.md §2: ">1.5s" -> rules fallback
const DEFAULT_CACHE_TTL_MS = 10 * 60_000; // "cache identical prompts 10 min"
const DEFAULT_CACHE_MAX = 500;
const DEFAULT_RATE_MAX = 20; // Jev calls per window — the endpoint itself never rate-limits,
const DEFAULT_RATE_WINDOW_MS = 60_000; // only the (metered) Jev call; over budget => rules.
/** How long a route-card summary is reused. snapshotExtras runs on every snapshot, and the
 *  log only grows by one line per prompt, so re-reading it more often than this buys
 *  nothing. */
const DEFAULT_CARDS_TTL_MS = 30_000;
/** The vector query runs before the Jev call inside the hook's 2.5 s budget, next to a
 *  1.5 s Jev timeout, so it gets what is left. A late answer just means BM25 alone. */
const DEFAULT_VECTOR_TIMEOUT_MS = 600;
const VECTOR_K = 6;

/** Paths of memory-vector hits for a prompt, best first, or [] on any failure. */
export type VectorSearch = (prompt: string) => Promise<string[]>;

/** The memory-vector CLI the "## Memory Recall" hook already uses, so the card and that
 *  hook rank over the same embeddings while both exist. */
function memoryVectorSearch(timeoutMs: number): VectorSearch {
  const node = existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
  const cli = join(homedir(), ".claude", "skills", "memory-vector", "cli.js");
  return (prompt) =>
    new Promise((resolve) => {
      if (!existsSync(cli)) return resolve([]);
      execFile(node, [cli, "query", prompt.slice(0, 1000), "--k", String(VECTOR_K), "--json"], { timeout: timeoutMs }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data: unknown = JSON.parse(stdout);
          const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];
          resolve(results.flatMap((r) => (isRecord(r) && typeof r.sourcePath === "string" ? [r.sourcePath] : [])));
        } catch {
          resolve([]);
        }
      });
    });
}

/** The vault's graph feed as a link index, rebuilt only when the reader hands back a new
 *  parse (the reader returns the same object when nothing changed). The first prompts after boot get no wave while the feed is read in the
 *  background; reading it never blocks a request. */
function vaultGraph(): () => GraphIndex | null {
  const reader = new VaultFeedReader();
  let builtFrom: unknown = null;
  let index: GraphIndex | null = null;
  let refreshedAt = Date.now();
  void reader.refresh().catch(() => null);
  return () => {
    // The feed is rebuilt hourly; a background re-read every 10 minutes keeps up with it.
    if (Date.now() - refreshedAt > 10 * 60_000) {
      refreshedAt = Date.now();
      void reader.refresh().catch(() => null);
    }
    const feed = reader.current();
    if (!feed) return null;
    if (feed.notes !== builtFrom) {
      const byPath = new Map<string, (typeof feed.notes)[number]>();
      const byId = new Map<string, (typeof feed.notes)[number]>();
      for (const n of feed.notes) {
        byPath.set(n.path, n);
        byId.set(n.id, n);
      }
      index = { byPath, byId };
      builtFrom = feed.notes;
    }
    return index;
  };
}

export interface RouterFeatureOptions {
  roots?: CorpusRoots;
  /** Installed skills offered as Dispatch candidates. Tests pass a fixed list; by default
   *  ~/.claude/skills is scanned once in the background at boot. */
  skills?: readonly SkillCandidate[];
  /** Skips the boot-time corpus scan (tests: a deterministic empty-candidates path without
   *  touching any filesystem). */
  skipCorpus?: boolean;
  jevTimeoutMs?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  rateLimit?: { max: number; windowMs: number };
  /** The jsonl the hook appends a decision to. Tests point this at a fixture; nothing here
   *  ever writes it. */
  routeCardLog?: string;
  cardsTtlMs?: number;
  /** Semantic candidates beside BM25. Tests inject one; by default the memory-vector CLI,
   *  or none when the corpus scan is skipped or a fixture corpus is passed. */
  vectorSearch?: VectorSearch | null;
  /** The vault link graph for the second wave. Tests inject one; by default the vault's
   *  graph feed, or none when the corpus scan is skipped or a fixture corpus is passed. */
  graph?: (() => GraphIndex | null) | null;
  now?: () => number;
}

type RouteAdvice = Omit<RouterResult, "ms">;

/** Factory so tests point at a fixture corpus (never Alex's real, private memory/vault)
 *  and each instance owns its own index/cache/limiter — no shared module state across tests,
 *  same shape as createRecallFeature. */
export function createRouterFeature(opts: RouterFeatureOptions = {}): ServerFeature {
  const roots = opts.roots ?? defaultCorpusRoots();
  const nowFn = opts.now ?? Date.now;
  const jevTimeoutMs = opts.jevTimeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;

  const state: { index: BM25Index | null; ready: boolean } = { index: null, ready: false };
  if (!opts.skipCorpus) {
    // Fire-and-forget at construction time, never awaited by a request — matches recall's
    // "build lazily in the background, never block the server or a boot".
    void (async () => {
      const t0 = nowFn();
      const docs = await walkCorpus(roots);
      state.index = buildIndex(docs);
      state.ready = true;
      log.info("router", `note index ready: ${state.index.n} docs in ${nowFn() - t0}ms`);
    })();
  }

  const skillState: { list: readonly SkillCandidate[] } = { list: opts.skills ?? [] };
  if (!opts.skills && !opts.skipCorpus) {
    void (async () => {
      const found = await scanUserSkills(join(homedir(), ".claude", "skills"));
      skillState.list = found.map((s) => ({ slug: s.slug, description: s.description }));
      log.info("router", `skill candidates ready: ${skillState.list.length}`);
    })();
  }

  const cache = createTtlCache<string, RouteAdvice>({ ttlMs: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, max: opts.cacheMax ?? DEFAULT_CACHE_MAX, now: nowFn });

  // The hook writes this log; the server only ever reads it, so a missing or unreadable
  // file is an ordinary state (the hook has not run yet on a fresh machine), not an error.
  const cardLog = opts.routeCardLog ?? process.env.ROUTE_CARD_LOG ?? join(homedir(), ".claude", "logs", "route-card.jsonl");
  const cardsTtlMs = opts.cardsTtlMs ?? DEFAULT_CARDS_TTL_MS;
  let cards: { at: number; value: RouteCardSummary | null } | null = null;

  function routeCards(): RouteCardSummary | null {
    const t = nowFn();
    if (cards && t - cards.at < cardsTtlMs) return cards.value;
    let value: RouteCardSummary | null = null;
    try {
      value = summarizeRouteCards(readFileSync(cardLog, "utf8"), t);
    } catch {
      value = null; // no log yet, or no permission to read it
    }
    cards = { at: t, value };
    return value;
  }
  const limiter = createRateLimiter(opts.rateLimit?.max ?? DEFAULT_RATE_MAX, opts.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS, nowFn);

  const vectorSearch: VectorSearch | null =
        // A fixture corpus (tests) never gets the real vector index: that would mix Alex's
    // private memory into a test's candidates.
    opts.vectorSearch !== undefined ? opts.vectorSearch : opts.skipCorpus || opts.roots ? null : memoryVectorSearch(DEFAULT_VECTOR_TIMEOUT_MS);

  const graph: (() => GraphIndex | null) | null = opts.graph !== undefined ? opts.graph : opts.skipCorpus || opts.roots ? null : vaultGraph();
  const vaultDir = vaultRoot();

  function bm25For(prompt: string): NoteCandidate[] {
    const idx = state.index;
    if (!idx || !state.ready) return [];
    const scores = bm25Scores(idx, prompt);
    if (!scores.size) return [];
    const ranked = rankedChunkIndices(idx, scores);
    return materialize(idx, ranked, scores, MAX_JEV_CANDIDATES).map((h) => ({ path: h.path, title: h.title, bm25Score: h.score }));
  }

  /** Vector hits are titled from the BM25 index when it holds that file (same title rule
   *  as everywhere else), from the file name otherwise. Still titles only, never bodies. */
  async function candidatesFor(prompt: string): Promise<NoteCandidate[]> {
    const [paths, bm25] = await Promise.all([vectorSearch ? vectorSearch(prompt).catch(() => []) : Promise.resolve([]), Promise.resolve(bm25For(prompt))]);
    const titles = new Map((state.index?.chunks ?? []).map((c) => [c.path, c.title]));
    const vector = paths.map((path) => ({ path, title: titles.get(path) ?? titleFromPath(path), bm25Score: 0 }));
    const first = mergeCandidates(vector, bm25);
    const g = graph?.() ?? null;
    if (!g) return first;
    const wave = graphWave(
      first,
      g,
      (p) => vaultRelative(p, vaultDir, roots.memoryDir),
      (rel) => join(vaultDir, rel),
    );
    return [...first, ...wave];
  }

  async function routeOnce(prompt: string, apiKey: string | undefined, fetchImpl: FetchLike): Promise<RouteAdvice> {
    const candidates = await candidatesFor(prompt);
    const tools = toolCandidates(prompt);
    const skills = skillCandidates(prompt, skillState.list);
    // Every fallback path still answers with the keyword matches rather than no tools at
    // all: Jev prunes this list, it is not the only thing that produces it.
    const rulesAdvice = (suffix: string): RouteAdvice => {
      const rules = classifyModelRules(prompt);
      return { ok: true, model: rules.model, why: clampWhy(`${rules.why} (${suffix})`), notes: pickNotes(candidates, null), tools: pickTools(tools, null) };
    };

    if (!apiKey) return rulesAdvice("no Jev key");
    if (!limiter.tryAcquire()) return rulesAdvice("Jev rate-limited");

    try {
      const raw = await callJev(apiKey, buildRouterJevBody(prompt, candidates, tools, skills, QUESTION_BANK), fetchImpl, jevTimeoutMs);
      const parsed = parseRouterJevAnswers(raw, candidates.length, tools.length, skills.length, QUESTION_BANK.length);
      const dispatch = pickDispatch(parsed, skills, QUESTION_BANK);
      return {
        ok: true,
        model: parsed.model,
        why: clampWhy(parsed.modelWhy),
        notes: pickNotes(candidates, parsed.noteRelevance),
        tools: pickTools(tools, parsed.toolRelevance),
        ...(dispatch ? { dispatch } : {}),
      };
    } catch (err) {
      log.warn("router", "typesafe call failed, timed out, or returned a bad shape — falling back to rules", String(err));
      return rulesAdvice("Jev unavailable");
    }
  }

  return {
    id: "router",
    routes: [
      {
        method: "POST",
        path: "/api/router/route",
        async handler(req, res, ctx) {
          const startedAt = nowFn();
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, { ok: false, model: null, why: "invalid JSON body", notes: [], ms: 0 } satisfies RouterResult);
            return;
          }
          const prompt = isRecord(body) && typeof body.prompt === "string" ? body.prompt : null;
          if (prompt === null || prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
            respondJson(res, 400, {
              ok: false,
              model: null,
              why: `prompt must be 1..${MAX_PROMPT_CHARS} characters`,
              notes: [],
              ms: Math.max(0, Math.round(nowFn() - startedAt)),
            } satisfies RouterResult);
            return;
          }

          // Cache key is the prompt alone ("identical prompts", per the contract) — cwd
          // isn't used by candidate retrieval or the rules classifier in this pass, so
          // folding it into the key would only fragment the cache for no benefit.
          const apiKey = ctx.config.typesafeApiKey ?? process.env.TYPESAFE_API_KEY;
          const fetchImpl = ctx.config.typesafeFetchImpl ?? (globalThis.fetch as FetchLike);
          const advice = await cache.get(prompt.trim(), () => routeOnce(prompt, apiKey, fetchImpl));
          respondJson(res, 200, { ...advice, ms: Math.max(0, Math.round(nowFn() - startedAt)) } satisfies RouterResult);
        },
      },
    ],
    snapshotExtras() {
      const extras: Record<string, unknown> = { "router.ready": state.ready, "router.docCount": state.index?.n ?? 0 };
      const summary = routeCards();
      if (summary) extras[ROUTER_CARDS_KEY] = summary;
      return extras;
    },
  };
}

export const routerFeature: ServerFeature = createRouterFeature();
