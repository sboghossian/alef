// "census" feature: the real numbers behind Alex's Alef vision post.
//
//  - "Sub-minions born" (generations()) folds server/features/subagents/index.ts's own
//    latestSubagentRecords() — never a second, competing count of the same thing. That function
//    returns null until its feature's first pass has published (the cold pass over subagents.db
//    can take seconds on a fresh boot), and CensusResponse.generations carries that null through
//    rather than reporting a fabricated 0.
//  - "Upgrades merged into Alef" reads this repo's own merged-PR history with a single
//    read-only `gh pr list --repo <slug> --state merged …` call every `tickIntervalMs`
//    (10 min), argv-only (no shell). The repo slug comes from this checkout's own GitHub
//    remote (`git -C <root> remote get-url origin`), resolved once and cached.
//  - "Sessions that lived here" is NOT computed here: it is agents.length + the archive
//    feature's own summary, both already free on every WorldSnapshot — the client computes it
//    (see client/src/features/census.ts) rather than this feature re-deriving it.
//
// On a failed or not-yet-run `gh` call, the merged summary keeps the last GOOD list (or the
// honest "not fetched yet" state: fetchedAt === null) — it is never reset to 0. See
// server/features/census-lib.ts for the pure parsing/folding this file has no logic of its own
// duplicating.
//
// A genuinely new merge goes out on the live feed as one gov:census item (vision wave 3: this
// used to be a client-only push, one per open page). "New" is judged against a seen-set of PR
// numbers persisted in the world db's meta table (governance-lib.ts mergeNews): the first run on a
// db seeds it silently, a restart never re-announces, a merge that landed while the server was
// down still goes out once if it is under 24 h old, and the seen-set is written BEFORE the items
// go out (a failed write sends nothing and retries on the next fetch).

import { execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CENSUS_SUMMARY_KEY,
  type CensusMergedSummary,
  type CensusMessage,
  type CensusPr,
  type CensusResponse,
} from "../../shared/features/census.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import { respondJson } from "../http.js";
import { githubRepoOfRemoteUrl } from "../placement-evidence-lib.js";
import { generations, parseMergedPrs } from "./census-lib.js";
import { appendToFeed } from "./feed.js";
import { mergeNews, parseMergeSeen, type FeedDraft } from "./governance-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { latestSubagentRecords } from "./subagents/index.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(__dirname)); // server/features -> server -> repo root

const TICK_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const PR_JSON_FIELDS = "number,title,mergedAt,headRefName,headRefOid,body,comments";
const RECENT_MAX = 10;
/** The world db meta key holding the merge seen-set (a JSON array of PR numbers). */
export const MERGE_SEEN_META_KEY = "census.feedSeenPrs";

const EMPTY_MERGED: CensusMergedSummary = { total: 0, reviewRecorded: 0, loopMarked: 0, recent: [], fetchedAt: null, repo: null, error: null };

/** Runs an argv-only `gh` command (no shell) and returns stdout; throws on any failure
 *  (missing binary, non-zero exit, timeout, oversized output). PATH is widened with the two
 *  common Homebrew prefixes so a launchd-style minimal PATH still finds `gh`. */
export async function realRunGh(args: readonly string[]): Promise<string> {
  const path = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
  const { stdout } = await execFileAsync("gh", [...args], {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
    env: { ...process.env, PATH: path, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  return stdout;
}

/** `git -C <repoRoot> remote get-url origin`, parsed to "owner/repo"; null on any failure
 *  (no `.git`, no `origin`, a non-GitHub host). */
export function realResolveRepoSlug(repoRoot: string): () => Promise<string | null> {
  return async () => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 });
      return githubRepoOfRemoteUrl(stdout);
    } catch {
      return null;
    }
  };
}

/** Readable one-line message from an execFile rejection (stderr, else Error#message),
 *  control characters stripped, capped so it's fit to display. */
export function ghErrorMessage(err: unknown): string {
  let raw: string;
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    raw = typeof e.stderr === "string" && e.stderr.trim() ? e.stderr : typeof e.message === "string" ? e.message : String(err);
  } else {
    raw = String(err);
  }
  const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? raw;
  return firstLine.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
}

