// "shelf": what a session produced or referenced (URLs, artifact links, files written,
// images/HTML, memory learnings) + a sandboxed preview for local HTML/MD/text/images.
// Preview paths must resolve (realpath) inside the agent's repo, the vault, or a known
// automation output dir; secret files are refused; every preview carries a strict CSP so
// an HTML document can never run script, and text types are secret-redacted.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  SHELF_PREVIEW_CSP,
  SHELF_PREVIEW_MAX_BYTES,
  type ShelfError,
  type ShelfFile,
  type ShelfResponse,
} from "../../shared/features/shelf.js";
import { redactSecrets } from "../heuristics.js";
import { respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import { automationOutputRoots } from "./automations-lib.js";
import { repoRootFor } from "./code.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { resolveInside, safePathStatus, type SafeResolve } from "./safe-path.js";
import { extractShelf, isLearningPath, previewContentType } from "./shelf-lib.js";
import { readTranscript } from "./transcript.js";
import { vaultRoot as defaultVaultRoot } from "../config.js";

export interface ShelfFeatureOptions {
  vaultRoot?: string;
  /** Extra preview roots (default: automation output dirs). */
  extraRoots?: () => string[];
  home?: string;
}

function fail(res: ServerResponse, status: number, error: string): void {
  respondJson(res, status, { ok: false, error } satisfies ShelfError);
}

export function createShelfFeature(opts: ShelfFeatureOptions = {}): ServerFeature {
  const home = opts.home ?? homedir();
  const vaultRoot = opts.vaultRoot ?? defaultVaultRoot(home);
  const extraRoots = opts.extraRoots ?? (() => automationOutputRoots(home));

  function rootsFor(ctx: FeatureContext, agentId: string | null): string[] {
    const roots = [vaultRoot, ...extraRoots()];
    if (agentId) {
      const r = repoRootFor(ctx, agentId, home);
      if (r.ok) roots.unshift(r.repo.root);
    }
    return roots;
  }

  const claudeProjects = join(home, ".claude", "projects");

  /** First allowed root that contains `abs` (absolute path), realpath-checked. Memory notes
   *  (~/.claude/projects/<p>/memory/**) are allowed too, so learnings can be previewed. */
  async function resolveAllowed(roots: readonly string[], abs: string): Promise<SafeResolve> {
    let worst: SafeResolve = { ok: false, error: "outside-root" };
    if (abs.startsWith(`${claudeProjects}/`)) {
      const r = await resolveInside(claudeProjects, abs, { allowAbsolute: true });
      if (r.ok && /^[^/]+\/memory\/[^/]/.test(r.rel)) return r;
      if (!r.ok && r.error === "secret") return r;
    }
    for (const root of roots) {
      const r = await resolveInside(root, abs, { allowAbsolute: true });
      if (r.ok) return r;
      if (r.error === "secret") return r; // never fall through to a looser answer
      if (r.error === "not-found" && abs.startsWith(`${root}/`)) worst = r;
    }
    return worst;
  }

  return {
    id: "shelf",
    routes: [
      {
        method: "GET",
        path: "/api/shelf/preview",
        async handler(req, res, ctx) {
          const url = new URL(req.url ?? "/", "http://localhost");
          const path = url.searchParams.get("path") ?? "";
          const agentId = url.searchParams.get("agentId");
          if (!path || !path.startsWith("/") || path.includes("\0") || path.length > 2048) return fail(res, 400, "absolute path required");
          if (agentId !== null && !isValidUuid(agentId)) return fail(res, 400, "invalid agent id");
          const type = previewContentType(path);
          if (!type) return fail(res, 415, "not a previewable type (html, md, txt, json, images)");
          const target = await resolveAllowed(rootsFor(ctx, agentId), path);
          if (!target.ok) return fail(res, safePathStatus(target.error), target.error);
          let st;
          try {
            st = await stat(target.abs);
          } catch {
            return fail(res, 404, "not found");
          }
          if (!st.isFile()) return fail(res, 400, "not a file");
          if (st.size > SHELF_PREVIEW_MAX_BYTES) return fail(res, 413, "file too large to preview");
          const buf = await readFile(target.abs);
          const body = type.startsWith("image/") && type !== "image/svg+xml" ? buf : Buffer.from(redactSecrets(buf.toString("utf8")), "utf8");
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": body.length,
            "Content-Security-Policy": SHELF_PREVIEW_CSP,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
        },
      },
      {
        method: "GET",
        path: "/api/shelf/:agentId",
        async handler(_req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return fail(res, 400, "invalid agent id");
          const session = ctx.db.getSession(agentId);
          if (!session) return fail(res, 404, "unknown agent id");
          const entries = (await readTranscript(ctx.config.projectsDir, agentId)) ?? [];
          const ex = extractShelf(entries, session.cwd);
          const roots = rootsFor(ctx, agentId);
          const files: ShelfFile[] = await Promise.all(
            ex.files.map(async (f) => {
              let exists = false;
              try {
                exists = (await stat(f.path)).isFile();
              } catch {
                exists = false;
              }
              const previewType = previewContentType(f.path);
              const previewable = exists && previewType !== null && (await resolveAllowed(roots, f.path)).ok;
              return { ...f, exists, previewable };
            }),
          );
          respondJson(res, 200, {
            ok: true,
            agentId,
            urls: ex.urls,
            artifacts: ex.artifacts,
            files,
            media: files.filter((f) => f.type === "image" || f.type === "html"),
            learnings: files.filter((f) => isLearningPath(f.path)),
          } satisfies ShelfResponse);
        },
      },
    ],
  };
}

export const shelfFeature = createShelfFeature();
