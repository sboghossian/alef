// "trust": Claude Code's folder trust, granted only from an explicit click (decision 2b,
// 2026-09-28). A launch into a folder Claude hasn't trusted sits on its "Quick safety check… Yes,
// I trust this folder" dialog and runs nothing until someone answers it; Alef never answers that
// dialog by send-keys. Instead:
//
//   POST /api/trust {cwd}   sets projects[<realpath cwd>].hasTrustDialogAccepted = true in
//                           ~/.claude.json, under trust-lib.ts's SAFETY INVARIANT, and logs the
//                           grant (the town Logs tab shows it, next to the action log's line).
//   GET  /api/trust/targets the district folders a launch can target that Claude hasn't trusted
//                           (Health's "Launch targets Claude hasn't trusted" list).
//   POST /api/trust/bulk {paths, confirm:true}
//                           Health's "Trust these N folders" (one click, the list shown above it).
//
// SAFETY INVARIANT of the bulk route (LOOP.md Destructive-route rule: it overwrites ~/.claude.json
// once per folder):
//  1. Nothing is written without confirm:true in the body, and nothing for a path that isn't in
//     the untrusted-targets list computed at the start of THAT request (no arbitrary paths; a
//     district folder Claude trusted since the list was shown reads as "already", unwritten).
//  2. Right before each write the path is re-verified: still a district folder in the db, an
//     existing folder strictly under $HOME after realpath (validateTrustCwd), still not trusted by
//     Claude (a folder Claude trusted meanwhile is "already", nothing written); then
//     grantFolderTrust validates it once more and writes it under trust-lib.ts's own invariant
//     (Claude Code's lock, re-read + compare before the atomic rename, only that one key, one 0600
//     copy per day).
//  3. Paths go one after another, never in parallel, and only one bulk request runs at a time
//     (a second one gets 409 and writes nothing).
//  4. Every path gets its own outcome (trusted / already / refused with the reason); a partial
//     failure is reported as one, never as success.

import { homedir } from "node:os";
import type { TrustBulkItem, TrustBulkResult, TrustGrantResult, TrustTarget, TrustTargetsResponse } from "../../shared/features/trust.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { folderTrust } from "../trust.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { grantFolderTrust, type TrustWriteDeps, validateTrustCwd } from "./trust-lib.js";