export interface CensusDeps {
  repoRoot: string;
  runGh: (args: readonly string[]) => Promise<string>;
  resolveRepoSlug: () => Promise<string | null>;
  /** null when the subagents feature hasn't published its first pass yet — see census-lib.ts's
   *  `generations` doc and shared/features/census.ts's CensusResponse.generations. */
  getSubagentRecords: () => readonly SubagentRecord[] | null;
  now: () => number;
  /** Where a new merge's governance item goes; defaults to the live Feed (feed.ts appendToFeed). */
  feed: (item: FeedDraft) => void;
  /** The persisted merge seen-set; defaults to the world db's meta table. */
  loadMergeSeen: (ctx: FeatureContext) => string | null;
  saveMergeSeen: (ctx: FeatureContext, value: string) => void;
}

interface Runtime {
  repoSlug: string | null;
  slugResolved: boolean;
  merged: CensusMergedSummary;
  lastEmittedTotal: number | null;
  /** True once a fetch has been kicked off at least once (success or failure) — a request
   *  never starts a second one just because it arrived before the first resolved. */
  attempted: boolean;
  /** The one in-flight fetch, if any: the tick and a request can never run `gh` at the same
   *  time, they share this promise instead (see the INVARIANT "one gh call per 10 min"). */
  inFlight: Promise<void> | null;
  /** PR numbers already announced or seeded: undefined until read from the db, null when the db
   *  has none yet (the first fetch then seeds it without announcing anything). */
  mergeSeen: Set<number> | null | undefined;
}

const runtimes = new Map<string, Runtime>();

/** The last merged summary any fetch produced (the vision ledger's census-merged probe reads it),
 *  or null before the first fetch finished. One server process = one runtime in production. */
let latestMerged: CensusMergedSummary | null = null;
export function latestCensusMerged(): CensusMergedSummary | null {
  return latestMerged;
}
/** Every merged PR of the last successful `gh pr list` (the summary keeps only 10): the Home
 *  digest counts the ones merged in its range. Empty before the first fetch landed. */
let latestPrs: readonly CensusPr[] = [];
export function latestCensusPrs(): readonly CensusPr[] {
  return latestPrs;
}

function runtime(ctx: FeatureContext): Runtime {
  const key = ctx.config.dbPath;
  let rt = runtimes.get(key);
  if (!rt) {
    rt = { repoSlug: null, slugResolved: false, merged: EMPTY_MERGED, lastEmittedTotal: null, attempted: false, inFlight: null, mergeSeen: undefined };
    runtimes.set(key, rt);
  }
  return rt;
}

async function resolveSlugOnce(rt: Runtime, deps: CensusDeps): Promise<string | null> {
  if (!rt.slugResolved) {
    rt.repoSlug = await deps.resolveRepoSlug();
    rt.slugResolved = true;
  }
  return rt.repoSlug;
}

/** One refresh: resolve the repo slug (once, ever), then `gh pr list`. Never throws — a
 *  failure is folded into `rt.merged.error`, keeping every other field at its last good value. */
async function fetchMerged(ctx: FeatureContext, rt: Runtime, deps: CensusDeps): Promise<void> {
  const slug = await resolveSlugOnce(rt, deps);
  if (!slug) {
    rt.merged = { ...rt.merged, repo: null, error: "no GitHub remote resolved for this checkout" };
    ctx.log.warn("census", "no GitHub remote resolved; keeping the last good merged list");
    return;
  }
  let stdout: string;
  try {
    stdout = await deps.runGh(["pr", "list", "--repo", slug, "--state", "merged", "--limit", "300", "--json", PR_JSON_FIELDS]);
  } catch (err) {
    rt.merged = { ...rt.merged, repo: slug, error: ghErrorMessage(err) };
    ctx.log.warn("census", "gh pr list failed; keeping the last good merged list", { error: rt.merged.error });
    return;
  }
  const prs = parseMergedPrs(stdout);
  if (prs === null) {
    rt.merged = { ...rt.merged, repo: slug, error: "gh returned unparseable output" };
    ctx.log.warn("census", "gh pr list returned non-JSON output; keeping the last good merged list");
    return;
  }
  const recent = [...prs].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, RECENT_MAX);
  latestPrs = prs;
  rt.merged = {
    total: prs.length,
    reviewRecorded: prs.filter((p) => p.review.recorded).length,
    loopMarked: prs.filter((p) => p.loopMarked).length,
    recent,
    fetchedAt: new Date(deps.now()).toISOString(),
    repo: slug,
    error: null,
  };
  announceMerges(ctx, rt, deps, prs, slug);
}

