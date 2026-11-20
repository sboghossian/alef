// Records the loop's review on the PR itself, on the exact SHA that was reviewed, so "nothing merges
// without passing review" has a record the census can read (not only ~/.alef-loop/journal.md):
//
//   gh pr comment <n> --repo <owner/repo> --body "alef-review: MERGE|BLOCK <headSha> <model>"
//
//   npx tsx scripts/post-review.ts --pr <n> --verdict MERGE|BLOCK --sha <the SHA the reviewer read> --model <model> [--repo owner/repo] [--dry-run]
//
// Before posting it reads the PR (gh pr view, a GitHub read): the PR must be OPEN and its head must
// still be the reviewed SHA. If the head moved (a fix commit, a merge of main), it refuses: a review
// of an older head is not a review of what would merge. The census counts a review only when the
// marker's SHA is the merged head and the comment predates the merge (server/features/census-lib.ts).
// Exit: 0 = posted (or --dry-run printed the argv), 2 = bad arguments or a gh failure, 3 = refused.
//
// INVARIANTS: the loop runs this explicitly, Alef never schedules it; gh runs through execFile with
// an argv array (never a shell), and every argv element is validated or built from validated parts;
// this is the one GitHub write, the same one the loop's ship step already makes. Nothing here merges.

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { log } from "../server/log.js";
import { githubRepoOfRemoteUrl } from "../server/placement-evidence-lib.js";
import { argValue, hasFlag, isMainModule, out } from "./script-args.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GH_TIMEOUT_MS = 30_000;

export type ReviewVerdict = "MERGE" | "BLOCK";

export interface ReviewArgs {
  pr: number;
  verdict: ReviewVerdict;
  sha: string;
  model: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,59}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The flags, validated. The model name is one token of plain characters: the census reads the
 *  marker's first line only and splits it on whitespace. */
export function parseReviewArgs(argv: readonly string[]): { ok: true; value: ReviewArgs } | { ok: false; error: string } {
  const prRaw = argValue(argv, "--pr") ?? "";
  const verdict = (argValue(argv, "--verdict") ?? "").toUpperCase();
  const sha = (argValue(argv, "--sha") ?? "").toLowerCase();
  const model = argValue(argv, "--model") ?? "";
  if (!/^[1-9]\d{0,6}$/.test(prRaw)) return { ok: false, error: "--pr must be a PR number" };
  if (verdict !== "MERGE" && verdict !== "BLOCK") return { ok: false, error: "--verdict must be MERGE or BLOCK" };
  if (!SHA_RE.test(sha)) return { ok: false, error: "--sha must be 7-40 hex characters (the head SHA the reviewer read)" };
  if (!MODEL_RE.test(model)) return { ok: false, error: `--model must match ${MODEL_RE}` };
  return { ok: true, value: { pr: Number(prRaw), verdict, sha, model } };
}

export function isRepoSlug(v: string): boolean {
  return REPO_RE.test(v);
}

/** The marker the census parses: "alef-review: <verdict> <full head SHA> <model>", one line. */
export function reviewMarker(verdict: ReviewVerdict, headSha: string, model: string): string {
  return `alef-review: ${verdict} ${headSha} ${model}`;
}

export function prViewArgv(pr: number, repo: string): string[] {
  return ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,state"];
}

/** gh's argv for the comment. `--body` and its value are two elements: no shell ever parses them. */
export function reviewCommentArgv(pr: number, repo: string, marker: string): string[] {
  return ["pr", "comment", String(pr), "--repo", repo, "--body", marker];
}

/** `gh pr view --json headRefOid,state` output, or null when it isn't that. */
export function parsePrView(stdout: string): { headRefOid: string; state: string } | null {
  try {
    const v: unknown = JSON.parse(stdout);
    if (typeof v !== "object" || v === null) return null;
    const { headRefOid, state } = v as { headRefOid?: unknown; state?: unknown };
    if (typeof headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(headRefOid) || typeof state !== "string") return null;
    return { headRefOid: headRefOid.toLowerCase(), state };
  } catch {
    return null;
  }
}

/** Why the review may not be posted on this PR as it stands, or null when it may. */
export function refusalReason(view: { headRefOid: string; state: string }, reviewedSha: string): string | null {
  if (view.state !== "OPEN") return `PR is ${view.state}, not OPEN: a review after the merge records nothing`;
  if (!view.headRefOid.startsWith(reviewedSha)) return `the PR head moved: reviewed ${reviewedSha}, head is now ${view.headRefOid.slice(0, 12)}. Review the new head, then post`;
  return null;
}

async function gh(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  return stdout;
}

async function repoSlug(explicit: string | null): Promise<string | null> {
  if (explicit) return isRepoSlug(explicit) ? explicit : null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"], { timeout: 5_000 });
    return githubRepoOfRemoteUrl(stdout);
  } catch {
    return null;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseReviewArgs(argv);
  if (!parsed.ok) {
    log.error("post-review", `${parsed.error}. usage: post-review.ts --pr <n> --verdict MERGE|BLOCK --sha <sha> --model <model> [--repo owner/repo] [--dry-run]`);
    return 2;
  }
  const { pr, verdict, sha, model } = parsed.value;
  const repo = await repoSlug(argValue(argv, "--repo"));
  if (!repo) {
    log.error("post-review", "no GitHub repo: pass --repo owner/repo, or run from a checkout whose origin is on GitHub");
    return 2;
  }
  let view: { headRefOid: string; state: string } | null;
  try {
    view = parsePrView(await gh(prViewArgv(pr, repo)));
  } catch (err) {
    log.error("post-review", `gh pr view ${pr} failed`, String(err));
    return 2;
  }
  if (!view) {
    log.error("post-review", `gh pr view ${pr} returned no head SHA/state`);
    return 2;
  }
  const refused = refusalReason(view, sha);
  if (refused) {
    out(`Refused: ${refused}\n`);
    return 3;
  }
  const argvOut = reviewCommentArgv(pr, repo, reviewMarker(verdict, view.headRefOid, model));
  if (hasFlag(argv, "--dry-run")) {
    out(`Dry run, nothing posted. gh argv: ${JSON.stringify(argvOut)}\n`);
    return 0;
  }
  try {
    const url = (await gh(argvOut)).trim();
    out(`Posted on ${repo}#${pr}: ${reviewMarker(verdict, view.headRefOid, model)}${url ? ` (${url})` : ""}\n`);
    return 0;
  } catch (err) {
    log.error("post-review", `gh pr comment ${pr} failed: nothing recorded`, String(err));
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