export interface TrustFeatureOptions {
  /** $HOME for the "strictly under home" rule and the ~/.alef-trash copy. Tests pass a fake one. */
  homeDir?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam passed to every write (trust-lib's TrustWriteDeps.beforeRename): a racing writer. */
  beforeRename?: () => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The deps every grant uses; exported so talk's "Trust & relaunch" writes through the same path. */
export function trustWriteDeps(ctx: FeatureContext, opts: TrustFeatureOptions = {}): TrustWriteDeps {
  const deps: TrustWriteDeps = { claudeJsonPath: ctx.config.claudeJsonPath, homeDir: opts.homeDir ?? homedir(), now: opts.now ?? (() => new Date()), sleep: opts.sleep ?? realSleep };
  if (opts.beforeRename) deps.beforeRename = opts.beforeRename;
  return deps;
}

/** Grants trust for `cwd` and logs the outcome. Shared by POST /api/trust and talk's trust-relaunch. */
export async function grantTrustLogged(ctx: FeatureContext, cwd: unknown, opts: TrustFeatureOptions = {}): Promise<{ status: number; body: TrustGrantResult }> {
  const out = await grantFolderTrust(trustWriteDeps(ctx, opts), cwd);
  if (!out.ok) {
    ctx.log.warn("trust", `refused to trust ${typeof cwd === "string" ? cwd : "?"}: ${out.error}`);
    return { status: out.status, body: { ok: false, error: out.error } };
  }
  ctx.log.info(
    "trust",
    out.alreadyTrusted ? `folder trust: ${out.path} was already trusted (nothing written)` : `granted Claude Code folder trust for ${out.path}${out.backup ? ` (safety copy: ${out.backup})` : ""}`,
  );
  return { status: 200, body: { ok: true, path: out.path, alreadyTrusted: out.alreadyTrusted, backup: out.backup } };
}

/** The islands that count as districts here: those at least one indexed session sits on (live or
 *  dormant). An island only touched files sit on (a folder some session `cd`'d into) or one known
 *  only from archived fossils is no place anyone launches from, and counting those made this
 *  check say "71 of 104" (2026-10-14). */
function districtIslandIds(ctx: FeatureContext): string[] {
  return [...ctx.db.listSessionIslandIds()].filter((id) => id !== "harness").sort();
}

/** District folders a launch can target (the cwd /api/dispatch would use for each district
 *  island), kept when they exist, sit strictly under $HOME, and Claude hasn't trusted them. */
export async function listTrustTargets(ctx: FeatureContext, homeDir: string): Promise<TrustTargetsResponse> {
  const seen = new Set<string>();
  const untrusted: TrustTarget[] = [];
  let checked = 0;
  for (const islandId of districtIslandIds(ctx)) {
    if (islandId === "harness") continue;
    const cwd = ctx.db.getIslandCwd(islandId);
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    // Exists, is a folder, strictly under $HOME: the only folders POST /api/trust would accept.
    if (!(await validateTrustCwd(homeDir, cwd)).ok) continue;
    checked++;
    const trust = await folderTrust(ctx.config.claudeJsonPath, cwd, homeDir);
    if (trust !== "trusted") untrusted.push({ islandId, cwd, trust });
  }
  untrusted.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return { ok: true, untrusted, checked };
}

/** At most this many paths in one bulk request (there are ~30 districts). */
export const TRUST_BULK_MAX = 200;

function isDistrictCwd(ctx: FeatureContext, path: string): boolean {
  return districtIslandIds(ctx).some((id) => ctx.db.getIslandCwd(id) === path);
}

/** POST /api/trust/bulk under the SAFETY INVARIANT above. `body` is the parsed request body. */
export async function bulkTrust(ctx: FeatureContext, body: unknown, opts: TrustFeatureOptions & { homeDir: string }): Promise<{ status: number; body: TrustBulkResult }> {
  const fail = (status: number, error: string): { status: number; body: TrustBulkResult } => ({ status, body: { ok: false, results: [], trusted: 0, already: 0, refused: 0, error } });
  if (!isRecord(body) || body.confirm !== true) return fail(400, "confirm:true is required: nothing is trusted without the click");
  const raw = body.paths;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((p): p is string => typeof p === "string")) return fail(400, "paths must be a non-empty list of folder paths");
  if (raw.length > TRUST_BULK_MAX) return fail(400, `at most ${TRUST_BULK_MAX} folders at once`);
  const paths = [...new Set(raw)];
  const listed = new Set((await listTrustTargets(ctx, opts.homeDir)).untrusted.map((t) => t.cwd));
  const results: TrustBulkItem[] = [];
  const notListed = "not in the current list of untrusted launch targets";
  for (const path of paths) {
    // Only district folders are ever considered; anything else is refused before any other read.
    if (!listed.has(path) && !isDistrictCwd(ctx, path)) {
      results.push({ path, outcome: "refused", error: notListed });
      continue;
    }
    // Re-verified right before this path's write (no check-then-act gap from the list above).
    if (!isDistrictCwd(ctx, path)) {
      results.push({ path, outcome: "refused", error: "no longer a district folder" });
      continue;
    }
    const valid = await validateTrustCwd(opts.homeDir, path);
    if (!valid.ok) {
      results.push({ path, outcome: "refused", error: valid.error });
      continue;
    }
    // Claude trusted it since the list was shown (answered in Terminal, say): a success, nothing written.
    if ((await folderTrust(ctx.config.claudeJsonPath, path, opts.homeDir)) === "trusted") {
      results.push({ path, outcome: "already" });
      continue;
    }
    if (!listed.has(path)) {
      results.push({ path, outcome: "refused", error: notListed });
      continue;
    }
    const out = await grantTrustLogged(ctx, path, opts);
    if (!out.body.ok) results.push({ path, outcome: "refused", error: out.body.error ?? "refused" });
    else if (out.body.alreadyTrusted) results.push({ path, outcome: "already" });
    else results.push({ path, outcome: "trusted", backup: out.body.backup ?? null });
  }
  const count = (o: TrustBulkItem["outcome"]): number => results.filter((r) => r.outcome === o).length;
  const trusted = count("trusted");
  const already = count("already");
  const refused = count("refused");
  ctx.log.info("trust", `bulk trust: ${trusted} trusted, ${already} already trusted, ${refused} refused (of ${paths.length})`);
  const result: TrustBulkResult = { ok: refused === 0, results, trusted, already, refused };
  if (refused > 0) result.error = `${refused} of ${paths.length} folder${paths.length === 1 ? "" : "s"} not trusted: ${results.filter((r) => r.outcome === "refused").map((r) => `${r.path} (${r.error ?? "refused"})`).slice(0, 3).join("; ")}${refused > 3 ? "; …" : ""}`;
  return { status: 200, body: result };
}

export function createTrustFeature(opts: TrustFeatureOptions = {}): ServerFeature {
  const homeDir = opts.homeDir ?? homedir();
  let bulkRunning = false;
  return {
    id: "trust",
    routes: [
      {
        method: "POST",
        path: "/api/trust",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies TrustGrantResult);
          }
          const out = await grantTrustLogged(ctx, isRecord(body) ? body.cwd : undefined, { ...opts, homeDir });
          respondJson(res, out.status, out.body);
        },
      },
      {
        method: "POST",
        path: "/api/trust/bulk",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, results: [], trusted: 0, already: 0, refused: 0, error: "invalid JSON body" } satisfies TrustBulkResult);
          }
          if (bulkRunning) return respondJson(res, 409, { ok: false, results: [], trusted: 0, already: 0, refused: 0, error: "a bulk trust is already running; nothing was written by this one" } satisfies TrustBulkResult);
          bulkRunning = true;
          try {
            const out = await bulkTrust(ctx, body, { ...opts, homeDir });
            respondJson(res, out.status, out.body);
          } finally {
            bulkRunning = false;
          }
        },
      },
      {
        method: "GET",
        path: "/api/trust/targets",
        async handler(_req, res, ctx) {
          try {
            respondJson(res, 200, await listTrustTargets(ctx, homeDir));
          } catch (err) {
            respondJson(res, 500, { ok: false, untrusted: [], checked: 0, error: String(err) } satisfies TrustTargetsResponse);
          }
        },
      },
    ],
  };
}

export const trustFeature = createTrustFeature();