/** One gov:census feed item per merge never announced before (governance-lib.ts mergeNews). The
 *  seen-set is saved first: if that write fails, nothing goes out and the next fetch retries, so a
 *  merge is never announced twice. Never throws: the census numbers never depend on the feed. */
function announceMerges(ctx: FeatureContext, rt: Runtime, deps: CensusDeps, prs: readonly CensusPr[], slug: string): void {
  try {
    if (rt.mergeSeen === undefined) rt.mergeSeen = parseMergeSeen(deps.loadMergeSeen(ctx));
    const news = mergeNews(prs, rt.mergeSeen, slug, deps.now());
    if (news.changed && news.seen) deps.saveMergeSeen(ctx, JSON.stringify([...news.seen]));
    rt.mergeSeen = news.seen;
    for (const item of news.items) deps.feed(item);
  } catch (err) {
    ctx.log.warn("census", "merge feed step failed; retrying on the next fetch", String(err));
  }
}

function maybeEmit(ctx: FeatureContext, rt: Runtime): void {
  if (rt.merged.total === rt.lastEmittedTotal) return;
  rt.lastEmittedTotal = rt.merged.total;
  const msg: CensusMessage = { kind: "merged", merged: rt.merged };
  ctx.emit(msg);
}

/** Runs one fetch, coalescing with an already-in-flight one instead of starting a second. */
function runFetch(ctx: FeatureContext, rt: Runtime, deps: CensusDeps): Promise<void> {
  if (rt.inFlight) return rt.inFlight;
  rt.attempted = true;
  rt.inFlight = fetchMerged(ctx, rt, deps)
    .then(() => {
      latestMerged = rt.merged;
      maybeEmit(ctx, rt);
    })
    .catch((err: unknown) => {
      ctx.log.error("census", "merged-PR fetch failed", String(err));
    })
    .finally(() => {
      rt.inFlight = null;
    });
  return rt.inFlight;
}

/** Kicks off the very first fetch (a request or a snapshot, whichever comes first); every
 *  later request is served the cached `rt.merged` with no new `gh` call — the periodic
 *  `onTick` alone refreshes it after that. See INVARIANT "never one per request". */
function ensureStarted(ctx: FeatureContext, rt: Runtime, deps: CensusDeps): Promise<void> {
  if (rt.attempted) return Promise.resolve();
  return runFetch(ctx, rt, deps);
}

export function createCensusFeature(partial: Partial<CensusDeps> = {}): ServerFeature {
  const repoRoot = partial.repoRoot ?? REPO_ROOT;
  const deps: CensusDeps = {
    repoRoot,
    runGh: partial.runGh ?? realRunGh,
    resolveRepoSlug: partial.resolveRepoSlug ?? realResolveRepoSlug(repoRoot),
    getSubagentRecords: partial.getSubagentRecords ?? latestSubagentRecords,
    now: partial.now ?? Date.now,
    feed: partial.feed ?? appendToFeed,
    loadMergeSeen: partial.loadMergeSeen ?? ((ctx) => ctx.db.getMeta(MERGE_SEEN_META_KEY)),
    saveMergeSeen: partial.saveMergeSeen ?? ((ctx, value) => ctx.db.setMeta(MERGE_SEEN_META_KEY, value)),
  };

  return {
    id: "census",
    tickIntervalMs: TICK_MS,
    routes: [
      {
        method: "GET",
        path: "/api/census",
        async handler(_req, res, ctx) {
          const rt = runtime(ctx);
          await ensureStarted(ctx, rt, deps);
          const records = deps.getSubagentRecords();
          const body: CensusResponse = { generations: records === null ? null : generations(records), merged: rt.merged };
          respondJson(res, 200, body);
        },
      },
    ],
    async onTick(ctx) {
      await runFetch(ctx, runtime(ctx), deps);
    },
    snapshotExtras(ctx) {
      const rt = runtime(ctx);
      void ensureStarted(ctx, rt, deps);
      return { [CENSUS_SUMMARY_KEY]: rt.merged };
    },
  };
}

export const censusFeature: ServerFeature = createCensusFeature();
