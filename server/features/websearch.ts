// POST /api/websearch — Ask Jev's "From the web" section. Shells out (execFile, argv
// array, no shell) to alex_claude/60-Meta/scripts/jev_search.py --json, which owns
// the Firecrawl call, the Jev re-rank, the TypeSafe key and the response cache; this
// module only validates, single-flights and reshapes. One search in flight at a time.
// Every search that comes back is KEPT: one line in data/jev-web.jsonl (when, the question, the
// top 5 {title, url}; recall/jev-web.ts), so what Jev found is remembered and recallable.

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WebSearchHit, WebSearchResult } from "../../shared/features/websearch.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { appendJevWeb, jevWebPath } from "./recall/jev-web.js";
import type { ServerFeature } from "./registry.js";
import { vaultRoot } from "../config.js";

const MAX_QUESTION_CHARS = 300;
const MAX_HITS = 5;
const WEAK_BELOW = 0.5;
const TIMEOUT_MS = 45_000;

export const DEFAULT_SCRIPT = join(vaultRoot(), "60-Meta", "scripts", "jev_search.py");

/** Runs the search and resolves raw stdout; rejects on a non-zero exit or timeout. */
export type SearchRunner = (question: string) => Promise<string>;

export function defaultRunner(script = process.env.JEV_SEARCH_SCRIPT ?? DEFAULT_SCRIPT): SearchRunner {
  return (question) =>
    new Promise((resolve, reject) => {
      execFile(
        "python3",
        [script, question, "--json", "--top", String(MAX_HITS), "--limit", "10"],
        {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          cwd: tmpdir(),
          // firecrawl + a modern python live in Homebrew; a launchd/tsx PATH may lack it.
          env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` },
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200)));
          else resolve(stdout);
        },
      );
    });
}

const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Firecrawl snippets are markdown: keep link text, drop link targets, heading hashes, emphasis. */
export function plainSnippet(md: unknown): string {
  if (typeof md !== "string") return "";
  const text = md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\u200b/g, "");
  return clean(text, 240);
}

function isHttpUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}

/** Pure: jev_search.py --json stdout -> WebSearchResult. Untrusted shape (web content). */
export function parseSearchOutput(stdout: string): WebSearchResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, hits: [], weak: false, error: "search returned invalid JSON" };
  }
  const rows = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  const hits: WebSearchHit[] = [];
  for (const r of rows) {
    if (!isRecord(r) || !isHttpUrl(r.url)) continue;
    const rank = typeof r.rank === "number" && Number.isFinite(r.rank) ? Math.max(0, Math.min(1, r.rank)) : null;
    hits.push({ title: clean(r.title, 200) || r.url, url: r.url, snippet: plainSnippet(r.snippet), rank });
    if (hits.length === MAX_HITS) break;
  }
  const best = hits[0]?.rank ?? null;
  return { ok: true, hits, weak: hits.length === 0 || (best !== null && best < WEAK_BELOW) };
}

const fail = (error: string): WebSearchResult => ({ ok: false, hits: [], weak: false, error });

export interface WebSearchFeatureOptions {
  /** Where each search is kept (default: data/jev-web.jsonl beside world.db). */
  logPath?: string;
}

export function createWebSearchFeature(run: SearchRunner = defaultRunner(), opts: WebSearchFeatureOptions = {}): ServerFeature {
  let inFlight = false;
  return {
    id: "websearch",
    routes: [
      {
        method: "POST",
        path: "/api/websearch",
        async handler(req, res, ctx) {
          if (inFlight) {
            respondJson(res, 429, fail("another web search is already running"));
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, fail("invalid JSON body"));
            return;
          }
          const q = isRecord(body) && typeof body.question === "string" ? body.question.trim() : "";
          if (q.length < 1 || q.length > MAX_QUESTION_CHARS) {
            respondJson(res, 400, fail(`question must be 1..${MAX_QUESTION_CHARS} characters`));
            return;
          }
          inFlight = true;
          try {
            const result = parseSearchOutput(await run(q));
            // An in-memory db has no data dir: nothing is kept there (tests pass logPath).
            const logPath = opts.logPath ?? (ctx.config.dbPath === ":memory:" ? null : jevWebPath(dirname(ctx.config.dbPath)));
            if (result.ok && logPath) {
              try {
                await appendJevWeb(logPath, new Date(), q, result.hits);
                result.kept = true;
              } catch (err) {
                result.kept = false;
                ctx.log.warn("websearch", "this search could not be kept", String(err));
              }
            }
            respondJson(res, 200, result);
          } catch (err) {
            respondJson(res, 200, fail(err instanceof Error ? err.message : String(err)));
          } finally {
            inFlight = false;
          }
        },
      },
    ],
  };
}

export const webSearchFeature: ServerFeature = createWebSearchFeature();
